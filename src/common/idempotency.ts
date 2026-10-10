/**
 * Mutating operations that must not double-apply (cash received, create club/
 * game/booking, invitation replies, join, publish) accept this header.
 * Storage and enforcement land with the first vertical slice.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
