import { createTestApp, type TestApp } from './support/app';
import { createUser } from './support/factories';
import {
  addMember,
  block,
  makeClub,
  makeFollow,
  makePitch,
  makeTournament,
  makeVenue,
  publishPost,
  setPrivate,
  uploadPhoto,
} from './social-helpers';

interface FeedItem {
  kind: 'POST' | 'ENTITY';
  post: { id: string } | null;
  entity: { id: string; entityType: string } | null;
  reasons: string[];
}

describe('discovery feeds (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const feed = async (u: { auth: { Authorization: string } }, path: string) => {
    const res = await t.http().get(path).set(u.auth).expect(200);
    return res.body as { items: FeedItem[]; nextCursor: string | null; caughtUp: boolean };
  };
  const ids = (f: { items: FeedItem[] }) => f.items.flatMap((i) => (i.post ? [i.post.id] : []));

  it('for-you shows only posts the viewer may see (private / followers / only-me / blocked / deleted / club variants)', async () => {
    const viewer = await createUser(t, { city: 'Feedville' });
    const author = await createUser(t, { city: 'Feedville' });
    const privateAuthor = await createUser(t);
    const blockedAuthor = await createUser(t);
    const clubOwner = await createUser(t);
    await setPrivate(t, privateAuthor);
    await block(t, viewer, blockedAuthor);
    const club = await makeClub(t, clubOwner);

    const pub = await publishPost(t, author, { text: 'public one' });
    const fol = await publishPost(t, author, { audience: 'FOLLOWERS' });
    const onlyMe = await publishPost(t, author, { audience: 'ONLY_ME' });
    const deleted = await publishPost(t, author);
    await t.http().delete(`/v1/posts/${deleted.id}`).set(author.auth).expect(204);
    const draft = await publishPost(t, author, { publish: false });
    const priv = await publishPost(t, privateAuthor, { audience: 'PUBLIC' });
    const blockedPost = await publishPost(t, blockedAuthor);
    const clubPublic = await t
      .http()
      .post('/v1/posts')
      .set(clubOwner.auth)
      .send({ authorType: 'CLUB', authorEntityId: club.id, text: 'club public' })
      .expect(201);
    const clubMembers = await t
      .http()
      .post('/v1/posts')
      .set(clubOwner.auth)
      .send({
        authorType: 'CLUB',
        authorEntityId: club.id,
        text: 'club members',
        audience: 'CLUB_MEMBERS',
      })
      .expect(201);

    let f = await feed(viewer, '/v1/discovery/for-you?limit=100');
    let seen = new Set(ids(f));
    expect(seen.has(pub.id)).toBe(true);
    expect(seen.has(clubPublic.body.id)).toBe(true);
    for (const hidden of [
      fol.id,
      onlyMe.id,
      deleted.id,
      draft.id,
      priv.id,
      blockedPost.id,
      clubMembers.body.id,
    ]) {
      expect(seen.has(hidden)).toBe(false);
    }
    // explainable reasons, no scores
    const item = f.items.find((i) => i.post?.id === pub.id) as FeedItem;
    expect(item.reasons).toContain('SAME_CITY');
    expect(item.reasons).toContain('RECENT');
    expect(JSON.stringify(f)).not.toMatch(/score|rank/i);

    // relationships open the matching posts
    await makeFollow(t, viewer, 'USER', author.userId);
    await makeFollow(t, viewer, 'USER', privateAuthor.userId);
    await addMember(t, club.id, viewer);
    f = await feed(viewer, '/v1/discovery/for-you?limit=100');
    seen = new Set(ids(f));
    for (const visible of [fol.id, priv.id, clubMembers.body.id])
      expect(seen.has(visible)).toBe(true);
    for (const hidden of [onlyMe.id, deleted.id, draft.id, blockedPost.id])
      expect(seen.has(hidden)).toBe(false);
    const own = await publishPost(t, viewer);
    expect(ids(await feed(viewer, '/v1/discovery/for-you?limit=100'))).not.toContain(own.id);
  });

  it('following feed = posts of followed users/clubs/venues/tournaments only, newest first, then caught up', async () => {
    const viewer = await createUser(t);
    const followed = await createUser(t);
    const stranger = await createUser(t);
    const owner = await createUser(t);
    const club = await makeClub(t, owner);
    const tour = await makeTournament(t, owner);
    await makeFollow(t, viewer, 'USER', followed.userId);
    await makeFollow(t, viewer, 'CLUB', club.id);
    await makeFollow(t, viewer, 'TOURNAMENT', tour.id);

    const empty = await feed(viewer, '/v1/discovery/following');
    expect(empty.items).toEqual([]);

    const a = await publishPost(t, followed);
    const nope = await publishPost(t, stranger);
    const c = await t
      .http()
      .post('/v1/posts')
      .set(owner.auth)
      .send({ authorType: 'CLUB', authorEntityId: club.id, text: 'club' })
      .expect(201);
    const tp = await t
      .http()
      .post('/v1/posts')
      .set(owner.auth)
      .send({ authorType: 'TOURNAMENT', authorEntityId: tour.id, text: 'tour' })
      .expect(201);
    // the organiser's own posts as a USER are not in the feed just because the tournament is followed
    const ownerPersonal = await publishPost(t, owner);

    const f = await feed(viewer, '/v1/discovery/following');
    expect(ids(f)).toEqual([tp.body.id, c.body.id, a.id]);
    expect(f.nextCursor).toBeNull();
    expect(f.caughtUp).toBe(true);
    expect(f.items.every((i) => i.reasons.includes('FOLLOWING'))).toBe(true);
    expect(ids(f)).not.toContain(nope.id);
    expect(ids(f)).not.toContain(ownerPersonal.id);

    // categories
    expect(ids(await feed(viewer, '/v1/discovery/following?category=clubs'))).toEqual([c.body.id]);
    expect(ids(await feed(viewer, '/v1/discovery/following?category=people'))).toEqual([a.id]);
    expect(ids(await feed(viewer, '/v1/discovery/following?category=tournaments'))).toEqual([
      tp.body.id,
    ]);
    expect(ids(await feed(viewer, '/v1/discovery/following?category=media'))).toEqual([]);
    const photo = await uploadPhoto(t, followed);
    const withMedia = await publishPost(t, followed, { mediaIds: [photo] });
    expect(ids(await feed(viewer, '/v1/discovery/following?category=media'))).toEqual([
      withMedia.id,
    ]);
    await t.http().get('/v1/discovery/following?category=nope').set(viewer.auth).expect(400);
    await t.http().get('/v1/discovery/following').expect(401);

    // blocking stops the author's posts, unfollowing too
    await block(t, followed, viewer);
    expect(ids(await feed(viewer, '/v1/discovery/following'))).toEqual([tp.body.id, c.body.id]);
  });

  it('keyset paging is stable while new posts are inserted', async () => {
    const viewer = await createUser(t);
    const author = await createUser(t);
    await makeFollow(t, viewer, 'USER', author.userId);
    const created: string[] = [];
    for (let i = 0; i < 7; i++) created.push((await publishPost(t, author, { text: `p${i}` })).id);
    const expected = [...created].reverse();

    const p1 = await feed(viewer, '/v1/discovery/following?limit=3');
    expect(ids(p1)).toEqual(expected.slice(0, 3));
    expect(p1.caughtUp).toBe(false);
    // new post + a deletion of an item that is already on page 1 + a private one arrive mid-paging
    const late = await publishPost(t, author, { text: 'late' });
    await publishPost(t, author, { text: 'hidden', audience: 'ONLY_ME' });
    await t.http().delete(`/v1/posts/${expected[0]}`).set(author.auth).expect(204);
    const p2 = await feed(viewer, `/v1/discovery/following?limit=3&cursor=${p1.nextCursor}`);
    expect(ids(p2)).toEqual(expected.slice(3, 6));
    const p3 = await feed(viewer, `/v1/discovery/following?limit=3&cursor=${p2.nextCursor}`);
    expect(ids(p3)).toEqual(expected.slice(6));
    expect(p3.nextCursor).toBeNull();
    expect(p3.caughtUp).toBe(true);
    const all = [...ids(p1), ...ids(p2), ...ids(p3)];
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(late.id);
    await t.http().get('/v1/discovery/following?cursor=abc').set(viewer.auth).expect(400);
  });

  it('for-you paging skips invisible posts without dropping visible ones', async () => {
    const viewer = await createUser(t);
    const author = await createUser(t);
    const visible: string[] = [];
    for (let i = 0; i < 4; i++) {
      visible.push((await publishPost(t, author, { text: `v${i}` })).id);
      for (let j = 0; j < 5; j++) await publishPost(t, author, { text: 'x', audience: 'ONLY_ME' });
    }
    const mine = new Set(visible);
    let cursor: string | null = null;
    const got: string[] = [];
    for (let i = 0; i < 100 && got.length < 4; i++) {
      const f: Awaited<ReturnType<typeof feed>> = await feed(
        viewer,
        `/v1/discovery/for-you?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      got.push(...ids(f).filter((id) => mine.has(id)));
      cursor = f.nextCursor;
      if (!cursor) break;
    }
    expect(got).toEqual([...visible].reverse());
  });

  it('entity categories recommend people/clubs/tournaments/pitches the viewer does not follow', async () => {
    const viewer = await createUser(t, { city: 'Recoville' });
    const other = await createUser(t);
    const followed = await createUser(t);
    const blocked = await createUser(t);
    const owner = await createUser(t);
    await makeFollow(t, viewer, 'USER', followed.userId);
    await block(t, viewer, blocked);
    const club = await makeClub(t, owner, { city: 'Recoville' });
    const followedClub = await makeClub(t, owner);
    await makeFollow(t, viewer, 'CLUB', followedClub.id);
    const tour = await makeTournament(t, owner);
    await makeTournament(t, owner, { status: 'DRAFT' });
    const venue = await makeVenue(t, owner, { city: 'Recoville' });
    const pitch = await makePitch(t, venue.id);
    const draftPitch = await makePitch(t, venue.id, { status: 'DRAFT' });

    const entityIds = (f: { items: FeedItem[] }) =>
      f.items.flatMap((i) => (i.entity ? [i.entity.id] : []));
    const people = await feed(viewer, '/v1/discovery/for-you?category=people&limit=100');
    expect(entityIds(people)).toContain(other.userId);
    for (const no of [viewer.userId, followed.userId, blocked.userId])
      expect(entityIds(people)).not.toContain(no);
    expect(people.items[0]?.entity?.entityType).toBe('PERSON');

    const clubs = await feed(viewer, '/v1/discovery/for-you?category=clubs&limit=100');
    expect(entityIds(clubs)).toContain(club.id);
    expect(entityIds(clubs)).not.toContain(followedClub.id);
    expect(clubs.items.find((i) => i.entity?.id === club.id)?.reasons).toEqual(['SAME_CITY']);

    expect(
      entityIds(await feed(viewer, '/v1/discovery/for-you?category=tournaments&limit=100')),
    ).toContain(tour.id);
    const pitches = entityIds(
      await feed(viewer, '/v1/discovery/for-you?category=pitches&limit=100'),
    );
    expect(pitches).toContain(pitch.id);
    expect(pitches).not.toContain(draftPitch.id);
    const paged = await feed(viewer, '/v1/discovery/for-you?category=clubs&limit=1');
    expect(paged.items).toHaveLength(1);
    expect(paged.nextCursor).not.toBeNull();
  });
});
