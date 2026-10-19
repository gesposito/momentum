/*
  Every access to the Temporal API goes through this module. It resolves `globalThis.Temporal`
  lazily, so importing momentum never touches globals and a polyfill may be installed before the
  first call (see `@momentum-js/luxon/polyfill`).

  Temporal is the authority for the calendar and for everything that depends on the time zone
  database. A DateTime reads its calendar fields and UTC offset from the Temporal.ZonedDateTime of
  its instant in its zone, turns wall-clock times into instants with PlainDateTime#toZonedDateTime
  (resolveWallClock) and takes calendar arithmetic and week data from Temporal.PlainDate.
  Zone#offset() (IANAZone, SystemZone) is answered from transition windows cached here.
*/

import type { Temporal as TemporalNamespace } from "temporal-spec";
import { TemporalUnavailableError } from "../errors.js";
import type { GregorianDateTime } from "../types.js";

export type TemporalApi = typeof TemporalNamespace;
export type Instant = TemporalNamespace.Instant;
export type ZonedDateTime = TemporalNamespace.ZonedDateTime;
export type PlainDate = TemporalNamespace.PlainDate;
export type PlainDateTime = TemporalNamespace.PlainDateTime;
export type PlainTime = TemporalNamespace.PlainTime;

/**
 * Largest magnitude of epoch milliseconds representable by `Temporal.Instant` (and by `Date`).
 */
export const MAX_EPOCH_MS = 8.64e15;

const NANOS_PER_MINUTE = 60_000_000_000;

/**
 * Returns the Temporal namespace object, throwing a descriptive error if the runtime lacks it.
 */
export function temporal(): TemporalApi {
  const api = (globalThis as { Temporal?: TemporalApi }).Temporal;
  if (api === undefined) {
    throw new TemporalUnavailableError();
  }
  return api;
}

/**
 * Whether Temporal is available in this runtime (natively or through a polyfill).
 */
export function hasTemporal(): boolean {
  return (globalThis as { Temporal?: unknown }).Temporal !== undefined;
}

/**
 * Temporal reports values it cannot represent (out of range, unknown identifiers) with
 * RangeErrors. Any other error is a genuine failure and must not be mistaken for invalid input.
 */
export function isRangeError(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    (typeof error === "object" && error !== null && (error as Error).name === "RangeError")
  );
}

export function isRepresentableTs(ts: number): boolean {
  return Number.isFinite(ts) && Math.abs(ts) <= MAX_EPOCH_MS;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Identifier of the Temporal time zone with a fixed UTC offset in minutes, e.g. `-240` ->
 * `"-04:00"`, or null when Temporal has none: offset time zones are whole minutes under a day.
 */
export function offsetTimeZoneId(minutes: number): string | null {
  if (!Number.isInteger(minutes) || Math.abs(minutes) >= 1440) return null;
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * Zoned view of an epoch millisecond timestamp (fractions are truncated). Throws a RangeError for
 * timestamps outside the representable range or for unknown time zone identifiers. Reading the
 * fields of a ZonedDateTime built with the constructor is about a quarter cheaper on Bun and on
 * temporal-polyfill than through Instant#toZonedDateTimeISO(), and the constructor only accepts
 * time zone identifiers, not ISO strings that carry one.
 */
export function zonedDateTime(ts: number, timeZone: string): ZonedDateTime {
  return new (temporal().ZonedDateTime)(BigInt(Math.trunc(ts)) * 1_000_000n, timeZone);
}

export function offsetMinutes(zdt: ZonedDateTime): number {
  return zdt.offsetNanoseconds / NANOS_PER_MINUTE;
}

// Native engines recompute the wall clock in every ZonedDateTime getter (about 200 ns each on
// JavaScriptCore), so the fields are cheaper to read from one PlainDateTime there, whose getters
// are plain field reads. temporal-polyfill caches the wall clock of a ZonedDateTime but builds
// PlainDateTimes slowly, so it is read directly. Decided once per Temporal implementation.
// Upstream: the getter cost in V8 (https://issues.chromium.org/issues/575359795) and
// JavaScriptCore (https://bugs.webkit.org/show_bug.cgi?id=328057); the polyfill's PlainDateTime
// cost is mostly a debug string it attaches to every object
// (https://github.com/fullcalendar/temporal-polyfill/issues/116); see docs/upstream.md.
let inspectedApi: TemporalApi | null = null;
let readThroughPlainDateTime = true;

function isNativeCode(fn: unknown): boolean {
  try {
    return Function.prototype.toString.call(fn).includes("[native code]");
  } catch {
    return true;
  }
}

/**
 * Calendar fields of the wall clock of a ZonedDateTime.
 */
export function wallClock(zdt: ZonedDateTime): GregorianDateTime {
  const api = temporal();
  if (api !== inspectedApi) {
    inspectedApi = api;
    readThroughPlainDateTime = isNativeCode(api.ZonedDateTime);
  }
  const p = readThroughPlainDateTime ? zdt.toPlainDateTime() : zdt;
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    millisecond: p.millisecond,
  };
}

/**
 * Calendar fields of an epoch millisecond timestamp seen at a fixed UTC offset in minutes. Offsets
 * that have no Temporal offset time zone (seconds, or a day and more, which custom zones may
 * report) shift the instant and read it in UTC instead. Throws a RangeError when the result is not
 * representable.
 */
export function wallClockAtOffset(ts: number, minutes: number): GregorianDateTime {
  const id = offsetTimeZoneId(minutes);
  return wallClock(
    id === null
      ? zonedDateTime(Math.trunc(ts) + Math.round(minutes * 60000), "UTC")
      : zonedDateTime(ts, id)
  );
}

/**
 * ISO calendar date. Throws a RangeError for dates that do not exist or lie outside Temporal's
 * range.
 */
export function plainDate(year: number, month: number, day: number): PlainDate {
  return new (temporal().PlainDate)(year, month, day);
}

// WALL-CLOCK RESOLUTION

export interface ResolvedWallClock {
  /** epoch milliseconds of the resolved instant */
  ts: number;
  /** its UTC offset in minutes */
  o: number;
  /** its wall clock, which differs from the requested one when that one was skipped */
  fields: GregorianDateTime;
  /** whether the requested wall clock fell into a gap and was moved forward */
  wasHole: boolean;
}

/**
 * The instant of a wall-clock time in a Temporal time zone, resolved the way Luxon does it:
 *
 * - an ambiguous time (the clocks went back) takes `offsetGuess`, in minutes, when that is one of
 *   its two offsets, and the earlier instant otherwise;
 * - a skipped time (the clocks went forward) moves forward by the length of the gap and is
 *   reported as a hole;
 * - fields out of range roll over into the next unit the way `Date.UTC()` does (day 31 of
 *   February is early March, hour 24 the next midnight, month 13 the next January, a negative
 *   minute the previous hour) and fractions are truncated.
 *
 * Throws a RangeError when the result is not representable.
 */
export function resolveWallClock(
  fields: GregorianDateTime,
  timeZone: string,
  offsetGuess?: number
): ResolvedWallClock {
  let requested: GregorianDateTime = {
      year: Math.trunc(fields.year),
      month: Math.trunc(fields.month),
      day: Math.trunc(fields.day),
      hour: Math.trunc(fields.hour),
      minute: Math.trunc(fields.minute),
      second: Math.trunc(fields.second),
      millisecond: Math.trunc(fields.millisecond),
    },
    pdt: PlainDateTime;
  try {
    pdt = plainDateTime(requested);
  } catch (e) {
    if (!isRangeError(e)) throw e;
    requested = rollOver(requested);
    pdt = plainDateTime(requested);
  }
  // "compatible" disambiguation: the earlier instant of an ambiguous time, and a skipped time
  // moved forward by the length of the gap
  const zdt = pdt.toZonedDateTime(timeZone),
    ts = zdt.epochMilliseconds,
    o = offsetMinutes(zdt);
  // The later instant of an ambiguous time has the smaller offset, so only a smaller guess can
  // pick it, and it does when the zone really has that offset at the instant the guess implies.
  // That is what ZonedDateTime.from's offset: "prefer" decides; asking the zone's cached offsets
  // (offsetAt) first keeps a guess taken in another season cheap. The cache only shortlists the
  // candidate: a conversion with "later" disambiguation confirms it, so that a wrong cached
  // window (temporal-polyfill misses a few historical transitions,
  // https://github.com/fullcalendar/temporal-polyfill/pull/114) can never pick an instant.
  if (offsetGuess !== undefined && offsetGuess < o) {
    const later = ts + Math.round((o - offsetGuess) * 60) * 1000;
    // an instant beyond the end of Temporal's range is no candidate
    if (
      isRepresentableTs(later) &&
      offsetAt(timeZone, later) === offsetGuess &&
      pdt.toZonedDateTime(timeZone, { disambiguation: "later" }).epochMilliseconds === later
    ) {
      return { ts: later, o: offsetGuess, fields: requested, wasHole: false };
    }
  }
  const resolved = wallClock(zdt);
  return { ts, o, fields: resolved, wasHole: !sameWallClock(resolved, requested) };
}

/**
 * ISO calendar date and time. Throws a RangeError for wall clocks that do not exist or lie outside
 * Temporal's range.
 */
export function plainDateTime(f: GregorianDateTime): PlainDateTime {
  return new (temporal().PlainDateTime)(
    f.year,
    f.month,
    f.day,
    f.hour,
    f.minute,
    f.second,
    f.millisecond
  );
}

/**
 * Epoch milliseconds of wall-clock fields read as UTC, the "local timestamp" of Luxon's offset
 * arithmetic, with out-of-range fields rolled over (see resolveWallClock). Throws a RangeError
 * when the result is not representable.
 */
export function utcMillis(fields: GregorianDateTime): number {
  return resolveWallClock(fields, "UTC").ts;
}

// The Gregorian calendar repeats every 400 years: 4800 months, 146097 days
const CYCLE_MONTHS = 4800,
  CYCLE_DAYS = 146097,
  CYCLE_MS = CYCLE_DAYS * 86400000;

// integer fields with out-of-range values carried into the larger units (see resolveWallClock)
function rollOver(f: GregorianDateTime): GregorianDateTime {
  // Whole 400-year cycles are taken out of the months, the days and the time of day and added to
  // the year, and the rest is carried near the year 2000, so that every intermediate date is
  // representable wherever the year and the result lie in Temporal's range. Temporal.Duration
  // rejects mixed signs, so the months, the days and the time of day are added one at a time.
  const ms = f.hour * 3600000 + f.minute * 60000 + f.second * 1000 + f.millisecond,
    monthCycles = Math.floor((f.month - 1) / CYCLE_MONTHS),
    dayCycles = Math.floor((f.day - 1) / CYCLE_DAYS),
    msCycles = Math.floor(ms / CYCLE_MS),
    year = f.year + (monthCycles + dayCycles + msCycles) * 400,
    shift = Math.round((year - 2000) / 400) * 400,
    p = plainDate(year - shift, 1, 1)
      .add({ months: f.month - 1 - monthCycles * CYCLE_MONTHS })
      .add({ days: f.day - 1 - dayCycles * CYCLE_DAYS })
      .toPlainDateTime()
      .add({ milliseconds: ms - msCycles * CYCLE_MS });
  return {
    year: p.year + shift,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    millisecond: p.millisecond,
  };
}

function sameWallClock(a: GregorianDateTime, b: GregorianDateTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second &&
    a.millisecond === b.millisecond
  );
}

// OFFSETS

// A zone's offset is constant between two transitions. Looking a transition window up once and
// remembering it makes repeated offset queries for nearby instants (the common case) free of
// Temporal calls. A handful of windows is kept per zone, most recently used first.
interface OffsetWindow {
  start: number;
  end: number;
  offset: number;
}

const WINDOWS_PER_ZONE = 8;
const offsetWindows = /* @__PURE__ */ new Map<string, OffsetWindow[]>();

/**
 * Forget cached offset windows. Should only be necessary in testing scenarios.
 */
export function resetOffsetCache(): void {
  offsetWindows.clear();
}

// longer than the gap between consecutive transitions in any zone that has them
const LOOKBACK_MS = 366 * 86400000;

function transitionWindow(timeZone: string, exact: number): OffsetWindow {
  const zdt = zonedDateTime(exact, timeZone),
    offset = offsetMinutes(zdt);

  if (typeof zdt.getTimeZoneTransition !== "function") {
    // no transition data: remember this one instant only
    return { start: exact, end: exact + 1, offset };
  }

  // the first transition at or after `exact`: look from a millisecond earlier so that a
  // transition exactly at `exact` is found
  const upcoming = (
    exact > -MAX_EPOCH_MS ? zdt.subtract({ milliseconds: 1 }) : zdt
  ).getTimeZoneTransition("next");

  let start: number, end: number;
  if (upcoming !== null && upcoming.epochMilliseconds === exact) {
    const following = zdt.getTimeZoneTransition("next");
    start = exact;
    end = following ? following.epochMilliseconds : Infinity;
  } else {
    end = upcoming ? upcoming.epochMilliseconds : Infinity;
    // the last transition before `exact`, found by walking forward from a year earlier:
    // temporal-polyfill answers getTimeZoneTransition("previous") incorrectly beyond its rule
    // horizon (https://github.com/fullcalendar/temporal-polyfill/pull/113)
    start = Math.max(exact - LOOKBACK_MS, -MAX_EPOCH_MS);
    let transition = zonedDateTime(start, timeZone).getTimeZoneTransition("next");
    while (transition !== null && transition.epochMilliseconds < exact) {
      start = transition.epochMilliseconds;
      transition = transition.getTimeZoneTransition("next");
    }
  }

  // temporal-polyfill's "next" also misses a few historical transitions (Asia/Manila's move
  // across the date line on 1844-12-31, for one:
  // https://github.com/fullcalendar/temporal-polyfill/pull/114), so the offset is confirmed at
  // both ends of the window; where it differs, only the queried instant is remembered
  if (
    offsetMinutes(zonedDateTime(start, timeZone)) !== offset ||
    (end !== Infinity && offsetMinutes(zonedDateTime(end - 1, timeZone)) !== offset)
  ) {
    return { start: exact, end: exact + 1, offset };
  }
  return { start, end, offset };
}

/**
 * UTC offset in minutes of a Temporal time zone at an epoch millisecond timestamp. Throws a
 * RangeError for unknown identifiers or timestamps outside the representable range.
 */
export function offsetAt(timeZone: string, ts: number): number {
  // like Date, a fractional timestamp stands for the millisecond it truncates to
  const exact = Math.trunc(ts);
  let windows = offsetWindows.get(timeZone);
  if (windows !== undefined) {
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      if (exact >= w.start && exact < w.end) {
        if (i > 0) {
          windows.splice(i, 1);
          windows.unshift(w);
        }
        return w.offset;
      }
    }
  } else {
    windows = [];
    offsetWindows.set(timeZone, windows);
  }

  const w = transitionWindow(timeZone, exact);
  windows.unshift(w);
  if (windows.length > WINDOWS_PER_ZONE) windows.pop();
  return w.offset;
}

// IDENTIFIERS

/**
 * Case-normalized identifier of a Temporal time zone, or null when the identifier is unknown.
 * Link names are preserved ("Asia/Calcutta" stays "Asia/Calcutta").
 */
export function normalizeTimeZoneId(id: string): string | null {
  try {
    // the constructor accepts time zone identifiers only; Instant#toZonedDateTimeISO would also
    // read a zone out of ISO strings such as "2020-01-01T00:00[Europe/Rome]", which Luxon rejects
    return new (temporal().ZonedDateTime)(0n, id).timeZoneId;
  } catch (e) {
    if (!isRangeError(e)) throw e;
    return null;
  }
}

/**
 * The identifier of the system time zone, as reported by `Temporal.Now`.
 */
export function systemTimeZoneId(): string {
  return temporal().Now.timeZoneId();
}
