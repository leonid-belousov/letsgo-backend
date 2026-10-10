import { Injectable } from '@nestjs/common';
import type { Fixture, Prisma, TournamentStage } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import { Clock } from '../../common/time/clock';
import type { Db, Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type {
  CorrectResultDto,
  FixtureDto,
  FixtureStatusDto,
  ImpactDto,
  RecordResultDto,
  ShootoutDto,
  TieResolutionDto,
} from './dto/structure.dto';
import { FixtureViewService, RANK_RE, REF_RE, winnerOf } from './fixture-view.service';
import { readConfig, type StageConfigBase } from './logic/stage-config';
import { computeTable, type Played, type TableRow } from './logic/standings';
import { NOT_AVAILABLE, TournamentAccess, lockTournament } from './tournament-access.service';

interface Override {
  fixtureId: string;
  homeScore: number;
  awayScore: number;
  shootout: ShootoutDto | null;
}

interface Change {
  fixtureId: string;
  side: 'home' | 'away';
  current: string | null;
  next: string | null;
  status: Fixture['status'];
}

const asJson = (c: StageConfigBase): Prisma.InputJsonObject =>
  JSON.parse(JSON.stringify(c)) as Prisma.InputJsonObject;

/**
 * Results, standings and dependent-fixture resolution.
 *  - a recorded score makes the fixture FINISHED (= confirmed); standings are recomputed in the
 *    same transaction from finished fixtures only, using ONLY the configured criteria;
 *  - placeholders ("A1", "Winner of ...") resolve once the group is fully played (and the rank is
 *    not tied) / the source match has a winner;
 *  - a played fixture is never rebuilt silently: correcting a result lists affected dependents and
 *    needs an explicit organiser decision; fixtures already played keep their participants.
 */
@Injectable()
export class ResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TournamentAccess,
    private readonly idempotency: IdempotencyService,
    private readonly view: FixtureViewService,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ───────────── standings & resolution engine ─────────────

  private groupOf(f: Fixture): string {
    return f.groupLabel ?? '';
  }

  private tableFor(
    stage: TournamentStage,
    cfg: StageConfigBase,
    group: string,
    fixtures: Fixture[],
    ov: Override | undefined,
    fairPlay?: ReadonlyMap<string, number>,
  ): { rows: TableRow[]; confirmed: boolean } {
    const inGroup = fixtures.filter((f) => f.stageId === stage.id && this.groupOf(f) === group);
    const results: Played[] = [];
    let open = 0;
    let live = 0;
    for (const f of inGroup) {
      if (f.status === 'CANCELLED') continue;
      live += 1;
      const o = ov?.fixtureId === f.id ? ov : undefined;
      const hs = o ? o.homeScore : f.homeScore;
      const as = o ? o.awayScore : f.awayScore;
      const done = o ? true : f.status === 'FINISHED';
      if (!done || hs === null || as === null || !f.homeEntryId || !f.awayEntryId) {
        open += 1;
        continue;
      }
      results.push({ home: f.homeEntryId, away: f.awayEntryId, homeScore: hs, awayScore: as });
    }
    const members = new Set<string>(cfg.assignments?.[group] ?? []);
    for (const f of inGroup) {
      if (f.homeEntryId) members.add(f.homeEntryId);
      if (f.awayEntryId) members.add(f.awayEntryId);
    }
    const resolutions = (cfg.tieResolutions ?? []).filter((r) => r.group === group);
    return {
      rows: computeTable([...members], results, cfg, resolutions, { fairPlay }),
      confirmed: live > 0 && open === 0,
    };
  }

  /**
   * Fair-play totals per entry from CONFIRMED match events of matches linked to the stage's
   * fixtures (Match.fixtureId): yellow*w + red*w, lower is better. Only when the stage uses the
   * criterion; events without a team cannot be attributed and are ignored.
   */
  private async fairPlayFor(
    db: Db,
    cfg: StageConfigBase,
    fixtures: Fixture[],
  ): Promise<ReadonlyMap<string, number> | undefined> {
    if (!cfg.tiebreakers.includes('fairPlay') || !cfg.fairPlayWeights || fixtures.length === 0) {
      return undefined;
    }
    const w = cfg.fairPlayWeights;
    const matches = await db.match.findMany({
      where: { fixtureId: { in: fixtures.map((f) => f.id) }, status: 'CONFIRMED' },
      include: { events: { where: { type: { in: ['YELLOW_CARD', 'RED_CARD'] } } } },
    });
    const byFixture = new Map(fixtures.map((f) => [f.id, f]));
    const totals = new Map<string, number>();
    for (const m of matches) {
      const f = m.fixtureId ? byFixture.get(m.fixtureId) : undefined;
      if (!f) continue;
      for (const e of m.events) {
        const entry =
          e.teamId && e.teamId === m.homeTeamId
            ? f.homeEntryId
            : e.teamId && e.teamId === m.awayTeamId
              ? f.awayEntryId
              : null;
        if (!entry) continue;
        totals.set(entry, (totals.get(entry) ?? 0) + (e.type === 'RED_CARD' ? w.red : w.yellow));
      }
    }
    return totals;
  }

  /** Persist Standing rows of a stage from confirmed fixtures. */
  async recomputeStage(tx: Tx, stageId: string): Promise<void> {
    const stage = await tx.tournamentStage.findUnique({ where: { id: stageId } });
    if (!stage || stage.kind === 'KNOCKOUT') return;
    const cfg = readConfig(stage.config);
    const fixtures = await tx.fixture.findMany({ where: { stageId } });
    const groups = new Set<string>([
      ...Object.keys(cfg.assignments ?? {}),
      ...fixtures.map((f) => this.groupOf(f)),
    ]);
    const fair = await this.fairPlayFor(tx, cfg, fixtures);
    await tx.standing.deleteMany({ where: { stageId } });
    const data: Prisma.StandingCreateManyInput[] = [];
    for (const g of groups) {
      const { rows } = this.tableFor(stage, cfg, g, fixtures, undefined, fair);
      for (const r of rows) {
        data.push({
          stageId,
          groupLabel: g,
          entryId: r.entryId,
          played: r.played,
          won: r.won,
          drawn: r.drawn,
          lost: r.lost,
          goalsFor: r.goalsFor,
          goalsAgainst: r.goalsAgainst,
          points: r.points,
          rank: r.rank,
        });
      }
    }
    if (data.length) await tx.standing.createMany({ data });
  }

  /** What every placeholder side SHOULD point at given the (possibly hypothetical) results. */
  private async desired(db: Db, tournamentId: string, ov?: Override) {
    const [stages, fixtures] = await Promise.all([
      db.tournamentStage.findMany({ where: { tournamentId } }),
      db.fixture.findMany({ where: { tournamentId } }),
    ]);
    const byIndex = new Map(stages.map((s) => [s.index, s]));
    const shoot = new Map<string, ShootoutDto>();
    for (const s of stages) {
      for (const [fid, v] of Object.entries(readConfig(s.config).shootouts ?? {}))
        shoot.set(fid, v);
    }
    if (ov?.shootout) shoot.set(ov.fixtureId, ov.shootout);
    else if (ov) shoot.delete(ov.fixtureId);
    const fairByStage = new Map<string, ReadonlyMap<string, number>>();
    for (const s of stages) {
      const m = await this.fairPlayFor(
        db,
        readConfig(s.config),
        fixtures.filter((f) => f.stageId === s.id),
      );
      if (m) fairByStage.set(s.id, m);
    }
    const tables = new Map<string, { rows: TableRow[]; confirmed: boolean }>();
    const table = (idx: number, group: string) => {
      const key = `${idx}|${group}`;
      let t = tables.get(key);
      if (!t) {
        const stage = byIndex.get(idx);
        if (!stage || stage.kind === 'KNOCKOUT') return null;
        t = this.tableFor(
          stage,
          readConfig(stage.config),
          group,
          fixtures,
          ov,
          fairByStage.get(stage.id),
        );
        tables.set(key, t);
      }
      return t;
    };
    const result = (f: Fixture) => {
      if (ov?.fixtureId === f.id) {
        return winnerOf(
          { ...f, homeScore: ov.homeScore, awayScore: ov.awayScore, status: 'FINISHED' },
          shoot.get(f.id),
        );
      }
      return winnerOf(f, shoot.get(f.id));
    };
    const resolve = (p: string): string | null => {
      const r = RANK_RE.exec(p);
      if (r) {
        const t = table(Number(r[1]), r[2] as string);
        if (!t || !t.confirmed) return null;
        const row = t.rows.find((x) => x.rank === Number(r[3]));
        return row && !row.tied ? row.entryId : null;
      }
      const w = REF_RE.exec(p);
      if (w) {
        const src = fixtures.find((x) => x.id === w[2]);
        const res = src ? result(src) : null;
        return res ? (w[1] === 'W' ? res.winner : res.loser) : null;
      }
      return null;
    };
    return { fixtures, resolve };
  }

  /**
   * Fill placeholder sides that can now be resolved. `reassign` also re-points already resolved
   * sides of UNPLAYED fixtures (explicit organiser decision); played fixtures are never touched.
   */
  async resolvePlaceholders(
    tx: Tx,
    tournamentId: string,
    opts: { reassign?: boolean; ov?: Override } = {},
  ): Promise<Change[]> {
    const { fixtures, resolve } = await this.desired(tx, tournamentId, opts.ov);
    const changes: Change[] = [];
    for (const f of fixtures) {
      if (f.status !== 'SCHEDULED') continue;
      for (const side of ['home', 'away'] as const) {
        const placeholder = side === 'home' ? f.homePlaceholder : f.awayPlaceholder;
        const current = side === 'home' ? f.homeEntryId : f.awayEntryId;
        if (!placeholder) continue;
        const next = resolve(placeholder);
        if (next === current) continue;
        if (current !== null && !opts.reassign) continue;
        if (next === null && current === null) continue;
        changes.push({ fixtureId: f.id, side, current, next, status: f.status });
        await tx.fixture.update({
          where: { id: f.id },
          data: side === 'home' ? { homeEntryId: next } : { awayEntryId: next },
        });
      }
    }
    return changes;
  }

  /** Sides whose resolution would differ if `ov` were the truth (played fixtures flagged locked). */
  private async impactOf(db: Db, tournamentId: string, ov: Override) {
    const { fixtures, resolve } = await this.desired(db, tournamentId, ov);
    const ctx = await this.view.context(db, tournamentId);
    const out: { change: Change; locked: boolean; label: string }[] = [];
    for (const f of fixtures) {
      for (const side of ['home', 'away'] as const) {
        const placeholder = side === 'home' ? f.homePlaceholder : f.awayPlaceholder;
        const current = side === 'home' ? f.homeEntryId : f.awayEntryId;
        if (!placeholder || current === null) continue;
        const next = resolve(placeholder);
        if (next !== current) {
          out.push({
            change: { fixtureId: f.id, side, current, next, status: f.status },
            locked: f.status !== 'SCHEDULED',
            label: this.view.label(ctx, f),
          });
        }
      }
    }
    return out;
  }

  // ───────────── recording ─────────────

  private async loadFixture(db: Db, tournamentId: string, fixtureId: string) {
    const f = await db.fixture.findUnique({ where: { id: fixtureId }, include: { stage: true } });
    if (!f || f.tournamentId !== tournamentId)
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    return f;
  }

  private validateScore(kind: TournamentStage['kind'], dto: RecordResultDto): ShootoutDto | null {
    if (kind === 'KNOCKOUT') {
      if (dto.homeScore === dto.awayScore) {
        if (!dto.shootout || dto.shootout.home === dto.shootout.away) {
          throw new ApiError(
            ErrorCode.VALIDATION,
            'A knockout tie needs a decided penalty shoot-out',
            {
              field: 'shootout',
            },
          );
        }
        return dto.shootout;
      }
      if (dto.shootout) {
        throw new ApiError(ErrorCode.VALIDATION, 'A shoot-out is only for tied knockout matches', {
          field: 'shootout',
        });
      }
      return null;
    }
    if (dto.shootout) {
      throw new ApiError(ErrorCode.VALIDATION, 'Shoot-outs apply to knockout stages only', {
        field: 'shootout',
      });
    }
    return null;
  }

  private async saveShootout(
    tx: Tx,
    stage: TournamentStage,
    fixtureId: string,
    s: ShootoutDto | null,
  ) {
    const cfg = readConfig(stage.config);
    const map = { ...(cfg.shootouts ?? {}) };
    if (s) map[fixtureId] = s;
    else delete map[fixtureId];
    await tx.tournamentStage.update({
      where: { id: stage.id },
      data: { config: asJson({ ...cfg, shootouts: map }) },
    });
  }

  private async dtoOf(db: Db, tournamentId: string, fixtureId: string): Promise<FixtureDto> {
    const ctx = await this.view.context(db, tournamentId);
    const f = ctx.fixtures.find((x) => x.id === fixtureId) as Fixture;
    return this.view.toDto(ctx, f, true);
  }

  async record(
    actorId: string,
    tournamentId: string,
    fixtureId: string,
    dto: RecordResultDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<FixtureDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.result:${fixtureId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        await this.access.assertCan(tx, actorId, 'tournament.protocols', t);
        if (t.status !== 'LIVE') {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'Results can be recorded while the tournament is live',
            { status: t.status },
          );
        }
        const f = await this.loadFixture(tx, tournamentId, fixtureId);
        if (!f.homeEntryId || !f.awayEntryId) {
          throw new ApiError(ErrorCode.CONFLICT, 'Both sides of this match are not decided yet', {
            reason: 'SIDES_UNRESOLVED',
          });
        }
        if (f.status === 'FINISHED') {
          if (f.homeScore === dto.homeScore && f.awayScore === dto.awayScore)
            return this.dtoOf(tx, tournamentId, f.id);
          throw new ApiError(
            ErrorCode.CONFLICT,
            'This match is already played; use a correction with a reason',
            { reason: 'ALREADY_PLAYED' },
          );
        }
        if (f.status === 'CANCELLED' || f.status === 'POSTPONED') {
          throw new ApiError(ErrorCode.CONFLICT, 'This match is not scheduled to be played', {
            status: f.status,
          });
        }
        const shootout = this.validateScore(f.stage.kind, dto);
        await tx.fixture.update({
          where: { id: f.id },
          data: { homeScore: dto.homeScore, awayScore: dto.awayScore, status: 'FINISHED' },
        });
        if (shootout) await this.saveShootout(tx, f.stage, f.id, shootout);
        await this.recomputeStage(tx, f.stageId);
        const changes = await this.resolvePlaceholders(tx, tournamentId);
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.fixture.result',
          targetType: 'Fixture',
          targetId: f.id,
          requestId,
          metadata: {
            tournamentId,
            home: dto.homeScore,
            away: dto.awayScore,
            resolved: changes.length,
          },
        });
        await this.notifySides(tx, t.id, f, actorId, 'A match result was recorded');
        return this.dtoOf(tx, tournamentId, f.id);
      },
    );
  }

  private async notifySides(
    tx: Tx,
    tournamentId: string,
    f: Fixture,
    actorId: string,
    title: string,
  ) {
    const ids = [f.homeEntryId, f.awayEntryId].filter((x): x is string => !!x);
    const entries = await tx.clubEntry.findMany({
      where: { id: { in: ids } },
      select: { clubId: true, submittedById: true },
    });
    const recipients = new Set<string>();
    for (const e of entries) {
      recipients.add(e.submittedById);
      for (const r of await this.access.clubRepresentatives(tx, e.clubId)) recipients.add(r);
    }
    await this.notifier.notify(tx, {
      recipientIds: [...recipients],
      category: 'result',
      activityKind: 'tournament.result',
      title,
      objectType: 'Fixture',
      objectId: f.id,
      actorId,
      essential: true,
      payload: { tournamentId },
      dedupeKey: `tournament-result:${f.id}:${this.clock.now().getTime()}`,
    });
  }

  private overrideOf(f: Fixture, dto: RecordResultDto, shootout: ShootoutDto | null): Override {
    return { fixtureId: f.id, homeScore: dto.homeScore, awayScore: dto.awayScore, shootout };
  }

  /** Lists what a correction of a played result would change downstream (nothing is saved). */
  async impact(
    actorId: string,
    tournamentId: string,
    fixtureId: string,
    dto: RecordResultDto,
  ): Promise<ImpactDto> {
    const t = await this.access.loadVisible(this.prisma, actorId, tournamentId);
    this.access.assertOrganiser(actorId, t);
    const f = await this.loadFixture(this.prisma, tournamentId, fixtureId);
    const shootout = this.validateScore(f.stage.kind, dto);
    const list = await this.impactOf(this.prisma, tournamentId, this.overrideOf(f, dto, shootout));
    return { affected: this.affectedDtos(list) };
  }

  private affectedDtos(list: Awaited<ReturnType<ResultsService['impactOf']>>) {
    return list.map((x) => ({
      fixtureId: x.change.fixtureId,
      label: x.label,
      side: x.change.side,
      currentEntryId: x.change.current,
      newEntryId: x.change.next,
      status: x.change.status,
      locked: x.locked,
    }));
  }

  async correct(
    actorId: string,
    tournamentId: string,
    fixtureId: string,
    dto: CorrectResultDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<FixtureDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.correct:${fixtureId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        this.access.assertOrganiser(actorId, t); // final corrections belong to the chief organiser
        this.access.assertNotTerminal(t);
        const f = await this.loadFixture(tx, tournamentId, fixtureId);
        if (f.status !== 'FINISHED') {
          throw new ApiError(ErrorCode.CONFLICT, 'Only a played match can be corrected', {
            status: f.status,
          });
        }
        const shootout = this.validateScore(f.stage.kind, dto);
        const affected = await this.impactOf(tx, tournamentId, this.overrideOf(f, dto, shootout));
        if (affected.length > 0 && !dto.decision) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'The correction changes dependent matches; decide what to do with them',
            {
              reason: 'DEPENDENTS_AFFECTED',
              affected: this.affectedDtos(affected) as unknown as Prisma.InputJsonValue,
            },
          );
        }
        const old = { home: f.homeScore, away: f.awayScore };
        await tx.fixture.update({
          where: { id: f.id },
          data: { homeScore: dto.homeScore, awayScore: dto.awayScore },
        });
        await this.saveShootout(tx, f.stage, f.id, shootout);
        await this.recomputeStage(tx, f.stageId);
        await this.resolvePlaceholders(tx, tournamentId, {
          reassign: dto.decision === 'REASSIGN_UNPLAYED',
        });
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.fixture.correct',
          targetType: 'Fixture',
          targetId: f.id,
          requestId,
          metadata: {
            tournamentId,
            old,
            new: { home: dto.homeScore, away: dto.awayScore },
            reason: dto.reason,
            decision: dto.decision ?? null,
            affected: affected.length,
            locked: affected.filter((a) => a.locked).length,
          },
        });
        await this.notifySides(tx, tournamentId, f, actorId, 'A match result was corrected');
        return this.dtoOf(tx, tournamentId, f.id);
      },
    );
  }

  async setStatus(
    actorId: string,
    tournamentId: string,
    fixtureId: string,
    dto: FixtureStatusDto,
    key: string | undefined,
  ): Promise<FixtureDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.fixtureStatus:${fixtureId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        await this.access.assertCan(tx, actorId, 'tournament.protocols', t);
        this.access.assertNotTerminal(t);
        const f = await this.loadFixture(tx, tournamentId, fixtureId);
        if (f.status === 'FINISHED') {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'A played match keeps its result; use a correction',
            { status: f.status },
          );
        }
        if (f.status !== dto.status) {
          await tx.fixture.update({ where: { id: f.id }, data: { status: dto.status } });
          await this.recomputeStage(tx, f.stageId);
          if (['POSTPONED', 'CANCELLED'].includes(dto.status)) {
            await this.notifySides(
              tx,
              tournamentId,
              f,
              actorId,
              `A match was ${dto.status.toLowerCase()}`,
            );
          }
        }
        return this.dtoOf(tx, tournamentId, f.id);
      },
    );
  }

  /** Organiser orders a tied set explicitly (recorded with author and time) - never invented. */
  async resolveTie(
    actorId: string,
    tournamentId: string,
    stageId: string,
    dto: TieResolutionDto,
    requestId?: string,
  ): Promise<{ resolved: number }> {
    return this.prisma.$transaction(async (tx) => {
      await lockTournament(tx, tournamentId);
      const t = await this.access.loadVisible(tx, actorId, tournamentId);
      this.access.assertOrganiser(actorId, t);
      this.access.assertNotTerminal(t);
      const stage = await tx.tournamentStage.findUnique({ where: { id: stageId } });
      if (!stage || stage.tournamentId !== tournamentId || stage.kind === 'KNOCKOUT') {
        throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      }
      const rows = await tx.standing.findMany({ where: { stageId, groupLabel: dto.group } });
      const tiedRanks = new Set(dto.entryIds.map((id) => rows.find((r) => r.entryId === id)?.rank));
      const sameRank = rows.filter((r) => tiedRanks.has(r.rank));
      if (
        tiedRanks.size !== 1 ||
        tiedRanks.has(undefined) ||
        sameRank.length !== dto.entryIds.length ||
        !sameRank.every((r) => dto.entryIds.includes(r.entryId))
      ) {
        throw new ApiError(
          ErrorCode.CONFLICT,
          'Give exactly the clubs that are tied on the same rank',
          { group: dto.group },
        );
      }
      const cfg = readConfig(stage.config);
      const kept = (cfg.tieResolutions ?? []).filter(
        (r) => !(r.group === dto.group && r.entryIds.some((id) => dto.entryIds.includes(id))),
      );
      kept.push({
        group: dto.group,
        entryIds: dto.entryIds,
        byId: actorId,
        at: this.clock.now().toISOString(),
        reason: dto.reason ?? null,
      });
      await tx.tournamentStage.update({
        where: { id: stageId },
        data: { config: asJson({ ...cfg, tieResolutions: kept }) },
      });
      await this.recomputeStage(tx, stageId);
      const changes = await this.resolvePlaceholders(tx, tournamentId);
      await this.audit.record(tx, {
        actorId,
        action: 'tournament.standings.tie_resolution',
        targetType: 'TournamentStage',
        targetId: stageId,
        requestId,
        metadata: { group: dto.group, order: dto.entryIds, reason: dto.reason },
      });
      return { resolved: changes.length };
    });
  }
}
