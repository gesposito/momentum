/* global test expect describe */
import { DateTime } from "../../src/momentum";

// Luxon behaviour that Luxon's own test suite does not check: each expectation is what Luxon
// 3.7.2 returns for the same input.

// Luxon keeps a DateTime's state in ordinary properties, so a DateTime keeps working behind a
// Proxy (Vue's reactive() wraps objects in one) and as a copy of its own properties (what
// deep-clone helpers make).
describe("a DateTime behind a Proxy or copied property by property", () => {
  const dt = DateTime.fromMillis(Date.UTC(2017, 4, 15, 9), { zone: "Europe/Rome" });

  function check(copy) {
    expect(copy.hour).toBe(11);
    expect(copy.toISO()).toBe("2017-05-15T11:00:00.000+02:00");
    expect(copy.plus({ days: 1 }).toISO()).toBe("2017-05-16T11:00:00.000+02:00");
    expect(copy.startOf("month").toISO()).toBe("2017-05-01T00:00:00.000+02:00");
    expect(copy.setZone("Asia/Tokyo").toISO()).toBe("2017-05-15T18:00:00.000+09:00");
    expect(copy.toFormat("yyyy-MM-dd HH:mm ZZ")).toBe("2017-05-15 11:00 +02:00");
    expect(copy.weekNumber).toBe(20);
    expect(copy.ordinal).toBe(135);
  }

  test("works through the Proxy", () => {
    check(new Proxy(dt, {}));
  });

  test("works as a copy of its own properties", () => {
    check(Object.assign(Object.create(Object.getPrototypeOf(dt)), dt));
  });
});
