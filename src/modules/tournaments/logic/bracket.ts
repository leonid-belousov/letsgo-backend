import type { SeedRef } from './stage-config';

export type Source =
  | { t: 'ENTRY'; entryId: string }
  | { t: 'RANK'; stage: number; group: string; rank: number }
  | { t: 'WIN'; key: string }
  | { t: 'LOSE'; key: string };

export interface BracketFixture {
  key: string;
  round: number;
  pos: number;
  third: boolean;
  home: Source;
  away: Source;
}

export interface Bracket {
  fixtures: BracketFixture[];
  rounds: number;
  byes: number;
}

export function seedToSource(r: SeedRef): Source {
  return 'entryId' in r
    ? { t: 'ENTRY', entryId: r.entryId }
    : { t: 'RANK', stage: r.stage, group: r.group, rank: r.rank };
}

/** Standard seeding order for a bracket of `size` (power of two): 1v8, 4v5, 2v7, 3v6 ... */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const next = order.length * 2;
    order = order.flatMap((x) => [x, next + 1 - x]);
  }
  return order;
}

/** Pairs from a seeded participant list; the top seeds receive the byes. */
export function pairsFromSeeds(participants: readonly SeedRef[]): [SeedRef, SeedRef | null][] {
  let size = 1;
  while (size < participants.length) size *= 2;
  const order = seedOrder(size);
  const pairs: [SeedRef, SeedRef | null][] = [];
  for (let i = 0; i < order.length; i += 2) {
    const a = participants[(order[i] ?? 0) - 1] ?? null;
    const b = participants[(order[i + 1] ?? 0) - 1] ?? null;
    if (a && b) pairs.push([a, b]);
    else if (a) pairs.push([a, null]);
    else if (b) pairs.push([b, null]);
  }
  return pairs;
}

/**
 * Builds the bracket tree. A pair with an empty side is a bye: that side advances without
 * a fixture (byes are never counted as played matches). Later rounds reference winners of
 * earlier fixtures via WIN sources; an optional third-place match pairs the two semi-final losers.
 */
export function buildBracket(
  pairs: readonly [SeedRef, SeedRef | null][],
  thirdPlace: boolean,
): Bracket {
  const fixtures: BracketFixture[] = [];
  let byes = 0;
  let round = 1;
  let layer: Source[][] = pairs.map(([a, b]) =>
    b ? [seedToSource(a), seedToSource(b)] : [seedToSource(a)],
  );
  const semiKeys: string[] = [];

  const play = (sources: Source[][]): Source[] => {
    const next: Source[] = [];
    sources.forEach((s, idx) => {
      const [a, b] = s;
      if (a && b) {
        const key = `r${round}p${idx + 1}`;
        fixtures.push({ key, round, pos: idx + 1, third: false, home: a, away: b });
        next.push({ t: 'WIN', key });
      } else if (a) {
        byes += 1;
        next.push(a);
      }
    });
    return next;
  };

  let current = play(layer);
  while (current.length > 1) {
    round += 1;
    layer = [];
    for (let i = 0; i < current.length; i += 2) {
      const a = current[i];
      const b = current[i + 1];
      layer.push(a && b ? [a, b] : a ? [a] : []);
    }
    if (thirdPlace && current.length === 2) {
      for (const s of current) if (s.t === 'WIN') semiKeys.push(s.key);
    }
    current = play(layer);
  }
  const rounds = round;
  if (thirdPlace && semiKeys.length === 2) {
    fixtures.push({
      key: `r${rounds}third`,
      round: rounds,
      pos: 2,
      third: true,
      home: { t: 'LOSE', key: semiKeys[0] as string },
      away: { t: 'LOSE', key: semiKeys[1] as string },
    });
  }
  return { fixtures, rounds, byes };
}

/** Human label for a knockout fixture based on its distance from the final. */
export function roundLabel(totalRounds: number, round: number, third: boolean): string {
  if (third) return 'Third place';
  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semi-final';
  if (fromEnd === 2) return 'Quarter-final';
  return `Round ${round}`;
}
