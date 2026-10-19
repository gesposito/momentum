/* global test expect describe beforeAll afterAll */
import { DateTime, Settings } from "../../src/momentum";

// Luxon behaviour that Luxon's own test suite does not check: each expectation is what Luxon
// 3.7.2 returns for the same input.

// Luxon resolves a wall-clock time with a two-step search from a guessed offset (fixOffset).
// Where the guess is far from the offsets around a transition, that search reports an existing
// time as skipped, or takes the later of two instants for a guess that is neither of their
// offsets. Temporal's disambiguation, momentum's default, does not (see
// test/momentum/temporalCore.test.js); with Settings.temporalNative = false momentum runs
// Luxon's search and returns exactly what Luxon returns.
describe("Luxon's offset search (Settings.temporalNative = false)", () => {
  let temporalNative;
  beforeAll(() => {
    temporalNative = Settings.temporalNative;
    Settings.temporalNative = false;
  });
  afterAll(() => {
    Settings.temporalNative = temporalNative;
  });

  function withNow(ts, fn) {
    const old = Settings.now;
    Settings.now = () => ts;
    try {
      return fn();
    } finally {
      Settings.now = old;
    }
  }

  test("reports existing times far from the guess as skipped", () => {
    // Kiritimati moved from -10:40 to -10:00 at midnight on 1979-10-01, far from today's +14:00
    const kiritimati = withNow(Date.UTC(2017, 0, 15), () =>
      DateTime.fromObject(
        { year: 1979, month: 10, day: 1, hour: 2, minute: 30 },
        { zone: "Pacific/Kiritimati" }
      )
    );
    expect(kiritimati.toISO()).toBe("1979-10-01T03:10:00.000-10:00");
    expect(kiritimati.wasHole).toBe(true);
    // Samoa started daylight saving time at midnight on 2010-09-26, far from today's +13:00
    const apia = withNow(Date.UTC(2017, 0, 15), () =>
      DateTime.fromObject(
        { year: 2010, month: 9, day: 26, hour: 1, minute: 30 },
        { zone: "Pacific/Apia" }
      )
    );
    expect(apia.toISO()).toBe("2010-09-26T02:30:00.000-10:00");
    expect(apia.wasHole).toBe(true);
  });

  test("takes the later instant of an ambiguous time for a guess that is neither offset", () => {
    // in 1880 New York kept local mean time (-04:56:02), neither -04:00 nor -05:00
    const dt = withNow(Date.UTC(1880, 0, 1), () =>
      DateTime.fromObject(
        { year: 2017, month: 11, day: 5, hour: 1, minute: 30 },
        { zone: "America/New_York" }
      )
    );
    expect(dt.toISO()).toBe("2017-11-05T01:30:00.000-05:00");
    expect(dt.wasHole).toBe(false);
  });
});
