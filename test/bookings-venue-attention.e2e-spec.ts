import { Clock } from '../src/common/time/clock';
import { BookingsService } from '../src/modules/bookings/bookings.service';
import { createPitch, futureDate, grantVia, tb } from './bookings.support';
import { createTestApp, type TestApp } from './support/app';
import { FakeClock } from './support/clock';
import { createUser, type TestUser } from './support/factories';

describe('bookings → linked games: venue needs attention (real PostgreSQL)', () => {
  let t: TestApp;
  const clock = new FakeClock();
  beforeAll(async () => {
    t = await createTestApp((b) => b.overrideProvider(Clock).useValue(clock));
  });
  beforeEach(() => clock.set(new Date()));
  afterAll(() => t.close());

  interface Setup {
    organiser: TestUser;
    player: TestUser;
    mgr: TestUser;
    bookingId: string;
    eventId: string;
    pitchId: string;
  }

  /** Booking (REQUESTED) by the organiser + a published game linked to it + one confirmed player. */
  async function setup(day: number): Promise<Setup> {
    const f = await createPitch(t);
    const organiser = await createUser(t);
    const player = await createUser(t);
    const mgr = await createUser(t);
    await grantVia(t, f.admin, mgr, 'VENUE', f.venueId, 'pitch.bookings.decide').then((r) =>
      expect(r.status).toBe(201),
    );
    const d = futureDate(day);
    const b = await t
      .http()
      .post('/v1/bookings')
      .set(organiser.auth)
      .send({
        pitchId: f.pitchId,
        configurationId: f.wholeId,
        startsAt: tb(d, '18:00'),
        durationMinutes: 120,
      })
      .expect(201);
    const g = await linkedGame(organiser, b.body.id, d);
    await t.prisma.participation.create({
      data: {
        eventId: g,
        userId: player.userId,
        status: 'CONFIRMED',
        source: 'ORGANISER_ADDED',
        confirmedAt: new Date(),
      },
    });
    return { organiser, player, mgr, bookingId: b.body.id, eventId: g, pitchId: f.pitchId };
  }

  async function linkedGame(organiser: TestUser, bookingId: string, d: string): Promise<string> {
    const res = await t
      .http()
      .post('/v1/games')
      .set(organiser.auth)
      .send({
        kind: 'CASUAL',
        bookingId,
        timezone: 'Asia/Tbilisi',
        startsAt: tb(d, '18:00'),
        endsAt: tb(d, '20:00'),
        formatPlayers: 5,
        teamCount: 2,
        substitutesPerTeam: 1,
        priceMinor: 1500,
        joinMode: 'AUTO_ACCEPT',
        publish: true,
      })
      .expect(201);
    expect(res.body.pitchStatus).toBe('BOOKING_PENDING');
    return res.body.id as string;
  }

  const snapshot = async (eventId: string) => ({
    event: await t.prisma.event.findUniqueOrThrow({ where: { id: eventId } }),
    participations: await t.prisma.participation.count({ where: { eventId } }),
    conversations: await t.prisma.conversation.count({ where: { eventId } }),
    payments: await t.prisma.paymentObligation.count({ where: { eventId } }),
  });

  async function expectFlagged(
    s: Setup,
    reason: string,
    before: Awaited<ReturnType<typeof snapshot>>,
  ) {
    const after = await snapshot(s.eventId);
    expect(after.event).toMatchObject({
      venueNeedsAttention: true,
      venueAttentionReason: reason,
      pitchStatus: null,
      pitchStatusSource: null,
      bookingId: s.bookingId,
      status: before.event.status, // the game is NOT cancelled
    });
    expect(after.event.venueAttentionAt).toBeInstanceOf(Date);
    expect(after.event.version).toBe(before.event.version + 1);
    expect(after.participations).toBe(before.participations);
    expect(after.conversations).toBe(before.conversations);
    expect(after.payments).toBe(before.payments);
    expect(
      await t.prisma.auditEvent.count({
        where: { action: 'game.venue_attention', targetId: s.eventId },
      }),
    ).toBe(1);
    for (const u of [s.organiser, s.player]) {
      const n = await t.prisma.notification.findMany({
        where: { recipientId: u.userId, objectId: s.eventId, category: 'booking' },
      });
      expect(n).toHaveLength(1);
      expect(n[0]?.title).toBe('The venue of a game needs attention');
    }
    const items = await t.prisma.activityItem.findMany({
      where: { objectId: s.eventId, kind: 'game.venue_needs_attention' },
    });
    expect(items).toHaveLength(2);
    expect(JSON.stringify(items.map((i) => i.payload))).not.toMatch(/nickname|username|email/);
  }

  it('cancel by the booker flags the game once and keeps it alive; cancelling again does nothing', async () => {
    const s = await setup(30);
    const before = await snapshot(s.eventId);
    expect(before.event.status).toBe('PUBLISHED');
    await t
      .http()
      .post(`/v1/bookings/${s.bookingId}/cancel`)
      .set(s.organiser.auth)
      .send({})
      .expect(200);
    await expectFlagged(s, 'BOOKING_CANCELLED', before);
    // second cancel is a state error and flags nothing more
    await t
      .http()
      .post(`/v1/bookings/${s.bookingId}/cancel`)
      .set(s.organiser.auth)
      .send({})
      .expect(409);
    expect(
      await t.prisma.auditEvent.count({
        where: { action: 'game.venue_attention', targetId: s.eventId },
      }),
    ).toBe(1);
    expect((await snapshot(s.eventId)).event.version).toBe(before.event.version + 1);
  });

  it('reject by staff flags the game with BOOKING_REJECTED', async () => {
    const s = await setup(31);
    const before = await snapshot(s.eventId);
    await t
      .http()
      .post(`/v1/bookings/${s.bookingId}/reject`)
      .set(s.mgr.auth)
      .send({ reason: 'closed' })
      .expect(200);
    await expectFlagged(s, 'BOOKING_REJECTED', before);
  });

  it('hold expiry (FakeClock) flags the game — lazily on read and via expireHolds', async () => {
    const s = await setup(32);
    await t
      .http()
      .post(`/v1/bookings/${s.bookingId}/hold`)
      .set(s.mgr.auth)
      .send({ holdMinutes: 30 })
      .expect(200);
    const before = await snapshot(s.eventId);
    expect(before.event.venueNeedsAttention).toBe(false);
    clock.advanceMinutes(31);
    const read = await t
      .http()
      .get(`/v1/bookings/${s.bookingId}`)
      .set(s.organiser.auth)
      .expect(200);
    expect(read.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'HOLD_EXPIRED' });
    await expectFlagged(s, 'BOOKING_EXPIRED', before);

    // scheduler path
    const s2 = await setup(33);
    await t
      .http()
      .post(`/v1/bookings/${s2.bookingId}/hold`)
      .set(s2.mgr.auth)
      .send({ holdMinutes: 15 })
      .expect(200);
    const before2 = await snapshot(s2.eventId);
    clock.advanceMinutes(16);
    const svc = t.app.get(BookingsService);
    expect(await svc.expireHolds(clock.now())).toBeGreaterThanOrEqual(1);
    await expectFlagged(s2, 'BOOKING_EXPIRED', before2);
    // a second run must not flag this game again (other suites' holds may be swept meanwhile, so no global count)
    await svc.expireHolds(clock.now());
    expect(
      await t.prisma.auditEvent.count({
        where: { action: 'game.venue_attention', targetId: s2.eventId },
      }),
    ).toBe(1);
  });

  it('finished / cancelled games are not flagged; only games linked to that booking are', async () => {
    const s = await setup(34);
    const d = futureDate(34);
    const finished = await linkedGame(s.organiser, s.bookingId, d);
    await t.prisma.event.update({ where: { id: finished }, data: { status: 'CANCELLED' } });
    const other = await setup(35);
    await t
      .http()
      .post(`/v1/bookings/${s.bookingId}/cancel`)
      .set(s.organiser.auth)
      .send({})
      .expect(200);
    expect((await snapshot(s.eventId)).event.venueNeedsAttention).toBe(true);
    expect((await snapshot(finished)).event.venueNeedsAttention).toBe(false);
    expect((await snapshot(other.eventId)).event.venueNeedsAttention).toBe(false);
  });

  it('confirming: an unflagged game shows Pitch booked from the real confirmation; a flagged one keeps its flag', async () => {
    const s = await setup(36);
    await t.http().post(`/v1/bookings/${s.bookingId}/confirm`).set(s.mgr.auth).expect(200);
    const ev = (await snapshot(s.eventId)).event;
    expect(ev).toMatchObject({
      pitchStatus: 'PITCH_BOOKED',
      pitchStatusSource: 'VENUE',
      venueNeedsAttention: false,
    });

    const flagged = await setup(37);
    await t.prisma.event.update({
      where: { id: flagged.eventId },
      data: {
        venueNeedsAttention: true,
        venueAttentionReason: 'BOOKING_EXPIRED',
        venueAttentionAt: new Date(),
      },
    });
    await t
      .http()
      .post(`/v1/bookings/${flagged.bookingId}/confirm`)
      .set(flagged.mgr.auth)
      .expect(200);
    const kept = (await snapshot(flagged.eventId)).event;
    expect(kept).toMatchObject({ venueNeedsAttention: true, pitchStatus: 'BOOKING_PENDING' });
  });

  it('a booking nobody links to releases as before', async () => {
    const f = await createPitch(t);
    const u = await createUser(t);
    const b = await t
      .http()
      .post('/v1/bookings')
      .set(u.auth)
      .send({
        pitchId: f.pitchId,
        configurationId: f.wholeId,
        startsAt: tb(futureDate(38), '18:00'),
        durationMinutes: 60,
      })
      .expect(201);
    const res = await t
      .http()
      .post(`/v1/bookings/${b.body.id}/cancel`)
      .set(u.auth)
      .send({})
      .expect(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(
      await t.prisma.auditEvent.count({
        where: {
          action: 'game.venue_attention',
          metadata: { path: ['bookingId'], equals: b.body.id },
        },
      }),
    ).toBe(0);
  });
});
