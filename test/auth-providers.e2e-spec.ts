// ConfigModule.forRoot() validates process.env when AppModule is imported, so set these first.
process.env.GOOGLE_CLIENT_IDS =
  ' test-google-client.apps.example.test, other-google-client.example.test ';
process.env.APPLE_CLIENT_IDS = 'test.example.letsgo.ios';

import { randomBytes } from 'node:crypto';
import { PROVIDER_JWKS } from '../src/modules/auth/provider-verifier';
import { createTestApp, type TestApp } from './support/app';
import { createUser, PASSWORD, uniq } from './support/factories';
import {
  APPLE_AUD,
  APPLE_ISS,
  getNonce,
  GOOGLE_AUD,
  GOOGLE_ISS,
  makeKeyPairs,
  sha256Hex,
  signIdToken,
  unsignedToken,
  type KeyPairs,
} from './auth-providers.support';

type Body = Record<string, unknown> & {
  accessToken: string;
  userId: string;
  id: string;
  error: { code: string; details: { reason: string; field: string } };
};

const auth = (accessToken: string): { Authorization: string } => ({
  Authorization: `Bearer ${accessToken}`,
});

describe('Google / Apple sign-in (e2e, locally signed tokens, real PostgreSQL)', () => {
  let t: TestApp;
  let keys: KeyPairs;

  beforeAll(async () => {
    keys = await makeKeyPairs();
    t = await createTestApp((b) => b.overrideProvider(PROVIDER_JWKS).useValue(keys.jwks));
  });
  afterAll(async () => {
    await t.close();
  });

  const googleToken = async (
    nonce: string | undefined,
    o: Partial<Parameters<typeof signIdToken>[0]> = {},
  ): Promise<string> =>
    signIdToken({
      key: keys.google.privateKey,
      kid: keys.google.kid,
      iss: GOOGLE_ISS,
      aud: GOOGLE_AUD,
      nonce,
      ...o,
    });
  const appleToken = async (
    nonce: string | undefined,
    o: Partial<Parameters<typeof signIdToken>[0]> = {},
  ): Promise<string> =>
    signIdToken({
      key: keys.apple.privateKey,
      kid: keys.apple.kid,
      iss: APPLE_ISS,
      aud: APPLE_AUD,
      nonce,
      ...o,
    });

  const googleLogin = async (
    sub: string,
    o: Partial<Parameters<typeof signIdToken>[0]> = {},
  ): Promise<{ status: number; body: Body }> => {
    const { nonce } = await getNonce(t);
    const idToken = await googleToken(nonce, { sub, ...o });
    const res = await t.http().post('/v1/auth/google').send({ idToken, nonce });
    return { status: res.status, body: res.body as Body };
  };

  const countIdentities = (subject: string): Promise<number> =>
    t.prisma.authIdentity.count({ where: { subject } });

  describe('nonce', () => {
    it('issues a 256-bit single-use nonce valid for 10 minutes and stores only its hash', async () => {
      const before = Date.now();
      const { nonce, expiresAt } = await getNonce(t);
      expect(Buffer.from(nonce, 'base64url')).toHaveLength(32);
      const ttl = new Date(expiresAt).getTime() - before;
      expect(ttl).toBeGreaterThan(9 * 60_000);
      expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 5_000);
      const row = await t.prisma.authNonce.findUnique({ where: { nonceHash: sha256Hex(nonce) } });
      expect(row?.usedAt).toBeNull();
      expect(await t.prisma.authNonce.count({ where: { nonceHash: nonce } })).toBe(0);
      const other = await getNonce(t);
      expect(other.nonce).not.toBe(nonce);
    });
  });

  describe('sign-in', () => {
    it('Google: creates an account for a new subject, then signs in to the same one', async () => {
      const sub = `g-${uniq(12)}`;
      const first = await googleLogin(sub);
      expect(first.status).toBe(200);
      expect(first.body.accessToken).toEqual(expect.any(String));
      const me = await t
        .http()
        .get('/v1/me')
        .set(auth(first.body.accessToken as string))
        .expect(200);
      expect(me.body.profileComplete).toBe(false);

      const second = await googleLogin(sub);
      expect(second.status).toBe(200);
      expect(second.body.userId).toBe(first.body.userId);
      expect(await countIdentities(sub)).toBe(1);

      const identity = await t.prisma.authIdentity.findFirstOrThrow({
        where: { provider: 'GOOGLE', subject: sub },
      });
      expect(identity.verifiedAt).not.toBeNull();
      const created = await t.prisma.auditEvent.findMany({
        where: { action: 'auth.provider_login_created', targetId: identity.id },
      });
      expect(created).toHaveLength(1); // only the creation is audited, not the second sign-in
    });

    it('Google: also accepts the bare "accounts.google.com" issuer and an array audience', async () => {
      const { nonce } = await getNonce(t);
      const idToken = await googleToken(nonce, {
        iss: 'accounts.google.com',
        aud: ['unrelated.example.test', 'other-google-client.example.test'],
      });
      await t.http().post('/v1/auth/google').send({ idToken, nonce }).expect(200);
    });

    it('Apple: accepts the raw nonce and the sha256 hex of it; a new subject creates an account', async () => {
      const sub = `a-${uniq(12)}`;
      const n1 = await getNonce(t);
      const hashed = await appleToken(sha256Hex(n1.nonce), { sub });
      const a = await t
        .http()
        .post('/v1/auth/apple')
        .send({ idToken: hashed, nonce: n1.nonce })
        .expect(200);
      const n2 = await getNonce(t);
      const raw = await appleToken(n2.nonce, { sub });
      const b = await t
        .http()
        .post('/v1/auth/apple')
        .send({ idToken: raw, nonce: n2.nonce })
        .expect(200);
      expect(b.body.userId).toBe(a.body.userId);
      const ident = await t.prisma.authIdentity.findFirstOrThrow({
        where: { provider: 'APPLE', subject: sub },
      });
      expect(ident.userId).toBe(a.body.userId);
    });

    it('Google does not accept sha256(nonce) (only Apple does)', async () => {
      const { nonce } = await getNonce(t);
      const idToken = await googleToken(sha256Hex(nonce));
      const res = await t.http().post('/v1/auth/google').send({ idToken, nonce }).expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('a Google token is not accepted on the Apple endpoint (and vice versa)', async () => {
      const n1 = await getNonce(t);
      await t
        .http()
        .post('/v1/auth/apple')
        .send({ idToken: await googleToken(n1.nonce), nonce: n1.nonce })
        .expect(401);
      const n2 = await getNonce(t);
      await t
        .http()
        .post('/v1/auth/google')
        .send({ idToken: await appleToken(n2.nonce), nonce: n2.nonce })
        .expect(401);
    });

    it('does NOT merge by e-mail: a password user with the same e-mail claim is untouched', async () => {
      const owner = await createUser(t);
      const sub = `g-${uniq(12)}`;
      const { nonce } = await getNonce(t);
      const idToken = await googleToken(nonce, {
        sub,
        extra: { email: owner.email, email_verified: true },
      });
      const res = await t.http().post('/v1/auth/google').send({ idToken, nonce }).expect(200);
      expect(res.body.userId).not.toBe(owner.userId);
      const idents = await t.prisma.authIdentity.findMany({ where: { userId: owner.userId } });
      expect(idents.map((i) => i.provider)).toEqual(['EMAIL']);
      // the provider account carries no e-mail identity at all
      const theirs = await t.prisma.authIdentity.findMany({
        where: { userId: res.body.userId as string },
      });
      expect(theirs.map((i) => i.provider)).toEqual(['GOOGLE']);
      // and the owner still logs in with the password, as themselves
      const login = await t
        .http()
        .post('/v1/auth/login')
        .send({ email: owner.email, password: PASSWORD })
        .expect(200);
      expect(login.body.userId).toBe(owner.userId);
    });
  });

  describe('rejections (no account is ever created)', () => {
    const cases: [string, (nonce: string, sub: string) => Promise<string>][] = [
      [
        'wrong audience',
        (n, sub) => googleToken(n, { sub, aud: 'someone-elses-client.example.test' }),
      ],
      ['wrong issuer', (n, sub) => googleToken(n, { sub, iss: 'https://evil.example.test' })],
      ['apple issuer on google', (n, sub) => googleToken(n, { sub, iss: APPLE_ISS })],
      [
        'expired',
        (n, sub) =>
          googleToken(n, {
            sub,
            iat: Math.floor(Date.now() / 1000) - 7200,
            exp: Math.floor(Date.now() / 1000) - 3600,
          }),
      ],
      [
        'issued in the future',
        (n, sub) =>
          googleToken(n, {
            sub,
            iat: Math.floor(Date.now() / 1000) + 3600,
            exp: Math.floor(Date.now() / 1000) + 7200,
          }),
      ],
      [
        'bad signature (rogue key, same kid)',
        (n, sub) => googleToken(n, { sub, key: keys.rogue.privateKey }),
      ],
      ['unknown kid', (n, sub) => googleToken(n, { sub, kid: 'not-in-jwks' })],
      [
        'alg none',
        (n, sub) =>
          Promise.resolve(
            unsignedToken({
              iss: GOOGLE_ISS,
              aud: GOOGLE_AUD,
              sub,
              nonce: n,
              iat: Math.floor(Date.now() / 1000),
              exp: Math.floor(Date.now() / 1000) + 600,
            }),
          ),
      ],
      ['no subject claim', (n) => googleToken(n, { sub: null })],
      ['no nonce claim', (_n, sub) => googleToken(undefined, { sub })],
      [
        'nonce claim does not match',
        (_n, sub) => googleToken('a-different-nonce-value-xxxxxxxx', { sub }),
      ],
      ['garbage', () => Promise.resolve('not.a.jwt')],
    ];

    it.each(cases)('%s', async (_name, build) => {
      const sub = `g-${uniq(12)}`;
      const { nonce } = await getNonce(t);
      const idToken = await build(nonce, sub);
      const res = await t.http().post('/v1/auth/google').send({ idToken, nonce }).expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(await countIdentities(sub)).toBe(0);
      // a rejected token does not burn the nonce
      const row = await t.prisma.authNonce.findUniqueOrThrow({
        where: { nonceHash: sha256Hex(nonce) },
      });
      expect(row.usedAt).toBeNull();
    });

    it('HS256 (algorithm confusion) is rejected', async () => {
      const { SignJWT } = await import('jose');
      const { nonce } = await getNonce(t);
      const sub = `g-${uniq(12)}`;
      const idToken = await new SignJWT({ nonce })
        .setProtectedHeader({ alg: 'HS256', kid: keys.google.kid })
        .setIssuer(GOOGLE_ISS)
        .setAudience(GOOGLE_AUD)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(new TextEncoder().encode('an-hmac-secret-an-hmac-secret-123456'));
      await t.http().post('/v1/auth/google').send({ idToken, nonce }).expect(401);
      expect(await countIdentities(sub)).toBe(0);
    });

    it('a request without a nonce is a validation error (provider configured)', async () => {
      const idToken = await googleToken('whatever-whatever-whatever');
      const res = await t.http().post('/v1/auth/google').send({ idToken }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.details.field).toBe('nonce');
    });

    it('a nonce that was never issued is rejected', async () => {
      const nonce = randomBytes(32).toString('base64url');
      const sub = `g-${uniq(12)}`;
      const idToken = await googleToken(nonce, { sub });
      const res = await t.http().post('/v1/auth/google').send({ idToken, nonce }).expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(await countIdentities(sub)).toBe(0);
    });

    it('a replayed nonce is rejected (same token, and a new token with the same nonce)', async () => {
      const { nonce } = await getNonce(t);
      const sub = `g-${uniq(12)}`;
      const idToken = await googleToken(nonce, { sub });
      await t.http().post('/v1/auth/google').send({ idToken, nonce }).expect(200);
      const same = await t.http().post('/v1/auth/google').send({ idToken, nonce }).expect(401);
      expect(same.body.error.code).toBe('UNAUTHENTICATED');
      const other = await googleToken(nonce, { sub: `g-${uniq(12)}` });
      await t.http().post('/v1/auth/google').send({ idToken: other, nonce }).expect(401);
    });

    it('an expired nonce is 410 EXPIRED and creates nothing', async () => {
      const nonce = randomBytes(32).toString('base64url');
      await t.prisma.authNonce.create({
        data: { nonceHash: sha256Hex(nonce), expiresAt: new Date(Date.now() - 60_000) },
      });
      const sub = `g-${uniq(12)}`;
      const idToken = await googleToken(nonce, { sub });
      const res = await t.http().post('/v1/auth/google').send({ idToken, nonce }).expect(410);
      expect(res.body.error.code).toBe('EXPIRED');
      expect(await countIdentities(sub)).toBe(0);
    });

    it('two parallel sign-ins with one nonce: exactly one succeeds', async () => {
      const { nonce } = await getNonce(t);
      const a = await googleToken(nonce, { sub: `g-${uniq(12)}` });
      const b = await googleToken(nonce, { sub: `g-${uniq(12)}` });
      const results = await Promise.all([
        t.http().post('/v1/auth/google').send({ idToken: a, nonce }),
        t.http().post('/v1/auth/google').send({ idToken: b, nonce }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it('two parallel first sign-ins of one subject (different nonces) end in one account', async () => {
      const sub = `g-${uniq(12)}`;
      const [n1, n2] = await Promise.all([getNonce(t), getNonce(t)]);
      const [t1, t2] = await Promise.all([
        googleToken(n1.nonce, { sub }),
        googleToken(n2.nonce, { sub }),
      ]);
      const [r1, r2] = await Promise.all([
        t.http().post('/v1/auth/google').send({ idToken: t1, nonce: n1.nonce }),
        t.http().post('/v1/auth/google').send({ idToken: t2, nonce: n2.nonce }),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r1.body.userId).toBe(r2.body.userId);
      expect(await countIdentities(sub)).toBe(1);
    });
  });

  describe('linking to an existing account', () => {
    const link = async (
      accessToken: string,
      provider: 'google' | 'apple',
      sub: string,
    ): Promise<{ status: number; body: Body }> => {
      const { nonce } = await getNonce(t);
      const idToken =
        provider === 'google'
          ? await googleToken(nonce, { sub })
          : await appleToken(nonce, { sub });
      const res = await t
        .http()
        .post(`/v1/auth/link/${provider}`)
        .set(auth(accessToken))
        .send({ idToken, nonce });
      return { status: res.status, body: res.body as Body };
    };

    it('requires authentication', async () => {
      const { nonce } = await getNonce(t);
      const idToken = await googleToken(nonce);
      await t.http().post('/v1/auth/link/google').send({ idToken, nonce }).expect(401);
      await t.http().get('/v1/auth/identities').expect(401);
    });

    it('links explicitly, lists without subjects, signs in as the same user, and audits', async () => {
      const u = await createUser(t);
      const sub = `g-${uniq(12)}`;
      const res = await link(u.accessToken, 'google', sub);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        provider: 'GOOGLE',
        linkedAt: expect.any(String),
        hasPassword: false,
        canUnlink: true,
      });

      const list = await t.http().get('/v1/auth/identities').set(u.auth).expect(200);
      expect(list.body.map((i: { provider: string }) => i.provider).sort()).toEqual([
        'EMAIL',
        'GOOGLE',
      ]);
      const text = JSON.stringify(list.body);
      expect(text).not.toContain(sub);
      expect(text).not.toContain(u.email);
      expect(text).not.toMatch(/subject|passwordHash|scrypt|token/i);
      const email = list.body.find((i: { provider: string }) => i.provider === 'EMAIL');
      expect(email).toMatchObject({ hasPassword: true, canUnlink: true });

      // provider sign-in now lands on this very account
      const login = await googleLogin(sub);
      expect(login.status).toBe(200);
      expect(login.body.userId).toBe(u.userId);

      const audit = await t.prisma.auditEvent.findMany({
        where: { action: 'auth.provider_linked', actorId: u.userId },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.targetId).toBe(res.body.id);
      expect(audit[0]?.requestId).toEqual(expect.any(String));
    });

    it('links Apple too; a second identity of the same provider is a 409', async () => {
      const u = await createUser(t);
      expect((await link(u.accessToken, 'apple', `a-${uniq(12)}`)).status).toBe(201);
      const again = await link(u.accessToken, 'apple', `a-${uniq(12)}`);
      expect(again.status).toBe(409);
      expect(again.body.error.details.reason).toBe('PROVIDER_ALREADY_LINKED');
    });

    it('linking the same identity twice is 409 and changes nothing', async () => {
      const u = await createUser(t);
      const sub = `g-${uniq(12)}`;
      await link(u.accessToken, 'google', sub);
      const again = await link(u.accessToken, 'google', sub);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('CONFLICT');
      expect(await countIdentities(sub)).toBe(1);
    });

    it('a subject that belongs to another account is 409 - never stolen', async () => {
      const owner = await createUser(t);
      const thief = await createUser(t);
      const sub = `g-${uniq(12)}`;
      expect((await link(owner.accessToken, 'google', sub)).status).toBe(201);
      const res = await link(thief.accessToken, 'google', sub);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.details.reason).toBe('IDENTITY_LINKED_TO_ANOTHER_ACCOUNT');
      const ident = await t.prisma.authIdentity.findFirstOrThrow({ where: { subject: sub } });
      expect(ident.userId).toBe(owner.userId);
      // also for a provider-created account
      const created = await googleLogin(`g-${uniq(12)}`);
      const sub2 = (
        await t.prisma.authIdentity.findFirstOrThrow({
          where: { userId: created.body.userId as string },
        })
      ).subject;
      const nonce = await getNonce(t);
      const idToken = await googleToken(nonce.nonce, { sub: sub2 });
      await t
        .http()
        .post('/v1/auth/link/google')
        .set(thief.auth)
        .send({ idToken, nonce: nonce.nonce })
        .expect(409);
    });

    it('a rolled-back link (409) does not burn the nonce; a used nonce cannot link again', async () => {
      const u = await createUser(t);
      const { nonce } = await getNonce(t);
      const idToken = await googleToken(nonce, { sub: `g-${uniq(12)}` });
      await t.http().post('/v1/auth/link/google').set(u.auth).send({ idToken, nonce }).expect(201);
      const u2 = await createUser(t);
      const idToken2 = await googleToken(nonce, { sub: `g-${uniq(12)}` });
      await t
        .http()
        .post('/v1/auth/link/google')
        .set(u2.auth)
        .send({ idToken: idToken2, nonce })
        .expect(401);
    });

    describe('unlink', () => {
      it('cannot remove the last usable login method (provider-only account)', async () => {
        const login = await googleLogin(`g-${uniq(12)}`);
        const tokens = login.body as { accessToken: string };
        const list = await t
          .http()
          .get('/v1/auth/identities')
          .set(auth(tokens.accessToken))
          .expect(200);
        expect(list.body).toHaveLength(1);
        expect(list.body[0].canUnlink).toBe(false);
        const res = await t
          .http()
          .delete(`/v1/auth/identities/${list.body[0].id as string}`)
          .set(auth(tokens.accessToken))
          .expect(409);
        expect(res.body.error.code).toBe('CONFLICT');
        expect(res.body.error.details.reason).toBe('LAST_LOGIN_METHOD');
        expect(
          await t.prisma.authIdentity.count({ where: { id: list.body[0].id as string } }),
        ).toBe(1);
      });

      it('can unlink a provider when a password identity remains, with audit', async () => {
        const u = await createUser(t);
        const sub = `g-${uniq(12)}`;
        const linked = await link(u.accessToken, 'google', sub);
        await t
          .http()
          .delete(`/v1/auth/identities/${linked.body.id as string}`)
          .set(u.auth)
          .expect(204);
        expect(await countIdentities(sub)).toBe(0);
        const audit = await t.prisma.auditEvent.findMany({
          where: { action: 'auth.provider_unlinked', actorId: u.userId },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]?.metadata).toEqual({ provider: 'GOOGLE' });
        // signing in with it now creates a brand-new account rather than reviving the old link
        const again = await googleLogin(sub);
        expect(again.body.userId).not.toBe(u.userId);
      });

      it('can unlink the password identity once a provider is linked - then the provider is the last', async () => {
        const u = await createUser(t);
        const google = await link(u.accessToken, 'google', `g-${uniq(12)}`);
        const list = await t.http().get('/v1/auth/identities').set(u.auth).expect(200);
        const email = list.body.find((i: { provider: string }) => i.provider === 'EMAIL') as {
          id: string;
        };
        await t.http().delete(`/v1/auth/identities/${email.id}`).set(u.auth).expect(204);
        const last = await t
          .http()
          .delete(`/v1/auth/identities/${google.body.id as string}`)
          .set(u.auth)
          .expect(409);
        expect(last.body.error.details.reason).toBe('LAST_LOGIN_METHOD');
      });

      it('parallel unlinks cannot remove both methods', async () => {
        const u = await createUser(t);
        const google = await link(u.accessToken, 'google', `g-${uniq(12)}`);
        const list = await t.http().get('/v1/auth/identities').set(u.auth).expect(200);
        const email = list.body.find((i: { provider: string }) => i.provider === 'EMAIL') as {
          id: string;
        };
        const results = await Promise.all([
          t.http().delete(`/v1/auth/identities/${email.id}`).set(u.auth),
          t
            .http()
            .delete(`/v1/auth/identities/${google.body.id as string}`)
            .set(u.auth),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
        expect(await t.prisma.authIdentity.count({ where: { userId: u.userId } })).toBe(1);
      });

      it("another user's identity id is 404 and untouched; malformed id is 400", async () => {
        const a = await createUser(t);
        const b = await createUser(t);
        const linked = await link(a.accessToken, 'google', `g-${uniq(12)}`);
        await t
          .http()
          .delete(`/v1/auth/identities/${linked.body.id as string}`)
          .set(b.auth)
          .expect(404);
        expect(await t.prisma.authIdentity.count({ where: { id: linked.body.id as string } })).toBe(
          1,
        );
        await t.http().delete('/v1/auth/identities/not-a-uuid').set(b.auth).expect(400);
        await t
          .http()
          .delete(`/v1/auth/identities/${linked.body.id as string}`)
          .expect(401);
      });
    });
  });

  describe('audit hygiene', () => {
    it('audit rows never contain token text, nonces or provider subjects', async () => {
      const u = await createUser(t);
      const sub = `g-${uniq(12)}`;
      const { nonce } = await getNonce(t);
      const idToken = await googleToken(nonce, {
        sub,
        extra: { email: 'secret-mail@example.test' },
      });
      const linked = await t
        .http()
        .post('/v1/auth/link/google')
        .set(u.auth)
        .send({ idToken, nonce })
        .expect(201);
      await t
        .http()
        .delete(`/v1/auth/identities/${linked.body.id as string}`)
        .set(u.auth)
        .expect(204);
      const created = await googleLogin(`g-${uniq(12)}`);

      const rows = await t.prisma.auditEvent.findMany({
        where: {
          action: {
            in: ['auth.provider_linked', 'auth.provider_unlinked', 'auth.provider_login_created'],
          },
          actorId: { in: [u.userId, created.body.userId as string] },
        },
      });
      expect(rows.length).toBeGreaterThanOrEqual(3);
      const dump = JSON.stringify(rows);
      for (const secret of [
        idToken,
        nonce,
        sub,
        'secret-mail@example.test',
        idToken.split('.')[1] ?? 'x',
      ]) {
        expect(dump).not.toContain(secret);
      }
      expect(dump).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no JWT-looking string at all
    });
  });
});
