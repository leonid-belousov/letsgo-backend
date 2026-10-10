import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { Clock } from '../../common/time/clock';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  PasswordHasher,
  randomSecret,
  sha256Hex,
} from '../../infrastructure/security/password-hasher';
import { normalizeContact } from './auth.service';
import type { ContactDto } from './dto';

const TOKEN_TTL_HOURS = 24;

/**
 * Support-assisted recovery (Handoff §18): no SMS/e-mail codes. A person files a request;
 * staff with `admin.accounts.recover` verifies ownership by means outside this system
 * (OPEN #4: what counts as proof is not encoded) and, if satisfied, approves — receiving a
 * single-use token to hand over out-of-band. Knowing a phone/e-mail alone never yields access.
 */
@Injectable()
export class RecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly config: ConfigService<Env, true>,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** Always succeeds from the caller's view (no account enumeration). */
  async request(contact: ContactDto, message?: string): Promise<void> {
    const { provider, subject } = normalizeContact(contact);
    const identity = await this.prisma.authIdentity.findUnique({
      where: { provider_subject: { provider, subject } },
      select: { userId: true },
    });
    if (!identity) return;
    const open = await this.prisma.accountRecoveryCase.findFirst({
      where: { userId: identity.userId, status: { in: ['OPEN', 'APPROVED'] } },
      select: { id: true },
    });
    if (open) return;
    await this.prisma.accountRecoveryCase.create({
      data: {
        contactProvider: provider,
        contactSubject: subject,
        userId: identity.userId,
        message: message ?? null,
      },
    });
  }

  list(status: 'OPEN' | 'APPROVED' | 'DECLINED' | 'REDEEMED' | 'EXPIRED' = 'OPEN') {
    return this.prisma.accountRecoveryCase.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true,
        contactProvider: true,
        userId: true,
        message: true,
        status: true,
        createdAt: true,
      },
    });
  }

  async approve(
    staffId: string,
    caseId: string,
    verificationNote: string,
    requestId?: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomSecret();
    const expiresAt = new Date(this.clock.now().getTime() + TOKEN_TTL_HOURS * 3_600_000);
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.accountRecoveryCase.updateMany({
        where: { id: caseId, status: 'OPEN' },
        data: {
          status: 'APPROVED',
          reviewedById: staffId,
          verificationNote,
          tokenHash: sha256Hex(token),
          tokenExpiresAt: expiresAt,
          decidedAt: this.clock.now(),
        },
      });
      if (res.count !== 1) throw new ApiError(ErrorCode.NOT_FOUND, 'Open recovery case not found');
      await this.audit.record(tx, {
        actorId: staffId,
        action: 'recovery.approve',
        targetType: 'AccountRecoveryCase',
        targetId: caseId,
        requestId,
      });
    });
    return { token, expiresAt };
  }

  async decline(staffId: string, caseId: string, note: string, requestId?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.accountRecoveryCase.updateMany({
        where: { id: caseId, status: 'OPEN' },
        data: {
          status: 'DECLINED',
          reviewedById: staffId,
          verificationNote: note,
          decidedAt: this.clock.now(),
        },
      });
      if (res.count !== 1) throw new ApiError(ErrorCode.NOT_FOUND, 'Open recovery case not found');
      await this.audit.record(tx, {
        actorId: staffId,
        action: 'recovery.decline',
        targetType: 'AccountRecoveryCase',
        targetId: caseId,
        requestId,
      });
    });
  }

  async redeem(token: string, newPassword: string): Promise<void> {
    const min = this.config.get('PASSWORD_MIN_LENGTH', { infer: true });
    if (newPassword.length < min) {
      throw new ApiError(ErrorCode.VALIDATION, `Password must be at least ${min} characters`, {
        field: 'newPassword',
      });
    }
    const hash = await this.hasher.hash(newPassword);
    const now = this.clock.now();
    let expired = false;
    await this.prisma
      .$transaction(async (tx) => {
        const c = await tx.accountRecoveryCase.findUnique({
          where: { tokenHash: sha256Hex(token) },
        });
        if (!c || c.status !== 'APPROVED' || !c.userId) {
          throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Invalid recovery token');
        }
        if (!c.tokenExpiresAt || c.tokenExpiresAt <= now) {
          expired = true;
          await tx.accountRecoveryCase.update({ where: { id: c.id }, data: { status: 'EXPIRED' } });
          return;
        }
        const used = await tx.accountRecoveryCase.updateMany({
          where: { id: c.id, status: 'APPROVED' },
          data: { status: 'REDEEMED' },
        });
        if (used.count !== 1)
          throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Invalid recovery token');
        await tx.authIdentity.updateMany({
          where: { userId: c.userId, passwordHash: { not: null } },
          data: { passwordHash: hash },
        });
        await tx.session.updateMany({
          where: { userId: c.userId, revokedAt: null },
          data: { revokedAt: now, revokedReason: 'account_recovery' },
        });
        await this.audit.record(tx, {
          actorId: c.userId,
          action: 'recovery.redeem',
          targetType: 'AccountRecoveryCase',
          targetId: c.id,
        });
      })
      .catch((e: unknown) => {
        throw e;
      });
    if (expired) throw new ApiError(ErrorCode.EXPIRED, 'Recovery token expired');
  }
}
