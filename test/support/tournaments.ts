import { randomUUID } from 'node:crypto';
import type { TestApp } from './app';
import { uniq, type TestUser } from './factories';
import { createClubRow, idemKey } from './games';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON response bodies in tests
export type Json = Record<string, any>;

export const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

export interface TournamentOpts extends Json {
  publish?: boolean;
}

/** Creates (and by default publishes) a tournament through the API. */
export async function createTournament(
  t: TestApp,
  organiser: TestUser,
  o: TournamentOpts = {},
): Promise<{ id: string; body: Json }> {
  const { publish, ...rest } = o;
  const res = await t
    .http()
    .post('/v1/tournaments')
    .set(organiser.auth)
    .set('Idempotency-Key', idemKey())
    .send({
      name: `Cup ${uniq(6)}`,
      city: 'Testville',
      timezone: 'Asia/Tbilisi',
      duration: 'ONE_DAY',
      startsOn: isoDay(30),
      formatPlayers: 5,
      ...rest,
    });
  if (res.status !== 201)
    throw new Error(`createTournament ${res.status} ${JSON.stringify(res.body)}`);
  const id = res.body.id as string;
  if (publish !== false) {
    const p = await t.http().post(`/v1/tournaments/${id}/publish`).set(organiser.auth).expect(200);
    return { id, body: p.body as Json };
  }
  return { id, body: res.body as Json };
}

/** READY media row owned by `owner` (media API is another module; the tournament only needs the row). */
export async function mediaRow(
  t: TestApp,
  owner: TestUser,
  kind: 'PHOTO' | 'VIDEO' | 'DOCUMENT' = 'PHOTO',
  status: 'READY' | 'UPLOADING' = 'READY',
): Promise<string> {
  const m = await t.prisma.mediaAsset.create({
    data: {
      ownerId: owner.userId,
      kind,
      status,
      mimeType: kind === 'DOCUMENT' ? 'application/pdf' : 'image/png',
      sizeBytes: 1000n,
      storageKey: `test/${randomUUID()}`,
      readyAt: status === 'READY' ? new Date() : null,
    },
  });
  return m.id;
}

export async function addMember(t: TestApp, clubId: string, user: TestUser): Promise<void> {
  await t.prisma.membership.create({
    data: { clubId, userId: user.userId, status: 'MEMBER', joinedAt: new Date() },
  });
}

/** Club-level grant written directly (grant logic itself belongs to the access module). */
export async function grantClub(
  t: TestApp,
  clubId: string,
  by: TestUser,
  to: TestUser,
  permission: string,
): Promise<void> {
  await t.prisma.roleGrant.create({
    data: {
      granteeId: to.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission,
      canPassOn: false,
      furtherDelegation: false,
      grantedById: by.userId,
    },
  });
}

export interface ClubWithOwner {
  owner: TestUser;
  clubId: string;
}

/** Applies with a club and returns the entry id. */
export async function applyWith(
  t: TestApp,
  tid: string,
  owner: TestUser,
  clubId: string,
): Promise<string> {
  const res = await t
    .http()
    .post(`/v1/tournaments/${tid}/entries`)
    .set(owner.auth)
    .set('Idempotency-Key', idemKey())
    .send({ clubId })
    .expect(200);
  return res.body.id as string;
}

export function decide(
  t: TestApp,
  tid: string,
  by: TestUser,
  entryId: string,
  decision: 'ACCEPT' | 'REJECT',
) {
  return t
    .http()
    .post(`/v1/tournaments/${tid}/entries/${entryId}/decision`)
    .set(by.auth)
    .set('Idempotency-Key', idemKey())
    .send({ decision });
}

export { createClubRow, idemKey };
