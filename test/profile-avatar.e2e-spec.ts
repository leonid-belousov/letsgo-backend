import { createTestApp, type TestApp } from './support/app';
import { createUser } from './support/factories';
import { uploadPhoto } from './social-helpers';

describe('profile avatar', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('attaches an own READY photo, exposes it, and can remove it', async () => {
    const u = await createUser(t);
    const media = await uploadPhoto(t, u);
    const res = await t
      .http()
      .patch('/v1/me/profile')
      .set(u.auth)
      .send({ avatarId: media })
      .expect(200);
    expect(res.body.avatarId).toBe(media);
    const me = await t.http().get('/v1/me').set(u.auth).expect(200);
    expect(me.body.avatarId).toBe(media);
    // anyone who may see the profile may fetch the avatar variant
    const other = await createUser(t);
    await t.http().get(`/v1/media/${media}/url?variant=thumb`).set(other.auth).expect(200);
    const cleared = await t
      .http()
      .patch('/v1/me/profile')
      .set(u.auth)
      .send({ avatarId: null })
      .expect(200);
    expect(cleared.body.avatarId).toBeNull();
  });

  it("refuses someone else's media and unknown ids like a missing one", async () => {
    const owner = await createUser(t);
    const thief = await createUser(t);
    const media = await uploadPhoto(t, owner);
    const res = await t
      .http()
      .patch('/v1/me/profile')
      .set(thief.auth)
      .send({ avatarId: media })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.details.field).toBe('avatarId');
    await t
      .http()
      .patch('/v1/me/profile')
      .set(thief.auth)
      .send({ avatarId: '01a0f25f-0000-7000-8000-000000000000' })
      .expect(400);
    await t.http().patch('/v1/me/profile').set(thief.auth).send({ avatarId: 'nope' }).expect(400);
  });
});
