import { BookingsService } from '../src/modules/bookings/bookings.service';
import { createPitch, futureDate, grantVia, makeStaff, tb } from './bookings.support';
import { createTestApp, type TestApp } from './support/app';
import { createUser, uniq, type TestUser } from './support/factories';

describe('bookings (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const book = (
    u: TestUser,
    body: {
      pitchId: string;
      configurationId?: string;
      startsAt: string;
      durationMinutes: number;
    } & Record<string, unknown>,
    key?: string,
  ) => {
    const r = t.http().post('/v1/bookings').set(u.auth);
    if (key) r.set('Idempotency-Key', key);
    return r.send(body);
  };

  const api = (
    u: TestUser,
    method: 'post' | 'get' | 'put' | 'delete' | 'patch',
    path: string,
    body?: object,
  ) => {
    const r = t.http()[method](path).set(u.auth);
    return body ? r.send(body) : r;
  };

  async function manager(f: { venueId: string }, ...perms: string[]): Promise<TestUser> {
    const admin = await makeStaff(t, 'admin.catalog.manage');
    const m = await createUser(t);
    for (const p of perms)
      await grantVia(t, admin, m, 'VENUE', f.venueId, p).then((r) => expect(r.status).toBe(201));
    return m;
  }

  describe('server-side booking rules', () => {
    it('grid, minimum, step (extension off), opening hours across midnight, past', async () => {
      const f = await createPitch(t);
      const u = await createUser(t);
      const d = futureDate(5);
      const base = { pitchId: f.pitchId, configurationId: f.wholeId };
      const fail = async (startsAt: string, durationMinutes: number, rule: string) => {
        const r = await book(u, { ...base, startsAt, durationMinutes }).expect(400);
        expect(r.body.error.code).toBe('VALIDATION');
        expect(r.body.error.details.rule).toBe(rule);
      };
      await fail(tb(d, '18:15'), 60, 'START_NOT_ON_GRID');
      await fail(tb(d, '18:00'), 30, 'DURATION_TOO_SHORT');
      await fail(tb(d, '18:00'), 90, 'DURATION_STEP'); // extension off: 60/120/180
      await fail(tb(d, '08:00'), 60, 'OUTSIDE_OPENING_HOURS');
      await fail(tb(d, '23:30'), 120, 'OUTSIDE_OPENING_HOURS'); // would end 01:30, closes 01:00
      await fail(tb(futureDate(-2), '18:00'), 60, 'IN_THE_PAST');
      await book(u, { ...base, startsAt: tb(d, '18:00'), durationMinutes: 45 }).expect(400);
      await book(u, {
        ...base,
        startsAt: tb(d, '18:00'),
        durationMinutes: 60,
        status: 'CONFIRMED',
      }).expect(400);

      // valid: 18:30 start is fine in both modes; 120 minutes ok; crossing midnight 23:00–01:00 ok
      const a = await book(u, { ...base, startsAt: tb(d, '18:30'), durationMinutes: 60 }).expect(
        201,
      );
      expect(a.body).toMatchObject({
        status: 'REQUESTED',
        pitchBooked: false,
        source: 'LETSGO',
        rulesVersion: 2,
      });
      expect(a.body.confirmationSource).toBeNull();
      await book(u, { ...base, startsAt: tb(d, '20:00'), durationMinutes: 120 }).expect(201);
      await book(u, { ...base, startsAt: tb(d, '23:00'), durationMinutes: 120 }).expect(201);
    });

    it('30-minute extension on: 60/90/120…; turning it off later leaves existing bookings alone', async () => {
      const f = await createPitch(t, { allowHalfHourExtension: true });
      const u = await createUser(t);
      const d = futureDate(6);
      const base = { pitchId: f.pitchId, configurationId: f.wholeId };
      const long = await book(u, { ...base, startsAt: tb(d, '18:00'), durationMinutes: 90 }).expect(
        201,
      );
      const rulesVersionThen = long.body.rulesVersion as number;
      const before = await api(f.admin, 'get', `/v1/pitches/${f.pitchId}`).expect(200);
      expect(before.body.bookingRules).toMatchObject({
        allowHalfHourExtension: true,
        stepMinutes: 30,
      });

      const off = await api(f.admin, 'put', `/v1/pitches/${f.pitchId}/booking-rules`, {
        allowHalfHourExtension: false,
      }).expect(200);
      expect(off.body.bookingRules.ruleVersion).toBe(rulesVersionThen + 1);
      expect(off.body.bookingRules.stepMinutes).toBe(60);

      // new 90-minute bookings are refused now …
      const r = await book(u, { ...base, startsAt: tb(d, '21:00'), durationMinutes: 90 }).expect(
        400,
      );
      expect(r.body.error.details.rule).toBe('DURATION_STEP');
      // … but the old one keeps its version, remains readable and cancellable
      const got = await api(u, 'get', `/v1/bookings/${long.body.id}`).expect(200);
      expect(got.body).toMatchObject({ rulesVersion: rulesVersionThen, status: 'REQUESTED' });
      const cancelled = await api(u, 'post', `/v1/bookings/${long.body.id}/cancel`, {}).expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
    });

    it('closed weekdays and missing configuration are enforced; hours are in the venue timezone', async () => {
      const f = await createPitch(t, { hours: { mon: [{ open: '10:00', close: '12:00' }] } });
      const u = await createUser(t);
      // find the next Monday (venue local) ≥ 4 days ahead
      let d = futureDate(4);
      while (new Date(`${d}T12:00:00+04:00`).getUTCDay() !== 1) {
        d = new Date(new Date(`${d}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
      }
      const base = { pitchId: f.pitchId, configurationId: f.wholeId };
      await book(u, { ...base, startsAt: tb(d, '10:00'), durationMinutes: 60 }).expect(201);
      // 07:00 UTC = 11:00 local: inside; the same wall clock in UTC would be wrong
      await book(u, { ...base, startsAt: `${d}T07:00:00Z`, durationMinutes: 60 }).expect(201);
      const tue = new Date(new Date(`${d}T00:00:00Z`).getTime() + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const r = await book(u, { ...base, startsAt: tb(tue, '10:00'), durationMinutes: 60 }).expect(
        400,
      );
      expect(r.body.error.details.rule).toBe('OUTSIDE_OPENING_HOURS');
      await book(u, { pitchId: f.pitchId, startsAt: tb(d, '10:00'), durationMinutes: 60 }).expect(
        400,
      );
      await book(u, {
        ...base,
        configurationId: '0190a0a0-0000-7000-8000-000000000000',
        startsAt: tb(d, '10:00'),
        durationMinutes: 60,
      }).expect(400);
    });

    it('terms: the latest version must be accepted and is stored with the acceptance time', async () => {
      const f = await createPitch(t, { terms: 'Cancel 24h before. Minimum squad 8.' });
      const u = await createUser(t);
      const d = futureDate(7);
      const base = {
        pitchId: f.pitchId,
        configurationId: f.wholeId,
        startsAt: tb(d, '18:00'),
        durationMinutes: 60,
      };
      const missing = await book(u, base).expect(400);
      expect(missing.body.error.details).toMatchObject({
        field: 'termsVersion',
        latestTermsVersion: 1,
      });
      await api(f.admin, 'post', `/v1/pitches/${f.pitchId}/terms`, {
        body: 'Cancel 48h before.',
      }).expect(201);
      const stale = await book(u, { ...base, termsVersion: 1 }).expect(409);
      expect(stale.body.error).toMatchObject({
        code: 'VERSION_CHANGED',
        details: { currentVersion: 2 },
      });
      const ok = await book(u, { ...base, termsVersion: 2 }).expect(201);
      expect(ok.body.termsVersion).toBe(2);
      expect(Date.parse(ok.body.termsAcceptedAt)).toBeGreaterThan(Date.now() - 60_000);
      // append-only history
      const terms = await api(f.admin, 'get', `/v1/pitches/${f.pitchId}/terms`).expect(200);
      expect(terms.body.items.map((x: { version: number }) => x.version)).toEqual([2, 1]);
      const pub = await t.http().get(`/v1/pitches/${f.pitchId}/terms/latest`).expect(200);
      expect(pub.body.version).toBe(2);
    });
  });

  describe('occupancy', () => {
    it('overlaps are rejected with BOOKING_CONFLICT; adjacent slots work; cancel and reject release', async () => {
      const f = await createPitch(t);
      const [a, b] = await Promise.all([createUser(t), createUser(t)]);
      const mgr = await manager(f, 'pitch.bookings.decide');
      const d = futureDate(8);
      const base = { pitchId: f.pitchId, configurationId: f.wholeId };
      const first = await book(a, {
        ...base,
        startsAt: tb(d, '18:00'),
        durationMinutes: 120,
      }).expect(201);
      const clash = await book(b, {
        ...base,
        startsAt: tb(d, '19:00'),
        durationMinutes: 60,
      }).expect(409);
      expect(clash.body.error).toMatchObject({
        code: 'BOOKING_CONFLICT',
        message: 'This time is no longer available.',
      });
      await book(b, { ...base, startsAt: tb(d, '17:00'), durationMinutes: 60 }).expect(201); // ends 18:00
      await book(b, { ...base, startsAt: tb(d, '20:00'), durationMinutes: 60 }).expect(201); // starts 20:00

      // cancelling releases
      await api(a, 'post', `/v1/bookings/${first.body.id}/cancel`, {
        reason: 'plans changed',
      }).expect(200);
      const occ = await t.prisma.pitchOccupancy.findMany({ where: { bookingId: first.body.id } });
      expect(occ.length).toBeGreaterThan(0);
      expect(occ.every((o) => o.releasedAt !== null)).toBe(true);
      const again = await book(b, {
        ...base,
        startsAt: tb(d, '18:00'),
        durationMinutes: 120,
      }).expect(201);
      // rejecting releases as well
      await api(mgr, 'post', `/v1/bookings/${again.body.id}/reject`, { reason: 'closed' }).expect(
        200,
      );
      await book(a, { ...base, startsAt: tb(d, '18:00'), durationMinutes: 60 }).expect(201);
      // a second cancel is a state error
      await api(a, 'post', `/v1/bookings/${first.body.id}/cancel`, {}).expect(409);
    });

    it('concurrent overlapping requests: exactly one wins, everyone else gets BOOKING_CONFLICT', async () => {
      const f = await createPitch(t);
      const users = await Promise.all(Array.from({ length: 6 }, () => createUser(t)));
      const d = futureDate(9);
      const results = await Promise.all(
        users.map((u, i) =>
          book(u, {
            pitchId: f.pitchId,
            configurationId: f.wholeId,
            // all overlap each other, different offsets
            startsAt: tb(d, i % 2 === 0 ? '18:00' : '18:30'),
            durationMinutes: 60,
          }),
        ),
      );
      const ok = results.filter((r) => r.status === 201);
      const lost = results.filter((r) => r.status === 409);
      expect(ok).toHaveLength(1);
      expect(lost).toHaveLength(5);
      for (const l of lost) expect(l.body.error.code).toBe('BOOKING_CONFLICT');
      const rows = await t.prisma.booking.count({
        where: { pitchId: f.pitchId, status: 'REQUESTED' },
      });
      expect(rows).toBe(1);
      const live = await t.prisma.pitchOccupancy.count({
        where: { part: { pitchId: f.pitchId }, releasedAt: null },
      });
      expect(live).toBe(f.partIds.length);
    });

    it('divisible pitch: whole conflicts with any part; independent halves/quarters run in parallel', async () => {
      const f = await createPitch(t, { quarters: true });
      const u = await Promise.all([createUser(t), createUser(t), createUser(t), createUser(t)]);
      const mgr = await manager(f, 'pitch.bookings.decide');
      const d = futureDate(10);
      const slot = { startsAt: tb(d, '18:00'), durationMinutes: 60, pitchId: f.pitchId };
      const c = (name: string) => ({ ...slot, configurationId: f.configs[name] as string });

      const halfA = await book(u[0] as TestUser, c('Half A')).expect(201);
      await book(u[1] as TestUser, c('Half B')).expect(201); // independent half
      const whole = await book(u[2] as TestUser, c('Whole pitch')).expect(409);
      expect(whole.body.error.code).toBe('BOOKING_CONFLICT');
      await book(u[2] as TestUser, c('Q1')).expect(409); // inside Half A
      await book(u[2] as TestUser, c('Q4')).expect(409); // inside Half B
      // a different time on the whole pitch is fine
      await book(u[2] as TestUser, { ...c('Whole pitch'), startsAt: tb(d, '20:00') }).expect(201);
      // freeing Half A alone does not free the whole pitch (Half B still there) …
      await api(u[0] as TestUser, 'post', `/v1/bookings/${halfA.body.id}/cancel`, {}).expect(200);
      await book(u[3] as TestUser, c('Whole pitch')).expect(409);
      await book(u[3] as TestUser, c('Q2')).expect(201);
      await book(u[3] as TestUser, c('Q1')).expect(201);
      // … four independent quarters at another time
      const other = { ...slot, startsAt: tb(d, '22:00') };
      const quarters = await Promise.all(
        ['Q1', 'Q2', 'Q3', 'Q4'].map((q, i) =>
          book(u[i] as TestUser, { ...other, configurationId: f.configs[q] as string }),
        ),
      );
      expect(quarters.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      await book(u[0] as TestUser, { ...other, configurationId: f.wholeId }).expect(409);
      void mgr;
    });

    it('availability reflects the occupancy of every part of the chosen configuration', async () => {
      const f = await createPitch(t, { quarters: true });
      const u = await createUser(t);
      const d = futureDate(11);
      await book(u, {
        pitchId: f.pitchId,
        configurationId: f.configs['Half A'] as string,
        startsAt: tb(d, '18:00'),
        durationMinutes: 60,
      }).expect(201);
      const q = (cfg: string) =>
        t
          .http()
          .get(`/v1/pitches/${f.pitchId}/availability?date=${d}&configurationId=${cfg}`)
          .expect(200);
      const whole = await q(f.wholeId);
      const halfB = await q(f.configs['Half B'] as string);
      const startsWhole = whole.body.intervals.map((i: { startsAt: string }) => i.startsAt);
      // whole pitch is split around the booking; Half B is one uninterrupted stretch
      expect(whole.body.intervals).toHaveLength(2);
      expect(startsWhole).toContain(tb(d, '19:00'));
      expect(halfB.body.intervals).toHaveLength(1);
      expect(halfB.body.intervals[0]).toEqual({
        startsAt: tb(d, '09:00'),
        endsAt: tb(d, '01:00', 1),
      });
      expect(whole.body).toMatchObject({
        timezone: 'Asia/Tbilisi',
        minDurationMinutes: 60,
        stepMinutes: 60,
      });
      await t.http().get(`/v1/pitches/${f.pitchId}/availability?date=nonsense`).expect(400);
    });
  });

  describe('status flow', () => {
    it('REQUESTED → CONFIRMED by a decider; clients can never confirm; audit + notifications', async () => {
      const f = await createPitch(t);
      const booker = await createUser(t);
      const stranger = await createUser(t);
      const mgr = await manager(f, 'pitch.bookings.decide');
      const calOnly = await manager(f, 'pitch.calendar.manage');
      const d = futureDate(12);
      const b = await book(booker, {
        pitchId: f.pitchId,
        configurationId: f.wholeId,
        startsAt: tb(d, '18:00'),
        durationMinutes: 60,
      }).expect(201);
      const id = b.body.id as string;

      await api(booker, 'post', `/v1/bookings/${id}/confirm`).expect(403);
      await api(stranger, 'post', `/v1/bookings/${id}/confirm`).expect(404);
      await api(calOnly, 'post', `/v1/bookings/${id}/confirm`).expect(403);
      await api(stranger, 'get', `/v1/bookings/${id}`).expect(404);

      // deciders get a notification about the request
      expect(
        await t.prisma.notification.count({
          where: { recipientId: mgr.userId, category: 'booking', objectId: id },
        }),
      ).toBe(1);

      const ok = await api(mgr, 'post', `/v1/bookings/${id}/confirm`).expect(200);
      expect(ok.body).toMatchObject({
        status: 'CONFIRMED',
        pitchBooked: true,
        confirmationSource: 'VENUE',
        confirmedById: mgr.userId,
      });
      const mine = await api(booker, 'get', `/v1/bookings/${id}`).expect(200);
      expect(mine.body).toMatchObject({ status: 'CONFIRMED', pitchBooked: true });
      expect(mine.body).not.toHaveProperty('staffNote');
      expect(mine.body).not.toHaveProperty('externalPhone');
      await api(mgr, 'post', `/v1/bookings/${id}/confirm`).expect(409);
      expect(
        await t.prisma.auditEvent.count({ where: { action: 'booking.confirm', targetId: id } }),
      ).toBe(1);
      expect(
        await t.prisma.notification.count({
          where: { recipientId: booker.userId, objectId: id, title: { contains: 'confirmed' } },
        }),
      ).toBe(1);

      // the booker's list
      const list = await api(booker, 'get', '/v1/bookings/mine').expect(200);
      expect(list.body.items.map((x: { id: string }) => x.id)).toContain(id);
      // the pitch inbox is staff only
      await api(stranger, 'get', `/v1/pitches/${f.pitchId}/bookings`).expect(403);
      const inbox = await api(
        mgr,
        'get',
        `/v1/pitches/${f.pitchId}/bookings?status=CONFIRMED`,
      ).expect(200);
      expect(inbox.body.items[0]).toMatchObject({ id, booker: { userId: booker.userId } });
    });

    it('reject and staff cancel are audited and notify the booker; a booker cancel notifies staff', async () => {
      const f = await createPitch(t);
      const booker = await createUser(t);
      const mgr = await manager(f, 'pitch.bookings.decide', 'pitch.calendar.manage');
      const d = futureDate(13);
      const mk = async (h: string) =>
        (
          await book(booker, {
            pitchId: f.pitchId,
            configurationId: f.wholeId,
            startsAt: tb(d, h),
            durationMinutes: 60,
          }).expect(201)
        ).body.id as string;
      const [r1, r2, r3] = [await mk('10:00'), await mk('12:00'), await mk('14:00')];
      const rej = await api(mgr, 'post', `/v1/bookings/${r1}/reject`, {
        reason: 'Maintenance',
      }).expect(200);
      expect(rej.body).toMatchObject({ status: 'REJECTED', cancelReason: 'Maintenance' });
      await api(mgr, 'post', `/v1/bookings/${r2}/confirm`).expect(200);
      const cancelled = await api(mgr, 'post', `/v1/bookings/${r2}/cancel`, {
        reason: 'Flooded',
      }).expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      expect(
        await t.prisma.auditEvent.count({ where: { action: 'booking.reject', targetId: r1 } }),
      ).toBe(1);
      expect(
        await t.prisma.auditEvent.count({ where: { action: 'booking.cancel', targetId: r2 } }),
      ).toBe(1);
      expect(
        await t.prisma.notification.count({ where: { recipientId: booker.userId, objectId: r2 } }),
      ).toBeGreaterThanOrEqual(2);
      await api(booker, 'post', `/v1/bookings/${r3}/cancel`, {}).expect(200);
      expect(
        await t.prisma.notification.count({
          where: { recipientId: mgr.userId, objectId: r3, category: 'booking' },
        }),
      ).toBeGreaterThanOrEqual(1);
      await api(mgr, 'post', `/v1/bookings/${r1}/confirm`).expect(409); // rejected is final
    });

    it('holds: visible expiry, lazy expiry on read, exported expireHolds, time is released', async () => {
      const f = await createPitch(t);
      const booker = await createUser(t);
      const other = await createUser(t);
      const mgr = await manager(f, 'pitch.bookings.decide');
      const d = futureDate(14);
      const base = { pitchId: f.pitchId, configurationId: f.wholeId, durationMinutes: 60 };
      const one = await book(booker, { ...base, startsAt: tb(d, '18:00') }).expect(201);
      const two = await book(booker, { ...base, startsAt: tb(d, '20:00') }).expect(201);

      await api(booker, 'post', `/v1/bookings/${one.body.id}/hold`, { holdMinutes: 30 }).expect(
        403,
      );
      const held = await api(mgr, 'post', `/v1/bookings/${one.body.id}/hold`, {
        holdMinutes: 30,
      }).expect(200);
      expect(held.body.status).toBe('HELD');
      expect(held.body.pitchBooked).toBe(false);
      expect(Date.parse(held.body.holdExpiresAt)).toBeGreaterThan(Date.now());
      await book(other, { ...base, startsAt: tb(d, '18:00') }).expect(409); // held time is taken

      // lazy expiry on read
      await t.prisma.booking.update({
        where: { id: one.body.id },
        data: { holdExpiresAt: new Date(Date.now() - 1000) },
      });
      const after = await api(booker, 'get', `/v1/bookings/${one.body.id}`).expect(200);
      expect(after.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'HOLD_EXPIRED' });
      await book(other, { ...base, startsAt: tb(d, '18:00') }).expect(201);

      // exported method (scheduler-friendly)
      await api(mgr, 'post', `/v1/bookings/${two.body.id}/hold`, { holdMinutes: 15 }).expect(200);
      const svc = t.app.get(BookingsService);
      expect(await svc.expireHolds(new Date(Date.now() + 20 * 60_000))).toBeGreaterThanOrEqual(1);
      const row = await t.prisma.booking.findUniqueOrThrow({ where: { id: two.body.id } });
      expect(row.status).toBe('CANCELLED');
      // a confirmed booking is never affected by expiry
      const three = await book(booker, { ...base, startsAt: tb(d, '22:00') }).expect(201);
      await api(mgr, 'post', `/v1/bookings/${three.body.id}/confirm`).expect(200);
      await svc.expireHolds(new Date(Date.now() + 86_400_000));
      expect(
        (await t.prisma.booking.findUniqueOrThrow({ where: { id: three.body.id } })).status,
      ).toBe('CONFIRMED');
    });

    it('finished confirmed bookings become COMPLETED (lazily, or by staff)', async () => {
      const f = await createPitch(t);
      const booker = await createUser(t);
      const mgr = await manager(f, 'pitch.bookings.decide');
      const d = futureDate(15);
      const mk = async (h: string) => {
        const b = await book(booker, {
          pitchId: f.pitchId,
          configurationId: f.wholeId,
          startsAt: tb(d, h),
          durationMinutes: 60,
        }).expect(201);
        await api(mgr, 'post', `/v1/bookings/${b.body.id}/confirm`).expect(200);
        return b.body.id as string;
      };
      const id = await mk('18:00');
      await api(mgr, 'post', `/v1/bookings/${id}/complete`).expect(409); // not over yet
      // move the booking into the past (test-only data change)
      await t.prisma.booking.update({
        where: { id },
        data: {
          startsAt: new Date(Date.now() - 7_200_000),
          endsAt: new Date(Date.now() - 3_600_000),
        },
      });
      const got = await api(booker, 'get', `/v1/bookings/${id}`).expect(200);
      expect(got.body.status).toBe('COMPLETED');
    });

    it('getBookingForEventLink exposes what the games module needs', async () => {
      const f = await createPitch(t);
      const booker = await createUser(t);
      const mgr = await manager(f, 'pitch.bookings.decide');
      const b = await book(booker, {
        pitchId: f.pitchId,
        configurationId: f.wholeId,
        startsAt: tb(futureDate(16), '18:00'),
        durationMinutes: 60,
      }).expect(201);
      const svc = t.app.get(BookingsService);
      const before = await svc.getBookingForEventLink(t.prisma, b.body.id);
      expect(before).toMatchObject({
        id: b.body.id,
        pitchId: f.pitchId,
        venueId: f.venueId,
        status: 'REQUESTED',
        bookedById: booker.userId,
        confirmationSource: null,
      });
      await api(mgr, 'post', `/v1/bookings/${b.body.id}/confirm`).expect(200);
      const after = await svc.getBookingForEventLink(t.prisma, b.body.id);
      expect(after).toMatchObject({ status: 'CONFIRMED', confirmationSource: 'VENUE' });
      expect(after?.startsAt).toBeInstanceOf(Date);
      expect(
        await svc.getBookingForEventLink(t.prisma, '0190a0a0-0000-7000-8000-000000000000'),
      ).toBeNull();
    });

    it('create is idempotent: same key → one booking, also under a parallel double-submit', async () => {
      const f = await createPitch(t);
      const u = await createUser(t);
      const d = futureDate(17);
      const body = {
        pitchId: f.pitchId,
        configurationId: f.wholeId,
        startsAt: tb(d, '18:00'),
        durationMinutes: 60,
      };
      const key = `bk-${uniq(12)}`;
      const [x, y] = await Promise.all([book(u, body, key), book(u, body, key)]);
      expect([x.status, y.status]).toEqual([201, 201]);
      expect(x.body.id).toBe(y.body.id);
      const later = await book(u, body, key).expect(201);
      expect(later.body.id).toBe(x.body.id);
      expect(await t.prisma.booking.count({ where: { pitchId: f.pitchId } })).toBe(1);
      const diff = await book(u, { ...body, startsAt: tb(d, '20:00') }, key).expect(409);
      expect(diff.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('community, hidden and unknown pitches cannot be booked', async () => {
      const f = await createPitch(t);
      const u = await createUser(t);
      const d = futureDate(18);
      await api(f.admin, 'post', `/v1/pitches/${f.pitchId}/hide`).expect(200);
      await book(u, {
        pitchId: f.pitchId,
        configurationId: f.wholeId,
        startsAt: tb(d, '18:00'),
        durationMinutes: 60,
      }).expect(404);
      await api(u, 'get', `/v1/pitches/${f.pitchId}/availability?date=${d}`).expect(404);
      await book(u, {
        pitchId: '0190a0a0-0000-7000-8000-000000000000',
        configurationId: f.wholeId,
        startsAt: tb(d, '18:00'),
        durationMinutes: 60,
      }).expect(404);
      const anon = await t.http().post('/v1/bookings').send({}).expect(401);
      expect(anon.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('manager calendar', () => {
    it('external bookings: staff only, hidden from everybody else, same validator, occupy the slot', async () => {
      const f = await createPitch(t);
      const cal = await manager(f, 'pitch.calendar.manage');
      const decider = await manager(f, 'pitch.bookings.decide');
      const booker = await createUser(t);
      const d = futureDate(19);
      const ext = {
        configurationId: f.wholeId,
        startsAt: tb(d, '18:00'),
        durationMinutes: 60,
        externalName: 'Dinamo Old Boys',
        externalPhone: '+995000000000',
        staffNote: 'pays cash',
      };
      await api(booker, 'post', `/v1/pitches/${f.pitchId}/bookings/external`, ext).expect(403);
      await api(decider, 'post', `/v1/pitches/${f.pitchId}/bookings/external`, ext).expect(403);
      await api(cal, 'post', `/v1/pitches/${f.pitchId}/bookings/external`, {
        ...ext,
        externalName: undefined,
      }).expect(400);
      // 60-minute minimum applies to staff too
      const short = await api(cal, 'post', `/v1/pitches/${f.pitchId}/bookings/external`, {
        ...ext,
        durationMinutes: 30,
      }).expect(400);
      expect(short.body.error.details.rule).toBe('DURATION_TOO_SHORT');

      const made = await api(cal, 'post', `/v1/pitches/${f.pitchId}/bookings/external`, ext).expect(
        201,
      );
      expect(made.body).toMatchObject({
        source: 'EXTERNAL',
        status: 'CONFIRMED',
        isExternal: true,
        externalName: 'Dinamo Old Boys',
        externalPhone: '+995000000000',
        staffNote: 'pays cash',
        bookedById: null,
      });
      expect(
        await t.prisma.user.count({
          where: { identities: { some: { subject: '+995000000000' } } },
        }),
      ).toBe(0);
      expect(
        await t.prisma.auditEvent.count({
          where: { action: 'booking.external.create', targetId: made.body.id },
        }),
      ).toBe(1);

      // it occupies the slot for clients …
      const clash = await book(booker, {
        pitchId: f.pitchId,
        configurationId: f.wholeId,
        startsAt: tb(d, '18:30'),
        durationMinutes: 60,
      }).expect(409);
      expect(clash.body.error.code).toBe('BOOKING_CONFLICT');
      // … and non-staff never see the name, phone or note anywhere
      const avail = await t
        .http()
        .get(`/v1/pitches/${f.pitchId}/availability?date=${d}`)
        .expect(200);
      const publicText = JSON.stringify(avail.body);
      expect(publicText).not.toMatch(/Dinamo|995000|pays cash/);
      await api(booker, 'get', `/v1/bookings/${made.body.id}`).expect(404);
      await api(
        booker,
        'get',
        `/v1/pitches/${f.pitchId}/calendar?from=${tb(d, '00:00')}&to=${tb(d, '00:00', 1)}`,
      ).expect(403);
      await api(booker, 'get', `/v1/pitches/${f.pitchId}/bookings/${made.body.id}`).expect(403);

      // staff calendar shows the flag and the staff-only details
      const calRes = await api(
        cal,
        'get',
        `/v1/pitches/${f.pitchId}/calendar?from=${encodeURIComponent(tb(d, '00:00'))}&to=${encodeURIComponent(tb(d, '00:00', 1))}`,
      ).expect(200);
      const entry = calRes.body.entries.find((e: { id: string }) => e.id === made.body.id);
      expect(entry).toMatchObject({
        kind: 'BOOKING',
        isExternal: true,
        title: 'Dinamo Old Boys',
        phone: '+995000000000',
        note: 'pays cash',
        status: 'CONFIRMED',
      });
      expect(entry.partIds).toHaveLength(f.partIds.length);

      // cancelling frees the time; deciders may not cancel externals
      await api(decider, 'post', `/v1/bookings/${made.body.id}/cancel`, {}).expect(403);
      await api(cal, 'post', `/v1/bookings/${made.body.id}/cancel`, {}).expect(200);
      await book(booker, {
        pitchId: f.pitchId,
        configurationId: f.wholeId,
        startsAt: tb(d, '18:30'),
        durationMinutes: 60,
      }).expect(201);
      // double-tap with a key creates one row
      const key = `ex-${uniq(12)}`;
      const ext2 = { ...ext, startsAt: tb(d, '12:00') };
      const send = () =>
        t
          .http()
          .post(`/v1/pitches/${f.pitchId}/bookings/external`)
          .set(cal.auth)
          .set('Idempotency-Key', key)
          .send(ext2);
      const [r1, r2] = await Promise.all([send(), send()]);
      expect(r1.body.id).toBe(r2.body.id);
    });

    it('blocks: 30 minutes allowed, occupy parts, conflict both ways, cancellable', async () => {
      const f = await createPitch(t, { quarters: true });
      const cal = await manager(f, 'pitch.calendar.manage');
      const booker = await createUser(t);
      const d = futureDate(20);
      const block = await api(cal, 'post', `/v1/pitches/${f.pitchId}/blocks`, {
        configurationId: f.configs['Half A'],
        startsAt: tb(d, '18:00'),
        durationMinutes: 30,
        reason: 'Grass repair',
      }).expect(201);
      expect(block.body.partIds).toHaveLength(2);
      await api(cal, 'post', `/v1/pitches/${f.pitchId}/blocks`, {
        startsAt: tb(d, '18:10'),
        durationMinutes: 30,
      }).expect(400);
      await api(cal, 'post', `/v1/pitches/${f.pitchId}/blocks`, {
        startsAt: tb(d, '18:00'),
        durationMinutes: 45,
      }).expect(400);
      await api(booker, 'post', `/v1/pitches/${f.pitchId}/blocks`, {
        startsAt: tb(d, '19:00'),
        durationMinutes: 30,
      }).expect(403);

      const req = (cfg: string, h: string) =>
        book(booker, {
          pitchId: f.pitchId,
          configurationId: f.configs[cfg] as string,
          startsAt: tb(d, h),
          durationMinutes: 60,
        });
      await req('Whole pitch', '18:00').expect(409);
      await req('Q2', '17:30').expect(409); // 17:30 is on the grid, overlaps the block by 30 min
      await req('Half B', '18:00').expect(201);
      // a block over an existing booking fails too
      await api(cal, 'post', `/v1/pitches/${f.pitchId}/blocks`, {
        configurationId: f.configs['Q3'],
        startsAt: tb(d, '18:30'),
        durationMinutes: 30,
      }).expect(409);

      const cancelled = await api(
        cal,
        'delete',
        `/v1/pitches/${f.pitchId}/blocks/${block.body.id}`,
      ).expect(200);
      expect(cancelled.body.cancelledAt).toEqual(expect.any(String));
      await req('Half A', '18:00').expect(201);
      expect(
        await t.prisma.auditEvent.count({
          where: { action: 'calendar.block.create', targetId: f.pitchId },
        }),
      ).toBe(1);
      expect(
        await t.prisma.auditEvent.count({
          where: { action: 'calendar.block.cancel', targetId: f.pitchId },
        }),
      ).toBe(1);
    });

    it('calendar range is bounded and pitch-scoped permissions do not leak to another pitch', async () => {
      const f1 = await createPitch(t);
      const f2 = await createPitch(t);
      const cal = await manager(f1, 'pitch.calendar.manage');
      const d = futureDate(21);
      const q = `from=${encodeURIComponent(tb(d, '00:00'))}&to=${encodeURIComponent(tb(d, '00:00', 1))}`;
      await api(cal, 'get', `/v1/pitches/${f1.pitchId}/calendar?${q}`).expect(200);
      await api(cal, 'get', `/v1/pitches/${f2.pitchId}/calendar?${q}`).expect(403);
      await api(cal, 'post', `/v1/pitches/${f2.pitchId}/blocks`, {
        startsAt: tb(d, '18:00'),
        durationMinutes: 30,
      }).expect(403);
      await api(
        cal,
        'get',
        `/v1/pitches/${f1.pitchId}/calendar?from=${encodeURIComponent(tb(d, '00:00'))}&to=${encodeURIComponent(tb(futureDate(200), '00:00'))}`,
      ).expect(400);
    });
  });
});
