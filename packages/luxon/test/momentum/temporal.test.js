/* global test expect describe */
import {
  DateTime,
  FixedOffsetZone,
  IANAZone,
  Settings,
  TemporalUnavailableError,
  Zone,
} from "../../src/momentum";

const T = globalThis.Temporal;

describe("Temporal interop", () => {
  const zdt = T.ZonedDateTime.from("2017-05-15T09:12:34.567-04:00[America/New_York]");

  test("DateTime.fromZonedDateTime keeps the instant, the zone and the wall clock", () => {
    const dt = DateTime.fromZonedDateTime(zdt);
    expect(dt.isValid).toBe(true);
    expect(dt.toMillis()).toBe(zdt.epochMilliseconds);
    expect(dt.zoneName).toBe("America/New_York");
    expect(dt.zone).toBeInstanceOf(IANAZone);
    expect(dt.offset).toBe(-240);
    expect(dt.toObject()).toEqual({
      year: 2017,
      month: 5,
      day: 15,
      hour: 9,
      minute: 12,
      second: 34,
      millisecond: 567,
    });
  });

  test("DateTime.fromZonedDateTime accepts locale options", () => {
    const dt = DateTime.fromZonedDateTime(zdt, { locale: "fr", numberingSystem: "beng" });
    expect(dt.locale).toBe("fr");
    expect(dt.numberingSystem).toBe("beng");
  });

  test("DateTime.fromZonedDateTime maps UTC and offset time zones", () => {
    const utc = DateTime.fromZonedDateTime(zdt.withTimeZone("UTC"));
    expect(utc.zone).toBe(FixedOffsetZone.utcInstance);
    expect(utc.hour).toBe(13);

    const offset = DateTime.fromZonedDateTime(zdt.withTimeZone("+05:30"));
    expect(offset.isValid).toBe(true);
    expect(offset.zoneName).toBe("+05:30");
    expect(offset.offset).toBe(330);
    expect(offset.hour).toBe(18);
    expect(offset.minute).toBe(42);
  });

  test("DateTime.fromZonedDateTime converts non-ISO calendars to the Gregorian calendar", () => {
    let japanese;
    try {
      japanese = zdt.withCalendar("japanese");
    } catch (e) {
      // the basic build of the polyfill only ships the ISO calendar
      return;
    }
    const dt = DateTime.fromZonedDateTime(japanese);
    expect(dt.year).toBe(2017);
    expect(dt.month).toBe(5);
    expect(dt.toMillis()).toBe(zdt.epochMilliseconds);
  });

  test("DateTime.fromZonedDateTime is invalid when the local time is beyond Date's range", () => {
    // the rule Luxon applies to every DateTime, see test/parity/dateRange.test.js
    const edge = T.Instant.fromEpochMilliseconds(8.64e15);
    expect(DateTime.fromZonedDateTime(edge.toZonedDateTimeISO("UTC")).isValid).toBe(true);
    expect(DateTime.fromZonedDateTime(edge.toZonedDateTimeISO("+05:30")).invalidReason).toBe(
      "invalid input"
    );
  });

  test("DateTime.fromInstant uses the default zone unless one is given", () => {
    const instant = T.Instant.fromEpochMilliseconds(1494853954567);
    expect(DateTime.fromInstant(instant).toMillis()).toBe(1494853954567);
    expect(DateTime.fromInstant(instant).zone.type).toBe("system");
    expect(DateTime.fromInstant(instant, { zone: "Europe/Paris" }).hour).toBe(15);
  });

  test("DateTime#toZonedDateTime round-trips", () => {
    const dt = DateTime.fromZonedDateTime(zdt);
    expect(dt.toZonedDateTime().toString()).toBe(zdt.toString());
    expect(
      DateTime.fromISO("2017-05-15T09:12:34.567Z", { zone: "utc" }).toZonedDateTime().toString()
    ).toBe("2017-05-15T09:12:34.567+00:00[UTC]");
    expect(
      DateTime.fromISO("2017-05-15T09:12:34.567+02:00", { setZone: true })
        .toZonedDateTime()
        .toString()
    ).toBe("2017-05-15T09:12:34.567+02:00[+02:00]");
  });

  // a custom zone with a constant offset in minutes
  class CustomZone extends Zone {
    constructor(minutes) {
      super();
      this.minutes = minutes;
    }
    get type() {
      return "custom";
    }
    get name() {
      return "CUSTOM";
    }
    get isUniversal() {
      return true;
    }
    offsetName() {
      return "CUSTOM";
    }
    formatOffset() {
      return "+00:30";
    }
    offset() {
      return this.minutes;
    }
    equals(other) {
      return other.type === "custom";
    }
    get isValid() {
      return true;
    }
  }

  test("DateTime#toZonedDateTime represents custom zones by their offset", () => {
    const dt = DateTime.fromMillis(1494853954567).setZone(new CustomZone(30));
    expect(dt.toZonedDateTime().toString()).toBe("2017-05-15T13:42:34.567+00:30[+00:30]");
  });

  test("DateTime#toZonedDateTime is null when Temporal has no such time zone", () => {
    // Temporal's offset time zones are whole minutes under a day
    expect(DateTime.fromMillis(0).setZone(new CustomZone(49.9)).toZonedDateTime()).toBe(null);
    expect(DateTime.fromMillis(0, { zone: FixedOffsetZone.instance(90.5) }).toZonedDateTime()).toBe(
      null
    );
    expect(DateTime.fromMillis(0, { zone: "UTC+24" }).toZonedDateTime()).toBe(null);
  });

  test("DateTime#toInstant, toPlainDateTime, toPlainDate and toPlainTime", () => {
    const dt = DateTime.fromZonedDateTime(zdt);
    expect(dt.toInstant().epochMilliseconds).toBe(zdt.epochMilliseconds);
    expect(dt.toPlainDateTime().toString()).toBe("2017-05-15T09:12:34.567");
    expect(dt.toPlainDate().toString()).toBe("2017-05-15");
    expect(dt.toPlainTime().toString()).toBe("09:12:34.567");
  });

  test("Temporal conversions of an invalid DateTime are null", () => {
    const dt = DateTime.invalid("because");
    expect(dt.toZonedDateTime()).toBe(null);
    expect(dt.toInstant()).toBe(null);
    expect(dt.toPlainDateTime()).toBe(null);
    expect(dt.toPlainDate()).toBe(null);
    expect(dt.toPlainTime()).toBe(null);
  });
});

describe("Temporal-backed zones", () => {
  test("IANAZone.normalizeZone keeps links, folds UTC aliases, rejects ISO strings", () => {
    expect(IANAZone.normalizeZone("Asia/Calcutta")).toBe("Asia/Calcutta");
    expect(IANAZone.normalizeZone("asia/kolkata")).toBe("Asia/Kolkata");
    expect(IANAZone.normalizeZone("Etc/UTC")).toBe("UTC");
    expect(IANAZone.normalizeZone("etc/gmt")).toBe("UTC");
    expect(IANAZone.normalizeZone("GMT0")).toBe("UTC");
    expect(IANAZone.normalizeZone("Etc/GMT+8")).toBe("Etc/GMT+8");
    for (const iso of ["2020-01-01T00:00[Europe/Rome]", "2020-01-01T00:00Z", "2020-01-01T00:00+01:00"]) {
      expect(IANAZone.normalizeZone(iso)).toBe(null);
      expect(DateTime.now().setZone(iso).invalidReason).toBe("unsupported zone");
    }
  });

  test("setting an out-of-range unit rolls over into the next unit", () => {
    const dt = DateTime.fromISO("2017-02-10T10:00", { zone: "UTC" });
    expect(dt.set({ day: 31 }).toISODate()).toBe("2017-03-03");
    expect(dt.set({ hour: 24 }).toISO()).toBe("2017-02-11T00:00:00.000Z");
    expect(dt.set({ month: 13 }).toISODate()).toBe("2018-01-10");
  });

  test("ambiguous and skipped local times behave like Luxon", () => {
    const fall = DateTime.fromObject(
      { year: 2017, month: 11, day: 5, hour: 1, minute: 30 },
      { zone: "America/New_York" }
    );
    expect(fall.getPossibleOffsets().map((d) => d.offset)).toEqual([-240, -300]);
    const spring = DateTime.fromObject(
      { year: 2017, month: 3, day: 12, hour: 2, minute: 30 },
      { zone: "America/New_York" }
    );
    expect(spring.hour).toBe(3);
    expect(spring.wasHole).toBe(true);
    expect(spring.getPossibleOffsets()).toHaveLength(1);
  });
});

describe("Temporal availability", () => {
  test("a descriptive error is thrown when Temporal is missing", () => {
    const original = globalThis.Temporal;
    try {
      delete globalThis.Temporal;
      Settings.resetCaches();
      let error = null;
      try {
        DateTime.now();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TemporalUnavailableError);
      expect(error.name).toBe("TemporalUnavailableError");
      expect(error.message).toMatch(/momentum\/polyfill/);
    } finally {
      globalThis.Temporal = original;
      Settings.resetCaches();
    }
  });
});
