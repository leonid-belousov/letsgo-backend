import { Injectable } from '@nestjs/common';
import type { Match } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export const MVP_DECISION_ACTION = 'match.mvp.decide';

export interface MvpOutcome {
  /** A voting window exists (match confirmed). Cancelled/unconfirmed matches never open voting. */
  opened: boolean;
  open: boolean;
  closesAt: Date | null;
  /** Only filled once the window is closed. */
  leaders: { userId: string; votes: number }[];
  mvpUserId: string | null;
  needsDecision: boolean;
}

type MatchLike = Pick<Match, 'id' | 'status' | 'mvpVotingClosesAt'>;

/** MVP voting rules (Handoff §17): one vote per confirmed player, no self-vote, configurable window. */
@Injectable()
export class MvpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Outcome per match; votes are only tallied for matches whose window is closed. */
  async outcomes(db: Db, matches: MatchLike[], now: Date): Promise<Map<string, MvpOutcome>> {
    const out = new Map<string, MvpOutcome>();
    const closedIds: string[] = [];
    for (const m of matches) {
      const opened = m.status === 'CONFIRMED' && m.mvpVotingClosesAt !== null;
      const closed = opened && m.mvpVotingClosesAt !== null && now >= m.mvpVotingClosesAt;
      out.set(m.id, {
        opened,
        open: opened && !closed,
        closesAt: opened ? m.mvpVotingClosesAt : null,
        leaders: [],
        mvpUserId: null,
        needsDecision: false,
      });
      if (closed) closedIds.push(m.id);
    }
    if (closedIds.length === 0) return out;

    const [tallies, decisions] = await Promise.all([
      db.mvpVote.groupBy({
        by: ['matchId', 'candidateId'],
        where: { matchId: { in: closedIds } },
        _count: { _all: true },
      }),
      db.auditEvent.findMany({
        where: { action: MVP_DECISION_ACTION, targetType: 'Match', targetId: { in: closedIds } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { targetId: true, metadata: true },
      }),
    ]);
    const decided = new Map<string, string>();
    for (const d of decisions) {
      const md = d.metadata as { mvpUserId?: unknown } | null;
      if (d.targetId && typeof md?.mvpUserId === 'string') decided.set(d.targetId, md.mvpUserId);
    }
    const byMatch = new Map<string, { userId: string; votes: number }[]>();
    for (const t of tallies) {
      const list = byMatch.get(t.matchId) ?? [];
      list.push({ userId: t.candidateId, votes: t._count._all });
      byMatch.set(t.matchId, list);
    }
    for (const id of closedIds) {
      const o = out.get(id);
      if (!o) continue;
      const all = byMatch.get(id) ?? [];
      const max = all.reduce((a, b) => Math.max(a, b.votes), 0);
      o.leaders = all
        .filter((x) => x.votes === max && max > 0)
        .sort((a, b) => a.userId.localeCompare(b.userId));
      if (o.leaders.length === 1) {
        o.mvpUserId = o.leaders[0]?.userId ?? null;
      } else if (o.leaders.length > 1) {
        const pick = decided.get(id);
        if (pick && o.leaders.some((l) => l.userId === pick)) o.mvpUserId = pick;
        else o.needsDecision = true;
      }
    }
    return out;
  }

  /** Users who took part in the match: confirmed participants of its teams plus anyone in its events. */
  async playedUserIds(db: Db, matchId: string): Promise<Set<string>> {
    const m = await db.match.findUnique({
      where: { id: matchId },
      select: { eventId: true, homeTeamId: true, awayTeamId: true },
    });
    if (!m) return new Set();
    const [parts, events] = await Promise.all([
      db.participation.findMany({
        where: { eventId: m.eventId, status: 'CONFIRMED' },
        select: { userId: true, teamId: true },
      }),
      db.matchEvent.findMany({ where: { matchId }, select: { playerId: true, assistById: true } }),
    ]);
    const set = new Set<string>();
    for (const p of parts) {
      if (!p.teamId || p.teamId === m.homeTeamId || p.teamId === m.awayTeamId) set.add(p.userId);
    }
    for (const e of events) {
      set.add(e.playerId);
      if (e.assistById) set.add(e.assistById);
    }
    return set;
  }

  async vote(voterId: string, matchId: string, candidateId: string): Promise<void> {
    const now = this.clock.now();
    const m = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!m || m.status === 'DRAFT' || m.status === 'AWAITING_CONFIRMATION') {
      // Unconfirmed protocols are not public; the voter could not know them.
      if (!m) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
      throw new ApiError(ErrorCode.CONFLICT, 'MVP voting opens when the result is confirmed', {
        reason: 'VOTING_NOT_OPEN',
      });
    }
    if (m.status === 'CANCELLED' || !m.mvpVotingClosesAt) {
      throw new ApiError(ErrorCode.CONFLICT, 'MVP voting is not available for this match', {
        reason: 'VOTING_NOT_OPEN',
      });
    }
    const played = await this.playedUserIds(this.prisma, matchId);
    if (!played.has(voterId)) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    if (now >= m.mvpVotingClosesAt) {
      throw new ApiError(ErrorCode.EXPIRED, 'MVP voting has closed');
    }
    if (candidateId === voterId) {
      throw new ApiError(ErrorCode.VALIDATION, 'You cannot vote for yourself', {
        field: 'candidateId',
      });
    }
    if (!played.has(candidateId)) {
      throw new ApiError(ErrorCode.VALIDATION, 'The candidate did not play in this match', {
        field: 'candidateId',
      });
    }
    await this.prisma.mvpVote.upsert({
      where: { matchId_voterId: { matchId, voterId } },
      create: { matchId, voterId, candidateId },
      update: { candidateId },
    });
  }

  /** Tie-break by the organiser / results manager (explicit and final; kept in the audit log). */
  async decide(
    actorId: string,
    matchId: string,
    mvpUserId: string,
    requestId?: string,
  ): Promise<void> {
    const m = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!m) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    await this.policy.assert(actorId, 'event.results.confirm', { type: 'EVENT', id: m.eventId });
    const outcome = (await this.outcomes(this.prisma, [m], this.clock.now())).get(m.id);
    if (!outcome?.opened) {
      throw new ApiError(ErrorCode.CONFLICT, 'MVP voting has not been opened for this match');
    }
    if (outcome.open) {
      throw new ApiError(ErrorCode.CONFLICT, 'MVP voting is still open', { reason: 'VOTING_OPEN' });
    }
    if (outcome.leaders.length < 2) {
      throw new ApiError(ErrorCode.CONFLICT, 'There is no tie to decide', { reason: 'NO_TIE' });
    }
    if (!outcome.leaders.some((l) => l.userId === mvpUserId)) {
      throw new ApiError(ErrorCode.VALIDATION, 'The decision must be one of the tied leaders', {
        field: 'mvpUserId',
      });
    }
    if (outcome.mvpUserId) {
      if (outcome.mvpUserId === mvpUserId) return; // idempotent retry
      throw new ApiError(ErrorCode.CONFLICT, 'The MVP decision is final', { reason: 'DECIDED' });
    }
    await this.audit.record(this.prisma, {
      actorId,
      action: MVP_DECISION_ACTION,
      targetType: 'Match',
      targetId: matchId,
      requestId,
      metadata: { mvpUserId, leaders: outcome.leaders },
    });
  }
}
