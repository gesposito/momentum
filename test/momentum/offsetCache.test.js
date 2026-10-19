/* global test expect describe */
import { DateTime, IANAZone, Settings } from "../../src/momentum";
import { anyInstant, fc, nearTransition } from "./fastCheck.js";

// Offsets are served from cached transition windows; they must agree with Temporal exactly,
// including right at, just before and just after every transition.

const T = globalThis.Temporal;
const directOffset = (zone, ts) =>
  T.Instant.fromEpochMilliseconds(ts).toZonedDateTimeISO(zone).offsetNanoseconds / 60000000000;

// every transition of a zone between 1995 and 2030: the instants right at, just before and just
// after it, and an hour either side
function transitionProbes(zone) {
  const result = [];
  let current = T.Instant.fromEpochMilliseconds(Date.UTC(1995, 0, 1)).toZonedDateTimeISO(zone);
  for (let i = 0; i < 200; i++) {
    const next = current.getTimeZoneTransition("next");
    if (next === null || next.epochMilliseconds > Date.UTC(2030, 0, 1)) break;
    const t = next.epochMilliseconds;
    result.push(t - 1, t, t + 1, t - 3600000, t + 3600000);
    current = next;
  }
  return result;
}

const zones = ["America/New_York", "Europe/Rome", "Australia/Lord_Howe", "Pacific/Apia"];

describe("cached offsets", () => {
  for (const zone of zones) {
    test(`agree with Temporal around every transition of ${zone}`, () => {
      Settings.resetCaches();
      const iana = IANAZone.create(zone);
      for (const ts of transitionProbes(zone)) {
        expect(iana.offset(ts)).toBe(directOffset(zone, ts));
      }
    });
  }

  test("agree with Temporal for any instants, queried in any order", () => {
    // the cache keeps a few windows per zone and evicts the least recently used one, so no
    // sequence of queries may change an answer; each run starts from an empty cache
    const zoneAndInstants = fc
      .constantFrom(...zones, "Asia/Manila", "Pacific/Guam", "Europe/London", "Asia/Kathmandu")
      .chain((zone) =>
        fc.tuple(
          fc.constant(zone),
          fc.array(fc.oneof(nearTransition(zone), anyInstant), { minLength: 1, maxLength: 30 })
        )
      );
    fc.assert(
      fc.property(zoneAndInstants, ([zone, instants]) => {
        Settings.resetCaches();
        const iana = IANAZone.create(zone);
        for (const ts of instants) {
          expect(iana.offset(ts)).toBe(directOffset(zone, ts));
        }
      })
    );
  });

  test("include historical local mean time with sub-minute precision", () => {
    // 1800-01-01 in Rome: LMT +00:49:56
    expect(IANAZone.create("Europe/Rome").offset(Date.UTC(1800, 0, 1))).toBeCloseTo(49.9333, 3);
    expect(DateTime.fromMillis(Date.UTC(1800, 0, 1), { zone: "Europe/Rome" }).toISO()).toBe(
      "1800-01-01T00:49:56.000+00:49"
    );
  });

  test("treat a fractional timestamp as the millisecond it truncates to, like Date", () => {
    // New York left daylight saving time at 06:00 UTC on 1918-10-27. Half a millisecond earlier
    // truncates toward zero onto the transition itself, whatever the cache holds.
    const transition = Date.UTC(1918, 9, 27, 6),
      zone = IANAZone.create("America/New_York");
    Settings.resetCaches();
    expect(zone.offset(transition - 0.5)).toBe(-300);
    Settings.resetCaches();
    expect(zone.offset(transition - 3600000)).toBe(-240);
    expect(zone.offset(transition - 0.5)).toBe(-300);
  });

  test("hold across transitions that temporal-polyfill does not report", () => {
    // these zones moved across the date line on 1844-12-31, a transition the polyfill's
    // getTimeZoneTransition("next") skips; a window cached before it must not reach past it
    const zones = ["Asia/Manila", "Pacific/Guam", "Pacific/Kosrae", "Pacific/Palau"];
    const instants = [
      Date.UTC(1844, 0, 1),
      Date.UTC(1850, 0, 1),
      Date.UTC(1844, 11, 30, 12),
      Date.UTC(1845, 6, 1),
    ];
    for (const zone of zones) {
      Settings.resetCaches();
      const iana = IANAZone.create(zone);
      for (const ts of instants) {
        expect(iana.offset(ts)).toBe(directOffset(zone, ts));
      }
    }
  });

  test("survive Settings.resetCaches()", () => {
    const zone = IANAZone.create("America/New_York"),
      ts = Date.UTC(2017, 6, 1);
    expect(zone.offset(ts)).toBe(-240);
    Settings.resetCaches();
    expect(IANAZone.create("America/New_York").offset(ts)).toBe(-240);
    expect(DateTime.now().zoneName).toBe("America/New_York");
  });

  test("are NaN for invalid zones and unrepresentable instants", () => {
    expect(IANAZone.create("Fantasia/Castle").offset(0)).toBe(NaN);
    expect(IANAZone.create("America/New_York").offset(NaN)).toBe(NaN);
    expect(IANAZone.create("America/New_York").offset(8.64e15 + 1)).toBe(NaN);
  });
});
