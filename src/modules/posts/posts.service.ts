import { Injectable } from '@nestjs/common';
import type { PostAudience, PostAuthorType, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import {
  clampPageSize,
  CursorKey,
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
import { assertOwnedReady } from '../media/media-checks';
import {
  CreatePostDto,
  LikeStateDto,
  POST_TEXT_MAX,
  PostAuthorDto,
  PostDto,
  PostMentionDto,
  PostPageDto,
  UpdatePostDto,
} from './dto';
import { MentionsService, PreparedMention } from './mentions.service';
import { PostVisibilityService } from './post-visibility.service';

export const postInclude = {
  media: { orderBy: { position: 'asc' }, include: { media: { select: { kind: true } } } },
  mentions: true,
} satisfies Prisma.PostInclude;
export type PostRow = Prisma.PostGetPayload<{ include: typeof postInclude }>;

const NOT_AVAILABLE = 'This content isn’t available';

function keysetLt(cursor: CursorKey | undefined): Prisma.PostWhereInput {
  if (!cursor) return {};
  const t = new Date(cursor.t);
  return { OR: [{ publishedAt: { lt: t } }, { publishedAt: t, id: { lt: cursor.id } }] };
}

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly visibility: VisibilityService,
    private readonly postVisibility: PostVisibilityService,
    private readonly mentions: MentionsService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ───────────────────────── reads ─────────────────────────

  async get(viewerId: string | null, id: string): Promise<PostDto> {
    const row = await this.prisma.post.findUnique({ where: { id }, include: postInclude });
    if (!row || !(await this.postVisibility.canView(this.prisma, viewerId, row))) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    return (await this.present(this.prisma, viewerId, [row]))[0] as PostDto;
  }

  /** Posts of one author entity, newest first, visible to the viewer only. */
  async listByAuthor(
    viewerId: string | null,
    authorType: PostAuthorType,
    authorEntityId: string,
    q: PageQuery,
  ): Promise<PostPageDto> {
    if (authorType === 'USER') {
      const user = await this.prisma.user.findUnique({
        where: { id: authorEntityId },
        include: { profile: true, privacy: true },
      });
      if (!user?.profile || !user.privacy || user.status !== 'ACTIVE') {
        throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      }
      const rel = await this.visibility.relationship(viewerId, user.id);
      if (!this.visibility.canSee(user.privacy.postsAudience, user.profile.visibility, rel)) {
        return { items: [], nextCursor: null };
      }
    }
    return this.pageVisible(viewerId, { authorType, authorEntityId }, q);
  }

  /** Posts in which a person/club is mentioned and has let the mention show (SHOWN). */
  async listTagged(
    viewerId: string | null,
    targetType: 'USER' | 'CLUB',
    targetId: string,
    q: PageQuery,
  ): Promise<PostPageDto> {
    if (targetType === 'USER') {
      const user = await this.prisma.user.findUnique({
        where: { id: targetId },
        include: { profile: true, privacy: true },
      });
      if (!user?.profile || !user.privacy || user.status !== 'ACTIVE') {
        throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      }
      const rel = await this.visibility.relationship(viewerId, user.id);
      if (!this.visibility.canSee(user.privacy.postsAudience, user.profile.visibility, rel)) {
        return { items: [], nextCursor: null };
      }
    }
    return this.pageVisible(
      viewerId,
      {
        mentions: { some: { targetType, targetId, status: 'SHOWN' } },
      },
      q,
    );
  }

  async listDrafts(userId: string, q: PageQuery): Promise<PostPageDto> {
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const where: Prisma.PostWhereInput = { authorId: userId, status: 'DRAFT' };
    if (cursor) {
      const t = new Date(cursor.t);
      where.OR = [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: cursor.id } }];
    }
    const rows = await this.prisma.post.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: postInclude,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items: await this.present(this.prisma, userId, items),
      nextCursor:
        hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  /**
   * Keyset page over PUBLISHED posts matching `where`, keeping only posts the viewer may
   * see. Invisible rows are skipped batch by batch so a page is as full as possible and the
   * cursor (publishedAt,id of the last returned post) stays stable while new posts arrive.
   */
  async pageVisible(
    viewerId: string | null,
    where: Prisma.PostWhereInput,
    q: PageQuery,
  ): Promise<PostPageDto> {
    const { rows, nextCursor } = await this.scanVisible(viewerId, where, q);
    return { items: await this.present(this.prisma, viewerId, rows), nextCursor };
  }

  async scanVisible(
    viewerId: string | null,
    where: Prisma.PostWhereInput,
    q: PageQuery,
  ): Promise<{ rows: PostRow[]; nextCursor: string | null }> {
    const limit = clampPageSize(q.limit);
    let cursor = decodeCursor(q.cursor);
    const batch = Math.max(limit * 3, 30);
    const collected: PostRow[] = [];
    let exhausted = false;
    for (let i = 0; i < 12 && collected.length <= limit; i++) {
      const rows = await this.prisma.post.findMany({
        where: {
          AND: [
            where,
            { status: 'PUBLISHED', publishedAt: { not: null } },
            keysetLt(cursor),
            viewerId
              ? { OR: [{ audience: { not: 'ONLY_ME' } }, { authorId: viewerId }] }
              : { audience: 'PUBLIC' },
          ],
        },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: batch,
        include: postInclude,
      });
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      const ok = await this.postVisibility.filterViewable(this.prisma, viewerId, rows);
      for (const r of rows) if (ok.has(r.id)) collected.push(r);
      const last = rows[rows.length - 1] as PostRow;
      cursor = { t: (last.publishedAt as Date).toISOString(), id: last.id };
      if (rows.length < batch) {
        exhausted = true;
        break;
      }
    }
    const items = collected.slice(0, limit);
    const last = items[items.length - 1];
    let nextCursor: string | null = null;
    if (collected.length > limit || !exhausted) {
      if (last) {
        nextCursor = encodeCursor({ t: (last.publishedAt as Date).toISOString(), id: last.id });
      } else if (cursor && !exhausted) {
        nextCursor = encodeCursor(cursor);
      }
    }
    return { rows: items, nextCursor };
  }

  // ───────────────────────── writes ─────────────────────────

  create(
    userId: string,
    dto: CreatePostDto,
    key: string | undefined,
    requestId: string,
  ): Promise<PostDto> {
    return this.idempotency.execute(
      { userId, scope: 'posts.create', key, payload: dto },
      async (tx) => {
        const type = dto.authorType ?? 'USER';
        const entityId = await this.resolveAuthor(tx, userId, type, dto.authorEntityId);
        const audience = await this.effectiveAudience(tx, type, entityId, dto.audience ?? 'PUBLIC');
        const text = normaliseText(dto.text);
        const media = await assertOwnedReady(tx, userId, dto.mediaIds ?? [], {
          kinds: ['PHOTO', 'VIDEO'],
        });
        await this.assertAchievement(tx, type, entityId, userId, dto.achievementId);
        const publish = dto.publish !== false;
        if (publish) assertHasContent(text, media.length, dto.achievementId);
        const prepared = await this.mentions.prepare(
          tx,
          userId,
          { type, id: entityId },
          dto.mentions,
        );

        const post = await tx.post.create({
          data: {
            authorId: userId,
            authorType: type,
            authorEntityId: entityId,
            audience,
            body: text,
            achievementId: dto.achievementId ?? null,
            status: publish ? 'PUBLISHED' : 'DRAFT',
            publishedAt: publish ? this.clock.now() : null,
            media: { create: media.map((m, position) => ({ mediaId: m.id, position })) },
          },
        });
        const fresh = await this.mentions.sync(tx, post.id, userId, prepared);
        if (publish) {
          await this.mentions.notifyMentioned(tx, post, userId, fresh);
          await this.auditPublish(tx, userId, post.id, type, entityId, requestId);
        }
        return this.presentOne(tx, userId, post.id);
      },
    );
  }

  publish(
    userId: string,
    id: string,
    key: string | undefined,
    requestId: string,
  ): Promise<PostDto> {
    return this.idempotency.execute(
      { userId, scope: `posts.publish:${id}`, key, payload: { id } },
      async (tx) => {
        await lockPost(tx, id);
        const post = await this.loadEditable(tx, userId, id);
        if (post.status === 'PUBLISHED') return this.presentOne(tx, userId, id);
        const text = post.body;
        assertHasContent(text, post.media.length, post.achievementId ?? undefined);
        // media must still be READY, and the audience cap of a (now) private profile applies
        await assertOwnedReady(
          tx,
          post.authorId,
          post.media.map((m) => m.mediaId),
        );
        const audience = await this.effectiveAudience(
          tx,
          post.authorType,
          post.authorEntityId,
          post.audience,
        );
        const updated = await tx.post.update({
          where: { id },
          data: {
            status: 'PUBLISHED',
            publishedAt: this.clock.now(),
            audience,
            version: { increment: 1 },
          },
        });
        const live = post.mentions
          .filter((m) => m.status !== 'REMOVED')
          .map<PreparedMention>((m) => ({
            targetType: m.targetType,
            targetId: m.targetId,
            status: m.status,
          }));
        await this.mentions.notifyMentioned(tx, updated, userId, live);
        await this.auditPublish(tx, userId, id, post.authorType, post.authorEntityId, requestId);
        return this.presentOne(tx, userId, id);
      },
    );
  }

  async update(userId: string, id: string, dto: UpdatePostDto): Promise<PostDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockPost(tx, id);
      const post = await this.loadEditable(tx, userId, id);
      if (post.version !== dto.version) {
        throw new ApiError(ErrorCode.VERSION_CHANGED, 'This post was changed elsewhere', {
          currentVersion: post.version,
        });
      }
      const data: Prisma.PostUpdateInput = { version: { increment: 1 } };
      const text = dto.text !== undefined ? normaliseText(dto.text) : post.body;
      if (dto.text !== undefined) data.body = text;
      if (dto.audience !== undefined) {
        data.audience = await this.effectiveAudience(
          tx,
          post.authorType,
          post.authorEntityId,
          dto.audience,
        );
      }
      let mediaCount = post.media.length;
      if (dto.mediaIds !== undefined) {
        const media = await assertOwnedReady(tx, userId, dto.mediaIds, {
          kinds: ['PHOTO', 'VIDEO'],
        });
        await tx.postMedia.deleteMany({ where: { postId: id } });
        if (media.length > 0) {
          await tx.postMedia.createMany({
            data: media.map((m, position) => ({ postId: id, mediaId: m.id, position })),
          });
        }
        mediaCount = media.length;
      }
      if (post.status === 'PUBLISHED')
        assertHasContent(text, mediaCount, post.achievementId ?? undefined);
      await tx.post.update({ where: { id }, data });
      if (dto.mentions !== undefined) {
        const prepared = await this.mentions.prepare(
          tx,
          userId,
          { type: post.authorType, id: post.authorEntityId },
          dto.mentions,
        );
        const fresh = await this.mentions.sync(tx, id, userId, prepared);
        const current = await tx.post.findUniqueOrThrow({ where: { id } });
        await this.mentions.notifyMentioned(tx, current, userId, fresh);
      }
      return this.presentOne(tx, userId, id);
    });
  }

  /** Soft delete: leaves feeds, saved lists and mention lists everywhere. Matches/results are untouched. */
  async remove(userId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockPost(tx, id);
      const post = await tx.post.findUnique({ where: { id }, include: postInclude });
      if (!post) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      if (post.status === 'DELETED' && post.authorId === userId) return; // idempotent
      if (!(await this.canEditPost(tx, userId, post))) {
        if (post.status === 'DELETED' || !(await this.postVisibility.canView(tx, userId, post))) {
          throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        }
        throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
      }
      if (post.status === 'DELETED') return;
      await tx.post.update({
        where: { id },
        data: { status: 'DELETED', deletedAt: this.clock.now(), version: { increment: 1 } },
      });
    });
  }

  async setCommentsClosed(userId: string, id: string, closed: boolean): Promise<PostDto> {
    const post = await this.prisma.post.findUnique({ where: { id }, include: postInclude });
    if (!post || post.status === 'DELETED') throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    if (!(await this.canEditPost(this.prisma, userId, post))) {
      if (!(await this.postVisibility.canView(this.prisma, userId, post))) {
        throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      }
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    await this.prisma.post.update({ where: { id }, data: { commentsClosed: closed } });
    return this.presentOne(this.prisma, userId, id);
  }

  async like(userId: string, id: string): Promise<LikeStateDto> {
    await this.requireInteractable(userId, id);
    await this.prisma.reaction.createMany({
      data: [{ postId: id, userId, type: 'LIKE' }],
      skipDuplicates: true,
    });
    return this.likeState(userId, id);
  }

  async unlike(userId: string, id: string): Promise<LikeStateDto> {
    await this.requireInteractable(userId, id);
    await this.prisma.reaction.deleteMany({ where: { postId: id, userId, type: 'LIKE' } });
    return this.likeState(userId, id);
  }

  /** Published + viewable, otherwise NOT_FOUND. Returns the raw row. */
  async requireInteractable(userId: string | null, id: string): Promise<PostRow> {
    const row = await this.prisma.post.findUnique({ where: { id }, include: postInclude });
    if (
      !row ||
      row.status !== 'PUBLISHED' ||
      !(await this.postVisibility.canView(this.prisma, userId, row))
    ) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    return row;
  }

  private async likeState(userId: string, id: string): Promise<LikeStateDto> {
    const [likes, mine] = await Promise.all([
      this.prisma.reaction.count({ where: { postId: id, type: 'LIKE' } }),
      this.prisma.reaction.count({ where: { postId: id, userId, type: 'LIKE' } }),
    ]);
    return { liked: mine > 0, likes };
  }

  // ───────────────────────── authority ─────────────────────────

  /**
   * May this user edit/delete the post and moderate its comments? Used for both the
   * capabilities in the DTO and every mutation guard.
   */
  async canEditPost(
    db: Db,
    userId: string,
    post: { authorId: string; authorType: PostAuthorType; authorEntityId: string; status: string },
  ): Promise<boolean> {
    if (post.status === 'DELETED') return false;
    const isEditor = post.authorId === userId;
    switch (post.authorType) {
      case 'USER':
        return isEditor && post.authorEntityId === userId;
      case 'CLUB': {
        const target = { type: 'CLUB', id: post.authorEntityId } as const;
        if (await this.policy.can(userId, Permission.CLUB_POSTS_MANAGE, target, db)) return true;
        return (
          isEditor && (await this.policy.can(userId, Permission.CLUB_POSTS_PUBLISH, target, db))
        );
      }
      case 'TOURNAMENT':
        return (
          isEditor &&
          (await this.policy.can(
            userId,
            Permission.TOURNAMENT_MANAGE,
            { type: 'TOURNAMENT', id: post.authorEntityId },
            db,
          ))
        );
      case 'VENUE':
        return (
          isEditor &&
          (await this.policy.can(
            userId,
            Permission.VENUE_MANAGE,
            { type: 'VENUE', id: post.authorEntityId },
            db,
          ))
        );
    }
  }

  private async loadEditable(tx: Tx, userId: string, id: string): Promise<PostRow> {
    const post = await tx.post.findUnique({ where: { id }, include: postInclude });
    if (!post || post.status === 'DELETED') throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    if (!(await this.canEditPost(tx, userId, post))) {
      if (!(await this.postVisibility.canView(tx, userId, post))) {
        throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
      }
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    return post;
  }

  /** Validates the "post as" target and the caller's right to publish as it. */
  private async resolveAuthor(
    tx: Tx,
    userId: string,
    type: PostAuthorType,
    entityId: string | undefined,
  ): Promise<string> {
    if (type === 'USER') {
      if (entityId !== undefined && entityId !== userId) {
        throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
      }
      return userId;
    }
    if (!entityId) {
      throw new ApiError(ErrorCode.VALIDATION, 'authorEntityId is required', {
        field: 'authorEntityId',
      });
    }
    switch (type) {
      case 'CLUB': {
        const club = await tx.club.findUnique({
          where: { id: entityId },
          select: { status: true },
        });
        if (!club || club.status !== 'ACTIVE')
          throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        await this.policy.assert(
          userId,
          Permission.CLUB_POSTS_PUBLISH,
          { type: 'CLUB', id: entityId },
          tx,
        );
        return entityId;
      }
      case 'TOURNAMENT': {
        const t = await tx.tournament.findUnique({ where: { id: entityId }, select: { id: true } });
        if (!t) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        await this.policy.assert(
          userId,
          Permission.TOURNAMENT_MANAGE,
          { type: 'TOURNAMENT', id: entityId },
          tx,
        );
        return entityId;
      }
      case 'VENUE': {
        const v = await tx.venue.findUnique({ where: { id: entityId }, select: { id: true } });
        if (!v) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        await this.policy.assert(
          userId,
          Permission.VENUE_MANAGE,
          { type: 'VENUE', id: entityId },
          tx,
        );
        return entityId;
      }
    }
  }

  /** A private-profile user can never publish PUBLIC (capped to FOLLOWERS). */
  private async effectiveAudience(
    tx: Tx,
    type: PostAuthorType,
    entityId: string,
    requested: PostAudience,
  ): Promise<PostAudience> {
    if (requested === 'CLUB_MEMBERS' && type !== 'CLUB') {
      throw new ApiError(ErrorCode.VALIDATION, 'CLUB_MEMBERS is only available for club posts', {
        field: 'audience',
      });
    }
    if (type === 'USER' && requested === 'PUBLIC') {
      const profile = await tx.profile.findUnique({
        where: { userId: entityId },
        select: { visibility: true },
      });
      if (profile?.visibility === 'PRIVATE') return 'FOLLOWERS';
    }
    return requested;
  }

  private async assertAchievement(
    tx: Tx,
    type: PostAuthorType,
    entityId: string,
    userId: string,
    achievementId: string | undefined,
  ): Promise<void> {
    if (!achievementId) return;
    const a = await tx.achievement.findUnique({ where: { id: achievementId } });
    const belongs =
      a !== null &&
      a.revokedAt === null &&
      ((type === 'USER' && a.recipientId === userId) || (type === 'CLUB' && a.clubId === entityId));
    if (!belongs) {
      throw new ApiError(ErrorCode.VALIDATION, 'This achievement cannot be attached', {
        field: 'achievementId',
      });
    }
  }

  private auditPublish(
    tx: Tx,
    actorId: string,
    postId: string,
    type: PostAuthorType,
    entityId: string,
    requestId: string,
  ) {
    if (type === 'USER') return Promise.resolve();
    return this.audit.record(tx, {
      actorId,
      action: 'post.published',
      targetType: 'POST',
      targetId: postId,
      metadata: { authorType: type, authorEntityId: entityId },
      requestId,
    });
  }

  // ───────────────────────── presentation ─────────────────────────

  private async presentOne(db: Db, viewerId: string, id: string): Promise<PostDto> {
    const row = await db.post.findUniqueOrThrow({ where: { id }, include: postInclude });
    return (await this.present(db, viewerId, [row]))[0] as PostDto;
  }

  /** Batch DTO builder. Callers must already have filtered rows through PostVisibilityService. */
  async present(db: Db, viewerId: string | null, rows: PostRow[]): Promise<PostDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [likeGroups, commentGroups, likedRows, savedRows, authors, mentionTargets, mediaSharing] =
      await Promise.all([
        db.reaction.groupBy({
          by: ['postId'],
          where: { postId: { in: ids }, type: 'LIKE' },
          _count: { _all: true },
        }),
        db.comment.groupBy({
          by: ['postId'],
          where: { postId: { in: ids }, deletedAt: null },
          _count: { _all: true },
        }),
        viewerId
          ? db.reaction.findMany({
              where: { postId: { in: ids }, userId: viewerId, type: 'LIKE' },
              select: { postId: true },
            })
          : [],
        viewerId
          ? db.savedPost.findMany({
              where: { postId: { in: ids }, userId: viewerId },
              select: { postId: true },
            })
          : [],
        this.resolveAuthors(
          db,
          rows.map((r) => ({ type: r.authorType, id: r.authorEntityId })),
        ),
        this.resolveMentionTargets(
          db,
          rows.flatMap((r) => r.mentions),
        ),
        db.privacyPolicy.findMany({
          where: {
            userId: {
              in: [...new Set(rows.filter((r) => r.authorType === 'USER').map((r) => r.authorEntityId))],
            },
          },
          select: { userId: true, externalMediaSharing: true },
        }),
      ]);
    const likes = new Map(likeGroups.map((g) => [g.postId, g._count._all]));
    const comments = new Map(commentGroups.map((g) => [g.postId, g._count._all]));
    const liked = new Set(likedRows.map((r) => r.postId));
    const saved = new Set(savedRows.map((r) => r.postId));
    const externalMediaSharing = new Map(mediaSharing.map((p) => [p.userId, p.externalMediaSharing]));
    const editCache = new Map<string, boolean>();

    const out: PostDto[] = [];
    for (const r of rows) {
      let canEdit = false;
      if (viewerId) {
        const k = `${r.authorType}:${r.authorEntityId}:${r.authorId === viewerId}`;
        let v = editCache.get(k);
        if (v === undefined) {
          v = await this.canEditPost(db, viewerId, r);
          editCache.set(k, v);
        }
        canEdit = v && r.status !== 'DELETED';
      }
      const published = r.status === 'PUBLISHED';
      const isEditor = viewerId !== null && r.authorId === viewerId;
      const mentions: PostMentionDto[] = r.mentions
        .filter((m) => m.status !== 'REMOVED' && (canEdit || isEditor || m.status === 'SHOWN'))
        .map((m) => {
          const info = mentionTargets.get(`${m.targetType}:${m.targetId}`);
          const dto: PostMentionDto = {
            id: m.id,
            targetType: m.targetType,
            targetId: m.targetId,
            name: info?.name ?? null,
            handle: info?.handle ?? null,
          };
          if (canEdit || isEditor) dto.status = m.status;
          return dto;
        });
      out.push({
        id: r.id,
        author: authors.get(`${r.authorType}:${r.authorEntityId}`) ?? {
          type: r.authorType,
          id: r.authorEntityId,
          name: null,
          handle: null,
          avatarId: null,
        },
        audience: r.audience,
        status: r.status,
        text: r.body,
        media: r.media.map((m) => ({ id: m.mediaId, kind: m.media.kind, position: m.position })),
        achievementId: r.achievementId,
        mentions,
        counts: { likes: likes.get(r.id) ?? 0, comments: comments.get(r.id) ?? 0 },
        viewer: { liked: liked.has(r.id), saved: saved.has(r.id) },
        capabilities: {
          canEdit,
          canDelete: canEdit,
          canComment: viewerId !== null && published && !r.commentsClosed,
          canLike: viewerId !== null && published,
          canReport: viewerId !== null && !isEditor && published,
          canManageComments: canEdit && published,
          canSaveMedia:
            r.media.length > 0 &&
            (r.authorType !== 'USER' || externalMediaSharing.get(r.authorEntityId) === true),
        },
        commentsClosed: r.commentsClosed,
        version: r.version,
        publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      });
    }
    return out;
  }

  /** Public identities of "posting as" entities (name + handle only). */
  async resolveAuthors(
    db: Db,
    refs: { type: PostAuthorType; id: string }[],
  ): Promise<Map<string, PostAuthorDto>> {
    const by = (t: PostAuthorType) => [
      ...new Set(refs.filter((r) => r.type === t).map((r) => r.id)),
    ];
    const [profiles, clubs, tournaments, venues] = await Promise.all([
      by('USER').length
        ? db.profile.findMany({
            where: { userId: { in: by('USER') } },
            select: { userId: true, nickname: true, username: true, avatarId: true },
          })
        : [],
      by('CLUB').length
        ? db.club.findMany({
            where: { id: { in: by('CLUB') } },
            select: { id: true, name: true, username: true, logoMediaId: true },
          })
        : [],
      by('TOURNAMENT').length
        ? db.tournament.findMany({
            where: { id: { in: by('TOURNAMENT') } },
            select: { id: true, name: true },
          })
        : [],
      by('VENUE').length
        ? db.venue.findMany({
            where: { id: { in: by('VENUE') } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    const map = new Map<string, PostAuthorDto>();
    for (const p of profiles)
      map.set(`USER:${p.userId}`, {
        type: 'USER',
        id: p.userId,
        name: p.nickname,
        handle: p.username,
        avatarId: p.avatarId,
      });
    for (const c of clubs)
      map.set(`CLUB:${c.id}`, {
        type: 'CLUB',
        id: c.id,
        name: c.name,
        handle: c.username,
        avatarId: c.logoMediaId,
      });
    for (const t of tournaments)
      map.set(`TOURNAMENT:${t.id}`, {
        type: 'TOURNAMENT',
        id: t.id,
        name: t.name,
        handle: null,
        avatarId: null,
      });
    for (const v of venues)
      map.set(`VENUE:${v.id}`, {
        type: 'VENUE',
        id: v.id,
        name: v.name,
        handle: null,
        avatarId: null,
      });
    return map;
  }

  private async resolveMentionTargets(
    db: Db,
    mentions: { targetType: 'USER' | 'CLUB'; targetId: string }[],
  ): Promise<Map<string, { name: string | null; handle: string | null }>> {
    const userIds = [
      ...new Set(mentions.filter((m) => m.targetType === 'USER').map((m) => m.targetId)),
    ];
    const clubIds = [
      ...new Set(mentions.filter((m) => m.targetType === 'CLUB').map((m) => m.targetId)),
    ];
    const [profiles, clubs] = await Promise.all([
      userIds.length
        ? db.profile.findMany({
            where: { userId: { in: userIds } },
            select: { userId: true, nickname: true, username: true },
          })
        : [],
      clubIds.length
        ? db.club.findMany({
            where: { id: { in: clubIds } },
            select: { id: true, name: true, username: true },
          })
        : [],
    ]);
    const map = new Map<string, { name: string | null; handle: string | null }>();
    for (const p of profiles) map.set(`USER:${p.userId}`, { name: p.nickname, handle: p.username });
    for (const c of clubs) map.set(`CLUB:${c.id}`, { name: c.name, handle: c.username });
    return map;
  }
}

function normaliseText(text: string | undefined): string | null {
  const t = text?.trim();
  if (!t) return null;
  if (t.length > POST_TEXT_MAX) {
    throw new ApiError(ErrorCode.VALIDATION, `Text is limited to ${POST_TEXT_MAX} characters`, {
      field: 'text',
      max: POST_TEXT_MAX,
    });
  }
  return t;
}

function assertHasContent(
  text: string | null,
  mediaCount: number,
  achievementId: string | undefined,
): void {
  if (!text && mediaCount === 0 && !achievementId) {
    throw new ApiError(ErrorCode.VALIDATION, 'A post needs text, media or an achievement', {
      field: 'text',
    });
  }
}

async function lockPost(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Post" WHERE id = ${id}::uuid FOR UPDATE`;
}
