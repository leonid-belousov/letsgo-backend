process.env.GOOGLE_CLIENT_IDS = '';
process.env.APPLE_CLIENT_IDS = '';

import { createTestApp, type TestApp } from './support/app';
import { createUser } from './support/factories';
import { getNonce } from './auth-providers.support';

describe('Google / Apple sign-in - not configured (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it.each(['google', 'apple'])('POST /auth/%s answers 503 PROVIDER_NOT_CONFIGURED', async (p) => {
    const res = await t
      .http()
      .post(`/v1/auth/${p}`)
      .send({ idToken: 'x.y.z', nonce: 'n'.repeat(32) })
      .expect(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(res.body.error.message).toBe(
      `${p === 'google' ? 'Google' : 'Apple'} sign-in is not configured`,
    );
    expect(res.body.error.details.reason).toBe('PROVIDER_NOT_CONFIGURED');
    // no nonce needed to learn that it is unavailable
    await t.http().post(`/v1/auth/${p}`).send({ idToken: 'x.y.z' }).expect(503);
  });

  it('linking is 503 as well, and nonce issuing still works', async () => {
    const u = await createUser(t, { complete: false });
    const res = await t
      .http()
      .post('/v1/auth/link/google')
      .set(u.auth)
      .send({ idToken: 'x.y.z', nonce: 'n'.repeat(32) })
      .expect(503);
    expect(res.body.error.details.reason).toBe('PROVIDER_NOT_CONFIGURED');
    await getNonce(t);
  });
});
