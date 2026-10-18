/*
  Every access to the Temporal API goes through this module. It resolves `globalThis.Temporal`
  lazily, so importing momentum never touches globals and a polyfill may be installed before the
  first call.

  Temporal is the authority for everything that depends on the time zone database: UTC offsets,
  the transitions between them and the set of valid zone identifiers.
*/

import { TemporalUnavailableError } from "../errors.js";

/**
 * Largest magnitude of epoch milliseconds representable by `Temporal.Instant` (and by `Date`).
 */
export const MAX_EPOCH_MS = 8.64e15;

const NANOS_PER_MINUTE = 60000000000;

/**
 * Returns the Temporal namespace object, throwing a descriptive error if the runtime lacks it.
 */
export function temporal() {
  const api = globalThis.Temporal;
  if (api === undefined) {
    throw new TemporalUnavailableError();
  }
  return api;
}

/**
 * Whether Temporal is available in this runtime (natively or through a polyfill).
 */
export function hasTemporal() {
  return globalThis.Temporal !== undefined;
}

/**
 * Temporal reports values it cannot represent (out of range, unknown identifiers) with
 * RangeErrors. Any other error is a genuine failure and must not be mistaken for invalid input.
 */
export function isRangeError(error) {
  return (
    error instanceof RangeError ||
    (typeof error === "object" && error !== null && error.name === "RangeError")
  );
}

export function isRepresentableTs(ts) {
  return Number.isFinite(ts) && Math.abs(ts) <= MAX_EPOCH_MS;
}

/**
 * Zoned view of an epoch millisecond timestamp. Throws a RangeError for timestamps outside the
 * representable range or for unknown time zone identifiers.
 */
export function zonedDateTime(ts, timeZone) {
  return temporal().Instant.fromEpochMilliseconds(Math.trunc(ts)).toZonedDateTimeISO(timeZone);
}

export function offsetMinutes(zdt) {
  return zdt.offsetNanoseconds / NANOS_PER_MINUTE;
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Identifier of the Temporal time zone with a fixed UTC offset in minutes, e.g. `-240` ->
 * `"-04:00"`, or null when Temporal has none: offset time zones are whole minutes under a day.
 */
export function offsetTimeZoneId(minutes) {
  if (!Number.isInteger(minutes) || Math.abs(minutes) >= 1440) return null;
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export function gregorianFields(dt) {
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

export function plainDate(year, month, day) {
  return temporal().PlainDate.from({ year, month, day });
}

// OFFSETS

// A zone's offset is constant between two transitions. Looking a transition window up once and
// remembering it makes repeated offset queries for nearby instants (the common case) free of
// Temporal calls. A handful of windows is kept per zone, most recently used first.
const WINDOWS_PER_ZONE = 8;
const offsetWindows = new Map();

/**
 * Forget cached offset windows. Should only be necessary in testing scenarios.
 */
export function resetOffsetCache() {
  offsetWindows.clear();
}

// longer than the gap between consecutive transitions in any zone that has them
const LOOKBACK_MS = 366 * 86400000;

function transitionWindow(timeZone, exact) {
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

  let start, end;
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
export function offsetAt(timeZone, ts) {
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

/**
 * Case-normalized identifier of a Temporal time zone, or null when the identifier is unknown.
 * Link names are preserved ("Asia/Calcutta" stays "Asia/Calcutta").
 */
export function normalizeTimeZoneId(id) {
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
export function systemTimeZoneId() {
  return temporal().Now.timeZoneId();
}
