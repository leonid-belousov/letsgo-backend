import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './support/app';
import { createUser } from './support/factories';
import { createGame, createVenueRow } from './support/games';

describe('game feed: Nearest and Organiser rating sorts (keyset, real PostgreSQL)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('Nearest needs coordinates (no invented distances) and orders by distance, unknown last, with stable paging', async () => {
    const org = await createUser(t);
    const near = await createVenueRow(t, org, { lat: 41.7, lng: 44.8 });
    const far = await createVenueRow(t, org, { lat: 42.5, lng: 45.5 });
    const gFar = await createGame(t, org, { pitchId: far.pitchId, hoursFromNow: 50 });
    const gNone = await createGame(t, org, { hoursFromNow: 40 }); // no venue ⇒ unknown distance
    const gNear = await createGame(t, org, { pitchId: near.pitchId, hoursFromNow: 60 });
    const base = `/v1/games?organiserId=${org.userId}&sort=NEAREST`;
    const bad = await t.http().get(base).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION');
    const q = `${base}&lat=41.7&lng=44.8`;
    const all = await t.http().get(q).expect(200);
    expect(all.body.items.map((x: { id: string }) => x.id)).toEqual([gNear.id, gFar.id, gNone.id]);
    const p1 = await t.http().get(`${q}&limit=1`).expect(200);
    const p2 = await t
      .http()
      .get(`${q}&limit=1&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
      .expect(200);
    const p3 = await t
      .http()
      .get(`${q}&limit=1&cursor=${encodeURIComponent(p2.body.nextCursor)}`)
      .expect(200);
    expect([p1, p2, p3].map((p) => p.body.items[0].id)).toEqual([gNear.id, gFar.id, gNone.id]);
    expect(p3.body.nextCursor).toBeNull();
  });

  it('Organiser rating: higher first, unrated organisers last, ties by start time', async () => {
    const good = await createUser(t);
    const meh = await createUser(t);
    const fresh = await createUser(t);
    const rate = (subject: string, score: number) =>
      t.prisma.rating.create({
        data: {
          authorId: randomUUID(),
          subjectType: 'ORGANISER',
          subjectId: subject,
          eventId: randomUUID(),
          score,
          editableUntil: new Date(Date.now() + 86_400_000),
        },
      });
    await rate(good.userId, 5);
    await rate(good.userId, 4);
    await rate(meh.userId, 3);
    const city = `c${Date.now()}`;
    void city;
    const gFresh = await createGame(t, fresh, { hoursFromNow: 30 });
    const gMeh = await createGame(t, meh, { hoursFromNow: 31 });
    const gGood = await createGame(t, good, { hoursFromNow: 32 });
    // the shared database accumulates games from other suites: page until all three are seen
    const wanted = [gFresh.id, gMeh.id, gGood.id];
    const seen: { id: string; organiser: { rating: number | null; ratingCount: number } }[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200 && seen.length < wanted.length; page++) {
      const q: string = `/v1/games?sort=ORGANISER_RATING&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await t.http().get(q).expect(200);
      seen.push(...res.body.items.filter((x: { id: string }) => wanted.includes(x.id)));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.map((x) => x.id)).toEqual([gGood.id, gMeh.id, gFresh.id]);
    const detail = seen.find((x) => x.id === gGood.id);
    expect(detail?.organiser).toMatchObject({ rating: 4.5, ratingCount: 2 });
    const unrated = seen.find((x) => x.id === gFresh.id);
    if (!unrated) throw new Error('unrated game missing');
    expect(unrated.organiser.rating).toBeNull(); // no zero, no placeholder
  });
});
