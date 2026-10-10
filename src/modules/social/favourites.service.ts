import { Injectable } from '@nestjs/common';
import type { FavouriteTargetType } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { clampPageSize, decodeCursor, encodeCursor } from '../../common/pagination/cursor-page';
import { PostsService, postInclude } from '../posts/posts.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  FavouritePageDto,
  FavouritesQuery,
  FavouriteStateDto,
  FavouriteTab,
  SavedPostPageDto,
  SavedStateDto,
} from './dto';
import { EntityResolver } from './entity-resolver.service';
import { PostVisibilityService } from '../posts/post-visibility.service';
import { PageQuery } from '../../common/pagination/cursor-page';

const NOT_AVAILABLE = 'This content isn’t available';

const TAB_TYPES: Record<FavouriteTab, FavouriteTargetType[] | null> = {
  all: null,
  people: ['USER'],
  clubs: ['CLUB'],
  // tournaments are competitions people attend: they live under "Events"
  events: ['EVENT', 'TOURNAMENT'],
  places: ['VENUE', 'PITCH'],
};

/**
 * Favourites are private bookmarks: adding/removing never notifies the target and never
 * changes Follow or Membership. Bookmarked posts (SavedPost) live here too.
 */
@Injectable()
export class FavouritesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: EntityResolver,
    private readonly posts: PostsService,
    private readonly postVisibility: PostVisibilityService,
  ) {}

  async add(
    userId: string,
    targetType: FavouriteTargetType,
    targetId: string,
  ): Promise<FavouriteStateDto> {
    if (targetType === 'USER' && targetId === userId) {
      throw new ApiError(ErrorCode.VALIDATION, 'You cannot favourite yourself', {
        field: 'targetId',
      });
    }
    const found = await this.resolver.resolve(userId, [{ type: targetType, id: targetId }]);
    if (!found.has(`${targetType}:${targetId}`)) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    await this.prisma.favourite.createMany({
      data: [{ userId, targetType, targetId }],
      skipDuplicates: true,
    });
    return { targetType, targetId, favourited: true };
  }

  /** Always allowed, even when the target became inaccessible. Idempotent. */
  async remove(
    userId: string,
    targetType: FavouriteTargetType,
    targetId: string,
  ): Promise<FavouriteStateDto> {
    await this.prisma.favourite.deleteMany({ where: { userId, targetType, targetId } });
    return { targetType, targetId, favourited: false };
  }

  async state(
    userId: string,
    targetType: FavouriteTargetType,
    targetId: string,
  ): Promise<FavouriteStateDto> {
    const n = await this.prisma.favourite.count({ where: { userId, targetType, targetId } });
    return { targetType, targetId, favourited: n > 0 };
  }

  async list(userId: string, q: FavouritesQuery): Promise<FavouritePageDto> {
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const types = TAB_TYPES[q.tab ?? 'all'];
    const t = cursor ? new Date(cursor.t) : undefined;
    const rows = await this.prisma.favourite.findMany({
      where: {
        userId,
        ...(types ? { targetType: { in: types } } : {}),
        ...(t && cursor
          ? { OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const info = await this.resolver.resolve(
      userId,
      page.map((r) => ({ type: r.targetType, id: r.targetId })),
    );
    const last = page[page.length - 1];
    return {
      items: page.map((r) => {
        const e = info.get(`${r.targetType}:${r.targetId}`);
        return {
          id: r.id,
          targetType: r.targetType,
          targetId: r.targetId,
          unavailable: !e,
          entity: e ? { name: e.name, handle: e.handle, city: e.city } : null,
          createdAt: r.createdAt.toISOString(),
        };
      }),
      nextCursor:
        hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  // ───────────────────────── saved posts ─────────────────────────

  async savePost(userId: string, postId: string): Promise<SavedStateDto> {
    await this.posts.requireInteractable(userId, postId);
    await this.prisma.savedPost.createMany({ data: [{ userId, postId }], skipDuplicates: true });
    return { postId, saved: true };
  }

  async unsavePost(userId: string, postId: string): Promise<SavedStateDto> {
    await this.prisma.savedPost.deleteMany({ where: { userId, postId } });
    return { postId, saved: false };
  }

  /** Deleted posts vanish; posts the viewer can no longer see become neutral "unavailable". */
  async listSaved(userId: string, q: PageQuery): Promise<SavedPostPageDto> {
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const t = cursor ? new Date(cursor.t) : undefined;
    const rows = await this.prisma.savedPost.findMany({
      where: {
        userId,
        ...(t && cursor
          ? { OR: [{ createdAt: { lt: t } }, { createdAt: t, postId: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { postId: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const posts = await this.prisma.post.findMany({
      where: { id: { in: page.map((r) => r.postId) }, status: { not: 'DELETED' } },
      include: postInclude,
    });
    const byId = new Map(posts.map((p) => [p.id, p]));
    const viewable = await this.postVisibility.filterViewable(this.prisma, userId, posts);
    const visible = posts.filter((p) => viewable.has(p.id) && p.status === 'PUBLISHED');
    const dtos = new Map(
      (await this.posts.present(this.prisma, userId, visible)).map((d) => [d.id, d]),
    );
    const last = page[page.length - 1];
    return {
      items: page.flatMap((r) => {
        if (!byId.has(r.postId)) return []; // deleted
        const dto = dtos.get(r.postId);
        return [
          {
            postId: r.postId,
            savedAt: r.createdAt.toISOString(),
            unavailable: !dto,
            post: dto ?? null,
          },
        ];
      }),
      nextCursor:
        hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.postId }) : null,
    };
  }
}
