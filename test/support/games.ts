/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers return raw JSON bodies */
import { randomUUID } from 'node:crypto';
import type { TestApp } from './app';
import { uniq, type TestUser } from './factories';

export const HOUR = 3_600_000;

/** Creates a club row directly (clubs API is a separate module); owner = founder = `owner`. */
export async function createClubRow(t: TestApp, owner: TestUser): Promise<string> {
  const s = uniq(8);
  const club = await t.prisma.club.create({
    data: {
      name: `Club ${s}`,
      username: `c${s}`,
      city: 'Testville',
      founderId: owner.userId,
      ownerId: owner.userId,
      preferredFormats: [],
      memberships: { create: { userId: owner.userId, status: 'MEMBER', joinedAt: new Date() } },
    },
  });
  return club.id;
}

export interface GameOpts {
  clubId?: string;
  pitchId?: string;
  hoursFromNow?: number;
  startsAt?: Date;
  formatPlayers?: number;
  teamCount?: number;
  substitutesPerTeam?: number;
  priceMinor?: number;
  joinMode?: 'AUTO_ACCEPT' | 'APPROVE_REQUESTS';
  waitlistEnabled?: boolean;
  ageBand?: 'NONE' | 'A35' | 'A40' | 'A45' | 'A50';
  allowYounger?: boolean;
  publish?: boolean;
  minConfirmed?: number;
  autoCancel?: { enabled: boolean; checkAt?: Date };
  now?: Date;
}

/** Creates a game through the API (default: published, 5v5×2 + 1 sub each = 12 places, GEL 15). */
export async function createGame(
  t: TestApp,
  organiser: TestUser,
  o: GameOpts = {},
): Promise<{ id: string; version: number; body: Record<string, any> }> {
  const base = o.now ?? new Date();
  const startsAt = o.startsAt ?? new Date(base.getTime() + (o.hoursFromNow ?? 72) * HOUR);
  const res = await t
    .http()
    .post('/v1/games')
    .set(organiser.auth)
    .send({
      kind: 'CASUAL',
      clubId: o.clubId,
      pitchId: o.pitchId,
      timezone: 'Asia/Tbilisi',
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 2 * HOUR).toISOString(),
      formatPlayers: o.formatPlayers ?? 5,
      teamCount: o.teamCount ?? 2,
      substitutesPerTeam: o.substitutesPerTeam ?? 1,
      priceMinor: o.priceMinor ?? 1500,
      joinMode: o.joinMode ?? 'AUTO_ACCEPT',
      waitlistEnabled: o.waitlistEnabled ?? true,
      ageBand: o.ageBand,
      allowYounger: o.allowYounger,
      minConfirmed: o.minConfirmed,
      autoCancel: o.autoCancel
        ? { enabled: o.autoCancel.enabled, checkAt: o.autoCancel.checkAt?.toISOString() }
        : undefined,
      publish: o.publish ?? true,
    });
  if (res.status !== 201)
    throw new Error(`createGame failed ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id as string, version: res.body.version as number, body: res.body };
}

/** Fills places with anonymous confirmed players (Participation has no FK to users). */
export async function fillSeats(t: TestApp, eventId: string, n: number): Promise<void> {
  await t.prisma.participation.createMany({
    data: Array.from({ length: n }, () => ({
      eventId,
      userId: randomUUID(),
      status: 'CONFIRMED' as const,
      source: 'ORGANISER_ADDED' as const,
      confirmedAt: new Date(),
    })),
  });
}

export const idemKey = (): string => `k-${uniq(16)}`;

/** Direct-row venue + pitch (the venues API is another module); coordinates optional. */
export async function createVenueRow(
  t: TestApp,
  owner: TestUser,
  coords?: { lat: number; lng: number },
): Promise<{ venueId: string; pitchId: string }> {
  const s = uniq(6);
  const venue = await t.prisma.venue.create({
    data: {
      name: `Venue ${s}`,
      kind: 'PAID',
      status: 'PUBLISHED',
      city: 'Testville',
      timezone: 'Asia/Tbilisi',
      latitude: coords?.lat,
      longitude: coords?.lng,
      createdById: owner.userId,
      publishedAt: new Date(),
      pitches: { create: { name: 'Pitch 1', status: 'PUBLISHED', formats: [], amenities: [] } },
    },
    include: { pitches: true },
  });
  return { venueId: venue.id, pitchId: (venue.pitches[0] as { id: string }).id };
}
