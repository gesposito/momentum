// Day.js against the Temporal expressions the migration tool rewrites it to, with mitata. Day.js
// is the published package with its utc and timezone plugins, as a project would have it; the
// Temporal side is the text @momentum-js/migrate emits (packages/migrate/src/dayjs.ts), on the
// runtime's native Temporal.
//
//   bun run benchmark:dayjs          on Bun
//   bun run benchmark:dayjs:node     on Node
//
// Each case is a group of two benches. After mitata's own report, a table of the averages and
// the ratios (Day.js's time over Temporal's, so above 1 means the rewrite is faster) follows,
// in the shape packages/dayjs/README.md uses.

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { bench, group, run, summary } from "mitata";

dayjs.extend(utc);
dayjs.extend(timezone);

const ms = 1494847455123; // 2017-05-15T09:24:15.123Z
const zone = Temporal.Now.timeZoneId();
const d = dayjs(ms);
const d2 = dayjs(ms + 50 * 36e5);
const z = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);
const z2 = Temporal.Instant.fromEpochMilliseconds(ms + 50 * 36e5).toZonedDateTimeISO(zone);

const cases: [string, () => unknown, () => unknown][] = [
  [
    "dayjs()",
    () => dayjs(),
    () =>
      Temporal.Now.zonedDateTimeISO().round({ smallestUnit: "millisecond", roundingMode: "floor" }),
  ],
  [
    "dayjs(ms)",
    () => dayjs(ms),
    () => Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(Temporal.Now.timeZoneId()),
  ],
  [
    'dayjs("2017-05-15T09:24:15.123Z")',
    () => dayjs("2017-05-15T09:24:15.123Z"),
    () =>
      Temporal.Instant.from("2017-05-15T09:24:15.123Z").toZonedDateTimeISO(
        Temporal.Now.timeZoneId()
      ),
  ],
  [
    'dayjs("2017-05-15T09:24:15")',
    () => dayjs("2017-05-15T09:24:15"),
    () =>
      Temporal.PlainDateTime.from("2017-05-15T09:24:15").toZonedDateTime(Temporal.Now.timeZoneId()),
  ],
  [
    'dayjs.utc("2017-05-15T09:24:15.123Z")',
    () => dayjs.utc("2017-05-15T09:24:15.123Z"),
    () => Temporal.Instant.from("2017-05-15T09:24:15.123Z").toZonedDateTimeISO("UTC"),
  ],
  [
    'dayjs.tz("2017-05-15 09:24", "Asia/Tokyo")',
    () => dayjs.tz("2017-05-15 09:24", "Asia/Tokyo"),
    () => Temporal.PlainDateTime.from("2017-05-15 09:24").toZonedDateTime("Asia/Tokyo"),
  ],
  [
    "dayjs(ms).hour()",
    () => dayjs(ms).hour(),
    () =>
      Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(Temporal.Now.timeZoneId()).hour,
  ],
  [
    "year(), month(), date(), hour()",
    () => d.year() + d.month() + d.date() + d.hour(),
    () => z.year + (z.month - 1) + z.day + z.hour,
  ],
  ["hour(3)", () => d.hour(3), () => z.with({ hour: 3 }, { offset: "ignore" })],
  ['add(1, "day")', () => d.add(1, "day"), () => z.add({ days: 1 })],
  ['add(1, "month")', () => d.add(1, "month"), () => z.add({ months: 1 })],
  ['startOf("day")', () => d.startOf("day"), () => z.startOfDay()],
  [
    'endOf("day")',
    () => d.endOf("day"),
    () =>
      z.with(
        { hour: 23, minute: 59, second: 59, millisecond: 999, microsecond: 0, nanosecond: 0 },
        { offset: "ignore" }
      ),
  ],
  ["isBefore(other)", () => d.isBefore(d2), () => Temporal.ZonedDateTime.compare(z, z2) < 0],
  [
    'diff(other, "hour")',
    () => d2.diff(d, "hour"),
    () => Math.trunc((z2.epochMilliseconds - z.epochMilliseconds) / 3600000),
  ],
  ["valueOf()", () => d.valueOf(), () => z.epochMilliseconds],
  [
    "toISOString()",
    () => d.toISOString(),
    () => z.toInstant().toString({ fractionalSecondDigits: 3 }),
  ],
  ['format("YYYY-MM-DD")', () => d.format("YYYY-MM-DD"), () => z.toPlainDate().toString()],
  [
    'format("HH:mm")',
    () => d.format("HH:mm"),
    () => z.toPlainTime().toString({ smallestUnit: "minute" }),
  ],
  ["utc()", () => d.utc(), () => z.withTimeZone("UTC")],
  ['tz("Asia/Tokyo")', () => d.tz("Asia/Tokyo"), () => z.withTimeZone("Asia/Tokyo")],
  [
    'tz("Asia/Tokyo").hour()',
    () => d.tz("Asia/Tokyo").hour(),
    () => z.withTimeZone("Asia/Tokyo").hour,
  ],
];

for (const [title, dayjsCase, temporalCase] of cases) {
  group(title, () => {
    summary(() => {
      bench(`dayjs: ${title}`, dayjsCase);
      bench(`temporal: ${title}`, temporalCase);
    });
  });
}

const result = await run();

// the table for the README
const averages = new Map<string, number>();
for (const b of (result as { benchmarks?: any[] }).benchmarks ?? []) {
  const avg = b.runs?.[0]?.stats?.avg;
  if (typeof avg === "number") averages.set(b.alias, avg);
}
const format = (ns: number) =>
  ns >= 1000 ? `${(ns / 1000).toFixed(1)} µs` : `${ns.toFixed(0)} ns`;
if (averages.size > 0) {
  console.log("\n| Case | Day.js | Temporal | Ratio |\n| --- | --- | --- | --- |");
  for (const [title] of cases) {
    const a = averages.get(`dayjs: ${title}`);
    const t = averages.get(`temporal: ${title}`);
    if (a !== undefined && t !== undefined)
      console.log(
        `| \`${title}\` | ${format(a)} | ${format(t)} | ${(a / t).toFixed(a / t < 0.1 ? 2 : 1)}× |`
      );
  }
}
