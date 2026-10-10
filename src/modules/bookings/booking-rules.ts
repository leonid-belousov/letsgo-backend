import { ApiError, ErrorCode } from '../../common/errors';
import {
  addDays,
  localParts,
  WEEKDAY_KEYS,
  weekdayOf,
  zonedToUtc,
  type WeekdayKey,
  type YMD,
} from './time-zone';

export interface HoursInterval {
  open: string;
  close: string;
}
/** Per-weekday opening intervals in the venue's local time. `close` <= `open` means "next day". */
export type OpeningHours = Partial<Record<WeekdayKey, HoursInterval[]>>;

export interface BookingRuleSet {
  minDurationMinutes: number;
  gridMinutes: number;
  allowHalfHourExtension: boolean;
  /** Raw JSON as stored; `null` = not configured (no restriction). */
  openingHours: unknown;
}

export const ALLOWED_GRIDS = [15, 30, 60] as const;

export function bookingStep(rules: Pick<BookingRuleSet, 'allowHalfHourExtension'>): number {
  return rules.allowHalfHourExtension ? 30 : 60;
}

function toMinutes(value: unknown, allow24: boolean): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (h === 24 && min === 0 && allow24) return 1440;
  if (h > 23) return null;
  return h * 60 + min;
}

function invalidHours(message: string): ApiError {
  return new ApiError(ErrorCode.VALIDATION, message, { field: 'openingHours' });
}

/** Validates and normalises the client-supplied opening hours (throws VALIDATION). */
export function normalizeOpeningHours(input: unknown): OpeningHours {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidHours('openingHours must be an object keyed by weekday (mon..sun).');
  }
  const out: OpeningHours = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(WEEKDAY_KEYS as readonly string[]).includes(key)) {
      throw invalidHours(`Unknown weekday “${key}”.`);
    }
    if (!Array.isArray(value) || value.length > 4) {
      throw invalidHours(`${key}: expected up to 4 intervals.`);
    }
    const spans: Array<[number, number]> = [];
    const intervals: HoursInterval[] = [];
    for (const raw of value as unknown[]) {
      const obj = raw as { open?: unknown; close?: unknown } | null;
      const open = toMinutes(obj?.open, false);
      const close = toMinutes(obj?.close, true);
      if (open === null || close === null || open === close) {
        throw invalidHours(`${key}: each interval needs open/close as HH:MM (open ≠ close).`);
      }
      spans.push([open, close < open ? close + 1440 : close]);
      intervals.push({ open: obj?.open as string, close: obj?.close as string });
    }
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      if ((spans[i]?.[0] ?? 0) < (spans[i - 1]?.[1] ?? 0)) {
        throw invalidHours(`${key}: intervals overlap.`);
      }
    }
    out[key as WeekdayKey] = intervals;
  }
  return out;
}

export function parseStoredOpeningHours(json: unknown): OpeningHours | null {
  if (json === null || json === undefined) return null;
  try {
    return normalizeOpeningHours(json);
  } catch {
    return {}; // corrupt configuration: treat as closed rather than open
  }
}

export interface TimeWindow {
  start: Date;
  end: Date;
}

/** Windows that OPEN on the given local calendar day (they may end on the next day). */
export function windowsOpeningOn(hours: OpeningHours | null, day: YMD, tz: string): TimeWindow[] {
  if (hours === null) {
    return [
      {
        start: zonedToUtc(day.year, day.month, day.day, 0, tz),
        end: zonedToUtc(day.year, day.month, day.day, 1440, tz),
      },
    ];
  }
  const key = WEEKDAY_KEYS[weekdayOf(day)] as WeekdayKey;
  return (hours[key] ?? []).map((iv) => {
    const open = toMinutes(iv.open, false) ?? 0;
    const close = toMinutes(iv.close, true) ?? 0;
    const closeAbs = close <= open ? close + 1440 : close;
    return {
      start: zonedToUtc(day.year, day.month, day.day, open, tz),
      end: zonedToUtc(day.year, day.month, day.day, closeAbs, tz),
    };
  });
}

/** Sorted, merged (touching windows join, e.g. Mon 20:00–24:00 + Tue 00:00–03:00). */
export function mergeWindows(windows: TimeWindow[]): TimeWindow[] {
  const sorted = [...windows].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: TimeWindow[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.start.getTime() <= last.end.getTime()) {
      if (w.end.getTime() > last.end.getTime()) last.end = w.end;
    } else {
      out.push({ start: w.start, end: w.end });
    }
  }
  return out;
}

export function isWithinOpeningHours(
  hours: OpeningHours | null,
  tz: string,
  start: Date,
  end: Date,
): boolean {
  if (hours === null) return true;
  const s = localParts(start, tz);
  const e = localParts(end, tz);
  const first = addDays({ year: s.year, month: s.month, day: s.day }, -1);
  const last: YMD = { year: e.year, month: e.month, day: e.day };
  const all: TimeWindow[] = [];
  for (let d = first, guard = 0; guard < 5; d = addDays(d, 1), guard++) {
    all.push(...windowsOpeningOn(hours, d, tz));
    if (d.year === last.year && d.month === last.month && d.day === last.day) break;
  }
  return mergeWindows(all).some(
    (w) => w.start.getTime() <= start.getTime() && w.end.getTime() >= end.getTime(),
  );
}

export type RuleViolation =
  | 'IN_THE_PAST'
  | 'START_NOT_ON_GRID'
  | 'DURATION_TOO_SHORT'
  | 'DURATION_STEP'
  | 'OUTSIDE_OPENING_HOURS'
  | 'INVALID_INTERVAL';

function violation(rule: RuleViolation, message: string, extra: object = {}): ApiError {
  const field = rule === 'START_NOT_ON_GRID' || rule === 'IN_THE_PAST' ? 'startsAt' : 'endsAt';
  return new ApiError(ErrorCode.VALIDATION, message, { field, rule, ...extra });
}

function basics(startsAt: Date, endsAt: Date): number {
  const ms = endsAt.getTime() - startsAt.getTime();
  if (
    Number.isNaN(ms) ||
    ms <= 0 ||
    startsAt.getUTCSeconds() !== 0 ||
    startsAt.getUTCMilliseconds() !== 0 ||
    ms % 60_000 !== 0
  ) {
    throw violation('INVALID_INTERVAL', 'The end must be after the start, on whole minutes.');
  }
  return ms / 60_000;
}

/**
 * The server-side booking rules (Handoff §16): 30-min grid start (18:30 is fine), minimum
 * rental, 30-min steps only when extension is allowed (else whole hours), inside opening hours
 * of the venue's timezone (midnight-crossing hours supported), never in the past.
 * The same validator serves clients and staff (external bookings).
 */
export function validateBookingWindow(args: {
  startsAt: Date;
  endsAt: Date;
  rules: BookingRuleSet;
  timezone: string;
  now: Date;
}): void {
  const { startsAt, endsAt, rules, timezone, now } = args;
  const duration = basics(startsAt, endsAt);
  if (startsAt.getTime() < now.getTime()) {
    throw violation('IN_THE_PAST', 'This time is in the past.');
  }
  if (localParts(startsAt, timezone).minuteOfDay % rules.gridMinutes !== 0) {
    throw violation('START_NOT_ON_GRID', `Start times follow a ${rules.gridMinutes}-minute grid.`, {
      gridMinutes: rules.gridMinutes,
    });
  }
  if (duration < rules.minDurationMinutes) {
    throw violation(
      'DURATION_TOO_SHORT',
      `The minimum booking is ${rules.minDurationMinutes} minutes.`,
      { minDurationMinutes: rules.minDurationMinutes },
    );
  }
  const step = bookingStep(rules);
  if ((duration - rules.minDurationMinutes) % step !== 0) {
    throw violation('DURATION_STEP', `Bookings grow in steps of ${step} minutes.`, {
      stepMinutes: step,
    });
  }
  if (
    !isWithinOpeningHours(parseStoredOpeningHours(rules.openingHours), timezone, startsAt, endsAt)
  ) {
    throw violation('OUTSIDE_OPENING_HOURS', 'This time is outside the opening hours.');
  }
}

/** Calendar blocks: a single grid cell (30 min) is the minimum; no opening-hours restriction. */
export function validateBlockWindow(args: {
  startsAt: Date;
  endsAt: Date;
  gridMinutes: number;
  timezone: string;
  now: Date;
}): void {
  const { startsAt, endsAt, gridMinutes, timezone, now } = args;
  const duration = basics(startsAt, endsAt);
  if (endsAt.getTime() <= now.getTime()) {
    throw violation('IN_THE_PAST', 'This time is in the past.');
  }
  if (localParts(startsAt, timezone).minuteOfDay % gridMinutes !== 0) {
    throw violation('START_NOT_ON_GRID', `Start times follow a ${gridMinutes}-minute grid.`, {
      gridMinutes,
    });
  }
  if (duration % gridMinutes !== 0) {
    throw violation('DURATION_STEP', `Blocks are whole ${gridMinutes}-minute cells.`, {
      stepMinutes: gridMinutes,
    });
  }
}
