import { createTestApp, type TestApp } from './support/app';
import { createUser, type TestUser } from './support/factories';
import {
  applyWith,
  createClubRow,
  createTournament,
  decide,
  idemKey,
  type Json,
} from './support/tournaments';

describe('tournaments: club withdrawal after the start (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const post = (u: TestUser, path: string, body: object = {}) =>
    t
      .http()
      .post(`/v1/tournaments/${path}`)
      .set(u.auth)
      .set('Idempotency-Key', idemKey())
      .send(body);
  const fixtures = async (tid: string, u: TestUser): Promise<Json[]> =>
    (await t.http().get(`/v1/tournaments/${tid}/fixtures`).set(u.auth).expect(200)).body
      .items as Json[];
  const involving = (list: Json[], entryId: string) =>
    list.filter((f) => f.home.entryId === entryId || f.away.entryId === entryId);

  interface Club {
    entryId: string;
    clubId: string;
    owner: TestUser;
  }

  /** A live league of `n` clubs (plus optional pending applicants that stay APPLIED). */
  async function live(org: TestUser, n: number, opts: Json = {}, applicants = 0) {
    const { id } = await createTournament(t, org, opts);
    const clubs: Club[] = [];
    const mk = async (accept: boolean): Promise<Club> => {
      const owner = await createUser(t);
      const clubId = await createClubRow(t, owner);
      const entryId = await applyWith(t, id, owner, clubId);
      if (accept) await decide(t, id, org, entryId, 'ACCEPT').expect(200);
      return { entryId, clubId, owner };
    };
    for (let i = 0; i < n; i++) clubs.push(await mk(true));
    const pending: Club[] = [];
    for (let i = 0; i < applicants; i++) pending.push(await mk(false));
    const stage = (
      await post(org, `${id}/stages`, {
        name: 'League',
        kind: 'LEAGUE',
        config: { rounds: 1 },
      }).expect(201)
    ).body;
    await post(org, `${id}/stages/${stage.id}/draw`, { mode: 'RANDOM', seed: 'w' }).expect(200);
    await post(org, `${id}/stages/${stage.id}/generate`).expect(200);
    return { id, clubs, pending, stageId: stage.id as string };
  }
  const goLive = (id: string) =>
    t.prisma.tournament.update({ where: { id }, data: { status: 'LIVE' } });
  const play = (org: TestUser, tid: string, fid: string, h: number, a: number) =>
    post(org, `${tid}/fixtures/${fid}/result`, { homeScore: h, awayScore: a }).expect(200);
  const request = (tid: string, u: TestUser, entryId: string, reason = 'we cannot continue') =>
    t
      .http()
      .post(`/v1/tournaments/${tid}/entries/${entryId}/withdrawal`)
      .set(u.auth)
      .set('Idempotency-Key', idemKey())
      .send({ reason });
  const resolve = (tid: string, u: TestUser, entryId: string, wid: string, body: object) =>
    t
      .http()
      .post(`/v1/tournaments/${tid}/entries/${entryId}/withdrawals/${wid}/resolve`)
      .set(u.auth)
      .set('Idempotency-Key', idemKey())
      .send(body);

  it('request rules, permissions and validation; POSTPONE keeps played matches', async () => {
    const org = await createUser(t);
    const { id, clubs } = await live(org, 4);
    const x = clubs[0] as Club;
    // before the start the normal flow applies
    await request(id, x.owner, x.entryId).expect(409);
    await goLive(id);
    const stranger = await createUser(t);
    await request(id, stranger, x.entryId).expect(403);
    await t
      .http()
      .post(`/v1/tournaments/${id}/entries/${x.entryId}/withdrawal`)
      .set(x.owner.auth)
      .send({ reason: 'x' })
      .expect(400);
    const w1 = (await request(id, x.owner, x.entryId).expect(200)).body;
    const w2 = (await request(id, x.owner, x.entryId, 'another reason').expect(200)).body;
    expect(w2.id).toBe(w1.id); // idempotent while pending
    expect(w1).toMatchObject({ status: 'PENDING_RESOLUTION', resolution: null });
    expect(
      await t.prisma.notification.count({
        where: { recipientId: org.userId, title: { contains: 'asked to leave' } },
      }),
    ).toBe(1);
    // a request changes nothing by itself
    expect((await fixtures(id, org)).every((f) => f.status === 'SCHEDULED')).toBe(true);

    // an assistant with tournament.applications may file but never resolve
    const assistant = await createUser(t);
    await t
      .http()
      .post(`/v1/tournaments/${id}/assistants`)
      .set(org.auth)
      .send({
        userId: assistant.userId,
        permissions: ['tournament.applications', 'tournament.protocols'],
      })
      .expect(200);
    const y = clubs[1] as Club;
    const wy = (await request(id, assistant, y.entryId).expect(200)).body;
    await resolve(id, assistant, x.entryId, w1.id, {
      resolution: 'POSTPONE',
      note: 'okay fine',
    }).expect(403);
    await resolve(id, x.owner, x.entryId, w1.id, {
      resolution: 'POSTPONE',
      note: 'okay fine',
    }).expect(403);
    await resolve(id, org, x.entryId, w1.id, { resolution: 'POSTPONE' }).expect(400); // note is required
    await resolve(id, org, x.entryId, w1.id, {
      resolution: 'TECHNICAL_RESULT',
      note: 'forfeit',
    }).expect(400); // no scores => no default result
    await resolve(id, org, x.entryId, w1.id, { resolution: 'REPLACEMENT', note: 'swap' }).expect(
      400,
    );

    // play one match of X, then postpone the rest
    const played = involving(await fixtures(id, org), x.entryId)[0] as Json;
    await play(org, id, played.id, 2, 1);
    const done = (
      await resolve(id, org, x.entryId, w1.id, {
        resolution: 'POSTPONE',
        note: 'pending venue talks',
      }).expect(200)
    ).body;
    expect(done).toMatchObject({
      status: 'RESOLVED',
      resolution: 'POSTPONE',
      resolvedById: org.userId,
    });
    const fx = involving(await fixtures(id, org), x.entryId);
    expect(fx.filter((f) => f.status === 'POSTPONED')).toHaveLength(2);
    expect(fx.find((f) => f.id === played.id)).toMatchObject({
      status: 'FINISHED',
      homeScore: 2,
      awayScore: 1,
    }); // history untouched
    // other clubs' fixtures keep their status
    expect((await fixtures(id, org)).filter((f) => f.status === 'SCHEDULED')).toHaveLength(3);
    await resolve(id, org, x.entryId, w1.id, { resolution: 'POSTPONE', note: 'again' }).expect(200); // same decision: idempotent
    await resolve(id, org, x.entryId, w1.id, {
      resolution: 'END_PARTICIPATION',
      note: 'changed mind',
    }).expect(409);
    expect(
      await t.prisma.notification.count({
        where: { recipientId: x.owner.userId, title: { contains: 'left the tournament' } },
      }),
    ).toBe(1);
    expect(
      await t.prisma.auditEvent.count({
        where: { action: 'tournament.withdrawal.resolve', targetId: w1.id },
      }),
    ).toBe(1);
    const listed = await t
      .http()
      .get(`/v1/tournaments/${id}/withdrawals`)
      .set(org.auth)
      .expect(200);
    expect(listed.body.items.map((w: Json) => w.status).sort()).toEqual([
      'PENDING_RESOLUTION',
      'RESOLVED',
    ]);
    expect(wy.entryId).toBe(y.entryId);
    // a rep sees only their own club's requests; strangers none
    expect(
      (await t.http().get(`/v1/tournaments/${id}/withdrawals`).set(x.owner.auth).expect(200)).body
        .items,
    ).toHaveLength(1);
    await t.http().get(`/v1/tournaments/${id}/withdrawals`).set(stranger.auth).expect(403);
  });

  it('TECHNICAL_RESULT needs explicit scores for unplayed fixtures and recomputes the table', async () => {
    const org = await createUser(t);
    const { id, clubs, stageId } = await live(org, 4);
    await goLive(id);
    const x = clubs[0] as Club;
    const all = await fixtures(id, org);
    const mine = involving(all, x.entryId);
    await play(org, id, (mine[0] as Json).id, 1, 1); // played draw stays a draw
    const w = (await request(id, x.owner, x.entryId).expect(200)).body;
    const other = all.find(
      (f) => f.home.entryId !== x.entryId && f.away.entryId !== x.entryId,
    ) as Json;
    const bad = (results: object[]) =>
      resolve(id, org, x.entryId, w.id, {
        resolution: 'TECHNICAL_RESULT',
        note: 'forfeit',
        technicalResults: results,
      });
    await bad([]).expect(400);
    await bad([{ fixtureId: (mine[0] as Json).id, homeScore: 0, awayScore: 3 }]).expect(400); // already played
    await bad([{ fixtureId: other.id, homeScore: 0, awayScore: 3 }]).expect(400); // not the club's fixture
    await bad([{ fixtureId: (mine[1] as Json).id, homeScore: 0 }]).expect(400); // score missing
    // the regulation decides the numbers: here 0:5 for the opponent, whichever side that is
    const f1 = mine[1] as Json;
    const f2 = mine[2] as Json;
    const score = (f: Json, xGoals: number, oppGoals: number) =>
      f.home.entryId === x.entryId
        ? { homeScore: xGoals, awayScore: oppGoals }
        : { homeScore: oppGoals, awayScore: xGoals };
    const res = await bad([{ fixtureId: f1.id, ...score(f1, 0, 5) }]).expect(200);
    expect(res.body.details.technicalResults).toEqual([f1.id]);
    expect(res.body.details.stillUnplayed).toEqual([f2.id]);
    const after = await fixtures(id, org);
    expect(after.find((f) => f.id === f1.id)).toMatchObject({
      status: 'FINISHED',
      ...score(f1, 0, 5),
    });
    expect(after.find((f) => f.id === f2.id)?.status).toBe('SCHEDULED'); // unlisted fixtures stay open
    expect(
      await t.prisma.auditEvent.count({
        where: { action: 'tournament.fixture.technical_result', targetId: f1.id },
      }),
    ).toBe(1);
    const table = (await t.http().get(`/v1/tournaments/${id}/standings`).expect(200)).body.stages[0]
      .groups[0].rows as Json[];
    const row = table.find((r) => r.entryId === x.entryId) as Json;
    expect(row).toMatchObject({ played: 2, goalsFor: 1, goalsAgainst: 6 });
    expect(stageId).toBeTruthy();
  });

  it('REPLACEMENT hands the unplayed fixtures to another club; the leaving club is out and unpaid fees vanish', async () => {
    const org = await createUser(t);
    const { id, clubs, pending } = await live(org, 3, { feeMode: 'PER_CLUB', feeMinor: 20000 }, 1);
    await goLive(id);
    const x = clubs[0] as Club;
    const newcomer = pending[0] as Club;
    const obX = await t.prisma.paymentObligation.findFirstOrThrow({
      where: { tournamentId: id, payerClubId: x.clubId },
    });
    expect(obX.status).toBe('OPEN');
    const mine = involving(await fixtures(id, org), x.entryId);
    await play(org, id, (mine[0] as Json).id, 3, 0);
    const w = (await request(id, x.owner, x.entryId).expect(200)).body;
    await resolve(id, org, x.entryId, w.id, {
      resolution: 'REPLACEMENT',
      note: 'same',
      replacementEntryId: x.entryId,
    }).expect(400);
    await resolve(id, org, x.entryId, w.id, {
      resolution: 'REPLACEMENT',
      note: 'gone',
      replacementEntryId: '00000000-0000-4000-8000-000000000000',
    }).expect(404);
    // the replacement already plays the leaving club in an unplayed match -> refused, nothing changes
    const rivals = mine.filter((f) => f.status === 'SCHEDULED');
    const rival = clubs[1] as Club;
    expect(involving(rivals, rival.entryId).length).toBeGreaterThan(0);
    await resolve(id, org, x.entryId, w.id, {
      resolution: 'REPLACEMENT',
      note: 'rival swap',
      replacementEntryId: rival.entryId,
    }).expect(409);
    expect((await t.prisma.clubEntry.findUniqueOrThrow({ where: { id: x.entryId } })).status).toBe(
      'ACCEPTED',
    );

    const ok = await resolve(id, org, x.entryId, w.id, {
      resolution: 'REPLACEMENT',
      note: 'newcomer takes over',
      replacementEntryId: newcomer.entryId,
    }).expect(200);
    expect(ok.body).toMatchObject({
      resolution: 'REPLACEMENT',
      replacementEntryId: newcomer.entryId,
    });
    expect((await t.prisma.clubEntry.findUniqueOrThrow({ where: { id: x.entryId } })).status).toBe(
      'WITHDRAWN',
    );
    expect(
      (await t.prisma.clubEntry.findUniqueOrThrow({ where: { id: newcomer.entryId } })).status,
    ).toBe('ACCEPTED');
    const after = await fixtures(id, org);
    expect(involving(after, newcomer.entryId)).toHaveLength(1); // the one unplayed match of the leaving club
    expect(after.find((f) => f.id === (mine[0] as Json).id)).toMatchObject({ status: 'FINISHED' }); // played match still shows the old club
    expect(involving(after, x.entryId).filter((f) => f.status !== 'FINISHED')).toHaveLength(0);
    expect(
      (await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: obX.id } })).status,
    ).toBe('CANCELLED');
    expect(
      await t.prisma.paymentObligation.count({
        where: { tournamentId: id, payerClubId: newcomer.clubId, status: 'OPEN' },
      }),
    ).toBe(1);
  });

  it('END_PARTICIPATION cancels unplayed fixtures, recomputes from played matches only; paid fees are untouched', async () => {
    const org = await createUser(t);
    const { id, clubs } = await live(org, 4, { feeMode: 'PER_CLUB', feeMinor: 10000 });
    await goLive(id);
    const [paidClub, unpaidClub] = [clubs[0] as Club, clubs[1] as Club];
    const paidOb = await t.prisma.paymentObligation.findFirstOrThrow({
      where: { tournamentId: id, payerClubId: paidClub.clubId },
    });
    await t
      .http()
      .post(`/v1/payments/obligations/${paidOb.id}/cash-received`)
      .set(org.auth)
      .set('Idempotency-Key', idemKey())
      .send({})
      .expect(200);
    const unpaidOb = await t.prisma.paymentObligation.findFirstOrThrow({
      where: { tournamentId: id, payerClubId: unpaidClub.clubId },
    });

    const all = await fixtures(id, org);
    const first = involving(all, paidClub.entryId)[0] as Json;
    await play(org, id, first.id, 1, 0);
    for (const c of [paidClub, unpaidClub]) {
      const w = (await request(id, c.owner, c.entryId).expect(200)).body;
      const r = await resolve(id, org, c.entryId, w.id, {
        resolution: 'END_PARTICIPATION',
        note: 'season over for them',
      }).expect(200);
      expect(r.body.status).toBe('RESOLVED');
      expect(
        (await t.prisma.clubEntry.findUniqueOrThrow({ where: { id: c.entryId } })).status,
      ).toBe('WITHDRAWN');
    }
    const after = await fixtures(id, org);
    expect(after.find((f) => f.id === first.id)).toMatchObject({
      status: 'FINISHED',
      homeScore: 1,
      awayScore: 0,
    }); // never deleted
    for (const c of [paidClub, unpaidClub]) {
      expect(
        involving(after, c.entryId).filter((f) => !['FINISHED', 'CANCELLED'].includes(f.status)),
      ).toHaveLength(0);
    }
    expect(after.filter((f) => f.status === 'CANCELLED').length).toBeGreaterThan(0);
    // unpaid obligation cancelled, paid one untouched
    expect(
      (await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: unpaidOb.id } })).status,
    ).toBe('CANCELLED');
    expect(
      await t.prisma.paymentObligation.findUniqueOrThrow({ where: { id: paidOb.id } }),
    ).toMatchObject({ status: 'PAID', paidMinor: 10000, refundDueMinor: 0 });
    // the tournament continues; the remaining fixture is playable, the table counts played matches only
    const table = (await t.http().get(`/v1/tournaments/${id}/standings`).expect(200)).body.stages[0]
      .groups[0].rows as Json[];
    expect(table.find((r) => r.entryId === paidClub.entryId)).toMatchObject({ played: 1, won: 1 });
    expect(table.reduce((s, r) => s + (r.played as number), 0)).toBe(2);
  });
});
