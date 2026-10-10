import { Injectable } from '@nestjs/common';
import type { PostAudience, PostAuthorType, PostStatus } from '@prisma/client';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** The minimal post shape the visibility rules need. */
export interface PostVisibilityInput {
  id: string;
  /** actual editor */
  authorId: string;
  authorType: PostAuthorType;
  authorEntityId: string;
  audience: PostAudience;
  status: PostStatus;
}

/** Tournaments/venues are visible to the public only when published. */
export function tournamentIsPublic(t: { isPublic: boolean; status: string }): boolean {
  return t.isPublic && t.status !== 'DRAFT';
}

/**
 * The single answer to "may this viewer see this post?". Every read path (detail, feeds,
 * comments, reactions, mentions, saved, tag requests) goes through it.
 *
 *  - DELETED: nobody. DRAFT: only the editor. ONLY_ME: only the editor.
 *  - blocked (either direction, editor or USER author): never.
 *  - PUBLIC: everybody, except posts of private-profile users / private clubs, which need
 *    an accepted follow (or membership).
 *  - FOLLOWERS: accepted followers of the author entity (club: or active members).
 *  - CLUB_MEMBERS: active members of the author club (and its owner).
 */
@Injectable()
export class PostVisibilityService {
  constructor(private readonly prisma: PrismaService) {}

  async canView(db: Db, viewerId: string | null, post: PostVisibilityInput): Promise<boolean> {
    return (await this.filterViewable(db, viewerId, [post])).has(post.id);
  }

  /** Batch variant: returns the ids of the posts the viewer may see. */
  async filterViewable(
    db: Db,
    viewerId: string | null,
    posts: readonly PostVisibilityInput[],
  ): Promise<Set<string>> {
    const allowed = new Set<string>();
    const pending: PostVisibilityInput[] = [];
    for (const p of posts) {
      if (p.status === 'DELETED') continue;
      if (p.status === 'DRAFT') {
        if (viewerId && p.authorId === viewerId) allowed.add(p.id);
        continue;
      }
      if (viewerId && p.authorId === viewerId) {
        allowed.add(p.id);
        continue;
      }
      if (p.audience === 'ONLY_ME') continue;
      pending.push(p);
    }
    if (pending.length === 0) return allowed;

    const ids = (type: PostAuthorType) => [
      ...new Set(pending.filter((p) => p.authorType === type).map((p) => p.authorEntityId)),
    ];
    const userIds = ids('USER');
    const clubIds = ids('CLUB');
    const tournamentIds = ids('TOURNAMENT');
    const venueIds = ids('VENUE');

    const blockedSet = new Set<string>();
    if (viewerId) {
      const counterparts = [...new Set([...pending.map((p) => p.authorId), ...userIds])];
      const blocks = await db.block.findMany({
        where: {
          OR: [
            { blockerId: viewerId, blockedId: { in: counterparts } },
            { blockedId: viewerId, blockerId: { in: counterparts } },
          ],
        },
        select: { blockerId: true, blockedId: true },
      });
      for (const b of blocks) blockedSet.add(b.blockerId === viewerId ? b.blockedId : b.blockerId);
    }

    const [users, clubs, tournaments, venues, follows, memberships] = await Promise.all([
      userIds.length
        ? db.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, status: true, profile: { select: { visibility: true } } },
          })
        : [],
      clubIds.length
        ? db.club.findMany({
            where: { id: { in: clubIds } },
            select: { id: true, visibility: true, status: true, ownerId: true },
          })
        : [],
      tournamentIds.length
        ? db.tournament.findMany({
            where: { id: { in: tournamentIds } },
            select: { id: true, isPublic: true, status: true, organiserId: true },
          })
        : [],
      venueIds.length
        ? db.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, status: true } })
        : [],
      viewerId
        ? db.follow.findMany({
            where: {
              followerId: viewerId,
              status: 'ACCEPTED',
              OR: [
                { targetType: 'USER', targetId: { in: userIds } },
                { targetType: 'CLUB', targetId: { in: clubIds } },
                { targetType: 'TOURNAMENT', targetId: { in: tournamentIds } },
                { targetType: 'VENUE', targetId: { in: venueIds } },
              ],
            },
            select: { targetType: true, targetId: true },
          })
        : [],
      viewerId && clubIds.length
        ? db.membership.findMany({
            where: { userId: viewerId, status: 'MEMBER', clubId: { in: clubIds } },
            select: { clubId: true },
          })
        : [],
    ]);

    const userBy = new Map(users.map((u) => [u.id, u]));
    const clubBy = new Map(clubs.map((c) => [c.id, c]));
    const tournamentBy = new Map(tournaments.map((t) => [t.id, t]));
    const venueBy = new Map(venues.map((v) => [v.id, v]));
    const followSet = new Set(follows.map((f) => `${f.targetType}:${f.targetId}`));
    const memberSet = new Set(memberships.map((m) => m.clubId));

    for (const p of pending) {
      if (blockedSet.has(p.authorId)) continue;
      if (p.authorType === 'USER' && blockedSet.has(p.authorEntityId)) continue;
      const follower = followSet.has(`${p.authorType}:${p.authorEntityId}`);
      let ok = false;
      switch (p.authorType) {
        case 'USER': {
          const u = userBy.get(p.authorEntityId);
          if (!u || u.status !== 'ACTIVE') break;
          const isPrivate = u.profile?.visibility === 'PRIVATE';
          if (p.audience === 'PUBLIC') ok = !isPrivate || follower;
          else if (p.audience === 'FOLLOWERS') ok = follower;
          break;
        }
        case 'CLUB': {
          const c = clubBy.get(p.authorEntityId);
          if (!c || c.status !== 'ACTIVE') break;
          const member = memberSet.has(c.id) || (viewerId !== null && c.ownerId === viewerId);
          if (p.audience === 'PUBLIC') ok = c.visibility === 'PUBLIC' || member || follower;
          else if (p.audience === 'FOLLOWERS') ok = follower || member;
          else if (p.audience === 'CLUB_MEMBERS') ok = member;
          break;
        }
        case 'TOURNAMENT': {
          const t = tournamentBy.get(p.authorEntityId);
          if (!t) break;
          if (viewerId && t.organiserId === viewerId) {
            ok = true;
            break;
          }
          if (!tournamentIsPublic(t)) break;
          if (p.audience === 'PUBLIC') ok = true;
          else if (p.audience === 'FOLLOWERS') ok = follower;
          break;
        }
        case 'VENUE': {
          const v = venueBy.get(p.authorEntityId);
          if (!v || v.status !== 'PUBLISHED') break;
          if (p.audience === 'PUBLIC') ok = true;
          else if (p.audience === 'FOLLOWERS') ok = follower;
          break;
        }
      }
      if (ok) allowed.add(p.id);
    }
    return allowed;
  }
}
