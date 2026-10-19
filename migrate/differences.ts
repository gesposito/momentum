// The ways a native Temporal replacement can behave differently from momentum. A rewrite that
// carries any of these is applied only when the user accepts them (`--accept`); each one was
// observed by comparing momentum with Temporal, see test/momentum/migrateRules.test.js.

export interface Difference {
  /** One line: what changes. */
  summary: string;
  /** When it shows up, with an example. */
  detail: string;
}

export const differences = {
  "repeated-wall-time": {
    summary:
      "calendar arithmetic that lands on a repeated wall-clock time picks the earlier instant",
    detail:
      "momentum keeps the original offset when a result such as 01:30 on a fall-back night occurs " +
      "twice; Temporal's add, subtract and from take the earlier instant. Example: 2017-11-06T01:30-05:00 " +
      "in America/New_York minus one day is 01:30-05:00 in momentum and 01:30-04:00 in Temporal.",
  },
  "repeated-midnight": {
    summary: "the start of a day whose midnight occurs twice is the earlier one",
    detail:
      "In zones that fall back at midnight (America/Havana), momentum's startOf/endOf keep the " +
      "current offset and can pick the second midnight; Temporal's startOfDay picks the first.",
  },
  overflow: {
    summary: "out-of-range fields are clamped instead of rolled over",
    detail:
      "momentum, like Luxon and Date.UTC, rolls day 31 of April over to May 1; Temporal's with and " +
      'from clamp it to April 30 (overflow: "constrain").',
  },
  "invalid-throws": {
    summary: "invalid input throws a RangeError instead of returning an invalid DateTime",
    detail:
      "momentum returns an invalid object (isValid false, getters null) for unparsable strings, " +
      "NaN, fractional milliseconds or unknown zones; Temporal throws. Code that checks isValid " +
      "needs a try/catch instead.",
  },
  "fractional-amounts": {
    summary: "fractional amounts and mixed signs throw",
    detail:
      "momentum accepts plus({ hours: 1.5 }) and plus({ months: 1, days: -1 }); Temporal durations " +
      "take integers of a single sign.",
  },
  "zone-specifiers": {
    summary: "only IANA names and ±HH:MM offsets are accepted as zones",
    detail:
      'momentum also accepts "local", "system", "UTC+3" and Zone objects; Temporal throws for them.',
  },
  "fixed-offset-names": {
    summary: 'fixed offsets are named "+03:00" rather than "UTC+3"',
    detail:
      "zoneName and formatted time zone names of fixed-offset zones differ; IANA zones and UTC " +
      "are identical.",
  },
  "iso-format": {
    summary: "ISO strings write UTC as +00:00 and round historical sub-minute offsets",
    detail:
      'momentum\'s toISO writes "Z" for UTC and truncates local-mean-time offsets ("-08:59"); ' +
      'Temporal writes "+00:00" and rounds ("-09:00").',
  },
  "iso-grammar": {
    summary: "only full date-times with an offset are parsed",
    detail:
      "momentum's fromISO also reads week dates, ordinal dates, reduced precision and strings " +
      "without an offset (as local time); Temporal.Instant.from needs a date, a time and an offset.",
  },
  "json-format": {
    summary: "JSON.stringify writes Temporal's string, with the time zone annotation",
    detail:
      'A DateTime serializes as "2017-05-15T09:24:15.123-04:00"; a ZonedDateTime as ' +
      '"2017-05-15T09:24:15.123-04:00[America/New_York]", and digits after the second only when needed.',
  },
  "inspect-output": {
    summary: "console output shows Temporal's representation",
    detail:
      "Logged values print as Temporal objects instead of momentum's DateTime { ts, zone, loc }.",
  },
  "julian-dates": {
    summary: "on V8 before 14.8, dates before 15 October 1582 are formatted in the Julian calendar",
    detail:
      "Node 26 (V8 14.6) and Chrome before 148 format Temporal objects with ICU's hybrid " +
      "calendar, so 1500-03-31 prints as March 21, 1500, while momentum (through Date), V8 " +
      "since 14.8 and JavaScriptCore use the proleptic Gregorian calendar. An engine bug, " +
      "tracked in docs/upstream.md.",
  },
  "link-name-equality": {
    summary: "equals treats link names as the same zone",
    detail:
      "momentum compares zone names, so Asia/Calcutta and Asia/Kolkata differ; Temporal compares " +
      "the zones they designate.",
  },
  "negative-duration-iso": {
    summary: "negative durations are written -PT2H instead of PT-2H",
    detail:
      "momentum writes the sign of each component; Temporal writes one sign for the duration.",
  },
  "duration-calendar-units": {
    summary: "durations with years, months or weeks need a reference date to be totalled",
    detail:
      "momentum converts with fixed factors (a month is 30 days); Temporal's total throws without " +
      "relativeTo when a duration has years, months or weeks.",
  },
} as const satisfies Record<string, Difference>;

export type DifferenceId = keyof typeof differences;

export const differenceIds = Object.keys(differences) as DifferenceId[];
