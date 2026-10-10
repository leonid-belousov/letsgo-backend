import type { TestApp } from './support/app';
import { createUser, uniq, type TestUser } from './support/factories';

/** A synthetic staff member holding one PLATFORM permission (inserted directly, no admin bypass). */
export async function makeStaff(t: TestApp, ...permissions: string[]): Promise<TestUser> {
  const u = await createUser(t);
  for (const permission of permissions) {
    await t.prisma.roleGrant.create({
      data: {
        granteeId: u.userId,
        resourceType: 'PLATFORM',
        resourceId: null,
        permission,
        grantedById: u.userId,
      },
    });
  }
  return u;
}

export async function grantVia(
  t: TestApp,
  granter: TestUser,
  grantee: TestUser,
  resourceType: 'VENUE' | 'PITCH' | 'CLUB',
  resourceId: string,
  permission: string,
  extra: Record<string, unknown> = {},
) {
  return t
    .http()
    .post('/v1/grants')
    .set(granter.auth)
    .send({ granteeId: grantee.userId, resourceType, resourceId, permission, ...extra });
}

/** Tbilisi has been UTC+4 without DST since 2005. */
export const TBILISI_OFFSET = '+04:00';

/** A local calendar date `n` days ahead (stable across the test run). */
export function futureDate(n: number): string {
  const d = new Date(Date.now() + n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** ISO instant for a Tbilisi wall-clock time; `dayOffset` moves past midnight. */
export function tb(date: string, hhmm: string, dayOffset = 0): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + dayOffset)).toISOString().slice(0, 10);
  return new Date(`${shifted}T${hhmm}:00${TBILISI_OFFSET}`).toISOString();
}

export const ALL_DAYS_HOURS = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [
    d,
    [{ open: '09:00', close: '01:00' }],
  ]),
);

export interface PitchFixture {
  admin: TestUser;
  venueId: string;
  pitchId: string;
  wholeId: string;
  partIds: string[];
  configs: Record<string, string>;
}

/**
 * A published paid venue with one published pitch (via the real API, staff = admin.catalog.manage).
 * Quarter layout: four parts, configurations "Half A/B" and "Q1".."Q4" plus the default "Whole pitch".
 */
export async function createPitch(
  t: TestApp,
  opts: {
    quarters?: boolean;
    hours?: unknown;
    allowHalfHourExtension?: boolean;
    price?: number;
    terms?: string;
    city?: string;
    admin?: TestUser;
  } = {},
): Promise<PitchFixture> {
  const admin = opts.admin ?? (await makeStaff(t, 'admin.catalog.manage'));
  const v = await t
    .http()
    .post('/v1/venues')
    .set(admin.auth)
    .send({ name: `Arena ${uniq(6)}`, city: opts.city ?? `City${uniq(6)}` });
  if (v.status !== 201) throw new Error(`venue: ${v.status} ${JSON.stringify(v.body)}`);
  const venueId = v.body.id as string;
  const p = await t
    .http()
    .post(`/v1/venues/${venueId}/pitches`)
    .set(admin.auth)
    .send({
      name: 'Pitch 1',
      surface: 'ARTIFICIAL',
      setting: 'OUTDOOR',
      formats: ['5v5', '7v7'],
      pricePerHourMinor: opts.price ?? 6000,
      ...(opts.quarters ? { partNames: ['Q1', 'Q2', 'Q3', 'Q4'] } : {}),
    });
  if (p.status !== 201) throw new Error(`pitch: ${p.status} ${JSON.stringify(p.body)}`);
  const pitchId = p.body.id as string;
  let pitch = p.body as {
    parts: { id: string; name: string }[];
    configurations: { id: string; name: string }[];
  };
  const configs: Record<string, string> = {};
  if (opts.quarters) {
    const q = pitch.parts.map((x) => x.id);
    const defs: Array<[string, string[]]> = [
      ['Half A', [q[0] as string, q[1] as string]],
      ['Half B', [q[2] as string, q[3] as string]],
      ['Q1', [q[0] as string]],
      ['Q2', [q[1] as string]],
      ['Q3', [q[2] as string]],
      ['Q4', [q[3] as string]],
    ];
    for (const [name, partIds] of defs) {
      const c = await t
        .http()
        .post(`/v1/pitches/${pitchId}/configurations`)
        .set(admin.auth)
        .send({ name, partIds });
      if (c.status !== 201) throw new Error(`config: ${c.status} ${JSON.stringify(c.body)}`);
      pitch = c.body;
    }
  }
  for (const c of pitch.configurations) configs[c.name] = c.id;
  const rules = await t
    .http()
    .put(`/v1/pitches/${pitchId}/booking-rules`)
    .set(admin.auth)
    .send({
      openingHours: opts.hours === undefined ? ALL_DAYS_HOURS : opts.hours,
      allowHalfHourExtension: opts.allowHalfHourExtension ?? false,
    });
  if (rules.status !== 200) throw new Error(`rules: ${rules.status} ${JSON.stringify(rules.body)}`);
  if (opts.terms) {
    await t
      .http()
      .post(`/v1/pitches/${pitchId}/terms`)
      .set(admin.auth)
      .send({ body: opts.terms })
      .expect(201);
  }
  await t.http().post(`/v1/venues/${venueId}/publish`).set(admin.auth).expect(200);
  await t.http().post(`/v1/pitches/${pitchId}/publish`).set(admin.auth).expect(200);
  return {
    admin,
    venueId,
    pitchId,
    wholeId: configs['Whole pitch'] as string,
    partIds: pitch.parts.map((x) => x.id),
    configs,
  };
}
