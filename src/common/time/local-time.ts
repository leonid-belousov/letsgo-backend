/** Calendar date parts of an instant as seen in an IANA timezone. */
export function localDateParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Age in whole years on `on` (evaluated in `timeZone`). Used for age bands: the event's
 * start instant in the event's timezone decides eligibility (Handoff §13).
 * `dateOfBirth` is a calendar date (stored as DATE → UTC midnight).
 */
export function ageOn(dateOfBirth: Date, on: Date, timeZone: string): number {
  const today = localDateParts(on, timeZone);
  const dobYear = dateOfBirth.getUTCFullYear();
  const dobMonth = dateOfBirth.getUTCMonth() + 1;
  const dobDay = dateOfBirth.getUTCDate();
  let age = today.year - dobYear;
  if (today.month < dobMonth || (today.month === dobMonth && today.day < dobDay)) age -= 1;
  return age;
}

export const AGE_BAND_MIN: Record<'NONE' | 'A35' | 'A40' | 'A45' | 'A50', number> = {
  NONE: 0,
  A35: 35,
  A40: 40,
  A45: 45,
  A50: 50,
};
