import { Injectable } from '@nestjs/common';
import type { Audience, PrivacyPolicy, ProfileVisibility } from '@prisma/client';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** How a viewer (possibly anonymous) relates to a profile owner. */
export interface Relationship {
  viewerId: string | null;
  targetId: string;
  isSelf: boolean;
  /** Either side blocked the other. */
  blocked: boolean;
  /** Viewer follows target: ACCEPTED, REQUESTED or none. */
  following: 'ACCEPTED' | 'REQUESTED' | null;
  /** Target follows viewer (accepted) — used by "People I follow" message/invite/mention policies. */
  followedByTarget: boolean;
}

/**
 * Central audience resolution (Handoff §8). Every DTO that shows another person's data is built
 * from this: private fields are *not returned* when the audience check fails.
 */
@Injectable()
export class VisibilityService {
  constructor(private readonly prisma: PrismaService) {}

  async relationship(
    viewerId: string | null,
    targetId: string,
    db: Db = this.prisma,
  ): Promise<Relationship> {
    if (!viewerId) {
      return {
        viewerId,
        targetId,
        isSelf: false,
        blocked: false,
        following: null,
        followedByTarget: false,
      };
    }
    if (viewerId === targetId) {
      return {
        viewerId,
        targetId,
        isSelf: true,
        blocked: false,
        following: null,
        followedByTarget: false,
      };
    }
    const [blocks, follow, reverse] = await Promise.all([
      db.block.findFirst({
        where: {
          OR: [
            { blockerId: viewerId, blockedId: targetId },
            { blockerId: targetId, blockedId: viewerId },
          ],
        },
        select: { blockerId: true },
      }),
      db.follow.findUnique({
        where: {
          followerId_targetType_targetId: { followerId: viewerId, targetType: 'USER', targetId },
        },
        select: { status: true },
      }),
      db.follow.findUnique({
        where: {
          followerId_targetType_targetId: {
            followerId: targetId,
            targetType: 'USER',
            targetId: viewerId,
          },
        },
        select: { status: true },
      }),
    ]);
    return {
      viewerId,
      targetId,
      isSelf: false,
      blocked: blocks !== null,
      following: follow?.status ?? null,
      followedByTarget: reverse?.status === 'ACCEPTED',
    };
  }

  /** A private profile can never expose a section to EVERYONE (max = FOLLOWERS). */
  effectiveAudience(setting: Audience, visibility: ProfileVisibility): Audience {
    return visibility === 'PRIVATE' && setting === 'EVERYONE' ? 'FOLLOWERS' : setting;
  }

  canSee(setting: Audience, visibility: ProfileVisibility, rel: Relationship): boolean {
    if (rel.isSelf) return true;
    if (rel.blocked) return false;
    switch (this.effectiveAudience(setting, visibility)) {
      case 'EVERYONE':
        return true;
      case 'FOLLOWERS':
        return rel.following === 'ACCEPTED';
      case 'ONLY_ME':
        return false;
    }
  }

  /** Message policy: EVERYONE / FOLLOWING (target follows viewer) / NOBODY. */
  canMessage(policy: PrivacyPolicy, rel: Relationship): boolean {
    if (rel.isSelf || rel.blocked || !rel.viewerId) return false;
    switch (policy.messagePolicy) {
      case 'EVERYONE':
        return true;
      case 'FOLLOWING':
        return rel.followedByTarget;
      case 'NOBODY':
        return false;
    }
  }

  canInvite(policy: PrivacyPolicy, rel: Relationship, sharesClub: boolean): boolean {
    if (rel.isSelf || rel.blocked || !rel.viewerId) return false;
    switch (policy.invitationPolicy) {
      case 'EVERYONE':
        return true;
      case 'FOLLOWING':
        return rel.followedByTarget;
      case 'CLUB_MEMBERS':
        return sharesClub;
      case 'NOBODY':
        return false;
    }
  }

  canMention(policy: PrivacyPolicy, rel: Relationship): boolean {
    if (rel.isSelf) return true;
    if (rel.blocked || !rel.viewerId) return false;
    switch (policy.mentionPolicy) {
      case 'EVERYONE':
        return true;
      case 'FOLLOWING':
        return rel.followedByTarget;
      case 'NOBODY':
        return false;
    }
  }

  /** Is `viewerId` allowed to see any content of `authorId` that is FOLLOWERS-only? */
  async isAcceptedFollower(
    viewerId: string,
    targetId: string,
    db: Db = this.prisma,
  ): Promise<boolean> {
    const f = await db.follow.findUnique({
      where: {
        followerId_targetType_targetId: { followerId: viewerId, targetType: 'USER', targetId },
      },
      select: { status: true },
    });
    return f?.status === 'ACCEPTED';
  }

  async isBlockedEitherWay(a: string, b: string, db: Db = this.prisma): Promise<boolean> {
    if (a === b) return false;
    const row = await db.block.findFirst({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
      select: { blockerId: true },
    });
    return row !== null;
  }
}
