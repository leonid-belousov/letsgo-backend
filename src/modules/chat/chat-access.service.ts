import { Injectable } from '@nestjs/common';
import type { Conversation } from '@prisma/client';
import { PolicyService } from '../../common/permissions/policy.service';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';

export interface ChatRights {
  read: boolean;
  post: boolean;
}

const NONE: ChatRights = { read: false, post: false };

/**
 * Chat access is RECOMPUTED from the current state of the world on every read and every send —
 * holding a conversation id (or an old ConversationMember row) grants nothing. Losing access
 * (leaving the game, being removed, leaving the club, blocking) immediately stops sending.
 */
@Injectable()
export class ChatAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly visibility: VisibilityService,
  ) {}

  async rights(userId: string, conv: Conversation, db: Db = this.prisma): Promise<ChatRights> {
    switch (conv.kind) {
      case 'SYSTEM':
        return conv.directKey === `system:${userId}` ? { read: true, post: false } : NONE;

      case 'DIRECT': {
        const ids = (conv.directKey ?? '').split(':');
        if (ids.length !== 2 || !ids.includes(userId)) return NONE;
        const other = ids.find((i) => i !== userId);
        if (!other) return NONE;
        if (await this.visibility.isBlockedEitherWay(userId, other, db)) return NONE;
        const otherUser = await db.user.findUnique({
          where: { id: other },
          select: { status: true },
        });
        return otherUser?.status === 'ACTIVE'
          ? { read: true, post: true }
          : { read: true, post: false };
      }

      case 'EVENT': {
        if (!conv.eventId) return NONE;
        const ev = await db.event.findUnique({
          where: { id: conv.eventId },
          select: { id: true, status: true, organiserId: true },
        });
        if (!ev || ev.status === 'DRAFT') return NONE;
        const confirmed =
          (await db.participation.count({
            where: { eventId: ev.id, userId, status: 'CONFIRMED' },
          })) > 0;
        const staff =
          ev.organiserId === userId ||
          (await this.policy.can(userId, 'event.squad.manage', { type: 'EVENT', id: ev.id }, db));
        if (!confirmed && !staff) return NONE; // waitlisted/pending/invited never read the squad chat
        return { read: true, post: ev.status !== 'CANCELLED' };
      }

      case 'CLUB': {
        if (!conv.clubId) return NONE;
        const club = await db.club.findUnique({
          where: { id: conv.clubId },
          select: { ownerId: true, status: true },
        });
        if (!club) return NONE;
        const member =
          club.ownerId === userId ||
          (await db.membership.count({
            where: { clubId: conv.clubId, userId, status: 'MEMBER' },
          })) > 0;
        if (!member) return NONE;
        return { read: true, post: club.status === 'ACTIVE' };
      }

      case 'TOURNAMENT': {
        if (!conv.tournamentId) return NONE;
        const t = await db.tournament.findUnique({
          where: { id: conv.tournamentId },
          select: { status: true },
        });
        if (!t || t.status === 'DRAFT') return NONE;
        const target = { type: 'TOURNAMENT', id: conv.tournamentId } as const;
        const manager = await this.policy.can(userId, 'tournament.manage', target, db);
        if (manager) return { read: true, post: true };
        const assistant = await this.policy.can(userId, 'tournament.applications', target, db);
        if (assistant) return { read: true, post: true };
        // Announcements: readable by accepted clubs' representatives and their confirmed players; nobody else posts.
        const inSquad =
          (await db.clubEntryPlayer.count({
            where: {
              tournamentId: conv.tournamentId,
              userId,
              status: 'CONFIRMED',
              entry: { status: 'ACCEPTED' },
            },
          })) > 0;
        const rep = await db.clubEntry.findMany({
          where: { tournamentId: conv.tournamentId, status: 'ACCEPTED' },
          select: { clubId: true },
        });
        let isRep = false;
        for (const e of rep) {
          if (
            await this.policy.can(
              userId,
              'club.tournaments.enter',
              { type: 'CLUB', id: e.clubId },
              db,
            )
          ) {
            isRep = true;
            break;
          }
        }
        return inSquad || isRep ? { read: true, post: false } : NONE;
      }
    }
  }
}
