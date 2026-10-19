import dayjs, { type Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);

/** A free trial ends 14 days after signing up, at the end of that day. */
export function trialEnd(signedUp: Dayjs): Dayjs {
  return signedUp.add(14, "day").endOf("day");
}

const signedUp = dayjs("2026-03-01T10:30:00");
export const ends = trialEnd(signedUp).toISOString();
export const endsOnWeekday = trialEnd(signedUp).day();
export const daysInMonth = signedUp.daysInMonth();
export const hoursLeft = trialEnd(signedUp).diff(signedUp, "hour");
export const later = trialEnd(signedUp).isAfter(signedUp);
export const stamp = dayjs.utc("2026-03-15T12:34:56Z").startOf("hour").valueOf();
export const label = `${signedUp.month() + 1}/${signedUp.date()}/${signedUp.year()}`;
