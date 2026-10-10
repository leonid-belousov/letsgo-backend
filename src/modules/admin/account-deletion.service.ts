import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { Clock } from '../../common/time/clock';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ParticipationService } from '../games/participation.service';
import type { AccountDeletedDto, DeletionBlockersDto, OpenObligationDto } from './dto';

/**
 * Account deletion (Handoff §18): refuses while the person still owns clubs, organises upcoming
 * games or owes / is owed money; otherwise anonymises the personal page. Official protocols,
 * matches and receipts keep their ids — only the public identity becomes "Deleted user".
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly participation: ParticipationService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async blockers(db: Db, userId: string): Promise<DeletionBlockersDto> {
    const now = this.clock.now();
    const [clubs, games, open, refunds] = await Promise.all([
      db.club.findMany({
        where: { ownerId: userId, status: 'ACTIVE' },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
      }),
      db.event.findMany({
        where: {
          organiserId: userId,
          OR: [{ status: 'PUBLISHED', endsAt: { gt: now } }, { status: 'STARTED' }],
        },
        select: { id: true, title: true, startsAt: true },
        orderBy: { startsAt: 'asc' },
      }),
      db.paymentObligation.findMany({
        where: { payerUserId: userId, status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
        orderBy: { id: 'asc' },
      }),
      db.paymentObligation.findMany({
        where: { payerUserId: userId, refundDueMinor: { gt: 0 } },
        orderBy: { id: 'asc' },
      }),
    ]);
    const ob = (o: (typeof open)[number], outstanding: number): OpenObligationDto => ({
      id: o.id,
      kind: o.kind,
      eventId: o.eventId,
      outstandingMinor: outstanding,
      refundDueMinor: o.refundDueMinor,
      currency: o.currency,
    });
    return {
      ownedClubs: clubs,
      upcomingGames: games.map((g) => ({
        id: g.id,
        title: g.title,
        startsAt: g.startsAt.toISOString(),
      })),
      openObligations: open.map((o) => ob(o, Math.max(o.amountMinor - o.paidMinor, 0))),
      pendingRefunds: refunds.map((o) => ob(o, 0)),
    };
  }

  private isBlocked(b: DeletionBlockersDto): boolean {
    return (
      b.ownedClubs.length +
        b.upcomingGames.length +
        b.openObligations.length +
        b.pendingRefunds.length >
      0
    );
  }

  async check(userId: string): Promise<DeletionBlockersDto> {
    return this.blockers(this.prisma, userId);
  }

  async deleteAccount(userId: string, requestId?: string): Promise<AccountDeletedDto> {
    this.assertClear(await this.blockers(this.prisma, userId));

    // Leave upcoming games first (frees seats, promotes the waitlist through the games module).
    const now = this.clock.now();
    const parts = await this.prisma.participation.findMany({
      where: {
        userId,
        status: { in: ['CONFIRMED', 'PENDING_APPROVAL', 'WAITLISTED'] },
        event: { status: 'PUBLISHED', endsAt: { gt: now } },
      },
      select: { eventId: true },
    });
    for (const p of parts) await this.participation.leave(userId, p.eventId, undefined);

    await this.prisma.$transaction(async (tx) => {
      this.assertClear(await this.blockers(tx, userId)); // nothing new appeared meanwhile
      const u = await tx.user.updateMany({
        where: { id: userId, status: { not: 'DELETED' } },
        data: { status: 'DELETED', deletedAt: now },
      });
      if (u.count !== 1) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
      await tx.profile.updateMany({
        where: { userId },
        data: {
          nickname: 'Deleted user',
          username: null,
          dateOfBirth: null,
          city: null,
          bio: null,
          avatarId: null,
          visibility: 'PRIVATE',
          version: { increment: 1 },
        },
      });
      await tx.authIdentity.deleteMany({ where: { userId } });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'account_deleted' },
      });
      await tx.follow.deleteMany({
        where: { OR: [{ followerId: userId }, { targetType: 'USER', targetId: userId }] },
      });
      await tx.favourite.deleteMany({
        where: { OR: [{ userId }, { targetType: 'USER', targetId: userId }] },
      });
      await tx.notificationPreference.deleteMany({ where: { userId } });
      await tx.roleGrant.updateMany({
        where: { granteeId: userId, revokedAt: null },
        data: { revokedAt: now, revokedById: userId, revokedReason: 'account_deleted' },
      });
      await tx.membership.updateMany({
        where: { userId, status: { in: ['MEMBER', 'REQUESTED', 'INVITED'] } },
        data: { status: 'LEFT', leftAt: now },
      });
      await tx.post.updateMany({
        where: { authorId: userId, authorType: 'USER', status: { not: 'DELETED' } },
        data: { status: 'DELETED', deletedAt: now },
      });
      await tx.comment.updateMany({
        where: { authorId: userId, deletedAt: null },
        data: { deletedAt: now, deletedById: userId },
      });
      // Matches, match events, receipts and ledger rows are deliberately untouched.
      await this.audit.record(tx, {
        actorId: userId,
        action: 'account.delete',
        targetType: 'User',
        targetId: userId,
        requestId,
        metadata: { leftGames: parts.length },
      });
    });
    return { status: 'DELETED' };
  }

  private assertClear(b: DeletionBlockersDto): void {
    if (this.isBlocked(b)) {
      throw new ApiError(ErrorCode.CONFLICT, 'Resolve these items before deleting your account.', {
        reason: 'DELETION_BLOCKED',
        ...b,
      });
    }
  }
}
