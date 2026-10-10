import { createTestApp, type TestApp } from './support/app';
import { createUser } from './support/factories';
import { createClubRow, createGame, idemKey } from './support/games';

/**
 * First vertical slice (Handoff §22):
 * Home invitation → invitation details → confirm → Pay cash → Cash received → Paid.
 */
describe('vertical slice: invitation → confirm → Pay cash → Cash received', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('runs end-to-end with correct states, capabilities and immutable history', async () => {
    const organiser = await createUser(t);
    const player = await createUser(t);
    const stranger = await createUser(t);
    const clubId = await createClubRow(t, organiser);
    const game = await createGame(t, organiser, { clubId });

    // organiser invites the player (ordinary invitation ⇒ NO seat hold)
    const invite = await t
      .http()
      .post(`/v1/games/${game.id}/invitations`)
      .set(organiser.auth)
      .set('Idempotency-Key', idemKey())
      .send({ inviteeIds: [player.userId] })
      .expect(200);
    expect(invite.body.created).toHaveLength(1);
    const invitationId = invite.body.created[0].id as string;
    expect(invite.body.created[0].heldUntil).toBeNull();
    expect(await t.prisma.seatHold.count({ where: { eventId: game.id } })).toBe(0);

    // Home: pinned invitation
    const home = await t.http().get('/v1/games/invitations/mine').set(player.auth).expect(200);
    expect(home.body).toHaveLength(1);
    expect(home.body[0].game.id).toBe(game.id);
    expect(home.body[0].game.seats).toMatchObject({ capacity: 12, confirmed: 0, spotsLeft: 12 });
    expect(home.body[0].game.viewerInvitation).toBe('PENDING');

    // invitation details = game detail with capabilities
    const detail = await t.http().get(`/v1/games/${game.id}`).set(player.auth).expect(200);
    expect(detail.body.capabilities.canConfirmInvitation).toBe(true);
    expect(detail.body.viewer.invitation.id).toBe(invitationId);
    expect(detail.body.capabilities.canConfirmCash).toBe(false);
    expect(detail.body.capabilities.canManageSquad).toBe(false);

    // confirm (idempotent: the retry with the same key changes nothing)
    const key = idemKey();
    const c1 = await t
      .http()
      .post(`/v1/games/invitations/${invitationId}/confirm`)
      .set(player.auth)
      .set('Idempotency-Key', key)
      .expect(200);
    expect(c1.body.status).toBe('CONFIRMED');
    const c2 = await t
      .http()
      .post(`/v1/games/invitations/${invitationId}/confirm`)
      .set(player.auth)
      .set('Idempotency-Key', key)
      .expect(200);
    expect(c2.body.id).toBe(c1.body.id);
    // a different key after success is also harmless (state-based idempotency)
    const c3 = await t
      .http()
      .post(`/v1/games/invitations/${invitationId}/confirm`)
      .set(player.auth)
      .expect(200);
    expect(c3.body.id).toBe(c1.body.id);
    expect(
      await t.prisma.participation.count({ where: { eventId: game.id, userId: player.userId } }),
    ).toBe(1);
    expect(
      await t.prisma.paymentObligation.count({
        where: { eventId: game.id, payerUserId: player.userId },
      }),
    ).toBe(1);

    // Home no longer pins it
    expect((await t.http().get('/v1/games/invitations/mine').set(player.auth)).body).toHaveLength(
      0,
    );

    // obligation: 15.00 GEL, OPEN, Pay cash allowed, Pay online never
    const mine = await t.http().get('/v1/payments/mine').set(player.auth).expect(200);
    expect(mine.body).toHaveLength(1);
    const ob = mine.body[0];
    expect(ob).toMatchObject({
      amountMinor: 1500,
      currency: 'GEL',
      status: 'OPEN',
      paidMinor: 0,
      remainingMinor: 1500,
    });
    expect(ob.capabilities).toEqual({
      canPayCash: true,
      canConfirmCash: false,
      canCorrect: false,
      canPayOnline: false,
    });

    // Pay cash ≠ paid
    const pc = await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/pay-cash`)
      .set(player.auth)
      .expect(200);
    expect(pc.body.status).toBe('OPEN');
    expect(pc.body.payCashRequestedAt).not.toBeNull();
    // the responsible person (club owner) was told
    const acts = await t.prisma.activityItem.findMany({
      where: { recipientId: organiser.userId, kind: 'cash.pay_cash_requested' },
    });
    expect(acts).toHaveLength(1);
    // repeating Pay cash does not spam
    await t.http().post(`/v1/payments/obligations/${ob.id}/pay-cash`).set(player.auth).expect(200);
    expect(
      await t.prisma.activityItem.count({
        where: { recipientId: organiser.userId, kind: 'cash.pay_cash_requested' },
      }),
    ).toBe(1);

    // the responsible person's view: money overview with capability
    const summary = await t
      .http()
      .get(`/v1/games/${game.id}/payments`)
      .set(organiser.auth)
      .expect(200);
    expect(summary.body).toMatchObject({
      expectedMinor: 1500,
      collectedMinor: 0,
      outstandingMinor: 1500,
      paidCount: 0,
    });
    expect(summary.body.obligations[0].capabilities.canConfirmCash).toBe(true);
    const orgDetail = await t.http().get(`/v1/games/${game.id}`).set(organiser.auth).expect(200);
    expect(orgDetail.body.capabilities.canConfirmCash).toBe(true);

    // players and strangers cannot confirm cash; the player cannot mark themselves paid
    await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(player.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(403);
    await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(stranger.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(403);
    await t.http().get(`/v1/payments/obligations/${ob.id}`).set(stranger.auth).expect(404);
    // the key is mandatory for money-moving calls
    const noKey = await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(organiser.auth)
      .send({})
      .expect(400);
    expect(noKey.body.error.code).toBe('VALIDATION');

    // Cash received (double tap with the same key ⇒ one receipt)
    const cashKey = idemKey();
    const r1 = await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(organiser.auth)
      .set('Idempotency-Key', cashKey)
      .send({})
      .expect(200);
    const r2 = await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(organiser.auth)
      .set('Idempotency-Key', cashKey)
      .send({})
      .expect(200);
    expect(r1.body.status).toBe('PAID');
    expect(r2.body).toEqual(r1.body);
    expect(await t.prisma.cashReceipt.count({ where: { obligationId: ob.id } })).toBe(1);
    // a second tap with a NEW key after payment is refused (never double-credits)
    await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(organiser.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(409);
    expect(await t.prisma.cashReceipt.count({ where: { obligationId: ob.id } })).toBe(1);
    // the same key with a different body is a client bug
    const reuse = await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(organiser.auth)
      .set('Idempotency-Key', cashKey)
      .send({ amountMinor: 100 })
      .expect(409);
    expect(reuse.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    // ledger: author, time, amount — visible to the payer
    const ledger = await t
      .http()
      .get(`/v1/payments/obligations/${ob.id}`)
      .set(player.auth)
      .expect(200);
    expect(ledger.body.status).toBe('PAID');
    expect(ledger.body.receipts).toHaveLength(1);
    expect(ledger.body.receipts[0]).toMatchObject({
      amountMinor: 1500,
      receivedById: organiser.userId,
    });
    expect(ledger.body.capabilities.canPayCash).toBe(false);

    // the payer was notified
    expect(
      await t.prisma.activityItem.count({
        where: { recipientId: player.userId, kind: 'cash.paid' },
      }),
    ).toBe(1);

    // receipts are immutable in the database itself
    await expect(
      t.prisma.cashReceipt.update({
        where: { id: ledger.body.receipts[0].id },
        data: { amountMinor: 1 },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.cashReceipt.deleteMany({ where: { obligationId: ob.id } }),
    ).rejects.toThrow();
    const audit = await t.prisma.auditEvent.findMany({
      where: { targetId: ob.id, action: 'payment.cash_received' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(organiser.userId);
  });

  it('partial cash → Partially paid with exact remainder; overpayment refused; then Paid', async () => {
    const organiser = await createUser(t);
    const player = await createUser(t);
    const clubId = await createClubRow(t, organiser);
    const game = await createGame(t, organiser, { clubId, joinMode: 'AUTO_ACCEPT' });
    await t.http().post(`/v1/games/${game.id}/join`).set(player.auth).send({}).expect(200);
    const ob = (await t.http().get('/v1/payments/mine').set(player.auth)).body[0];

    const p1 = await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(organiser.auth)
      .set('Idempotency-Key', idemKey())
      .send({ amountMinor: 500, note: 'part' })
      .expect(200);
    expect(p1.body).toMatchObject({
      status: 'PARTIALLY_PAID',
      paidMinor: 500,
      remainingMinor: 1000,
    });
    const over = await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(organiser.auth)
      .set('Idempotency-Key', idemKey())
      .send({ amountMinor: 1001 })
      .expect(400);
    expect(over.body.error.details.remainingMinor).toBe(1000);
    const p2 = await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(organiser.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(200);
    expect(p2.body).toMatchObject({ status: 'PAID', paidMinor: 1500, remainingMinor: 0 });
    expect(await t.prisma.cashReceipt.count({ where: { obligationId: ob.id } })).toBe(2);
  });

  it('corrections append adjustments — receipts stay untouched; refund due ≠ refunded', async () => {
    const organiser = await createUser(t);
    const player = await createUser(t);
    const clubId = await createClubRow(t, organiser);
    const game = await createGame(t, organiser, { clubId });
    await t.http().post(`/v1/games/${game.id}/join`).set(player.auth).send({}).expect(200);
    const ob = (await t.http().get('/v1/payments/mine').set(player.auth)).body[0];
    await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(organiser.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(200);

    // the payer cannot adjust
    await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/adjustments`)
      .set(player.auth)
      .set('Idempotency-Key', idemKey())
      .send({ type: 'CORRECTION', deltaMinor: -500, reason: 'x' })
      .expect(403);

    const corr = await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/adjustments`)
      .set(organiser.auth)
      .set('Idempotency-Key', idemKey())
      .send({ type: 'CORRECTION', deltaMinor: -500, reason: 'counted wrong' })
      .expect(200);
    expect(corr.body).toMatchObject({ paidMinor: 1000, status: 'PARTIALLY_PAID' });
    const due = await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/adjustments`)
      .set(organiser.auth)
      .set('Idempotency-Key', idemKey())
      .send({ type: 'REFUND_DUE', deltaMinor: 400, reason: 'left early' })
      .expect(200);
    expect(due.body).toMatchObject({ refundDueMinor: 400, refundedMinor: 0 });
    const paid = await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/adjustments`)
      .set(organiser.auth)
      .set('Idempotency-Key', idemKey())
      .send({ type: 'REFUND_PAID', deltaMinor: 400, reason: 'handed back' })
      .expect(200);
    expect(paid.body).toMatchObject({ refundDueMinor: 0, refundedMinor: 400 });
    await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/adjustments`)
      .set(organiser.auth)
      .set('Idempotency-Key', idemKey())
      .send({ type: 'REFUND_PAID', deltaMinor: 1, reason: 'more than due' })
      .expect(400);

    expect(await t.prisma.cashReceipt.count({ where: { obligationId: ob.id } })).toBe(1);
    expect(await t.prisma.adjustment.count({ where: { obligationId: ob.id } })).toBe(3);
    await expect(
      t.prisma.adjustment.deleteMany({ where: { obligationId: ob.id } }),
    ).rejects.toThrow();
  });

  it('a delegated receiver can confirm cash but never their own payment', async () => {
    const owner = await createUser(t);
    const treasurer = await createUser(t);
    const clubId = await createClubRow(t, owner);
    const game = await createGame(t, owner, { clubId });
    // explicit event-level grant of the cash permission
    await t
      .http()
      .post('/v1/grants')
      .set(owner.auth)
      .send({
        granteeId: treasurer.userId,
        resourceType: 'CLUB',
        resourceId: clubId,
        permission: 'club.money.confirmCash',
      })
      .expect(201);
    const other = await createUser(t);
    await t.http().post(`/v1/games/${game.id}/join`).set(other.auth).send({}).expect(200);
    await t.http().post(`/v1/games/${game.id}/join`).set(treasurer.auth).send({}).expect(200);
    const otherOb = (await t.http().get('/v1/payments/mine').set(other.auth)).body[0];
    const ownOb = (await t.http().get('/v1/payments/mine').set(treasurer.auth)).body[0];
    await t
      .http()
      .post(`/v1/payments/obligations/${otherOb.id}/cash-received`)
      .set(treasurer.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(200);
    // the receiver's own obligation must be confirmed by someone else
    await t
      .http()
      .post(`/v1/payments/obligations/${ownOb.id}/cash-received`)
      .set(treasurer.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(403);
    await t
      .http()
      .post(`/v1/payments/obligations/${ownOb.id}/cash-received`)
      .set(owner.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(200);
  });

  it('casual game without a club: nobody is an implicit receiver (OPEN decision #1)', async () => {
    const organiser = await createUser(t);
    const player = await createUser(t);
    const game = await createGame(t, organiser);
    await t.http().post(`/v1/games/${game.id}/join`).set(player.auth).send({}).expect(200);
    const ob = (await t.http().get('/v1/payments/mine').set(player.auth)).body[0];
    await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(organiser.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(403);
    // organiser explicitly grants themselves… not possible; they may grant a helper
    const helper = await createUser(t);
    await t
      .http()
      .post('/v1/grants')
      .set(organiser.auth)
      .send({
        granteeId: helper.userId,
        resourceType: 'EVENT',
        resourceId: game.id,
        permission: 'event.cash.confirm',
      })
      .expect(201);
    await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(helper.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(200);
  });
});
