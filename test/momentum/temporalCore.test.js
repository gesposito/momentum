/* global test expect describe */
import { DateTime, Settings, Zone } from "../../src/momentum";
import { resolveWallClock } from "../../src/impl/temporal";
import { anyInstant, fc, fieldsAt, wallClockNearTransition } from "./fastCheck.js";

// The DateTime core on Temporal: wall-clock resolution through PlainDateTime#toZonedDateTime,
// getPossibleOffsets, calendar arithmetic and week fields from Temporal.PlainDate, the lazily
// derived state, the fallback for custom zones, and the cases where Temporal deliberately differs
// from Luxon's algorithm.

const T = globalThis.Temporal;

function withNow(ts, fn) {
  const old = Settings.now;
  Settings.now = () => ts;
  try {
    return fn();
  } finally {
    Settings.now = old;
  }
}

// a custom zone that follows New York's 2017 rules, to exercise the path for zones Temporal
// cannot represent
class Switching2017Zone extends Zone {
  get type() {
    return "custom";
  }
  get name() {
    return "Switching2017";
  }
  get isUniversal() {
    return false;
  }
  offsetName() {
    return "SW";
  }
  formatOffset(ts) {
    return this.offset(ts) === -240 ? "-04:00" : "-05:00";
  }
  offset(ts) {
    return ts >= Date.UTC(2017, 2, 12, 7) && ts < Date.UTC(2017, 10, 5, 6) ? -240 : -300;
  }
  equals(other) {
    return other === this;
  }
  get isValid() {
    return true;
  }
}

describe("wall-clock resolution", () => {
  test("ambiguous times take the guessed offset when it is one of theirs", () => {
    // Lord Howe falls back 30 minutes: 01:30-02:00 on 2017-04-02 happens at +11:00 and at +10:30
    const zone = "Australia/Lord_Howe",
      wall = { year: 2017, month: 4, day: 2, hour: 1, minute: 45 },
      summer = DateTime.fromObject({ year: 2017, month: 3, day: 1 }, { zone }),
      winter = DateTime.fromObject({ year: 2017, month: 6, day: 1 }, { zone });
    expect(summer.set(wall).toISO()).toBe("2017-04-02T01:45:00.000+11:00");
    expect(winter.set(wall).toISO()).toBe("2017-04-02T01:45:00.000+10:30");
  });

  test("ambiguous times take the earlier offset when the guess is not one of theirs", () => {
    // in 1880 New York kept local mean time (-04:56:02), neither -04:00 nor -05:00
    const dt = withNow(Date.UTC(1880, 0, 1), () =>
      DateTime.fromObject(
        { year: 2017, month: 11, day: 5, hour: 1, minute: 30 },
        { zone: "America/New_York" }
      )
    );
    expect(dt.toISO()).toBe("2017-11-05T01:30:00.000-04:00");
    expect(dt.wasHole).toBe(false);
  });

  test("skipped times move forward by the length of the gap", () => {
    const lordHowe = DateTime.fromObject(
      { year: 2017, month: 10, day: 1, hour: 2, minute: 15 },
      { zone: "Australia/Lord_Howe" }
    );
    expect(lordHowe.toISO()).toBe("2017-10-01T02:45:00.000+11:00");
    expect(lordHowe.wasHole).toBe(true);

    // Samoa skipped 2011-12-30 when it moved across the date line
    const apia = DateTime.fromObject({ year: 2011, month: 12, day: 30, hour: 12 }, { zone: "Pacific/Apia" });
    expect(apia.toISO()).toBe("2011-12-31T12:00:00.000+14:00");
    expect(apia.wasHole).toBe(true);
  });

  test("existing times next to a transition are not mistaken for skipped ones", () => {
    // Kiritimati moved from -10:40 to -10:00 at midnight on 1979-10-01, far from today's +14:00.
    // Luxon's two-step offset search reports 02:30 as a hole and moves it to 03:10.
    const dt = DateTime.fromObject(
      { year: 1979, month: 10, day: 1, hour: 2, minute: 30 },
      { zone: "Pacific/Kiritimati" }
    );
    expect(dt.toISO()).toBe("1979-10-01T02:30:00.000-10:00");
    expect(dt.wasHole).toBe(false);
  });

  test("sub-minute offsets of local mean time are kept", () => {
    const rome = DateTime.fromObject({ year: 1800, month: 1, day: 1, hour: 12 }, { zone: "Europe/Rome" });
    expect(rome.offset).toBeCloseTo(49.9333, 3);
    expect(rome.toISO()).toBe("1800-01-01T12:00:00.000+00:49");
    expect(rome.toMillis()).toBe(Date.UTC(1800, 0, 1, 11, 10, 4));
    expect(rome.set({ hour: 5 }).toISO()).toBe("1800-01-01T05:00:00.000+00:49");
    expect(rome.plus({ days: 1 }).toISO()).toBe("1800-01-02T12:00:00.000+00:49");
    expect(
      DateTime.fromISO("0001-01-01", { zone: "UTC" })
        .setZone("America/Curacao", { keepLocalTime: true })
        .toObject()
    ).toEqual({ year: 1, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 });
  });

  test("out-of-range fields roll over like Date.UTC()", () => {
    const dt = DateTime.fromISO("2017-02-10T10:00", { zone: "UTC" });
    expect(dt.set({ minute: -1 }).toISO()).toBe("2017-02-10T09:59:00.000Z");
    expect(dt.set({ month: 0 }).toISODate()).toBe("2016-12-10");
    expect(dt.set({ day: 0 }).toISODate()).toBe("2017-01-31");
    expect(dt.set({ hour: 1.9 }).hour).toBe(1);
    expect(dt.set({ hour: 1.9 }).wasHole).toBe(false);
    expect(DateTime.local(2017, 5, 15, 24, { zone: "America/New_York" }).toISO()).toBe(
      "2017-05-16T00:00:00.000-04:00"
    );
  });

  test("wall clocks at the edges of Temporal's range resolve as in Luxon", () => {
    // Luxon computes local times with Date, so the instant and its local time must both fit
    // Date's range: east of UTC the first instant is valid, west of UTC the last one
    const first = DateTime.fromMillis(-8.64e15, { zone: "Asia/Tokyo" });
    expect(first.toISO()).toBe("-271821-04-20T09:18:59.000+09:18");
    expect(first.set({ minute: 57 }).toISO()).toBe("-271821-04-20T09:57:59.000+09:18");
    expect(first.set({ day: 31 }).toISO()).toBe("-271821-05-01T09:18:59.000+09:18");
    expect(first.set({ hour: 0 }).invalidReason).toBe("invalid input");
    expect(DateTime.fromMillis(-8.64e15, { zone: "America/New_York" }).invalidReason).toBe(
      "invalid input"
    );
    const last = DateTime.fromMillis(8.64e15, { zone: "America/New_York" });
    expect(last.set({ hour: 19 }).toISO()).toBe("+275760-09-12T19:00:00.000-04:00");
    expect(last.set({ hour: 21 }).invalidReason).toBe("invalid input");
    expect(DateTime.fromMillis(8.64e15, { zone: "Asia/Tokyo" }).invalidReason).toBe("invalid input");
    const lastDay = DateTime.fromMillis(8.64e15 - 9 * 3600000, { zone: "Asia/Tokyo" });
    expect(lastDay.set({ hour: 0 }).toISO()).toBe("+275760-09-13T00:00:00.000+09:00");
  });

  test("a guess whose instant lies past the end of Temporal's range is no candidate", () => {
    // New York is on summer time in September 275760; "now" in winter guesses -05:00, whose
    // instant for this wall clock would be past the last representable one
    const fields = { year: 275760, month: 9, day: 12, hour: 19, minute: 30 },
      dt = withNow(Date.UTC(2017, 0, 15), () =>
        DateTime.fromObject(fields, { zone: "America/New_York" })
      ),
      expected = T.ZonedDateTime.from({ ...fields, timeZone: "America/New_York" });
    expect(dt.isValid).toBe(true);
    expect(dt.toMillis()).toBe(expected.epochMilliseconds);
    expect(dt.offset).toBe(expected.offsetNanoseconds / 60e9);
  });

  test("does not depend on what the offset cache holds", () => {
    // Asia/Manila and Pacific/Guam moved across the date line on 1844-12-31, a transition that
    // temporal-polyfill's getTimeZoneTransition("next") skips. Moving a DateTime from before it to
    // after it guesses the old offset, which must not pick an instant through a stale window.
    Settings.resetCaches();
    const manila = DateTime.fromMillis(Date.UTC(1844, 5, 1), { zone: "Asia/Manila" });
    expect(manila.toFormat("ZZ")).toBe("-15:56");
    expect(manila.set({ year: 1850 }).toISO()).toBe("1850-05-31T08:03:52.000+08:03");
    expect(manila.plus({ years: 6 }).toISO()).toBe("1850-05-31T08:03:52.000+08:03");
    const guam = DateTime.fromMillis(Date.UTC(1844, 5, 1), { zone: "Pacific/Guam" });
    expect(guam.set({ year: 1850 }).toISO()).toBe("1850-05-31T09:39:00.000+09:39");
  });

  test("agrees with Temporal's own disambiguation around transitions", () => {
    // Luxon's rules in Temporal's terms: a skipped wall clock moves forward ("later"), and an
    // ambiguous one takes its later instant only when the zone's offset now (fromObject's guess)
    // is that instant's offset
    const zones = [
      "America/New_York",
      "Australia/Lord_Howe",
      "Pacific/Apia",
      "Europe/London",
      "Africa/Casablanca",
      "America/Nuuk",
      "Pacific/Chatham",
      "Asia/Kathmandu",
      "America/Caracas",
      "Europe/Moscow",
    ];
    const samples = fc.constantFrom(...zones).chain((zone) =>
      fc.record({
        zone: fc.constant(zone),
        fields: wallClockNearTransition(zone),
        now: fc
          .integer({ min: Date.UTC(1850, 0, 1) / 86400000, max: Date.UTC(2050, 0, 1) / 86400000 })
          .map((days) => days * 86400000),
      })
    );
    fc.assert(
      fc.property(samples, ({ zone, fields, now }) => {
        const dt = withNow(now, () => DateTime.fromObject(fields, { zone })),
          bag = { ...fields, timeZone: zone },
          earlier = T.ZonedDateTime.from(bag, { disambiguation: "earlier" }),
          later = T.ZonedDateTime.from(bag, { disambiguation: "later" }),
          guess = T.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone).offsetNanoseconds,
          skipped =
            T.PlainDateTime.compare(earlier.toPlainDateTime(), T.PlainDateTime.from(fields)) !== 0,
          ambiguous = earlier.epochMilliseconds !== later.epochMilliseconds,
          expected = skipped || (ambiguous && later.offsetNanoseconds === guess) ? later : earlier,
          view = T.Instant.fromEpochMilliseconds(dt.toMillis()).toZonedDateTimeISO(zone);
        expect([dt.toMillis(), dt.wasHole]).toEqual([expected.epochMilliseconds, skipped]);
        expect([dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.offset]).toEqual([
          view.year,
          view.month,
          view.day,
          view.hour,
          view.minute,
          view.offsetNanoseconds / 60e9,
        ]);
      })
    );
  });

  test("resolveWallClock matches ZonedDateTime.from with a preferred offset", () => {
    // ZonedDateTime.from({ ...fields, offset: guess }, { offset: "prefer" }) is the rule that
    // resolveWallClock implements more cheaply, so Temporal itself is the reference: the same
    // instant and offset, or a RangeError from both
    const zones = [
      "America/New_York",
      "Europe/London",
      "Europe/Dublin",
      "Australia/Lord_Howe",
      "Pacific/Apia",
      "Pacific/Kiritimati",
      "America/Nuuk",
      "Africa/Casablanca",
      "Asia/Kathmandu",
      "Pacific/Chatham",
      "Europe/Moscow",
      "Antarctica/Troll",
      "America/Sao_Paulo",
      "Asia/Tehran",
      "America/St_Johns",
      "Asia/Manila",
      "Pacific/Guam",
      "+05:30",
      "-09:30",
      "UTC",
    ];
    // the first and last two days of Temporal's range
    const edgeDay = (year, month, days) =>
      fc
        .tuple(fc.constantFrom(...days), fc.integer({ min: 0, max: 1439 }))
        .map(([day, minutes]) => ({
          year,
          month,
          day,
          hour: Math.floor(minutes / 60),
          minute: minutes % 60,
          second: 0,
          millisecond: 0,
        }));
    const edgeDays = fc.oneof(edgeDay(-271821, 4, [19, 20]), edgeDay(275760, 9, [12, 13]));
    const samples = fc.constantFrom(...zones).chain((zone) =>
      fc.record({
        zone: fc.constant(zone),
        fields: fc.oneof(
          { arbitrary: wallClockNearTransition(zone), weight: 6 },
          { arbitrary: anyInstant.map((ts) => fieldsAt(ts, zone)), weight: 3 },
          { arbitrary: edgeDays, weight: 1 }
        ),
        guess: fc.oneof(
          fc.constant(undefined),
          // an offset the zone really has within two months of that wall clock
          fc.integer({ min: -60, max: 60 }).map((days) => ({ days })),
          fc.integer({ min: -900, max: 900 }),
          fc.constantFrom(49.93333333333333, -296.03333333333336, 1500, -1440, NaN)
        ),
      })
    );
    fc.assert(
      fc.property(samples, ({ zone, fields, guess }) => {
        const offsetGuess =
            typeof guess === "object" ? offsetNear(fields, zone, guess.days) : guess,
          expected = attempt(() => preferredOffset(fields, zone, offsetGuess)),
          actual = attempt(() => resolveWallClock(fields, zone, offsetGuess));
        if (expected instanceof Error || actual instanceof Error) {
          expect([actual.name, expected.name]).toEqual(["RangeError", "RangeError"]);
        } else {
          expect([actual.ts, actual.o]).toEqual([
            expected.epochMilliseconds,
            expected.offsetNanoseconds / 60e9,
          ]);
        }
      })
    );
  });
});

function attempt(f) {
  try {
    return f();
  } catch (e) {
    return e;
  }
}

// the offset a zone has a number of days away from a wall clock (0 when that is out of range)
function offsetNear(fields, zone, days) {
  try {
    const zdt = T.PlainDateTime.from(fields).toZonedDateTime(zone);
    return zdt.add({ days }).offsetNanoseconds / 60e9;
  } catch {
    return 0;
  }
}

// minutes, possibly fractional, as a UTC offset string with up to second precision
function offsetString(minutes) {
  const seconds = Math.round(Math.abs(minutes) * 60),
    pad = (n) => String(n).padStart(2, "0"),
    sign = minutes < 0 ? "-" : "+",
    hhmm = `${sign}${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}`;
  return seconds % 60 === 0 ? hhmm : `${hhmm}:${pad(seconds % 60)}`;
}

// the reference resolution: Temporal's own, with the guess as a preferred offset
function preferredOffset(fields, timeZone, guess) {
  const offset = Number.isFinite(guess) && Math.abs(guess) < 1440 ? offsetString(guess) : undefined;
  try {
    return T.ZonedDateTime.from(
      { ...fields, timeZone, offset },
      { offset: "prefer", disambiguation: "compatible", overflow: "reject" }
    );
  } catch (e) {
    // ZonedDateTime.from rejects the first day of Temporal's range whenever an offset is given
    if (e?.name !== "RangeError") throw e;
    return T.PlainDateTime.from(fields).toZonedDateTime(timeZone);
  }
}

describe("getPossibleOffsets", () => {
  test("lists both instants of an ambiguous wall clock, earlier first", () => {
    const lordHowe = DateTime.fromObject(
      { year: 2017, month: 4, day: 2, hour: 1, minute: 45 },
      { zone: "Australia/Lord_Howe" }
    );
    expect(lordHowe.getPossibleOffsets().map((d) => d.toISO())).toEqual([
      "2017-04-02T01:45:00.000+11:00",
      "2017-04-02T01:45:00.000+10:30",
    ]);
    // Samoa lived through 1892-07-04 twice when it moved east of the date line
    const apia = DateTime.fromObject({ year: 1892, month: 7, day: 4, hour: 12 }, { zone: "Pacific/Apia" });
    expect(apia.getPossibleOffsets().map((d) => d.offset)).toEqual([753 + 4 / 60, -686 - 56 / 60]);
  });

  test("returns the DateTime itself when the wall clock is unambiguous", () => {
    const dt = DateTime.fromObject({ year: 2017, month: 4, day: 2, hour: 3 }, { zone: "Australia/Lord_Howe" });
    expect(dt.getPossibleOffsets()).toEqual([dt]);
    expect(dt.getPossibleOffsets()[0]).toBe(dt);
    const first = DateTime.fromMillis(-8.64e15, { zone: "America/New_York" });
    expect(first.getPossibleOffsets()[0]).toBe(first);
  });
});

describe("calendar arithmetic", () => {
  const jan31 = DateTime.fromObject({ year: 2017, month: 1, day: 31, hour: 10 }, { zone: "UTC" });

  test("adds months before days and clamps to the length of the month", () => {
    expect(jan31.plus({ months: 1 }).toISODate()).toBe("2017-02-28");
    expect(jan31.plus({ months: 1, days: 1 }).toISODate()).toBe("2017-03-01");
    expect(jan31.plus({ months: 1, days: -1 }).toISODate()).toBe("2017-02-27");
    expect(jan31.plus({ months: 1, days: -1 }).equals(jan31.plus({ months: 1 }).plus({ days: -1 }))).toBe(
      true
    );
    expect(jan31.plus({ years: 3, months: 1 }).toISODate()).toBe("2020-02-29");
    expect(jan31.minus({ quarters: 1 }).toISODate()).toBe("2016-10-31");
  });

  test("accepts mixed signs and fractions", () => {
    expect(jan31.plus({ years: 1, months: -1 }).toISODate()).toBe("2017-12-31");
    expect(jan31.plus({ quarters: 1, weeks: -1 }).toISODate()).toBe("2017-04-23");
    expect(jan31.plus({ days: 1.5 }).toISO()).toBe("2017-02-01T22:00:00.000Z");
    expect(jan31.plus({ months: -1, hours: 30 }).toISO()).toBe("2017-01-01T16:00:00.000Z");
  });

  test("keeps the wall clock across transitions, unlike time units", () => {
    const ny = DateTime.fromObject({ year: 2017, month: 3, day: 11, hour: 12 }, { zone: "America/New_York" });
    expect(ny.plus({ days: 1 }).toISO()).toBe("2017-03-12T12:00:00.000-04:00");
    expect(ny.plus({ hours: 24 }).toISO()).toBe("2017-03-12T13:00:00.000-04:00");
    const apia = DateTime.fromObject({ year: 2011, month: 12, day: 29, hour: 12 }, { zone: "Pacific/Apia" });
    expect(apia.plus({ days: 1 }).toISO()).toBe("2011-12-31T12:00:00.000+14:00");
    expect(apia.plus({ days: 1 }).wasHole).toBe(true);
    expect(apia.plus({ days: 2 }).toISO()).toBe("2011-12-31T12:00:00.000+14:00");
    expect(apia.plus({ days: 2 }).wasHole).toBe(false);
  });

  test("is invalid when it leaves Temporal's range", () => {
    const dt = DateTime.fromMillis(8.64e15 - 86400000, { zone: "UTC" });
    expect(dt.plus({ days: 1 }).isValid).toBe(true);
    expect(dt.plus({ days: 2 }).invalidReason).toBe("invalid input");
    expect(dt.plus({ months: 1 }).invalidReason).toBe("invalid input");
    expect(dt.plus({ years: 1e20 }).invalidReason).toBe("invalid input");
  });
});

describe("week, ordinal and month fields", () => {
  const dt = DateTime.fromObject({ year: 2016, month: 1, day: 1 }, { zone: "UTC" });

  test("come from Temporal.PlainDate", () => {
    expect([dt.weekYear, dt.weekNumber, dt.weekday, dt.ordinal]).toEqual([2015, 53, 5, 1]);
    expect([dt.daysInMonth, dt.daysInYear, dt.isInLeapYear, dt.weeksInWeekYear]).toEqual([
      31,
      366,
      true,
      53,
    ]);
    expect(dt.toPlainDate().toString()).toBe("2016-01-01");
    const sat = DateTime.fromObject({ year: 2022, month: 1, day: 1 }, { zone: "UTC" }).reconfigure({
      weekSettings: { firstDay: 7, minimalDays: 1, weekend: [6, 7] },
    });
    expect([sat.localWeekYear, sat.localWeekNumber, sat.localWeekday]).toEqual([2022, 1, 7]);
  });

  test("week and ordinal dates beyond Temporal's range are still validated", () => {
    expect(DateTime.fromObject({ weekYear: 300000, weekNumber: 1 }).invalidReason).toBe(
      "invalid input"
    );
    expect(DateTime.fromObject({ weekYear: 300000, weekNumber: 54 }).invalidReason).toBe(
      "unit out of range"
    );
    expect(DateTime.fromObject({ year: 300000, ordinal: 1 }).invalidReason).toBe("invalid input");
    expect(DateTime.fromObject({ weekYear: 1e25, weekNumber: 1 }).invalidReason).toBe(
      "invalid input"
    );
    expect(dt.set({ weekYear: 1e25 }).invalidReason).toBe("invalid input");
    // fractions are truncated, as Date.UTC() does in Luxon (2017 has no week 53)
    expect(dt.set({ weekYear: 2017.5 }).toISODate()).toBe("2018-01-05");
  });

  test("ordinals roll over like Luxon's, which rejects those of 0 or less", () => {
    expect(dt.set({ ordinal: 400 }).toISODate()).toBe("2017-02-03");
    expect(dt.set({ weekNumber: 60 }).toISODate()).toBe("2016-02-19");
    expect(dt.set({ ordinal: 0 }).invalidReason).toBe("invalid input");
    expect(dt.set({ ordinal: 1e12 }).invalidReason).toBe("invalid input");
  });

  test("invalid DateTimes have none", () => {
    const invalid = DateTime.invalid("because");
    expect([invalid.weekNumber, invalid.ordinal, invalid.daysInYear]).toEqual([NaN, NaN, NaN]);
    expect(invalid.daysInMonth).toBe(undefined);
    expect(invalid.isInLeapYear).toBe(false);
    expect(invalid.toPlainDate()).toBe(null);
  });
});

describe("Temporal-derived state", () => {
  test("does not affect deep equality", () => {
    const resolved = DateTime.local(2017, 5, 15, 10),
      fromInstant = DateTime.fromMillis(resolved.toMillis());
    expect(resolved).toEqual(fromInstant);
    void resolved.ordinal;
    void fromInstant.hour;
    expect(resolved).toEqual(fromInstant);
    expect(Object.keys(resolved).sort()).toEqual(Object.keys(fromInstant).sort());
    expect(resolved).not.toEqual(fromInstant.plus(1));
  });
});

describe("custom zones", () => {
  const zone = new Switching2017Zone(),
    reference = "America/New_York";

  test("resolve wall clocks from their offsets", () => {
    for (const fields of [
      { year: 2017, month: 3, day: 12, hour: 2, minute: 30 },
      { year: 2017, month: 7, day: 1, hour: 12 },
      { year: 2017, month: 12, day: 24, hour: 18 },
    ]) {
      const custom = DateTime.fromObject(fields, { zone }),
        iana = DateTime.fromObject(fields, { zone: reference });
      expect(custom.toISO()).toBe(iana.toISO());
      expect(custom.wasHole).toBe(iana.wasHole);
    }
  });

  test("support math, set, startOf and getPossibleOffsets", () => {
    const custom = DateTime.fromObject({ year: 2017, month: 11, day: 4, hour: 1, minute: 30 }, { zone }),
      iana = DateTime.fromObject({ year: 2017, month: 11, day: 4, hour: 1, minute: 30 }, { zone: reference });
    expect(custom.plus({ days: 1 }).toISO()).toBe(iana.plus({ days: 1 }).toISO());
    expect(custom.plus({ hours: 24 }).toISO()).toBe(iana.plus({ hours: 24 }).toISO());
    expect(custom.set({ month: 3, day: 12, hour: 2 }).toISO()).toBe(
      iana.set({ month: 3, day: 12, hour: 2 }).toISO()
    );
    expect(custom.startOf("month").toISO()).toBe(iana.startOf("month").toISO());
    const ambiguous = custom.plus({ days: 1 });
    expect(ambiguous.getPossibleOffsets().map((d) => d.toISO())).toEqual([
      "2017-11-05T01:30:00.000-04:00",
      "2017-11-05T01:30:00.000-05:00",
    ]);
  });

  test("with offsets Temporal has no time zone for still have calendar fields", () => {
    class FarZone extends Switching2017Zone {
      offset() {
        return 1500.5; // a day, an hour and thirty seconds
      }
    }
    const dt = DateTime.fromMillis(Date.UTC(2017, 0, 1), { zone: new FarZone() });
    expect(dt.toObject()).toEqual({
      year: 2017,
      month: 1,
      day: 2,
      hour: 1,
      minute: 0,
      second: 30,
      millisecond: 0,
    });
  });
});
