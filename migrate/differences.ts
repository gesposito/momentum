// The ways a native Temporal replacement can behave differently from momentum or Day.js. A
// rewrite that carries any of these is applied only when the user accepts them (`--accept`); each
// one was observed by comparing the library with Temporal, see test/momentum/migrateRules.test.js
// and test/momentum/migrateDayjs.test.js.

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
  "dayjs-zones": {
    summary: "Day.js values in a time zone keep a fixed UTC offset through arithmetic",
    detail:
      "With the timezone plugin, dayjs.tz(...) and .tz(zone) give a value with the zone's offset at " +
      "that instant, and add, subtract and the setters keep it while computing in the system zone, " +
      "so a day added across another zone's DST change lands an hour off (Europe/London on " +
      "2026-03-28 12:00 plus a day is 13:00 BST). Temporal follows the zone's rules. Applies to " +
      "projects that use the timezone plugin or utcOffset(n).",
  },
  "dayjs-tz": {
    summary:
      "Day.js's timezone plugin is exact only from 1970 to 9999, away from the system zone's DST changes",
    detail:
      "The plugin converts through the system zone and Date parsing: before 1970 a fraction of a " +
      "second or an offset with seconds moves the instant (dayjs(-123046875001).tz('America/New_York') " +
      "is a second late), near a DST change of the system zone the wall-clock fields can be an hour " +
      "off (Australia/Lord_Howe on 1999-10-31 02:00 reads 01:30 in New York), and past the year 9999 " +
      "the conversion fails. Temporal converts exactly.",
  },
  "dayjs-tz-parse": {
    summary: "dayjs.tz reads a repeated wall-clock time by the zone's current offset",
    detail:
      "dayjs.tz('2026-11-01 01:30', 'America/New_York') is 01:30 EDT when the code runs in summer " +
      "and 01:30 EST in winter; Temporal always takes the earlier instant. Skipped times move forward " +
      "in both.",
  },
  "dayjs-dst-steps": {
    summary: "around DST changes, Day.js's month and year arithmetic can move the time by an hour",
    detail:
      "Day.js changes the month or year through the first of the month, so a time skipped on that " +
      "day stays shifted (1989-03-10 02:47 plus 13 months is 03:47 in New York, not 02:47), and it " +
      "re-reads the wall clock, so the second of two repeated times becomes the first, even when " +
      "adding 0. Temporal keeps the wall-clock time.",
  },
  "dayjs-offsets": {
    summary: "Day.js rounds UTC offsets to 15 minutes",
    detail:
      "utcOffset() and the Z token of format() round the offset to a multiple of 15 minutes, which " +
      "changes historical local mean time offsets such as New York's -4:56:02 before 1883; Temporal " +
      "reports the exact offset.",
  },
  "dayjs-years": {
    summary: "years before 100 or after 9999 differ",
    detail:
      "Day.js's startOf and endOf of years and months build dates with new Date(y, m, d), which " +
      "reads the years 0 to 99 as 1900 to 1999 (the start of the year 99 is 1999-01-01), and " +
      "format pads YYYY to four digits (10000-01-01, and 00-5 for the year -5) where Temporal " +
      "writes ISO 8601's extended years (+010000-01-01, -000005-01-01).",
  },
  "dayjs-plugins": {
    summary: "a Day.js plugin that patches the rewritten method stops applying",
    detail:
      "devHelper's warnings (diff() without a date, a timestamp passed as a string) disappear with " +
      "the calls they watch, and a plugin the tool does not know, passed to dayjs.extend, may change " +
      "any method: check what it patches before accepting this.",
  },
  "dayjs-utc-mode": {
    summary: "isUTC is true for any value in the UTC zone",
    detail:
      "Day.js tells dayjs.utc() values from local ones; Temporal only knows the zone, so a local " +
      "value is in UTC when the system zone is UTC.",
  },
} as const satisfies Record<string, Difference>;

export type DifferenceId = keyof typeof differences;

export const differenceIds = Object.keys(differences) as DifferenceId[];
