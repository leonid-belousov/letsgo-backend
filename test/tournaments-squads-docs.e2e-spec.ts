import { createTestApp, type TestApp } from './support/app';
import { createUser, type TestUser } from './support/factories';
import {
  addMember,
  applyWith,
  createClubRow,
  createTournament,
  decide,
  idemKey,
  mediaRow,
} from './support/tournaments';

describe('tournaments: squads, age, documents, sponsors (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  async function acceptedClub(tid: string, org: TestUser) {
    const owner = await createUser(t);
    const clubId = await createClubRow(t, owner);
    const entryId = await applyWith(t, tid, owner, clubId);
    await decide(t, tid, org, entryId, 'ACCEPT').expect(200);
    return { owner, clubId, entryId };
  }
  const invite = (
    tid: string,
    c: { owner: TestUser; entryId: string },
    userIds: string[],
    isGuest?: boolean,
  ) =>
    t
      .http()
      .post(`/v1/tournaments/${tid}/entries/${c.entryId}/players`)
      .set(c.owner.auth)
      .set('Idempotency-Key', idemKey())
      .send({ userIds, isGuest });
  const confirm = (tid: string, u: TestUser) =>
    t.http().post(`/v1/tournaments/${tid}/players/me/confirm`).set(u.auth);

  it('one squad per person per tournament, membership, privacy and blocks are honoured', async () => {
    const org = await createUser(t);
    const { id } = await createTournament(t, org, { maxPlayersPerClub: 2 });
    const a = await acceptedClub(id, org);
    const b = await acceptedClub(id, org);
    const p = await createUser(t);
    await addMember(t, a.clubId, p);
    await addMember(t, b.clubId, p);

    const first = await invite(id, a, [p.userId]).expect(200);
    expect(first.body.invited).toHaveLength(1);
    expect(first.body.invited[0].person.id).toBe(p.userId);
    // same person in a second club's squad -> CONFLICT (unique per tournament)
    const dup = await invite(id, b, [p.userId]).expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');
    // repeating in the same squad is harmless
    const again = await invite(id, a, [p.userId]).expect(200);
    expect(again.body.invited).toHaveLength(0);
    expect(again.body.skipped).toEqual([{ userId: p.userId, reason: 'ALREADY_IN_SQUAD' }]);
    // a race between the two clubs: at most one row ever exists
    const q = await createUser(t);
    await addMember(t, a.clubId, q);
    await addMember(t, b.clubId, q);
    const [r1, r2] = await Promise.all([invite(id, a, [q.userId]), invite(id, b, [q.userId])]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(
      await t.prisma.clubEntryPlayer.count({ where: { tournamentId: id, userId: q.userId } }),
    ).toBe(1);

    // declining releases the person for another club
    await t.http().post(`/v1/tournaments/${id}/players/me/decline`).set(p.auth).expect(200);
    const moved = await invite(id, b, [p.userId]).expect(200);
    expect(moved.body.invited).toHaveLength(1);
    expect(
      await t.prisma.clubEntryPlayer.count({ where: { tournamentId: id, userId: p.userId } }),
    ).toBe(1);

    // non-members are refused unless invited as guests (guests keep their own club)
    const stranger = await createUser(t);
    const noGuest = await invite(id, a, [stranger.userId]).expect(200);
    expect(noGuest.body.skipped[0].reason).toBe('NOT_A_MEMBER');
    const guest = await invite(id, a, [stranger.userId], true).expect(200);
    expect(guest.body.invited[0]).toMatchObject({ isGuest: true, status: 'INVITED' });
    expect(
      await t.prisma.membership.count({ where: { userId: stranger.userId, clubId: a.clubId } }),
    ).toBe(0);

    // the maximum squad size is enforced
    const extra = await createUser(t);
    await addMember(t, a.clubId, extra);
    await invite(id, a, [extra.userId]).expect(409); // p? no: q + guest already fill 2 places

    // privacy: invitationPolicy NOBODY and blocks are respected
    const c = await acceptedClub(id, org);
    const shy = await createUser(t);
    await addMember(t, c.clubId, shy);
    await t.prisma.privacyPolicy.update({
      where: { userId: shy.userId },
      data: { invitationPolicy: 'NOBODY' },
    });
    const blocker = await createUser(t);
    await addMember(t, c.clubId, blocker);
    await t.prisma.block.create({ data: { blockerId: blocker.userId, blockedId: c.owner.userId } });
    const res = await invite(id, c, [shy.userId, blocker.userId]).expect(200);
    expect(res.body.invited).toHaveLength(0);
    expect(res.body.skipped.map((s: { reason: string }) => s.reason)).toEqual([
      'NOT_ALLOWED',
      'NOT_ALLOWED',
    ]);

    // only a club actor may manage the squad
    await t
      .http()
      .post(`/v1/tournaments/${id}/entries/${c.entryId}/players`)
      .set(stranger.auth)
      .send({ userIds: [shy.userId] })
      .expect(403);
    await t
      .http()
      .get(`/v1/tournaments/${id}/entries/${a.entryId}/squad`)
      .set(stranger.auth)
      .expect(404);
    const squad = await t
      .http()
      .get(`/v1/tournaments/${id}/entries/${a.entryId}/squad`)
      .set(a.owner.auth)
      .expect(200);
    expect(squad.body.players.length).toBe(2);
    await t
      .http()
      .delete(`/v1/tournaments/${id}/entries/${a.entryId}/players/${stranger.userId}`)
      .set(a.owner.auth)
      .expect(200);
    expect(
      await t.prisma.clubEntryPlayer.count({
        where: { tournamentId: id, userId: stranger.userId, status: 'REMOVED' },
      }),
    ).toBe(1);
  });

  it('age band: only one; younger players need an individual organiser exception that invitations never bypass', async () => {
    const org = await createUser(t);
    const strict = await createTournament(t, org, { ageBand: 'A35', allowYounger: false });
    const loose = await createTournament(t, org, { ageBand: 'A35', allowYounger: true });
    const young = await createUser(t, { dob: '2000-01-01' });
    const old = await createUser(t, { dob: '1980-01-01' });

    const s = await acceptedClub(strict.id, org);
    await addMember(t, s.clubId, young);
    await addMember(t, s.clubId, old);
    const sr = await invite(strict.id, s, [young.userId, old.userId]).expect(200);
    expect(sr.body.skipped).toEqual([{ userId: young.userId, reason: 'AGE_NOT_ALLOWED' }]);
    await confirm(strict.id, old).expect(200);

    const l = await acceptedClub(loose.id, org);
    await addMember(t, l.clubId, young);
    const lr = await invite(loose.id, l, [young.userId], true).expect(200); // guest flag does not help either
    expect(lr.body.invited[0]).toMatchObject({
      ageEligibility: 'EXCEPTION_REQUIRED',
      ageExceptionApproved: false,
    });
    // the organiser was told to decide
    expect(
      await t.prisma.notification.count({
        where: { recipientId: org.userId, title: { contains: 'age exception' } },
      }),
    ).toBe(1);
    const pending = await confirm(loose.id, young).expect(409);
    expect(pending.body.error.details.reason).toBe('AGE_EXCEPTION_PENDING');
    // neither the rep nor the player can approve; only the chief organiser
    const path = `/v1/tournaments/${loose.id}/entries/${l.entryId}/players/${young.userId}/age-exception`;
    await t.http().post(path).set(l.owner.auth).send({ approve: true }).expect(403);
    await t.http().post(path).set(young.auth).send({ approve: true }).expect(403);
    await t
      .http()
      .post(path)
      .set(org.auth)
      .send({ approve: true, reason: 'known player' })
      .expect(200);
    expect((await confirm(loose.id, young).expect(200)).body.status).toBe('CONFIRMED');
    expect(
      await t.prisma.auditEvent.count({
        where: { action: 'tournament.age_exception.approve', actorId: org.userId },
      }),
    ).toBeGreaterThan(0);

    // a refusal removes the player
    const other = await createUser(t, { dob: '2001-01-01' });
    await addMember(t, l.clubId, other);
    await invite(loose.id, l, [other.userId]).expect(200);
    await t
      .http()
      .post(
        `/v1/tournaments/${loose.id}/entries/${l.entryId}/players/${other.userId}/age-exception`,
      )
      .set(org.auth)
      .send({ approve: false })
      .expect(200);
    expect(
      (await t.http().get(`/v1/tournaments/${loose.id}/players/me`).set(other.auth).expect(200))
        .body.status,
    ).toBe('REMOVED');
  });

  it('documents: assigned per role, personal consent, new version needs new consent while history stays', async () => {
    const org = await createUser(t);
    const { id } = await createTournament(t, org, { minPlayersPerClub: 1 });
    const c = await acceptedClub(id, org);
    const player = await createUser(t);
    await addMember(t, c.clubId, player);
    await invite(id, c, [player.userId]).expect(200);
    await confirm(id, player).expect(200);

    const file = await mediaRow(t, org, 'DOCUMENT');
    const mk = (body: object) =>
      t
        .http()
        .post(`/v1/tournaments/${id}/documents`)
        .set(org.auth)
        .send({ mandatory: true, fileMediaId: file, ...body });
    // media rules
    const pdfOfPlayer = await mediaRow(t, player, 'DOCUMENT');
    const pendingPdf = await mediaRow(t, org, 'DOCUMENT', 'UPLOADING');
    const videoFile = await mediaRow(t, org, 'VIDEO');
    await t
      .http()
      .post(`/v1/tournaments/${id}/documents`)
      .set(org.auth)
      .send({ title: 'x', audience: 'BOTH', fileMediaId: pdfOfPlayer })
      .expect(400);
    await t
      .http()
      .post(`/v1/tournaments/${id}/documents`)
      .set(org.auth)
      .send({ title: 'x', audience: 'BOTH', fileMediaId: pendingPdf })
      .expect(422);
    await t
      .http()
      .post(`/v1/tournaments/${id}/documents`)
      .set(org.auth)
      .send({ title: 'x', audience: 'BOTH', fileMediaId: videoFile })
      .expect(400);
    await t
      .http()
      .post(`/v1/tournaments/${id}/documents`)
      .set(player.auth)
      .send({ title: 'x', audience: 'BOTH', fileMediaId: file })
      .expect(403);

    const both = (await mk({ title: 'Regulations', audience: 'BOTH', language: 'en' }).expect(201))
      .body;
    const playersOnly = (
      await mk({ title: 'Consent', audience: 'PLAYERS', language: 'ru' }).expect(201)
    ).body;
    const repsOnly = (
      await mk({ title: 'Entry terms', audience: 'CLUB_REPS', language: 'ka' }).expect(201)
    ).body;
    expect(both.currentVersion.version).toBe(1);

    // each person sees only what is assigned to his role
    const asPlayer = await t
      .http()
      .get(`/v1/tournaments/${id}/documents-required`)
      .set(player.auth)
      .expect(200);
    expect(asPlayer.body.map((d: { title: string }) => d.title).sort()).toEqual([
      'Consent',
      'Regulations',
    ]);
    const asRep = await t
      .http()
      .get(`/v1/tournaments/${id}/documents-required`)
      .set(c.owner.auth)
      .expect(200);
    expect(asRep.body.map((d: { title: string }) => d.title).sort()).toEqual([
      'Entry terms',
      'Regulations',
    ]);
    const nobody = await createUser(t);
    expect(
      (await t.http().get(`/v1/tournaments/${id}/documents-required`).set(nobody.auth).expect(200))
        .body,
    ).toEqual([]);

    // readiness is blocked until consents exist (opening the file is not consent)
    const readyNow = async () =>
      (await t.http().get(`/v1/tournaments/${id}/entries/${c.entryId}`).set(org.auth).expect(200))
        .body;
    let e = await readyNow();
    expect(e.ready).toBe(false);
    expect(e.problems.map((p: { code: string }) => p.code).sort()).toEqual([
      'REP_CONSENT_MISSING',
      'SQUAD_TOO_SMALL',
    ]);

    const consent = (
      u: TestUser,
      doc: { id: string; currentVersion: { id: string } },
      key = idemKey(),
    ) =>
      t
        .http()
        .post(`/v1/tournaments/${id}/documents/${doc.id}/consent`)
        .set(u.auth)
        .set('Idempotency-Key', key)
        .send({ versionId: doc.currentVersion.id });
    // a representative can NEVER consent for players
    const denied = await consent(c.owner, playersOnly).expect(403);
    expect(denied.body.error.details.reason).toBe('NOT_IN_AUDIENCE');
    await consent(player, repsOnly).expect(403);
    await consent(nobody, both).expect(403);
    // the rep's consent to a BOTH document does not count for the player
    const k = idemKey();
    const rc = await consent(c.owner, both, k).expect(200);
    expect(rc.body.role).toBe('CLUB_REP');
    expect((await consent(c.owner, both, k).expect(200)).body.id).toBe(rc.body.id);
    await consent(c.owner, repsOnly).expect(200);
    e = await readyNow();
    expect(e.problems.map((p: { code: string }) => p.code)).toEqual(['SQUAD_TOO_SMALL']);
    expect((await consent(player, both).expect(200)).body.role).toBe('PLAYER');
    await consent(player, playersOnly).expect(200);
    e = await readyNow();
    expect(e.ready).toBe(true);
    expect(e.squad).toMatchObject({ confirmed: 1, eligible: 1 });

    // consents are immutable
    await expect(
      t.prisma.consent.update({ where: { id: rc.body.id }, data: { role: 'PLAYER' } }),
    ).rejects.toBeDefined();
    await expect(t.prisma.consent.delete({ where: { id: rc.body.id } })).rejects.toBeDefined();

    // new version of a mandatory document: readiness drops, old consents stay, a stale version id is refused
    const v2File = await mediaRow(t, org, 'DOCUMENT');
    const ver = await t
      .http()
      .post(`/v1/tournaments/${id}/documents/${both.id}/versions`)
      .set(org.auth)
      .send({ fileMediaId: v2File })
      .expect(201);
    expect(ver.body.currentVersion.version).toBe(2);
    expect(ver.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(
      await t.prisma.notification.count({
        where: { recipientId: player.userId, title: { contains: 'new version' } },
      }),
    ).toBe(1);
    e = await readyNow();
    expect(e.ready).toBe(false);
    expect(e.problems.map((p: { code: string }) => p.code).sort()).toEqual([
      'REP_CONSENT_MISSING',
      'SQUAD_TOO_SMALL',
    ]);
    expect(await t.prisma.consent.count({ where: { userId: player.userId } })).toBe(2); // history kept
    const stale = await t
      .http()
      .post(`/v1/tournaments/${id}/documents/${both.id}/consent`)
      .set(player.auth)
      .send({ versionId: both.currentVersion.id })
      .expect(409);
    expect(stale.body.error.code).toBe('VERSION_CHANGED');
    const req = await t
      .http()
      .get(`/v1/tournaments/${id}/documents-required`)
      .set(player.auth)
      .expect(200);
    expect(req.body.find((d: { title: string }) => d.title === 'Regulations')).toMatchObject({
      accepted: false,
      acceptedOlderVersion: true,
    });

    // organiser's matrix + explicit reminder
    const matrix = await t
      .http()
      .get(`/v1/tournaments/${id}/consents/matrix`)
      .set(org.auth)
      .expect(200);
    expect(matrix.body.missingPeople).toBe(2);
    const row = matrix.body.entries[0].people.find((x: { role: string }) => x.role === 'PLAYER');
    expect(row.missingDocumentIds).toEqual([both.id]);
    await t.http().get(`/v1/tournaments/${id}/consents/matrix`).set(player.auth).expect(403);
    const rem = await t
      .http()
      .post(`/v1/tournaments/${id}/consents/remind`)
      .set(org.auth)
      .set('Idempotency-Key', idemKey())
      .send({ documentId: both.id })
      .expect(200);
    expect(rem.body.reminded).toBe(2);
    await t
      .http()
      .post(`/v1/tournaments/${id}/consents/remind`)
      .set(player.auth)
      .send({})
      .expect(403);

    await consent(player, ver.body).expect(200);
    await consent(c.owner, ver.body).expect(200);
    e = await readyNow();
    expect(e.ready).toBe(true);
    expect(
      (await t.http().get(`/v1/tournaments/${id}/consents/matrix`).set(org.auth).expect(200)).body
        .missingPeople,
    ).toBe(0);
  });

  it('sponsors: editable in every stage incl. LIVE/FINISHED, one Main sponsor on the card, no re-consent', async () => {
    const org = await createUser(t);
    const helper = await createUser(t);
    const outsider = await createUser(t);
    const city = `SpCity${Date.now()}`;
    const { id } = await createTournament(t, org, { city });
    const other = await createTournament(t, org);
    await t
      .http()
      .post(`/v1/tournaments/${id}/assistants`)
      .set(org.auth)
      .send({ userId: helper.userId, permissions: ['tournament.sponsors'] })
      .expect(200);
    const doc = await mediaRow(t, org, 'DOCUMENT');
    await t
      .http()
      .post(`/v1/tournaments/${id}/documents`)
      .set(org.auth)
      .send({ title: 'Rules', audience: 'BOTH', fileMediaId: doc })
      .expect(201);
    const consentsBefore = await t.prisma.consent.count();

    const logo = await mediaRow(t, org, 'PHOTO');
    const helperLogo = await mediaRow(t, helper);
    const s1 = (
      await t
        .http()
        .post(`/v1/tournaments/${id}/sponsors`)
        .set(org.auth)
        .send({ name: 'Partner One', logoMediaId: logo, externalUrl: 'https://example.test/one' })
        .expect(201)
    ).body;
    const s2 = (
      await t
        .http()
        .post(`/v1/tournaments/${id}/sponsors`)
        .set(helper.auth)
        .send({ name: 'Partner Two' })
        .expect(201)
    ).body;
    await t
      .http()
      .post(`/v1/tournaments/${id}/sponsors`)
      .set(outsider.auth)
      .send({ name: 'Nope' })
      .expect(403);
    await t
      .http()
      .post(`/v1/tournaments/${id}/sponsors`)
      .set(org.auth)
      .send({ name: 'Bad', externalUrl: 'javascript:alert(1)' })
      .expect(400);
    await t
      .http()
      .post(`/v1/tournaments/${id}/sponsors`)
      .set(org.auth)
      .send({ name: 'Bad', logoMediaId: helperLogo })
      .expect(400);

    // the card shows only the Main sponsor; it must belong to this tournament and not be hidden
    expect((await t.http().get(`/v1/tournaments/${id}`).expect(200)).body.mainSponsor).toBeNull();
    const foreign = (
      await t
        .http()
        .post(`/v1/tournaments/${other.id}/sponsors`)
        .set(org.auth)
        .send({ name: 'Elsewhere' })
        .expect(201)
    ).body;
    await t
      .http()
      .put(`/v1/tournaments/${id}/sponsors/main`)
      .set(org.auth)
      .send({ sponsorId: foreign.id })
      .expect(404);
    await t
      .http()
      .put(`/v1/tournaments/${id}/sponsors/main`)
      .set(helper.auth)
      .send({ sponsorId: s2.id })
      .expect(200);
    let card = (await t.http().get(`/v1/tournaments/${id}`).expect(200)).body;
    expect(card.mainSponsor).toMatchObject({ id: s2.id, name: 'Partner Two' });
    await t
      .http()
      .put(`/v1/tournaments/${id}/sponsors/main`)
      .set(org.auth)
      .send({ sponsorId: s1.id })
      .expect(200);
    card = (await t.http().get(`/v1/tournaments/${id}`).expect(200)).body;
    expect(card.mainSponsor.id).toBe(s1.id);
    const list = await t.http().get('/v1/tournaments').query({ city }).expect(200);
    expect(list.body.items.find((i: { id: string }) => i.id === id).mainSponsor.id).toBe(s1.id);

    // stage independence: LIVE and FINISHED (set directly) do not close the editor
    for (const status of ['LIVE', 'FINISHED'] as const) {
      await t.prisma.tournament.update({ where: { id }, data: { status } });
      const m1 = await mediaRow(t, org, 'PHOTO');
      const m2 = await mediaRow(t, helper, 'VIDEO');
      const newLogo = await mediaRow(t, org);
      await t
        .http()
        .post(`/v1/tournaments/${id}/sponsors/${s2.id}/assets`)
        .set(org.auth)
        .send({ mediaId: m1 })
        .expect(200);
      const withAssets = await t
        .http()
        .post(`/v1/tournaments/${id}/sponsors/${s2.id}/assets`)
        .set(helper.auth)
        .send({ mediaId: m2 })
        .expect(200);
      expect(withAssets.body.assets.length).toBeGreaterThanOrEqual(2);
      await t
        .http()
        .patch(`/v1/tournaments/${id}/sponsors/${s2.id}`)
        .set(org.auth)
        .send({ logoMediaId: newLogo })
        .expect(200);
    }
    const s2Now = (
      await t.http().get(`/v1/tournaments/${id}/sponsors`).set(org.auth).expect(200)
    ).body.items.find((s: { id: string }) => s.id === s2.id);
    expect(s2Now.assets).toHaveLength(4);
    expect(s1.id).not.toBe(s2.id);

    // hide an asset (public no longer sees it), reorder, delete
    const firstAsset = s2Now.assets[0].id as string;
    await t
      .http()
      .patch(`/v1/tournaments/${id}/sponsors/${s2.id}/assets/${firstAsset}`)
      .set(org.auth)
      .send({ hidden: true })
      .expect(200);
    const pub = (await t.http().get(`/v1/tournaments/${id}/sponsors`).expect(200)).body.items.find(
      (s: { id: string }) => s.id === s2.id,
    );
    expect(pub.assets).toHaveLength(3);
    await t
      .http()
      .put(`/v1/tournaments/${id}/sponsors/order`)
      .set(org.auth)
      .send({ ids: [s2.id, s1.id] })
      .expect(200);
    await t
      .http()
      .put(`/v1/tournaments/${id}/sponsors/order`)
      .set(org.auth)
      .send({ ids: [s2.id] })
      .expect(400);
    expect(
      (await t.http().get(`/v1/tournaments/${id}/sponsors`).expect(200)).body.items[0].id,
    ).toBe(s2.id);
    await t
      .http()
      .delete(`/v1/tournaments/${id}/sponsors/${s2.id}/assets/${firstAsset}`)
      .set(org.auth)
      .expect(200);

    // hiding the Main sponsor clears the designation; a hidden sponsor cannot be Main
    await t
      .http()
      .patch(`/v1/tournaments/${id}/sponsors/${s1.id}`)
      .set(org.auth)
      .send({ hidden: true })
      .expect(200);
    expect((await t.http().get(`/v1/tournaments/${id}`).expect(200)).body.mainSponsor).toBeNull();
    await t
      .http()
      .put(`/v1/tournaments/${id}/sponsors/main`)
      .set(org.auth)
      .send({ sponsorId: s1.id })
      .expect(409);
    expect(
      (await t.http().get(`/v1/tournaments/${id}/sponsors`).expect(200)).body.items.map(
        (s: { id: string }) => s.id,
      ),
    ).toEqual([s2.id]);

    // no consent side effects, tournament version untouched by sponsor edits
    expect(await t.prisma.consent.count()).toBeGreaterThanOrEqual(consentsBefore);
    expect(
      await t.prisma.consent.count({ where: { version: { document: { tournamentId: id } } } }),
    ).toBe(0);
  });
});
