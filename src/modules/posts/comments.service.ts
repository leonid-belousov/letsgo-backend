import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { Notifier } from '../../common/notify/notifier.service';
import {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  PageQuery,
} from '../../common/pagination/cursor-page';
import { Clock } from '../../common/time/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import { CommentDto, CommentPageDto, CreateCommentDto } from './dto';
import { PostVisibilityService } from './post-visibility.service';
import { PostsService } from './posts.service';

const NOT_AVAILABLE = 'This content isn’t available';

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    private readonly postVisibility: PostVisibilityService,
    private readonly visibility: VisibilityService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {}

  async list(
    viewerId: string | null,
    postId: string,
    q: PageQuery,
    parentId?: string,
  ): Promise<CommentPageDto> {
    const post = await this.posts.requireInteractable(viewerId, postId);
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const blockedIds = await this.blockedCounterparts(viewerId);
    const where: Prisma.CommentWhereInput = {
      postId,
      deletedAt: null,
      parentId: parentId ?? null,
      ...(blockedIds.length ? { authorId: { notIn: blockedIds } } : {}),
    };
    if (parentId) {
      const parent = await this.prisma.comment.findFirst({
        where: { id: parentId, postId, deletedAt: null, parentId: null },
        select: { id: true },
      });
      if (!parent) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    if (cursor) {
      const t = new Date(cursor.t);
      where.AND = [{ OR: [{ createdAt: { gt: t } }, { createdAt: t, id: { gt: cursor.id } }] }];
    }
    const rows = await this.prisma.comment.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const items = await this.present(viewerId, post, page);
    return {
      items,
      nextCursor:
        hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async create(userId: string, postId: string, dto: CreateCommentDto): Promise<CommentDto> {
    const body = dto.body.trim();
    if (!body) throw new ApiError(ErrorCode.VALIDATION, 'Comment is empty', { field: 'body' });
    const post = await this.posts.requireInteractable(userId, postId);
    if (post.commentsClosed) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'Comments are closed for this post.');
    }
    let parentAuthorId: string | null = null;
    if (dto.parentId) {
      const parent = await this.prisma.comment.findFirst({
        where: { id: dto.parentId, postId, deletedAt: null },
      });
      if (!parent) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      if (parent.parentId !== null) {
        throw new ApiError(ErrorCode.VALIDATION, 'Replies are limited to one level', {
          field: 'parentId',
        });
      }
      if (await this.visibility.isBlockedEitherWay(userId, parent.authorId)) {
        throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      }
      parentAuthorId = parent.authorId;
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const c = await tx.comment.create({
        data: { postId, authorId: userId, parentId: dto.parentId ?? null, body },
      });
      const recipients = [post.authorId, ...(parentAuthorId ? [parentAuthorId] : [])];
      const viewable: string[] = [];
      for (const r of new Set(recipients)) {
        if (r !== userId && (await this.postVisibility.canView(tx, r, post))) viewable.push(r);
      }
      await this.notifier.notify(tx, {
        recipientIds: viewable,
        category: 'social',
        activityKind: parentAuthorId ? 'comment.reply' : 'comment.created',
        title: parentAuthorId ? 'New reply' : 'New comment on your post',
        objectType: 'POST',
        objectId: postId,
        actorId: userId,
        payload: { postId, commentId: c.id, category: 'comment' },
        dedupeKey: `comment:${c.id}`,
      });
      return c;
    });
    return (await this.present(userId, post, [row]))[0] as CommentDto;
  }

  async edit(userId: string, commentId: string, body: string): Promise<CommentDto> {
    const text = body.trim();
    if (!text) throw new ApiError(ErrorCode.VALIDATION, 'Comment is empty', { field: 'body' });
    const { comment, post } = await this.load(userId, commentId);
    if (comment.authorId !== userId) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data: { body: text, editedAt: this.clock.now() },
    });
    return (await this.present(userId, post, [updated]))[0] as CommentDto;
  }

  /** Own comment, or the post's author/moderator (club.posts.manage) removes any comment. */
  async remove(userId: string, commentId: string): Promise<void> {
    const found = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!found) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    if (found.deletedAt) return;
    const { comment, post } = await this.load(userId, commentId);
    const canModerate = await this.posts.canEditPost(this.prisma, userId, post);
    if (comment.authorId !== userId && !canModerate) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    const now = this.clock.now();
    await this.prisma.comment.updateMany({
      where: { OR: [{ id: commentId }, { parentId: commentId }], deletedAt: null },
      data: { deletedAt: now, deletedById: userId },
    });
  }

  private async load(userId: string, commentId: string) {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deletedAt) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    const post = await this.posts.requireInteractable(userId, comment.postId);
    return { comment, post };
  }

  private async blockedCounterparts(viewerId: string | null): Promise<string[]> {
    if (!viewerId) return [];
    const rows = await this.prisma.block.findMany({
      where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
      select: { blockerId: true, blockedId: true },
    });
    return rows.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId));
  }

  private async present(
    viewerId: string | null,
    post: Awaited<ReturnType<PostsService['requireInteractable']>>,
    rows: Prisma.CommentGetPayload<object>[],
  ): Promise<CommentDto[]> {
    if (rows.length === 0) return [];
    const [profiles, replyGroups, canModerate] = await Promise.all([
      this.prisma.profile.findMany({
        where: { userId: { in: [...new Set(rows.map((r) => r.authorId))] } },
        select: { userId: true, nickname: true, username: true },
      }),
      this.prisma.comment.groupBy({
        by: ['parentId'],
        where: { parentId: { in: rows.map((r) => r.id) }, deletedAt: null },
        _count: { _all: true },
      }),
      viewerId ? this.posts.canEditPost(this.prisma, viewerId, post) : false,
    ]);
    const prof = new Map(profiles.map((p) => [p.userId, p]));
    const replies = new Map(replyGroups.map((g) => [g.parentId, g._count._all]));
    return rows.map((r) => {
      const own = viewerId !== null && r.authorId === viewerId;
      return {
        id: r.id,
        postId: r.postId,
        parentId: r.parentId,
        author: {
          id: r.authorId,
          nickname: prof.get(r.authorId)?.nickname ?? null,
          username: prof.get(r.authorId)?.username ?? null,
        },
        body: r.body,
        replyCount: replies.get(r.id) ?? 0,
        createdAt: r.createdAt.toISOString(),
        editedAt: r.editedAt ? r.editedAt.toISOString() : null,
        capabilities: {
          canEdit: own,
          canDelete: own || canModerate,
          canReply: viewerId !== null && r.parentId === null && !post.commentsClosed,
        },
      };
    });
  }
}
