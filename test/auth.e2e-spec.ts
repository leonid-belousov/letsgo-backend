import { createTestApp, type TestApp } from './support/app';
import { createUser, PASSWORD, uniq } from './support/factories';

describe('auth (e2e, real PostgreSQL)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('registers without any OTP step and returns a device session', async () => {
    const email = `reg-${uniq()}@example.test`;
    const res = await t
      .http()
      .post('/v1/auth/register')
      .send({ email, password: PASSWORD, deviceName: 'Pixel' })
      .expect(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    const me = await t
      .http()
      .get('/v1/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
    expect(me.body.email).toBe(email);
    expect(me.body.profileComplete).toBe(false);
    // never leaks credentials
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|scrypt/);
  });

  it('rejects a duplicate contact (case-insensitive e-mail)', async () => {
    const u = await createUser(t, { complete: false });
    const res = await t
      .http()
      .post('/v1/auth/register')
      .send({ email: u.email.toUpperCase(), password: PASSWORD })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects a duplicate username (case-insensitive) with a field error', async () => {
    const a = await createUser(t);
    const b = await createUser(t, { complete: false });
    const res = await t
      .http()
      .patch('/v1/me/profile')
      .set(b.auth)
      .send({ username: a.username.toUpperCase() })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details.field).toBe('username');
  });

  it('logs in with phone or e-mail + password and refuses wrong passwords', async () => {
    const phone = `+9955${Math.floor(10000000 + Math.random() * 89999999)}`;
    await t.http().post('/v1/auth/register').send({ phone, password: PASSWORD }).expect(201);
    await t.http().post('/v1/auth/login').send({ phone, password: PASSWORD }).expect(200);
    const bad = await t
      .http()
      .post('/v1/auth/login')
      .send({ phone, password: 'wrong-password-1' })
      .expect(401);
    expect(bad.body.error.code).toBe('UNAUTHENTICATED');
    // knowing someone's phone without the password never authenticates
    await t
      .http()
      .post('/v1/auth/login')
      .send({ phone: '+995000000001', password: PASSWORD })
      .expect(401);
  });

  it('validates input: short password, bad phone format', async () => {
    const a = await t
      .http()
      .post('/v1/auth/register')
      .send({ email: `x-${uniq()}@example.test`, password: 'short' })
      .expect(400);
    expect(a.body.error.code).toBe('VALIDATION');
    await t
      .http()
      .post('/v1/auth/register')
      .send({ phone: '12345', password: PASSWORD })
      .expect(400);
  });

  it('rotates refresh tokens and revokes the session when an old one is replayed', async () => {
    const u = await createUser(t, { complete: false });
    const r1 = await t
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: u.refreshToken })
      .expect(200);
    expect(r1.body.refreshToken).not.toBe(u.refreshToken);
    // replay of the rotated-out token = theft signal
    await t.http().post('/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(401);
    // the whole session is now dead, including the freshly issued token
    await t
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: r1.body.refreshToken })
      .expect(401);
    await t.http().get('/v1/me').set('Authorization', `Bearer ${r1.body.accessToken}`).expect(401);
  });

  it('lists sessions, revokes one, and logout-all kills every device', async () => {
    const u = await createUser(t, { complete: false });
    const second = await t
      .http()
      .post('/v1/auth/login')
      .send({ email: u.email, password: PASSWORD, deviceName: 'iPad' })
      .expect(200);
    const list = await t.http().get('/v1/auth/sessions').set(u.auth).expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    await t.http().delete(`/v1/auth/sessions/${second.body.sessionId}`).set(u.auth).expect(204);
    await t
      .http()
      .get('/v1/me')
      .set('Authorization', `Bearer ${second.body.accessToken}`)
      .expect(401); // revoked = immediate

    const third = await t
      .http()
      .post('/v1/auth/login')
      .send({ email: u.email, password: PASSWORD })
      .expect(200);
    const all = await t.http().post('/v1/auth/logout-all').set(u.auth).expect(200);
    expect(all.body.revoked).toBeGreaterThanOrEqual(2);
    await t.http().get('/v1/me').set(u.auth).expect(401);
    await t
      .http()
      .get('/v1/me')
      .set('Authorization', `Bearer ${third.body.accessToken}`)
      .expect(401);
  });

  it('cannot revoke another user’s session', async () => {
    const a = await createUser(t, { complete: false });
    const b = await createUser(t, { complete: false });
    await t.http().delete(`/v1/auth/sessions/${b.sessionId}`).set(a.auth).expect(404);
    await t.http().get('/v1/me').set(b.auth).expect(200);
  });

  it('logout revokes only the current session; change-password revokes the others', async () => {
    const u = await createUser(t, { complete: false });
    const other = await t
      .http()
      .post('/v1/auth/login')
      .send({ email: u.email, password: PASSWORD })
      .expect(200);
    await t
      .http()
      .post('/v1/auth/change-password')
      .set(u.auth)
      .send({ currentPassword: PASSWORD, newPassword: 'another-long-password' })
      .expect(204);
    await t
      .http()
      .get('/v1/me')
      .set('Authorization', `Bearer ${other.body.accessToken}`)
      .expect(401);
    await t.http().post('/v1/auth/login').send({ email: u.email, password: PASSWORD }).expect(401);
    await t
      .http()
      .post('/v1/auth/login')
      .send({ email: u.email, password: 'another-long-password' })
      .expect(200);
    await t.http().post('/v1/auth/logout').set(u.auth).expect(204);
    await t.http().get('/v1/me').set(u.auth).expect(401);
  });

  it('requires authentication and rejects tampered tokens', async () => {
    await t.http().get('/v1/me').expect(401);
    const u = await createUser(t, { complete: false });
    await t
      .http()
      .get('/v1/me')
      .set('Authorization', `Bearer ${u.accessToken.slice(0, -3)}abc`)
      .expect(401);
  });

  it('provider sign-in refuses honestly while unconfigured (no fake success)', async () => {
    const res = await t
      .http()
      .post('/v1/auth/google')
      .send({ idToken: 'x'.repeat(20) })
      .expect(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('completes the profile once, grants New joiner, honours optimistic version', async () => {
    const u = await createUser(t, { complete: false });
    const me0 = await t.http().get('/v1/me').set(u.auth).expect(200);
    const upd = await t
      .http()
      .patch('/v1/me/profile')
      .set(u.auth)
      .send({
        nickname: 'Ada',
        username: u.username,
        dateOfBirth: '1991-02-03',
        city: 'Testville',
        version: me0.body.version,
      })
      .expect(200);
    expect(upd.body.profileComplete).toBe(true);
    const stale = await t
      .http()
      .patch('/v1/me/profile')
      .set(u.auth)
      .send({ bio: 'x', version: me0.body.version })
      .expect(409);
    expect(stale.body.error.code).toBe('VERSION_CHANGED');
    const achievements = await t.prisma.achievement.count({
      where: { recipientId: u.userId, type: 'NEW_JOINER' },
    });
    expect(achievements).toBe(1);
    await t.http().patch('/v1/me/profile').set(u.auth).send({ bio: 'hello' }).expect(200);
    expect(
      await t.prisma.achievement.count({ where: { recipientId: u.userId, type: 'NEW_JOINER' } }),
    ).toBe(1);
  });

  it('support-assisted recovery: request → staff approval → single-use token', async () => {
    const u = await createUser(t, { complete: false });
    await t
      .http()
      .post('/v1/auth/recovery/request')
      .send({ email: u.email, message: 'lost password' })
      .expect(202);
    // unknown contact is indistinguishable
    await t
      .http()
      .post('/v1/auth/recovery/request')
      .send({ email: `nobody-${uniq()}@example.test` })
      .expect(202);
    const c = await t.prisma.accountRecoveryCase.findFirstOrThrow({ where: { userId: u.userId } });
    await t
      .http()
      .post('/v1/auth/recovery/redeem')
      .send({ token: 'not-a-real-token-value', newPassword: 'brand-new-password' })
      .expect(401);
    // approval is a staff action tested in admin.e2e-spec; here only the token contract is proven
    expect(c.status).toBe('OPEN');
    expect(c.tokenHash).toBeNull();
  });
});
