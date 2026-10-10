import { Injectable } from '@nestjs/common';
import type { Club, Membership, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import {
  clampPageSize,
  decodeCursor,
  keysetBefore,
  toPage,
  type PageQuery,
} from '../../common/pagination/cursor-page';
import { Permission, type PermissionName } from '../../common/permissions/permissions';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import { isUniqueViolation, type Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import {
  assertActive,
  loadClub,
  lockClub,
  notAvailable,
  requireCompleteProfile,
} from './club-support';
import {
  CLUB_USERNAME_PATTERN,
  ClubAwardDto,
  ClubAwardPageDto,
  ClubCapabilitiesDto,
  ClubDto,
  ClubSearchItemDto,
  ClubSearchPageDto,
  ClubSearchQuery,
  ClubUsernameAvailabilityDto,
  CreateClubAwardDto,
  CreateClubDto,
  MyClubItemDto,
  MyClubsPageDto,
  UpdateClubDto,
} from './dto';

const USERNAME_TAKEN = 'This username is taken.';

@Injectable()
export class ClubsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly visibility: VisibilityService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {}

  // ───────────── create / availability ─────────────

  async isUsernameAvailable(raw: string): Promise<ClubUsernameAvailabilityDto> {
    const username = raw.trim().toLowerCase();
    if (!CLUB_USERNAME_PATTERN.test(username)) return { username, available: false, valid: false };
    const taken = await this.prisma.club.findUnique({ where: { username }, select: { id: true } });
    return { username, available: taken === null, valid: true };
  }

  async create(
    userId: string,
    dto: CreateClubDto,
    idempotencyKey: string | undefined,
  ): Promise<ClubDto> {
    await requireCompleteProfile(this.prisma, userId);
    return this.idempotency.execute(
      { userId, scope: 'clubs.create', key: idempotencyKey, payload: dto },
      async (tx) => {
        const now = this.clock.now();
        const existing = await tx.club.findUnique({
          where: { username: dto.username },
          select: { id: true },
        });
        if (existing) throw this.usernameTaken();
        await this.assertReadyPhoto(tx, dto.logoMediaId, userId, 'logoMediaId');
        await this.assertReadyPhoto(tx, dto.coverMediaId, userId, 'coverMediaId');
        let club: Club;
        try {
          club = await tx.club.create({
            data: {
              name: dto.name,
              username: dto.username,
              city: dto.city,
              about: dto.about ?? null,
              preferredFormats: dto.preferredFormats ?? [],
              visibility: dto.visibility ?? 'PUBLIC',
              joinMode: dto.joinMode ?? 'APPROVE_REQUESTS',
              logoMediaId: dto.logoMediaId ?? null,
              coverMediaId: dto.coverMediaId ?? null,
              founderId: userId,
              ownerId: userId,
            },
          });
        } catch (err) {
          // The unique index is the source of truth for the username race.
          if (isUniqueViolation(err)) throw this.usernameTaken();
          throw err;
        }
        await tx.membership.create({
          data: { clubId: club.id, userId, status: 'MEMBER', joinedAt: now },
        });
        return this.toDto(tx, club, userId);
      },
    );
  }

  private usernameTaken(): ApiError {
    return new ApiError(ErrorCode.CONFLICT, USERNAME_TAKEN, { field: 'username' });
  }

  // ───────────── read ─────────────

  async get(viewerId: string | null, clubId: string): Promise<ClubDto> {
    const club = await loadClub(this.prisma, clubId);
    return this.toDto(this.prisma, await this.assertVisible(club, viewerId), viewerId);
  }

  async getByUsername(viewerId: string | null, rawUsername: string): Promise<ClubDto> {
    const club = await this.prisma.club.findUnique({
      where: { username: rawUsername.trim().toLowerCase() },
    });
    if (!club) throw notAvailable();
    return this.toDto(this.prisma, await this.assertVisible(club, viewerId), viewerId);
  }

  /**
   * Whether the viewer may open the club page at all. Archived clubs and clubs of an owner who
   * blocked the viewer (or vice versa) look like they do not exist; PRIVATE clubs stay reachable
   * (restricted card) so people can find and request to join them.
   */
  async assertVisible(club: Club, viewerId: string | null, db: Db = this.prisma): Promise<Club> {
    const membership = viewerId
      ? await db.membership.findUnique({
          where: { clubId_userId: { clubId: club.id, userId: viewerId } },
        })
      : null;
    const member = membership?.status === 'MEMBER';
    if (member || club.ownerId === viewerId) return club;
    if (club.status !== 'ACTIVE') throw notAvailable();
    if (viewerId && (await this.visibility.isBlockedEitherWay(viewerId, club.ownerId, db))) {
      throw notAvailable();
    }
    return club;
  }

  /** Can the viewer see the club's internals (members list, awards)? */
  async canSeeInternals(
    club: Club,
    viewerId: string | null,
    db: Db = this.prisma,
  ): Promise<boolean> {
    const membership = viewerId
      ? await db.membership.findUnique({
          where: { clubId_userId: { clubId: club.id, userId: viewerId } },
          select: { status: true },
        })
      : null;
    if (membership?.status === 'MEMBER' || club.ownerId === viewerId) return true;
    return club.visibility === 'PUBLIC';
  }

  async toDto(db: Db, club: Club, viewerId: string | null): Promise<ClubDto> {
    const membership = viewerId
      ? await db.membership.findUnique({
          where: { clubId_userId: { clubId: club.id, userId: viewerId } },
        })
      : null;
    const isOwner = club.ownerId === viewerId;
    const member = membership?.status === 'MEMBER';
    const restricted = club.visibility === 'PRIVATE' && !member && !isOwner;
    const capabilities = await this.capabilities(db, club, viewerId, membership);
    const dto: ClubDto = {
      id: club.id,
      entityType: 'CLUB',
      name: club.name,
      username: club.username,
      city: club.city,
      logoMediaId: club.logoMediaId,
      visibility: club.visibility,
      status: club.status,
      restricted,
      myMembership: membership
        ? { status: membership.status, roleTitle: membership.roleTitle, isOwner }
        : null,
      capabilities,
    };
    if (!restricted) {
      dto.about = club.about;
      dto.coverMediaId = club.coverMediaId;
      dto.joinMode = club.joinMode;
      dto.preferredFormats = club.preferredFormats;
      dto.founderId = club.founderId;
      dto.ownerId = club.ownerId;
      dto.memberCount = await db.membership.count({
        where: { clubId: club.id, status: 'MEMBER' },
      });
      if (capabilities.canEdit) dto.version = club.version;
    }
    return dto;
  }

  /** Same PolicyService calls that guard the mutations — never a separate rule set. */
  async capabilities(
    db: Db,
    club: Club,
    viewerId: string | null,
    membership: Membership | null,
  ): Promise<ClubCapabilitiesDto> {
    const none: ClubCapabilitiesDto = {
      canJoin: false,
      canRequestToJoin: false,
      canCancelRequest: false,
      canAcceptInvitation: false,
      canEdit: false,
      canInvite: false,
      canApprove: false,
      canRemoveMembers: false,
      canManageRoles: false,
      canManageAwards: false,
      canTransferOwnership: false,
      canArchive: false,
      canLeave: false,
    };
    if (!viewerId) return none;
    const active = club.status === 'ACTIVE';
    const status = membership?.status ?? null;
    const isOwner = club.ownerId === viewerId;
    const has = async (p: PermissionName): Promise<boolean> =>
      active && (await this.policy.can(viewerId, p, { type: 'CLUB', id: club.id }, db));
    // Sequential on purpose: `db` may be a transaction client (one connection).
    const canEdit = await has(Permission.CLUB_PROFILE_EDIT);
    const canInvite = await has(Permission.CLUB_MEMBERS_INVITE);
    const canApprove = await has(Permission.CLUB_MEMBERS_APPROVE);
    const canRemoveMembers = await has(Permission.CLUB_MEMBERS_REMOVE);
    const canManageAwards = await has(Permission.CLUB_AWARDS_MANAGE);
    const blocked = isOwner
      ? false
      : await this.visibility.isBlockedEitherWay(viewerId, club.ownerId, db);
    const canSelfServe = active && !blocked && status !== 'MEMBER' && status !== 'REMOVED';
    return {
      canJoin:
        canSelfServe && status !== 'INVITED' && status !== 'REQUESTED' && club.joinMode === 'OPEN',
      canRequestToJoin:
        canSelfServe &&
        status !== 'INVITED' &&
        status !== 'REQUESTED' &&
        club.joinMode === 'APPROVE_REQUESTS',
      canCancelRequest: status === 'REQUESTED',
      canAcceptInvitation: active && !blocked && status === 'INVITED',
      canEdit,
      canInvite,
      canApprove,
      canRemoveMembers,
      canManageRoles: active && (isOwner || canApprove),
      canManageAwards,
      canTransferOwnership: active && isOwner,
      canArchive: active && isOwner,
      canLeave: status === 'MEMBER' && !isOwner,
    };
  }

  // ───────────── update / archive ─────────────

  async update(userId: string, clubId: string, dto: UpdateClubDto): Promise<ClubDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockClub(tx, clubId);
      const club = await loadClub(tx, clubId);
      await this.assertCan(userId, Permission.CLUB_PROFILE_EDIT, club, tx);
      assertActive(club);
      if (dto.version !== club.version) {
        throw new ApiError(ErrorCode.VERSION_CHANGED, 'This club was changed elsewhere.', {
          currentVersion: club.version,
        });
      }
      const data: Prisma.ClubUpdateInput = { version: { increment: 1 } };
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.city !== undefined) data.city = dto.city;
      if (dto.about !== undefined) data.about = dto.about;
      if (dto.preferredFormats !== undefined) data.preferredFormats = dto.preferredFormats;
      if (dto.visibility !== undefined) data.visibility = dto.visibility;
      if (dto.joinMode !== undefined) data.joinMode = dto.joinMode;
      if (dto.logoMediaId !== undefined) {
        await this.assertReadyPhoto(tx, dto.logoMediaId, userId, 'logoMediaId');
        data.logoMediaId = dto.logoMediaId;
      }
      if (dto.coverMediaId !== undefined) {
        await this.assertReadyPhoto(tx, dto.coverMediaId, userId, 'coverMediaId');
        data.coverMediaId = dto.coverMediaId;
      }
      const updated = await tx.club.update({ where: { id: clubId }, data });
      return this.toDto(tx, updated, userId);
    });
  }

  private async assertReadyPhoto(
    db: Db,
    mediaId: string | null | undefined,
    ownerId: string,
    field: string,
  ): Promise<void> {
    if (mediaId == null) return;
    const media = await db.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { ownerId: true, kind: true, status: true },
    });
    if (!media || media.ownerId !== ownerId || media.kind !== 'PHOTO') {
      throw new ApiError(ErrorCode.VALIDATION, 'Choose one of your finished photos', { field });
    }
    if (media.status !== 'READY') {
      throw new ApiError(ErrorCode.UPLOAD_FAILED, 'The file is not ready yet', { field });
    }
  }

  /** Non-members get NOT_FOUND (do not reveal existence); members without the right get ACCESS_DENIED. */
  async assertCan(userId: string, permission: PermissionName, club: Club, db: Db): Promise<void> {
    if (await this.policy.can(userId, permission, { type: 'CLUB', id: club.id }, db)) return;
    await this.denyOrHide(userId, club, db);
  }

  private async denyOrHide(userId: string, club: Club, db: Db): Promise<never> {
    const m = await db.membership.findUnique({
      where: { clubId_userId: { clubId: club.id, userId } },
      select: { status: true },
    });
    if (m?.status === 'MEMBER' || club.visibility === 'PUBLIC') {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
    throw notAvailable();
  }

  async archive(userId: string, clubId: string, requestId: string): Promise<ClubDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockClub(tx, clubId);
      const club = await loadClub(tx, clubId);
      if (!(await this.policy.hasStructuralAuthority(userId, { type: 'CLUB', id: clubId }, tx))) {
        await this.denyOrHide(userId, club, tx);
      }
      if (club.status === 'ARCHIVED') return this.toDto(tx, club, userId);
      const now = this.clock.now();
      const updated = await tx.club.update({
        where: { id: clubId },
        data: { status: 'ARCHIVED', archivedAt: now, version: { increment: 1 } },
      });
      await tx.ownershipTransfer.updateMany({
        where: { clubId, status: 'PENDING' },
        data: { status: 'CANCELLED', respondedAt: now },
      });
      await this.audit.record(tx, {
        actorId: userId,
        action: 'club.archive',
        targetType: 'CLUB',
        targetId: clubId,
        metadata: { username: club.username },
        requestId,
      });
      const members = await tx.membership.findMany({
        where: { clubId, status: 'MEMBER' },
        select: { userId: true },
      });
      await this.notifier.notify(tx, {
        recipientIds: members.map((m) => m.userId),
        category: 'club',
        activityKind: 'club.archived',
        title: 'A club you belong to was archived',
        objectType: 'CLUB',
        objectId: clubId,
        actorId: userId,
        payload: { clubId },
        dedupeKey: `club:${clubId}:archived`,
        essential: true,
      });
      return this.toDto(tx, updated, userId);
    });
  }

  // ───────────── lists ─────────────

  async search(viewerId: string | null, q: ClubSearchQuery): Promise<ClubSearchPageDto> {
    const limit = clampPageSize(q.limit);
    const cursor = decodeCursor(q.cursor);
    const and: Prisma.ClubWhereInput[] = [{ status: 'ACTIVE' }];
    if (q.q) {
      and.push({
        OR: [
          { name: { contains: q.q, mode: 'insensitive' } },
          { username: { contains: q.q.toLowerCase() } },
        ],
      });
    }
    if (q.city) and.push({ city: { equals: q.city, mode: 'insensitive' } });
    if (viewerId) {
      const blocks = await this.prisma.block.findMany({
        where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
        select: { blockerId: true, blockedId: true },
      });
      const hidden = blocks.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId));
      if (hidden.length > 0) and.push({ ownerId: { notIn: hidden } });
    }
    const rows = await this.prisma.club.findMany({
      where: { AND: and, ...keysetBefore('createdAt', cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = toPage(rows, limit, (c) => ({ t: c.createdAt.toISOString(), id: c.id }));
    const counts = await this.memberCounts(page.items.filter((c) => c.visibility === 'PUBLIC'));
    return {
      items: page.items.map((c) => this.toSearchItem(c, counts.get(c.id) ?? 0)),
      nextCursor: page.nextCursor,
    };
  }

  private async memberCounts(clubs: Club[]): Promise<Map<string, number>> {
    if (clubs.length === 0) return new Map();
    const grouped = await this.prisma.membership.groupBy({
      by: ['clubId'],
      where: { clubId: { in: clubs.map((c) => c.id) }, status: 'MEMBER' },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.clubId, g._count._all]));
  }

  private toSearchItem(c: Club, memberCount: number): ClubSearchItemDto {
    const item: ClubSearchItemDto = {
      id: c.id,
      entityType: 'CLUB',
      name: c.name,
      username: c.username,
      city: c.city,
      logoMediaId: c.logoMediaId,
      visibility: c.visibility,
    };
    if (c.visibility === 'PUBLIC') {
      item.memberCount = memberCount;
      item.joinMode = c.joinMode;
    }
    return item;
  }

  async mine(userId: string, page: PageQuery): Promise<MyClubsPageDto> {
    const limit = clampPageSize(page.limit);
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.membership.findMany({
      where: { userId, status: 'MEMBER', ...keysetBefore('createdAt', cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { club: true },
    });
    const res = toPage(rows, limit, (m) => ({ t: m.createdAt.toISOString(), id: m.id }));
    const counts = await this.memberCounts(res.items.map((m) => m.club));
    // The viewer is a member, so the full card is theirs to see even for private clubs.
    const items: MyClubItemDto[] = res.items.map((m) => {
      const base = this.toSearchItem(m.club, counts.get(m.club.id) ?? 0);
      return {
        ...base,
        memberCount: counts.get(m.club.id) ?? 0,
        joinMode: m.club.joinMode,
        status: m.club.status,
        isOwner: m.club.ownerId === userId,
        roleTitle: m.roleTitle,
      };
    });
    return { items, nextCursor: res.nextCursor };
  }

  // ───────────── awards ─────────────

  async createAward(
    userId: string,
    clubId: string,
    dto: CreateClubAwardDto,
    requestId: string,
  ): Promise<ClubAwardDto> {
    return this.prisma.$transaction(async (tx) => {
      const club = await loadClub(tx, clubId);
      await this.assertCan(userId, Permission.CLUB_AWARDS_MANAGE, club, tx);
      assertActive(club);
      const member = await tx.membership.findUnique({
        where: { clubId_userId: { clubId, userId: dto.recipientId } },
        select: { status: true },
      });
      if (member?.status !== 'MEMBER') {
        throw new ApiError(ErrorCode.VALIDATION, 'Awards can only go to club members.', {
          field: 'recipientId',
        });
      }
      const a = await tx.achievement.create({
        data: {
          type: 'CLUB_AWARD',
          clubId,
          recipientId: dto.recipientId,
          title: dto.title,
          description: dto.description ?? null,
          grantedById: userId,
        },
      });
      await this.audit.record(tx, {
        actorId: userId,
        action: 'club.award.create',
        targetType: 'CLUB',
        targetId: clubId,
        metadata: { achievementId: a.id, recipientId: dto.recipientId },
        requestId,
      });
      await this.notifier.notify(tx, {
        recipientIds: [dto.recipientId],
        category: 'club',
        activityKind: 'club.award',
        title: 'You received a club award',
        objectType: 'CLUB',
        objectId: clubId,
        actorId: userId,
        payload: { clubId, achievementId: a.id },
        dedupeKey: `club-award:${a.id}`,
      });
      return this.toAwardDto(a);
    });
  }

  async listAwards(
    viewerId: string | null,
    clubId: string,
    page: PageQuery,
  ): Promise<ClubAwardPageDto> {
    const club = await this.assertVisible(await loadClub(this.prisma, clubId), viewerId);
    if (!(await this.canSeeInternals(club, viewerId))) throw notAvailable();
    const limit = clampPageSize(page.limit);
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.achievement.findMany({
      where: { clubId, type: 'CLUB_AWARD', revokedAt: null, ...keysetBefore('awardedAt', cursor) },
      orderBy: [{ awardedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const res = toPage(rows, limit, (a) => ({ t: a.awardedAt.toISOString(), id: a.id }));
    return { items: res.items.map((a) => this.toAwardDto(a)), nextCursor: res.nextCursor };
  }

  private toAwardDto(a: {
    id: string;
    clubId: string | null;
    title: string;
    description: string | null;
    recipientId: string;
    grantedById: string | null;
    awardedAt: Date;
  }): ClubAwardDto {
    return {
      id: a.id,
      clubId: a.clubId ?? '',
      type: 'CLUB_AWARD',
      clubAward: true,
      title: a.title,
      description: a.description,
      recipientId: a.recipientId,
      grantedById: a.grantedById,
      awardedAt: a.awardedAt.toISOString(),
    };
  }
}
