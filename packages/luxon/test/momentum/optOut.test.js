/* global test expect describe */
import { DateTime, Duration, Settings } from "../../src/momentum";
import { anyInstant, fc, wallClockNearTransition } from "./fastCheck.js";

// Settings.temporalNative = false swaps the Temporal-native core for Luxon's algorithms
// (closed-form calendar arithmetic and Luxon's offset search), fed with the same Temporal
// offsets. The two must agree everywhere except where Luxon's search goes wrong far from its
// guess (test/parity/dstResolution.test.js).

function inMode(temporalNative, fn) {
  const previous = Settings.temporalNative;
  Settings.temporalNative = temporalNative;
  try {
    return fn();
  } finally {
    Settings.temporalNative = previous;
  }
}

function inBothModes(fn) {
  return [inMode(true, fn), inMode(false, fn)];
}

function describeDateTime(dt) {
  return dt.isValid
    ? [
        dt.toISO(),
        dt.offset,
        dt.wasHole,
        dt.weekYear,
        dt.weekNumber,
        dt.weekday,
        dt.localWeekNumber,
        dt.ordinal,
        dt.daysInMonth,
        dt.daysInYear,
        dt.isInLeapYear,
      ]
    : dt.invalidReason;
}

const zones = [
  "America/New_York",
  "Europe/Rome",
  "Europe/London",
  "Australia/Sydney",
  "Australia/Lord_Howe",
  "America/Sao_Paulo",
  "Pacific/Chatham",
  "Asia/Kolkata",
  "UTC",
  "UTC+5:30",
];

describe("Settings.temporalNative", () => {
  test("is on unless MOMENTUM_TEMPORAL_NATIVE=false opts the test run out", () => {
    expect(Settings.temporalNative).toBe(process.env.MOMENTUM_TEMPORAL_NATIVE !== "false");
    expect(inMode(false, () => Settings.temporalNative)).toBe(false);
    expect(inMode(true, () => Settings.temporalNative)).toBe(true);
  });

  test("leaves DateTimes created in the other mode intact", () => {
    const dt = inMode(true, () => DateTime.fromMillis(1494853954567, { zone: "Europe/Rome" }));
    expect(inMode(false, () => [dt.toISO(), dt.weekNumber, dt.ordinal])).toEqual([
      "2017-05-15T15:12:34.567+02:00",
      20,
      135,
    ]);
  });
});

describe("both cores", () => {
  test("give any instant the same fields in any zone", () => {
    const anyZone = fc.constantFrom(...zones, "Pacific/Apia", "Asia/Manila");
    fc.assert(
      fc.property(anyZone, anyInstant, (zone, ts) => {
        const create = () => describeDateTime(DateTime.fromMillis(ts, { zone })),
          [native, luxon] = inBothModes(create);
        expect(luxon).toEqual(native);
      })
    );
  });

  test("resolve wall clocks next to modern transitions alike", () => {
    // guessing from "now", as fromObject does; the zones' offsets around these transitions are
    // the ones they have today, so Luxon's search starts close to them
    const ianaZones = zones.filter((zone) => !zone.startsWith("UTC+"));
    const samples = fc.constantFrom(...ianaZones).chain((zone) =>
      fc.record({
        zone: fc.constant(zone),
        fields: wallClockNearTransition(zone, 1990, 2040),
        now: fc
          .integer({ min: Date.UTC(1990, 0, 1) / 86400000, max: Date.UTC(2040, 0, 1) / 86400000 })
          .map((days) => days * 86400000),
      })
    );
    fc.assert(
      fc.property(samples, ({ zone, fields, now }) => {
        const create = () => {
          const old = Settings.now;
          Settings.now = () => now;
          try {
            return describeDateTime(DateTime.fromObject(fields, { zone }));
          } finally {
            Settings.now = old;
          }
        };
        const [native, luxon] = inBothModes(create);
        expect(luxon).toEqual(native);
      })
    );
  });

  test("do the same calendar arithmetic", () => {
    const modern = fc
      .integer({ min: Date.UTC(1990, 0, 1) / 60000, max: Date.UTC(2040, 0, 1) / 60000 })
      .map((minutes) => minutes * 60000);
    const durations = fc.record(
      {
        years: fc.integer({ min: -20, max: 20 }),
        months: fc.integer({ min: -30, max: 30 }),
        weeks: fc.integer({ min: -10, max: 10 }),
        days: fc.integer({ min: -400, max: 400 }),
        hours: fc.integer({ min: -48, max: 48 }),
        minutes: fc.integer({ min: -120, max: 120 }),
      },
      { requiredKeys: [] }
    );
    fc.assert(
      fc.property(fc.constantFrom(...zones), modern, durations, (zone, ts, duration) => {
        const [native, luxon] = inBothModes(() => {
          const dt = DateTime.fromMillis(ts, { zone }),
            dur = Duration.fromObject(duration);
          return [
            describeDateTime(dt.plus(dur)),
            describeDateTime(dt.minus(dur)),
            describeDateTime(dt.startOf("week")),
            describeDateTime(dt.endOf("month")),
            describeDateTime(dt.set({ weekNumber: 1 })),
          ];
        });
        expect(luxon).toEqual(native);
      })
    );
  });
});
