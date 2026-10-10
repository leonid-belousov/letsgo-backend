import { Injectable } from '@nestjs/common';
import type { Club, Event, EventTeam, Pitch, Venue } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { VisibilityService } from '../privacy/visibility.service';
import {
  loadPersonSummaries,
  personOrUnknown,
  type PersonSummaryDto,
} from '../users/person-summary';
import {
  GameCapabilitiesDto,
  GameDto,
  GameJoinStateDto,
  GameSummaryDto,
  ParticipationDto,
  PlayersDto,
  ViewerInvitationDto,
  ViewerStateDto,
  type EntityRefDto,
  type OrganiserDto,
} from './dto';
import { ageEligibility, seatSummary, type AgeEligibility, type SeatSummary } from './seats';

type EventRow = Event & {
  club: Pick<Club, 'id' | 'name' | 'username'> | null;
  venue: Pick<Venue, 'id' | 'name'> | null;
  pitch: Pick<Pitch, 'id' | 'name'> | null;
};

const EVENT_INCLUDE = {
  club: { select: { id: true, name: true, username: true } },
  venue: { select: { id: true, name: true } },
  pitch: { select: { id: true, name: true } },
} as const;

/**
 * Builds every read-side game DTO. Manager-only data and rights are computed with the same
 * PolicyService calls the mutations use, so a capability can never disagree with enforcement.
 */
@Injectable()
export class GameViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly visibility: VisibilityService,
    private readonly clock: Clock,
  ) {}

  static readonly include = EVENT_INCLUDE;

  // ───────────── detail ─────────────

  async detail(db: Db, viewerId: string | null, eventId: string): Promise<GameDto> {
    const ev = await db.event.findUnique({ where: { id: eventId }, include: EVENT_INCLUDE });
    if (!ev) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    const target = { type: 'EVENT', id: ev.id } as const;
    const canManage = viewerId
      ? await this.policy.can(viewerId, 'event.manage', target, db)
      : false;
    if (ev.status === 'DRAFT' && !canManage) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    }
    const now = this.clock.now();
    const seats = await seatSummary(db, ev, now);
    const [people, teams, ratings, viewer] = await Promise.all([
      loadPersonSummaries(db, [ev.organiserId]),
      db.eventTeam.findMany({ where: { eventId: ev.id }, orderBy: { index: 'asc' } }),
      this.organiserRatings(db, [ev.organiserId]),
      this.viewerState(db, viewerId, ev, now),
    ]);
    const caps = await this.capabilities(db, viewerId, ev, seats, viewer, canManage, now);
    return {
      id: ev.id,
      kind: ev.kind,
      status: ev.status,
      organiser: this.organiser(people, ratings, ev.organiserId),
      club: ev.club ? { id: ev.club.id, name: ev.club.name, handle: ev.club.username } : null,
      venue: ev.venue,
      pitch: ev.pitch,
      bookingId: ev.bookingId,
      title: ev.title,
      timezone: ev.timezone,
      startsAt: ev.startsAt.toISOString(),
      endsAt: ev.endsAt.toISOString(),
      formatPlayers: ev.formatPlayers,
      teamCount: ev.teamCount,
      substitutesPerTeam: ev.substitutesPerTeam,
      minConfirmed: ev.minConfirmed,
      priceMinor: ev.priceMinor,
      currency: ev.currency,
      pitchStatus: ev.pitchStatus,
      pitchStatusSource: ev.pitchStatusSource,
      joinMode: ev.joinMode,
      ageBand: ev.ageBand,
      allowYounger: ev.allowYounger,
      refereeIncluded: ev.refereeIncluded,
      videoIncluded: ev.videoIncluded,
      waterIncluded: ev.waterIncluded,
      bibsIncluded: ev.bibsIncluded,
      refereeAssigned: ev.refereeUserId !== null,
      waitlistEnabled: ev.waitlistEnabled,
      payCashEnabled: ev.payCashEnabled,
      notes: ev.notes,
      autoCancelEnabled: ev.autoCancelEnabled,
      autoNextWave: ev.autoNextWave,
      venueNeedsAttention: ev.venueNeedsAttention,
      venueAttentionReason: ev.venueAttentionReason,
      venueAttentionAt: ev.venueAttentionAt?.toISOString() ?? null,
      autoCancelCheckAt: ev.autoCancelCheckAt?.toISOString() ?? null,
      cancelReason: ev.cancelReason,
      seats: this.publicSeats(seats),
      teams: teams.map((t: EventTeam) => ({
        id: t.id,
        index: t.index,
        name: t.name,
        colour: t.colour,
        captainId: t.captainId,
        clubId: t.clubId,
      })),
      version: ev.version,
      viewer,
      capabilities: caps,
    };
  }

  async players(db: Db, viewerId: string | null, eventId: string): Promise<PlayersDto> {
    const ev = await db.event.findUnique({ where: { id: eventId } });
    if (!ev) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    const target = { type: 'EVENT', id: ev.id } as const;
    const manage = viewerId
      ? await this.policy.can(viewerId, 'event.squad.manage', target, db)
      : false;
    if (ev.status === 'DRAFT' && !manage)
      throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');

    const confirmed = await db.participation.findMany({
      where: { eventId, status: 'CONFIRMED' },
      orderBy: [{ confirmedAt: 'asc' }, { id: 'asc' }],
    });
    const waitlistedCount = await db.participation.count({
      where: { eventId, status: 'WAITLISTED' },
    });
    const managedRows = manage
      ? await db.participation.findMany({
          where: { eventId, status: { in: ['PENDING_APPROVAL', 'WAITLISTED'] } },
          orderBy: [{ waitlistedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    const people = await loadPersonSummaries(
      db,
      [...confirmed, ...managedRows].map((p) => p.userId),
    );
    let position = 0;
    return {
      confirmed: confirmed.map((p) => ({
        player: personOrUnknown(people, p.userId),
        participationId: p.id,
        teamId: p.teamId,
        isSubstitute: p.isSubstitute,
        isGuest: p.isGuest,
      })),
      waitlistedCount,
      managed: managedRows.map((p) => ({
        player: personOrUnknown(people, p.userId),
        participationId: p.id,
        teamId: p.teamId,
        isSubstitute: p.isSubstitute,
        isGuest: p.isGuest,
        status: p.status,
        ageExceptionRequested: p.ageExceptionRequested,
        waitlistPosition: p.status === 'WAITLISTED' ? ++position : null,
      })),
    };
  }

  // ───────────── summaries (feed / home) ─────────────

  async summaries(db: Db, viewerId: string | null, events: EventRow[]): Promise<GameSummaryDto[]> {
    if (events.length === 0) return [];
    const now = this.clock.now();
    const ids = events.map((e) => e.id);
    const [people, ratings, confirmed, holds, offers, waitlisted] = await Promise.all([
      loadPersonSummaries(
        db,
        events.map((e) => e.organiserId),
      ),
      this.organiserRatings(
        db,
        events.map((e) => e.organiserId),
      ),
      db.participation.groupBy({
        by: ['eventId'],
        where: { eventId: { in: ids }, status: 'CONFIRMED' },
        _count: { _all: true },
      }),
      db.seatHold.groupBy({
        by: ['eventId'],
        where: { eventId: { in: ids }, releasedAt: null, expiresAt: { gt: now } },
        _count: { _all: true },
      }),
      db.waitlistOffer.groupBy({
        by: ['eventId'],
        where: { eventId: { in: ids }, status: 'OFFERED', expiresAt: { gt: now } },
        _count: { _all: true },
      }),
      db.participation.groupBy({
        by: ['eventId'],
        where: { eventId: { in: ids }, status: 'WAITLISTED' },
        _count: { _all: true },
      }),
    ]);
    const count = (rows: { eventId: string; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.eventId, r._count._all]));
    const cConfirmed = count(confirmed);
    const cHolds = count(holds);
    const cOffers = count(offers);
    const cWait = count(waitlisted);

    const mine = viewerId
      ? await db.participation.findMany({ where: { eventId: { in: ids }, userId: viewerId } })
      : [];
    const myInv = viewerId
      ? await db.invitation.findMany({ where: { eventId: { in: ids }, inviteeId: viewerId } })
      : [];
    const myHolds = viewerId
      ? await db.seatHold.findMany({
          where: {
            eventId: { in: ids },
            userId: viewerId,
            releasedAt: null,
            expiresAt: { gt: now },
          },
          select: { eventId: true },
        })
      : [];
    const myOffers = viewerId
      ? await db.waitlistOffer.findMany({
          where: {
            eventId: { in: ids },
            userId: viewerId,
            status: 'OFFERED',
            expiresAt: { gt: now },
          },
          select: { eventId: true },
        })
      : [];
    const blocked = viewerId
      ? new Set(
          (
            await db.block.findMany({
              where: {
                OR: [
                  { blockerId: viewerId, blockedId: { in: events.map((e) => e.organiserId) } },
                  { blockedId: viewerId, blockerId: { in: events.map((e) => e.organiserId) } },
                ],
              },
            })
          ).flatMap((b) => [b.blockerId, b.blockedId]),
        )
      : new Set<string>();
    const profile = viewerId
      ? await db.profile.findUnique({
          where: { userId: viewerId },
          select: { dateOfBirth: true, completedAt: true },
        })
      : null;

    const byEvent = <T extends { eventId: string }>(rows: T[]) =>
      new Map(rows.map((r) => [r.eventId, r]));
    const partBy = byEvent(mine);
    const invBy = byEvent(myInv);
    const holdSet = new Set(myHolds.map((h) => h.eventId));
    const offerSet = new Set(myOffers.map((o) => o.eventId));

    return events.map((ev) => {
      const seats: SeatSummary = {
        capacity: ev.capacity,
        confirmed: cConfirmed.get(ev.id) ?? 0,
        holds: cHolds.get(ev.id) ?? 0,
        offers: cOffers.get(ev.id) ?? 0,
        waitlisted: cWait.get(ev.id) ?? 0,
        pending: 0,
        free: Math.max(
          0,
          ev.capacity -
            (cConfirmed.get(ev.id) ?? 0) -
            (cHolds.get(ev.id) ?? 0) -
            (cOffers.get(ev.id) ?? 0),
        ),
      };
      const part = partBy.get(ev.id) ?? null;
      const inv = invBy.get(ev.id) ?? null;
      const join = this.joinState({
        viewerId,
        ev,
        seats,
        participationStatus: part?.status ?? null,
        ownReservation: holdSet.has(ev.id) || offerSet.has(ev.id),
        eligibility: profile ? ageEligibility(profile.dateOfBirth, ev) : 'ELIGIBLE',
        profileComplete: !!profile?.completedAt,
        blocked: blocked.has(ev.organiserId) && ev.organiserId !== viewerId,
        now: this.clock.now(),
      });
      return {
        id: ev.id,
        kind: ev.kind,
        status: ev.status,
        organiser: this.organiser(people, ratings, ev.organiserId),
        club: ev.club ? { id: ev.club.id, name: ev.club.name, handle: ev.club.username } : null,
        venue: ev.venue,
        pitch: ev.pitch,
        title: ev.title,
        timezone: ev.timezone,
        startsAt: ev.startsAt.toISOString(),
        endsAt: ev.endsAt.toISOString(),
        formatPlayers: ev.formatPlayers,
        priceMinor: ev.priceMinor,
        currency: ev.currency,
        pitchStatus: ev.pitchStatus,
        ageBand: ev.ageBand,
        refereeIncluded: ev.refereeIncluded,
        videoIncluded: ev.videoIncluded,
        waitlistEnabled: ev.waitlistEnabled,
        seats: this.publicSeats(seats),
        viewerParticipation: part?.status ?? null,
        viewerInvitation: inv?.status ?? null,
        join,
      };
    });
  }

  // ───────────── helpers ─────────────

  publicSeats(s: SeatSummary) {
    return {
      capacity: s.capacity,
      confirmed: s.confirmed,
      spotsLeft: s.free,
      waitlisted: s.waitlisted,
    };
  }

  organiser(
    people: Map<string, PersonSummaryDto>,
    ratings: Map<string, { avg: number; count: number }>,
    id: string,
  ): OrganiserDto {
    const p = personOrUnknown(people, id);
    const r = ratings.get(id);
    return { ...p, rating: r ? r.avg : null, ratingCount: r ? r.count : 0 };
  }

  /** Mean of visible organiser ratings, 1 decimal; no ratings ⇒ absent (never 0). */
  async organiserRatings(
    db: Db,
    organiserIds: string[],
  ): Promise<Map<string, { avg: number; count: number }>> {
    const ids = [...new Set(organiserIds)];
    const rows = await db.rating.groupBy({
      by: ['subjectId'],
      where: { subjectType: 'ORGANISER', subjectId: { in: ids }, hiddenAt: null },
      _avg: { score: true },
      _count: { _all: true },
    });
    return new Map(
      rows.map((r) => [
        r.subjectId,
        { avg: Math.round((r._avg.score ?? 0) * 10) / 10, count: r._count._all },
      ]),
    );
  }

  private async viewerState(
    db: Db,
    viewerId: string | null,
    ev: Event,
    now: Date,
  ): Promise<ViewerStateDto> {
    if (!viewerId)
      return {
        participation: null,
        invitation: null,
        offerId: null,
        offerExpiresAt: null,
        obligationId: null,
      };
    const [part, inv, hold, offer, ob] = await Promise.all([
      db.participation.findUnique({
        where: { eventId_userId: { eventId: ev.id, userId: viewerId } },
      }),
      db.invitation.findUnique({
        where: { eventId_inviteeId: { eventId: ev.id, inviteeId: viewerId } },
      }),
      db.seatHold.findFirst({
        where: { eventId: ev.id, userId: viewerId, releasedAt: null, expiresAt: { gt: now } },
      }),
      db.waitlistOffer.findFirst({
        where: { eventId: ev.id, userId: viewerId, status: 'OFFERED', expiresAt: { gt: now } },
      }),
      db.paymentObligation.findUnique({
        where: {
          kind_eventId_payerUserId: { kind: 'EVENT_FEE', eventId: ev.id, payerUserId: viewerId },
        },
        select: { id: true, status: true },
      }),
    ]);
    let position: number | null = null;
    if (part?.status === 'WAITLISTED' && part.waitlistedAt) {
      position =
        1 +
        (await db.participation.count({
          where: {
            eventId: ev.id,
            status: 'WAITLISTED',
            OR: [
              { waitlistedAt: { lt: part.waitlistedAt } },
              { waitlistedAt: part.waitlistedAt, id: { lt: part.id } },
            ],
          },
        }));
    }
    const invitation: ViewerInvitationDto | null = inv
      ? {
          id: inv.id,
          status: inv.status,
          priority: inv.priority,
          isGuest: inv.isGuest,
          respondBy: inv.respondBy?.toISOString() ?? null,
          heldUntil: hold ? hold.expiresAt.toISOString() : null,
        }
      : null;
    return {
      participation: part ? ParticipationDto.from(part, position) : null,
      invitation,
      offerId: offer?.id ?? null,
      offerExpiresAt: offer?.expiresAt.toISOString() ?? null,
      obligationId: ob && ob.status !== 'CANCELLED' ? ob.id : null,
    };
  }

  joinState(a: {
    viewerId: string | null;
    ev: Event;
    seats: SeatSummary;
    participationStatus: string | null;
    ownReservation: boolean;
    eligibility: AgeEligibility;
    profileComplete: boolean;
    blocked: boolean;
    now: Date;
  }): GameJoinStateDto {
    const none = { canJoin: false, canRequestToJoin: false, canJoinWaitlist: false };
    const { ev } = a;
    if (!a.viewerId || a.blocked || a.viewerId === undefined) return none;
    if (ev.status !== 'PUBLISHED' || ev.startsAt <= a.now) return none;
    if (
      a.participationStatus &&
      ['CONFIRMED', 'PENDING_APPROVAL', 'WAITLISTED'].includes(a.participationStatus)
    )
      return none;
    if (!a.profileComplete || a.eligibility === 'NOT_ALLOWED' || a.eligibility === 'UNKNOWN_DOB')
      return none;
    const room = a.seats.free + (a.ownReservation ? 1 : 0) > 0;
    const needsApproval =
      ev.joinMode === 'APPROVE_REQUESTS' || a.eligibility === 'EXCEPTION_REQUIRED';
    if (needsApproval) return { canJoin: false, canRequestToJoin: true, canJoinWaitlist: false };
    if (room) return { canJoin: true, canRequestToJoin: false, canJoinWaitlist: false };
    return { canJoin: false, canRequestToJoin: false, canJoinWaitlist: ev.waitlistEnabled };
  }

  private async capabilities(
    db: Db,
    viewerId: string | null,
    ev: Event,
    seats: SeatSummary,
    viewer: ViewerStateDto,
    canManage: boolean,
    now: Date,
  ): Promise<GameCapabilitiesDto> {
    const target = { type: 'EVENT', id: ev.id } as const;
    const can = async (p: Parameters<PolicyService['can']>[1]) =>
      viewerId ? this.policy.can(viewerId, p, target, db) : false;
    const [invite, approve, squad, money, cash] = viewerId
      ? await Promise.all([
          can('event.squad.manage'),
          can('event.requests.decide'),
          can('event.squad.manage'),
          can('event.money.view'),
          can('event.cash.confirm'),
        ])
      : [false, false, false, false, false];

    let eligibility: AgeEligibility = 'ELIGIBLE';
    let profileComplete = false;
    let blocked = false;
    if (viewerId) {
      const profile = await db.profile.findUnique({
        where: { userId: viewerId },
        select: { dateOfBirth: true, completedAt: true },
      });
      eligibility = ageEligibility(profile?.dateOfBirth ?? null, ev);
      profileComplete = !!profile?.completedAt;
      blocked = await this.visibility.isBlockedEitherWay(viewerId, ev.organiserId, db);
    }
    const join = this.joinState({
      viewerId,
      ev,
      seats,
      participationStatus: viewer.participation?.status ?? null,
      ownReservation: viewer.invitation?.heldUntil != null || viewer.offerId !== null,
      eligibility,
      profileComplete,
      blocked,
      now,
    });
    const openEvent = ev.status === 'PUBLISHED' && ev.startsAt > now;
    const inv = viewer.invitation;
    const invitationOpen =
      inv?.status === 'PENDING' &&
      (!inv.respondBy || new Date(inv.respondBy) > now) &&
      ev.status === 'PUBLISHED';
    const pStatus = viewer.participation?.status;
    const isConfirmed = pStatus === 'CONFIRMED';
    return {
      ...join,
      canLeave:
        !!pStatus &&
        ['CONFIRMED', 'PENDING_APPROVAL', 'WAITLISTED'].includes(pStatus) &&
        ev.status !== 'CANCELLED',
      canConfirmInvitation: invitationOpen && !isConfirmed,
      canDeclineInvitation: invitationOpen,
      canAcceptOffer: viewer.offerId !== null && pStatus === 'WAITLISTED',
      canEdit:
        canManage && (ev.status === 'DRAFT' || ev.status === 'PUBLISHED') && ev.startsAt > now,
      canPublish: canManage && ev.status === 'DRAFT',
      canCancel: canManage && ['DRAFT', 'PUBLISHED', 'STARTED'].includes(ev.status),
      canInvite: invite && openEvent,
      canApprove: approve && openEvent,
      canManageSquad: squad,
      canViewMoney: money || cash,
      canConfirmCash: cash,
      canOpenChat: isConfirmed || squad || canManage,
      canAttachBooking:
        canManage && ['DRAFT', 'PUBLISHED'].includes(ev.status) && ev.startsAt > now,
      ageEligibility: eligibility,
    };
  }

  async loadRows(
    db: Db,
    where: object,
    args: { take?: number; orderBy?: object[] } = {},
  ): Promise<EventRow[]> {
    return db.event.findMany({
      where,
      include: EVENT_INCLUDE,
      take: args.take,
      orderBy: args.orderBy as never,
    });
  }
}

export type { EventRow, EntityRefDto };
