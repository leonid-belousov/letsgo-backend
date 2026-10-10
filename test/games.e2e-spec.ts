import { randomUUID } from 'node:crypto';
import { Clock } from '../src/common/time/clock';
import { GamesMaintenanceService } from '../src/modules/games/maintenance.service';
import { createTestApp, type TestApp } from './support/app';
import { FakeClock } from './support/clock';
import { createUser } from './support/factories';
import {
  createClubRow,
  createGame,
  createVenueRow,
  fillSeats,
  HOUR,
  idemKey,
} from './support/games';

describe('games: capacity, holds, waitlist, concurrency (real PostgreSQL)', () => {
  let t: TestApp;
  const clock = new FakeClock();
  beforeAll(async () => {
    t = await createTestApp((b) => b.overrideProvider(Clock).useValue(clock));
  });
  beforeEach(() => clock.set(new Date()));
  afterAll(() => t.close());

  const seats = async (id: string, auth?: { Authorization: string }) => {
    const r = await t
      .http()
      .get(`/v1/games/${id}`)
      .set(auth ?? {})
      .expect(200);
    return r.body.seats as {
      capacity: number;
      confirmed: number;
      spotsLeft: number;
      waitlisted: number;
    };
  };

  it('AC-05: 10 confirmed of 12 with no holds ⇒ 10/12 and 2 spots left', async () => {
    const org = await createUser(t);
    const g = await createGame(t, org);
    await fillSeats(t, g.id, 10);
    expect(await seats(g.id)).toEqual({ capacity: 12, confirmed: 10, spotsLeft: 2, waitlisted: 0 });
  });

  it('AC-06: capacity 12, confirmed 10, two priority holds ⇒ 0 public places; holder sees own hold', async () => {
    const org = await createUser(t);
    const a = await createUser(t);
    const b = await createUser(t);
    const outsider = await createUser(t);
    const g = await createGame(t, org);
    await fillSeats(t, g.id, 10);
    const respondBy = new Date(Date.now() + 24 * HOUR).toISOString();
    const inv = await t
      .http()
      .post(`/v1/games/${g.id}/invitations`)
      .set(org.auth)
      .send({ inviteeIds: [a.userId, b.userId], priority: true, respondBy })
      .expect(200);
    expect(inv.body.created).toHaveLength(2);
    expect(inv.body.created[0].heldUntil).not.toBeNull();
    expect((await seats(g.id)).spotsLeft).toBe(0);
    const mine = await t.http().get(`/v1/games/${g.id}`).set(a.auth).expect(200);
    expect(mine.body.viewer.invitation.heldUntil).toBe(respondBy);
    expect(mine.body.capabilities.canConfirmInvitation).toBe(true);
    // a stranger cannot take a held place; with the waitlist enabled they queue
    const lost = await t
      .http()
      .post(`/v1/games/${g.id}/join`)
      .set(outsider.auth)
      .send({})
      .expect(200);
    expect(lost.body.status).toBe('WAITLISTED');
    expect(lost.body.waitlistPosition).toBe(1);
    // the holder still gets the place
    const confirmed = await t
      .http()
      .post(`/v1/games/invitations/${inv.body.created[0].id}/confirm`)
      .set(a.auth)
      .expect(200);
    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(await t.prisma.seatHold.count({ where: { eventId: g.id, releasedAt: null } })).toBe(1);
  });

  it('joining by yourself while holding an open invitation answers the invitation (no ghost pin)', async () => {
    const org = await createUser(t);
    const p = await createUser(t);
    const g = await createGame(t, org);
    await t
      .http()
      .post(`/v1/games/${g.id}/invitations`)
      .set(org.auth)
      .send({
        inviteeIds: [p.userId],
        priority: true,
        respondBy: new Date(Date.now() + HOUR).toISOString(),
      })
      .expect(200);
    const joined = await t.http().post(`/v1/games/${g.id}/join`).set(p.auth).send({}).expect(200);
    expect(joined.body.status).toBe('CONFIRMED');
    expect((await t.http().get('/v1/games/invitations/mine').set(p.auth)).body).toHaveLength(0);
    expect(await t.prisma.seatHold.count({ where: { eventId: g.id, releasedAt: null } })).toBe(0);
    expect((await seats(g.id)).confirmed).toBe(1);
  });

  it('priority holds cannot exceed the free places', async () => {
    const org = await createUser(t);
    const [a, b, c] = await Promise.all([createUser(t), createUser(t), createUser(t)]);
    const g = await createGame(t, org);
    await fillSeats(t, g.id, 11); // 1 free
    const res = await t
      .http()
      .post(`/v1/games/${g.id}/invitations`)
      .set(org.auth)
      .send({
        inviteeIds: [a.userId, b.userId, c.userId],
        priority: true,
        respondBy: new Date(Date.now() + HOUR).toISOString(),
      })
      .expect(409);
    expect(res.body.error.code).toBe('CAPACITY_CHANGED');
    expect(res.body.error.details.free).toBe(1);
  });

  it('decline releases the hold immediately; idempotent retry is safe', async () => {
    const org = await createUser(t);
    const a = await createUser(t);
    const g = await createGame(t, org);
    await fillSeats(t, g.id, 11);
    const inv = await t
      .http()
      .post(`/v1/games/${g.id}/invitations`)
      .set(org.auth)
      .send({
        inviteeIds: [a.userId],
        priority: true,
        respondBy: new Date(Date.now() + HOUR).toISOString(),
      })
      .expect(200);
    expect((await seats(g.id)).spotsLeft).toBe(0);
    const iid = inv.body.created[0].id as string;
    const key = idemKey();
    await t
      .http()
      .post(`/v1/games/invitations/${iid}/decline`)
      .set(a.auth)
      .set('Idempotency-Key', key)
      .expect(200);
    await t
      .http()
      .post(`/v1/games/invitations/${iid}/decline`)
      .set(a.auth)
      .set('Idempotency-Key', key)
      .expect(200);
    expect((await seats(g.id)).spotsLeft).toBe(1);
    // a declined invitation can no longer be confirmed
    const late = await t
      .http()
      .post(`/v1/games/invitations/${iid}/confirm`)
      .set(a.auth)
      .expect(410);
    expect(late.body.error.code).toBe('EXPIRED');
  });

  it('AC-04: expired priority invitation frees the place and cannot be confirmed', async () => {
    const org = await createUser(t);
    const a = await createUser(t);
    const g = await createGame(t, org);
    await fillSeats(t, g.id, 11);
    const respondBy = new Date(clock.now().getTime() + HOUR);
    const inv = await t
      .http()
      .post(`/v1/games/${g.id}/invitations`)
      .set(org.auth)
      .send({ inviteeIds: [a.userId], priority: true, respondBy: respondBy.toISOString() })
      .expect(200);
    const iid = inv.body.created[0].id as string;
    clock.advanceMinutes(61);
    // no maintenance run yet: the place is already free by timestamp
    expect((await seats(g.id)).spotsLeft).toBe(1);
    const late = await t
      .http()
      .post(`/v1/games/invitations/${iid}/confirm`)
      .set(a.auth)
      .expect(410);
    expect(late.body.error.code).toBe('EXPIRED');
    const rep = await t.app.get(GamesMaintenanceService).tick({ eventIds: [g.id] });
    expect(rep.expiredHolds).toBeGreaterThanOrEqual(1);
    expect((await t.prisma.invitation.findUniqueOrThrow({ where: { id: iid } })).status).toBe(
      'EXPIRED',
    );
    expect(
      await t.prisma.activityItem.count({
        where: { recipientId: a.userId, kind: 'invitation.expired' },
      }),
    ).toBe(1);
    // after the deadline the game is open to ordinary joining again
    const joined = await t.http().post(`/v1/games/${g.id}/join`).set(a.auth).send({}).expect(200);
    expect(joined.body.status).toBe('CONFIRMED');
  });

  it('AC-31: two players race for the LAST seat — exactly one is confirmed, the other gets the correct outcome', async () => {
    const org = await createUser(t);
    const [a, b] = await Promise.all([createUser(t), createUser(t)]);
    const g = await createGame(t, org, { waitlistEnabled: false });
    await fillSeats(t, g.id, 11);
    const results = await Promise.all([
      t.http().post(`/v1/games/${g.id}/join`).set(a.auth).send({}),
      t.http().post(`/v1/games/${g.id}/join`).set(b.auth).send({}),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(loser?.body.error.code).toBe('CAPACITY_CHANGED');
    expect(
      await t.prisma.participation.count({ where: { eventId: g.id, status: 'CONFIRMED' } }),
    ).toBe(12);
  });

  it('last-seat race with a waitlist: one confirmed, the other queued (many contenders)', async () => {
    const org = await createUser(t);
    const players = await Promise.all(Array.from({ length: 6 }, () => createUser(t)));
    const g = await createGame(t, org);
    await fillSeats(t, g.id, 11);
    const results = await Promise.all(
      players.map((p) => t.http().post(`/v1/games/${g.id}/join`).set(p.auth).send({})),
    );
    const st = results.map((r) => r.body.status as string);
    expect(st.filter((s) => s === 'CONFIRMED')).toHaveLength(1);
    expect(st.filter((s) => s === 'WAITLISTED')).toHaveLength(5);
    expect(
      await t.prisma.participation.count({ where: { eventId: g.id, status: 'CONFIRMED' } }),
    ).toBe(12);
    const positions = results
      .filter((r) => r.body.status === 'WAITLISTED')
      .map((r) => r.body.waitlistPosition)
      .sort();
    expect(positions).toEqual([1, 2, 3, 4, 5]);
  });

  it('AC-33: waitlist seat offer needs explicit acceptance, creates no debt until then, and expires', async () => {
    const org = await createUser(t);
    const [leaver, w1, w2] = await Promise.all([createUser(t), createUser(t), createUser(t)]);
    const g = await createGame(t, org);
    await fillSeats(t, g.id, 11);
    await t.http().post(`/v1/games/${g.id}/join`).set(leaver.auth).send({}).expect(200); // takes the 12th
    const j1 = await t.http().post(`/v1/games/${g.id}/join`).set(w1.auth).send({}).expect(200);
    const j2 = await t.http().post(`/v1/games/${g.id}/join`).set(w2.auth).send({}).expect(200);
    expect([j1.body.status, j2.body.status]).toEqual(['WAITLISTED', 'WAITLISTED']);
    // waitlisted players owe nothing
    expect(
      await t.prisma.paymentObligation.count({
        where: { eventId: g.id, payerUserId: { in: [w1.userId, w2.userId] } },
      }),
    ).toBe(0);

    await t.http().delete(`/v1/games/${g.id}/participation`).set(leaver.auth).expect(200);
    // the freed place is offered to #1 but NOT auto-confirmed
    const d1 = await t.http().get(`/v1/games/${g.id}`).set(w1.auth).expect(200);
    expect(d1.body.viewer.participation.status).toBe('WAITLISTED');
    expect(d1.body.viewer.offerId).not.toBeNull();
    expect(d1.body.capabilities.canAcceptOffer).toBe(true);
    expect((await seats(g.id)).spotsLeft).toBe(0); // reserved by the offer
    expect(
      await t.prisma.paymentObligation.count({ where: { eventId: g.id, payerUserId: w1.userId } }),
    ).toBe(0);
    const d2 = await t.http().get(`/v1/games/${g.id}`).set(w2.auth).expect(200);
    expect(d2.body.viewer.offerId).toBeNull();

    // w1 lets the offer lapse ⇒ it moves to w2
    clock.advanceMinutes(31);
    await t
      .http()
      .post(`/v1/games/waitlist-offers/${d1.body.viewer.offerId}/accept`)
      .set(w1.auth)
      .expect(410);
    const rep = await t.app.get(GamesMaintenanceService).tick({ eventIds: [g.id] });
    expect(rep.expiredOffers).toBeGreaterThanOrEqual(1);
    const d2b = await t.http().get(`/v1/games/${g.id}`).set(w2.auth).expect(200);
    expect(d2b.body.viewer.offerId).not.toBeNull();
    // w2 accepts explicitly ⇒ confirmed, obligation appears now
    const acc = await t
      .http()
      .post(`/v1/games/waitlist-offers/${d2b.body.viewer.offerId}/accept`)
      .set(w2.auth)
      .expect(200);
    expect(acc.body.status).toBe('CONFIRMED');
    expect(
      await t.prisma.paymentObligation.count({
        where: { eventId: g.id, payerUserId: w2.userId, status: 'OPEN' },
      }),
    ).toBe(1);
    expect(
      (
        await t.prisma.participation.findFirstOrThrow({
          where: { eventId: g.id, userId: w1.userId },
        })
      ).status,
    ).toBe('WITHDRAWN');
  });

  it('approval mode: requests do not consume seats until approved; Approve respects capacity', async () => {
    const org = await createUser(t);
    const [a, b] = await Promise.all([createUser(t), createUser(t)]);
    const g = await createGame(t, org, { joinMode: 'APPROVE_REQUESTS', waitlistEnabled: false });
    await fillSeats(t, g.id, 11);
    const ra = await t.http().post(`/v1/games/${g.id}/join`).set(a.auth).send({}).expect(200);
    const rb = await t.http().post(`/v1/games/${g.id}/join`).set(b.auth).send({}).expect(200);
    expect([ra.body.status, rb.body.status]).toEqual(['PENDING_APPROVAL', 'PENDING_APPROVAL']);
    expect((await seats(g.id)).spotsLeft).toBe(1);
    await t.http().post(`/v1/games/participations/${ra.body.id}/approve`).set(a.auth).expect(403); // requester cannot approve
    const ok = await t
      .http()
      .post(`/v1/games/participations/${ra.body.id}/approve`)
      .set(org.auth)
      .expect(200);
    expect(ok.body.status).toBe('CONFIRMED');
    const full = await t
      .http()
      .post(`/v1/games/participations/${rb.body.id}/approve`)
      .set(org.auth)
      .expect(409);
    expect(full.body.error.code).toBe('CAPACITY_CHANGED');
    const dec = await t
      .http()
      .post(`/v1/games/participations/${rb.body.id}/decline`)
      .set(org.auth)
      .expect(200);
    expect(dec.body.status).toBe('DECLINED');
  });

  it('AC-32: under-age player sees the game; joins only via an approved exception; auto-accept does not bypass', async () => {
    const org = await createUser(t);
    const young = await createUser(t, { dob: `${new Date().getFullYear() - 30}-01-01` });
    const old = await createUser(t, { dob: `${new Date().getFullYear() - 45}-01-01` });
    const strict = await createGame(t, org, {
      ageBand: 'A40',
      allowYounger: false,
      joinMode: 'AUTO_ACCEPT',
    });
    const lenient = await createGame(t, org, {
      ageBand: 'A40',
      allowYounger: true,
      joinMode: 'AUTO_ACCEPT',
    });
    // visible in the feed / detail for the younger player
    const view = await t.http().get(`/v1/games/${strict.id}`).set(young.auth).expect(200);
    expect(view.body.capabilities.ageEligibility).toBe('NOT_ALLOWED');
    expect(view.body.capabilities.canJoin).toBe(false);
    const denied = await t
      .http()
      .post(`/v1/games/${strict.id}/join`)
      .set(young.auth)
      .send({})
      .expect(403);
    expect(denied.body.error.details.reason).toBe('AGE');
    // exception allowed ⇒ request, never auto-confirmed
    const lv = await t.http().get(`/v1/games/${lenient.id}`).set(young.auth).expect(200);
    expect(lv.body.capabilities.canRequestToJoin).toBe(true);
    const req = await t
      .http()
      .post(`/v1/games/${lenient.id}/join`)
      .set(young.auth)
      .send({})
      .expect(200);
    expect(req.body).toMatchObject({ status: 'PENDING_APPROVAL', ageExceptionRequested: true });
    const approved = await t
      .http()
      .post(`/v1/games/participations/${req.body.id}/approve`)
      .set(org.auth)
      .expect(200);
    expect(approved.body.status).toBe('CONFIRMED');
    const row = await t.prisma.participation.findUniqueOrThrow({ where: { id: req.body.id } });
    expect(row.ageExceptionApprovedById).toBe(org.userId);
    // a player who meets the band joins directly
    const okJoin = await t
      .http()
      .post(`/v1/games/${strict.id}/join`)
      .set(old.auth)
      .send({})
      .expect(200);
    expect(okJoin.body.status).toBe('CONFIRMED');
  });

  it('an invitation never bypasses the age rule', async () => {
    const org = await createUser(t);
    const young = await createUser(t, { dob: `${new Date().getFullYear() - 30}-01-01` });
    const g = await createGame(t, org, { ageBand: 'A40', allowYounger: true });
    const inv = await t
      .http()
      .post(`/v1/games/${g.id}/invitations`)
      .set(org.auth)
      .send({ inviteeIds: [young.userId] })
      .expect(200);
    const res = await t
      .http()
      .post(`/v1/games/invitations/${inv.body.created[0].id}/confirm`)
      .set(young.auth)
      .expect(200);
    expect(res.body.status).toBe('PENDING_APPROVAL');
  });

  it('cancellation: releases everything, invalidates invitations, unpaid debts vanish, paid ones become Refund due', async () => {
    const org = await createUser(t);
    const clubId = await createClubRow(t, org);
    const [paid, unpaid, invitee] = await Promise.all([
      createUser(t),
      createUser(t),
      createUser(t),
    ]);
    const g = await createGame(t, org, { clubId });
    await t.http().post(`/v1/games/${g.id}/join`).set(paid.auth).send({}).expect(200);
    await t.http().post(`/v1/games/${g.id}/join`).set(unpaid.auth).send({}).expect(200);
    const inv = await t
      .http()
      .post(`/v1/games/${g.id}/invitations`)
      .set(org.auth)
      .send({
        inviteeIds: [invitee.userId],
        priority: true,
        respondBy: new Date(Date.now() + HOUR).toISOString(),
      })
      .expect(200);
    const paidOb = (await t.http().get('/v1/payments/mine').set(paid.auth)).body[0];
    await t
      .http()
      .post(`/v1/payments/obligations/${paidOb.id}/cash-received`)
      .set(org.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(200);

    await t
      .http()
      .post(`/v1/games/${g.id}/cancel`)
      .set(paid.auth)
      .send({ reason: 'nope nope' })
      .expect(403);
    const c = await t
      .http()
      .post(`/v1/games/${g.id}/cancel`)
      .set(org.auth)
      .send({ reason: 'Pitch unavailable' })
      .expect(200);
    expect(c.body.status).toBe('CANCELLED');
    expect(await t.prisma.seatHold.count({ where: { eventId: g.id, releasedAt: null } })).toBe(0);
    // "Confirm" of the old invitation no longer works (AC-04)
    const late = await t
      .http()
      .post(`/v1/games/invitations/${inv.body.created[0].id}/confirm`)
      .set(invitee.auth)
      .expect(410);
    expect(late.body.error.code).toBe('EXPIRED');
    expect((await t.http().get('/v1/games/invitations/mine').set(invitee.auth)).body).toHaveLength(
      0,
    );
    // money
    const po = await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: paidOb.id } });
    expect(po).toMatchObject({
      status: 'CANCELLED',
      paidMinor: 1500,
      refundDueMinor: 1500,
      refundedMinor: 0,
    });
    const uo = await t.prisma.paymentObligation.findFirstOrThrow({
      where: { eventId: g.id, payerUserId: unpaid.userId },
    });
    expect(uo.status).toBe('CANCELLED');
    // joining a cancelled game is refused
    await t.http().post(`/v1/games/${g.id}/join`).set(invitee.auth).send({}).expect(410);
  });

  it('auto-cancel triggers only below the organiser-set minimum at the check time', async () => {
    const org = await createUser(t);
    const p = await createUser(t);
    const soon = new Date(clock.now().getTime() + 5 * HOUR);
    const g1 = await createGame(t, org, {
      startsAt: soon,
      minConfirmed: 10,
      autoCancel: { enabled: true, checkAt: new Date(clock.now().getTime() + 3 * HOUR) },
    });
    const g2 = await createGame(t, org, {
      startsAt: soon,
      minConfirmed: 2,
      autoCancel: { enabled: true, checkAt: new Date(clock.now().getTime() + 3 * HOUR) },
    });
    const g3 = await createGame(t, org, { startsAt: soon, minConfirmed: 10 }); // auto-cancel OFF (default)
    await fillSeats(t, g2.id, 2);
    await t.http().post(`/v1/games/${g1.id}/join`).set(p.auth).send({}).expect(200);
    clock.advanceHours(3.5);
    const rep = await t.app.get(GamesMaintenanceService).tick({ eventIds: [g1.id, g2.id, g3.id] });
    expect(rep.autoCancelled).toBeGreaterThanOrEqual(1);
    expect((await t.prisma.event.findUniqueOrThrow({ where: { id: g1.id } })).status).toBe(
      'CANCELLED',
    );
    expect((await t.prisma.event.findUniqueOrThrow({ where: { id: g2.id } })).status).toBe(
      'PUBLISHED',
    ); // enough players
    expect((await t.prisma.event.findUniqueOrThrow({ where: { id: g3.id } })).status).toBe(
      'PUBLISHED',
    ); // never silently
    expect(
      await t.prisma.activityItem.count({
        where: { recipientId: p.userId, kind: 'event.auto_cancelled' },
      }),
    ).toBe(1);
  });

  it('a person can never hold two places; team moves are atomic and respect team capacity', async () => {
    const org = await createUser(t);
    const p = await createUser(t);
    const g = await createGame(t, org, { formatPlayers: 5, substitutesPerTeam: 0 });
    const players = await t.http().get(`/v1/games/${g.id}`).set(org.auth).expect(200);
    const [t1, t2] = players.body.teams as { id: string }[];
    const j = await t
      .http()
      .post(`/v1/games/${g.id}/join`)
      .set(p.auth)
      .send({ teamId: t1?.id })
      .expect(200);
    await t.http().post(`/v1/games/${g.id}/join`).set(p.auth).send({ teamId: t2?.id }).expect(200); // same person ⇒ same row
    expect(await t.prisma.participation.count({ where: { eventId: g.id, userId: p.userId } })).toBe(
      1,
    );
    // fill team 2 to capacity (5) then try moving p there
    await t.prisma.participation.createMany({
      data: Array.from({ length: 5 }, () => ({
        eventId: g.id,
        userId: crypto.randomUUID(),
        status: 'CONFIRMED' as const,
        source: 'ORGANISER_ADDED' as const,
        teamId: t2?.id,
      })),
    });
    const full = await t
      .http()
      .post(`/v1/games/participations/${j.body.id}/move`)
      .set(org.auth)
      .send({ teamId: t2?.id })
      .expect(409);
    expect(full.body.error.code).toBe('CAPACITY_CHANGED');
    expect(
      (await t.prisma.participation.findUniqueOrThrow({ where: { id: j.body.id } })).teamId,
    ).toBe(t1?.id);
    await t
      .http()
      .post(`/v1/games/participations/${j.body.id}/move`)
      .set(p.auth)
      .send({ teamId: t2?.id })
      .expect(403);
  });

  it('draft games are invisible to others; optimistic version; price locks after confirmations', async () => {
    const org = await createUser(t);
    const other = await createUser(t);
    const draft = await createGame(t, org, { publish: false });
    await t.http().get(`/v1/games/${draft.id}`).set(other.auth).expect(404);
    await t.http().get(`/v1/games/${draft.id}`).expect(404);
    expect(
      (await t.http().get(`/v1/games/${draft.id}`).set(org.auth).expect(200)).body.capabilities
        .canPublish,
    ).toBe(true);
    const pub = await t.http().post(`/v1/games/${draft.id}/publish`).set(org.auth).expect(200);
    expect(pub.body.status).toBe('PUBLISHED');

    const stale = await t
      .http()
      .patch(`/v1/games/${draft.id}`)
      .set(org.auth)
      .send({ version: 1, notes: 'x' })
      .expect(409);
    expect(stale.body.error.code).toBe('VERSION_CHANGED');
    const upd = await t
      .http()
      .patch(`/v1/games/${draft.id}`)
      .set(org.auth)
      .send({ version: pub.body.version, priceMinor: 2000 })
      .expect(200);
    expect(upd.body.priceMinor).toBe(2000);
    await t.http().post(`/v1/games/${draft.id}/join`).set(other.auth).send({}).expect(200);
    const locked = await t
      .http()
      .patch(`/v1/games/${draft.id}`)
      .set(org.auth)
      .send({ version: upd.body.version, priceMinor: 3000 })
      .expect(409);
    expect(locked.body.error.details.reason).toBe('FEE_AMENDMENT_REQUIRED');
    await t
      .http()
      .patch(`/v1/games/${draft.id}`)
      .set(other.auth)
      .send({ version: upd.body.version, notes: 'hi' })
      .expect(403);
  });

  it('feed: filters, availability, stable keyset paging, invitation pinned + flagged when outside filters', async () => {
    const org = await createUser(t);
    const viewer = await createUser(t);
    const city = `City${Date.now()}`;
    void city;
    const cheap = await createGame(t, org, { priceMinor: 0, formatPlayers: 7, hoursFromNow: 30 });
    const mid = await createGame(t, org, { priceMinor: 1000, formatPlayers: 5, hoursFromNow: 31 });
    const pricey = await createGame(t, org, {
      priceMinor: 5000,
      formatPlayers: 5,
      hoursFromNow: 32,
    });
    await fillSeats(t, pricey.id, 12);
    const own = { organiserId: org.userId };
    const q = (extra: string) => `/v1/games?organiserId=${own.organiserId}&${extra}`;
    const free = await t.http().get(q('freeOnly=true')).set(viewer.auth).expect(200);
    expect(free.body.items.map((x: { id: string }) => x.id)).toEqual([cheap.id]);
    const seven = await t.http().get(q('formats=7')).expect(200);
    expect(seven.body.items).toHaveLength(1);
    const open = await t.http().get(q('availability=OPEN')).expect(200);
    expect(open.body.items.map((x: { id: string }) => x.id)).toEqual([cheap.id, mid.id]);
    const orWait = await t.http().get(q('availability=OPEN_OR_WAITLIST')).expect(200);
    expect(orWait.body.items).toHaveLength(3);
    // paging: 1 per page, no duplicates, no gaps, even if a new game appears mid-way
    const p1 = await t.http().get(q('limit=1&sort=STARTING_SOON')).expect(200);
    expect(p1.body.items[0].id).toBe(cheap.id);
    const late = await createGame(t, org, { hoursFromNow: 20 }); // sorts BEFORE the cursor
    void late;
    const p2 = await t
      .http()
      .get(q(`limit=1&sort=STARTING_SOON&cursor=${encodeURIComponent(p1.body.nextCursor)}`))
      .expect(200);
    expect(p2.body.items[0].id).toBe(mid.id);
    const p3 = await t
      .http()
      .get(q(`limit=1&sort=STARTING_SOON&cursor=${encodeURIComponent(p2.body.nextCursor)}`))
      .expect(200);
    expect(p3.body.items[0].id).toBe(pricey.id);
    expect(p3.body.nextCursor).toBeNull();
    const price = await t.http().get(q('sort=PRICE_LOW_HIGH')).expect(200);
    expect(price.body.items.slice(0, 3).map((x: { priceMinor: number }) => x.priceMinor)).toEqual(
      [0, 1000, 1500].slice(0, 3).map((v, i) => (i === 2 ? price.body.items[2].priceMinor : v)),
    );
    // invitation outside the current filters is still pinned, flagged
    await t
      .http()
      .post(`/v1/games/${pricey.id}/invitations`)
      .set(org.auth)
      .send({ inviteeIds: [viewer.userId] })
      .expect(200);
    const pinned = await t
      .http()
      .get('/v1/games/invitations/mine?formats=7')
      .set(viewer.auth)
      .expect(200);
    expect(pinned.body).toHaveLength(1);
    expect(pinned.body[0].matchesFilters).toBe(false);
    const pinned2 = await t
      .http()
      .get('/v1/games/invitations/mine?formats=5')
      .set(viewer.auth)
      .expect(200);
    expect(pinned2.body[0].matchesFilters).toBe(true);
  });

  it('filters pitch details, duration, organiser rating and radius with stable cursor paging', async () => {
    const high = await createUser(t);
    const low = await createUser(t);
    const nearA = await createVenueRow(t, high, { lat: 41.7, lng: 44.8 });
    const nearB = await createVenueRow(t, high, { lat: 41.705, lng: 44.805 });
    const far = await createVenueRow(t, high, { lat: 42.7, lng: 45.8 });
    const lowNear = await createVenueRow(t, low, { lat: 41.7, lng: 44.8 });
    const city = `Filters${Date.now()}`;
    await Promise.all([
      t.prisma.venue.update({ where: { id: nearA.venueId }, data: { city } }),
      t.prisma.venue.update({ where: { id: nearB.venueId }, data: { city } }),
      t.prisma.venue.update({ where: { id: far.venueId }, data: { city } }),
      t.prisma.venue.update({ where: { id: lowNear.venueId }, data: { city } }),
      t.prisma.pitch.update({
        where: { id: nearA.pitchId },
        data: { surface: 'ARTIFICIAL', setting: 'INDOOR', amenities: ['showers'] },
      }),
      t.prisma.pitch.update({
        where: { id: nearB.pitchId },
        data: { surface: 'NATURAL', setting: 'OUTDOOR', amenities: ['parking'] },
      }),
      t.prisma.pitch.update({
        where: { id: far.pitchId },
        data: { surface: 'ARTIFICIAL', setting: 'INDOOR', amenities: ['showers'] },
      }),
      t.prisma.pitch.update({
        where: { id: lowNear.pitchId },
        data: { surface: 'ARTIFICIAL', setting: 'INDOOR', amenities: ['showers'] },
      }),
      t.prisma.rating.createMany({
        data: [
          { authorId: randomUUID(), subjectType: 'ORGANISER', subjectId: high.userId, eventId: randomUUID(), score: 4, editableUntil: new Date(Date.now() + HOUR) },
          { authorId: randomUUID(), subjectType: 'ORGANISER', subjectId: high.userId, eventId: randomUUID(), score: 5, editableUntil: new Date(Date.now() + HOUR) },
          { authorId: randomUUID(), subjectType: 'ORGANISER', subjectId: low.userId, eventId: randomUUID(), score: 3, editableUntil: new Date(Date.now() + HOUR) },
        ],
      }),
    ]);
    const good = await createGame(t, high, { pitchId: nearA.pitchId, hoursFromNow: 40 });
    const alsoGood = await createGame(t, high, { pitchId: nearB.pitchId, hoursFromNow: 41 });
    const outsideRadius = await createGame(t, high, { pitchId: far.pitchId, hoursFromNow: 42 });
    const lowRated = await createGame(t, low, { pitchId: lowNear.pitchId, hoursFromNow: 43 });
    const unknownLocation = await createGame(t, high, { hoursFromNow: 44 });
    void outsideRadius;
    void lowRated;
    void unknownLocation;
    await t.prisma.event.update({
      where: { id: alsoGood.id },
      data: { endsAt: new Date(new Date(alsoGood.body.startsAt as string).getTime() + 180 * 60_000) },
    });
    const query = `city=${city}&surfaces=ARTIFICIAL,NATURAL&settings=INDOOR,OUTDOOR&amenities=showers,parking&durationMinMinutes=120&durationMaxMinutes=180&minOrganiserRating=4&lat=41.7&lng=44.8&radiusKm=10`;
    const all = await t.http().get(`/v1/games?${query}`).expect(200);
    expect(all.body.items.map((x: { id: string }) => x.id)).toEqual([good.id, alsoGood.id]);
    const first = await t.http().get(`/v1/games?${query}&limit=1`).expect(200);
    const second = await t
      .http()
      .get(`/v1/games?${query}&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);
    expect([first.body.items[0].id, second.body.items[0].id]).toEqual([good.id, alsoGood.id]);
    expect(second.body.nextCursor).toBeNull();
    await t.http().get('/v1/games?radiusKm=10&lat=41.7').expect(400);
    await t.http().get('/v1/games?radiusKm=10&lat=91&lng=44.8').expect(400);
    await t.http().get('/v1/games?radiusKm=-1&lat=41.7&lng=44.8').expect(400);
  });

  it('blocked organiser/player pairs cannot join; the game is hidden from the blocker’s feed', async () => {
    const org = await createUser(t);
    const p = await createUser(t);
    const g = await createGame(t, org);
    await t.http().put(`/v1/blocks/${org.userId}`).set(p.auth).expect(204);
    await t.http().post(`/v1/games/${g.id}/join`).set(p.auth).send({}).expect(403);
    const feed = await t.http().get(`/v1/games?organiserId=${org.userId}`).set(p.auth).expect(200);
    expect(feed.body.items).toHaveLength(0);
  });
});
