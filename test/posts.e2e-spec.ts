import { createTestApp, type TestApp } from './support/app';
import { createUser, uniq } from './support/factories';
import {
  addMember,
  block,
  grant,
  makeClub,
  makeFollow,
  makeTournament,
  publishPost,
  setPrivate,
  uploadPhoto,
} from './social-helpers';

describe('posts (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('composer validation: empty, too long, too many media, media not READY / not mine', async () => {
    const u = await createUser(t);
    const other = await createUser(t);
    await t.http().post('/v1/posts').set(u.auth).send({}).expect(400);
    await t.http().post('/v1/posts').set(u.auth).send({ text: '   ' }).expect(400);
    await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ text: 'x'.repeat(2001) })
      .expect(400);
    const ids = Array.from({ length: 11 }, () => '018f0000-0000-7000-8000-000000000001').map(
      (_, i) => `018f0000-0000-7000-8000-0000000000${(10 + i).toString()}`,
    );
    await t.http().post('/v1/posts').set(u.auth).send({ text: 'x', mediaIds: ids }).expect(400);
    const ok = await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ text: 'x'.repeat(2000) })
      .expect(201);
    expect(ok.body.text).toHaveLength(2000);

    // not owned by me
    const foreign = await uploadPhoto(t, other);
    await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ text: 'x', mediaIds: [foreign] })
      .expect(400);
    // unfinished
    const c = await t
      .http()
      .post('/v1/media/uploads')
      .set(u.auth)
      .send({ kind: 'PHOTO', mimeType: 'image/png', sizeBytes: 100 })
      .expect(201);
    const res = await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ text: 'x', mediaIds: [c.body.id] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.invalid[0].reason).toContain('NOT_READY');
  });

  it('media only post keeps order; post DTO has ids/kinds, no URLs; capabilities', async () => {
    const u = await createUser(t);
    const a = await uploadPhoto(t, u);
    const b = await uploadPhoto(t, u);
    const p = await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ mediaIds: [b, a] })
      .expect(201);
    expect(p.body.media.map((m: { id: string }) => m.id)).toEqual([b, a]);
    expect(JSON.stringify(p.body)).not.toMatch(/http|storageKey|\/content/);
    expect(p.body.capabilities).toEqual({
      canEdit: true,
      canDelete: true,
      canComment: true,
      canLike: true,
      canReport: false,
      canManageComments: true,
      canSaveMedia: true,
    });
    const viewer = await createUser(t);
    const seen = await t.http().get(`/v1/posts/${p.body.id}`).set(viewer.auth).expect(200);
    expect(seen.body.capabilities.canEdit).toBe(false);
    expect(seen.body.capabilities.canReport).toBe(true);
    expect(seen.body.capabilities.canManageComments).toBe(false);
    const visitor = await t.http().get(`/v1/posts/${p.body.id}`).expect(200);
    expect(visitor.body.capabilities.canComment).toBe(false);
  });

  it('idempotent create/publish: retries never duplicate; different body with the same key conflicts', async () => {
    const u = await createUser(t);
    const key = `k-${uniq(10)}`;
    const body = { text: 'once' };
    const [r1, r2] = await Promise.all([
      t.http().post('/v1/posts').set(u.auth).set('Idempotency-Key', key).send(body),
      t.http().post('/v1/posts').set(u.auth).set('Idempotency-Key', key).send(body),
    ]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r1.body.id).toBe(r2.body.id);
    expect(await t.prisma.post.count({ where: { authorId: u.userId } })).toBe(1);
    await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .set('Idempotency-Key', key)
      .send({ text: 'other' })
      .expect(409);

    // draft → publish, twice
    const draft = await t
      .http()
      .post('/v1/posts')
      .set(u.auth)
      .send({ text: 'draft', publish: false })
      .expect(201);
    expect(draft.body.status).toBe('DRAFT');
    const viewer = await createUser(t);
    await t.http().get(`/v1/posts/${draft.body.id}`).set(viewer.auth).expect(404);
    const drafts = await t.http().get('/v1/posts/drafts').set(u.auth).expect(200);
    expect(drafts.body.items.map((p: { id: string }) => p.id)).toContain(draft.body.id);
    const pk = `pub-${uniq(10)}`;
    const p1 = await t
      .http()
      .post(`/v1/posts/${draft.body.id}/publish`)
      .set(u.auth)
      .set('Idempotency-Key', pk)
      .expect(200);
    const p2 = await t
      .http()
      .post(`/v1/posts/${draft.body.id}/publish`)
      .set(u.auth)
      .set('Idempotency-Key', pk)
      .expect(200);
    const p3 = await t.http().post(`/v1/posts/${draft.body.id}/publish`).set(u.auth).expect(200);
    expect(p1.body.status).toBe('PUBLISHED');
    expect(p2.body.publishedAt).toBe(p1.body.publishedAt);
    expect(p3.body.publishedAt).toBe(p1.body.publishedAt);
    await t.http().post(`/v1/posts/${draft.body.id}/publish`).set(viewer.auth).expect(403);
    // empty draft cannot be published
    const empty = await t.http().post('/v1/posts').set(u.auth).send({ publish: false }).expect(201);
    await t.http().post(`/v1/posts/${empty.body.id}/publish`).set(u.auth).expect(400);
  });

  it('edit with version → VERSION_CHANGED; only the author edits; delete is soft and idempotent', async () => {
    const u = await createUser(t);
    const v = await createUser(t);
    const p = await publishPost(t, u);
    await t
      .http()
      .patch(`/v1/posts/${p.id}`)
      .set(v.auth)
      .send({ version: 1, text: 'hack' })
      .expect(403);
    const e = await t
      .http()
      .patch(`/v1/posts/${p.id}`)
      .set(u.auth)
      .send({ version: 1, text: 'edited' })
      .expect(200);
    expect(e.body.text).toBe('edited');
    expect(e.body.version).toBe(2);
    const stale = await t
      .http()
      .patch(`/v1/posts/${p.id}`)
      .set(u.auth)
      .send({ version: 1, text: 'again' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CHANGED');
    expect(stale.body.error.details.currentVersion).toBe(2);
    // published post cannot be emptied
    await t
      .http()
      .patch(`/v1/posts/${p.id}`)
      .set(u.auth)
      .send({ version: 2, text: '' })
      .expect(400);

    await t.http().delete(`/v1/posts/${p.id}`).set(v.auth).expect(403);
    await t.http().delete(`/v1/posts/${p.id}`).set(u.auth).expect(204);
    await t.http().delete(`/v1/posts/${p.id}`).set(u.auth).expect(204);
    await t.http().get(`/v1/posts/${p.id}`).set(u.auth).expect(404);
    await t.http().get(`/v1/posts/${p.id}`).set(v.auth).expect(404);
    expect((await t.prisma.post.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('DELETED');
  });

  describe('audience', () => {
  it('private profile is capped to FOLLOWERS; visibility rules per audience', async () => {
      const author = await createUser(t);
      await setPrivate(t, author);
      const post = await t
        .http()
        .post('/v1/posts')
        .set(author.auth)
        .send({ text: 'hi', audience: 'PUBLIC' })
        .expect(201);
      expect(post.body.audience).toBe('FOLLOWERS');
      await t
        .http()
        .post('/v1/posts')
        .set(author.auth)
        .send({ text: 'hi', audience: 'CLUB_MEMBERS' })
        .expect(400);

      const stranger = await createUser(t);
      const follower = await createUser(t);
      const requester = await createUser(t);
      await makeFollow(t, follower, 'USER', author.userId, 'ACCEPTED');
      await makeFollow(t, requester, 'USER', author.userId, 'REQUESTED');
      await t.http().get(`/v1/posts/${post.body.id}`).expect(404);
      await t.http().get(`/v1/posts/${post.body.id}`).set(stranger.auth).expect(404);
      await t.http().get(`/v1/posts/${post.body.id}`).set(requester.auth).expect(404);
      await t.http().get(`/v1/posts/${post.body.id}`).set(follower.auth).expect(200);
      await t.http().get(`/v1/posts/${post.body.id}`).set(author.auth).expect(200);
    });

    it('a legacy PUBLIC post of a profile that later became private is followers-only; ONLY_ME and blocked', async () => {
      const author = await createUser(t);
      const pub = await publishPost(t, author, { audience: 'PUBLIC' });
      const me = await publishPost(t, author, { audience: 'ONLY_ME' });
      const viewer = await createUser(t);
      const blocked = await createUser(t);
      await t.http().get(`/v1/posts/${pub.id}`).expect(200);
      await t.http().get(`/v1/posts/${me.id}`).set(viewer.auth).expect(404);
      await t.http().get(`/v1/posts/${me.id}`).set(author.auth).expect(200);
      await setPrivate(t, author);
      await t.http().get(`/v1/posts/${pub.id}`).set(viewer.auth).expect(404);
      await t.http().get(`/v1/posts/${pub.id}`).expect(404);
      // switching back to PUBLIC never re-opens old posts (privacy module narrows them)
      await t
        .http()
        .patch('/v1/me/privacy')
        .set(author.auth)
        .send({ profileVisibility: 'PUBLIC' })
        .expect(200);
      await t.http().get(`/v1/posts/${pub.id}`).set(viewer.auth).expect(404);
      // a new public post is visible; blocked users never see it
      const fresh = await publishPost(t, author, { audience: 'PUBLIC' });
      await t.http().get(`/v1/posts/${fresh.id}`).set(blocked.auth).expect(200);
      await block(t, author, blocked);
      await t.http().get(`/v1/posts/${fresh.id}`).set(blocked.auth).expect(404);
      await t.http().get(`/v1/posts/${fresh.id}`).set(viewer.auth).expect(200);
    });

    it('club posts: publish permission, CLUB_MEMBERS audience, real editor stored', async () => {
      const owner = await createUser(t);
      const publisher = await createUser(t);
      const member = await createUser(t);
      const outsider = await createUser(t);
      const club = await makeClub(t, owner);
      await addMember(t, club.id, member);
      await grant(t, publisher, 'club.posts.publish', 'CLUB', club.id, owner.userId);

      // member without the permission is denied
      await t
        .http()
        .post('/v1/posts')
        .set(member.auth)
        .send({ authorType: 'CLUB', authorEntityId: club.id, text: 'x' })
        .expect(403);
      await t
        .http()
        .post('/v1/posts')
        .set(outsider.auth)
        .send({ authorType: 'CLUB', authorEntityId: club.id, text: 'x' })
        .expect(403);
      await t
        .http()
        .post('/v1/posts')
        .set(owner.auth)
        .send({ authorType: 'CLUB', text: 'x' })
        .expect(400);

      const p = await t
        .http()
        .post('/v1/posts')
        .set(publisher.auth)
        .send({
          authorType: 'CLUB',
          authorEntityId: club.id,
          text: 'members only',
          audience: 'CLUB_MEMBERS',
        })
        .expect(201);
      expect(p.body.author).toMatchObject({ type: 'CLUB', id: club.id, handle: club.username });
      const row = await t.prisma.post.findUniqueOrThrow({ where: { id: p.body.id } });
      expect(row.authorId).toBe(publisher.userId);
      expect(row.authorEntityId).toBe(club.id);

      await t.http().get(`/v1/posts/${p.body.id}`).set(member.auth).expect(200);
      await t.http().get(`/v1/posts/${p.body.id}`).set(owner.auth).expect(200);
      await t.http().get(`/v1/posts/${p.body.id}`).set(outsider.auth).expect(404);
      await t.http().get(`/v1/posts/${p.body.id}`).expect(404);
      // publisher can edit own; a member cannot; the owner (club.* implied) can delete
      expect(p.body.capabilities.canEdit).toBe(true);
      await t
        .http()
        .patch(`/v1/posts/${p.body.id}`)
        .set(member.auth)
        .send({ version: 1, text: 'x' })
        .expect(403);
      await t.http().delete(`/v1/posts/${p.body.id}`).set(owner.auth).expect(204);

      // permission revoked → publisher loses edit
      const p2 = await t
        .http()
        .post('/v1/posts')
        .set(publisher.auth)
        .send({ authorType: 'CLUB', authorEntityId: club.id, text: 'again' })
        .expect(201);
      await t.prisma.roleGrant.updateMany({
        where: { granteeId: publisher.userId },
        data: { revokedAt: new Date() },
      });
      await t
        .http()
        .patch(`/v1/posts/${p2.body.id}`)
        .set(publisher.auth)
        .send({ version: 1, text: 'x' })
        .expect(403);
    });

    it('tournament / venue authors need manage permission', async () => {
      const org = await createUser(t);
      const other = await createUser(t);
      const tour = await makeTournament(t, org);
      await t
        .http()
        .post('/v1/posts')
        .set(other.auth)
        .send({ authorType: 'TOURNAMENT', authorEntityId: tour.id, text: 'x' })
        .expect(403);
      const ok = await t
        .http()
        .post('/v1/posts')
        .set(org.auth)
        .send({ authorType: 'TOURNAMENT', authorEntityId: tour.id, text: 'Draw is out' })
        .expect(201);
      expect(ok.body.author.type).toBe('TOURNAMENT');
      await t.http().get(`/v1/posts/${ok.body.id}`).expect(200);
      const venue = await t.prisma.venue.create({
        data: {
          name: 'V',
          kind: 'PAID',
          city: 'C',
          timezone: 'Asia/Tbilisi',
          createdById: org.userId,
          status: 'PUBLISHED',
        },
      });
      await t
        .http()
        .post('/v1/posts')
        .set(org.auth)
        .send({ authorType: 'VENUE', authorEntityId: venue.id, text: 'x' })
        .expect(403);
      await grant(t, org, 'venue.manage', 'VENUE', venue.id, other.userId);
      await t
        .http()
        .post('/v1/posts')
        .set(org.auth)
        .send({ authorType: 'VENUE', authorEntityId: venue.id, text: 'x' })
        .expect(201);
    });
  });

  it('post media export capability follows the author privacy policy', async () => {
    const author = await createUser(t);
    const viewer = await createUser(t);
    const blockedMedia = await uploadPhoto(t, author);
    await t
      .http()
      .patch('/v1/me/privacy')
      .set(author.auth)
      .send({ externalMediaSharing: false })
      .expect(200);
    const blocked = await publishPost(t, author, {
      audience: 'PUBLIC',
      mediaIds: [blockedMedia],
    });
    const blockedView = await t
      .http()
      .get(`/v1/posts/${blocked.id}`)
      .set(viewer.auth)
      .expect(200);
    expect(blockedView.body.capabilities.canSaveMedia).toBe(false);

    const allowedMedia = await uploadPhoto(t, author);
    await t
      .http()
      .patch('/v1/me/privacy')
      .set(author.auth)
      .send({ externalMediaSharing: true })
      .expect(200);
    const allowed = await publishPost(t, author, {
      audience: 'PUBLIC',
      mediaIds: [allowedMedia],
    });
    const allowedView = await t
      .http()
      .get(`/v1/posts/${allowed.id}`)
      .set(viewer.auth)
      .expect(200);
    expect(allowedView.body.capabilities.canSaveMedia).toBe(true);
  });

  describe('comments and reactions', () => {
    it('comment, reply (one level), edit own, delete rules, closing', async () => {
      const author = await createUser(t);
      const a = await createUser(t);
      const b = await createUser(t);
      const post = await publishPost(t, author);
      const c1 = await t
        .http()
        .post(`/v1/posts/${post.id}/comments`)
        .set(a.auth)
        .send({ body: 'first' })
        .expect(201);
      const r1 = await t
        .http()
        .post(`/v1/posts/${post.id}/comments`)
        .set(b.auth)
        .send({ body: 'reply', parentId: c1.body.id })
        .expect(201);
      await t
        .http()
        .post(`/v1/posts/${post.id}/comments`)
        .set(a.auth)
        .send({ body: 'deep', parentId: r1.body.id })
        .expect(400);
      await t
        .http()
        .post(`/v1/posts/${post.id}/comments`)
        .set(a.auth)
        .send({ body: '' })
        .expect(400);
      await t.http().post(`/v1/posts/${post.id}/comments`).send({ body: 'anon' }).expect(401);

      const list = await t.http().get(`/v1/posts/${post.id}/comments`).expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].replyCount).toBe(1);
      const replies = await t
        .http()
        .get(`/v1/posts/${post.id}/comments?parentId=${c1.body.id}`)
        .expect(200);
      expect(replies.body.items[0].body).toBe('reply');

      await t
        .http()
        .patch(`/v1/comments/${c1.body.id}`)
        .set(b.auth)
        .send({ body: 'x' })
        .expect(403);
      const ed = await t
        .http()
        .patch(`/v1/comments/${c1.body.id}`)
        .set(a.auth)
        .send({ body: 'edited' })
        .expect(200);
      expect(ed.body.editedAt).not.toBeNull();
      // b cannot delete a's comment; post author can
      await t.http().delete(`/v1/comments/${c1.body.id}`).set(b.auth).expect(403);
      await t.http().delete(`/v1/comments/${c1.body.id}`).set(author.auth).expect(204);
      await t.http().delete(`/v1/comments/${c1.body.id}`).set(author.auth).expect(204);
      const after = await t.http().get(`/v1/posts/${post.id}`).expect(200);
      expect(after.body.counts.comments).toBe(0);

      // closing
      await t
        .http()
        .put(`/v1/posts/${post.id}/comments-closed`)
        .set(a.auth)
        .send({ closed: true })
        .expect(403);
      await t
        .http()
        .put(`/v1/posts/${post.id}/comments-closed`)
        .set(author.auth)
        .send({ closed: true })
        .expect(200);
      const closed = await t
        .http()
        .post(`/v1/posts/${post.id}/comments`)
        .set(a.auth)
        .send({ body: 'late' });
      expect(closed.status).toBe(403);
      expect(
        (await t.http().get(`/v1/posts/${post.id}`).set(a.auth)).body.capabilities.canComment,
      ).toBe(false);
      await t
        .http()
        .put(`/v1/posts/${post.id}/comments-closed`)
        .set(author.auth)
        .send({ closed: false })
        .expect(200);
      await t
        .http()
        .post(`/v1/posts/${post.id}/comments`)
        .set(a.auth)
        .send({ body: 'ok now' })
        .expect(201);
    });

    it('club moderators (club.posts.manage) remove any comment; notifications carry no text', async () => {
      const owner = await createUser(t);
      const mod = await createUser(t);
      const commenter = await createUser(t);
      const club = await makeClub(t, owner);
      await grant(t, mod, 'club.posts.manage', 'CLUB', club.id, owner.userId);
      const post = await t
        .http()
        .post('/v1/posts')
        .set(owner.auth)
        .send({ authorType: 'CLUB', authorEntityId: club.id, text: 'club news' })
        .expect(201);
      const c = await t
        .http()
        .post(`/v1/posts/${post.body.id}/comments`)
        .set(commenter.auth)
        .send({ body: 'secret words 12345' })
        .expect(201);
      const notes = await t.prisma.notification.findMany({
        where: { recipientId: owner.userId, objectId: post.body.id },
      });
      expect(notes.length).toBeGreaterThan(0);
      expect(JSON.stringify(notes)).not.toContain('secret words');
      const acts = await t.prisma.activityItem.findMany({
        where: { recipientId: owner.userId, objectId: post.body.id },
      });
      expect(JSON.stringify(acts)).not.toContain('secret words');
      await t.http().delete(`/v1/comments/${c.body.id}`).set(mod.auth).expect(204);
      // moderator flag reflected in capabilities
      expect(
        (await t.http().get(`/v1/posts/${post.body.id}`).set(mod.auth)).body.capabilities
          .canManageComments,
      ).toBe(true);
    });

    it('likes are idempotent, one per user, and need view access', async () => {
      const author = await createUser(t);
      const a = await createUser(t);
      const stranger = await createUser(t);
      const post = await publishPost(t, author);
      const l1 = await t.http().put(`/v1/posts/${post.id}/like`).set(a.auth).expect(200);
      const l2 = await t.http().put(`/v1/posts/${post.id}/like`).set(a.auth).expect(200);
      expect(l1.body).toEqual({ liked: true, likes: 1 });
      expect(l2.body).toEqual({ liked: true, likes: 1 });
      expect((await t.http().get(`/v1/posts/${post.id}`).set(a.auth)).body.viewer.liked).toBe(true);
      const un = await t.http().delete(`/v1/posts/${post.id}/like`).set(a.auth).expect(200);
      expect(un.body).toEqual({ liked: false, likes: 0 });
      await t.http().delete(`/v1/posts/${post.id}/like`).set(a.auth).expect(200);

      const priv = await publishPost(t, author, { audience: 'ONLY_ME' });
      await t.http().put(`/v1/posts/${priv.id}/like`).set(stranger.auth).expect(404);
      await t
        .http()
        .post(`/v1/posts/${priv.id}/comments`)
        .set(stranger.auth)
        .send({ body: 'x' })
        .expect(404);
      await t.http().get(`/v1/posts/${priv.id}/comments`).set(stranger.auth).expect(404);
    });
  });

  describe('mentions and tag requests', () => {
    it('mentionPolicy is honoured, self/duplicates dropped, review flow, no audience widening', async () => {
      const author = await createUser(t);
      const open = await createUser(t); // mentionPolicy EVERYONE, reviewTags false
      const reviewer = await createUser(t); // default: FOLLOWING + reviewTags -> follows author? no
      const closed = await createUser(t);
      await t
        .http()
        .patch('/v1/me/privacy')
        .set(open.auth)
        .send({ mentionPolicy: 'EVERYONE', reviewTags: false })
        .expect(200);
      await t
        .http()
        .patch('/v1/me/privacy')
        .set(reviewer.auth)
        .send({ mentionPolicy: 'EVERYONE', reviewTags: true })
        .expect(200);
      await t
        .http()
        .patch('/v1/me/privacy')
        .set(closed.auth)
        .send({ mentionPolicy: 'NOBODY' })
        .expect(200);

      const m = (id: string) => ({ targetType: 'USER', targetId: id });
      const post = await t
        .http()
        .post('/v1/posts')
        .set(author.auth)
        .send({
          text: 'with friends',
          audience: 'ONLY_ME',
          mentions: [
            m(open.userId),
            m(open.userId),
            m(reviewer.userId),
            m(closed.userId),
            m(author.userId),
          ],
        })
        .expect(201);
      const byTarget = Object.fromEntries(
        (post.body.mentions as { targetId: string; status: string }[]).map((x) => [
          x.targetId,
          x.status,
        ]),
      );
      expect(byTarget[open.userId]).toBe('SHOWN');
      expect(byTarget[reviewer.userId]).toBe('PENDING_REVIEW');
      expect(byTarget[closed.userId]).toBeUndefined();
      expect(byTarget[author.userId]).toBeUndefined();
      expect(await t.prisma.mention.count({ where: { postId: post.body.id } })).toBe(2);

      // ONLY_ME: a mention does not widen the audience, and nobody gets a notification
      await t.http().get(`/v1/posts/${post.body.id}`).set(open.auth).expect(404);
      expect(
        await t.prisma.notification.count({
          where: { recipientId: open.userId, objectId: post.body.id },
        }),
      ).toBe(0);

      // tag request exists for the reviewer, without a post preview (cannot view)
      const list = await t.http().get('/v1/tag-requests').set(reviewer.auth).expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].post).toBeNull();
      expect(list.body.items[0].postId).toBe(post.body.id);
      const tagId = list.body.items[0].id as string;
      await t
        .http()
        .post(`/v1/tag-requests/${tagId}/decision`)
        .set(author.auth)
        .send({ decision: 'SHOW' })
        .expect(404);

      // public post with review: pending mentions are not on the profile
      const pub = await t
        .http()
        .post('/v1/posts')
        .set(author.auth)
        .send({ text: 'public', mentions: [m(reviewer.userId), m(open.userId)] })
        .expect(201);
      const tagged0 = await t
        .http()
        .get(`/v1/posts/tagged?targetType=USER&targetId=${reviewer.userId}`)
        .expect(200);
      expect(tagged0.body.items).toHaveLength(0);
      const taggedOpen = await t
        .http()
        .get(`/v1/posts/tagged?targetType=USER&targetId=${open.userId}`)
        .expect(200);
      expect(taggedOpen.body.items.map((p: { id: string }) => p.id)).toContain(pub.body.id);
      // notification for a viewable recipient contains ids only
      const notes = await t.prisma.notification.findMany({
        where: { recipientId: reviewer.userId, objectId: pub.body.id },
      });
      expect(notes).toHaveLength(1);
      expect(JSON.stringify(notes)).not.toContain('public');

      const pending = await t.http().get('/v1/tag-requests').set(reviewer.auth).expect(200);
      const req = (pending.body.items as { id: string; postId: string; post: unknown }[]).find(
        (x) => x.postId === pub.body.id,
      );
      expect(req?.post).not.toBeNull();
      await t
        .http()
        .post(`/v1/tag-requests/${req?.id}/decision`)
        .set(reviewer.auth)
        .send({ decision: 'SHOW' })
        .expect(200);
      await t
        .http()
        .post(`/v1/tag-requests/${req?.id}/decision`)
        .set(reviewer.auth)
        .send({ decision: 'SHOW' })
        .expect(200); // idempotent
      const tagged1 = await t
        .http()
        .get(`/v1/posts/tagged?targetType=USER&targetId=${reviewer.userId}`)
        .expect(200);
      expect(tagged1.body.items.map((p: { id: string }) => p.id)).toContain(pub.body.id);
      await t
        .http()
        .post(`/v1/tag-requests/${req?.id}/decision`)
        .set(reviewer.auth)
        .send({ decision: 'HIDE' })
        .expect(200);
      const tagged2 = await t
        .http()
        .get(`/v1/posts/tagged?targetType=USER&targetId=${reviewer.userId}`)
        .expect(200);
      expect(tagged2.body.items).toHaveLength(0);
      // removing the tag never deletes the post
      await t
        .http()
        .post(`/v1/tag-requests/${req?.id}/decision`)
        .set(reviewer.auth)
        .send({ decision: 'REMOVE' })
        .expect(200);
      await t.http().get(`/v1/posts/${pub.body.id}`).expect(200);
      await t
        .http()
        .post(`/v1/tag-requests/${req?.id}/decision`)
        .set(reviewer.auth)
        .send({ decision: 'SHOW' })
        .expect(409);
      await t
        .http()
        .post('/v1/tag-requests/not-a-uuid/decision')
        .set(reviewer.auth)
        .send({ decision: 'nope' })
        .expect(400);
    });

    it('club mentions are reviewed by holders of club.mentions.moderate; author can drop a mention on edit', async () => {
      const author = await createUser(t);
      const owner = await createUser(t);
      const mod = await createUser(t);
      const nobody = await createUser(t);
      const club = await makeClub(t, owner);
      await grant(t, mod, 'club.mentions.moderate', 'CLUB', club.id, owner.userId);
      const post = await t
        .http()
        .post('/v1/posts')
        .set(author.auth)
        .send({ text: 'shout-out', mentions: [{ targetType: 'CLUB', targetId: club.id }] })
        .expect(201);
      expect(post.body.mentions[0]).toMatchObject({
        targetType: 'CLUB',
        status: 'PENDING_REVIEW',
        handle: club.username,
      });
      const forMod = await t.http().get('/v1/tag-requests').set(mod.auth).expect(200);
      expect(forMod.body.items).toHaveLength(1);
      expect((await t.http().get('/v1/tag-requests').set(owner.auth)).body.items).toHaveLength(1);
      expect((await t.http().get('/v1/tag-requests').set(nobody.auth)).body.items).toHaveLength(0);
      const id = forMod.body.items[0].id as string;
      await t
        .http()
        .post(`/v1/tag-requests/${id}/decision`)
        .set(nobody.auth)
        .send({ decision: 'SHOW' })
        .expect(404);
      await t
        .http()
        .post(`/v1/tag-requests/${id}/decision`)
        .set(mod.auth)
        .send({ decision: 'SHOW' })
        .expect(200);

      const edited = await t
        .http()
        .patch(`/v1/posts/${post.body.id}`)
        .set(author.auth)
        .send({ version: 1, mentions: [] })
        .expect(200);
      expect(edited.body.mentions).toHaveLength(0);
      expect(
        (await t.prisma.mention.findFirstOrThrow({ where: { postId: post.body.id } })).status,
      ).toBe('REMOVED');
      await t.http().get(`/v1/posts/${post.body.id}`).expect(200);
    });
  });

  it('a deleted post disappears everywhere', async () => {
    const author = await createUser(t);
    const fan = await createUser(t);
    const tagged = await createUser(t);
    await t
      .http()
      .patch('/v1/me/privacy')
      .set(tagged.auth)
      .send({ mentionPolicy: 'EVERYONE', reviewTags: false })
      .expect(200);
    await makeFollow(t, fan, 'USER', author.userId);
    const post = await publishPost(t, author, {
      mentions: [{ targetType: 'USER', targetId: tagged.userId }],
    });
    await t.http().put(`/v1/posts/${post.id}/save`).set(fan.auth).expect(200);
    const present = async () => {
      const [detail, byAuthor, tag, following, forYou, saved] = await Promise.all([
        t.http().get(`/v1/posts/${post.id}`).set(fan.auth),
        t.http().get(`/v1/posts?authorType=USER&authorEntityId=${author.userId}`).set(fan.auth),
        t.http().get(`/v1/posts/tagged?targetType=USER&targetId=${tagged.userId}`).set(fan.auth),
        t.http().get('/v1/discovery/following').set(fan.auth),
        t.http().get('/v1/discovery/for-you').set(fan.auth),
        t.http().get('/v1/me/saved-posts').set(fan.auth),
      ]);
      const has = (r: {
        body: { items?: { id?: string; postId?: string; post?: { id: string } | null }[] };
      }) =>
        (r.body.items ?? []).some(
          (i) => i.id === post.id || i.postId === post.id || i.post?.id === post.id,
        );
      return {
        detail: detail.status,
        byAuthor: has(byAuthor),
        tag: has(tag),
        following: has(following),
        forYou: has(forYou),
        saved: has(saved),
      };
    };
    expect(await present()).toEqual({
      detail: 200,
      byAuthor: true,
      tag: true,
      following: true,
      forYou: true,
      saved: true,
    });
    await t.http().delete(`/v1/posts/${post.id}`).set(author.auth).expect(204);
    expect(await present()).toEqual({
      detail: 404,
      byAuthor: false,
      tag: false,
      following: false,
      forYou: false,
      saved: false,
    });
    await t.http().put(`/v1/posts/${post.id}/like`).set(fan.auth).expect(404);
  });
});
