import { DateTime, Duration } from "@momentum-js/luxon";

const ROME = "Europe/Rome";

// self-contained expressions
export const today = Temporal.Now.zonedDateTimeISO().round({ smallestUnit: "millisecond", roundingMode: "floor" }).toPlainDate().toString();
export const epochYear = Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO("UTC").year;
export const parsed = Temporal.Instant.from("2017-05-15T09:24:15.123+02:00").toZonedDateTimeISO(Temporal.Now.timeZoneId()).epochMilliseconds;
export const inRome = Temporal.Instant.fromEpochMilliseconds(1494833055123).toZonedDateTimeISO(Temporal.Now.timeZoneId()).withTimeZone(ROME).hour;
export const later = Temporal.Instant.fromEpochMilliseconds(1494833055123).toZonedDateTimeISO(ROME).add({ hours: 2 }).toPlainDate().toString();
export const tomorrow = DateTime.fromMillis(1494833055123, { zone: ROME }).plus({ days: 1 }).toISODate();
export const minutes = Temporal.Duration.from({ hours: 2 }).total("minute");

// values that live in variables and cross functions
const start = DateTime.local(2017, 5, 15, 9, 0, 0, 0, { zone: ROME });
export function describe(d: DateTime): string {
  return `${d.toFormat("yyyy-MM-dd")} at ${d.hour}h, offset ${d.offset.toFixed(1)}`;
}
export const before = start < start.plus({ minutes: 1 });
export const payload = JSON.stringify({ start });
export const text = describe(start);

const decoy = { plus: (x: number) => x + 1, year: 3 };
export const untouched = decoy.plus(decoy.year);
