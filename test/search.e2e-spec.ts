import { createTestApp, type TestApp } from './support/app';
import { createUser, uniq } from './support/factories';
import {
  addMember,
  block,
  makeClub,
  makePitch,
  makeTournament,
  makeVenue,
  setPrivate,
} from './social-helpers';

interface Result {
  entityType: string;
  id: string;
  name: string | null;
  handle: string | null;
}
interface Section {
  type: string;
  entityType: string;
  items: Result[];
  total: number;
}

describe('search (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const search = async (
    viewer: { auth: { Authorization: string } } | null,
    qs: string,
  ): Promise<{
    sections: Section[] | null;
    items: Result[] | null;
    nextCursor: string | null;
    total: number | null;
  }> => {
    const req = t.http().get(`/v1/search?${qs}`);
    if (viewer) req.set(viewer.auth);
    const res = await req.expect(200);
    return res.body;
  };
  const tok = () => `zq${uniq(8)}`;

  it('same nickname for different people is normal: distinct ids, explicit entityType, handle', async () => {
    const token = tok();
    const viewer = await createUser(t);
    const people = await Promise.all([1, 2, 3].map(() => createUser(t, { nickname: `${token}` })));
    const res = await search(viewer, `q=${token}&type=people`);
    expect(res.total).toBe(3);
    expect(new Set(res.items?.map((i) => i.id))).toEqual(new Set(people.map((p) => p.userId)));
    expect(res.items?.every((i) => i.entityType === 'PERSON' && i.name === token && i.handle)).toBe(
      true,
    );
    // visitors can search too
    expect((await search(null, `q=${token}&type=people`)).total).toBe(3);
  });

  it('ranking: exact @username, then nickname prefix (case-insensitive), then contains / trigram', async () => {
    const token = tok();
    const viewer = await createUser(t);
    const exact = await createUser(t, { nickname: `Someone ${uniq(4)}` });
    // rename so the exact username is unique to this test
    const handle = `${token}x`;
    await t.http().patch('/v1/me/profile').set(exact.auth).send({ username: handle }).expect(200);
    const nickEqualsHandle = await createUser(t, { nickname: handle.toUpperCase() });
    const prefix = await createUser(t, { nickname: `${handle}zzz` });
    const contains = await createUser(t, { nickname: `abc ${handle}` });
    const typo = await createUser(t, { nickname: `${handle.slice(0, -1)}q` });

    const res = await search(viewer, `q=${handle}&type=people`);
    const order = (res.items ?? []).map((i) => i.id);
    expect(order[0]).toBe(exact.userId);
    expect(order[1]).toBe(nickEqualsHandle.userId);
    expect(order.indexOf(prefix.userId)).toBeGreaterThan(1);
    expect(order.indexOf(prefix.userId)).toBeLessThan(order.indexOf(contains.userId));
    expect(order).toContain(typo.userId);
    expect(order.indexOf(contains.userId)).toBeLessThan(order.indexOf(typo.userId));

    // @handle restricts to handles
    const at = await search(viewer, `q=${encodeURIComponent(`@${handle}`)}&type=people`);
    expect(at.items?.map((i) => i.id)).toEqual([exact.userId]);
    // upper-case query behaves the same
    const upper = await search(viewer, `q=${handle.toUpperCase()}&type=people`);
    expect(upper.items?.[0]?.id).toBe(exact.userId);
    // handle-only with no such handle
    expect((await search(viewer, `q=${encodeURIComponent('@wwwwwwwwww')}&type=people`)).total).toBe(
      0,
    );
  });

  it('excludes blocked (both ways), suspended/deleted users; private profiles are findable by identity only', async () => {
    const token = tok();
    const viewer = await createUser(t);
    const visible = await createUser(t, { nickname: `${token} ok` });
    const priv = await createUser(t, { nickname: `${token} private`, city: 'Secretville' });
    await setPrivate(t, priv);
    const blockedByMe = await createUser(t, { nickname: `${token} b1` });
    const blockedMe = await createUser(t, { nickname: `${token} b2` });
    const suspended = await createUser(t, { nickname: `${token} s` });
    const deleted = await createUser(t, { nickname: `${token} d` });
    await block(t, viewer, blockedByMe);
    await block(t, blockedMe, viewer);
    await t.prisma.user.update({ where: { id: suspended.userId }, data: { status: 'SUSPENDED' } });
    await t.prisma.user.update({ where: { id: deleted.userId }, data: { status: 'DELETED' } });

    const res = await search(viewer, `q=${token}&type=people`);
    const got = new Set(res.items?.map((i) => i.id));
    expect(got).toEqual(new Set([visible.userId, priv.userId]));
    expect(res.total).toBe(2);
    expect(JSON.stringify(res)).not.toMatch(/Secretville|dateOfBirth|@example/);
    // the blocked one does not find the viewer either
    const other = await search(blockedMe, `q=${token}&type=people`);
    expect(other.items?.map((i) => i.id)).not.toContain(viewer.userId);
  });

  it('overview: ≤ 4 per type with true totals; typed search is keyset paginated', async () => {
    const token = tok();
    const viewer = await createUser(t);
    const owner = await createUser(t);
    for (let i = 0; i < 6; i++) await makeClub(t, owner, { name: `${token} club ${i}` });
    for (let i = 0; i < 2; i++) await createUser(t, { nickname: `${token} person ${i}` });
    const venue = await makeVenue(t, owner, { name: `${token} arena` });
    await makePitch(t, venue.id, { name: `${token} pitch` });
    await makeTournament(t, owner, { name: `${token} cup` });

    const res = await search(viewer, `q=${token}`);
    const by = Object.fromEntries((res.sections ?? []).map((s) => [s.type, s]));
    expect(Object.keys(by).sort()).toEqual([
      'clubs',
      'events',
      'people',
      'pitches',
      'tournaments',
      'venues',
    ]);
    expect(by.clubs?.items).toHaveLength(4);
    expect(by.clubs?.total).toBe(6);
    expect(by.people?.total).toBe(2);
    expect(by.venues?.total).toBe(1);
    expect(by.pitches?.total).toBe(1);
    expect(by.tournaments?.total).toBe(1);
    expect(by.events?.total).toBe(0);
    expect(by.clubs?.items.every((i) => i.entityType === 'CLUB' && i.handle)).toBe(true);
    expect(by.venues?.items[0]?.entityType).toBe('VENUE');

    const p1 = await search(viewer, `q=${token}&type=clubs&limit=4`);
    expect(p1.items).toHaveLength(4);
    expect(p1.total).toBe(6);
    const p2 = await search(viewer, `q=${token}&type=clubs&limit=4&cursor=${p1.nextCursor}`);
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    const all = [...(p1.items ?? []), ...(p2.items ?? [])].map((i) => i.id);
    expect(new Set(all).size).toBe(6);
  });

  it('hidden venues / pitches / tournaments / events never show up', async () => {
    const token = tok();
    const viewer = await createUser(t);
    const owner = await createUser(t);
    const member = await createUser(t);
    const draftVenue = await makeVenue(t, owner, { name: `${token} draftvenue`, status: 'DRAFT' });
    await makePitch(t, draftVenue.id, { name: `${token} pitchofdraft` });
    const goodVenue = await makeVenue(t, owner, { name: `${token} goodvenue` });
    await makePitch(t, goodVenue.id, { name: `${token} draftpitch`, status: 'DRAFT' });
    await makeTournament(t, owner, { name: `${token} draftcup`, status: 'DRAFT' });
    await makeTournament(t, owner, { name: `${token} privatecup`, isPublic: false });
    const club = await makeClub(t, owner, { visibility: 'PRIVATE' });
    await addMember(t, club.id, member);
    const mk = (
      title: string,
      clubId: string | null,
      status: 'PUBLISHED' | 'DRAFT' = 'PUBLISHED',
    ) =>
      t.prisma.event.create({
        data: {
          kind: 'CASUAL',
          status,
          organiserId: owner.userId,
          clubId,
          title,
          timezone: 'Asia/Tbilisi',
          startsAt: new Date(Date.now() + 86_400_000),
          endsAt: new Date(Date.now() + 90_000_000),
          formatPlayers: 5,
          capacity: 10,
        },
      });
    const open = await mk(`${token} open game`, null);
    const clubEvent = await mk(`${token} club game`, club.id);
    await mk(`${token} draft game`, null, 'DRAFT');

    const res = await search(viewer, `q=${token}`);
    const by = Object.fromEntries((res.sections ?? []).map((s) => [s.type, s]));
    expect(by.venues?.items.map((i) => i.name)).toEqual([`${token} goodvenue`]);
    expect(by.pitches?.total).toBe(0);
    expect(by.tournaments?.total).toBe(0);
    expect(by.events?.items.map((i) => i.id)).toEqual([open.id]);
    const asMember = await search(member, `q=${token}&type=events`);
    expect(new Set(asMember.items?.map((i) => i.id))).toEqual(new Set([open.id, clubEvent.id]));
    // organiser blocked → their events vanish for the blocked side
    await block(t, viewer, owner);
    expect((await search(viewer, `q=${token}&type=events`)).total).toBe(0);
  });

  it('validation and injection safety', async () => {
    const viewer = await createUser(t);
    await t.http().get('/v1/search').set(viewer.auth).expect(400);
    await t.http().get('/v1/search?q=').set(viewer.auth).expect(400);
    await t.http().get('/v1/search?q=%20%20').set(viewer.auth).expect(400);
    await t.http().get('/v1/search?q=@').set(viewer.auth).expect(400);
    await t.http().get('/v1/search?q=x&type=animals').set(viewer.auth).expect(400);
    await t
      .http()
      .get(`/v1/search?q=${'a'.repeat(81)}`)
      .set(viewer.auth)
      .expect(400);
    await t.http().get('/v1/search?q=x&type=people&cursor=garbage').set(viewer.auth).expect(400);
    const inj = await search(
      viewer,
      `q=${encodeURIComponent(`'; DROP TABLE "User"; --`)}&type=people`,
    );
    expect(inj.total).toBe(0);
    // LIKE wildcards are literals
    expect((await search(viewer, 'q=%25&type=clubs')).total).toBe(0);
    expect((await search(viewer, 'q=_&type=clubs')).total).toBe(0);
    expect(await t.prisma.user.count()).toBeGreaterThan(0);
  });
});
