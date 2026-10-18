/*
  Every access to the Temporal API goes through this module. It resolves `globalThis.Temporal`
  lazily, so importing momentum never touches globals and a polyfill may be installed before the
  first call (see `momentum/polyfill`).

  Temporal is the authority for everything that depends on the time zone database: UTC offsets,
  the transitions between them and the set of valid zone identifiers. Pure calendar arithmetic
  lives in ./calendar.ts.
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
 * Zoned view of an epoch millisecond timestamp. Throws a RangeError for timestamps outside the
 * representable range or for unknown time zone identifiers.
 */
export function zonedDateTime(ts: number, timeZone: string): ZonedDateTime {
  return temporal().Instant.fromEpochMilliseconds(Math.trunc(ts)).toZonedDateTimeISO(timeZone);
}

export function offsetMinutes(zdt: ZonedDateTime): number {
  return zdt.offsetNanoseconds / NANOS_PER_MINUTE;
}

export function gregorianFields(dt: ZonedDateTime | PlainDateTime): GregorianDateTime {
  return {
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
    second: dt.second,
    millisecond: dt.millisecond,
  };
}

export function plainDate(year: number, month: number, day: number): PlainDate {
  return temporal().PlainDate.from({ year, month, day });
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
    // horizon
    start = Math.max(exact - LOOKBACK_MS, -MAX_EPOCH_MS);
    let transition = zonedDateTime(start, timeZone).getTimeZoneTransition("next");
    while (transition !== null && transition.epochMilliseconds < exact) {
      start = transition.epochMilliseconds;
      transition = transition.getTimeZoneTransition("next");
    }
  }

  // temporal-polyfill's "next" also misses a few historical transitions (Asia/Manila's move
  // across the date line on 1844-12-31, for one), so the offset is confirmed at both ends of the
  // window; where it differs, only the queried instant is remembered
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
