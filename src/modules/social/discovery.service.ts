import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  clampPageSize,
  CursorKey,
  decodeCursor,
  encodeCursor,
  PageQuery,
} from '../../common/pagination/cursor-page';
import { Clock } from '../../common/time/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PostRow, PostsService } from '../posts/posts.service';
import { DiscoveryCategory, EntityCardDto, FeedItemDto, FeedPageDto } from './dto';

const RECENT_MS = 48 * 3_600_000;

function createdBefore(cursor: CursorKey | undefined) {
  if (!cursor) return {};
  const t = new Date(cursor.t);
  return { OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: cursor.id } }] };
}

/**
 * Home / Discovery. Order is deliberately plain and explainable (newest first); each item
 * carries `reasons` instead of a fake score. Recommendation ranking is an OPEN decision.
 * Only posts the viewer may see (PostVisibilityService) ever appear.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    private readonly clock: Clock,
  ) {}

  async forYou(viewerId: string, category: DiscoveryCategory, q: PageQuery): Promise<FeedPageDto> {
    switch (category) {
      case 'all':
      case 'media': {
        const where: Prisma.PostWhereInput = {
          authorId: { not: viewerId },
          ...(category === 'media' ? { media: { some: {} } } : {}),
        };
        const { rows, nextCursor } = await this.posts.scanVisible(viewerId, where, q);
        return this.postPage(viewerId, rows, nextCursor, true);
      }
      default:
        return this.recommendedEntities(viewerId, category, q);
    }
  }

  async following(
    viewerId: string,
    category: DiscoveryCategory,
    q: PageQuery,
  ): Promise<FeedPageDto> {
    const follows = await this.prisma.follow.findMany({
      where: { followerId: viewerId, status: 'ACCEPTED' },
      select: { targetType: true, targetId: true },
    });
    const ids = (t: string) => follows.filter((f) => f.targetType === t).map((f) => f.targetId);
    const byType: { authorType: 'USER' | 'CLUB' | 'TOURNAMENT' | 'VENUE'; ids: string[] }[] = [
      { authorType: 'USER', ids: ids('USER') },
      { authorType: 'CLUB', ids: ids('CLUB') },
      { authorType: 'TOURNAMENT', ids: ids('TOURNAMENT') },
      { authorType: 'VENUE', ids: ids('VENUE') },
    ];
    // "pitches" = places: posts of followed venues
    const wanted: Record<DiscoveryCategory, string[] | null> = {
      all: null,
      media: null,
      people: ['USER'],
      clubs: ['CLUB'],
      tournaments: ['TOURNAMENT'],
      pitches: ['VENUE'],
    };
    const allowed = wanted[category];
    const authorFilters = byType
      .filter((b) => b.ids.length > 0 && (!allowed || allowed.includes(b.authorType)))
      .map((b) => ({ authorType: b.authorType, authorEntityId: { in: b.ids } }));
    if (authorFilters.length === 0) return { items: [], nextCursor: null, caughtUp: true };
    const where: Prisma.PostWhereInput = {
      OR: authorFilters,
      ...(category === 'media' ? { media: { some: {} } } : {}),
    };
    const { rows, nextCursor } = await this.posts.scanVisible(viewerId, where, q);
    const dtos = await this.posts.present(this.prisma, viewerId, rows);
    return {
      items: dtos.map<FeedItemDto>((post) => ({
        kind: 'POST',
        post,
        entity: null,
        reasons: ['FOLLOWING'],
      })),
      nextCursor,
      caughtUp: nextCursor === null,
    };
  }

  private async postPage(
    viewerId: string,
    rows: PostRow[],
    nextCursor: string | null,
    explain: boolean,
  ): Promise<FeedPageDto> {
    const dtos = await this.posts.present(this.prisma, viewerId, rows);
    const reasons = explain ? await this.postReasons(viewerId, rows) : new Map<string, string[]>();
    return {
      items: dtos.map<FeedItemDto>((post) => ({
        kind: 'POST',
        post,
        entity: null,
        reasons: reasons.get(post.id) ?? [],
      })),
      nextCursor,
      caughtUp: nextCursor === null,
    };
  }

  /** Real, checkable facts only: following, followed-by, same city, club membership, recency. */
  private async postReasons(viewerId: string, rows: PostRow[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (rows.length === 0) return out;
    const userIds = [
      ...new Set(rows.filter((r) => r.authorType === 'USER').map((r) => r.authorEntityId)),
    ];
    const clubIds = [
      ...new Set(rows.filter((r) => r.authorType === 'CLUB').map((r) => r.authorEntityId)),
    ];
    const [me, follows, followedBy, memberships, profiles, clubs] = await Promise.all([
      this.prisma.profile.findUnique({ where: { userId: viewerId }, select: { city: true } }),
      this.prisma.follow.findMany({
        where: { followerId: viewerId, status: 'ACCEPTED' },
        select: { targetType: true, targetId: true },
      }),
      userIds.length
        ? this.prisma.follow.findMany({
            where: {
              followerId: { in: userIds },
              targetType: 'USER',
              targetId: viewerId,
              status: 'ACCEPTED',
            },
            select: { followerId: true },
          })
        : [],
      clubIds.length
        ? this.prisma.membership.findMany({
            where: { userId: viewerId, status: 'MEMBER', clubId: { in: clubIds } },
            select: { clubId: true },
          })
        : [],
      userIds.length
        ? this.prisma.profile.findMany({
            where: { userId: { in: userIds } },
            select: {
              userId: true,
              city: true,
              visibility: true,
              user: { select: { privacy: { select: { cityAudience: true } } } },
            },
          })
        : [],
      clubIds.length
        ? this.prisma.club.findMany({
            where: { id: { in: clubIds } },
            select: { id: true, city: true },
          })
        : [],
    ]);
    const followSet = new Set(follows.map((f) => `${f.targetType}:${f.targetId}`));
    const followsMe = new Set(followedBy.map((f) => f.followerId));
    const memberSet = new Set(memberships.map((m) => m.clubId));
    const userCity = new Map<string, string | null>();
    for (const p of profiles) {
      const audience = p.user.privacy?.cityAudience ?? 'ONLY_ME';
      const visible =
        (audience === 'EVERYONE' && p.visibility === 'PUBLIC') ||
        (audience !== 'ONLY_ME' && followSet.has(`USER:${p.userId}`));
      userCity.set(p.userId, visible ? p.city : null);
    }
    const clubCity = new Map(clubs.map((c) => [c.id, c.city]));
    const now = this.clock.now().getTime();
    const myCity = me?.city?.trim().toLowerCase();
    for (const r of rows) {
      const reasons: string[] = [];
      if (followSet.has(`${r.authorType}:${r.authorEntityId}`)) reasons.push('FOLLOWING');
      if (r.authorType === 'USER' && followsMe.has(r.authorEntityId)) reasons.push('FOLLOWS_YOU');
      if (r.authorType === 'CLUB' && memberSet.has(r.authorEntityId)) reasons.push('CLUB_MEMBER');
      const city =
        r.authorType === 'USER'
          ? userCity.get(r.authorEntityId)
          : r.authorType === 'CLUB'
            ? clubCity.get(r.authorEntityId)
            : null;
      if (myCity && city && city.trim().toLowerCase() === myCity) reasons.push('SAME_CITY');
      if (r.publishedAt && now - r.publishedAt.getTime() < RECENT_MS) reasons.push('RECENT');
      out.set(r.id, reasons);
    }
    return out;
  }

  /** people / clubs / tournaments / pitches: entities the viewer does not follow yet. */
  private async recommendedEntities(
    viewerId: string,
    category: Exclude<DiscoveryCategory, 'all' | 'media'>,
    q: PageQuery,
  ): Promise<FeedPageDto> {
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const before = createdBefore(cursor);
    const [me, follows, blocks, memberships] = await Promise.all([
      this.prisma.profile.findUnique({ where: { userId: viewerId }, select: { city: true } }),
      this.prisma.follow.findMany({
        where: { followerId: viewerId },
        select: { targetType: true, targetId: true },
      }),
      this.prisma.block.findMany({
        where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
        select: { blockerId: true, blockedId: true },
      }),
      this.prisma.membership.findMany({
        where: { userId: viewerId, status: 'MEMBER' },
        select: { clubId: true },
      }),
    ]);
    const followed = (t: string) =>
      follows.filter((f) => f.targetType === t).map((f) => f.targetId);
    const myCity = me?.city?.trim().toLowerCase();
    const reasonsFor = (city: string | null): string[] =>
      myCity && city && city.trim().toLowerCase() === myCity ? ['SAME_CITY'] : ['NEW'];

    let cards: { card: EntityCardDto; createdAt: Date; id: string }[];
    if (category === 'people') {
      const blocked = blocks.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId));
      const users = await this.prisma.user.findMany({
        where: {
          status: 'ACTIVE',
          id: { notIn: [viewerId, ...followed('USER'), ...blocked] },
          profile: { is: { username: { not: null } } },
          ...before,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          createdAt: true,
          profile: { select: { nickname: true, username: true, city: true, visibility: true } },
          privacy: { select: { cityAudience: true } },
        },
      });
      cards = users.map((u) => {
        const cityVisible =
          u.privacy?.cityAudience === 'EVERYONE' && u.profile?.visibility === 'PUBLIC';
        return {
          id: u.id,
          createdAt: u.createdAt,
          card: {
            entityType: 'PERSON',
            id: u.id,
            name: u.profile?.nickname ?? null,
            handle: u.profile?.username ?? null,
            city: cityVisible ? (u.profile?.city ?? null) : null,
          },
        };
      });
    } else if (category === 'clubs') {
      const clubs = await this.prisma.club.findMany({
        where: {
          status: 'ACTIVE',
          id: { notIn: [...followed('CLUB'), ...memberships.map((m) => m.clubId)] },
          ...before,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      cards = clubs.map((c) => ({
        id: c.id,
        createdAt: c.createdAt,
        card: { entityType: 'CLUB', id: c.id, name: c.name, handle: c.username, city: c.city },
      }));
    } else if (category === 'tournaments') {
      const ts = await this.prisma.tournament.findMany({
        where: {
          isPublic: true,
          status: { in: ['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'LIVE', 'POSTPONED'] },
          id: { notIn: followed('TOURNAMENT') },
          ...before,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      cards = ts.map((t) => ({
        id: t.id,
        createdAt: t.createdAt,
        card: { entityType: 'TOURNAMENT', id: t.id, name: t.name, handle: null, city: t.city },
      }));
    } else {
      const pitches = await this.prisma.pitch.findMany({
        where: {
          status: 'PUBLISHED',
          venue: { status: 'PUBLISHED' },
          id: { notIn: followed('PITCH') },
          ...before,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: { venue: { select: { city: true } } },
      });
      cards = pitches.map((p) => ({
        id: p.id,
        createdAt: p.createdAt,
        card: { entityType: 'PITCH', id: p.id, name: p.name, handle: null, city: p.venue.city },
      }));
    }
    const hasMore = cards.length > limit;
    const page = hasMore ? cards.slice(0, limit) : cards;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null;
    return {
      items: page.map<FeedItemDto>((c) => ({
        kind: 'ENTITY',
        post: null,
        entity: c.card,
        reasons: reasonsFor(c.card.city),
      })),
      nextCursor,
      caughtUp: nextCursor === null,
    };
  }
}
