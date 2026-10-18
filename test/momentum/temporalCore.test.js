/* global test expect describe */
import { DateTime, Settings, Zone } from "../../src/momentum";

// The DateTime core on Temporal: wall-clock resolution through Temporal.ZonedDateTime.from, the
// fallback for custom zones, and the cases where it deliberately differs from Luxon's algorithm.

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

  test("agrees with Temporal's own disambiguation around random transitions", () => {
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
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 200; i++) {
      const zone = zones[Math.floor(random() * zones.length)],
        start = T.ZonedDateTime.from({
          year: 1880 + Math.floor(random() * 160),
          month: 1 + Math.floor(random() * 12),
          day: 1,
          timeZone: zone,
        }),
        transition = start.getTimeZoneTransition("next");
      if (transition === null) continue;
      const near = transition.add({ minutes: Math.floor(random() * 240) - 120 }),
        fields = {
          year: near.year,
          month: near.month,
          day: near.day,
          hour: near.hour,
          minute: near.minute,
        },
        now = Date.UTC(1850 + Math.floor(random() * 200), Math.floor(random() * 12), 1),
        dt = withNow(now, () => DateTime.fromObject(fields, { zone })),
        earlier = T.ZonedDateTime.from({ ...fields, timeZone: zone }, { disambiguation: "earlier" }),
        later = T.ZonedDateTime.from({ ...fields, timeZone: zone }, { disambiguation: "later" }),
        guess = T.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone).offsetNanoseconds,
        skipped = T.PlainDateTime.compare(earlier.toPlainDateTime(), T.PlainDateTime.from(fields)) !== 0,
        expected = skipped
          ? later
          : earlier.epochMilliseconds !== later.epochMilliseconds && later.offsetNanoseconds === guess
            ? later
            : earlier,
        view = T.Instant.fromEpochMilliseconds(dt.toMillis()).toZonedDateTimeISO(zone);

      expect({ zone, fields, now, ms: dt.toMillis(), hole: dt.wasHole }).toEqual({
        zone,
        fields,
        now,
        ms: expected.epochMilliseconds,
        hole: skipped,
      });
      expect([dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.offset]).toEqual([
        view.year,
        view.month,
        view.day,
        view.hour,
        view.minute,
        view.offsetNanoseconds / 60e9,
      ]);
    }
  });
});

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
