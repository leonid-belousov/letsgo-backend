import { Injectable } from '@nestjs/common';
import type { Tournament } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { PolicyService } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Db } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { BookingsService } from '../bookings/bookings.service';
import type {
  BookingProblemDto,
  TournamentBookingDto,
  TournamentBookingListDto,
} from './dto/bookings.dto';
import {
  ACTIVE_ENTRY,
  NOT_AVAILABLE,
  TournamentAccess,
  lockTournament,
} from './tournament-access.service';

export interface SlotToCheck {
  fixtureId: string;
  pitchId: string;
  start: number;
  end: number;
}

export interface AttachedWindow {
  bookingId: string;
  pitchId: string;
  start: number;
  end: number;
  effective: 'CONFIRMED' | 'PENDING' | 'LOST';
}

/**
 * Rental windows of a tournament. The booking rules themselves (grid, parts, exclusion
 * constraint, holds) stay in BookingsService; this service only asks it for the state of the
 * attached bookings and for foreign occupancy, and applies the tournament rules on top:
 *  - pitch WITH attached windows: a fixture must lie fully inside one CONFIRMED window
 *    (many fixtures share one booking);
 *  - pitch WITHOUT: the interval must be physically free (all parts), and is reported UNBOOKED.
 */
@Injectable()
export class TournamentBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TournamentAccess,
    private readonly policy: PolicyService,
    private readonly bookings: BookingsService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ───────────── attach / detach / list ─────────────

  private async gate(db: Db, actorId: string, tournamentId: string): Promise<Tournament> {
    const t = await this.access.loadVisible(db, actorId, tournamentId);
    await this.access.assertCan(db, actorId, 'tournament.schedule', t);
    this.access.assertNotTerminal(t);
    return t;
  }

  async windows(db: Db, tournamentId: string): Promise<AttachedWindow[]> {
    const links = await db.tournamentBooking.findMany({ where: { tournamentId } });
    const states = await this.bookings.bookingWindows(
      db,
      links.map((l) => l.bookingId),
      this.clock.now(),
    );
    return states.map((s) => ({
      bookingId: s.id,
      pitchId: s.pitchId,
      start: s.startsAt.getTime(),
      end: s.endsAt.getTime(),
      effective: s.effective,
    }));
  }

  async list(actorId: string, tournamentId: string): Promise<TournamentBookingListDto> {
    const t = await this.access.loadVisible(this.prisma, actorId, tournamentId);
    await this.access.assertAny(this.prisma, actorId, ['tournament.schedule'], t);
    return { items: await this.listDtos(this.prisma, tournamentId) };
  }

  private async listDtos(db: Db, tournamentId: string): Promise<TournamentBookingDto[]> {
    const links = await db.tournamentBooking.findMany({
      where: { tournamentId },
      orderBy: [{ createdAt: 'asc' }, { bookingId: 'asc' }],
    });
    if (links.length === 0) return [];
    const now = this.clock.now();
    const states = await this.bookings.bookingWindows(
      db,
      links.map((l) => l.bookingId),
      now,
    );
    const rows = await db.booking.findMany({
      where: { id: { in: links.map((l) => l.bookingId) } },
      select: { id: true, status: true, pitch: { select: { name: true } } },
    });
    const info = new Map(rows.map((r) => [r.id, r]));
    const fixtures = await db.fixture.findMany({
      where: {
        tournamentId,
        status: { in: ['SCHEDULED', 'LIVE'] },
        startsAt: { not: null },
        endsAt: { not: null },
      },
      select: { pitchId: true, startsAt: true, endsAt: true },
    });
    return links.flatMap((l) => {
      const s = states.find((x) => x.id === l.bookingId);
      const r = info.get(l.bookingId);
      if (!s || !r) return [];
      const inside = fixtures.filter(
        (f) =>
          f.pitchId === s.pitchId &&
          (f.startsAt as Date) >= s.startsAt &&
          (f.endsAt as Date) <= s.endsAt,
      ).length;
      return [
        {
          bookingId: s.id,
          pitchId: s.pitchId,
          pitchName: r.pitch.name,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          status: r.status,
          effective: s.effective,
          attachedById: l.attachedById,
          attachedAt: l.createdAt.toISOString(),
          fixtureCount: inside,
        },
      ];
    });
  }

  async attach(
    actorId: string,
    tournamentId: string,
    bookingId: string,
    key: string | undefined,
    requestId?: string,
  ): Promise<TournamentBookingListDto> {
    return this.idempotency.execute(
      {
        userId: actorId,
        scope: `tournaments.booking.attach:${tournamentId}`,
        key,
        payload: { bookingId },
      },
      async (tx) => {
        await lockTournament(tx, tournamentId);
        const t = await this.gate(tx, actorId, tournamentId);
        const booking = await tx.booking.findUnique({
          where: { id: bookingId },
          include: { pitch: { include: { venue: true } } },
        });
        if (!booking) throw new ApiError(ErrorCode.NOT_FOUND, NOT_AVAILABLE);
        if (booking.pitch.status !== 'PUBLISHED' || booking.pitch.venue.status !== 'PUBLISHED') {
          throw new ApiError(ErrorCode.VALIDATION, 'The pitch of this booking is not published', {
            field: 'bookingId',
          });
        }
        const [state] = await this.bookings.bookingWindows(tx, [bookingId], this.clock.now());
        if (!state || state.effective === 'LOST' || booking.endsAt <= this.clock.now()) {
          throw new ApiError(ErrorCode.CONFLICT, 'This booking is no longer active', {
            reason: 'BOOKING_NOT_ACTIVE',
          });
        }
        // who may use the window: the organiser's own booking, a rep of an entered club, or a booking decider
        const own = booking.bookedById === actorId;
        const decider = await this.policy.can(
          actorId,
          'pitch.bookings.decide',
          { type: 'PITCH', id: booking.pitchId },
          tx,
        );
        let repOfEntered = false;
        if (!own && !decider && booking.bookedById) {
          const entries = await tx.clubEntry.findMany({
            where: { tournamentId, status: { in: [...ACTIVE_ENTRY] } },
            select: { clubId: true, submittedById: true },
          });
          for (const e of entries) {
            if (
              e.submittedById === booking.bookedById ||
              (await this.access.clubRepresentatives(tx, e.clubId)).includes(booking.bookedById)
            ) {
              repOfEntered = true;
              break;
            }
          }
        }
        if (!own && !decider && !repOfEntered) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
        }
        const existing = await tx.tournamentBooking.findMany({ where: { bookingId } });
        if (existing.some((e) => e.tournamentId !== tournamentId)) {
          throw new ApiError(
            ErrorCode.CONFLICT,
            'This booking already belongs to another tournament',
          );
        }
        if (existing.length === 0) {
          await tx.tournamentBooking.create({
            data: { tournamentId: t.id, bookingId, attachedById: actorId },
          });
          await this.audit.record(tx, {
            actorId,
            action: 'tournament.booking.attach',
            targetType: 'Booking',
            targetId: bookingId,
            requestId,
            metadata: { tournamentId, pitchId: booking.pitchId },
          });
        }
        return { items: await this.listDtos(tx, tournamentId) };
      },
    );
  }

  async detach(
    actorId: string,
    tournamentId: string,
    bookingId: string,
    requestId?: string,
  ): Promise<TournamentBookingListDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockTournament(tx, tournamentId);
      await this.gate(tx, actorId, tournamentId);
      const res = await tx.tournamentBooking.deleteMany({ where: { tournamentId, bookingId } });
      if (res.count > 0) {
        await this.audit.record(tx, {
          actorId,
          action: 'tournament.booking.detach',
          targetType: 'Booking',
          targetId: bookingId,
          requestId,
          metadata: { tournamentId },
        });
      }
      return { items: await this.listDtos(tx, tournamentId) };
    });
  }

  // ───────────── validation used by schedule / start ─────────────

  /**
   * Builds the schedulable windows: parameter windows on pitches with attached bookings are
   * clipped to their CONFIRMED windows; on unbooked pitches, foreign occupancy is cut out.
   */
  async constrainWindows(
    db: Db,
    tournamentId: string,
    windows: { pitchId: string; start: number; end: number }[],
  ): Promise<{ pitchId: string; start: number; end: number }[]> {
    const attached = await this.windows(db, tournamentId);
    const out: { pitchId: string; start: number; end: number }[] = [];
    for (const w of windows) {
      const mine = attached.filter((a) => a.pitchId === w.pitchId);
      if (mine.length > 0) {
        for (const a of mine.filter((x) => x.effective === 'CONFIRMED')) {
          const s = Math.max(w.start, a.start);
          const e = Math.min(w.end, a.end);
          if (e > s) out.push({ pitchId: w.pitchId, start: s, end: e });
        }
        continue;
      }
      const busy = await this.bookings.foreignOccupancy(
        db,
        w.pitchId,
        new Date(w.start),
        new Date(w.end),
      );
      let free = [{ start: w.start, end: w.end }];
      for (const b of busy) {
        const bs = b.startsAt.getTime();
        const be = b.endsAt.getTime();
        free = free.flatMap((f) =>
          be <= f.start || bs >= f.end
            ? [f]
            : [
                ...(bs > f.start ? [{ start: f.start, end: bs }] : []),
                ...(be < f.end ? [{ start: be, end: f.end }] : []),
              ],
        );
      }
      out.push(...free.map((f) => ({ pitchId: w.pitchId, ...f })));
    }
    return out;
  }

  /** Blocking problems and non-blocking warnings for concrete fixture slots (safety net + start/report). */
  async evaluate(
    db: Db,
    tournamentId: string,
    slots: SlotToCheck[],
  ): Promise<{ problems: BookingProblemDto[]; warnings: BookingProblemDto[] }> {
    const attached = await this.windows(db, tournamentId);
    const problems: BookingProblemDto[] = [];
    const warnings: BookingProblemDto[] = [];
    const fmt = (ms: number) => new Date(ms).toISOString();
    for (const s of slots) {
      const mine = attached.filter((a) => a.pitchId === s.pitchId);
      const inside = (a: AttachedWindow) => a.start <= s.start && s.end <= a.end;
      const base = { fixtureId: s.fixtureId, pitchId: s.pitchId };
      if (mine.length > 0) {
        if (mine.some((a) => a.effective === 'CONFIRMED' && inside(a))) continue;
        const pending = mine.find((a) => a.effective === 'PENDING' && inside(a));
        const lost = mine.find((a) => a.effective === 'LOST' && inside(a));
        if (pending) {
          problems.push({
            ...base,
            code: 'WINDOW_UNCONFIRMED',
            bookingId: pending.bookingId,
            message: 'The booking that covers this match is not confirmed yet',
          });
        } else if (lost) {
          problems.push({
            ...base,
            code: 'WINDOW_LOST',
            bookingId: lost.bookingId,
            message: 'The booking that covered this match was cancelled, rejected or expired',
          });
        } else {
          problems.push({
            ...base,
            code: 'OUTSIDE_BOOKED_WINDOW',
            message: `The match (${fmt(s.start)} - ${fmt(s.end)}) is outside every booked window of this pitch`,
          });
        }
        continue;
      }
      const busy = await this.bookings.foreignOccupancy(
        db,
        s.pitchId,
        new Date(s.start),
        new Date(s.end),
      );
      if (busy.length > 0) {
        problems.push({
          ...base,
          code: 'RESOURCE_UNAVAILABLE',
          message: 'Another booking or calendar block occupies this pitch at that time',
        });
      } else {
        warnings.push({
          ...base,
          code: 'UNBOOKED',
          message: 'The pitch is free but no booking is attached for this time',
        });
      }
    }
    return { problems, warnings };
  }

  /** Locks the pitches against concurrent booking creation for the rest of the transaction. */
  async lockPitches(
    tx: Parameters<BookingsService['lockPitchesExclusive']>[0],
    pitchIds: string[],
  ): Promise<void> {
    await this.bookings.lockPitchesExclusive(tx, pitchIds);
  }
}
