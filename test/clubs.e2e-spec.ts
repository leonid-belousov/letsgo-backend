import { createTestApp, type TestApp } from './support/app';
import { createUser, uniq, type TestUser } from './support/factories';
import { mediaRow } from './support/tournaments';

describe('clubs (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const handle = (): string => `c${uniq(10)}`;

  async function makeClub(
    owner: TestUser,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string; username: string }> {
    const username = handle();
    const res = await t
      .http()
      .post('/v1/clubs')
      .set(owner.auth)
      .send({ name: `Club ${username}`, username, city: 'Testville', ...extra });
    expect(res.status).toBe(201);
    return { id: (res.body as { id: string }).id, username };
  }

  const post = (u: TestUser, path: string, body: object = {}) =>
    t.http().post(path).set(u.auth).send(body);

  describe('create', () => {
    it('creator is founder, owner and member; nobody is enrolled in games', async () => {
      const owner = await createUser(t);
      const username = handle();
      const res = await post(owner, '/v1/clubs', {
        name: '  Клуб «Динамо»  ',
        username: username.toUpperCase(),
        city: 'Tbilisi',
        preferredFormats: ['5v5', '7v7'],
      }).expect(201);
      expect(res.body).toMatchObject({
        entityType: 'CLUB',
        name: 'Клуб «Динамо»',
        username,
        visibility: 'PUBLIC',
        joinMode: 'APPROVE_REQUESTS',
        founderId: owner.userId,
        ownerId: owner.userId,
        memberCount: 1,
        restricted: false,
        myMembership: { status: 'MEMBER', isOwner: true },
        capabilities: {
          canEdit: true,
          canInvite: true,
          canApprove: true,
          canManageRoles: true,
          canTransferOwnership: true,
          canArchive: true,
          canLeave: false,
          canJoin: false,
        },
      });
      const club = await t.prisma.club.findUniqueOrThrow({ where: { username } });
      expect(club.founderId).toBe(owner.userId);
      expect(await t.prisma.event.count({ where: { clubId: club.id } })).toBe(0);
    });

    it('validates name, username, formats and requires a completed profile', async () => {
      const owner = await createUser(t);
      const base = { name: 'Ok', username: handle(), city: 'X' };
      await post(owner, '/v1/clubs', { ...base, name: '   ' }).expect(400);
      await post(owner, '/v1/clubs', { ...base, name: 'x'.repeat(61) }).expect(400);
      await post(owner, '/v1/clubs', { ...base, username: '_bad' }).expect(400);
      await post(owner, '/v1/clubs', { ...base, username: 'ab' }).expect(400);
      await post(owner, '/v1/clubs', { ...base, city: '' }).expect(400);
      await post(owner, '/v1/clubs', { ...base, preferredFormats: ['4v4'] }).expect(400);
      await post(owner, '/v1/clubs', { ...base, joinMode: 'NOPE' }).expect(400);
      await post(owner, '/v1/clubs', { ...base, ownerId: owner.userId }).expect(400); // mass assignment
      const incomplete = await createUser(t, { complete: false });
      await post(incomplete, '/v1/clubs', base).expect(400);
      await t.http().post('/v1/clubs').send(base).expect(401);
    });

    it('double submit with the same Idempotency-Key creates exactly one club', async () => {
      const owner = await createUser(t);
      const username = handle();
      const key = `key-${uniq(12)}`;
      const send = () =>
        t
          .http()
          .post('/v1/clubs')
          .set(owner.auth)
          .set('Idempotency-Key', key)
          .send({ name: 'Once', username, city: 'X' });
      const [a, b] = await Promise.all([send(), send()]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect((a.body as { id: string }).id).toBe((b.body as { id: string }).id);
      expect(await t.prisma.club.count({ where: { username } })).toBe(1);
      // same key, different payload is refused
      const other = await t
        .http()
        .post('/v1/clubs')
        .set(owner.auth)
        .set('Idempotency-Key', key)
        .send({ name: 'Twice', username: handle(), city: 'X' });
      expect(other.status).toBe(409);
      expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('accepts own READY photo media for logo and cover, and preserves them across an idempotent retry', async () => {
      const owner = await createUser(t);
      const logoMediaId = await mediaRow(t, owner, 'PHOTO');
      const coverMediaId = await mediaRow(t, owner, 'PHOTO');
      const username = handle();
      const key = `media-${uniq(12)}`;
      const body = {
        name: 'Media club',
        username,
        city: 'Tbilisi',
        logoMediaId,
        coverMediaId,
      };

      const first = await t
        .http()
        .post('/v1/clubs')
        .set(owner.auth)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      const retry = await t
        .http()
        .post('/v1/clubs')
        .set(owner.auth)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect(retry.body.id).toBe(first.body.id);
      expect(first.body).toMatchObject({ logoMediaId, coverMediaId, version: 1 });
      expect((await t.http().get(`/v1/clubs/${first.body.id}`).set(owner.auth)).body).toMatchObject({
        logoMediaId,
        coverMediaId,
      });
    });

    it('username race without keys: exactly one 201, the loser gets CONFLICT on `username`', async () => {
      const users = await Promise.all([createUser(t), createUser(t), createUser(t)]);
      const username = handle();
      const results = await Promise.all(
        users.map((u) =>
          t.http().post('/v1/clubs').set(u.auth).send({ name: 'Racer', username, city: 'X' }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const losers = results.filter((r) => r.status !== 201);
      expect(losers).toHaveLength(2);
      for (const l of losers) {
        expect(l.status).toBe(409);
        expect(l.body.error).toMatchObject({
          code: 'CONFLICT',
          message: 'This username is taken.',
          details: { field: 'username' },
        });
      }
      expect(await t.prisma.club.count({ where: { username } })).toBe(1);
    });

    it('username availability is public and case-insensitive', async () => {
      const owner = await createUser(t);
      const { username } = await makeClub(owner);
      const taken = await t
        .http()
        .get(`/v1/clubs/username-available?username=${username.toUpperCase()}`)
        .expect(200);
      expect(taken.body).toEqual({ username, available: false, valid: true });
      const free = await t
        .http()
        .get(`/v1/clubs/username-available?username=${handle()}`)
        .expect(200);
      expect(free.body.available).toBe(true);
      const bad = await t.http().get('/v1/clubs/username-available?username=a').expect(200);
      expect(bad.body).toMatchObject({ available: false, valid: false });
      // a different person's handle namespace does not matter: club creation with a
      // person's username is fine
      const person = await createUser(t);
      await post(person, '/v1/clubs', {
        name: 'Same',
        username: person.username,
        city: 'X',
      }).expect(201);
    });
  });

  describe('read / update / archive', () => {
    it('private club: non-members see only the name card, visitors too; members see everything', async () => {
      const owner = await createUser(t);
      const stranger = await createUser(t);
      const { id } = await makeClub(owner, {
        visibility: 'PRIVATE',
        about: 'secret plans',
        preferredFormats: ['7v7'],
      });
      for (const asStranger of [false, true]) {
        const r = t.http().get(`/v1/clubs/${id}`);
        const req = asStranger ? r.set(stranger.auth) : r;
        const res = await req.expect(200);
        expect(res.body.restricted).toBe(true);
        expect(res.body).toMatchObject({ name: expect.any(String), username: expect.any(String) });
        for (const k of [
          'about',
          'memberCount',
          'ownerId',
          'founderId',
          'joinMode',
          'preferredFormats',
        ]) {
          expect(res.body).not.toHaveProperty(k);
        }
      }
      const own = await t.http().get(`/v1/clubs/${id}`).set(owner.auth).expect(200);
      expect(own.body).toMatchObject({ restricted: false, about: 'secret plans' });
      // internals hidden
      await t.http().get(`/v1/clubs/${id}/members`).set(stranger.auth).expect(404);
      await t.http().get(`/v1/clubs/${id}/awards`).expect(404);
      await t.http().get(`/v1/clubs/${id}/members`).set(owner.auth).expect(200);
    });

    it('public club members list is visible to everyone; requests/invited only to permission holders', async () => {
      const owner = await createUser(t);
      const other = await createUser(t);
      const { id } = await makeClub(owner);
      const members = await t.http().get(`/v1/clubs/${id}/members`).expect(200);
      expect(members.body.items).toHaveLength(1);
      expect(members.body.items[0]).toMatchObject({
        userId: owner.userId,
        isOwner: true,
        isFounder: true,
      });
      expect(JSON.stringify(members.body)).not.toMatch(/@example\.test|dateOfBirth/);
      await t.http().get(`/v1/clubs/${id}/requests`).set(other.auth).expect(403);
      await t.http().get(`/v1/clubs/${id}/invited`).set(other.auth).expect(403);
      await t.http().get(`/v1/clubs/${id}/requests`).set(owner.auth).expect(200);
      await t.http().get(`/v1/clubs/${id}/invited`).set(owner.auth).expect(200);
    });

    it('unknown / malformed ids', async () => {
      const u = await createUser(t);
      await t.http().get('/v1/clubs/not-a-uuid').set(u.auth).expect(400);
      await t.http().get('/v1/clubs/0190a0a0-0000-7000-8000-000000000000').set(u.auth).expect(404);
      await t.http().get(`/v1/clubs/by-username/${handle()}`).expect(404);
    });

    it('update needs club.profile.edit and the current version', async () => {
      const owner = await createUser(t);
      const member = await createUser(t);
      const { id, username } = await makeClub(owner, { joinMode: 'OPEN' });
      await post(member, `/v1/clubs/${id}/join`).expect(200);
      await t
        .http()
        .patch(`/v1/clubs/${id}`)
        .set(member.auth)
        .send({ about: 'hack', version: 1 })
        .expect(403);
      const ok = await t
        .http()
        .patch(`/v1/clubs/${id}`)
        .set(owner.auth)
        .send({ about: 'New about', joinMode: 'INVITE_ONLY', version: 1 })
        .expect(200);
      expect(ok.body).toMatchObject({ about: 'New about', joinMode: 'INVITE_ONLY', version: 2 });
      const stale = await t
        .http()
        .patch(`/v1/clubs/${id}`)
        .set(owner.auth)
        .send({ about: 'x', version: 1 })
        .expect(409);
      expect(stale.body.error).toMatchObject({
        code: 'VERSION_CHANGED',
        details: { currentVersion: 2 },
      });
      await t
        .http()
        .patch(`/v1/clubs/${id}`)
        .set(owner.auth)
        .send({ username: 'nope', version: 2 })
        .expect(400);
      const byName = await t.http().get(`/v1/clubs/by-username/${username}`).expect(200);
      expect(byName.body.id).toBe(id);
    });

    it('replaces and clears logo/cover media with optimistic versioning', async () => {
      const owner = await createUser(t);
      const logo = await mediaRow(t, owner, 'PHOTO');
      const cover = await mediaRow(t, owner, 'PHOTO');
      const replacement = await mediaRow(t, owner, 'PHOTO');
      const { id } = await makeClub(owner, { logoMediaId: logo, coverMediaId: cover });

      const updated = await t
        .http()
        .patch(`/v1/clubs/${id}`)
        .set(owner.auth)
        .send({ logoMediaId: replacement, coverMediaId: null, version: 1 })
        .expect(200);
      expect(updated.body).toMatchObject({
        logoMediaId: replacement,
        coverMediaId: null,
        version: 2,
      });

      await t
        .http()
        .patch(`/v1/clubs/${id}`)
        .set(owner.auth)
        .send({ logoMediaId: logo, version: 1 })
        .expect(409);
    });

    it('rejects foreign, unfinished and non-photo media before changing a club', async () => {
      const owner = await createUser(t);
      const stranger = await createUser(t);
      const { id } = await makeClub(owner);
      const foreign = await mediaRow(t, stranger, 'PHOTO');
      const unfinished = await mediaRow(t, owner, 'PHOTO', 'UPLOADING');
      const video = await mediaRow(t, owner, 'VIDEO');
      const invalid = [
        { logoMediaId: foreign, status: 400 },
        { logoMediaId: unfinished, status: 422 },
        { logoMediaId: video, status: 400 },
      ];

      for (const body of invalid) {
        await t
          .http()
          .patch(`/v1/clubs/${id}`)
          .set(owner.auth)
          .send({ logoMediaId: body.logoMediaId, version: 1 })
          .expect(body.status);
      }
      const current = await t.http().get(`/v1/clubs/${id}`).set(owner.auth).expect(200);
      expect(current.body).toMatchObject({ logoMediaId: null, version: 1 });
    });

    it('checks club.profile.edit before validating media ownership', async () => {
      const owner = await createUser(t);
      const member = await createUser(t);
      const { id } = await makeClub(owner, { joinMode: 'OPEN' });
      await post(member, `/v1/clubs/${id}/join`).expect(200);
      const media = await mediaRow(t, member, 'PHOTO');

      await t
        .http()
        .patch(`/v1/clubs/${id}`)
        .set(member.auth)
        .send({ logoMediaId: media, version: 1 })
        .expect(403);
    });

    it('a delegated club.profile.edit-free grant (club.members.invite) does not allow editing', async () => {
      const owner = await createUser(t);
      const helper = await createUser(t);
      const { id } = await makeClub(owner, { joinMode: 'OPEN' });
      await post(helper, `/v1/clubs/${id}/join`).expect(200);
      await post(owner, '/v1/grants', {
        granteeId: helper.userId,
        resourceType: 'CLUB',
        resourceId: id,
        permission: 'club.members.invite',
      }).expect(201);
      const view = await t.http().get(`/v1/clubs/${id}`).set(helper.auth).expect(200);
      expect(view.body.capabilities).toMatchObject({
        canInvite: true,
        canEdit: false,
        canArchive: false,
      });
      await t
        .http()
        .patch(`/v1/clubs/${id}`)
        .set(helper.auth)
        .send({ about: 'x', version: 1 })
        .expect(403);
      await post(helper, `/v1/clubs/${id}/archive`).expect(403);
    });

    it('archive: owner only, audited; archived clubs reject joins and hide from strangers', async () => {
      const owner = await createUser(t);
      const member = await createUser(t);
      const joiner = await createUser(t);
      const { id } = await makeClub(owner, { joinMode: 'OPEN' });
      await post(member, `/v1/clubs/${id}/join`).expect(200);
      await post(member, `/v1/clubs/${id}/archive`).expect(403);
      const res = await post(owner, `/v1/clubs/${id}/archive`).expect(200);
      expect(res.body.status).toBe('ARCHIVED');
      expect(res.body.capabilities.canEdit).toBe(false);
      const audit = await t.prisma.auditEvent.count({
        where: { action: 'club.archive', targetId: id, actorId: owner.userId },
      });
      expect(audit).toBe(1);
      const join = await post(joiner, `/v1/clubs/${id}/join`).expect(409);
      expect(join.body.error.details.reason).toBe('CLUB_ARCHIVED');
      await t.http().get(`/v1/clubs/${id}`).set(joiner.auth).expect(404);
      await t.http().get(`/v1/clubs/${id}`).set(member.auth).expect(200);
      await post(owner, `/v1/clubs/${id}/archive`).expect(200); // idempotent
    });
  });

  describe('membership', () => {
    it('join modes: OPEN → MEMBER, APPROVE_REQUESTS → REQUESTED → approve, INVITE_ONLY → denied', async () => {
      const owner = await createUser(t);
      const [a, b, c] = await Promise.all([createUser(t), createUser(t), createUser(t)]);
      const open = await makeClub(owner, { joinMode: 'OPEN' });
      const approve = await makeClub(owner, { joinMode: 'APPROVE_REQUESTS' });
      const invite = await makeClub(owner, { joinMode: 'INVITE_ONLY' });

      const view = await t.http().get(`/v1/clubs/${open.id}`).set(a.auth).expect(200);
      expect(view.body.capabilities).toMatchObject({ canJoin: true, canRequestToJoin: false });
      expect((await post(a, `/v1/clubs/${open.id}/join`).expect(200)).body).toMatchObject({
        status: 'MEMBER',
      });
      // repeat is a no-op
      expect((await post(a, `/v1/clubs/${open.id}/join`).expect(200)).body.status).toBe('MEMBER');

      const view2 = await t.http().get(`/v1/clubs/${approve.id}`).set(b.auth).expect(200);
      expect(view2.body.capabilities).toMatchObject({ canJoin: false, canRequestToJoin: true });
      expect((await post(b, `/v1/clubs/${approve.id}/join`).expect(200)).body.status).toBe(
        'REQUESTED',
      );
      // A requester is not a member yet
      const members = await t.http().get(`/v1/clubs/${approve.id}/members`).expect(200);
      expect(members.body.items.map((m: { userId: string }) => m.userId)).toEqual([owner.userId]);
      const requests = await t
        .http()
        .get(`/v1/clubs/${approve.id}/requests`)
        .set(owner.auth)
        .expect(200);
      expect(requests.body.items.map((m: { userId: string }) => m.userId)).toEqual([b.userId]);
      // requester cannot approve themselves
      await post(b, `/v1/clubs/${approve.id}/requests/${b.userId}/approve`).expect(403);
      await post(owner, `/v1/clubs/${approve.id}/requests/${b.userId}/approve`).expect(200);
      const after = await t.http().get(`/v1/clubs/${approve.id}/members`).expect(200);
      expect(after.body.items).toHaveLength(2);
      // request list is now empty; second approval is a state error
      await post(owner, `/v1/clubs/${approve.id}/requests/${b.userId}/approve`).expect(404);

      await post(c, `/v1/clubs/${invite.id}/join`).expect(403);
      const ivView = await t.http().get(`/v1/clubs/${invite.id}`).set(c.auth).expect(200);
      expect(ivView.body.capabilities).toMatchObject({ canJoin: false, canRequestToJoin: false });

      // decline + withdraw
      const d = await createUser(t);
      await post(d, `/v1/clubs/${approve.id}/join`).expect(200);
      await post(d, `/v1/clubs/${approve.id}/join/cancel`).expect(200);
      await post(d, `/v1/clubs/${approve.id}/join`).expect(200);
      await post(owner, `/v1/clubs/${approve.id}/requests/${d.userId}/decline`).expect(200);
      const st = await t.prisma.membership.findUniqueOrThrow({
        where: { clubId_userId: { clubId: approve.id, userId: d.userId } },
      });
      expect(st.status).toBe('DECLINED');
    });

    it('leave: members can, the owner cannot before transferring ownership', async () => {
      const owner = await createUser(t);
      const m = await createUser(t);
      const { id } = await makeClub(owner, { joinMode: 'OPEN' });
      await post(m, `/v1/clubs/${id}/join`).expect(200);
      const res = await post(owner, `/v1/clubs/${id}/leave`).expect(409);
      expect(res.body.error.details.reason).toBe('LAST_OWNER');
      expect((await post(m, `/v1/clubs/${id}/leave`).expect(200)).body.status).toBe('LEFT');
      await post(m, `/v1/clubs/${id}/leave`).expect(404);
      expect((await post(m, `/v1/clubs/${id}/join`).expect(200)).body.status).toBe('MEMBER');
    });

    it('invites: multi-select, no duplicates, invitee accept/decline, permission required', async () => {
      const owner = await createUser(t);
      const [a, b, c] = await Promise.all([createUser(t), createUser(t), createUser(t)]);
      const { id } = await makeClub(owner, { joinMode: 'INVITE_ONLY' });
      await post(a, `/v1/clubs/${id}/invitations`, { userIds: [b.userId] }).expect(403);

      const res = await post(owner, `/v1/clubs/${id}/invitations`, {
        userIds: [a.userId, b.userId, owner.userId, '0190a0a0-0000-7000-8000-000000000000'],
      }).expect(201);
      const by = Object.fromEntries(
        (res.body.results as { userId: string; outcome: string }[]).map((r) => [
          r.userId,
          r.outcome,
        ]),
      );
      expect(by[a.userId]).toBe('INVITED');
      expect(by[b.userId]).toBe('INVITED');
      expect(by[owner.userId]).toBe('ALREADY_MEMBER');
      expect(by['0190a0a0-0000-7000-8000-000000000000']).toBe('NOT_FOUND');

      const again = await post(owner, `/v1/clubs/${id}/invitations`, {
        userIds: [a.userId],
      }).expect(201);
      expect(again.body.results[0].outcome).toBe('ALREADY_INVITED');
      expect(await t.prisma.membership.count({ where: { clubId: id, userId: a.userId } })).toBe(1);

      // separate lists
      const invited = await t.http().get(`/v1/clubs/${id}/invited`).set(owner.auth).expect(200);
      expect(invited.body.items).toHaveLength(2);
      const members = await t.http().get(`/v1/clubs/${id}/members`).set(owner.auth).expect(200);
      expect(members.body.items).toHaveLength(1);

      const mine = await t.http().get('/v1/me/club-invitations').set(a.auth).expect(200);
      expect(mine.body.items.map((i: { clubId: string }) => i.clubId)).toContain(id);
      const view = await t.http().get(`/v1/clubs/${id}`).set(a.auth).expect(200);
      expect(view.body.capabilities.canAcceptInvitation).toBe(true);

      expect((await post(a, `/v1/clubs/${id}/invitation/accept`).expect(200)).body.status).toBe(
        'MEMBER',
      );
      expect((await post(b, `/v1/clubs/${id}/invitation/decline`).expect(200)).body.status).toBe(
        'DECLINED',
      );
      await post(c, `/v1/clubs/${id}/invitation/accept`).expect(404); // not invited
      await post(a, `/v1/clubs/${id}/invitation/accept`).expect(404); // already used

      // notification reached the invitee
      expect(
        await t.prisma.notification.count({ where: { recipientId: a.userId, category: 'club' } }),
      ).toBeGreaterThan(0);

      // declined people can be invited again; the owner can withdraw an invitation
      const again2 = await post(owner, `/v1/clubs/${id}/invitations`, {
        userIds: [b.userId, c.userId],
      }).expect(201);
      expect(again2.body.results.map((r: { outcome: string }) => r.outcome)).toEqual([
        'INVITED',
        'INVITED',
      ]);
      await t.http().delete(`/v1/clubs/${id}/invitations/${c.userId}`).set(owner.auth).expect(204);
      await post(c, `/v1/clubs/${id}/invitation/accept`).expect(404);
      await post(owner, `/v1/clubs/${id}/invitations`, { userIds: [] }).expect(400);
    });

    it('invitation policy and blocks are honoured', async () => {
      const owner = await createUser(t);
      const [nobody, following, everyone, blocker, clubOnly] = await Promise.all([
        createUser(t),
        createUser(t),
        createUser(t),
        createUser(t),
        createUser(t),
      ]);
      const { id } = await makeClub(owner);
      await t
        .http()
        .patch('/v1/me/privacy')
        .set(nobody.auth)
        .send({ invitationPolicy: 'NOBODY' })
        .expect(200);
      await t
        .http()
        .patch('/v1/me/privacy')
        .set(following.auth)
        .send({ invitationPolicy: 'FOLLOWING' })
        .expect(200);
      await t
        .http()
        .patch('/v1/me/privacy')
        .set(clubOnly.auth)
        .send({ invitationPolicy: 'CLUB_MEMBERS' })
        .expect(200);
      await t.http().put(`/v1/blocks/${owner.userId}`).set(blocker.auth).expect(204);

      const res = await post(owner, `/v1/clubs/${id}/invitations`, {
        userIds: [
          nobody.userId,
          following.userId,
          everyone.userId,
          blocker.userId,
          clubOnly.userId,
        ],
      }).expect(201);
      const by = Object.fromEntries(
        (res.body.results as { userId: string; outcome: string }[]).map((r) => [
          r.userId,
          r.outcome,
        ]),
      );
      expect(by).toEqual({
        [nobody.userId]: 'NOT_ALLOWED',
        [following.userId]: 'NOT_ALLOWED',
        [everyone.userId]: 'INVITED',
        [blocker.userId]: 'NOT_ALLOWED',
        [clubOnly.userId]: 'NOT_ALLOWED',
      });
      expect(
        await t.prisma.membership.count({ where: { clubId: id, userId: nobody.userId } }),
      ).toBe(0);

      // FOLLOWING = the invitee follows the inviter; CLUB_MEMBERS = they share a club
      await t.prisma.follow.create({
        data: {
          followerId: owner.userId,
          targetType: 'USER',
          targetId: following.userId,
          status: 'ACCEPTED',
        },
      }); // wrong direction (inviter follows invitee): still not allowed
      await t.prisma.follow.create({
        data: {
          followerId: following.userId,
          targetType: 'USER',
          targetId: owner.userId,
          status: 'ACCEPTED',
        },
      });
      const other = await makeClub(owner, { joinMode: 'OPEN' });
      await post(clubOnly, `/v1/clubs/${other.id}/join`).expect(200);
      const res2 = await post(owner, `/v1/clubs/${id}/invitations`, {
        userIds: [following.userId, clubOnly.userId],
      }).expect(201);
      expect(res2.body.results.map((r: { outcome: string }) => r.outcome)).toEqual([
        'INVITED',
        'INVITED',
      ]);

      // blocked people cannot join or see the club either
      await t.http().get(`/v1/clubs/${id}`).set(blocker.auth).expect(404);
      await post(blocker, `/v1/clubs/${id}/join`).expect(404);
    });

    it('remove member: needs club.members.remove, cannot remove the owner, ends grants', async () => {
      const owner = await createUser(t);
      const [helper, victim] = await Promise.all([createUser(t), createUser(t)]);
      const { id } = await makeClub(owner, { joinMode: 'OPEN' });
      await post(helper, `/v1/clubs/${id}/join`).expect(200);
      await post(victim, `/v1/clubs/${id}/join`).expect(200);
      await t
        .http()
        .delete(`/v1/clubs/${id}/members/${victim.userId}`)
        .set(helper.auth)
        .expect(403);
      await t.http().delete(`/v1/clubs/${id}/members/${owner.userId}`).set(owner.auth).expect(409);
      // victim gets a grant, then is removed → grant dies with the membership
      await post(owner, '/v1/grants', {
        granteeId: victim.userId,
        resourceType: 'CLUB',
        resourceId: id,
        permission: 'club.members.invite',
      }).expect(201);
      const res = await t
        .http()
        .delete(`/v1/clubs/${id}/members/${victim.userId}`)
        .set(owner.auth)
        .expect(200);
      expect(res.body.status).toBe('REMOVED');
      const live = await t.prisma.roleGrant.count({
        where: { granteeId: victim.userId, resourceId: id, revokedAt: null },
      });
      expect(live).toBe(0);
      await post(victim, `/v1/clubs/${id}/invitations`, { userIds: [helper.userId] }).expect(403);
      // a removed person cannot walk back in on their own
      await post(victim, `/v1/clubs/${id}/join`).expect(403);
      expect(
        await t.prisma.auditEvent.count({ where: { action: 'club.member.remove', targetId: id } }),
      ).toBe(1);
    });

    it('a role title is display text only and grants nothing', async () => {
      const owner = await createUser(t);
      const member = await createUser(t);
      const other = await createUser(t);
      const { id } = await makeClub(owner, { joinMode: 'OPEN' });
      await post(member, `/v1/clubs/${id}/join`).expect(200);
      await post(other, `/v1/clubs/${id}/join`).expect(200);
      // members cannot set titles
      await t
        .http()
        .patch(`/v1/clubs/${id}/members/${other.userId}/title`)
        .set(member.auth)
        .send({ roleTitle: 'Founder' })
        .expect(403);
      const res = await t
        .http()
        .patch(`/v1/clubs/${id}/members/${member.userId}/title`)
        .set(owner.auth)
        .send({ roleTitle: 'Founder / Owner', showTitle: true })
        .expect(200);
      expect(res.body.roleTitle).toBe('Founder / Owner');
      const view = await t.http().get(`/v1/clubs/${id}`).set(member.auth).expect(200);
      expect(view.body.myMembership.roleTitle).toBe('Founder / Owner');
      expect(view.body.capabilities).toMatchObject({
        canEdit: false,
        canInvite: false,
        canApprove: false,
        canRemoveMembers: false,
        canManageRoles: false,
        canTransferOwnership: false,
        canArchive: false,
      });
      // nothing works
      await t
        .http()
        .patch(`/v1/clubs/${id}`)
        .set(member.auth)
        .send({ about: 'x', version: 1 })
        .expect(403);
      await post(member, `/v1/clubs/${id}/invitations`, { userIds: [owner.userId] }).expect(403);
      await post(member, `/v1/clubs/${id}/archive`).expect(403);
      await post(member, `/v1/clubs/${id}/ownership-transfers`, { toUserId: other.userId }).expect(
        403,
      );
      await t.http().delete(`/v1/clubs/${id}/members/${other.userId}`).set(member.auth).expect(403);
      await t
        .http()
        .patch(`/v1/clubs/${id}/members/${other.userId}/title`)
        .set(member.auth)
        .send({ roleTitle: 'Boss' })
        .expect(403);
      expect(
        await t.prisma.roleGrant.count({ where: { granteeId: member.userId, revokedAt: null } }),
      ).toBe(0);
      // hidden title stays hidden from others but the manager sees it
      await t
        .http()
        .patch(`/v1/clubs/${id}/members/${member.userId}/title`)
        .set(owner.auth)
        .send({ showTitle: false })
        .expect(200);
      const list = await t.http().get(`/v1/clubs/${id}/members`).set(other.auth).expect(200);
      const row = list.body.items.find((m: { userId: string }) => m.userId === member.userId);
      expect(row.roleTitle).toBeNull();
      // clearing
      await t
        .http()
        .patch(`/v1/clubs/${id}/members/${member.userId}/title`)
        .set(owner.auth)
        .send({ roleTitle: null })
        .expect(200);
    });

    it('my clubs list is paginated by keyset', async () => {
      const u = await createUser(t);
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push((await makeClub(u)).id);
      const p1 = await t.http().get('/v1/clubs/mine?limit=2').set(u.auth).expect(200);
      expect(p1.body.items).toHaveLength(2);
      expect(p1.body.nextCursor).toEqual(expect.any(String));
      const p2 = await t
        .http()
        .get(`/v1/clubs/mine?limit=2&cursor=${p1.body.nextCursor}`)
        .set(u.auth)
        .expect(200);
      expect(p2.body.items).toHaveLength(1);
      expect(p2.body.nextCursor).toBeNull();
      const all = [...p1.body.items, ...p2.body.items].map((c: { id: string }) => c.id);
      expect(new Set(all)).toEqual(new Set(ids));
      expect(p1.body.items[0]).toMatchObject({ isOwner: true, entityType: 'CLUB' });
    });
  });

  describe('ownership transfer', () => {
    it('offer → accept swaps the owner atomically, founder unchanged, old owner loses authority', async () => {
      const owner = await createUser(t);
      const next = await createUser(t);
      const { id } = await makeClub(owner, { joinMode: 'OPEN' });
      await post(next, `/v1/clubs/${id}/join`).expect(200);

      const offer = await post(owner, `/v1/clubs/${id}/ownership-transfers`, {
        toUserId: next.userId,
      }).expect(201);
      expect(offer.body).toMatchObject({
        status: 'PENDING',
        fromUserId: owner.userId,
        toUserId: next.userId,
      });
      const transferId = offer.body.id as string;

      // only one pending transfer per club
      const dup = await post(owner, `/v1/clubs/${id}/ownership-transfers`, {
        toUserId: next.userId,
      }).expect(409);
      expect(dup.body.error.details.reason).toBe('TRANSFER_PENDING');
      // the owner still leads until acceptance; leaving is still refused
      await post(owner, `/v1/clubs/${id}/leave`).expect(409);
      // wrong people cannot answer
      await post(owner, `/v1/clubs/${id}/ownership-transfers/${transferId}/accept`).expect(404);
      const stranger = await createUser(t);
      await post(stranger, `/v1/clubs/${id}/ownership-transfers/${transferId}/accept`).expect(404);
      await post(next, `/v1/clubs/${id}/ownership-transfers/${transferId}/cancel`).expect(404);
      const incoming = await t.http().get('/v1/me/ownership-transfers').set(next.auth).expect(200);
      expect(incoming.body.items.map((x: { id: string }) => x.id)).toContain(transferId);

      const done = await post(
        next,
        `/v1/clubs/${id}/ownership-transfers/${transferId}/accept`,
      ).expect(200);
      expect(done.body.status).toBe('ACCEPTED');
      const club = await t.prisma.club.findUniqueOrThrow({ where: { id } });
      expect(club).toMatchObject({ ownerId: next.userId, founderId: owner.userId });

      // old owner: still a member, no structural authority
      const oldView = await t.http().get(`/v1/clubs/${id}`).set(owner.auth).expect(200);
      expect(oldView.body).toMatchObject({
        myMembership: { status: 'MEMBER', isOwner: false },
        founderId: owner.userId,
      });
      expect(oldView.body.capabilities).toMatchObject({
        canEdit: false,
        canArchive: false,
        canTransferOwnership: false,
        canLeave: true,
      });
      await t
        .http()
        .patch(`/v1/clubs/${id}`)
        .set(owner.auth)
        .send({ about: 'x', version: club.version })
        .expect(403);
      await post(owner, `/v1/clubs/${id}/archive`).expect(403);
      // the new owner has it all, and the old owner may now leave
      await t
        .http()
        .patch(`/v1/clubs/${id}`)
        .set(next.auth)
        .send({ about: 'mine now', version: club.version })
        .expect(200);
      await post(owner, `/v1/clubs/${id}/leave`).expect(200);
      await post(next, `/v1/clubs/${id}/leave`).expect(409); // last owner
      expect(
        await t.prisma.auditEvent.count({
          where: { action: 'club.ownership.accept', targetId: id },
        }),
      ).toBe(1);
      // a settled offer cannot be replayed
      await post(next, `/v1/clubs/${id}/ownership-transfers/${transferId}/accept`).expect(404);
    });

    it('decline and cancel free the slot for a new offer; bad recipients are refused', async () => {
      const owner = await createUser(t);
      const [a, b, blocked] = await Promise.all([createUser(t), createUser(t), createUser(t)]);
      const incomplete = await createUser(t, { complete: false });
      const { id } = await makeClub(owner);
      await post(owner, `/v1/clubs/${id}/ownership-transfers`, { toUserId: owner.userId }).expect(
        400,
      );
      await post(owner, `/v1/clubs/${id}/ownership-transfers`, {
        toUserId: incomplete.userId,
      }).expect(400);
      await t.http().put(`/v1/blocks/${owner.userId}`).set(blocked.auth).expect(204);
      await post(owner, `/v1/clubs/${id}/ownership-transfers`, { toUserId: blocked.userId }).expect(
        400,
      );
      await post(a, `/v1/clubs/${id}/ownership-transfers`, { toUserId: b.userId }).expect(403);

      const o1 = await post(owner, `/v1/clubs/${id}/ownership-transfers`, {
        toUserId: a.userId,
      }).expect(201);
      expect(
        (await post(a, `/v1/clubs/${id}/ownership-transfers/${o1.body.id}/decline`).expect(200))
          .body.status,
      ).toBe('DECLINED');
      const o2 = await post(owner, `/v1/clubs/${id}/ownership-transfers`, {
        toUserId: b.userId,
      }).expect(201);
      const listed = await t
        .http()
        .get(`/v1/clubs/${id}/ownership-transfers`)
        .set(owner.auth)
        .expect(200);
      expect(listed.body.items).toHaveLength(1);
      const hidden = await t
        .http()
        .get(`/v1/clubs/${id}/ownership-transfers`)
        .set(a.auth)
        .expect(200);
      expect(hidden.body.items).toHaveLength(0);
      expect(
        (await post(owner, `/v1/clubs/${id}/ownership-transfers/${o2.body.id}/cancel`).expect(200))
          .body.status,
      ).toBe('CANCELLED');
      // idempotent offer with a key
      const key = `key-${uniq(12)}`;
      const send = () =>
        t
          .http()
          .post(`/v1/clubs/${id}/ownership-transfers`)
          .set(owner.auth)
          .set('Idempotency-Key', key)
          .send({ toUserId: a.userId });
      const [x, y] = await Promise.all([send(), send()]);
      expect([x.status, y.status]).toEqual([201, 201]);
      expect(x.body.id).toBe(y.body.id);
      expect(
        await t.prisma.ownershipTransfer.count({ where: { clubId: id, status: 'PENDING' } }),
      ).toBe(1);
    });

    it('a stale offer (owner changed) cannot be accepted', async () => {
      const owner = await createUser(t);
      const [a, b] = await Promise.all([createUser(t), createUser(t)]);
      const { id } = await makeClub(owner);
      const o = await post(owner, `/v1/clubs/${id}/ownership-transfers`, {
        toUserId: a.userId,
      }).expect(201);
      await t.prisma.club.update({ where: { id }, data: { ownerId: b.userId } }); // out-of-band change
      const res = await post(a, `/v1/clubs/${id}/ownership-transfers/${o.body.id}/accept`).expect(
        409,
      );
      expect(res.body.error.details.reason).toBe('TRANSFER_STALE');
    });
  });

  describe('awards', () => {
    it('club.awards.manage can award members; labelled as a club award; others cannot', async () => {
      const owner = await createUser(t);
      const [member, outsider, mgr] = await Promise.all([
        createUser(t),
        createUser(t),
        createUser(t),
      ]);
      const { id } = await makeClub(owner, { joinMode: 'OPEN' });
      await post(member, `/v1/clubs/${id}/join`).expect(200);
      await post(mgr, `/v1/clubs/${id}/join`).expect(200);
      const body = {
        recipientId: member.userId,
        title: 'Player of the month',
        description: 'Great season',
      };
      await post(mgr, `/v1/clubs/${id}/awards`, body).expect(403);
      await post(owner, `/v1/clubs/${id}/awards`, { ...body, recipientId: outsider.userId }).expect(
        400,
      );
      const ok = await post(owner, `/v1/clubs/${id}/awards`, body).expect(201);
      expect(ok.body).toMatchObject({
        type: 'CLUB_AWARD',
        clubAward: true,
        clubId: id,
        recipientId: member.userId,
      });
      await post(owner, '/v1/grants', {
        granteeId: mgr.userId,
        resourceType: 'CLUB',
        resourceId: id,
        permission: 'club.awards.manage',
      }).expect(201);
      await post(mgr, `/v1/clubs/${id}/awards`, { ...body, title: 'Fair play' }).expect(201);
      const list = await t.http().get(`/v1/clubs/${id}/awards`).expect(200);
      expect(list.body.items).toHaveLength(2);
      const row = await t.prisma.achievement.findUniqueOrThrow({ where: { id: ok.body.id } });
      expect(row).toMatchObject({ type: 'CLUB_AWARD', clubId: id, grantedById: owner.userId });
    });
  });

  describe('search', () => {
    it('finds clubs by name and username with entity type; private clubs by name only; keyset paging', async () => {
      const u = await createUser(t);
      const tag = uniq(8);
      const pub = await makeClub(u, {
        name: `Alpha ${tag} United`,
        city: 'Searchville',
        about: 'about text',
      });
      const priv = await makeClub(u, {
        name: `Beta ${tag} Private`,
        city: 'Searchville',
        visibility: 'PRIVATE',
        about: 'hidden',
      });
      await makeClub(u, { name: `Gamma ${tag}`, city: 'Elsewhere' });
      const viewer = await createUser(t);

      const res = await t
        .http()
        .get(`/v1/clubs?q=${tag}&city=searchville`)
        .set(viewer.auth)
        .expect(200);
      const items = res.body.items as Record<string, unknown>[];
      expect(items.map((i) => i.id).sort()).toEqual([pub.id, priv.id].sort());
      for (const i of items) expect(i.entityType).toBe('CLUB');
      const privateItem = items.find((i) => i.id === priv.id)!;
      expect(privateItem).not.toHaveProperty('memberCount');
      expect(JSON.stringify(privateItem)).not.toContain('hidden');
      const publicItem = items.find((i) => i.id === pub.id)!;
      expect(publicItem.memberCount).toBe(1);

      const byHandle = await t.http().get(`/v1/clubs?q=${pub.username.toUpperCase()}`).expect(200);
      expect(byHandle.body.items.map((i: { id: string }) => i.id)).toEqual([pub.id]);

      const p1 = await t.http().get(`/v1/clubs?q=${tag}&limit=2`).expect(200);
      expect(p1.body.items).toHaveLength(2);
      const p2 = await t
        .http()
        .get(`/v1/clubs?q=${tag}&limit=2&cursor=${p1.body.nextCursor}`)
        .expect(200);
      expect(p2.body.items).toHaveLength(1);
      expect(p2.body.nextCursor).toBeNull();
      await t.http().get('/v1/clubs?cursor=garbage').expect(400);
    });
  });
});
