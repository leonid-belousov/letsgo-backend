export interface RrMatch {
  round: number;
  home: string;
  away: string;
}

/**
 * Round-robin by the circle method. An odd number of teams gets a rest round for the team
 * paired with the phantom slot (no opponent is invented). `rounds` = 2 repeats every pairing
 * with home/away swapped ("two circles").
 */
export function roundRobin(teams: readonly string[], rounds: 1 | 2 = 1): RrMatch[] {
  const list: (string | null)[] = [...teams];
  if (list.length < 2) return [];
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const days = n - 1;
  const out: RrMatch[] = [];
  let arr = list.slice();
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i] ?? null;
      const b = arr[n - 1 - i] ?? null;
      if (a === null || b === null) continue;
      // alternate home/away to keep it balanced
      const swap = (d + i) % 2 === 1;
      out.push({ round: d + 1, home: swap ? b : a, away: swap ? a : b });
    }
    // rotate all but the first
    const [first, ...rest] = arr;
    const last = rest.pop();
    arr = [first ?? null, ...(last === undefined ? [] : [last]), ...rest];
  }
  if (rounds === 2) {
    const second = out.map((m) => ({ round: m.round + days, home: m.away, away: m.home }));
    out.push(...second);
  }
  return out;
}
