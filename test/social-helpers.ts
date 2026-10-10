import type { GrantResourceType } from '@prisma/client';
import sharp from 'sharp';
import type { TestApp } from './support/app';
import { uniq, type TestUser } from './support/factories';

/** Clubs are created straight through prisma: the clubs module is built by another agent. */
export async function makeClub(
  t: TestApp,
  owner: TestUser,
  opts: { visibility?: 'PUBLIC' | 'PRIVATE'; city?: string; name?: string } = {},
): Promise<{ id: string; username: string; name: string }> {
  const s = uniq(10);
  const club = await t.prisma.club.create({
    data: {
      name: opts.name ?? `Club ${s}`,
      username: `club${s}`,
      city: opts.city ?? 'Testville',
      founderId: owner.userId,
      ownerId: owner.userId,
      visibility: opts.visibility ?? 'PUBLIC',
    },
  });
  return { id: club.id, username: club.username, name: club.name };
}

export async function grant(
  t: TestApp,
  grantee: TestUser,
  permission: string,
  resourceType: GrantResourceType,
  resourceId: string | null,
  grantedById: string,
): Promise<void> {
  await t.prisma.roleGrant.create({
    data: { granteeId: grantee.userId, permission, resourceType, resourceId, grantedById },
  });
}

export async function addMember(t: TestApp, clubId: string, user: TestUser): Promise<void> {
  await t.prisma.membership.create({
    data: { clubId, userId: user.userId, status: 'MEMBER', joinedAt: new Date() },
  });
}

export async function makeVenue(
  t: TestApp,
  creator: TestUser,
  opts: { status?: 'DRAFT' | 'PUBLISHED' | 'HIDDEN'; name?: string; city?: string } = {},
) {
  return t.prisma.venue.create({
    data: {
      name: opts.name ?? `Venue ${uniq(8)}`,
      kind: 'PAID',
      status: opts.status ?? 'PUBLISHED',
      city: opts.city ?? 'Testville',
      timezone: 'Asia/Tbilisi',
      createdById: creator.userId,
    },
  });
}

export async function makePitch(
  t: TestApp,
  venueId: string,
  opts: { status?: 'DRAFT' | 'PUBLISHED' | 'HIDDEN'; name?: string } = {},
) {
  return t.prisma.pitch.create({
    data: { venueId, name: opts.name ?? `Pitch ${uniq(8)}`, status: opts.status ?? 'PUBLISHED' },
  });
}

export async function makeTournament(
  t: TestApp,
  organiser: TestUser,
  opts: { status?: 'DRAFT' | 'REGISTRATION_OPEN'; isPublic?: boolean; name?: string } = {},
) {
  return t.prisma.tournament.create({
    data: {
      name: opts.name ?? `Cup ${uniq(8)}`,
      organiserId: organiser.userId,
      city: 'Testville',
      timezone: 'Asia/Tbilisi',
      duration: 'ONE_DAY',
      startsOn: new Date('2030-01-01'),
      formatPlayers: 5,
      status: opts.status ?? 'REGISTRATION_OPEN',
      isPublic: opts.isPublic ?? true,
    },
  });
}

export async function setPrivate(t: TestApp, user: TestUser): Promise<void> {
  await t
    .http()
    .patch('/v1/me/privacy')
    .set(user.auth)
    .send({ profileVisibility: 'PRIVATE' })
    .expect(200);
}

export async function block(t: TestApp, blocker: TestUser, blocked: TestUser): Promise<void> {
  await t.prisma.block.create({ data: { blockerId: blocker.userId, blockedId: blocked.userId } });
}

export async function makeFollow(
  t: TestApp,
  follower: TestUser,
  targetType: 'USER' | 'CLUB' | 'VENUE' | 'PITCH' | 'TOURNAMENT',
  targetId: string,
  status: 'ACCEPTED' | 'REQUESTED' = 'ACCEPTED',
): Promise<void> {
  await t.prisma.follow.create({
    data: { followerId: follower.userId, targetType, targetId, status },
  });
}

/** Minimal valid PNG header + padding. */
export function pngBytes(size = 64): Buffer {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
}

/** A real, decodable PNG. */
export async function realPng(width = 8, height = 8): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

/** intent → upload → finalize; returns the READY media id. */
export async function uploadPhoto(t: TestApp, user: TestUser): Promise<string> {
  const bytes = await realPng();
  const intent = await t
    .http()
    .post('/v1/media/uploads')
    .set(user.auth)
    .send({ kind: 'PHOTO', mimeType: 'image/png', sizeBytes: bytes.length })
    .expect(201);
  const id = (intent.body as { id: string }).id;
  await t
    .http()
    .put(`/v1/media/${id}/content`)
    .set(user.auth)
    .set('Content-Type', 'image/png')
    .send(bytes)
    .expect(200);
  await t.http().post(`/v1/media/${id}/finalize`).set(user.auth).send({}).expect(200);
  return id;
}

export interface PostBody {
  id: string;
  [k: string]: unknown;
}

export async function publishPost(
  t: TestApp,
  user: TestUser,
  body: Record<string, unknown> = {},
): Promise<PostBody> {
  const res = await t
    .http()
    .post('/v1/posts')
    .set(user.auth)
    .send({ text: `hello ${uniq(6)}`, ...body })
    .expect(201);
  return res.body as PostBody;
}
