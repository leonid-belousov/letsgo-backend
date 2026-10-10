import { Injectable } from '@nestjs/common';
import type { ReportTargetType } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import type { Db } from '../../common/transactions/tx';
import { PostVisibilityService } from '../posts/post-visibility.service';
import type { TargetPreviewDto } from './dto';

const NOT_AVAILABLE = 'This content isn’t available';
const notFound = () => new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
const excerpt = (s: string | null | undefined): string | null =>
  s ? (s.length > 200 ? `${s.slice(0, 200)}…` : s) : null;

/**
 * Knows, for every reportable object, (a) whether a given person may see it — a reporter must be
 * able to view what they report, otherwise the answer is the neutral NOT_FOUND — and (b) who owns
 * it, so the moderation notice can reach the affected party.
 */
@Injectable()
export class ReportTargets {
  constructor(private readonly postVisibility: PostVisibilityService) {}

  /** Returns the owner (may be null for ownerless objects); throws NOT_FOUND when not viewable. */
  async assertViewable(
    db: Db,
    reporterId: string,
    type: ReportTargetType,
    id: string,
  ): Promise<{ ownerId: string | null }> {
    const owner = await this.viewableOwner(db, reporterId, type, id);
    if (owner === reporterId) {
      throw new ApiError(ErrorCode.VALIDATION, 'You cannot report your own content', {
        field: 'targetId',
      });
    }
    return { ownerId: owner };
  }

  private async viewableOwner(
    db: Db,
    reporterId: string,
    type: ReportTargetType,
    id: string,
  ): Promise<string | null> {
    switch (type) {
      case 'POST': {
        const post = await db.post.findUnique({ where: { id } });
        if (!post || !(await this.postVisibility.canView(db, reporterId, post))) throw notFound();
        return post.authorId;
      }
      case 'COMMENT': {
        const c = await db.comment.findUnique({ where: { id }, include: { post: true } });
        if (!c || c.deletedAt || !(await this.postVisibility.canView(db, reporterId, c.post))) {
          throw notFound();
        }
        return c.authorId;
      }
      case 'USER': {
        const u = await db.user.findUnique({ where: { id }, select: { status: true } });
        if (!u || u.status === 'DELETED') throw notFound();
        return id;
      }
      case 'CLUB': {
        const club = await db.club.findUnique({ where: { id } });
        if (!club || club.status !== 'ACTIVE') throw notFound();
        if (club.visibility === 'PRIVATE' && club.ownerId !== reporterId) {
          const m = await db.membership.findUnique({
            where: { clubId_userId: { clubId: id, userId: reporterId } },
            select: { status: true },
          });
          if (m?.status !== 'MEMBER') throw notFound();
        }
        return club.ownerId;
      }
      case 'EVENT': {
        const ev = await db.event.findUnique({
          where: { id },
          select: { status: true, organiserId: true },
        });
        if (!ev || ev.status === 'DRAFT') throw notFound();
        return ev.organiserId;
      }
      case 'TOURNAMENT': {
        const t = await db.tournament.findUnique({
          where: { id },
          select: { status: true, isPublic: true, organiserId: true },
        });
        if (!t || t.status === 'DRAFT' || (!t.isPublic && t.organiserId !== reporterId))
          throw notFound();
        return t.organiserId;
      }
      case 'VENUE': {
        const v = await db.venue.findUnique({
          where: { id },
          select: { status: true, createdById: true },
        });
        if (!v || v.status !== 'PUBLISHED') throw notFound();
        return v.createdById;
      }
      case 'MESSAGE': {
        const msg = await db.message.findUnique({ where: { id } });
        if (!msg || msg.deletedAt) throw notFound();
        const member = await db.conversationMember.findUnique({
          where: {
            conversationId_userId: { conversationId: msg.conversationId, userId: reporterId },
          },
          select: { leftAt: true },
        });
        if (!member || member.leftAt) throw notFound();
        if (!msg.senderId) {
          throw new ApiError(ErrorCode.VALIDATION, 'System messages cannot be reported', {
            field: 'targetId',
          });
        }
        return msg.senderId;
      }
      case 'MEDIA': {
        const media = await db.mediaAsset.findUnique({
          where: { id },
          include: { posts: { include: { post: true } } },
        });
        if (!media || media.status !== 'READY') throw notFound();
        if (media.ownerId === reporterId) return media.ownerId;
        let visible = media.visibility === 'PUBLIC';
        if (!visible) {
          for (const pm of media.posts) {
            if (await this.postVisibility.canView(db, reporterId, pm.post)) {
              visible = true;
              break;
            }
          }
        }
        if (!visible) throw notFound();
        return media.ownerId;
      }
    }
  }

  /** Context for staff; content is only shown to people with the moderation permission. */
  async preview(db: Db, type: ReportTargetType, id: string): Promise<TargetPreviewDto> {
    const none: TargetPreviewDto = { exists: false, ownerId: null, excerpt: null, state: null };
    switch (type) {
      case 'POST': {
        const p = await db.post.findUnique({ where: { id } });
        return p
          ? { exists: true, ownerId: p.authorId, excerpt: excerpt(p.body), state: p.status }
          : none;
      }
      case 'COMMENT': {
        const c = await db.comment.findUnique({ where: { id } });
        return c
          ? {
              exists: true,
              ownerId: c.authorId,
              excerpt: excerpt(c.body),
              state: c.deletedAt ? 'DELETED' : 'VISIBLE',
            }
          : none;
      }
      case 'USER': {
        const u = await db.user.findUnique({ where: { id }, include: { profile: true } });
        return u
          ? { exists: true, ownerId: id, excerpt: excerpt(u.profile?.nickname), state: u.status }
          : none;
      }
      case 'CLUB': {
        const c = await db.club.findUnique({ where: { id } });
        return c
          ? { exists: true, ownerId: c.ownerId, excerpt: excerpt(c.name), state: c.status }
          : none;
      }
      case 'EVENT': {
        const e = await db.event.findUnique({ where: { id } });
        return e
          ? { exists: true, ownerId: e.organiserId, excerpt: excerpt(e.title), state: e.status }
          : none;
      }
      case 'TOURNAMENT': {
        const t = await db.tournament.findUnique({ where: { id } });
        return t
          ? { exists: true, ownerId: t.organiserId, excerpt: excerpt(t.name), state: t.status }
          : none;
      }
      case 'VENUE': {
        const v = await db.venue.findUnique({ where: { id } });
        return v
          ? { exists: true, ownerId: v.createdById, excerpt: excerpt(v.name), state: v.status }
          : none;
      }
      case 'MESSAGE': {
        const m = await db.message.findUnique({ where: { id } });
        return m
          ? {
              exists: true,
              ownerId: m.senderId,
              excerpt: excerpt(m.body),
              state: m.deletedAt ? 'DELETED' : 'VISIBLE',
            }
          : none;
      }
      case 'MEDIA': {
        const m = await db.mediaAsset.findUnique({ where: { id } });
        return m ? { exists: true, ownerId: m.ownerId, excerpt: null, state: m.status } : none;
      }
    }
  }
}
