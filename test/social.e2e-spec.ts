import { createTestApp, type TestApp } from './support/app';
import { createUser } from './support/factories';
import {
  addMember,
  block,
  grant,
  makeClub,
  makePitch,
  makeTournament,
  makeVenue,
  publishPost,
  setPrivate,
} from './social-helpers';

describe('social: follow / favourites / saved (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const follow = (u: { auth: { Authorization: string } }, type: string, id: string) =>
    t.http().put(`/v1/follows/${type}/${id}`).set(u.auth);

  describe('follow states', () => {
    it('public user → ACCEPTED immediately; repeat follow is idempotent; unfollow', async () => {
      const a = await createUser(t);
      const b = await createUser(t);
      const r1 = await follow(a, 'USER', b.userId).expect(200);
      expect(r1.body.status).toBe('ACCEPTED');
      const r2 = await follow(a, 'USER', b.userId).expect(200);
      expect(r2.body.status).toBe('ACCEPTED');
      expect(await t.prisma.follow.count({ where: { followerId: a.userId } })).toBe(1);
      // concurrent double tap
      const c = await createUser(t);
      const both = await Promise.all([follow(a, 'USER', c.userId), follow(a, 'USER', c.userId)]);
      expect(both.map((r) => r.status)).toEqual([200, 200]);
      expect(
        await t.prisma.follow.count({ where: { followerId: a.userId, targetId: c.userId } }),
      ).toBe(1);

      const un = await t.http().delete(`/v1/follows/USER/${b.userId}`).set(a.auth).expect(200);
      expect(un.body.status).toBe('NONE');
      await t.http().delete(`/v1/follows/USER/${b.userId}`).set(a.auth).expect(200);
      expect((await t.http().get(`/v1/follows/USER/${b.userId}`).set(a.auth)).body.status).toBe(
        'NONE',
      );
      // validation
      await follow(a, 'USER', a.userId).expect(400);
      await follow(a, 'USER', '018f0000-0000-7000-8000-000000000001').expect(404);
      await t.http().put(`/v1/follows/BANANA/${b.userId}`).set(a.auth).expect(400);
      await t.http().put(`/v1/follows/USER/${b.userId}`).expect(401);
    });

    it('private user → REQUESTED; requester cancels; owner accepts / declines / removes', async () => {
      const owner = await createUser(t);
      await setPrivate(t, owner);
      const a = await createUser(t);
      const b = await createUser(t);
      const c = await createUser(t);

      expect((await follow(a, 'USER', owner.userId).expect(200)).body.status).toBe('REQUESTED');
      expect((await follow(a, 'USER', owner.userId).expect(200)).body.status).toBe('REQUESTED');
      await follow(b, 'USER', owner.userId).expect(200);
      await follow(c, 'USER', owner.userId).expect(200);

      // owner sees exactly the incoming requests
      const inbox = await t.http().get('/v1/follows/requests').set(owner.auth).expect(200);
      expect(inbox.body.items).toHaveLength(3);
      expect((await t.http().get('/v1/follows/requests').set(a.auth)).body.items).toHaveLength(0);

      // the requester cancels
      await t.http().delete(`/v1/follows/USER/${c.userId}`).set(c.auth).expect(200);
      await t.http().delete(`/v1/follows/USER/${owner.userId}`).set(c.auth).expect(200);
      expect((await t.http().get('/v1/follows/requests').set(owner.auth)).body.items).toHaveLength(
        2,
      );

      const req = (id: string) =>
        (inbox.body.items as { id: string; requester: { id: string } }[]).find(
          (i) => i.requester.id === id,
        )?.id;
      // strangers cannot decide
      await t
        .http()
        .post(`/v1/follows/requests/${req(a.userId)}/accept`)
        .set(b.auth)
        .expect(404);
      const acc = await t
        .http()
        .post(`/v1/follows/requests/${req(a.userId)}/accept`)
        .set(owner.auth)
        .expect(200);
      expect(acc.body.status).toBe('ACCEPTED');
      await t
        .http()
        .post(`/v1/follows/requests/${req(a.userId)}/accept`)
        .set(owner.auth)
        .expect(200); // idempotent
      expect((await t.http().get(`/v1/follows/USER/${owner.userId}`).set(a.auth)).body.status).toBe(
        'ACCEPTED',
      );
      // accepted follower sees followers-only posts
      const post = await publishPost(t, owner, { audience: 'FOLLOWERS' });
      await t.http().get(`/v1/posts/${post.id}`).set(a.auth).expect(200);
      await t.http().get(`/v1/posts/${post.id}`).set(b.auth).expect(404);

      await t
        .http()
        .post(`/v1/follows/requests/${req(b.userId)}/decline`)
        .set(owner.auth)
        .expect(200);
      expect((await t.http().get(`/v1/follows/USER/${owner.userId}`).set(b.auth)).body.status).toBe(
        'NONE',
      );
      // an accepted request can no longer be "declined"; the owner removes the follower instead
      await t
        .http()
        .post(`/v1/follows/requests/${req(a.userId)}/decline`)
        .set(owner.auth)
        .expect(409);
      await t.http().delete(`/v1/follows/followers/${a.userId}`).set(owner.auth).expect(204);
      await t.http().delete(`/v1/follows/followers/${a.userId}`).set(owner.auth).expect(204);
      await t.http().get(`/v1/posts/${post.id}`).set(a.auth).expect(404);
    });

    it('blocked pairs cannot follow (either direction) and the target looks unavailable', async () => {
      const a = await createUser(t);
      const b = await createUser(t);
      await block(t, b, a);
      await follow(a, 'USER', b.userId).expect(404);
      await follow(b, 'USER', a.userId).expect(404);
    });

    it('club: PUBLIC → ACCEPTED, PRIVATE → REQUESTED decided by club.members.approve holders; no membership is touched', async () => {
      const owner = await createUser(t);
      const approver = await createUser(t);
      const plain = await createUser(t);
      const fan = await createUser(t);
      const pub = await makeClub(t, owner);
      const priv = await makeClub(t, owner, { visibility: 'PRIVATE' });
      await grant(t, approver, 'club.members.approve', 'CLUB', priv.id, owner.userId);

      expect((await follow(fan, 'CLUB', pub.id).expect(200)).body.status).toBe('ACCEPTED');
      expect((await follow(fan, 'CLUB', priv.id).expect(200)).body.status).toBe('REQUESTED');
      expect(await t.prisma.membership.count({ where: { userId: fan.userId } })).toBe(0);

      await t.http().get(`/v1/follows/requests?clubId=${priv.id}`).set(plain.auth).expect(403);
      const inbox = await t
        .http()
        .get(`/v1/follows/requests?clubId=${priv.id}`)
        .set(approver.auth)
        .expect(200);
      expect(inbox.body.items).toHaveLength(1);
      expect(inbox.body.items[0].requester.id).toBe(fan.userId);
      await t
        .http()
        .post(`/v1/follows/requests/${inbox.body.items[0].id}/accept`)
        .set(plain.auth)
        .expect(403);
      await t
        .http()
        .post(`/v1/follows/requests/${inbox.body.items[0].id}/accept`)
        .set(approver.auth)
        .expect(200);
      expect((await t.http().get(`/v1/follows/CLUB/${priv.id}`).set(fan.auth)).body.status).toBe(
        'ACCEPTED',
      );
      // the owner notification exists for the request, and membership is still untouched
      expect(await t.prisma.membership.count({ where: { userId: fan.userId } })).toBe(0);
      await t
        .http()
        .delete(`/v1/follows/followers/${fan.userId}?clubId=${priv.id}`)
        .set(approver.auth)
        .expect(204);
      expect((await t.http().get(`/v1/follows/CLUB/${priv.id}`).set(fan.auth)).body.status).toBe(
        'NONE',
      );
    });

    it('venue / pitch / tournament: independent, and hidden ones are NOT_FOUND', async () => {
      const staff = await createUser(t);
      const fan = await createUser(t);
      const venue = await makeVenue(t, staff);
      const pitch = await makePitch(t, venue.id);
      const draftVenue = await makeVenue(t, staff, { status: 'DRAFT' });
      const tour = await makeTournament(t, staff);
      const hiddenTour = await makeTournament(t, staff, { status: 'DRAFT' });
      const privateTour = await makeTournament(t, staff, { isPublic: false });

      expect((await follow(fan, 'VENUE', venue.id).expect(200)).body.status).toBe('ACCEPTED');
      // following a venue is not following its pitches
      expect((await t.http().get(`/v1/follows/PITCH/${pitch.id}`).set(fan.auth)).body.status).toBe(
        'NONE',
      );
      expect((await follow(fan, 'PITCH', pitch.id).expect(200)).body.status).toBe('ACCEPTED');
      expect((await follow(fan, 'TOURNAMENT', tour.id).expect(200)).body.status).toBe('ACCEPTED');
      // following a tournament does not follow its organiser
      expect(
        (await t.http().get(`/v1/follows/USER/${staff.userId}`).set(fan.auth)).body.status,
      ).toBe('NONE');
      expect(await t.prisma.follow.count({ where: { followerId: fan.userId } })).toBe(3);

      await follow(fan, 'VENUE', draftVenue.id).expect(404);
      await follow(fan, 'TOURNAMENT', hiddenTour.id).expect(404);
      await follow(fan, 'TOURNAMENT', privateTour.id).expect(404);
      await follow(fan, 'PITCH', (await makePitch(t, draftVenue.id)).id).expect(404);
    });

    it('follow ≠ favourite ≠ join: each is independent', async () => {
      const owner = await createUser(t);
      const fan = await createUser(t);
      const club = await makeClub(t, owner);
      await follow(fan, 'CLUB', club.id).expect(200);
      expect(
        (await t.http().get(`/v1/favourites/CLUB/${club.id}`).set(fan.auth)).body.favourited,
      ).toBe(false);
      await t.http().put(`/v1/favourites/CLUB/${club.id}`).set(fan.auth).expect(200);
      await t.http().delete(`/v1/follows/CLUB/${club.id}`).set(fan.auth).expect(200);
      expect(
        (await t.http().get(`/v1/favourites/CLUB/${club.id}`).set(fan.auth)).body.favourited,
      ).toBe(true);
      await addMember(t, club.id, fan);
      await t.http().delete(`/v1/favourites/CLUB/${club.id}`).set(fan.auth).expect(200);
      await follow(fan, 'CLUB', club.id).expect(200);
      expect(
        await t.prisma.membership.count({
          where: { userId: fan.userId, clubId: club.id, status: 'MEMBER' },
        }),
      ).toBe(1);
      // favouriting never notifies the target
      const person = await createUser(t);
      const before = await t.prisma.notification.count({ where: { recipientId: person.userId } });
      await t.http().put(`/v1/favourites/USER/${person.userId}`).set(fan.auth).expect(200);
      expect(await t.prisma.notification.count({ where: { recipientId: person.userId } })).toBe(
        before,
      );
      expect(await t.prisma.activityItem.count({ where: { recipientId: person.userId } })).toBe(0);
    });
  });

  describe('lists and counters', () => {
    it('follower lists honour followListAudience; a hidden list hides the counters', async () => {
      const owner = await createUser(t);
      const f1 = await createUser(t);
      const f2 = await createUser(t);
      const stranger = await createUser(t);
      await follow(f1, 'USER', owner.userId).expect(200);
      await follow(f2, 'USER', owner.userId).expect(200);
      await follow(owner, 'USER', f1.userId).expect(200);

      // default followListAudience = FOLLOWERS
      const hiddenList = await t
        .http()
        .get(`/v1/users/${owner.userId}/followers`)
        .set(stranger.auth)
        .expect(200);
      expect(hiddenList.body).toEqual({ items: [], nextCursor: null, hidden: true });
      const hiddenCounts = await t
        .http()
        .get(`/v1/users/${owner.userId}/follow-counts`)
        .set(stranger.auth)
        .expect(200);
      expect(hiddenCounts.body).toEqual({ followers: null, following: null, hidden: true });
      expect(
        (await t.http().get(`/v1/follows/USER/${owner.userId}`).set(stranger.auth)).body
          .followersCount,
      ).toBeNull();

      const asFollower = await t
        .http()
        .get(`/v1/users/${owner.userId}/followers`)
        .set(f1.auth)
        .expect(200);
      expect(asFollower.body.hidden).toBe(false);
      expect(asFollower.body.items).toHaveLength(2);
      expect(JSON.stringify(asFollower.body)).not.toMatch(/email|dateOfBirth|@example/);
      const counts = await t
        .http()
        .get(`/v1/users/${owner.userId}/follow-counts`)
        .set(f1.auth)
        .expect(200);
      expect(counts.body).toEqual({ followers: 2, following: 1, hidden: false });
      const own = await t
        .http()
        .get(`/v1/users/${owner.userId}/follow-counts`)
        .set(owner.auth)
        .expect(200);
      expect(own.body.followers).toBe(2);

      const following = await t
        .http()
        .get(`/v1/users/${owner.userId}/following`)
        .set(f1.auth)
        .expect(200);
      expect(following.body.items[0]).toMatchObject({ targetType: 'USER', targetId: f1.userId });

      // open the list to everyone
      await t
        .http()
        .patch('/v1/me/privacy')
        .set(owner.auth)
        .send({ followListAudience: 'EVERYONE' })
        .expect(200);
      const open = await t
        .http()
        .get(`/v1/users/${owner.userId}/followers`)
        .set(stranger.auth)
        .expect(200);
      expect(open.body.items).toHaveLength(2);
      // paging
      const p1 = await t
        .http()
        .get(`/v1/users/${owner.userId}/followers?limit=1`)
        .set(stranger.auth)
        .expect(200);
      expect(p1.body.items).toHaveLength(1);
      const p2 = await t
        .http()
        .get(`/v1/users/${owner.userId}/followers?limit=1&cursor=${p1.body.nextCursor}`)
        .set(stranger.auth)
        .expect(200);
      expect(p2.body.items[0].user.id).not.toBe(p1.body.items[0].user.id);
      // blocked users are never listed for a viewer who blocked them
      await block(t, stranger, f1);
      const filtered = await t
        .http()
        .get(`/v1/users/${owner.userId}/followers`)
        .set(stranger.auth)
        .expect(200);
      expect(filtered.body.items.map((i: { user: { id: string } }) => i.user.id)).toEqual([
        f2.userId,
      ]);
    });
  });

  describe('favourites', () => {
    it('tabs, keyset paging, neutral unavailable entries that can be removed', async () => {
      const me = await createUser(t, { nickname: 'FavHost' });
      const staff = await createUser(t);
      const person = await createUser(t);
      const club = await makeClub(t, staff);
      const venue = await makeVenue(t, staff, { name: 'Secret Arena' });
      const pitch = await makePitch(t, venue.id);
      const tour = await makeTournament(t, staff, { name: 'Secret Cup' });
      const event = await t.prisma.event.create({
        data: {
          kind: 'CASUAL',
          status: 'PUBLISHED',
          organiserId: staff.userId,
          title: 'Kickabout',
          timezone: 'Asia/Tbilisi',
          startsAt: new Date(Date.now() + 86_400_000),
          endsAt: new Date(Date.now() + 90_000_000),
          formatPlayers: 5,
          capacity: 10,
        },
      });
      const draftEvent = await t.prisma.event.create({
        data: {
          kind: 'CASUAL',
          status: 'DRAFT',
          organiserId: staff.userId,
          title: 'Draft game',
          timezone: 'Asia/Tbilisi',
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          formatPlayers: 5,
          capacity: 10,
        },
      });
      const add = (type: string, id: string) =>
        t.http().put(`/v1/favourites/${type}/${id}`).set(me.auth);
      await add('USER', person.userId).expect(200);
      await add('CLUB', club.id).expect(200);
      await add('VENUE', venue.id).expect(200);
      await add('PITCH', pitch.id).expect(200);
      await add('TOURNAMENT', tour.id).expect(200);
      await add('EVENT', event.id).expect(200);
      await add('EVENT', event.id).expect(200); // idempotent
      await add('USER', me.userId).expect(400);
      await add('EVENT', draftEvent.id).expect(404);
      await add('CLUB', '018f0000-0000-7000-8000-000000000001').expect(404);

      const tab = async (name: string) => {
        const r = await t.http().get(`/v1/favourites?tab=${name}`).set(me.auth).expect(200);
        return (r.body.items as { targetType: string }[]).map((i) => i.targetType).sort();
      };
      expect(await tab('all')).toHaveLength(6);
      expect(await tab('people')).toEqual(['USER']);
      expect(await tab('clubs')).toEqual(['CLUB']);
      expect(await tab('events')).toEqual(['EVENT', 'TOURNAMENT']);
      expect(await tab('places')).toEqual(['PITCH', 'VENUE']);
      await t.http().get('/v1/favourites?tab=nope').set(me.auth).expect(400);

      const p1 = await t.http().get('/v1/favourites?limit=4').set(me.auth).expect(200);
      const p2 = await t
        .http()
        .get(`/v1/favourites?limit=4&cursor=${p1.body.nextCursor}`)
        .set(me.auth)
        .expect(200);
      expect(p1.body.items).toHaveLength(4);
      expect(p2.body.items).toHaveLength(2);
      expect(p2.body.nextCursor).toBeNull();

      // the venue is unpublished, the tournament hidden, the person suspended, the person blocks me
      await t.prisma.venue.update({ where: { id: venue.id }, data: { status: 'HIDDEN' } });
      await t.prisma.tournament.update({ where: { id: tour.id }, data: { status: 'DRAFT' } });
      await t.prisma.user.update({ where: { id: person.userId }, data: { status: 'SUSPENDED' } });
      const all = await t.http().get('/v1/favourites').set(me.auth).expect(200);
      const by = Object.fromEntries(
        (all.body.items as { targetType: string; unavailable: boolean; entity: unknown }[]).map(
          (i) => [i.targetType, i],
        ),
      );
      for (const type of ['VENUE', 'PITCH', 'TOURNAMENT', 'USER']) {
        expect(by[type]).toMatchObject({ unavailable: true, entity: null });
      }
      expect(by.CLUB?.unavailable).toBe(false);
      expect(by.EVENT?.unavailable).toBe(false);
      const leaked = JSON.stringify(all.body);
      expect(leaked).not.toMatch(/Secret Arena|Secret Cup|FavHost/);
      // unavailable entries can be removed
      await t.http().delete(`/v1/favourites/VENUE/${venue.id}`).set(me.auth).expect(200);
      await t.http().delete(`/v1/favourites/VENUE/${venue.id}`).set(me.auth).expect(200);
      expect(await tab('places')).toEqual(['PITCH']);
    });
  });

  describe('saved posts', () => {
    it('save / unsave / list; posts that became invisible are neutral, deleted ones vanish', async () => {
      const author = await createUser(t);
      const me = await createUser(t);
      const friend = await createUser(t);
      await t.prisma.follow.create({
        data: {
          followerId: me.userId,
          targetType: 'USER',
          targetId: author.userId,
          status: 'ACCEPTED',
        },
      });
      const visible = await publishPost(t, author, { audience: 'PUBLIC', text: 'open post' });
      const fol = await publishPost(t, author, {
        audience: 'FOLLOWERS',
        text: 'top secret followers text',
      });
      const gone = await publishPost(t, author, { text: 'will be deleted' });
      for (const p of [visible, fol, gone])
        await t.http().put(`/v1/posts/${p.id}/save`).set(me.auth).expect(200);
      await t.http().put(`/v1/posts/${visible.id}/save`).set(me.auth).expect(200);
      await t.http().put(`/v1/posts/${fol.id}/save`).set(friend.auth).expect(404);
      expect((await t.http().get(`/v1/posts/${visible.id}`).set(me.auth)).body.viewer.saved).toBe(
        true,
      );

      let list = await t.http().get('/v1/me/saved-posts').set(me.auth).expect(200);
      expect(list.body.items).toHaveLength(3);
      // stop following → followers-only post becomes neutral; author deletes another
      await t.http().delete(`/v1/follows/USER/${author.userId}`).set(me.auth).expect(200);
      await t.http().delete(`/v1/posts/${gone.id}`).set(author.auth).expect(204);
      list = await t.http().get('/v1/me/saved-posts').set(me.auth).expect(200);
      expect(list.body.items).toHaveLength(2);
      const neutral = list.body.items.find((i: { postId: string }) => i.postId === fol.id);
      expect(neutral).toMatchObject({ unavailable: true, post: null });
      expect(JSON.stringify(neutral)).not.toContain('top secret');
      // paging
      const p1 = await t.http().get('/v1/me/saved-posts?limit=1').set(me.auth).expect(200);
      expect(p1.body.nextCursor).not.toBeNull();
      // unsave (also for unavailable ones)
      await t.http().delete(`/v1/posts/${fol.id}/save`).set(me.auth).expect(200);
      await t.http().delete(`/v1/posts/${fol.id}/save`).set(me.auth).expect(200);
      expect((await t.http().get('/v1/me/saved-posts').set(me.auth)).body.items).toHaveLength(1);
    });
  });
});
