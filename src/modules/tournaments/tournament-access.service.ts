import { Injectable } from '@nestjs/common';
import type { Tournament, TournamentStatus } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import type { PermissionName } from '../../common/permissions/permissions';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Db, Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';

export const NOT_AVAILABLE = 'This content isn’t available';
export const TERMINAL: TournamentStatus[] = ['FINISHED', 'CANCELLED'];
export const ACTIVE_ENTRY = ['APPLIED', 'INVITED', 'ACCEPTED', 'WAITLISTED'] as const;

/** Row lock on the Tournament: serialises capacity decisions, squad changes, results and schedules. */
export async function lockTournament(tx: Tx, tournamentId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id = ${tournamentId}::uuid FOR UPDATE`;
}

/**
 * Who may see / do what on a tournament. Manage rights are STRUCTURAL: only the chief organiser
 * (Tournament.organiserId) has them - a stray `tournament.manage` grant is ignored. Module rights
 * (applications, schedule, protocols, cash, sponsors) go through PolicyService, so the organiser
 * and valid assistants pass and everybody else is refused.
 */
@Injectable()
export class TournamentAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly visibility: VisibilityService,
    private readonly clock: Clock,
  ) {}

  async find(db: Db, id: string): Promise<Tournament | null> {
    return db.tournament.findUnique({ where: { id } });
  }

  /** Loads a tournament the viewer may see; otherwise NOT_FOUND (existence is never revealed). */
  async loadVisible(db: Db, viewerId: string | null, id: string): Promise<Tournament> {
    const t = await this.find(db, id);
    if (!t || !(await this.isVisible(db, viewerId, t))) {
      throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
    }
    return t;
  }

  async isVisible(db: Db, viewerId: string | null, t: Tournament): Promise<boolean> {
    if (viewerId && t.organiserId === viewerId) return true;
    if (t.status === 'DRAFT' || !t.publishedAt) return false;
    if (viewerId && (await this.visibility.isBlockedEitherWay(viewerId, t.organiserId, db))) {
      return false;
    }
    if (t.isPublic) return true;
    if (!viewerId) return false;
    return this.isInvolved(db, viewerId, t.id);
  }

  /** Assistant, club representative of an entry, or squad member. */
  async isInvolved(db: Db, userId: string, tournamentId: string): Promise<boolean> {
    if (await this.hasAnyModule(db, userId, tournamentId)) return true;
    const entry = await db.clubEntry.findFirst({
      where: {
        tournamentId,
        OR: [
          { submittedById: userId },
          { players: { some: { userId } } },
          { club: { ownerId: userId } },
        ],
      },
      select: { id: true },
    });
    if (entry) return true;
    const actsFor = await this.clubsFor(db, userId, [
      'club.tournaments.enter',
      'club.squad.manage',
    ]);
    if (actsFor.length === 0) return false;
    return (await db.clubEntry.count({ where: { tournamentId, clubId: { in: actsFor } } })) > 0;
  }

  private async hasAnyModule(db: Db, userId: string, tournamentId: string): Promise<boolean> {
    const now = this.clock.now();
    const g = await db.roleGrant.findFirst({
      where: {
        granteeId: userId,
        resourceType: 'TOURNAMENT',
        resourceId: tournamentId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true },
    });
    return g !== null;
  }

  isOrganiser(userId: string, t: Pick<Tournament, 'organiserId'>): boolean {
    return t.organiserId === userId;
  }

  /** Chief-organiser-only action. */
  assertOrganiser(userId: string, t: Pick<Tournament, 'organiserId'>): void {
    if (t.organiserId !== userId) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
  }

  async can(db: Db, userId: string, permission: PermissionName, t: Pick<Tournament, 'id'>) {
    return this.policy.can(userId, permission, { type: 'TOURNAMENT', id: t.id }, db);
  }

  async assertCan(
    db: Db,
    userId: string,
    permission: PermissionName,
    t: Pick<Tournament, 'id'>,
  ): Promise<void> {
    await this.policy.assert(userId, permission, { type: 'TOURNAMENT', id: t.id }, db);
  }

  /** Organiser or holder of ANY of the module permissions. */
  async canAny(
    db: Db,
    userId: string,
    permissions: PermissionName[],
    t: Pick<Tournament, 'id' | 'organiserId'>,
  ): Promise<boolean> {
    if (t.organiserId === userId) return true;
    for (const p of permissions) if (await this.can(db, userId, p, t)) return true;
    return false;
  }

  async assertAny(
    db: Db,
    userId: string,
    permissions: PermissionName[],
    t: Pick<Tournament, 'id' | 'organiserId'>,
  ): Promise<void> {
    if (!(await this.canAny(db, userId, permissions, t))) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
  }

  assertNotTerminal(t: Pick<Tournament, 'status'>): void {
    if (TERMINAL.includes(t.status)) {
      throw new ApiError(ErrorCode.CONFLICT, 'This tournament is closed for changes', {
        status: t.status,
      });
    }
  }

  /** User ids holding a valid grant for any of the permissions (assistants) + the organiser. */
  async holders(db: Db, t: Pick<Tournament, 'id' | 'organiserId'>, permissions: PermissionName[]) {
    const now = this.clock.now();
    const rows = await db.roleGrant.findMany({
      where: {
        resourceType: 'TOURNAMENT',
        resourceId: t.id,
        permission: { in: permissions },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { granteeId: true },
    });
    return [...new Set([t.organiserId, ...rows.map((r) => r.granteeId)])];
  }

  /** Clubs the user may act for: owner (all club.*) or holder of one of the club permissions. */
  async clubsFor(db: Db, userId: string, permissions: string[]): Promise<string[]> {
    const now = this.clock.now();
    const [owned, granted] = await Promise.all([
      db.club.findMany({ where: { ownerId: userId, status: 'ACTIVE' }, select: { id: true } }),
      db.roleGrant.findMany({
        where: {
          granteeId: userId,
          resourceType: 'CLUB',
          permission: { in: permissions },
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { resourceId: true },
      }),
    ]);
    return [
      ...new Set([
        ...owned.map((c) => c.id),
        ...granted.flatMap((g) => (g.resourceId ? [g.resourceId] : [])),
      ]),
    ];
  }

  /** People to notify on a club's behalf: its owner and every holder of `club.tournaments.enter`. */
  async clubRepresentatives(db: Db, clubId: string): Promise<string[]> {
    const now = this.clock.now();
    const [club, grants] = await Promise.all([
      db.club.findUnique({ where: { id: clubId }, select: { ownerId: true } }),
      db.roleGrant.findMany({
        where: {
          resourceType: 'CLUB',
          resourceId: clubId,
          permission: 'club.tournaments.enter',
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { granteeId: true },
      }),
    ]);
    return [...new Set([...(club ? [club.ownerId] : []), ...grants.map((g) => g.granteeId)])];
  }
}
