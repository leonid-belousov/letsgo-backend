import { randomBytes } from 'node:crypto';
import { ApiError } from '../src/common/errors';
import { AuthNonceService, NONCE_TTL_MS } from '../src/modules/auth/nonce.service';
import { sha256Hex } from '../src/infrastructure/security/password-hasher';
import { createTestApp, type TestApp } from './support/app';

describe('AuthNonceService (real PostgreSQL)', () => {
  let t: TestApp;
  let nonces: AuthNonceService;
  beforeAll(async () => {
    t = await createTestApp();
    nonces = t.app.get(AuthNonceService);
  });
  afterAll(() => t.close());

  const consume = (nonce: string): Promise<'ok' | string> =>
    t.prisma
      .$transaction((tx) => nonces.consume(tx, nonce))
      .then(() => 'ok' as const)
      .catch((e: unknown) => (e instanceof ApiError ? e.code : 'ERROR'));

  it('stores only the SHA-256 of a 256-bit nonce with a 10 minute TTL', async () => {
    const before = Date.now();
    const { nonce, expiresAt } = await nonces.issue();
    expect(Buffer.from(nonce, 'base64url')).toHaveLength(32);
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(NONCE_TTL_MS - 1000);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(NONCE_TTL_MS + 5000);
    const row = await t.prisma.authNonce.findUniqueOrThrow({
      where: { nonceHash: sha256Hex(nonce) },
    });
    expect(row.nonceHash).not.toContain(nonce);
    expect(row.usedAt).toBeNull();
  });

  it('is single use', async () => {
    const { nonce } = await nonces.issue();
    expect(await consume(nonce)).toBe('ok');
    expect(await consume(nonce)).toBe('UNAUTHENTICATED');
    const row = await t.prisma.authNonce.findUniqueOrThrow({
      where: { nonceHash: sha256Hex(nonce) },
    });
    expect(row.usedAt).not.toBeNull();
  });

  it('parallel consumption: exactly one of many succeeds', async () => {
    const { nonce } = await nonces.issue();
    const results = await Promise.all(Array.from({ length: 6 }, () => consume(nonce)));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'UNAUTHENTICATED')).toHaveLength(5);
  });

  it('unknown nonce is UNAUTHENTICATED, expired one is EXPIRED', async () => {
    expect(await consume(randomBytes(32).toString('base64url'))).toBe('UNAUTHENTICATED');
    const nonce = randomBytes(32).toString('base64url');
    await t.prisma.authNonce.create({
      data: { nonceHash: sha256Hex(nonce), expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await consume(nonce)).toBe('EXPIRED');
  });

  it('rolls the consumption back when the surrounding transaction fails', async () => {
    const { nonce } = await nonces.issue();
    await expect(
      t.prisma.$transaction(async (tx) => {
        await nonces.consume(tx, nonce);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await consume(nonce)).toBe('ok');
  });
});
