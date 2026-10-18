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

/**
 * UTC offset in minutes of a Temporal time zone at an epoch millisecond timestamp. Throws a
 * RangeError for unknown identifiers or timestamps outside the representable range.
 */
export function offsetAt(timeZone, ts) {
  return offsetMinutes(zonedDateTime(ts, timeZone));
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
