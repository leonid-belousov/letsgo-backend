import type { MediaKind, Prisma } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { lockObligation, type Db, type Tx } from '../../common/transactions/tx';

/** 'YYYY-MM-DD' -> Date at UTC midnight (the @db.Date convention). */
export function parseDate(s: string): Date {
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new ApiError(ErrorCode.VALIDATION, 'Invalid calendar date', { value: s });
  }
  return d;
}

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new ApiError(ErrorCode.VALIDATION, 'Unknown timezone', { field: 'timezone' });
  }
}

/**
 * A media file used by the tournament (logo, document, sponsor material) must be a READY asset
 * of an allowed kind that belongs to the acting person.
 */
export async function assertReadyMedia(
  db: Db,
  mediaId: string,
  ownerId: string,
  kinds: MediaKind[],
  field: string,
): Promise<void> {
  const m = await db.mediaAsset.findUnique({
    where: { id: mediaId },
    select: { ownerId: true, kind: true, status: true },
  });
  if (!m || m.ownerId !== ownerId) {
    throw new ApiError(ErrorCode.VALIDATION, 'Unknown media file', { field });
  }
  if (m.status !== 'READY') {
    throw new ApiError(ErrorCode.UPLOAD_FAILED, 'The file is not ready yet', { field });
  }
  if (!kinds.includes(m.kind)) {
    throw new ApiError(ErrorCode.VALIDATION, 'This kind of file is not allowed here', { field });
  }
}

/**
 * Tournament obligations that stop being owed (cancelled tournament, withdrawn/removed club or
 * player): unpaid ones vanish (CANCELLED, no debt); anything already paid becomes REFUND_DUE via
 * an immutable Adjustment - never "refunded" (cash goes back by hand). Mirrors the games flow.
 */
export async function settleObligations(
  tx: Tx,
  where: Prisma.PaymentObligationWhereInput,
  actorId: string,
  reason: string,
): Promise<{ cancelled: number; refundDue: number }> {
  const scope: Prisma.PaymentObligationWhereInput = {
    AND: [where, { tournamentId: { not: null }, status: { not: 'CANCELLED' } }],
  };
  const unpaid = await tx.paymentObligation.updateMany({
    where: { AND: [scope, { paidMinor: 0 }] },
    data: { status: 'CANCELLED', version: { increment: 1 } },
  });
  const paid = await tx.paymentObligation.findMany({
    where: { AND: [scope, { paidMinor: { gt: 0 } }] },
  });
  for (const ob of paid) {
    await lockObligation(tx, ob.id);
    const due = ob.paidMinor - ob.refundDueMinor - ob.refundedMinor;
    if (due > 0) {
      await tx.adjustment.create({
        data: { obligationId: ob.id, type: 'REFUND_DUE', deltaMinor: due, reason, actorId },
      });
    }
    await tx.paymentObligation.update({
      where: { id: ob.id },
      data: {
        status: 'CANCELLED',
        refundDueMinor: { increment: Math.max(due, 0) },
        version: { increment: 1 },
      },
    });
  }
  return { cancelled: unpaid.count, refundDue: paid.length };
}

/** Stable, order-independent id list for `IN` filters. */
export const uniqueIds = (ids: (string | null | undefined)[]): string[] => [
  ...new Set(ids.filter((x): x is string => typeof x === 'string')),
];
