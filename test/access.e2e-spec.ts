import { Clock } from '../src/common/time/clock';
import { createTestApp, type TestApp } from './support/app';
import { FakeClock } from './support/clock';
import { createUser, type TestUser } from './support/factories';
import { createClubRow, createGame, HOUR } from './support/games';

describe('grants, delegation and the capability engine (real PostgreSQL)', () => {
  let t: TestApp;
  const clock = new FakeClock();
  beforeAll(async () => {
    t = await createTestApp((b) => b.overrideProvider(Clock).useValue(clock));
  });
  beforeEach(() => clock.set(new Date()));
  afterAll(() => t.close());

  const grant = (by: TestUser, body: Record<string, unknown>) =>
    t.http().post('/v1/grants').set(by.auth).send(body);
  /** Can this user manage the squad (invite) of that game? Uses the real mutation as the oracle. */
  const canInvite = async (u: TestUser, gameId: string, target: TestUser) =>
    (
      await t
        .http()
        .post(`/v1/games/${gameId}/invitations`)
        .set(u.auth)
        .send({ inviteeIds: [target.userId] })
    ).status === 200;

  it('publishes the server permission catalogue without granting access', async () => {
    const user = await createUser(t);
    await t.http().get('/v1/grants/catalog').expect(401);
    const all = await t.http().get('/v1/grants/catalog').set(user.auth).expect(200);
    expect(all.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          permission: 'club.squad.manage',
          resources: ['CLUB', 'EVENT'],
          delegable: true,
        }),
        expect.objectContaining({
          permission: 'tournament.protocols',
          resources: ['TOURNAMENT'],
          delegable: false,
        }),
      ]),
    );

    const club = await t
      .http()
      .get('/v1/grants/catalog')
      .query({ resourceType: 'CLUB' })
      .set(user.auth)
      .expect(200);
    expect(club.body.length).toBeGreaterThan(0);
    expect(club.body.every((x: { resources: string[] }) => x.resources.includes('CLUB'))).toBe(
      true,
    );
    expect(club.body.some((x: { permission: string }) => x.permission === 'admin.staff.manage')).toBe(
      false,
    );
  });

  it('a role TITLE grants nothing; only explicit grants do', async () => {
    const owner = await createUser(t);
    const coach = await createUser(t);
    const target = await createUser(t);
    const clubId = await createClubRow(t, owner);
    await t.prisma.membership.create({
      data: { clubId, userId: coach.userId, status: 'MEMBER', roleTitle: 'Founder & Head Coach' },
    });
    const game = await createGame(t, owner, { clubId });
    expect(await canInvite(coach, game.id, target)).toBe(false);
    const detail = await t.http().get(`/v1/games/${game.id}`).set(coach.auth).expect(200);
    expect(detail.body.capabilities.canInvite).toBe(false);
    expect(detail.body.capabilities.canEdit).toBe(false);
  });

  it('owner grants a permission; capability and mutation agree; revoking removes both', async () => {
    const owner = await createUser(t);
    const coach = await createUser(t);
    const [t1, t2] = await Promise.all([createUser(t), createUser(t)]);
    const clubId = await createClubRow(t, owner);
    const game = await createGame(t, owner, { clubId });
    const g = await grant(owner, {
      granteeId: coach.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
    }).expect(201);
    expect(
      (await t.http().get(`/v1/games/${game.id}`).set(coach.auth)).body.capabilities.canInvite,
    ).toBe(true);
    expect(await canInvite(coach, game.id, t1)).toBe(true);
    await t
      .http()
      .delete(`/v1/grants/${g.body.id}`)
      .set(owner.auth)
      .send({ reason: 'test' })
      .expect(200);
    expect(
      (await t.http().get(`/v1/games/${game.id}`).set(coach.auth)).body.capabilities.canInvite,
    ).toBe(false);
    expect(await canInvite(coach, game.id, t2)).toBe(false);
    // audit trail
    expect(
      await t.prisma.auditEvent.count({
        where: { targetId: g.body.id, action: { in: ['grant.create', 'grant.revoke'] } },
      }),
    ).toBe(2);
  });

  it('non-owners cannot create root grants; unknown permissions and self-grants are refused', async () => {
    const owner = await createUser(t);
    const rando = await createUser(t);
    const other = await createUser(t);
    const clubId = await createClubRow(t, owner);
    await grant(rando, {
      granteeId: other.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
    }).expect(403);
    await grant(owner, {
      granteeId: other.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.does.not.exist',
    }).expect(400);
    await grant(owner, {
      granteeId: owner.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
    }).expect(403);
    // permission that does not apply to this resource type
    await grant(owner, {
      granteeId: other.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'tournament.manage',
    }).expect(400);
  });

  it('AC-35: club staff cannot act on another club’s game — the title does not help', async () => {
    const ownerA = await createUser(t);
    const ownerB = await createUser(t);
    const coachA = await createUser(t);
    const target = await createUser(t);
    const clubA = await createClubRow(t, ownerA);
    const clubB = await createClubRow(t, ownerB);
    await grant(ownerA, {
      granteeId: coachA.userId,
      resourceType: 'CLUB',
      resourceId: clubA,
      permission: 'club.squad.manage',
    }).expect(201);
    const gameB = await createGame(t, ownerB, { clubId: clubB });
    expect(await canInvite(coachA, gameB.id, target)).toBe(false);
  });

  it('delegation: David passes on ONE game to Arunas; scope cannot widen; no further delegation', async () => {
    const owner = await createUser(t);
    const david = await createUser(t);
    const arunas = await createUser(t);
    const third = await createUser(t);
    const t1 = await createUser(t);
    const clubId = await createClubRow(t, owner);
    const gameA = await createGame(t, owner, { clubId });
    const gameB = await createGame(t, owner, { clubId });
    // David: can use + can pass on (but no further delegation)
    const root = await grant(owner, {
      granteeId: david.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
      canPassOn: true,
    }).expect(201);
    expect(root.body.canPassOn).toBe(true);
    // He passes it for game A only
    const child = await grant(david, {
      granteeId: arunas.userId,
      resourceType: 'EVENT',
      resourceId: gameA.id,
      permission: 'club.squad.manage',
    }).expect(201);
    expect(child.body.sourceGrantId).toBe(root.body.id);
    expect(await canInvite(arunas, gameA.id, t1)).toBe(true);
    expect(await canInvite(arunas, gameB.id, t1)).toBe(false); // scope not widened
    // Arunas cannot pass it on (no "can pass on")
    await grant(arunas, {
      granteeId: third.userId,
      resourceType: 'EVENT',
      resourceId: gameA.id,
      permission: 'club.squad.manage',
    }).expect(403);
    // David cannot pass on what he does not hold
    await grant(david, {
      granteeId: third.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.money.confirmCash',
    }).expect(403);
    // …nor widen to the whole club? Same permission at CLUB scope is allowed for his own scope only
    const wide = await grant(david, {
      granteeId: third.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
    }).expect(201);
    expect(wide.body.sourceGrantId).toBe(root.body.id); // equal to his own scope: not wider
  });

  it('a delegate can only receive "can pass on" if the source allows further delegation', async () => {
    const owner = await createUser(t);
    const a = await createUser(t);
    const b = await createUser(t);
    const c = await createUser(t);
    const clubId = await createClubRow(t, owner);
    const rootNo = await grant(owner, {
      granteeId: a.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
      canPassOn: true,
    }).expect(201);
    const dNo = await grant(a, {
      granteeId: b.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
      canPassOn: true,
    }).expect(201);
    expect(dNo.body.canPassOn).toBe(false);
    void rootNo;
    const rootYes = await grant(owner, {
      granteeId: c.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.results.record',
      canPassOn: true,
      furtherDelegation: true,
    }).expect(201);
    const d = await grant(c, {
      granteeId: b.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.results.record',
      canPassOn: true,
    }).expect(201);
    expect(d.body.canPassOn).toBe(true);
    expect(d.body.sourceGrantId).toBe(rootYes.body.id);
  });

  it('a delegated grant cannot outlive its source; the child expiry is clamped', async () => {
    const owner = await createUser(t);
    const a = await createUser(t);
    const b = await createUser(t);
    const clubId = await createClubRow(t, owner);
    const srcExp = new Date(clock.now().getTime() + 2 * HOUR);
    await grant(owner, {
      granteeId: a.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
      canPassOn: true,
      expiresAt: srcExp.toISOString(),
    }).expect(201);
    const noExpiry = await grant(a, {
      granteeId: b.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
    }).expect(201);
    expect(new Date(noExpiry.body.expiresAt).getTime()).toBe(srcExp.getTime());
    const longer = await grant(a, {
      granteeId: b.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
      expiresAt: new Date(srcExp.getTime() + 5 * HOUR).toISOString(),
    }).expect(201);
    expect(new Date(longer.body.expiresAt).getTime()).toBe(srcExp.getTime());
  });

  it('expired grants stop working by time alone', async () => {
    const owner = await createUser(t);
    const coach = await createUser(t);
    const target = await createUser(t);
    const target2 = await createUser(t);
    const clubId = await createClubRow(t, owner);
    const game = await createGame(t, owner, { clubId });
    await grant(owner, {
      granteeId: coach.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
      expiresAt: new Date(clock.now().getTime() + HOUR).toISOString(),
    }).expect(201);
    expect(await canInvite(coach, game.id, target)).toBe(true);
    clock.advanceMinutes(61);
    expect(await canInvite(coach, game.id, target2)).toBe(false);
    expect((await t.http().get('/v1/grants/mine').set(coach.auth)).body).toHaveLength(0);
  });

  it('AC-34: revoking the source revokes dependents; an independent grant from the owner survives', async () => {
    const owner = await createUser(t);
    const david = await createUser(t);
    const arunas = await createUser(t);
    const bystander = await createUser(t);
    const t1 = await createUser(t);
    const clubId = await createClubRow(t, owner);
    const game = await createGame(t, owner, { clubId });
    const root = await grant(owner, {
      granteeId: david.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
      canPassOn: true,
      furtherDelegation: true,
    }).expect(201);
    const viaDavid = await grant(david, {
      granteeId: arunas.userId,
      resourceType: 'EVENT',
      resourceId: game.id,
      permission: 'club.squad.manage',
      canPassOn: true,
    }).expect(201);
    const second = await grant(arunas, {
      granteeId: bystander.userId,
      resourceType: 'EVENT',
      resourceId: game.id,
      permission: 'club.squad.manage',
    }).expect(201);
    // Arunas ALSO has an independent grant of another permission from the owner
    const independent = await grant(owner, {
      granteeId: arunas.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.results.record',
    }).expect(201);
    expect(await canInvite(arunas, game.id, t1)).toBe(true);

    const rev = await t
      .http()
      .delete(`/v1/grants/${root.body.id}`)
      .set(owner.auth)
      .send({})
      .expect(200);
    expect(rev.body.revoked).toBe(3); // root + child + grandchild
    expect(await canInvite(david, game.id, t1)).toBe(false);
    expect(await canInvite(arunas, game.id, t1)).toBe(false);
    expect(await canInvite(bystander, game.id, t1)).toBe(false);
    void viaDavid;
    void second;
    // the independent grant is untouched
    const mine = await t.http().get('/v1/grants/mine').set(arunas.auth).expect(200);
    expect(mine.body.map((g: { id: string }) => g.id)).toEqual([independent.body.id]);
    expect(
      await t.prisma.roleGrant.count({
        where: { sourceGrantId: root.body.id, revokedAt: { not: null } },
      }),
    ).toBe(1);
  });

  it('a delegator cannot delegate back up the chain (cycle) or to themselves', async () => {
    const owner = await createUser(t);
    const a = await createUser(t);
    const b = await createUser(t);
    const clubId = await createClubRow(t, owner);
    await grant(owner, {
      granteeId: a.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
      canPassOn: true,
      furtherDelegation: true,
    }).expect(201);
    await grant(a, {
      granteeId: b.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
      canPassOn: true,
    }).expect(201);
    const cyc = await grant(b, {
      granteeId: a.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
    });
    expect(cyc.status).toBe(403);
    await grant(a, {
      granteeId: a.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.squad.manage',
    }).expect(403);
  });

  it('non-delegable permissions can only be issued by the owner and never passed on', async () => {
    const owner = await createUser(t);
    const a = await createUser(t);
    const b = await createUser(t);
    const clubId = await createClubRow(t, owner);
    const g = await grant(owner, {
      granteeId: a.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.money.changeFees',
      canPassOn: true,
    }).expect(201);
    expect(g.body.canPassOn).toBe(false); // requested but not allowed for this permission
    await grant(a, {
      granteeId: b.userId,
      resourceType: 'CLUB',
      resourceId: clubId,
      permission: 'club.money.changeFees',
    }).expect(403);
  });

  it('platform staff: admin permissions come only from staff-manager grants (no admin flag)', async () => {
    const boss = await createUser(t);
    const staff = await createUser(t);
    const nobody = await createUser(t);
    await t.prisma.roleGrant.create({
      data: {
        granteeId: boss.userId,
        resourceType: 'PLATFORM',
        resourceId: null,
        permission: 'admin.staff.manage',
        grantedById: boss.userId,
      },
    });
    await grant(nobody, {
      granteeId: staff.userId,
      resourceType: 'PLATFORM',
      permission: 'admin.reports.moderate',
    }).expect(403);
    const g = await grant(boss, {
      granteeId: staff.userId,
      resourceType: 'PLATFORM',
      permission: 'admin.reports.moderate',
    }).expect(201);
    expect(g.body.resourceId).toBeNull();
    const list = await t.http().get('/v1/grants?resourceType=PLATFORM').set(boss.auth).expect(200);
    expect(list.body.some((x: { id: string }) => x.id === g.body.id)).toBe(true);
    await t.http().get('/v1/grants?resourceType=PLATFORM').set(nobody.auth).expect(403);
  });
});
