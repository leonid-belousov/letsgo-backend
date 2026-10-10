import { Injectable } from '@nestjs/common';
import type { MentionStatus, MentionTargetType, Post } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { Notifier } from '../../common/notify/notifier.service';
import { Permission } from '../../common/permissions/permissions';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import type { MentionInputDto } from './dto';
import { PostVisibilityService } from './post-visibility.service';

export interface PreparedMention {
  targetType: MentionTargetType;
  targetId: string;
  status: MentionStatus;
}

type PostRef = Pick<
  Post,
  'id' | 'authorId' | 'authorType' | 'authorEntityId' | 'audience' | 'status'
>;

@Injectable()
export class MentionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: VisibilityService,
    private readonly policy: PolicyService,
    private readonly postVisibility: PostVisibilityService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {}

  /**
   * Validates and de-duplicates mention inputs. Self mentions, targets whose mention policy
   * rejects the actor and blocked pairs are silently dropped (no policy is revealed).
   * The initial status honours the recipient's `reviewTags` / club moderation.
   */
  async prepare(
    tx: Tx,
    actorId: string,
    author: { type: string; id: string },
    inputs: readonly MentionInputDto[] | undefined,
  ): Promise<PreparedMention[]> {
    if (!inputs || inputs.length === 0) return [];
    const seen = new Set<string>();
    const out: PreparedMention[] = [];
    for (const input of inputs) {
      const key = `${input.targetType}:${input.targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (input.targetType === 'USER') {
        if (input.targetId === actorId) continue;
        if (author.type === 'USER' && input.targetId === author.id) continue;
        const user = await tx.user.findUnique({
          where: { id: input.targetId },
          include: { privacy: true, profile: { select: { userId: true } } },
        });
        if (!user || user.status !== 'ACTIVE' || !user.profile || !user.privacy) {
          throw new ApiError(ErrorCode.VALIDATION, 'Unknown mention target', {
            field: 'mentions',
            targetId: input.targetId,
          });
        }
        const rel = await this.visibility.relationship(actorId, user.id, tx);
        if (!this.visibility.canMention(user.privacy, rel)) continue;
        out.push({
          targetType: 'USER',
          targetId: user.id,
          status: user.privacy.reviewTags ? 'PENDING_REVIEW' : 'SHOWN',
        });
      } else {
        if (author.type === 'CLUB' && input.targetId === author.id) continue;
        const club = await tx.club.findUnique({
          where: { id: input.targetId },
          select: { id: true, status: true },
        });
        if (!club || club.status !== 'ACTIVE') {
          throw new ApiError(ErrorCode.VALIDATION, 'Unknown mention target', {
            field: 'mentions',
            targetId: input.targetId,
          });
        }
        const moderates = await this.policy.can(
          actorId,
          Permission.CLUB_MENTIONS_MODERATE,
          { type: 'CLUB', id: club.id },
          tx,
        );
        out.push({
          targetType: 'CLUB',
          targetId: club.id,
          status: moderates ? 'SHOWN' : 'PENDING_REVIEW',
        });
      }
    }
    return out;
  }

  /**
   * Makes the post's structured mentions equal `prepared` (rows are kept, removed ones become
   * REMOVED; decisions of still-present mentions are preserved). Returns the newly active ones.
   */
  async sync(
    tx: Tx,
    postId: string,
    actorId: string,
    prepared: PreparedMention[],
  ): Promise<PreparedMention[]> {
    const existing = await tx.mention.findMany({ where: { postId } });
    const by = new Map(existing.map((m) => [`${m.targetType}:${m.targetId}`, m]));
    const wanted = new Set(prepared.map((p) => `${p.targetType}:${p.targetId}`));
    const fresh: PreparedMention[] = [];
    for (const p of prepared) {
      const cur = by.get(`${p.targetType}:${p.targetId}`);
      if (!cur) {
        await tx.mention.create({
          data: {
            postId,
            targetType: p.targetType,
            targetId: p.targetId,
            createdById: actorId,
            status: p.status,
          },
        });
        fresh.push(p);
      } else if (cur.status === 'REMOVED') {
        await tx.mention.update({
          where: { id: cur.id },
          data: { status: p.status, decidedAt: null, createdById: actorId },
        });
        fresh.push(p);
      }
    }
    for (const cur of existing) {
      if (!wanted.has(`${cur.targetType}:${cur.targetId}`) && cur.status !== 'REMOVED') {
        await tx.mention.update({
          where: { id: cur.id },
          data: { status: 'REMOVED', decidedAt: this.clock.now() },
        });
      }
    }
    return fresh;
  }

  /** Recipients of a club mention: owner + holders of club.mentions.moderate. */
  async clubModerators(tx: Tx, clubId: string): Promise<string[]> {
    const now = this.clock.now();
    const [club, grants] = await Promise.all([
      tx.club.findUnique({ where: { id: clubId }, select: { ownerId: true } }),
      tx.roleGrant.findMany({
        where: {
          resourceType: 'CLUB',
          resourceId: clubId,
          permission: Permission.CLUB_MENTIONS_MODERATE,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { granteeId: true },
      }),
    ]);
    return [...new Set([...(club ? [club.ownerId] : []), ...grants.map((g) => g.granteeId)])];
  }

  /** Notification carries ids + category only, and only reaches people who may view the post. */
  async notifyMentioned(
    tx: Tx,
    post: PostRef,
    actorId: string,
    fresh: PreparedMention[],
  ): Promise<void> {
    if (post.status !== 'PUBLISHED') return;
    for (const m of fresh) {
      const recipients =
        m.targetType === 'USER' ? [m.targetId] : await this.clubModerators(tx, m.targetId);
      const viewable: string[] = [];
      for (const r of recipients) {
        if (r === actorId) continue;
        if (await this.postVisibility.canView(tx, r, post)) viewable.push(r);
      }
      if (viewable.length === 0) continue;
      await this.notifier.notify(tx, {
        recipientIds: viewable,
        category: 'social',
        activityKind: 'post.mention',
        title: 'You were mentioned in a post',
        objectType: 'POST',
        objectId: post.id,
        actorId,
        payload: { postId: post.id, category: 'mention' },
        dedupeKey: `mention:${post.id}:${m.targetType}:${m.targetId}`,
      });
    }
  }
}
