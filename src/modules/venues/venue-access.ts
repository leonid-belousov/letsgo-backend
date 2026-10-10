import { Injectable } from '@nestjs/common';
import { ApiError, ErrorCode } from '../../common/errors';
import { Permission, type PermissionName } from '../../common/permissions/permissions';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const STAFF_PERMISSIONS: PermissionName[] = [
  Permission.PITCH_MANAGE,
  Permission.VENUE_MANAGE,
  Permission.PITCH_CALENDAR_MANAGE,
  Permission.PITCH_BOOKINGS_DECIDE,
];

/** What catalog drafts a person is allowed to see (they manage or staff them). */
export interface ManagedScope {
  /** Platform catalog staff: everything. */
  all: boolean;
  venueIds: Set<string>;
  pitchIds: Set<string>;
  /** Venues that contain a pitch the user has a pitch-level grant on. */
  pitchVenueIds: Set<string>;
}

/**
 * Permission questions of the catalog, all answered through PolicyService:
 *  - platform catalog staff (`admin.catalog.manage`) manage everything;
 *  - `venue.manage` / `pitch.manage` grants (given by staff through the grants API) manage
 *    their venue / pitch; `pitch.manage` on a venue covers all its pitches.
 */
@Injectable()
export class VenueAccess {
  constructor(
    private readonly policy: PolicyService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  isCatalogAdmin(userId: string, db: Db = this.prisma): Promise<boolean> {
    return this.policy.can(userId, Permission.ADMIN_CATALOG, { type: 'PLATFORM' }, db);
  }

  async canManageVenue(userId: string, venueId: string, db: Db = this.prisma): Promise<boolean> {
    const target = { type: 'VENUE', id: venueId } as const;
    return (
      (await this.isCatalogAdmin(userId, db)) ||
      (await this.policy.can(userId, Permission.VENUE_MANAGE, target, db)) ||
      (await this.policy.can(userId, Permission.PITCH_MANAGE, target, db))
    );
  }

  async canPublishVenue(userId: string, venueId: string, db: Db = this.prisma): Promise<boolean> {
    return (
      (await this.isCatalogAdmin(userId, db)) ||
      (await this.policy.can(userId, Permission.VENUE_MANAGE, { type: 'VENUE', id: venueId }, db))
    );
  }

  async canManagePitch(userId: string, pitchId: string, db: Db = this.prisma): Promise<boolean> {
    return (
      (await this.isCatalogAdmin(userId, db)) ||
      (await this.policy.can(userId, Permission.PITCH_MANAGE, { type: 'PITCH', id: pitchId }, db))
    );
  }

  /** Calendar work, booking decisions or pitch management on this pitch. */
  async isPitchStaff(userId: string, pitchId: string, db: Db = this.prisma): Promise<boolean> {
    const target = { type: 'PITCH', id: pitchId } as const;
    return (
      (await this.canManagePitch(userId, pitchId, db)) ||
      (await this.policy.can(userId, Permission.PITCH_CALENDAR_MANAGE, target, db)) ||
      (await this.policy.can(userId, Permission.PITCH_BOOKINGS_DECIDE, target, db))
    );
  }

  async managedScope(userId: string | null, db: Db = this.prisma): Promise<ManagedScope> {
    const scope: ManagedScope = {
      all: false,
      venueIds: new Set(),
      pitchIds: new Set(),
      pitchVenueIds: new Set(),
    };
    if (!userId) return scope;
    scope.all = await this.isCatalogAdmin(userId, db);
    if (scope.all) return scope;
    const grants = await db.roleGrant.findMany({
      where: {
        granteeId: userId,
        resourceType: { in: ['VENUE', 'PITCH'] },
        permission: { in: STAFF_PERMISSIONS },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: this.clock.now() } }],
      },
      select: { resourceType: true, resourceId: true },
    });
    for (const g of grants) {
      if (!g.resourceId) continue;
      (g.resourceType === 'VENUE' ? scope.venueIds : scope.pitchIds).add(g.resourceId);
    }
    if (scope.pitchIds.size > 0) {
      const pitches = await db.pitch.findMany({
        where: { id: { in: [...scope.pitchIds] } },
        select: { venueId: true },
      });
      pitches.forEach((p) => scope.pitchVenueIds.add(p.venueId));
    }
    return scope;
  }

  canSeeVenue(scope: ManagedScope, venueId: string): boolean {
    return scope.all || scope.venueIds.has(venueId) || scope.pitchVenueIds.has(venueId);
  }

  canSeePitch(scope: ManagedScope, pitch: { id: string; venueId: string }): boolean {
    return scope.all || scope.venueIds.has(pitch.venueId) || scope.pitchIds.has(pitch.id);
  }
}

export function notAvailable(): ApiError {
  return new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
}

export function accessDenied(): ApiError {
  return new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
}
