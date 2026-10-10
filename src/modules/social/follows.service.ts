import { Injectable } from '@nestjs/common';
import type { FollowStatus, FollowTargetType, Prisma } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { Notifier } from '../../common/notify/notifier.service';
import {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  PageQuery,
} from '../../common/pagination/cursor-page';
import { Permission } from '../../common/permissions/permissions';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Db, Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import { tournamentIsPublic } from '../posts/post-visibility.service';
import {
  FollowCountsDto,
  FollowerPageDto,
  FollowingPageDto,
  FollowRequestPageDto,
  FollowStateDto,
  UserSummaryDto,
} from './dto';
import { EntityKind, EntityResolver } from './entity-resolver.service';

const NOT_AVAILABLE = 'This content isn’t available';

/**
 * Follow ≠ Favourite ≠ Join: this service never touches Membership, Participation or
 * Favourite rows, and following a venue does not follow its pitches (nor a tournament its
 * organiser/clubs).
 */
@Injectable()
export class FollowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: VisibilityService,
    private readonly policy: PolicyService,
    private readonly notifier: Notifier,
    private readonly resolver: EntityResolver,
    private readonly clock: Clock,
  ) {}

  // ───────────────────────── follow / unfollow ─────────────────────────

  async follow(
    userId: string,
    targetType: FollowTargetType,
    targetId: string,
  ): Promise<FollowStateDto> {
    if (targetType === 'USER' && targetId === userId) {
      throw new ApiError(ErrorCode.VALIDATION, 'You cannot follow yourself', { field: 'targetId' });
    }
    const initial = await this.initialStatus(userId, targetType, targetId);
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.follow.createMany({
        data: [{ followerId: userId, targetType, targetId, status: initial }],
        skipDuplicates: true,
      });
      if (created.count === 0) return; // repeat follow = same state
      if (targetType === 'USER') {
        await this.notifier.notify(tx, {
          recipientIds: [targetId],
          category: 'social',
          activityKind: initial === 'REQUESTED' ? 'follow.requested' : 'follow.new',
          title: initial === 'REQUESTED' ? 'New follow request' : 'You have a new follower',
          objectType: 'USER',
          objectId: userId,
          actorId: userId,
          payload: { userId, category: 'follow' },
          dedupeKey: `follow:${userId}:${initial}`,
        });
      } else if (targetType === 'CLUB' && initial === 'REQUESTED') {
        await this.notifier.notify(tx, {
          recipientIds: await this.clubApprovers(tx, targetId),
          category: 'club',
          activityKind: 'club.follow.requested',
          title: 'New follow request for your club',
          objectType: 'CLUB',
          objectId: targetId,
          actorId: userId,
          payload: { clubId: targetId, userId, category: 'follow' },
          dedupeKey: `clubfollow:${targetId}:${userId}`,
        });
      }
    });
    return this.state(userId, targetType, targetId);
  }

  /** Unfollow, or cancel your own pending request. Idempotent. */
  async unfollow(
    userId: string,
    targetType: FollowTargetType,
    targetId: string,
  ): Promise<FollowStateDto> {
    await this.prisma.follow.deleteMany({ where: { followerId: userId, targetType, targetId } });
    return this.state(userId, targetType, targetId);
  }

  async state(
    viewerId: string,
    targetType: FollowTargetType,
    targetId: string,
  ): Promise<FollowStateDto> {
    const [mine, followersCount] = await Promise.all([
      this.prisma.follow.findUnique({
        where: { followerId_targetType_targetId: { followerId: viewerId, targetType, targetId } },
        select: { status: true },
      }),
      this.visibleFollowerCount(viewerId, targetType, targetId),
    ]);
    return { targetType, targetId, status: mine?.status ?? 'NONE', followersCount };
  }

  private async visibleFollowerCount(
    viewerId: string | null,
    targetType: FollowTargetType,
    targetId: string,
  ): Promise<number | null> {
    if (targetType === 'USER') {
      const gate = await this.followListGate(viewerId, targetId);
      if (!gate.visible) return null;
    }
    return this.prisma.follow.count({ where: { targetType, targetId, status: 'ACCEPTED' } });
  }

  private async initialStatus(
    userId: string,
    targetType: FollowTargetType,
    targetId: string,
  ): Promise<FollowStatus> {
    switch (targetType) {
      case 'USER': {
        const user = await this.prisma.user.findUnique({
          where: { id: targetId },
          include: { profile: { select: { visibility: true } } },
        });
        if (!user || user.status !== 'ACTIVE' || !user.profile) {
          throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        }
        if (await this.visibility.isBlockedEitherWay(userId, targetId)) {
          throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        }
        return user.profile.visibility === 'PUBLIC' ? 'ACCEPTED' : 'REQUESTED';
      }
      case 'CLUB': {
        const club = await this.prisma.club.findUnique({
          where: { id: targetId },
          select: { status: true, visibility: true, ownerId: true },
        });
        if (!club || club.status !== 'ACTIVE')
          throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (await this.visibility.isBlockedEitherWay(userId, club.ownerId)) {
          throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        }
        return club.visibility === 'PUBLIC' ? 'ACCEPTED' : 'REQUESTED';
      }
      case 'VENUE':
      case 'PITCH':
      case 'TOURNAMENT': {
        const found = await this.resolver.resolve(userId, [{ type: targetType, id: targetId }]);
        if (!found.has(`${targetType}:${targetId}`)) {
          throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        }
        if (targetType === 'TOURNAMENT') {
          const t = await this.prisma.tournament.findUniqueOrThrow({
            where: { id: targetId },
            select: { isPublic: true, status: true },
          });
          if (!tournamentIsPublic(t)) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        }
        return 'ACCEPTED';
      }
    }
  }

  private async clubApprovers(db: Db, clubId: string): Promise<string[]> {
    const now = this.clock.now();
    const [club, grants] = await Promise.all([
      db.club.findUnique({ where: { id: clubId }, select: { ownerId: true } }),
      db.roleGrant.findMany({
        where: {
          resourceType: 'CLUB',
          resourceId: clubId,
          permission: Permission.CLUB_MEMBERS_APPROVE,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { granteeId: true },
      }),
    ]);
    return [...new Set([...(club ? [club.ownerId] : []), ...grants.map((g) => g.granteeId)])];
  }

  // ───────────────────────── requests ─────────────────────────

  /** Pending requests to follow you (or, with clubId, a club you approve for). */
  async listRequests(userId: string, q: PageQuery, clubId?: string): Promise<FollowRequestPageDto> {
    const target = clubId
      ? await this.assertClubApprover(userId, clubId)
      : { type: 'USER' as const, id: userId };
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const t = cursor ? new Date(cursor.t) : undefined;
    const rows = await this.prisma.follow.findMany({
      where: {
        targetType: target.type,
        targetId: target.id,
        status: 'REQUESTED',
        ...(t && cursor
          ? { OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const users = await this.userSummaries(
      userId,
      page.map((r) => r.followerId),
    );
    const last = page[page.length - 1];
    return {
      items: page.flatMap((r) => {
        const requester = users.get(r.followerId);
        return requester
          ? [
              {
                id: r.id,
                targetType: r.targetType,
                targetId: r.targetId,
                requester,
                createdAt: r.createdAt.toISOString(),
              },
            ]
          : [];
      }),
      nextCursor:
        hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async respond(userId: string, followId: string, accept: boolean): Promise<FollowStateDto> {
    const follow = await this.prisma.follow.findUnique({ where: { id: followId } });
    if (!follow) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    await this.assertCanDecide(userId, follow);
    if (accept) {
      await this.prisma.$transaction(async (tx) => {
        const res = await tx.follow.updateMany({
          where: { id: followId, status: 'REQUESTED' },
          data: { status: 'ACCEPTED', respondedAt: this.clock.now() },
        });
        if (res.count === 1) {
          await this.notifier.notify(tx, {
            recipientIds: [follow.followerId],
            category: 'social',
            activityKind: 'follow.accepted',
            title: 'Your follow request was accepted',
            objectType: follow.targetType,
            objectId: follow.targetId,
            actorId: userId,
            payload: {
              targetType: follow.targetType,
              targetId: follow.targetId,
              category: 'follow',
            },
            dedupeKey: `follow-accepted:${follow.id}`,
          });
        }
      });
    } else {
      if (follow.status !== 'REQUESTED') {
        throw new ApiError(
          ErrorCode.CONFLICT,
          'This request was already accepted. Remove the follower instead.',
        );
      }
      await this.prisma.follow.deleteMany({ where: { id: followId, status: 'REQUESTED' } });
    }
    return {
      targetType: follow.targetType,
      targetId: follow.targetId,
      status: accept ? 'ACCEPTED' : 'NONE',
      followersCount: null,
    };
  }

  /** Owner removes a follower (or a club approver removes a club follower). */
  async removeFollower(userId: string, followerId: string, clubId?: string): Promise<void> {
    const target = clubId
      ? await this.assertClubApprover(userId, clubId)
      : { type: 'USER' as const, id: userId };
    await this.prisma.follow.deleteMany({
      where: { followerId, targetType: target.type, targetId: target.id },
    });
  }

  private async assertCanDecide(
    userId: string,
    follow: { targetType: FollowTargetType; targetId: string },
  ): Promise<void> {
    if (follow.targetType === 'USER') {
      if (follow.targetId !== userId) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    } else if (follow.targetType === 'CLUB') {
      await this.policy.assert(userId, Permission.CLUB_MEMBERS_APPROVE, {
        type: 'CLUB',
        id: follow.targetId,
      });
    } else {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
  }

  private async assertClubApprover(userId: string, clubId: string) {
    await this.policy.assert(userId, Permission.CLUB_MEMBERS_APPROVE, { type: 'CLUB', id: clubId });
    return { type: 'CLUB' as const, id: clubId };
  }

  // ───────────────────────── lists ─────────────────────────

  /** Whether the viewer may see `ownerId`'s follower/following lists and counters. */
  private async followListGate(viewerId: string | null, ownerId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: ownerId },
      include: { profile: { select: { visibility: true } }, privacy: true },
    });
    if (!user || user.status !== 'ACTIVE' || !user.profile || !user.privacy) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    const rel = await this.visibility.relationship(viewerId, ownerId);
    if (rel.blocked) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    return {
      visible: this.visibility.canSee(
        user.privacy.followListAudience,
        user.profile.visibility,
        rel,
      ),
    };
  }

  async counts(viewerId: string | null, ownerId: string): Promise<FollowCountsDto> {
    const gate = await this.followListGate(viewerId, ownerId);
    if (!gate.visible) return { followers: null, following: null, hidden: true };
    const [followers, following] = await Promise.all([
      this.prisma.follow.count({
        where: { targetType: 'USER', targetId: ownerId, status: 'ACCEPTED' },
      }),
      this.prisma.follow.count({ where: { followerId: ownerId, status: 'ACCEPTED' } }),
    ]);
    return { followers, following, hidden: false };
  }

  async followers(
    viewerId: string | null,
    ownerId: string,
    q: PageQuery,
  ): Promise<FollowerPageDto> {
    const gate = await this.followListGate(viewerId, ownerId);
    if (!gate.visible) return { items: [], nextCursor: null, hidden: true };
    const { rows, nextCursor } = await this.pageFollows(
      { targetType: 'USER', targetId: ownerId, status: 'ACCEPTED' },
      q,
    );
    const users = await this.userSummaries(
      viewerId,
      rows.map((r) => r.followerId),
    );
    return {
      items: rows.flatMap((r) => {
        const user = users.get(r.followerId);
        return user ? [{ user, followedAt: r.createdAt.toISOString() }] : [];
      }),
      nextCursor,
      hidden: false,
    };
  }

  async following(
    viewerId: string | null,
    ownerId: string,
    q: PageQuery,
  ): Promise<FollowingPageDto> {
    const gate = await this.followListGate(viewerId, ownerId);
    if (!gate.visible) return { items: [], nextCursor: null, hidden: true };
    const { rows, nextCursor } = await this.pageFollows(
      { followerId: ownerId, status: 'ACCEPTED' },
      q,
    );
    const info = await this.resolver.resolve(
      viewerId,
      rows.map((r) => ({ type: r.targetType as EntityKind, id: r.targetId })),
    );
    return {
      items: rows.flatMap((r) => {
        const e = info.get(`${r.targetType}:${r.targetId}`);
        return e
          ? [
              {
                targetType: r.targetType,
                targetId: r.targetId,
                name: e.name,
                handle: e.handle,
                followedAt: r.createdAt.toISOString(),
              },
            ]
          : [];
      }),
      nextCursor,
      hidden: false,
    };
  }

  private async pageFollows(where: Prisma.FollowWhereInput, q: PageQuery) {
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const t = cursor ? new Date(cursor.t) : undefined;
    const rows = await this.prisma.follow.findMany({
      where: {
        ...where,
        ...(t && cursor
          ? { OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      rows: page,
      nextCursor:
        hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  /** Active, non-blocked users as summaries; others are absent from the map. */
  async userSummaries(viewerId: string | null, ids: string[], db: Db | Tx = this.prisma) {
    const map = new Map<string, UserSummaryDto>();
    if (ids.length === 0) return map;
    const unique = [...new Set(ids)];
    const users = await db.user.findMany({
      where: { id: { in: unique }, status: 'ACTIVE', profile: { isNot: null } },
      select: { id: true, profile: { select: { nickname: true, username: true, avatarId: true } } },
    });
    let blocked = new Set<string>();
    if (viewerId) {
      const blocks = await db.block.findMany({
        where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
        select: { blockerId: true, blockedId: true },
      });
      blocked = new Set(blocks.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId)));
    }
    for (const u of users) {
      if (blocked.has(u.id)) continue;
      map.set(u.id, {
        id: u.id,
        nickname: u.profile?.nickname ?? null,
        username: u.profile?.username ?? null,
        avatarId: u.profile?.avatarId ?? null,
      });
    }
    return map;
  }
}
