import { pgErrorCode } from '../../common/transactions/tx';

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * PostgreSQL SQLSTATE behind a Prisma 7 (driver-adapter) error.
 *
 * `pgErrorCode` from the shared kernel returns Prisma's own top-level code first (e.g. P2039 for
 * an exclusion violation raised by `createMany`), because those also look like five characters.
 * Here the driver's original state wins.
 */
export function sqlState(err: unknown): string | undefined {
  const e = err as {
    meta?: {
      code?: unknown;
      driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } };
    };
    message?: unknown;
  } | null;
  const cause = e?.meta?.driverAdapterError?.cause;
  for (const c of [cause?.originalCode, cause?.code, e?.meta?.code]) {
    if (typeof c === 'string' && SQLSTATE.test(c) && !/^P\d{4}$/.test(c)) return c;
  }
  if (typeof e?.message === 'string') {
    const m = /Code: `([0-9A-Z]{5})`/.exec(e.message);
    if (m?.[1] && !/^P\d{4}$/.test(m[1])) return m[1];
  }
  const generic = pgErrorCode(err);
  return generic && !/^P\d{4}$/.test(generic) ? generic : undefined;
}

export const EXCLUSION_VIOLATION = '23P01';
