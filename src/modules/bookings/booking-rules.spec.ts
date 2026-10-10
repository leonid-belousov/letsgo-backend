import { ApiError } from '../../common/errors';
import {
  isWithinOpeningHours,
  normalizeOpeningHours,
  validateBlockWindow,
  validateBookingWindow,
  type BookingRuleSet,
} from './booking-rules';
import { localParts, zonedToUtc } from './time-zone';

const TBILISI = 'Asia/Tbilisi';
const rules = (over: Partial<BookingRuleSet> = {}): BookingRuleSet => ({
  minDurationMinutes: 60,
  gridMinutes: 30,
  allowHalfHourExtension: false,
  openingHours: {
    mon: [{ open: '09:00', close: '01:00' }],
    tue: [{ open: '09:00', close: '01:00' }],
  },
  ...over,
});
const utc = (s: string): Date => new Date(s);
const now = utc('2026-01-01T00:00:00Z');

function rule(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as ApiError).details?.rule as string | undefined;
  }
  return undefined;
}

describe('time zone helpers', () => {
  it('converts wall-clock time to UTC, including DST zones', () => {
    expect(zonedToUtc(2026, 10, 5, 18 * 60 + 30, TBILISI).toISOString()).toBe(
      '2026-10-05T14:30:00.000Z',
    );
    // Europe/Berlin: CEST (+2) in summer, CET (+1) in winter
    expect(zonedToUtc(2026, 7, 1, 20 * 60, 'Europe/Berlin').toISOString()).toBe(
      '2026-07-01T18:00:00.000Z',
    );
    expect(zonedToUtc(2026, 12, 1, 20 * 60, 'Europe/Berlin').toISOString()).toBe(
      '2026-12-01T19:00:00.000Z',
    );
    // minuteOfDay beyond 24h rolls to the next local day
    expect(zonedToUtc(2026, 10, 5, 25 * 60, TBILISI).toISOString()).toBe(
      '2026-10-05T21:00:00.000Z',
    );
    const p = localParts(utc('2026-10-05T21:30:00Z'), TBILISI);
    expect([p.day, p.hour, p.minute, p.minuteOfDay]).toEqual([6, 1, 30, 90]);
  });
});

describe('opening hours', () => {
  it('validates and normalises', () => {
    expect(() => normalizeOpeningHours({ mon: [{ open: '09:00', close: '24:00' }] })).not.toThrow();
    expect(() => normalizeOpeningHours({ mon: [{ open: '24:00', close: '02:00' }] })).toThrow(
      ApiError,
    );
    expect(() => normalizeOpeningHours({ xyz: [] })).toThrow(ApiError);
    expect(() => normalizeOpeningHours(null)).toThrow(ApiError);
    expect(() =>
      normalizeOpeningHours({
        mon: [
          { open: '09:00', close: '13:00' },
          { open: '12:00', close: '15:00' },
        ],
      }),
    ).toThrow(ApiError);
  });

  it('09:00–01:00 closes on the NEXT day in the venue timezone', () => {
    const hours = normalizeOpeningHours({ mon: [{ open: '09:00', close: '01:00' }] });
    // Monday 2026-10-05 (local)
    const at = (h: string, d = '2026-10-05') => utc(`${d}T${h}:00+04:00`);
    expect(isWithinOpeningHours(hours, TBILISI, at('23:00'), at('01:00', '2026-10-06'))).toBe(true);
    expect(isWithinOpeningHours(hours, TBILISI, at('23:00'), at('01:30', '2026-10-06'))).toBe(
      false,
    );
    expect(isWithinOpeningHours(hours, TBILISI, at('08:00'), at('10:00'))).toBe(false);
    // Tuesday is closed; the Monday window ends 01:00 Tuesday
    expect(
      isWithinOpeningHours(hours, TBILISI, at('00:00', '2026-10-06'), at('01:00', '2026-10-06')),
    ).toBe(true);
    expect(
      isWithinOpeningHours(hours, TBILISI, at('10:00', '2026-10-06'), at('11:00', '2026-10-06')),
    ).toBe(false);
    // the same wall clock in another zone is a different instant
    expect(
      isWithinOpeningHours(hours, 'UTC', utc('2026-10-05T10:00:00Z'), utc('2026-10-05T11:00:00Z')),
    ).toBe(true);
  });

  it('touching windows across midnight merge (Mon until 24:00 + Tue from 00:00)', () => {
    const hours = normalizeOpeningHours({
      mon: [{ open: '20:00', close: '24:00' }],
      tue: [{ open: '00:00', close: '03:00' }],
    });
    const at = (h: string, d: string) => utc(`${d}T${h}:00+04:00`);
    expect(
      isWithinOpeningHours(hours, TBILISI, at('23:00', '2026-10-05'), at('01:00', '2026-10-06')),
    ).toBe(true);
  });
});

describe('booking window validation', () => {
  const at = (h: string, d = '2026-10-05') => utc(`${d}T${h}:00+04:00`);
  const check = (s: Date, e: Date, r = rules()) =>
    rule(() => validateBookingWindow({ startsAt: s, endsAt: e, rules: r, timezone: TBILISI, now }));

  it('accepts grid starts (18:30) with hour steps, and 30-minute steps when extension is on', () => {
    expect(check(at('18:30'), at('19:30'))).toBeUndefined();
    expect(check(at('18:00'), at('20:00'))).toBeUndefined();
    expect(check(at('18:00'), at('19:30'))).toBe('DURATION_STEP');
    const ext = rules({ allowHalfHourExtension: true });
    expect(check(at('18:00'), at('19:30'), ext)).toBeUndefined();
    expect(check(at('18:00'), at('19:45'), ext)).toBe('DURATION_STEP');
    expect(check(at('18:00'), at('18:30'), ext)).toBe('DURATION_TOO_SHORT');
  });

  it('rejects off-grid starts, short rentals, outside hours, the past and bad intervals', () => {
    expect(check(at('18:15'), at('19:15'))).toBe('START_NOT_ON_GRID');
    expect(check(at('18:00'), at('18:30'))).toBe('DURATION_TOO_SHORT');
    expect(check(at('07:00'), at('08:00'))).toBe('OUTSIDE_OPENING_HOURS');
    expect(check(at('18:00', '2025-01-06'), at('19:00', '2025-01-06'))).toBe('IN_THE_PAST');
    expect(check(at('19:00'), at('18:00'))).toBe('INVALID_INTERVAL');
  });

  it('a custom minimum (90) uses steps counted from the minimum', () => {
    const r = rules({ minDurationMinutes: 90, allowHalfHourExtension: false });
    expect(check(at('18:00'), at('19:30'), r)).toBeUndefined();
    expect(check(at('18:00'), at('20:30'), r)).toBeUndefined(); // 150 = 90 + 60
    expect(check(at('18:00'), at('20:00'), r)).toBe('DURATION_STEP'); // 120 = 90 + 30
  });

  it('null opening hours means no restriction', () => {
    expect(check(at('03:00'), at('04:00'), rules({ openingHours: null }))).toBeUndefined();
  });

  it('blocks may be a single 30-minute cell but must sit on the grid', () => {
    const block = (s: Date, e: Date) =>
      rule(() =>
        validateBlockWindow({ startsAt: s, endsAt: e, gridMinutes: 30, timezone: TBILISI, now }),
      );
    expect(block(at('18:00'), at('18:30'))).toBeUndefined();
    expect(block(at('18:10'), at('18:40'))).toBe('START_NOT_ON_GRID');
    expect(block(at('18:00'), at('18:45'))).toBe('DURATION_STEP');
    expect(block(at('18:00', '2025-01-06'), at('18:30', '2025-01-06'))).toBe('IN_THE_PAST');
  });
});
