import { createTestApp, type TestApp } from './support/app';
import { createUser, type TestUser } from './support/factories';
import { createGame } from './support/games';
import {
  applyWith,
  createClubRow,
  createTournament,
  decide,
  idemKey,
  type Json,
} from './support/tournaments';

describe('tournaments: configurable tie-breakers (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const post = (u: TestUser, path: string, body: object = {}) =>
    t
      .http()
      .post(`/v1/tournaments/${path}`)
      .set(u.auth)
      .set('Idempotency-Key', idemKey())
      .send(body);

  it('head-to-head and fair play need their configuration; unsupported criteria are refused', async () => {
    const org = await createUser(t);
    const { id } = await createTournament(t, org);
    const stage = (config: object) =>
      post(org, `${id}/stages`, { name: 'L', kind: 'LEAGUE', config });
    const h2h = await stage({ tiebreakers: ['points', 'headToHead'] }).expect(400);
    expect(h2h.body.error.details.reason).toBe('HEAD_TO_HEAD_CONFIG_REQUIRED');
    const fp = await stage({ tiebreakers: ['points', 'fairPlay'] }).expect(400);
    expect(fp.body.error.details.reason).toBe('FAIR_PLAY_WEIGHTS_REQUIRED');
    await stage({
      tiebreakers: ['points', 'fairPlay'],
      fairPlayWeights: { yellow: -1, red: 2 },
    }).expect(400);
    await stage({
      tiebreakers: ['points', 'headToHead'],
      headToHead: { metrics: ['points'] },
    }).expect(400); // reapplyToSubgroup missing
    await stage({ tiebreakers: ['points', 'drawingOfLots'] }).expect(400); // lots are recorded by the organiser, not a criterion
    const ok = await stage({
      tiebreakers: ['points', 'headToHead', 'fairPlay', 'goalDifference'],
      headToHead: { metrics: ['points', 'goalDifference'], reapplyToSubgroup: true },
      fairPlayWeights: { yellow: 1, red: 3 },
    }).expect(201);
    expect(ok.body.config.headToHead).toEqual({
      metrics: ['points', 'goalDifference'],
      reapplyToSubgroup: true,
    });
  });

  it('fair play uses the confirmed cards of matches linked to the fixture (lower total wins the tie)', async () => {
    const org = await createUser(t);
    const { id } = await createTournament(t, org);
    const clubs: { entryId: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const owner = await createUser(t);
      const clubId = await createClubRow(t, owner);
      const entryId = await applyWith(t, id, owner, clubId);
      await decide(t, id, org, entryId, 'ACCEPT').expect(200);
      clubs.push({ entryId });
    }
    const stage = (
      await post(org, `${id}/stages`, {
        name: 'League',
        kind: 'LEAGUE',
        config: { tiebreakers: ['points', 'fairPlay'], fairPlayWeights: { yellow: 1, red: 3 } },
      }).expect(201)
    ).body;
    await post(org, `${id}/stages/${stage.id}/draw`, {
      mode: 'MANUAL',
      assignments: { '': clubs.map((c) => c.entryId) },
    }).expect(200);
    await post(org, `${id}/stages/${stage.id}/generate`).expect(200);
    const fixture = (
      (await t.http().get(`/v1/tournaments/${id}/fixtures`).set(org.auth).expect(200)).body
        .items as Json[]
    )[0] as Json;

    // a played game with cards: home 1 red (3), away 2 yellows (2) => away is better
    const game = await createGame(t, org);
    const teams = await t.prisma.eventTeam.findMany({
      where: { eventId: game.id },
      orderBy: { index: 'asc' },
    });
    const [homeTeam, awayTeam] = teams as [(typeof teams)[number], (typeof teams)[number]];
    const match = await t.prisma.match.create({
      data: {
        eventId: game.id,
        fixtureId: fixture.id,
        homeTeamId: homeTeam.id,
        awayTeamId: awayTeam.id,
        status: 'CONFIRMED',
      },
    });
    const card = (type: 'RED_CARD' | 'YELLOW_CARD', teamId: string, status: 'x' = 'x') =>
      t.prisma.matchEvent
        .create({
          data: { matchId: match.id, type, teamId, playerId: org.userId, recordedById: org.userId },
        })
        .then(() => status);
    await card('RED_CARD', homeTeam.id);
    await card('YELLOW_CARD', awayTeam.id);
    await card('YELLOW_CARD', awayTeam.id);

    await t.prisma.tournament.update({ where: { id }, data: { status: 'LIVE' } });
    await post(org, `${id}/fixtures/${fixture.id}/result`, { homeScore: 1, awayScore: 1 }).expect(
      200,
    );
    const rows = (await t.http().get(`/v1/tournaments/${id}/standings`).expect(200)).body.stages[0]
      .groups[0].rows as Json[];
    expect(rows.map((r) => r.entryId)).toEqual([fixture.away.entryId, fixture.home.entryId]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows.every((r) => !r.tied)).toBe(true);
  });
});
