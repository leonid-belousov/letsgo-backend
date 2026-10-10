import { randomBytes } from 'node:crypto';
import type { TestApp } from './app';

/** Short random suffix so parallel tests never collide on unique data. */
export const uniq = (n = 8): string => randomBytes(n).toString('hex').slice(0, n);

export interface TestUser {
  userId: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  email: string;
  username: string;
  password: string;
  auth: { Authorization: string };
}

export const PASSWORD = 'correct-horse-battery';

/** Registers a synthetic user (no real personal data) and optionally completes the profile. */
export async function createUser(
  t: TestApp,
  opts: { complete?: boolean; nickname?: string; dob?: string; city?: string } = {},
): Promise<TestUser> {
  const suffix = uniq(10);
  const email = `user-${suffix}@example.test`;
  const res = await t
    .http()
    .post('/v1/auth/register')
    .send({ email, password: PASSWORD, deviceName: 'jest' });
  if (res.status !== 201)
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body as {
    userId: string;
    accessToken: string;
    refreshToken: string;
    sessionId: string;
  };
  const username = `u${suffix}`;
  const user: TestUser = {
    userId: body.userId,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    sessionId: body.sessionId,
    email,
    username,
    password: PASSWORD,
    auth: { Authorization: `Bearer ${body.accessToken}` },
  };
  if (opts.complete !== false) {
    const upd = await t
      .http()
      .patch('/v1/me/profile')
      .set(user.auth)
      .send({
        nickname: opts.nickname ?? `Player ${suffix.slice(0, 4)}`,
        username,
        dateOfBirth: opts.dob ?? '1990-06-15',
        city: opts.city ?? 'Testville',
      });
    if (upd.status !== 200)
      throw new Error(`profile failed: ${upd.status} ${JSON.stringify(upd.body)}`);
  }
  return user;
}

export function bearer(u: TestUser): { Authorization: string } {
  return u.auth;
}
