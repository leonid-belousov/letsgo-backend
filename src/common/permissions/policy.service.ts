import { Global, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GrantResourceType, Prisma } from '@prisma/client';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ApiError, ErrorCode } from '../errors';
import { Clock } from '../time/clock';
import type { Db } from '../transactions/tx';
import {
  EVENT_TO_CLUB_PERMISSION,
  isKnownPermission,
  PERMISSION_CATALOG,
  type PermissionName,
} from './permissions';

export type PolicyTarget =
  | { type: 'PLATFORM' }
  | { type: 'CLUB'; id: string }
  | { type: 'EVENT'; id: string }
  | { type: 'VENUE'; id: string }
  | { type: 'PITCH'; id: string }
  | { type: 'TOURNAMENT'; id: string };

interface Candidate {
  resourceType: GrantResourceType;
  resourceId: string | null;
  permissions: string[];
}

/**
 * The single place that answers "may this user do X on Y?".
 *
 *  1. structural authority (club owner, event organiser, tournament organiser) — a
 *     relation, never a role *name*;
 *  2. valid RoleGrant rows (not revoked, not expired) on the resource or its container
 *     (event → club, pitch → venue).
 *
 * Capabilities returned to clients and every mutation guard call this same service.
 */
@Injectable()
export class PolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly clock: Clock,
  ) {}

  async can(
    userId: string,
    permission: PermissionName,
    target: PolicyTarget,
    db: Db = this.prisma,
  ): Promise<boolean> {
    if (!isKnownPermission(permission)) return false;
    const structural = await this.structuralGrants(userId, permission, target, db);
    if (structural.allowed) return true;
    return this.hasValidGrant(userId, structural.candidates, db);
  }

  async assert(
    userId: string,
    permission: PermissionName,
    target: PolicyTarget,
    db: Db = this.prisma,
  ): Promise<void> {
    if (!(await this.can(userId, permission, target, db))) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
  }

  /** Does the user hold structural authority (owner/organiser) over the target? */
  async hasStructuralAuthority(
    userId: string,
    target: PolicyTarget,
    db: Db = this.prisma,
  ): Promise<boolean> {
    switch (target.type) {
      case 'CLUB': {
        const club = await db.club.findUnique({
          where: { id: target.id },
          select: { ownerId: true },
        });
        return club?.ownerId === userId;
      }
      case 'EVENT': {
        const ev = await db.event.findUnique({
          where: { id: target.id },
          select: { organiserId: true },
        });
        return ev?.organiserId === userId;
      }
      case 'TOURNAMENT': {
        const t = await db.tournament.findUnique({
          where: { id: target.id },
          select: { organiserId: true },
        });
        return t?.organiserId === userId;
      }
      default:
        return false;
    }
  }

  /** Valid (unrevoked, unexpired) grant lookup used by delegation logic too. */
  async findValidGrant(
    userId: string,
    resourceType: GrantResourceType,
    resourceId: string | null,
    permissions: string[],
    db: Db = this.prisma,
  ) {
    const now = this.clock.now();
    return db.roleGrant.findMany({
      where: {
        granteeId: userId,
        resourceType,
        resourceId,
        permission: { in: permissions },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  }

  private async hasValidGrant(userId: string, candidates: Candidate[], db: Db): Promise<boolean> {
    if (candidates.length === 0) return false;
    const now = this.clock.now();
    const where: Prisma.RoleGrantWhereInput = {
      granteeId: userId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      AND: [
        {
          OR: candidates.map((c) => ({
            resourceType: c.resourceType,
            resourceId: c.resourceId,
            permission: { in: c.permissions },
          })),
        },
      ],
    };
    const found = await db.roleGrant.findFirst({ where, select: { id: true } });
    return found !== null;
  }

  private async structuralGrants(
    userId: string,
    permission: PermissionName,
    target: PolicyTarget,
    db: Db,
  ): Promise<{ allowed: boolean; candidates: Candidate[] }> {
    const def = PERMISSION_CATALOG[permission];
    const clubPerm = EVENT_TO_CLUB_PERMISSION[permission];

    switch (target.type) {
      case 'PLATFORM':
        return {
          allowed: false,
          candidates: [{ resourceType: 'PLATFORM', resourceId: null, permissions: [permission] }],
        };

      case 'CLUB': {
        const club = await db.club.findUnique({
          where: { id: target.id },
          select: { ownerId: true },
        });
        if (!club) return { allowed: false, candidates: [] };
        return {
          allowed: club.ownerId === userId && permission.startsWith('club.'),
          candidates: [{ resourceType: 'CLUB', resourceId: target.id, permissions: [permission] }],
        };
      }

      case 'EVENT': {
        const ev = await db.event.findUnique({
          where: { id: target.id },
          select: { organiserId: true, clubId: true },
        });
        if (!ev) return { allowed: false, candidates: [] };
        const candidates: Candidate[] = [
          {
            resourceType: 'EVENT',
            resourceId: target.id,
            permissions: clubPerm ? [permission, clubPerm] : [permission],
          },
        ];
        let allowed = false;
        if (ev.organiserId === userId && permission.startsWith('event.')) {
          // Cash confirmation is never implied by organising (OPEN decision #1)
          if (permission === 'event.cash.confirm' || permission === 'event.cash.correct') {
            allowed =
              !ev.clubId &&
              permission === 'event.cash.confirm' &&
              this.config.get('CASUAL_CASH_RECEIVER_POLICY', { infer: true }) === 'ORGANISER';
          } else {
            allowed = true;
          }
        }
        if (ev.clubId) {
          if (clubPerm) {
            candidates.push({
              resourceType: 'CLUB',
              resourceId: ev.clubId,
              permissions: [clubPerm],
            });
            // The club owner's authority extends to the club's events.
            if (!allowed) {
              const club = await db.club.findUnique({
                where: { id: ev.clubId },
                select: { ownerId: true },
              });
              allowed = club?.ownerId === userId;
            }
          }
        }
        return { allowed, candidates };
      }

      case 'VENUE':
        return {
          allowed: false,
          candidates: [{ resourceType: 'VENUE', resourceId: target.id, permissions: [permission] }],
        };

      case 'PITCH': {
        const pitch = await db.pitch.findUnique({
          where: { id: target.id },
          select: { venueId: true },
        });
        if (!pitch) return { allowed: false, candidates: [] };
        const candidates: Candidate[] = [];
        if (def.resources.includes('PITCH')) {
          candidates.push({
            resourceType: 'PITCH',
            resourceId: target.id,
            permissions: [permission],
          });
        }
        if (def.resources.includes('VENUE')) {
          candidates.push({
            resourceType: 'VENUE',
            resourceId: pitch.venueId,
            permissions: [permission],
          });
        }
        return { allowed: false, candidates };
      }

      case 'TOURNAMENT': {
        const t = await db.tournament.findUnique({
          where: { id: target.id },
          select: { organiserId: true },
        });
        if (!t) return { allowed: false, candidates: [] };
        return {
          allowed: t.organiserId === userId && permission.startsWith('tournament.'),
          candidates: [
            { resourceType: 'TOURNAMENT', resourceId: target.id, permissions: [permission] },
          ],
        };
      }
    }
  }
}

@Global()
@Module({ providers: [PolicyService], exports: [PolicyService] })
export class PermissionsModule {}
