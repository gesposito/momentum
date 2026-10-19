import { DateTime, Duration } from "@momentum-js/momentum";

const ROME = "Europe/Rome";

// self-contained expressions
export const today = DateTime.now().toISODate();
export const epochYear = DateTime.fromMillis(0, { zone: "UTC" }).year;
export const parsed = DateTime.fromISO("2017-05-15T09:24:15.123+02:00").toMillis();
export const inRome = DateTime.fromMillis(1494833055123).setZone(ROME).hour;
export const later = DateTime.fromMillis(1494833055123, { zone: ROME }).plus({ hours: 2 }).toISODate();
export const tomorrow = DateTime.fromMillis(1494833055123, { zone: ROME }).plus({ days: 1 }).toISODate();
export const minutes = Duration.fromObject({ hours: 2 }).as("minutes");

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
