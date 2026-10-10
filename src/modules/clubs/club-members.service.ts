import { Injectable } from '@nestjs/common';
import type { Club, Membership, MembershipStatus } from '@prisma/client';
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
import { Permission } from '../../common/permissions/permissions';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Db, Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import {
  approverIds,
  assertActive,
  loadClub,
  lockClub,
  notAvailable,
  requireCompleteProfile,
  revokeClubGrants,
} from './club-support';
import { ClubsService } from './clubs.service';
import {
  InviteResultDto,
  InviteResultItemDto,
  MemberDto,
  MemberPageDto,
  MembershipResultDto,
  MyInvitationPageDto,
  SetMemberTitleDto,
} from './dto';

@Injectable()
export class ClubMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly visibility: VisibilityService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
    private readonly clubs: ClubsService,
  ) {}

  // ───────────── self-service ─────────────

  /** OPEN → MEMBER, APPROVE_REQUESTS → REQUESTED, INVITE_ONLY → ACCESS_DENIED (unless invited). */
  async join(
    userId: string,
    clubId: string,
    idempotencyKey: string | undefined,
  ): Promise<MembershipResultDto> {
    await requireCompleteProfile(this.prisma, userId);
    return this.idempotency.execute(
      { userId, scope: `clubs.join:${clubId}`, key: idempotencyKey, payload: {} },
      async (tx) => {
        await lockClub(tx, clubId);
        const club = await loadClub(tx, clubId);
        this.assertOpenForJoining(club);
        if (await this.visibility.isBlockedEitherWay(userId, club.ownerId, tx))
          throw notAvailable();
        const existing = await this.find(tx, clubId, userId);
        const now = this.clock.now();

        if (existing?.status === 'MEMBER' || existing?.status === 'REQUESTED') {
          return this.result(clubId, userId, existing.status); // idempotent no-op
        }
        if (existing?.status === 'REMOVED') {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
        }
        if (existing?.status === 'INVITED') {
          await this.becomeMember(tx, clubId, userId, now);
          await this.notifyInviter(tx, club, existing, userId, 'accepted');
          return this.result(clubId, userId, 'MEMBER');
        }
        switch (club.joinMode) {
          case 'OPEN':
            await this.becomeMember(tx, clubId, userId, now);
            return this.result(clubId, userId, 'MEMBER');
          case 'APPROVE_REQUESTS':
            await this.upsert(tx, clubId, userId, {
              status: 'REQUESTED',
              joinedAt: null,
              leftAt: null,
            });
            await this.notifier.notify(tx, {
              recipientIds: await approverIds(tx, club, now),
              category: 'club',
              activityKind: 'club.join_requested',
              title: 'New request to join your club',
              objectType: 'CLUB',
              objectId: clubId,
              actorId: userId,
              payload: { clubId, userId },
              dedupeKey: `club-join-request:${clubId}:${userId}:${now.getTime()}`,
              essential: true,
            });
            return this.result(clubId, userId, 'REQUESTED');
          case 'INVITE_ONLY':
            throw new ApiError(
              ErrorCode.ACCESS_DENIED,
              'You no longer have access to this action.',
            );
        }
      },
    );
  }

  async cancelRequest(userId: string, clubId: string): Promise<MembershipResultDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockClub(tx, clubId);
      await loadClub(tx, clubId);
      const m = await this.find(tx, clubId, userId);
      if (m?.status !== 'REQUESTED') throw notAvailable();
      await tx.membership.delete({ where: { id: m.id } });
      return this.result(clubId, userId, 'LEFT');
    });
  }

  async leave(userId: string, clubId: string): Promise<MembershipResultDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockClub(tx, clubId);
      const club = await loadClub(tx, clubId);
      const m = await this.find(tx, clubId, userId);
      if (m?.status !== 'MEMBER') throw notAvailable();
      if (club.ownerId === userId) {
        throw new ApiError(
          ErrorCode.CONFLICT,
          'Transfer ownership to another member before leaving the club.',
          { reason: 'LAST_OWNER' },
        );
      }
      const now = this.clock.now();
      await tx.membership.update({ where: { id: m.id }, data: { status: 'LEFT', leftAt: now } });
      await revokeClubGrants(tx, clubId, userId, userId, now, 'MEMBERSHIP_ENDED');
      return this.result(clubId, userId, 'LEFT');
    });
  }

  // ───────────── invitations ─────────────

  async invite(
    actorId: string,
    clubId: string,
    userIds: string[],
    idempotencyKey: string | undefined,
  ): Promise<InviteResultDto> {
    return this.idempotency.execute(
      {
        userId: actorId,
        scope: `clubs.invite:${clubId}`,
        key: idempotencyKey,
        payload: { userIds: [...userIds].sort() },
      },
      async (tx) => {
        await lockClub(tx, clubId);
        const club = await loadClub(tx, clubId);
        await this.clubs.assertCan(actorId, Permission.CLUB_MEMBERS_INVITE, club, tx);
        assertActive(club);
        const now = this.clock.now();
        const results: InviteResultItemDto[] = [];
        for (const userId of [...new Set(userIds)]) {
          const outcome = await this.inviteOne(tx, club, actorId, userId, now);
          results.push({ userId, outcome });
        }
        return { results };
      },
    );
  }

  private async inviteOne(
    tx: Tx,
    club: Club,
    actorId: string,
    userId: string,
    now: Date,
  ): Promise<InviteResultItemDto['outcome']> {
    if (userId === actorId) return 'ALREADY_MEMBER';
    const target = await tx.user.findUnique({
      where: { id: userId },
      select: { status: true, profile: { select: { completedAt: true } }, privacy: true },
    });
    if (target?.status !== 'ACTIVE' || !target.profile?.completedAt) return 'NOT_FOUND';
    const existing = await this.find(tx, club.id, userId);
    if (existing?.status === 'MEMBER') return 'ALREADY_MEMBER';
    if (existing?.status === 'INVITED') return 'ALREADY_INVITED';
    if (existing?.status === 'REQUESTED') return 'ALREADY_REQUESTED';

    // Blocked people and the invitee's own invitation policy both read as NOT_ALLOWED.
    const rel = await this.visibility.relationship(actorId, userId, tx);
    if (rel.blocked) return 'NOT_ALLOWED';
    const policy = target.privacy?.invitationPolicy ?? 'EVERYONE';
    if (policy === 'NOBODY') return 'NOT_ALLOWED';
    if (policy === 'FOLLOWING' && !rel.followedByTarget) return 'NOT_ALLOWED';
    if (policy === 'CLUB_MEMBERS' && !(await this.sharesClub(tx, actorId, userId))) {
      return 'NOT_ALLOWED';
    }

    await this.upsert(tx, club.id, userId, {
      status: 'INVITED',
      invitedById: actorId,
      joinedAt: null,
      leftAt: null,
    });
    await this.notifier.notify(tx, {
      recipientIds: [userId],
      category: 'club',
      activityKind: 'club.invitation',
      title: 'You were invited to join a club',
      objectType: 'CLUB',
      objectId: club.id,
      actorId,
      payload: { clubId: club.id },
      dedupeKey: `club-invite:${club.id}:${userId}:${now.getTime()}`,
    });
    return 'INVITED';
  }

  private async sharesClub(tx: Tx, a: string, b: string): Promise<boolean> {
    const mine = await tx.membership.findMany({
      where: { userId: a, status: 'MEMBER' },
      select: { clubId: true },
    });
    if (mine.length === 0) return false;
    const common = await tx.membership.count({
      where: { userId: b, status: 'MEMBER', clubId: { in: mine.map((m) => m.clubId) } },
    });
    return common > 0;
  }

  async cancelInvitation(actorId: string, clubId: string, userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockClub(tx, clubId);
      const club = await loadClub(tx, clubId);
      await this.clubs.assertCan(actorId, Permission.CLUB_MEMBERS_INVITE, club, tx);
      const m = await this.find(tx, clubId, userId);
      if (m?.status !== 'INVITED') throw notAvailable();
      await tx.membership.delete({ where: { id: m.id } });
    });
  }

  async respondToInvitation(
    userId: string,
    clubId: string,
    accept: boolean,
  ): Promise<MembershipResultDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockClub(tx, clubId);
      const club = await loadClub(tx, clubId);
      const m = await this.find(tx, clubId, userId);
      if (m?.status !== 'INVITED') throw notAvailable();
      const now = this.clock.now();
      if (accept) {
        assertActive(club);
        if (await this.visibility.isBlockedEitherWay(userId, club.ownerId, tx))
          throw notAvailable();
        await requireCompleteProfile(tx, userId);
        await this.becomeMember(tx, clubId, userId, now);
        await this.notifyInviter(tx, club, m, userId, 'accepted');
        return this.result(clubId, userId, 'MEMBER');
      }
      await tx.membership.update({
        where: { id: m.id },
        data: { status: 'DECLINED', leftAt: now },
      });
      await this.notifyInviter(tx, club, m, userId, 'declined');
      return this.result(clubId, userId, 'DECLINED');
    });
  }

  private async notifyInviter(
    tx: Tx,
    club: Club,
    m: Membership,
    userId: string,
    what: 'accepted' | 'declined',
  ): Promise<void> {
    if (!m.invitedById) return;
    await this.notifier.notify(tx, {
      recipientIds: [m.invitedById],
      category: 'club',
      activityKind: `club.invitation_${what}`,
      title:
        what === 'accepted'
          ? 'Your club invitation was accepted'
          : 'Your club invitation was declined',
      objectType: 'CLUB',
      objectId: club.id,
      actorId: userId,
      payload: { clubId: club.id, userId },
      dedupeKey: `club-invite-${what}:${club.id}:${userId}:${this.clock.now().getTime()}`,
    });
  }

  async myInvitations(userId: string, page: PageQuery): Promise<MyInvitationPageDto> {
    const limit = clampPageSize(page.limit);
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.membership.findMany({
      where: {
        userId,
        status: 'INVITED',
        club: { status: 'ACTIVE' },
        ...keysetBefore('createdAt', cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { club: true },
    });
    const res = toPage(rows, limit, (m) => ({ t: m.createdAt.toISOString(), id: m.id }));
    return {
      items: res.items.map((m) => ({
        clubId: m.clubId,
        name: m.club.name,
        username: m.club.username,
        city: m.club.city,
        logoMediaId: m.club.logoMediaId,
        invitedById: m.invitedById,
        invitedAt: m.createdAt.toISOString(),
      })),
      nextCursor: res.nextCursor,
    };
  }

  // ───────────── join requests ─────────────

  async decideRequest(
    actorId: string,
    clubId: string,
    userId: string,
    approve: boolean,
    requestId: string,
  ): Promise<MembershipResultDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockClub(tx, clubId);
      const club = await loadClub(tx, clubId);
      await this.clubs.assertCan(actorId, Permission.CLUB_MEMBERS_APPROVE, club, tx);
      const m = await this.find(tx, clubId, userId);
      if (m?.status !== 'REQUESTED') throw notAvailable();
      const now = this.clock.now();
      if (approve) {
        assertActive(club);
        await this.becomeMember(tx, clubId, userId, now);
      } else {
        await tx.membership.update({
          where: { id: m.id },
          data: { status: 'DECLINED', leftAt: now },
        });
      }
      await this.audit.record(tx, {
        actorId,
        action: approve ? 'club.request.approve' : 'club.request.decline',
        targetType: 'CLUB',
        targetId: clubId,
        metadata: { userId },
        requestId,
      });
      await this.notifier.notify(tx, {
        recipientIds: [userId],
        category: 'club',
        activityKind: approve ? 'club.request_approved' : 'club.request_declined',
        title: approve
          ? 'Your request to join the club was approved'
          : 'Your request to join the club was declined',
        objectType: 'CLUB',
        objectId: clubId,
        actorId,
        payload: { clubId },
        dedupeKey: `club-request-${approve ? 'approved' : 'declined'}:${clubId}:${userId}:${now.getTime()}`,
      });
      return this.result(clubId, userId, approve ? 'MEMBER' : 'DECLINED');
    });
  }

  // ───────────── remove / title ─────────────

  async remove(
    actorId: string,
    clubId: string,
    userId: string,
    requestId: string,
  ): Promise<MembershipResultDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockClub(tx, clubId);
      const club = await loadClub(tx, clubId);
      await this.clubs.assertCan(actorId, Permission.CLUB_MEMBERS_REMOVE, club, tx);
      if (userId === club.ownerId) {
        throw new ApiError(ErrorCode.CONFLICT, 'The club owner cannot be removed.', {
          reason: 'OWNER_PROTECTED',
        });
      }
      if (userId === actorId) {
        throw new ApiError(ErrorCode.CONFLICT, 'Use “leave club” to leave yourself.');
      }
      const m = await this.find(tx, clubId, userId);
      if (m?.status !== 'MEMBER') throw notAvailable();
      const now = this.clock.now();
      await tx.membership.update({ where: { id: m.id }, data: { status: 'REMOVED', leftAt: now } });
      const revoked = await revokeClubGrants(tx, clubId, userId, actorId, now, 'MEMBER_REMOVED');
      await this.audit.record(tx, {
        actorId,
        action: 'club.member.remove',
        targetType: 'CLUB',
        targetId: clubId,
        metadata: { userId, revokedGrants: revoked },
        requestId,
      });
      await this.notifier.notify(tx, {
        recipientIds: [userId],
        category: 'club',
        activityKind: 'club.member_removed',
        title: 'You were removed from a club',
        objectType: 'CLUB',
        objectId: clubId,
        actorId,
        payload: { clubId },
        dedupeKey: `club-removed:${clubId}:${userId}:${now.getTime()}`,
        essential: true,
      });
      return this.result(clubId, userId, 'REMOVED');
    });
  }

  /** Display text only. Requires club.members.approve (or ownership); it never grants anything. */
  async setTitle(
    actorId: string,
    clubId: string,
    userId: string,
    dto: SetMemberTitleDto,
  ): Promise<MemberDto> {
    return this.prisma.$transaction(async (tx) => {
      const club = await loadClub(tx, clubId);
      await this.clubs.assertCan(actorId, Permission.CLUB_MEMBERS_APPROVE, club, tx);
      const m = await this.find(tx, clubId, userId);
      if (m?.status !== 'MEMBER') throw notAvailable();
      const data: { roleTitle?: string | null; showTitle?: boolean } = {};
      if (dto.roleTitle !== undefined) data.roleTitle = dto.roleTitle === '' ? null : dto.roleTitle;
      if (dto.showTitle !== undefined) data.showTitle = dto.showTitle;
      const updated = await tx.membership.update({ where: { id: m.id }, data });
      const [dtoOut] = await this.toMemberDtos(tx, club, [updated], actorId, true);
      return dtoOut as MemberDto;
    });
  }

  // ───────────── lists ─────────────

  async listMembers(
    viewerId: string | null,
    clubId: string,
    page: PageQuery,
  ): Promise<MemberPageDto> {
    const club = await this.clubs.assertVisible(await loadClub(this.prisma, clubId), viewerId);
    if (!(await this.clubs.canSeeInternals(club, viewerId))) throw notAvailable();
    return this.listByStatus(club, 'MEMBER', page, viewerId, false);
  }

  async listRequests(viewerId: string, clubId: string, page: PageQuery): Promise<MemberPageDto> {
    const club = await loadClub(this.prisma, clubId);
    await this.clubs.assertCan(viewerId, Permission.CLUB_MEMBERS_APPROVE, club, this.prisma);
    return this.listByStatus(club, 'REQUESTED', page, viewerId, true);
  }

  async listInvited(viewerId: string, clubId: string, page: PageQuery): Promise<MemberPageDto> {
    const club = await loadClub(this.prisma, clubId);
    const canInvite = await this.policy.can(viewerId, Permission.CLUB_MEMBERS_INVITE, {
      type: 'CLUB',
      id: clubId,
    });
    if (!canInvite) {
      await this.clubs.assertCan(viewerId, Permission.CLUB_MEMBERS_APPROVE, club, this.prisma);
    }
    return this.listByStatus(club, 'INVITED', page, viewerId, true);
  }

  private async listByStatus(
    club: Club,
    status: MembershipStatus,
    page: PageQuery,
    viewerId: string | null,
    staffView: boolean,
  ): Promise<MemberPageDto> {
    const limit = clampPageSize(page.limit);
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.membership.findMany({
      where: { clubId: club.id, status, ...keysetBefore('createdAt', cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const res = toPage(rows, limit, (m) => ({ t: m.createdAt.toISOString(), id: m.id }));
    return {
      items: await this.toMemberDtos(this.prisma, club, res.items, viewerId, staffView),
      nextCursor: res.nextCursor,
    };
  }

  private async toMemberDtos(
    db: Db,
    club: Club,
    rows: Membership[],
    viewerId: string | null,
    staffView: boolean,
  ): Promise<MemberDto[]> {
    const profiles = await db.profile.findMany({
      where: { userId: { in: rows.map((r) => r.userId) } },
      select: { userId: true, nickname: true, username: true, avatarId: true },
    });
    const by = new Map(profiles.map((p) => [p.userId, p]));
    const viewerIsManager = staffView || viewerId === club.ownerId;
    return rows.map((m) => {
      const p = by.get(m.userId);
      const titleVisible = m.showTitle || viewerIsManager || viewerId === m.userId;
      const dto: MemberDto = {
        userId: m.userId,
        entityType: 'PERSON',
        nickname: p?.nickname ?? null,
        username: p?.username ?? null,
        avatarId: p?.avatarId ?? null,
        status: m.status,
        roleTitle: titleVisible ? m.roleTitle : null,
        isOwner: m.userId === club.ownerId,
        isFounder: m.userId === club.founderId,
        joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
        requestedOrInvitedAt: m.createdAt.toISOString(),
      };
      if (staffView) dto.invitedById = m.invitedById;
      return dto;
    });
  }

  // ───────────── helpers ─────────────

  private assertOpenForJoining(club: Club): void {
    if (club.status !== 'ACTIVE') {
      throw new ApiError(ErrorCode.CONFLICT, 'This club is archived.', { reason: 'CLUB_ARCHIVED' });
    }
  }

  private find(db: Db, clubId: string, userId: string): Promise<Membership | null> {
    return db.membership.findUnique({ where: { clubId_userId: { clubId, userId } } });
  }

  private upsert(
    tx: Tx,
    clubId: string,
    userId: string,
    data: {
      status: MembershipStatus;
      invitedById?: string | null;
      joinedAt?: Date | null;
      leftAt?: Date | null;
    },
  ): Promise<Membership> {
    return tx.membership.upsert({
      where: { clubId_userId: { clubId, userId } },
      create: { clubId, userId, ...data },
      update: data,
    });
  }

  private async becomeMember(tx: Tx, clubId: string, userId: string, now: Date): Promise<void> {
    await this.upsert(tx, clubId, userId, { status: 'MEMBER', joinedAt: now, leftAt: null });
  }

  private result(clubId: string, userId: string, status: MembershipStatus): MembershipResultDto {
    return { clubId, userId, status };
  }
}
