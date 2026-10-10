import { Clock } from '../src/common/time/clock';
import { createTestApp, type TestApp } from './support/app';
import { FakeClock } from './support/clock';
import { createUser } from './support/factories';
import { finishedGame, type PlayedGame } from './support/results';

describe('results: matches, captains, corrections, stats, MVP (real PostgreSQL)', () => {
  let t: TestApp;
  const clock = new FakeClock();
  beforeAll(async () => {
    t = await createTestApp((b) => b.overrideProvider(Clock).useValue(clock));
  });
  beforeEach(() => clock.set(new Date()));
  afterAll(() => t.close());

  const newMatch = async (g: PlayedGame) => {
    const r = await t
      .http()
      .post(`/v1/games/${g.gameId}/matches`)
      .set(g.org.auth)
      .send({ homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId })
      .expect(201);
    return r.body.id as string;
  };
  const goal = (g: PlayedGame, scorer: 'home' | 'away', idx = 0, extra: object = {}) => ({
    type: 'GOAL',
    playerId: (scorer === 'home' ? g.home : g.away)[idx]?.userId,
    ...extra,
  });
  const addEvent = (id: string, who: { auth: { Authorization: string } }, body: object) =>
    t.http().post(`/v1/matches/${id}/events`).set(who.auth).send(body);
  const confirmed = async (g: PlayedGame) => {
    const id = await newMatch(g);
    await t
      .http()
      .put(`/v1/matches/${id}/score`)
      .set(g.org.auth)
      .send({ homeScore: 2, awayScore: 1 })
      .expect(200);
    const m = await t.http().get(`/v1/matches/${id}`).set(g.org.auth).expect(200);
    await t
      .http()
      .post(`/v1/matches/${id}/confirm`)
      .set(g.org.auth)
      .send({ version: m.body.version })
      .expect(200);
    return id;
  };

  it('full lifecycle: captain records own team, cannot confirm, locked after confirmation', async () => {
    const g = await finishedGame(t);
    const cap = g.home[0]!;
    // only the organiser (event.manage) appoints; a plain player cannot
    await t
      .http()
      .put(`/v1/games/${g.gameId}/teams/${g.homeTeamId}/captain`)
      .set(g.away[0]!.auth)
      .send({ userId: cap.userId })
      .expect(403);
    await t
      .http()
      .put(`/v1/games/${g.gameId}/teams/${g.homeTeamId}/captain`)
      .set(g.org.auth)
      .send({ userId: cap.userId })
      .expect(200);
    // captain must be a confirmed player of that team
    await t
      .http()
      .put(`/v1/games/${g.gameId}/teams/${g.homeTeamId}/captain`)
      .set(g.org.auth)
      .send({ userId: g.away[0]!.userId })
      .expect(400);

    const id = await newMatch(g);
    // captains cannot create matches
    await t
      .http()
      .post(`/v1/games/${g.gameId}/matches`)
      .set(cap.auth)
      .send({ homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId })
      .expect(403);

    // captain records a goal + assist for his own team
    const r1 = await addEvent(
      id,
      cap,
      goal(g, 'home', 0, { assistById: g.home[1]!.userId, minute: 10 }),
    ).expect(200);
    expect(r1.body.homeScore).toBe(1);
    expect(r1.body.scoreSource).toBe('EVENTS');
    // ...but not for the opponents
    await addEvent(id, cap, goal(g, 'away', 0)).expect(403);
    // an own goal by an away player counts for HOME and is not that player's goal
    const r2 = await addEvent(id, g.org, { type: 'OWN_GOAL', playerId: g.away[1]!.userId }).expect(
      200,
    );
    expect(r2.body.homeScore).toBe(2);
    expect(r2.body.awayScore).toBe(0);
    await addEvent(id, g.org, { type: 'YELLOW_CARD', playerId: g.away[0]!.userId }).expect(200);
    // assist validation
    await addEvent(id, g.org, goal(g, 'home', 0, { assistById: g.home[0]!.userId })).expect(400);
    // a stranger is not a participant
    const stranger = await createUser(t);
    await addEvent(id, g.org, {
      type: 'GOAL',
      playerId: stranger.userId,
      teamId: g.homeTeamId,
    }).expect(400);
    await addEvent(id, stranger, goal(g, 'home')).expect(404);

    const sub = await t.http().post(`/v1/matches/${id}/submit`).set(cap.auth).send({}).expect(200);
    expect(sub.body.status).toBe('AWAITING_CONFIRMATION');
    expect((await t.prisma.event.findUniqueOrThrow({ where: { id: g.gameId } })).status).toBe(
      'RESULT_PENDING',
    );
    // idempotent re-submit
    await t.http().post(`/v1/matches/${id}/submit`).set(cap.auth).send({}).expect(200);
    // captain can never confirm
    await t
      .http()
      .post(`/v1/matches/${id}/confirm`)
      .set(cap.auth)
      .send({ version: sub.body.version })
      .expect(403);
    // stale version
    const stale = await t
      .http()
      .post(`/v1/matches/${id}/confirm`)
      .set(g.org.auth)
      .send({ version: sub.body.version - 1 })
      .expect(409);
    expect(stale.body.error.code).toBe('VERSION_CHANGED');
    const done = await t
      .http()
      .post(`/v1/matches/${id}/confirm`)
      .set(g.org.auth)
      .send({ version: sub.body.version })
      .expect(200);
    expect(done.body.status).toBe('CONFIRMED');
    expect(done.body.confirmedById).toBe(g.org.userId);
    expect(done.body.mvp.votingOpen).toBe(true);
    // idempotent confirm
    await t
      .http()
      .post(`/v1/matches/${id}/confirm`)
      .set(g.org.auth)
      .send({ version: 1 })
      .expect(200);
    expect((await t.prisma.event.findUniqueOrThrow({ where: { id: g.gameId } })).status).toBe(
      'RESULT_CONFIRMED',
    );

    // lockout
    await addEvent(id, cap, goal(g, 'home')).expect(403);
    await t
      .http()
      .delete(`/v1/matches/${id}/events/${r2.body.events[1].id}`)
      .set(cap.auth)
      .expect(403);
    const locked = await addEvent(id, g.org, goal(g, 'home')).expect(409);
    expect(locked.body.error.details.reason).toBe('MATCH_LOCKED');
    await t
      .http()
      .post(`/v1/matches/${id}/correct`)
      .set(cap.auth)
      .send({ reason: 'nope', version: done.body.version, homeScore: 5, awayScore: 0 })
      .expect(403);
  });

  it('scores never disagree silently: direct score vs derived goals', async () => {
    const g = await finishedGame(t);
    const id = await newMatch(g);
    await t
      .http()
      .put(`/v1/matches/${id}/score`)
      .set(g.org.auth)
      .send({ homeScore: 3, awayScore: 1 })
      .expect(200);
    const clash = await addEvent(id, g.org, goal(g, 'home')).expect(409);
    expect(clash.body.error.details.reason).toBe('SCORE_SET_DIRECTLY');
    await t.http().put(`/v1/matches/${id}/score`).set(g.org.auth).send({}).expect(200); // clear
    await addEvent(id, g.org, goal(g, 'home')).expect(200);
    const derived = await t
      .http()
      .put(`/v1/matches/${id}/score`)
      .set(g.org.auth)
      .send({ homeScore: 5, awayScore: 5 })
      .expect(409);
    expect(derived.body.error.details.reason).toBe('SCORE_DERIVED');
    // submit needs a score; only a half-set score is rejected
    const id2 = await newMatch(g);
    await t.http().post(`/v1/matches/${id2}/submit`).set(g.org.auth).send({}).expect(400);
    await t
      .http()
      .put(`/v1/matches/${id2}/score`)
      .set(g.org.auth)
      .send({ homeScore: 1 })
      .expect(400);
    // cancelled match never opens voting
    const cancelled = await t
      .http()
      .post(`/v1/matches/${id2}/cancel`)
      .set(g.org.auth)
      .send({})
      .expect(200);
    expect(cancelled.body.mvp.votingOpened).toBe(false);
  });

  it('correction after confirmation: reason, immutable revision, stats recompute, no double counting', async () => {
    const g = await finishedGame(t);
    const scorer = g.home[0]!;
    const id = await newMatch(g);
    await addEvent(id, g.org, goal(g, 'home', 0)).expect(200);
    await addEvent(id, g.org, goal(g, 'home', 0)).expect(200);
    const m = await t.http().get(`/v1/matches/${id}`).set(g.org.auth).expect(200);
    // unconfirmed stats do not count
    let stats = await t.http().get(`/v1/users/${scorer.userId}/stats`).set(scorer.auth).expect(200);
    expect(stats.body.goals).toBe(0);
    expect(stats.body.games).toBe(0);
    await t
      .http()
      .post(`/v1/matches/${id}/confirm`)
      .set(g.org.auth)
      .send({ version: m.body.version })
      .expect(200);
    stats = await t.http().get(`/v1/users/${scorer.userId}/stats`).set(scorer.auth).expect(200);
    expect(stats.body).toMatchObject({ goals: 2, games: 1, assists: 0, primaryRole: 'PLAYER' });
    const orgStats = await t
      .http()
      .get(`/v1/users/${g.org.userId}/stats`)
      .set(scorer.auth)
      .expect(200);
    expect(orgStats.body.organiser.games).toBe(1);
    expect(orgStats.body.primaryRole).toBe('ORGANISER');

    const cur = await t.http().get(`/v1/matches/${id}`).set(g.org.auth).expect(200);
    await t
      .http()
      .post(`/v1/matches/${id}/correct`)
      .set(g.org.auth)
      .send({ version: cur.body.version, events: [] })
      .expect(400); // reason missing
    await t
      .http()
      .post(`/v1/matches/${id}/correct`)
      .set(g.org.auth)
      .send({
        reason: 'same',
        version: cur.body.version,
        events: cur.body.events.map((e: { type: string; player: { id: string } }) => ({
          type: e.type,
          playerId: e.player.id,
          teamId: g.homeTeamId,
        })),
      })
      .expect(400); // no change
    const fixed = await t
      .http()
      .post(`/v1/matches/${id}/correct`)
      .set(g.org.auth)
      .send({
        reason: 'One goal was disallowed',
        version: cur.body.version,
        events: [{ type: 'GOAL', playerId: scorer.userId, teamId: g.homeTeamId }],
      })
      .expect(200);
    expect(fixed.body.homeScore).toBe(1);
    expect(fixed.body.version).toBe(cur.body.version + 1);
    expect(fixed.body.revisionCount).toBe(1);
    stats = await t.http().get(`/v1/users/${scorer.userId}/stats`).set(scorer.auth).expect(200);
    expect(stats.body.goals).toBe(1);
    expect(stats.body.games).toBe(1);
    const revs = await t.http().get(`/v1/matches/${id}/revisions`).set(g.org.auth).expect(200);
    expect(revs.body.items).toHaveLength(1);
    expect(revs.body.items[0].reason).toBe('One goal was disallowed');
    expect(revs.body.items[0].snapshot.events).toHaveLength(2);
    expect(revs.body.items[0].snapshot.homeScore).toBe(2);
    await t.http().get(`/v1/matches/${id}/revisions`).set(g.away[0]!.auth).expect(403);
    // stale version
    await t
      .http()
      .post(`/v1/matches/${id}/correct`)
      .set(g.org.auth)
      .send({ reason: 'again', version: cur.body.version, homeScore: 0, awayScore: 0 })
      .expect(409);
    expect(
      await t.prisma.auditEvent.count({ where: { action: 'match.correct', targetId: id } }),
    ).toBe(1);

    // history: links ids and personal contribution
    const hist = await t
      .http()
      .get(`/v1/users/${scorer.userId}/history`)
      .set(scorer.auth)
      .expect(200);
    expect(hist.body.items).toHaveLength(1);
    expect(hist.body.items[0]).toMatchObject({
      matchId: id,
      eventId: g.gameId,
      outcome: 'WIN',
      side: 'HOME',
    });
    expect(hist.body.items[0].contribution.goals).toBe(1);
  });

  it('hidden stats/history return { hidden: true } and never zeros; private profile caps at followers', async () => {
    const g = await finishedGame(t);
    const p = g.home[0]!;
    await confirmed(g);
    const stranger = await createUser(t);
    await t.prisma.privacyPolicy.update({
      where: { userId: p.userId },
      data: { statsAudience: 'ONLY_ME', historyAudience: 'FOLLOWERS' },
    });
    const hidden = await t.http().get(`/v1/users/${p.userId}/stats`).set(stranger.auth).expect(200);
    expect(hidden.body).toEqual({ userId: p.userId, hidden: true });
    const own = await t.http().get(`/v1/users/${p.userId}/stats`).set(p.auth).expect(200);
    expect(own.body.hidden).toBe(false);
    expect(own.body.games).toBe(1);
    const hh = await t.http().get(`/v1/users/${p.userId}/history`).set(stranger.auth).expect(200);
    expect(hh.body).toEqual({ userId: p.userId, hidden: true });
    await t.prisma.follow.create({
      data: {
        followerId: stranger.userId,
        targetType: 'USER',
        targetId: p.userId,
        status: 'ACCEPTED',
      },
    });
    const seen = await t.http().get(`/v1/users/${p.userId}/history`).set(stranger.auth).expect(200);
    expect(seen.body.hidden).toBe(false);
    expect(seen.body.items).toHaveLength(1);
    // private profile: EVERYONE is capped to FOLLOWERS
    const g2 = await finishedGame(t);
    const q = g2.home[0]!;
    await t.prisma.profile.update({ where: { userId: q.userId }, data: { visibility: 'PRIVATE' } });
    const priv = await t.http().get(`/v1/users/${q.userId}/stats`).set(stranger.auth).expect(200);
    expect(priv.body.hidden).toBe(true);
    // visitors too
    const anon = await t.http().get(`/v1/users/${q.userId}/stats`).expect(200);
    expect(anon.body.hidden).toBe(true);
  });

  it('MVP: window from config, one vote each, no self-vote, participants only, tie needs explicit decision', async () => {
    const g = await finishedGame(t);
    const [a, b] = [g.home[0]!, g.home[1]!];
    const c = g.away[0]!;
    const id = await confirmed(g);
    const outsider = await createUser(t);
    await t
      .http()
      .put(`/v1/matches/${id}/mvp/vote`)
      .set(a.auth)
      .send({ candidateId: a.userId })
      .expect(400);
    await t
      .http()
      .put(`/v1/matches/${id}/mvp/vote`)
      .set(outsider.auth)
      .send({ candidateId: a.userId })
      .expect(403);
    await t
      .http()
      .put(`/v1/matches/${id}/mvp/vote`)
      .set(a.auth)
      .send({ candidateId: outsider.userId })
      .expect(400);
    await t
      .http()
      .put(`/v1/matches/${id}/mvp/vote`)
      .set(a.auth)
      .send({ candidateId: b.userId })
      .expect(200);
    await t
      .http()
      .put(`/v1/matches/${id}/mvp/vote`)
      .set(b.auth)
      .send({ candidateId: a.userId })
      .expect(200);
    // changing a vote replaces it: still one vote per voter
    await t
      .http()
      .put(`/v1/matches/${id}/mvp/vote`)
      .set(a.auth)
      .send({ candidateId: c.userId })
      .expect(200);
    expect(await t.prisma.mvpVote.count({ where: { matchId: id, voterId: a.userId } })).toBe(1);
    // tallies hidden while open; a decision is premature
    const open = await t.http().get(`/v1/matches/${id}/mvp`).expect(200);
    expect(open.body.votingOpen).toBe(true);
    expect(open.body.leaders).toEqual([]);
    await t
      .http()
      .post(`/v1/matches/${id}/mvp/decision`)
      .set(g.org.auth)
      .send({ mvpUserId: a.userId })
      .expect(409);

    clock.advanceHours(25);
    const closed = await t
      .http()
      .put(`/v1/matches/${id}/mvp/vote`)
      .set(c.auth)
      .send({ candidateId: a.userId })
      .expect(410);
    expect(closed.body.error.code).toBe('EXPIRED');
    // votes: b->a, a->c => tie between a and c
    const res = await t.http().get(`/v1/matches/${id}/mvp`).expect(200);
    expect(res.body.leaders).toHaveLength(2);
    expect(res.body.mvpUserId).toBeNull();
    expect(res.body.needsDecision).toBe(true);
    let s = await t.http().get(`/v1/users/${a.userId}/stats`).set(a.auth).expect(200);
    expect(s.body.mvps).toBe(0);
    await t
      .http()
      .post(`/v1/matches/${id}/mvp/decision`)
      .set(a.auth)
      .send({ mvpUserId: a.userId })
      .expect(403);
    await t
      .http()
      .post(`/v1/matches/${id}/mvp/decision`)
      .set(g.org.auth)
      .send({ mvpUserId: b.userId })
      .expect(400);
    const dec = await t
      .http()
      .post(`/v1/matches/${id}/mvp/decision`)
      .set(g.org.auth)
      .send({ mvpUserId: a.userId })
      .expect(200);
    expect(dec.body.mvpUserId).toBe(a.userId);
    await t
      .http()
      .post(`/v1/matches/${id}/mvp/decision`)
      .set(g.org.auth)
      .send({ mvpUserId: c.userId })
      .expect(409); // final
    s = await t.http().get(`/v1/users/${a.userId}/stats`).set(a.auth).expect(200);
    expect(s.body.mvps).toBe(1);

    // no votes => no MVP
    const g2 = await finishedGame(t);
    const id2 = await confirmed(g2);
    clock.advanceHours(25);
    const none = await t.http().get(`/v1/matches/${id2}/mvp`).expect(200);
    expect(none.body.mvpUserId).toBeNull();
    expect(none.body.needsDecision).toBe(false);
  });

  it('unconfirmed protocols are invisible to strangers; results staff grants work per event', async () => {
    const g = await finishedGame(t);
    const id = await newMatch(g);
    const stranger = await createUser(t);
    await t.http().get(`/v1/matches/${id}`).set(stranger.auth).expect(404);
    expect(
      (await t.http().get(`/v1/games/${g.gameId}/matches`).set(stranger.auth).expect(200)).body
        .items,
    ).toHaveLength(0);
    // a participant may look
    await t.http().get(`/v1/matches/${id}`).set(g.home[0]!.auth).expect(200);
    // event-scoped results manager (RoleGrant) can record and correct-but-not-confirm
    const mgr = await createUser(t);
    await t.prisma.roleGrant.create({
      data: {
        granteeId: mgr.userId,
        resourceType: 'EVENT',
        resourceId: g.gameId,
        permission: 'event.results.record',
        grantedById: g.org.userId,
      },
    });
    await addEvent(id, mgr, goal(g, 'home')).expect(200);
    const cur = await t.http().get(`/v1/matches/${id}`).set(mgr.auth).expect(200);
    expect(cur.body.capabilities.canConfirm).toBe(false);
    await t
      .http()
      .post(`/v1/matches/${id}/confirm`)
      .set(mgr.auth)
      .send({ version: cur.body.version })
      .expect(403);
  });
});
