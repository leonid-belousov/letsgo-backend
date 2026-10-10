import { createHash } from 'node:crypto';
import { Global, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ApiError, ErrorCode } from '../errors';
import { Clock } from '../time/clock';
import type { Tx } from '../transactions/tx';

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export interface IdempotentCall {
  userId: string;
  /** Operation identity, e.g. "payments.cashReceived:<obligationId>". Keys are unique per (user, scope). */
  scope: string;
  key: string | undefined;
  /** Semantic request payload; used to detect key reuse with a different body. */
  payload: unknown;
  /** Mandatory for money-moving operations. */
  required?: boolean;
}

/** Stable JSON: object keys sorted so equal payloads hash equally. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * Restart-safe idempotency. The key row is claimed **inside the same transaction** as the
 * work, and the response is stored in that transaction too:
 *  - crash/rollback  → nothing persisted, a retry runs the work again;
 *  - concurrent duplicate → its INSERT blocks on the unique index until the first commits,
 *    then it replays the stored response (never runs the work twice);
 *  - same key, different payload → IDEMPOTENCY_CONFLICT.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly clock: Clock,
  ) {}

  async execute<T>(call: IdempotentCall, work: (tx: Tx) => Promise<T>): Promise<T> {
    if (call.key === undefined || call.key === '') {
      if (call.required) {
        throw new ApiError(ErrorCode.VALIDATION, 'Idempotency-Key header is required', {
          header: 'Idempotency-Key',
        });
      }
      return this.prisma.$transaction(async (tx) => toJson(await work(tx)), { timeout: 20_000 });
    }
    if (!KEY_PATTERN.test(call.key)) {
      throw new ApiError(ErrorCode.VALIDATION, 'Invalid Idempotency-Key', {
        header: 'Idempotency-Key',
      });
    }
    const requestHash = createHash('sha256').update(stableStringify(call.payload)).digest('hex');
    const ttlHours = this.config.get('IDEMPOTENCY_TTL_HOURS', { infer: true });
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`DELETE FROM "IdempotencyRecord"
          WHERE "userId" = ${call.userId}::uuid AND scope = ${call.scope} AND key = ${call.key}
            AND "expiresAt" < ${now}`;
        const inserted = await tx.$executeRaw`INSERT INTO "IdempotencyRecord"
          (id, "userId", scope, key, "requestHash", "expiresAt")
          VALUES (gen_random_uuid(), ${call.userId}::uuid, ${call.scope}, ${call.key}, ${requestHash}, ${expiresAt})
          ON CONFLICT ("userId", scope, key) DO NOTHING`;

        if (inserted === 1) {
          const result = toJson(await work(tx));
          await tx.idempotencyRecord.update({
            where: {
              userId_scope_key: { userId: call.userId, scope: call.scope, key: call.key as string },
            },
            data: { responseStatus: 200, responseBody: result as Prisma.InputJsonValue },
          });
          return result;
        }

        const existing = await tx.idempotencyRecord.findUnique({
          where: {
            userId_scope_key: { userId: call.userId, scope: call.scope, key: call.key as string },
          },
        });
        if (!existing || existing.requestHash !== requestHash) {
          throw new ApiError(
            ErrorCode.IDEMPOTENCY_CONFLICT,
            'Idempotency-Key was already used with a different request',
          );
        }
        if (existing.responseBody === null) {
          throw new ApiError(ErrorCode.IDEMPOTENCY_CONFLICT, 'Request is still being processed');
        }
        return existing.responseBody as T;
      },
      { timeout: 20_000 },
    );
  }
}

/** Normalise to what a replay would produce (Dates → ISO strings, undefined dropped). */
function toJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

@Global()
@Module({ providers: [IdempotencyService], exports: [IdempotencyService] })
export class IdempotencyModule {}
