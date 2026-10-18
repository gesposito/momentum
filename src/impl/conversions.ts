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
import { dayOfWeek } from "./calendar.js";
import type { GregorianDateTime } from "../types.js";
import type { TimeObject } from "./util.js";

export { dayOfWeek };

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

const nonLeapLadder = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334],
  leapLadder = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

function unitOutOfRange(unit: string, value: unknown): Invalid {
  return new Invalid(
    "unit out of range",
    `you specified ${value} (of type ${typeof value}) as a ${unit}, which is invalid`
  );
}

function isLeap(year: number): boolean {
  return daysInYear(year) === 366;
}

function computeOrdinal(year: number, month: number, day: number): number {
  return day + (isLeap(year) ? leapLadder : nonLeapLadder)[month - 1];
}

function uncomputeOrdinal(year: number, ordinal: number): { month: number; day: number } {
  const table = isLeap(year) ? leapLadder : nonLeapLadder,
    month0 = table.findIndex((i) => i < ordinal),
    day = ordinal - table[month0];
  return { month: month0 + 1, day };
}

export function isoWeekdayToLocal(isoWeekday: number, startOfWeek: number): number {
  return ((isoWeekday - startOfWeek + 7) % 7) + 1;
}

/**
 * @private
 */

export function gregorianToWeek(
  gregObj: GregorianDateTime,
  minDaysInFirstWeek = 4,
  startOfWeek = 1
): WeekDateTime {
  const { year, month, day } = gregObj,
    ordinal = computeOrdinal(year, month, day),
    weekday = isoWeekdayToLocal(dayOfWeek(year, month, day), startOfWeek);

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

  const { month, day } = uncomputeOrdinal(year, ordinal);
  return { year, month, day, ...timeObject(weekData) };
}

export function gregorianToOrdinal(gregData: GregorianDateTime): OrdinalDateTime {
  const { year, month, day } = gregData;
  const ordinal = computeOrdinal(year, month, day);
  return { year, ordinal, ...timeObject(gregData) };
}

export function ordinalToGregorian(ordinalData: OrdinalDateTime): GregorianDateTime {
  const { year, ordinal } = ordinalData;
  const { month, day } = uncomputeOrdinal(year, ordinal);
  return { year, month, day, ...timeObject(ordinalData) };
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
