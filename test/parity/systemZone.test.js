/* global test expect describe beforeEach afterEach */
import { DateTime, Settings, SystemZone } from "../../src/momentum";

// Luxon behaviour that Luxon's own test suite does not check: each expectation is what Luxon
// 3.7.2 does in the same situation.

// Node.js reports the system zone as "Etc/Unknown" when TZ is set but empty, a name the time zone
// database lacks. Luxon keeps the name and computes in UTC, as Date does. momentum reads the
// system zone from Temporal.Now, which is stubbed here.
describe("a system zone the time zone database lacks", () => {
  const T = globalThis.Temporal;
  let timeZoneId;

  beforeEach(() => {
    timeZoneId = T.Now.timeZoneId;
    T.Now.timeZoneId = () => "Etc/Unknown";
    Settings.resetCaches();
  });

  afterEach(() => {
    T.Now.timeZoneId = timeZoneId;
    Settings.resetCaches();
  });

  test("keeps its name and computes in UTC", () => {
    const dt = DateTime.fromMillis(0);
    expect(dt.isValid).toBe(true);
    expect(dt.zoneName).toBe("Etc/Unknown");
    expect(dt.toISO()).toBe("1970-01-01T00:00:00.000+00:00");
    expect(DateTime.local(2017, 5, 15, 9).toMillis()).toBe(Date.UTC(2017, 4, 15, 9));
    expect(SystemZone.instance.isValid).toBe(true);
  });
});
