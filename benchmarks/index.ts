// Port of luxon's benchmark suites (benchmarks/datetime.js and benchmarks/info.js) to mitata.
// Runs against the built bundle (build/momentum.js), so it works on Bun and on Node alike.
//
//   bun run benchmark                       momentum on the runtime's native Temporal
//   bun run benchmark:compare               the same cases for momentum and luxon side by side
//   bun run benchmark:node                  the comparison on Node (node --expose-gc for GC stats)
//   MOMENTUM_TEMPORAL=polyfill ...          momentum on top of temporal-polyfill

import { bench, group, run, summary } from "mitata";

if (process.env.MOMENTUM_TEMPORAL === "polyfill") {
  const { Temporal } = await import("temporal-polyfill/implementation");
  (globalThis as { Temporal?: unknown }).Temporal = Temporal;
}

const momentum = await import("../build/momentum.js").catch(() => {
  throw new Error("build/momentum.js is missing; run `bun run build` first");
});

type Lib = Pick<typeof momentum, "DateTime" | "Settings" | "Info">;

const compare = process.argv.includes("--compare");
const libs: [string, Lib][] = [["momentum", momentum]];
if (compare) {
  libs.push(["luxon", (await import("luxon")) as unknown as Lib]);
}

function dateTimeCases({ DateTime, Settings }: Lib): [string, () => unknown][] {
  const dt = DateTime.now();
  const formatParser = DateTime.buildFormatParser("yyyy/MM/dd HH:mm:ss.SSS");
  return [
    ["DateTime.now", () => DateTime.now()],
    ["DateTime.fromObject with locale", () => DateTime.fromObject({}, { locale: "fr" })],
    ["DateTime.local with numbers", () => DateTime.local(2017, 5, 15)],
    [
      "DateTime.local with numbers and zone",
      () => DateTime.local(2017, 5, 15, 11, 7, 35, { zone: "America/New_York" }),
    ],
    ["DateTime.fromISO", () => DateTime.fromISO("1982-05-25T09:10:11.445Z")],
    ["DateTime.fromSQL", () => DateTime.fromSQL("2016-05-14 10:23:54.2346")],
    [
      "DateTime.fromFormat",
      () => DateTime.fromFormat("1982/05/25 09:10:11.445", "yyyy/MM/dd HH:mm:ss.SSS"),
    ],
    [
      "DateTime.fromFormat with zone",
      () =>
        DateTime.fromFormat("1982/05/25 09:10:11.445", "yyyy/MM/dd HH:mm:ss.SSS", {
          zone: "America/Los_Angeles",
        }),
    ],
    [
      "DateTime.fromFormatParser",
      () => DateTime.fromFormatParser("1982/05/25 09:10:11.445", formatParser as never),
    ],
    [
      "DateTime.fromFormatParser with zone",
      () =>
        DateTime.fromFormatParser("1982/05/25 09:10:11.445", formatParser as never, {
          zone: "America/Los_Angeles",
        }),
    ],
    ["DateTime#setZone", () => dt.setZone("America/Los_Angeles")],
    ["DateTime#toFormat", () => dt.toFormat("yyyy-MM-dd")],
    ["DateTime#toFormat with macro", () => dt.toFormat("T")],
    [
      "DateTime#toFormat with macro no cache",
      () => {
        dt.toFormat("T");
        Settings.resetCaches();
      },
    ],
    ["DateTime#format in german", () => dt.setLocale("de-De").toFormat("d. LLL. HH:mm")],
    [
      "DateTime#format in german and no-cache",
      () => {
        dt.setLocale("de-De").toFormat("d. LLL. HH:mm");
        Settings.resetCaches();
      },
    ],
    ["DateTime#add", () => dt.plus({ milliseconds: 3434 })],
    ["DateTime#toISO", () => dt.toISO()],
    ["DateTime#toLocaleString", () => dt.toLocaleString()],
    ["DateTime#toLocaleString in utc", () => dt.toUTC().toLocaleString()],
    [
      "DateTime#toRelativeCalendar",
      () => dt.toRelativeCalendar({ base: DateTime.now(), locale: "fi" }),
    ],
  ];
}

function infoCases({ DateTime, Info }: Lib): [string, () => unknown][] {
  // both libraries keep the Locale object on the DateTime as `loc`
  const locale = (DateTime.now() as unknown as { loc: unknown }).loc as never;
  return [
    ["Info.months with existing locale", () => Info.months("long", { locObj: locale })],
    ["Info.months", () => Info.months("long")],
    ["Info.monthsFormat with existing locale", () => Info.monthsFormat("long", { locObj: locale })],
    ["Info.monthsFormat", () => Info.monthsFormat("long")],
    ["Info.weekdays with existing locale", () => Info.weekdays("long", { locObj: locale })],
    ["Info.weekdays", () => Info.weekdays("long")],
    [
      "Info.weekdaysFormat with existing locale",
      () => Info.weekdaysFormat("long", { locObj: locale }),
    ],
    ["Info.weekdaysFormat", () => Info.weekdaysFormat("long")],
  ];
}

const cases = libs.map(([name, lib]) => ({
  name,
  cases: [...dateTimeCases(lib), ...infoCases(lib)],
}));

for (let i = 0; i < cases[0].cases.length; i++) {
  const title = cases[0].cases[i][0];
  if (compare) {
    group(title, () => {
      summary(() => {
        for (const { name, cases: libCases } of cases) {
          bench(`${name}: ${title}`, libCases[i][1]);
        }
      });
    });
  } else {
    bench(title, cases[0].cases[i][1]);
  }
}

await run();
