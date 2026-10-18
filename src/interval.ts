import DateTime, { friendlyDateTime, parseDataToDateTime } from "./datetime.js";
import Duration from "./duration.js";
import Settings from "./settings.js";
import { InvalidArgumentError, InvalidIntervalError } from "./errors.js";
import Invalid from "./impl/invalid.js";
import Formatter from "./impl/formatter.js";
import * as Formats from "./impl/formats.js";
import { parseISOIntervalEnd } from "./impl/regexParser.js";
import type {
  DateTimeLike,
  DateTimeOptions,
  DiffOptions,
  DurationLike,
  DurationUnits,
  LocaleOptions,
  StartOfOptions,
  ToISOTimeOptions,
} from "./types.js";

const INVALID = "Invalid Interval";
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

interface IntervalConfig {
  start?: DateTime;
  end?: DateTime;
  invalid?: Invalid | null;
}

// checks if the start is equal to or before the end
function validateStartEnd(start: DateTime, end: DateTime): Interval | null {
  if (!start || !start.isValid) {
    return Interval.invalid("missing or invalid start");
  } else if (!end || !end.isValid) {
    return Interval.invalid("missing or invalid end");
  } else if (end < start) {
    return Interval.invalid(
      "end before start",
      `The end of an interval must be after its start, but you had start=${start.toISO()} and end=${end.toISO()}`
    );
  } else {
    return null;
  }
}

/**
 * An Interval object represents a half-open interval of time, where each endpoint is a {@link DateTime}. Conceptually, it's a container for those two endpoints, accompanied by methods for creating, parsing, interrogating, comparing, transforming, and formatting them.
 *
 * Here is a brief overview of the most commonly used methods and getters in Interval:
 *
 * * **Creation** To create an Interval, use {@link Interval.fromDateTimes}, {@link Interval.after}, {@link Interval.before}, or {@link Interval.fromISO}.
 * * **Accessors** Use {@link Interval#start} and {@link Interval#end} to get the start and end.
 * * **Interrogation** To analyze the Interval, use {@link Interval#count}, {@link Interval#length}, {@link Interval#hasSame}, {@link Interval#contains}, {@link Interval#isAfter}, or {@link Interval#isBefore}.
 * * **Transformation** To create other Intervals out of this one, use {@link Interval#set}, {@link Interval#splitAt}, {@link Interval#splitBy}, {@link Interval#divideEqually}, {@link Interval.merge}, {@link Interval.xor}, {@link Interval#union}, {@link Interval#intersection}, or {@link Interval#difference}.
 * * **Comparison** To compare this Interval to another one, use {@link Interval#equals}, {@link Interval#overlaps}, {@link Interval#abutsStart}, {@link Interval#abutsEnd}, {@link Interval#engulfs}
 * * **Output** To convert the Interval into other representations, see {@link Interval#toString}, {@link Interval#toLocaleString}, {@link Interval#toISO}, {@link Interval#toISODate}, {@link Interval#toISOTime}, {@link Interval#toFormat}, and {@link Interval#toDuration}.
 */
export default class Interval {
  /** @internal */
  readonly s: DateTime;
  /** @internal */
  readonly e: DateTime;
  /** @internal */
  readonly invalid: Invalid | null;
  /** @internal */
  readonly isLuxonInterval: true;

  /**
   * @private
   */
  constructor(config: IntervalConfig) {
    this.s = config.start as DateTime;
    this.e = config.end as DateTime;
    this.invalid = config.invalid || null;
    this.isLuxonInterval = true;
  }

  /**
   * Create an invalid Interval.
   * @param reason - simple string of why this Interval is invalid. Should not contain parameters or anything else data-dependent
   * @param explanation - longer explanation, may include parameters and other useful debugging information
   */
  static invalid(reason: string | Invalid, explanation: string | null = null): Interval {
    if (!reason) {
      throw new InvalidArgumentError("need to specify a reason the Interval is invalid");
    }

    const invalid = reason instanceof Invalid ? reason : new Invalid(reason, explanation);

    if (Settings.throwOnInvalid) {
      throw new InvalidIntervalError(invalid);
    } else {
      return new Interval({ invalid });
    }
  }

  /**
   * Create an Interval from a start DateTime and an end DateTime. Inclusive of the start but not the end.
   */
  static fromDateTimes(start: DateTimeLike, end: DateTimeLike): Interval {
    const builtStart = friendlyDateTime(start),
      builtEnd = friendlyDateTime(end);

    const validateError = validateStartEnd(builtStart, builtEnd);

    if (validateError == null) {
      return new Interval({
        start: builtStart,
        end: builtEnd,
      });
    } else {
      return validateError;
    }
  }

  /**
   * Create an Interval from a start DateTime and a Duration to extend to.
   * @param start
   * @param duration - the length of the Interval.
   */
  static after(start: DateTimeLike, duration: DurationLike): Interval {
    const dur = Duration.fromDurationLike(duration),
      dt = friendlyDateTime(start);
    return Interval.fromDateTimes(dt, dt.plus(dur));
  }

  /**
   * Create an Interval from an end DateTime and a Duration to extend backwards to.
   * @param end
   * @param duration - the length of the Interval.
   */
  static before(end: DateTimeLike, duration: DurationLike): Interval {
    const dur = Duration.fromDurationLike(duration),
      dt = friendlyDateTime(end);
    return Interval.fromDateTimes(dt.minus(dur), dt);
  }

  /**
   * Create an Interval from an ISO 8601 string.
   * Accepts `<start>/<end>`, `<start>/<duration>`, and `<duration>/<end>` formats.
   * @param text - the ISO string to parse
   * @param opts - options to pass {@link DateTime#fromISO} and optionally {@link Duration#fromISO}
   * @see https://en.wikipedia.org/wiki/ISO_8601#Time_intervals
   */
  static fromISO(text: string, opts?: DateTimeOptions): Interval {
    const { zone, setZone, ...restOpts } = opts || {};
    const [s, e] = (text || "").split("/", 2);
    if (s && e) {
      let start: DateTime | undefined, startIsValid: boolean;
      try {
        // we need to know the zone that was used in the string, so that we can
        // default to it when parsing end, therefor use setZone: true
        start = DateTime.fromISO(s, { ...restOpts, zone, setZone: true });
        startIsValid = start.isValid;
      } catch (e) {
        startIsValid = false;
      }

      let end: DateTime | undefined, endIsValid: boolean;
      try {
        const [vals, parsedZone] = parseISOIntervalEnd(e);
        const endParseOpts = {
          ...restOpts,
          overrideNow: startIsValid ? (start as DateTime).valueOf() : null,
          zone: startIsValid ? (start as DateTime).zone : zone,
          setZone: true,
        };
        end = parseDataToDateTime(vals, parsedZone, endParseOpts, "ISO 8601 Interval end", e);
        endIsValid = end.isValid;
      } catch (e) {
        endIsValid = false;
      }

      // if we overrode the user's choice for setZone earlier, make up for it now
      if (startIsValid && !setZone) {
        start = (start as DateTime).setZone(zone);
      }
      if (endIsValid && !setZone) {
        end = (end as DateTime).setZone(zone);
      }

      if (startIsValid && endIsValid) {
        return Interval.fromDateTimes(start as DateTime, end as DateTime);
      }

      if (startIsValid) {
        const dur = Duration.fromISO(e, opts);
        if (dur.isValid) {
          return Interval.after(start as DateTime, dur);
        }
      } else if (endIsValid) {
        const dur = Duration.fromISO(s, opts);
        if (dur.isValid) {
          return Interval.before(end as DateTime, dur);
        }
      }
    }
    return Interval.invalid("unparsable", `the input "${text}" can't be parsed as ISO 8601`);
  }

  /**
   * Check if an object is an Interval. Works across context boundaries
   */
  static isInterval(o: unknown): o is Interval {
    return (!!o && (o as Interval).isLuxonInterval) || false;
  }

  /**
   * Returns the start of the Interval
   */
  get start(): DateTime | null {
    return this.isValid ? this.s : null;
  }

  /**
   * Returns the end of the Interval. This is the first instant which is not part of the interval
   * (Interval is half-open).
   */
  get end(): DateTime | null {
    return this.isValid ? this.e : null;
  }

  /**
   * Returns the last DateTime included in the interval (since end is not part of the interval)
   */
  get lastDateTime(): DateTime | null {
    return this.isValid ? (this.e ? this.e.minus(1) : null) : null;
  }

  /**
   * Returns whether this Interval's end is at least its start, meaning that the Interval isn't 'backwards'.
   */
  get isValid(): boolean {
    return this.invalidReason === null;
  }

  /**
   * Returns an error code if this Interval is invalid, or null if the Interval is valid
   */
  get invalidReason(): string | null {
    return this.invalid ? this.invalid.reason : null;
  }

  /**
   * Returns an explanation of why this Interval became invalid, or null if the Interval is valid
   */
  get invalidExplanation(): string | null {
    return this.invalid ? this.invalid.explanation : null;
  }

  /**
   * Returns the length of the Interval in the specified unit.
   * @param unit - the unit (such as 'hours' or 'days') to return the length in.
   */
  length(unit: DurationUnits = "milliseconds"): number {
    return this.isValid ? this.toDuration(...[unit]).get(unit) : NaN;
  }

  /**
   * Returns the count of minutes, hours, days, months, or years included in the Interval, even in part.
   * Unlike {@link Interval#length} this counts sections of the calendar, not periods of time, e.g. specifying 'day'
   * asks 'what dates are included in this interval?', not 'how many days long is this interval?'
   * @param unit - the unit of time to count.
   * @param opts - options
   * @param opts.useLocaleWeeks - If true, use weeks based on the locale, i.e. use the locale-dependent start of the week; this operation will always use the locale of the start DateTime
   */
  count(unit: DurationUnits = "milliseconds", opts?: StartOfOptions): number {
    if (!this.isValid) return NaN;
    const start = this.s.startOf(unit, opts);
    let end;
    if (opts?.useLocaleWeeks) {
      end = this.e.reconfigure({ locale: start.locale });
    } else {
      end = this.e;
    }
    end = end.startOf(unit, opts);
    return Math.floor(end.diff(start, unit).get(unit)) + (end.valueOf() !== this.e.valueOf() ? 1 : 0);
  }

  /**
   * Returns whether this Interval's start and end are both in the same unit of time
   * @param unit - the unit of time to check sameness on
   */
  hasSame(unit: DurationUnits): boolean {
    if (!this.isValid) return false;
    // For an empty interval, compare the endpoints directly so that endpoints
    // in different zones (with differing local unit values) are respected.
    return this.isEmpty() ? this.s.hasSame(this.e, unit) : this.e.minus(1).hasSame(this.s, unit);
  }

  /**
   * Return whether this Interval has the same start and end DateTimes.
   */
  isEmpty(): boolean {
    return this.s.valueOf() === this.e.valueOf();
  }

  /**
   * Return whether this Interval's start is after the specified DateTime.
   */
  isAfter(dateTime: DateTime): boolean {
    if (!this.isValid) return false;
    return this.s > dateTime;
  }

  /**
   * Return whether this Interval's end is before the specified DateTime.
   */
  isBefore(dateTime: DateTime): boolean {
    if (!this.isValid) return false;
    return this.e <= dateTime;
  }

  /**
   * Return whether this Interval contains the specified DateTime.
   */
  contains(dateTime: DateTime): boolean {
    if (!this.isValid) return false;
    return this.s <= dateTime && this.e > dateTime;
  }

  /**
   * "Sets" the start and/or end dates. Returns a newly-constructed Interval.
   * @param values - the values to set
   * @param values.start - the starting DateTime
   * @param values.end - the ending DateTime
   */
  set({ start, end }: { start?: DateTime; end?: DateTime } = {}): Interval {
    if (!this.isValid) return this;
    return Interval.fromDateTimes(start || this.s, end || this.e);
  }

  /**
   * Split this Interval at each of the specified DateTimes
   * @param dateTimes - the unit of time to count.
   */
  splitAt(...dateTimes: DateTimeLike[]): Interval[] {
    if (!this.isValid) return [];
    const sorted = dateTimes
        .map(friendlyDateTime)
        .filter((d) => this.contains(d))
        .sort((a, b) => a.toMillis() - b.toMillis()),
      results = [];
    let { s } = this,
      i = 0;

    while (s < this.e) {
      const added = sorted[i] || this.e,
        next = +added > +this.e ? this.e : added;
      results.push(Interval.fromDateTimes(s, next));
      s = next;
      i += 1;
    }

    return results;
  }

  /**
   * Split this Interval into smaller Intervals, each of the specified length.
   * Left over time is grouped into a smaller interval
   * @param duration - The length of each resulting interval.
   */
  splitBy(duration: DurationLike): Interval[] {
    const dur = Duration.fromDurationLike(duration);

    if (!this.isValid || !dur.isValid || dur.as("milliseconds") === 0) {
      return [];
    }

    let { s } = this,
      idx = 1,
      next;

    const results = [];
    while (s < this.e) {
      const added = this.s.plus(dur.mapUnits((x) => x * idx));
      next = +added > +this.e ? this.e : added;
      results.push(Interval.fromDateTimes(s, next));
      s = next;
      idx += 1;
    }

    return results;
  }

  /**
   * Split this Interval into the specified number of smaller intervals.
   * @param numberOfParts - The number of Intervals to divide the Interval into.
   */
  divideEqually(numberOfParts: number): Interval[] {
    if (!this.isValid) return [];
    return this.splitBy(this.length() / numberOfParts).slice(0, numberOfParts);
  }

  /**
   * Return whether this Interval overlaps with the specified Interval
   */
  overlaps(other: Interval): boolean {
    return this.e > other.s && this.s < other.e;
  }

  /**
   * Return whether this Interval's end is adjacent to the specified Interval's start.
   */
  abutsStart(other: Interval): boolean {
    if (!this.isValid) return false;
    return +this.e === +other.s;
  }

  /**
   * Return whether this Interval's start is adjacent to the specified Interval's end.
   */
  abutsEnd(other: Interval): boolean {
    if (!this.isValid) return false;
    return +other.e === +this.s;
  }

  /**
   * Returns true if this Interval fully contains the specified Interval, specifically if the intersect (of this Interval and the other Interval) is equal to the other Interval; false otherwise.
   */
  engulfs(other: Interval): boolean {
    if (!this.isValid) return false;
    return this.s <= other.s && this.e >= other.e;
  }

  /**
   * Return whether this Interval has the same start and end as the specified Interval.
   */
  equals(other: Interval): boolean {
    if (!this.isValid || !other.isValid) {
      return false;
    }

    return this.s.equals(other.s) && this.e.equals(other.e);
  }

  /**
   * Return an Interval representing the intersection of this Interval and the specified Interval.
   * Specifically, the resulting Interval has the maximum start time and the minimum end time of the two Intervals.
   * Returns null if the intersection is empty, meaning, the intervals don't intersect.
   */
  intersection(other: Interval): Interval | null {
    if (!this.isValid) return this;
    const s = this.s > other.s ? this.s : other.s,
      e = this.e < other.e ? this.e : other.e;

    if (s >= e) {
      return null;
    } else {
      return Interval.fromDateTimes(s, e);
    }
  }

  /**
   * Return an Interval representing the union of this Interval and the specified Interval.
   * Specifically, the resulting Interval has the minimum start time and the maximum end time of the two Intervals.
   */
  union(other: Interval): Interval {
    if (!this.isValid) return this;
    const s = this.s < other.s ? this.s : other.s,
      e = this.e > other.e ? this.e : other.e;
    return Interval.fromDateTimes(s, e);
  }

  /**
   * Merge an array of Intervals into an equivalent minimal set of Intervals.
   * Combines overlapping and adjacent Intervals.
   * The resulting array will contain the Intervals in ascending order, that is, starting with the earliest Interval
   * and ending with the latest.
   */
  static merge(intervals: Interval[]): Interval[] {
    const [found, final] = intervals
      .sort((a, b) => +a.s - +b.s)
      .reduce<[Interval[], Interval | null]>(
        ([sofar, current], item) => {
          if (!current) {
            return [sofar, item];
          } else if (current.overlaps(item) || current.abutsStart(item)) {
            return [sofar, current.union(item)];
          } else {
            return [sofar.concat([current]), item];
          }
        },
        [[], null]
      );
    if (final) {
      found.push(final);
    }
    return found;
  }

  /**
   * Return an array of Intervals representing the spans of time that only appear in one of the specified Intervals.
   */
  static xor(intervals: Interval[]): Interval[] {
    let start: DateTime | null = null,
      currentCount = 0;
    const results: Interval[] = [],
      ends = intervals.map((i) => [
        { time: i.s, type: "s" },
        { time: i.e, type: "e" },
      ]),
      flattened = Array.prototype.concat(...ends) as { time: DateTime; type: string }[],
      arr = flattened.sort((a, b) => +a.time - +b.time);

    for (const i of arr) {
      currentCount += i.type === "s" ? 1 : -1;

      if (currentCount === 1) {
        start = i.time;
      } else {
        if (start && +start !== +i.time) {
          results.push(Interval.fromDateTimes(start, i.time));
        }

        start = null;
      }
    }

    return Interval.merge(results);
  }

  /**
   * Return an Interval representing the span of time in this Interval that doesn't overlap with any of the specified Intervals.
   */
  difference(...intervals: Interval[]): Interval[] {
    return Interval.xor([this as Interval].concat(intervals))
      .map((i) => this.intersection(i))
      .filter((i) => i && !i.isEmpty()) as Interval[];
  }

  /**
   * Returns a string representation of this Interval appropriate for debugging.
   */
  toString(): string {
    if (!this.isValid) return INVALID;
    return `[${this.s.toISO()} – ${this.e.toISO()})`;
  }

  /**
   * Returns a string representation of this Interval appropriate for the REPL.
   */
  [INSPECT](): string {
    if (this.isValid) {
      return `Interval { start: ${this.s.toISO()}, end: ${this.e.toISO()} }`;
    } else {
      return `Interval { Invalid, reason: ${this.invalidReason} }`;
    }
  }

  /**
   * Returns a localized string representing this Interval. Accepts the same options as the
   * Intl.DateTimeFormat constructor and any presets defined by momentum, such as
   * {@link DateTime.DATE_FULL} or {@link DateTime.TIME_SIMPLE}. The exact behavior of this method
   * is browser-specific, but in general it will return an appropriate representation of the
   * Interval in the assigned locale. Defaults to the system's locale if no locale has been
   * specified.
   *
   * Requires support for Intl.DateTimeFormat.prototype.formatRange().
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DateTimeFormat
   * @param formatOpts - Either a DateTime preset or Intl.DateTimeFormat constructor options.
   * @param opts - Options to override the configuration of the start DateTime.
   * @example Interval.fromISO('2022-11-07T09:00Z/2022-11-08T09:00Z').toLocaleString(); //=> 11/7/2022 – 11/8/2022
   * @example Interval.fromISO('2022-11-07T09:00Z/2022-11-08T09:00Z').toLocaleString(DateTime.DATE_FULL); //=> November 7 – 8, 2022
   * @example Interval.fromISO('2022-11-07T09:00Z/2022-11-08T09:00Z').toLocaleString(DateTime.DATE_FULL, { locale: 'fr-FR' }); //=> 7–8 novembre 2022
   * @example Interval.fromISO('2022-11-07T17:00Z/2022-11-07T19:00Z').toLocaleString(DateTime.TIME_SIMPLE); //=> 6:00 – 8:00 PM
   * @example Interval.fromISO('2022-11-07T17:00Z/2022-11-07T19:00Z').toLocaleString({ weekday: 'short', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); //=> Mon, Nov 07, 6:00 – 8:00 p
   */
  toLocaleString(
    formatOpts: Intl.DateTimeFormatOptions = Formats.DATE_SHORT,
    opts: LocaleOptions = {}
  ): string {
    return this.isValid
      ? Formatter.create(this.s.loc.clone(opts), formatOpts).formatInterval(this)
      : INVALID;
  }

  /**
   * Returns an ISO 8601-compliant string representation of this Interval.
   * @see https://en.wikipedia.org/wiki/ISO_8601#Time_intervals
   * @param opts - The same options as {@link DateTime#toISO}
   */
  toISO(opts?: ToISOTimeOptions): string {
    if (!this.isValid) return INVALID;
    return `${this.s.toISO(opts)}/${this.e.toISO(opts)}`;
  }

  /**
   * Returns an ISO 8601-compliant string representation of date of this Interval.
   * The time components are ignored.
   * @see https://en.wikipedia.org/wiki/ISO_8601#Time_intervals
   */
  toISODate(): string {
    if (!this.isValid) return INVALID;
    return `${this.s.toISODate()}/${this.e.toISODate()}`;
  }

  /**
   * Returns an ISO 8601-compliant string representation of time of this Interval.
   * The date components are ignored.
   * @see https://en.wikipedia.org/wiki/ISO_8601#Time_intervals
   * @param opts - The same options as {@link DateTime#toISO}
   */
  toISOTime(opts?: ToISOTimeOptions): string {
    if (!this.isValid) return INVALID;
    return `${this.s.toISOTime(opts)}/${this.e.toISOTime(opts)}`;
  }

  /**
   * Returns a string representation of this Interval formatted according to the specified format
   * string. **You may not want this.** See {@link Interval#toLocaleString} for a more flexible
   * formatting tool.
   * @param dateFormat - The format string. This string formats the start and end time.
   * See {@link DateTime#toFormat} for details.
   * @param opts - Options.
   * @param opts.separator - A separator to place between the start and end
   * representations.
   */
  toFormat(dateFormat: string, { separator = " – " }: { separator?: string } = {}): string {
    if (!this.isValid) return INVALID;
    return `${this.s.toFormat(dateFormat)}${separator}${this.e.toFormat(dateFormat)}`;
  }

  /**
   * Return a Duration representing the time spanned by this interval.
   * @param unit - the unit or units (such as 'hours' or 'days') to include in the duration.
   * @param opts - options that affect the creation of the Duration
   * @param opts.conversionAccuracy - the conversion system to use
   * @example Interval.fromDateTimes(dt1, dt2).toDuration().toObject() //=> { milliseconds: 88489257 }
   * @example Interval.fromDateTimes(dt1, dt2).toDuration('days').toObject() //=> { days: 1.0241812152777778 }
   * @example Interval.fromDateTimes(dt1, dt2).toDuration(['hours', 'minutes']).toObject() //=> { hours: 24, minutes: 34.82095 }
   * @example Interval.fromDateTimes(dt1, dt2).toDuration(['hours', 'minutes', 'seconds']).toObject() //=> { hours: 24, minutes: 34, seconds: 49.257 }
   * @example Interval.fromDateTimes(dt1, dt2).toDuration('seconds').toObject() //=> { seconds: 88489.257 }
   */
  toDuration(unit?: DurationUnits | DurationUnits[], opts?: DiffOptions): Duration {
    if (!this.isValid) {
      return Duration.invalid(this.invalidReason as string);
    }
    return this.e.diff(this.s, unit, opts);
  }

  /**
   * Run mapFn on the interval start and end, returning a new Interval from the resulting DateTimes
   * @example Interval.fromDateTimes(dt1, dt2).mapEndpoints(endpoint => endpoint.toUTC())
   * @example Interval.fromDateTimes(dt1, dt2).mapEndpoints(endpoint => endpoint.plus({ hours: 2 }))
   */
  mapEndpoints(mapFn: (dt: DateTime) => DateTime): Interval {
    return Interval.fromDateTimes(mapFn(this.s), mapFn(this.e));
  }
}
