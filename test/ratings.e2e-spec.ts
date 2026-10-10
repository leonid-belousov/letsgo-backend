import { Clock } from '../src/common/time/clock';
import { createTestApp, type TestApp } from './support/app';
import { FakeClock } from './support/clock';
import { createUser } from './support/factories';
import { finishedGame, makeStaff } from './support/results';

describe('ratings (real PostgreSQL)', () => {
  let t: TestApp;
  const clock = new FakeClock();
  beforeAll(async () => {
    t = await createTestApp((b) => b.overrideProvider(Clock).useValue(clock));
  });
  beforeEach(() => clock.set(new Date()));
  afterAll(() => t.close());

  const rate = (who: { auth: { Authorization: string } }, body: object) =>
    t.http().put('/v1/ratings').set(who.auth).send(body);

  it('eligibility: finished game, confirmed players only, no self-rating, subject must be in the event', async () => {
    const early = await finishedGame(t, { finish: false });
    await rate(early.home[0]!, {
      eventId: early.gameId,
      subjectType: 'ORGANISER',
      subjectId: early.org.userId,
      score: 5,
    }).expect(409);

    const g = await finishedGame(t);
    const a = g.home[0]!;
    const outsider = await createUser(t);
    await rate(outsider, {
      eventId: g.gameId,
      subjectType: 'ORGANISER',
      subjectId: g.org.userId,
      score: 5,
    }).expect(403);
    // a follower who did not play cannot rate either
    await t.prisma.follow.create({
      data: {
        followerId: outsider.userId,
        targetType: 'USER',
        targetId: g.org.userId,
        status: 'ACCEPTED',
      },
    });
    await rate(outsider, {
      eventId: g.gameId,
      subjectType: 'PLAYER',
      subjectId: a.userId,
      score: 5,
    }).expect(403);
    await rate(a, {
      eventId: g.gameId,
      subjectType: 'PLAYER',
      subjectId: a.userId,
      score: 5,
    }).expect(400);
    await rate(a, {
      eventId: g.gameId,
      subjectType: 'PLAYER',
      subjectId: outsider.userId,
      score: 5,
    }).expect(400);
    await rate(a, {
      eventId: g.gameId,
      subjectType: 'REFEREE',
      subjectId: g.org.userId,
      score: 5,
    }).expect(400);
    await rate(a, {
      eventId: g.gameId,
      subjectType: 'PITCH',
      subjectId: outsider.userId,
      score: 5,
    }).expect(400);
    await rate(a, {
      eventId: g.gameId,
      subjectType: 'ORGANISER',
      subjectId: g.org.userId,
      score: 6,
    }).expect(400);
    await rate(a, {
      eventId: g.gameId,
      subjectType: 'ORGANISER',
      subjectId: g.org.userId,
      score: 0,
    }).expect(400);
  });

  it('upsert, mean rounded to 1 decimal, null when unrated, edit window, received hides authors', async () => {
    const g = await finishedGame(t);
    const [a, b, c] = [g.home[0]!, g.home[1]!, g.away[0]!];
    const agg = () => t.http().get(`/v1/ratings/subject/ORGANISER/${g.org.userId}`).expect(200);
    const none = await agg();
    expect(none.body).toMatchObject({ average: null, count: 0, hidden: false });

    const r1 = await rate(a, {
      eventId: g.gameId,
      subjectType: 'ORGANISER',
      subjectId: g.org.userId,
      score: 4,
      comment: 'nice',
      extended: { pace: 3 },
    }).expect(200);
    expect(r1.body.canEdit).toBe(true);
    const until = new Date(r1.body.editableUntil).getTime() - Date.now();
    expect(until).toBeGreaterThan(6.9 * 86_400_000);
    const r1b = await rate(a, {
      eventId: g.gameId,
      subjectType: 'ORGANISER',
      subjectId: g.org.userId,
      score: 5,
    }).expect(200);
    expect(r1b.body.id).toBe(r1.body.id); // upsert, not a second rating
    expect(r1b.body.comment).toBeNull();
    await rate(b, {
      eventId: g.gameId,
      subjectType: 'ORGANISER',
      subjectId: g.org.userId,
      score: 4,
    }).expect(200);
    await rate(c, {
      eventId: g.gameId,
      subjectType: 'ORGANISER',
      subjectId: g.org.userId,
      score: 4,
    }).expect(200);
    expect((await agg()).body).toMatchObject({ average: 4.3, count: 3 }); // (5+4+4)/3 = 4.33

    // concurrent first submissions collapse into one rating
    const [x, y] = await Promise.all([
      rate(b, { eventId: g.gameId, subjectType: 'PLAYER', subjectId: c.userId, score: 3 }),
      rate(b, { eventId: g.gameId, subjectType: 'PLAYER', subjectId: c.userId, score: 2 }),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(
      await t.prisma.rating.count({
        where: { authorId: b.userId, subjectId: c.userId, eventId: g.gameId },
      }),
    ).toBe(1);

    const given = await t.http().get('/v1/me/ratings/given').set(a.auth).expect(200);
    expect(given.body.items).toHaveLength(1);
    const recv = await t.http().get('/v1/me/ratings/received').set(g.org.auth).expect(200);
    expect(recv.body.items).toHaveLength(3);
    expect(JSON.stringify(recv.body)).not.toContain(a.userId);
    const mine = await t.http().get(`/v1/ratings/events/${g.gameId}/mine`).set(a.auth).expect(200);
    expect(mine.body.canRate).toBe(true);
    expect(
      mine.body.subjects.some(
        (s: { subjectType: string; myRating: unknown }) =>
          s.subjectType === 'ORGANISER' && s.myRating,
      ),
    ).toBe(true);
    expect(mine.body.subjects.some((s: { subjectId: string }) => s.subjectId === a.userId)).toBe(
      false,
    );

    clock.advanceHours(24 * 8);
    const late = await rate(a, {
      eventId: g.gameId,
      subjectType: 'ORGANISER',
      subjectId: g.org.userId,
      score: 1,
    }).expect(410);
    expect(late.body.error.code).toBe('EXPIRED');
    expect((await agg()).body.average).toBe(4.3);
  });

  it('window after a confirmed result and player audience', async () => {
    const g = await finishedGame(t);
    const a = g.home[0]!;
    const m = await t
      .http()
      .post(`/v1/games/${g.gameId}/matches`)
      .set(g.org.auth)
      .send({ homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId, homeScore: 1, awayScore: 0 })
      .expect(201);
    await t
      .http()
      .post(`/v1/matches/${m.body.id}/confirm`)
      .set(g.org.auth)
      .send({ version: m.body.version })
      .expect(200);
    await rate(a, {
      eventId: g.gameId,
      subjectType: 'PLAYER',
      subjectId: g.away[0]!.userId,
      score: 5,
    }).expect(200);
    const target = g.away[0]!;
    const viewer = await createUser(t);
    expect(
      (
        await t
          .http()
          .get(`/v1/ratings/subject/PLAYER/${target.userId}`)
          .set(viewer.auth)
          .expect(200)
      ).body.average,
    ).toBe(5);
    await t.prisma.privacyPolicy.update({
      where: { userId: target.userId },
      data: { ratingsAudience: 'ONLY_ME' },
    });
    const hidden = await t
      .http()
      .get(`/v1/ratings/subject/PLAYER/${target.userId}`)
      .set(viewer.auth)
      .expect(200);
    expect(hidden.body).toEqual({ subjectType: 'PLAYER', subjectId: target.userId, hidden: true });
    expect(
      (
        await t
          .http()
          .get(`/v1/ratings/subject/PLAYER/${target.userId}`)
          .set(target.auth)
          .expect(200)
      ).body.average,
    ).toBe(5);
  });

  it('moderator hides a rating with a reason: excluded from aggregates and audited', async () => {
    const g = await finishedGame(t);
    const a = g.home[0]!;
    const r = await rate(a, {
      eventId: g.gameId,
      subjectType: 'ORGANISER',
      subjectId: g.org.userId,
      score: 1,
    }).expect(200);
    await rate(g.home[1]!, {
      eventId: g.gameId,
      subjectType: 'ORGANISER',
      subjectId: g.org.userId,
      score: 5,
    }).expect(200);
    await t
      .http()
      .post(`/v1/admin/ratings/${r.body.id}/hide`)
      .set(a.auth)
      .send({ reason: 'abusive' })
      .expect(403);
    const mod = await makeStaff(t, ['admin.reports.moderate']);
    await t.http().post(`/v1/admin/ratings/${r.body.id}/hide`).set(mod.auth).send({}).expect(400);
    await t
      .http()
      .post(`/v1/admin/ratings/${r.body.id}/hide`)
      .set(mod.auth)
      .send({ reason: 'abusive' })
      .expect(200);
    const agg = await t.http().get(`/v1/ratings/subject/ORGANISER/${g.org.userId}`).expect(200);
    expect(agg.body).toMatchObject({ average: 5, count: 1 });
    expect(
      await t.prisma.auditEvent.count({ where: { action: 'rating.hide', targetId: r.body.id } }),
    ).toBe(1);
    // the author cannot resurrect it by editing
    await rate(a, {
      eventId: g.gameId,
      subjectType: 'ORGANISER',
      subjectId: g.org.userId,
      score: 1,
    }).expect(409);
  });
});
