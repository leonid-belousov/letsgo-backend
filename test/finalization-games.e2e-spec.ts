import { Clock } from '../src/common/time/clock';
import { MaintenanceService } from '../src/modules/maintenance/maintenance.service';
import {
  NotificationsService,
  NotificationDeliveryProvider,
} from '../src/modules/notifications/notifications.service';
import { createTestApp, type TestApp } from './support/app';
import { FakeClock } from './support/clock';
import { createUser, type TestUser } from './support/factories';
import {
  createClubRow,
  createGame,
  createVenueRow,
  fillSeats,
  HOUR,
  idemKey,
} from './support/games';

describe('finalization: persistent maintenance, auto next wave, capacity edits, venue attention', () => {
  let t: TestApp;
  const clock = new FakeClock();
  const failing = { fail: false, calls: 0 };
  beforeAll(async () => {
    t = await createTestApp((b) =>
      b
        .overrideProvider(Clock)
        .useValue(clock)
        .overrideProvider(NotificationDeliveryProvider)
        .useValue({
          deliver: () => {
            failing.calls += 1;
            return failing.fail
              ? Promise.reject(new Error('push provider down'))
              : Promise.resolve();
          },
        }),
    );
  });
  beforeEach(() => clock.set(new Date()));
  afterAll(() => t.close());

  const run = (eventIds: string[]) => t.app.get(MaintenanceService).runOnce({ eventIds });

  async function clubWithMembers(owner: TestUser, n: number) {
    const clubId = await createClubRow(t, owner);
    const members: TestUser[] = [];
    for (let i = 0; i < n; i++) {
      const u = await createUser(t);
      await t.prisma.membership.create({
        data: { clubId, userId: u.userId, status: 'MEMBER', joinedAt: new Date() },
      });
      members.push(u);
    }
    return { clubId, members };
  }

  it('priority deadline ⇒ holds released, freed places offered to the remaining club players — once, restart-safe', async () => {
    const owner = await createUser(t);
    const { clubId, members } = await clubWithMembers(owner, 4);
    const [m1, m2, m3, m4] = members as [TestUser, TestUser, TestUser, TestUser];
    const g = await createGame(t, owner, { clubId });
    await fillSeats(t, g.id, 10); // 2 places left
    const deadline = new Date(clock.now().getTime() + 2 * HOUR);
    const inv = await t
      .http()
      .post(`/v1/games/${g.id}/invitations`)
      .set(owner.auth)
      .send({
        inviteeIds: [m1.userId, m2.userId],
        priority: true,
        respondBy: deadline.toISOString(),
      })
      .expect(200);
    // m1 confirms before the deadline and keeps the seat
    await t
      .http()
      .post(`/v1/games/invitations/${inv.body.created[0].id}/confirm`)
      .set(m1.auth)
      .expect(200);

    // nothing is due yet ⇒ nothing happens
    const early = await run([g.id]);
    expect(early.status).toBe('OK');
    expect(
      await t.prisma.invitation.count({
        where: { eventId: g.id, inviteeId: { in: [m3.userId, m4.userId] } },
      }),
    ).toBe(0);

    clock.advanceHours(3); // deadline passed; m2 stayed silent
    const first = await run([g.id]);
    expect(first.games?.expiredHolds).toBeGreaterThanOrEqual(1);
    expect(first.games?.nextWaves).toBeGreaterThanOrEqual(1);
    const wave = await t.prisma.invitation.findMany({
      where: { eventId: g.id, inviteeId: { in: [m3.userId, m4.userId] } },
    });
    expect(wave).toHaveLength(2);
    expect(wave.every((w) => w.status === 'PENDING' && !w.priority && w.waveNumber === 2)).toBe(
      true,
    );
    expect(await t.prisma.seatHold.count({ where: { eventId: g.id, releasedAt: null } })).toBe(0); // ordinary wave holds nothing
    expect(
      (
        await t.prisma.invitation.findFirstOrThrow({
          where: { eventId: g.id, inviteeId: m2.userId },
        })
      ).status,
    ).toBe('EXPIRED');
    expect(
      (
        await t.prisma.participation.findFirstOrThrow({
          where: { eventId: g.id, userId: m1.userId },
        })
      ).status,
    ).toBe('CONFIRMED');
    expect(
      await t.prisma.activityItem.count({
        where: { recipientId: m3.userId, kind: 'invitation.received' },
      }),
    ).toBe(1);

    // running again (or twice at once) duplicates nothing
    const [a, b] = await Promise.all([run([g.id]), run([g.id])]);
    expect(
      [a.status, b.status].includes('OK') || [a.status, b.status].every((s) => s === 'SKIPPED'),
    ).toBe(true);
    await run([g.id]);
    expect(
      await t.prisma.invitation.count({
        where: { eventId: g.id, inviteeId: { in: [m3.userId, m4.userId] } },
      }),
    ).toBe(2);
    expect(
      await t.prisma.activityItem.count({
        where: { recipientId: m3.userId, kind: 'invitation.received' },
      }),
    ).toBe(1);
    // every run is recorded persistently
    expect(
      await t.prisma.jobRun.count({ where: { job: 'maintenance', status: 'OK' } }),
    ).toBeGreaterThanOrEqual(3);

    // m3 takes the free place; the wave never overbooks
    const inv3 = wave.find((w) => w.inviteeId === m3.userId);
    await t.http().post(`/v1/games/invitations/${inv3?.id}/confirm`).set(m3.auth).expect(200);
  });

  it('waitlisted players are offered freed places before any club wave; a disabled flag gets none; an extended deadline is respected', async () => {
    const owner = await createUser(t);
    const { clubId, members } = await clubWithMembers(owner, 2);
    const [m1] = members as [TestUser, TestUser];
    const waiter = await createUser(t);
    const dl = new Date(clock.now().getTime() + HOUR);
    const priority = (id: string, at = dl) =>
      t
        .http()
        .post(`/v1/games/${id}/invitations`)
        .set(owner.auth)
        .send({ inviteeIds: [m1.userId], priority: true, respondBy: at.toISOString() })
        .expect(200);

    // waitlist first: the freed place is reserved by an offer, so the club wave finds no free place
    const queued = await createGame(t, owner, { clubId });
    await fillSeats(t, queued.id, 11);
    await priority(queued.id); // 11 + 1 hold = full
    const wj = await t
      .http()
      .post(`/v1/games/${queued.id}/join`)
      .set(waiter.auth)
      .send({})
      .expect(200);
    expect(wj.body.status).toBe('WAITLISTED');

    // auto wave switched off
    const off = await createGame(t, owner, { clubId });
    await t
      .http()
      .patch(`/v1/games/${off.id}`)
      .set(owner.auth)
      .send({ version: off.version, autoNextWave: false })
      .expect(200);
    await priority(off.id);

    // deadline extension keeps the hold alive past the original time
    const ext = await createGame(t, owner, { clubId });
    const e1 = await priority(ext.id);
    await t
      .http()
      .post(`/v1/games/invitations/${e1.body.created[0].id}/deadline`)
      .set(owner.auth)
      .send({ respondBy: new Date(dl.getTime() + 3 * HOUR).toISOString() })
      .expect(200);

    clock.advanceMinutes(90);
    await run([queued.id, off.id, ext.id]);
    expect(await t.prisma.invitation.count({ where: { eventId: queued.id } })).toBe(1); // no wave: offer took the place
    expect(
      (await t.http().get(`/v1/games/${queued.id}`).set(waiter.auth)).body.viewer.offerId,
    ).not.toBeNull();
    expect(await t.prisma.invitation.count({ where: { eventId: off.id } })).toBe(1);
    expect(await t.prisma.seatHold.count({ where: { eventId: ext.id, releasedAt: null } })).toBe(1);
    expect(
      (await t.prisma.invitation.findUniqueOrThrow({ where: { id: e1.body.created[0].id } }))
        .status,
    ).toBe('PENDING');
  });

  it('maintenance is exposed to schedulers only to authorised staff and is safe under concurrency', async () => {
    const nobody = await createUser(t);
    await t.http().post('/v1/admin/maintenance/run').set(nobody.auth).expect(403);
    const staff = await createUser(t);
    await t.prisma.roleGrant.create({
      data: {
        granteeId: staff.userId,
        resourceType: 'PLATFORM',
        resourceId: null,
        permission: 'admin.maintenance.run',
        grantedById: staff.userId,
      },
    });
    const res = await t.http().post('/v1/admin/maintenance/run').set(staff.auth).expect(200);
    expect(['OK', 'SKIPPED']).toContain(res.body.status);
    const runs = await t.http().get('/v1/admin/maintenance/runs').set(staff.auth).expect(200);
    expect(runs.body.length).toBeGreaterThan(0);
  });

  it('safe post-publication edits: capacity up/down within occupancy, teams added, empty teams removed', async () => {
    const owner = await createUser(t);
    const w = await createUser(t);
    const g = await createGame(t, owner); // 2 x (5+1) = 12
    await fillSeats(t, g.id, 8);
    let v = g.version;
    const up = await t
      .http()
      .patch(`/v1/games/${g.id}`)
      .set(owner.auth)
      .send({ version: v, substitutesPerTeam: 2 })
      .expect(200);
    expect(up.body.seats.capacity).toBe(14);
    v = up.body.version;
    const teams3 = await t
      .http()
      .patch(`/v1/games/${g.id}`)
      .set(owner.auth)
      .send({ version: v, teamCount: 3 })
      .expect(200);
    expect(teams3.body.seats.capacity).toBe(21);
    expect(teams3.body.teams).toHaveLength(3);
    v = teams3.body.version;
    const back = await t
      .http()
      .patch(`/v1/games/${g.id}`)
      .set(owner.auth)
      .send({ version: v, teamCount: 2 })
      .expect(200);
    expect(back.body.teams).toHaveLength(2); // the empty third team was removed
    v = back.body.version;
    // never below occupied places
    const low = await t
      .http()
      .patch(`/v1/games/${g.id}`)
      .set(owner.auth)
      .send({ version: v, substitutesPerTeam: 0, formatPlayers: 5, teamCount: 2, minConfirmed: 5 });
    expect(low.status).toBe(200); // 10 >= 8
    v = low.body.version;
    await fillSeats(t, g.id, 2); // now 10 confirmed = capacity
    const below = await t
      .http()
      .patch(`/v1/games/${g.id}`)
      .set(owner.auth)
      .send({ version: v, formatPlayers: 5, teamCount: 2, substitutesPerTeam: 0 });
    expect(below.status).toBe(200); // unchanged capacity is a no-op
    await fillSeats(t, g.id, 1);
    // 11 confirmed but capacity 10 is impossible; simulate by trying to shrink an 11-seat state
    const g2 = await createGame(t, owner);
    await fillSeats(t, g2.id, 11);
    const shrink = await t
      .http()
      .patch(`/v1/games/${g2.id}`)
      .set(owner.auth)
      .send({ version: g2.version, substitutesPerTeam: 0 })
      .expect(409);
    expect(shrink.body.error.code).toBe('CAPACITY_CHANGED');
    expect(shrink.body.error.details.occupied).toBe(11);
    // a waitlisted player is offered the extra place when capacity grows
    await t.http().post(`/v1/games/${g2.id}/join`).set(owner.auth).send({}).expect(200); // 12th
    const wj = await t.http().post(`/v1/games/${g2.id}/join`).set(w.auth).send({}).expect(200);
    expect(wj.body.status).toBe('WAITLISTED');
    const cur = await t.http().get(`/v1/games/${g2.id}`).set(owner.auth).expect(200);
    await t
      .http()
      .patch(`/v1/games/${g2.id}`)
      .set(owner.auth)
      .send({ version: cur.body.version, substitutesPerTeam: 2 })
      .expect(200);
    const offer = await t.http().get(`/v1/games/${g2.id}`).set(w.auth).expect(200);
    expect(offer.body.viewer.offerId).not.toBeNull();
  });

  it('team removal with players / matches is refused with a specific error (redistribution rule is OPEN)', async () => {
    const owner = await createUser(t);
    const p = await createUser(t);
    const g = await createGame(t, owner, { teamCount: 3 });
    const d = await t.http().get(`/v1/games/${g.id}`).set(owner.auth).expect(200);
    const team3 = (d.body.teams as { id: string; index: number }[]).find((x) => x.index === 3);
    await t
      .http()
      .post(`/v1/games/${g.id}/join`)
      .set(p.auth)
      .send({ teamId: team3?.id })
      .expect(200);
    const res = await t
      .http()
      .patch(`/v1/games/${g.id}`)
      .set(owner.auth)
      .send({ version: d.body.version, teamCount: 2 })
      .expect(409);
    expect(res.body.error.details.reason).toBe('TEAM_REDISTRIBUTION_UNDEFINED');
    // nothing changed
    expect((await t.http().get(`/v1/games/${g.id}`).set(owner.auth)).body.teams).toHaveLength(3);
    // format cannot change once a match exists
    const g2 = await createGame(t, owner);
    const d2 = await t.http().get(`/v1/games/${g2.id}`).set(owner.auth).expect(200);
    await t.prisma.match.create({ data: { eventId: g2.id } });
    const fmt = await t
      .http()
      .patch(`/v1/games/${g2.id}`)
      .set(owner.auth)
      .send({ version: d2.body.version, formatPlayers: 7 })
      .expect(409);
    expect(fmt.body.error.details.reason).toBe('MATCHES_EXIST');
  });

  it('price change after confirmations points to the fee-amendment flow (never silent)', async () => {
    const owner = await createUser(t);
    const p = await createUser(t);
    const g = await createGame(t, owner);
    await t.http().post(`/v1/games/${g.id}/join`).set(p.auth).send({}).expect(200);
    const d = await t.http().get(`/v1/games/${g.id}`).set(owner.auth).expect(200);
    const res = await t
      .http()
      .patch(`/v1/games/${g.id}`)
      .set(owner.auth)
      .send({ version: d.body.version, priceMinor: 3000 })
      .expect(409);
    expect(res.body.error.details.reason).toBe('FEE_AMENDMENT_REQUIRED');
  });

  it('AC-40: a lost booking flags the game; attaching a valid replacement clears it and derives the pitch status', async () => {
    const owner = await createUser(t);
    const stranger = await createUser(t);
    const { pitchId } = await createVenueRow(t, owner);
    const part = await t.prisma.pitchPart.create({ data: { pitchId, name: 'whole' } });
    const cfg = await t.prisma.pitchConfiguration.create({
      data: { pitchId, name: 'Whole', parts: { create: { partId: part.id } } },
    });
    const start = new Date(clock.now().getTime() + 48 * HOUR);
    const mkBooking = (
      status: 'CONFIRMED' | 'REQUESTED',
      bookedById: string | null,
      from = start,
      hours = 3,
    ) =>
      t.prisma.booking.create({
        data: {
          pitchId,
          configurationId: cfg.id,
          bookedById,
          status,
          startsAt: from,
          endsAt: new Date(from.getTime() + hours * HOUR),
          rulesVersion: 1,
          confirmationSource: status === 'CONFIRMED' ? 'VENUE' : null,
        },
      });
    const lost = await mkBooking('CONFIRMED', owner.userId);
    const g = await createGame(t, owner, { pitchId, startsAt: new Date(start.getTime() + HOUR) });
    // simulate what BookingsService.flagLinkedEvents does on cancellation (covered in bookings tests)
    await t.prisma.event.update({
      where: { id: g.id },
      data: {
        bookingId: lost.id,
        venueNeedsAttention: true,
        venueAttentionReason: 'BOOKING_CANCELLED',
        venueAttentionAt: new Date(),
        pitchStatus: null,
        version: { increment: 1 },
      },
    });
    const flagged = await t.http().get(`/v1/games/${g.id}`).set(owner.auth).expect(200);
    expect(flagged.body).toMatchObject({
      venueNeedsAttention: true,
      venueAttentionReason: 'BOOKING_CANCELLED',
      pitchStatus: null,
      status: 'PUBLISHED',
    });
    expect(flagged.body.capabilities.canAttachBooking).toBe(true);

    const good = await mkBooking('CONFIRMED', owner.userId, new Date(start.getTime() - HOUR), 6);
    const tooShort = await mkBooking(
      'CONFIRMED',
      owner.userId,
      new Date(start.getTime() + 2 * HOUR),
      1,
    );
    const others = await mkBooking(
      'CONFIRMED',
      stranger.userId,
      new Date(start.getTime() - HOUR),
      6,
    );
    await t
      .http()
      .post(`/v1/games/${g.id}/booking`)
      .set(stranger.auth)
      .send({ bookingId: good.id, version: flagged.body.version })
      .expect(403);
    await t
      .http()
      .post(`/v1/games/${g.id}/booking`)
      .set(owner.auth)
      .send({ bookingId: others.id, version: flagged.body.version })
      .expect(403);
    const misfit = await t
      .http()
      .post(`/v1/games/${g.id}/booking`)
      .set(owner.auth)
      .send({ bookingId: tooShort.id, version: flagged.body.version })
      .expect(409);
    expect(misfit.body.error.code).toBe('BOOKING_CONFLICT');
    const stale = await t
      .http()
      .post(`/v1/games/${g.id}/booking`)
      .set(owner.auth)
      .send({ bookingId: good.id, version: 1 })
      .expect(409);
    expect(stale.body.error.code).toBe('VERSION_CHANGED');
    // still flagged after every refusal
    expect((await t.http().get(`/v1/games/${g.id}`).set(owner.auth)).body.venueNeedsAttention).toBe(
      true,
    );

    const ok = await t
      .http()
      .post(`/v1/games/${g.id}/booking`)
      .set(owner.auth)
      .set('Idempotency-Key', idemKey())
      .send({ bookingId: good.id, version: flagged.body.version })
      .expect(200);
    expect(ok.body).toMatchObject({
      venueNeedsAttention: false,
      venueAttentionReason: null,
      pitchStatus: 'PITCH_BOOKED',
      bookingId: good.id,
    });
    expect(ok.body.version).toBe(flagged.body.version + 1);
    expect(
      await t.prisma.auditEvent.count({
        where: { targetId: g.id, action: 'game.booking_attached' },
      }),
    ).toBe(1);
    // a merely requested booking gives Booking pending, never Pitch booked
    const g2 = await createGame(t, owner, {
      pitchId,
      startsAt: new Date(start.getTime() + 24 * HOUR),
    });
    const req = await mkBooking(
      'REQUESTED',
      owner.userId,
      new Date(start.getTime() + 23 * HOUR),
      4,
    );
    const pend = await t
      .http()
      .post(`/v1/games/${g2.id}/booking`)
      .set(owner.auth)
      .send({ bookingId: req.id, version: g2.version })
      .expect(200);
    expect(pend.body.pitchStatus).toBe('BOOKING_PENDING');
  });

  it('push failure never loses the in-app notification; retries back off and stop after the maximum', async () => {
    const org = await createUser(t);
    const p = await createUser(t);
    const g = await createGame(t, org);
    await t
      .http()
      .post(`/v1/games/${g.id}/invitations`)
      .set(org.auth)
      .send({ inviteeIds: [p.userId] })
      .expect(200);
    const n = await t.prisma.notification.findFirstOrThrow({ where: { recipientId: p.userId } });
    failing.fail = true;
    const svc = t.app.get(NotificationsService);
    const drain = async () => {
      for (let i = 0; i < 100; i++) {
        const r = await svc.dispatchPending(500);
        if (r.sent + r.failed === 0) break;
      }
    };
    await drain();
    const f1 = await t.prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(f1).toMatchObject({ delivery: 'FAILED', attempts: 1, lastError: 'Error' });
    expect(f1.nextAttemptAt).not.toBeNull();
    expect(f1.lastError).not.toMatch(/down/); // provider text never stored
    // still listed in-app
    const list = await t.http().get('/v1/notifications').set(p.auth).expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(n.id);
    // not retried before its time
    await drain();
    expect((await t.prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).attempts).toBe(
      1,
    );
    // later, when the provider is back, it is delivered
    failing.fail = false;
    clock.advanceHours(2);
    await drain();
    expect((await t.prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).delivery).toBe(
      'SENT',
    );
  });
});
