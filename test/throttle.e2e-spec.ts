describe('rate limiting and proxy trust', () => {
  const body = { email: 'nobody@example.test', password: 'wrong-password-1' };

  it('returns 429 RATE_LIMITED after the login budget is spent', async () => {
    const prev = process.env.THROTTLE_DISABLED;
    process.env.THROTTLE_DISABLED = 'false';
    try {
      const { createTestApp } = await import('./support/app');
      const t = await createTestApp();
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 12; i++) statuses.push((await t.http().post('/v1/auth/login').send(body)).status);
        expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
        expect(statuses.slice(10)).toEqual([429, 429]);
        const res = await t.http().post('/v1/auth/login').send(body).expect(429);
        expect(res.body.error.code).toBe('RATE_LIMITED');
      } finally {
        await t.close();
      }
    } finally {
      process.env.THROTTLE_DISABLED = prev;
    }
  });

  it('a spoofed X-Forwarded-For cannot dodge the limit unless the proxy is explicitly trusted', async () => {
    const prev = { d: process.env.THROTTLE_DISABLED, p: process.env.TRUST_PROXY };
    process.env.THROTTLE_DISABLED = 'false';
    delete process.env.TRUST_PROXY; // default: 'false'
    try {
      const { createTestApp } = await import('./support/app');
      const t = await createTestApp();
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 12; i++) {
          statuses.push((await t.http().post('/v1/auth/login').set('X-Forwarded-For', `203.0.113.${i + 1}`).send(body)).status);
        }
        expect(statuses.slice(10)).toEqual([429, 429]); // every spoofed address was counted as the real peer
      } finally {
        await t.close();
      }
    } finally {
      process.env.THROTTLE_DISABLED = prev.d;
      if (prev.p === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = prev.p;
    }
  });

  it('TRUST_PROXY=true is refused at startup (would trust any forwarded header)', async () => {
    const { validateEnv } = await import('../src/config/env');
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', JWT_ACCESS_SECRET: 'x'.repeat(32) };
    expect(() => validateEnv({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(validateEnv({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe('1');
    expect(validateEnv({ ...base, TRUST_PROXY: 'loopback,10.0.0.0/8' }).TRUST_PROXY).toContain('loopback');
  });
});
