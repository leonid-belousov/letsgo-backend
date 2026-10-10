import { Injectable } from '@nestjs/common';
import type { OwnershipTransfer } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import { Clock } from '../../common/time/clock';
import { isUniqueViolation, type Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import { assertActive, loadClub, lockClub, notAvailable } from './club-support';
import { OwnershipTransferDto, OwnershipTransferListDto } from './dto';

/**
 * Owner → a specific active user → the recipient accepts. One PENDING transfer per club (DB partial
 * unique index). The founder never changes; the previous owner stays a member but loses the
 * structural authority (PolicyService derives it from `Club.ownerId`).
 */
@Injectable()
export class ClubOwnershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: VisibilityService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {}

  async create(
    ownerId: string,
    clubId: string,
    toUserId: string,
    idempotencyKey: string | undefined,
    requestId: string,
  ): Promise<OwnershipTransferDto> {
    return this.idempotency.execute(
      {
        userId: ownerId,
        scope: `clubs.transfer:${clubId}`,
        key: idempotencyKey,
        payload: { toUserId },
      },
      async (tx) => {
        await lockClub(tx, clubId);
        const club = await loadClub(tx, clubId);
        if (club.ownerId !== ownerId) {
          // Only the current owner starts a transfer; everybody else sees a uniform denial.
          const m = await tx.membership.findUnique({
            where: { clubId_userId: { clubId, userId: ownerId } },
            select: { status: true },
          });
          if (m?.status === 'MEMBER' || club.visibility === 'PUBLIC') {
            throw new ApiError(
              ErrorCode.ACCESS_DENIED,
              'You no longer have access to this action.',
            );
          }
          throw notAvailable();
        }
        assertActive(club);
        if (toUserId === ownerId) {
          throw new ApiError(ErrorCode.VALIDATION, 'Choose another person.', { field: 'toUserId' });
        }
        const target = await tx.user.findUnique({
          where: { id: toUserId },
          select: { status: true, profile: { select: { completedAt: true } } },
        });
        if (target?.status !== 'ACTIVE' || !target.profile?.completedAt) {
          throw new ApiError(ErrorCode.VALIDATION, 'This person can’t become the owner.', {
            field: 'toUserId',
          });
        }
        if (await this.visibility.isBlockedEitherWay(ownerId, toUserId, tx)) {
          throw new ApiError(ErrorCode.VALIDATION, 'This person can’t become the owner.', {
            field: 'toUserId',
          });
        }
        const pending = await tx.ownershipTransfer.findFirst({
          where: { clubId, status: 'PENDING' },
        });
        if (pending) throw this.alreadyPending();
        let transfer: OwnershipTransfer;
        try {
          transfer = await tx.ownershipTransfer.create({
            data: { clubId, fromUserId: ownerId, toUserId },
          });
        } catch (err) {
          if (isUniqueViolation(err)) throw this.alreadyPending();
          throw err;
        }
        await this.audit.record(tx, {
          actorId: ownerId,
          action: 'club.ownership.offer',
          targetType: 'CLUB',
          targetId: clubId,
          metadata: { transferId: transfer.id, toUserId },
          requestId,
        });
        await this.notifier.notify(tx, {
          recipientIds: [toUserId],
          category: 'club',
          activityKind: 'club.ownership_offered',
          title: 'You were offered ownership of a club',
          objectType: 'CLUB',
          objectId: clubId,
          actorId: ownerId,
          payload: { clubId, transferId: transfer.id },
          dedupeKey: `club-transfer:${transfer.id}:offered`,
          essential: true,
        });
        return this.toDto(transfer);
      },
    );
  }

  private alreadyPending(): ApiError {
    return new ApiError(ErrorCode.CONFLICT, 'An ownership transfer is already pending.', {
      reason: 'TRANSFER_PENDING',
    });
  }

  async accept(userId: string, clubId: string, transferId: string, requestId: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockClub(tx, clubId);
      const club = await loadClub(tx, clubId);
      const t = await this.pendingFor(tx, clubId, transferId);
      if (t.toUserId !== userId) throw notAvailable();
      const now = this.clock.now();
      if (club.ownerId !== t.fromUserId || club.status !== 'ACTIVE') {
        // Stale offer: the club changed hands or was archived meanwhile.
        await tx.ownershipTransfer.update({
          where: { id: t.id },
          data: { status: 'CANCELLED', respondedAt: now },
        });
        throw new ApiError(ErrorCode.CONFLICT, 'This ownership offer is no longer valid.', {
          reason: 'TRANSFER_STALE',
        });
      }
      await tx.club.update({
        where: { id: clubId },
        data: { ownerId: userId, version: { increment: 1 } },
      });
      const done = await tx.ownershipTransfer.update({
        where: { id: t.id },
        data: { status: 'ACCEPTED', respondedAt: now },
      });
      // Ownership implies membership; the previous owner keeps theirs.
      await tx.membership.upsert({
        where: { clubId_userId: { clubId, userId } },
        create: { clubId, userId, status: 'MEMBER', joinedAt: now },
        update: { status: 'MEMBER', joinedAt: now, leftAt: null },
      });
      await this.audit.record(tx, {
        actorId: userId,
        action: 'club.ownership.accept',
        targetType: 'CLUB',
        targetId: clubId,
        metadata: { transferId: t.id, fromUserId: t.fromUserId, toUserId: userId },
        requestId,
      });
      await this.notifier.notify(tx, {
        recipientIds: [t.fromUserId],
        category: 'club',
        activityKind: 'club.ownership_accepted',
        title: 'Your club ownership transfer was accepted',
        objectType: 'CLUB',
        objectId: clubId,
        actorId: userId,
        payload: { clubId, transferId: t.id },
        dedupeKey: `club-transfer:${t.id}:accepted`,
        essential: true,
      });
      return this.toDto(done);
    });
  }

  async decline(userId: string, clubId: string, transferId: string, requestId: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockClub(tx, clubId);
      const t = await this.pendingFor(tx, clubId, transferId);
      if (t.toUserId !== userId) throw notAvailable();
      const done = await tx.ownershipTransfer.update({
        where: { id: t.id },
        data: { status: 'DECLINED', respondedAt: this.clock.now() },
      });
      await this.audit.record(tx, {
        actorId: userId,
        action: 'club.ownership.decline',
        targetType: 'CLUB',
        targetId: clubId,
        metadata: { transferId: t.id },
        requestId,
      });
      await this.notifier.notify(tx, {
        recipientIds: [t.fromUserId],
        category: 'club',
        activityKind: 'club.ownership_declined',
        title: 'Your club ownership transfer was declined',
        objectType: 'CLUB',
        objectId: clubId,
        actorId: userId,
        payload: { clubId, transferId: t.id },
        dedupeKey: `club-transfer:${t.id}:declined`,
        essential: true,
      });
      return this.toDto(done);
    });
  }

  async cancel(userId: string, clubId: string, transferId: string, requestId: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockClub(tx, clubId);
      const t = await this.pendingFor(tx, clubId, transferId);
      if (t.fromUserId !== userId) throw notAvailable();
      const done = await tx.ownershipTransfer.update({
        where: { id: t.id },
        data: { status: 'CANCELLED', respondedAt: this.clock.now() },
      });
      await this.audit.record(tx, {
        actorId: userId,
        action: 'club.ownership.cancel',
        targetType: 'CLUB',
        targetId: clubId,
        metadata: { transferId: t.id },
        requestId,
      });
      return this.toDto(done);
    });
  }

  /** The pending offer of a club, visible to the current owner and to the recipient only. */
  async listForClub(userId: string, clubId: string): Promise<OwnershipTransferListDto> {
    const rows = await this.prisma.ownershipTransfer.findMany({
      where: {
        clubId,
        status: 'PENDING',
        OR: [{ fromUserId: userId }, { toUserId: userId }],
      },
      orderBy: { createdAt: 'desc' },
    });
    return { items: rows.map((r) => this.toDto(r)) };
  }

  async incoming(userId: string): Promise<OwnershipTransferListDto> {
    const rows = await this.prisma.ownershipTransfer.findMany({
      where: { toUserId: userId, status: 'PENDING', club: { status: 'ACTIVE' } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items: rows.map((r) => this.toDto(r)) };
  }

  private async pendingFor(tx: Tx, clubId: string, transferId: string): Promise<OwnershipTransfer> {
    const t = await tx.ownershipTransfer.findFirst({
      where: { id: transferId, clubId, status: 'PENDING' },
    });
    if (!t) throw notAvailable();
    return t;
  }

  private toDto(t: OwnershipTransfer): OwnershipTransferDto {
    return {
      id: t.id,
      clubId: t.clubId,
      fromUserId: t.fromUserId,
      toUserId: t.toUserId,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      respondedAt: t.respondedAt ? t.respondedAt.toISOString() : null,
    };
  }
}
