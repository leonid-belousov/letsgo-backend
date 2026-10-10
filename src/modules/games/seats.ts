import type { Event } from '@prisma/client';
import type { Db } from '../../common/transactions/tx';
import { AGE_BAND_MIN, ageOn } from '../../common/time/local-time';

export interface SeatSummary {
  capacity: number;
  confirmed: number;
  /** Seats reserved by priority invitations (active, unexpired holds) */
  holds: number;
  /** Seats reserved by open waitlist offers */
  offers: number;
  waitlisted: number;
  pending: number;
  /** Publicly available places = capacity − confirmed − active holds − active offers */
  free: number;
}

/**
 * Capacity arithmetic in one place (Handoff §3 / AC-05, AC-06):
 *   free = capacity − confirmed − active holds − active offers
 * Pending invitations, pending approvals and waitlisted players never consume a seat.
 */
export async function seatSummary(
  db: Db,
  event: Pick<Event, 'id' | 'capacity'>,
  now: Date,
): Promise<SeatSummary> {
  const [confirmed, holds, offers, waitlisted, pending] = await Promise.all([
    db.participation.count({ where: { eventId: event.id, status: 'CONFIRMED' } }),
    db.seatHold.count({ where: { eventId: event.id, releasedAt: null, expiresAt: { gt: now } } }),
    db.waitlistOffer.count({
      where: { eventId: event.id, status: 'OFFERED', expiresAt: { gt: now } },
    }),
    db.participation.count({ where: { eventId: event.id, status: 'WAITLISTED' } }),
    db.participation.count({ where: { eventId: event.id, status: 'PENDING_APPROVAL' } }),
  ]);
  return {
    capacity: event.capacity,
    confirmed,
    holds,
    offers,
    waitlisted,
    pending,
    free: Math.max(0, event.capacity - confirmed - holds - offers),
  };
}

export type AgeEligibility = 'ELIGIBLE' | 'EXCEPTION_REQUIRED' | 'NOT_ALLOWED' | 'UNKNOWN_DOB';

/** Age is evaluated at the event's start in the event's timezone (Handoff §13). */
export function ageEligibility(
  dateOfBirth: Date | null,
  event: Pick<Event, 'ageBand' | 'allowYounger' | 'startsAt' | 'timezone'>,
): AgeEligibility {
  const min = AGE_BAND_MIN[event.ageBand];
  if (min === 0) return 'ELIGIBLE';
  if (!dateOfBirth) return 'UNKNOWN_DOB';
  if (ageOn(dateOfBirth, event.startsAt, event.timezone) >= min) return 'ELIGIBLE';
  return event.allowYounger ? 'EXCEPTION_REQUIRED' : 'NOT_ALLOWED';
}

/** Per-team seats (players on the pitch + substitutes). */
export function teamCapacity(event: Pick<Event, 'formatPlayers' | 'substitutesPerTeam'>): number {
  return event.formatPlayers + event.substitutesPerTeam;
}
