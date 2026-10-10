import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Event, Match, MatchEvent, Participation, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import { lockEvent, type Tx } from '../../common/transactions/tx';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  CaptainDto,
  CorrectMatchDto,
  CreateMatchDto,
  MatchDto,
  MatchListDto,
  MatchRevisionDto,
  MatchRevisionsDto,
  MvpSummaryDto,
  RevisionSnapshotEventDto,
  type AddMatchEventDto,
  type MatchEventInputDto,
} from './dto';
import {
  deriveScore,
  isOpen,
  MatchViewService,
  NOT_AVAILABLE,
  RECORDING_EVENT_STATES,
  RESULT_EVENT_STATES,
  type MatchRow,
  type Rights,
} from './match-view.service';
import { MvpService } from './mvp.service';

interface Loaded {
  match: MatchRow;
  event: Event;
  rights: Rights;
}

interface EventData {
  type: MatchEvent['type'];
  teamId: string | null;
  playerId: string;
  assistById: string | null;
  minute: number | null;
}

async function lockMatch(tx: Tx, matchId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId}::uuid FOR UPDATE`;
}

@Injectable()
export class ResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly idempotency: IdempotencyService,
    private readonly view: MatchViewService,
    private readonly mvp: MvpService,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ───────────── reads ─────────────

  async list(viewerId: string | null, eventId: string): Promise<MatchListDto> {
    const ev = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!ev) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    const rights = await this.view.rights(this.prisma, viewerId, eventId);
    if (ev.status === 'DRAFT' && !rights.record && !rights.confirm) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    const matches = await this.prisma.match.findMany({
      where: { eventId },
      include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const items: MatchDto[] = [];
    for (const m of matches) {
      if (this.view.canView(ev, m, rights))
        items.push(await this.view.build(this.prisma, m, ev, rights));
    }
    return { items, nextCursor: null };
  }

  get(viewerId: string | null, matchId: string): Promise<MatchDto> {
    return this.view.detail(this.prisma, viewerId, matchId);
  }

  async revisions(actorId: string, matchId: string): Promise<MatchRevisionsDto> {
    const row = await this.view.loadRow(this.prisma, matchId);
    if (!row) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    const rights = await this.view.rights(this.prisma, actorId, row.event.id);
    if (!this.view.canView(row.event, row.match, rights)) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    if (!rights.record && !rights.confirm) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    const revs = await this.prisma.matchRevision.findMany({
      where: { matchId },
      orderBy: { version: 'desc' },
    });
    return {
      items: revs.map((r): MatchRevisionDto => {
        const snap = r.snapshot as unknown as {
          homeScore: number | null;
          awayScore: number | null;
          events: RevisionSnapshotEventDto[];
        };
        return {
          version: r.version,
          reason: r.reason,
          changedById: r.changedById,
          createdAt: r.createdAt.toISOString(),
          snapshot: { homeScore: snap.homeScore, awayScore: snap.awayScore, events: snap.events },
        };
      }),
    };
  }

  // ───────────── create / record ─────────────

  async create(
    actorId: string,
    eventId: string,
    dto: CreateMatchDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<MatchDto> {
    if ((dto.homeScore === undefined) !== (dto.awayScore === undefined)) {
      throw new ApiError(ErrorCode.VALIDATION, 'Provide both scores or neither', {
        field: 'homeScore',
      });
    }
    if (dto.homeTeamId === dto.awayTeamId) {
      throw new ApiError(ErrorCode.VALIDATION, 'A team cannot play itself', {
        field: 'awayTeamId',
      });
    }
    return this.idempotency.execute(
      { userId: actorId, scope: `results.create:${eventId}`, key, payload: dto },
      async (tx) => {
        await lockEvent(tx, eventId);
        const ev = await tx.event.findUnique({ where: { id: eventId } });
        if (!ev) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        const rights = await this.view.rights(tx, actorId, eventId);
        if (ev.status === 'DRAFT' && !rights.record)
          throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (!rights.record) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
        }
        if (!RECORDING_EVENT_STATES.includes(ev.status)) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'Results can be recorded once the game has started',
            {
              status: ev.status,
            },
          );
        }
        const teams = await tx.eventTeam.findMany({
          where: { eventId, id: { in: [dto.homeTeamId, dto.awayTeamId] } },
          select: { id: true },
        });
        if (teams.length !== 2) {
          throw new ApiError(ErrorCode.VALIDATION, 'Both teams must belong to this game', {
            field: 'homeTeamId',
          });
        }
        const match = await tx.match.create({
          data: {
            eventId,
            homeTeamId: dto.homeTeamId,
            awayTeamId: dto.awayTeamId,
            startsAt: dto.startsAt ?? ev.startsAt,
            homeScore: dto.homeScore ?? null,
            awayScore: dto.awayScore ?? null,
          },
        });
        await this.syncEventStatus(tx, eventId);
        await this.audit.record(tx, {
          actorId,
          action: 'match.create',
          targetType: 'Match',
          targetId: match.id,
          requestId,
          metadata: { eventId },
        });
        return this.view.detail(tx, actorId, match.id);
      },
    );
  }

  async addEvent(
    actorId: string,
    matchId: string,
    dto: AddMatchEventDto,
    key: string | undefined,
  ): Promise<MatchDto> {
    const eventId = await this.eventIdOf(matchId);
    return this.idempotency.execute(
      { userId: actorId, scope: `results.addEvent:${matchId}`, key, payload: dto },
      async (tx) => {
        const l = await this.load(tx, actorId, matchId, eventId);
        this.assertRecorder(l);
        this.checkVersion(l.match, dto.version);
        const data = await this.resolveEvent(tx, l, dto, false);
        if (!l.rights.record && (!data.teamId || !l.rights.captainTeamIds.includes(data.teamId))) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
        }
        const hadGoals = l.match.events.some((e) => e.type === 'GOAL' || e.type === 'OWN_GOAL');
        const isGoal = data.type === 'GOAL' || data.type === 'OWN_GOAL';
        if (
          isGoal &&
          !hadGoals &&
          l.match.homeScore !== null &&
          (l.match.homeScore !== 0 || l.match.awayScore !== 0)
        ) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'A score was entered directly. Clear it before recording scorers so the two cannot disagree.',
            {
              reason: 'SCORE_SET_DIRECTLY',
              homeScore: l.match.homeScore,
              awayScore: l.match.awayScore,
            },
          );
        }
        await tx.matchEvent.create({ data: { matchId, recordedById: actorId, ...data } });
        await this.resyncScore(tx, l.match, hadGoals);
        return this.view.detail(tx, actorId, matchId);
      },
    );
  }

  async removeEvent(
    actorId: string,
    matchId: string,
    eventRowId: string,
    version: number | undefined,
  ): Promise<MatchDto> {
    const eventId = await this.eventIdOf(matchId);
    return this.prisma.$transaction(async (tx) => {
      const l = await this.load(tx, actorId, matchId, eventId);
      this.assertRecorder(l);
      this.checkVersion(l.match, version);
      const row = l.match.events.find((e) => e.id === eventRowId);
      if (!row) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      if (!l.rights.record && (!row.teamId || !l.rights.captainTeamIds.includes(row.teamId))) {
        throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
      }
      const hadGoals = l.match.events.some((e) => e.type === 'GOAL' || e.type === 'OWN_GOAL');
      await tx.matchEvent.delete({ where: { id: eventRowId } });
      await this.resyncScore(tx, l.match, hadGoals);
      return this.view.detail(tx, actorId, matchId);
    });
  }

  async setScore(
    actorId: string,
    matchId: string,
    dto: { homeScore?: number | null; awayScore?: number | null; version?: number },
    key: string | undefined,
  ): Promise<MatchDto> {
    const home = dto.homeScore ?? null;
    const away = dto.awayScore ?? null;
    if ((home === null) !== (away === null)) {
      throw new ApiError(ErrorCode.VALIDATION, 'Provide both scores or clear both', {
        field: 'homeScore',
      });
    }
    const eventId = await this.eventIdOf(matchId);
    return this.idempotency.execute(
      { userId: actorId, scope: `results.score:${matchId}`, key, payload: dto },
      async (tx) => {
        const l = await this.load(tx, actorId, matchId, eventId);
        if (!l.rights.record) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
        }
        this.assertRecorder(l);
        this.checkVersion(l.match, dto.version);
        const d = deriveScore(l.match, l.match.events);
        if (d.hasGoals) {
          if (home === d.home && away === d.away) return this.view.detail(tx, actorId, matchId);
          throw new ApiError(
            ErrorCode.CONFLICT,
            'The score is derived from the recorded goals. Remove or correct the goal events instead.',
            { reason: 'SCORE_DERIVED', derivedHome: d.home, derivedAway: d.away },
          );
        }
        if (home === l.match.homeScore && away === l.match.awayScore) {
          return this.view.detail(tx, actorId, matchId);
        }
        await tx.match.update({
          where: { id: matchId },
          data: { homeScore: home, awayScore: away, version: { increment: 1 } },
        });
        return this.view.detail(tx, actorId, matchId);
      },
    );
  }

  // ───────────── lifecycle ─────────────

  async submit(
    actorId: string,
    matchId: string,
    version: number | undefined,
    key: string | undefined,
  ): Promise<MatchDto> {
    const eventId = await this.eventIdOf(matchId);
    return this.idempotency.execute(
      { userId: actorId, scope: `results.submit:${matchId}`, key, payload: { version } },
      async (tx) => {
        const l = await this.load(tx, actorId, matchId, eventId);
        if (
          l.match.status === 'AWAITING_CONFIRMATION' &&
          (l.rights.record || this.view.captainInScope(l.rights, l.match))
        ) {
          return this.view.detail(tx, actorId, matchId); // idempotent
        }
        this.assertRecorder(l);
        this.checkVersion(l.match, version);
        this.assertScoreReady(l.match);
        await tx.match.update({
          where: { id: matchId },
          data: { status: 'AWAITING_CONFIRMATION', version: { increment: 1 } },
        });
        await this.syncEventStatus(tx, eventId);
        await this.notifier.notify(tx, {
          recipientIds: [l.event.organiserId],
          category: 'result',
          activityKind: 'match.awaiting_confirmation',
          title: 'A result is waiting for your confirmation',
          objectType: 'Match',
          objectId: matchId,
          actorId,
          essential: true,
          dedupeKey: `match:${matchId}:awaiting:${l.match.version}`,
        });
        return this.view.detail(tx, actorId, matchId);
      },
    );
  }

  async confirm(
    actorId: string,
    matchId: string,
    version: number,
    key: string | undefined,
    requestId?: string,
  ): Promise<MatchDto> {
    const eventId = await this.eventIdOf(matchId);
    return this.idempotency.execute(
      { userId: actorId, scope: `results.confirm:${matchId}`, key, payload: { version } },
      async (tx) => {
        const l = await this.load(tx, actorId, matchId, eventId);
        if (!l.rights.confirm) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
        }
        if (l.match.status === 'CONFIRMED') return this.view.detail(tx, actorId, matchId); // idempotent
        if (l.match.status === 'CANCELLED') {
          throw new ApiError(ErrorCode.CONFLICT, 'A cancelled match cannot be confirmed');
        }
        if (!RESULT_EVENT_STATES.includes(l.event.status)) {
          throw new ApiError(ErrorCode.CONFLICT, 'Finish the game before confirming the result', {
            status: l.event.status,
          });
        }
        this.checkVersion(l.match, version);
        this.assertScoreReady(l.match);
        const now = this.clock.now();
        const hours = this.config.get('MVP_VOTING_HOURS', { infer: true });
        await tx.match.update({
          where: { id: matchId },
          data: {
            status: 'CONFIRMED',
            confirmedById: actorId,
            confirmedAt: now,
            mvpVotingClosesAt: new Date(now.getTime() + hours * 3_600_000),
            version: { increment: 1 },
          },
        });
        await this.syncEventStatus(tx, eventId);
        await this.audit.record(tx, {
          actorId,
          action: 'match.confirm',
          targetType: 'Match',
          targetId: matchId,
          requestId,
          metadata: { eventId, version: l.match.version + 1 },
        });
        await this.notifyParticipants(
          tx,
          l,
          actorId,
          'match.confirmed',
          'Result confirmed',
          `match:${matchId}:confirmed`,
        );
        return this.view.detail(tx, actorId, matchId);
      },
    );
  }

  async cancel(
    actorId: string,
    matchId: string,
    dto: { reason?: string; version?: number },
    key: string | undefined,
    requestId?: string,
  ): Promise<MatchDto> {
    const eventId = await this.eventIdOf(matchId);
    return this.idempotency.execute(
      { userId: actorId, scope: `results.cancel:${matchId}`, key, payload: dto },
      async (tx) => {
        const l = await this.load(tx, actorId, matchId, eventId);
        if (!l.rights.record) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
        }
        if (l.match.status === 'CANCELLED') return this.view.detail(tx, actorId, matchId);
        this.assertRecorder(l);
        this.checkVersion(l.match, dto.version);
        await tx.match.update({
          where: { id: matchId },
          data: { status: 'CANCELLED', mvpVotingClosesAt: null, version: { increment: 1 } },
        });
        await this.syncEventStatus(tx, eventId);
        await this.audit.record(tx, {
          actorId,
          action: 'match.cancel',
          targetType: 'Match',
          targetId: matchId,
          requestId,
          metadata: { eventId, reason: dto.reason ?? null },
        });
        return this.view.detail(tx, actorId, matchId);
      },
    );
  }

  /** Correction after confirmation: immutable revision of the previous state, mandatory reason. */
  async correct(
    actorId: string,
    matchId: string,
    dto: CorrectMatchDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<MatchDto> {
    if ((dto.homeScore === undefined) !== (dto.awayScore === undefined)) {
      throw new ApiError(ErrorCode.VALIDATION, 'Provide both scores or neither', {
        field: 'homeScore',
      });
    }
    if (dto.events === undefined && dto.homeScore === undefined) {
      throw new ApiError(
        ErrorCode.VALIDATION,
        'Nothing to correct: provide events and/or a score',
        {
          field: 'events',
        },
      );
    }
    const eventId = await this.eventIdOf(matchId);
    return this.idempotency.execute(
      { userId: actorId, scope: `results.correct:${matchId}`, key, payload: dto },
      async (tx) => {
        const l = await this.load(tx, actorId, matchId, eventId);
        if (!l.rights.confirm) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
        }
        if (l.match.status !== 'CONFIRMED') {
          throw new ApiError(ErrorCode.CONFLICT, 'Only a confirmed result is corrected this way', {
            status: l.match.status,
          });
        }
        this.checkVersion(l.match, dto.version);

        const snapshot = {
          status: l.match.status,
          homeTeamId: l.match.homeTeamId,
          awayTeamId: l.match.awayTeamId,
          homeScore: l.match.homeScore,
          awayScore: l.match.awayScore,
          confirmedById: l.match.confirmedById,
          confirmedAt: l.match.confirmedAt ? l.match.confirmedAt.toISOString() : null,
          events: l.match.events.map((e) => ({
            id: e.id,
            type: e.type,
            teamId: e.teamId,
            playerId: e.playerId,
            assistById: e.assistById,
            minute: e.minute,
            recordedById: e.recordedById,
          })),
        };

        let nextEvents: EventData[] = l.match.events.map((e) => ({
          type: e.type,
          teamId: e.teamId,
          playerId: e.playerId,
          assistById: e.assistById,
          minute: e.minute,
        }));
        if (dto.events) {
          nextEvents = [];
          for (const input of dto.events)
            nextEvents.push(await this.resolveEvent(tx, l, input, true));
        }
        const d = deriveScore(l.match, nextEvents);
        let home: number | null;
        let away: number | null;
        if (d.hasGoals) {
          if (
            dto.homeScore !== undefined &&
            (dto.homeScore !== d.home || dto.awayScore !== d.away)
          ) {
            throw new ApiError(
              ErrorCode.CONFLICT,
              'The score is derived from the goal events and cannot be set differently',
              { reason: 'SCORE_DERIVED', derivedHome: d.home, derivedAway: d.away },
            );
          }
          home = d.home;
          away = d.away;
        } else if (dto.homeScore !== undefined) {
          home = dto.homeScore;
          away = dto.awayScore ?? null;
        } else if (l.match.events.some((e) => e.type === 'GOAL' || e.type === 'OWN_GOAL')) {
          throw new ApiError(
            ErrorCode.VALIDATION,
            'The corrected events contain no goals: provide the score explicitly',
            { field: 'homeScore' },
          );
        } else {
          home = l.match.homeScore;
          away = l.match.awayScore;
        }

        const sameEvents =
          key4(nextEvents) ===
          key4(
            l.match.events.map((e) => ({
              type: e.type,
              teamId: e.teamId,
              playerId: e.playerId,
              assistById: e.assistById,
              minute: e.minute,
            })),
          );
        if (sameEvents && home === l.match.homeScore && away === l.match.awayScore) {
          throw new ApiError(ErrorCode.VALIDATION, 'The correction changes nothing', {
            field: 'events',
          });
        }

        await tx.matchRevision.create({
          data: {
            matchId,
            version: l.match.version,
            snapshot: snapshot as unknown as Prisma.InputJsonObject,
            reason: dto.reason,
            changedById: actorId,
          },
        });
        if (dto.events) {
          await tx.matchEvent.deleteMany({ where: { matchId } });
          if (nextEvents.length > 0) {
            await tx.matchEvent.createMany({
              data: nextEvents.map((e) => ({ matchId, recordedById: actorId, ...e })),
            });
          }
        }
        await tx.match.update({
          where: { id: matchId },
          data: { homeScore: home, awayScore: away, version: { increment: 1 } },
        });
        await this.audit.record(tx, {
          actorId,
          action: 'match.correct',
          targetType: 'Match',
          targetId: matchId,
          requestId,
          metadata: {
            eventId,
            fromVersion: l.match.version,
            toVersion: l.match.version + 1,
            reason: dto.reason,
            before: { homeScore: l.match.homeScore, awayScore: l.match.awayScore },
            after: { homeScore: home, awayScore: away },
          },
        });
        await this.notifyParticipants(
          tx,
          l,
          actorId,
          'match.corrected',
          'A confirmed result was corrected',
          `match:${matchId}:corrected:${l.match.version + 1}`,
        );
        return this.view.detail(tx, actorId, matchId);
      },
    );
  }

  // ───────────── MVP ─────────────

  async vote(voterId: string, matchId: string, candidateId: string): Promise<MvpSummaryDto> {
    await this.mvp.vote(voterId, matchId, candidateId);
    return (await this.view.detail(this.prisma, voterId, matchId)).mvp;
  }

  async decideMvp(
    actorId: string,
    matchId: string,
    mvpUserId: string,
    requestId?: string,
  ): Promise<MvpSummaryDto> {
    await this.mvp.decide(actorId, matchId, mvpUserId, requestId);
    return (await this.view.detail(this.prisma, actorId, matchId)).mvp;
  }

  async mvpSummary(viewerId: string | null, matchId: string): Promise<MvpSummaryDto> {
    return (await this.view.detail(this.prisma, viewerId, matchId)).mvp;
  }

  // ───────────── captains ─────────────

  async setCaptain(
    actorId: string,
    eventId: string,
    teamId: string,
    userId: string | null,
    requestId?: string,
  ): Promise<CaptainDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockEvent(tx, eventId);
      const ev = await tx.event.findUnique({ where: { id: eventId } });
      const team = await tx.eventTeam.findFirst({ where: { id: teamId, eventId } });
      if (!ev || !team) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      const target = { type: 'EVENT', id: eventId } as const;
      const allowed =
        (await this.policy.can(actorId, 'event.manage', target, tx)) ||
        (ev.clubId
          ? await this.policy.can(
              actorId,
              'club.captains.appoint',
              { type: 'CLUB', id: ev.clubId },
              tx,
            )
          : false) ||
        (team.clubId
          ? await this.policy.can(
              actorId,
              'club.captains.appoint',
              { type: 'CLUB', id: team.clubId },
              tx,
            )
          : false);
      if (!allowed) {
        if (ev.status === 'DRAFT') throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
      }
      if (ev.status === 'CANCELLED') {
        throw new ApiError(ErrorCode.CONFLICT, 'This game was cancelled');
      }
      if (userId) {
        const p = await tx.participation.findUnique({
          where: { eventId_userId: { eventId, userId } },
        });
        if (p?.status !== 'CONFIRMED') {
          throw new ApiError(
            ErrorCode.VALIDATION,
            'A captain must be a confirmed player of this game',
            {
              field: 'userId',
            },
          );
        }
        if (p.teamId && p.teamId !== teamId) {
          throw new ApiError(ErrorCode.VALIDATION, 'The player belongs to another team', {
            field: 'userId',
          });
        }
      }
      if (team.captainId === userId) return { teamId, captainId: userId };
      await tx.eventTeam.update({ where: { id: teamId }, data: { captainId: userId } });
      await this.audit.record(tx, {
        actorId,
        action: userId ? 'team.captain.appoint' : 'team.captain.clear',
        targetType: 'EventTeam',
        targetId: teamId,
        requestId,
        metadata: { eventId, captainId: userId, previousCaptainId: team.captainId },
      });
      if (userId) {
        await this.notifier.notify(tx, {
          recipientIds: [userId],
          category: 'result',
          activityKind: 'team.captain.appointed',
          title: 'You were appointed team captain',
          objectType: 'Event',
          objectId: eventId,
          actorId,
          essential: true,
          dedupeKey: `team:${teamId}:captain:${userId}`,
        });
      }
      return { teamId, captainId: userId };
    });
  }

  // ───────────── internals ─────────────

  private async eventIdOf(matchId: string): Promise<string> {
    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { eventId: true },
    });
    if (!m) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    return m.eventId;
  }

  /** Locks event then match (fixed order) and loads the state the rules run against. */
  private async load(tx: Tx, actorId: string, matchId: string, eventId: string): Promise<Loaded> {
    await lockEvent(tx, eventId);
    await lockMatch(tx, matchId);
    const row = await this.view.loadRow(tx, matchId);
    if (!row) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    const rights = await this.view.rights(tx, actorId, eventId);
    if (!this.view.canView(row.event, row.match, rights)) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    return { match: row.match, event: row.event, rights };
  }

  private checkVersion(m: Match, version: number | undefined): void {
    if (version !== undefined && version !== m.version) {
      throw new ApiError(ErrorCode.VERSION_CHANGED, 'This result was changed by someone else', {
        currentVersion: m.version,
      });
    }
  }

  private assertRecorder(l: Loaded): void {
    const staff = l.rights.record;
    const captain = this.view.captainInScope(l.rights, l.match);
    if (!staff && !captain) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    if (!isOpen(l.match.status)) {
      // Captains lose every right once the protocol is final.
      if (!staff)
        throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
      throw new ApiError(
        ErrorCode.CONFLICT,
        'This result is final. Use a correction with a reason.',
        {
          reason: 'MATCH_LOCKED',
          status: l.match.status,
        },
      );
    }
    if (!RECORDING_EVENT_STATES.includes(l.event.status)) {
      throw new ApiError(ErrorCode.CONFLICT, 'Results can be recorded once the game has started', {
        status: l.event.status,
      });
    }
  }

  private assertScoreReady(m: MatchRow): void {
    const d = deriveScore(m, m.events);
    if (m.homeScore === null || m.awayScore === null) {
      throw new ApiError(ErrorCode.VALIDATION, 'Set the score first (0-0 if there were no goals)', {
        field: 'homeScore',
      });
    }
    if (d.hasGoals && (m.homeScore !== d.home || m.awayScore !== d.away)) {
      throw new ApiError(ErrorCode.CONFLICT, 'The score disagrees with the recorded goals', {
        reason: 'SCORE_MISMATCH',
        derivedHome: d.home,
        derivedAway: d.away,
      });
    }
  }

  /** Validates one event against the match and its event's roster. */
  private async resolveEvent(
    tx: Tx,
    l: Loaded,
    input: MatchEventInputDto,
    relaxed: boolean,
  ): Promise<EventData> {
    const m = l.match;
    const matchTeams = [m.homeTeamId, m.awayTeamId].filter((x): x is string => x !== null);
    const partOf = async (userId: string): Promise<Participation | null> => {
      const p = await tx.participation.findUnique({
        where: { eventId_userId: { eventId: m.eventId, userId } },
      });
      if (!p) return null;
      if (p.status === 'CONFIRMED' || (relaxed && p.confirmedAt !== null)) return p;
      return null;
    };
    const player = await partOf(input.playerId);
    if (!player) {
      throw new ApiError(
        ErrorCode.VALIDATION,
        'The player is not a confirmed participant of this game',
        {
          field: 'playerId',
        },
      );
    }
    if (input.teamId && player.teamId && input.teamId !== player.teamId) {
      throw new ApiError(ErrorCode.VALIDATION, 'The player belongs to a different team', {
        field: 'teamId',
      });
    }
    const teamId = input.teamId ?? player.teamId ?? null;
    if (teamId && !matchTeams.includes(teamId)) {
      throw new ApiError(ErrorCode.VALIDATION, 'The team does not play in this match', {
        field: 'teamId',
      });
    }
    const isGoal = input.type === 'GOAL' || input.type === 'OWN_GOAL';
    if (isGoal && !teamId) {
      throw new ApiError(ErrorCode.VALIDATION, 'teamId is required for a goal', {
        field: 'teamId',
      });
    }
    let assistById: string | null = null;
    if (input.assistById) {
      if (input.type !== 'GOAL') {
        throw new ApiError(ErrorCode.VALIDATION, 'Only a goal can have an assist', {
          field: 'assistById',
        });
      }
      if (input.assistById === input.playerId) {
        throw new ApiError(ErrorCode.VALIDATION, 'The scorer cannot assist their own goal', {
          field: 'assistById',
        });
      }
      const assist = await partOf(input.assistById);
      if (!assist) {
        throw new ApiError(
          ErrorCode.VALIDATION,
          'The assisting player is not a confirmed participant',
          {
            field: 'assistById',
          },
        );
      }
      if (assist.teamId && teamId && assist.teamId !== teamId) {
        throw new ApiError(ErrorCode.VALIDATION, 'The assist must come from the scoring team', {
          field: 'assistById',
        });
      }
      assistById = input.assistById;
    }
    return {
      type: input.type,
      teamId,
      playerId: input.playerId,
      assistById,
      minute: input.minute ?? null,
    };
  }

  /** Scores are derived from goals when any exist; a match that lost its last goal needs a fresh score. */
  private async resyncScore(tx: Tx, m: Match, hadGoals: boolean): Promise<void> {
    const events = await tx.matchEvent.findMany({ where: { matchId: m.id } });
    const d = deriveScore(m, events);
    const data: Prisma.MatchUpdateInput = { version: { increment: 1 } };
    if (d.hasGoals) {
      data.homeScore = d.home;
      data.awayScore = d.away;
    } else if (hadGoals) {
      data.homeScore = null;
      data.awayScore = null;
    }
    await tx.match.update({ where: { id: m.id }, data });
  }

  /** FINISHED ⇄ RESULT_PENDING ⇄ RESULT_CONFIRMED follows the state of the event's matches. */
  private async syncEventStatus(tx: Tx, eventId: string): Promise<void> {
    const ev = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
    if (!RESULT_EVENT_STATES.includes(ev.status)) return;
    const matches = await tx.match.findMany({
      where: { eventId, status: { not: 'CANCELLED' } },
      select: { status: true },
    });
    let next: Event['status'];
    if (matches.length === 0) next = ev.status === 'RESULT_PENDING' ? 'FINISHED' : ev.status;
    else
      next = matches.every((m) => m.status === 'CONFIRMED') ? 'RESULT_CONFIRMED' : 'RESULT_PENDING';
    if (next !== ev.status) {
      await tx.event.update({
        where: { id: eventId },
        data: { status: next, version: { increment: 1 } },
      });
    }
  }

  private async notifyParticipants(
    tx: Tx,
    l: Loaded,
    actorId: string,
    kind: string,
    title: string,
    dedupeKey: string,
  ): Promise<void> {
    const parts = await tx.participation.findMany({
      where: { eventId: l.event.id, status: 'CONFIRMED' },
      select: { userId: true },
    });
    await this.notifier.notify(tx, {
      recipientIds: parts.map((p) => p.userId),
      category: 'result',
      activityKind: kind,
      title,
      objectType: 'Match',
      objectId: l.match.id,
      actorId,
      essential: true,
      dedupeKey,
    });
  }
}

/** Order-insensitive comparison key of an event list. */
function key4(events: EventData[]): string {
  return JSON.stringify(
    events
      .map(
        (e) => `${e.type}|${e.teamId ?? ''}|${e.playerId}|${e.assistById ?? ''}|${e.minute ?? ''}`,
      )
      .sort(),
  );
}
