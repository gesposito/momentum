/* global test expect describe */
import { DateTime } from "../../src/momentum";

// Luxon behaviour that Luxon's own test suite does not check: each expectation is what Luxon
// 3.7.2 returns for the same input.

// Luxon hands an ordinal to Date.UTC as a day of January: any ordinal above 0 is accepted, its
// fraction is dropped, and days past the end of the year roll into the following years.
describe("setting the ordinal", () => {
  const dt = DateTime.utc(2017, 5, 15, 9);

  test("drops the fraction of the ordinal", () => {
    expect(dt.set({ ordinal: 0.5 }).toISO()).toBe("2016-12-31T09:00:00.000Z");
    expect(dt.set({ ordinal: 32.9 }).toISO()).toBe("2017-02-01T09:00:00.000Z");
  });

  test("rolls past the end of the year, however far", () => {
    expect(dt.set({ ordinal: 400 }).toISO()).toBe("2018-02-04T09:00:00.000Z");
    expect(DateTime.utc(1000).set({ ordinal: 1e8 }).toISO()).toBe("+274790-09-13T00:00:00.000Z");
  });

  test("rejects ordinals of 0 or less", () => {
    expect(dt.set({ ordinal: 0 }).invalidReason).toBe("invalid input");
    expect(dt.set({ ordinal: -1 }).invalidReason).toBe("invalid input");
  });
});
