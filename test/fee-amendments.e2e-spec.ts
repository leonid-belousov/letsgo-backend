/* eslint-disable @typescript-eslint/no-explicit-any -- e2e assertions read raw JSON bodies */
import { createTestApp, type TestApp } from './support/app';
import { createUser, type TestUser } from './support/factories';
import { createClubRow, createGame, fillSeats, idemKey } from './support/games';

/**
 * Handoff §16 / Decisions §17: a later fee change needs each affected player's acceptance;
 * receipts are never rewritten; waitlisted players owe nothing. Real PostgreSQL.
 */
describe('fee amendments (real PostgreSQL)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  interface Setup {
    organiser: TestUser;
    gameId: string;
    players: TestUser[];
    obligationIds: string[];
  }

  /** A club game (GEL 15.00) with `n` confirmed, paying players. */
  async function setup(n: number, opts: { priceMinor?: number } = {}): Promise<Setup> {
    const organiser = await createUser(t);
    const clubId = await createClubRow(t, organiser);
    const game = await createGame(t, organiser, { clubId, priceMinor: opts.priceMinor });
    const players: TestUser[] = [];
    const obligationIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const p = await createUser(t);
      await t.http().post(`/v1/games/${game.id}/join`).set(p.auth).send({}).expect(200);
      players.push(p);
      const ob = await t.prisma.paymentObligation.findFirstOrThrow({
        where: { eventId: game.id, payerUserId: p.userId },
      });
      obligationIds.push(ob.id);
    }
    return { organiser, gameId: game.id, players, obligationIds };
  }

  const propose = (s: Setup, newPriceMinor: number, by: TestUser = s.organiser, key = idemKey()) =>
    t
      .http()
      .post(`/v1/games/${s.gameId}/fee-amendments`)
      .set(by.auth)
      .set('Idempotency-Key', key)
      .send({ newPriceMinor, reason: 'Pitch got more expensive' });

  const respond = (
    id: string,
    action: 'accept' | 'reject',
    by: TestUser,
    version: number,
    key = idemKey(),
  ) =>
    t
      .http()
      .post(`/v1/payments/amendments/${id}/${action}`)
      .set(by.auth)
      .set('Idempotency-Key', key)
      .send({ version });

  const cashReceived = (obligationId: string, by: TestUser, body: object = {}, key = idemKey()) =>
    t
      .http()
      .post(`/v1/payments/obligations/${obligationId}/cash-received`)
      .set(by.auth)
      .set('Idempotency-Key', key)
      .send(body);

  const pendingFor = (s: Setup, i: number) =>
    t.prisma.feeAmendment.findFirstOrThrow({
      where: { participantId: s.players[i]!.userId, eventId: s.gameId, status: 'PENDING' },
    });

  it('proposal: pending amendments only for confirmed payers, notified, waitlisted get nothing, new joiners get the new price', async () => {
    const s = await setup(3);
    // fill the remaining places with anonymous confirmed rows (no obligations), then queue a real player
    await fillSeats(t, s.gameId, 9);
    const waiting = await createUser(t);
    const w = await t
      .http()
      .post(`/v1/games/${s.gameId}/join`)
      .set(waiting.auth)
      .send({})
      .expect(200);
    expect(w.body.status).toBe('WAITLISTED');
    const before = await t.prisma.event.findUniqueOrThrow({ where: { id: s.gameId } });

    const res = await propose(s, 2000).expect(200);
    expect(res.body).toMatchObject({ eventId: s.gameId, priceMinor: 2000, proposed: 3 });
    expect(res.body.amendments).toHaveLength(3);
    expect(res.body.amendments[0]).toMatchObject({
      oldAmountMinor: 1500,
      newAmountMinor: 2000,
      currency: 'GEL',
      status: 'PENDING',
      version: 1,
      proposedById: s.organiser.userId,
    });

    const after = await t.prisma.event.findUniqueOrThrow({ where: { id: s.gameId } });
    expect(after.priceMinor).toBe(2000);
    expect(after.version).toBe(before.version + 1);

    // obligations are untouched until acceptance; the payer sees the pending amendment
    for (const id of s.obligationIds) {
      const ob = await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id } });
      expect(ob.amountMinor).toBe(1500);
    }
    const mine = await t.http().get('/v1/payments/mine').set(s.players[0]!.auth).expect(200);
    expect(mine.body[0]).toMatchObject({ amountMinor: 1500 });
    expect(mine.body[0].pendingAmendment).toMatchObject({
      newAmountMinor: 2000,
      version: 1,
      id: res.body.amendments.find((a: any) => a.participantId === s.players[0]!.userId).id,
    });

    // activity item + chat card for each affected player, nothing for the waitlisted one
    for (const p of s.players) {
      const acts = await t.prisma.activityItem.findMany({
        where: { recipientId: p.userId, kind: 'fee.amendment_proposed' },
      });
      expect(acts).toHaveLength(1);
      expect(acts[0]!.payload).toMatchObject({
        eventId: s.gameId,
        oldAmountMinor: 1500,
        newAmountMinor: 2000,
        currency: 'GEL',
      });
      expect(Object.keys(acts[0]!.payload as object).sort()).toEqual([
        'amendmentId',
        'currency',
        'eventId',
        'newAmountMinor',
        'oldAmountMinor',
      ]);
      const conv = await t.prisma.conversation.findUniqueOrThrow({
        where: { directKey: `system:${p.userId}` },
      });
      const cards = await t.prisma.message.findMany({
        where: { conversationId: conv.id, cardType: 'FEE_AMENDMENT' },
      });
      expect(cards).toHaveLength(1);
      expect(cards[0]!.cardPayload).toMatchObject({ eventId: s.gameId });
    }
    expect(
      await t.prisma.activityItem.count({
        where: { recipientId: waiting.userId, kind: 'fee.amendment_proposed' },
      }),
    ).toBe(0);
    expect(await t.prisma.feeAmendment.count({ where: { participantId: waiting.userId } })).toBe(0);
    expect(
      await t.prisma.auditEvent.count({
        where: {
          action: 'payment.fee_amendment_proposed',
          metadata: { path: ['eventId'], equals: s.gameId },
        },
      }),
    ).toBe(3);

    // the organiser sees them; a plain participant does not
    const list = await t
      .http()
      .get(`/v1/games/${s.gameId}/fee-amendments`)
      .set(s.organiser.auth)
      .expect(200);
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items[0].capabilities).toMatchObject({ canAccept: false, canCancel: true });
    await t.http().get(`/v1/games/${s.gameId}/fee-amendments`).set(s.players[0]!.auth).expect(403);

    // a player joining after the change agrees to the new price
    await t
      .http()
      .delete(`/v1/games/${s.gameId}/participation`)
      .set(s.players[2]!.auth)
      .expect(200);
    // leaving cancels the pending amendment (no addressee any more)
    expect(
      await t.prisma.feeAmendment.count({
        where: { participantId: s.players[2]!.userId, status: 'CANCELLED' },
      }),
    ).toBe(1);
    // the seat goes to the waitlist offer; rejoin path: a fresh game for the joiner check
    const s2 = await setup(1);
    await propose(s2, 1800).expect(200);
    const joiner = await createUser(t);
    await t.http().post(`/v1/games/${s2.gameId}/join`).set(joiner.auth).send({}).expect(200);
    const ob = await t.prisma.paymentObligation.findFirstOrThrow({
      where: { eventId: s2.gameId, payerUserId: joiner.userId },
    });
    expect(ob.amountMinor).toBe(1800);
    expect(await t.prisma.feeAmendment.count({ where: { participantId: joiner.userId } })).toBe(0);
  });

  it('acceptance changes the obligation only for the accepter; rejection leaves it; replays are idempotent', async () => {
    const s = await setup(3);
    await propose(s, 2000).expect(200);
    const [a0, a1, a2] = [await pendingFor(s, 0), await pendingFor(s, 1), await pendingFor(s, 2)];
    const [p0, p1, p2] = s.players as [TestUser, TestUser, TestUser];

    // only the affected participant may answer
    await respond(a0.id, 'accept', s.organiser, 1).expect(404);
    const stranger = await createUser(t);
    await respond(a0.id, 'accept', stranger, 1).expect(404);
    await respond(a0.id, 'accept', p1, 1).expect(404);
    expect(
      (await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: s.obligationIds[0]! } }))
        .amountMinor,
    ).toBe(1500);

    // stale / wrong version
    const stale = await respond(a0.id, 'accept', p0, 7).expect(409);
    expect(stale.body.error.code).toBe('VERSION_CHANGED');
    expect(stale.body.error.details).toMatchObject({ currentVersion: 1 });

    // accept
    const key = idemKey();
    const r1 = await respond(a0.id, 'accept', p0, 1, key).expect(200);
    expect(r1.body).toMatchObject({ status: 'ACCEPTED', version: 2, respondedById: p0.userId });
    expect(r1.body.obligation).toMatchObject({
      amountMinor: 2000,
      status: 'OPEN',
      remainingMinor: 2000,
    });
    expect(r1.body.obligation.pendingAmendment).toBeUndefined();
    // same key ⇒ same stored response; new key ⇒ same state, no second effect
    const r2 = await respond(a0.id, 'accept', p0, 1, key).expect(200);
    expect(r2.body).toEqual(r1.body);
    const r3 = await respond(a0.id, 'accept', p0, 1).expect(200);
    expect(r3.body.status).toBe('ACCEPTED');
    expect(r3.body.obligation.amountMinor).toBe(2000);
    const ob0 = await t.prisma.paymentObligation.findUniqueOrThrow({
      where: { id: s.obligationIds[0]! },
    });
    expect(ob0).toMatchObject({ amountMinor: 2000, version: 2 });
    // the proposer was told once
    expect(
      await t.prisma.activityItem.count({
        where: { recipientId: s.organiser.userId, kind: 'fee.amendment_accepted', objectId: a0.id },
      }),
    ).toBe(1);
    expect(
      await t.prisma.auditEvent.count({
        where: { action: 'payment.fee_amendment_accepted', targetId: a0.id },
      }),
    ).toBe(1);

    // reject leaves the obligation as it was
    const rj = await respond(a1.id, 'reject', p1, 1).expect(200);
    expect(rj.body).toMatchObject({ status: 'REJECTED' });
    expect(rj.body.obligation.amountMinor).toBe(1500);
    await respond(a1.id, 'reject', p1, 1).expect(200); // repeat: same result
    expect(
      await t.prisma.activityItem.count({
        where: { recipientId: s.organiser.userId, kind: 'fee.amendment_rejected', objectId: a1.id },
      }),
    ).toBe(1);
    // a decided amendment cannot be flipped
    const flip = await respond(a1.id, 'accept', p1, 2).expect(409);
    expect(flip.body.error.code).toBe('CONFLICT');
    await respond(a0.id, 'reject', p0, 2).expect(409);

    // the third player never answered: untouched
    expect(
      (await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: s.obligationIds[1]! } }))
        .amountMinor,
    ).toBe(1500);
    expect(
      (await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: s.obligationIds[2]! } }))
        .amountMinor,
    ).toBe(1500);
    expect((await t.prisma.feeAmendment.findUniqueOrThrow({ where: { id: a2.id } })).status).toBe(
      'PENDING',
    );

    // my amendments: pending first
    const mine = await t.http().get('/v1/payments/amendments/mine').set(p2.auth).expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ id: a2.id, status: 'PENDING' });
    expect(mine.body[0].capabilities).toMatchObject({
      canAccept: true,
      canReject: true,
      canCancel: false,
    });
  });

  it('accept when partially paid / higher: status recomputed, receipts untouched', async () => {
    const s = await setup(1);
    const p = s.players[0]!;
    const obId = s.obligationIds[0]!;
    await cashReceived(obId, s.organiser, { amountMinor: 500 }).expect(200);
    const receiptsBefore = await t.prisma.cashReceipt.findMany({
      where: { obligationId: obId },
      orderBy: { id: 'asc' },
    });

    await propose(s, 2000).expect(200);
    // while pending, cash still applies to the old amount
    const cashWhilePending = await cashReceived(obId, s.organiser, { amountMinor: 500 }).expect(
      200,
    );
    expect(cashWhilePending.body).toMatchObject({ amountMinor: 1500, paidMinor: 1000 });
    expect(cashWhilePending.body.pendingAmendment).toBeDefined();
    const am = await pendingFor(s, 0);
    const res = await respond(am.id, 'accept', p, 1).expect(200);
    expect(res.body.obligation).toMatchObject({
      amountMinor: 2000,
      paidMinor: 1000,
      remainingMinor: 1000,
      status: 'PARTIALLY_PAID',
      refundDueMinor: 0,
    });
    const receiptsAfter = await t.prisma.cashReceipt.findMany({
      where: { obligationId: obId },
      orderBy: { id: 'asc' },
    });
    expect(receiptsAfter).toHaveLength(receiptsBefore.length + 1);
    expect(receiptsAfter.slice(0, receiptsBefore.length)).toEqual(receiptsBefore);
    expect(await t.prisma.adjustment.count({ where: { obligationId: obId } })).toBe(0);

    // the receiver's view shows the raised amount and can still confirm the rest
    const rest = await cashReceived(obId, s.organiser).expect(200);
    expect(rest.body).toMatchObject({ paidMinor: 2000, status: 'PAID' });

    // fully paid + higher price ⇒ owes again (partially paid), receipts unchanged
    const s2 = await setup(1);
    await cashReceived(s2.obligationIds[0]!, s2.organiser).expect(200);
    await propose(s2, 2500).expect(200);
    const am2 = await pendingFor(s2, 0);
    const up = await respond(am2.id, 'accept', s2.players[0]!, 1).expect(200);
    expect(up.body.obligation).toMatchObject({
      amountMinor: 2500,
      paidMinor: 1500,
      status: 'PARTIALLY_PAID',
      remainingMinor: 1000,
    });
  });

  it('accept a lower price when fully paid ⇒ Refund due for the excess, receipts untouched, no double effect', async () => {
    const s = await setup(1);
    const p = s.players[0]!;
    const obId = s.obligationIds[0]!;
    await cashReceived(obId, s.organiser).expect(200);
    const receiptsBefore = await t.prisma.cashReceipt.findMany({ where: { obligationId: obId } });

    await propose(s, 1000).expect(200);
    const am = await pendingFor(s, 0);
    const res = await respond(am.id, 'accept', p, 1).expect(200);
    expect(res.body.obligation).toMatchObject({
      amountMinor: 1000,
      paidMinor: 1500,
      status: 'PAID',
      refundDueMinor: 500,
      refundedMinor: 0,
      remainingMinor: 0,
    });
    const adjustments = await t.prisma.adjustment.findMany({ where: { obligationId: obId } });
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({
      type: 'REFUND_DUE',
      deltaMinor: 500,
      reason: 'Fee reduced by accepted amendment',
      actorId: s.organiser.userId, // the proposer, not the accepting participant
    });
    expect(await t.prisma.cashReceipt.findMany({ where: { obligationId: obId } })).toEqual(
      receiptsBefore,
    );

    await respond(am.id, 'accept', p, 1).expect(200);
    expect(await t.prisma.adjustment.count({ where: { obligationId: obId } })).toBe(1);
    expect(
      (await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: obId } })).refundDueMinor,
    ).toBe(500);
  });

  it('a new proposal supersedes the pending one; retries do not duplicate; cancel; free price', async () => {
    const s = await setup(2);
    const first = await propose(s, 2000).expect(200);
    const firstIds: string[] = first.body.amendments.map((a: any) => a.id);
    const second = await propose(s, 2500).expect(200);
    const secondIds: string[] = second.body.amendments.map((a: any) => a.id);
    expect(second.body.proposed).toBe(2);
    for (const id of firstIds) {
      expect((await t.prisma.feeAmendment.findUniqueOrThrow({ where: { id } })).status).toBe(
        'SUPERSEDED',
      );
    }
    expect(
      await t.prisma.feeAmendment.count({ where: { eventId: s.gameId, status: 'PENDING' } }),
    ).toBe(2);
    // a superseded amendment can no longer be accepted
    const old = await respond(firstIds[0]!, 'accept', s.players[0]!, 2).expect(409);
    expect(old.body.error.code).toBe('CONFLICT');

    // retrying the same proposal (new key) keeps the same pending rows and does not re-notify
    const notifBefore = await t.prisma.activityItem.count({
      where: { kind: 'fee.amendment_proposed', objectId: { in: secondIds } },
    });
    const again = await propose(s, 2500).expect(200);
    expect(again.body.amendments.map((a: any) => a.id).sort()).toEqual([...secondIds].sort());
    expect(
      await t.prisma.activityItem.count({
        where: { kind: 'fee.amendment_proposed', objectId: { in: secondIds } },
      }),
    ).toBe(notifBefore);
    expect(
      await t.prisma.feeAmendment.count({ where: { eventId: s.gameId, status: 'PENDING' } }),
    ).toBe(2);

    // cancel: fee-changer only
    const target = secondIds[0]!;
    const targetPlayer = second.body.amendments[0].participantId as string;
    const player = s.players.find((p) => p.userId === targetPlayer)!;
    await t.http().post(`/v1/payments/amendments/${target}/cancel`).set(player.auth).expect(403);
    const other = await createUser(t);
    await t.http().post(`/v1/payments/amendments/${target}/cancel`).set(other.auth).expect(404);
    const c = await t
      .http()
      .post(`/v1/payments/amendments/${target}/cancel`)
      .set(s.organiser.auth)
      .set('Idempotency-Key', idemKey())
      .expect(200);
    expect(c.body.status).toBe('CANCELLED');
    await t
      .http()
      .post(`/v1/payments/amendments/${target}/cancel`)
      .set(s.organiser.auth)
      .expect(200);
    const acc = await respond(target, 'accept', player, 1).expect(409);
    expect(acc.body.error.code).toBe('CONFLICT');
    expect(
      await t.prisma.activityItem.count({
        where: { recipientId: player.userId, kind: 'fee.amendment_cancelled' },
      }),
    ).toBe(1);

    // a free price is allowed; accepting leaves nothing owed
    await propose(s, 0).expect(200);
    const am = await pendingFor(
      s,
      s.players.findIndex((p) => p.userId !== targetPlayer),
    );
    const free = await respond(
      am.id,
      'accept',
      s.players.find((p) => p.userId === am.participantId)!,
      1,
    ).expect(200);
    expect(free.body.obligation).toMatchObject({ amountMinor: 0, remainingMinor: 0 });
  });

  it('authorisation and validation of proposals', async () => {
    const s = await setup(1);
    const outsider = await createUser(t);
    const otherOrganiser = await createUser(t);
    await createClubRow(t, otherOrganiser);

    await propose(s, 2000, s.players[0]!).expect(403);
    await propose(s, 2000, outsider).expect(403);
    await propose(s, 2000, otherOrganiser).expect(403);
    expect(await t.prisma.feeAmendment.count({ where: { eventId: s.gameId } })).toBe(0);
    expect((await t.prisma.event.findUniqueOrThrow({ where: { id: s.gameId } })).priceMinor).toBe(
      1500,
    );

    await propose(s, -1).expect(400);
    await propose(s, 12.5).expect(400);
    await t
      .http()
      .post(`/v1/games/${s.gameId}/fee-amendments`)
      .set(s.organiser.auth)
      .send({})
      .expect(400);
    await t
      .http()
      .post('/v1/games/00000000-0000-7000-8000-000000000000/fee-amendments')
      .set(s.organiser.auth)
      .send({ newPriceMinor: 100 })
      .expect(404);

    // a delegated fee-changer may propose (permission is checked through the policy layer)
    const delegate = await createUser(t);
    const event = await t.prisma.event.findUniqueOrThrow({ where: { id: s.gameId } });
    await t.prisma.roleGrant.create({
      data: {
        granteeId: delegate.userId,
        grantedById: s.organiser.userId,
        permission: 'club.money.changeFees',
        resourceType: 'CLUB',
        resourceId: event.clubId!,
        canPassOn: false,
      },
    });
    const ok = await propose(s, 1600, delegate).expect(200);
    expect(ok.body.proposed).toBe(1);

    // a cancelled game cannot be re-priced
    await t
      .http()
      .post(`/v1/games/${s.gameId}/cancel`)
      .set(s.organiser.auth)
      .send({ reason: 'rain' })
      .expect(200);
    await propose(s, 1700).expect(409);
    // ... and its pending proposals were withdrawn
    expect(
      await t.prisma.feeAmendment.count({ where: { eventId: s.gameId, status: 'PENDING' } }),
    ).toBe(0);
  });

  it('concurrency: parallel accepts have exactly one effect; Cash received racing an accept stays consistent', async () => {
    const s = await setup(2);
    await propose(s, 2000).expect(200);
    const a0 = await pendingFor(s, 0);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        respond(
          a0.id,
          'accept',
          s.players[0]!,
          1,
          i < 2 ? 'same-key-parallel-' + a0.id.slice(0, 8) : idemKey(),
        ),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);
    const ob0 = await t.prisma.paymentObligation.findUniqueOrThrow({
      where: { id: s.obligationIds[0]! },
    });
    expect(ob0).toMatchObject({ amountMinor: 2000, version: 2 });
    expect((await t.prisma.feeAmendment.findUniqueOrThrow({ where: { id: a0.id } })).version).toBe(
      2,
    );
    expect(
      await t.prisma.activityItem.count({
        where: { kind: 'fee.amendment_accepted', objectId: a0.id },
      }),
    ).toBe(1);
    expect(
      await t.prisma.auditEvent.count({
        where: { action: 'payment.fee_amendment_accepted', targetId: a0.id },
      }),
    ).toBe(1);

    // accept vs reject at the same time: exactly one wins, the other gets 409 or the same result
    const a1 = await pendingFor(s, 1);
    const [acc, rej] = await Promise.all([
      respond(a1.id, 'accept', s.players[1]!, 1),
      respond(a1.id, 'reject', s.players[1]!, 1),
    ]);
    expect([acc.status, rej.status].sort()).toEqual([200, 409]);
    const finalA1 = await t.prisma.feeAmendment.findUniqueOrThrow({ where: { id: a1.id } });
    const ob1 = await t.prisma.paymentObligation.findUniqueOrThrow({
      where: { id: s.obligationIds[1]! },
    });
    expect(ob1.amountMinor).toBe(finalA1.status === 'ACCEPTED' ? 2000 : 1500);

    // Cash received racing an acceptance
    for (let round = 0; round < 3; round++) {
      const r = await setup(1);
      await propose(r, 2000).expect(200);
      const am = await pendingFor(r, 0);
      const obId = r.obligationIds[0]!;
      const [accepted, cash] = await Promise.all([
        respond(am.id, 'accept', r.players[0]!, 1),
        cashReceived(obId, r.organiser),
      ]);
      expect(accepted.status).toBe(200);
      expect(cash.status).toBe(200);
      const ob = await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: obId } });
      const receipts = await t.prisma.cashReceipt.findMany({ where: { obligationId: obId } });
      const sum = receipts.reduce((x, y) => x + y.amountMinor, 0);
      expect(ob.amountMinor).toBe(2000);
      expect(ob.paidMinor).toBe(sum);
      expect([1500, 2000]).toContain(sum); // cash before the accept: old remainder; after: the new one
      expect(ob.status).toBe(sum === 2000 ? 'PAID' : 'PARTIALLY_PAID');
      expect(ob.refundDueMinor).toBe(0);
    }
  });
});
