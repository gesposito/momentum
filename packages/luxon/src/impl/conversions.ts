import {
  integerBetween,
  timeObject,
  daysInYear,
  daysInMonth,
  weeksInWeekYear,
  isInteger,
  isUndefined,
} from "./util.js";
import Invalid from "./invalid.js";
import { ConflictingSpecificationError } from "../errors.js";
import { isRangeError, plainDate } from "./temporal.js";
import { dayOfWeek as civilDayOfWeek } from "./calendar.js";
import { isTemporalNative } from "./mode.js";
import type { PlainDate } from "./temporal.js";
import type { GregorianDateTime } from "../types.js";
import type { TimeObject } from "./util.js";

export interface WeekDateTime extends TimeObject {
  weekYear: number;
  weekNumber: number;
  weekday: number;
}

export interface OrdinalDateTime extends TimeObject {
  year: number;
  ordinal: number;
}

export interface WeekSettingsPair {
  minDaysInFirstWeek: number;
  startOfWeek: number;
}

// Luxon's ordinal arithmetic, used when Settings.temporalNative is false
const nonLeapLadder = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334],
  leapLadder = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

function computeOrdinal(year: number, month: number, day: number): number {
  return day + (daysInYear(year) === 366 ? leapLadder : nonLeapLadder)[month - 1];
}

// the month and day of an ordinal; the day may lie past the end of the month, which Luxon lets
// Date.UTC carry (as msFromCivil does)
function uncomputeOrdinal(year: number, ordinal: number): { month: number; day: number } {
  const table = daysInYear(year) === 366 ? leapLadder : nonLeapLadder,
    month0 = table.findIndex((i) => i < ordinal),
    day = ordinal - table[month0];
  return { month: month0 + 1, day };
}

function unitOutOfRange(unit: string, value: unknown): Invalid {
  return new Invalid(
    "unit out of range",
    `you specified ${value} (of type ${typeof value}) as a ${unit}, which is invalid`
  );
}

// The Gregorian calendar repeats every 400 years (146097 days, a whole number of weeks), so the
// weekday or the month and day of a date in a year beyond Temporal's range (about ±271821) are
// those of the same date in a year near 2000 that differs by a multiple of 400.
function cycleShift(year: number): number {
  return Math.abs(year) > 200000 ? Math.round((year - 2000) / 400) * 400 : 0;
}

/**
 * ISO weekday (1 = Monday ... 7 = Sunday) of a proleptic Gregorian date, from Temporal. NaN when
 * the year is not a finite number (or too large to be an exact integer).
 */
export function dayOfWeek(year: number, month: number, day: number): number {
  if (!isTemporalNative()) return civilDayOfWeek(year, month, day);
  if (!Number.isFinite(year)) return NaN;
  const y = Math.trunc(year);
  try {
    return plainDate(y - cycleShift(y), month, day).dayOfWeek;
  } catch (e) {
    if (!isRangeError(e)) throw e;
    return NaN;
  }
}

// the date of the ordinal-th day of a year, from Temporal. As in Luxon, which hands the ordinal to
// Date.UTC as a day of January, ordinals past the end of the year roll over into the next one and
// a fractional ordinal counts its whole days (0.5 is the last day of the previous year); ordinals
// of 0 or less and unrepresentable dates give NaN fields. Whole 400-year cycles are taken out of
// the ordinal first, so that Temporal only ever computes dates near the year 2000.
function ordinalToDate(year: number, ordinal: number): { year: number; month: number; day: number } {
  if (ordinal > 0 && Number.isFinite(year)) {
    const days = Math.trunc(ordinal) - 1,
      cycles = Math.floor(days / 146097),
      y = Math.trunc(year) + cycles * 400,
      shift = cycleShift(y);
    try {
      const date = plainDate(y - shift, 1, 1).add({ days: days - cycles * 146097 });
      return { year: date.year + shift, month: date.month, day: date.day };
    } catch (e) {
      if (!isRangeError(e)) throw e;
    }
  }
  return { year, month: NaN, day: NaN };
}

// the ISO calendar date of calendar fields, or null when they are not a representable date
function isoDate({ year, month, day }: GregorianDateTime): PlainDate | null {
  try {
    return plainDate(year, month, day);
  } catch (e) {
    if (!isRangeError(e)) throw e;
    return null;
  }
}

export function isoWeekdayToLocal(isoWeekday: number, startOfWeek: number): number {
  return ((isoWeekday - startOfWeek + 7) % 7) + 1;
}

/**
 * @private
 */

/**
 * Week data of a Temporal.PlainDate with the time of `time`. ISO weeks (the default settings) are
 * Temporal's own; Temporal has no locale-dependent weeks, so those keep Luxon's algorithm, fed by
 * Temporal's day of the year and day of the week.
 */
export function plainDateToWeek(
  date: PlainDate,
  time: TimeObject,
  minDaysInFirstWeek = 4,
  startOfWeek = 1
): WeekDateTime {
  if (minDaysInFirstWeek === 4 && startOfWeek === 1) {
    return {
      weekYear: date.yearOfWeek as number,
      weekNumber: date.weekOfYear as number,
      weekday: date.dayOfWeek,
      ...timeObject(time),
    };
  }

  const year = date.year,
    ordinal = date.dayOfYear,
    weekday = isoWeekdayToLocal(date.dayOfWeek, startOfWeek);

  let weekNumber = Math.floor((ordinal - weekday + 14 - minDaysInFirstWeek) / 7),
    weekYear;

  if (weekNumber < 1) {
    weekYear = year - 1;
    weekNumber = weeksInWeekYear(weekYear, minDaysInFirstWeek, startOfWeek);
  } else if (weekNumber > weeksInWeekYear(year, minDaysInFirstWeek, startOfWeek)) {
    weekYear = year + 1;
    weekNumber = 1;
  } else {
    weekYear = year;
  }

  return { weekYear, weekNumber, weekday, ...timeObject(time) };
}

export function gregorianToWeek(
  gregObj: GregorianDateTime,
  minDaysInFirstWeek = 4,
  startOfWeek = 1
): WeekDateTime {
  if (!isTemporalNative()) return civilWeek(gregObj, minDaysInFirstWeek, startOfWeek);
  const date = isoDate(gregObj);
  return date === null
    ? { weekYear: NaN, weekNumber: NaN, weekday: NaN, ...timeObject(gregObj) }
    : plainDateToWeek(date, gregObj, minDaysInFirstWeek, startOfWeek);
}

export function weekToGregorian(
  weekData: WeekDateTime,
  minDaysInFirstWeek = 4,
  startOfWeek = 1
): GregorianDateTime {
  const { weekYear, weekNumber, weekday } = weekData,
    weekdayOfJan4 = isoWeekdayToLocal(dayOfWeek(weekYear, 1, minDaysInFirstWeek), startOfWeek),
    yearInDays = daysInYear(weekYear);

  let ordinal = weekNumber * 7 + weekday - weekdayOfJan4 - 7 + minDaysInFirstWeek,
    year;

  if (ordinal < 1) {
    year = weekYear - 1;
    ordinal += daysInYear(year);
  } else if (ordinal > yearInDays) {
    year = weekYear + 1;
    ordinal -= daysInYear(weekYear);
  } else {
    year = weekYear;
  }

  return { ...dateOfOrdinal(year, ordinal), ...timeObject(weekData) };
}

export function gregorianToOrdinal(gregData: GregorianDateTime): OrdinalDateTime {
  const { year, month, day } = gregData;
  let ordinal: number;
  if (isTemporalNative()) {
    const date = isoDate(gregData);
    ordinal = date === null ? NaN : date.dayOfYear;
  } else {
    ordinal = computeOrdinal(year, month, day);
  }
  return { year, ordinal, ...timeObject(gregData) };
}

export function ordinalToGregorian(ordinalData: OrdinalDateTime): GregorianDateTime {
  return { ...dateOfOrdinal(ordinalData.year, ordinalData.ordinal), ...timeObject(ordinalData) };
}

function dateOfOrdinal(
  year: number,
  ordinal: number
): { year: number; month: number; day: number } {
  return isTemporalNative()
    ? ordinalToDate(year, ordinal)
    : { year, ...uncomputeOrdinal(year, ordinal) };
}

// Luxon's week numbering of a calendar date (Settings.temporalNative = false)
function civilWeek(
  gregObj: GregorianDateTime,
  minDaysInFirstWeek: number,
  startOfWeek: number
): WeekDateTime {
  const { year, month, day } = gregObj,
    ordinal = computeOrdinal(year, month, day),
    weekday = isoWeekdayToLocal(civilDayOfWeek(year, month, day), startOfWeek);

  let weekNumber = Math.floor((ordinal - weekday + 14 - minDaysInFirstWeek) / 7),
    weekYear;

  if (weekNumber < 1) {
    weekYear = year - 1;
    weekNumber = weeksInWeekYear(weekYear, minDaysInFirstWeek, startOfWeek);
  } else if (weekNumber > weeksInWeekYear(year, minDaysInFirstWeek, startOfWeek)) {
    weekYear = year + 1;
    weekNumber = 1;
  } else {
    weekYear = year;
  }

  return { weekYear, weekNumber, weekday, ...timeObject(gregObj) };
}

/**
 * Check if local week units like localWeekday are used in obj.
 * If so, validates that they are not mixed with ISO week units and then copies them to the normal week unit properties.
 * Modifies obj in-place!
 * @param obj the object values
 * @ignore
 */
export function usesLocalWeekValues(
  obj: Record<string, number | undefined>,
  loc: { getMinDaysInFirstWeek(): number; getStartOfWeek(): number }
): WeekSettingsPair {
  const hasLocaleWeekData =
    !isUndefined(obj.localWeekday) ||
    !isUndefined(obj.localWeekNumber) ||
    !isUndefined(obj.localWeekYear);
  if (hasLocaleWeekData) {
    const hasIsoWeekData =
      !isUndefined(obj.weekday) || !isUndefined(obj.weekNumber) || !isUndefined(obj.weekYear);

    if (hasIsoWeekData) {
      throw new ConflictingSpecificationError(
        "Cannot mix locale-based week fields with ISO-based week fields"
      );
    }
    if (!isUndefined(obj.localWeekday)) obj.weekday = obj.localWeekday;
    if (!isUndefined(obj.localWeekNumber)) obj.weekNumber = obj.localWeekNumber;
    if (!isUndefined(obj.localWeekYear)) obj.weekYear = obj.localWeekYear;
    delete obj.localWeekday;
    delete obj.localWeekNumber;
    delete obj.localWeekYear;
    return {
      minDaysInFirstWeek: loc.getMinDaysInFirstWeek(),
      startOfWeek: loc.getStartOfWeek(),
    };
  } else {
    return { minDaysInFirstWeek: 4, startOfWeek: 1 };
  }
}

export function hasInvalidWeekData(
  obj: Partial<WeekDateTime>,
  minDaysInFirstWeek = 4,
  startOfWeek = 1
): Invalid | false {
  const validYear = isInteger(obj.weekYear),
    validWeek = integerBetween(
      obj.weekNumber,
      1,
      weeksInWeekYear(obj.weekYear as number, minDaysInFirstWeek, startOfWeek)
    ),
    validWeekday = integerBetween(obj.weekday, 1, 7);

  if (!validYear) {
    return unitOutOfRange("weekYear", obj.weekYear);
  } else if (!validWeek) {
    return unitOutOfRange("week", obj.weekNumber);
  } else if (!validWeekday) {
    return unitOutOfRange("weekday", obj.weekday);
  } else return false;
}

export function hasInvalidOrdinalData(obj: Partial<OrdinalDateTime>): Invalid | false {
  const validYear = isInteger(obj.year),
    validOrdinal = integerBetween(obj.ordinal, 1, daysInYear(obj.year as number));

  if (!validYear) {
    return unitOutOfRange("year", obj.year);
  } else if (!validOrdinal) {
    return unitOutOfRange("ordinal", obj.ordinal);
  } else return false;
}

export function hasInvalidGregorianData(obj: Partial<GregorianDateTime>): Invalid | false {
  const validYear = isInteger(obj.year),
    validMonth = integerBetween(obj.month, 1, 12),
    validDay = integerBetween(obj.day, 1, daysInMonth(obj.year as number, obj.month as number));

  if (!validYear) {
    return unitOutOfRange("year", obj.year);
  } else if (!validMonth) {
    return unitOutOfRange("month", obj.month);
  } else if (!validDay) {
    return unitOutOfRange("day", obj.day);
  } else return false;
}

export function hasInvalidTimeData(obj: Partial<TimeObject>): Invalid | false {
  const { hour, minute, second, millisecond } = obj;
  const validHour =
      integerBetween(hour, 0, 23) ||
      (hour === 24 && minute === 0 && second === 0 && millisecond === 0),
    validMinute = integerBetween(minute, 0, 59),
    validSecond = integerBetween(second, 0, 59),
    validMillisecond = integerBetween(millisecond, 0, 999);

  if (!validHour) {
    return unitOutOfRange("hour", hour);
  } else if (!validMinute) {
    return unitOutOfRange("minute", minute);
  } else if (!validSecond) {
    return unitOutOfRange("second", second);
  } else if (!validMillisecond) {
    return unitOutOfRange("millisecond", millisecond);
  } else return false;
}
