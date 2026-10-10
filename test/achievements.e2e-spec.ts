import { createTestApp, type TestApp } from './support/app';
import { createUser } from './support/factories';
import { finishedGame, makeStaff } from './support/results';

describe('achievements (real PostgreSQL)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('lists awards honouring the owner audience; hidden gives no list', async () => {
    const owner = await createUser(t);
    const viewer = await createUser(t);
    // NEW_JOINER is created when the profile is completed
    const open = await t
      .http()
      .get(`/v1/users/${owner.userId}/achievements`)
      .set(viewer.auth)
      .expect(200);
    expect(open.body.hidden).toBe(false);
    expect(open.body.items.map((i: { type: string }) => i.type)).toContain('NEW_JOINER');
    await t.prisma.privacyPolicy.update({
      where: { userId: owner.userId },
      data: { awardsAudience: 'ONLY_ME' },
    });
    const hidden = await t
      .http()
      .get(`/v1/users/${owner.userId}/achievements`)
      .set(viewer.auth)
      .expect(200);
    expect(hidden.body).toEqual({ userId: owner.userId, hidden: true });
    const own = await t
      .http()
      .get(`/v1/users/${owner.userId}/achievements`)
      .set(owner.auth)
      .expect(200);
    expect(own.body.hidden).toBe(false);
  });

  it('staff grants and revokes with reason; audited; trophies feed stats; a club award stays labelled', async () => {
    const g = await finishedGame(t);
    const p = g.home[0]!;
    const m = await t
      .http()
      .post(`/v1/games/${g.gameId}/matches`)
      .set(g.org.auth)
      .send({ homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId, homeScore: 1, awayScore: 0 })
      .expect(201);
    const staff = await makeStaff(t, ['admin.achievements.grant']);
    const body = {
      recipientId: p.userId,
      type: 'TROPHY',
      reason: 'Won the cup final',
      sourceMatchId: m.body.id,
    };
    await t.http().post('/v1/admin/achievements').set(p.auth).send(body).expect(403);
    // unconfirmed match cannot back an award
    await t.http().post('/v1/admin/achievements').set(staff.auth).send(body).expect(400);
    await t
      .http()
      .post(`/v1/matches/${m.body.id}/confirm`)
      .set(g.org.auth)
      .send({ version: m.body.version })
      .expect(200);
    await t
      .http()
      .post('/v1/admin/achievements')
      .set(staff.auth)
      .send({ ...body, reason: '' })
      .expect(400);
    await t
      .http()
      .post('/v1/admin/achievements')
      .set(staff.auth)
      .send({ ...body, type: 'NEW_JOINER' })
      .expect(400);
    const granted = await t
      .http()
      .post('/v1/admin/achievements')
      .set(staff.auth)
      .send(body)
      .expect(200);
    expect(granted.body.type).toBe('TROPHY');
    await t.http().post('/v1/admin/achievements').set(staff.auth).send(body).expect(409); // same activity twice
    let stats = await t.http().get(`/v1/users/${p.userId}/stats`).set(p.auth).expect(200);
    expect(stats.body.trophies).toBe(1);
    expect(
      await t.prisma.auditEvent.count({
        where: { action: 'achievement.grant', targetId: granted.body.id },
      }),
    ).toBe(1);

    // club awards are labelled and are not revocable by platform staff
    const club = await t.prisma.achievement.create({
      data: { type: 'CLUB_AWARD', recipientId: p.userId, title: 'Best clubman' },
    });
    const list = await t
      .http()
      .get(`/v1/users/${p.userId}/achievements`)
      .set(g.org.auth)
      .expect(200);
    expect(list.body.items.find((i: { id: string }) => i.id === club.id).isClubAward).toBe(true);
    await t
      .http()
      .post(`/v1/admin/achievements/${club.id}/revoke`)
      .set(staff.auth)
      .send({ reason: 'no way' })
      .expect(409);

    await t
      .http()
      .post(`/v1/admin/achievements/${granted.body.id}/revoke`)
      .set(staff.auth)
      .send({ reason: 'Granted by mistake' })
      .expect(200);
    stats = await t.http().get(`/v1/users/${p.userId}/stats`).set(p.auth).expect(200);
    expect(stats.body.trophies).toBe(0);
    expect(
      await t.prisma.auditEvent.count({
        where: { action: 'achievement.revoke', targetId: granted.body.id },
      }),
    ).toBe(1);
  });

  it('a post never creates a system achievement', async () => {
    const u = await createUser(t);
    const before = await t.prisma.achievement.count({ where: { recipientId: u.userId } });
    await t.prisma.post.create({
      data: {
        authorId: u.userId,
        authorEntityId: u.userId,
        body: 'FAIR_PLAY!',
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
    expect(await t.prisma.achievement.count({ where: { recipientId: u.userId } })).toBe(before);
  });
});
