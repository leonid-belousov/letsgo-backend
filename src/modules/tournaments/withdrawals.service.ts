import { Injectable } from '@nestjs/common';
import type { ClubEntry, EntryWithdrawal, Fixture, Prisma, Tournament } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Db, Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import type {
  RequestWithdrawalDto,
  ResolveWithdrawalDto,
  WithdrawalDto,
  WithdrawalListDto,
} from './dto/withdrawals.dto';
import { analyseSchedule } from './logic/scheduler';
import { ResultsService } from './results.service';
import { NOT_AVAILABLE, TournamentAccess, lockTournament } from './tournament-access.service';

const UNPLAYED = ['SCHEDULED', 'POSTPONED'] as const;
const isUnplayed = (f: Pick<Fixture, 'status'>) =>
  (UNPLAYED as readonly string[]).includes(f.status);

/**
 * A club leaving after the start (Decisions §44.8): the platform only records the request and
 * gives the chief organiser the mechanisms - it never picks a policy. Played matches are never
 * changed or deleted; technical results are always explicit scores.
 */
@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TournamentAccess,
    private readonly policy: PolicyService,
    private readonly idempotency: IdempotencyService,
    private readonly results: ResultsService,
    private readonly payments: PaymentsService,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private async toDtos(db: Db, rows: EntryWithdrawal[]): Promise<WithdrawalDto[]> {
    const entries = await db.clubEntry.findMany({
      where: { id: { in: rows.map((r) => r.entryId) } },
      include: { club: { select: { id: true, name: true, username: true } } },
    });
    const club = new Map(entries.map((e) => [e.id, e.club]));
    return rows.map((r) => ({
      id: r.id,
      tournamentId: r.tournamentId,
      entryId: r.entryId,
      club: club.get(r.entryId) ?? null,
      requestedById: r.requestedById,
      reason: r.reason,
      status: r.status,
      resolution: r.resolution,
      resolutionNote: r.resolutionNote,
      resolvedById: r.resolvedById,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      replacementEntryId: r.replacementEntryId,
      details: (r.details as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private async mustEntry(db: Db, tournamentId: string, entryId: string): Promise<ClubEntry> {
    const e = await db.clubEntry.findUnique({ where: { id: entryId } });
    if (!e || e.tournamentId !== tournamentId)
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    return e;
  }

  async request(
    actorId: string,
    tournamentId: string,
    entryId: string,
    dto: RequestWithdrawalDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<WithdrawalDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `tournaments.withdrawal.request:${entryId}`, key, payload: dto },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        const e = await this.mustEntry(tx, tournamentId, entryId);
        const isRep = await this.policy.can(
          actorId,
          'club.tournaments.enter',
          { type: 'CLUB', id: e.clubId },
          tx,
        );
        const isManager = await this.access.can(tx, actorId, 'tournament.applications', t);
        if (!isRep && !isManager)
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
        if (!['LIVE', 'POSTPONED'].includes(t.status)) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'Before the start use the normal withdraw / reject flow; this request is for a running tournament',
            { status: t.status },
          );
        }
        if (e.status !== 'ACCEPTED') {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'Only an accepted club can withdraw from a running tournament',
            {
              status: e.status,
            },
          );
        }
        const pending = await tx.entryWithdrawal.findFirst({
          where: { entryId, status: 'PENDING_RESOLUTION' },
        });
        if (pending) return (await this.toDtos(tx, [pending]))[0] as WithdrawalDto;
        const w = await tx.entryWithdrawal.create({
          data: { tournamentId, entryId, requestedById: actorId, reason: dto.reason },
        });
        await this.notifier.notify(tx, {
          recipientIds: await this.access.holders(tx, t, ['tournament.applications']),
          category: 'tournament',
          activityKind: 'tournament.withdrawal_requested',
          title: 'A club asked to leave the running tournament',
          objectType: 'EntryWithdrawal',
          objectId: w.id,
          actorId,
          essential: true,
          payload: { tournamentId, entryId },
          dedupeKey: `withdrawal-requested:${w.id}`,
        });
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.withdrawal.request',
          targetType: 'EntryWithdrawal',
          targetId: w.id,
          requestId,
          metadata: { tournamentId, entryId },
        });
        return (await this.toDtos(tx, [w]))[0] as WithdrawalDto;
      },
    );
  }

  async list(actorId: string, tournamentId: string): Promise<WithdrawalListDto> {
    const t = await this.access.loadVisible(this.prisma, actorId, tournamentId);
    const manager = await this.access.can(this.prisma, actorId, 'tournament.applications', t);
    let where: Prisma.EntryWithdrawalWhereInput = { tournamentId };
    if (!manager) {
      const clubs = await this.access.clubsFor(this.prisma, actorId, ['club.tournaments.enter']);
      const entries = await this.prisma.clubEntry.findMany({
        where: { tournamentId, clubId: { in: clubs } },
        select: { id: true },
      });
      if (entries.length === 0)
        throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
      where = { tournamentId, entryId: { in: entries.map((e) => e.id) } };
    }
    const rows = await this.prisma.entryWithdrawal.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return { items: await this.toDtos(this.prisma, rows) };
  }

  async resolve(
    actorId: string,
    tournamentId: string,
    withdrawalId: string,
    dto: ResolveWithdrawalDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<WithdrawalDto> {
    return this.idempotency.execute(
      {
        userId: actorId,
        scope: `tournaments.withdrawal.resolve:${withdrawalId}`,
        key,
        payload: dto,
      },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.access.loadVisible(tx, actorId, tournamentId);
        this.access.assertOrganiser(actorId, t); // assistants can never resolve
        this.access.assertNotTerminal(t);
        const w = await tx.entryWithdrawal.findUnique({ where: { id: withdrawalId } });
        if (!w || w.tournamentId !== tournamentId)
          throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (w.status === 'RESOLVED') {
          if (w.resolution === dto.resolution)
            return (await this.toDtos(tx, [w]))[0] as WithdrawalDto;
          throw new ApiError(ErrorCode.CONFLICT, 'This request was already resolved differently', {
            resolution: w.resolution,
          });
        }
        const entry = await this.mustEntry(tx, tournamentId, w.entryId);
        const fixtures = await tx.fixture.findMany({
          where: { tournamentId, OR: [{ homeEntryId: entry.id }, { awayEntryId: entry.id }] },
          include: { stage: { select: { kind: true } } },
        });
        const unplayed = fixtures.filter(isUnplayed);
        const details: Record<string, unknown> = {};
        const affectedEntryIds = new Set<string>([entry.id]);
        unplayed.forEach((f) => {
          if (f.homeEntryId) affectedEntryIds.add(f.homeEntryId);
          if (f.awayEntryId) affectedEntryIds.add(f.awayEntryId);
        });
        const stageIds = new Set(unplayed.map((f) => f.stageId));
        const before = await this.recipientsOf(tx, [...affectedEntryIds]);

        switch (dto.resolution) {
          case 'POSTPONE': {
            const ids = unplayed.filter((f) => f.status === 'SCHEDULED').map((f) => f.id);
            await tx.fixture.updateMany({
              where: { id: { in: ids } },
              data: { status: 'POSTPONED' },
            });
            details.postponed = ids;
            break;
          }
          case 'TECHNICAL_RESULT': {
            const list = dto.technicalResults ?? [];
            if (list.length === 0) {
              throw new ApiError(
                ErrorCode.VALIDATION,
                'Technical results need explicit scores for the fixtures; there is no default result',
                { field: 'technicalResults' },
              );
            }
            if (new Set(list.map((x) => x.fixtureId)).size !== list.length) {
              throw new ApiError(ErrorCode.VALIDATION, 'A fixture is listed twice', {
                field: 'technicalResults',
              });
            }
            for (const r of list) {
              const f = unplayed.find((x) => x.id === r.fixtureId);
              if (!f) {
                throw new ApiError(
                  ErrorCode.VALIDATION,
                  'Only unplayed fixtures of the withdrawing club can get a technical result',
                  { field: 'technicalResults', fixtureId: r.fixtureId },
                );
              }
              if (!f.homeEntryId || !f.awayEntryId) {
                throw new ApiError(
                  ErrorCode.VALIDATION,
                  'Both sides of the fixture must be known',
                  {
                    field: 'technicalResults',
                    fixtureId: f.id,
                  },
                );
              }
              if (f.stage.kind === 'KNOCKOUT' && r.homeScore === r.awayScore) {
                throw new ApiError(
                  ErrorCode.VALIDATION,
                  'A knockout technical result needs a winner',
                  {
                    field: 'technicalResults',
                    fixtureId: f.id,
                  },
                );
              }
              await tx.fixture.update({
                where: { id: f.id },
                data: { homeScore: r.homeScore, awayScore: r.awayScore, status: 'FINISHED' },
              });
              await this.audit.record(tx, {
                actorId,
                action: 'tournament.fixture.technical_result',
                targetType: 'Fixture',
                targetId: f.id,
                requestId,
                metadata: {
                  tournamentId,
                  withdrawalId,
                  home: r.homeScore,
                  away: r.awayScore,
                  note: dto.note,
                },
              });
            }
            details.technicalResults = list.map((x) => x.fixtureId);
            details.stillUnplayed = unplayed
              .filter((f) => !list.some((x) => x.fixtureId === f.id))
              .map((f) => f.id);
            break;
          }
          case 'REPLACEMENT': {
            await this.replace(
              tx,
              t,
              entry,
              unplayed,
              dto,
              actorId,
              details,
              affectedEntryIds,
              stageIds,
            );
            break;
          }
          case 'END_PARTICIPATION': {
            await tx.fixture.updateMany({
              where: { id: { in: unplayed.map((f) => f.id) } },
              data: { status: 'CANCELLED' },
            });
            details.cancelled = unplayed.map((f) => f.id);
            await this.leave(tx, entry, actorId, 'WITHDRAWN');
            break;
          }
        }

        for (const sid of stageIds) await this.results.recomputeStage(tx, sid);
        await this.results.resolvePlaceholders(tx, tournamentId);

        const updated = await tx.entryWithdrawal.update({
          where: { id: w.id },
          data: {
            status: 'RESOLVED',
            resolution: dto.resolution,
            resolutionNote: dto.note,
            resolvedById: actorId,
            resolvedAt: this.clock.now(),
            replacementEntryId:
              dto.resolution === 'REPLACEMENT' ? (dto.replacementEntryId ?? null) : null,
            details: details as Prisma.InputJsonObject,
          },
        });
        const after = await this.recipientsOf(tx, [...affectedEntryIds]);
        await this.notifyAffected(
          tx,
          t,
          new Set([...before, ...after]),
          actorId,
          dto.resolution,
          updated.id,
        );
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.withdrawal.resolve',
          targetType: 'EntryWithdrawal',
          targetId: w.id,
          requestId,
          metadata: { tournamentId, entryId: entry.id, resolution: dto.resolution, note: dto.note },
        });
        return (await this.toDtos(tx, [updated]))[0] as WithdrawalDto;
      },
    );
  }

  /** The club leaves: players released, unpaid fees cancelled (paid ones stay untouched). */
  private async leave(tx: Tx, entry: ClubEntry, actorId: string, status: 'WITHDRAWN') {
    const players = await tx.clubEntryPlayer.findMany({
      where: { entryId: entry.id, status: { in: ['INVITED', 'CONFIRMED'] } },
      select: { userId: true },
    });
    await tx.clubEntry.update({
      where: { id: entry.id },
      data: { status, decidedById: actorId, decidedAt: this.clock.now() },
    });
    await tx.clubEntryPlayer.updateMany({
      where: { entryId: entry.id, status: { in: ['INVITED', 'CONFIRMED'] } },
      data: { status: 'REMOVED' },
    });
    // Unpaid fees vanish; anything already paid is left exactly as it is (the organiser decides about money).
    await tx.paymentObligation.updateMany({
      where: {
        tournamentId: entry.tournamentId,
        paidMinor: 0,
        status: { not: 'CANCELLED' },
        OR: [
          { kind: 'TOURNAMENT_CLUB_FEE', payerClubId: entry.clubId },
          { kind: 'TOURNAMENT_PLAYER_FEE', payerUserId: { in: players.map((p) => p.userId) } },
        ],
      },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });
  }

  private async replace(
    tx: Tx,
    t: Tournament,
    entry: ClubEntry,
    unplayed: (Fixture & { stage: { kind: string } })[],
    dto: ResolveWithdrawalDto,
    actorId: string,
    details: Record<string, unknown>,
    affected: Set<string>,
    stageIds: Set<string>,
  ) {
    if (!dto.replacementEntryId) {
      throw new ApiError(ErrorCode.VALIDATION, 'A replacement needs replacementEntryId', {
        field: 'replacementEntryId',
      });
    }
    if (dto.replacementEntryId === entry.id) {
      throw new ApiError(ErrorCode.VALIDATION, 'A club cannot replace itself', {
        field: 'replacementEntryId',
      });
    }
    const rep = await this.mustEntry(tx, t.id, dto.replacementEntryId);
    if (!['ACCEPTED', 'APPLIED', 'WAITLISTED'].includes(rep.status)) {
      throw new ApiError(
        ErrorCode.CONFLICT,
        'The replacement must be an accepted or pending club',
        { status: rep.status },
      );
    }
    const clash = unplayed.filter((f) => f.homeEntryId === rep.id || f.awayEntryId === rep.id);
    if (clash.length > 0) {
      throw new ApiError(
        ErrorCode.CONFLICT,
        'The replacement already plays some of these matches against the leaving club',
        {
          fixtureIds: clash.map((f) => f.id) as unknown as Prisma.InputJsonValue,
        },
      );
    }
    // the replacement must not end up in two matches at once
    const timed = await tx.fixture.findMany({
      where: {
        tournamentId: t.id,
        startsAt: { not: null },
        endsAt: { not: null },
        status: { in: ['SCHEDULED', 'LIVE', 'POSTPONED'] },
        OR: [
          { homeEntryId: rep.id },
          { awayEntryId: rep.id },
          { id: { in: unplayed.map((f) => f.id) } },
        ],
      },
    });
    const slots = timed.flatMap((f) => [
      {
        id: f.id,
        pitchId: null,
        start: (f.startsAt as Date).getTime(),
        end: (f.endsAt as Date).getTime(),
        clubs: [
          f.homeEntryId === entry.id ? rep.id : f.homeEntryId,
          f.awayEntryId === entry.id ? rep.id : f.awayEntryId,
        ].filter((x): x is string => !!x),
      },
    ]);
    const overlap = analyseSchedule(slots, 0).conflicts.filter(
      (c) => c.type === 'CLUB_OVERLAP' && c.clubId === rep.id,
    );
    if (overlap.length > 0) {
      throw new ApiError(
        ErrorCode.CONFLICT,
        'The replacement would play two matches at the same time',
        {
          fixtureIds: overlap.flatMap((c) => c.fixtureIds) as unknown as Prisma.InputJsonValue,
        },
      );
    }
    if (rep.status !== 'ACCEPTED') {
      await tx.clubEntry.update({
        where: { id: rep.id },
        data: { status: 'ACCEPTED', decidedById: actorId, decidedAt: this.clock.now() },
      });
      if (t.feeMode === 'PER_CLUB') {
        await this.payments.ensureTournamentObligation(tx, {
          kind: 'TOURNAMENT_CLUB_FEE',
          tournamentId: t.id,
          payerClubId: rep.clubId,
          amountMinor: t.feeMinor,
          currency: t.currency,
        });
      }
    }
    for (const f of unplayed) {
      await tx.fixture.update({
        where: { id: f.id },
        data: f.homeEntryId === entry.id ? { homeEntryId: rep.id } : { awayEntryId: rep.id },
      });
    }
    details.replacementEntryId = rep.id;
    details.reassigned = unplayed.map((f) => f.id);
    affected.add(rep.id);
    unplayed.forEach((f) => stageIds.add(f.stageId));
    await this.leave(tx, entry, actorId, 'WITHDRAWN');
  }

  private async recipientsOf(tx: Tx, entryIds: string[]): Promise<Set<string>> {
    const entries = await tx.clubEntry.findMany({
      where: { id: { in: entryIds } },
      include: { players: { where: { status: { in: ['INVITED', 'CONFIRMED'] } } } },
    });
    const recipients = new Set<string>();
    for (const e of entries) {
      recipients.add(e.submittedById);
      for (const r of await this.access.clubRepresentatives(tx, e.clubId)) recipients.add(r);
      e.players.forEach((p) => recipients.add(p.userId));
    }
    return recipients;
  }

  private async notifyAffected(
    tx: Tx,
    t: Tournament,
    recipients: Set<string>,
    actorId: string,
    resolution: string,
    withdrawalId: string,
  ) {
    await this.notifier.notify(tx, {
      recipientIds: [...recipients],
      category: 'tournament',
      activityKind: 'tournament.withdrawal_resolved',
      title: `A club left the tournament: ${resolution.toLowerCase().replace('_', ' ')}`,
      objectType: 'EntryWithdrawal',
      objectId: withdrawalId,
      actorId,
      essential: true,
      payload: { tournamentId: t.id, resolution },
      dedupeKey: `withdrawal-resolved:${withdrawalId}`,
    });
  }
}
