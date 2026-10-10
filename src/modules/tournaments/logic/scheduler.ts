/**
 * Pure scheduling maths (no I/O). All times are epoch milliseconds.
 *
 * Model (Decisions §44.4):
 *  - the match length is independent of the rented window (a window is an availability
 *    interval of one pitch; many matches fit inside one rental);
 *  - consecutive matches on one pitch are separated by `changeover` (+ the playoff `reserve`
 *    after a playoff match) which is part of the pitch occupancy, not of the club's rest;
 *  - a club's rest is measured from the END of its previous match to the START of its next one
 *    and is NEVER shrunk: if a slot honouring `minRest` does not exist the fixture stays
 *    unscheduled with a concrete reason.
 */

export interface SchedWindow {
  pitchId: string;
  start: number;
  end: number;
}

export interface SchedFixture {
  id: string;
  clubs: string[];
  minutes: number;
  /** Extra minutes reserved after this match on its pitch (playoff delays / penalties). */
  reserve: number;
  changeover: number;
  /** Fixtures that must have finished (plus the minimum rest) before this one may start. */
  after: string[];
}

export interface PlacedSlot {
  id: string;
  pitchId: string | null;
  start: number;
  end: number;
  /** Pitch occupancy end (match end + changeover + reserve). */
  occupiedUntil: number;
  clubs: string[];
}

export interface UnscheduledFixture {
  id: string;
  reason: 'NO_SLOT_IN_WINDOWS' | 'DEPENDENCY_UNSCHEDULED';
  detail: string;
}

export interface ScheduleOutcome {
  placed: PlacedSlot[];
  unscheduled: UnscheduledFixture[];
}

const MIN = 60_000;
export const minutes = (n: number): number => n * MIN;

export function scheduleFixtures(
  fixtures: readonly SchedFixture[],
  windows: readonly SchedWindow[],
  fixed: readonly PlacedSlot[],
  minRest: number,
): ScheduleOutcome {
  const placed: PlacedSlot[] = [...fixed];
  const byId = new Map<string, PlacedSlot>(fixed.map((p) => [p.id, p]));
  const unscheduled: UnscheduledFixture[] = [];
  const failed = new Set<string>();

  for (const f of fixtures) {
    const dep = f.after.find((id) => failed.has(id));
    if (dep) {
      failed.add(f.id);
      unscheduled.push({
        id: f.id,
        reason: 'DEPENDENCY_UNSCHEDULED',
        detail: 'A fixture this one depends on could not be scheduled',
      });
      continue;
    }
    let notBefore = 0;
    for (const id of f.after) {
      const d = byId.get(id);
      if (d) notBefore = Math.max(notBefore, d.end + minRest);
    }
    const len = minutes(f.minutes);
    const gap = minutes(f.changeover + f.reserve);
    const reserve = minutes(f.reserve);

    let best: { window: SchedWindow; t: number } | null = null;
    for (const w of windows) {
      let t = Math.max(w.start, notBefore);
      for (let guard = 0; guard < 10_000; guard++) {
        if (t + len + reserve > w.end) {
          t = -1;
          break;
        }
        let next = t;
        for (const p of placed) {
          if (p.pitchId === w.pitchId && t < p.occupiedUntil && p.start < t + len + gap) {
            next = Math.max(next, p.occupiedUntil);
          }
          if (p.clubs.some((c) => f.clubs.includes(c))) {
            const clear = t >= p.end + minRest || t + len + minRest <= p.start;
            if (!clear) next = Math.max(next, p.end + minRest);
          }
        }
        if (next === t) break;
        t = next;
      }
      if (t < 0) continue;
      if (!best || t < best.t) best = { window: w, t };
    }
    if (!best) {
      failed.add(f.id);
      unscheduled.push({
        id: f.id,
        reason: 'NO_SLOT_IN_WINDOWS',
        detail: `No slot inside the pitch windows honours the ${minRest / MIN}-minute minimum rest`,
      });
      continue;
    }
    const slot: PlacedSlot = {
      id: f.id,
      pitchId: best.window.pitchId,
      start: best.t,
      end: best.t + len,
      occupiedUntil: best.t + len + gap,
      clubs: f.clubs,
    };
    placed.push(slot);
    byId.set(f.id, slot);
  }
  return { placed, unscheduled };
}

export interface ClubRest {
  clubId: string;
  matches: number;
  /** Smallest gap between two of the club's consecutive matches (null with <2 matches). */
  minRestMinutes: number | null;
}

export interface ScheduleConflict {
  type: 'PITCH_OVERLAP' | 'CLUB_OVERLAP' | 'REST_TOO_SHORT';
  fixtureIds: string[];
  clubId?: string;
  pitchId?: string;
  restMinutes?: number;
  message: string;
}

export interface ScheduleAnalysis {
  clubs: ClubRest[];
  /** Smallest rest of any club (null when nobody plays twice). */
  minRestMinutes: number | null;
  /** Largest minus smallest per-club minimum - shows unequal rest, never hides it. */
  restSpreadMinutes: number | null;
  conflicts: ScheduleConflict[];
}

interface AnalyseSlot {
  id: string;
  pitchId: string | null;
  start: number;
  end: number;
  clubs: string[];
}

/** Conflicts and per-club rest of a set of placed fixtures. */
export function analyseSchedule(slots: readonly AnalyseSlot[], minRest: number): ScheduleAnalysis {
  const conflicts: ScheduleConflict[] = [];
  const byPitch = new Map<string, AnalyseSlot[]>();
  const byClub = new Map<string, AnalyseSlot[]>();
  for (const s of slots) {
    if (s.pitchId) byPitch.set(s.pitchId, [...(byPitch.get(s.pitchId) ?? []), s]);
    for (const c of s.clubs) byClub.set(c, [...(byClub.get(c) ?? []), s]);
  }
  for (const [pitchId, list] of byPitch) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1] as AnalyseSlot;
      const cur = sorted[i] as AnalyseSlot;
      if (cur.start < prev.end) {
        conflicts.push({
          type: 'PITCH_OVERLAP',
          fixtureIds: [prev.id, cur.id],
          pitchId,
          message: 'Two matches overlap on the same pitch',
        });
      }
    }
  }
  const clubs: ClubRest[] = [];
  for (const [clubId, list] of byClub) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    let smallest: number | null = null;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1] as AnalyseSlot;
      const cur = sorted[i] as AnalyseSlot;
      const rest = cur.start - prev.end;
      if (rest < 0) {
        conflicts.push({
          type: 'CLUB_OVERLAP',
          fixtureIds: [prev.id, cur.id],
          clubId,
          message: 'A club is scheduled in two matches at the same time',
        });
      } else if (rest < minRest) {
        conflicts.push({
          type: 'REST_TOO_SHORT',
          fixtureIds: [prev.id, cur.id],
          clubId,
          restMinutes: rest / MIN,
          message: `Rest of ${rest / MIN} min is below the required ${minRest / MIN} min`,
        });
      }
      const minutesRest = rest / MIN;
      smallest = smallest === null ? minutesRest : Math.min(smallest, minutesRest);
    }
    clubs.push({ clubId, matches: sorted.length, minRestMinutes: smallest });
  }
  const mins = clubs.flatMap((c) => (c.minRestMinutes === null ? [] : [c.minRestMinutes]));
  return {
    clubs: clubs.sort((a, b) => a.clubId.localeCompare(b.clubId)),
    minRestMinutes: mins.length ? Math.min(...mins) : null,
    restSpreadMinutes: mins.length ? Math.max(...mins) - Math.min(...mins) : null,
    conflicts,
  };
}
