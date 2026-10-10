import { Injectable } from '@nestjs/common';
import { ApiError, ErrorCode } from '../../common/errors';
import { Clock } from '../../common/time/clock';
import type { Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { randomSecret, sha256Hex } from '../../infrastructure/security/password-hasher';

export const NONCE_TTL_MS = 10 * 60_000;
const PURGE_AFTER_MS = 24 * 3_600_000;

/**
 * Server-issued, single-use nonces that bind a Google/Apple ID token to one sign-in attempt
 * (replay protection). Only the SHA-256 of a nonce is stored.
 */
@Injectable()
export class AuthNonceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async issue(): Promise<{ nonce: string; expiresAt: Date }> {
    const now = this.clock.now();
    const nonce = randomSecret(32); // 256 bits
    const expiresAt = new Date(now.getTime() + NONCE_TTL_MS);
    await this.prisma.authNonce.create({ data: { nonceHash: sha256Hex(nonce), expiresAt } });
    // Housekeeping: drop nonces that expired long ago (indexed range delete, best effort).
    await this.prisma.authNonce
      .deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - PURGE_AFTER_MS) } } })
      .catch(() => undefined);
    return { nonce, expiresAt };
  }

  /**
   * Atomically consumes the nonce inside the caller's transaction. Exactly one of any number of
   * concurrent callers succeeds; a concurrent loser blocks on the row lock, then matches no row.
   * Unknown / already used ⇒ 401 UNAUTHENTICATED, expired ⇒ 410 EXPIRED.
   */
  async consume(tx: Tx, nonce: string): Promise<void> {
    const hash = sha256Hex(nonce);
    const now = this.clock.now();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "AuthNonce" SET "usedAt" = ${now}
      WHERE "nonceHash" = ${hash} AND "usedAt" IS NULL AND "expiresAt" > ${now}
      RETURNING id`;
    if (rows.length === 1) return;
    const row = await tx.authNonce.findUnique({
      where: { nonceHash: hash },
      select: { usedAt: true, expiresAt: true },
    });
    if (row && !row.usedAt && row.expiresAt <= now) {
      throw new ApiError(ErrorCode.EXPIRED, 'The sign-in nonce has expired; request a new one');
    }
    throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Invalid or already used sign-in nonce');
  }
}
