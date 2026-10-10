import { Injectable } from '@nestjs/common';
import type { Event, EventTeam, Match, MatchEvent } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { loadPersonSummaries, personOrUnknown } from '../users/person-summary';
import { MatchCapabilitiesDto, MatchDto, MatchEventDto, MatchTeamDto, MvpSummaryDto } from './dto';
import { MvpService, type MvpOutcome } from './mvp.service';

export const NOT_AVAILABLE = 'This content isn’t available';
/** Event states in which a result exists / may be finalised. */
export const RESULT_EVENT_STATES: Event['status'][] = [
  'FINISHED',
  'RESULT_PENDING',
  'RESULT_CONFIRMED',
];
/** Event states in which matches may be created and recorded. */
export const RECORDING_EVENT_STATES: Event['status'][] = ['STARTED', ...RESULT_EVENT_STATES];

export interface Rights {
  viewerId: string | null;
  /** event.results.record (organiser, results manager, club grants) */
  record: boolean;
  /** event.results.confirm */
  confirm: boolean;
  /** Teams of this event captained by the viewer. */
  captainTeamIds: string[];
  participant: boolean;
}

export type MatchRow = Match & { events: MatchEvent[] };

export function isOpen(status: Match['status']): boolean {
  return status === 'DRAFT' || status === 'AWAITING_CONFIRMATION';
}

/** Score implied by the goal events; `hasGoals` false ⇒ no derived score exists. */
export function deriveScore(
  m: Pick<Match, 'homeTeamId' | 'awayTeamId'>,
  events: Pick<MatchEvent, 'type' | 'teamId'>[],
): { home: number; away: number; hasGoals: boolean } {
  let home = 0;
  let away = 0;
  let hasGoals = false;
  for (const e of events) {
    if (e.type === 'GOAL') {
      hasGoals = true;
      if (e.teamId && e.teamId === m.homeTeamId) home += 1;
      else if (e.teamId && e.teamId === m.awayTeamId) away += 1;
    } else if (e.type === 'OWN_GOAL') {
      hasGoals = true;
      // An own goal counts for the opponent, never as the player's goal.
      if (e.teamId && e.teamId === m.homeTeamId) away += 1;
      else if (e.teamId && e.teamId === m.awayTeamId) home += 1;
    }
  }
  return { home, away, hasGoals };
}

@Injectable()
export class MatchViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly mvp: MvpService,
    private readonly clock: Clock,
  ) {}

  async rights(db: Db, viewerId: string | null, eventId: string): Promise<Rights> {
    if (!viewerId) {
      return { viewerId, record: false, confirm: false, captainTeamIds: [], participant: false };
    }
    const target = { type: 'EVENT', id: eventId } as const;
    const [record, confirm, captained, part] = await Promise.all([
      this.policy.can(viewerId, 'event.results.record', target, db),
      this.policy.can(viewerId, 'event.results.confirm', target, db),
      db.eventTeam.findMany({ where: { eventId, captainId: viewerId }, select: { id: true } }),
      db.participation.findFirst({
        where: { eventId, userId: viewerId, status: 'CONFIRMED' },
        select: { id: true },
      }),
    ]);
    return {
      viewerId,
      record,
      confirm,
      captainTeamIds: captained.map((t) => t.id),
      participant: part !== null,
    };
  }

  captainInScope(r: Rights, m: Pick<Match, 'homeTeamId' | 'awayTeamId'>): boolean {
    return r.captainTeamIds.some((id) => id === m.homeTeamId || id === m.awayTeamId);
  }

  /** May the viewer see this match at all? Unconfirmed protocols are for the people working on them. */
  canView(ev: Pick<Event, 'status'>, m: Pick<Match, 'status'>, r: Rights): boolean {
    const staff = r.record || r.confirm;
    if (ev.status === 'DRAFT' && !staff) return false;
    if (m.status === 'CONFIRMED') return true;
    return staff || r.captainTeamIds.length > 0 || r.participant;
  }

  async loadRow(db: Db, matchId: string): Promise<{ match: MatchRow; event: Event } | null> {
    const match = await db.match.findUnique({
      where: { id: matchId },
      include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!match) return null;
    const event = await db.event.findUnique({ where: { id: match.eventId } });
    if (!event) return null;
    return { match, event };
  }

  async detail(db: Db, viewerId: string | null, matchId: string): Promise<MatchDto> {
    const row = await this.loadRow(db, matchId);
    if (!row) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    const rights = await this.rights(db, viewerId, row.event.id);
    if (!this.canView(row.event, row.match, rights)) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    return this.build(db, row.match, row.event, rights);
  }

  async build(db: Db, m: MatchRow, ev: Event, r: Rights): Promise<MatchDto> {
    const now = this.clock.now();
    const [teams, revisionCount, outcomes] = await Promise.all([
      db.eventTeam.findMany({ where: { eventId: ev.id } }),
      db.matchRevision.count({ where: { matchId: m.id } }),
      this.mvp.outcomes(db, [m], now),
    ]);
    const outcome = outcomes.get(m.id) as MvpOutcome;
    const people = await loadPersonSummaries(
      db,
      m.events.flatMap((e) => (e.assistById ? [e.playerId, e.assistById] : [e.playerId])),
    );
    const teamById = new Map(teams.map((t) => [t.id, t]));
    const teamDto = (id: string | null): MatchTeamDto | null => {
      const t = id ? teamById.get(id) : undefined;
      return t ? this.team(t) : null;
    };
    const hasGoals = m.events.some((e) => e.type === 'GOAL' || e.type === 'OWN_GOAL');

    let myVote: string | null = null;
    let canVote = false;
    if (r.viewerId && outcome.opened) {
      const vote = await db.mvpVote.findUnique({
        where: { matchId_voterId: { matchId: m.id, voterId: r.viewerId } },
        select: { candidateId: true },
      });
      myVote = vote?.candidateId ?? null;
      if (outcome.open) canVote = (await this.mvp.playedUserIds(db, m.id)).has(r.viewerId);
    }

    const mvp = new MvpSummaryDto();
    mvp.votingOpened = outcome.opened;
    mvp.votingOpen = outcome.open;
    mvp.closesAt = outcome.closesAt ? outcome.closesAt.toISOString() : null;
    mvp.leaders = outcome.leaders;
    mvp.mvpUserId = outcome.mvpUserId;
    mvp.needsDecision = outcome.needsDecision;
    mvp.myVote = myVote;

    const dto = new MatchDto();
    dto.id = m.id;
    dto.eventId = m.eventId;
    dto.status = m.status;
    dto.version = m.version;
    dto.homeTeam = teamDto(m.homeTeamId);
    dto.awayTeam = teamDto(m.awayTeamId);
    dto.homeScore = m.homeScore;
    dto.awayScore = m.awayScore;
    dto.scoreSource = hasGoals ? 'EVENTS' : m.homeScore !== null ? 'DIRECT' : null;
    dto.startsAt = m.startsAt ? m.startsAt.toISOString() : null;
    dto.events = m.events.map((e): MatchEventDto => {
      const out = new MatchEventDto();
      out.id = e.id;
      out.type = e.type;
      out.teamId = e.teamId;
      out.player = personOrUnknown(people, e.playerId);
      out.assistBy = e.assistById ? personOrUnknown(people, e.assistById) : null;
      out.minute = e.minute;
      out.recordedById = e.recordedById;
      out.createdAt = e.createdAt.toISOString();
      return out;
    });
    dto.confirmedById = m.confirmedById;
    dto.confirmedAt = m.confirmedAt ? m.confirmedAt.toISOString() : null;
    dto.revisionCount = revisionCount;
    dto.mvp = mvp;
    dto.capabilities = this.capabilities(m, ev, r, outcome, canVote);
    return dto;
  }

  private capabilities(
    m: Match,
    ev: Event,
    r: Rights,
    outcome: MvpOutcome,
    canVote: boolean,
  ): MatchCapabilitiesDto {
    const open = isOpen(m.status);
    const recording = RECORDING_EVENT_STATES.includes(ev.status);
    const worker = r.record || this.captainInScope(r, m);
    const c = new MatchCapabilitiesDto();
    c.canRecordEvents = open && recording && worker;
    c.canSetScore = open && recording && r.record;
    c.canSubmit = m.status === 'DRAFT' && recording && worker;
    c.canConfirm = open && RESULT_EVENT_STATES.includes(ev.status) && r.confirm;
    c.canCorrect = m.status === 'CONFIRMED' && r.confirm;
    c.canCancel = open && r.record;
    c.canVoteMvp = canVote;
    c.canDecideMvp = r.confirm && outcome.opened && !outcome.open && outcome.needsDecision;
    return c;
  }

  private team(t: EventTeam): MatchTeamDto {
    const d = new MatchTeamDto();
    d.id = t.id;
    d.index = t.index;
    d.name = t.name;
    d.colour = t.colour;
    d.clubId = t.clubId;
    d.captainId = t.captainId;
    return d;
  }
}
