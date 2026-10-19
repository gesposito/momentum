/* global test expect describe */
import { DateTime } from "../../src/momentum";

// Luxon behaviour that Luxon's own test suite does not check: each expectation is what Luxon
// 3.7.2 returns for the same input.

// Luxon builds dates with Date.UTC, which carries out-of-range fields into the larger units
// however far they reach, as long as the result fits Date's range.
describe("fields far out of range", () => {
  test("roll over across hundreds of thousands of years", () => {
    expect(DateTime.utc(275000).set({ day: -1e8 }).toISO()).toBe("1209-04-19T00:00:00.000Z");
    expect(DateTime.utc(2017).set({ month: -3e6 }).toISO()).toBe("-247984-12-01T00:00:00.000Z");
    expect(DateTime.utc(-271000).set({ month: 3e6 }).toISO()).toBe("-021001-12-01T00:00:00.000Z");
    expect(DateTime.utc(-271000).set({ minute: 1e11 }).toISO()).toBe(
      "-080868-06-07T10:40:00.000Z"
    );
    expect(DateTime.utc(1000).set({ hour: 2e9 }).toISO()).toBe("+229158-12-02T08:00:00.000Z");
  });

  test("are invalid input when the result leaves Date's range", () => {
    expect(DateTime.utc(275000).set({ day: 1e8 }).invalidReason).toBe("invalid input");
  });
});
