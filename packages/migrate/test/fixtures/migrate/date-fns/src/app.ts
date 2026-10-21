import {
  addDays,
  differenceInHours,
  endOfDay,
  format,
  getDay,
  getDaysInMonth,
  isAfter,
  parseISO,
  startOfHour,
} from "date-fns";

/** A free trial ends 14 days after signing up, at the end of that day. */
export function trialEnd(signedUp: Date): Date {
  return endOfDay(addDays(signedUp, 14));
}

const signedUp = parseISO("2026-03-01T10:30:00");
export const ends = trialEnd(signedUp).toISOString();
export const endsOnWeekday = getDay(trialEnd(signedUp));
export const daysInMonth = getDaysInMonth(signedUp);
export const hoursLeft = differenceInHours(trialEnd(signedUp), signedUp);
export const later = isAfter(trialEnd(signedUp), signedUp);
export const stamp = startOfHour(parseISO("2026-03-15T12:34:56Z")).getTime();
export const label = format(signedUp, "yyyy-MM-dd");
