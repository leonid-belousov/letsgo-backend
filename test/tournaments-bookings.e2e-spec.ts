import { createPitch, futureDate, grantVia, tb, type PitchFixture } from './bookings.support';
import { createTestApp, type TestApp } from './support/app';
import { createUser, type TestUser } from './support/factories';
import {
  applyWith,
  createClubRow,
  createTournament,
  decide,
  idemKey,
  type Json,
} from './support/tournaments';

describe('tournaments: rentals (attached bookings) and the scheduler (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const day = futureDate(12);
  const post = (u: TestUser, path: string, body: object = {}) =>
    t
      .http()
      .post(`/v1/tournaments/${path}`)
      .set(u.auth)
      .set('Idempotency-Key', idemKey())
      .send(body);
  const fixturesOf = async (tid: string, u: TestUser): Promise<Json[]> =>
    (await t.http().get(`/v1/tournaments/${tid}/fixtures`).set(u.auth).expect(200)).body
      .items as Json[];

  async function leagueTournament(org: TestUser, clubsN = 4) {
    const { id } = await createTournament(t, org);
    const clubs: { entryId: string; owner: TestUser }[] = [];
    for (let i = 0; i < clubsN; i++) {
      const owner = await createUser(t);
      const clubId = await createClubRow(t, owner);
      const entryId = await applyWith(t, id, owner, clubId);
      await decide(t, id, org, entryId, 'ACCEPT').expect(200);
      clubs.push({ entryId, owner });
    }
    const stage = (
      await post(org, `${id}/stages`, {
        name: 'League',
        kind: 'LEAGUE',
        config: { rounds: 1 },
      }).expect(201)
    ).body;
    await post(org, `${id}/stages/${stage.id}/draw`, { mode: 'RANDOM', seed: 's' }).expect(200);
    await post(org, `${id}/stages/${stage.id}/generate`).expect(200);
    return { id, clubs };
  }

  const book = async (u: TestUser, f: PitchFixture, from: string, minutes: number) => {
    const r = await t
      .http()
      .post('/v1/bookings')
      .set(u.auth)
      .send({
        pitchId: f.pitchId,
        configurationId: f.wholeId,
        startsAt: tb(day, from),
        durationMinutes: minutes,
      });
    if (r.status !== 201) throw new Error(`booking ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as Json;
  };
  const window = (pitchId: string, from: string, to: string) => ({
    pitchId,
    startsAt: tb(day, from),
    endsAt: tb(day, to),
  });
  const params = (pitchId: string, from = '09:00', to = '16:00', extra: object = {}) => ({
    windows: [window(pitchId, from, to)],
    matchMinutes: 20,
    changeoverMinutes: 5,
    minRestMinutes: 20,
    ...extra,
  });

  it('attach rules, unconfirmed / outside / lost windows, scheduling inside the confirmed window', async () => {
    const org = await createUser(t);
    const stranger = await createUser(t);
    const f = await createPitch(t);
    const decider = await createUser(t);
    await grantVia(t, f.admin, decider, 'VENUE', f.venueId, 'pitch.bookings.decide').then((r) =>
      expect(r.status).toBe(201),
    );
    const { id, clubs } = await leagueTournament(org);

    const mine = await book(org, f, '10:00', 180);
    expect(mine.status).toBe('REQUESTED');
    const foreign = await book(stranger, f, '14:00', 60);
    const attach = (u: TestUser, bookingId: string, tid = id) =>
      t
        .http()
        .post(`/v1/tournaments/${tid}/bookings`)
        .set(u.auth)
        .set('Idempotency-Key', idemKey())
        .send({ bookingId });

    // only somebody entitled to the booking can attach it
    await attach(org, foreign.id).expect(403);
    await attach(stranger, mine.id).expect(403);
    const a1 = await attach(org, mine.id).expect(200);
    expect(a1.body.items).toHaveLength(1);
    expect(a1.body.items[0]).toMatchObject({
      bookingId: mine.id,
      effective: 'PENDING',
      status: 'REQUESTED',
    });
    await attach(org, mine.id).expect(200); // idempotent
    expect(
      (await t.http().get(`/v1/tournaments/${id}/bookings`).set(org.auth).expect(200)).body.items,
    ).toHaveLength(1);
    await t.http().get(`/v1/tournaments/${id}/bookings`).set(stranger.auth).expect(403);
    // a rep of an entered club may lend their booking
    const repBooking = await book(clubs[0]?.owner as TestUser, f, '16:00', 60);
    await attach(org, repBooking.id).expect(200);
    await t
      .http()
      .delete(`/v1/tournaments/${id}/bookings/${repBooking.id}`)
      .set(org.auth)
      .expect(200);
    // a booking belongs to one tournament only
    const other = await createTournament(t, org);
    await attach(org, mine.id, other.id).expect(409);
    // assistants without the schedule module cannot attach
    await attach(clubs[0]?.owner as TestUser, mine.id).expect(403);

    // the window is only REQUESTED: nothing can be placed in it, moves report WINDOW_UNCONFIRMED
    const preview0 = (await post(org, `${id}/schedule/preview`, params(f.pitchId)).expect(200))
      .body;
    expect(preview0.slots).toHaveLength(0);
    expect(preview0.unscheduled.length).toBe(6);
    const fx = await fixturesOf(id, org);
    const slot = (fid: string, from: string, minutes = 20) =>
      t
        .http()
        .patch(`/v1/tournaments/${id}/fixtures/${fid}/slot`)
        .set(org.auth)
        .send({
          pitchId: f.pitchId,
          startsAt: tb(day, from),
          endsAt: new Date(Date.parse(tb(day, from)) + minutes * 60_000).toISOString(),
        });
    const unconfirmed = await slot((fx[0] as Json).id, '10:30').expect(409);
    expect(unconfirmed.body.error.details.bookingProblems[0].code).toBe('WINDOW_UNCONFIRMED');

    // the venue confirms
    await t.http().post(`/v1/bookings/${mine.id}/confirm`).set(decider.auth).expect(200);
    const outside = await slot((fx[0] as Json).id, '14:30').expect(409);
    expect(outside.body.error.details.bookingProblems[0].code).toBe('OUTSIDE_BOOKED_WINDOW');
    const straddle = await slot((fx[0] as Json).id, '12:50').expect(409); // 12:50-13:10 crosses the end of the window
    expect(straddle.body.error.details.bookingProblems[0].code).toBe('OUTSIDE_BOOKED_WINDOW');

    // many fixtures share the one 3-hour booking; the rental is 180 min, a match 20
    const preview = (await post(org, `${id}/schedule/preview`, params(f.pitchId)).expect(200)).body;
    expect(preview.unscheduled).toEqual([]);
    expect(preview.slots).toHaveLength(6);
    expect(preview.bookingProblems).toEqual([]);
    expect(preview.warnings).toEqual([]); // covered by an attached booking => not "unbooked"
    for (const s of preview.slots) {
      expect(Date.parse(s.startsAt)).toBeGreaterThanOrEqual(Date.parse(tb(day, '10:00')));
      expect(Date.parse(s.endsAt)).toBeLessThanOrEqual(Date.parse(tb(day, '13:00')));
    }
    const applied = (await post(org, `${id}/schedule/apply`, params(f.pitchId)).expect(200)).body;
    expect(applied.saved).toBe(true);
    const list = (await t.http().get(`/v1/tournaments/${id}/bookings`).set(org.auth).expect(200))
      .body.items;
    expect(list[0]).toMatchObject({ effective: 'CONFIRMED', fixtureCount: 6 });
    expect(
      (await t.http().get(`/v1/tournaments/${id}/schedule/report`).set(org.auth).expect(200)).body
        .bookingProblems,
    ).toEqual([]);

    // the booker cancels the rental: the loss is visible in the report, publish and start
    await t
      .http()
      .post(`/v1/bookings/${mine.id}/cancel`)
      .set(org.auth)
      .send({ reason: 'changed plans' })
      .expect(200);
    const report = (
      await t.http().get(`/v1/tournaments/${id}/schedule/report`).set(org.auth).expect(200)
    ).body;
    expect(report.bookingProblems).toHaveLength(6);
    expect(
      report.bookingProblems.every(
        (p: Json) => p.code === 'WINDOW_LOST' && p.bookingId === mine.id,
      ),
    ).toBe(true);
    const pub = await post(org, `${id}/schedule/publish`).expect(409);
    expect(pub.body.error.details.bookingProblems).toHaveLength(6);
    const start = await post(org, `${id}/start`).expect(409);
    const codes = (start.body.error.details.problems as { code: string }[]).map((p) => p.code);
    expect(codes).toContain('WINDOW_LOST');
    expect(
      (await t.http().get(`/v1/tournaments/${id}/bookings`).set(org.auth).expect(200)).body.items[0]
        .effective,
    ).toBe('LOST');
    // an explicit detach removes the (dead) window; the pitch is then only checked for availability
    await t.http().delete(`/v1/tournaments/${id}/bookings/${mine.id}`).set(org.auth).expect(200);
    const after = (
      await t.http().get(`/v1/tournaments/${id}/schedule/report`).set(org.auth).expect(200)
    ).body;
    expect(after.bookingProblems).toEqual([]);
    expect(after.warnings).toHaveLength(6);
    expect(after.warnings[0].code).toBe('UNBOOKED');
  });

  it('a pitch without attached windows is checked for real availability; foreign bookings are never double-booked', async () => {
    const org = await createUser(t);
    const f = await createPitch(t, { quarters: true });
    const { id } = await leagueTournament(org);

    // a foreign external booking of ONE QUARTER blocks the whole-pitch matches (all parts are checked)
    const cal = await createUser(t);
    await grantVia(t, f.admin, cal, 'VENUE', f.venueId, 'pitch.calendar.manage').then((r) =>
      expect(r.status).toBe(201),
    );
    await t
      .http()
      .post(`/v1/pitches/${f.pitchId}/bookings/external`)
      .set(cal.auth)
      .send({
        configurationId: f.configs['Q3'],
        startsAt: tb(day, '10:00'),
        durationMinutes: 60,
        externalName: 'Local team',
      })
      .expect(201);
    const prev = (
      await post(org, `${id}/schedule/preview`, params(f.pitchId, '10:00', '14:00')).expect(200)
    ).body;
    expect(prev.bookingProblems).toEqual([]);
    for (const s of prev.slots)
      expect(Date.parse(s.startsAt)).toBeGreaterThanOrEqual(Date.parse(tb(day, '11:00')));
    expect(prev.warnings.every((w: Json) => w.code === 'UNBOOKED')).toBe(true);

    // manual slot inside the foreign booking => RESOURCE_UNAVAILABLE (409 with the problem list)
    const fx = await fixturesOf(id, org);
    const clash = await t
      .http()
      .patch(`/v1/tournaments/${id}/fixtures/${(fx[0] as Json).id}/slot`)
      .set(org.auth)
      .send({ pitchId: f.pitchId, startsAt: tb(day, '10:20') })
      .expect(409);
    expect(clash.body.error.details.bookingProblems[0].code).toBe('RESOURCE_UNAVAILABLE');

    // apply on a free stretch, then a foreign block appears on top of a placed match: surfaced, never silent
    await post(org, `${id}/schedule/apply`, params(f.pitchId, '13:00', '17:00')).expect(200);
    const placed = (await fixturesOf(id, org)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const firstStart = new Date(placed[0]?.startsAt as string);
    const blocked = await t.http().post(`/v1/pitches/${f.pitchId}/blocks`).set(cal.auth).send({
      configurationId: f.configs['Q1'],
      startsAt: firstStart.toISOString(),
      durationMinutes: 60,
    });
    expect(blocked.status).toBe(201);
    const report = (
      await t.http().get(`/v1/tournaments/${id}/schedule/report`).set(org.auth).expect(200)
    ).body;
    {
      expect(report.bookingProblems.some((p: Json) => p.code === 'RESOURCE_UNAVAILABLE')).toBe(
        true,
      );
      const pub = await post(org, `${id}/schedule/publish`).expect(409);
      expect(pub.body.error.details.bookingProblems.length).toBeGreaterThan(0);
      const start = await post(org, `${id}/start`).expect(409);
      expect(
        (start.body.error.details.problems as { code: string }[]).map((p) => p.code),
      ).toContain('RESOURCE_UNAVAILABLE');
    }
  });

  it('apply re-validates inside its transaction: a booking created concurrently cannot end up silently double-booked', async () => {
    const org = await createUser(t);
    const f = await createPitch(t);
    const { id } = await leagueTournament(org);
    const other = await createUser(t);
    // the tournament wants the free stretch 10:00-13:00 while somebody books 10:00-12:00 at the same moment
    const [applied, booked] = await Promise.all([
      post(org, `${id}/schedule/apply`, params(f.pitchId, '10:00', '14:00')),
      t
        .http()
        .post('/v1/bookings')
        .set(other.auth)
        .send({
          pitchId: f.pitchId,
          configurationId: f.wholeId,
          startsAt: tb(day, '10:00'),
          durationMinutes: 120,
        }),
    ]);
    expect([200, 409]).toContain(applied.status);
    expect([201, 409]).toContain(booked.status);
    const timed = (await fixturesOf(id, org)).filter((x) => x.startsAt);
    const occupancy = await t.prisma.pitchOccupancy.findMany({
      where: { part: { pitchId: f.pitchId }, releasedAt: null },
    });
    const overlaps = timed.filter((x) =>
      occupancy.some(
        (o) =>
          o.startsAt.getTime() < Date.parse(x.endsAt) &&
          o.endsAt.getTime() > Date.parse(x.startsAt),
      ),
    );
    // Invariant: either nothing overlaps, or (booking came after apply committed) the report flags it
    const report = (
      await t.http().get(`/v1/tournaments/${id}/schedule/report`).set(org.auth).expect(200)
    ).body;
    if (overlaps.length > 0) {
      expect(report.bookingProblems.some((p: Json) => p.code === 'RESOURCE_UNAVAILABLE')).toBe(
        true,
      );
    } else {
      expect(report.bookingProblems).toEqual([]);
    }
    // deterministic variant: booking committed BEFORE apply => the applied schedule keeps clear of it
    const f2 = await createPitch(t);
    const t2 = await leagueTournament(org);
    await t
      .http()
      .post('/v1/bookings')
      .set(other.auth)
      .send({
        pitchId: f2.pitchId,
        configurationId: f2.wholeId,
        startsAt: tb(day, '10:00'),
        durationMinutes: 60,
      })
      .expect(201);
    const okRes = await post(org, `${t2.id}/schedule/apply`, params(f2.pitchId, '10:00', '14:00'));
    if (okRes.status !== 200) throw new Error(JSON.stringify(okRes.body));
    const ok = okRes.body;
    for (const s of ok.slots)
      expect(Date.parse(s.startsAt)).toBeGreaterThanOrEqual(Date.parse(tb(day, '11:00')));
    // and a stale preview cannot be forced through: a fixture forced into the foreign hour is refused
    const f2fx = await fixturesOf(t2.id, org);
    await t
      .http()
      .patch(`/v1/tournaments/${t2.id}/fixtures/${(f2fx[0] as Json).id}/slot`)
      .set(org.auth)
      .send({ pitchId: f2.pitchId, startsAt: tb(day, '10:10') })
      .expect(409);
  });
});
