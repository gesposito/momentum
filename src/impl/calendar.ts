/*
  Proleptic Gregorian (ISO 8601) calendar arithmetic in closed form (Howard Hinnant's
  days_from_civil / civil_from_days), for Luxon's algorithms (Settings.temporalNative = false).

  Converting between epoch milliseconds and calendar fields is pure arithmetic with no time zone
  or locale input; done this way it needs no Temporal objects, whose field accessors cost hundreds
  of nanoseconds in current engines. The Temporal-native core computes the same values with
  Temporal, and everything time-zone dependent lives in ./temporal.ts.
*/

import type { GregorianDateTime } from "../types.js";

const MS_PER_DAY = 86400000;

/**
 * Days since 1970-01-01 of a proleptic Gregorian date. The month may lie outside 1..12 and the
 * day outside the month's length; both roll over, the way `Date.UTC()` behaves.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const monthIndex = month - 1,
    yearShift = Math.floor(monthIndex / 12),
    m = monthIndex - yearShift * 12 + 1,
    y0 = year + yearShift,
    y = m <= 2 ? y0 - 1 : y0,
    era = Math.floor(y / 400),
    yoe = y - era * 400,
    mp = m > 2 ? m - 3 : m + 9,
    doy = Math.floor((153 * mp + 2) / 5) + day - 1,
    doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Proleptic Gregorian date of a day count since 1970-01-01.
 */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468,
    era = Math.floor(z / 146097),
    doe = z - era * 146097,
    yoe = Math.floor(
      (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
    ),
    y = yoe + era * 400,
    doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)),
    mp = Math.floor((5 * doy + 2) / 153),
    day = doy - Math.floor((153 * mp + 2) / 5) + 1,
    month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

/**
 * ISO weekday (1 = Monday ... 7 = Sunday) of a proleptic Gregorian date.
 */
export function dayOfWeek(year: number, month: number, day: number): number {
  // 1970-01-01 was a Thursday
  const days = daysFromCivil(year, month, day);
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

/**
 * Epoch milliseconds of wall-clock fields read as UTC (a "local timestamp"). Out-of-range fields
 * roll over into the next unit (hour 24 is the next day's midnight, day 32 of January is
 * February 1, ...) and fractions are truncated, matching `Date.UTC()`. NaN when not finite.
 */
export function msFromCivil(fields: GregorianDateTime): number {
  const ms =
    daysFromCivil(
      Math.trunc(fields.year),
      Math.trunc(fields.month),
      Math.trunc(fields.day)
    ) *
      MS_PER_DAY +
    Math.trunc(fields.hour) * 3600000 +
    Math.trunc(fields.minute) * 60000 +
    Math.trunc(fields.second) * 1000 +
    Math.trunc(fields.millisecond);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Wall-clock fields of epoch milliseconds read as UTC. Fractional milliseconds are truncated.
 */
export function civilFromMs(ms: number): GregorianDateTime {
  const t = Math.trunc(ms),
    days = Math.floor(t / MS_PER_DAY),
    msInDay = t - days * MS_PER_DAY,
    { year, month, day } = civilFromDays(days);
  return {
    year,
    month,
    day,
    hour: Math.floor(msInDay / 3600000),
    minute: Math.floor(msInDay / 60000) % 60,
    second: Math.floor(msInDay / 1000) % 60,
    millisecond: msInDay % 1000,
  };
}
