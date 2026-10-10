import { validateEnv } from './env';

describe('validateEnv', () => {
  const ok = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
  };

  it('applies defaults', () => {
    const env = validateEnv(ok);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('parses provider client id lists (optional, trimmed, de-duplicated)', () => {
    expect(validateEnv(ok).GOOGLE_CLIENT_IDS).toEqual([]);
    const env = validateEnv({
      ...ok,
      GOOGLE_CLIENT_IDS: ' a.apps , b.apps,a.apps,',
      APPLE_CLIENT_IDS: '',
    });
    expect(env.GOOGLE_CLIENT_IDS).toEqual(['a.apps', 'b.apps']);
    expect(env.APPLE_CLIENT_IDS).toEqual([]);
  });

  it('rejects a short JWT secret and missing DATABASE_URL', () => {
    expect(() => validateEnv({ JWT_ACCESS_SECRET: 'short' })).toThrow(/Invalid environment/);
  });
});
