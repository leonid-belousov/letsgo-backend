import type { H2hMetric, Rules, TieBreaker } from './stage-config';

export interface Played {
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
}

export interface TableRow {
  entryId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  rank: number;
  /** Another club shares this rank after every configured criterion. */
  tied: boolean;
}

export interface TieResolution {
  entryIds: string[];
}

export type TableRules = Pick<Rules, 'points' | 'tiebreakers' | 'headToHead'>;

export interface TableExtras {
  /** Fair-play totals per entry (weighted cards, LOWER is better). Missing = 0. */
  fairPlay?: ReadonlyMap<string, number>;
}

function blank(id: string): TableRow {
  return {
    entryId: id,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    points: 0,
    rank: 0,
    tied: false,
  };
}

/** Raw table (no ordering) from a set of results among `ids`. */
function tally(ids: readonly string[], results: readonly Played[], pts: Rules['points']) {
  const rows = new Map<string, TableRow>([...new Set(ids)].map((id) => [id, blank(id)]));
  for (const r of results) {
    const h = rows.get(r.home);
    const a = rows.get(r.away);
    if (!h || !a) continue;
    h.played += 1;
    a.played += 1;
    h.goalsFor += r.homeScore;
    h.goalsAgainst += r.awayScore;
    a.goalsFor += r.awayScore;
    a.goalsAgainst += r.homeScore;
    if (r.homeScore > r.awayScore) {
      h.won += 1;
      a.lost += 1;
      h.points += pts.win;
      a.points += pts.loss;
    } else if (r.homeScore < r.awayScore) {
      a.won += 1;
      h.lost += 1;
      a.points += pts.win;
      h.points += pts.loss;
    } else {
      h.drawn += 1;
      a.drawn += 1;
      h.points += pts.draw;
      a.points += pts.draw;
    }
  }
  return rows;
}

/** Higher is better for every simple criterion. */
function simpleValue(row: TableRow, c: TieBreaker): number {
  switch (c) {
    case 'points':
      return row.points;
    case 'goalDifference':
      return row.goalsFor - row.goalsAgainst;
    case 'goalsFor':
      return row.goalsFor;
    case 'goalsAgainst':
      return -row.goalsAgainst;
    case 'wins':
      return row.won;
    default:
      return 0;
  }
}

function h2hValue(row: TableRow, m: H2hMetric): number {
  return m === 'points'
    ? row.points
    : m === 'goalDifference'
      ? row.goalsFor - row.goalsAgainst
      : row.goalsFor;
}

/** Splits rows into blocks of equal value, best first. */
function groupBy(rows: TableRow[], value: (r: TableRow) => number): TableRow[][] {
  const sorted = [...rows].sort(
    (a, b) => value(b) - value(a) || a.entryId.localeCompare(b.entryId),
  );
  const out: TableRow[][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && value(last[0] as TableRow) === value(r)) last.push(r);
    else out.push([r]);
  }
  return out;
}

/**
 * Head-to-head mini table (Decisions §44.3): ONLY the mutual matches of the tied clubs, ordered by
 * the organiser-configured metrics. With `reapplyToSubgroup` a subgroup that is still tied but
 * smaller than before gets its own mini table (mutual matches of that subgroup only), repeatedly.
 */
export function headToHeadBlocks(
  block: TableRow[],
  results: readonly Played[],
  pts: Rules['points'],
  cfg: { metrics: readonly H2hMetric[]; reapplyToSubgroup: boolean },
): TableRow[][] {
  const ids = block.map((b) => b.entryId);
  const mutual = results.filter((r) => ids.includes(r.home) && ids.includes(r.away));
  const mini = tally(ids, mutual, pts);
  const miniRows = [...mini.values()];
  const cmp = (a: TableRow, b: TableRow) => {
    for (const m of cfg.metrics) {
      const d = h2hValue(b, m) - h2hValue(a, m);
      if (d !== 0) return d;
    }
    return 0;
  };
  miniRows.sort((a, b) => cmp(a, b) || a.entryId.localeCompare(b.entryId));
  const groups: TableRow[][] = [];
  for (const r of miniRows) {
    const last = groups[groups.length - 1];
    if (last && cmp(last[0] as TableRow, r) === 0) last.push(r);
    else groups.push([r]);
  }
  const byId = new Map(block.map((b) => [b.entryId, b]));
  const mapped = groups.map((g) => g.map((r) => byId.get(r.entryId) as TableRow));
  if (!cfg.reapplyToSubgroup) return mapped;
  return mapped.flatMap((g) =>
    g.length > 1 && g.length < block.length ? headToHeadBlocks(g, results, pts, cfg) : [g],
  );
}

/**
 * League table from confirmed results. Ordering uses ONLY the configured criteria, applied in
 * order to clubs still equal after the previous ones. Clubs equal on all of them share a rank
 * (1,2,2,4) and are flagged `tied` - no rule is invented. An explicit organiser resolution
 * (recorded with author/time elsewhere) may order a tied set.
 */
export function computeTable(
  entryIds: readonly string[],
  results: readonly Played[],
  rules: TableRules,
  resolutions: readonly TieResolution[] = [],
  extras: TableExtras = {},
): TableRow[] {
  const rows = [...tally(entryIds, results, rules.points).values()];

  const order = (block: TableRow[], crit: readonly TieBreaker[]): TableRow[][] => {
    if (block.length <= 1 || crit.length === 0) return [block];
    const [c, ...rest] = crit as [TieBreaker, ...TieBreaker[]];
    let parts: TableRow[][];
    if (c === 'headToHead') {
      parts = rules.headToHead
        ? headToHeadBlocks(block, results, rules.points, rules.headToHead)
        : [block];
    } else if (c === 'fairPlay') {
      // lower weighted card total is better
      parts = groupBy(block, (r) => -(extras.fairPlay?.get(r.entryId) ?? 0));
    } else {
      parts = groupBy(block, (r) => simpleValue(r, c));
    }
    return parts.flatMap((p) => order(p, rest));
  };

  const blocks: TableRow[][] = [];
  for (const b of order(rows, rules.tiebreakers)) {
    const sorted = [...b].sort((x, y) => x.entryId.localeCompare(y.entryId));
    const res = resolutions.find((r) => sorted.every((s) => r.entryIds.includes(s.entryId)));
    if (res && sorted.length > 1) {
      sorted.sort((x, y) => res.entryIds.indexOf(x.entryId) - res.entryIds.indexOf(y.entryId));
      for (const s of sorted) blocks.push([s]);
    } else {
      blocks.push(sorted);
    }
  }
  let position = 1;
  for (const block of blocks) {
    for (const row of block) {
      row.rank = position;
      row.tied = block.length > 1;
    }
    position += block.length;
  }
  return blocks.flat();
}
