import { findInPages } from './support/paging';
import { createTestApp, type TestApp } from './support/app';
import { createUser } from './support/factories';
import { createGame } from './support/games';
import { finishedGame, makeStaff } from './support/results';

describe('admin: recovery, audit, user lookup, account deletion (real PostgreSQL)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('recovery: list → approve (token once) → redeem end to end; scoped permission only', async () => {
    const victim = await createUser(t);
    await t
      .http()
      .post('/v1/auth/recovery/request')
      .send({ email: victim.email, message: 'lost my password' })
      .expect(202);
    const c = await t.prisma.accountRecoveryCase.findFirstOrThrow({
      where: { userId: victim.userId },
    });
    const outsider = await createUser(t);
    await t.http().get('/v1/admin/recovery-cases').set(outsider.auth).expect(403);
    const audit = await makeStaff(t, ['admin.audit.read']);
    await t.http().get('/v1/admin/recovery-cases').set(audit.auth).expect(403); // other staff permission is not enough
    const staff = await makeStaff(t, ['admin.accounts.recover']);
    // the shared database accumulates cases from earlier runs: page until ours shows up
    let list = await t.http().get('/v1/admin/recovery-cases?limit=100').set(staff.auth).expect(200);
    let item = list.body.items.find((i: { id: string }) => i.id === c.id);
    for (let page = 0; !item && list.body.nextCursor && page < 200; page++) {
      list = await t
        .http()
        .get(
          `/v1/admin/recovery-cases?limit=100&cursor=${encodeURIComponent(list.body.nextCursor)}`,
        )
        .set(staff.auth)
        .expect(200);
      item = list.body.items.find((i: { id: string }) => i.id === c.id);
    }
    expect(item.status).toBe('OPEN');
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash/);
    await t
      .http()
      .post(`/v1/admin/recovery-cases/${c.id}/approve`)
      .set(staff.auth)
      .send({})
      .expect(400);
    const ok = await t
      .http()
      .post(`/v1/admin/recovery-cases/${c.id}/approve`)
      .set(staff.auth)
      .send({ verificationNote: 'Verified by video call' })
      .expect(200);
    expect(ok.body.token).toEqual(expect.any(String));
    await t
      .http()
      .post(`/v1/admin/recovery-cases/${c.id}/approve`)
      .set(staff.auth)
      .send({ verificationNote: 'Verified again' })
      .expect(404); // no second token
    await t
      .http()
      .post('/v1/auth/recovery/redeem')
      .send({ token: ok.body.token, newPassword: 'brand-new-password' })
      .expect(204);
    await t
      .http()
      .post('/v1/auth/login')
      .send({ email: victim.email, password: 'brand-new-password' })
      .expect(200);
    await t
      .http()
      .post('/v1/auth/recovery/redeem')
      .send({ token: ok.body.token, newPassword: 'another-password-1' })
      .expect(401);
    const done = await findInPages<{ id: string }>(
      t,
      '/v1/admin/recovery-cases?status=REDEEMED',
      staff.auth,
      (i) => i.id === c.id,
    );
    expect(done).toBeDefined();

    // decline path
    const other = await createUser(t);
    await t.http().post('/v1/auth/recovery/request').send({ email: other.email }).expect(202);
    const c2 = await t.prisma.accountRecoveryCase.findFirstOrThrow({
      where: { userId: other.userId },
    });
    await t
      .http()
      .post(`/v1/admin/recovery-cases/${c2.id}/decline`)
      .set(staff.auth)
      .send({ note: 'Could not verify' })
      .expect(204);
    expect(
      (await t.prisma.accountRecoveryCase.findUniqueOrThrow({ where: { id: c2.id } })).status,
    ).toBe('DECLINED');
  });

  it('audit log needs admin.audit.read, filters, is keyset paged and carries no secrets', async () => {
    const actor = await createUser(t);
    await t.prisma.auditEvent.createMany({
      data: [1, 2, 3].map((i) => ({
        actorId: actor.userId,
        action: 'test.thing',
        targetType: 'Thing',
        targetId: `t${i}`,
        metadata: { note: i, password: 'hunter2', token: 'abc' },
      })),
    });
    await t.http().get('/v1/admin/audit').set(actor.auth).expect(403);
    const staff = await makeStaff(t, ['admin.audit.read']);
    const p1 = await t
      .http()
      .get(`/v1/admin/audit?actorId=${actor.userId}&action=test.thing&limit=2`)
      .set(staff.auth)
      .expect(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).not.toBeNull();
    const p2 = await t
      .http()
      .get(
        `/v1/admin/audit?actorId=${actor.userId}&action=test.thing&limit=2&cursor=${p1.body.nextCursor}`,
      )
      .set(staff.auth)
      .expect(200);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    const all = JSON.stringify([p1.body, p2.body]);
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('abc"');
    // creating grants by staff is itself visible
    const byTarget = await t
      .http()
      .get('/v1/admin/audit?targetType=Thing&targetId=t2')
      .set(staff.auth)
      .expect(200);
    expect(byTarget.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('user lookup exposes id/username/status only', async () => {
    const u = await createUser(t);
    await t.http().get(`/v1/admin/users?q=${u.userId}`).set(u.auth).expect(403);
    const staff = await makeStaff(t, ['admin.reports.moderate']);
    const r = await t.http().get(`/v1/admin/users?q=${u.userId}`).set(staff.auth).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(Object.keys(r.body.items[0]).sort()).toEqual([
      'createdAt',
      'id',
      'nickname',
      'status',
      'username',
    ]);
    const byName = await t
      .http()
      .get(`/v1/admin/users?q=${u.username}`)
      .set(staff.auth)
      .expect(200);
    expect(byName.body.items[0].id).toBe(u.userId);
  });

  it('DELETE /me refuses with concrete lists while clubs, upcoming games or money are open', async () => {
    const owner = await createUser(t);
    const club = await t.prisma.club.create({
      data: {
        name: 'C',
        username: `c${owner.username}`,
        city: 'x',
        founderId: owner.userId,
        ownerId: owner.userId,
        preferredFormats: [],
      },
    });
    const game = await createGame(t, owner);
    const player = await createUser(t);
    await t.http().post(`/v1/games/${game.id}/join`).set(player.auth).send({}).expect(200);

    const blocked = await t.http().delete('/v1/me').set(owner.auth).expect(409);
    expect(blocked.body.error.code).toBe('CONFLICT');
    expect(blocked.body.error.details.ownedClubs.map((c: { id: string }) => c.id)).toEqual([
      club.id,
    ]);
    expect(blocked.body.error.details.upcomingGames.map((g: { id: string }) => g.id)).toEqual([
      game.id,
    ]);

    const owing = await t.http().delete('/v1/me').set(player.auth).expect(409);
    expect(owing.body.error.details.openObligations).toHaveLength(1);
    expect(owing.body.error.details.openObligations[0].outstandingMinor).toBe(1500);
    expect(
      (await t.http().get('/v1/me/deletion-check').set(player.auth).expect(200)).body
        .openObligations,
    ).toHaveLength(1);
    // nothing changed
    await t.http().get('/v1/me').set(player.auth).expect(200);

    // pending refund also blocks
    await t.prisma.paymentObligation.updateMany({
      where: { payerUserId: player.userId },
      data: { status: 'PAID', paidMinor: 1500, refundDueMinor: 500 },
    });
    const refund = await t.http().delete('/v1/me').set(player.auth).expect(409);
    expect(refund.body.error.details.pendingRefunds).toHaveLength(1);
    expect(refund.body.error.details.openObligations).toHaveLength(0);
  });

  it('DELETE /me anonymises the person but keeps official protocols and receipts', async () => {
    const g = await finishedGame(t);
    const me = g.home[0]!;
    const m = await t
      .http()
      .post(`/v1/games/${g.gameId}/matches`)
      .set(g.org.auth)
      .send({ homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId })
      .expect(201);
    await t
      .http()
      .post(`/v1/matches/${m.body.id}/events`)
      .set(g.org.auth)
      .send({ type: 'GOAL', playerId: me.userId })
      .expect(200);
    const cur = await t.http().get(`/v1/matches/${m.body.id}`).set(g.org.auth).expect(200);
    await t
      .http()
      .post(`/v1/matches/${m.body.id}/confirm`)
      .set(g.org.auth)
      .send({ version: cur.body.version })
      .expect(200);
    await t.prisma.paymentObligation.updateMany({
      where: { payerUserId: me.userId },
      data: { status: 'PAID', paidMinor: 1500 },
    });
    const receiptsBefore = await t.prisma.paymentObligation.count({
      where: { payerUserId: me.userId },
    });
    const post = await t.prisma.post.create({
      data: {
        authorId: me.userId,
        authorEntityId: me.userId,
        body: 'hi',
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
    const otherSession = await t
      .http()
      .post('/v1/auth/login')
      .send({ email: me.email, password: me.password })
      .expect(200);

    const res = await t.http().delete('/v1/me').set(me.auth).expect(200);
    expect(res.body.status).toBe('DELETED');

    const user = await t.prisma.user.findUniqueOrThrow({
      where: { id: me.userId },
      include: { profile: true },
    });
    expect(user.status).toBe('DELETED');
    expect(user.deletedAt).not.toBeNull();
    expect(user.profile).toMatchObject({
      nickname: 'Deleted user',
      username: null,
      dateOfBirth: null,
      city: null,
      bio: null,
      avatarId: null,
    });
    expect(await t.prisma.session.count({ where: { userId: me.userId, revokedAt: null } })).toBe(0);
    expect(await t.prisma.authIdentity.count({ where: { userId: me.userId } })).toBe(0);
    await t.http().get('/v1/me').set(me.auth).expect(401);
    await t
      .http()
      .get('/v1/me')
      .set({ Authorization: `Bearer ${otherSession.body.accessToken}` })
      .expect(401);
    await t
      .http()
      .post('/v1/auth/login')
      .send({ email: me.email, password: me.password })
      .expect(401);
    expect((await t.prisma.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe(
      'DELETED',
    );

    // official records survive; the identity inside them is "Deleted user"
    const match = await t.http().get(`/v1/matches/${m.body.id}`).expect(200);
    expect(match.body.status).toBe('CONFIRMED');
    expect(match.body.homeScore).toBe(1);
    expect(match.body.events[0].player.nickname).toBe('Deleted user');
    expect(
      await t.prisma.matchEvent.count({ where: { matchId: m.body.id, playerId: me.userId } }),
    ).toBe(1);
    expect(await t.prisma.paymentObligation.count({ where: { payerUserId: me.userId } })).toBe(
      receiptsBefore,
    );
    await t.http().get(`/v1/users/${me.userId}/stats`).expect(404);
    expect(
      await t.prisma.auditEvent.count({ where: { action: 'account.delete', targetId: me.userId } }),
    ).toBe(1);
  });
});
