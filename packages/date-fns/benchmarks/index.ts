// date-fns against the Temporal expressions the migration tool rewrites it to, with mitata.
// date-fns is the published package, as a project would have it; the Temporal side is the text
// @momentum-js/migrate emits (packages/migrate/src/dateFns.ts): a Date in, read as a ZonedDateTime
// in the system zone, the work done there, a Date out, on the runtime's native Temporal.
//
//   bun run benchmark:date-fns          on Bun
//   bun run benchmark:date-fns:node     on Node
//
// Each case is a group of two benches. After mitata's own report, a table of the averages and
// the ratios (date-fns's time over Temporal's, so above 1 means the rewrite is faster) follows,
// in the shape packages/date-fns/README.md uses.

import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  differenceInDays,
  differenceInHours,
  endOfDay,
  format,
  formatISO,
  getDate,
  getHours,
  getMonth,
  getTime,
  getYear,
  isAfter,
  isSameDay,
  isToday,
  parseISO,
  setHours,
  startOfDay,
  startOfMonth,
  startOfToday,
  startOfWeek,
} from "date-fns";
import { bench, group, run, summary } from "mitata";

const ms = 1494847455123; // 2017-05-15T09:24:15.123Z
const d = new Date(ms);
const e = new Date(ms + 50 * 36e5);

const cases: [string, () => unknown, () => unknown][] = [
  [
    'parseISO("2017-05-15T09:24:15.123Z")',
    () => parseISO("2017-05-15T09:24:15.123Z"),
    () =>
      new Date(
        Temporal.Instant.from("2017-05-15T09:24:15.123Z").toZonedDateTimeISO(
          Temporal.Now.timeZoneId()
        ).epochMilliseconds
      ),
  ],
  [
    'parseISO("2017-05-15T09:24:15")',
    () => parseISO("2017-05-15T09:24:15"),
    () =>
      new Date(
        Temporal.PlainDateTime.from("2017-05-15T09:24:15").toZonedDateTime(
          Temporal.Now.timeZoneId()
        ).epochMilliseconds
      ),
  ],
  [
    "getHours(d)",
    () => getHours(d),
    () =>
      Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(
        Temporal.Now.timeZoneId()
      ).hour,
  ],
  [
    "getYear(d), getMonth(d), getDate(d), getHours(d)",
    () => getYear(d) + getMonth(d) + getDate(d) + getHours(d),
    () =>
      Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(
        Temporal.Now.timeZoneId()
      ).year +
      (Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(
        Temporal.Now.timeZoneId()
      ).month -
        1) +
      Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(
        Temporal.Now.timeZoneId()
      ).day +
      Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(
        Temporal.Now.timeZoneId()
      ).hour,
  ],
  [
    "setHours(d, 3)",
    () => setHours(d, 3),
    () =>
      new Date(
        Temporal.Instant.fromEpochMilliseconds(d.getTime())
          .toZonedDateTimeISO(Temporal.Now.timeZoneId())
          .with({ hour: 3 }, { offset: "ignore" }).epochMilliseconds
      ),
  ],
  [
    "addDays(d, 1)",
    () => addDays(d, 1),
    () =>
      new Date(
        Temporal.Instant.fromEpochMilliseconds(d.getTime())
          .toZonedDateTimeISO(Temporal.Now.timeZoneId())
          .add({ days: 1 }).epochMilliseconds
      ),
  ],
  [
    "addMonths(d, 1)",
    () => addMonths(d, 1),
    () =>
      new Date(
        Temporal.Instant.fromEpochMilliseconds(d.getTime())
          .toZonedDateTimeISO(Temporal.Now.timeZoneId())
          .add({ months: 1 }).epochMilliseconds
      ),
  ],
  [
    "startOfDay(d)",
    () => startOfDay(d),
    () =>
      new Date(
        Temporal.Instant.fromEpochMilliseconds(d.getTime())
          .toZonedDateTimeISO(Temporal.Now.timeZoneId())
          .startOfDay().epochMilliseconds
      ),
  ],
  [
    "endOfDay(d)",
    () => endOfDay(d),
    () =>
      new Date(
        Temporal.Instant.fromEpochMilliseconds(d.getTime())
          .toZonedDateTimeISO(Temporal.Now.timeZoneId())
          .with(
            { hour: 23, minute: 59, second: 59, millisecond: 999, microsecond: 0, nanosecond: 0 },
            { offset: "ignore" }
          ).epochMilliseconds
      ),
  ],
  [
    "startOfMonth(d)",
    () => startOfMonth(d),
    () =>
      new Date(
        Temporal.Instant.fromEpochMilliseconds(d.getTime())
          .toZonedDateTimeISO(Temporal.Now.timeZoneId())
          .toPlainDate()
          .with({ day: 1 })
          .toZonedDateTime(Temporal.Now.timeZoneId()).epochMilliseconds
      ),
  ],
  [
    "startOfWeek(d)",
    () => startOfWeek(d),
    () =>
      new Date(
        Temporal.Instant.fromEpochMilliseconds(d.getTime())
          .toZonedDateTimeISO(Temporal.Now.timeZoneId())
          .toPlainDate()
          .subtract({
            days:
              Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(
                Temporal.Now.timeZoneId()
              ).dayOfWeek % 7,
          })
          .toZonedDateTime(Temporal.Now.timeZoneId()).epochMilliseconds
      ),
  ],
  [
    "isAfter(e, d)",
    () => isAfter(e, d),
    () =>
      Temporal.ZonedDateTime.compare(
        Temporal.Instant.fromEpochMilliseconds(e.getTime()).toZonedDateTimeISO(
          Temporal.Now.timeZoneId()
        ),
        Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(
          Temporal.Now.timeZoneId()
        )
      ) > 0,
  ],
  [
    "isSameDay(d, e)",
    () => isSameDay(d, e),
    () =>
      Temporal.Instant.fromEpochMilliseconds(d.getTime())
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .toPlainDate()
        .equals(
          Temporal.Instant.fromEpochMilliseconds(e.getTime())
            .toZonedDateTimeISO(Temporal.Now.timeZoneId())
            .toPlainDate()
        ),
  ],
  [
    "differenceInHours(e, d)",
    () => differenceInHours(e, d),
    () =>
      Math.trunc(
        (Temporal.Instant.fromEpochMilliseconds(e.getTime()).toZonedDateTimeISO(
          Temporal.Now.timeZoneId()
        ).epochMilliseconds -
          Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(
            Temporal.Now.timeZoneId()
          ).epochMilliseconds) /
          3600000
      ) || 0,
  ],
  [
    "differenceInCalendarDays(e, d)",
    () => differenceInCalendarDays(e, d),
    () =>
      Temporal.Instant.fromEpochMilliseconds(e.getTime())
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .toPlainDate()
        .since(
          Temporal.Instant.fromEpochMilliseconds(d.getTime())
            .toZonedDateTimeISO(Temporal.Now.timeZoneId())
            .toPlainDate()
        ).days,
  ],
  [
    "differenceInDays(e, d)",
    () => differenceInDays(e, d),
    () =>
      Temporal.Instant.fromEpochMilliseconds(e.getTime())
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .since(
          Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(
            Temporal.Now.timeZoneId()
          ),
          { largestUnit: "days" }
        ).days,
  ],
  [
    "getTime(d)",
    () => getTime(d),
    () =>
      Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(
        Temporal.Now.timeZoneId()
      ).epochMilliseconds,
  ],
  [
    "formatISO(d)",
    () => formatISO(d),
    () =>
      Temporal.Instant.fromEpochMilliseconds(d.getTime())
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .toString({ smallestUnit: "second", timeZoneName: "never" }),
  ],
  [
    'format(d, "yyyy-MM-dd")',
    () => format(d, "yyyy-MM-dd"),
    () =>
      Temporal.Instant.fromEpochMilliseconds(d.getTime())
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .toPlainDate()
        .toString(),
  ],
  [
    'format(d, "HH:mm")',
    () => format(d, "HH:mm"),
    () =>
      Temporal.Instant.fromEpochMilliseconds(d.getTime())
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .toPlainTime()
        .toString({ smallestUnit: "minute" }),
  ],
  [
    "startOfToday()",
    () => startOfToday(),
    () =>
      new Date(
        Temporal.Now.plainDateISO().toZonedDateTime(Temporal.Now.timeZoneId()).epochMilliseconds
      ),
  ],
  [
    "isToday(d)",
    () => isToday(d),
    () =>
      Temporal.Instant.fromEpochMilliseconds(d.getTime())
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .toPlainDate()
        .equals(Temporal.Now.plainDateISO()),
  ],
];

for (const [title, dateFnsCase, temporalCase] of cases) {
  group(title, () => {
    summary(() => {
      bench(`date-fns: ${title}`, dateFnsCase);
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
const formatTime = (ns: number) =>
  ns >= 1000 ? `${(ns / 1000).toFixed(1)} µs` : `${ns.toFixed(0)} ns`;
if (averages.size > 0) {
  console.log("\n| Case | date-fns | Temporal | Ratio |\n| --- | --- | --- | --- |");
  for (const [title] of cases) {
    const a = averages.get(`date-fns: ${title}`);
    const t = averages.get(`temporal: ${title}`);
    if (a !== undefined && t !== undefined)
      console.log(
        `| \`${title}\` | ${formatTime(a)} | ${formatTime(t)} | ${(a / t).toFixed(a / t < 0.1 ? 2 : 1)}× |`
      );
  }
}
