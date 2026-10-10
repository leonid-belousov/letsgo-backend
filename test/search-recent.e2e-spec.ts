import { createTestApp, type TestApp } from './support/app';
import { createUser, uniq } from './support/factories';
import { block, makeClub, makeTournament, makeVenue, setPrivate } from './social-helpers';

interface Recent {
  id: string;
  kind: 'QUERY' | 'ENTITY';
  query: string | null;
  entityType: string | null;
  entityId: string | null;
  unavailable: boolean;
  entity: { name: string | null; handle: string | null; subtitle: string | null } | null;
}

describe('recent searches (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const post = (u: { auth: { Authorization: string } }, body: Record<string, unknown>) =>
    t.http().post('/v1/search/recent').set(u.auth).send(body);
  const list = async (u: { auth: { Authorization: string } }): Promise<Recent[]> =>
    (await t.http().get('/v1/search/recent').set(u.auth).expect(200)).body.items as Recent[];

  it('requires login and validates the body', async () => {
    const u = await createUser(t);
    await t.http().post('/v1/search/recent').send({ query: 'abc' }).expect(401);
    await t.http().get('/v1/search/recent').expect(401);
    await post(u, {}).expect(400);
    await post(u, { query: 'a' }).expect(400);
    await post(u, { query: ' a ' }).expect(400);
    await post(u, { query: 'x'.repeat(81) }).expect(400);
    await post(u, { query: 'abc', entityType: 'CLUB', entityId: u.userId }).expect(400);
    await post(u, { entityType: 'CLUB' }).expect(400);
    await post(u, { entityType: 'ROBOT', entityId: u.userId }).expect(400);
    await post(u, { entityType: 'CLUB', entityId: 'nope' }).expect(400);
    await post(u, { query: 'ab' }).expect(200);
  });

  it('dedupes by lowercased trimmed query and bumps ordering (newest first)', async () => {
    const u = await createUser(t);
    const a = (await post(u, { query: '  Messi ' }).expect(200)).body as Recent;
    await post(u, { query: 'ronaldo' }).expect(200);
    const again = (await post(u, { query: 'MESSI' }).expect(200)).body as Recent;
    expect(again.id).toBe(a.id);
    expect(again.query).toBe('MESSI');
    const items = await list(u);
    expect(items.map((i) => i.query)).toEqual(['MESSI', 'ronaldo']);
    expect(items[0]).toMatchObject({ kind: 'QUERY', unavailable: false, entity: null });
    expect(await t.prisma.recentSearch.count({ where: { userId: u.userId } })).toBe(2);
  });

  it('keeps at most 20 per user, dropping the oldest', async () => {
    const u = await createUser(t);
    for (let i = 0; i < 23; i++)
      await post(u, { query: `query-${String(i).padStart(2, '0')}` }).expect(200);
    const items = await list(u);
    expect(items).toHaveLength(20);
    expect(items[0]?.query).toBe('query-22');
    expect(items[19]?.query).toBe('query-03');
    expect(await t.prisma.recentSearch.count({ where: { userId: u.userId } })).toBe(20);
    // re-using an old one keeps it and evicts the next oldest
    await post(u, { query: 'query-03' }).expect(200);
    await post(u, { query: 'brand-new' }).expect(200);
    const q = (await list(u)).map((i) => i.query);
    expect(q).toContain('query-03');
    expect(q).not.toContain('query-04');
  });

  it('concurrent duplicate POSTs produce one row', async () => {
    const u = await createUser(t);
    const res = await Promise.all(
      Array.from({ length: 8 }, () => post(u, { query: 'same thing' })),
    );
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(new Set(res.map((r) => (r.body as Recent).id)).size).toBe(1);
    expect(await t.prisma.recentSearch.count({ where: { userId: u.userId } })).toBe(1);
    const club = await makeClub(t, u);
    const res2 = await Promise.all(
      Array.from({ length: 6 }, () => post(u, { entityType: 'CLUB', entityId: club.id })),
    );
    expect(res2.every((r) => r.status === 200)).toBe(true);
    expect(
      await t.prisma.recentSearch.count({ where: { userId: u.userId, entityId: club.id } }),
    ).toBe(1);
  });

  it('entity entries are resolved with search visibility; the rest are recorded per type', async () => {
    const u = await createUser(t);
    const other = await createUser(t, { nickname: 'Visible Person' });
    const club = await makeClub(t, other, { name: 'Recent FC' });
    const venue = await makeVenue(t, other, { name: 'Recent Arena' });
    const tour = await makeTournament(t, other, { name: 'Recent Cup' });
    await post(u, { entityType: 'PERSON', entityId: other.userId }).expect(200);
    await post(u, { entityType: 'CLUB', entityId: club.id }).expect(200);
    await post(u, { entityType: 'VENUE', entityId: venue.id }).expect(200);
    await post(u, { entityType: 'TOURNAMENT', entityId: tour.id }).expect(200);
    const items = await list(u);
    expect(items.map((i) => i.entityType)).toEqual(['TOURNAMENT', 'VENUE', 'CLUB', 'PERSON']);
    expect(items.every((i) => !i.unavailable && i.entity?.name)).toBe(true);
    expect(items[3]?.entity).toMatchObject({ name: 'Visible Person', handle: other.username });
    // wrong type for an id, unknown or hidden targets are not recorded
    await post(u, { entityType: 'PERSON', entityId: club.id }).expect(404);
    await post(u, { entityType: 'CLUB', entityId: '018f0000-0000-7000-8000-000000000001' }).expect(
      404,
    );
    const draft = await makeVenue(t, other, { status: 'DRAFT' });
    await post(u, { entityType: 'VENUE', entityId: draft.id }).expect(404);
    expect(await list(u)).toHaveLength(4);
  });

  it('nothing leaks after the entity became inaccessible; unavailable entries can be removed', async () => {
    const u = await createUser(t);
    const priv = await createUser(t, { nickname: 'ToBeBlocked' });
    const susp = await createUser(t, { nickname: 'ToBeSuspended' });
    const gone = await createUser(t, { nickname: 'ToBeDeleted' });
    const shy = await createUser(t, { nickname: 'GoesPrivate', city: 'Hidetown' });
    const owner = await createUser(t);
    const venue = await makeVenue(t, owner, { name: 'ToBeHiddenArena' });
    const tour = await makeTournament(t, owner, { name: 'ToBeDraftedCup' });
    const club = await makeClub(t, owner, { name: 'StaysVisibleFC' });
    for (const [type, id] of [
      ['PERSON', priv.userId],
      ['PERSON', susp.userId],
      ['PERSON', gone.userId],
      ['PERSON', shy.userId],
      ['VENUE', venue.id],
      ['TOURNAMENT', tour.id],
      ['CLUB', club.id],
    ] as const) {
      await post(u, { entityType: type, entityId: id }).expect(200);
    }
    await block(t, priv, u);
    await t.prisma.user.update({ where: { id: susp.userId }, data: { status: 'SUSPENDED' } });
    await t.prisma.user.update({ where: { id: gone.userId }, data: { status: 'DELETED' } });
    await setPrivate(t, shy); // private profiles stay findable by identity
    await t.prisma.venue.update({ where: { id: venue.id }, data: { status: 'HIDDEN' } });
    await t.prisma.tournament.update({ where: { id: tour.id }, data: { status: 'DRAFT' } });

    const res = await t.http().get('/v1/search/recent').set(u.auth).expect(200);
    const items = res.body.items as Recent[];
    const by = (id: string) => items.find((i) => i.entityId === id) as Recent;
    for (const id of [priv.userId, susp.userId, gone.userId, venue.id, tour.id]) {
      expect(by(id)).toMatchObject({ unavailable: true, entity: null });
    }
    expect(by(club.id)).toMatchObject({ unavailable: false });
    expect(by(shy.userId).unavailable).toBe(false);
    const raw = JSON.stringify(items.filter((i) => i.unavailable));
    expect(raw).not.toMatch(
      /ToBeBlocked|ToBeSuspended|ToBeDeleted|ToBeHiddenArena|ToBeDraftedCup|Hidetown/,
    );
    expect(JSON.stringify(res.body)).not.toMatch(/Hidetown/);

    // remove one unavailable entry
    await t
      .http()
      .delete(`/v1/search/recent/${by(venue.id).id}`)
      .set(u.auth)
      .expect(204);
    expect((await list(u)).some((i) => i.entityId === venue.id)).toBe(false);
    // blocked entity cannot be re-recorded
    await post(u, { entityType: 'PERSON', entityId: priv.userId }).expect(404);
  });

  it('per-user only: another user cannot see or delete my entries; clear-all really deletes', async () => {
    const me = await createUser(t);
    const other = await createUser(t);
    const a = (await post(me, { query: `secret-${uniq(5)}` }).expect(200)).body as Recent;
    await post(other, { query: 'theirs' }).expect(200);
    expect((await list(other)).map((i) => i.query)).toEqual(['theirs']);
    await t.http().delete(`/v1/search/recent/${a.id}`).set(other.auth).expect(404);
    await t.http().delete('/v1/search/recent/not-a-uuid').set(me.auth).expect(400);
    expect(await list(me)).toHaveLength(1);
    await t.http().delete(`/v1/search/recent/${a.id}`).set(me.auth).expect(204);
    await t.http().delete(`/v1/search/recent/${a.id}`).set(me.auth).expect(404);

    await post(me, { query: 'one one' }).expect(200);
    await post(me, { query: 'two two' }).expect(200);
    await t.http().delete('/v1/search/recent').set(me.auth).expect(204);
    expect(await list(me)).toEqual([]);
    expect(await t.prisma.recentSearch.count({ where: { userId: me.userId } })).toBe(0);
    expect(await list(other)).toHaveLength(1);
    await t.http().delete('/v1/search/recent').set(me.auth).expect(204); // idempotent
  });
});
