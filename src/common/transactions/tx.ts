import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Prisma interactive-transaction client. Pass it down to keep related writes atomic. */
export type Tx = Prisma.TransactionClient;

/** Either the root client or a transaction client — for read helpers usable in both. */
export type Db = PrismaService | Tx;

/** Lock an Event row for the rest of the transaction (seat/hold/team-move serialisation). */
export async function lockEvent(tx: Tx, eventId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId}::uuid FOR UPDATE`;
}

/** Lock an obligation row (cash receipt serialisation). */
export async function lockObligation(tx: Tx, obligationId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "PaymentObligation" WHERE id = ${obligationId}::uuid FOR UPDATE`;
}

/** Postgres SQLSTATE from a Prisma/driver error, if present (e.g. 23P01 exclusion, 23505 unique). */
export function pgErrorCode(err: unknown): string | undefined {
  // Prefer the driver's SQLSTATE (meta.driverAdapterError.cause.originalCode) over Prisma's own P-codes.
  const e = err as {
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  } | null;
  const driver = e?.meta?.driverAdapterError?.cause?.originalCode;
  if (typeof driver === 'string' && /^[0-9A-Z]{5}$/.test(driver)) return driver;
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as Record<string, unknown>;
    if (typeof o.code === 'string' && /^[0-9A-Z]{5}$/.test(o.code)) return o.code;
    if (typeof o.originalCode === 'string' && /^[0-9A-Z]{5}$/.test(o.originalCode)) {
      return o.originalCode;
    }
    const meta = o.meta as Record<string, unknown> | undefined;
    const driver = meta?.driverAdapterError as Record<string, unknown> | undefined;
    const cause = driver?.cause as Record<string, unknown> | undefined;
    if (cause && typeof cause.originalCode === 'string') return cause.originalCode;
    if (meta && typeof meta.code === 'string' && /^[0-9A-Z]{5}$/.test(meta.code)) return meta.code;
    cur = o.cause ?? driver;
  }
  return undefined;
}

/** Prisma unique-violation (P2002) or SQLSTATE 23505. */
export function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') return true;
  return pgErrorCode(err) === '23505';
}
