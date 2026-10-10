import { Injectable } from '@nestjs/common';
import type { ModerationAction, Prisma, Report } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  keysetBefore,
  toPage,
} from '../../common/pagination/cursor-page';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  AdminReportDetailDto,
  AdminReportDto,
  AdminReportPageDto,
  ModerationActionDto,
  MyReportsPageDto,
  ReportReceiptDto,
  type ApplyModerationActionDto,
  type CreateReportDto,
  type ModerationActionName,
  type MyReportsQuery,
  type ReportQueueQuery,
} from './dto';
import { ReportTargets } from './report-targets';

const NOT_AVAILABLE = 'This content isn’t available';
const TARGET_OF_ACTION: Record<ModerationActionName, string> = {
  HIDE_POST: 'POST',
  REMOVE_COMMENT: 'COMMENT',
  REMOVE_MEDIA: 'MEDIA',
  SUSPEND_USER: 'USER',
  RESTORE_USER: 'USER',
  WARN: 'USER',
};
/** Neutral notices: they never mention who reported, and never quote the moderator's private reason. */
const NOTICE: Record<ModerationActionName, string> = {
  HIDE_POST: 'A post of yours was removed by moderators',
  REMOVE_COMMENT: 'A comment of yours was removed by moderators',
  REMOVE_MEDIA: 'A file of yours was removed by moderators',
  SUSPEND_USER: 'Your account was suspended by moderators',
  RESTORE_USER: 'Your account was restored',
  WARN: 'You received a notice from moderators',
};

@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly idempotency: IdempotencyService,
    private readonly targets: ReportTargets,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ───────────── reporter side ─────────────

  /**
   * "Report sent": a receipt, never a promise of removal. A repeated identical open report from the
   * same person returns the same ticket. Reporting never blocks anyone (Block is a separate action).
   */
  async create(
    reporterId: string,
    dto: CreateReportDto,
    key: string | undefined,
  ): Promise<ReportReceiptDto> {
    const text = dto.text?.trim() ? dto.text.trim() : null;
    return this.idempotency.execute(
      { userId: reporterId, scope: 'reports.create', key, payload: dto },
      async (tx) => {
        await this.targets.assertViewable(tx, reporterId, dto.targetType, dto.targetId);
        // Serialise concurrent identical submissions so exactly one ticket exists.
        const lockKey = `report:${reporterId}:${dto.targetType}:${dto.targetId}:${dto.reason}`;
        await tx.$queryRaw`SELECT count(*)::int AS n FROM (SELECT pg_advisory_xact_lock(hashtext(${lockKey}))) l`;
        const existing = await tx.report.findFirst({
          where: {
            reporterId,
            targetType: dto.targetType,
            targetId: dto.targetId,
            reason: dto.reason,
            status: { in: ['OPEN', 'IN_REVIEW'] },
          },
          orderBy: { createdAt: 'asc' },
        });
        if (existing) return this.receipt(existing);
        const created = await tx.report.create({
          data: {
            reporterId,
            targetType: dto.targetType,
            targetId: dto.targetId,
            reason: dto.reason,
            text,
          },
        });
        return this.receipt(created);
      },
    );
  }

  async mine(reporterId: string, q: MyReportsQuery): Promise<MyReportsPageDto> {
    const limit = clampPageSize(q.limit);
    const rows = await this.prisma.report.findMany({
      where: { reporterId, ...keysetBefore('createdAt', decodeCursor(q.cursor)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = toPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
    return {
      items: page.items.map((r) => ({
        ticketNumber: r.ticketNumber,
        status: r.status,
        targetType: r.targetType,
        targetId: r.targetId,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  // ───────────── staff queue ─────────────

  async queue(staffId: string, q: ReportQueueQuery): Promise<AdminReportPageDto> {
    await this.policy.assert(staffId, 'admin.reports.moderate', { type: 'PLATFORM' });
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const where: Prisma.ReportWhereInput = {
      status: q.status ?? { in: ['OPEN', 'IN_REVIEW'] },
      ...(q.targetType ? { targetType: q.targetType } : {}),
    };
    if (cursor) {
      const t = new Date(cursor.t);
      // Oldest first: the queue is worked from the top.
      where.AND = [{ OR: [{ createdAt: { gt: t } }, { createdAt: t, id: { gt: cursor.id } }] }];
    }
    const rows = await this.prisma.report.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map((r) => this.adminDto(r)),
      nextCursor:
        hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  /** Reading a report exposes reporter and content context, so every read is audited. */
  async detail(
    staffId: string,
    reportId: string,
    requestId?: string,
  ): Promise<AdminReportDetailDto> {
    await this.policy.assert(staffId, 'admin.reports.moderate', { type: 'PLATFORM' });
    const r = await this.prisma.report.findUnique({
      where: { id: reportId },
      include: { actions: { orderBy: { createdAt: 'asc' } } },
    });
    if (!r) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    await this.audit.record(this.prisma, {
      actorId: staffId,
      action: 'report.view',
      targetType: 'Report',
      targetId: reportId,
      requestId,
      metadata: { ticketNumber: r.ticketNumber },
    });
    return {
      ...this.adminDto(r),
      target: await this.targets.preview(this.prisma, r.targetType, r.targetId),
      actions: r.actions.map((a) => this.actionDto(a)),
    };
  }

  async take(staffId: string, reportId: string, requestId?: string): Promise<AdminReportDto> {
    await this.policy.assert(staffId, 'admin.reports.moderate', { type: 'PLATFORM' });
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.report.findUnique({ where: { id: reportId } });
      if (!r) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      if (r.status === 'IN_REVIEW') return this.adminDto(r);
      if (r.status !== 'OPEN') {
        throw new ApiError(ErrorCode.CONFLICT, 'This report is already closed', {
          status: r.status,
        });
      }
      const updated = await tx.report.update({
        where: { id: reportId },
        data: { status: 'IN_REVIEW' },
      });
      await this.audit.record(tx, {
        actorId: staffId,
        action: 'report.take',
        targetType: 'Report',
        targetId: reportId,
        requestId,
        metadata: { ticketNumber: r.ticketNumber },
      });
      return this.adminDto(updated);
    });
  }

  async close(
    staffId: string,
    reportId: string,
    outcome: 'RESOLVED' | 'DISMISSED',
    resolution: string,
    requestId?: string,
  ): Promise<AdminReportDto> {
    await this.policy.assert(staffId, 'admin.reports.moderate', { type: 'PLATFORM' });
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.report.findUnique({ where: { id: reportId } });
      if (!r) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      if (r.status === 'RESOLVED' || r.status === 'DISMISSED') {
        throw new ApiError(ErrorCode.CONFLICT, 'This report is already closed', {
          status: r.status,
        });
      }
      const updated = await tx.report.update({
        where: { id: reportId },
        data: {
          status: outcome,
          resolution,
          resolvedById: staffId,
          resolvedAt: this.clock.now(),
        },
      });
      await this.audit.record(tx, {
        actorId: staffId,
        action: outcome === 'RESOLVED' ? 'report.resolve' : 'report.dismiss',
        targetType: 'Report',
        targetId: reportId,
        requestId,
        metadata: { ticketNumber: r.ticketNumber },
      });
      // The reporter only learns "reviewed" — never who reviewed it or what was decided.
      await this.notifier.notify(tx, {
        recipientIds: [r.reporterId],
        category: 'system',
        activityKind: 'report.reviewed',
        title: `Your report #${r.ticketNumber} was reviewed`,
        objectType: 'Report',
        objectId: r.id,
        essential: true,
        dedupeKey: `report:${r.id}:reviewed`,
      });
      return this.adminDto(updated);
    });
  }

  // ───────────── actions ─────────────

  async apply(
    staffId: string,
    dto: ApplyModerationActionDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<ModerationActionDto> {
    await this.policy.assert(staffId, 'admin.reports.moderate', { type: 'PLATFORM' });
    if (TARGET_OF_ACTION[dto.action] !== dto.targetType) {
      throw new ApiError(
        ErrorCode.VALIDATION,
        `${dto.action} applies to ${TARGET_OF_ACTION[dto.action]} targets`,
        { field: 'targetType' },
      );
    }
    return this.idempotency.execute(
      { userId: staffId, scope: 'moderation.apply', key, payload: dto },
      async (tx) => {
        if (dto.reportId) {
          const rep = await tx.report.findUnique({
            where: { id: dto.reportId },
            select: { id: true },
          });
          if (!rep) throw new ApiError(ErrorCode.NOT_FOUND, 'Report not found');
        }
        const ownerId = await this.execute(tx, staffId, dto);
        const row = await tx.moderationAction.create({
          data: {
            reportId: dto.reportId ?? null,
            moderatorId: staffId,
            action: dto.action,
            targetType: dto.targetType,
            targetId: dto.targetId,
            reason: dto.reason,
          },
        });
        await this.audit.record(tx, {
          actorId: staffId,
          action: `moderation.${dto.action.toLowerCase()}`,
          targetType: dto.targetType,
          targetId: dto.targetId,
          requestId,
          metadata: {
            reportId: dto.reportId ?? null,
            reason: dto.reason,
            moderationActionId: row.id,
          },
        });
        if (ownerId) {
          await this.notifier.notify(tx, {
            recipientIds: [ownerId],
            category: 'system',
            activityKind: `moderation.${dto.action.toLowerCase()}`,
            title: NOTICE[dto.action],
            objectType: 'ModerationAction',
            objectId: row.id,
            essential: true,
            dedupeKey: `moderation:${row.id}`,
          });
        }
        return this.actionDto(row);
      },
    );
  }

  /** Applies the effect and returns the affected party (owner) to notify. */
  private async execute(
    tx: Tx,
    staffId: string,
    dto: ApplyModerationActionDto,
  ): Promise<string | null> {
    const now = this.clock.now();
    switch (dto.action) {
      case 'HIDE_POST': {
        const p = await tx.post.findUnique({ where: { id: dto.targetId } });
        if (!p) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (p.status === 'DELETED')
          throw new ApiError(ErrorCode.CONFLICT, 'The post is already removed');
        await tx.post.update({
          where: { id: p.id },
          data: { status: 'DELETED', deletedAt: now, version: { increment: 1 } },
        });
        return p.authorId;
      }
      case 'REMOVE_COMMENT': {
        const c = await tx.comment.findUnique({ where: { id: dto.targetId } });
        if (!c) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (c.deletedAt) throw new ApiError(ErrorCode.CONFLICT, 'The comment is already removed');
        await tx.comment.update({
          where: { id: c.id },
          data: { deletedAt: now, deletedById: staffId },
        });
        return c.authorId;
      }
      case 'REMOVE_MEDIA': {
        const m = await tx.mediaAsset.findUnique({ where: { id: dto.targetId } });
        if (!m) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (m.status === 'FAILED' && m.failureReason === 'moderation') {
          throw new ApiError(ErrorCode.CONFLICT, 'The file is already removed');
        }
        await tx.mediaAsset.update({
          where: { id: m.id },
          data: { status: 'FAILED', failureReason: 'moderation' },
        });
        return m.ownerId;
      }
      case 'SUSPEND_USER': {
        if (dto.targetId === staffId) {
          throw new ApiError(ErrorCode.VALIDATION, 'You cannot suspend yourself', {
            field: 'targetId',
          });
        }
        const u = await tx.user.findUnique({
          where: { id: dto.targetId },
          select: { status: true },
        });
        if (!u || u.status === 'DELETED') throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (u.status === 'SUSPENDED')
          throw new ApiError(ErrorCode.CONFLICT, 'The account is already suspended');
        await tx.user.update({ where: { id: dto.targetId }, data: { status: 'SUSPENDED' } });
        await tx.session.updateMany({
          where: { userId: dto.targetId, revokedAt: null },
          data: { revokedAt: now, revokedReason: 'suspended' },
        });
        return dto.targetId;
      }
      case 'RESTORE_USER': {
        const u = await tx.user.findUnique({
          where: { id: dto.targetId },
          select: { status: true },
        });
        if (!u || u.status === 'DELETED') throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (u.status !== 'SUSPENDED')
          throw new ApiError(ErrorCode.CONFLICT, 'The account is not suspended');
        await tx.user.update({ where: { id: dto.targetId }, data: { status: 'ACTIVE' } });
        return dto.targetId;
      }
      case 'WARN': {
        const u = await tx.user.findUnique({
          where: { id: dto.targetId },
          select: { status: true },
        });
        if (!u || u.status === 'DELETED') throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        return dto.targetId;
      }
    }
  }

  private receipt(r: Report): ReportReceiptDto {
    return { ticketNumber: r.ticketNumber, status: r.status, message: 'Report sent' };
  }

  private adminDto(r: Report): AdminReportDto {
    return {
      id: r.id,
      ticketNumber: r.ticketNumber,
      status: r.status,
      targetType: r.targetType,
      targetId: r.targetId,
      reason: r.reason,
      text: r.text,
      reporterId: r.reporterId,
      createdAt: r.createdAt.toISOString(),
      resolvedById: r.resolvedById,
      resolution: r.resolution,
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    };
  }

  private actionDto(a: ModerationAction): ModerationActionDto {
    return {
      id: a.id,
      reportId: a.reportId,
      moderatorId: a.moderatorId,
      action: a.action,
      targetType: a.targetType,
      targetId: a.targetId,
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
    };
  }
}
