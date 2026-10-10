import { Injectable } from '@nestjs/common';
import type { Booking, Prisma } from '@prisma/client';
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
import {
  bookingStep,
  mergeWindows,
  parseStoredOpeningHours,
  validateBlockWindow,
  validateBookingWindow,
  windowsOpeningOn,
  type BookingRuleSet,
  type TimeWindow,
} from './booking-rules';
import {
  AvailabilityDto,
  BlockDto,
  BookingDto,
  BookingEventLink,
  BookingPageDto,
  CalendarDto,
  CalendarEntryDto,
  CreateBlockDto,
  CreateBookingDto,
  CreateExternalBookingDto,
  StaffBookingDto,
  StaffBookingPageDto,
} from './dto';
import { EXCLUSION_VIOLATION, sqlState } from './pg-errors';
import { localParts, parseYMD } from './time-zone';

const WHOLE_PITCH = 'whole pitch';
const OPEN_BOOKINGS_PER_USER = 20;
const MAX_CALENDAR_DAYS = 62;
const ACTIVE = ['REQUESTED', 'HELD', 'CONFIRMED'] as const;

type PitchCtx = Prisma.PitchGetPayload<{
  include: {
    venue: true;
    rules: true;
    configurations: { include: { parts: true } };
  };
}>;

interface StaffFlags {
  /** pitch.calendar.manage or pitch.manage */
  calendar: boolean;
  /** pitch.bookings.decide or pitch.manage */
  decide: boolean;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {}

  // ───────────── exported helpers ─────────────

  /** What the games module needs to attach a game to a booking. */
  async getBookingForEventLink(db: Db, bookingId: string): Promise<BookingEventLink | null> {
    const b = await db.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        pitchId: true,
        status: true,
        startsAt: true,
        endsAt: true,
        bookedById: true,
        confirmationSource: true,
        pitch: { select: { venueId: true } },
      },
    });
    if (!b) return null;
    return {
      id: b.id,
      pitchId: b.pitchId,
      venueId: b.pitch.venueId,
      status: b.status,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      bookedById: b.bookedById,
      confirmationSource: b.confirmationSource,
    };
  }

  /**
   * Read-only state of bookings for other modules that build on rented windows (tournaments).
   * `effective`: CONFIRMED (also COMPLETED) is usable, PENDING (requested / held) is not yet
   * confirmed, LOST is cancelled / rejected / an expired hold. Expiry is evaluated against `now`
   * without writing, so it is correct even before the lazy upkeep ran.
   */
  async bookingWindows(db: Db, bookingIds: string[], now: Date = this.clock.now()) {
    if (bookingIds.length === 0) return [];
    const rows = await db.booking.findMany({
      where: { id: { in: bookingIds } },
      select: {
        id: true,
        pitchId: true,
        status: true,
        startsAt: true,
        endsAt: true,
        bookedById: true,
        holdExpiresAt: true,
      },
    });
    return rows.map((b) => {
      const expired = b.status === 'HELD' && b.holdExpiresAt !== null && b.holdExpiresAt <= now;
      const effective: 'CONFIRMED' | 'PENDING' | 'LOST' =
        b.status === 'CONFIRMED' || b.status === 'COMPLETED'
          ? 'CONFIRMED'
          : (b.status === 'HELD' && !expired) || b.status === 'REQUESTED'
            ? 'PENDING'
            : 'LOST';
      return { ...b, effective };
    });
  }

  /**
   * Occupancy on ANY part of the pitch (whole pitch, halves, quarters - the atomic parts are what
   * the exclusion constraint guards) overlapping [startsAt, endsAt) that does not belong to
   * `ignoreBookingIds`. Released occupancy (cancelled / expired) does not count.
   */
  async foreignOccupancy(
    db: Db,
    pitchId: string,
    startsAt: Date,
    endsAt: Date,
    ignoreBookingIds: string[] = [],
  ): Promise<{ kind: 'BOOKING' | 'BLOCK'; id: string; startsAt: Date; endsAt: Date }[]> {
    const rows = await db.pitchOccupancy.findMany({
      where: {
        part: { pitchId },
        releasedAt: null,
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        ...(ignoreBookingIds.length ? { NOT: { bookingId: { in: ignoreBookingIds } } } : {}),
      },
      select: { bookingId: true, calendarBlockId: true, startsAt: true, endsAt: true },
    });
    const seen = new Set<string>();
    const out: { kind: 'BOOKING' | 'BLOCK'; id: string; startsAt: Date; endsAt: Date }[] = [];
    for (const r of rows) {
      const id = r.bookingId ?? r.calendarBlockId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        kind: r.bookingId ? 'BOOKING' : 'BLOCK',
        id,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
      });
    }
    return out;
  }

  /**
   * Serialises a caller with concurrent booking creation on these pitches: booking inserts take a
   * KEY SHARE lock on the Pitch row, so after this returns nobody can add occupancy until the
   * caller's transaction ends, and anything already in flight has committed and is visible.
   */
  async lockPitchesExclusive(tx: Tx, pitchIds: string[]): Promise<void> {
    for (const id of [...new Set(pitchIds)].sort()) {
      await tx.$queryRaw`SELECT id FROM "Pitch" WHERE id = ${id}::uuid FOR UPDATE`;
    }
  }

  /**
   * Temporary holds that ran out free their time. Called lazily by every read and write path and
   * safe to call from a scheduler. Returns how many holds expired.
   */
  async expireHolds(now: Date = this.clock.now(), db: Db = this.prisma): Promise<number> {
    // Expiry and the flagging of linked games must commit together.
    if ('$transaction' in db) return db.$transaction((tx) => this.expireHoldsIn(tx, now));
    return this.expireHoldsIn(db, now);
  }

  private async expireHoldsIn(tx: Tx, now: Date): Promise<number> {
    const due = await tx.booking.findMany({
      where: { status: 'HELD', holdExpiresAt: { lte: now } },
      select: { id: true, bookedById: true },
      orderBy: { id: 'asc' },
      take: 500,
    });
    let expired = 0;
    for (const d of due) {
      const res = await tx.booking.updateMany({
        where: { id: d.id, status: 'HELD' },
        data: { status: 'CANCELLED', cancelReason: 'HOLD_EXPIRED', holdExpiresAt: null },
      });
      if (res.count !== 1) continue; // someone else expired it first
      expired += 1;
      await tx.pitchOccupancy.updateMany({
        where: { bookingId: d.id, releasedAt: null },
        data: { releasedAt: now },
      });
      await this.flagLinkedEvents(tx, d.id, 'BOOKING_EXPIRED');
      if (!d.bookedById) continue;
      await this.notifier.notify(tx, {
        recipientIds: [d.bookedById],
        category: 'booking',
        activityKind: 'booking.hold_expired',
        title: 'Your pitch hold expired',
        objectType: 'BOOKING',
        objectId: d.id,
        payload: { bookingId: d.id },
        dedupeKey: `booking:${d.id}:hold_expired`,
        essential: true,
      });
    }
    return expired;
  }

  /**
   * A booking that games are linked to was cancelled, rejected or its hold expired: every live
   * game keeps its status, chat, participants and payments, but is flagged “venue needs attention”
   * and loses “Pitch booked” (that label must reflect a real confirmed booking). Call this in the
   * SAME transaction as the booking change, from every release path. Idempotent: a game already
   * flagged is not touched, audited or notified again. Returns the ids of the games flagged.
   */
  async flagLinkedEvents(
    tx: Tx,
    bookingId: string,
    reason: 'BOOKING_CANCELLED' | 'BOOKING_REJECTED' | 'BOOKING_EXPIRED',
    actorId: string | null = null,
    requestId?: string,
  ): Promise<string[]> {
    // Row locks make concurrent releases flag (and notify) each game exactly once.
    const rows = await tx.$queryRaw<{ id: string; organiserId: string }[]>`
      SELECT id, "organiserId" FROM "Event"
      WHERE "bookingId" = ${bookingId}::uuid
        AND "venueNeedsAttention" = false
        AND status::text NOT IN ('CANCELLED', 'FINISHED', 'RESULT_PENDING', 'RESULT_CONFIRMED')
      ORDER BY id FOR UPDATE`;
    if (rows.length === 0) return [];
    const now = this.clock.now();
    await tx.event.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: {
        venueNeedsAttention: true,
        venueAttentionReason: reason,
        venueAttentionAt: now,
        pitchStatus: null,
        pitchStatusSource: null,
        version: { increment: 1 },
      },
    });
    for (const ev of rows) {
      const confirmed = await tx.participation.findMany({
        where: { eventId: ev.id, status: 'CONFIRMED' },
        select: { userId: true },
      });
      await this.audit.record(tx, {
        actorId,
        action: 'game.venue_attention',
        targetType: 'EVENT',
        targetId: ev.id,
        metadata: { bookingId, reason },
        requestId,
      });
      await this.notifier.notify(tx, {
        recipientIds: [ev.organiserId, ...confirmed.map((c) => c.userId)],
        category: 'booking',
        activityKind: 'game.venue_needs_attention',
        title: 'The venue of a game needs attention',
        objectType: 'EVENT',
        objectId: ev.id,
        payload: { eventId: ev.id, bookingId },
        dedupeKey: `game:${ev.id}:venue_attention:${bookingId}`,
        essential: true,
      });
    }
    return rows.map((r) => r.id);
  }

  /**
   * The booking became CONFIRMED: games still linked to it (and not flagged) now show
   * “Pitch booked” from a real confirmation. A flagged game keeps its flag — the organiser
   * has to re-attach explicitly.
   */
  private async syncLinkedEventsOnConfirm(tx: Tx, b: Booking): Promise<void> {
    await tx.event.updateMany({
      where: {
        bookingId: b.id,
        venueNeedsAttention: false,
        status: { notIn: ['CANCELLED', 'FINISHED', 'RESULT_PENDING', 'RESULT_CONFIRMED'] },
      },
      data: {
        pitchStatus: 'PITCH_BOOKED',
        pitchStatusSource: b.confirmationSource ?? 'VENUE',
        version: { increment: 1 },
      },
    });
  }

  /** Lazy upkeep: expire holds, mark elapsed confirmed bookings as COMPLETED. */
  private async maintain(db: Db): Promise<void> {
    const now = this.clock.now();
    await this.expireHolds(now, db);
    await db.booking.updateMany({
      where: { status: 'CONFIRMED', endsAt: { lte: now } },
      data: { status: 'COMPLETED' },
    });
  }

  // ───────────── availability & calendar ─────────────

  async availability(
    viewerId: string | null,
    pitchId: string,
    date: string,
    configurationId: string | undefined,
  ): Promise<AvailabilityDto> {
    const day = parseYMD(date);
    if (!day) throw new ApiError(ErrorCode.VALIDATION, 'Invalid date.', { field: 'date' });
    await this.maintain(this.prisma);
    const ctx = await this.loadPitch(this.prisma, pitchId);
    await this.assertVisibleForBooking(ctx, viewerId);
    const config = this.pickConfiguration(ctx, configurationId);
    const rules = this.rulesOf(ctx);
    const tz = ctx.venue.timezone;
    const windows = mergeWindows(
      windowsOpeningOn(parseStoredOpeningHours(rules.openingHours), day, tz),
    );
    const partIds = config.parts.map((p) => p.partId);
    const from = windows[0]?.start ?? new Date();
    const to = windows[windows.length - 1]?.end ?? new Date();
    const occupied = windows.length
      ? await this.prisma.pitchOccupancy.findMany({
          where: {
            partId: { in: partIds },
            releasedAt: null,
            startsAt: { lt: to },
            endsAt: { gt: from },
          },
          select: { startsAt: true, endsAt: true },
        })
      : [];
    const now = this.clock.now();
    const free: TimeWindow[] = [];
    for (const w of windows) {
      let cursor = w.start;
      const busy = occupied
        .filter((o) => o.startsAt < w.end && o.endsAt > w.start)
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      for (const o of busy) {
        if (o.startsAt > cursor) free.push({ start: cursor, end: o.startsAt });
        if (o.endsAt > cursor) cursor = o.endsAt;
      }
      if (cursor < w.end) free.push({ start: cursor, end: w.end });
    }
    const intervals = free
      .map((f) => this.alignToGrid(f, tz, rules.gridMinutes, now))
      .filter(
        (f): f is TimeWindow =>
          f !== null && (f.end.getTime() - f.start.getTime()) / 60_000 >= rules.minDurationMinutes,
      )
      .map((f) => ({ startsAt: f.start.toISOString(), endsAt: f.end.toISOString() }));
    return {
      pitchId,
      configurationId: config.id,
      date,
      timezone: tz,
      minDurationMinutes: rules.minDurationMinutes,
      gridMinutes: rules.gridMinutes,
      stepMinutes: bookingStep(rules),
      rulesVersion: ctx.rules?.ruleVersion ?? 1,
      intervals,
    };
  }

  private alignToGrid(w: TimeWindow, tz: string, grid: number, now: Date): TimeWindow | null {
    let startMs = Math.ceil(Math.max(w.start.getTime(), now.getTime()) / 60_000) * 60_000;
    const rem = localParts(new Date(startMs), tz).minuteOfDay % grid;
    if (rem !== 0) startMs += (grid - rem) * 60_000;
    const endMs = w.end.getTime() - (localParts(w.end, tz).minuteOfDay % grid) * 60_000;
    return endMs > startMs ? { start: new Date(startMs), end: new Date(endMs) } : null;
  }

  async calendar(actorId: string, pitchId: string, from: Date, to: Date): Promise<CalendarDto> {
    if (!(to > from) || to.getTime() - from.getTime() > MAX_CALENDAR_DAYS * 86_400_000) {
      throw new ApiError(
        ErrorCode.VALIDATION,
        `Choose a range of up to ${MAX_CALENDAR_DAYS} days.`,
        {
          field: 'to',
        },
      );
    }
    await this.maintain(this.prisma);
    const ctx = await this.loadPitch(this.prisma, pitchId);
    const flags = await this.staffFlags(actorId, pitchId);
    if (!flags.calendar && !flags.decide) this.denyOrHide(ctx);
    const [bookings, blocks] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          pitchId,
          status: { in: ['REQUESTED', 'HELD', 'CONFIRMED', 'COMPLETED'] },
          startsAt: { lt: to },
          endsAt: { gt: from },
        },
        orderBy: { startsAt: 'asc' },
        include: { occupancies: { select: { partId: true } } },
      }),
      this.prisma.calendarBlock.findMany({
        where: { pitchId, cancelledAt: null, startsAt: { lt: to }, endsAt: { gt: from } },
        orderBy: { startsAt: 'asc' },
        include: { occupancies: { select: { partId: true } } },
      }),
    ]);
    const bookers = await this.bookerProfiles(
      this.prisma,
      bookings.flatMap((b) => (b.bookedById ? [b.bookedById] : [])),
    );
    const configNames = new Map(ctx.configurations.map((c) => [c.id, c.name]));
    const entries: CalendarEntryDto[] = [
      ...bookings.map<CalendarEntryDto>((b) => ({
        kind: 'BOOKING',
        id: b.id,
        configurationId: b.configurationId,
        configurationName: configNames.get(b.configurationId) ?? null,
        partIds: b.occupancies.map((o) => o.partId).sort(),
        startsAt: b.startsAt.toISOString(),
        endsAt: b.endsAt.toISOString(),
        status: b.status,
        isExternal: b.source === 'EXTERNAL',
        title:
          b.source === 'EXTERNAL'
            ? b.externalName
            : ((b.bookedById && bookers.get(b.bookedById)?.nickname) ?? null),
        phone: b.externalPhone,
        note: b.staffNote,
      })),
      ...blocks.map<CalendarEntryDto>((k) => ({
        kind: 'BLOCK',
        id: k.id,
        configurationId: null,
        configurationName: null,
        partIds: k.occupancies.map((o) => o.partId).sort(),
        startsAt: k.startsAt.toISOString(),
        endsAt: k.endsAt.toISOString(),
        status: null,
        isExternal: false,
        title: k.reason,
        phone: null,
        note: null,
      })),
    ].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return { pitchId, timezone: ctx.venue.timezone, entries };
  }

  // ───────────── create (clients) ─────────────

  async create(
    userId: string,
    dto: CreateBookingDto,
    idempotencyKey: string | undefined,
  ): Promise<BookingDto> {
    await this.requireCompleteProfile(userId);
    return this.idempotency.execute(
      { userId, scope: 'bookings.create', key: idempotencyKey, payload: dto },
      async (tx) => {
        await this.lockPitchShared(tx, dto.pitchId);
        await this.maintain(tx);
        const ctx = await this.loadPitch(tx, dto.pitchId);
        await this.assertVisibleForBooking(ctx, userId, tx);
        if (
          ctx.venue.kind !== 'PAID' ||
          ctx.venue.status !== 'PUBLISHED' ||
          ctx.status !== 'PUBLISHED'
        ) {
          throw new ApiError(ErrorCode.VALIDATION, 'This pitch can’t be booked through Let’sGo.', {
            field: 'pitchId',
          });
        }
        const config = this.pickConfiguration(ctx, dto.configurationId, true);
        const rules = this.rulesOf(ctx);
        const endsAt = new Date(dto.startsAt.getTime() + dto.durationMinutes * 60_000);
        const now = this.clock.now();
        validateBookingWindow({
          startsAt: dto.startsAt,
          endsAt,
          rules,
          timezone: ctx.venue.timezone,
          now,
        });
        const latest = await tx.bookingTerms.findFirst({
          where: { pitchId: ctx.id },
          orderBy: { version: 'desc' },
        });
        if (latest) {
          if (dto.termsVersion === undefined) {
            throw new ApiError(ErrorCode.VALIDATION, 'Accept the booking terms to continue.', {
              field: 'termsVersion',
              latestTermsVersion: latest.version,
            });
          }
          if (dto.termsVersion !== latest.version) {
            throw new ApiError(ErrorCode.VERSION_CHANGED, 'The booking terms have changed.', {
              currentVersion: latest.version,
              field: 'termsVersion',
            });
          }
        } else if (dto.termsVersion !== undefined) {
          throw new ApiError(ErrorCode.VALIDATION, 'This pitch has no booking terms.', {
            field: 'termsVersion',
          });
        }
        const open = await tx.booking.count({
          where: {
            bookedById: userId,
            source: 'LETSGO',
            status: { in: [...ACTIVE] },
            endsAt: { gt: now },
          },
        });
        if (open >= OPEN_BOOKINGS_PER_USER) {
          throw new ApiError(ErrorCode.CONFLICT, 'You have too many open bookings.', {
            reason: 'BOOKING_LIMIT',
          });
        }
        const booking = await this.insertBooking(tx, ctx, config.id, {
          bookedById: userId,
          source: 'LETSGO',
          status: 'REQUESTED',
          startsAt: dto.startsAt,
          endsAt,
          priceMinor: this.priceFor(ctx, dto.durationMinutes),
          rulesVersion: ctx.rules?.ruleVersion ?? 1,
          termsVersion: latest?.version ?? null,
          termsAcceptedAt: latest ? now : null,
        });
        await this.notifier.notify(tx, {
          recipientIds: await this.staffRecipients(tx, ctx, [
            Permission.PITCH_BOOKINGS_DECIDE,
            Permission.PITCH_MANAGE,
          ]),
          category: 'booking',
          activityKind: 'booking.requested',
          title: 'New booking request',
          objectType: 'BOOKING',
          objectId: booking.id,
          actorId: userId,
          payload: { bookingId: booking.id, pitchId: ctx.id },
          dedupeKey: `booking:${booking.id}:requested`,
          essential: true,
        });
        return this.clientDto(booking, ctx);
      },
    );
  }

  // ───────────── staff: external bookings & blocks ─────────────

  async createExternal(
    actorId: string,
    pitchId: string,
    dto: CreateExternalBookingDto,
    idempotencyKey: string | undefined,
    requestId: string,
  ): Promise<StaffBookingDto> {
    return this.idempotency.execute(
      { userId: actorId, scope: `bookings.external:${pitchId}`, key: idempotencyKey, payload: dto },
      async (tx) => {
        await this.lockPitchShared(tx, pitchId);
        await this.maintain(tx);
        const ctx = await this.loadPitch(tx, pitchId);
        await this.assertCalendarStaff(actorId, ctx, tx);
        const config = this.pickConfiguration(ctx, dto.configurationId, true);
        const rules = this.rulesOf(ctx);
        const endsAt = new Date(dto.startsAt.getTime() + dto.durationMinutes * 60_000);
        const now = this.clock.now();
        // Same validator as for clients: grid, 60-minute minimum, steps, opening hours.
        validateBookingWindow({
          startsAt: dto.startsAt,
          endsAt,
          rules,
          timezone: ctx.venue.timezone,
          now,
        });
        const booking = await this.insertBooking(tx, ctx, config.id, {
          bookedById: null,
          source: 'EXTERNAL',
          status: 'CONFIRMED',
          confirmationSource: 'VENUE',
          confirmedById: actorId,
          startsAt: dto.startsAt,
          endsAt,
          externalName: dto.externalName,
          externalPhone: dto.externalPhone ?? null,
          staffNote: dto.staffNote ?? null,
          priceMinor: null,
          rulesVersion: ctx.rules?.ruleVersion ?? 1,
        });
        await this.audit.record(tx, {
          actorId,
          action: 'booking.external.create',
          targetType: 'BOOKING',
          targetId: booking.id,
          metadata: { pitchId, startsAt: booking.startsAt, endsAt: booking.endsAt },
          requestId,
        });
        return this.staffDto(tx, booking, ctx);
      },
    );
  }

  async createBlock(
    actorId: string,
    pitchId: string,
    dto: CreateBlockDto,
    requestId: string,
  ): Promise<BlockDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockPitchShared(tx, pitchId);
      await this.maintain(tx);
      const ctx = await this.loadPitch(tx, pitchId);
      await this.assertCalendarStaff(actorId, ctx, tx);
      const config = this.pickConfiguration(ctx, dto.configurationId);
      const rules = this.rulesOf(ctx);
      const endsAt = new Date(dto.startsAt.getTime() + dto.durationMinutes * 60_000);
      validateBlockWindow({
        startsAt: dto.startsAt,
        endsAt,
        gridMinutes: rules.gridMinutes,
        timezone: ctx.venue.timezone,
        now: this.clock.now(),
      });
      const block = await tx.calendarBlock.create({
        data: {
          pitchId,
          startsAt: dto.startsAt,
          endsAt,
          reason: dto.reason ?? null,
          createdById: actorId,
        },
      });
      await this.occupy(
        tx,
        config.parts.map((p) => p.partId),
        dto.startsAt,
        endsAt,
        {
          calendarBlockId: block.id,
        },
      );
      await this.audit.record(tx, {
        actorId,
        action: 'calendar.block.create',
        targetType: 'PITCH',
        targetId: pitchId,
        metadata: { blockId: block.id, startsAt: dto.startsAt, endsAt },
        requestId,
      });
      return {
        id: block.id,
        pitchId,
        startsAt: block.startsAt.toISOString(),
        endsAt: block.endsAt.toISOString(),
        reason: block.reason,
        partIds: config.parts.map((p) => p.partId).sort(),
        cancelledAt: null,
      };
    });
  }

  async cancelBlock(
    actorId: string,
    pitchId: string,
    blockId: string,
    requestId: string,
  ): Promise<BlockDto> {
    return this.prisma.$transaction(async (tx) => {
      const ctx = await this.loadPitch(tx, pitchId);
      await this.assertCalendarStaff(actorId, ctx, tx);
      const block = await tx.calendarBlock.findFirst({
        where: { id: blockId, pitchId },
        include: { occupancies: { select: { partId: true } } },
      });
      if (!block) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
      const now = this.clock.now();
      if (!block.cancelledAt) {
        await tx.calendarBlock.update({ where: { id: blockId }, data: { cancelledAt: now } });
        await tx.pitchOccupancy.updateMany({
          where: { calendarBlockId: blockId, releasedAt: null },
          data: { releasedAt: now },
        });
        await this.audit.record(tx, {
          actorId,
          action: 'calendar.block.cancel',
          targetType: 'PITCH',
          targetId: pitchId,
          metadata: { blockId },
          requestId,
        });
      }
      return {
        id: block.id,
        pitchId,
        startsAt: block.startsAt.toISOString(),
        endsAt: block.endsAt.toISOString(),
        reason: block.reason,
        partIds: block.occupancies.map((o) => o.partId).sort(),
        cancelledAt: (block.cancelledAt ?? now).toISOString(),
      };
    });
  }

  // ───────────── status transitions ─────────────

  async confirm(actorId: string, bookingId: string, requestId: string): Promise<StaffBookingDto> {
    return this.transition(actorId, bookingId, async (tx, b, ctx, flags, now) => {
      this.assertDecider(flags, b);
      this.assertOpen(b, ['REQUESTED', 'HELD']);
      if (b.endsAt <= now) throw this.stateConflict('This booking is already over.');
      const updated = await tx.booking.update({
        where: { id: b.id },
        data: {
          status: 'CONFIRMED',
          confirmationSource: 'VENUE',
          confirmedById: actorId,
          holdExpiresAt: null,
          version: { increment: 1 },
        },
      });
      await this.syncLinkedEventsOnConfirm(tx, updated);
      await this.auditAndNotify(
        tx,
        ctx,
        updated,
        actorId,
        requestId,
        'booking.confirm',
        'confirmed',
      );
      return updated;
    });
  }

  async reject(
    actorId: string,
    bookingId: string,
    reason: string | undefined,
    requestId: string,
  ): Promise<StaffBookingDto> {
    return this.transition(actorId, bookingId, async (tx, b, ctx, flags, now) => {
      this.assertDecider(flags, b);
      this.assertOpen(b, ['REQUESTED', 'HELD']);
      const updated = await this.release(
        tx,
        b,
        'REJECTED',
        reason ?? null,
        now,
        actorId,
        requestId,
      );
      await this.auditAndNotify(tx, ctx, updated, actorId, requestId, 'booking.reject', 'rejected');
      return updated;
    });
  }

  async hold(
    actorId: string,
    bookingId: string,
    holdMinutes: number,
    requestId: string,
  ): Promise<StaffBookingDto> {
    return this.transition(actorId, bookingId, async (tx, b, ctx, flags, now) => {
      this.assertDecider(flags, b);
      this.assertOpen(b, ['REQUESTED']);
      const expires = new Date(
        Math.min(now.getTime() + holdMinutes * 60_000, b.startsAt.getTime()),
      );
      if (expires <= now) throw this.stateConflict('This booking starts too soon to hold.');
      const updated = await tx.booking.update({
        where: { id: b.id },
        data: { status: 'HELD', holdExpiresAt: expires, version: { increment: 1 } },
      });
      await this.auditAndNotify(tx, ctx, updated, actorId, requestId, 'booking.hold', 'held');
      return updated;
    });
  }

  async complete(actorId: string, bookingId: string, requestId: string): Promise<StaffBookingDto> {
    return this.transition(actorId, bookingId, async (tx, b, ctx, flags, now) => {
      if (!(flags.calendar || flags.decide)) throw this.denied();
      this.assertOpen(b, ['CONFIRMED']);
      if (b.endsAt > now) throw this.stateConflict('The booking has not finished yet.');
      const updated = await tx.booking.update({
        where: { id: b.id },
        data: { status: 'COMPLETED', version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        actorId,
        action: 'booking.complete',
        targetType: 'BOOKING',
        targetId: b.id,
        metadata: { pitchId: ctx.id },
        requestId,
      });
      return updated;
    });
  }

  /** Booker or venue staff. */
  async cancel(
    actorId: string,
    bookingId: string,
    reason: string | undefined,
    requestId: string,
  ): Promise<BookingDto | StaffBookingDto> {
    await this.maintain(this.prisma);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${bookingId}::uuid FOR UPDATE`;
      const b = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!b) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
      const ctx = await this.loadPitch(tx, b.pitchId);
      const flags = await this.staffFlags(actorId, b.pitchId, tx);
      const isBooker = b.bookedById === actorId;
      const isStaff = b.source === 'EXTERNAL' ? flags.calendar : flags.calendar || flags.decide;
      if (!isBooker && !isStaff) {
        if (flags.calendar || flags.decide) throw this.denied();
        throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
      }
      this.assertOpen(b, ['REQUESTED', 'HELD', 'CONFIRMED']);
      const now = this.clock.now();
      if (b.endsAt <= now) throw this.stateConflict('This booking is already over.');
      const updated = await this.release(
        tx,
        b,
        'CANCELLED',
        reason ?? null,
        now,
        actorId,
        requestId,
      );
      if (!isBooker || isStaff) {
        await this.audit.record(tx, {
          actorId,
          action: 'booking.cancel',
          targetType: 'BOOKING',
          targetId: b.id,
          metadata: { pitchId: ctx.id, byStaff: isStaff && !isBooker },
          requestId,
        });
      }
      if (isBooker) {
        await this.notifier.notify(tx, {
          recipientIds: await this.staffRecipients(tx, ctx, [
            Permission.PITCH_BOOKINGS_DECIDE,
            Permission.PITCH_MANAGE,
          ]),
          category: 'booking',
          activityKind: 'booking.cancelled_by_booker',
          title: 'A booking was cancelled by the booker',
          objectType: 'BOOKING',
          objectId: b.id,
          actorId,
          payload: { bookingId: b.id, pitchId: ctx.id },
          dedupeKey: `booking:${b.id}:cancelled`,
          essential: true,
        });
      } else {
        await this.notifyBooker(tx, updated, actorId, 'cancelled');
      }
      return { updated, ctx, staff: isStaff };
    });
    return result.staff
      ? this.staffDto(this.prisma, result.updated, result.ctx)
      : this.clientDto(result.updated, result.ctx);
  }

  private async transition(
    actorId: string,
    bookingId: string,
    work: (tx: Tx, b: Booking, ctx: PitchCtx, flags: StaffFlags, now: Date) => Promise<Booking>,
  ): Promise<StaffBookingDto> {
    await this.maintain(this.prisma);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${bookingId}::uuid FOR UPDATE`;
      const b = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!b) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
      const ctx = await this.loadPitch(tx, b.pitchId);
      const flags = await this.staffFlags(actorId, b.pitchId, tx);
      if (!flags.calendar && !flags.decide) {
        // Bookers learn nothing about staff actions; strangers learn nothing at all.
        if (b.bookedById === actorId) throw this.denied();
        throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
      }
      const updated = await work(tx, b, ctx, flags, this.clock.now());
      return this.staffDto(tx, updated, ctx);
    });
  }

  private assertDecider(flags: StaffFlags, b: Booking): void {
    if (!flags.decide || b.source === 'EXTERNAL') throw this.denied();
  }

  private assertOpen(b: Booking, allowed: Array<Booking['status']>): void {
    if (!allowed.includes(b.status)) {
      throw this.stateConflict(`This booking is already ${b.status.toLowerCase()}.`, b.status);
    }
  }

  private stateConflict(message: string, status?: string): ApiError {
    return new ApiError(ErrorCode.CONFLICT, message, { reason: 'BOOKING_STATE', status });
  }

  private denied(): ApiError {
    return new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
  }

  /** Terminal, occupancy-freeing transition (reject / cancel). */
  private async release(
    tx: Tx,
    b: Booking,
    status: 'REJECTED' | 'CANCELLED',
    reason: string | null,
    now: Date,
    actorId: string,
    requestId: string,
  ): Promise<Booking> {
    const updated = await tx.booking.update({
      where: { id: b.id },
      data: { status, cancelReason: reason, holdExpiresAt: null, version: { increment: 1 } },
    });
    await tx.pitchOccupancy.updateMany({
      where: { bookingId: b.id, releasedAt: null },
      data: { releasedAt: now },
    });
    await this.flagLinkedEvents(
      tx,
      b.id,
      status === 'REJECTED' ? 'BOOKING_REJECTED' : 'BOOKING_CANCELLED',
      actorId,
      requestId,
    );
    return updated;
  }

  private async auditAndNotify(
    tx: Tx,
    ctx: PitchCtx,
    b: Booking,
    actorId: string,
    requestId: string,
    action: string,
    what: string,
  ): Promise<void> {
    await this.audit.record(tx, {
      actorId,
      action,
      targetType: 'BOOKING',
      targetId: b.id,
      metadata: { pitchId: ctx.id, status: b.status },
      requestId,
    });
    await this.notifyBooker(tx, b, actorId, what);
  }

  private async notifyBooker(tx: Tx, b: Booking, actorId: string, what: string): Promise<void> {
    if (!b.bookedById) return;
    const titles: Record<string, string> = {
      confirmed: 'Your pitch booking was confirmed',
      rejected: 'Your pitch booking request was declined',
      held: 'The pitch is being held for you',
      cancelled: 'Your pitch booking was cancelled',
    };
    await this.notifier.notify(tx, {
      recipientIds: [b.bookedById],
      category: 'booking',
      activityKind: `booking.${what}`,
      title: titles[what] ?? 'Your pitch booking changed',
      objectType: 'BOOKING',
      objectId: b.id,
      actorId,
      payload: { bookingId: b.id, status: b.status },
      dedupeKey: `booking:${b.id}:${what}`,
      essential: true,
    });
  }

  // ───────────── reads ─────────────

  async getMine(userId: string, bookingId: string): Promise<BookingDto> {
    await this.maintain(this.prisma);
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!b || b.bookedById !== userId) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    }
    return this.clientDto(b, await this.loadPitch(this.prisma, b.pitchId));
  }

  /** Staff view of one booking of the pitch. */
  async getForStaff(actorId: string, pitchId: string, bookingId: string): Promise<StaffBookingDto> {
    await this.maintain(this.prisma);
    const ctx = await this.loadPitch(this.prisma, pitchId);
    const flags = await this.staffFlags(actorId, pitchId);
    if (!flags.calendar && !flags.decide) this.denyOrHide(ctx);
    const b = await this.prisma.booking.findFirst({ where: { id: bookingId, pitchId } });
    if (!b) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return this.staffDto(this.prisma, b, ctx);
  }

  async listMine(
    userId: string,
    page: PageQuery,
    status?: Booking['status'],
  ): Promise<BookingPageDto> {
    await this.maintain(this.prisma);
    const limit = clampPageSize(page.limit);
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.booking.findMany({
      where: {
        bookedById: userId,
        ...(status ? { status } : {}),
        ...keysetBefore('createdAt', cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const res = toPage(rows, limit, (b) => ({ t: b.createdAt.toISOString(), id: b.id }));
    const ctxs = new Map<string, PitchCtx>();
    for (const b of res.items) {
      if (!ctxs.has(b.pitchId)) ctxs.set(b.pitchId, await this.loadPitch(this.prisma, b.pitchId));
    }
    return {
      items: res.items.map((b) => this.clientDto(b, ctxs.get(b.pitchId) as PitchCtx)),
      nextCursor: res.nextCursor,
    };
  }

  async listForPitch(
    actorId: string,
    pitchId: string,
    page: PageQuery,
    status?: Booking['status'],
  ): Promise<StaffBookingPageDto> {
    await this.maintain(this.prisma);
    const ctx = await this.loadPitch(this.prisma, pitchId);
    const flags = await this.staffFlags(actorId, pitchId);
    if (!flags.calendar && !flags.decide) this.denyOrHide(ctx);
    const limit = clampPageSize(page.limit);
    const cursor = decodeCursor(page.cursor);
    const rows = await this.prisma.booking.findMany({
      where: { pitchId, ...(status ? { status } : {}), ...keysetBefore('createdAt', cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const res = toPage(rows, limit, (b) => ({ t: b.createdAt.toISOString(), id: b.id }));
    const items: StaffBookingDto[] = [];
    for (const b of res.items) items.push(await this.staffDto(this.prisma, b, ctx));
    return { items, nextCursor: res.nextCursor };
  }

  // ───────────── internals ─────────────

  private async insertBooking(
    tx: Tx,
    ctx: PitchCtx,
    configurationId: string,
    data: Omit<Prisma.BookingUncheckedCreateInput, 'pitchId' | 'configurationId' | 'currency'>,
  ): Promise<Booking> {
    const config = ctx.configurations.find((c) => c.id === configurationId);
    const booking = await tx.booking.create({
      data: { ...data, pitchId: ctx.id, configurationId, currency: ctx.currency },
    });
    await this.occupy(
      tx,
      (config?.parts ?? []).map((p) => p.partId),
      booking.startsAt,
      booking.endsAt,
      { bookingId: booking.id },
    );
    return booking;
  }

  /**
   * One occupancy row per atomic part. The exclusion constraint `pitch_occupancy_no_overlap` is
   * the source of truth: any overlap on any part (whole vs half vs quarter included) fails the
   * insert with SQLSTATE 23P01, which becomes BOOKING_CONFLICT.
   */
  private async occupy(
    tx: Tx,
    partIds: string[],
    startsAt: Date,
    endsAt: Date,
    owner: { bookingId: string } | { calendarBlockId: string },
  ): Promise<void> {
    try {
      await tx.pitchOccupancy.createMany({
        data: partIds.map((partId) => ({ partId, startsAt, endsAt, ...owner })),
      });
    } catch (err) {
      if (sqlState(err) === EXCLUSION_VIOLATION) {
        throw new ApiError(ErrorCode.BOOKING_CONFLICT, 'This time is no longer available.');
      }
      throw err;
    }
  }

  private async lockPitchShared(tx: Tx, pitchId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "Pitch" WHERE id = ${pitchId}::uuid FOR SHARE`;
  }

  private async loadPitch(db: Db, pitchId: string): Promise<PitchCtx> {
    const pitch = await db.pitch.findUnique({
      where: { id: pitchId },
      include: { venue: true, rules: true, configurations: { include: { parts: true } } },
    });
    if (!pitch) throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
    return pitch;
  }

  /** Public pitches are open to look at; drafts/hidden ones only to their staff. */
  private async assertVisibleForBooking(
    ctx: PitchCtx,
    viewerId: string | null,
    db: Db = this.prisma,
  ): Promise<void> {
    if (ctx.status === 'PUBLISHED' && ctx.venue.status === 'PUBLISHED') return;
    if (viewerId) {
      const flags = await this.staffFlags(viewerId, ctx.id, db);
      if (flags.calendar || flags.decide) return;
    }
    throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
  }

  private pickConfiguration(ctx: PitchCtx, id: string | undefined, required = false) {
    if (id) {
      const c = ctx.configurations.find((x) => x.id === id);
      if (!c) {
        throw new ApiError(ErrorCode.VALIDATION, 'Unknown configuration for this pitch.', {
          field: 'configurationId',
        });
      }
      return c;
    }
    if (required) {
      throw new ApiError(ErrorCode.VALIDATION, 'Choose what to book.', {
        field: 'configurationId',
      });
    }
    const whole =
      ctx.configurations.find((c) => c.name.toLowerCase() === WHOLE_PITCH) ??
      [...ctx.configurations].sort((a, b) => b.parts.length - a.parts.length)[0];
    if (!whole) {
      throw new ApiError(ErrorCode.VALIDATION, 'This pitch has no bookable configuration.');
    }
    return whole;
  }

  private rulesOf(ctx: PitchCtx): BookingRuleSet {
    return (
      ctx.rules ?? {
        minDurationMinutes: 60,
        gridMinutes: 30,
        allowHalfHourExtension: false,
        openingHours: null,
      }
    );
  }

  private priceFor(ctx: PitchCtx, durationMinutes: number): number | null {
    return ctx.pricePerHourMinor === null
      ? null
      : Math.round((ctx.pricePerHourMinor * durationMinutes) / 60);
  }

  private async staffFlags(
    userId: string,
    pitchId: string,
    db: Db = this.prisma,
  ): Promise<StaffFlags> {
    const target = { type: 'PITCH', id: pitchId } as const;
    const manage = await this.policy.can(userId, Permission.PITCH_MANAGE, target, db);
    const calendar = await this.policy.can(userId, Permission.PITCH_CALENDAR_MANAGE, target, db);
    const decide = await this.policy.can(userId, Permission.PITCH_BOOKINGS_DECIDE, target, db);
    return { calendar: manage || calendar, decide: manage || decide };
  }

  private async assertCalendarStaff(actorId: string, ctx: PitchCtx, db: Db): Promise<void> {
    const flags = await this.staffFlags(actorId, ctx.id, db);
    if (flags.calendar) return;
    if (flags.decide) throw this.denied();
    this.denyOrHide(ctx);
  }

  /** Published pitches are known to everybody (denied); drafts do not exist for outsiders. */
  private denyOrHide(ctx: PitchCtx): never {
    if (ctx.status === 'PUBLISHED' && ctx.venue.status === 'PUBLISHED') throw this.denied();
    throw new ApiError(ErrorCode.NOT_FOUND, 'This content isn’t available');
  }

  private async requireCompleteProfile(userId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { completedAt: true },
    });
    if (!profile?.completedAt) {
      throw new ApiError(ErrorCode.VALIDATION, 'Complete your profile first.', {
        field: 'profile',
      });
    }
  }

  /** Managers and deciders of the pitch (pitch-level and venue-level grants). */
  private async staffRecipients(db: Db, ctx: PitchCtx, permissions: string[]): Promise<string[]> {
    const grants = await db.roleGrant.findMany({
      where: {
        permission: { in: permissions },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: this.clock.now() } }],
        AND: [
          {
            OR: [
              { resourceType: 'PITCH', resourceId: ctx.id },
              { resourceType: 'VENUE', resourceId: ctx.venueId },
            ],
          },
        ],
      },
      select: { granteeId: true },
    });
    return [...new Set(grants.map((g) => g.granteeId))];
  }

  private async bookerProfiles(db: Db, ids: string[]) {
    const rows = await db.profile.findMany({
      where: { userId: { in: [...new Set(ids)] } },
      select: { userId: true, nickname: true, username: true },
    });
    return new Map(rows.map((r) => [r.userId, r]));
  }

  private configName(ctx: PitchCtx, id: string): string {
    return ctx.configurations.find((c) => c.id === id)?.name ?? '';
  }

  clientDto(b: Booking, ctx: PitchCtx): BookingDto {
    return {
      id: b.id,
      pitchId: b.pitchId,
      venueId: ctx.venueId,
      configurationId: b.configurationId,
      configurationName: this.configName(ctx, b.configurationId),
      source: b.source,
      status: b.status,
      pitchBooked: b.status === 'CONFIRMED',
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      holdExpiresAt: b.holdExpiresAt ? b.holdExpiresAt.toISOString() : null,
      priceMinor: b.priceMinor,
      currency: b.currency,
      rulesVersion: b.rulesVersion,
      termsVersion: b.termsVersion,
      termsAcceptedAt: b.termsAcceptedAt ? b.termsAcceptedAt.toISOString() : null,
      confirmationSource: b.confirmationSource,
      cancelReason: b.cancelReason,
      bookedById: b.bookedById,
      version: b.version,
      createdAt: b.createdAt.toISOString(),
    };
  }

  private async staffDto(db: Db, b: Booking, ctx: PitchCtx): Promise<StaffBookingDto> {
    const bookers = await this.bookerProfiles(db, b.bookedById ? [b.bookedById] : []);
    const p = b.bookedById ? bookers.get(b.bookedById) : undefined;
    return {
      ...this.clientDto(b, ctx),
      isExternal: b.source === 'EXTERNAL',
      booker: b.bookedById
        ? { userId: b.bookedById, nickname: p?.nickname ?? null, username: p?.username ?? null }
        : null,
      externalName: b.externalName,
      externalPhone: b.externalPhone,
      staffNote: b.staffNote,
      confirmedById: b.confirmedById,
    };
  }
}
