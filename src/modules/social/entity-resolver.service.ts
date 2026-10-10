import { Injectable } from '@nestjs/common';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { tournamentIsPublic } from '../posts/post-visibility.service';

export type EntityKind = 'USER' | 'CLUB' | 'EVENT' | 'VENUE' | 'PITCH' | 'TOURNAMENT';

export interface EntityRef {
  type: EntityKind;
  id: string;
}

export interface EntityInfo {
  type: EntityKind;
  id: string;
  name: string | null;
  handle: string | null;
  city: string | null;
}

export const entityKey = (r: EntityRef): string => `${r.type}:${r.id}`;

/**
 * Resolves polymorphic ids (Follow/Favourite targets) to what the *viewer* may see. Anything
 * missing or inaccessible to the viewer is simply absent from the result map, so callers can
 * return a neutral "unavailable" entry without leaking a title or cover.
 */
@Injectable()
export class EntityResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    viewerId: string | null,
    refs: readonly EntityRef[],
    db: Db = this.prisma,
  ): Promise<Map<string, EntityInfo>> {
    const out = new Map<string, EntityInfo>();
    const ids = (t: EntityKind) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];
    const userIds = ids('USER');
    const clubIds = ids('CLUB');
    const eventIds = ids('EVENT');
    const venueIds = ids('VENUE');
    const pitchIds = ids('PITCH');
    const tournamentIds = ids('TOURNAMENT');

    let blocked = new Set<string>();
    if (viewerId) {
      const blocks = await db.block.findMany({
        where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
        select: { blockerId: true, blockedId: true },
      });
      blocked = new Set(blocks.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId)));
    }

    if (userIds.length) {
      const users = await db.user.findMany({
        where: { id: { in: userIds }, status: 'ACTIVE', profile: { isNot: null } },
        select: { id: true, profile: { select: { nickname: true, username: true } } },
      });
      for (const u of users) {
        if (blocked.has(u.id)) continue;
        out.set(`USER:${u.id}`, {
          type: 'USER',
          id: u.id,
          name: u.profile?.nickname ?? null,
          handle: u.profile?.username ?? null,
          city: null,
        });
      }
    }
    if (clubIds.length) {
      const clubs = await db.club.findMany({
        where: { id: { in: clubIds }, status: 'ACTIVE' },
        select: { id: true, name: true, username: true, city: true },
      });
      for (const c of clubs) {
        out.set(`CLUB:${c.id}`, {
          type: 'CLUB',
          id: c.id,
          name: c.name,
          handle: c.username,
          city: c.city,
        });
      }
    }
    if (venueIds.length) {
      const venues = await db.venue.findMany({
        where: { id: { in: venueIds }, status: 'PUBLISHED' },
        select: { id: true, name: true, city: true },
      });
      for (const v of venues) {
        out.set(`VENUE:${v.id}`, {
          type: 'VENUE',
          id: v.id,
          name: v.name,
          handle: null,
          city: v.city,
        });
      }
    }
    if (pitchIds.length) {
      const pitches = await db.pitch.findMany({
        where: { id: { in: pitchIds }, status: 'PUBLISHED', venue: { status: 'PUBLISHED' } },
        select: { id: true, name: true, venue: { select: { city: true } } },
      });
      for (const p of pitches) {
        out.set(`PITCH:${p.id}`, {
          type: 'PITCH',
          id: p.id,
          name: p.name,
          handle: null,
          city: p.venue.city,
        });
      }
    }
    if (tournamentIds.length) {
      const ts = await db.tournament.findMany({
        where: { id: { in: tournamentIds } },
        select: {
          id: true,
          name: true,
          city: true,
          isPublic: true,
          status: true,
          organiserId: true,
        },
      });
      for (const t of ts) {
        if (!tournamentIsPublic(t) && t.organiserId !== viewerId) continue;
        out.set(`TOURNAMENT:${t.id}`, {
          type: 'TOURNAMENT',
          id: t.id,
          name: t.name,
          handle: null,
          city: t.city,
        });
      }
    }
    if (eventIds.length) {
      const events = await db.event.findMany({
        where: { id: { in: eventIds } },
        select: {
          id: true,
          title: true,
          status: true,
          organiserId: true,
          clubId: true,
          club: { select: { visibility: true, ownerId: true, status: true } },
          venue: { select: { city: true } },
        },
      });
      const clubIdsOfEvents = events.flatMap((e) => (e.clubId ? [e.clubId] : []));
      const memberSet = new Set<string>();
      if (viewerId && clubIdsOfEvents.length) {
        const ms = await db.membership.findMany({
          where: { userId: viewerId, status: 'MEMBER', clubId: { in: clubIdsOfEvents } },
          select: { clubId: true },
        });
        for (const m of ms) memberSet.add(m.clubId);
      }
      for (const e of events) {
        const isOrganiser = viewerId !== null && e.organiserId === viewerId;
        if (e.status === 'DRAFT' && !isOrganiser) continue;
        if (blocked.has(e.organiserId)) continue;
        if (e.club && !isOrganiser) {
          const member = memberSet.has(e.clubId as string) || e.club.ownerId === viewerId;
          if (e.club.visibility === 'PRIVATE' && !member) continue;
        }
        out.set(`EVENT:${e.id}`, {
          type: 'EVENT',
          id: e.id,
          name: e.title,
          handle: null,
          city: e.venue?.city ?? null,
        });
      }
    }
    return out;
  }
}
