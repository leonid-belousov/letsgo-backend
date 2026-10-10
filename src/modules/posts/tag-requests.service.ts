import { Injectable } from '@nestjs/common';
import type { MentionStatus, Prisma } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  PageQuery,
} from '../../common/pagination/cursor-page';
import { Permission } from '../../common/permissions/permissions';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TagDecision, TagRequestDto, TagRequestPageDto } from './dto';
import { PostVisibilityService } from './post-visibility.service';
import { PostsService, postInclude } from './posts.service';

const NOT_FOUND = 'This content isn’t available';
const DECISION_STATUS: Record<TagDecision, MentionStatus> = {
  SHOW: 'SHOWN',
  HIDE: 'HIDDEN',
  REMOVE: 'REMOVED',
};

/**
 * "Tag requests" = mentions the mentioned subject reviews. A person reviews mentions of
 * themselves; club mentions are reviewed by holders of club.mentions.moderate.
 */
@Injectable()
export class TagRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly posts: PostsService,
    private readonly postVisibility: PostVisibilityService,
    private readonly clock: Clock,
  ) {}

  private async moderatedClubIds(userId: string): Promise<string[]> {
    const now = this.clock.now();
    const [owned, grants] = await Promise.all([
      this.prisma.club.findMany({ where: { ownerId: userId }, select: { id: true } }),
      this.prisma.roleGrant.findMany({
        where: {
          granteeId: userId,
          resourceType: 'CLUB',
          permission: Permission.CLUB_MENTIONS_MODERATE,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { resourceId: true },
      }),
    ]);
    return [
      ...new Set([
        ...owned.map((c) => c.id),
        ...grants.flatMap((g) => (g.resourceId ? [g.resourceId] : [])),
      ]),
    ];
  }

  async listMine(userId: string, status: MentionStatus, q: PageQuery): Promise<TagRequestPageDto> {
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const clubIds = await this.moderatedClubIds(userId);
    const where: Prisma.MentionWhereInput = {
      status,
      post: { status: 'PUBLISHED' },
      OR: [
        { targetType: 'USER', targetId: userId },
        ...(clubIds.length ? [{ targetType: 'CLUB' as const, targetId: { in: clubIds } }] : []),
      ],
    };
    if (cursor) {
      const t = new Date(cursor.t);
      where.AND = [{ OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: cursor.id } }] }];
    }
    const rows = await this.prisma.mention.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { post: { include: postInclude } },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const viewable = await this.postVisibility.filterViewable(
      this.prisma,
      userId,
      page.map((m) => m.post),
    );
    const authors = await this.posts.resolveAuthors(
      this.prisma,
      page.map((m) => ({ type: m.post.authorType, id: m.post.authorEntityId })),
    );
    const targets = await this.posts.resolveAuthors(
      this.prisma,
      page.map((m) => ({ type: m.targetType, id: m.targetId })),
    );
    const visiblePosts = page.filter((m) => viewable.has(m.post.id)).map((m) => m.post);
    const presented = new Map(
      (await this.posts.present(this.prisma, userId, visiblePosts)).map((p) => [p.id, p]),
    );
    const items: TagRequestDto[] = page.map((m) => ({
      id: m.id,
      postId: m.postId,
      targetType: m.targetType,
      targetId: m.targetId,
      targetName: targets.get(`${m.targetType}:${m.targetId}`)?.name ?? null,
      targetHandle: targets.get(`${m.targetType}:${m.targetId}`)?.handle ?? null,
      status: m.status,
      postedBy: authors.get(`${m.post.authorType}:${m.post.authorEntityId}`) ?? {
        type: m.post.authorType,
        id: m.post.authorEntityId,
        name: null,
        handle: null,
        avatarId: null,
      },
      post: presented.get(m.postId) ?? null,
      createdAt: m.createdAt.toISOString(),
    }));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async decide(userId: string, mentionId: string, decision: TagDecision): Promise<TagRequestDto> {
    const m = await this.prisma.mention.findUnique({
      where: { id: mentionId },
      include: { post: { include: postInclude } },
    });
    if (!m || m.post.status !== 'PUBLISHED') throw new ApiError(ErrorCode.NOT_FOUND, NOT_FOUND);
    const allowed =
      m.targetType === 'USER'
        ? m.targetId === userId
        : await this.policy.can(userId, Permission.CLUB_MENTIONS_MODERATE, {
            type: 'CLUB',
            id: m.targetId,
          });
    if (!allowed) throw new ApiError(ErrorCode.NOT_FOUND, NOT_FOUND);
    if (m.status === 'REMOVED') {
      throw new ApiError(ErrorCode.CONFLICT, 'This tag was already removed');
    }
    const next = DECISION_STATUS[decision];
    const updated =
      m.status === next
        ? m
        : await this.prisma.mention.update({
            where: { id: mentionId },
            data: { status: next, decidedAt: this.clock.now() },
            include: { post: { include: postInclude } },
          });
    const canView = await this.postVisibility.canView(this.prisma, userId, updated.post);
    const authors = await this.posts.resolveAuthors(this.prisma, [
      { type: updated.post.authorType, id: updated.post.authorEntityId },
      { type: updated.targetType, id: updated.targetId },
    ]);
    const target = authors.get(`${updated.targetType}:${updated.targetId}`);
    return {
      id: updated.id,
      postId: updated.postId,
      targetType: updated.targetType,
      targetId: updated.targetId,
      targetName: target?.name ?? null,
      targetHandle: target?.handle ?? null,
      status: updated.status,
      postedBy: authors.get(`${updated.post.authorType}:${updated.post.authorEntityId}`) ?? {
        type: updated.post.authorType,
        id: updated.post.authorEntityId,
        name: null,
        handle: null,
        avatarId: null,
      },
      post: canView
        ? ((await this.posts.present(this.prisma, userId, [updated.post]))[0] ?? null)
        : null,
      createdAt: updated.createdAt.toISOString(),
    };
  }
}
