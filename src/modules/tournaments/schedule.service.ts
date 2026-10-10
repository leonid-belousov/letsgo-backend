import { Injectable } from '@nestjs/common';
import type { Fixture, Prisma, Tournament, TournamentStage } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import type { Db, Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type {
  ApplyScheduleDto,
  MoveFixtureDto,
  ScheduleAnalysisDto,
  ScheduleApplyResultDto,
  ScheduleParamsDto,
  SchedulePreviewDto,
  ScheduleReportDto,
} from './dto/structure.dto';
import { FixtureViewService, RANK_RE, REF_RE, type FixtureContext } from './fixture-view.service';
import { readConfig } from './logic/stage-config';
import {
  analyseSchedule,
  minutes,
  scheduleFixtures,
  type PlacedSlot,
  type SchedFixture,
  type SchedWindow,
} from './logic/scheduler';
import { NOT_AVAILABLE, TournamentAccess, lockTournament } from './tournament-access.service';
import { TournamentBookingsService } from './tournament-bookings.service';
import type { FixtureDto } from './dto/structure.dto';

interface Proposal extends SchedulePreviewDto {
  placedMap: Map<string, PlacedSlot>;
  targets: Fixture[];
}

@Injectable()
export class ScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TournamentAccess,
    private readonly idempotency: IdempotencyService,
    private readonly view: FixtureViewService,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly rentals: TournamentBookingsService,
  ) {}

  private async gate(db: Db, actorId: string, tournamentId: string): Promise<Tournament> {
    const t = await this.access.loadVisible(db, actorId, tournamentId);
    await this.access.assertCan(db, actorId, 'tournament.schedule', t);
    this.access.assertNotTerminal(t);
    return t;
  }

  private async currentVersion(db: Db, tournamentId: string): Promise<number> {
    const a = await db.fixture.aggregate({
      where: { tournamentId },
      _max: { scheduleVersion: true },
    });
    return a._max.scheduleVersion ?? 0;
  }

  private slotOf(f: Fixture): PlacedSlot | null {
    if (!f.startsAt || !f.endsAt) return null;
    return {
      id: f.id,
      pitchId: f.pitchId,
      start: f.startsAt.getTime(),
      end: f.endsAt.getTime(),
      occupiedUntil: f.endsAt.getTime(),
      clubs: [f.homeEntryId, f.awayEntryId].filter((x): x is string => !!x),
    };
  }

  private async analysisDto(
    ctx: FixtureContext,
    slots: PlacedSlot[],
    minRest: number,
  ): Promise<ScheduleAnalysisDto> {
    const a = analyseSchedule(slots, minutes(minRest));
    const nameless = (id: string) => ctx.clubs.get(id) ?? null;
    return {
      clubs: a.clubs.map((c) => ({
        entryId: c.clubId,
        club: nameless(c.clubId),
        matches: c.matches,
        minRestMinutes: c.minRestMinutes,
      })),
      minRestMinutes: a.minRestMinutes,
      restSpreadMinutes: a.restSpreadMinutes,
      conflicts: a.conflicts.map((c) => ({
        type: c.type,
        fixtureIds: c.fixtureIds,
        entryId: c.clubId,
        pitchId: c.pitchId,
        restMinutes: c.restMinutes,
        message: c.message,
      })),
    };
  }

  private async propose(db: Db, t: Tournament, p: ScheduleParamsDto): Promise<Proposal> {
    // windows
    const windows: SchedWindow[] = p.windows.map((w) => ({
      pitchId: w.pitchId,
      start: w.startsAt.getTime(),
      end: w.endsAt.getTime(),
    }));
    for (const w of windows) {
      if (w.end <= w.start)
        throw new ApiError(ErrorCode.VALIDATION, 'A window must end after it starts', {
          field: 'windows',
        });
    }
    const pitchIds = [...new Set(windows.map((w) => w.pitchId))];
    if ((await db.pitch.count({ where: { id: { in: pitchIds } } })) !== pitchIds.length) {
      throw new ApiError(ErrorCode.VALIDATION, 'Unknown pitch in the windows', {
        field: 'windows',
      });
    }
    for (const id of pitchIds) {
      const ws = windows.filter((w) => w.pitchId === id).sort((a, b) => a.start - b.start);
      for (let i = 1; i < ws.length; i++) {
        if ((ws[i] as SchedWindow).start < (ws[i - 1] as SchedWindow).end) {
          throw new ApiError(ErrorCode.VALIDATION, 'Windows of one pitch overlap', {
            field: 'windows',
          });
        }
      }
    }
    // real rentals: clip to confirmed attached windows / cut foreign occupancy out
    const usable = (await this.rentals.constrainWindows(db, t.id, windows)) as SchedWindow[];
    usable.sort((a, b) => a.start - b.start || a.pitchId.localeCompare(b.pitchId));

    const ctx = await this.view.context(db, t.id);
    const stageFilter = p.stageIds ? new Set(p.stageIds) : null;
    if (stageFilter) {
      for (const id of stageFilter) {
        if (!ctx.stages.has(id))
          throw new ApiError(ErrorCode.VALIDATION, 'Unknown stage', { field: 'stageIds' });
      }
    }
    const all = ctx.fixtures;
    const targets = this.view.sort(
      all.filter(
        (f) =>
          f.status === 'SCHEDULED' &&
          (!stageFilter || stageFilter.has(f.stageId)) &&
          (p.reschedule || !f.startsAt),
      ),
      ctx,
    );
    const targetIds = new Set(targets.map((f) => f.id));
    const fixed = all
      .filter((f) => !targetIds.has(f.id) && f.status !== 'CANCELLED' && f.status !== 'POSTPONED')
      .flatMap((f) => {
        const s = this.slotOf(f);
        return s ? [s] : [];
      });

    const stageOf = (f: Fixture): TournamentStage => ctx.stages.get(f.stageId) as TournamentStage;
    const byStageIndex = new Map([...ctx.stages.values()].map((s) => [s.index, s]));
    const timedOrTarget = (id: string) => targetIds.has(id) || fixed.some((s) => s.id === id);
    const deps = (f: Fixture): string[] => {
      const out = new Set<string>();
      for (const [entry, ph] of [
        [f.homeEntryId, f.homePlaceholder],
        [f.awayEntryId, f.awayPlaceholder],
      ] as const) {
        if (!ph) continue;
        const r = RANK_RE.exec(ph);
        if (r) {
          const src = byStageIndex.get(Number(r[1]));
          if (src) {
            for (const x of all) {
              if (x.stageId === src.id && (x.groupLabel ?? '') === r[2] && timedOrTarget(x.id))
                out.add(x.id);
            }
          }
          continue;
        }
        const w = REF_RE.exec(ph);
        if (w && timedOrTarget(w[2] as string)) out.add(w[2] as string);
        void entry;
      }
      return [...out];
    };

    const sched: SchedFixture[] = targets.map((f) => {
      const cfg = readConfig(stageOf(f).config);
      const playoff = stageOf(f).kind === 'KNOCKOUT';
      return {
        id: f.id,
        clubs: [f.homeEntryId, f.awayEntryId].filter((x): x is string => !!x),
        minutes: cfg.matchMinutes ?? p.matchMinutes,
        changeover: cfg.changeoverMinutes ?? p.changeoverMinutes,
        reserve: playoff ? (cfg.reserveMinutes ?? p.playoffReserveMinutes ?? 0) : 0,
        after: deps(f),
      };
    });
    const out = scheduleFixtures(sched, usable, fixed, minutes(p.minRestMinutes));
    const placedMap = new Map(out.placed.map((s) => [s.id, s]));

    const slots = targets.flatMap((f) => {
      const s = placedMap.get(f.id);
      if (!s || !s.pitchId) return [];
      const changed = !(
        f.pitchId === s.pitchId &&
        f.startsAt?.getTime() === s.start &&
        f.endsAt?.getTime() === s.end
      );
      return [
        {
          fixtureId: f.id,
          pitchId: s.pitchId,
          startsAt: new Date(s.start).toISOString(),
          endsAt: new Date(s.end).toISOString(),
          changed,
          published: f.scheduleVersion >= 1,
        },
      ];
    });
    const rental = await this.rentals.evaluate(
      db,
      t.id,
      slots.map((x) => ({
        fixtureId: x.fixtureId,
        pitchId: x.pitchId,
        start: Date.parse(x.startsAt),
        end: Date.parse(x.endsAt),
      })),
    );
    const affected = new Set<string>();
    const accepted = (
      await db.clubEntry.findMany({
        where: { tournamentId: t.id, status: 'ACCEPTED' },
        select: { id: true },
      })
    ).map((e) => e.id);
    for (const s of slots) {
      if (s.changed && s.published) {
        const f = all.find((x) => x.id === s.fixtureId) as Fixture;
        if (f.homeEntryId && f.awayEntryId) {
          affected.add(f.homeEntryId);
          affected.add(f.awayEntryId);
        } else {
          accepted.forEach((a) => affected.add(a));
        }
      }
    }
    const analysis = await this.analysisDto(
      ctx,
      out.placed.filter((s) => s.pitchId !== null || s.clubs.length > 0),
      p.minRestMinutes,
    );
    return {
      scheduleVersion: await this.currentVersion(db, t.id),
      slots,
      unscheduled: out.unscheduled.map((u) => ({
        fixtureId: u.id,
        reason: u.reason,
        detail: u.detail,
      })),
      analysis,
      bookingProblems: rental.problems,
      warnings: rental.warnings,
      affectedEntryIds: [...affected],
      saved: false,
      placedMap,
      targets,
    };
  }

  private strip(p: Proposal): SchedulePreviewDto {
    const { placedMap: _m, targets: _t, ...rest } = p;
    void _m;
    void _t;
    return rest;
  }

  /** Conflicts, rest and unscheduled fixtures for the proposed schedule - saves nothing. */
  async preview(
    actorId: string,
    tournamentId: string,
    p: ScheduleParamsDto,
  ): Promise<SchedulePreviewDto> {
    const t = await this.gate(this.prisma, actorId, tournamentId);
    return this.strip(await this.propose(this.prisma, t, p));
  }

  async apply(
    actorId: string,
    tournamentId: string,
    p: ApplyScheduleDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<ScheduleApplyResultDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.schedule.apply:${tournamentId}`, key, payload: p },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.gate(tx, actorId, tournamentId);
        const current = await this.currentVersion(tx, tournamentId);
        if (p.expectedVersion !== undefined && p.expectedVersion !== current) {
          throw new ApiError(ErrorCode.VERSION_CHANGED, 'The schedule changed elsewhere', {
            currentVersion: current,
          });
        }
        // re-validated inside the transaction, with the pitches locked against concurrent bookings
        await this.rentals.lockPitches(
          tx,
          p.windows.map((w) => w.pitchId),
        );
        const prop = await this.propose(tx, t, p);
        if (
          prop.unscheduled.length > 0 ||
          prop.bookingProblems.length > 0 ||
          prop.analysis.conflicts.some((c) =>
            prop.slots.some((s) => c.fixtureIds.includes(s.fixtureId)),
          )
        ) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'The schedule cannot be applied as it stands; nothing was changed',
            {
              reason: 'SCHEDULE_CONFLICTS',
              unscheduled: prop.unscheduled as unknown as Prisma.InputJsonValue,
              conflicts: prop.analysis.conflicts as unknown as Prisma.InputJsonValue,
              bookingProblems: prop.bookingProblems as unknown as Prisma.InputJsonValue,
            },
          );
        }
        const publishing = current >= 1 || p.publish === true;
        const newVersion = publishing ? current + 1 : 0;
        const changed = prop.slots.filter((s) => s.changed);
        for (const s of changed) {
          await tx.fixture.update({
            where: { id: s.fixtureId },
            data: {
              pitchId: s.pitchId,
              startsAt: new Date(s.startsAt),
              endsAt: new Date(s.endsAt),
              ...(publishing ? { scheduleVersion: newVersion } : {}),
            },
          });
        }
        if (publishing && current === 0) {
          await tx.fixture.updateMany({
            where: { tournamentId, scheduleVersion: 0, startsAt: { not: null } },
            data: { scheduleVersion: newVersion },
          });
        }
        const notified = publishing
          ? await this.notifyChange(
              tx,
              t,
              actorId,
              current === 0 ? 'The match schedule was published' : 'The match schedule changed',
              changed.map((c) => c.fixtureId),
              current === 0,
              newVersion,
            )
          : 0;
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.schedule.apply',
          targetType: 'Tournament',
          targetId: tournamentId,
          requestId,
          metadata: { changed: changed.length, version: newVersion, minRest: p.minRestMinutes },
        });
        return {
          ...this.strip(prop),
          saved: true,
          changedCount: changed.length,
          newScheduleVersion: publishing ? newVersion : current,
          notified,
        };
      },
    );
  }

  private timedSlots(list: Fixture[]) {
    return list.flatMap((f) =>
      f.pitchId && f.startsAt && f.endsAt && ['SCHEDULED', 'LIVE'].includes(f.status)
        ? [
            {
              fixtureId: f.id,
              pitchId: f.pitchId,
              start: f.startsAt.getTime(),
              end: f.endsAt.getTime(),
            },
          ]
        : [],
    );
  }

  /** Refuses (409, full list) when any scheduled fixture violates the rental rules. */
  async assertRentals(db: Db, tournamentId: string): Promise<void> {
    const fixtures = await db.fixture.findMany({ where: { tournamentId } });
    const r = await this.rentals.evaluate(db, tournamentId, this.timedSlots(fixtures));
    if (r.problems.length > 0) {
      throw new ApiError(
        ErrorCode.CONFLICT,
        'Some matches are not covered by confirmed pitch rentals',
        {
          reason: 'SCHEDULE_CONFLICTS',
          bookingProblems: r.problems as unknown as Prisma.InputJsonValue,
        },
      );
    }
  }

  async publish(
    actorId: string,
    tournamentId: string,
    key: string | undefined,
    requestId?: string,
  ): Promise<{ scheduleVersion: number; published: number }> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.schedule.publish:${tournamentId}`, key, payload: {} },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.gate(tx, actorId, tournamentId);
        const current = await this.currentVersion(tx, tournamentId);
        const drafts = await tx.fixture.findMany({
          where: { tournamentId, scheduleVersion: 0, startsAt: { not: null } },
          select: { id: true },
        });
        if (drafts.length === 0) return { scheduleVersion: current, published: 0 };
        await this.assertRentals(tx, tournamentId);
        const v = current + 1;
        await tx.fixture.updateMany({
          where: { id: { in: drafts.map((d) => d.id) } },
          data: { scheduleVersion: v },
        });
        await this.notifyChange(
          tx,
          t,
          actorId,
          current === 0 ? 'The match schedule was published' : 'The match schedule changed',
          drafts.map((d) => d.id),
          current === 0,
          v,
        );
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.schedule.publish',
          targetType: 'Tournament',
          targetId: tournamentId,
          requestId,
          metadata: { version: v, count: drafts.length },
        });
        return { scheduleVersion: v, published: drafts.length };
      },
    );
  }

  /** Affected clubs (their representatives and confirmed players) hear about published changes. */
  private async notifyChange(
    tx: Tx,
    t: Tournament,
    actorId: string,
    title: string,
    fixtureIds: string[],
    everyone: boolean,
    version: number,
  ): Promise<number> {
    const fixtures = await tx.fixture.findMany({
      where: { id: { in: fixtureIds } },
      select: { homeEntryId: true, awayEntryId: true },
    });
    // unresolved sides: any accepted club may still end up in the match, so all are told
    const anyone = everyone || fixtures.some((f) => !f.homeEntryId || !f.awayEntryId);
    const entryIds = anyone
      ? (
          await tx.clubEntry.findMany({
            where: { tournamentId: t.id, status: 'ACCEPTED' },
            select: { id: true },
          })
        ).map((e) => e.id)
      : [
          ...new Set(
            fixtures.flatMap((f) => [f.homeEntryId, f.awayEntryId]).filter((x): x is string => !!x),
          ),
        ];
    const entries = await tx.clubEntry.findMany({
      where: { id: { in: entryIds } },
      include: { players: { where: { status: 'CONFIRMED' } } },
    });
    const recipients = new Set<string>();
    for (const e of entries) {
      recipients.add(e.submittedById);
      for (const r of await this.access.clubRepresentatives(tx, e.clubId)) recipients.add(r);
      e.players.forEach((p) => recipients.add(p.userId));
    }
    await this.notifier.notify(tx, {
      recipientIds: [...recipients],
      category: 'tournament',
      activityKind: 'tournament.schedule_changed',
      title,
      objectType: 'Tournament',
      objectId: t.id,
      actorId,
      essential: true,
      payload: { tournamentId: t.id, scheduleVersion: version },
      dedupeKey: `tournament-schedule:${t.id}:${version}`,
    });
    return recipients.size;
  }

  async report(
    actorId: string,
    tournamentId: string,
    minRestMinutes: number,
  ): Promise<ScheduleReportDto> {
    const t = await this.access.loadVisible(this.prisma, actorId, tournamentId);
    await this.access.assertCan(this.prisma, actorId, 'tournament.schedule', t);
    const ctx = await this.view.context(this.prisma, tournamentId);
    const live = ctx.fixtures.filter((f) => f.status !== 'CANCELLED' && f.status !== 'POSTPONED');
    const slots = live.flatMap((f) => {
      const s = this.slotOf(f);
      return s ? [s] : [];
    });
    const rental = await this.rentals.evaluate(this.prisma, tournamentId, this.timedSlots(live));
    return {
      bookingProblems: rental.problems,
      warnings: rental.warnings,
      scheduleVersion: await this.currentVersion(this.prisma, tournamentId),
      scheduledFixtures: slots.length,
      unscheduledFixtures: live.length - slots.length,
      analysis: await this.analysisDto(ctx, slots, minRestMinutes),
    };
  }

  /** Manual move of one fixture: overlaps are refused; a short rest needs an explicit decision. */
  async move(
    actorId: string,
    tournamentId: string,
    fixtureId: string,
    dto: MoveFixtureDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<FixtureDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.fixture.move:${fixtureId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.gate(tx, actorId, tournamentId);
        const ctx = await this.view.context(tx, tournamentId);
        const f = ctx.fixtures.find((x) => x.id === fixtureId);
        if (!f) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (f.status !== 'SCHEDULED' && f.status !== 'POSTPONED') {
          throw new ApiError(ErrorCode.CONFLICT, 'A played or cancelled match cannot be moved', {
            status: f.status,
          });
        }
        if ((await tx.pitch.count({ where: { id: dto.pitchId } })) !== 1) {
          throw new ApiError(ErrorCode.VALIDATION, 'Unknown pitch', { field: 'pitchId' });
        }
        const stageCfg = readConfig((ctx.stages.get(f.stageId) as TournamentStage).config);
        const len = dto.endsAt
          ? dto.endsAt.getTime() - dto.startsAt.getTime()
          : f.startsAt && f.endsAt
            ? f.endsAt.getTime() - f.startsAt.getTime()
            : minutes(stageCfg.matchMinutes ?? 20);
        if (len <= 0)
          throw new ApiError(ErrorCode.VALIDATION, 'endsAt must be after startsAt', {
            field: 'endsAt',
          });
        const minRest =
          dto.minRestMinutes ??
          Math.max(
            0,
            ...[...ctx.stages.values()].map((s) => readConfig(s.config).minRestMinutes ?? 0),
          );
        const moved: PlacedSlot = {
          id: f.id,
          pitchId: dto.pitchId,
          start: dto.startsAt.getTime(),
          end: dto.startsAt.getTime() + len,
          occupiedUntil: dto.startsAt.getTime() + len,
          clubs: [f.homeEntryId, f.awayEntryId].filter((x): x is string => !!x),
        };
        const others = ctx.fixtures
          .filter((x) => x.id !== f.id && x.status !== 'CANCELLED' && x.status !== 'POSTPONED')
          .flatMap((x) => {
            const s = this.slotOf(x);
            return s ? [s] : [];
          });
        await this.rentals.lockPitches(tx, [dto.pitchId]);
        const rental = await this.rentals.evaluate(tx, tournamentId, [
          { fixtureId: f.id, pitchId: dto.pitchId, start: moved.start, end: moved.end },
        ]);
        if (rental.problems.length > 0) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'The new slot is not covered by a confirmed pitch rental',
            {
              reason: 'SCHEDULE_CONFLICTS',
              bookingProblems: rental.problems as unknown as Prisma.InputJsonValue,
            },
          );
        }
        const a = analyseSchedule([...others, moved], minutes(minRest));
        const mine = a.conflicts.filter((c) => c.fixtureIds.includes(f.id));
        const hard = mine.filter((c) => c.type !== 'REST_TOO_SHORT');
        if (hard.length > 0) {
          throw new ApiError(ErrorCode.BOOKING_CONFLICT, 'The new slot overlaps another match', {
            conflicts: hard as unknown as Prisma.InputJsonValue,
          });
        }
        const soft = mine.filter((c) => c.type === 'REST_TOO_SHORT');
        if (soft.length > 0 && !dto.allowShortRest) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'A club would rest less than the minimum; the rest is never shortened silently',
            {
              reason: 'REST_TOO_SHORT',
              minRestMinutes: minRest,
              conflicts: soft as unknown as Prisma.InputJsonValue,
            },
          );
        }
        const current = await this.currentVersion(tx, tournamentId);
        const published = f.scheduleVersion >= 1 || current >= 1;
        const version = published ? current + 1 : 0;
        const updated = await tx.fixture.update({
          where: { id: f.id },
          data: {
            pitchId: dto.pitchId,
            startsAt: dto.startsAt,
            endsAt: new Date(moved.end),
            status: 'SCHEDULED',
            ...(published ? { scheduleVersion: version } : {}),
          },
        });
        if (published)
          await this.notifyChange(tx, t, actorId, 'A match was moved', [f.id], false, version);
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.fixture.move',
          targetType: 'Fixture',
          targetId: f.id,
          requestId,
          metadata: {
            pitchId: dto.pitchId,
            startsAt: dto.startsAt,
            allowShortRest: dto.allowShortRest ?? false,
          },
        });
        const fresh = await this.view.context(tx, tournamentId);
        return this.view.toDto(fresh, updated, true);
      },
    );
  }
}
