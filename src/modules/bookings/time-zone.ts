/**
 * Small IANA-timezone toolkit (no dependency). All instants are UTC `Date`s; "local" means the
 * wall clock of the venue's timezone.
 */

export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
  /** minutes since local midnight */
  minuteOfDay: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(instant: Date, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') % 24;
  const minute = get('minute');
  const second = get('second');
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minuteOfDay: hour * 60 + minute,
  };
}

/** Offset (local − UTC) in ms at the given instant. */
function offsetMs(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of a wall-clock time. `minuteOfDay` may exceed 1440 (next local day).
 * Nonexistent local times (DST gap) resolve forward; ambiguous ones to the earlier instant.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  tz: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, 0, minuteOfDay, 0);
  const first = wall - offsetMs(new Date(wall), tz);
  const second = wall - offsetMs(new Date(first), tz);
  return new Date(second);
}

export interface YMD {
  year: number;
  month: number;
  day: number;
}

export function addDays(d: YMD, n: number): YMD {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function weekdayOf(d: YMD): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

export function parseYMD(value: string): YMD | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d: YMD = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
  if (
    t.getUTCFullYear() !== d.year ||
    t.getUTCMonth() + 1 !== d.month ||
    t.getUTCDate() !== d.day
  ) {
    return null;
  }
  return d;
}
