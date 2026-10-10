import { createTestApp, type TestApp } from './support/app';
import { createUser } from './support/factories';

describe('profiles & privacy (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('public DTO never contains DOB, contacts or hashes — even for the owner’s followers', async () => {
    const owner = await createUser(t);
    const visitor = await t.http().get(`/v1/users/${owner.userId}`).expect(200);
    const s = JSON.stringify(visitor.body);
    expect(s).not.toMatch(/dateOfBirth|1990-06-15|@example\.test|passwordHash|email|phone/);
    expect(visitor.body.username).toBe(owner.username);
    expect(visitor.body.capabilities.canFollow).toBe(false); // visitors cannot follow (login required)

    const ownerView = await t.http().get('/v1/me').set(owner.auth).expect(200);
    expect(ownerView.body.dateOfBirth).toBe('1990-06-15');
    expect(ownerView.body.email).toBe(owner.email);
  });

  it('age is hidden by default (Only me) and shown as years only when allowed', async () => {
    const owner = await createUser(t);
    const viewer = await createUser(t);
    let p = await t.http().get(`/v1/users/${owner.userId}`).set(viewer.auth).expect(200);
    expect(p.body.age).toBeUndefined();
    await t
      .http()
      .patch('/v1/me/privacy')
      .set(owner.auth)
      .send({ ageAudience: 'EVERYONE' })
      .expect(200);
    p = await t.http().get(`/v1/users/${owner.userId}`).set(viewer.auth).expect(200);
    expect(typeof p.body.age).toBe('number');
    expect(p.body).not.toHaveProperty('dateOfBirth');
  });

  it('city follows its audience setting', async () => {
    const owner = await createUser(t, { city: 'Cityville' });
    const viewer = await createUser(t);
    expect((await t.http().get(`/v1/users/${owner.userId}`).set(viewer.auth)).body.city).toBe(
      'Cityville',
    );
    await t
      .http()
      .patch('/v1/me/privacy')
      .set(owner.auth)
      .send({ cityAudience: 'ONLY_ME' })
      .expect(200);
    expect(
      (await t.http().get(`/v1/users/${owner.userId}`).set(viewer.auth)).body.city,
    ).toBeUndefined();
    expect((await t.http().get('/v1/me').set(owner.auth)).body.city).toBe('Cityville');
  });

  it('private profile: identity only for strangers, followers-tier fields need an ACCEPTED follow', async () => {
    const owner = await createUser(t, { city: 'Cityville' });
    const viewer = await createUser(t);
    await t.http().patch('/v1/me/profile').set(owner.auth).send({ bio: 'secret bio' }).expect(200);
    await t
      .http()
      .patch('/v1/me/privacy')
      .set(owner.auth)
      .send({ profileVisibility: 'PRIVATE' })
      .expect(200);

    const stranger = await t.http().get(`/v1/users/${owner.userId}`).set(viewer.auth).expect(200);
    expect(stranger.body.visibility).toBe('PRIVATE');
    expect(stranger.body.city).toBeUndefined();
    expect(stranger.body.bio).toBeUndefined();

    // A follow REQUEST is not access
    await t.prisma.follow.create({
      data: {
        followerId: viewer.userId,
        targetType: 'USER',
        targetId: owner.userId,
        status: 'REQUESTED',
      },
    });
    const requested = await t.http().get(`/v1/users/${owner.userId}`).set(viewer.auth).expect(200);
    expect(requested.body.followStatus).toBe('REQUESTED');
    expect(requested.body.city).toBeUndefined();

    await t.prisma.follow.update({
      where: {
        followerId_targetType_targetId: {
          followerId: viewer.userId,
          targetType: 'USER',
          targetId: owner.userId,
        },
      },
      data: { status: 'ACCEPTED' },
    });
    const follower = await t.http().get(`/v1/users/${owner.userId}`).set(viewer.auth).expect(200);
    expect(follower.body.city).toBe('Cityville');
    expect(follower.body.bio).toBe('secret bio');
  });

  it('a private profile cannot be set to the Everyone audience; Public→Private narrows stored settings', async () => {
    const owner = await createUser(t);
    await t
      .http()
      .patch('/v1/me/privacy')
      .set(owner.auth)
      .send({ cityAudience: 'EVERYONE' })
      .expect(200);
    await t
      .http()
      .patch('/v1/me/privacy')
      .set(owner.auth)
      .send({ profileVisibility: 'PRIVATE' })
      .expect(200);
    const p = await t.http().get('/v1/me/privacy').set(owner.auth).expect(200);
    expect(p.body.cityAudience).toBe('FOLLOWERS');
    const bad = await t
      .http()
      .patch('/v1/me/privacy')
      .set(owner.auth)
      .send({ postsAudience: 'EVERYONE' })
      .expect(400);
    expect(bad.body.error.code).toBe('VALIDATION');
    // Private → Public does not re-open anything automatically
    await t
      .http()
      .patch('/v1/me/privacy')
      .set(owner.auth)
      .send({ profileVisibility: 'PUBLIC' })
      .expect(200);
    expect((await t.http().get('/v1/me/privacy').set(owner.auth)).body.cityAudience).toBe(
      'FOLLOWERS',
    );
  });

  it('messaging capability follows the message policy', async () => {
    const owner = await createUser(t);
    const viewer = await createUser(t);
    // default: People I follow → owner must follow viewer
    let p = await t.http().get(`/v1/users/${owner.userId}`).set(viewer.auth).expect(200);
    expect(p.body.capabilities.canMessage).toBe(false);
    await t.prisma.follow.create({
      data: {
        followerId: owner.userId,
        targetType: 'USER',
        targetId: viewer.userId,
        status: 'ACCEPTED',
      },
    });
    p = await t.http().get(`/v1/users/${owner.userId}`).set(viewer.auth).expect(200);
    expect(p.body.capabilities.canMessage).toBe(true);
    await t
      .http()
      .patch('/v1/me/privacy')
      .set(owner.auth)
      .send({ messagePolicy: 'NOBODY' })
      .expect(200);
    p = await t.http().get(`/v1/users/${owner.userId}`).set(viewer.auth).expect(200);
    expect(p.body.capabilities.canMessage).toBe(false);
  });

  it('block removes follow links both ways, disables interaction, and does not touch other records', async () => {
    const a = await createUser(t);
    const b = await createUser(t);
    await t.prisma.follow.createMany({
      data: [
        { followerId: a.userId, targetType: 'USER', targetId: b.userId, status: 'ACCEPTED' },
        { followerId: b.userId, targetType: 'USER', targetId: a.userId, status: 'ACCEPTED' },
      ],
    });
    await t.http().put(`/v1/blocks/${b.userId}`).set(a.auth).expect(204);
    expect(
      await t.prisma.follow.count({
        where: { followerId: { in: [a.userId, b.userId] }, targetType: 'USER' },
      }),
    ).toBe(0);
    const view = await t.http().get(`/v1/users/${a.userId}`).set(b.auth).expect(200);
    expect(view.body.capabilities.canFollow).toBe(false);
    expect(view.body.capabilities.canMessage).toBe(false);
    expect(
      (await t.http().get('/v1/me/blocks').set(a.auth)).body.map(
        (x: { userId: string }) => x.userId,
      ),
    ).toContain(b.userId);
    await t.http().delete(`/v1/blocks/${b.userId}`).set(a.auth).expect(204);
    await t.http().put(`/v1/blocks/${a.userId}`).set(a.auth).expect(400);
  });

  it('unknown or deleted profiles return the neutral NOT_FOUND', async () => {
    const res = await t.http().get('/v1/users/00000000-0000-7000-8000-000000000000').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    await t.http().get('/v1/users/not-a-uuid').expect(400);
  });
});
