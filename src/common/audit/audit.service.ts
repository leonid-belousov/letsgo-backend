import { Global, Injectable, Module } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { Db } from '../transactions/tx';

const SECRET_KEY =
  /pass(word)?|secret|token|authorization|cookie|hash|otp|private[-_]?key|dob|dateofbirth/i;

/** Removes anything secret-looking (deeply) before it can reach the audit log. */
export function scrubMetadata(value: unknown, depth = 0): Prisma.InputJsonValue {
  if (value === null || value === undefined) return {};
  if (depth > 4) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'object' ? scrubMetadata(v, depth + 1) : (v as string)));
  }
  if (typeof value === 'object') {
    const out: Record<string, Prisma.InputJsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) out[k] = '[REDACTED]';
      else if (typeof v === 'object' && v !== null) out[k] = scrubMetadata(v, depth + 1);
      else if (v instanceof Date) out[k] = v.toISOString();
      else if (v !== undefined) out[k] = v as string | number | boolean;
    }
    return out;
  }
  return value as string | number | boolean;
}

export interface AuditInput {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: unknown;
  requestId?: string | null;
}

/** Writes immutable audit rows. Pass the caller's `tx` so the audit commits with the change. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(db: Db | undefined, input: AuditInput): Promise<void> {
    const client = db ?? this.prisma;
    await client.auditEvent.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        metadata: scrubMetadata(input.metadata ?? {}),
        requestId: input.requestId ?? null,
      },
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
