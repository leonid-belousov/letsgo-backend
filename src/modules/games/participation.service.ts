import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Event, Invitation, Participation } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import { lockEvent, type Tx } from '../../common/transactions/tx';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { VisibilityService } from '../privacy/visibility.service';
import { ParticipationDto } from './dto';
import { ageEligibility, seatSummary, teamCapacity } from './seats';

/**
 * All seat-affecting transitions live here and ALWAYS run under a row lock on the Event
 * (`SELECT … FOR UPDATE`), so two people racing for the last place serialise in PostgreSQL:
 * exactly one is confirmed, the other gets CAPACITY_CHANGED (or the waitlist).
 */
@Injectable()
export class ParticipationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly policy: PolicyService,
    private readonly payments: PaymentsService,
    private readonly notifier: Notifier,
    private readonly visibility: VisibilityService,
    private readonly clock: Clock,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ───────────── player actions ─────────────

  async join(
    userId: string,
    eventId: string,
    dto: { teamId?: string },
    key: string | undefined,
  ): Promise<ParticipationDto> {
    return this.idempotency.execute(
      { userId, scope: `games.join:${eventId}`, key, payload: dto },
      async (tx) => {
        await lockEvent(tx, eventId);
        const ev = await this.loadOpenEvent(tx, eventId);
        const now = this.clock.now();
        await this.assertMayParticipate(tx, userId, ev);

        const existing = await tx.participation.findUnique({
          where: { eventId_userId: { eventId, userId } },
        });
        if (existing && ['CONFIRMED', 'PENDING_APPROVAL', 'WAITLISTED'].includes(existing.status)) {
          return this.dto(tx, existing);
        }

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
        if (eligibility === 'NOT_ALLOWED') {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'This game is not open to your age group', {
            reason: 'AGE',
          });
        }
        if (eligibility === 'UNKNOWN_DOB') {
          throw new ApiError(
            ErrorCode.VALIDATION,
            'Date of birth is required for age-restricted games',
            {
              reason: 'DOB_REQUIRED',
            },
          );
        }
        const teamId = await this.resolveTeam(tx, ev, userId, dto.teamId);

        // A player who holds a priority seat or an open waitlist offer uses that reservation.
        const ownHold = await this.activeHold(tx, eventId, userId, now);
        const ownOffer = await this.activeOffer(tx, eventId, userId, now);

        // Waitlist fairness: never let a newcomer overtake queued players.
        if ((await tx.participation.count({ where: { eventId, status: 'WAITLISTED' } })) > 0) {
          await this.promoteWaitlist(tx, ev);
        }

        const forcePending = eligibility === 'EXCEPTION_REQUIRED';
        if (forcePending || ev.joinMode === 'APPROVE_REQUESTS') {
          const row = await this.write(tx, existing, {
            eventId,
            userId,
            teamId,
            status: 'PENDING_APPROVAL',
            source: forcePending ? 'AGE_EXCEPTION' : 'SELF_JOIN',
            ageExceptionRequested: forcePending,
          });
          await this.notifyDeciders(
            tx,
            ev,
            userId,
            'participation.requested',
            'New request to join',
          );
          return this.dto(tx, row);
        }

        const summary = await seatSummary(tx, ev, now);
        const reserved = (ownHold ? 1 : 0) + (ownOffer ? 1 : 0);
        if (summary.free + reserved > 0 && (await this.teamHasRoom(tx, ev, teamId))) {
          const row = await this.confirmSeat(tx, ev, existing, userId, teamId, 'SELF_JOIN');
          return this.dto(tx, row);
        }
        if (ev.waitlistEnabled) {
          const row = await this.write(tx, existing, {
            eventId,
            userId,
            teamId,
            status: 'WAITLISTED',
            source: 'SELF_JOIN',
            waitlistedAt: now,
          });
          return this.dto(tx, row);
        }
        throw new ApiError(ErrorCode.CAPACITY_CHANGED, 'That place was just taken.');
      },
    );
  }

  async leave(
    userId: string,
    eventId: string,
    key: string | undefined,
  ): Promise<ParticipationDto | null> {
    return this.idempotency.execute(
      { userId, scope: `games.leave:${eventId}`, key, payload: {} },
      async (tx) => {
        await lockEvent(tx, eventId);
        const ev = await tx.event.findUnique({ where: { id: eventId } });
        if (!ev) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
        const p = await tx.participation.findUnique({
          where: { eventId_userId: { eventId, userId } },
        });
        const now = this.clock.now();
        // Leaving also answers any open invitation / offer.
        await this.releaseReservations(tx, eventId, userId, now, 'DECLINED');
        if (!p || !['CONFIRMED', 'PENDING_APPROVAL', 'WAITLISTED'].includes(p.status)) {
          return p ? this.dto(tx, p) : null;
        }
        const updated = await tx.participation.update({
          where: { id: p.id },
          data: { status: 'WITHDRAWN' },
        });
        if (p.status === 'CONFIRMED') {
          await this.payments.cancelPlayerObligation(tx, eventId, userId);
          await this.notifier.notify(tx, {
            recipientIds: [ev.organiserId],
            category: 'game',
            activityKind: 'participation.left',
            title: 'A player left your game',
            objectType: 'Event',
            objectId: eventId,
            actorId: userId,
            essential: true,
          });
        }
        await this.promoteWaitlist(tx, ev);
        return this.dto(tx, updated);
      },
    );
  }

  // ───────────── organiser actions ─────────────

  async approve(
    actorId: string,
    participationId: string,
    key: string | undefined,
  ): Promise<ParticipationDto> {
    const meta = await this.prisma.participation.findUnique({
      where: { id: participationId },
      select: { eventId: true },
    });
    if (!meta) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return this.idempotency.execute(
      { userId: actorId, scope: `games.approve:${participationId}`, key, payload: {} },
      async (tx) => {
        await lockEvent(tx, meta.eventId);
        const ev = await this.loadEvent(tx, meta.eventId);
        await this.policy.assert(
          actorId,
          'event.requests.decide',
          { type: 'EVENT', id: ev.id },
          tx,
        );
        const p = await tx.participation.findUniqueOrThrow({ where: { id: participationId } });
        if (p.status === 'CONFIRMED') return this.dto(tx, p); // idempotent
        if (p.status !== 'PENDING_APPROVAL') {
          throw new ApiError(ErrorCode.CONFLICT, 'This request is no longer pending', {
            status: p.status,
          });
        }
        if (ev.status !== 'PUBLISHED')
          throw new ApiError(ErrorCode.CONFLICT, 'This game is not open');
        const now = this.clock.now();
        const hold = await this.activeHold(tx, ev.id, p.userId, now);
        const summary = await seatSummary(tx, ev, now);
        const hasRoom =
          summary.free + (hold ? 1 : 0) > 0 && (await this.teamHasRoom(tx, ev, p.teamId));
        let row: Participation;
        if (hasRoom) {
          row = await this.confirmSeat(tx, ev, p, p.userId, p.teamId, p.source, {
            ageExceptionApprovedById: p.ageExceptionRequested ? actorId : undefined,
          });
        } else if (ev.waitlistEnabled) {
          row = await tx.participation.update({
            where: { id: p.id },
            data: {
              status: 'WAITLISTED',
              waitlistedAt: now,
              ageExceptionApprovedById: p.ageExceptionRequested ? actorId : null,
            },
          });
        } else {
          throw new ApiError(ErrorCode.CAPACITY_CHANGED, 'That place was just taken.');
        }
        await this.notifier.notify(tx, {
          recipientIds: [p.userId],
          category: 'game',
          activityKind: 'participation.approved',
          title: row.status === 'CONFIRMED' ? 'Your place is confirmed' : 'You are on the waitlist',
          objectType: 'Event',
          objectId: ev.id,
          actorId,
          essential: true,
          dedupeKey: `participation:${p.id}:decision`,
        });
        return this.dto(tx, row);
      },
    );
  }

  async decline(
    actorId: string,
    participationId: string,
    key: string | undefined,
  ): Promise<ParticipationDto> {
    const meta = await this.prisma.participation.findUnique({
      where: { id: participationId },
      select: { eventId: true },
    });
    if (!meta) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return this.idempotency.execute(
      { userId: actorId, scope: `games.decline:${participationId}`, key, payload: {} },
      async (tx) => {
        await lockEvent(tx, meta.eventId);
        const ev = await this.loadEvent(tx, meta.eventId);
        await this.policy.assert(
          actorId,
          'event.requests.decide',
          { type: 'EVENT', id: ev.id },
          tx,
        );
        const p = await tx.participation.findUniqueOrThrow({ where: { id: participationId } });
        if (p.status === 'DECLINED') return this.dto(tx, p);
        if (p.status !== 'PENDING_APPROVAL') {
          throw new ApiError(ErrorCode.CONFLICT, 'This request is no longer pending', {
            status: p.status,
          });
        }
        const row = await tx.participation.update({
          where: { id: p.id },
          data: { status: 'DECLINED' },
        });
        await this.releaseReservations(tx, ev.id, p.userId, this.clock.now(), 'DECLINED');
        await this.notifier.notify(tx, {
          recipientIds: [p.userId],
          category: 'game',
          activityKind: 'participation.declined',
          title: 'Your request was declined',
          objectType: 'Event',
          objectId: ev.id,
          actorId,
          essential: true,
          dedupeKey: `participation:${p.id}:decision`,
        });
        await this.promoteWaitlist(tx, ev);
        return this.dto(tx, row);
      },
    );
  }

  async remove(
    actorId: string,
    participationId: string,
    key: string | undefined,
  ): Promise<ParticipationDto> {
    const meta = await this.prisma.participation.findUnique({
      where: { id: participationId },
      select: { eventId: true },
    });
    if (!meta) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return this.idempotency.execute(
      { userId: actorId, scope: `games.remove:${participationId}`, key, payload: {} },
      async (tx) => {
        await lockEvent(tx, meta.eventId);
        const ev = await this.loadEvent(tx, meta.eventId);
        await this.policy.assert(actorId, 'event.squad.manage', { type: 'EVENT', id: ev.id }, tx);
        const p = await tx.participation.findUniqueOrThrow({ where: { id: participationId } });
        if (p.status === 'REMOVED') return this.dto(tx, p);
        if (!['CONFIRMED', 'PENDING_APPROVAL', 'WAITLISTED'].includes(p.status)) {
          throw new ApiError(ErrorCode.CONFLICT, 'This player is not in the squad', {
            status: p.status,
          });
        }
        const row = await tx.participation.update({
          where: { id: p.id },
          data: { status: 'REMOVED' },
        });
        await this.releaseReservations(tx, ev.id, p.userId, this.clock.now(), 'DECLINED');
        if (p.status === 'CONFIRMED')
          await this.payments.cancelPlayerObligation(tx, ev.id, p.userId);
        await this.notifier.notify(tx, {
          recipientIds: [p.userId],
          category: 'game',
          activityKind: 'participation.removed',
          title: 'You were removed from a game',
          objectType: 'Event',
          objectId: ev.id,
          actorId,
          essential: true,
        });
        await this.promoteWaitlist(tx, ev);
        return this.dto(tx, row);
      },
    );
  }

  /** Move a player between teams (or toggle substitute) atomically: one row, one lock. */
  async move(
    actorId: string,
    participationId: string,
    dto: { teamId?: string | null; isSubstitute?: boolean },
    key: string | undefined,
  ): Promise<ParticipationDto> {
    const meta = await this.prisma.participation.findUnique({
      where: { id: participationId },
      select: { eventId: true },
    });
    if (!meta) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return this.idempotency.execute(
      { userId: actorId, scope: `games.move:${participationId}`, key, payload: dto },
      async (tx) => {
        await lockEvent(tx, meta.eventId);
        const ev = await this.loadEvent(tx, meta.eventId);
        await this.policy.assert(actorId, 'event.squad.manage', { type: 'EVENT', id: ev.id }, tx);
        const p = await tx.participation.findUniqueOrThrow({ where: { id: participationId } });
        if (!['CONFIRMED', 'PENDING_APPROVAL', 'WAITLISTED'].includes(p.status)) {
          throw new ApiError(ErrorCode.CONFLICT, 'This player is not in the squad', {
            status: p.status,
          });
        }
        const data: { teamId?: string | null; isSubstitute?: boolean } = {};
        if (dto.teamId !== undefined) {
          if (dto.teamId !== null) {
            const team = await tx.eventTeam.findUnique({ where: { id: dto.teamId } });
            if (!team || team.eventId !== ev.id) {
              throw new ApiError(ErrorCode.VALIDATION, 'Unknown team', { field: 'teamId' });
            }
            if (
              p.status === 'CONFIRMED' &&
              dto.teamId !== p.teamId &&
              !(await this.teamHasRoom(tx, ev, dto.teamId))
            ) {
              throw new ApiError(ErrorCode.CAPACITY_CHANGED, 'That team is full.');
            }
          }
          data.teamId = dto.teamId;
        }
        if (dto.isSubstitute !== undefined) data.isSubstitute = dto.isSubstitute;
        const row = await tx.participation.update({ where: { id: p.id }, data });
        return this.dto(tx, row);
      },
    );
  }

  // ───────────── waitlist offers ─────────────

  async acceptOffer(
    userId: string,
    offerId: string,
    key: string | undefined,
  ): Promise<ParticipationDto> {
    const meta = await this.prisma.waitlistOffer.findUnique({
      where: { id: offerId },
      select: { eventId: true, userId: true },
    });
    if (!meta || meta.userId !== userId)
      throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return this.idempotency.execute(
      { userId, scope: `games.offer.accept:${offerId}`, key, payload: {} },
      async (tx) => {
        await lockEvent(tx, meta.eventId);
        const ev = await this.loadEvent(tx, meta.eventId);
        const offer = await tx.waitlistOffer.findUniqueOrThrow({ where: { id: offerId } });
        const p = await tx.participation.findUniqueOrThrow({
          where: { id: offer.participationId },
        });
        if (offer.status === 'ACCEPTED') return this.dto(tx, p);
        const now = this.clock.now();
        if (offer.status !== 'OFFERED' || offer.expiresAt <= now || ev.status !== 'PUBLISHED') {
          throw new ApiError(ErrorCode.EXPIRED, 'This offer has expired', {
            reason: 'OFFER_EXPIRED',
          });
        }
        if (p.status !== 'WAITLISTED')
          throw new ApiError(ErrorCode.CONFLICT, 'You are no longer on the waitlist');
        // The offer itself reserved the seat; confirmSeat consumes it.
        const row = await this.confirmSeat(tx, ev, p, userId, p.teamId, 'WAITLIST_OFFER');
        await tx.waitlistOffer.update({
          where: { id: offerId },
          data: { status: 'ACCEPTED', respondedAt: now },
        });
        await this.notifier.notify(tx, {
          recipientIds: [ev.organiserId],
          category: 'game',
          activityKind: 'waitlist.offer_accepted',
          title: 'A waitlisted player took the free place',
          objectType: 'Event',
          objectId: ev.id,
          actorId: userId,
          essential: true,
        });
        return this.dto(tx, row);
      },
    );
  }

  async declineOffer(
    userId: string,
    offerId: string,
    key: string | undefined,
  ): Promise<ParticipationDto> {
    const meta = await this.prisma.waitlistOffer.findUnique({
      where: { id: offerId },
      select: { eventId: true, userId: true },
    });
    if (!meta || meta.userId !== userId)
      throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return this.idempotency.execute(
      { userId, scope: `games.offer.decline:${offerId}`, key, payload: {} },
      async (tx) => {
        await lockEvent(tx, meta.eventId);
        const ev = await this.loadEvent(tx, meta.eventId);
        const offer = await tx.waitlistOffer.findUniqueOrThrow({ where: { id: offerId } });
        const p = await tx.participation.findUniqueOrThrow({
          where: { id: offer.participationId },
        });
        if (offer.status === 'OFFERED') {
          await tx.waitlistOffer.update({
            where: { id: offerId },
            data: { status: 'DECLINED', respondedAt: this.clock.now() },
          });
          // WORK: declining leaves the queue (the doc only says the offer passes to the next player).
          await tx.participation.update({ where: { id: p.id }, data: { status: 'WITHDRAWN' } });
          await this.promoteWaitlist(tx, ev);
        }
        return this.dto(tx, await tx.participation.findUniqueOrThrow({ where: { id: p.id } }));
      },
    );
  }

  // ───────────── shared internals (called by other games services inside a locked tx) ─────────────

  /**
   * Confirms a place for `userId`: writes the CONFIRMED participation, creates the fee
   * obligation (waitlisted/pending players never owe anything), and consumes the person's own
   * hold/offer. Caller must hold the event lock and have verified seat availability.
   */
  async confirmSeat(
    tx: Tx,
    ev: Event,
    existing: Participation | null,
    userId: string,
    teamId: string | null,
    source: Participation['source'],
    extra: { isGuest?: boolean; ageExceptionApprovedById?: string } = {},
  ): Promise<Participation> {
    const now = this.clock.now();
    const row = await this.write(tx, existing, {
      eventId: ev.id,
      userId,
      teamId,
      status: 'CONFIRMED',
      source,
      confirmedAt: now,
      isGuest: extra.isGuest,
      ageExceptionApprovedById: extra.ageExceptionApprovedById,
    });
    await this.releaseReservations(tx, ev.id, userId, now, 'CONFIRMED');
    // Any still-open invitation to this person is answered by their confirmed place.
    await tx.invitation.updateMany({
      where: { eventId: ev.id, inviteeId: userId, status: 'PENDING' },
      data: { status: 'CONFIRMED', respondedAt: now },
    });
    await this.payments.ensureEventFeeObligation(tx, ev, userId);
    return row;
  }

  /** Releases the person's active hold (and open offer) — used on confirm/decline/leave/remove. */
  async releaseReservations(
    tx: Tx,
    eventId: string,
    userId: string,
    now: Date,
    reason: 'CONFIRMED' | 'DECLINED' | 'REVOKED' | 'EXPIRED' | 'EVENT_CANCELLED',
  ): Promise<void> {
    await tx.seatHold.updateMany({
      where: { eventId, userId, releasedAt: null },
      data: { releasedAt: now, releaseReason: reason },
    });
    await tx.waitlistOffer.updateMany({
      where: { eventId, userId, status: 'OFFERED' },
      data: {
        status: reason === 'CONFIRMED' ? 'ACCEPTED' : 'CANCELLED',
        respondedAt: now,
      },
    });
  }

  /**
   * Offers freed seats to waitlisted players in join order. Offers reserve seats (they count in
   * `free`) and expire; no participation or debt is created until the player accepts.
   */
  async promoteWaitlist(tx: Tx, ev: Event): Promise<void> {
    const now = this.clock.now();
    if (ev.status !== 'PUBLISHED' || ev.startsAt <= now) return;
    const summary = await seatSummary(tx, ev, now);
    if (summary.free <= 0) return;
    const minutes = this.config.get('WAITLIST_OFFER_MINUTES', { infer: true });
    // Never later than the event start; no time left ⇒ no automatic offer.
    const expiresAt = new Date(Math.min(now.getTime() + minutes * 60_000, ev.startsAt.getTime()));
    if (expiresAt <= now) return;
    const queue = await tx.participation.findMany({
      where: { eventId: ev.id, status: 'WAITLISTED' },
      orderBy: [{ waitlistedAt: 'asc' }, { id: 'asc' }],
      take: summary.free + 20,
    });
    const activeOffers = await tx.waitlistOffer.findMany({
      where: { eventId: ev.id, status: 'OFFERED', expiresAt: { gt: now } },
      select: { userId: true },
    });
    const have = new Set(activeOffers.map((o) => o.userId));
    let remaining = summary.free;
    for (const p of queue) {
      if (remaining <= 0) break;
      if (have.has(p.userId)) continue;
      const offer = await tx.waitlistOffer.create({
        data: { eventId: ev.id, participationId: p.id, userId: p.userId, expiresAt },
      });
      await this.notifier.notify(tx, {
        recipientIds: [p.userId],
        category: 'game',
        activityKind: 'waitlist.seat_offered',
        title: 'A place opened up',
        objectType: 'Event',
        objectId: ev.id,
        essential: true,
        payload: { offerId: offer.id, expiresAt: expiresAt.toISOString() },
        dedupeKey: `waitlist-offer:${offer.id}`,
      });
      remaining -= 1;
    }
  }

  async activeHold(tx: Tx, eventId: string, userId: string, now: Date) {
    return tx.seatHold.findFirst({
      where: { eventId, userId, releasedAt: null, expiresAt: { gt: now } },
    });
  }

  async activeOffer(tx: Tx, eventId: string, userId: string, now: Date) {
    return tx.waitlistOffer.findFirst({
      where: { eventId, userId, status: 'OFFERED', expiresAt: { gt: now } },
    });
  }

  async teamHasRoom(tx: Tx, ev: Event, teamId: string | null): Promise<boolean> {
    if (!teamId) return true;
    const used = await tx.participation.count({
      where: { eventId: ev.id, teamId, status: 'CONFIRMED' },
    });
    return used < teamCapacity(ev);
  }

  async loadEvent(tx: Tx, eventId: string): Promise<Event> {
    const ev = await tx.event.findUnique({ where: { id: eventId } });
    if (!ev) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return ev;
  }

  async assertMayParticipate(tx: Tx, userId: string, ev: Event): Promise<void> {
    if (await this.visibility.isBlockedEitherWay(userId, ev.organiserId, tx)) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    }
  }

  /** Published, not started, not cancelled. */
  private async loadOpenEvent(tx: Tx, eventId: string): Promise<Event> {
    const ev = await this.loadEvent(tx, eventId);
    if (ev.status === 'DRAFT')
      throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    if (ev.status === 'CANCELLED') {
      throw new ApiError(ErrorCode.EXPIRED, 'This game was cancelled', {
        reason: 'EVENT_CANCELLED',
      });
    }
    if (ev.status !== 'PUBLISHED' || ev.startsAt <= this.clock.now()) {
      throw new ApiError(ErrorCode.EXPIRED, 'Joining has closed for this game', {
        reason: 'CLOSED',
      });
    }
    return ev;
  }

  private async resolveTeam(
    tx: Tx,
    ev: Event,
    userId: string,
    teamId?: string,
  ): Promise<string | null> {
    if (!teamId) {
      if (ev.kind === 'CLUB_V_CLUB') {
        throw new ApiError(ErrorCode.VALIDATION, 'Choose the team you are playing for', {
          field: 'teamId',
        });
      }
      return null;
    }
    const team = await tx.eventTeam.findUnique({ where: { id: teamId } });
    if (!team || team.eventId !== ev.id) {
      throw new ApiError(ErrorCode.VALIDATION, 'Unknown team', { field: 'teamId' });
    }
    if (ev.kind === 'CLUB_V_CLUB') {
      const member = team.clubId
        ? await tx.membership.findUnique({
            where: { clubId_userId: { clubId: team.clubId, userId } },
          })
        : null;
      if (member?.status !== 'MEMBER') {
        throw new ApiError(ErrorCode.ACCESS_DENIED, 'You are not a member of that team’s club');
      }
    }
    return team.id;
  }

  private async write(
    tx: Tx,
    existing: Participation | null,
    d: {
      eventId: string;
      userId: string;
      teamId: string | null;
      status: Participation['status'];
      source: Participation['source'];
      ageExceptionRequested?: boolean;
      ageExceptionApprovedById?: string;
      waitlistedAt?: Date;
      confirmedAt?: Date;
      isGuest?: boolean;
    },
  ): Promise<Participation> {
    if (existing) {
      return tx.participation.update({
        where: { id: existing.id },
        data: {
          status: d.status,
          source: d.source,
          teamId: d.teamId ?? existing.teamId,
          ageExceptionRequested: d.ageExceptionRequested ?? existing.ageExceptionRequested,
          ageExceptionApprovedById: d.ageExceptionApprovedById ?? existing.ageExceptionApprovedById,
          waitlistedAt:
            d.waitlistedAt ??
            (d.status === 'WAITLISTED' ? this.clock.now() : existing.waitlistedAt),
          confirmedAt: d.confirmedAt ?? existing.confirmedAt,
          isGuest: d.isGuest ?? existing.isGuest,
        },
      });
    }
    return tx.participation.create({
      data: {
        eventId: d.eventId,
        userId: d.userId,
        teamId: d.teamId,
        status: d.status,
        source: d.source,
        ageExceptionRequested: d.ageExceptionRequested ?? false,
        ageExceptionApprovedById: d.ageExceptionApprovedById ?? null,
        waitlistedAt: d.waitlistedAt ?? null,
        confirmedAt: d.confirmedAt ?? null,
        isGuest: d.isGuest ?? false,
      },
    });
  }

  async notifyDeciders(
    tx: Tx,
    ev: Event,
    actorId: string,
    kind: string,
    title: string,
  ): Promise<void> {
    const ids = new Set<string>([ev.organiserId]);
    if (ev.clubId) {
      const club = await tx.club.findUnique({
        where: { id: ev.clubId },
        select: { ownerId: true },
      });
      if (club) ids.add(club.ownerId);
    }
    await this.notifier.notify(tx, {
      recipientIds: [...ids],
      category: 'game',
      activityKind: kind,
      title,
      objectType: 'Event',
      objectId: ev.id,
      actorId,
      essential: true,
    });
  }

  async dto(tx: Tx, p: Participation): Promise<ParticipationDto> {
    let position: number | null = null;
    if (p.status === 'WAITLISTED' && p.waitlistedAt) {
      const ahead = await tx.participation.count({
        where: {
          eventId: p.eventId,
          status: 'WAITLISTED',
          OR: [
            { waitlistedAt: { lt: p.waitlistedAt } },
            { waitlistedAt: p.waitlistedAt, id: { lt: p.id } },
          ],
        },
      });
      position = ahead + 1;
    }
    return ParticipationDto.from(p, position);
  }

  /** Marks an invitation-based confirmation (used by InvitationsService). */
  async confirmFromInvitation(
    tx: Tx,
    ev: Event,
    inv: Invitation,
    userId: string,
  ): Promise<Participation> {
    const existing = await tx.participation.findUnique({
      where: { eventId_userId: { eventId: ev.id, userId } },
    });
    return this.confirmSeat(tx, ev, existing, userId, null, 'INVITATION', { isGuest: inv.isGuest });
  }
}
