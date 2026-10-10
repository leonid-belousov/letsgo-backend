import { createTestApp, type TestApp } from './support/app';
import { createUser } from './support/factories';
import {
  addMember,
  applyWith,
  createClubRow,
  createTournament,
  decide,
  grantClub,
  idemKey,
  isoDay,
} from './support/tournaments';

describe('tournaments: lifecycle, assistants, entries, fees (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const get = (id: string, u?: { auth: { Authorization: string } }) => {
    const r = t.http().get(`/v1/tournaments/${id}`);
    return u ? r.set(u.auth) : r;
  };

  async function club(): Promise<{
    owner: Awaited<ReturnType<typeof createUser>>;
    clubId: string;
  }> {
    const owner = await createUser(t);
    return { owner, clubId: await createClubRow(t, owner) };
  }

  it('creates idempotently, keeps drafts private, publishes without entries and guards versions', async () => {
    const org = await createUser(t);
    const stranger = await createUser(t);
    const key = idemKey();
    const body = {
      name: `Idem ${key}`,
      city: 'Testville',
      timezone: 'Asia/Tbilisi',
      duration: 'ONE_DAY',
      startsOn: isoDay(20),
      formatPlayers: 7,
      feeMode: 'PER_CLUB',
      feeMinor: 30000,
      maxClubs: 8,
    };
    const a = await t
      .http()
      .post('/v1/tournaments')
      .set(org.auth)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const b = await t
      .http()
      .post('/v1/tournaments')
      .set(org.auth)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await t.prisma.tournament.count({ where: { organiserId: org.userId } })).toBe(1);
    expect(a.body.status).toBe('DRAFT');
    expect(a.body.organiser.id).toBe(org.userId);
    expect(a.body.capabilities).toMatchObject({
      canManage: true,
      canPublish: true,
      canEnter: false,
    });

    // validation
    await t
      .http()
      .post('/v1/tournaments')
      .set(org.auth)
      .send({ ...body, feeMode: 'FREE', feeMinor: 100 })
      .expect(400);
    await t
      .http()
      .post('/v1/tournaments')
      .set(org.auth)
      .send({ ...body, formatPlayers: 4 })
      .expect(400);
    await t
      .http()
      .post('/v1/tournaments')
      .set(org.auth)
      .send({ ...body, duration: 'MULTI_DAY' })
      .expect(400);
    await t
      .http()
      .post('/v1/tournaments')
      .set(org.auth)
      .send({ ...body, timezone: 'Mars/Base' })
      .expect(400);
    await t
      .http()
      .post('/v1/tournaments')
      .set(org.auth)
      .send({ ...body, minClubs: 9 })
      .expect(400);

    // draft: invisible to others (existence not revealed)
    await get(a.body.id, stranger).expect(404);
    await get(a.body.id).expect(404);
    await get(a.body.id, org).expect(200);

    // publish needs no entries/consents/bookings; idempotent
    const p = await t.http().post(`/v1/tournaments/${a.body.id}/publish`).set(org.auth).expect(200);
    expect(p.body.status).toBe('REGISTRATION_OPEN');
    await t.http().post(`/v1/tournaments/${a.body.id}/publish`).set(org.auth).expect(200);
    await t.http().post(`/v1/tournaments/${a.body.id}/publish`).set(stranger.auth).expect(403);
    const pub = await get(a.body.id).expect(200);
    expect(pub.body.label).toBe('REGISTRATION_OPEN');
    expect(pub.body.counters).toBeNull();

    // optimistic concurrency
    const v = p.body.version as number;
    await t
      .http()
      .patch(`/v1/tournaments/${a.body.id}`)
      .set(org.auth)
      .send({ version: v, name: 'Renamed' })
      .expect(200);
    const stale = await t
      .http()
      .patch(`/v1/tournaments/${a.body.id}`)
      .set(org.auth)
      .send({ version: v, name: 'Again' })
      .expect(409);
    expect(stale.body.error.code).toBe('VERSION_CHANGED');
    await t
      .http()
      .patch(`/v1/tournaments/${a.body.id}`)
      .set(stranger.auth)
      .send({ version: v + 1, name: 'Hack' })
      .expect(403);
  });

  it('runs the state machine and refuses illegal transitions', async () => {
    const org = await createUser(t);
    const { id } = await createTournament(t, org, { minClubs: 2 });
    const post = (path: string, body: object = {}) =>
      t.http().post(`/v1/tournaments/${id}/${path}`).set(org.auth).send(body);
    await post('finish').expect(409); // not live
    expect((await post('close-registration').expect(200)).body.status).toBe('REGISTRATION_CLOSED');
    await post('close-registration').expect(200); // idempotent
    expect((await post('open-registration').expect(200)).body.status).toBe('REGISTRATION_OPEN');
    const pp = await post('postpone', { reason: 'weather', startsOn: isoDay(40) }).expect(200);
    expect(pp.body.status).toBe('POSTPONED');
    expect(pp.body.startsOn).toBe(isoDay(40));
    expect((await post('resume').expect(200)).body.status).toBe('REGISTRATION_OPEN');
    const c = await post('cancel', { reason: 'no venue' }).expect(200);
    expect(c.body.status).toBe('CANCELLED'); // distinct from FINISHED
    await post('cancel').expect(200);
    await post('open-registration').expect(409);
    await post('finish').expect(409);
  });

  it('assistants: only after publication, module scope only, at most two', async () => {
    const org = await createUser(t);
    const [a1, a2, a3] = [await createUser(t), await createUser(t), await createUser(t)];
    const draft = await createTournament(t, org, { publish: false });
    await t
      .http()
      .post(`/v1/tournaments/${draft.id}/assistants`)
      .set(org.auth)
      .send({ userId: a1.userId, permissions: ['tournament.applications'] })
      .expect(409);

    const { id } = await createTournament(t, org);
    const appoint = (u: { userId: string }, permissions: string[], by = org) =>
      t
        .http()
        .post(`/v1/tournaments/${id}/assistants`)
        .set(by.auth)
        .send({ userId: u.userId, permissions });
    // tournament.manage can never be handed out
    await appoint(a1, ['tournament.manage']).expect(400);
    // only the organiser appoints
    await appoint(a1, ['tournament.applications'], a2).expect(403);
    const r1 = await appoint(a1, ['tournament.applications', 'tournament.sponsors']).expect(200);
    expect(r1.body.items[0].permissions.sort()).toEqual([
      'tournament.applications',
      'tournament.sponsors',
    ]);
    await appoint(a1, ['tournament.applications']).expect(200); // idempotent
    await appoint(a2, ['tournament.protocols']).expect(200);
    const third = await appoint(a3, ['tournament.cash']).expect(409);
    expect(third.body.error.message).toMatch(/two assistants/);

    // scope: a1 reads applications and edits sponsors, but cannot edit/cancel/record results
    await t.http().get(`/v1/tournaments/${id}/entries`).set(a1.auth).expect(200);
    await t
      .http()
      .post(`/v1/tournaments/${id}/sponsors`)
      .set(a1.auth)
      .send({ name: 'Partner' })
      .expect(201);
    await t.http().get(`/v1/tournaments/${id}/entries`).set(a2.auth).expect(403);
    await t
      .http()
      .patch(`/v1/tournaments/${id}`)
      .set(a1.auth)
      .send({ version: 99, name: 'xx' })
      .expect(403);
    await t.http().post(`/v1/tournaments/${id}/cancel`).set(a1.auth).expect(403);
    await t
      .http()
      .post(`/v1/tournaments/${id}/stages`)
      .set(a1.auth)
      .send({ name: 's', kind: 'LEAGUE', config: {} })
      .expect(403);
    const detail = await get(id, a1).expect(200);
    expect(detail.body.capabilities).toMatchObject({
      canManage: false,
      canManageApplications: true,
      canEditSponsors: true,
      canRecordResults: false,
      canSchedule: false,
    });
    // a stray tournament.manage grant is ignored: manage is structural
    await t.prisma.roleGrant.create({
      data: {
        granteeId: a3.userId,
        resourceType: 'TOURNAMENT',
        resourceId: id,
        permission: 'tournament.manage',
        grantedById: org.userId,
      },
    });
    await t.http().post(`/v1/tournaments/${id}/cancel`).set(a3.auth).expect(403);

    // dismiss frees a place
    const d = await t
      .http()
      .delete(`/v1/tournaments/${id}/assistants/${a2.userId}`)
      .set(org.auth)
      .expect(200);
    expect(d.body.revoked).toBe(1);
    await appoint(a3, ['tournament.cash']).expect(200);
    await t.http().get(`/v1/tournaments/${id}/entries`).set(a2.auth).expect(403);
  });

  it('entry rights: only a representative with club.tournaments.enter may enter; retries are idempotent', async () => {
    const org = await createUser(t);
    const { id } = await createTournament(t, org, { maxClubs: 4 });
    const { owner, clubId } = await club();
    const coach = await createUser(t);
    const delegate = await createUser(t);
    await grantClub(t, clubId, owner, delegate, 'club.tournaments.enter');
    await grantClub(t, clubId, owner, coach, 'club.squad.manage');

    // a random user and a coach without the enter permission are refused
    const rnd = await createUser(t);
    await t.http().post(`/v1/tournaments/${id}/entries`).set(rnd.auth).send({ clubId }).expect(403);
    await t
      .http()
      .post(`/v1/tournaments/${id}/entries`)
      .set(coach.auth)
      .send({ clubId })
      .expect(403);
    await t
      .http()
      .post(`/v1/tournaments/${id}/entries`)
      .set(owner.auth)
      .send({ clubId: '00000000-0000-4000-8000-000000000000' })
      .expect(404);

    const key = idemKey();
    const e1 = await t
      .http()
      .post(`/v1/tournaments/${id}/entries`)
      .set(delegate.auth)
      .set('Idempotency-Key', key)
      .send({ clubId })
      .expect(200);
    const e2 = await t
      .http()
      .post(`/v1/tournaments/${id}/entries`)
      .set(delegate.auth)
      .set('Idempotency-Key', key)
      .send({ clubId })
      .expect(200);
    const e3 = await t
      .http()
      .post(`/v1/tournaments/${id}/entries`)
      .set(owner.auth)
      .send({ clubId })
      .expect(200);
    expect(e1.body.status).toBe('APPLIED');
    expect(e2.body.id).toBe(e1.body.id);
    expect(e3.body.id).toBe(e1.body.id);
    expect(await t.prisma.clubEntry.count({ where: { tournamentId: id } })).toBe(1);

    // "Enter with my club" chooser + counters: applications are NOT accepted clubs
    const page = await get(id, delegate).expect(200);
    expect(page.body.viewer.enterableClubs).toEqual([
      { clubId, clubName: expect.any(String), entryStatus: 'APPLIED' },
    ]);
    expect(page.body.acceptedClubs).toBe(0);
    expect(page.body.capabilities.canEnter).toBe(false);
    const asOrg = await get(id, org).expect(200);
    expect(asOrg.body.counters).toMatchObject({ applications: 1, readyClubs: 0 });

    // only the organiser decides; players/reps cannot
    await decide(t, id, delegate, e1.body.id, 'ACCEPT').expect(403);
    const acc = await decide(t, id, org, e1.body.id, 'ACCEPT').expect(200);
    expect(acc.body.status).toBe('ACCEPTED');
    expect(acc.body.ready).toBe(false); // Accepted is not Ready
    expect((await get(id).expect(200)).body.acceptedClubs).toBe(1);

    // registration closed => cannot enter
    await t.http().post(`/v1/tournaments/${id}/close-registration`).set(org.auth).expect(200);
    const c2 = await club();
    const closed = await t
      .http()
      .post(`/v1/tournaments/${id}/entries`)
      .set(c2.owner.auth)
      .send({ clubId: c2.clubId })
      .expect(410);
    expect(closed.body.error.code).toBe('EXPIRED');
  });

  it('the last free club goes to exactly one applicant (race), overflow waitlists when open', async () => {
    const org = await createUser(t);
    const { id } = await createTournament(t, org, { maxClubs: 2 });
    const clubs = [await club(), await club(), await club()];
    const entries: string[] = [];
    for (const c of clubs) entries.push(await applyWith(t, id, c.owner, c.clubId));
    expect((await decide(t, id, org, entries[0] as string, 'ACCEPT').expect(200)).body.status).toBe(
      'ACCEPTED',
    );

    const [r1, r2] = await Promise.all([
      decide(t, id, org, entries[1] as string, 'ACCEPT'),
      decide(t, id, org, entries[2] as string, 'ACCEPT'),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('CAPACITY_CHANGED');
    expect(
      await t.prisma.clubEntry.count({ where: { tournamentId: id, status: 'ACCEPTED' } }),
    ).toBe(2);
    const card = (await get(id).expect(200)).body;
    expect(card.acceptedClubs).toBe(2);
    expect(card.openSpots).toBe(0);

    // waitlist open: an application beyond the limit is WAITLISTED, not an error
    const w = await createTournament(t, org, { maxClubs: 1, waitlistOpen: true });
    const [c1, cW] = [await club(), await club()];
    const e1 = await applyWith(t, w.id, c1.owner, c1.clubId);
    const eW = await applyWith(t, w.id, cW.owner, cW.clubId);
    await decide(t, w.id, org, e1, 'ACCEPT').expect(200);
    const wl = await decide(t, w.id, org, eW, 'ACCEPT').expect(200);
    expect(wl.body.status).toBe('WAITLISTED');
    expect((await get(w.id).expect(200)).body.label).toBe('WAITLIST_OPEN');
    // explicitly accepting a waitlisted club while full is still capacity-changed
    await decide(t, w.id, org, eW, 'ACCEPT').expect(409);
    // freeing the spot lets the organiser take the waitlisted club
    await t
      .http()
      .post(`/v1/tournaments/${w.id}/entries/${e1}/withdraw`)
      .set(c1.owner.auth)
      .expect(200);
    expect((await decide(t, w.id, org, eW, 'ACCEPT').expect(200)).body.status).toBe('ACCEPTED');
  });

  it('targeted invitation holds a spot, coexists with applications and is answered by the club', async () => {
    const org = await createUser(t);
    const { id } = await createTournament(t, org, { maxClubs: 2 });
    const [inv, open, late] = [await club(), await club(), await club()];
    const invited = await t
      .http()
      .post(`/v1/tournaments/${id}/club-invitations`)
      .set(org.auth)
      .send({ clubId: inv.clubId })
      .expect(200);
    expect(invited.body.status).toBe('INVITED');
    // the invited club's representative was notified (essential)
    expect(
      await t.prisma.notification.count({
        where: { recipientId: inv.owner.userId, category: 'tournament' },
      }),
    ).toBe(1);
    const card = (await get(id).expect(200)).body;
    expect(card.acceptedClubs).toBe(0);
    expect(card.openSpots).toBe(1); // max 2 - accepted 0 - held 1
    const eOpen = await applyWith(t, id, open.owner, open.clubId);
    await decide(t, id, org, eOpen, 'ACCEPT').expect(200);
    // both spots are used now (1 accepted + 1 held): a further application cannot be accepted
    const eLate = await applyWith(t, id, late.owner, late.clubId);
    await decide(t, id, org, eLate, 'ACCEPT').expect(409);
    // the invited club says yes -> Accepted, not Ready
    const yes = await t
      .http()
      .post(`/v1/tournaments/${id}/entries/${invited.body.id}/respond`)
      .set(inv.owner.auth)
      .send({ accept: true })
      .expect(200);
    expect(yes.body.status).toBe('ACCEPTED');
    // strangers cannot answer for the club
    await t
      .http()
      .post(`/v1/tournaments/${id}/entries/${invited.body.id}/respond`)
      .set(late.owner.auth)
      .send({ accept: false })
      .expect(403);
  });

  it('start refuses with a concrete problem list and changes nothing; a ready field starts', async () => {
    const org = await createUser(t);
    const { id } = await createTournament(t, org, { minClubs: 2, minPlayersPerClub: 1 });
    const [c1, c2] = [await club(), await club()];
    const e1 = await applyWith(t, id, c1.owner, c1.clubId);
    await decide(t, id, org, e1, 'ACCEPT').expect(200);

    const refused = await t.http().post(`/v1/tournaments/${id}/start`).set(org.auth).expect(409);
    const codes = (refused.body.error.details.problems as { code: string }[]).map((p) => p.code);
    expect(codes).toContain('NOT_ENOUGH_CLUBS');
    expect(codes).toContain('SQUAD_TOO_SMALL');
    expect((await get(id).expect(200)).body.status).toBe('REGISTRATION_OPEN');

    const e2 = await applyWith(t, id, c2.owner, c2.clubId);
    await decide(t, id, org, e2, 'ACCEPT').expect(200);
    for (const [c, e] of [
      [c1, e1],
      [c2, e2],
    ] as const) {
      await t
        .http()
        .post(`/v1/tournaments/${id}/entries/${e}/players`)
        .set(c.owner.auth)
        .send({ userIds: [c.owner.userId] })
        .expect(200);
      await t.http().post(`/v1/tournaments/${id}/players/me/confirm`).set(c.owner.auth).expect(200);
    }
    const ok = await t.http().post(`/v1/tournaments/${id}/start`).set(org.auth).expect(200);
    expect(ok.body.status).toBe('LIVE');
    expect((await get(id, org).expect(200)).body.counters.readyClubs).toBe(2);
    await t.http().post(`/v1/tournaments/${id}/start`).set(org.auth).expect(200); // idempotent
    // after the start a club cannot just leave; the organiser decides
    await t
      .http()
      .post(`/v1/tournaments/${id}/entries/${e1}/withdraw`)
      .set(c1.owner.auth)
      .expect(409);
  });

  it('fees: club fee on acceptance, player fee on confirmation, cancelled on withdrawal; cancel makes paid ones refund-due', async () => {
    const org = await createUser(t);
    // PER_CLUB
    const pc = await createTournament(t, org, { feeMode: 'PER_CLUB', feeMinor: 30000 });
    const c1 = await club();
    const e1 = await applyWith(t, pc.id, c1.owner, c1.clubId);
    expect(await t.prisma.paymentObligation.count({ where: { tournamentId: pc.id } })).toBe(0); // application is not debt
    await decide(t, pc.id, org, e1, 'ACCEPT').expect(200);
    const ob = await t.prisma.paymentObligation.findFirstOrThrow({
      where: { tournamentId: pc.id, payerClubId: c1.clubId },
    });
    expect(ob).toMatchObject({ kind: 'TOURNAMENT_CLUB_FEE', amountMinor: 30000, status: 'OPEN' });
    await t
      .http()
      .post(`/v1/tournaments/${pc.id}/entries/${e1}/withdraw`)
      .set(c1.owner.auth)
      .expect(200);
    expect(
      (await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: ob.id } })).status,
    ).toBe('CANCELLED');
    // re-applying and being accepted again reopens the same obligation, no duplicate
    await applyWith(t, pc.id, c1.owner, c1.clubId);
    await decide(t, pc.id, org, e1, 'ACCEPT').expect(200);
    expect(
      await t.prisma.paymentObligation.count({
        where: { tournamentId: pc.id, payerClubId: c1.clubId },
      }),
    ).toBe(1);
    expect(
      (await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: ob.id } })).status,
    ).toBe('OPEN');

    // cash received by the tournament's receiver -> paid; cancelling the tournament => REFUND_DUE
    await t
      .http()
      .post(`/v1/payments/obligations/${ob.id}/cash-received`)
      .set(org.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(200);
    const c2 = await club();
    const e2 = await applyWith(t, pc.id, c2.owner, c2.clubId);
    await decide(t, pc.id, org, e2, 'ACCEPT').expect(200);
    const ob2 = await t.prisma.paymentObligation.findFirstOrThrow({
      where: { tournamentId: pc.id, payerClubId: c2.clubId },
    });
    await t
      .http()
      .post(`/v1/tournaments/${pc.id}/cancel`)
      .set(org.auth)
      .send({ reason: 'venue lost' })
      .expect(200);
    const paid = await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: ob.id } });
    expect(paid).toMatchObject({
      status: 'CANCELLED',
      paidMinor: 30000,
      refundDueMinor: 30000,
      refundedMinor: 0,
    });
    expect(
      await t.prisma.adjustment.count({ where: { obligationId: ob.id, type: 'REFUND_DUE' } }),
    ).toBe(1);
    expect(
      (await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: ob2.id } })).status,
    ).toBe('CANCELLED');
    expect(
      (await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: ob2.id } }))
        .refundDueMinor,
    ).toBe(0);
    // the club rep was told (essential notification) and history stays readable
    expect(
      await t.prisma.notification.count({
        where: { recipientId: c2.owner.userId, title: { contains: 'cancelled' } },
      }),
    ).toBeGreaterThan(0);
    expect((await get(pc.id).expect(200)).body.status).toBe('CANCELLED');

    // PER_PLAYER: obligation appears when the player confirms (entry accepted), and vanishes when he declines
    const pp = await createTournament(t, org, { feeMode: 'PER_PLAYER', feeMinor: 1500 });
    const c3 = await club();
    const p1 = await createUser(t);
    await addMember(t, c3.clubId, p1);
    const e3 = await applyWith(t, pp.id, c3.owner, c3.clubId);
    await decide(t, pp.id, org, e3, 'ACCEPT').expect(200);
    await t
      .http()
      .post(`/v1/tournaments/${pp.id}/entries/${e3}/players`)
      .set(c3.owner.auth)
      .send({ userIds: [p1.userId] })
      .expect(200);
    expect(await t.prisma.paymentObligation.count({ where: { tournamentId: pp.id } })).toBe(0);
    await t.http().post(`/v1/tournaments/${pp.id}/players/me/confirm`).set(p1.auth).expect(200);
    const pob = await t.prisma.paymentObligation.findFirstOrThrow({
      where: { tournamentId: pp.id, payerUserId: p1.userId },
    });
    expect(pob).toMatchObject({ kind: 'TOURNAMENT_PLAYER_FEE', amountMinor: 1500 });
    const view = await get(pp.id, p1).expect(200);
    expect(view.body.viewer.obligations).toHaveLength(1);
    await t.http().post(`/v1/tournaments/${pp.id}/players/me/decline`).set(p1.auth).expect(200);
    expect(
      (await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: pob.id } })).status,
    ).toBe('CANCELLED');
  });

  it('list: Upcoming hides finished/cancelled, Any time shows them; private tournaments stay private', async () => {
    const org = await createUser(t);
    const city = `City${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const open = await createTournament(t, org, { city, formatPlayers: 7 });
    const cancelled = await createTournament(t, org, { city });
    await t.http().post(`/v1/tournaments/${cancelled.id}/cancel`).set(org.auth).expect(200);
    const priv = await createTournament(t, org, { city, isPublic: false });
    await createTournament(t, org, { city, publish: false });

    const ids = (r: { body: { items: { id: string }[] } }) => r.body.items.map((i) => i.id);
    const up = await t.http().get('/v1/tournaments').query({ city }).expect(200);
    expect(ids(up)).toEqual([open.id]);
    const any = await t.http().get('/v1/tournaments').query({ city, when: 'ANY' }).expect(200);
    expect(ids(any).sort()).toEqual([open.id, cancelled.id].sort());
    expect(any.body.items.find((i: { id: string }) => i.id === cancelled.id).label).toBe(
      'CANCELLED',
    );
    expect(ids(await t.http().get('/v1/tournaments').query({ city, formats: '7' }))).toEqual([
      open.id,
    ]);
    expect(ids(await t.http().get('/v1/tournaments').query({ city, formats: '9' }))).toEqual([]);

    // mine: organiser sees own private + draft; anonymous / others do not see private
    const mine = await t
      .http()
      .get('/v1/tournaments')
      .set(org.auth)
      .query({ city, mine: 'true', when: 'ANY' })
      .expect(200);
    expect(mine.body.items).toHaveLength(4);
    const other = await createUser(t);
    await get(priv.id, other).expect(404);
    // once a club of the other user is invited it becomes visible to that involved person
    const oc = await club();
    await t
      .http()
      .post(`/v1/tournaments/${priv.id}/club-invitations`)
      .set(org.auth)
      .send({ clubId: oc.clubId })
      .expect(200);
    await get(priv.id, oc.owner).expect(200);

    // keyset pagination
    const p1 = await t
      .http()
      .get('/v1/tournaments')
      .query({ city, when: 'ANY', limit: 1 })
      .expect(200);
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.nextCursor).toEqual(expect.any(String));
    const p2 = await t
      .http()
      .get('/v1/tournaments')
      .query({ city, when: 'ANY', limit: 1, cursor: p1.body.nextCursor })
      .expect(200);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
  });
});
