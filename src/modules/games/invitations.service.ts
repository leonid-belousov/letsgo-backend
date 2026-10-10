import { Injectable } from '@nestjs/common';
import type { Event, Invitation } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import { lockEvent, type Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import { loadPersonSummaries, personOrUnknown } from '../users/person-summary';
import {
  GameListQuery,
  InvitationDto,
  MyInvitationDto,
  MyInvitationsQuery,
  ParticipationDto,
  type CreateInvitationsDto,
} from './dto';
import { GameViewService } from './game-view.service';
import { GamesService } from './games.service';
import { ParticipationService } from './participation.service';
import { ageEligibility, seatSummary } from './seats';

export interface InviteResult {
  created: InvitationDto[];
  skipped: { userId: string; reason: string }[];
}

/**
 * Invitation ≠ participation ≠ seat hold (DOC):
 *  - an ordinary invitation reserves nothing;
 *  - a priority invitation creates a SeatHold until `respondBy`, never exceeding free capacity;
 *  - confirming re-checks everything on the server; an expired/revoked invitation can never confirm.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly idempotency: IdempotencyService,
    private readonly participation: ParticipationService,
    private readonly games: GamesService,
    private readonly view: GameViewService,
    private readonly visibility: VisibilityService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {}

  async create(
    actorId: string,
    eventId: string,
    dto: CreateInvitationsDto,
    key: string | undefined,
  ): Promise<InviteResult> {
    return this.idempotency.execute(
      { userId: actorId, scope: `games.invite:${eventId}`, key, payload: dto },
      async (tx) => {
        await lockEvent(tx, eventId);
        const ev = await tx.event.findUnique({ where: { id: eventId } });
        if (!ev) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
        await this.policy.assert(actorId, 'event.squad.manage', { type: 'EVENT', id: eventId }, tx);
        const now = this.clock.now();
        if (ev.status !== 'PUBLISHED' || ev.startsAt <= now) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'Invitations can only be sent for an upcoming published game',
            { status: ev.status },
          );
        }
        const priority = dto.priority ?? false;
        if (priority) {
          if (!dto.respondBy) {
            throw new ApiError(
              ErrorCode.VALIDATION,
              'A priority invitation needs a reply-by deadline',
              { field: 'respondBy' },
            );
          }
        }
        if (dto.respondBy && (dto.respondBy <= now || dto.respondBy > ev.startsAt)) {
          throw new ApiError(
            ErrorCode.VALIDATION,
            'respondBy must be in the future and not after the start',
            { field: 'respondBy' },
          );
        }
        return this.createMany(tx, ev, actorId, [...new Set(dto.inviteeIds)], {
          priority,
          isGuest: dto.isGuest ?? false,
          respondBy: dto.respondBy ?? null,
          waveNumber: 1,
        });
      },
    );
  }

  /** "Invite remaining club players": the organiser triggers the next wave early (ordinary invitations, no holds). */
  async inviteRemainingClubPlayers(
    actorId: string,
    eventId: string,
    respondBy: Date | undefined,
    key: string | undefined,
  ): Promise<InviteResult> {
    return this.idempotency.execute(
      {
        userId: actorId,
        scope: `games.invite-remaining:${eventId}`,
        key,
        payload: { respondBy: respondBy ?? null },
      },
      async (tx) => {
        await lockEvent(tx, eventId);
        const ev = await tx.event.findUnique({ where: { id: eventId } });
        if (!ev) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
        await this.policy.assert(actorId, 'event.squad.manage', { type: 'EVENT', id: eventId }, tx);
        if (!ev.clubId)
          throw new ApiError(ErrorCode.CONFLICT, 'Only club games have remaining club players');
        if (ev.status !== 'PUBLISHED' || ev.startsAt <= this.clock.now()) {
          throw new ApiError(ErrorCode.CONFLICT, 'The game is not open for invitations');
        }
        return this.nextWave(tx, ev, actorId, respondBy ?? null);
      },
    );
  }

  /**
   * Next wave: ordinary invitations to club members who were never invited and are not in the game.
   * Shared by the organiser action and the automatic processor at the priority deadline. Caller holds
   * the event lock. Repeating it is harmless: everybody already invited/participating is skipped, so
   * no duplicate invitations exist and nothing is offered while the game is full.
   */
  async nextWave(
    tx: Tx,
    ev: Event,
    actorId: string,
    respondBy: Date | null,
  ): Promise<InviteResult> {
    const now = this.clock.now();
    if (!ev.clubId || ev.status !== 'PUBLISHED' || ev.startsAt <= now)
      return { created: [], skipped: [] };
    const summary = await seatSummary(tx, ev, now);
    if (summary.free <= 0) return { created: [], skipped: [] }; // full ⇒ no extra wave
    const members = await tx.membership.findMany({
      where: { clubId: ev.clubId, status: 'MEMBER' },
      select: { userId: true },
    });
    const existing = await tx.invitation.findMany({
      where: { eventId: ev.id },
      select: { inviteeId: true },
    });
    const parts = await tx.participation.findMany({
      where: { eventId: ev.id, status: { in: ['CONFIRMED', 'PENDING_APPROVAL', 'WAITLISTED'] } },
      select: { userId: true },
    });
    const skip = new Set([...existing.map((e) => e.inviteeId), ...parts.map((p) => p.userId)]);
    const ids = members.map((m) => m.userId).filter((u) => !skip.has(u));
    if (ids.length === 0) return { created: [], skipped: [] };
    const maxWave = await tx.invitation.aggregate({
      where: { eventId: ev.id },
      _max: { waveNumber: true },
    });
    return this.createMany(tx, ev, actorId, ids, {
      priority: false,
      isGuest: false,
      respondBy: respondBy && respondBy > now && respondBy <= ev.startsAt ? respondBy : null,
      waveNumber: (maxWave._max.waveNumber ?? 1) + 1,
    });
  }

  private async createMany(
    tx: Tx,
    ev: Event,
    actorId: string,
    inviteeIds: string[],
    opts: { priority: boolean; isGuest: boolean; respondBy: Date | null; waveNumber: number },
  ): Promise<InviteResult> {
    const now = this.clock.now();
    const skipped: InviteResult['skipped'] = [];
    const eligible: string[] = [];

    for (const inviteeId of inviteeIds) {
      if (inviteeId === actorId) {
        skipped.push({ userId: inviteeId, reason: 'SELF' });
        continue;
      }
      const user = await tx.user.findUnique({
        where: { id: inviteeId },
        select: { status: true, privacy: true },
      });
      if (user?.status !== 'ACTIVE' || !user.privacy) {
        skipped.push({ userId: inviteeId, reason: 'NOT_FOUND' });
        continue;
      }
      const rel = await this.visibility.relationship(actorId, inviteeId, tx);
      const sharesClub = ev.clubId
        ? (
            await tx.membership.findUnique({
              where: { clubId_userId: { clubId: ev.clubId, userId: inviteeId } },
            })
          )?.status === 'MEMBER'
        : false;
      if (rel.blocked || !this.visibility.canInvite(user.privacy, rel, sharesClub)) {
        skipped.push({ userId: inviteeId, reason: 'NOT_ALLOWED' });
        continue;
      }
      const part = await tx.participation.findUnique({
        where: { eventId_userId: { eventId: ev.id, userId: inviteeId } },
      });
      if (part?.status === 'CONFIRMED') {
        skipped.push({ userId: inviteeId, reason: 'ALREADY_CONFIRMED' });
        continue;
      }
      const inv = await tx.invitation.findUnique({
        where: { eventId_inviteeId: { eventId: ev.id, inviteeId } },
      });
      if (inv?.status === 'PENDING') {
        skipped.push({ userId: inviteeId, reason: 'ALREADY_INVITED' });
        continue;
      }
      eligible.push(inviteeId);
    }

    if (opts.priority) {
      const summary = await seatSummary(tx, ev, now);
      if (eligible.length > summary.free) {
        throw new ApiError(
          ErrorCode.CAPACITY_CHANGED,
          'Not enough free places to hold for all priority invitees',
          {
            free: summary.free,
            requested: eligible.length,
          },
        );
      }
    }

    const created: Invitation[] = [];
    for (const inviteeId of eligible) {
      const data = {
        eventId: ev.id,
        inviteeId,
        invitedById: actorId,
        status: 'PENDING' as const,
        priority: opts.priority,
        isGuest: opts.isGuest,
        waveNumber: opts.waveNumber,
        respondBy: opts.respondBy,
        respondedAt: null,
        createdAt: now,
      };
      const inv = await tx.invitation.upsert({
        where: { eventId_inviteeId: { eventId: ev.id, inviteeId } },
        create: data,
        update: { ...data },
      });
      // a fresh invitation must not inherit a stale hold
      await tx.seatHold.deleteMany({ where: { invitationId: inv.id } });
      if (opts.priority && opts.respondBy) {
        await tx.seatHold.create({
          data: {
            eventId: ev.id,
            invitationId: inv.id,
            userId: inviteeId,
            expiresAt: opts.respondBy,
          },
        });
      }
      created.push(inv);
      await this.notifier.notify(tx, {
        recipientIds: [inviteeId],
        category: 'invitation',
        activityKind: 'invitation.received',
        title: 'You were invited to a game',
        objectType: 'Event',
        objectId: ev.id,
        actorId,
        payload: {
          invitationId: inv.id,
          priority: opts.priority,
          respondBy: opts.respondBy ? opts.respondBy.toISOString() : null,
        },
        dedupeKey: `invitation:${inv.id}:${now.getTime()}:received`,
        chatCard: {
          type: 'INVITATION',
          payload: {
            invitationId: inv.id,
            eventId: ev.id,
            priority: opts.priority,
            respondBy: opts.respondBy ? opts.respondBy.toISOString() : null,
          },
        },
      });
    }
    return { created: await this.dtos(tx, created), skipped };
  }

  // ───────────── invitee ─────────────

  async respond(
    userId: string,
    invitationId: string,
    accept: boolean,
    key: string | undefined,
  ): Promise<ParticipationDto | InvitationDto> {
    const meta = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
      select: { eventId: true, inviteeId: true },
    });
    if (!meta || meta.inviteeId !== userId)
      throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return this.idempotency.execute(
      {
        userId,
        scope: `games.invitation.${accept ? 'confirm' : 'decline'}:${invitationId}`,
        key,
        payload: {},
      },
      async (tx) => {
        await lockEvent(tx, meta.eventId);
        const ev = await tx.event.findUniqueOrThrow({ where: { id: meta.eventId } });
        const inv = await tx.invitation.findUniqueOrThrow({ where: { id: invitationId } });
        const now = this.clock.now();

        if (!accept) {
          if (inv.status === 'DECLINED') return (await this.dtos(tx, [inv]))[0] as InvitationDto;
          if (inv.status !== 'PENDING')
            throw new ApiError(ErrorCode.EXPIRED, 'Invitation expired', { status: inv.status });
          const updated = await tx.invitation.update({
            where: { id: inv.id },
            data: { status: 'DECLINED', respondedAt: now },
          });
          await this.participation.releaseReservations(tx, ev.id, userId, now, 'DECLINED');
          await this.notifier.notify(tx, {
            recipientIds: [inv.invitedById],
            category: 'invitation',
            activityKind: 'invitation.declined',
            title: 'An invitation was declined',
            objectType: 'Event',
            objectId: ev.id,
            actorId: userId,
            essential: true,
            dedupeKey: `invitation:${inv.id}:declined`,
          });
          await this.participation.promoteWaitlist(tx, ev);
          return (await this.dtos(tx, [updated]))[0] as InvitationDto;
        }

        // ── confirm ──
        const existing = await tx.participation.findUnique({
          where: { eventId_userId: { eventId: ev.id, userId } },
        });
        if (inv.status === 'CONFIRMED' && existing) return this.participation.dto(tx, existing); // idempotent retry
        if (inv.status !== 'PENDING') {
          throw new ApiError(ErrorCode.EXPIRED, 'Invitation expired', { status: inv.status });
        }
        if (ev.status === 'CANCELLED')
          throw new ApiError(ErrorCode.EXPIRED, 'This game was cancelled', {
            reason: 'EVENT_CANCELLED',
          });
        if (ev.status !== 'PUBLISHED' || ev.startsAt <= now)
          throw new ApiError(ErrorCode.EXPIRED, 'Joining has closed for this game', {
            reason: 'CLOSED',
          });
        if (inv.respondBy && inv.respondBy <= now)
          throw new ApiError(ErrorCode.EXPIRED, 'Invitation expired', { reason: 'DEADLINE' });
        await this.participation.assertMayParticipate(tx, userId, ev);

        const profile = await tx.profile.findUnique({
          where: { userId },
          select: { dateOfBirth: true, completedAt: true },
        });
        if (!profile?.completedAt) {
          throw new ApiError(ErrorCode.VALIDATION, 'Complete your profile before joining a game', {
            reason: 'PROFILE_INCOMPLETE',
          });
        }
        const eligibility = ageEligibility(profile.dateOfBirth, ev);
        if (eligibility === 'NOT_ALLOWED')
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'This game is not open to your age group', {
            reason: 'AGE',
          });
        if (eligibility === 'UNKNOWN_DOB')
          throw new ApiError(
            ErrorCode.VALIDATION,
            'Date of birth is required for age-restricted games',
            { reason: 'DOB_REQUIRED' },
          );

        if (eligibility === 'EXCEPTION_REQUIRED') {
          // An invitation never bypasses the age rule: the organiser must still approve the exception.
          await tx.invitation.update({
            where: { id: inv.id },
            data: { status: 'CONFIRMED', respondedAt: now },
          });
          const row = existing
            ? await tx.participation.update({
                where: { id: existing.id },
                data: {
                  status: 'PENDING_APPROVAL',
                  ageExceptionRequested: true,
                  source: 'AGE_EXCEPTION',
                },
              })
            : await tx.participation.create({
                data: {
                  eventId: ev.id,
                  userId,
                  status: 'PENDING_APPROVAL',
                  source: 'AGE_EXCEPTION',
                  ageExceptionRequested: true,
                  isGuest: inv.isGuest,
                },
              });
          await this.participation.notifyDeciders(
            tx,
            ev,
            userId,
            'participation.requested',
            'Age exception requested',
          );
          return this.participation.dto(tx, row);
        }

        const hold = await this.participation.activeHold(tx, ev.id, userId, now);
        const summary = await seatSummary(tx, ev, now);
        if (!hold && summary.free <= 0) {
          throw new ApiError(ErrorCode.CAPACITY_CHANGED, 'That place was just taken.');
        }
        const row = await this.participation.confirmFromInvitation(tx, ev, inv, userId);
        await tx.invitation.update({
          where: { id: inv.id },
          data: { status: 'CONFIRMED', respondedAt: now },
        });
        await this.notifier.notify(tx, {
          recipientIds: [inv.invitedById],
          category: 'invitation',
          activityKind: 'invitation.confirmed',
          title: 'An invited player confirmed',
          objectType: 'Event',
          objectId: ev.id,
          actorId: userId,
          essential: true,
          dedupeKey: `invitation:${inv.id}:confirmed`,
        });
        return this.participation.dto(tx, row);
      },
    );
  }

  // ───────────── organiser ─────────────

  async revoke(
    actorId: string,
    invitationId: string,
    key: string | undefined,
  ): Promise<InvitationDto> {
    const meta = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
      select: { eventId: true },
    });
    if (!meta) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return this.idempotency.execute(
      { userId: actorId, scope: `games.invitation.revoke:${invitationId}`, key, payload: {} },
      async (tx) => {
        await lockEvent(tx, meta.eventId);
        const ev = await tx.event.findUniqueOrThrow({ where: { id: meta.eventId } });
        await this.policy.assert(actorId, 'event.squad.manage', { type: 'EVENT', id: ev.id }, tx);
        const inv = await tx.invitation.findUniqueOrThrow({ where: { id: invitationId } });
        if (inv.status === 'REVOKED') return (await this.dtos(tx, [inv]))[0] as InvitationDto;
        if (inv.status !== 'PENDING')
          throw new ApiError(ErrorCode.CONFLICT, 'Only pending invitations can be revoked', {
            status: inv.status,
          });
        const now = this.clock.now();
        const updated = await tx.invitation.update({
          where: { id: inv.id },
          data: { status: 'REVOKED', respondedAt: now },
        });
        await tx.seatHold.updateMany({
          where: { invitationId: inv.id, releasedAt: null },
          data: { releasedAt: now, releaseReason: 'REVOKED' },
        });
        await this.notifier.notify(tx, {
          recipientIds: [inv.inviteeId],
          category: 'invitation',
          activityKind: 'invitation.revoked',
          title: 'An invitation was withdrawn',
          objectType: 'Event',
          objectId: ev.id,
          actorId,
          essential: true,
          dedupeKey: `invitation:${inv.id}:revoked`,
        });
        await this.participation.promoteWaitlist(tx, ev);
        return (await this.dtos(tx, [updated]))[0] as InvitationDto;
      },
    );
  }

  /** Change the reply-by time of a pending invitation; affected invitee is notified; never adds capacity. */
  async extend(
    actorId: string,
    invitationId: string,
    respondBy: Date,
    key: string | undefined,
  ): Promise<InvitationDto> {
    const meta = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
      select: { eventId: true },
    });
    if (!meta) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return this.idempotency.execute(
      {
        userId: actorId,
        scope: `games.invitation.extend:${invitationId}`,
        key,
        payload: { respondBy },
      },
      async (tx) => {
        await lockEvent(tx, meta.eventId);
        const ev = await tx.event.findUniqueOrThrow({ where: { id: meta.eventId } });
        await this.policy.assert(actorId, 'event.squad.manage', { type: 'EVENT', id: ev.id }, tx);
        const inv = await tx.invitation.findUniqueOrThrow({ where: { id: invitationId } });
        const now = this.clock.now();
        if (inv.status !== 'PENDING')
          throw new ApiError(ErrorCode.CONFLICT, 'Only pending invitations can change deadline', {
            status: inv.status,
          });
        if (respondBy <= now || respondBy > ev.startsAt) {
          throw new ApiError(
            ErrorCode.VALIDATION,
            'respondBy must be in the future and not after the start',
            { field: 'respondBy' },
          );
        }
        const hold = await tx.seatHold.findUnique({ where: { invitationId: inv.id } });
        if (hold && (hold.releasedAt || hold.expiresAt <= now)) {
          // A lapsed hold cannot be silently revived: the place may have gone to somebody else.
          throw new ApiError(ErrorCode.EXPIRED, 'The hold already lapsed; send a new invitation', {
            reason: 'HOLD_LAPSED',
          });
        }
        const updated = await tx.invitation.update({ where: { id: inv.id }, data: { respondBy } });
        if (hold)
          await tx.seatHold.update({ where: { id: hold.id }, data: { expiresAt: respondBy } });
        await this.notifier.notify(tx, {
          recipientIds: [inv.inviteeId],
          category: 'invitation',
          activityKind: 'invitation.deadline_changed',
          title: 'The reply-by time of your invitation changed',
          objectType: 'Event',
          objectId: ev.id,
          actorId,
          essential: true,
          payload: { invitationId: inv.id, respondBy: respondBy.toISOString() },
          dedupeKey: `invitation:${inv.id}:deadline:${respondBy.getTime()}`,
        });
        return (await this.dtos(tx, [updated]))[0] as InvitationDto;
      },
    );
  }

  async listForEvent(actorId: string, eventId: string): Promise<InvitationDto[]> {
    await this.policy.assert(actorId, 'event.squad.manage', { type: 'EVENT', id: eventId });
    const rows = await this.prisma.invitation.findMany({
      where: { eventId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 300,
    });
    return this.dtos(this.prisma, rows);
  }

  /** Home: my active invitations, pinned above the feed and never hidden by feed filters. */
  async mine(userId: string, q: MyInvitationsQuery): Promise<MyInvitationDto[]> {
    const now = this.clock.now();
    const invs = await this.prisma.invitation.findMany({
      where: {
        inviteeId: userId,
        status: 'PENDING',
        OR: [{ respondBy: null }, { respondBy: { gt: now } }],
        event: { status: 'PUBLISHED', startsAt: { gt: now } },
      },
      include: { event: { include: GameViewService.include }, hold: true },
    });
    invs.sort((a, b) => {
      const ad = a.respondBy?.getTime() ?? Number.POSITIVE_INFINITY;
      const bd = b.respondBy?.getTime() ?? Number.POSITIVE_INFINITY;
      return ad - bd || a.event.startsAt.getTime() - b.event.startsAt.getTime();
    });
    const filters = Object.assign(new GameListQuery(), q);
    const matching = await this.games.matchingIds(
      userId,
      filters,
      invs.map((i) => i.eventId),
    );
    const summaries = await this.view.summaries(
      this.prisma,
      userId,
      invs.map((i) => i.event),
    );
    const people = await loadPersonSummaries(
      this.prisma,
      invs.map((i) => i.invitedById),
    );
    return invs.map((inv, i) => ({
      id: inv.id,
      status: inv.status,
      invitedBy: personOrUnknown(people, inv.invitedById),
      priority: inv.priority,
      respondBy: inv.respondBy?.toISOString() ?? null,
      heldUntil:
        inv.hold && !inv.hold.releasedAt && inv.hold.expiresAt > now
          ? inv.hold.expiresAt.toISOString()
          : null,
      matchesFilters: matching.has(inv.eventId),
      game: summaries[i] as MyInvitationDto['game'],
    }));
  }

  private async dtos(db: Tx | PrismaService, rows: Invitation[]): Promise<InvitationDto[]> {
    const people = await loadPersonSummaries(
      db,
      rows.flatMap((r) => [r.inviteeId, r.invitedById]),
    );
    const holds = await db.seatHold.findMany({
      where: { invitationId: { in: rows.map((r) => r.id) } },
    });
    const holdBy = new Map(holds.map((h) => [h.invitationId, h]));
    const now = this.clock.now();
    return rows.map((r) => {
      const h = holdBy.get(r.id);
      return {
        id: r.id,
        eventId: r.eventId,
        invitee: personOrUnknown(people, r.inviteeId),
        invitedBy: personOrUnknown(people, r.invitedById),
        status: r.status,
        priority: r.priority,
        isGuest: r.isGuest,
        waveNumber: r.waveNumber,
        respondBy: r.respondBy?.toISOString() ?? null,
        heldUntil: h && !h.releasedAt && h.expiresAt > now ? h.expiresAt.toISOString() : null,
        respondedAt: r.respondedAt?.toISOString() ?? null,
      };
    });
  }
}
