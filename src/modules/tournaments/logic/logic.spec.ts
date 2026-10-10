import { buildBracket, pairsFromSeeds } from './bracket';
import { roundRobin } from './round-robin';
import { parseClientConfig } from './stage-config';
import { analyseSchedule, minutes, scheduleFixtures, type SchedFixture } from './scheduler';
import { computeTable } from './standings';

describe('round robin', () => {
  it('plays every pair exactly once and no team twice in a round', () => {
    const m = roundRobin(['a', 'b', 'c', 'd']);
    expect(m).toHaveLength(6);
    const pairs = new Set(m.map((x) => [x.home, x.away].sort().join('-')));
    expect(pairs.size).toBe(6);
    for (const r of [1, 2, 3]) {
      const ts = m.filter((x) => x.round === r).flatMap((x) => [x.home, x.away]);
      expect(new Set(ts).size).toBe(ts.length);
    }
  });
  it('gives an odd league a rest round and two circles double the matches', () => {
    expect(roundRobin(['a', 'b', 'c'])).toHaveLength(3);
    expect(roundRobin(['a', 'b', 'c', 'd'], 2)).toHaveLength(12);
  });
});

describe('bracket', () => {
  const r = (g: string, rank: number) => ({ stage: 1, group: g, rank });
  it('Golden cup: A1xB2, B1xA2 then a final', () => {
    const b = buildBracket(
      [
        [r('A', 1), r('B', 2)],
        [r('B', 1), r('A', 2)],
      ],
      false,
    );
    expect(b.fixtures).toHaveLength(3);
    expect(b.rounds).toBe(2);
    expect(b.fixtures.find((f) => f.round === 2)?.home).toEqual({ t: 'WIN', key: 'r1p1' });
  });
  it('byes are not matches and third place adds one', () => {
    const seeds = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ entryId: id }));
    const b = buildBracket(pairsFromSeeds(seeds), true);
    expect(b.byes).toBe(2);
    expect(b.fixtures.filter((f) => f.round === 1)).toHaveLength(2);
    expect(b.fixtures.some((f) => f.third)).toBe(true);
  });
});

describe('standings', () => {
  const rules = {
    points: { win: 3, draw: 1, loss: 0 },
    tiebreakers: ['points', 'goalDifference', 'goalsFor'] as const,
  };
  it('leaves ties unresolved and shares the rank', () => {
    const t = computeTable(
      ['a', 'b', 'c'],
      [{ home: 'a', away: 'b', homeScore: 1, awayScore: 1 }],
      {
        points: rules.points,
        tiebreakers: [...rules.tiebreakers],
      },
    );
    expect(t.find((x) => x.entryId === 'c')?.rank).toBe(3);
    expect(t.filter((x) => x.rank === 1).every((x) => x.tied)).toBe(true);
  });
  it('orders by points then goal difference', () => {
    const t = computeTable(
      ['a', 'b', 'c'],
      [
        { home: 'a', away: 'b', homeScore: 3, awayScore: 0 },
        { home: 'c', away: 'b', homeScore: 1, awayScore: 0 },
        { home: 'a', away: 'c', homeScore: 0, awayScore: 0 },
      ],
      { points: rules.points, tiebreakers: [...rules.tiebreakers] },
    );
    expect(t.map((x) => x.entryId)).toEqual(['a', 'c', 'b']);
    expect(t.every((x) => !x.tied)).toBe(true);
  });
});

describe('scheduler: 8 clubs, 2 groups of 4, 2 pitches', () => {
  const group = (g: string) => {
    const ids = [1, 2, 3, 4].map((n) => `${g}${n}`);
    return roundRobin(ids).map((m, i) => ({ ...m, key: `${g}-${i}` }));
  };
  const day = Date.UTC(2026, 8, 27, 5, 0); // 09:00 local (UTC+4)
  const windows = ['p1', 'p2'].map((p) => ({ pitchId: p, start: day, end: day + 7 * 3_600_000 }));

  it('places 18 matches, no overlaps, honours a 20-minute rest and reports the actual minimum', () => {
    const list: SchedFixture[] = [];
    const groupFx = [...group('A'), ...group('B')].sort((a, b) => a.round - b.round);
    for (const m of groupFx) {
      list.push({
        id: m.key,
        clubs: [m.home, m.away],
        minutes: 20,
        reserve: 0,
        changeover: 5,
        after: [],
      });
    }
    const groupIds = (g: string) => groupFx.filter((m) => m.key.startsWith(g)).map((m) => m.key);
    const sf = (id: string, a: string, b: string) =>
      list.push({
        id,
        clubs: [],
        minutes: 20,
        reserve: 10,
        changeover: 5,
        after: [...groupIds(a), ...groupIds(b)],
      });
    sf('G-SF1', 'A', 'B');
    sf('G-SF2', 'A', 'B');
    sf('S-SF1', 'A', 'B');
    sf('S-SF2', 'A', 'B');
    list.push({
      id: 'S-F',
      clubs: [],
      minutes: 20,
      reserve: 10,
      changeover: 5,
      after: ['S-SF1', 'S-SF2'],
    });
    list.push({
      id: 'G-F',
      clubs: [],
      minutes: 20,
      reserve: 10,
      changeover: 5,
      after: ['G-SF1', 'G-SF2'],
    });
    expect(list).toHaveLength(18);

    const out = scheduleFixtures(list, windows, [], minutes(20));
    expect(out.unscheduled).toEqual([]);
    expect(out.placed).toHaveLength(18);

    const a = analyseSchedule(out.placed, minutes(20));
    expect(a.conflicts).toEqual([]);
    // every club plays at least 3 group matches here and rests >= 20 minutes
    expect(a.minRestMinutes).not.toBeNull();
    expect(a.minRestMinutes as number).toBeGreaterThanOrEqual(20);
    const last = Math.max(...out.placed.map((p) => p.occupiedUntil));
    expect(last).toBeLessThanOrEqual(windows[0]?.end as number);
  });

  it('never shrinks the rest: too small a window leaves fixtures unscheduled with a reason', () => {
    const tight = [{ pitchId: 'p1', start: day, end: day + 30 * 60_000 }];
    const list: SchedFixture[] = [
      { id: 'x', clubs: ['a', 'b'], minutes: 20, reserve: 0, changeover: 5, after: [] },
      { id: 'y', clubs: ['a', 'c'], minutes: 20, reserve: 0, changeover: 5, after: [] },
    ];
    const out = scheduleFixtures(list, tight, [], minutes(20));
    expect(out.placed).toHaveLength(1);
    expect(out.unscheduled[0]).toMatchObject({ id: 'y', reason: 'NO_SLOT_IN_WINDOWS' });
  });
});

describe('standings: head-to-head and fair play', () => {
  const pts = { win: 3, draw: 1, loss: 0 };
  // a,b,c equal on points (all beat d, and a>b, b>c, c>a in a cycle by different margins)
  const results = [
    { home: 'a', away: 'b', homeScore: 2, awayScore: 0 },
    { home: 'b', away: 'c', homeScore: 1, awayScore: 0 },
    { home: 'c', away: 'a', homeScore: 1, awayScore: 0 },
    { home: 'a', away: 'd', homeScore: 1, awayScore: 0 },
    { home: 'b', away: 'd', homeScore: 1, awayScore: 0 },
    { home: 'c', away: 'd', homeScore: 1, awayScore: 0 },
  ];
  const ids = ['a', 'b', 'c', 'd'];

  it('three tied clubs: the mini table over mutual matches with configured metrics decides', () => {
    // mini: a 3pts gd+1, b 3pts gd-1, c 3pts gd 0 (all 3 points) -> goalDifference splits
    const t = computeTable(ids, results, {
      points: pts,
      tiebreakers: ['points', 'headToHead'],
      headToHead: { metrics: ['points', 'goalDifference'], reapplyToSubgroup: false },
    });
    expect(t.map((x) => x.entryId)).toEqual(['a', 'c', 'b', 'd']);
    expect(t.every((x) => !x.tied)).toBe(true);
    // with only "points" as the metric the cycle stays unresolved
    const u = computeTable(ids, results, {
      points: pts,
      tiebreakers: ['points', 'headToHead'],
      headToHead: { metrics: ['points'], reapplyToSubgroup: false },
    });
    expect(u.slice(0, 3).every((x) => x.rank === 1 && x.tied)).toBe(true);
  });

  it('reapplyToSubgroup re-runs the mini table on the remaining subgroup only', () => {
    // a,b,c,d all level on points; mini table over all four leaves b,c level, a first, d last
    const res = [
      { home: 'a', away: 'b', homeScore: 1, awayScore: 0 },
      { home: 'a', away: 'c', homeScore: 1, awayScore: 0 },
      { home: 'a', away: 'd', homeScore: 0, awayScore: 1 },
      { home: 'b', away: 'c', homeScore: 3, awayScore: 0 }, // b beats c heavily
      { home: 'b', away: 'd', homeScore: 0, awayScore: 1 },
      { home: 'c', away: 'd', homeScore: 0, awayScore: 1 },
    ];
    const base = { points: pts, tiebreakers: ['headToHead' as const] };
    const four = ['a', 'b', 'c', 'd'];
    const cfg = (reapply: boolean) => ({
      metrics: ['points' as const, 'goalsFor' as const],
      reapplyToSubgroup: reapply,
    });
    // d: 9 pts, a: 6, b: 3, c: 0 in the mini table over four -> everything already split; craft a tie instead
    const withoutReapply = computeTable(four, res, { ...base, headToHead: cfg(false) });
    expect(withoutReapply.map((x) => x.entryId)).toEqual(['d', 'a', 'b', 'c']);
    // three-way tie among a,b,c after excluding d: rerun with d absent from the block
    const tie = [
      { home: 'a', away: 'b', homeScore: 1, awayScore: 0 },
      { home: 'b', away: 'c', homeScore: 1, awayScore: 0 },
      { home: 'c', away: 'a', homeScore: 1, awayScore: 0 },
      { home: 'x', away: 'y', homeScore: 0, awayScore: 0 },
    ];
    const t = computeTable(['a', 'b', 'c'], tie, { ...base, headToHead: cfg(true) });
    expect(t.every((x) => x.rank === 1 && x.tied)).toBe(true); // a cycle stays unresolved, no invented rule
  });

  it('reapply true splits further where false stops', () => {
    // 4-club mini table: a 6, b 4, d 4, c 2 -> b and d stay level; their own mutual match (b won) splits them
    const res = [
      { home: 'a', away: 'b', homeScore: 2, awayScore: 0 },
      { home: 'a', away: 'c', homeScore: 1, awayScore: 0 },
      { home: 'a', away: 'd', homeScore: 0, awayScore: 2 },
      { home: 'b', away: 'c', homeScore: 2, awayScore: 2 },
      { home: 'b', away: 'd', homeScore: 2, awayScore: 0 },
      { home: 'c', away: 'd', homeScore: 1, awayScore: 1 },
    ];
    const cfgOf = (reapplyToSubgroup: boolean) => ({
      points: pts,
      tiebreakers: ['headToHead' as const],
      headToHead: { metrics: ['points' as const], reapplyToSubgroup },
    });
    const off = computeTable(['a', 'b', 'c', 'd'], res, cfgOf(false));
    const on = computeTable(['a', 'b', 'c', 'd'], res, cfgOf(true));
    expect(off.map((x) => [x.entryId, x.rank])).toEqual([
      ['a', 1],
      ['b', 2],
      ['d', 2],
      ['c', 4],
    ]);
    expect(on.map((x) => [x.entryId, x.rank])).toEqual([
      ['a', 1],
      ['b', 2],
      ['d', 3],
      ['c', 4],
    ]);
  });

  it('fair play: lower weighted card total wins the tie; missing data counts as zero', () => {
    const level = [{ home: 'a', away: 'b', homeScore: 1, awayScore: 1 }];
    const weights = { yellow: 1, red: 3 };
    const cards = new Map([
      ['a', 1 * weights.yellow + 1 * weights.red], // 4
      ['b', 2 * weights.yellow], // 2
    ]);
    const t = computeTable(
      ['a', 'b'],
      level,
      { points: pts, tiebreakers: ['points', 'fairPlay'] },
      [],
      { fairPlay: cards },
    );
    expect(t.map((x) => x.entryId)).toEqual(['b', 'a']);
    expect(t.every((x) => !x.tied)).toBe(true);
    const none = computeTable(['a', 'b'], level, {
      points: pts,
      tiebreakers: ['points', 'fairPlay'],
    });
    expect(none.every((x) => x.tied)).toBe(true);
  });
});

describe('stage config: head-to-head and fair play validation', () => {
  it('rejects the criteria without their required config with a specific error', () => {
    expect(() =>
      parseClientConfig('GROUP', { groups: ['A'], tiebreakers: ['points', 'headToHead'] }),
    ).toThrow(/headToHead needs/);
    expect(() => parseClientConfig('GROUP', { groups: ['A'], tiebreakers: ['fairPlay'] })).toThrow(
      /fairPlayWeights/,
    );
    expect(() => parseClientConfig('GROUP', { groups: ['A'], tiebreakers: ['lots'] })).toThrow(
      /not supported/,
    );
    const ok = parseClientConfig('GROUP', {
      groups: ['A'],
      tiebreakers: ['points', 'headToHead', 'fairPlay'],
      headToHead: { metrics: ['points', 'goalDifference'], reapplyToSubgroup: true },
      fairPlayWeights: { yellow: 1, red: 3 },
    });
    expect(ok.headToHead?.reapplyToSubgroup).toBe(true);
    expect(() =>
      parseClientConfig('GROUP', {
        groups: ['A'],
        tiebreakers: ['headToHead'],
        headToHead: { metrics: ['points'] },
      }),
    ).toThrow();
    expect(() =>
      parseClientConfig('GROUP', {
        groups: ['A'],
        tiebreakers: ['fairPlay'],
        fairPlayWeights: { yellow: -1, red: 1 },
      }),
    ).toThrow();
  });
});
