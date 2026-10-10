import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { scrubMetadata } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  keysetBefore,
  toPage,
} from '../../common/pagination/cursor-page';
import { PolicyService } from '../../common/permissions/policy.service';
import type { PermissionName } from '../../common/permissions/permissions';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RecoveryService } from '../auth/recovery.service';
import type {
  AuditPageDto,
  AuditQuery,
  RecoveryApprovalDto,
  RecoveryCasePageDto,
  RecoveryCasesQuery,
  StaffUserPageDto,
  UserLookupQuery,
} from './dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly recovery: RecoveryService,
  ) {}

  private assert(staffId: string, permission: PermissionName): Promise<void> {
    return this.policy.assert(staffId, permission, { type: 'PLATFORM' });
  }

  // ───────────── recovery ─────────────

  async recoveryCases(staffId: string, q: RecoveryCasesQuery): Promise<RecoveryCasePageDto> {
    await this.assert(staffId, 'admin.accounts.recover');
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const where: Prisma.AccountRecoveryCaseWhereInput = { status: q.status ?? 'OPEN' };
    if (cursor) {
      const t = new Date(cursor.t);
      where.AND = [{ OR: [{ createdAt: { gt: t } }, { createdAt: t, id: { gt: cursor.id } }] }];
    }
    const rows = await this.prisma.accountRecoveryCase.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      // tokenHash / tokenExpiresAt are never selected into the DTO
      items: items.map((c) => ({
        id: c.id,
        contactProvider: c.contactProvider,
        contactSubject: c.contactSubject,
        userId: c.userId,
        message: c.message,
        status: c.status,
        reviewedById: c.reviewedById,
        verificationNote: c.verificationNote,
        createdAt: c.createdAt.toISOString(),
        decidedAt: c.decidedAt ? c.decidedAt.toISOString() : null,
      })),
      nextCursor:
        hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async approveRecovery(
    staffId: string,
    caseId: string,
    verificationNote: string,
    requestId?: string,
  ): Promise<RecoveryApprovalDto> {
    await this.assert(staffId, 'admin.accounts.recover');
    const { token, expiresAt } = await this.recovery.approve(
      staffId,
      caseId,
      verificationNote,
      requestId,
    );
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async declineRecovery(
    staffId: string,
    caseId: string,
    note: string,
    requestId?: string,
  ): Promise<void> {
    await this.assert(staffId, 'admin.accounts.recover');
    await this.recovery.decline(staffId, caseId, note, requestId);
  }

  // ───────────── audit ─────────────

  async audit(staffId: string, q: AuditQuery): Promise<AuditPageDto> {
    await this.assert(staffId, 'admin.audit.read');
    const limit = clampPageSize(q.limit);
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        ...(q.actorId ? { actorId: q.actorId } : {}),
        ...(q.action ? { action: q.action } : {}),
        ...(q.targetType ? { targetType: q.targetType } : {}),
        ...(q.targetId ? { targetId: q.targetId } : {}),
        ...keysetBefore('createdAt', decodeCursor(q.cursor)),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = toPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
    return {
      items: page.items.map((r) => ({
        id: r.id,
        actorId: r.actorId,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        // scrubbed again on the way out: secrets never leave the API, even from old rows
        metadata: r.metadata ? (scrubMetadata(r.metadata) as Record<string, unknown>) : null,
        requestId: r.requestId,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  // ───────────── user lookup ─────────────

  async users(staffId: string, q: UserLookupQuery): Promise<StaffUserPageDto> {
    const perms: PermissionName[] = [
      'admin.reports.moderate',
      'admin.accounts.recover',
      'admin.staff.manage',
    ];
    let allowed = false;
    for (const p of perms) {
      if (await this.policy.can(staffId, p, { type: 'PLATFORM' })) {
        allowed = true;
        break;
      }
    }
    if (!allowed)
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    const limit = clampPageSize(q.limit);
    const term = q.q?.trim().toLowerCase();
    const where: Prisma.UserWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...keysetBefore('createdAt', decodeCursor(q.cursor)),
    };
    if (term) {
      where.AND = [
        UUID.test(term) ? { id: term } : { profile: { username: { startsWith: term } } },
      ];
    }
    const rows = await this.prisma.user.findMany({
      where,
      include: { profile: { select: { username: true, nickname: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = toPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
    return {
      items: page.items.map((u) => ({
        id: u.id,
        username: u.profile?.username ?? null,
        nickname: u.profile?.nickname ?? null,
        status: u.status,
        createdAt: u.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
}
