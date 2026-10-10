import { createTestApp, type TestApp } from './support/app';
import { createUser, uniq, type TestUser } from './support/factories';
import {
  applyWith,
  createClubRow,
  createTournament,
  decide,
  idemKey,
  isoDay,
  type Json,
} from './support/tournaments';

interface Fx extends Json {
  id: string;
}
type TimedFx = Fx & { s: number; e: number };

describe('tournaments: structure, scheduling, results (e2e)', () => {
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

  async function acceptClubs(
    tid: string,
    org: TestUser,
    n: number,
  ): Promise<{ entryId: string; clubId: string; owner: TestUser }[]> {
    const out = [];
    for (let i = 0; i < n; i++) {
      const owner = await createUser(t);
      const clubId = await createClubRow(t, owner);
      const entryId = await applyWith(t, tid, owner, clubId);
      await decide(t, tid, org, entryId, 'ACCEPT').expect(200);
      out.push({ entryId, clubId, owner });
    }
    return out;
  }

  async function pitches(owner: TestUser, n: number): Promise<string[]> {
    const venue = await t.prisma.venue.create({
      data: {
        name: `Venue ${uniq(5)}`,
        kind: 'PAID',
        status: 'PUBLISHED',
        city: 'Testville',
        timezone: 'Asia/Tbilisi',
        createdById: owner.userId,
      },
    });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        (
          await t.prisma.pitch.create({
            data: {
              venueId: venue.id,
              name: `Pitch ${i + 1}`,
              formats: [],
              amenities: [],
              status: 'PUBLISHED',
            },
          })
        ).id,
      );
    }
    return ids;
  }

  const fixtures = async (tid: string, u?: TestUser): Promise<Fx[]> => {
    const r = t.http().get(`/v1/tournaments/${tid}/fixtures`);
    return (await (u ? r.set(u.auth) : r).expect(200)).body.items as Fx[];
  };

  it('8 clubs / 2 groups of 4 / Golden+Silver cups = 18 matches on 2 pitches, with verified rest', async () => {
    const org = await createUser(t);
    const protocols = await createUser(t);
    const { id } = await createTournament(t, org, { minClubs: 8, maxClubs: 8 });
    const clubs = await acceptClubs(id, org, 8);
    const [p1, p2] = await pitches(org, 2);

    // stage 1: groups A/B, single round robin, seeded random draw
    const groups = (
      await post(org, `${id}/stages`, {
        name: 'Groups',
        kind: 'GROUP',
        config: { groups: ['A', 'B'], rounds: 1 },
      }).expect(201)
    ).body;
    expect(groups.index).toBe(1);
    await post(org, `${id}/stages/${groups.id}/generate`).expect(409); // not drawn yet
    const drawn = (
      await post(org, `${id}/stages/${groups.id}/draw`, {
        mode: 'RANDOM',
        seed: 'vazisubani',
      }).expect(200)
    ).body;
    const again = (
      await post(org, `${id}/stages/${groups.id}/draw`, {
        mode: 'RANDOM',
        seed: 'vazisubani',
      }).expect(200)
    ).body;
    expect(again.config.assignments).toEqual(drawn.config.assignments); // reproducible
    expect(drawn.config.draw).toMatchObject({
      mode: 'RANDOM',
      seed: 'vazisubani',
      byId: org.userId,
    });
    const asg = drawn.config.assignments as Record<string, string[]>;
    expect(asg.A).toHaveLength(4);
    expect(asg.B).toHaveLength(4);
    const gen = (await post(org, `${id}/stages/${groups.id}/generate`).expect(200)).body;
    expect(gen.created).toBe(12);

    // cups: A1xB2, B1xA2 / A3xB4, B3xA4 ; one group position feeds exactly one cup
    const rank = (group: string, r: number) => ({ stage: 1, group, rank: r });
    const golden = (
      await post(org, `${id}/stages`, {
        name: 'Golden Cup',
        kind: 'KNOCKOUT',
        config: {
          pairs: [
            [rank('A', 1), rank('B', 2)],
            [rank('B', 1), rank('A', 2)],
          ],
        },
      }).expect(201)
    ).body;
    const silver = (
      await post(org, `${id}/stages`, {
        name: 'Silver Cup',
        kind: 'KNOCKOUT',
        config: {
          pairs: [
            [rank('A', 3), rank('B', 4)],
            [rank('B', 3), rank('A', 4)],
          ],
        },
      }).expect(201)
    ).body;
    const twice = await post(org, `${id}/stages`, {
      name: 'Bronze',
      kind: 'KNOCKOUT',
      config: {
        pairs: [
          [rank('A', 1), rank('B', 4)],
          [rank('B', 5), rank('A', 2)],
        ],
      },
    }).expect(409);
    const codes = (twice.body.error.details.problems as { code: string }[]).map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['RANK_FEEDS_TWO_CUPS', 'POSITION_MISSING']));
    const cycle = await post(org, `${id}/stages`, {
      name: 'Loop',
      kind: 'KNOCKOUT',
      config: {
        pairs: [
          [
            { stage: 9, group: 'A', rank: 1 },
            { stage: 1, group: 'Z', rank: 1 },
          ],
        ],
      },
    }).expect(409);
    expect((cycle.body.error.details.problems as { code: string }[]).map((p) => p.code)).toEqual(
      expect.arrayContaining(['STAGE_REF_INVALID', 'GROUP_MISSING']),
    );
    expect((await t.http().get(`/v1/tournaments/${id}/stages`).expect(200)).body).toHaveLength(3);
    await post(org, `${id}/stages/${golden.id}/generate`).expect(200);
    await post(org, `${id}/stages/${silver.id}/generate`).expect(200);
    const all = await fixtures(id, org);
    expect(all).toHaveLength(18); // 12 + 4 semi-finals + 2 finals, no third-place matches
    expect(
      all
        .filter((f) => f.stageKind === 'KNOCKOUT' && f.home.placeholderLabel)
        .map((f) => f.home.placeholderLabel)
        .sort(),
    ).toEqual([
      'A1',
      'A3',
      'B1',
      'B3',
      'Winner of Golden Cup - Semi-final 1',
      'Winner of Silver Cup - Semi-final 1',
    ]);
    // every club plays at least 3 group matches (=> at least 4 with a semi-final, 5 for finalists)
    for (const c of clubs) {
      expect(
        all.filter(
          (f) =>
            f.stageKind === 'GROUP' &&
            (f.home.entryId === c.entryId || f.away.entryId === c.entryId),
        ),
      ).toHaveLength(3);
    }

    // scheduling: 2 pitches, 09:00-16:00 local (UTC+4), 20 min matches, 5 min changeover, 20 min rest, 10 min playoff reserve
    const day = isoDay(30);
    const at = (hh: number, mm = 0) =>
      new Date(`${day}T00:00:00.000Z`).getTime() + ((hh - 4) * 60 + mm) * 60_000;
    const window = (pitchId: string) => ({
      pitchId,
      startsAt: new Date(at(9)).toISOString(),
      endsAt: new Date(at(16)).toISOString(),
    });
    const params = {
      windows: [window(p1 as string), window(p2 as string)],
      matchMinutes: 20,
      changeoverMinutes: 5,
      minRestMinutes: 20,
      playoffReserveMinutes: 10,
    };

    await post(protocols, `${id}/schedule/preview`, params).expect(403);
    const preview = (await post(org, `${id}/schedule/preview`, params).expect(200)).body;
    expect(preview.saved).toBe(false);
    expect(preview.unscheduled).toEqual([]);
    expect(preview.slots).toHaveLength(18);
    expect(preview.analysis.conflicts).toEqual([]);
    expect(preview.analysis.minRestMinutes).toBeGreaterThanOrEqual(20); // actual minimum is reported, never below the parameter
    expect(preview.analysis.restSpreadMinutes).not.toBeNull();
    expect(preview.analysis.clubs.length).toBe(8);
    expect(
      Math.max(...preview.slots.map((s: { endsAt: string }) => Date.parse(s.endsAt))),
    ).toBeLessThanOrEqual(at(16));
    expect((await fixtures(id, org)).filter((f) => f.startsAt !== null)).toHaveLength(0); // preview saved nothing

    // a window that is too small is reported concretely and nothing changes
    const tight = {
      ...params,
      windows: [
        {
          pitchId: p1 as string,
          startsAt: new Date(at(9)).toISOString(),
          endsAt: new Date(at(11)).toISOString(),
        },
      ],
    };
    const refused = await post(org, `${id}/schedule/apply`, tight).expect(409);
    expect(refused.body.error.details.reason).toBe('SCHEDULE_CONFLICTS');
    expect(refused.body.error.details.unscheduled.length).toBeGreaterThan(0);
    expect((await fixtures(id, org)).filter((f) => f.startsAt !== null)).toHaveLength(0);

    // apply as a draft: hidden from the public until published
    const applied = (await post(org, `${id}/schedule/apply`, params).expect(200)).body;
    expect(applied.saved).toBe(true);
    expect(applied.newScheduleVersion).toBe(0);
    const mine = await fixtures(id, org);
    expect(mine.filter((f) => f.startsAt !== null)).toHaveLength(18);
    expect((await fixtures(id)).filter((f) => f.startsAt !== null)).toHaveLength(0);

    // independent verification of the saved schedule: no pitch overlap, no club overlap, rest >= 20
    const toTimed = (list: Fx[]): TimedFx[] =>
      list.map((f) => ({ ...f, s: Date.parse(f.startsAt), e: Date.parse(f.endsAt) }));
    const timed = toTimed(mine);
    for (const p of [p1, p2]) {
      const list = timed.filter((f) => f.pitchId === p).sort((a, b) => a.s - b.s);
      for (let i = 1; i < list.length; i++)
        expect((list[i] as TimedFx).s).toBeGreaterThanOrEqual(
          (list[i - 1] as TimedFx).e + 5 * 60_000,
        );
    }
    const byClub = new Map<string, TimedFx[]>();
    for (const f of timed.filter((x) => x.stageKind === 'GROUP')) {
      for (const c of [f.home.entryId, f.away.entryId] as string[])
        byClub.set(c, [...(byClub.get(c) ?? []), f]);
    }
    let minRest = Infinity;
    for (const list of byClub.values()) {
      list.sort((a, b) => a.s - b.s);
      for (let i = 1; i < list.length; i++)
        minRest = Math.min(minRest, ((list[i] as TimedFx).s - (list[i - 1] as TimedFx).e) / 60_000);
    }
    expect(minRest).toBeGreaterThanOrEqual(20);
    // knockouts start only after the group stage is over (+ rest)
    const lastGroup = Math.max(...timed.filter((f) => f.stageKind === 'GROUP').map((f) => f.e));
    for (const f of timed.filter((x) => x.stageKind === 'KNOCKOUT' && x.round === 1))
      expect(f.s).toBeGreaterThanOrEqual(lastGroup + 20 * 60_000);

    // publishing = schedule version 1; a later change is a new version and notifies affected clubs
    const pub = (await post(org, `${id}/schedule/publish`).expect(200)).body;
    expect(pub).toMatchObject({ scheduleVersion: 1, published: 18 });
    expect((await fixtures(id)).filter((f) => f.startsAt !== null)).toHaveLength(18);
    const rep = await t.prisma.notification.count({
      where: { recipientId: clubs[0]?.owner.userId, title: 'The match schedule was published' },
    });
    expect(rep).toBe(1);
    const stale = await post(org, `${id}/schedule/apply`, {
      ...params,
      expectedVersion: 0,
      reschedule: true,
    }).expect(409);
    expect(stale.body.error.code).toBe('VERSION_CHANGED');
    const moved = (
      await post(org, `${id}/schedule/apply`, {
        ...params,
        minRestMinutes: 25,
        reschedule: true,
        expectedVersion: 1,
      }).expect(200)
    ).body;
    expect(moved.analysis.minRestMinutes).toBeGreaterThanOrEqual(25);
    if (moved.changedCount > 0) {
      expect(moved.newScheduleVersion).toBe(2);
    }

    // manual move: overlap refused; a short rest needs an explicit decision
    const current = toTimed(await fixtures(id, org));
    const g = current.filter((x) => x.stageKind === 'GROUP').sort((a, b) => a.s - b.s);
    const first = g[0] as TimedFx;
    const second = g.find(
      (x) =>
        x.id !== first.id &&
        (x.home.entryId === first.home.entryId ||
          x.away.entryId === first.home.entryId ||
          x.home.entryId === first.away.entryId ||
          x.away.entryId === first.away.entryId),
    ) as TimedFx;
    const clash = await t
      .http()
      .patch(`/v1/tournaments/${id}/fixtures/${second.id}/slot`)
      .set(org.auth)
      .send({ pitchId: p2, startsAt: first.startsAt })
      .expect(409);
    expect(clash.body.error.code).toBe('BOOKING_CONFLICT');
    // a short rest is refused unless the organiser decides explicitly (third pitch: no pitch clash)
    const [p3] = await pitches(org, 1);
    // move a club's 2nd match to 5 minutes after its 1st (some candidates may clash with the opponent: try on)
    let slot = '';
    let body: Json = {};
    let movedId = '';
    let originalPitch = '';
    for (const c of clubs) {
      const [f1, f2] = g
        .filter((x) => x.home.entryId === c.entryId || x.away.entryId === c.entryId)
        .sort((a, b) => a.s - b.s) as [TimedFx, TimedFx];
      slot = `/v1/tournaments/${id}/fixtures/${f2.id}/slot`;
      body = {
        pitchId: p3,
        startsAt: new Date(f1.e + 5 * 60_000).toISOString(),
        minRestMinutes: 20,
      };
      const attempt = await t.http().patch(slot).set(org.auth).send(body);
      expect(attempt.status).toBe(409);
      if (attempt.body.error.details.reason === 'REST_TOO_SHORT') {
        movedId = f2.id;
        originalPitch = f2.pitchId;
        break;
      }
      expect(attempt.body.error.code).toBe('BOOKING_CONFLICT');
    }
    expect(movedId).not.toBe('');
    expect((await fixtures(id, org)).find((f) => f.id === movedId)?.pitchId).toBe(originalPitch);
    const forced = await t
      .http()
      .patch(slot)
      .set(org.auth)
      .send({ ...body, allowShortRest: true })
      .expect(200);
    expect(forced.body.pitchId).toBe(p3);
    expect(forced.body.scheduleVersion).toBeGreaterThanOrEqual(2);
    const report = (
      await t
        .http()
        .get(`/v1/tournaments/${id}/schedule/report`)
        .query({ minRestMinutes: 20 })
        .set(org.auth)
        .expect(200)
    ).body;
    expect(report).toMatchObject({ scheduledFixtures: 18, unscheduledFixtures: 0 });

    // ── results (tournament must be live; shortcut: start flow is covered elsewhere) ──
    await t.prisma.tournament.update({ where: { id }, data: { status: 'LIVE' } });
    await t
      .http()
      .post(`/v1/tournaments/${id}/assistants`)
      .set(org.auth)
      .send({ userId: protocols.userId, permissions: ['tournament.protocols'] })
      .expect(200);
    const rec = (u: TestUser, fid: string, body: object) =>
      post(u, `${id}/fixtures/${fid}/result`, body);

    const groupFx = (await fixtures(id, org)).filter((f) => f.stageKind === 'GROUP');
    const kn = (await fixtures(id, org)).filter((f) => f.stageKind === 'KNOCKOUT');
    await rec(protocols, (kn[0] as Fx).id, { homeScore: 1, awayScore: 0 }).expect(409); // sides not decided yet
    await rec(await createUser(t), (groupFx[0] as Fx).id, { homeScore: 1, awayScore: 0 }).expect(
      403,
    );
    await rec(protocols, (groupFx[0] as Fx).id, {
      homeScore: 1,
      awayScore: 0,
      shootout: { home: 1, away: 0 },
    }).expect(400);
    // rank by draw position: the earlier club in the assignment list always wins 2-0
    const pos = (label: string, entryId: string) => (asg[label] as string[]).indexOf(entryId);
    for (const f of groupFx) {
      const label = f.groupLabel as string;
      const hp = pos(label, f.home.entryId);
      const ap = pos(label, f.away.entryId);
      const res = await rec(
        protocols,
        f.id,
        hp < ap ? { homeScore: 2, awayScore: 0 } : { homeScore: 0, awayScore: 2 },
      ).expect(200);
      expect(res.body.status).toBe('FINISHED');
      // idempotent retry, but a different score needs a correction
      await rec(
        protocols,
        f.id,
        hp < ap ? { homeScore: 2, awayScore: 0 } : { homeScore: 0, awayScore: 2 },
      ).expect(200);
    }
    await rec(protocols, (groupFx[0] as Fx).id, { homeScore: 5, awayScore: 5 }).expect(409);

    const st = (await t.http().get(`/v1/tournaments/${id}/standings`).expect(200)).body.stages[0];
    expect(st.groups.map((x: Json) => x.label)).toEqual(['A', 'B']);
    for (const grp of st.groups) {
      expect(grp.confirmed).toBe(true);
      expect(grp.hasUnresolvedTie).toBe(false);
      expect(grp.rows.map((r: Json) => r.points)).toEqual([9, 6, 3, 0]);
      expect(grp.rows.map((r: Json) => r.rank)).toEqual([1, 2, 3, 4]);
      expect(grp.rows[0]).toMatchObject({
        played: 3,
        won: 3,
        goalsFor: 6,
        goalsAgainst: 0,
        goalDifference: 6,
      });
    }
    // placeholders resolved with the real clubs: A1xB2, B1xA2, A3xB4, B3xA4
    const after = await fixtures(id, org);
    const sf = (cup: string) =>
      after
        .filter((f) => f.stageName === cup && f.round === 1)
        .sort((a, b) => a.label.localeCompare(b.label));
    const A = asg.A as string[];
    const B = asg.B as string[];
    const goldenSf = sf('Golden Cup');
    expect(goldenSf.map((f) => [f.home.entryId, f.away.entryId])).toEqual([
      [A[0], B[1]],
      [B[0], A[1]],
    ]);
    expect(sf('Silver Cup').map((f) => [f.home.entryId, f.away.entryId])).toEqual([
      [A[2], B[3]],
      [B[2], A[3]],
    ]);

    // a group match correction that changes the top of group A: dependents listed, explicit decision required
    const a01 = groupFx.find(
      (f) =>
        f.groupLabel === 'A' &&
        [f.home.entryId, f.away.entryId].sort().join() === [A[0], A[1]].sort().join(),
    ) as Fx;
    const flip =
      a01.home.entryId === A[0] ? { homeScore: 0, awayScore: 2 } : { homeScore: 2, awayScore: 0 };
    const impact = (await post(org, `${id}/fixtures/${a01.id}/impact`, flip).expect(200)).body
      .affected as Json[];
    expect(impact.length).toBe(2); // Golden SF1 (A1) and Golden SF2 (A2)
    expect(impact.every((x) => x.locked === false)).toBe(true);
    await post(org, `${id}/fixtures/${a01.id}/correction`, {
      ...flip,
      reason: 'protocol error',
    }).expect(409);
    await post(protocols, `${id}/fixtures/${a01.id}/correction`, {
      ...flip,
      reason: 'protocol error',
      decision: 'KEEP_ASSIGNMENTS',
    }).expect(403); // chief organiser only
    await post(org, `${id}/fixtures/${a01.id}/correction`, {
      ...flip,
      reason: 'x',
      decision: 'KEEP_ASSIGNMENTS',
    }).expect(400); // reason too short
    const fixed = await post(org, `${id}/fixtures/${a01.id}/correction`, {
      ...flip,
      reason: 'protocol error',
      decision: 'REASSIGN_UNPLAYED',
    }).expect(200);
    expect(fixed.body.homeScore + fixed.body.awayScore).toBe(2);
    const swapped = (await fixtures(id, org))
      .filter((f) => f.stageName === 'Golden Cup' && f.round === 1)
      .sort((a, b) => a.label.localeCompare(b.label));
    expect(swapped.map((f) => [f.home.entryId, f.away.entryId])).toEqual([
      [A[1], B[1]],
      [B[0], A[0]],
    ]);
    expect(
      await t.prisma.auditEvent.count({
        where: { action: 'tournament.fixture.correct', targetId: a01.id },
      }),
    ).toBe(1);

    // knockout: a tie needs a decided shoot-out; the winner feeds the final
    const sf1 = swapped[0] as Fx;
    const sf2 = swapped[1] as Fx;
    await rec(protocols, sf1.id, { homeScore: 1, awayScore: 1 }).expect(400);
    await rec(protocols, sf1.id, {
      homeScore: 1,
      awayScore: 1,
      shootout: { home: 3, away: 3 },
    }).expect(400);
    await rec(protocols, sf1.id, {
      homeScore: 2,
      awayScore: 1,
      shootout: { home: 3, away: 1 },
    }).expect(400);
    const done = (
      await rec(protocols, sf1.id, {
        homeScore: 1,
        awayScore: 1,
        shootout: { home: 4, away: 3 },
      }).expect(200)
    ).body;
    expect(done.shootout).toEqual({ home: 4, away: 3 });
    expect(done.winnerEntryId).toBe(sf1.home.entryId);
    await rec(protocols, sf2.id, { homeScore: 0, awayScore: 3 }).expect(200);
    const goldenFinal = (await fixtures(id, org)).find(
      (f) => f.stageName === 'Golden Cup' && f.round === 2,
    ) as Fx;
    expect([goldenFinal.home.entryId, goldenFinal.away.entryId]).toEqual([
      sf1.home.entryId,
      sf2.away.entryId,
    ]);

    // now SF1/SF2 are played: correcting group A again lists them as locked and never rebuilds them
    const flipBack =
      a01.home.entryId === A[0] ? { homeScore: 2, awayScore: 0 } : { homeScore: 0, awayScore: 2 };
    const impact2 = (await post(org, `${id}/fixtures/${a01.id}/impact`, flipBack).expect(200)).body
      .affected as Json[];
    expect(impact2.length).toBeGreaterThan(0);
    expect(impact2.every((x) => x.locked === true)).toBe(true);
    await post(org, `${id}/fixtures/${a01.id}/correction`, {
      ...flipBack,
      reason: 'second correction',
      decision: 'REASSIGN_UNPLAYED',
    }).expect(200);
    const still = (await fixtures(id, org))
      .filter((f) => f.stageName === 'Golden Cup' && f.round === 1)
      .sort((a, b) => a.label.localeCompare(b.label));
    expect(still.map((f) => [f.home.entryId, f.away.entryId])).toEqual(
      swapped.map((f) => [f.home.entryId, f.away.entryId]),
    );
    expect(still.every((f) => f.status === 'FINISHED')).toBe(true);

    // each finalist has played 3 group matches + semi-final + final = 5; the others at least 4 once semis are done
    const total = (await fixtures(id, org)).length;
    expect(total).toBe(18);
    expect(await t.prisma.standing.count({ where: { stageId: groups.id } })).toBe(8);
  });

  it('ties beyond the configured criteria stay unresolved until the organiser decides; byes and unsupported rules', async () => {
    const org = await createUser(t);
    const { id } = await createTournament(t, org);
    const clubs = await acceptClubs(id, org, 3);
    const league = (
      await post(org, `${id}/stages`, {
        name: 'League',
        kind: 'LEAGUE',
        config: { rounds: 1 },
      }).expect(201)
    ).body;
    // unsupported tie-break rules are refused, not guessed
    await post(org, `${id}/stages`, {
      name: 'H2H',
      kind: 'LEAGUE',
      config: { tiebreakers: ['points', 'headToHead'] },
    }).expect(400);
    await post(org, `${id}/stages/${league.id}/draw`, {
      mode: 'MANUAL',
      assignments: { '': clubs.map((c) => c.entryId) },
    }).expect(200);
    await post(org, `${id}/stages/${league.id}/draw`, {
      mode: 'MANUAL',
      assignments: { '': [clubs[0]?.entryId] },
    }).expect(400);
    expect((await post(org, `${id}/stages/${league.id}/generate`).expect(200)).body.created).toBe(
      3,
    );
    // odd league: each round rests one club
    const rounds = (await fixtures(id, org)).map((f) => f.round).sort();
    expect(rounds).toEqual([1, 2, 3]);

    // knockout fed by league rank 1 + a direct entry (rank 1 will be tied)
    const ko = (
      await post(org, `${id}/stages`, {
        name: 'Final',
        kind: 'KNOCKOUT',
        config: {
          pairs: [
            [
              { stage: 1, group: '', rank: 1 },
              { entryId: (clubs[2] as { entryId: string }).entryId },
            ],
          ],
        },
      }).expect(201)
    ).body;
    await post(org, `${id}/stages/${ko.id}/generate`).expect(200);
    await t.prisma.tournament.update({ where: { id }, data: { status: 'LIVE' } });
    for (const f of (await fixtures(id, org)).filter((x) => x.stageKind === 'LEAGUE')) {
      await post(org, `${id}/fixtures/${f.id}/result`, { homeScore: 0, awayScore: 0 }).expect(200);
    }
    const st = (await t.http().get(`/v1/tournaments/${id}/standings`).expect(200)).body.stages[0]
      .groups[0];
    expect(st.hasUnresolvedTie).toBe(true);
    expect(st.rows.every((r: Json) => r.rank === 1 && r.tied)).toBe(true);
    let final = (await fixtures(id, org)).find((f) => f.stageKind === 'KNOCKOUT') as Fx;
    expect(final.home.entryId).toBeNull(); // never invented
    expect(final.home.placeholderLabel).toBe('#1');

    const order = clubs.map((c) => c.entryId);
    await post(org, `${id}/stages/${league.id}/tie-resolution`, {
      group: '',
      entryIds: [order[1], order[0]],
    }).expect(409); // must be exactly the tied set
    const tie = await post(org, `${id}/stages/${league.id}/tie-resolution`, {
      group: '',
      entryIds: [order[1], order[2], order[0]],
      reason: 'lots drawn',
    }).expect(200);
    expect(tie.body.resolved).toBe(1);
    final = (await fixtures(id, org)).find((f) => f.stageKind === 'KNOCKOUT') as Fx;
    expect(final.home.entryId).toBe(order[1]);
    const rows = (await t.http().get(`/v1/tournaments/${id}/standings`).expect(200)).body.stages[0]
      .groups[0].rows as Json[];
    expect(rows.map((r) => r.entryId)).toEqual([order[1], order[2], order[0]]);

    // stage with results cannot be regenerated or redrawn
    await post(org, `${id}/stages/${league.id}/generate`).expect(409);
    await t.http().delete(`/v1/tournaments/${id}/stages/${league.id}`).set(org.auth).expect(409); // used by another stage / has results
  });

  it('byes are free passes, never matches; the same club cannot sit twice in the brackets', async () => {
    const org = await createUser(t);
    const { id } = await createTournament(t, org);
    const clubs = await acceptClubs(id, org, 3);
    const seeds = clubs.map((c) => ({ entryId: c.entryId }));
    const cup = (
      await post(org, `${id}/stages`, {
        name: 'Odd cup',
        kind: 'KNOCKOUT',
        config: { participants: seeds, thirdPlace: false },
      }).expect(201)
    ).body;
    const gen = (await post(org, `${id}/stages/${cup.id}/generate`).expect(200)).body;
    expect(gen).toMatchObject({ created: 2, byes: 1 });
    const fx = await fixtures(id, org);
    expect(fx.filter((f) => f.round === 1)).toHaveLength(1);
    const dup = await post(org, `${id}/stages`, {
      name: 'Dup',
      kind: 'KNOCKOUT',
      config: { participants: [seeds[0], seeds[1]] },
    }).expect(409);
    expect(dup.body.error.details.problems[0].code).toBe('ENTRY_DUPLICATED');
    const brackets = (await t.http().get(`/v1/tournaments/${id}/brackets`).expect(200)).body
      .stages[0];
    expect(brackets.rounds.map((r: Json) => r.name)).toEqual(['Semi-final', 'Final']);
  });
});
