/* global test expect describe */
import { DateTime } from "../../src/momentum";

// Luxon behaviour that Luxon's own test suite does not check: each expectation is what Luxon
// 3.7.2 returns for the same input.

// Luxon computes calendar fields with Date, whose range is 8.64e15 ms either side of the epoch.
// A DateTime whose local time falls outside that range is invalid, even when its instant does not.
describe("the edges of Date's range", () => {
  test("instants at the edges are valid", () => {
    expect(DateTime.fromMillis(8.64e15, { zone: "UTC" }).toISO()).toBe(
      "+275760-09-13T00:00:00.000Z"
    );
    expect(DateTime.fromMillis(-8.64e15, { zone: "UTC+1" }).toISO()).toBe(
      "-271821-04-20T01:00:00.000+01:00"
    );
    expect(DateTime.fromMillis(8.64e15, { zone: "America/New_York" }).toISO()).toBe(
      "+275760-09-12T20:00:00.000-04:00"
    );
    expect(
      DateTime.fromObject(
        { year: 275760, month: 9, day: 12, hour: 19, minute: 30 },
        { zone: "America/New_York" }
      ).toISO()
    ).toBe("+275760-09-12T19:30:00.000-04:00");
  });

  test("a local time beyond the edges is invalid input", () => {
    const beyond = [
      DateTime.fromMillis(8.64e15, { zone: "UTC+5:30" }),
      DateTime.fromMillis(-8.64e15, { zone: "UTC-1" }),
      DateTime.fromMillis(8.64e15, { zone: "UTC" }).setZone("UTC+1"),
      DateTime.fromObject({ year: 275760, month: 9, day: 13, hour: 5 }, { zone: "UTC+5:30" }),
      DateTime.fromObject(
        { year: 275760, month: 9, day: 12, hour: 20, minute: 30 },
        { zone: "America/New_York" }
      ),
      // the month lands beyond the edge before the hours bring it back
      DateTime.fromObject({ year: 275760, month: 8, day: 13, hour: 3 }, { zone: "UTC+5:30" }).plus({
        months: 1,
        hours: -48,
      }),
    ];
    for (const dt of beyond) {
      expect(dt.isValid).toBe(false);
      expect(dt.invalidReason).toBe("invalid input");
    }
  });
});
