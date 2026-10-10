import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { clampPageSize, decodeCursor, encodeCursor } from '../../common/pagination/cursor-page';
import { Clock } from '../../common/time/clock';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import { HistoryItemDto, UserHistoryDto, UserStatsDto } from './dto';
import { NOT_AVAILABLE } from './match-view.service';
import { MvpService } from './mvp.service';

const ACTIVE_TOURNAMENT_STATES = ['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'LIVE'] as const;

/**
 * Ids of the CONFIRMED matches a player took part in. Official statistics are derived only from
 * these rows, so the same match is never counted twice however it is reached (event, tournament,
 * profile). "Played" = a confirmed participant of the event on one of the match's teams (or
 * unassigned), plus anyone named in a recorded match event.
 */
function playedMatchIds(userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT m.id FROM "Match" m
      JOIN "Participation" p
        ON p."eventId" = m."eventId" AND p."userId" = ${userId}::uuid AND p.status = 'CONFIRMED'
     WHERE m.status = 'CONFIRMED'
       AND (p."teamId" IS NULL OR p."teamId" = m."homeTeamId" OR p."teamId" = m."awayTeamId")
    UNION
    SELECT me."matchId" FROM "MatchEvent" me
      JOIN "Match" m ON m.id = me."matchId"
     WHERE m.status = 'CONFIRMED' AND (me."playerId" = ${userId}::uuid OR me."assistById" = ${userId}::uuid)`;
}

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: VisibilityService,
    private readonly mvp: MvpService,
    private readonly clock: Clock,
  ) {}

  private async subject(viewerId: string | null, targetId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetId },
      include: { profile: true, privacy: true },
    });
    if (!user?.profile || !user.privacy || user.status === 'DELETED') {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    const rel = await this.visibility.relationship(viewerId, targetId);
    return { user, profile: user.profile, privacy: user.privacy, rel };
  }

  async stats(viewerId: string | null, targetId: string): Promise<UserStatsDto> {
    const { profile, privacy, rel } = await this.subject(viewerId, targetId);
    const dto = new UserStatsDto();
    dto.userId = targetId;
    if (!this.visibility.canSee(privacy.statsAudience, profile.visibility, rel)) {
      dto.hidden = true; // no numbers at all — never zeros for hidden data
      return dto;
    }
    dto.hidden = false;
    const showAwards = this.visibility.canSee(privacy.awardsAudience, profile.visibility, rel);
    Object.assign(dto, await this.compute(this.prisma, targetId, showAwards));
    return dto;
  }

  /** Official numbers for one person. Used by the profile and by tests. */
  async compute(db: Db, userId: string, includeTrophies: boolean): Promise<Partial<UserStatsDto>> {
    const now = this.clock.now();
    const confirmed = { match: { status: 'CONFIRMED' as const } };
    const [
      games,
      playerEvents,
      goals,
      assists,
      yellow,
      red,
      mvps,
      trophies,
      tournaments,
      orgGames,
      refGames,
    ] = await Promise.all([
      db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM (${playedMatchIds(userId)}) x`,
      db.$queryRaw<{ n: number }[]>`
          SELECT count(DISTINCT m."eventId")::int AS n
            FROM "Match" m JOIN "Event" e ON e.id = m."eventId"
           WHERE e.status = 'RESULT_CONFIRMED' AND m.id IN (${playedMatchIds(userId)})`,
      db.matchEvent.count({ where: { playerId: userId, type: 'GOAL', ...confirmed } }),
      db.matchEvent.count({ where: { assistById: userId, type: 'GOAL', ...confirmed } }),
      db.matchEvent.count({ where: { playerId: userId, type: 'YELLOW_CARD', ...confirmed } }),
      db.matchEvent.count({ where: { playerId: userId, type: 'RED_CARD', ...confirmed } }),
      this.countMvps(db, userId, now),
      includeTrophies
        ? db.achievement.count({ where: { recipientId: userId, type: 'TROPHY', revokedAt: null } })
        : Promise.resolve(null),
      db.clubEntryPlayer.count({
        where: {
          userId,
          status: 'CONFIRMED',
          entry: {
            status: 'ACCEPTED',
            tournament: { status: { in: [...ACTIVE_TOURNAMENT_STATES] } },
          },
        },
      }),
      db.event.count({ where: { organiserId: userId, status: 'RESULT_CONFIRMED' } }),
      db.event.count({ where: { refereeUserId: userId, status: 'RESULT_CONFIRMED' } }),
    ]);

    const playerCount = playerEvents[0]?.n ?? 0;
    // The role with the most completed confirmed events; ties keep PLAYER (and a new profile is a PLAYER).
    let primaryRole: 'PLAYER' | 'ORGANISER' | 'REFEREE' = 'PLAYER';
    if (orgGames > playerCount && orgGames > refGames) primaryRole = 'ORGANISER';
    else if (refGames > playerCount && refGames > orgGames) primaryRole = 'REFEREE';

    const out: Partial<UserStatsDto> = {
      primaryRole,
      games: games[0]?.n ?? 0,
      goals,
      assists,
      yellowCards: yellow,
      redCards: red,
      mvps,
      tournaments,
      organiser: { games: orgGames },
      referee: { games: refGames },
    };
    if (trophies !== null) out.trophies = trophies;
    return out;
  }

  /** MVPs = confirmed matches whose closed vote produced (or whose tie-break decision named) this user. */
  private async countMvps(db: Db, userId: string, now: Date): Promise<number> {
    const votes = await db.mvpVote.findMany({
      where: {
        candidateId: userId,
        match: { status: 'CONFIRMED', mvpVotingClosesAt: { lte: now } },
      },
      select: { matchId: true },
      distinct: ['matchId'],
    });
    if (votes.length === 0) return 0;
    const matches = await db.match.findMany({
      where: { id: { in: votes.map((v) => v.matchId) } },
      select: { id: true, status: true, mvpVotingClosesAt: true },
    });
    const outcomes = await this.mvp.outcomes(db, matches, now);
    let n = 0;
    for (const o of outcomes.values()) if (o.mvpUserId === userId) n += 1;
    return n;
  }

  // ───────────── history ─────────────

  async history(
    viewerId: string | null,
    targetId: string,
    q: { limit?: number; cursor?: string },
  ): Promise<UserHistoryDto> {
    const { profile, privacy, rel } = await this.subject(viewerId, targetId);
    const out = new UserHistoryDto();
    out.userId = targetId;
    if (!this.visibility.canSee(privacy.historyAudience, profile.visibility, rel)) {
      out.hidden = true;
      return out;
    }
    out.hidden = false;
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const after = cursor
      ? Prisma.sql`AND (COALESCE(m."startsAt", e."startsAt"), m.id) < (${new Date(cursor.t)}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ id: string; t: Date }[]>`
      SELECT m.id, COALESCE(m."startsAt", e."startsAt") AS t
        FROM "Match" m JOIN "Event" e ON e.id = m."eventId"
       WHERE m.id IN (${playedMatchIds(targetId)}) ${after}
       ORDER BY t DESC, m.id DESC
       LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const ids = page.map((r) => r.id);

    const matches = await this.prisma.match.findMany({
      where: { id: { in: ids } },
      include: {
        events: true,
        event: { include: { venue: { select: { name: true } } } },
      },
    });
    const byId = new Map(matches.map((m) => [m.id, m]));
    const eventIds = [...new Set(matches.map((m) => m.eventId))];
    const fixtureIds = matches.flatMap((m) => (m.fixtureId ? [m.fixtureId] : []));
    const [teams, parts, fixtures, outcomes] = await Promise.all([
      this.prisma.eventTeam.findMany({ where: { eventId: { in: eventIds } } }),
      this.prisma.participation.findMany({
        where: { eventId: { in: eventIds }, userId: targetId },
        select: { eventId: true, teamId: true },
      }),
      this.prisma.fixture.findMany({
        where: { id: { in: fixtureIds } },
        select: { id: true, tournamentId: true },
      }),
      this.mvp.outcomes(this.prisma, matches, this.clock.now()),
    ]);
    const teamName = new Map(teams.map((t) => [t.id, t.name ?? `Team ${t.index}`]));
    const teamOfEvent = new Map(parts.map((p) => [p.eventId, p.teamId]));
    const tournamentOf = new Map(fixtures.map((f) => [f.id, f.tournamentId]));

    const items: HistoryItemDto[] = [];
    for (const r of page) {
      const m = byId.get(r.id);
      if (!m) continue;
      const mine = m.events.filter((e) => e.playerId === targetId);
      const teamId =
        teamOfEvent.get(m.eventId) ??
        mine.find((e) => e.teamId)?.teamId ??
        m.events.find((e) => e.assistById === targetId)?.teamId ??
        null;
      const side =
        teamId && teamId === m.homeTeamId
          ? 'HOME'
          : teamId && teamId === m.awayTeamId
            ? 'AWAY'
            : null;
      let outcome: 'WIN' | 'DRAW' | 'LOSS' | null = null;
      if (side && m.homeScore !== null && m.awayScore !== null) {
        const diff = side === 'HOME' ? m.homeScore - m.awayScore : m.awayScore - m.homeScore;
        outcome = diff > 0 ? 'WIN' : diff < 0 ? 'LOSS' : 'DRAW';
      }
      const item = new HistoryItemDto();
      item.matchId = m.id;
      item.eventId = m.eventId;
      item.tournamentId = m.fixtureId ? (tournamentOf.get(m.fixtureId) ?? null) : null;
      item.playedAt = new Date(r.t).toISOString();
      item.eventKind = m.event.kind;
      item.title = m.event.title;
      item.venueName = m.event.venue?.name ?? null;
      item.homeTeamName = m.homeTeamId ? (teamName.get(m.homeTeamId) ?? null) : null;
      item.awayTeamName = m.awayTeamId ? (teamName.get(m.awayTeamId) ?? null) : null;
      item.homeScore = m.homeScore;
      item.awayScore = m.awayScore;
      item.side = side;
      item.outcome = outcome;
      item.contribution = {
        goals: mine.filter((e) => e.type === 'GOAL').length,
        assists: m.events.filter((e) => e.type === 'GOAL' && e.assistById === targetId).length,
        ownGoals: mine.filter((e) => e.type === 'OWN_GOAL').length,
        yellowCards: mine.filter((e) => e.type === 'YELLOW_CARD').length,
        redCards: mine.filter((e) => e.type === 'RED_CARD').length,
        mvp: outcomes.get(m.id)?.mvpUserId === targetId,
      };
      items.push(item);
    }
    const last = page[page.length - 1];
    out.items = items;
    out.nextCursor =
      hasMore && last ? encodeCursor({ t: new Date(last.t).toISOString(), id: last.id }) : null;
    return out;
  }
}
