/*
  This is just a junk drawer, containing anything used across multiple classes.
  Because momentum is small(ish), this should stay small and we won't worry about splitting
  it up into, say, parsingUtil.js and basicUtil.js and so on. But they are divided up by feature area.
*/

import { InvalidArgumentError } from "../errors.js";
import Settings from "../settings.js";
import { dayOfWeek, isoWeekdayToLocal } from "./conversions.js";
import type { WeekSettings, ZoneOffsetFormat } from "../types.js";

/**
 * @private
 */

// TYPES

export function isUndefined(o: unknown): o is undefined {
  return typeof o === "undefined";
}

export function isNumber(o: unknown): o is number {
  return typeof o === "number";
}

export function isInteger(o: unknown): o is number {
  return typeof o === "number" && o % 1 === 0;
}

export function isString(o: unknown): o is string {
  return typeof o === "string";
}

export function isDate(o: unknown): o is Date {
  return Object.prototype.toString.call(o) === "[object Date]";
}

// CAPABILITIES

export function hasRelative(): boolean {
  try {
    return typeof Intl !== "undefined" && !!Intl.RelativeTimeFormat;
  } catch (e) {
    return false;
  }
}

export function hasLocaleWeekInfo(): boolean {
  try {
    return (
      typeof Intl !== "undefined" &&
      !!Intl.Locale &&
      ("weekInfo" in Intl.Locale.prototype || "getWeekInfo" in Intl.Locale.prototype)
    );
  } catch (e) {
    return false;
  }
}

// OBJECTS AND ARRAYS

export function maybeArray<T>(thing: T | T[]): T[] {
  return Array.isArray(thing) ? thing : [thing];
}

export function bestBy<T, U>(
  arr: T[],
  by: (item: T) => U,
  compare: (a: U, b: U) => U
): T | undefined {
  if (arr.length === 0) {
    return undefined;
  }
  return arr.reduce<[U, T] | null>((best, next) => {
    const pair: [U, T] = [by(next), next];
    if (!best) {
      return pair;
    } else if (compare(best[0], pair[0]) === best[0]) {
      return best;
    } else {
      return pair;
    }
  }, null)![1];
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  return keys.reduce((a, k) => {
    a[k] = obj[k];
    return a;
  }, {} as Pick<T, K>);
}

export function hasOwnProperty(obj: object, prop: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

export function validateWeekSettings(settings: unknown): WeekSettings | null {
  if (settings == null) {
    return null;
  } else if (typeof settings !== "object") {
    throw new InvalidArgumentError("Week settings must be an object");
  } else {
    const s = settings as Partial<WeekSettings>;
    if (
      !integerBetween(s.firstDay, 1, 7) ||
      !integerBetween(s.minimalDays, 1, 7) ||
      !Array.isArray(s.weekend) ||
      s.weekend.some((v) => !integerBetween(v, 1, 7))
    ) {
      throw new InvalidArgumentError("Invalid week settings");
    }
    return {
      firstDay: s.firstDay as number,
      minimalDays: s.minimalDays as number,
      weekend: Array.from(s.weekend),
    };
  }
}

// NUMBERS AND STRINGS

export function integerBetween(thing: unknown, bottom: number, top: number): boolean {
  return isInteger(thing) && thing >= bottom && thing <= top;
}

// x % n but takes the sign of n instead of x
export function floorMod(x: number, n: number): number {
  return x - n * Math.floor(x / n);
}

export function padStart(input: number | string, n = 2): string {
  const isNeg = typeof input === "number" ? input < 0 : false;
  let padded;
  if (isNeg) {
    padded = "-" + ("" + -(input as number)).padStart(n, "0");
  } else {
    padded = ("" + input).padStart(n, "0");
  }
  return padded;
}

export function parseInteger(string: string | null | undefined): number | undefined {
  if (isUndefined(string) || string === null || string === "") {
    return undefined;
  } else {
    return parseInt(string, 10);
  }
}

export function parseFloating(string: string | null | undefined): number | undefined {
  if (isUndefined(string) || string === null || string === "") {
    return undefined;
  } else {
    return parseFloat(string);
  }
}

export function parseMillis(fraction: string | null | undefined): number | undefined {
  // Return undefined (instead of 0) in these cases, where fraction is not set
  if (isUndefined(fraction) || fraction === null || fraction === "") {
    return undefined;
  } else {
    const f = parseFloat("0." + fraction) * 1000;
    return Math.floor(f);
  }
}

export function roundTo(number: number, digits: number, rounding = "round"): number {
  const factor = 10 ** digits;
  switch (rounding) {
    case "expand":
      return number > 0
        ? Math.ceil(number * factor) / factor
        : Math.floor(number * factor) / factor;
    case "trunc":
      return Math.trunc(number * factor) / factor;
    case "round":
      return Math.round(number * factor) / factor;
    case "floor":
      return Math.floor(number * factor) / factor;
    case "ceil":
      return Math.ceil(number * factor) / factor;
    default:
      throw new RangeError(`Value rounding ${rounding} is out of range`);
  }
}

export function snapFloatingPoint(val: number): number {
  const r = Math.round(val);
  return Math.abs(val - r) < 4 * Number.EPSILON * Math.max(1, Math.abs(r)) ? r : val;
}

// DATE BASICS

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

export function daysInMonth(year: number, month: number): number {
  const modMonth = floorMod(month - 1, 12) + 1,
    modYear = year + (month - modMonth) / 12;

  if (modMonth === 2) {
    return isLeapYear(modYear) ? 29 : 28;
  } else {
    return [31, null, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][modMonth - 1] as number;
  }
}

// adapted from moment.js: https://github.com/moment/moment/blob/000ac1800e620f770f4eb31b5ae908f6167b0ab2/src/lib/units/week-calendar-utils.js
function firstWeekOffset(year: number, minDaysInFirstWeek: number, startOfWeek: number): number {
  const fwdlw = isoWeekdayToLocal(dayOfWeek(year, 1, minDaysInFirstWeek), startOfWeek);
  return -fwdlw + minDaysInFirstWeek - 1;
}

export function weeksInWeekYear(weekYear: number, minDaysInFirstWeek = 4, startOfWeek = 1): number {
  const weekOffset = firstWeekOffset(weekYear, minDaysInFirstWeek, startOfWeek);
  const weekOffsetNext = firstWeekOffset(weekYear + 1, minDaysInFirstWeek, startOfWeek);
  return (daysInYear(weekYear) - weekOffset + weekOffsetNext) / 7;
}

export function untruncateYear(year: number): number {
  if (year > 99) {
    return year;
  } else return year > Settings.twoDigitCutoffYear ? 1900 + year : 2000 + year;
}

// PARSING

export function parseZoneInfo(
  ts: number,
  offsetFormat: "short" | "long" | undefined,
  locale: string | undefined,
  timeZone: string | null = null
): string | null {
  const date = new Date(ts),
    intlOpts: Intl.DateTimeFormatOptions = {
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    };

  if (timeZone) {
    intlOpts.timeZone = timeZone;
  }

  const modified: Intl.DateTimeFormatOptions = { timeZoneName: offsetFormat, ...intlOpts };

  const parsed = new Intl.DateTimeFormat(locale, modified)
    .formatToParts(date)
    .find((m) => m.type.toLowerCase() === "timezonename");
  return parsed ? parsed.value : null;
}

// signedOffset('-5', '30') -> -330
export function signedOffset(
  offHourStr: string | undefined,
  offMinuteStr: string | undefined
): number {
  let offHour = parseInt(offHourStr as string, 10);

  // don't || this because we want to preserve -0
  if (Number.isNaN(offHour)) {
    offHour = 0;
  }

  const offMin = parseInt(offMinuteStr as string, 10) || 0,
    offMinSigned = offHour < 0 || Object.is(offHour, -0) ? -offMin : offMin;
  return offHour * 60 + offMinSigned;
}

// COERCION

export function asNumber(value: unknown): number {
  const numericValue = Number(value);
  if (typeof value === "boolean" || value === "" || !Number.isFinite(numericValue))
    throw new InvalidArgumentError(`Invalid unit value ${value}`);
  return numericValue;
}

export function normalizeObject<K extends string>(
  obj: object,
  normalizer: (unit: string) => K
): Record<K, number> {
  const normalized = {} as Record<K, number>;
  for (const u in obj) {
    if (hasOwnProperty(obj, u)) {
      const v = (obj as Record<string, unknown>)[u];
      if (v === undefined || v === null) continue;
      normalized[normalizer(u)] = asNumber(v);
    }
  }
  return normalized;
}

/**
 * Returns the offset's value as a string
 * @param offset - offset in minutes
 * @param format - What style of offset to return.
 *                 Accepts 'narrow', 'short', or 'techie'. Returning '+6', '+06:00', or '+0600' respectively
 * @ignore
 */
export function formatOffset(offset: number, format: ZoneOffsetFormat): string {
  const hours = Math.trunc(Math.abs(offset / 60)),
    minutes = Math.trunc(Math.abs(offset % 60)),
    sign = offset >= 0 ? "+" : "-";

  switch (format) {
    case "short":
      return `${sign}${padStart(hours, 2)}:${padStart(minutes, 2)}`;
    case "narrow":
      return `${sign}${hours}${minutes > 0 ? `:${minutes}` : ""}`;
    case "techie":
      return `${sign}${padStart(hours, 2)}${padStart(minutes, 2)}`;
    default:
      throw new RangeError(`Value format ${format} is out of range for property format`);
  }
}

export interface TimeObject {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

export function timeObject(obj: TimeObject): TimeObject {
  return pick(obj, ["hour", "minute", "second", "millisecond"]);
}
