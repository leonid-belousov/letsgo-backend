import type { Club, Membership } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { Permission } from '../../common/permissions/permissions';
import type { Db, Tx } from '../../common/transactions/tx';

/** Serialises membership / ownership operations of one club for the rest of the transaction. */
export async function lockClub(tx: Tx, clubId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Club" WHERE id = ${clubId}::uuid FOR UPDATE`;
}

export async function loadClub(db: Db, clubId: string): Promise<Club> {
  const club = await db.club.findUnique({ where: { id: clubId } });
  if (!club) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
  return club;
}

export function notAvailable(): ApiError {
  return new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
}

/** Creating or joining clubs needs a completed profile (nickname, handle, date of birth, city). */
export async function requireCompleteProfile(db: Db, userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { status: true } });
  const profile = await db.profile.findUnique({
    where: { userId },
    select: { completedAt: true },
  });
  if (user?.status !== 'ACTIVE' || !profile?.completedAt) {
    throw new ApiError(ErrorCode.VALIDATION, 'Complete your profile first.', { field: 'profile' });
  }
}

export function assertActive(club: Club): void {
  if (club.status !== 'ACTIVE') {
    throw new ApiError(ErrorCode.CONFLICT, 'This club is archived.', { reason: 'CLUB_ARCHIVED' });
  }
}

/**
 * Ends a person's grants on the club (and everything delegated from them) when their
 * membership ends — a grant must never outlive membership.
 */
export async function revokeClubGrants(
  tx: Tx,
  clubId: string,
  userId: string,
  actorId: string,
  now: Date,
  reason: string,
): Promise<number> {
  const roots = await tx.roleGrant.findMany({
    where: { granteeId: userId, resourceType: 'CLUB', resourceId: clubId, revokedAt: null },
    select: { id: true },
  });
  const all = new Set(roots.map((r) => r.id));
  let frontier = [...all];
  while (frontier.length > 0) {
    const children = await tx.roleGrant.findMany({
      where: { sourceGrantId: { in: frontier }, revokedAt: null },
      select: { id: true },
    });
    frontier = children.map((c) => c.id).filter((id) => !all.has(id));
    frontier.forEach((id) => all.add(id));
  }
  if (all.size === 0) return 0;
  const res = await tx.roleGrant.updateMany({
    where: { id: { in: [...all] }, revokedAt: null },
    data: { revokedAt: now, revokedById: actorId, revokedReason: reason },
  });
  return res.count;
}

/** Owner plus everybody holding a valid `club.members.approve` grant: recipients of join requests. */
export async function approverIds(db: Db, club: Club, now: Date): Promise<string[]> {
  const grants = await db.roleGrant.findMany({
    where: {
      resourceType: 'CLUB',
      resourceId: club.id,
      permission: Permission.CLUB_MEMBERS_APPROVE,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { granteeId: true },
  });
  return [...new Set([club.ownerId, ...grants.map((g) => g.granteeId)])];
}

export function isMember(m: Pick<Membership, 'status'> | null | undefined): boolean {
  return m?.status === 'MEMBER';
}
