import { Injectable } from '@nestjs/common';
import { PitchSetting, PitchSurface, Prisma, type Event } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { Notifier } from '../../common/notify/notifier.service';
import {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  type CursorKey,
} from '../../common/pagination/cursor-page';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import { lockEvent, type Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import {
  AttachBookingDto,
  CancelGameDto,
  CreateGameDto,
  GameDto,
  GameListQuery,
  GamePageDto,
  UpdateGameDto,
} from './dto';
import { GameViewService } from './game-view.service';
import { ParticipationService } from './participation.service';

const csvInts = (v?: string): number[] =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map(Number)
    .filter((n) => Number.isInteger(n));
const csvStrs = (v?: string): string[] =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const flag = (v?: string): boolean => v === 'true' || v === '1';

function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new ApiError(ErrorCode.VALIDATION, 'Unknown timezone', { field: 'timezone' });
  }
}

@Injectable()
export class GamesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly idempotency: IdempotencyService,
    private readonly view: GameViewService,
    private readonly participation: ParticipationService,
    private readonly payments: PaymentsService,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ───────────── create / edit / lifecycle ─────────────

  async create(
    actorId: string,
    dto: CreateGameDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<GameDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: 'games.create', key, payload: dto },
      async (tx) => {
        const profile = await tx.profile.findUnique({
          where: { userId: actorId },
          select: { completedAt: true },
        });
        if (!profile?.completedAt) {
          throw new ApiError(
            ErrorCode.VALIDATION,
            'Complete your profile before organising a game',
            {
              reason: 'PROFILE_INCOMPLETE',
            },
          );
        }
        if (dto.endsAt <= dto.startsAt) {
          throw new ApiError(ErrorCode.VALIDATION, 'endsAt must be after startsAt', {
            field: 'endsAt',
          });
        }
        const now = this.clock.now();
        if (dto.publish && dto.startsAt <= now) {
          throw new ApiError(ErrorCode.VALIDATION, 'A published game must start in the future', {
            field: 'startsAt',
          });
        }
        // club rules
        if ((dto.kind === 'CLUB_V_CLUB' || dto.kind === 'TRAINING') && !dto.clubId) {
          throw new ApiError(ErrorCode.VALIDATION, 'clubId is required for this game type', {
            field: 'clubId',
          });
        }
        if (dto.clubId) {
          const club = await tx.club.findUnique({
            where: { id: dto.clubId },
            select: { status: true },
          });
          if (!club || club.status !== 'ACTIVE')
            throw new ApiError(ErrorCode.NOT_FOUND, 'Club not found');
          await this.policy.assert(
            actorId,
            'club.games.organise',
            { type: 'CLUB', id: dto.clubId },
            tx,
          );
        }
        // place
        let venueId = dto.venueId ?? null;
        let pitchId = dto.pitchId ?? null;
        let timezone = dto.timezone ?? null;
        let venueKind: 'PAID' | 'COMMUNITY' | null = null;
        if (pitchId) {
          const pitch = await tx.pitch.findUnique({
            where: { id: pitchId },
            include: { venue: true },
          });
          if (!pitch || pitch.venue.status !== 'PUBLISHED')
            throw new ApiError(ErrorCode.NOT_FOUND, 'Pitch not found');
          if (venueId && venueId !== pitch.venueId) {
            throw new ApiError(ErrorCode.VALIDATION, 'pitchId does not belong to venueId', {
              field: 'pitchId',
            });
          }
          venueId = pitch.venueId;
          timezone ??= pitch.venue.timezone;
          venueKind = pitch.venue.kind;
        } else if (venueId) {
          const venue = await tx.venue.findUnique({ where: { id: venueId } });
          if (!venue || venue.status !== 'PUBLISHED')
            throw new ApiError(ErrorCode.NOT_FOUND, 'Venue not found');
          timezone ??= venue.timezone;
          venueKind = venue.kind;
        }
        if (!timezone)
          throw new ApiError(ErrorCode.VALIDATION, 'timezone is required without a venue', {
            field: 'timezone',
          });
        assertTimezone(timezone);

        // booking link → pitch status derived, never client-asserted
        let bookingId: string | null = null;
        let pitchStatus = dto.pitchStatus ?? null;
        let pitchStatusSource: Event['pitchStatusSource'] = null;
        if (dto.bookingId) {
          const booking = await tx.booking.findUnique({ where: { id: dto.bookingId } });
          if (!booking || ['CANCELLED', 'REJECTED'].includes(booking.status)) {
            throw new ApiError(ErrorCode.NOT_FOUND, 'Booking not found');
          }
          const mayUse =
            booking.bookedById === actorId ||
            (dto.clubId
              ? await this.policy.can(
                  actorId,
                  'club.bookings.request',
                  { type: 'CLUB', id: dto.clubId },
                  tx,
                )
              : false);
          if (!mayUse)
            throw new ApiError(
              ErrorCode.ACCESS_DENIED,
              'You no longer have access to this action.',
            );
          if (pitchId && booking.pitchId !== pitchId) {
            throw new ApiError(ErrorCode.VALIDATION, 'The booking is for a different pitch', {
              field: 'bookingId',
            });
          }
          if (dto.startsAt < booking.startsAt || dto.endsAt > booking.endsAt) {
            throw new ApiError(
              ErrorCode.VALIDATION,
              'The game must fit inside the booked interval',
              { field: 'startsAt' },
            );
          }
          if (!pitchId) {
            const bp = await tx.pitch.findUniqueOrThrow({
              where: { id: booking.pitchId },
              include: { venue: true },
            });
            pitchId = bp.id;
            venueId = bp.venueId;
            timezone = dto.timezone ?? bp.venue.timezone;
          }
          bookingId = booking.id;
          pitchStatus = booking.status === 'CONFIRMED' ? 'PITCH_BOOKED' : 'BOOKING_PENDING';
          pitchStatusSource =
            booking.status === 'CONFIRMED' ? (booking.confirmationSource ?? 'VENUE') : null;
        } else if (pitchStatus) {
          if (pitchStatus === 'COMMUNITY_PITCH' && venueKind !== 'COMMUNITY') {
            throw new ApiError(ErrorCode.VALIDATION, 'Community pitch requires a community venue', {
              field: 'pitchStatus',
            });
          }
          // A manual "Pitch booked" is the organiser's claim, not a platform verification.
          if (pitchStatus === 'PITCH_BOOKED') pitchStatusSource = 'ORGANISER_MANUAL';
        }

        // capacity
        const teamCount = dto.teamCount ?? 2;
        const subs = dto.substitutesPerTeam ?? 0;
        let capacity = teamCount * (dto.formatPlayers + subs);
        if (dto.kind === 'TRAINING') {
          if (!dto.maxParticipants) {
            throw new ApiError(ErrorCode.VALIDATION, 'maxParticipants is required for a training', {
              field: 'maxParticipants',
            });
          }
          capacity = dto.maxParticipants;
        }
        if (dto.minConfirmed && dto.minConfirmed > capacity) {
          throw new ApiError(ErrorCode.VALIDATION, 'minConfirmed cannot exceed capacity', {
            field: 'minConfirmed',
          });
        }
        if (dto.autoCancel?.enabled) {
          if (
            !dto.autoCancel.checkAt ||
            dto.autoCancel.checkAt >= dto.startsAt ||
            !dto.minConfirmed
          ) {
            throw new ApiError(
              ErrorCode.VALIDATION,
              'Auto-cancel needs minConfirmed and a check time before the start',
              { field: 'autoCancel' },
            );
          }
        }
        if (dto.refereeUserId) {
          const ref = await tx.user.findUnique({
            where: { id: dto.refereeUserId },
            select: { status: true },
          });
          if (ref?.status !== 'ACTIVE')
            throw new ApiError(ErrorCode.VALIDATION, 'Unknown referee', { field: 'refereeUserId' });
        }
        if (dto.teams && dto.teams.length > teamCount) {
          throw new ApiError(ErrorCode.VALIDATION, 'More teams than teamCount', { field: 'teams' });
        }
        for (const t of dto.teams ?? []) {
          if (t.clubId) {
            const c = await tx.club.findUnique({ where: { id: t.clubId }, select: { id: true } });
            if (!c)
              throw new ApiError(ErrorCode.VALIDATION, 'Unknown club in teams', { field: 'teams' });
          }
        }

        const ev = await tx.event.create({
          data: {
            kind: dto.kind,
            status: dto.publish ? 'PUBLISHED' : 'DRAFT',
            organiserId: actorId,
            clubId: dto.clubId ?? null,
            venueId,
            pitchId,
            bookingId,
            title: dto.title ?? null,
            timezone,
            startsAt: dto.startsAt,
            endsAt: dto.endsAt,
            formatPlayers: dto.kind === 'TRAINING' ? dto.formatPlayers : dto.formatPlayers,
            teamCount,
            substitutesPerTeam: subs,
            capacity,
            minConfirmed: dto.minConfirmed ?? null,
            priceMinor: dto.priceMinor ?? 0,
            currency: dto.currency ?? 'GEL',
            pitchStatus,
            pitchStatusSource,
            joinMode: dto.joinMode ?? 'APPROVE_REQUESTS',
            ageBand: dto.ageBand ?? 'NONE',
            allowYounger: (dto.ageBand ?? 'NONE') === 'NONE' ? false : (dto.allowYounger ?? false),
            refereeIncluded: dto.refereeIncluded ?? false,
            videoIncluded: dto.videoIncluded ?? false,
            waterIncluded: dto.waterIncluded ?? false,
            bibsIncluded: dto.bibsIncluded ?? false,
            refereeUserId: dto.refereeUserId ?? null,
            waitlistEnabled: dto.waitlistEnabled ?? true,
            autoNextWave: dto.autoNextWave ?? true,
            payCashEnabled: dto.payCashEnabled ?? true,
            notes: dto.notes ?? null,
            autoCancelEnabled: dto.autoCancel?.enabled ?? false,
            autoCancelCheckAt: dto.autoCancel?.enabled ? (dto.autoCancel.checkAt ?? null) : null,
            publishedAt: dto.publish ? now : null,
          },
        });
        const teamRows = Array.from({ length: teamCount }, (_, i) => ({
          eventId: ev.id,
          index: i + 1,
          name: dto.teams?.[i]?.name ?? null,
          colour: dto.teams?.[i]?.colour ?? null,
          clubId:
            dto.teams?.[i]?.clubId ??
            (dto.kind === 'CLUB_V_CLUB' && i === 0 ? (dto.clubId ?? null) : null),
        }));
        await tx.eventTeam.createMany({ data: teamRows });
        await this.audit.record(tx, {
          actorId,
          action: 'game.create',
          targetType: 'Event',
          targetId: ev.id,
          requestId,
          metadata: { kind: dto.kind, clubId: dto.clubId ?? null, published: !!dto.publish },
        });
        return this.view.detail(tx, actorId, ev.id);
      },
    );
  }

  async publish(actorId: string, eventId: string, key: string | undefined): Promise<GameDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `games.publish:${eventId}`, key, payload: {} },
      async (tx) => {
        await lockEvent(tx, eventId);
        const ev = await this.mustEvent(tx, eventId);
        await this.policy.assert(actorId, 'event.manage', { type: 'EVENT', id: eventId }, tx);
        if (ev.status === 'PUBLISHED') return this.view.detail(tx, actorId, eventId);
        if (ev.status !== 'DRAFT')
          throw new ApiError(ErrorCode.CONFLICT, 'Only a draft can be published', {
            status: ev.status,
          });
        if (ev.startsAt <= this.clock.now()) {
          throw new ApiError(ErrorCode.VALIDATION, 'A published game must start in the future', {
            field: 'startsAt',
          });
        }
        await tx.event.update({
          where: { id: eventId },
          data: { status: 'PUBLISHED', publishedAt: this.clock.now(), version: { increment: 1 } },
        });
        return this.view.detail(tx, actorId, eventId);
      },
    );
  }

  async update(
    actorId: string,
    eventId: string,
    dto: UpdateGameDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<GameDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `games.update:${eventId}`, key, payload: dto },
      async (tx) => {
        await lockEvent(tx, eventId);
        const ev = await this.mustEvent(tx, eventId);
        await this.policy.assert(actorId, 'event.manage', { type: 'EVENT', id: eventId }, tx);
        if (dto.version !== ev.version) {
          throw new ApiError(ErrorCode.VERSION_CHANGED, 'This game was changed elsewhere', {
            currentVersion: ev.version,
          });
        }
        if (!['DRAFT', 'PUBLISHED'].includes(ev.status) || ev.startsAt <= this.clock.now()) {
          throw new ApiError(ErrorCode.CONFLICT, 'This game can no longer be edited', {
            status: ev.status,
          });
        }
        const startsAt = dto.startsAt ?? ev.startsAt;
        const endsAt = dto.endsAt ?? ev.endsAt;
        if (endsAt <= startsAt)
          throw new ApiError(ErrorCode.VALIDATION, 'endsAt must be after startsAt', {
            field: 'endsAt',
          });
        if (startsAt <= this.clock.now())
          throw new ApiError(ErrorCode.VALIDATION, 'startsAt must be in the future', {
            field: 'startsAt',
          });
        if (ev.bookingId && (dto.startsAt || dto.endsAt)) {
          const b = await tx.booking.findUniqueOrThrow({ where: { id: ev.bookingId } });
          if (startsAt < b.startsAt || endsAt > b.endsAt) {
            throw new ApiError(
              ErrorCode.BOOKING_CONFLICT,
              'The game must fit inside the booked interval',
            );
          }
        }
        if (dto.priceMinor !== undefined && dto.priceMinor !== ev.priceMinor) {
          // Changed conditions need each player's acceptance; obligations are never silently rewritten.
          const confirmed = await tx.participation.count({
            where: { eventId, status: 'CONFIRMED' },
          });
          if (confirmed > 0) {
            throw new ApiError(
              ErrorCode.CONFLICT,
              'Confirmed players must accept a price change: use the fee-amendment flow',
              { reason: 'FEE_AMENDMENT_REQUIRED', endpoint: `/v1/games/${eventId}/fee-amendments` },
            );
          }
        }
        if (dto.minConfirmed && dto.minConfirmed > ev.capacity) {
          throw new ApiError(ErrorCode.VALIDATION, 'minConfirmed cannot exceed capacity', {
            field: 'minConfirmed',
          });
        }
        if (dto.pitchStatus === 'COMMUNITY_PITCH' && ev.venueId) {
          const v = await tx.venue.findUnique({
            where: { id: ev.venueId },
            select: { kind: true },
          });
          if (v?.kind !== 'COMMUNITY')
            throw new ApiError(ErrorCode.VALIDATION, 'Community pitch requires a community venue', {
              field: 'pitchStatus',
            });
        }
        const capacityChange = await this.planCapacityChange(tx, ev, dto);
        const data: Prisma.EventUpdateInput = { version: { increment: 1 } };
        if (capacityChange) {
          data.formatPlayers = capacityChange.formatPlayers;
          data.teamCount = capacityChange.teamCount;
          data.substitutesPerTeam = capacityChange.substitutesPerTeam;
          data.capacity = capacityChange.capacity;
        }
        if (dto.title !== undefined) data.title = dto.title;
        if (dto.startsAt) data.startsAt = dto.startsAt;
        if (dto.endsAt) data.endsAt = dto.endsAt;
        if (dto.minConfirmed !== undefined) data.minConfirmed = dto.minConfirmed;
        if (dto.priceMinor !== undefined) data.priceMinor = dto.priceMinor;
        if (dto.joinMode) data.joinMode = dto.joinMode;
        if (dto.waitlistEnabled !== undefined) data.waitlistEnabled = dto.waitlistEnabled;
        if (dto.autoNextWave !== undefined) data.autoNextWave = dto.autoNextWave;
        if (dto.payCashEnabled !== undefined) data.payCashEnabled = dto.payCashEnabled;
        if (dto.notes !== undefined) data.notes = dto.notes;
        for (const f of [
          'refereeIncluded',
          'videoIncluded',
          'waterIncluded',
          'bibsIncluded',
        ] as const) {
          if (dto[f] !== undefined) data[f] = dto[f];
        }
        if (dto.pitchStatus && !ev.bookingId) {
          data.pitchStatus = dto.pitchStatus;
          data.pitchStatusSource = dto.pitchStatus === 'PITCH_BOOKED' ? 'ORGANISER_MANUAL' : null;
        }
        if (dto.autoCancel) {
          if (
            dto.autoCancel.enabled &&
            (!dto.autoCancel.checkAt ||
              dto.autoCancel.checkAt >= startsAt ||
              !(dto.minConfirmed ?? ev.minConfirmed))
          ) {
            throw new ApiError(
              ErrorCode.VALIDATION,
              'Auto-cancel needs minConfirmed and a check time before the start',
              { field: 'autoCancel' },
            );
          }
          data.autoCancelEnabled = dto.autoCancel.enabled;
          data.autoCancelCheckAt = dto.autoCancel.enabled ? (dto.autoCancel.checkAt ?? null) : null;
        }
        await tx.event.update({ where: { id: eventId }, data });
        if (capacityChange) {
          await this.applyTeamChange(tx, ev, capacityChange);
          if (capacityChange.capacity > ev.capacity) {
            // More room: queued players are offered the new places first.
            await this.participation.promoteWaitlist(tx, await this.mustEvent(tx, eventId));
          }
        }

        if (dto.startsAt || dto.endsAt) {
          await this.notifyAudience(
            tx,
            eventId,
            actorId,
            'game.rescheduled',
            'The time of a game changed',
          );
        }
        await this.audit.record(tx, {
          actorId,
          action: 'game.update',
          targetType: 'Event',
          targetId: eventId,
          requestId,
          metadata: { fields: Object.keys(data) },
        });
        return this.view.detail(tx, actorId, eventId);
      },
    );
  }

  async cancel(
    actorId: string,
    eventId: string,
    dto: CancelGameDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<GameDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `games.cancel:${eventId}`, key, payload: dto },
      async (tx) => {
        await lockEvent(tx, eventId);
        const ev = await this.mustEvent(tx, eventId);
        await this.policy.assert(actorId, 'event.manage', { type: 'EVENT', id: eventId }, tx);
        if (ev.status === 'CANCELLED') return this.view.detail(tx, actorId, eventId);
        if (!['DRAFT', 'PUBLISHED', 'STARTED'].includes(ev.status)) {
          throw new ApiError(ErrorCode.CONFLICT, 'This game can no longer be cancelled', {
            status: ev.status,
          });
        }
        await this.cancelInside(tx, ev, actorId, dto.reason, 'event.cancelled');
        await this.audit.record(tx, {
          actorId,
          action: 'game.cancel',
          targetType: 'Event',
          targetId: eventId,
          requestId,
          metadata: { reason: dto.reason },
        });
        return this.view.detail(tx, actorId, eventId);
      },
    );
  }

  /**
   * Post-publication capacity / team edits that are unambiguous:
   *  - never below what is occupied or reserved (confirmed + active holds + open offers);
   *  - never below any single team's confirmed count;
   *  - format / team-count changes only while no match exists (matches reference teams);
   *  - team-count DEcrease only removes EMPTY teams (no players, no captain, no club side);
   *    any redistribution of players between teams is undefined in the documents (OPEN #20b)
   *    and is refused with TEAM_REDISTRIBUTION_UNDEFINED instead of being guessed.
   */
  private async planCapacityChange(
    tx: Tx,
    ev: Event,
    dto: UpdateGameDto,
  ): Promise<{
    formatPlayers: number;
    teamCount: number;
    substitutesPerTeam: number;
    capacity: number;
    removeTeamIndexes: number[];
  } | null> {
    const touches =
      dto.formatPlayers !== undefined ||
      dto.teamCount !== undefined ||
      dto.substitutesPerTeam !== undefined ||
      dto.maxParticipants !== undefined;
    if (!touches) return null;
    const formatPlayers = dto.formatPlayers ?? ev.formatPlayers;
    const teamCount = dto.teamCount ?? ev.teamCount;
    const substitutesPerTeam = dto.substitutesPerTeam ?? ev.substitutesPerTeam;
    if (dto.maxParticipants !== undefined && ev.kind !== 'TRAINING') {
      throw new ApiError(ErrorCode.VALIDATION, 'maxParticipants is only for trainings', {
        field: 'maxParticipants',
      });
    }
    const capacity =
      ev.kind === 'TRAINING'
        ? (dto.maxParticipants ?? ev.capacity)
        : teamCount * (formatPlayers + substitutesPerTeam);
    if (
      capacity === ev.capacity &&
      formatPlayers === ev.formatPlayers &&
      teamCount === ev.teamCount &&
      substitutesPerTeam === ev.substitutesPerTeam
    ) {
      return null;
    }
    const structural = formatPlayers !== ev.formatPlayers || teamCount !== ev.teamCount;
    if (structural && (await tx.match.count({ where: { eventId: ev.id } })) > 0) {
      throw new ApiError(ErrorCode.CONFLICT, 'Format and team count are fixed once matches exist', {
        reason: 'MATCHES_EXIST',
      });
    }
    const now = this.clock.now();
    const [confirmed, holds, offers] = await Promise.all([
      tx.participation.count({ where: { eventId: ev.id, status: 'CONFIRMED' } }),
      tx.seatHold.count({ where: { eventId: ev.id, releasedAt: null, expiresAt: { gt: now } } }),
      tx.waitlistOffer.count({
        where: { eventId: ev.id, status: 'OFFERED', expiresAt: { gt: now } },
      }),
    ]);
    const occupied = confirmed + holds + offers;
    if (capacity < occupied) {
      throw new ApiError(
        ErrorCode.CAPACITY_CHANGED,
        'Capacity cannot drop below occupied or reserved places',
        {
          occupied,
          confirmed,
          holds,
          offers,
        },
      );
    }
    if (dto.minConfirmed === undefined && ev.minConfirmed && ev.minConfirmed > capacity) {
      throw new ApiError(ErrorCode.VALIDATION, 'minConfirmed would exceed the new capacity', {
        field: 'minConfirmed',
      });
    }
    const perTeam = formatPlayers + substitutesPerTeam;
    const teams = await tx.eventTeam.findMany({
      where: { eventId: ev.id },
      orderBy: { index: 'asc' },
    });
    const removeTeamIndexes: number[] = [];
    for (const team of teams) {
      const inTeam = await tx.participation.count({
        where: {
          eventId: ev.id,
          teamId: team.id,
          status: { in: ['CONFIRMED', 'PENDING_APPROVAL', 'WAITLISTED'] },
        },
      });
      if (team.index > teamCount) {
        if (inTeam > 0 || team.captainId || team.clubId) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'Removing a team that has players, a captain or a club needs a redistribution rule that is not defined',
            { reason: 'TEAM_REDISTRIBUTION_UNDEFINED', teamIndex: team.index },
          );
        }
        removeTeamIndexes.push(team.index);
      } else if (ev.kind !== 'TRAINING') {
        const confirmedInTeam = await tx.participation.count({
          where: { eventId: ev.id, teamId: team.id, status: 'CONFIRMED' },
        });
        if (confirmedInTeam > perTeam) {
          throw new ApiError(
            ErrorCode.CAPACITY_CHANGED,
            'A team already has more confirmed players than the new size',
            {
              teamIndex: team.index,
              confirmedInTeam,
              perTeam,
            },
          );
        }
      }
    }
    return { formatPlayers, teamCount, substitutesPerTeam, capacity, removeTeamIndexes };
  }

  private async applyTeamChange(
    tx: Tx,
    ev: Event,
    plan: { teamCount: number; removeTeamIndexes: number[] },
  ): Promise<void> {
    if (plan.removeTeamIndexes.length > 0) {
      await tx.eventTeam.deleteMany({
        where: { eventId: ev.id, index: { in: plan.removeTeamIndexes } },
      });
    }
    const existing = await tx.eventTeam.count({ where: { eventId: ev.id } });
    if (existing < plan.teamCount) {
      await tx.eventTeam.createMany({
        data: Array.from({ length: plan.teamCount - existing }, (_, i) => ({
          eventId: ev.id,
          index: existing + i + 1,
        })),
      });
    }
  }

  /** Shared by manual and automatic cancellation. Caller holds the event lock. */
  async cancelInside(
    tx: Tx,
    ev: Event,
    actorId: string,
    reason: string,
    activityKind: string,
  ): Promise<void> {
    const now = this.clock.now();
    const audience = await this.audienceIds(tx, ev.id);
    await tx.seatHold.updateMany({
      where: { eventId: ev.id, releasedAt: null },
      data: { releasedAt: now, releaseReason: 'EVENT_CANCELLED' },
    });
    await tx.waitlistOffer.updateMany({
      where: { eventId: ev.id, status: 'OFFERED' },
      data: { status: 'CANCELLED', respondedAt: now },
    });
    await tx.invitation.updateMany({
      where: { eventId: ev.id, status: 'PENDING' },
      data: { status: 'REVOKED', respondedAt: now },
    });
    await tx.participation.updateMany({
      where: { eventId: ev.id, status: { in: ['CONFIRMED', 'PENDING_APPROVAL', 'WAITLISTED'] } },
      data: { status: 'CANCELLED' },
    });
    await tx.event.update({
      where: { id: ev.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancelReason: reason,
        version: { increment: 1 },
      },
    });
    await this.payments.cancelObligationsForEvent(tx, ev.id, actorId, `Game cancelled: ${reason}`);
    // Cancelling the game is separate from cancelling the pitch booking: the booking is untouched.
    await this.notifier.notify(tx, {
      recipientIds: audience,
      category: 'game',
      activityKind,
      title: 'A game was cancelled',
      objectType: 'Event',
      objectId: ev.id,
      actorId: actorId === ev.organiserId ? actorId : null,
      essential: true,
      dedupeKey: `event:${ev.id}:cancelled`,
    });
  }

  /**
   * Attach a valid replacement booking after the previous one was lost (or link one later).
   * Validates like create(): usable status, actor may use it, the game fits the booked interval.
   * Pitch status is DERIVED from the booking (never client-asserted) and the attention flag clears
   * only here, i.e. when the venue problem is actually resolved.
   */
  async attachBooking(
    actorId: string,
    eventId: string,
    dto: AttachBookingDto,
    key: string | undefined,
    requestId?: string,
  ): Promise<GameDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `games.attach-booking:${eventId}`, key, payload: dto },
      async (tx) => {
        await lockEvent(tx, eventId);
        const ev = await this.mustEvent(tx, eventId);
        await this.policy.assert(actorId, 'event.manage', { type: 'EVENT', id: eventId }, tx);
        if (dto.version !== ev.version) {
          throw new ApiError(ErrorCode.VERSION_CHANGED, 'This game was changed elsewhere', {
            currentVersion: ev.version,
          });
        }
        if (!['DRAFT', 'PUBLISHED'].includes(ev.status) || ev.startsAt <= this.clock.now()) {
          throw new ApiError(ErrorCode.CONFLICT, 'A booking can no longer be attached', {
            status: ev.status,
          });
        }
        const booking = await tx.booking.findUnique({ where: { id: dto.bookingId } });
        if (!booking || ['CANCELLED', 'REJECTED', 'COMPLETED'].includes(booking.status)) {
          throw new ApiError(ErrorCode.NOT_FOUND, 'Booking not found');
        }
        const mayUse =
          booking.bookedById === actorId ||
          (ev.clubId
            ? await this.policy.can(
                actorId,
                'club.bookings.request',
                { type: 'CLUB', id: ev.clubId },
                tx,
              )
            : false);
        if (!mayUse) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
        }
        if (ev.startsAt < booking.startsAt || ev.endsAt > booking.endsAt) {
          throw new ApiError(
            ErrorCode.BOOKING_CONFLICT,
            'The game must fit inside the booked interval',
          );
        }
        const pitch = await tx.pitch.findUniqueOrThrow({
          where: { id: booking.pitchId },
          include: { venue: true },
        });
        const confirmed = booking.status === 'CONFIRMED';
        await tx.event.update({
          where: { id: eventId },
          data: {
            bookingId: booking.id,
            pitchId: pitch.id,
            venueId: pitch.venueId,
            pitchStatus: confirmed ? 'PITCH_BOOKED' : 'BOOKING_PENDING',
            pitchStatusSource: confirmed ? (booking.confirmationSource ?? 'VENUE') : null,
            venueNeedsAttention: false,
            venueAttentionReason: null,
            venueAttentionAt: null,
            version: { increment: 1 },
          },
        });
        await this.audit.record(tx, {
          actorId,
          action: 'game.booking_attached',
          targetType: 'Event',
          targetId: eventId,
          requestId,
          metadata: { bookingId: booking.id, hadAttention: ev.venueNeedsAttention },
        });
        if (ev.venueNeedsAttention) {
          await this.notifier.notify(tx, {
            recipientIds: await this.audienceIds(tx, eventId),
            category: 'game',
            activityKind: 'game.venue_resolved',
            title: 'The venue of a game was updated',
            objectType: 'Event',
            objectId: eventId,
            actorId,
            essential: true,
            dedupeKey: `event:${eventId}:venue-resolved:${booking.id}`,
          });
        }
        return this.view.detail(tx, actorId, eventId);
      },
    );
  }

  async start(actorId: string, eventId: string, key: string | undefined): Promise<GameDto> {
    return this.transition(actorId, eventId, key, 'PUBLISHED', 'STARTED', 'games.start');
  }

  async finish(actorId: string, eventId: string, key: string | undefined): Promise<GameDto> {
    return this.transition(actorId, eventId, key, 'STARTED', 'FINISHED', 'games.finish');
  }

  private async transition(
    actorId: string,
    eventId: string,
    key: string | undefined,
    from: Event['status'],
    to: Event['status'],
    scope: string,
  ): Promise<GameDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `${scope}:${eventId}`, key, payload: {} },
      async (tx) => {
        await lockEvent(tx, eventId);
        const ev = await this.mustEvent(tx, eventId);
        await this.policy.assert(actorId, 'event.manage', { type: 'EVENT', id: eventId }, tx);
        if (ev.status === to) return this.view.detail(tx, actorId, eventId);
        if (ev.status !== from)
          throw new ApiError(ErrorCode.CONFLICT, `Game must be ${from} to become ${to}`, {
            status: ev.status,
          });
        const now = this.clock.now();
        if (to === 'STARTED') {
          // Seats are final once the game starts: reservations and pending offers are released.
          await tx.seatHold.updateMany({
            where: { eventId, releasedAt: null },
            data: { releasedAt: now, releaseReason: 'EXPIRED' },
          });
          await tx.waitlistOffer.updateMany({
            where: { eventId, status: 'OFFERED' },
            data: { status: 'EXPIRED', respondedAt: now },
          });
          await tx.invitation.updateMany({
            where: { eventId, status: 'PENDING' },
            data: { status: 'EXPIRED', respondedAt: now },
          });
        }
        await tx.event.update({
          where: { id: eventId },
          data: { status: to, version: { increment: 1 } },
        });
        return this.view.detail(tx, actorId, eventId);
      },
    );
  }

  // ───────────── reads ─────────────

  get(viewerId: string | null, id: string): Promise<GameDto> {
    return this.view.detail(this.prisma, viewerId, id);
  }

  players(viewerId: string | null, id: string) {
    return this.view.players(this.prisma, viewerId, id);
  }

  /** Home feed / search. OR inside a group, AND between groups; keyset pagination. */
  async list(viewerId: string | null, q: GameListQuery): Promise<GamePageDto> {
    const now = this.clock.now();
    const limit = clampPageSize(q.limit);
    const where = await this.buildWhere(viewerId, q, now);
    const sort = q.sort === 'RECOMMENDED' || !q.sort ? 'STARTING_SOON' : q.sort;
    const cursor = decodeCursor(q.cursor);
    if (sort === 'NEAREST' || sort === 'ORGANISER_RATING') {
      return this.listComputedSort(viewerId, q, sort, where, cursor, limit);
    }
    const { orderBy, after } = this.sortSpec(sort, cursor);
    const rows = await this.view.loadRows(
      this.prisma,
      { AND: [where, ...(after ? [after] : [])] },
      { take: limit + 1, orderBy },
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = await this.view.summaries(this.prisma, viewerId, page);
    const last = page[page.length - 1];
    return { items, nextCursor: hasMore && last ? encodeCursor(this.keyOf(sort, last)) : null };
  }

  /**
   * Sorts that depend on a computed value (distance, organiser rating). Candidate ids come from the
   * same filter predicate, then PostgreSQL orders them with a proper composite keyset so paging stays
   * stable. Unknown distance / unrated organisers sort LAST (never as 0).
   */
  private async listComputedSort(
    viewerId: string | null,
    q: GameListQuery,
    sort: 'NEAREST' | 'ORGANISER_RATING',
    where: Prisma.EventWhereInput,
    cursor: CursorKey | undefined,
    limit: number,
  ): Promise<GamePageDto> {
    if (sort === 'NEAREST' && (q.lat === undefined || q.lng === undefined)) {
      // No location ⇒ no invented distances: ask for the coordinates or use another sort.
      throw new ApiError(ErrorCode.VALIDATION, 'lat and lng are required to sort by Nearest', {
        field: 'lat',
      });
    }
    const candidates = await this.prisma.event.findMany({
      where,
      select: { id: true },
      take: 5000,
    });
    const ids = candidates.map((c) => c.id);
    let ordered: { id: string; k: number | null; startsAt: Date }[];
    const n = limit + 1;
    if (sort === 'NEAREST') {
      const lat = q.lat as number;
      const lng = q.lng as number;
      const c = cursor ? this.parseComputedCursor(cursor) : null;
      const after = !c
        ? Prisma.sql``
        : c.k === null
          ? Prisma.sql`AND dist IS NULL AND ("startsAt" > ${c.s} OR ("startsAt" = ${c.s} AND id > ${c.id}::uuid))`
          : Prisma.sql`AND (dist IS NULL OR dist > ${c.k} OR (dist = ${c.k} AND ("startsAt" > ${c.s} OR ("startsAt" = ${c.s} AND id > ${c.id}::uuid))))`;
      ordered = await this.prisma.$queryRaw`
        WITH cand AS (
          SELECT e.id, e."startsAt",
            CASE WHEN v.latitude IS NULL OR v.longitude IS NULL THEN NULL
              ELSE (6371 * acos(least(1.0, greatest(-1.0,
                cos(radians(${lat})) * cos(radians(v.latitude::float8)) * cos(radians(v.longitude::float8) - radians(${lng}))
                + sin(radians(${lat})) * sin(radians(v.latitude::float8))))))::float8
            END AS dist
          FROM "Event" e LEFT JOIN "Venue" v ON v.id = e."venueId"
          WHERE e.id = ANY(${ids}::uuid[])
        )
        SELECT id, dist AS k, "startsAt" FROM cand
        WHERE true ${after}
        ORDER BY dist ASC NULLS LAST, "startsAt" ASC, id ASC
        LIMIT ${n}`;
    } else {
      const c = cursor ? this.parseComputedCursor(cursor) : null;
      const after = !c
        ? Prisma.sql``
        : Prisma.sql`AND (score < ${c.k ?? -1} OR (score = ${c.k ?? -1} AND ("startsAt" > ${c.s} OR ("startsAt" = ${c.s} AND id > ${c.id}::uuid))))`;
      ordered = await this.prisma.$queryRaw`
        WITH cand AS (
          SELECT e.id, e."startsAt",
            COALESCE((SELECT AVG(r.score)::float8 FROM "Rating" r
                      WHERE r."subjectType" = 'ORGANISER' AND r."subjectId" = e."organiserId" AND r."hiddenAt" IS NULL), -1)::float8 AS score
          FROM "Event" e WHERE e.id = ANY(${ids}::uuid[])
        )
        SELECT id, score AS k, "startsAt" FROM cand
        WHERE true ${after}
        ORDER BY score DESC, "startsAt" ASC, id ASC
        LIMIT ${n}`;
    }
    const hasMore = ordered.length > limit;
    const pageIds = (hasMore ? ordered.slice(0, limit) : ordered).map((o) => o.id);
    const rows = await this.view.loadRows(this.prisma, { id: { in: pageIds } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const page = pageIds
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined);
    const items = await this.view.summaries(this.prisma, viewerId, page);
    const last = (hasMore ? ordered.slice(0, limit) : ordered).at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              t: `${last.k === null ? 'NULL' : String(last.k)}|${last.startsAt.toISOString()}`,
              id: last.id,
            })
          : null,
    };
  }

  private parseComputedCursor(cursor: CursorKey): { k: number | null; s: Date; id: string } {
    const [k, s] = cursor.t.split('|');
    const start = new Date(s ?? '');
    if (!k || Number.isNaN(start.getTime()))
      throw new ApiError(ErrorCode.VALIDATION, 'Invalid cursor', { field: 'cursor' });
    return { k: k === 'NULL' ? null : Number(k), s: start, id: cursor.id };
  }

  /** Same predicate as `list`, used to flag invitations that fall outside the current filters. */
  async matchingIds(
    viewerId: string | null,
    q: GameListQuery,
    ids: string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const where = await this.buildWhere(viewerId, q, this.clock.now(), true);
    const rows = await this.prisma.event.findMany({
      where: { AND: [where, { id: { in: ids } }] },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  async buildWhere(
    viewerId: string | null,
    q: GameListQuery,
    now: Date,
    includePast = false,
  ): Promise<Prisma.EventWhereInput> {
    const and: Prisma.EventWhereInput[] = [{ status: 'PUBLISHED' }];
    if (!includePast) and.push({ startsAt: { gt: now } });
    if (q.from) and.push({ startsAt: { gte: q.from } });
    if (q.to) and.push({ startsAt: { lt: q.to } });
    const formats = csvInts(q.formats);
    if (formats.length) and.push({ formatPlayers: { in: formats } });
    const kinds = csvStrs(q.kinds).filter((k): k is Event['kind'] =>
      ['CASUAL', 'CLUB_V_CLUB', 'TRAINING'].includes(k),
    );
    if (kinds.length) and.push({ kind: { in: kinds } });
    if (flag(q.freeOnly)) and.push({ priceMinor: 0 });
    if (q.priceMin !== undefined) and.push({ priceMinor: { gte: q.priceMin } });
    if (q.priceMax !== undefined) and.push({ priceMinor: { lte: q.priceMax } });
    if (q.ageBand) and.push({ ageBand: q.ageBand });
    if (flag(q.referee)) and.push({ refereeIncluded: true });
    if (flag(q.video)) and.push({ videoIncluded: true });
    if (flag(q.pitchBookedOnly)) and.push({ pitchStatus: 'PITCH_BOOKED' });
    if (flag(q.venueConfirmedOnly))
      and.push({ pitchStatus: 'PITCH_BOOKED', pitchStatusSource: { in: ['VENUE', 'SYSTEM'] } });
    if (q.organiserId) and.push({ organiserId: q.organiserId });
    if (q.clubId) and.push({ clubId: q.clubId });
    if (q.venueId) and.push({ venueId: q.venueId });
    if (q.pitchId) and.push({ pitchId: q.pitchId });
    if (q.city) and.push({ venue: { city: { equals: q.city, mode: 'insensitive' } } });
    const surfaces = csvStrs(q.surfaces).filter((surface): surface is PitchSurface =>
      Object.values(PitchSurface).includes(surface as PitchSurface),
    );
    if (surfaces.length) and.push({ pitch: { surface: { in: surfaces } } });
    const settings = csvStrs(q.settings).filter((setting): setting is PitchSetting =>
      Object.values(PitchSetting).includes(setting as PitchSetting),
    );
    if (settings.length) and.push({ pitch: { setting: { in: settings } } });
    const amenities = csvStrs(q.amenities);
    if (amenities.length) and.push({ pitch: { amenities: { hasSome: amenities } } });
    if (q.durationMinMinutes !== undefined || q.durationMaxMinutes !== undefined) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT e.id FROM "Event" e
        WHERE (${q.durationMinMinutes ?? 0} <= EXTRACT(EPOCH FROM (e."endsAt" - e."startsAt")) / 60)
          AND (${q.durationMaxMinutes ?? Number.MAX_SAFE_INTEGER} >= EXTRACT(EPOCH FROM (e."endsAt" - e."startsAt")) / 60)`;
      and.push({ id: { in: rows.map((row) => row.id) } });
    }
    if (q.minOrganiserRating !== undefined) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT e.id FROM "Event" e
        JOIN "Rating" r ON r."subjectId" = e."organiserId"
          AND r."subjectType" = 'ORGANISER' AND r."hiddenAt" IS NULL
        GROUP BY e.id
        HAVING AVG(r.score) >= ${q.minOrganiserRating}`;
      and.push({ id: { in: rows.map((row) => row.id) } });
    }
    if (q.radiusKm !== undefined) {
      if (q.lat === undefined || q.lng === undefined)
        throw new ApiError(ErrorCode.VALIDATION, 'lat and lng are required with radiusKm', {
          field: q.lat === undefined ? 'lat' : 'lng',
        });
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT e.id FROM "Event" e
        JOIN "Venue" v ON v.id = e."venueId"
        WHERE v.latitude IS NOT NULL AND v.longitude IS NOT NULL
          AND (6371 * acos(least(1.0, greatest(-1.0,
            cos(radians(${q.lat})) * cos(radians(v.latitude::float8))
            * cos(radians(v.longitude::float8) - radians(${q.lng}))
            + sin(radians(${q.lat})) * sin(radians(v.latitude::float8)))))) <= ${q.radiusKm}`;
      and.push({ id: { in: rows.map((row) => row.id) } });
    }
    if (q.availability === 'OPEN' || q.availability === 'OPEN_OR_WAITLIST') {
      const ids = await this.availableEventIds(q.availability === 'OPEN_OR_WAITLIST', now);
      and.push({ id: { in: ids } });
    }
    if (flag(q.playersIFollow) && viewerId) {
      const followed = await this.prisma.follow.findMany({
        where: { followerId: viewerId, targetType: 'USER', status: 'ACCEPTED' },
        select: { targetId: true },
        take: 2000,
      });
      and.push({
        participations: {
          some: { status: 'CONFIRMED', userId: { in: followed.map((f) => f.targetId) } },
        },
      });
    }
    // hide organisers who blocked / were blocked by the viewer
    if (viewerId) {
      const blocks = await this.prisma.block.findMany({
        where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
        select: { blockerId: true, blockedId: true },
      });
      const hidden = blocks.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId));
      if (hidden.length) and.push({ organiserId: { notIn: hidden } });
    }
    return { AND: and };
  }

  /** Events with at least one publicly free place (optionally also those with an open waitlist). */
  private async availableEventIds(orWaitlist: boolean, now: Date): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT e.id FROM "Event" e
      WHERE e.status = 'PUBLISHED' AND e."startsAt" > ${now}
        AND (
          e.capacity
          - (SELECT count(*) FROM "Participation" p WHERE p."eventId" = e.id AND p.status = 'CONFIRMED')
          - (SELECT count(*) FROM "SeatHold" h WHERE h."eventId" = e.id AND h."releasedAt" IS NULL AND h."expiresAt" > ${now})
          - (SELECT count(*) FROM "WaitlistOffer" o WHERE o."eventId" = e.id AND o.status = 'OFFERED' AND o."expiresAt" > ${now})
          > 0
          ${orWaitlist ? this.prismaSqlOr() : this.prismaSqlNone()}
        )`;
    return rows.map((r) => r.id);
  }

  private prismaSqlOr() {
    return Prisma.sql`OR e."waitlistEnabled" = true`;
  }
  private prismaSqlNone() {
    return Prisma.sql``;
  }

  private sortSpec(
    sort: NonNullable<GameListQuery['sort']>,
    cursor: CursorKey | undefined,
  ): { orderBy: object[]; after: Prisma.EventWhereInput | null } {
    switch (sort) {
      case 'RECENTLY_ADDED': {
        const orderBy = [{ publishedAt: 'desc' }, { id: 'desc' }];
        if (!cursor) return { orderBy, after: null };
        const t = new Date(cursor.t);
        return {
          orderBy,
          after: { OR: [{ publishedAt: { lt: t } }, { publishedAt: t, id: { lt: cursor.id } }] },
        };
      }
      case 'PRICE_LOW_HIGH': {
        const orderBy = [{ priceMinor: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }];
        if (!cursor) return { orderBy, after: null };
        const [price, start] = cursor.t.split('|');
        const p = Number(price);
        const s = new Date(start ?? '');
        return {
          orderBy,
          after: {
            OR: [
              { priceMinor: { gt: p } },
              { priceMinor: p, startsAt: { gt: s } },
              { priceMinor: p, startsAt: s, id: { gt: cursor.id } },
            ],
          },
        };
      }
      default: {
        // STARTING_SOON (and RECOMMENDED until OPEN #2 is decided)
        const orderBy = [{ startsAt: 'asc' }, { id: 'asc' }];
        if (!cursor) return { orderBy, after: null };
        const t = new Date(cursor.t);
        return {
          orderBy,
          after: { OR: [{ startsAt: { gt: t } }, { startsAt: t, id: { gt: cursor.id } }] },
        };
      }
    }
  }

  private keyOf(sort: NonNullable<GameListQuery['sort']>, ev: Event): CursorKey {
    if (sort === 'RECENTLY_ADDED')
      return { t: (ev.publishedAt ?? ev.createdAt).toISOString(), id: ev.id };
    if (sort === 'PRICE_LOW_HIGH')
      return { t: `${ev.priceMinor}|${ev.startsAt.toISOString()}`, id: ev.id };
    return { t: ev.startsAt.toISOString(), id: ev.id };
  }

  // ───────────── helpers ─────────────

  async mustEvent(tx: Tx, id: string): Promise<Event> {
    const ev = await tx.event.findUnique({ where: { id } });
    if (!ev) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return ev;
  }

  /** Everyone with a stake in the game: players in any active state and pending invitees. */
  async audienceIds(tx: Tx, eventId: string): Promise<string[]> {
    const [parts, invs] = await Promise.all([
      tx.participation.findMany({
        where: { eventId, status: { in: ['CONFIRMED', 'PENDING_APPROVAL', 'WAITLISTED'] } },
        select: { userId: true },
      }),
      tx.invitation.findMany({
        where: { eventId, status: 'PENDING' },
        select: { inviteeId: true },
      }),
    ]);
    return [...new Set([...parts.map((p) => p.userId), ...invs.map((i) => i.inviteeId)])];
  }

  private async notifyAudience(
    tx: Tx,
    eventId: string,
    actorId: string,
    kind: string,
    title: string,
  ) {
    await this.notifier.notify(tx, {
      recipientIds: await this.audienceIds(tx, eventId),
      category: 'game',
      activityKind: kind,
      title,
      objectType: 'Event',
      objectId: eventId,
      actorId,
      essential: true,
    });
  }
}
