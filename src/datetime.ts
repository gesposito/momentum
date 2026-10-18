import Duration from "./duration.js";
import Interval from "./interval.js";
import Settings from "./settings.js";
import Info from "./info.js";
import Formatter from "./impl/formatter.js";
import FixedOffsetZone from "./zones/fixedOffsetZone.js";
import Locale from "./impl/locale.js";
import {
  isUndefined,
  maybeArray,
  isDate,
  isNumber,
  bestBy,
  daysInMonth,
  daysInYear,
  isLeapYear,
  weeksInWeekYear,
  normalizeObject,
  roundTo,
  padStart,
} from "./impl/util.js";
import { normalizeZone, temporalZoneId } from "./impl/zoneUtil.js";
import diff from "./impl/diff.js";
import { parseRFC2822Date, parseISODate, parseHTTPDate, parseSQL } from "./impl/regexParser.js";
import {
  parseFromTokens,
  explainFromTokens,
  formatOptsToTokens,
  expandMacroTokens,
  TokenParser,
} from "./impl/tokenParser.js";
import {
  gregorianToWeek,
  weekToGregorian,
  gregorianToOrdinal,
  ordinalToGregorian,
  hasInvalidGregorianData,
  hasInvalidWeekData,
  hasInvalidOrdinalData,
  hasInvalidTimeData,
  usesLocalWeekValues,
} from "./impl/conversions.js";
import type { WeekDateTime, OrdinalDateTime } from "./impl/conversions.js";
import * as Formats from "./impl/formats.js";
import {
  InvalidArgumentError,
  ConflictingSpecificationError,
  InvalidUnitError,
  InvalidDateTimeError,
} from "./errors.js";
import Invalid from "./impl/invalid.js";
import {
  isRangeError,
  isRepresentableTs,
  MAX_EPOCH_MS,
  offsetMinutes,
  offsetTimeZoneId,
  plainDate,
  resolveWallClock,
  utcMillis,
  temporal,
  wallClock,
  wallClockAtOffset,
  zonedDateTime,
} from "./impl/temporal.js";
import type { Instant, PlainDate, PlainDateTime, PlainTime, ZonedDateTime } from "./impl/temporal.js";
import type Zone from "./zone.js";
import type {
  DateObjectUnits,
  DateTimeLike,
  DateTimeOptions,
  DateTimeUnit,
  DateTimeUnitPlural,
  DiffOptions,
  DurationLike,
  DurationUnit,
  DurationUnits,
  ExplainedFormat,
  GregorianDateTime,
  GregorianDateTimeWithConfig,
  LocaleOptions,
  RoundingMode,
  SetZoneOptions,
  StartOfOptions,
  ToISODateOptions,
  ToISOOptions,
  ToISOTimeOptions,
  ToObjectOptions,
  ToRelativeCalendarOptions,
  ToRelativeOptions,
  ToSQLOptions,
  ZoneLike,
} from "./types.js";

const INVALID = "Invalid DateTime";
const MAX_DATE = 8.64e15;
const INSPECT = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");

interface DateTimeConfig {
  ts?: number;
  zone?: Zone;
  loc?: Locale;
  invalid?: Invalid | null;
  wasHole?: boolean;
  /** calendar fields already known for `ts` in `zone`; trusted only together with `o` */
  c?: GregorianDateTime | null;
  /** offset in minutes already known for `ts` in `zone`; trusted only together with `c` */
  o?: number | null;
}

interface CloneAlts {
  ts?: number;
  zone?: Zone;
  loc?: Locale;
  wasHole?: boolean;
  c?: GregorianDateTime | null;
  o?: number | null;
}

interface ResolvedLocal {
  ts: number;
  o: number;
  c: GregorianDateTime;
  wasHole: boolean;
}

interface FromObjectOptions extends DateTimeOptions {
  /** @internal offset the parsed input was explicitly given with */
  specificOffset?: number;
  /** @internal timestamp to use for defaulting unspecified high-order units */
  overrideNow?: number | null;
}

type NormalizedUnit =
  | "year"
  | "month"
  | "day"
  | "hour"
  | "minute"
  | "quarter"
  | "second"
  | "millisecond"
  | "weekday"
  | "weekNumber"
  | "weekYear"
  | "ordinal";

type NormalizedUnitWithLocalWeeks =
  | NormalizedUnit
  | "localWeekday"
  | "localWeekNumber"
  | "localWeekYear";

function unsupportedZone(zone: Zone): Invalid {
  return new Invalid("unsupported zone", `the zone "${zone.name}" is not supported`);
}

// A valid DateTime in a built-in zone is an instant (`ts`) in a Temporal time zone (`tz`), that
// is, a Temporal.ZonedDateTime. Its calendar fields and offset are read from that ZonedDateTime
// the first time they are needed and cached on the instance; DateTimes that only take part in
// instant arithmetic and comparisons never pay for it. Custom zones have no Temporal time zone,
// so their fields are computed up front from the zone's offset (see the constructor).
function deriveFields(dt: DateTime): void {
  const zdt = zonedDateTime(dt.ts, dt.tz as string);
  dt.c = wallClock(zdt);
  dt.o = offsetMinutes(zdt);
}

// calendar fields of a valid DateTime in its zone
function fieldsOf(dt: DateTime): GregorianDateTime {
  if (dt.c === null) deriveFields(dt);
  return dt.c as GregorianDateTime;
}

// offset of a valid DateTime in minutes
function offsetOf(dt: DateTime): number {
  if (dt.o === null) deriveFields(dt);
  return dt.o as number;
}

// we cache week data on the DT object and this intermediates the cache
/**
 * @ignore
 */
function possiblyCachedWeekData(dt: DateTime): WeekDateTime {
  if (dt.weekData === null) {
    dt.weekData = gregorianToWeek(fieldsOf(dt));
  }
  return dt.weekData;
}

/**
 * @ignore
 */
function possiblyCachedLocalWeekData(dt: DateTime): WeekDateTime {
  if (dt.localWeekData === null) {
    dt.localWeekData = gregorianToWeek(
      fieldsOf(dt),
      dt.loc.getMinDaysInFirstWeek(),
      dt.loc.getStartOfWeek()
    );
  }
  return dt.localWeekData;
}

// clone really means, "make a new object with these modifications". all "setters" really use this
// to create a new object while only changing some of the properties
function clone(inst: DateTime, alts: CloneAlts): DateTime {
  const ts = alts.ts ?? inst.ts,
    zone = alts.zone ?? inst.zone,
    unchanged = ts === inst.ts && zone.equals(inst.zone);
  return new DateTime({
    ts,
    zone,
    loc: alts.loc ?? inst.loc,
    invalid: inst.invalid,
    wasHole: alts.wasHole ?? inst.wasHole,
    c: alts.c ?? (unchanged ? inst.c : null),
    o: alts.o ?? (unchanged ? inst.o : null),
  });
}

// find the right offset a given local time. The o input is our guess, which determines which
// offset we'll pick in ambiguous cases (e.g. there are two 3 AMs b/c Fallback DST).
// Only used for custom zones, which Temporal cannot represent; built-in zones are resolved by
// Temporal.ZonedDateTime.from (see resolveWallClock).
function fixOffset(localTS: number, o: number, tz: Zone): [number, number, boolean] {
  // Our UTC time is just a guess because our offset is just a guess
  let utcGuess = localTS - o * 60 * 1000;

  // Test whether the zone matches the offset for this ts
  const o2 = tz.offset(utcGuess);

  // If so, offset didn't change and we're done
  if (o === o2) {
    return [utcGuess, o, false];
  }

  // If not, change the ts by the difference in the offset
  utcGuess -= (o2 - o) * 60 * 1000;

  // If that gives us the local time we want, we're done
  const o3 = tz.offset(utcGuess);
  if (o2 === o3) {
    return [utcGuess, o2, false];
  }

  // If it's different, we're in a hole time. The offset has changed, but the we don't adjust the time
  return [localTS - Math.min(o2, o3) * 60 * 1000, Math.max(o2, o3), true];
}

// calendar fields of an epoch timestamp at a UTC offset (in minutes), or null when not
// representable. Luxon computes local times with Date, so the local time must be within Date's
// range as well as the instant
function fieldsAtOffset(ts: number, offset: number): GregorianDateTime | null {
  if (!isRepresentableTs(ts + offset * 60 * 1000)) return null;
  try {
    return wallClockAtOffset(ts, offset);
  } catch (e) {
    if (!isRangeError(e)) throw e;
    return null;
  }
}

// convert wall-clock fields in a zone to an instant, resolving DST gaps and overlaps (see
// resolveWallClock). offsetGuess picks the candidate for ambiguous times (when it is one of them).
// Null when the result is not representable.
function resolveFields(
  fields: GregorianDateTime,
  offsetGuess: number,
  zone: Zone
): ResolvedLocal | null {
  try {
    const tz = temporalZoneId(zone);
    let resolved: ResolvedLocal;
    if (tz !== null) {
      const { zdt, fields: c, wasHole } = resolveWallClock(fields, tz, offsetGuess);
      resolved = { ts: zdt.epochMilliseconds, o: offsetMinutes(zdt), c, wasHole };
    } else {
      // custom zones only report the offset of an instant: Luxon's fixOffset, starting from the
      // instant the wall clock would have in UTC
      const [ts, o, wasHole] = fixOffset(utcMillis(fields), offsetGuess, zone);
      if (!isRepresentableTs(ts) || !Number.isFinite(o)) return null;
      resolved = { ts, o, c: wallClockAtOffset(ts, o), wasHole };
    }
    // Luxon computes local times with Date, so the local time must be within Date's range too
    return isRepresentableTs(resolved.ts + resolved.o * 60 * 1000) ? resolved : null;
  } catch (e) {
    if (!isRangeError(e)) throw e;
    return null;
  }
}

// getPossibleOffsets() for custom zones, which only report the offset of an instant: Luxon's
// algorithm, probing the zone's offsets a day before and a day after the wall clock
function possibleOffsetsFromZoneOffsets(dt: DateTime): DateTime[] {
  const dayMs = 86400000,
    minuteMs = 60000,
    zone = dt.zone;
  let localTS: number;
  try {
    localTS = utcMillis(fieldsOf(dt));
  } catch (e) {
    if (!isRangeError(e)) throw e;
    return [dt];
  }
  const oEarlier = zone.offset(localTS - dayMs),
    oLater = zone.offset(localTS + dayMs),
    o1 = zone.offset(localTS - oEarlier * minuteMs),
    o2 = zone.offset(localTS - oLater * minuteMs);
  if (o1 === o2) {
    return [dt];
  }
  const ts1 = localTS - o1 * minuteMs,
    ts2 = localTS - o2 * minuteMs,
    c1 = fieldsAtOffset(ts1, o1),
    c2 = fieldsAtOffset(ts2, o2);
  if (
    c1 !== null &&
    c2 !== null &&
    c1.hour === c2.hour &&
    c1.minute === c2.minute &&
    c1.second === c2.second &&
    c1.millisecond === c2.millisecond
  ) {
    return [clone(dt, { ts: ts1, c: c1, o: o1 }), clone(dt, { ts: ts2, c: c2, o: o2 })];
  }
  return [dt];
}

const notRepresentable: CloneAlts = { ts: NaN, c: null, o: null, wasHole: false };

// the calendar fields of an instant that cannot be represented (never mutated)
const unknownFields: GregorianDateTime = {
  year: NaN,
  month: NaN,
  day: NaN,
  hour: NaN,
  minute: NaN,
  second: NaN,
  millisecond: NaN,
};

// shift the calendar date of a valid DateTime by whole months, then by whole days, keeping the
// time of day; null when not representable
function shiftDate(inst: DateTime, months: number, days: number): ResolvedLocal | null {
  const c = fieldsOf(inst);
  let date: PlainDate;
  try {
    // the day is clamped to the length of the target month (Temporal's "constrain" overflow),
    // which is what Luxon does before it adds days
    date = plainDate(c.year, c.month, c.day);
    if (months !== 0) date = date.add({ months });
    if (days !== 0) date = date.add({ days });
  } catch (e) {
    if (!isRangeError(e)) throw e;
    return null;
  }
  return resolveFields(
    { ...c, year: date.year, month: date.month, day: date.day },
    offsetOf(inst),
    inst.zone
  );
}

// create a new DT instance by adding a duration, adjusting for DSTs
function adjustTime(inst: DateTime, dur: Duration): CloneAlts {
  // calendar units move the wall clock (Temporal.PlainDate#add, years and months before days,
  // which keeps plus({ months: 1, days: -1 }) equal to plus({ months: 1 }).plus({ days: -1 }));
  // the new wall clock is resolved with the previous offset as the guess. Time units, and the
  // fractions of calendar units, are exact milliseconds added to the instant.
  const months = Math.trunc(dur.years) * 12 + Math.trunc(dur.quarters) * 3 + Math.trunc(dur.months),
    days = Math.trunc(dur.weeks) * 7 + Math.trunc(dur.days),
    millisToAdd = Duration.fromObject({
      years: dur.years - Math.trunc(dur.years),
      quarters: dur.quarters - Math.trunc(dur.quarters),
      months: dur.months - Math.trunc(dur.months),
      weeks: dur.weeks - Math.trunc(dur.weeks),
      days: dur.days - Math.trunc(dur.days),
      hours: dur.hours,
      minutes: dur.minutes,
      seconds: dur.seconds,
      milliseconds: dur.milliseconds,
    }).as("milliseconds");

  let alts: CloneAlts;
  if (months !== 0 || days !== 0) {
    const resolved = shiftDate(inst, months, days);
    if (resolved === null) return notRepresentable;
    alts = resolved;
  } else {
    alts = { wasHole: false };
  }

  if (millisToAdd !== 0) {
    // that could have changed the offset by going over a DST; the fields and offset are
    // derived from the new instant when needed
    alts = { ts: (alts.ts ?? inst.ts) + millisToAdd, c: null, o: null, wasHole: alts.wasHole };
  }

  return alts;
}

// helper useful in turning the results of parsing into real dates
// by handling the zone options
export function parseDataToDateTime(
  parsed: DateObjectUnits | Record<string, number | undefined> | null | undefined,
  parsedZone: Zone | null | undefined,
  opts: FromObjectOptions,
  format: string,
  text: string,
  specificOffset?: number
): DateTime {
  const { setZone, zone } = opts;
  if ((parsed && Object.keys(parsed).length !== 0) || parsedZone) {
    const interpretationZone = parsedZone || zone,
      inst = DateTime.fromObject(parsed as DateObjectUnits, {
        ...opts,
        zone: interpretationZone,
        specificOffset,
      });
    return setZone ? inst : inst.setZone(zone);
  } else {
    return DateTime.invalid(
      new Invalid("unparsable", `the input "${text}" can't be parsed as ${format}`)
    );
  }
}

// if you want to output a technical format (e.g. RFC 2822), this helper
// helps handle the details
function toTechFormat(dt: DateTime, format: string, allowZ = true): string | null {
  return dt.isValid
    ? Formatter.create(Locale.create("en-US"), {
        allowZ,
        forceSimple: true,
      }).formatDateTimeFromString(dt, format)
    : null;
}

function toISODate(o: DateTime, extended: boolean, precision?: string): string {
  const c = fieldsOf(o);
  const longFormat = c.year > 9999 || c.year < 0;
  let s = "";
  if (longFormat && c.year >= 0) s += "+";
  s += padStart(c.year, longFormat ? 6 : 4);
  if (precision === "year") return s;
  if (extended) {
    s += "-";
    s += padStart(c.month);
    if (precision === "month") return s;
    s += "-";
  } else {
    s += padStart(c.month);
    if (precision === "month") return s;
  }
  s += padStart(c.day);
  return s;
}

function toISOTime(
  o: DateTime,
  extended: boolean,
  suppressSeconds: boolean,
  suppressMilliseconds: boolean,
  includeOffset: boolean,
  extendedZone: boolean,
  precision: string
): string {
  const c = fieldsOf(o),
    offset = offsetOf(o);
  const showSeconds = !suppressSeconds || c.millisecond !== 0 || c.second !== 0;
  let s = "";
  switch (precision) {
    case "day":
    case "month":
    case "year":
      break;
    default:
      s += padStart(c.hour);
      if (precision === "hour") break;
      if (extended) {
        s += ":";
        s += padStart(c.minute);
        if (precision === "minute") break;
        if (showSeconds) {
          s += ":";
          s += padStart(c.second);
        }
      } else {
        s += padStart(c.minute);
        if (precision === "minute") break;
        if (showSeconds) {
          s += padStart(c.second);
        }
      }
      if (precision === "second") break;
      if (showSeconds && (!suppressMilliseconds || c.millisecond !== 0)) {
        s += ".";
        s += padStart(c.millisecond, 3);
      }
  }

  if (includeOffset) {
    if (o.isOffsetFixed && o.offset === 0 && !extendedZone) {
      s += "Z";
    } else if (offset < 0) {
      s += "-";
      s += padStart(Math.trunc(-offset / 60));
      if (extended) {
        s += ":";
      }
      s += padStart(Math.trunc(-offset % 60));
    } else {
      s += "+";
      s += padStart(Math.trunc(offset / 60));
      if (extended) {
        s += ":";
      }
      s += padStart(Math.trunc(offset % 60));
    }
  }

  if (extendedZone) {
    s += "[" + o.zone.ianaName + "]";
  }
  return s;
}

// defaults for unspecified units in the supported calendars
const defaultUnitValues: Record<string, number> = {
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  },
  defaultWeekUnitValues: Record<string, number> = {
    weekNumber: 1,
    weekday: 1,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  },
  defaultOrdinalUnitValues: Record<string, number> = {
    ordinal: 1,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  };

// Units in the supported calendars, sorted by bigness
const orderedUnits = ["year", "month", "day", "hour", "minute", "second", "millisecond"],
  orderedWeekUnits = [
    "weekYear",
    "weekNumber",
    "weekday",
    "hour",
    "minute",
    "second",
    "millisecond",
  ],
  orderedOrdinalUnits = ["year", "ordinal", "hour", "minute", "second", "millisecond"];

// standardize case and plurality in units
function normalizeUnit(unit: string): NormalizedUnit {
  const normalized = (
    {
      year: "year",
      years: "year",
      month: "month",
      months: "month",
      day: "day",
      days: "day",
      hour: "hour",
      hours: "hour",
      minute: "minute",
      minutes: "minute",
      quarter: "quarter",
      quarters: "quarter",
      second: "second",
      seconds: "second",
      millisecond: "millisecond",
      milliseconds: "millisecond",
      weekday: "weekday",
      weekdays: "weekday",
      weeknumber: "weekNumber",
      weeksnumber: "weekNumber",
      weeknumbers: "weekNumber",
      weekyear: "weekYear",
      weekyears: "weekYear",
      ordinal: "ordinal",
    } as Record<string, NormalizedUnit>
  )[unit.toLowerCase()];

  if (!normalized) throw new InvalidUnitError(unit);

  return normalized;
}

function normalizeUnitWithLocalWeeks(unit: string): NormalizedUnitWithLocalWeeks {
  switch (unit.toLowerCase()) {
    case "localweekday":
    case "localweekdays":
      return "localWeekday";
    case "localweeknumber":
    case "localweeknumbers":
      return "localWeekNumber";
    case "localweekyear":
    case "localweekyears":
      return "localWeekYear";
    default:
      return normalizeUnit(unit);
  }
}

// cache offsets for zones based on the current timestamp when this function is
// first called. When we are handling a datetime from components like (year,
// month, day, hour) in a time zone, we need a guess about what the timezone
// offset is so that we can convert into a UTC timestamp. One way is to find the
// offset of now in the zone. The actual date may have a different offset (for
// example, if we handle a date in June while we're in December in a zone that
// observes DST), but we can check and adjust that.
//
// When handling many dates, calculating the offset for now every time is
// expensive. It's just a guess, so we can cache the offset to use even if we
// are right on a time change boundary (we'll just correct in the other
// direction). Using a timestamp from first read is a slight optimization for
// handling dates close to the current date, since those dates will usually be
// in the same offset (we could set the timestamp statically, instead). We use a
// single timestamp for all zones to make things a bit more predictable.
//
// This is safe for quickDT (used by local() and utc()) because we don't fill in
// higher-order units from tsNow (as we do in fromObject, this requires that
// offset is calculated from tsNow).
/**
 * @ignore
 */
function guessOffsetForZone(zone: Zone): number {
  if (zoneOffsetTs === undefined) {
    zoneOffsetTs = Settings.now();
  }

  // Do not cache anything but IANA zones, because it is not safe to do so.
  // Guessing an offset which is not present in the zone can cause wrong results from fixOffset
  if (zone.type !== "iana") {
    return zone.offset(zoneOffsetTs);
  }
  const zoneName = zone.name;
  let offsetGuess = zoneOffsetGuessCache.get(zoneName);
  if (offsetGuess === undefined) {
    offsetGuess = zone.offset(zoneOffsetTs);
    zoneOffsetGuessCache.set(zoneName, offsetGuess);
  }
  return offsetGuess;
}

// this is a dumbed down version of fromObject() that runs about 60% faster
// but doesn't do any validation, makes a bunch of assumptions about what units
// are present, and so on.
function quickDT(obj: Record<string, number | undefined>, opts: DateTimeOptions): DateTime {
  const zone = normalizeZone(opts.zone, Settings.defaultZone);
  if (!zone.isValid) {
    return DateTime.invalid(unsupportedZone(zone));
  }

  const loc = Locale.fromObject(opts);

  // assume we have the higher-order units
  if (!isUndefined(obj.year)) {
    for (const u of orderedUnits) {
      if (isUndefined(obj[u])) {
        obj[u] = defaultUnitValues[u];
      }
    }

    const invalid = hasInvalidGregorianData(obj) || hasInvalidTimeData(obj);
    if (invalid) {
      return DateTime.invalid(invalid);
    }

    const offsetProvis = guessOffsetForZone(zone);
    const resolved = resolveFields(obj as unknown as GregorianDateTime, offsetProvis, zone);
    return new DateTime({ ...(resolved ?? notRepresentable), zone, loc });
  }

  return new DateTime({ ts: Settings.now(), zone, loc });
}

interface DiffRelativeOptions {
  round?: boolean;
  rounding?: RoundingMode;
  calendary?: boolean;
  unit?: string;
  units: string[];
  numeric: "always" | "auto";
  locale?: string;
  numberingSystem?: string;
  style?: "long" | "short" | "narrow";
}

function diffRelative(start: DateTime, end: DateTime, opts: DiffRelativeOptions): string {
  const round = isUndefined(opts.round) ? true : opts.round,
    rounding = isUndefined(opts.rounding) ? "trunc" : opts.rounding,
    format = (c: number, unit: string) => {
      c = roundTo(c, round || opts.calendary ? 0 : 2, opts.calendary ? "round" : rounding);
      const formatter = end.loc.clone(opts).relFormatter(opts);
      return formatter.format(c, unit);
    },
    differ = (unit: string) => {
      if (opts.calendary) {
        if (!end.hasSame(start, unit as DurationUnits)) {
          return end
            .startOf(unit as DurationUnits)
            .diff(start.startOf(unit as DurationUnits), unit as DurationUnits)
            .get(unit as DurationUnits);
        } else return 0;
      } else {
        return end.diff(start, unit as DurationUnits).get(unit as DurationUnits);
      }
    };

  if (opts.unit) {
    return format(differ(opts.unit), opts.unit);
  }

  for (const unit of opts.units) {
    const count = differ(unit);
    if (Math.abs(count) >= 1) {
      return format(count, unit);
    }
  }
  return format(start > end ? -0 : 0, opts.units[opts.units.length - 1]);
}

function lastOpts(argList: IArguments | unknown[]): [DateTimeOptions, number[]] {
  let opts: DateTimeOptions = {},
    args: number[];
  if (argList.length > 0 && typeof argList[argList.length - 1] === "object") {
    opts = argList[argList.length - 1] as DateTimeOptions;
    args = Array.from(argList as unknown[]).slice(0, argList.length - 1) as number[];
  } else {
    args = Array.from(argList as unknown[]) as number[];
  }
  return [opts, args];
}

/**
 * Timestamp to use for cached zone offset guesses (exposed for test)
 * @ignore
 */
let zoneOffsetTs: number | undefined;
/**
 * Cache for zone offset guesses (exposed for test).
 *
 * This optimizes quickDT via guessOffsetForZone to avoid repeated calls of
 * zone.offset().
 *
 * @ignore
 */
const zoneOffsetGuessCache = /* @__PURE__ */ new Map<string, number>();

/**
 * A DateTime is an immutable data structure representing a specific date and time and accompanying methods. It contains class and instance methods for creating, parsing, interrogating, transforming, and formatting them.
 *
 * A DateTime comprises of:
 * * A timestamp. Each DateTime instance refers to a specific millisecond of the Unix epoch.
 * * A time zone. Each instance is considered in the context of a specific zone (by default the local system's zone).
 * * Configuration properties that effect how output strings are formatted, such as `locale`, `numberingSystem`, and `outputCalendar`.
 *
 * Here is a brief overview of the most commonly used functionality it provides:
 *
 * * **Creation**: To create a DateTime from its components, use one of its factory class methods: {@link DateTime.local}, {@link DateTime.utc}, and (most flexibly) {@link DateTime.fromObject}. To create one from a standard string format, use {@link DateTime.fromISO}, {@link DateTime.fromHTTP}, and {@link DateTime.fromRFC2822}. To create one from a custom string format, use {@link DateTime.fromFormat}. To create one from a native JS date, use {@link DateTime.fromJSDate}. To create one from a Temporal object, use {@link DateTime.fromZonedDateTime} or {@link DateTime.fromInstant}.
 * * **Gregorian calendar and time**: To examine the Gregorian properties of a DateTime individually (i.e as opposed to collectively through {@link DateTime#toObject}), use the {@link DateTime#year}, {@link DateTime#month},
 * {@link DateTime#day}, {@link DateTime#hour}, {@link DateTime#minute}, {@link DateTime#second}, {@link DateTime#millisecond} accessors.
 * * **Week calendar**: For ISO week calendar attributes, see the {@link DateTime#weekYear}, {@link DateTime#weekNumber}, and {@link DateTime#weekday} accessors.
 * * **Configuration** See the {@link DateTime#locale} and {@link DateTime#numberingSystem} accessors.
 * * **Transformation**: To transform the DateTime into other DateTimes, use {@link DateTime#set}, {@link DateTime#reconfigure}, {@link DateTime#setZone}, {@link DateTime#setLocale}, {@link DateTime#plus}, {@link DateTime#minus}, {@link DateTime#endOf}, {@link DateTime#startOf}, {@link DateTime#toUTC}, and {@link DateTime#toLocal}.
 * * **Output**: To convert the DateTime to other representations, use the {@link DateTime#toRelative}, {@link DateTime#toRelativeCalendar}, {@link DateTime#toJSON}, {@link DateTime#toISO}, {@link DateTime#toHTTP}, {@link DateTime#toObject}, {@link DateTime#toRFC2822}, {@link DateTime#toString}, {@link DateTime#toLocaleString}, {@link DateTime#toFormat}, {@link DateTime#toMillis}, {@link DateTime#toJSDate} and {@link DateTime#toZonedDateTime}.
 *
 * There's plenty others documented below. In addition, for more information on subtler topics like internationalization, time zones, alternative calendars, validity, and so on, see the external documentation.
 */
export default class DateTime {
  /** @internal epoch milliseconds */
  readonly ts: number;
  /**
   * @internal Temporal time zone identifier of the zone; null for custom zones, which only
   * report offsets, and for invalid DateTimes
   */
  readonly tz: string | null;
  /** @internal */
  readonly loc: Locale;
  /** @internal */
  readonly invalid: Invalid | null;
  /**
   * @internal calendar fields in the zone, read from the ZonedDateTime on first use
   * (see deriveFields); null until then and when invalid
   */
  c: GregorianDateTime | null;
  /** @internal offset in minutes, read together with `c` */
  o: number | null;
  /** @internal */
  weekData: WeekDateTime | null;
  /** @internal */
  localWeekData: WeekDateTime | null;
  /** @internal */
  readonly isLuxonDateTime: true;
  private readonly _zone: Zone;
  private readonly _wasHole: boolean;

  /**
   * @access private
   */
  constructor(config: DateTimeConfig) {
    const zone = config.zone || Settings.defaultZone;

    let invalid =
      config.invalid ||
      (Number.isNaN(config.ts) ? new Invalid("invalid input") : null) ||
      (!zone.isValid ? unsupportedZone(zone) : null);

    this.ts = isUndefined(config.ts) ? Settings.now() : config.ts;

    let tz: string | null = null,
      c: GregorianDateTime | null = null,
      o: number | null = null;
    if (!invalid) {
      if (!isRepresentableTs(this.ts)) {
        invalid = new Invalid("invalid input");
      } else {
        tz = temporalZoneId(zone);
        if (config.c != null && config.o != null) {
          // the caller already resolved the calendar fields and offset for this instant
          c = config.c;
          o = config.o;
        } else if (tz === null) {
          // custom zones have no Temporal time zone: their offset at this instant places it
          o = zone.offset(this.ts);
          c = Number.isFinite(o) ? fieldsAtOffset(this.ts, o) : null;
        } else if (Math.abs(this.ts) > MAX_EPOCH_MS - 86400000) {
          // Luxon computes local times with Date, so a local time outside Date's range is
          // invalid input. Built-in zones' offsets are under a day, so only instants within a
          // day of the end of the range need their fields now to check it.
          const zdt = zonedDateTime(this.ts, tz);
          c = wallClock(zdt);
          o = offsetMinutes(zdt);
        }
        if (o !== null && (c === null || !isRepresentableTs(this.ts + o * 60 * 1000))) {
          invalid = new Invalid("invalid input");
          tz = null;
          c = null;
          o = null;
        }
      }
    }

    this._zone = zone;
    this.tz = tz;
    this.loc = config.loc || Locale.create();
    this.invalid = invalid;
    this.weekData = null;
    this.localWeekData = null;
    this.c = c;
    this._wasHole = config.wasHole || false;
    this.o = o;
    this.isLuxonDateTime = true;
  }

  // CONSTRUCT

  /**
   * Create a DateTime for the current instant, in the system's time zone.
   *
   * Use Settings to override these default values if needed.
   * @example DateTime.now().toISO() //~> now in the ISO format
   */
  static now(): DateTime {
    return new DateTime({});
  }

  /**
   * Create a local DateTime
   * @param year - The calendar year. If omitted (as in, call `local()` with no arguments), the current time will be used
   * @param month - The month, 1-indexed
   * @param day - The day of the month, 1-indexed
   * @param hour - The hour of the day, in 24-hour time
   * @param minute - The minute of the hour, meaning a number between 0 and 59
   * @param second - The second of the minute, meaning a number between 0 and 59
   * @param millisecond - The millisecond of the second, meaning a number between 0 and 999
   * @example DateTime.local()                                  //~> now
   * @example DateTime.local({ zone: "America/New_York" })      //~> now, in US east coast time
   * @example DateTime.local(2017)                              //~> 2017-01-01T00:00:00
   * @example DateTime.local(2017, 3)                           //~> 2017-03-01T00:00:00
   * @example DateTime.local(2017, 3, 12, { locale: "fr" })     //~> 2017-03-12T00:00:00, with a French locale
   * @example DateTime.local(2017, 3, 12, 5)                    //~> 2017-03-12T05:00:00
   * @example DateTime.local(2017, 3, 12, 5, { zone: "utc" })   //~> 2017-03-12T05:00:00, in UTC
   * @example DateTime.local(2017, 3, 12, 5, 45)                //~> 2017-03-12T05:45:00
   * @example DateTime.local(2017, 3, 12, 5, 45, 10)            //~> 2017-03-12T05:45:10
   * @example DateTime.local(2017, 3, 12, 5, 45, 10, 765)       //~> 2017-03-12T05:45:10.765
   */
  static local(...args: (number | DateTimeOptions)[]): DateTime {
    const [opts, values] = lastOpts(args),
      [year, month, day, hour, minute, second, millisecond] = values;
    return quickDT({ year, month, day, hour, minute, second, millisecond }, opts);
  }

  /**
   * Create a DateTime in UTC
   * @param year - The calendar year. If omitted (as in, call `utc()` with no arguments), the current time will be used
   * @param month - The month, 1-indexed
   * @param day - The day of the month
   * @param hour - The hour of the day, in 24-hour time
   * @param minute - The minute of the hour, meaning a number between 0 and 59
   * @param second - The second of the minute, meaning a number between 0 and 59
   * @param millisecond - The millisecond of the second, meaning a number between 0 and 999
   * @param options - configuration options for the DateTime
   * @param options.locale - a locale to set on the resulting DateTime instance
   * @param options.outputCalendar - the output calendar to set on the resulting DateTime instance
   * @param options.numberingSystem - the numbering system to set on the resulting DateTime instance
   * @param options.weekSettings - the week settings to set on the resulting DateTime instance
   * @example DateTime.utc()                                              //~> now
   * @example DateTime.utc(2017)                                          //~> 2017-01-01T00:00:00Z
   * @example DateTime.utc(2017, 3)                                       //~> 2017-03-01T00:00:00Z
   * @example DateTime.utc(2017, 3, 12)                                   //~> 2017-03-12T00:00:00Z
   * @example DateTime.utc(2017, 3, 12, 5)                                //~> 2017-03-12T05:00:00Z
   * @example DateTime.utc(2017, 3, 12, 5, 45)                            //~> 2017-03-12T05:45:00Z
   * @example DateTime.utc(2017, 3, 12, 5, 45, { locale: "fr" })          //~> 2017-03-12T05:45:00Z with a French locale
   * @example DateTime.utc(2017, 3, 12, 5, 45, 10)                        //~> 2017-03-12T05:45:10Z
   * @example DateTime.utc(2017, 3, 12, 5, 45, 10, 765, { locale: "fr" }) //~> 2017-03-12T05:45:10.765Z with a French locale
   */
  static utc(...args: (number | LocaleOptions)[]): DateTime {
    const [opts, values] = lastOpts(args),
      [year, month, day, hour, minute, second, millisecond] = values;

    opts.zone = FixedOffsetZone.utcInstance;
    return quickDT({ year, month, day, hour, minute, second, millisecond }, opts);
  }

  /**
   * Create a DateTime from a JavaScript Date object. Uses the default zone.
   * @param date - a JavaScript Date object
   * @param options - configuration options for the DateTime
   * @param options.zone - the zone to place the DateTime into
   */
  static fromJSDate(date: Date, options: DateTimeOptions = {}): DateTime {
    const ts = isDate(date) ? date.valueOf() : NaN;
    if (Number.isNaN(ts)) {
      return DateTime.invalid("invalid input");
    }

    const zoneToUse = normalizeZone(options.zone, Settings.defaultZone);
    if (!zoneToUse.isValid) {
      return DateTime.invalid(unsupportedZone(zoneToUse));
    }

    return new DateTime({
      ts: ts,
      zone: zoneToUse,
      loc: Locale.fromObject(options),
    });
  }

  /**
   * Create a DateTime from a number of milliseconds since the epoch (meaning since 1 January 1970 00:00:00 UTC). Uses the default zone.
   * @param milliseconds - a number of milliseconds since 1970 UTC
   * @param options - configuration options for the DateTime
   * @param options.zone - the zone to place the DateTime into
   * @param options.locale - a locale to set on the resulting DateTime instance
   * @param options.outputCalendar - the output calendar to set on the resulting DateTime instance
   * @param options.numberingSystem - the numbering system to set on the resulting DateTime instance
   * @param options.weekSettings - the week settings to set on the resulting DateTime instance
   */
  static fromMillis(milliseconds: number, options: DateTimeOptions = {}): DateTime {
    if (!isNumber(milliseconds)) {
      throw new InvalidArgumentError(
        `fromMillis requires a numerical input, but received a ${typeof milliseconds} with value ${milliseconds}`
      );
    } else if (milliseconds < -MAX_DATE || milliseconds > MAX_DATE) {
      // this isn't perfect because we can still end up out of range because of additional shifting, but it's a start
      return DateTime.invalid("Timestamp out of range");
    } else {
      return new DateTime({
        ts: milliseconds,
        zone: normalizeZone(options.zone, Settings.defaultZone),
        loc: Locale.fromObject(options),
      });
    }
  }

  /**
   * Create a DateTime from a number of seconds since the epoch (meaning since 1 January 1970 00:00:00 UTC). Uses the default zone.
   * @param seconds - a number of seconds since 1970 UTC
   * @param options - configuration options for the DateTime
   * @param options.zone - the zone to place the DateTime into
   * @param options.locale - a locale to set on the resulting DateTime instance
   * @param options.outputCalendar - the output calendar to set on the resulting DateTime instance
   * @param options.numberingSystem - the numbering system to set on the resulting DateTime instance
   * @param options.weekSettings - the week settings to set on the resulting DateTime instance
   */
  static fromSeconds(seconds: number, options: DateTimeOptions = {}): DateTime {
    if (!isNumber(seconds)) {
      throw new InvalidArgumentError("fromSeconds requires a numerical input");
    } else {
      return new DateTime({
        ts: seconds * 1000,
        zone: normalizeZone(options.zone, Settings.defaultZone),
        loc: Locale.fromObject(options),
      });
    }
  }

  /**
   * Create a DateTime from a JavaScript object with keys like 'year' and 'hour' with reasonable defaults.
   * @param obj - the object to create the DateTime from
   * @param obj.year - a year, such as 1987
   * @param obj.month - a month, 1-12
   * @param obj.day - a day of the month, 1-31, depending on the month
   * @param obj.ordinal - day of the year, 1-365 or 366
   * @param obj.weekYear - an ISO week year
   * @param obj.weekNumber - an ISO week number, between 1 and 52 or 53, depending on the year
   * @param obj.weekday - an ISO weekday, 1-7, where 1 is Monday and 7 is Sunday
   * @param obj.localWeekYear - a week year, according to the locale
   * @param obj.localWeekNumber - a week number, between 1 and 52 or 53, depending on the year, according to the locale
   * @param obj.localWeekday - a weekday, 1-7, where 1 is the first and 7 is the last day of the week, according to the locale
   * @param obj.hour - hour of the day, 0-23
   * @param obj.minute - minute of the hour, 0-59
   * @param obj.second - second of the minute, 0-59
   * @param obj.millisecond - millisecond of the second, 0-999
   * @param opts - options for creating this DateTime
   * @param opts.zone - interpret the numbers in the context of a particular zone. Can take any value taken as the first argument to setZone()
   * @param opts.locale - a locale to set on the resulting DateTime instance
   * @param opts.outputCalendar - the output calendar to set on the resulting DateTime instance
   * @param opts.numberingSystem - the numbering system to set on the resulting DateTime instance
   * @param opts.weekSettings - the week settings to set on the resulting DateTime instance
   * @example DateTime.fromObject({ year: 1982, month: 5, day: 25}).toISODate() //=> '1982-05-25'
   * @example DateTime.fromObject({ year: 1982 }).toISODate() //=> '1982-01-01'
   * @example DateTime.fromObject({ hour: 10, minute: 26, second: 6 }) //~> today at 10:26:06
   * @example DateTime.fromObject({ hour: 10, minute: 26, second: 6 }, { zone: 'utc' }),
   * @example DateTime.fromObject({ hour: 10, minute: 26, second: 6 }, { zone: 'local' })
   * @example DateTime.fromObject({ hour: 10, minute: 26, second: 6 }, { zone: 'America/New_York' })
   * @example DateTime.fromObject({ weekYear: 2016, weekNumber: 2, weekday: 3 }).toISODate() //=> '2016-01-13'
   * @example DateTime.fromObject({ localWeekYear: 2022, localWeekNumber: 1, localWeekday: 1 }, { locale: "en-US" }).toISODate() //=> '2021-12-26'
   */
  static fromObject(obj?: DateObjectUnits | null, opts: FromObjectOptions = {}): DateTime {
    obj = obj || {};
    const zoneToUse = normalizeZone(opts.zone, Settings.defaultZone);
    if (!zoneToUse.isValid) {
      return DateTime.invalid(unsupportedZone(zoneToUse));
    }

    const loc = Locale.fromObject(opts);
    const normalized: Record<string, number | undefined> = normalizeObject(
      obj,
      normalizeUnitWithLocalWeeks
    );
    const { minDaysInFirstWeek, startOfWeek } = usesLocalWeekValues(normalized, loc);

    const tsNow = opts.overrideNow ?? Settings.now(),
      offsetProvis = !isUndefined(opts.specificOffset)
        ? opts.specificOffset
        : zoneToUse.offset(tsNow),
      containsOrdinal = !isUndefined(normalized.ordinal),
      containsGregorYear = !isUndefined(normalized.year),
      containsGregorMD = !isUndefined(normalized.month) || !isUndefined(normalized.day),
      containsGregor = containsGregorYear || containsGregorMD,
      definiteWeekDef = normalized.weekYear || normalized.weekNumber;

    // cases:
    // just a weekday -> this week's instance of that weekday, no worries
    // (gregorian data or ordinal) + (weekYear or weekNumber) -> error
    // (gregorian month or day) + ordinal -> error
    // otherwise just use weeks or ordinals or gregorian, depending on what's specified

    if ((containsGregor || containsOrdinal) && definiteWeekDef) {
      throw new ConflictingSpecificationError(
        "Can't mix weekYear/weekNumber units with year/month/day or ordinals"
      );
    }

    if (containsGregorMD && containsOrdinal) {
      throw new ConflictingSpecificationError("Can't mix ordinal dates with month/day");
    }

    const useWeekData = definiteWeekDef || (normalized.weekday && !containsGregor);

    // configure ourselves to deal with gregorian dates or week stuff
    let units: string[], defaultValues: Record<string, number>;
    if (useWeekData) {
      units = orderedWeekUnits;
      defaultValues = defaultWeekUnitValues;
    } else if (containsOrdinal) {
      units = orderedOrdinalUnits;
      defaultValues = defaultOrdinalUnitValues;
    } else {
      units = orderedUnits;
      defaultValues = defaultUnitValues;
    }

    // the current wall clock, in the same terms as the units, read only when a unit defaults to it
    let objNow: Record<string, number> | null = null;
    const nowValues = (): Record<string, number> => {
      if (objNow === null) {
        const now = fieldsAtOffset(tsNow, offsetProvis) ?? unknownFields;
        objNow = (
          useWeekData
            ? gregorianToWeek(now, minDaysInFirstWeek, startOfWeek)
            : containsOrdinal
              ? gregorianToOrdinal(now)
              : now
        ) as unknown as Record<string, number>;
      }
      return objNow;
    };

    // set default values for missing stuff
    let foundFirst = false;
    for (const u of units) {
      const v = normalized[u];
      if (!isUndefined(v)) {
        foundFirst = true;
      } else if (foundFirst) {
        normalized[u] = defaultValues[u];
      } else {
        normalized[u] = nowValues()[u];
      }
    }

    // make sure the values we have are in range
    const higherOrderInvalid = useWeekData
        ? hasInvalidWeekData(normalized, minDaysInFirstWeek, startOfWeek)
        : containsOrdinal
          ? hasInvalidOrdinalData(normalized)
          : hasInvalidGregorianData(normalized),
      invalid = higherOrderInvalid || hasInvalidTimeData(normalized);

    if (invalid) {
      return DateTime.invalid(invalid);
    }

    // compute the actual time
    const gregorian = useWeekData
      ? weekToGregorian(normalized as unknown as WeekDateTime, minDaysInFirstWeek, startOfWeek)
      : containsOrdinal
        ? ordinalToGregorian(normalized as unknown as OrdinalDateTime)
        : (normalized as unknown as GregorianDateTime);

    const resolved = resolveFields(gregorian, offsetProvis, zoneToUse);
    if (resolved === null) {
      return DateTime.invalid("invalid input");
    }

    const inst = new DateTime({ ...resolved, zone: zoneToUse, loc });

    // gregorian data + weekday serves only to validate
    if (normalized.weekday && containsGregor && obj.weekday !== inst.weekday) {
      return DateTime.invalid(
        "mismatched weekday",
        `you can't specify both a weekday of ${normalized.weekday} and a date of ${inst.toISO()}`
      );
    }

    if (!inst.isValid) {
      return DateTime.invalid(inst.invalid as Invalid);
    }

    return inst;
  }

  /**
   * Create a DateTime from an ISO 8601 string
   * @param text - the ISO string
   * @param opts - options to affect the creation
   * @param opts.zone - use this zone if no offset is specified in the input string itself. Will also convert the time to this zone
   * @param opts.setZone - override the zone with a fixed-offset zone specified in the string itself, if it specifies one
   * @param opts.locale - a locale to set on the resulting DateTime instance
   * @param opts.outputCalendar - the output calendar to set on the resulting DateTime instance
   * @param opts.numberingSystem - the numbering system to set on the resulting DateTime instance
   * @param opts.weekSettings - the week settings to set on the resulting DateTime instance
   * @example DateTime.fromISO('2016-05-25T09:08:34.123')
   * @example DateTime.fromISO('2016-05-25T09:08:34.123+06:00')
   * @example DateTime.fromISO('2016-05-25T09:08:34.123+06:00', {setZone: true})
   * @example DateTime.fromISO('2016-05-25T09:08:34.123', {zone: 'utc'})
   * @example DateTime.fromISO('2016-W05-4')
   */
  static fromISO(text: string, opts: DateTimeOptions = {}): DateTime {
    const [vals, parsedZone] = parseISODate(text);
    return parseDataToDateTime(vals, parsedZone, opts, "ISO 8601", text);
  }

  /**
   * Create a DateTime from an RFC 2822 string
   * @param text - the RFC 2822 string
   * @param opts - options to affect the creation
   * @param opts.zone - convert the time to this zone. Since the offset is always specified in the string itself, this has no effect on the interpretation of string, merely the zone the resulting DateTime is expressed in.
   * @param opts.setZone - override the zone with a fixed-offset zone specified in the string itself, if it specifies one
   * @param opts.locale - a locale to set on the resulting DateTime instance
   * @param opts.outputCalendar - the output calendar to set on the resulting DateTime instance
   * @param opts.numberingSystem - the numbering system to set on the resulting DateTime instance
   * @param opts.weekSettings - the week settings to set on the resulting DateTime instance
   * @example DateTime.fromRFC2822('25 Nov 2016 13:23:12 GMT')
   * @example DateTime.fromRFC2822('Fri, 25 Nov 2016 13:23:12 +0600')
   * @example DateTime.fromRFC2822('25 Nov 2016 13:23 Z')
   */
  static fromRFC2822(text: string, opts: DateTimeOptions = {}): DateTime {
    const [vals, parsedZone] = parseRFC2822Date(text);
    return parseDataToDateTime(vals, parsedZone, opts, "RFC 2822", text);
  }

  /**
   * Create a DateTime from an HTTP header date
   * @see https://www.w3.org/Protocols/rfc2616/rfc2616-sec3.html#sec3.3.1
   * @param text - the HTTP header date
   * @param opts - options to affect the creation
   * @param opts.zone - convert the time to this zone. Since HTTP dates are always in UTC, this has no effect on the interpretation of string, merely the zone the resulting DateTime is expressed in.
   * @param opts.setZone - override the zone with the fixed-offset zone specified in the string. For HTTP dates, this is always UTC, so this option is equivalent to setting the `zone` option to 'utc', but this option is included for consistency with similar methods.
   * @param opts.locale - a locale to set on the resulting DateTime instance
   * @param opts.outputCalendar - the output calendar to set on the resulting DateTime instance
   * @param opts.numberingSystem - the numbering system to set on the resulting DateTime instance
   * @param opts.weekSettings - the week settings to set on the resulting DateTime instance
   * @example DateTime.fromHTTP('Sun, 06 Nov 1994 08:49:37 GMT')
   * @example DateTime.fromHTTP('Sunday, 06-Nov-94 08:49:37 GMT')
   * @example DateTime.fromHTTP('Sun Nov  6 08:49:37 1994')
   */
  static fromHTTP(text: string, opts: DateTimeOptions = {}): DateTime {
    const [vals, parsedZone] = parseHTTPDate(text);
    return parseDataToDateTime(vals, parsedZone, opts, "HTTP", text);
  }

  /**
   * Create a DateTime from an input string and format string.
   * Defaults to en-US if no locale has been specified, regardless of the system's locale. For a table of tokens and their interpretations, see [here](https://moment.github.io/luxon/#/parsing?id=table-of-tokens).
   * @param text - the string to parse
   * @param fmt - the format the string is expected to be in (see the link below for the formats)
   * @param opts - options to affect the creation
   * @param opts.zone - use this zone if no offset is specified in the input string itself. Will also convert the DateTime to this zone
   * @param opts.setZone - override the zone with a zone specified in the string itself, if it specifies one
   * @param opts.locale - a locale string to use when parsing. Will also set the DateTime to this locale
   * @param opts.numberingSystem - the numbering system to use when parsing. Will also set the resulting DateTime to this numbering system
   * @param opts.weekSettings - the week settings to set on the resulting DateTime instance
   * @param opts.outputCalendar - the output calendar to set on the resulting DateTime instance
   */
  static fromFormat(text: string, fmt: string, opts: DateTimeOptions = {}): DateTime {
    if (isUndefined(text) || isUndefined(fmt)) {
      throw new InvalidArgumentError("fromFormat requires an input string and a format");
    }

    const { locale = null, numberingSystem = null } = opts,
      localeToUse = Locale.fromOpts({
        locale,
        numberingSystem,
        defaultToEN: true,
      }),
      [vals, parsedZone, specificOffset, invalid] = parseFromTokens(localeToUse, text, fmt);
    if (invalid) {
      return DateTime.invalid(invalid);
    } else {
      return parseDataToDateTime(vals, parsedZone, opts, `format ${fmt}`, text, specificOffset);
    }
  }

  /**
   * @deprecated use fromFormat instead
   */
  static fromString(text: string, fmt: string, opts: DateTimeOptions = {}): DateTime {
    return DateTime.fromFormat(text, fmt, opts);
  }

  /**
   * Create a DateTime from a SQL date, time, or datetime
   * Defaults to en-US if no locale has been specified, regardless of the system's locale
   * @param text - the string to parse
   * @param opts - options to affect the creation
   * @param opts.zone - use this zone if no offset is specified in the input string itself. Will also convert the DateTime to this zone
   * @param opts.setZone - override the zone with a zone specified in the string itself, if it specifies one
   * @param opts.locale - a locale string to use when parsing. Will also set the DateTime to this locale
   * @param opts.numberingSystem - the numbering system to use when parsing. Will also set the resulting DateTime to this numbering system
   * @param opts.weekSettings - the week settings to set on the resulting DateTime instance
   * @param opts.outputCalendar - the output calendar to set on the resulting DateTime instance
   * @example DateTime.fromSQL('2017-05-15')
   * @example DateTime.fromSQL('2017-05-15 09:12:34')
   * @example DateTime.fromSQL('2017-05-15 09:12:34.342')
   * @example DateTime.fromSQL('2017-05-15 09:12:34.342+06:00')
   * @example DateTime.fromSQL('2017-05-15 09:12:34.342 America/Los_Angeles')
   * @example DateTime.fromSQL('2017-05-15 09:12:34.342 America/Los_Angeles', { setZone: true })
   * @example DateTime.fromSQL('2017-05-15 09:12:34.342', { zone: 'America/Los_Angeles' })
   * @example DateTime.fromSQL('09:12:34.342')
   */
  static fromSQL(text: string, opts: DateTimeOptions = {}): DateTime {
    const [vals, parsedZone] = parseSQL(text);
    return parseDataToDateTime(vals, parsedZone, opts, "SQL", text);
  }

  /**
   * Create a DateTime from a `Temporal.ZonedDateTime`. The DateTime keeps the instant and the
   * time zone: "UTC" becomes {@link FixedOffsetZone.utcInstance}, IANA names and offsets such as
   * "+05:30" become {@link IANAZone}s.
   * Non-ISO calendars are converted to the Gregorian/ISO calendar.
   * @param zonedDateTime - the Temporal.ZonedDateTime to convert
   * @param opts - configuration options for the DateTime
   * @param opts.locale - a locale to set on the resulting DateTime instance
   * @param opts.outputCalendar - the output calendar to set on the resulting DateTime instance
   * @param opts.numberingSystem - the numbering system to set on the resulting DateTime instance
   * @param opts.weekSettings - the week settings to set on the resulting DateTime instance
   * @example DateTime.fromZonedDateTime(Temporal.Now.zonedDateTimeISO("America/New_York"))
   */
  static fromZonedDateTime(zonedDateTime: ZonedDateTime, opts: LocaleOptions = {}): DateTime {
    const iso = zonedDateTime.withCalendar("iso8601"),
      zone = normalizeZone(iso.timeZoneId, Settings.defaultZone);
    if (!zone.isValid) {
      return DateTime.invalid(unsupportedZone(zone));
    }
    return new DateTime({
      ts: iso.epochMilliseconds,
      zone,
      loc: Locale.fromObject(opts),
      c: wallClock(iso),
      o: offsetMinutes(iso),
    });
  }

  /**
   * Create a DateTime from a `Temporal.Instant`. Uses the default zone unless one is given.
   * @param instant - the Temporal.Instant to convert
   * @param opts - configuration options for the DateTime, see {@link DateTime.fromMillis}
   * @example DateTime.fromInstant(Temporal.Now.instant(), { zone: "Europe/Paris" })
   */
  static fromInstant(instant: Instant, opts: DateTimeOptions = {}): DateTime {
    return DateTime.fromMillis(instant.epochMilliseconds, opts);
  }

  /**
   * Create an invalid DateTime.
   * @param reason - simple string of why this DateTime is invalid. Should not contain parameters or anything else data-dependent.
   * @param explanation - longer explanation, may include parameters and other useful debugging information
   */
  static invalid(reason: string | Invalid, explanation: string | null = null): DateTime {
    if (!reason) {
      throw new InvalidArgumentError("need to specify a reason the DateTime is invalid");
    }

    const invalid = reason instanceof Invalid ? reason : new Invalid(reason, explanation);

    if (Settings.throwOnInvalid) {
      throw new InvalidDateTimeError(invalid);
    } else {
      return new DateTime({ invalid });
    }
  }

  /**
   * Check if an object is an instance of DateTime. Works across context boundaries
   */
  static isDateTime(o: unknown): o is DateTime {
    return (!!o && (o as DateTime).isLuxonDateTime) || false;
  }

  /**
   * Produce the format string for a set of options
   */
  static parseFormatForOpts(
    formatOpts: Intl.DateTimeFormatOptions,
    localeOpts: LocaleOptions = {}
  ): string | null {
    const tokenList = formatOptsToTokens(formatOpts, Locale.fromObject(localeOpts));
    return !tokenList ? null : tokenList.map((t) => (t ? t.val : null)).join("");
  }

  /**
   * Produce the the fully expanded format token for the locale
   * Does NOT quote characters, so quoted tokens will not round trip correctly
   */
  static expandFormat(fmt: string, localeOpts: LocaleOptions = {}): string {
    const expanded = expandMacroTokens(Formatter.parseFormat(fmt), Locale.fromObject(localeOpts));
    return expanded.map((t) => t.val).join("");
  }

  static resetCache(): void {
    zoneOffsetTs = undefined;
    zoneOffsetGuessCache.clear();
  }

  // INFO

  /**
   * Get the value of unit.
   * @param unit - a unit such as 'minute' or 'day'
   * @example DateTime.local(2017, 7, 4).get('month'); //=> 7
   * @example DateTime.local(2017, 7, 4).get('day'); //=> 4
   */
  get(unit: string): number {
    return (this as unknown as Record<string, number>)[unit];
  }

  /**
   * Returns whether the DateTime is valid. Invalid DateTimes occur when:
   * * The DateTime was created from invalid calendar information, such as the 13th month or February 30
   * * The DateTime was created by an operation on another invalid date
   */
  get isValid(): boolean {
    return this.invalid === null;
  }

  /**
   * Returns an error code if this DateTime is invalid, or null if the DateTime is valid
   */
  get invalidReason(): string | null {
    return this.invalid ? this.invalid.reason : null;
  }

  /**
   * Returns an explanation of why this DateTime became invalid, or null if the DateTime is valid
   */
  get invalidExplanation(): string | null {
    return this.invalid ? this.invalid.explanation : null;
  }

  /**
   * Get the locale of a DateTime, such 'en-GB'. The locale is used when formatting the DateTime
   */
  get locale(): string | null {
    return this.isValid ? this.loc.locale : null;
  }

  /**
   * Get the numbering system of a DateTime, such 'beng'. The numbering system is used when formatting the DateTime
   */
  get numberingSystem(): string | null {
    return this.isValid ? this.loc.numberingSystem : null;
  }

  /**
   * Get the output calendar of a DateTime, such 'islamic'. The output calendar is used when formatting the DateTime
   */
  get outputCalendar(): string | null {
    return this.isValid ? this.loc.outputCalendar : null;
  }

  /**
   * Get the time zone associated with this DateTime.
   */
  get zone(): Zone {
    return this._zone;
  }

  /**
   * Get the name of the time zone.
   */
  get zoneName(): string | null {
    return this.isValid ? this.zone.name : null;
  }

  /**
   * Whether this DateTime was created from a "hole time" that can exist during DST due to the
   * clocks moving forward.
   *
   * @example DateTime.local(2017, 3, 12, 2).wasHole; //=> true
   * @example DateTime.local(2017, 3, 12, 4).wasHole; //=> false
   */
  get wasHole(): boolean {
    return this._wasHole;
  }

  /**
   * Get the year
   * @example DateTime.local(2017, 5, 25).year //=> 2017
   */
  get year(): number {
    return this.isValid ? fieldsOf(this).year : NaN;
  }

  /**
   * Get the quarter
   * @example DateTime.local(2017, 5, 25).quarter //=> 2
   */
  get quarter(): number {
    return this.isValid ? Math.ceil(fieldsOf(this).month / 3) : NaN;
  }

  /**
   * Get the month (1-12).
   * @example DateTime.local(2017, 5, 25).month //=> 5
   */
  get month(): number {
    return this.isValid ? fieldsOf(this).month : NaN;
  }

  /**
   * Get the day of the month (1-30ish).
   * @example DateTime.local(2017, 5, 25).day //=> 25
   */
  get day(): number {
    return this.isValid ? fieldsOf(this).day : NaN;
  }

  /**
   * Get the hour of the day (0-23).
   * @example DateTime.local(2017, 5, 25, 9).hour //=> 9
   */
  get hour(): number {
    return this.isValid ? fieldsOf(this).hour : NaN;
  }

  /**
   * Get the minute of the hour (0-59).
   * @example DateTime.local(2017, 5, 25, 9, 30).minute //=> 30
   */
  get minute(): number {
    return this.isValid ? fieldsOf(this).minute : NaN;
  }

  /**
   * Get the second of the minute (0-59).
   * @example DateTime.local(2017, 5, 25, 9, 30, 52).second //=> 52
   */
  get second(): number {
    return this.isValid ? fieldsOf(this).second : NaN;
  }

  /**
   * Get the millisecond of the second (0-999).
   * @example DateTime.local(2017, 5, 25, 9, 30, 52, 654).millisecond //=> 654
   */
  get millisecond(): number {
    return this.isValid ? fieldsOf(this).millisecond : NaN;
  }

  /**
   * Get the week year
   * @see https://en.wikipedia.org/wiki/ISO_week_date
   * @example DateTime.local(2014, 12, 31).weekYear //=> 2015
   */
  get weekYear(): number {
    return this.isValid ? possiblyCachedWeekData(this).weekYear : NaN;
  }

  /**
   * Get the week number of the week year (1-52ish).
   * @see https://en.wikipedia.org/wiki/ISO_week_date
   * @example DateTime.local(2017, 5, 25).weekNumber //=> 21
   */
  get weekNumber(): number {
    return this.isValid ? possiblyCachedWeekData(this).weekNumber : NaN;
  }

  /**
   * Get the day of the week.
   * 1 is Monday and 7 is Sunday
   * @see https://en.wikipedia.org/wiki/ISO_week_date
   * @example DateTime.local(2014, 11, 31).weekday //=> 4
   */
  get weekday(): number {
    return this.isValid ? possiblyCachedWeekData(this).weekday : NaN;
  }

  /**
   * Returns true if this date is on a weekend according to the locale, false otherwise
   */
  get isWeekend(): boolean {
    return this.isValid && this.loc.getWeekendDays().includes(this.weekday);
  }

  /**
   * Get the day of the week according to the locale.
   * 1 is the first day of the week and 7 is the last day of the week.
   * If the locale assigns Sunday as the first day of the week, then a date which is a Sunday will return 1,
   */
  get localWeekday(): number {
    return this.isValid ? possiblyCachedLocalWeekData(this).weekday : NaN;
  }

  /**
   * Get the week number of the week year according to the locale. Different locales assign week numbers differently,
   * because the week can start on different days of the week (see localWeekday) and because a different number of days
   * is required for a week to count as the first week of a year.
   */
  get localWeekNumber(): number {
    return this.isValid ? possiblyCachedLocalWeekData(this).weekNumber : NaN;
  }

  /**
   * Get the week year according to the locale. Different locales assign week numbers (and therefor week years)
   * differently, see localWeekNumber.
   */
  get localWeekYear(): number {
    return this.isValid ? possiblyCachedLocalWeekData(this).weekYear : NaN;
  }

  /**
   * Get the ordinal (meaning the day of the year)
   * @example DateTime.local(2017, 5, 25).ordinal //=> 145
   */
  get ordinal(): number {
    return this.isValid ? gregorianToOrdinal(fieldsOf(this)).ordinal : NaN;
  }

  /**
   * Get the human readable short month name, such as 'Oct'.
   * Defaults to the system's locale if no locale has been specified
   * @example DateTime.local(2017, 10, 30).monthShort //=> Oct
   */
  get monthShort(): string | null {
    return this.isValid ? Info.months("short", { locObj: this.loc })[this.month - 1] : null;
  }

  /**
   * Get the human readable long month name, such as 'October'.
   * Defaults to the system's locale if no locale has been specified
   * @example DateTime.local(2017, 10, 30).monthLong //=> October
   */
  get monthLong(): string | null {
    return this.isValid ? Info.months("long", { locObj: this.loc })[this.month - 1] : null;
  }

  /**
   * Get the human readable short weekday, such as 'Mon'.
   * Defaults to the system's locale if no locale has been specified
   * @example DateTime.local(2017, 10, 30).weekdayShort //=> Mon
   */
  get weekdayShort(): string | null {
    return this.isValid ? Info.weekdays("short", { locObj: this.loc })[this.weekday - 1] : null;
  }

  /**
   * Get the human readable long weekday, such as 'Monday'.
   * Defaults to the system's locale if no locale has been specified
   * @example DateTime.local(2017, 10, 30).weekdayLong //=> Monday
   */
  get weekdayLong(): string | null {
    return this.isValid ? Info.weekdays("long", { locObj: this.loc })[this.weekday - 1] : null;
  }

  /**
   * Get the UTC offset of this DateTime in minutes
   * @example DateTime.now().offset //=> -240
   * @example DateTime.utc().offset //=> 0
   */
  get offset(): number {
    return this.isValid ? +offsetOf(this) : NaN;
  }

  /**
   * Get the short human name for the zone's current offset, for example "EST" or "EDT".
   * Defaults to the system's locale if no locale has been specified
   */
  get offsetNameShort(): string | null {
    if (this.isValid) {
      return this.zone.offsetName(this.ts, {
        format: "short",
        locale: this.locale as string,
      });
    } else {
      return null;
    }
  }

  /**
   * Get the long human name for the zone's current offset, for example "Eastern Standard Time" or "Eastern Daylight Time".
   * Defaults to the system's locale if no locale has been specified
   */
  get offsetNameLong(): string | null {
    if (this.isValid) {
      return this.zone.offsetName(this.ts, {
        format: "long",
        locale: this.locale as string,
      });
    } else {
      return null;
    }
  }

  /**
   * Get whether this zone's offset ever changes, as in a DST.
   */
  get isOffsetFixed(): boolean | null {
    return this.isValid ? this.zone.isUniversal : null;
  }

  /**
   * Get whether the DateTime is in a DST.
   */
  get isInDST(): boolean {
    if (this.isOffsetFixed) {
      return false;
    } else {
      return (
        this.offset > this.set({ month: 1, day: 1 }).offset ||
        this.offset > this.set({ month: 5 }).offset
      );
    }
  }

  /**
   * Get those DateTimes which have the same local time as this DateTime, but a different offset from UTC
   * in this DateTime's zone. During DST changes local time can be ambiguous, for example
   * `2023-10-29T02:30:00` in `Europe/Berlin` can have offset `+01:00` or `+02:00`.
   * This method will return both possible DateTimes if this DateTime's local time is ambiguous.
   */
  getPossibleOffsets(): DateTime[] {
    if (!this.isValid || this.isOffsetFixed) {
      return [this];
    }
    if (this.tz === null) {
      return possibleOffsetsFromZoneOffsets(this);
    }
    const c = fieldsOf(this),
      bag = { ...c, timeZone: this.tz };
    let earlier: ZonedDateTime, later: ZonedDateTime;
    try {
      earlier = temporal().ZonedDateTime.from(bag, { disambiguation: "earlier" });
      later = temporal().ZonedDateTime.from(bag, { disambiguation: "later" });
    } catch (e) {
      // the first day of Temporal's range (see resolveWallClock), where nothing is ambiguous
      if (!isRangeError(e)) throw e;
      return [this];
    }
    if (earlier.epochMilliseconds === later.epochMilliseconds) {
      return [this];
    }
    return [
      clone(this, { ts: earlier.epochMilliseconds, c, o: offsetMinutes(earlier) }),
      clone(this, { ts: later.epochMilliseconds, c, o: offsetMinutes(later) }),
    ];
  }

  /**
   * Returns true if this DateTime is in a leap year, false otherwise
   * @example DateTime.local(2016).isInLeapYear //=> true
   * @example DateTime.local(2013).isInLeapYear //=> false
   */
  get isInLeapYear(): boolean {
    return isLeapYear(this.year);
  }

  /**
   * Returns the number of days in this DateTime's month
   * @example DateTime.local(2016, 2).daysInMonth //=> 29
   * @example DateTime.local(2016, 3).daysInMonth //=> 31
   */
  get daysInMonth(): number {
    return daysInMonth(this.year, this.month);
  }

  /**
   * Returns the number of days in this DateTime's year
   * @example DateTime.local(2016).daysInYear //=> 366
   * @example DateTime.local(2013).daysInYear //=> 365
   */
  get daysInYear(): number {
    return this.isValid ? daysInYear(this.year) : NaN;
  }

  /**
   * Returns the number of weeks in this DateTime's year
   * @see https://en.wikipedia.org/wiki/ISO_week_date
   * @example DateTime.local(2004).weeksInWeekYear //=> 53
   * @example DateTime.local(2013).weeksInWeekYear //=> 52
   */
  get weeksInWeekYear(): number {
    return this.isValid ? weeksInWeekYear(this.weekYear) : NaN;
  }

  /**
   * Returns the number of weeks in this DateTime's local week year
   * @example DateTime.local(2020, 6, {locale: 'en-US'}).weeksInLocalWeekYear //=> 52
   * @example DateTime.local(2020, 6, {locale: 'de-DE'}).weeksInLocalWeekYear //=> 53
   */
  get weeksInLocalWeekYear(): number {
    return this.isValid
      ? weeksInWeekYear(
          this.localWeekYear,
          this.loc.getMinDaysInFirstWeek(),
          this.loc.getStartOfWeek()
        )
      : NaN;
  }

  /**
   * Returns the resolved Intl options for this DateTime.
   * This is useful in understanding the behavior of formatting methods
   * @param opts - the same options as toLocaleString
   */
  resolvedLocaleOptions(opts: Intl.DateTimeFormatOptions & LocaleOptions = {}): {
    locale: string;
    numberingSystem: string;
    outputCalendar: string;
  } {
    const { locale, numberingSystem, calendar } = Formatter.create(
      this.loc.clone(opts),
      opts
    ).resolvedOptions(this);
    return { locale, numberingSystem, outputCalendar: calendar };
  }

  // TRANSFORM

  /**
   * "Set" the DateTime's zone to UTC. Returns a newly-constructed DateTime.
   *
   * Equivalent to {@link DateTime#setZone}('utc')
   * @param offset - optionally, an offset from UTC in minutes
   * @param opts - options to pass to `setZone()`
   */
  toUTC(offset = 0, opts: SetZoneOptions = {}): DateTime {
    return this.setZone(FixedOffsetZone.instance(offset), opts);
  }

  /**
   * "Set" the DateTime's zone to the host's local zone. Returns a newly-constructed DateTime.
   *
   * Equivalent to `setZone('local')`
   */
  toLocal(): DateTime {
    return this.setZone(Settings.defaultZone);
  }

  /**
   * "Set" the DateTime's zone to specified zone. Returns a newly-constructed DateTime.
   *
   * By default, the setter keeps the underlying time the same (as in, the same timestamp), but the new instance will report different local times and consider DSTs when making computations, as with {@link DateTime#plus}. You may wish to use {@link DateTime#toLocal} and {@link DateTime#toUTC} which provide simple convenience wrappers for commonly used zones.
   * @param zone - a zone identifier. As a string, that can be any IANA zone supported by the host environment, or a fixed-offset name of the form 'UTC+3', or the strings 'local' or 'utc'. You may also supply an instance of a {@link DateTime#Zone} class.
   * @param opts - options
   * @param opts.keepLocalTime - If true, adjust the underlying time so that the local time stays the same, but in the target zone. You should rarely need this.
   */
  setZone(
    zone?: ZoneLike,
    { keepLocalTime = false, keepCalendarTime = false }: SetZoneOptions = {}
  ): DateTime {
    const target = normalizeZone(zone, Settings.defaultZone);
    if (target.equals(this.zone)) {
      return this;
    } else if (!target.isValid) {
      return DateTime.invalid(unsupportedZone(target));
    } else if ((keepLocalTime || keepCalendarTime) && this.isValid) {
      const resolved = resolveFields(
        fieldsOf(this),
        target.offset(this.ts),
        target
      );
      return clone(this, { ...(resolved ?? notRepresentable), zone: target });
    } else {
      return clone(this, { zone: target, wasHole: false });
    }
  }

  /**
   * "Set" the locale, numberingSystem, outputCalendar, or weekSettings. Returns a newly-constructed DateTime.
   * @param properties - the properties to set
   * @param properties.locale - the locale to set
   * @param properties.numberingSystem - the numbering system to set
   * @param properties.outputCalendar - the output calendar to set
   * @param properties.weekSettings - the week settings to set
   * @example DateTime.local(2017, 5, 25).reconfigure({ locale: 'en-GB' })
   * @example DateTime.local(2017, 5, 25).reconfigure({ weekSettings: { firstDay: 1 } })
   */
  reconfigure({ locale, numberingSystem, outputCalendar, weekSettings }: LocaleOptions = {}): DateTime {
    const loc = this.loc.clone({ locale, numberingSystem, outputCalendar, weekSettings });
    return clone(this, { loc });
  }

  /**
   * "Set" the locale. Returns a newly-constructed DateTime.
   * Just a convenient alias for reconfigure({ locale })
   * @example DateTime.local(2017, 5, 25).setLocale('en-GB')
   */
  setLocale(locale: string): DateTime {
    return this.reconfigure({ locale });
  }

  /**
   * "Set" the values of specified units. Returns a newly-constructed DateTime.
   * You can only set units with this method; for "setting" metadata, see {@link DateTime#reconfigure} and {@link DateTime#setZone}.
   *
   * This method also supports setting locale-based week units, i.e. `localWeekday`, `localWeekNumber` and `localWeekYear`.
   * They cannot be mixed with ISO-week units like `weekday`.
   * @param values - a mapping of units to numbers
   * @example dt.set({ year: 2017 })
   * @example dt.set({ hour: 8, minute: 30 })
   * @example dt.set({ weekday: 5 })
   * @example dt.set({ year: 2005, ordinal: 234 })
   */
  set(values: DateObjectUnits): DateTime {
    if (!this.isValid) return this;

    const c = fieldsOf(this);
    const normalized: Record<string, number | undefined> = normalizeObject(
      values,
      normalizeUnitWithLocalWeeks
    );
    const { minDaysInFirstWeek, startOfWeek } = usesLocalWeekValues(normalized, this.loc);

    const settingWeekStuff =
        !isUndefined(normalized.weekYear) ||
        !isUndefined(normalized.weekNumber) ||
        !isUndefined(normalized.weekday),
      containsOrdinal = !isUndefined(normalized.ordinal),
      containsGregorYear = !isUndefined(normalized.year),
      containsGregorMD = !isUndefined(normalized.month) || !isUndefined(normalized.day),
      containsGregor = containsGregorYear || containsGregorMD,
      definiteWeekDef = normalized.weekYear || normalized.weekNumber;

    if ((containsGregor || containsOrdinal) && definiteWeekDef) {
      throw new ConflictingSpecificationError(
        "Can't mix weekYear/weekNumber units with year/month/day or ordinals"
      );
    }

    if (containsGregorMD && containsOrdinal) {
      throw new ConflictingSpecificationError("Can't mix ordinal dates with month/day");
    }

    let mixed: GregorianDateTime;
    if (settingWeekStuff) {
      mixed = weekToGregorian(
        { ...gregorianToWeek(c, minDaysInFirstWeek, startOfWeek), ...normalized } as WeekDateTime,
        minDaysInFirstWeek,
        startOfWeek
      );
    } else if (!isUndefined(normalized.ordinal)) {
      mixed = ordinalToGregorian({ ...gregorianToOrdinal(c), ...normalized } as OrdinalDateTime);
    } else {
      mixed = { ...c, ...normalized } as GregorianDateTime;

      // if we didn't set the day but we ended up on an overflow date,
      // use the last day of the right month
      if (isUndefined(normalized.day)) {
        mixed.day = Math.min(daysInMonth(mixed.year, mixed.month), mixed.day);
      }
    }

    const resolved = resolveFields(mixed, offsetOf(this), this.zone);
    return clone(this, resolved ?? notRepresentable);
  }

  /**
   * Add a period of time to this DateTime and return the resulting DateTime
   *
   * Adding hours, minutes, seconds, or milliseconds increases the timestamp by the right number of milliseconds. Adding days, months, or years shifts the calendar, accounting for DSTs and leap years along the way. Thus, `dt.plus({ hours: 24 })` may result in a different time than `dt.plus({ days: 1 })` if there's a DST shift in between.
   * @param duration - The amount to add. Either a Duration, a number of milliseconds, the object argument to Duration.fromObject()
   * @example DateTime.now().plus(123) //~> in 123 milliseconds
   * @example DateTime.now().plus({ minutes: 15 }) //~> in 15 minutes
   * @example DateTime.now().plus({ days: 1 }) //~> this time tomorrow
   * @example DateTime.now().plus({ days: -1 }) //~> this time yesterday
   * @example DateTime.now().plus({ hours: 3, minutes: 13 }) //~> in 3 hr, 13 min
   * @example DateTime.now().plus(Duration.fromObject({ hours: 3, minutes: 13 })) //~> in 3 hr, 13 min
   */
  plus(duration: DurationLike): DateTime {
    if (!this.isValid) return this;
    const dur = Duration.fromDurationLike(duration);
    return clone(this, adjustTime(this, dur));
  }

  /**
   * Subtract a period of time to this DateTime and return the resulting DateTime
   * See {@link DateTime#plus}
   * @param duration - The amount to subtract. Either a Duration, a number of milliseconds, the object argument to Duration.fromObject()
   */
  minus(duration: DurationLike): DateTime {
    if (!this.isValid) return this;
    const dur = Duration.fromDurationLike(duration).negate();
    return clone(this, adjustTime(this, dur));
  }

  /**
   * "Set" this DateTime to the beginning of a unit of time.
   * @param unit - The unit to go to the beginning of. Can be 'year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', or 'millisecond'.
   * @param opts - options
   * @param opts.useLocaleWeeks - If true, use weeks based on the locale, i.e. use the locale-dependent start of the week
   * @example DateTime.local(2014, 3, 3).startOf('month').toISODate(); //=> '2014-03-01'
   * @example DateTime.local(2014, 3, 3).startOf('year').toISODate(); //=> '2014-01-01'
   * @example DateTime.local(2014, 3, 3).startOf('week').toISODate(); //=> '2014-03-03', weeks always start on Mondays
   * @example DateTime.local(2014, 3, 3, 5, 30).startOf('day').toISOTime(); //=> '00:00.000-05:00'
   * @example DateTime.local(2014, 3, 3, 5, 30).startOf('hour').toISOTime(); //=> '05:00:00.000-05:00'
   */
  startOf(unit: DurationUnits, { useLocaleWeeks = false }: StartOfOptions = {}): DateTime {
    if (!this.isValid) return this;

    const o: DateObjectUnits = {},
      normalizedUnit = Duration.normalizeUnit(unit);
    switch (normalizedUnit) {
      case "years":
        o.month = 1;
      // falls through
      case "quarters":
      case "months":
        o.day = 1;
      // falls through
      case "weeks":
      case "days":
        o.hour = 0;
      // falls through
      case "hours":
        o.minute = 0;
      // falls through
      case "minutes":
        o.second = 0;
      // falls through
      case "seconds":
        o.millisecond = 0;
        break;
      case "milliseconds":
        break;
      // no default, invalid units throw in normalizeUnit()
    }

    if (normalizedUnit === "weeks") {
      if (useLocaleWeeks) {
        const startOfWeek = this.loc.getStartOfWeek();
        const { weekday } = this;
        if (weekday < startOfWeek) {
          o.weekNumber = this.weekNumber - 1;
        }
        o.weekday = startOfWeek;
      } else {
        o.weekday = 1;
      }
    }

    if (normalizedUnit === "quarters") {
      const q = Math.ceil(this.month / 3);
      o.month = (q - 1) * 3 + 1;
    }

    return this.set(o);
  }

  /**
   * "Set" this DateTime to the end (meaning the last millisecond) of a unit of time
   * @param unit - The unit to go to the end of. Can be 'year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', or 'millisecond'.
   * @param opts - options
   * @param opts.useLocaleWeeks - If true, use weeks based on the locale, i.e. use the locale-dependent start of the week
   * @example DateTime.local(2014, 3, 3).endOf('month').toISO(); //=> '2014-03-31T23:59:59.999-05:00'
   * @example DateTime.local(2014, 3, 3).endOf('year').toISO(); //=> '2014-12-31T23:59:59.999-05:00'
   * @example DateTime.local(2014, 3, 3).endOf('week').toISO(); // => '2014-03-09T23:59:59.999-05:00', weeks start on Mondays
   * @example DateTime.local(2014, 3, 3, 5, 30).endOf('day').toISO(); //=> '2014-03-03T23:59:59.999-05:00'
   * @example DateTime.local(2014, 3, 3, 5, 30).endOf('hour').toISO(); //=> '2014-03-03T05:59:59.999-05:00'
   */
  endOf(unit: DurationUnits, opts?: StartOfOptions): DateTime {
    return this.isValid
      ? this.plus({ [unit]: 1 })
          .startOf(unit, opts)
          .minus(1)
      : this;
  }

  // OUTPUT

  /**
   * Returns a string representation of this DateTime formatted according to the specified format string.
   * **You may not want this.** See {@link DateTime#toLocaleString} for a more flexible formatting tool. For a table of tokens and their interpretations, see [here](https://moment.github.io/luxon/#/formatting?id=table-of-tokens).
   * Defaults to en-US if no locale has been specified, regardless of the system's locale.
   * @param fmt - the format string
   * @param opts - opts to override the configuration options on this DateTime
   * @example DateTime.now().toFormat('yyyy LLL dd') //=> '2017 Apr 22'
   * @example DateTime.now().setLocale('fr').toFormat('yyyy LLL dd') //=> '2017 avr. 22'
   * @example DateTime.now().toFormat('yyyy LLL dd', { locale: "fr" }) //=> '2017 avr. 22'
   * @example DateTime.now().toFormat("HH 'hours and' mm 'minutes'") //=> '20 hours and 55 minutes'
   */
  toFormat(fmt: string, opts: LocaleOptions = {}): string {
    return this.isValid
      ? Formatter.create(this.loc.redefaultToEN(opts)).formatDateTimeFromString(this, fmt)
      : INVALID;
  }

  /**
   * Returns a localized string representing this date. Accepts the same options as the Intl.DateTimeFormat constructor and any presets defined by momentum, such as `DateTime.DATE_FULL` or `DateTime.TIME_SIMPLE`.
   * The exact behavior of this method is browser-specific, but in general it will return an appropriate representation
   * of the DateTime in the assigned locale.
   * Defaults to the system's locale if no locale has been specified
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DateTimeFormat
   * @param formatOpts - Intl.DateTimeFormat constructor options and configuration options
   * @param opts - opts to override the configuration options on this DateTime
   * @example DateTime.now().toLocaleString(); //=> 4/20/2017
   * @example DateTime.now().setLocale('en-gb').toLocaleString(); //=> '20/04/2017'
   * @example DateTime.now().toLocaleString(DateTime.DATE_FULL); //=> 'April 20, 2017'
   * @example DateTime.now().toLocaleString(DateTime.DATE_FULL, { locale: 'fr' }); //=> '28 août 2022'
   * @example DateTime.now().toLocaleString(DateTime.TIME_SIMPLE); //=> '11:32 AM'
   * @example DateTime.now().toLocaleString(DateTime.DATETIME_SHORT); //=> '4/20/2017, 11:32 AM'
   * @example DateTime.now().toLocaleString({ weekday: 'long', month: 'long', day: '2-digit' }); //=> 'Thursday, April 20'
   * @example DateTime.now().toLocaleString({ weekday: 'short', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); //=> 'Thu, Apr 20, 11:27 AM'
   * @example DateTime.now().toLocaleString({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); //=> '11:32'
   */
  toLocaleString(
    formatOpts: Intl.DateTimeFormatOptions = Formats.DATE_SHORT,
    opts: LocaleOptions = {}
  ): string {
    return this.isValid
      ? Formatter.create(this.loc.clone(opts), formatOpts).formatDateTime(this)
      : INVALID;
  }

  /**
   * Returns an array of format "parts", meaning individual tokens along with metadata. This is allows callers to post-process individual sections of the formatted output.
   * Defaults to the system's locale if no locale has been specified
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DateTimeFormat/formatToParts
   * @param opts - Intl.DateTimeFormat constructor options, same as `toLocaleString`.
   * @example DateTime.now().toLocaleParts(); //=> [
   *                                   //=>   { type: 'day', value: '25' },
   *                                   //=>   { type: 'literal', value: '/' },
   *                                   //=>   { type: 'month', value: '05' },
   *                                   //=>   { type: 'literal', value: '/' },
   *                                   //=>   { type: 'year', value: '1982' }
   *                                   //=> ]
   */
  toLocaleParts(opts: Intl.DateTimeFormatOptions & LocaleOptions = {}): Intl.DateTimeFormatPart[] {
    return this.isValid
      ? Formatter.create(this.loc.clone(opts), opts).formatDateTimeParts(this)
      : [];
  }

  /**
   * Returns an ISO 8601-compliant string representation of this DateTime
   * @param opts - options
   * @param opts.suppressMilliseconds - exclude milliseconds from the format if they're 0
   * @param opts.suppressSeconds - exclude seconds from the format if they're 0
   * @param opts.includeOffset - include the offset, such as 'Z' or '-04:00'
   * @param opts.extendedZone - add the time zone format extension
   * @param opts.format - choose between the basic and extended format
   * @param opts.precision - truncate output to desired presicion: 'years', 'months', 'days', 'hours', 'minutes', 'seconds' or 'milliseconds'. When precision and suppressSeconds or suppressMilliseconds are used together, precision sets the maximum unit shown in the output, however seconds or milliseconds will still be suppressed if they are 0.
   * @example DateTime.utc(1983, 5, 25).toISO() //=> '1982-05-25T00:00:00.000Z'
   * @example DateTime.now().toISO() //=> '2017-04-22T20:47:05.335-04:00'
   * @example DateTime.now().toISO({ includeOffset: false }) //=> '2017-04-22T20:47:05.335'
   * @example DateTime.now().toISO({ format: 'basic' }) //=> '20170422T204705.335-0400'
   * @example DateTime.now().toISO({ precision: 'day' }) //=> '2017-04-22Z'
   * @example DateTime.now().toISO({ precision: 'minute' }) //=> '2017-04-22T20:47Z'
   */
  toISO({
    format = "extended",
    suppressSeconds = false,
    suppressMilliseconds = false,
    includeOffset = true,
    extendedZone = false,
    precision = "milliseconds",
  }: ToISOOptions = {}): string | null {
    if (!this.isValid) {
      return null;
    }

    const normalizedPrecision = normalizeUnit(precision);
    const ext = format === "extended";

    let s = toISODate(this, ext, normalizedPrecision);
    if (orderedUnits.indexOf(normalizedPrecision) >= 3) s += "T";
    s += toISOTime(
      this,
      ext,
      suppressSeconds,
      suppressMilliseconds,
      includeOffset,
      extendedZone,
      normalizedPrecision
    );
    return s;
  }

  /**
   * Returns an ISO 8601-compliant string representation of this DateTime's date component
   * @param opts - options
   * @param opts.format - choose between the basic and extended format
   * @param opts.precision - truncate output to desired precision: 'years', 'months', or 'days'.
   * @example DateTime.utc(1982, 5, 25).toISODate() //=> '1982-05-25'
   * @example DateTime.utc(1982, 5, 25).toISODate({ format: 'basic' }) //=> '19820525'
   * @example DateTime.utc(1982, 5, 25).toISODate({ precision: 'month' }) //=> '1982-05'
   */
  toISODate({ format = "extended", precision = "day" }: ToISODateOptions = {}): string | null {
    if (!this.isValid) {
      return null;
    }
    return toISODate(this, format === "extended", normalizeUnit(precision));
  }

  /**
   * Returns an ISO 8601-compliant string representation of this DateTime's week date
   * @example DateTime.utc(1982, 5, 25).toISOWeekDate() //=> '1982-W21-2'
   */
  toISOWeekDate(): string | null {
    return toTechFormat(this, "kkkk-'W'WW-c");
  }

  /**
   * Returns an ISO 8601-compliant string representation of this DateTime's time component
   * @param opts - options
   * @param opts.suppressMilliseconds - exclude milliseconds from the format if they're 0
   * @param opts.suppressSeconds - exclude seconds from the format if they're 0
   * @param opts.includeOffset - include the offset, such as 'Z' or '-04:00'
   * @param opts.extendedZone - add the time zone format extension
   * @param opts.includePrefix - include the `T` prefix
   * @param opts.format - choose between the basic and extended format
   * @param opts.precision - truncate output to desired presicion: 'hours', 'minutes', 'seconds' or 'milliseconds'. When precision and suppressSeconds or suppressMilliseconds are used together, precision sets the maximum unit shown in the output, however seconds or milliseconds will still be suppressed if they are 0.
   * @example DateTime.utc().set({ hour: 7, minute: 34 }).toISOTime() //=> '07:34:19.361Z'
   * @example DateTime.utc().set({ hour: 7, minute: 34, seconds: 0, milliseconds: 0 }).toISOTime({ suppressSeconds: true }) //=> '07:34Z'
   * @example DateTime.utc().set({ hour: 7, minute: 34 }).toISOTime({ format: 'basic' }) //=> '073419.361Z'
   * @example DateTime.utc().set({ hour: 7, minute: 34 }).toISOTime({ includePrefix: true }) //=> 'T07:34:19.361Z'
   * @example DateTime.utc().set({ hour: 7, minute: 34, second: 56 }).toISOTime({ precision: 'minute' }) //=> '07:34Z'
   */
  toISOTime({
    suppressMilliseconds = false,
    suppressSeconds = false,
    includeOffset = true,
    includePrefix = false,
    extendedZone = false,
    format = "extended",
    precision = "milliseconds",
  }: ToISOTimeOptions = {}): string | null {
    if (!this.isValid) {
      return null;
    }

    const normalizedPrecision = normalizeUnit(precision);
    const s = includePrefix && orderedUnits.indexOf(normalizedPrecision) >= 3 ? "T" : "";
    return (
      s +
      toISOTime(
        this,
        format === "extended",
        suppressSeconds,
        suppressMilliseconds,
        includeOffset,
        extendedZone,
        normalizedPrecision
      )
    );
  }

  /**
   * Returns an RFC 2822-compatible string representation of this DateTime
   * @example DateTime.utc(2014, 7, 13).toRFC2822() //=> 'Sun, 13 Jul 2014 00:00:00 +0000'
   * @example DateTime.local(2014, 7, 13).toRFC2822() //=> 'Sun, 13 Jul 2014 00:00:00 -0400'
   */
  toRFC2822(): string | null {
    return toTechFormat(this, "EEE, dd LLL yyyy HH:mm:ss ZZZ", false);
  }

  /**
   * Returns a string representation of this DateTime appropriate for use in HTTP headers. The output is always expressed in GMT.
   * Specifically, the string conforms to RFC 1123.
   * @see https://www.w3.org/Protocols/rfc2616/rfc2616-sec3.html#sec3.3.1
   * @example DateTime.utc(2014, 7, 13).toHTTP() //=> 'Sun, 13 Jul 2014 00:00:00 GMT'
   * @example DateTime.utc(2014, 7, 13, 19).toHTTP() //=> 'Sun, 13 Jul 2014 19:00:00 GMT'
   */
  toHTTP(): string | null {
    return toTechFormat(this.toUTC(), "EEE, dd LLL yyyy HH:mm:ss 'GMT'");
  }

  /**
   * Returns a string representation of this DateTime appropriate for use in SQL Date
   * @example DateTime.utc(2014, 7, 13).toSQLDate() //=> '2014-07-13'
   */
  toSQLDate(): string | null {
    if (!this.isValid) {
      return null;
    }
    return toISODate(this, true);
  }

  /**
   * Returns a string representation of this DateTime appropriate for use in SQL Time
   * @param opts - options
   * @param opts.includeZone - include the zone, such as 'America/New_York'. Overrides includeOffset.
   * @param opts.includeOffset - include the offset, such as 'Z' or '-04:00'
   * @param opts.includeOffsetSpace - include the space between the time and the offset, such as '05:15:16.345 -04:00'
   * @example DateTime.utc().toSQL() //=> '05:15:16.345'
   * @example DateTime.now().toSQL() //=> '05:15:16.345 -04:00'
   * @example DateTime.now().toSQL({ includeOffset: false }) //=> '05:15:16.345'
   * @example DateTime.now().toSQL({ includeZone: false }) //=> '05:15:16.345 America/New_York'
   */
  toSQLTime({
    includeOffset = true,
    includeZone = false,
    includeOffsetSpace = true,
  }: ToSQLOptions = {}): string | null {
    let fmt = "HH:mm:ss.SSS";

    if (includeZone || includeOffset) {
      if (includeOffsetSpace) {
        fmt += " ";
      }
      if (includeZone) {
        fmt += "z";
      } else if (includeOffset) {
        fmt += "ZZ";
      }
    }

    return toTechFormat(this, fmt, true);
  }

  /**
   * Returns a string representation of this DateTime appropriate for use in SQL DateTime
   * @param opts - options
   * @param opts.includeZone - include the zone, such as 'America/New_York'. Overrides includeOffset.
   * @param opts.includeOffset - include the offset, such as 'Z' or '-04:00'
   * @param opts.includeOffsetSpace - include the space between the time and the offset, such as '05:15:16.345 -04:00'
   * @example DateTime.utc(2014, 7, 13).toSQL() //=> '2014-07-13 00:00:00.000 Z'
   * @example DateTime.local(2014, 7, 13).toSQL() //=> '2014-07-13 00:00:00.000 -04:00'
   * @example DateTime.local(2014, 7, 13).toSQL({ includeOffset: false }) //=> '2014-07-13 00:00:00.000'
   * @example DateTime.local(2014, 7, 13).toSQL({ includeZone: true }) //=> '2014-07-13 00:00:00.000 America/New_York'
   */
  toSQL(opts: ToSQLOptions = {}): string | null {
    if (!this.isValid) {
      return null;
    }

    return `${this.toSQLDate()} ${this.toSQLTime(opts)}`;
  }

  /**
   * Returns a string representation of this DateTime appropriate for debugging
   */
  toString(): string {
    return this.isValid ? (this.toISO() as string) : INVALID;
  }

  /**
   * Returns a string representation of this DateTime appropriate for the REPL.
   */
  [INSPECT](): string {
    if (this.isValid) {
      return `DateTime { ts: ${this.toISO()}, zone: ${this.zone.name}, locale: ${this.locale} }`;
    } else {
      return `DateTime { Invalid, reason: ${this.invalidReason} }`;
    }
  }

  /**
   * Returns the epoch milliseconds of this DateTime. Alias of {@link DateTime#toMillis}
   */
  valueOf(): number {
    return this.toMillis();
  }

  /**
   * Returns the epoch milliseconds of this DateTime.
   */
  toMillis(): number {
    return this.isValid ? this.ts : NaN;
  }

  /**
   * Returns the epoch seconds (including milliseconds in the fractional part) of this DateTime.
   */
  toSeconds(): number {
    return this.isValid ? this.ts / 1000 : NaN;
  }

  /**
   * Returns the epoch seconds (as a whole number) of this DateTime.
   */
  toUnixInteger(): number {
    return this.isValid ? Math.floor(this.ts / 1000) : NaN;
  }

  /**
   * Returns an ISO 8601 representation of this DateTime appropriate for use in JSON.
   */
  toJSON(): string | null {
    return this.toISO();
  }

  /**
   * Returns a BSON serializable equivalent to this DateTime.
   */
  toBSON(): Date {
    return this.toJSDate();
  }

  /**
   * Returns a JavaScript object with this DateTime's year, month, day, and so on.
   * @param opts - options for generating the object
   * @param opts.includeConfig - include configuration attributes in the output
   * @example DateTime.now().toObject() //=> { year: 2017, month: 4, day: 22, hour: 20, minute: 49, second: 42, millisecond: 268 }
   */
  toObject(opts: ToObjectOptions = {}): Partial<GregorianDateTimeWithConfig> {
    if (!this.isValid) return {};

    const base: GregorianDateTimeWithConfig = { ...fieldsOf(this) };

    if (opts.includeConfig) {
      base.outputCalendar = this.outputCalendar;
      base.numberingSystem = this.loc.numberingSystem;
      base.locale = this.loc.locale;
    }
    return base;
  }

  /**
   * Returns a JavaScript Date equivalent to this DateTime.
   */
  toJSDate(): Date {
    return new Date(this.isValid ? this.ts : NaN);
  }

  /**
   * Returns a `Temporal.ZonedDateTime` equivalent to this DateTime, or null if it is invalid or
   * Temporal has no time zone for it. IANA and fixed-offset zones map directly onto Temporal time
   * zones; custom {@link Zone} implementations are represented by their UTC offset at this
   * instant. Temporal's offset time zones are whole minutes under a day, so a sub-minute offset
   * (or a fixed offset of a day or more) has no counterpart.
   * @example DateTime.now().toZonedDateTime().toString() //=> '2017-04-22T20:47:05.335-04:00[America/New_York]'
   */
  toZonedDateTime(): ZonedDateTime | null {
    if (!this.isValid) return null;
    const tzId = this.tz ?? offsetTimeZoneId(offsetOf(this));
    return tzId === null ? null : zonedDateTime(this.ts, tzId);
  }

  /**
   * Returns a `Temporal.Instant` equivalent to this DateTime, or null if it is invalid.
   */
  toInstant(): Instant | null {
    return this.isValid ? temporal().Instant.fromEpochMilliseconds(Math.trunc(this.ts)) : null;
  }

  /**
   * Returns a `Temporal.PlainDateTime` with the wall-clock date and time of this DateTime, or null if it is invalid.
   */
  toPlainDateTime(): PlainDateTime | null {
    return this.isValid ? temporal().PlainDateTime.from(fieldsOf(this)) : null;
  }

  /**
   * Returns a `Temporal.PlainDate` with the calendar date of this DateTime, or null if it is invalid.
   */
  toPlainDate(): PlainDate | null {
    if (!this.isValid) return null;
    const c = fieldsOf(this);
    return plainDate(c.year, c.month, c.day);
  }

  /**
   * Returns a `Temporal.PlainTime` with the wall-clock time of this DateTime, or null if it is invalid.
   */
  toPlainTime(): PlainTime | null {
    if (!this.isValid) return null;
    const { hour, minute, second, millisecond } = fieldsOf(this);
    return temporal().PlainTime.from({ hour, minute, second, millisecond });
  }

  // COMPARE

  /**
   * Return the difference between two DateTimes as a Duration.
   * @param otherDateTime - the DateTime to compare this one to
   * @param unit - the unit or array of units (such as 'hours' or 'days') to include in the duration.
   * @param opts - options that affect the creation of the Duration
   * @param opts.conversionAccuracy - the conversion system to use
   * @example
   * var i1 = DateTime.fromISO('1982-05-25T09:45'),
   *     i2 = DateTime.fromISO('1983-10-14T10:30');
   * i2.diff(i1).toObject() //=> { milliseconds: 43807500000 }
   * i2.diff(i1, 'hours').toObject() //=> { hours: 12168.75 }
   * i2.diff(i1, ['months', 'days']).toObject() //=> { months: 16, days: 19.03125 }
   * i2.diff(i1, ['months', 'days', 'hours']).toObject() //=> { months: 16, days: 19, hours: 0.75 }
   */
  diff(
    otherDateTime: DateTime,
    unit: DurationUnits | DurationUnits[] = "milliseconds",
    opts: DiffOptions = {}
  ): Duration {
    if (!this.isValid || !otherDateTime.isValid) {
      return Duration.invalid("created by diffing an invalid DateTime");
    }

    const durOpts = {
      locale: this.locale,
      numberingSystem: this.numberingSystem,
      ...opts,
    };

    const units = maybeArray(unit).map(Duration.normalizeUnit),
      otherIsLater = otherDateTime.valueOf() > this.valueOf(),
      earlier = otherIsLater ? this : otherDateTime,
      later = otherIsLater ? otherDateTime : this,
      diffed = diff(earlier, later, units, durOpts);

    return otherIsLater ? diffed.negate() : diffed;
  }

  /**
   * Return the difference between this DateTime and right now.
   * See {@link DateTime#diff}
   * @param unit - the unit or units units (such as 'hours' or 'days') to include in the duration
   * @param opts - options that affect the creation of the Duration
   * @param opts.conversionAccuracy - the conversion system to use
   */
  diffNow(unit: DurationUnits | DurationUnits[] = "milliseconds", opts: DiffOptions = {}): Duration {
    return this.diff(DateTime.now(), unit, opts);
  }

  /**
   * Return an Interval spanning between this DateTime and another DateTime
   * @param otherDateTime - the other end point of the Interval
   */
  until(otherDateTime: DateTime): Interval | DateTime {
    return this.isValid ? Interval.fromDateTimes(this, otherDateTime) : this;
  }

  /**
   * Return whether this DateTime is in the same unit of time as another DateTime.
   * Higher-order units must also be identical for this function to return `true`.
   * Note that time zones are **ignored** in this comparison, which compares the **local** calendar time. Use {@link DateTime#setZone} to convert one of the dates if needed.
   * @param otherDateTime - the other DateTime
   * @param unit - the unit of time to check sameness on
   * @param opts - options
   * @param opts.useLocaleWeeks - If true, use weeks based on the locale, i.e. use the locale-dependent start of the week; only the locale of this DateTime is used
   * @example DateTime.now().hasSame(otherDT, 'day'); //~> true if otherDT is in the same current calendar day
   */
  hasSame(otherDateTime: DateTime, unit: DurationUnits, opts?: StartOfOptions): boolean {
    if (!this.isValid) return false;

    const inputMs = otherDateTime.valueOf();
    const adjustedToZone = this.setZone(otherDateTime.zone, { keepLocalTime: true });
    return (
      adjustedToZone.startOf(unit, opts).valueOf() <= inputMs &&
      inputMs <= adjustedToZone.endOf(unit, opts).valueOf()
    );
  }

  /**
   * Equality check
   * Two DateTimes are equal if and only if they represent the same millisecond, have the same zone and location, and are both valid.
   * To compare just the millisecond values, use `+dt1 === +dt2`.
   * @param other - the other DateTime
   */
  equals(other: DateTime): boolean {
    return (
      this.isValid &&
      other.isValid &&
      this.valueOf() === other.valueOf() &&
      this.zone.equals(other.zone) &&
      this.loc.equals(other.loc)
    );
  }

  /**
   * Returns a string representation of a this time relative to now, such as "in two days". Can only internationalize if your
   * platform supports Intl.RelativeTimeFormat. Rounds towards zero by default.
   * @param options - options that affect the output
   * @param options.base - the DateTime to use as the basis to which this time is compared. Defaults to now.
   * @param options.style - the style of units, must be "long", "short", or "narrow"
   * @param options.unit - use a specific unit or array of units; if omitted, or an array, the method will pick the best unit. Use an array or one of "years", "quarters", "months", "weeks", "days", "hours", "minutes", or "seconds"
   * @param options.round - whether to round the numbers in the output.
   * @param options.rounding - rounding method to use when rounding the numbers in the output. Can be "trunc" (toward zero), "expand" (away from zero), "round", "floor", or "ceil".
   * @param options.padding - padding in milliseconds. This allows you to round up the result if it fits inside the threshold. Don't use in combination with {round: false} because the decimal output will include the padding.
   * @param options.locale - override the locale of this DateTime
   * @param options.numberingSystem - override the numberingSystem of this DateTime. The Intl system may choose not to honor this
   * @example DateTime.now().plus({ days: 1 }).toRelative() //=> "in 1 day"
   * @example DateTime.now().setLocale("es").plus({ days: 1 }).toRelative() //=> "dentro de 1 día"
   * @example DateTime.now().plus({ days: 1 }).toRelative({ locale: "fr" }) //=> "dans 23 heures"
   * @example DateTime.now().minus({ days: 2 }).toRelative() //=> "2 days ago"
   * @example DateTime.now().minus({ days: 2 }).toRelative({ unit: "hours" }) //=> "48 hours ago"
   * @example DateTime.now().minus({ hours: 36 }).toRelative({ round: false }) //=> "1.5 days ago"
   */
  toRelative(options: ToRelativeOptions = {}): string | null {
    if (!this.isValid) return null;
    const base = options.base || DateTime.fromObject({}, { zone: this.zone }),
      padding = options.padding ? (this < base ? -options.padding : options.padding) : 0;
    let units: string[] = ["years", "months", "days", "hours", "minutes", "seconds"];
    let unit: string | undefined = options.unit as string | undefined;
    if (Array.isArray(options.unit)) {
      units = options.unit;
      unit = undefined;
    }
    return diffRelative(base, this.plus(padding), {
      ...options,
      numeric: "always",
      units,
      unit,
    });
  }

  /**
   * Returns a string representation of this date relative to today, such as "yesterday" or "next month".
   * Only internationalizes on platforms that supports Intl.RelativeTimeFormat.
   * @param options - options that affect the output
   * @param options.base - the DateTime to use as the basis to which this time is compared. Defaults to now.
   * @param options.locale - override the locale of this DateTime
   * @param options.unit - use a specific unit; if omitted, the method will pick the unit. Use one of "years", "quarters", "months", "weeks", or "days"
   * @param options.numberingSystem - override the numberingSystem of this DateTime. The Intl system may choose not to honor this
   * @example DateTime.now().plus({ days: 1 }).toRelativeCalendar() //=> "tomorrow"
   * @example DateTime.now().setLocale("es").plus({ days: 1 }).toRelativeCalendar() //=> "mañana"
   * @example DateTime.now().plus({ days: 1 }).toRelativeCalendar({ locale: "fr" }) //=> "demain"
   * @example DateTime.now().minus({ days: 2 }).toRelativeCalendar() //=> "2 days ago"
   */
  toRelativeCalendar(options: ToRelativeCalendarOptions = {}): string | null {
    if (!this.isValid) return null;

    return diffRelative(options.base || DateTime.fromObject({}, { zone: this.zone }), this, {
      ...options,
      numeric: "auto",
      units: ["years", "months", "days"],
      calendary: true,
    });
  }

  /**
   * Return the min of several date times
   * @param dateTimes - the DateTimes from which to choose the minimum
   * @return the min DateTime, or undefined if called with no argument
   */
  static min(...dateTimes: DateTime[]): DateTime | undefined {
    if (!dateTimes.every(DateTime.isDateTime)) {
      throw new InvalidArgumentError("min requires all arguments be DateTimes");
    }
    return bestBy(dateTimes, (i) => i.valueOf(), Math.min);
  }

  /**
   * Return the max of several date times
   * @param dateTimes - the DateTimes from which to choose the maximum
   * @return the max DateTime, or undefined if called with no argument
   */
  static max(...dateTimes: DateTime[]): DateTime | undefined {
    if (!dateTimes.every(DateTime.isDateTime)) {
      throw new InvalidArgumentError("max requires all arguments be DateTimes");
    }
    return bestBy(dateTimes, (i) => i.valueOf(), Math.max);
  }

  // MISC

  /**
   * Explain how a string would be parsed by fromFormat()
   * @param text - the string to parse
   * @param fmt - the format the string is expected to be in (see description)
   * @param options - options taken by fromFormat()
   */
  static fromFormatExplain(text: string, fmt: string, options: DateTimeOptions = {}): ExplainedFormat {
    const { locale = null, numberingSystem = null } = options,
      localeToUse = Locale.fromOpts({
        locale,
        numberingSystem,
        defaultToEN: true,
      });
    return explainFromTokens(localeToUse, text, fmt);
  }

  /**
   * @deprecated use fromFormatExplain instead
   */
  static fromStringExplain(text: string, fmt: string, options: DateTimeOptions = {}): ExplainedFormat {
    return DateTime.fromFormatExplain(text, fmt, options);
  }

  /**
   * Build a parser for `fmt` using the given locale. This parser can be passed
   * to {@link DateTime.fromFormatParser} to a parse a date in this format. This
   * can be used to optimize cases where many dates need to be parsed in a
   * specific format.
   *
   * @param fmt - the format the string is expected to be in (see
   * description)
   * @param options - options used to set locale and numberingSystem
   * for parser
   * @returns opaque object to be used
   */
  static buildFormatParser(fmt: string, options: LocaleOptions = {}): TokenParser {
    const { locale = null, numberingSystem = null } = options,
      localeToUse = Locale.fromOpts({
        locale,
        numberingSystem,
        defaultToEN: true,
      });
    return new TokenParser(localeToUse, fmt);
  }

  /**
   * Create a DateTime from an input string and format parser.
   *
   * The format parser must have been created with the same locale as this call.
   *
   * @param text - the string to parse
   * @param formatParser - parser from {@link DateTime.buildFormatParser}
   * @param opts - options taken by fromFormat()
   */
  static fromFormatParser(text: string, formatParser: TokenParser, opts: DateTimeOptions = {}): DateTime {
    if (isUndefined(text) || isUndefined(formatParser)) {
      throw new InvalidArgumentError(
        "fromFormatParser requires an input string and a format parser"
      );
    }
    const { locale = null, numberingSystem = null } = opts,
      localeToUse = Locale.fromOpts({
        locale,
        numberingSystem,
        defaultToEN: true,
      });

    if (!localeToUse.equals(formatParser.locale)) {
      throw new InvalidArgumentError(
        `fromFormatParser called with a locale of ${localeToUse}, ` +
          `but the format parser was created for ${formatParser.locale}`
      );
    }

    const { result, zone, specificOffset, invalidReason } = formatParser.explainFromTokens(text);

    if (invalidReason) {
      return DateTime.invalid(invalidReason);
    } else {
      return parseDataToDateTime(
        result,
        zone,
        opts,
        `format ${formatParser.format}`,
        text,
        specificOffset
      );
    }
  }

  // FORMAT PRESETS

  /**
   * {@link DateTime#toLocaleString} format like 10/14/1983
   */
  static get DATE_SHORT(): Intl.DateTimeFormatOptions {
    return Formats.DATE_SHORT;
  }

  /**
   * {@link DateTime#toLocaleString} format like 'Oct 14, 1983'
   */
  static get DATE_MED(): Intl.DateTimeFormatOptions {
    return Formats.DATE_MED;
  }

  /**
   * {@link DateTime#toLocaleString} format like 'Fri, Oct 14, 1983'
   */
  static get DATE_MED_WITH_WEEKDAY(): Intl.DateTimeFormatOptions {
    return Formats.DATE_MED_WITH_WEEKDAY;
  }

  /**
   * {@link DateTime#toLocaleString} format like 'October 14, 1983'
   */
  static get DATE_FULL(): Intl.DateTimeFormatOptions {
    return Formats.DATE_FULL;
  }

  /**
   * {@link DateTime#toLocaleString} format like 'Tuesday, October 14, 1983'
   */
  static get DATE_HUGE(): Intl.DateTimeFormatOptions {
    return Formats.DATE_HUGE;
  }

  /**
   * {@link DateTime#toLocaleString} format like '09:30 AM'. Only 12-hour if the locale is.
   */
  static get TIME_SIMPLE(): Intl.DateTimeFormatOptions {
    return Formats.TIME_SIMPLE;
  }

  /**
   * {@link DateTime#toLocaleString} format like '09:30:23 AM'. Only 12-hour if the locale is.
   */
  static get TIME_WITH_SECONDS(): Intl.DateTimeFormatOptions {
    return Formats.TIME_WITH_SECONDS;
  }

  /**
   * {@link DateTime#toLocaleString} format like '09:30:23 AM EDT'. Only 12-hour if the locale is.
   */
  static get TIME_WITH_SHORT_OFFSET(): Intl.DateTimeFormatOptions {
    return Formats.TIME_WITH_SHORT_OFFSET;
  }

  /**
   * {@link DateTime#toLocaleString} format like '09:30:23 AM Eastern Daylight Time'. Only 12-hour if the locale is.
   */
  static get TIME_WITH_LONG_OFFSET(): Intl.DateTimeFormatOptions {
    return Formats.TIME_WITH_LONG_OFFSET;
  }

  /**
   * {@link DateTime#toLocaleString} format like '09:30', always 24-hour.
   */
  static get TIME_24_SIMPLE(): Intl.DateTimeFormatOptions {
    return Formats.TIME_24_SIMPLE;
  }

  /**
   * {@link DateTime#toLocaleString} format like '09:30:23', always 24-hour.
   */
  static get TIME_24_WITH_SECONDS(): Intl.DateTimeFormatOptions {
    return Formats.TIME_24_WITH_SECONDS;
  }

  /**
   * {@link DateTime#toLocaleString} format like '09:30:23 EDT', always 24-hour.
   */
  static get TIME_24_WITH_SHORT_OFFSET(): Intl.DateTimeFormatOptions {
    return Formats.TIME_24_WITH_SHORT_OFFSET;
  }

  /**
   * {@link DateTime#toLocaleString} format like '09:30:23 Eastern Daylight Time', always 24-hour.
   */
  static get TIME_24_WITH_LONG_OFFSET(): Intl.DateTimeFormatOptions {
    return Formats.TIME_24_WITH_LONG_OFFSET;
  }

  /**
   * {@link DateTime#toLocaleString} format like '10/14/1983, 9:30 AM'. Only 12-hour if the locale is.
   */
  static get DATETIME_SHORT(): Intl.DateTimeFormatOptions {
    return Formats.DATETIME_SHORT;
  }

  /**
   * {@link DateTime#toLocaleString} format like '10/14/1983, 9:30:33 AM'. Only 12-hour if the locale is.
   */
  static get DATETIME_SHORT_WITH_SECONDS(): Intl.DateTimeFormatOptions {
    return Formats.DATETIME_SHORT_WITH_SECONDS;
  }

  /**
   * {@link DateTime#toLocaleString} format like 'Oct 14, 1983, 9:30 AM'. Only 12-hour if the locale is.
   */
  static get DATETIME_MED(): Intl.DateTimeFormatOptions {
    return Formats.DATETIME_MED;
  }

  /**
   * {@link DateTime#toLocaleString} format like 'Oct 14, 1983, 9:30:33 AM'. Only 12-hour if the locale is.
   */
  static get DATETIME_MED_WITH_SECONDS(): Intl.DateTimeFormatOptions {
    return Formats.DATETIME_MED_WITH_SECONDS;
  }

  /**
   * {@link DateTime#toLocaleString} format like 'Fri, 14 Oct 1983, 9:30 AM'. Only 12-hour if the locale is.
   */
  static get DATETIME_MED_WITH_WEEKDAY(): Intl.DateTimeFormatOptions {
    return Formats.DATETIME_MED_WITH_WEEKDAY;
  }

  /**
   * {@link DateTime#toLocaleString} format like 'October 14, 1983, 9:30 AM EDT'. Only 12-hour if the locale is.
   */
  static get DATETIME_FULL(): Intl.DateTimeFormatOptions {
    return Formats.DATETIME_FULL;
  }

  /**
   * {@link DateTime#toLocaleString} format like 'October 14, 1983, 9:30:33 AM EDT'. Only 12-hour if the locale is.
   */
  static get DATETIME_FULL_WITH_SECONDS(): Intl.DateTimeFormatOptions {
    return Formats.DATETIME_FULL_WITH_SECONDS;
  }

  /**
   * {@link DateTime#toLocaleString} format like 'Friday, October 14, 1983, 9:30 AM Eastern Daylight Time'. Only 12-hour if the locale is.
   */
  static get DATETIME_HUGE(): Intl.DateTimeFormatOptions {
    return Formats.DATETIME_HUGE;
  }

  /**
   * {@link DateTime#toLocaleString} format like 'Friday, October 14, 1983, 9:30:33 AM Eastern Daylight Time'. Only 12-hour if the locale is.
   */
  static get DATETIME_HUGE_WITH_SECONDS(): Intl.DateTimeFormatOptions {
    return Formats.DATETIME_HUGE_WITH_SECONDS;
  }
}

/**
 * @private
 */
export function friendlyDateTime(dateTimeish: DateTimeLike): DateTime {
  if (DateTime.isDateTime(dateTimeish)) {
    return dateTimeish;
  } else if (dateTimeish && dateTimeish.valueOf && isNumber(dateTimeish.valueOf())) {
    return DateTime.fromJSDate(dateTimeish as Date);
  } else if (dateTimeish && typeof dateTimeish === "object") {
    return DateTime.fromObject(dateTimeish as DateObjectUnits);
  } else {
    throw new InvalidArgumentError(
      `Unknown datetime argument: ${dateTimeish}, of type ${typeof dateTimeish}`
    );
  }
}

export type { DateTimeUnit, DateTimeUnitPlural };
