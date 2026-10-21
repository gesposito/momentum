// The date-fns part of the migration catalog: what replaces date-fns's functions in native Temporal
// code. date-fns works on plain Dates in the system zone, through Date's local-time setters, which
// resolve a skipped or repeated wall-clock time like Temporal's "compatible" disambiguation. A call
// becomes an expression that reads its Date into a Temporal.ZonedDateTime in the system zone and,
// where date-fns returns a Date, gives a Date back, so the rest of the program is untouched; a call
// nested in another composes through the ZonedDateTime (Arg.zoned), and a self-contained chain ends
// in plain Temporal. Exactness is checked against date-fns itself by
// packages/migrate/test/migrateDateFns.test.js.

import type { Arg, ClassName, Context, Outcome, RuleKit } from "./rules.js";
import type { DifferenceId } from "./differences.js";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const isoWallClock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A Date argument as the analyzer sees it, turned into a ZonedDateTime in the system zone. */
interface Read {
  zdt: string;
  differences: DifferenceId[];
}

export function defineDateFnsRules(kit: RuleKit) {
  const { staticCall, unsupported, rewrite, none, str, temporal } = kit;
  const owner: ClassName = "DateFns";
  const zone = "Temporal.Now.timeZoneId()";
  const ignoreOffset = (q: string) => `{ offset: ${str("ignore", q)} }`;
  const endOfDayFields =
    "hour: 23, minute: 59, second: 59, millisecond: 999, microsecond: 0, nanosecond: 0";

  /** The ZonedDateTime for a Date or timestamp argument, or null when nothing is known about it. */
  function read(arg: Arg | undefined): Read | null {
    if (arg === undefined) return null;
    if (arg.zoned !== undefined) return { zdt: arg.zoned, differences: [] };
    const v = arg.value;
    const at = (ms: string) =>
      `Temporal.Instant.fromEpochMilliseconds(${ms}).toZonedDateTimeISO(${zone})`;
    // an Invalid Date comes back as NaN from date-fns, where Temporal throws
    if (v.kind === "dynamic" && v.type === "date")
      return { zdt: at(`${arg.text}.getTime()`), differences: ["invalid-throws"] };
    if (v.kind === "number")
      return Number.isFinite(v.value) && Math.abs(v.value) <= 8.64e15
        ? { zdt: at(String(Math.trunc(v.value))), differences: [] }
        : null;
    if (v.kind === "dynamic" && v.type === "number")
      return { zdt: at(arg.text), differences: ["invalid-throws", "fractional-amounts"] };
    return null;
  }
  const unreadable = (what = "the date") =>
    none(
      `${what} is not known to be a Date or a timestamp (a TZDate, a string or an unknown value)`
    );

  /** A rewrite that yields a Date made from `zdt`, which a nested date-fns call can take as it is. */
  const asDate = (zdt: string, differences: readonly DifferenceId[]): Outcome => ({
    kind: "rewrite",
    text: `new Date(${zdt}.epochMilliseconds)`,
    differences: [...new Set(differences)],
    precedence: "member",
    zoned: zdt,
  });

  /** An options argument the rewrite can ignore: absent, or a literal without the keys given. */
  function plainOptions(arg: Arg | undefined, keys: readonly string[] = []): boolean {
    if (arg === undefined || arg.value.kind === "undefined") return true;
    if (arg.value.kind !== "object") return false;
    return Object.keys(arg.value.props).every((k) => keys.includes(k) || k === "in") === false
      ? false
      : !("in" in arg.value.props);
  }
  /** A literal option's value, when the options are a literal; undefined when absent. */
  function option(arg: Arg | undefined, key: string): Arg | undefined {
    return arg?.value.kind === "object" ? arg.value.props[key] : undefined;
  }
  const inOption = () =>
    none(
      "the `in` option (a TZDate context) has no counterpart yet: the rewrite keeps the system zone"
    );

  /**
   * The trailing options every date-fns function takes, at `index` of the call's arguments: null
   * when absent or an object literal without `in` (the rule reads the keys it supports from it),
   * otherwise the outcome that stops the rewrite; a dynamic options object may carry `in`.
   */
  function optionsCheck(args: readonly Arg[], index: number): Outcome | null {
    const opts = args[index];
    if (opts === undefined || opts.value.kind === "undefined") return null;
    if (opts.value.kind !== "object") return none("the options are not a literal");
    if ("in" in opts.value.props) return inOption();
    return null;
  }

  /**
   * `fn(date, ...values, options?)` with a Date argument: the rewrite from its ZonedDateTime.
   * `values` counts the arguments between the date and the options (an amount, a pattern).
   */
  function dated(
    name: string,
    doc: string,
    apply: (ctx: Context, zdt: string, rest: readonly Arg[]) => Outcome | null,
    { values = 0 }: { values?: number } = {}
  ) {
    staticCall(owner, name, doc, (ctx) => {
      const [date, ...rest] = ctx.args;
      const r = read(date);
      if (r === null) return unreadable();
      const o = optionsCheck(ctx.args, 1 + values) ?? apply(ctx, r.zdt, rest);
      if (o === null || o.kind === "none") return o ?? none("not rewritten");
      return { ...o, differences: [...new Set([...r.differences, ...o.differences])] };
    });
  }

  /** An integer amount: its text, with the difference a dynamic one carries. */
  function amount(arg: Arg | undefined): { text: string; differences: DifferenceId[] } | null {
    if (arg === undefined) return null;
    const v = arg.value;
    if (v.kind === "number")
      return Number.isInteger(v.value) ? { text: String(v.value), differences: [] } : null;
    if (v.kind === "dynamic" && v.type === "number")
      return { text: arg.text, differences: ["fractional-amounts", "invalid-throws"] };
    return null;
  }
  const scaled = (a: { text: string }, factor: number) =>
    /^-?\d+$/.test(a.text) ? String(Number(a.text) * factor) : `${a.text} * ${factor}`;

  // --- add and subtract

  const unitOf: Record<string, [string, number]> = {
    Milliseconds: ["milliseconds", 1],
    Seconds: ["seconds", 1],
    Minutes: ["minutes", 1],
    Hours: ["hours", 1],
    Days: ["days", 1],
    Weeks: ["weeks", 1],
    Months: ["months", 1],
    Quarters: ["months", 3],
    Years: ["years", 1],
  };
  for (const [suffix, [unit, factor]] of Object.entries(unitOf)) {
    for (const [prefix, op] of [
      ["add", "add"],
      ["sub", "subtract"],
    ] as const) {
      const name = `${prefix}${suffix}`;
      dated(
        name,
        `\`.${op}({ ${unit}: ${factor === 1 ? "n" : `n * ${factor}`} })\` (exact for whole amounts; a fractional or NaN amount differs: fractional-amounts, invalid-throws)`,
        (ctx, zdt, rest) => {
          const n = amount(rest[0]);
          if (n === null) return none("the amount is not a whole number");
          if (rest.length > 1 && !plainOptions(rest[1])) return inOption();
          return asDate(`${zdt}.${op}({ ${unit}: ${scaled(n, factor)} })`, n.differences);
        },
        { values: 1 }
      );
    }
  }
  for (const [name, op] of [
    ["add", "add"],
    ["sub", "subtract"],
  ] as const) {
    dated(
      name,
      `\`.${op}({ years, months, weeks, days, hours, minutes, seconds })\` from a duration literal (exact for whole amounts; months with days differ: date-fns-dst-steps)`,
      (ctx, zdt, rest) => {
        const [duration, opts] = rest;
        if (duration?.value.kind !== "object") return none("the duration is not an object literal");
        if (!plainOptions(opts)) return inOption();
        const entries: string[] = [];
        const differences: DifferenceId[] = [];
        const signs = new Set<number>();
        for (const [key, value] of Object.entries(duration.value.props)) {
          if (!["years", "months", "weeks", "days", "hours", "minutes", "seconds"].includes(key))
            return none(`the duration field ${key} has no counterpart`);
          const n = amount(value);
          if (n === null) return none(`the amount of ${key} is not a whole number`);
          if (/^-?\d+$/.test(n.text) && Number(n.text) !== 0) signs.add(Math.sign(Number(n.text)));
          entries.push(`${key}: ${n.text}`);
          differences.push(...n.differences);
        }
        // date-fns adds each field in turn; a Temporal duration takes one sign for all of them
        if (signs.size > 1)
          return none("the duration mixes signs, which a Temporal duration cannot");
        // an empty duration is the date itself, where Temporal's add({}) throws
        if (entries.length === 0) return asDate(zdt, differences);
        // date-fns adds the months, then the days: a skipped time in between shifts the result
        const keys = Object.keys(duration.value.props);
        if (
          keys.some((k) => k === "years" || k === "months") &&
          keys.some((k) => k === "weeks" || k === "days")
        )
          differences.push("date-fns-dst-steps");
        return asDate(`${zdt}.${op}({ ${entries.join(", ")} })`, differences);
      },
      { values: 1 }
    );
  }

  // --- the starts and ends of units

  const withFields = (zdt: string, fields: string, q: string) =>
    `${zdt}.with({ ${fields} }, ${ignoreOffset(q)})`;
  const startOfDate = (date: string) => `${date}.toZonedDateTime(${zone})`;
  const timeStarts: Record<string, string> = {
    Hour: "minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0",
    Minute: "second: 0, millisecond: 0, microsecond: 0, nanosecond: 0",
    Second: "millisecond: 0, microsecond: 0, nanosecond: 0",
  };
  const timeEnds: Record<string, string> = {
    Hour: "minute: 59, second: 59, millisecond: 999, microsecond: 0, nanosecond: 0",
    Minute: "second: 59, millisecond: 999, microsecond: 0, nanosecond: 0",
    Second: "millisecond: 999, microsecond: 0, nanosecond: 0",
  };
  for (const unit of Object.keys(timeStarts)) {
    dated(
      `startOf${unit}`,
      `\`.with({ ${timeStarts[unit]} }, { offset: "ignore" })\` (exact)`,
      (ctx, zdt) => asDate(withFields(zdt, timeStarts[unit], ctx.quote), [])
    );
    dated(
      `endOf${unit}`,
      `\`.with({ ${timeEnds[unit]} }, { offset: "ignore" })\` (exact)`,
      (ctx, zdt) => asDate(withFields(zdt, timeEnds[unit], ctx.quote), [])
    );
  }
  dated("startOfDay", "`.startOfDay()` (exact)", (ctx, zdt) => asDate(`${zdt}.startOfDay()`, []));
  dated(
    "endOfDay",
    '`.with({ hour: 23, minute: 59, ... }, { offset: "ignore" })` (exact)',
    (ctx, zdt) => asDate(withFields(zdt, endOfDayFields, ctx.quote), [])
  );
  dated(
    "startOfMonth",
    "`.toPlainDate().with({ day: 1 }).toZonedDateTime(zone)` (exact)",
    (ctx, zdt) => asDate(startOfDate(`${zdt}.toPlainDate().with({ day: 1 })`), [])
  );
  dated(
    "endOfMonth",
    '`.with({ day: x.daysInMonth, hour: 23, ... }, { offset: "ignore" })` (exact)',
    (ctx, zdt) =>
      asDate(withFields(zdt, `day: ${zdt}.daysInMonth, ${endOfDayFields}`, ctx.quote), [])
  );
  dated(
    "lastDayOfMonth",
    "`.toPlainDate().with({ day: x.daysInMonth }).toZonedDateTime(zone)` (exact)",
    (ctx, zdt) => asDate(startOfDate(`${zdt}.toPlainDate().with({ day: ${zdt}.daysInMonth })`), [])
  );
  dated(
    "startOfYear",
    "`.toPlainDate().with({ month: 1, day: 1 }).toZonedDateTime(zone)` (exact)",
    (ctx, zdt) => asDate(startOfDate(`${zdt}.toPlainDate().with({ month: 1, day: 1 })`), [])
  );
  dated(
    "endOfYear",
    '`.with({ month: 12, day: 31, hour: 23, ... }, { offset: "ignore" })` (exact)',
    (ctx, zdt) => asDate(withFields(zdt, `month: 12, day: 31, ${endOfDayFields}`, ctx.quote), [])
  );
  dated(
    "lastDayOfYear",
    "`.toPlainDate().with({ month: 12, day: 31 }).toZonedDateTime(zone)` (exact)",
    (ctx, zdt) => asDate(startOfDate(`${zdt}.toPlainDate().with({ month: 12, day: 31 })`), [])
  );
  const quarterIndex = (zdt: string) => `Math.floor((${zdt}.month - 1) / 3)`;
  const quarterStart = (zdt: string) => `${quarterIndex(zdt)} * 3 + 1`;
  dated(
    "startOfQuarter",
    "`.toPlainDate().with({ month: first of the quarter, day: 1 }).toZonedDateTime(zone)` (exact)",
    (ctx, zdt) =>
      asDate(startOfDate(`${zdt}.toPlainDate().with({ month: ${quarterStart(zdt)}, day: 1 })`), [])
  );
  dated(
    "endOfQuarter",
    '`.with({ month: last of the quarter, day: 31, hour: 23, ... }, { offset: "ignore" })` (exact)',
    (ctx, zdt) =>
      asDate(
        withFields(zdt, `month: ${quarterStart(zdt)} + 2, day: 31, ${endOfDayFields}`, ctx.quote),
        []
      )
  );
  dated(
    "lastDayOfQuarter",
    "`.toPlainDate().with({ month: last of the quarter, day: 31 }).toZonedDateTime(zone)` (exact)",
    (ctx, zdt) =>
      asDate(
        startOfDate(`${zdt}.toPlainDate().with({ month: ${quarterStart(zdt)} + 2, day: 31 })`),
        []
      )
  );
  const decade = (zdt: string) => `Math.floor(${zdt}.year / 10) * 10`;
  dated(
    "startOfDecade",
    "`.toPlainDate().with({ year: the decade, month: 1, day: 1 })` (exact)",
    (ctx, zdt) =>
      asDate(
        startOfDate(`${zdt}.toPlainDate().with({ year: ${decade(zdt)}, month: 1, day: 1 })`),
        []
      )
  );
  dated(
    "endOfDecade",
    "`.with({ year: the decade + 9, month: 12, day: 31, hour: 23, ... })` (exact)",
    (ctx, zdt) =>
      asDate(
        withFields(
          zdt,
          `year: ${decade(zdt)} + 9, month: 12, day: 31, ${endOfDayFields}`,
          ctx.quote
        ),
        []
      )
  );
  dated(
    "lastDayOfDecade",
    "`.toPlainDate().with({ year: the decade + 9, month: 12, day: 31 })` (exact)",
    (ctx, zdt) =>
      asDate(
        startOfDate(`${zdt}.toPlainDate().with({ year: ${decade(zdt)} + 9, month: 12, day: 31 })`),
        []
      )
  );

  /** The week start a call uses, from its options literal or date-fns's default, Sunday. */
  function weekStart(ctx: Context, opts: Arg | undefined): number | Outcome {
    if (ctx.facts.settings.has("date-fns:defaultOptions"))
      return none("the project calls setDefaultOptions, which may change weekStartsOn");
    if (opts === undefined || opts.value.kind === "undefined") return 0;
    if (opts.value.kind !== "object") return none("the options are not a literal");
    if ("in" in opts.value.props) return inOption();
    if ("locale" in opts.value.props) return none("a locale sets the week start");
    const w = opts.value.props.weekStartsOn;
    if (w === undefined) return 0;
    if (
      w.value.kind === "number" &&
      Number.isInteger(w.value.value) &&
      w.value.value >= 0 &&
      w.value.value <= 6
    )
      return w.value.value;
    return none("weekStartsOn is not a literal from 0 to 6");
  }
  /** Days back to the week's first day, given the start of the week (0 = Sunday). */
  const daysIntoWeek = (zdt: string, w: number) =>
    w === 0
      ? `${zdt}.dayOfWeek % 7`
      : w === 1
        ? `${zdt}.dayOfWeek - 1`
        : `(${zdt}.dayOfWeek % 7 + ${7 - w}) % 7`;
  const weekStartDate = (zdt: string, w: number) =>
    `${zdt}.toPlainDate().subtract({ days: ${daysIntoWeek(zdt, w)} })`;
  for (const [name, iso] of [
    ["startOfWeek", false],
    ["startOfISOWeek", true],
  ] as const) {
    dated(
      name,
      "`.toPlainDate().subtract({ days: into the week }).toZonedDateTime(zone)` (exact)",
      (ctx, zdt, rest) => {
        const w = iso ? 1 : weekStart(ctx, rest[0]);
        if (typeof w !== "number") return w;
        return asDate(startOfDate(weekStartDate(zdt, w)), []);
      }
    );
  }
  for (const [name, iso] of [
    ["endOfWeek", false],
    ["endOfISOWeek", true],
  ] as const) {
    dated(
      name,
      "`.toPlainDate().add({ days: to the week's last day }).toZonedDateTime(zone).with({ hour: 23, ... })` (exact)",
      (ctx, zdt, rest) => {
        const w = iso ? 1 : weekStart(ctx, rest[0]);
        if (typeof w !== "number") return w;
        const end = `${zdt}.toPlainDate().add({ days: 6 - (${daysIntoWeek(zdt, w)}) })`;
        return asDate(withFields(startOfDate(end), endOfDayFields, ctx.quote), []);
      }
    );
  }
  for (const [name, iso] of [
    ["lastDayOfWeek", false],
    ["lastDayOfISOWeek", true],
  ] as const) {
    dated(
      name,
      "`.toPlainDate().add({ days: to the week's last day }).toZonedDateTime(zone)` (a skipped midnight differs: date-fns-dst-steps)",
      (ctx, zdt, rest) => {
        const w = iso ? 1 : weekStart(ctx, rest[0]);
        if (typeof w !== "number") return w;
        // date-fns sets midnight before moving the date, so a skipped midnight shifts the result
        return asDate(
          startOfDate(`${zdt}.toPlainDate().add({ days: 6 - (${daysIntoWeek(zdt, w)}) })`),
          ["date-fns-dst-steps"]
        );
      }
    );
  }
  const isoWeekYearStart = (year: string) =>
    `Temporal.PlainDate.from({ year: ${year}, month: 1, day: 4 })`;
  dated("startOfISOWeekYear", "the Monday of the week of January 4 (exact)", (ctx, zdt) => {
    const jan4 = isoWeekYearStart(`${zdt}.yearOfWeek`);
    return asDate(startOfDate(`${jan4}.subtract({ days: ${jan4}.dayOfWeek - 1 })`), []);
  });
  dated(
    "endOfISOWeekYear",
    "the Sunday before the next ISO week year, at the end of the day (a skipped midnight differs: date-fns-dst-steps)",
    (ctx, zdt) => {
      const jan4 = isoWeekYearStart(`${zdt}.yearOfWeek + 1`);
      // date-fns takes a millisecond off the next year's start, which a skipped midnight shifts
      return asDate(
        withFields(
          startOfDate(`${jan4}.subtract({ days: ${jan4}.dayOfWeek })`),
          endOfDayFields,
          ctx.quote
        ),
        ["date-fns-dst-steps"]
      );
    }
  );
  dated(
    "lastDayOfISOWeekYear",
    "the Sunday before the next ISO week year (a skipped midnight differs: date-fns-dst-steps)",
    (ctx, zdt) => {
      const jan4 = isoWeekYearStart(`${zdt}.yearOfWeek + 1`);
      // date-fns steps back a day from the next year's start, which a skipped midnight shifts
      return asDate(
        startOfDate(`${jan4}.subtract({ days: ${jan4}.dayOfWeek })`),
        ["date-fns-dst-steps"]
      );
    }
  );

  // today, tomorrow and yesterday read the clock
  const today = "Temporal.Now.plainDateISO()";
  staticCall(
    owner,
    "startOfToday",
    "`Temporal.Now.plainDateISO().toZonedDateTime(zone)` (exact)",
    (ctx) => optionsCheck(ctx.args, 0) ?? asDate(startOfDate(today), [])
  );
  staticCall(
    owner,
    "startOfTomorrow",
    "`Temporal.Now.plainDateISO().add({ days: 1 }).toZonedDateTime(zone)` (exact)",
    (ctx) => optionsCheck(ctx.args, 0) ?? asDate(startOfDate(`${today}.add({ days: 1 })`), [])
  );
  staticCall(
    owner,
    "startOfYesterday",
    "`Temporal.Now.plainDateISO().subtract({ days: 1 }).toZonedDateTime(zone)` (exact)",
    (ctx) =>
      optionsCheck(ctx.args, 0) ?? asDate(startOfDate(`${today}.subtract({ days: 1 })`), [])
  );
  staticCall(
    owner,
    "endOfToday",
    "today at 23:59:59.999 (exact)",
    (ctx) =>
      optionsCheck(ctx.args, 0) ??
      asDate(withFields(startOfDate(today), endOfDayFields, ctx.quote), [])
  );
  staticCall(
    owner,
    "endOfTomorrow",
    "tomorrow at 23:59:59.999 (exact)",
    (ctx) =>
      optionsCheck(ctx.args, 0) ??
      asDate(withFields(startOfDate(`${today}.add({ days: 1 })`), endOfDayFields, ctx.quote), [])
  );
  staticCall(
    owner,
    "endOfYesterday",
    "yesterday at 23:59:59.999 (exact)",
    (ctx) =>
      optionsCheck(ctx.args, 0) ??
      asDate(
        withFields(startOfDate(`${today}.subtract({ days: 1 })`), endOfDayFields, ctx.quote),
        []
      )
  );

  // --- getters

  const getters: Record<string, [string, (z: string) => string]> = {
    getYear: ["`.year`", (z) => `${z}.year`],
    getMonth: ["`.month - 1`", (z) => `${z}.month - 1`],
    getDate: ["`.day`", (z) => `${z}.day`],
    getDay: ["`.dayOfWeek % 7`", (z) => `${z}.dayOfWeek % 7`],
    getHours: ["`.hour`", (z) => `${z}.hour`],
    getMinutes: ["`.minute`", (z) => `${z}.minute`],
    getSeconds: ["`.second`", (z) => `${z}.second`],
    getMilliseconds: ["`.millisecond`", (z) => `${z}.millisecond`],
    getDayOfYear: ["`.dayOfYear`", (z) => `${z}.dayOfYear`],
    getDaysInMonth: ["`.daysInMonth`", (z) => `${z}.daysInMonth`],
    getDaysInYear: ["`.daysInYear`", (z) => `${z}.daysInYear`],
    getQuarter: [
      "`Math.floor((x.month - 1) / 3) + 1`",
      (z) => `Math.floor((${z}.month - 1) / 3) + 1`,
    ],
    getISODay: ["`.dayOfWeek`", (z) => `${z}.dayOfWeek`],
    getISOWeek: ["`.weekOfYear`", (z) => `${z}.weekOfYear`],
    getISOWeekYear: ["`.yearOfWeek`", (z) => `${z}.yearOfWeek`],
    getISOWeeksInYear: [
      "the ISO week of December 28 of the ISO week year",
      (z) => `Temporal.PlainDate.from({ year: ${z}.yearOfWeek, month: 12, day: 28 }).weekOfYear`,
    ],
    getDecade: ["`Math.floor(x.year / 10) * 10`", (z) => `Math.floor(${z}.year / 10) * 10`],
    getTime: ["`.epochMilliseconds`", (z) => `${z}.epochMilliseconds`],
    getUnixTime: [
      "`Math.trunc(x.epochMilliseconds / 1000)`",
      (z) => `Math.trunc(${z}.epochMilliseconds / 1000)`,
    ],
  };
  for (const [name, [doc, get]] of Object.entries(getters))
    dated(name, `${doc} (exact)`, (ctx, zdt, rest) =>
      rest.length === 0 || plainOptions(rest[0]) ? rewrite(get(zdt), [], "expression") : inOption()
    );
  dated("isLeapYear", "`.inLeapYear` (exact)", (ctx, zdt) => rewrite(`${zdt}.inLeapYear`));
  dated("isWeekend", "`.dayOfWeek >= 6` (exact)", (ctx, zdt) =>
    rewrite(`${zdt}.dayOfWeek >= 6`, [], "expression")
  );
  for (const [name, day] of [
    ["isMonday", 1],
    ["isTuesday", 2],
    ["isWednesday", 3],
    ["isThursday", 4],
    ["isFriday", 5],
    ["isSaturday", 6],
    ["isSunday", 7],
  ] as const)
    dated(name, `\`.dayOfWeek === ${day}\` (exact)`, (ctx, zdt) =>
      rewrite(`${zdt}.dayOfWeek === ${day}`, [], "expression")
    );
  dated("isFirstDayOfMonth", "`.day === 1` (exact)", (ctx, zdt) =>
    rewrite(`${zdt}.day === 1`, [], "expression")
  );
  dated("isLastDayOfMonth", "`.day === x.daysInMonth` (exact)", (ctx, zdt) =>
    rewrite(`${zdt}.day === ${zdt}.daysInMonth`, [], "expression")
  );

  // --- setters

  const setters: Record<
    string,
    { field: string; range: [number, number]; map?: (n: string) => string }
  > = {
    setYear: { field: "year", range: [-Infinity, Infinity] },
    setMonth: { field: "month", range: [0, 11], map: (n) => `${n} + 1` },
    setDate: { field: "day", range: [1, 28] },
    setHours: { field: "hour", range: [0, 23] },
    setMinutes: { field: "minute", range: [0, 59] },
    setSeconds: { field: "second", range: [0, 59] },
    setMilliseconds: { field: "millisecond", range: [0, 999] },
  };
  for (const [name, { field, range, map }] of Object.entries(setters))
    dated(
      name,
      `\`.with({ ${field} }, { offset: "ignore" })\` (exact for values in range; out of range, date-fns rolls over where Temporal clamps: overflow)`,
      (ctx, zdt, rest) => {
        const n = amount(rest[0]);
        if (n === null) return none("the value is not a whole number");
        if (rest.length > 1 && !plainOptions(rest[1])) return inOption();
        const value = map
          ? /^-?\d+$/.test(n.text)
            ? String(Number(n.text) + 1)
            : map(n.text)
          : n.text;
        const inRange =
          /^-?\d+$/.test(n.text) && Number(n.text) >= range[0] && Number(n.text) <= range[1];
        // setYear keeps a February 29 as March 1 where Temporal clamps it to February 28
        const differences: DifferenceId[] =
          inRange && name !== "setYear" ? n.differences : [...n.differences, "overflow"];
        return asDate(withFields(zdt, `${field}: ${value}`, ctx.quote), differences);
      },
      { values: 1 }
    );
  dated(
    "set",
    '`.with({ year, month, day, hour, minute, second, millisecond }, { offset: "ignore" })` from a literal (exact for values in range; a year differs: overflow)',
    (ctx, zdt, rest) => {
      const [values, opts] = rest;
      if (values?.value.kind !== "object") return none("the values are not an object literal");
      if (!plainOptions(opts)) return inOption();
      const fields: string[] = [];
      const differences: DifferenceId[] = [];
      for (const [key, value] of Object.entries(values.value.props)) {
        const setter = {
          year: "setYear",
          month: "setMonth",
          date: "setDate",
          hours: "setHours",
          minutes: "setMinutes",
          seconds: "setSeconds",
          milliseconds: "setMilliseconds",
        }[key];
        if (setter === undefined) return none(`the field ${key} has no counterpart`);
        const { field, range, map } = setters[setter];
        const n = amount(value);
        if (n === null) return none(`the value of ${key} is not a whole number`);
        const literal = /^-?\d+$/.test(n.text);
        const inRange = literal && Number(n.text) >= range[0] && Number(n.text) <= range[1];
        if (!inRange || setter === "setYear") differences.push("overflow");
        differences.push(...n.differences);
        fields.push(
          `${field}: ${map ? (literal ? String(Number(n.text) + 1) : map(n.text)) : n.text}`
        );
      }
      if (fields.length === 0) return none("no field is set");
      return asDate(withFields(zdt, fields.join(", "), ctx.quote), differences);
    },
    { values: 1 }
  );
  dated(
    "setDayOfYear",
    "`.toPlainDate().with({ month: 1, day: 1 }).add({ days: n - 1 })` with the time kept (a skipped midnight in January differs: date-fns-dst-steps)",
    (ctx, zdt, rest) => {
      const n = amount(rest[0]);
      if (n === null) return none("the day is not a whole number");
      if (rest.length > 1 && !plainOptions(rest[1])) return inOption();
      const date = `${zdt}.toPlainDate().with({ month: 1, day: 1 }).add({ days: ${n.text} - 1 })`;
      // date-fns goes through the same day of January, whose skipped midnight shifts the time
      return asDate(
        `${date}.toPlainDateTime(${zdt}.toPlainTime()).toZonedDateTime(${zone})`,
        [...n.differences, "date-fns-dst-steps"]
      );
    },
    { values: 1 }
  );
  dated(
    "setQuarter",
    '`.with({ month: the quarter\'s matching month }, { offset: "ignore" })` (exact for 1 to 4)',
    (ctx, zdt, rest) => {
      const n = amount(rest[0]);
      if (n === null || !/^[1-4]$/.test(n.text))
        return none("the quarter is not a literal from 1 to 4");
      if (rest.length > 1 && !plainOptions(rest[1])) return inOption();
      return asDate(
        withFields(
          zdt,
          `month: ${zdt}.month + (${n.text} - 1 - Math.floor((${zdt}.month - 1) / 3)) * 3`,
          ctx.quote
        ),
        []
      );
    },
    { values: 1 }
  );
  dated(
    "setDay",
    "`.add({ days: n - x.dayOfWeek % 7 })` (exact for 0 to 6 with the default week start)",
    (ctx, zdt, rest) => {
      const n = amount(rest[0]);
      if (n === null || !/^[0-6]$/.test(n.text))
        return none("the day is not a literal from 0 to 6");
      const w = weekStart(ctx, rest[1]);
      if (typeof w !== "number") return w;
      if (w !== 0)
        return none("a week start other than Sunday changes which week the day falls in");
      return asDate(`${zdt}.add({ days: ${n.text} - ${zdt}.dayOfWeek % 7 })`, []);
    },
    { values: 1 }
  );
  dated(
    "setISODay",
    "`.add({ days: n - x.dayOfWeek })` (exact for 1 to 7)",
    (ctx, zdt, rest) => {
      const n = amount(rest[0]);
      if (n === null || !/^[1-7]$/.test(n.text))
        return none("the day is not a literal from 1 to 7");
      if (rest.length > 1 && !plainOptions(rest[1])) return inOption();
      return asDate(`${zdt}.add({ days: ${n.text} - ${zdt}.dayOfWeek })`, []);
    },
    { values: 1 }
  );

  // --- comparisons

  /** `fn(a, b, options?)` with two Date arguments. */
  function paired(
    name: string,
    doc: string,
    apply: (ctx: Context, a: string, b: string, rest: readonly Arg[]) => Outcome | null
  ) {
    staticCall(owner, name, doc, (ctx) => {
      const [first, second, ...rest] = ctx.args;
      const a = read(first);
      const b = read(second);
      if (a === null || b === null)
        return unreadable(a === null ? "the first date" : "the second date");
      const o = optionsCheck(ctx.args, 2) ?? apply(ctx, a.zdt, b.zdt, rest);
      if (o === null || o.kind === "none") return o ?? none("not rewritten");
      return {
        ...o,
        differences: [...new Set([...a.differences, ...b.differences, ...o.differences])],
      };
    });
  }
  const compare = (a: string, b: string) => `Temporal.ZonedDateTime.compare(${a}, ${b})`;
  paired("isBefore", "`Temporal.ZonedDateTime.compare(a, b) < 0` (exact)", (ctx, a, b) =>
    rewrite(`${compare(a, b)} < 0`, [], "expression")
  );
  paired("isAfter", "`Temporal.ZonedDateTime.compare(a, b) > 0` (exact)", (ctx, a, b) =>
    rewrite(`${compare(a, b)} > 0`, [], "expression")
  );
  paired("isEqual", "`Temporal.ZonedDateTime.compare(a, b) === 0` (exact)", (ctx, a, b) =>
    rewrite(`${compare(a, b)} === 0`, [], "expression")
  );
  paired("compareAsc", "`Temporal.ZonedDateTime.compare(a, b)` (exact)", (ctx, a, b) =>
    rewrite(compare(a, b))
  );
  paired("compareDesc", "`Temporal.ZonedDateTime.compare(b, a)` (exact)", (ctx, a, b) =>
    rewrite(compare(b, a))
  );
  paired("isSameDay", "`a.toPlainDate().equals(b.toPlainDate())` (exact)", (ctx, a, b, rest) =>
    plainOptions(rest[0]) ? rewrite(`${a}.toPlainDate().equals(${b}.toPlainDate())`) : inOption()
  );
  paired(
    "isSameMonth",
    "`a.toPlainDate().toPlainYearMonth().equals(b.toPlainDate().toPlainYearMonth())` (exact)",
    (ctx, a, b, rest) =>
      plainOptions(rest[0])
        ? rewrite(
            `${a}.toPlainDate().toPlainYearMonth().equals(${b}.toPlainDate().toPlainYearMonth())`
          )
        : inOption()
  );
  paired("isSameYear", "`a.year === b.year` (exact)", (ctx, a, b, rest) =>
    plainOptions(rest[0]) ? rewrite(`${a}.year === ${b}.year`, [], "expression") : inOption()
  );
  paired("isSameQuarter", "the same year and quarter (exact)", (ctx, a, b, rest) =>
    plainOptions(rest[0])
      ? rewrite(
          `${a}.year === ${b}.year && ${quarterIndex(a)} === ${quarterIndex(b)}`,
          [],
          "expression"
        )
      : inOption()
  );
  paired("isSameISOWeekYear", "`a.yearOfWeek === b.yearOfWeek` (exact)", (ctx, a, b, rest) =>
    plainOptions(rest[0])
      ? rewrite(`${a}.yearOfWeek === ${b}.yearOfWeek`, [], "expression")
      : inOption()
  );
  const truncated = (z: string, unit: string, q: string) =>
    `${z}.toPlainDateTime().round({ smallestUnit: ${str(unit, q)}, roundingMode: ${str("floor", q)} })`;
  for (const [name, unit] of [
    ["isSameHour", "hour"],
    ["isSameMinute", "minute"],
    ["isSameSecond", "second"],
  ] as const)
    paired(name, `the same wall-clock time to the ${unit} (exact)`, (ctx, a, b, rest) =>
      plainOptions(rest[0])
        ? rewrite(`${truncated(a, unit, ctx.quote)}.equals(${truncated(b, unit, ctx.quote)})`)
        : inOption()
    );
  for (const [name, iso] of [
    ["isSameWeek", false],
    ["isSameISOWeek", true],
  ] as const)
    paired(name, "the same week start (exact)", (ctx, a, b, rest) => {
      const w = iso ? 1 : weekStart(ctx, rest[0]);
      if (typeof w !== "number") return w;
      return rewrite(`${weekStartDate(a, w)}.equals(${weekStartDate(b, w)})`);
    });
  dated(
    "isWithinInterval",
    "`compare(start, x) <= 0 && compare(x, end) <= 0`, either way round (exact)",
    (ctx, zdt, rest) => {
      const interval = rest[0];
      if (interval?.value.kind !== "object") return none("the interval is not an object literal");
      const s = read(interval.value.props.start);
      const e = read(interval.value.props.end);
      if (s === null || e === null) return unreadable("the interval's start or end");
      if (rest.length > 1 && !plainOptions(rest[1])) return inOption();
      const within = (lo: string, hi: string) =>
        `${compare(lo, zdt)} <= 0 && ${compare(zdt, hi)} <= 0`;
      return {
        kind: "rewrite",
        text: `(${within(s.zdt, e.zdt)}) || (${within(e.zdt, s.zdt)})`,
        differences: [...new Set([...s.differences, ...e.differences])],
        precedence: "expression",
      };
    },
    { values: 1 }
  );
  const nowMs = "Temporal.Now.instant().epochMilliseconds";
  dated(
    "isPast",
    "`x.epochMilliseconds < Temporal.Now.instant().epochMilliseconds` (exact)",
    (ctx, zdt) => rewrite(`${zdt}.epochMilliseconds < ${nowMs}`, [], "expression")
  );
  dated(
    "isFuture",
    "`x.epochMilliseconds > Temporal.Now.instant().epochMilliseconds` (exact)",
    (ctx, zdt) => rewrite(`${zdt}.epochMilliseconds > ${nowMs}`, [], "expression")
  );
  dated(
    "isToday",
    "`.toPlainDate().equals(Temporal.Now.plainDateISO())` (exact)",
    (ctx, zdt, rest) =>
      plainOptions(rest[0]) ? rewrite(`${zdt}.toPlainDate().equals(${today})`) : inOption()
  );
  dated(
    "isTomorrow",
    "`.toPlainDate().equals(Temporal.Now.plainDateISO().add({ days: 1 }))` (exact)",
    (ctx, zdt, rest) =>
      plainOptions(rest[0])
        ? rewrite(`${zdt}.toPlainDate().equals(${today}.add({ days: 1 }))`)
        : inOption()
  );
  dated(
    "isYesterday",
    "`.toPlainDate().equals(Temporal.Now.plainDateISO().subtract({ days: 1 }))` (exact)",
    (ctx, zdt, rest) =>
      plainOptions(rest[0])
        ? rewrite(`${zdt}.toPlainDate().equals(${today}.subtract({ days: 1 }))`)
        : inOption()
  );
  dated("isThisMonth", "the same year and month as today (exact)", (ctx, zdt, rest) =>
    plainOptions(rest[0])
      ? rewrite(
          `${zdt}.toPlainDate().toPlainYearMonth().equals(${today}.toPlainYearMonth())`
        )
      : inOption()
  );
  dated("isThisYear", "`.year === Temporal.Now.plainDateISO().year` (exact)", (ctx, zdt, rest) =>
    plainOptions(rest[0]) ? rewrite(`${zdt}.year === ${today}.year`, [], "expression") : inOption()
  );
  dated("isThisQuarter", "the same year and quarter as today (exact)", (ctx, zdt, rest) =>
    plainOptions(rest[0])
      ? rewrite(
          `${zdt}.year === ${today}.year && ${quarterIndex(zdt)} === ${quarterIndex(today)}`,
          [],
          "expression"
        )
      : inOption()
  );
  for (const [name, unit] of [
    ["isThisHour", "hour"],
    ["isThisMinute", "minute"],
    ["isThisSecond", "second"],
  ] as const)
    dated(name, `the same wall-clock ${unit} as now (exact)`, (ctx, zdt, rest) =>
      plainOptions(rest[0])
        ? rewrite(
            `${truncated(zdt, unit, ctx.quote)}.equals(${truncated("Temporal.Now.zonedDateTimeISO()", unit, ctx.quote)})`
          )
        : inOption()
    );
  for (const [name, iso] of [
    ["isThisWeek", false],
    ["isThisISOWeek", true],
  ] as const)
    dated(name, "the same week start as today (exact)", (ctx, zdt, rest) => {
      const w = iso ? 1 : weekStart(ctx, rest[0]);
      if (typeof w !== "number") return w;
      return rewrite(
        `${weekStartDate(zdt, w)}.equals(${today}.subtract({ days: ${daysIntoWeek(today, w)} }))`
      );
    });

  // --- differences

  paired(
    "differenceInMilliseconds",
    "`a.epochMilliseconds - b.epochMilliseconds` (exact)",
    (ctx, a, b) => rewrite(`${a}.epochMilliseconds - ${b}.epochMilliseconds`, [], "expression")
  );
  /** The rounding of date-fns's time differences: truncation unless the options say otherwise. */
  function rounding(opts: Arg | undefined): string | Outcome {
    if (opts === undefined || opts.value.kind === "undefined") return "Math.trunc";
    if (opts.value.kind !== "object") return none("the options are not a literal");
    if ("in" in opts.value.props) return inOption();
    const m = opts.value.props.roundingMethod;
    if (m === undefined) return "Math.trunc";
    if (m.value.kind === "string" && ["trunc", "round", "floor", "ceil"].includes(m.value.value))
      return `Math.${m.value.value}`;
    return none("roundingMethod is not a literal");
  }
  for (const [name, ms] of [
    ["differenceInSeconds", 1000],
    ["differenceInMinutes", 60000],
    ["differenceInHours", 3600000],
  ] as const)
    paired(
      name,
      `\`Math.trunc((a.epochMilliseconds - b.epochMilliseconds) / ${ms})\`, or the roundingMethod given (exact)`,
      (ctx, a, b, rest) => {
        const round = rounding(rest[0]);
        if (typeof round !== "string") return round;
        return rewrite(
          `${round}((${a}.epochMilliseconds - ${b}.epochMilliseconds) / ${ms}) || 0`,
          [],
          "expression"
        );
      }
    );
  paired(
    "differenceInCalendarDays",
    "`a.toPlainDate().since(b.toPlainDate()).days` (exact)",
    (ctx, a, b, rest) =>
      plainOptions(rest[0])
        ? rewrite(`${a}.toPlainDate().since(${b}.toPlainDate()).days`)
        : inOption()
  );
  paired(
    "differenceInCalendarMonths",
    "`(a.year - b.year) * 12 + a.month - b.month` (exact)",
    (ctx, a, b, rest) =>
      plainOptions(rest[0])
        ? rewrite(`(${a}.year - ${b}.year) * 12 + ${a}.month - ${b}.month`, [], "expression")
        : inOption()
  );
  paired("differenceInCalendarYears", "`a.year - b.year` (exact)", (ctx, a, b, rest) =>
    plainOptions(rest[0]) ? rewrite(`${a}.year - ${b}.year`, [], "expression") : inOption()
  );
  paired(
    "differenceInCalendarQuarters",
    "`(a.year - b.year) * 4 + a's quarter - b's quarter` (exact)",
    (ctx, a, b, rest) =>
      plainOptions(rest[0])
        ? rewrite(
            `(${a}.year - ${b}.year) * 4 + ${quarterIndex(a)} - ${quarterIndex(b)}`,
            [],
            "expression"
          )
        : inOption()
  );
  paired(
    "differenceInCalendarISOWeekYears",
    "`a.yearOfWeek - b.yearOfWeek` (exact)",
    (ctx, a, b, rest) =>
      plainOptions(rest[0])
        ? rewrite(`${a}.yearOfWeek - ${b}.yearOfWeek`, [], "expression")
        : inOption()
  );
  for (const [name, iso] of [
    ["differenceInCalendarWeeks", false],
    ["differenceInCalendarISOWeeks", true],
  ] as const)
    paired(name, "the days between the two week starts, in weeks (exact)", (ctx, a, b, rest) => {
      const w = iso ? 1 : weekStart(ctx, rest[0]);
      if (typeof w !== "number") return w;
      return rewrite(
        `${weekStartDate(a, w)}.since(${weekStartDate(b, w)}).days / 7`,
        [],
        "expression"
      );
    });
  // the whole-unit differences: date-fns compares wall clocks after moving an endpoint by whole
  // days, months or years with Date's setters, Temporal's since counts the units; they differ at
  // month ends and in the hours around a DST change
  const wholeUnits: DifferenceId[] = ["date-fns-whole-units"];
  paired(
    "differenceInDays",
    '`a.since(b, { largestUnit: "days" }).days` (differs around DST changes: date-fns-whole-units)',
    (ctx, a, b, rest) =>
      plainOptions(rest[0])
        ? rewrite(`${a}.since(${b}, { largestUnit: ${str("days", ctx.quote)} }).days`, wholeUnits)
        : inOption()
  );
  paired(
    "differenceInWeeks",
    '`Math.trunc(a.since(b, { largestUnit: "days" }).days / 7)`, or the roundingMethod given (differs around DST changes: date-fns-whole-units)',
    (ctx, a, b, rest) => {
      const round = rounding(rest[0]);
      if (typeof round !== "string") return round;
      return rewrite(
        `${round}(${a}.since(${b}, { largestUnit: ${str("days", ctx.quote)} }).days / 7) || 0`,
        wholeUnits,
        "expression"
      );
    }
  );
  paired(
    "differenceInMonths",
    '`a.since(b, { largestUnit: "months" }).months` (differs at month ends and around DST changes: date-fns-whole-units)',
    (ctx, a, b, rest) =>
      plainOptions(rest[0])
        ? rewrite(
            `${a}.since(${b}, { largestUnit: ${str("months", ctx.quote)} }).months`,
            wholeUnits
          )
        : inOption()
  );
  paired(
    "differenceInQuarters",
    '`Math.trunc(a.since(b, { largestUnit: "months" }).months / 3)`, or the roundingMethod given (differs at month ends and around DST changes: date-fns-whole-units)',
    (ctx, a, b, rest) => {
      const round = rounding(rest[0]);
      if (typeof round !== "string") return round;
      return rewrite(
        `${round}(${a}.since(${b}, { largestUnit: ${str("months", ctx.quote)} }).months / 3) || 0`,
        wholeUnits,
        "expression"
      );
    }
  );
  paired(
    "differenceInYears",
    '`a.since(b, { largestUnit: "years" }).years` (differs around DST changes: date-fns-whole-units)',
    (ctx, a, b, rest) =>
      plainOptions(rest[0])
        ? rewrite(
            `${a}.since(${b}, { largestUnit: ${str("years", ctx.quote)} }).years`,
            wholeUnits
          )
        : inOption()
  );

  // --- ISO 8601 and the fixed formats

  staticCall(
    owner,
    "parseISO",
    "`Temporal.PlainDate.from`, `Temporal.PlainDateTime.from` or `Temporal.Instant.from` in the system zone (exact for ISO literals; other strings: iso-grammar, invalid-throws)",
    (ctx) => {
      const [input, opts] = ctx.args;
      if (input === undefined) return none("parseISO takes a string");
      if (opts !== undefined && opts.value.kind !== "undefined")
        return none("the additionalDigits and in options are not supported");
      const v = input.value;
      if (v.kind === "string") {
        try {
          if (isoDate.test(v.value) && temporal().PlainDate.from(v.value))
            return asDate(startOfDate(`Temporal.PlainDate.from(${input.text})`), []);
          if (isoWallClock.test(v.value) && temporal().PlainDateTime.from(v.value))
            return asDate(
              `Temporal.PlainDateTime.from(${input.text}).toZonedDateTime(${zone})`,
              []
            );
          if (isoInstant.test(v.value) && temporal().Instant.from(v.value))
            return asDate(`Temporal.Instant.from(${input.text}).toZonedDateTimeISO(${zone})`, []);
        } catch {
          return none("Temporal does not read this string");
        }
        return none(
          "date-fns reads this string with its own ISO 8601 grammar (week dates, ordinal dates, reduced precision)"
        );
      }
      if (v.kind === "dynamic" && v.type === "string")
        return asDate(`Temporal.Instant.from(${input.text}).toZonedDateTimeISO(${zone})`, [
          "iso-grammar",
          "invalid-throws",
        ]);
      return none("parseISO takes a string");
    }
  );
  dated(
    "formatISO",
    '`.toString({ smallestUnit: "second", timeZoneName: "never" })` (differs: iso-format); with representation "date", `.toPlainDate().toString()` (exact)',
    (ctx, zdt, rest) => {
      const q = ctx.quote;
      const opts = rest[0];
      if (opts === undefined || opts.value.kind === "undefined")
        return rewrite(
          `${zdt}.toString({ smallestUnit: ${str("second", q)}, timeZoneName: ${str("never", q)} })`,
          ["iso-format"]
        );
      if (opts.value.kind !== "object") return none("the options are not a literal");
      if ("in" in opts.value.props) return inOption();
      const format = opts.value.props.format;
      if (
        format !== undefined &&
        !(format.value.kind === "string" && format.value.value === "extended")
      )
        return none("the basic format has no Temporal counterpart");
      const rep = opts.value.props.representation;
      const r =
        rep === undefined ? "complete" : rep.value.kind === "string" ? rep.value.value : null;
      if (r === "complete")
        return rewrite(
          `${zdt}.toString({ smallestUnit: ${str("second", q)}, timeZoneName: ${str("never", q)} })`,
          ["iso-format"]
        );
      if (r === "date") return rewrite(`${zdt}.toPlainDate().toString()`);
      if (r === "time")
        return rewrite(
          `${zdt}.toPlainTime().toString({ smallestUnit: ${str("second", q)} }) + ${zdt}.offset`,
          ["iso-format"],
          "expression"
        );
      return none("representation is not a literal");
    }
  );
  dated(
    "formatISO9075",
    '`.toPlainDateTime().toString({ smallestUnit: "second" }).replace("T", " ")` (exact)',
    (ctx, zdt, rest) => {
      const q = ctx.quote;
      const opts = rest[0];
      const rep = option(opts, "representation");
      if (opts !== undefined && opts.value.kind !== "undefined" && opts.value.kind !== "object")
        return none("the options are not a literal");
      if (option(opts, "format") !== undefined)
        return none("the basic format has no Temporal counterpart");
      if (option(opts, "in") !== undefined) return inOption();
      const r =
        rep === undefined ? "complete" : rep.value.kind === "string" ? rep.value.value : null;
      if (r === "complete")
        return rewrite(
          `${zdt}.toPlainDateTime().toString({ smallestUnit: ${str("second", q)} }).replace(${str("T", q)}, ${str(" ", q)})`
        );
      if (r === "date") return rewrite(`${zdt}.toPlainDate().toString()`);
      if (r === "time")
        return rewrite(`${zdt}.toPlainTime().toString({ smallestUnit: ${str("second", q)} })`);
      return none("representation is not a literal");
    }
  );
  dated(
    "formatRFC3339",
    '`.toString({ smallestUnit: "second", timeZoneName: "never" })` (historical sub-minute offsets differ: iso-format; before the year 1000: date-fns-years)',
    (ctx, zdt, rest) => {
      const q = ctx.quote;
      const digits = option(rest[0], "fractionDigits");
      if (
        rest[0] !== undefined &&
        rest[0].value.kind !== "undefined" &&
        rest[0].value.kind !== "object"
      )
        return none("the options are not a literal");
      if (option(rest[0], "in") !== undefined) return inOption();
      if (digits === undefined || (digits.value.kind === "number" && digits.value.value === 0))
        return rewrite(
          `${zdt}.toString({ smallestUnit: ${str("second", q)}, timeZoneName: ${str("never", q)} })`,
          ["iso-format", "date-fns-years"]
        );
      if (digits.value.kind === "number" && [1, 2, 3].includes(digits.value.value))
        return rewrite(
          `${zdt}.toString({ fractionalSecondDigits: ${digits.value.value}, timeZoneName: ${str("never", q)} })`,
          ["iso-format", "date-fns-years"]
        );
      return none("fractionDigits is not a literal from 0 to 3");
    }
  );
  dated(
    "formatRFC7231",
    "`new Date(x.epochMilliseconds).toUTCString()` (differs before the year 1000: date-fns-years)",
    (ctx, zdt) => rewrite(`new Date(${zdt}.epochMilliseconds).toUTCString()`, ["date-fns-years"])
  );
  const fixedFormats = (q: string): Record<string, (z: string) => string> => ({
    "yyyy-MM-dd": (z) => `${z}.toPlainDate().toString()`,
    "yyyy-MM-dd'T'HH:mm:ss": (z) =>
      `${z}.toPlainDateTime().toString({ smallestUnit: ${str("second", q)} })`,
    "yyyy-MM-dd HH:mm:ss": (z) =>
      `${z}.toPlainDateTime().toString({ smallestUnit: ${str("second", q)} }).replace(${str("T", q)}, ${str(" ", q)})`,
    "HH:mm": (z) => `${z}.toPlainTime().toString({ smallestUnit: ${str("minute", q)} })`,
    "HH:mm:ss": (z) => `${z}.toPlainTime().toString({ smallestUnit: ${str("second", q)} })`,
    "HH:mm:ss.SSS": (z) =>
      `${z}.toPlainTime().toString({ smallestUnit: ${str("millisecond", q)} })`,
  });
  for (const name of ["format", "formatDate", "lightFormat"])
    dated(
      name,
      "`.toPlainDate()`, `.toPlainDateTime()` or `.toPlainTime()` and `.toString(...)` for a few fixed patterns (date patterns differ: date-fns-years); other patterns: none",
      (ctx, zdt, rest) => {
        const [pattern, opts] = rest;
        if (pattern?.value.kind !== "string") return none("the pattern is not a literal");
        if (opts !== undefined && opts.value.kind !== "undefined")
          return none("format options (locale, weekStartsOn, in) are not supported");
        const text = fixedFormats(ctx.quote)[pattern.value.value];
        if (text === undefined)
          return none(
            "Temporal has no token-based formatter; use toLocaleString or Intl.DateTimeFormat"
          );
        return rewrite(text(zdt), pattern.value.value.startsWith("HH") ? [] : ["date-fns-years"]);
      },
      { values: 1 }
    );

  // --- conversions

  dated(
    "toDate",
    "`new Date(x.epochMilliseconds)` (exact)",
    (ctx, zdt, rest) =>
      rest.length === 0 ? asDate(zdt, []) : none("toDate with a context argument is not supported"),
    { values: 1 }
  );
  staticCall(
    owner,
    "fromUnixTime",
    "`Temporal.Instant.fromEpochMilliseconds(s * 1000)` in the system zone",
    (ctx) => {
      const [s, ...rest] = ctx.args;
      if (rest.length > 0) return none("fromUnixTime with a context argument is not supported");
      if (s === undefined) return none("fromUnixTime takes a number");
      if (s.value.kind === "number")
        return Number.isFinite(s.value.value) && Math.abs(s.value.value) <= 8.64e12
          ? asDate(
              `Temporal.Instant.fromEpochMilliseconds(${Math.trunc(s.value.value * 1000)}).toZonedDateTimeISO(${zone})`,
              []
            )
          : none("this number makes an Invalid Date");
      if (s.value.kind === "dynamic" && s.value.type === "number")
        return asDate(
          `Temporal.Instant.fromEpochMilliseconds(Math.trunc(${s.text} * 1000)).toZonedDateTimeISO(${zone})`,
          ["invalid-throws"]
        );
      return none("fromUnixTime takes a number");
    }
  );
  const weekdays: Record<string, number> = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
  };
  dated(
    "nextDay",
    "`.add({ days: forward to the day })` (exact for a literal day)",
    (ctx, zdt, rest) => {
      const n = amount(rest[0]);
      if (n === null || !/^[0-6]$/.test(n.text))
        return none("the day is not a literal from 0 to 6");
      if (rest.length > 1 && !plainOptions(rest[1])) return inOption();
      return asDate(`${zdt}.add({ days: ((${n.text} - ${zdt}.dayOfWeek % 7 + 6) % 7) + 1 })`, []);
    },
    { values: 1 }
  );
  dated(
    "previousDay",
    "`.subtract({ days: back to the day })` (exact for a literal day)",
    (ctx, zdt, rest) => {
      const n = amount(rest[0]);
      if (n === null || !/^[0-6]$/.test(n.text))
        return none("the day is not a literal from 0 to 6");
      if (rest.length > 1 && !plainOptions(rest[1])) return inOption();
      return asDate(
        `${zdt}.subtract({ days: ((${zdt}.dayOfWeek % 7 - ${n.text} + 6) % 7) + 1 })`,
        []
      );
    },
    { values: 1 }
  );
  for (const [day, n] of Object.entries(weekdays)) {
    dated(`next${day}`, `the next ${day}, \`.add({ days })\` (exact)`, (ctx, zdt, rest) =>
      plainOptions(rest[0])
        ? asDate(`${zdt}.add({ days: ((${n} - ${zdt}.dayOfWeek % 7 + 6) % 7) + 1 })`, [])
        : inOption()
    );
    dated(
      `previous${day}`,
      `the previous ${day}, \`.subtract({ days })\` (exact)`,
      (ctx, zdt, rest) =>
        plainOptions(rest[0])
          ? asDate(`${zdt}.subtract({ days: ((${zdt}.dayOfWeek % 7 - ${n} + 6) % 7) + 1 })`, [])
          : inOption()
    );
  }

  // --- what has no replacement

  unsupported(
    owner,
    true,
    ["fp"],
    "date-fns/fp's curried functions have no catalog entries; import them from date-fns",
    ["call"]
  );
  const noneFor = (names: readonly string[], reason: string) =>
    unsupported(owner, true, names, reason, ["call"]);
  noneFor(
    [
      "formatDistance",
      "formatDistanceStrict",
      "formatDistanceToNow",
      "formatDistanceToNowStrict",
      "formatRelative",
      "formatDuration",
      "intlFormat",
      "intlFormatDistance",
    ],
    "Temporal has no relative or locale-aware formatter; Intl.RelativeTimeFormat and toLocaleString are the native tools"
  );
  noneFor(
    ["parse", "parseJSON", "isMatch"],
    "Temporal reads ISO 8601 only; a format-driven parser has no counterpart"
  );
  noneFor(
    [
      "eachDayOfInterval",
      "eachHourOfInterval",
      "eachMinuteOfInterval",
      "eachMonthOfInterval",
      "eachQuarterOfInterval",
      "eachWeekOfInterval",
      "eachYearOfInterval",
      "eachWeekendOfInterval",
      "eachWeekendOfMonth",
      "eachWeekendOfYear",
      "areIntervalsOverlapping",
      "getOverlappingDaysInIntervals",
      "intervalToDuration",
      "interval",
      "clamp",
    ],
    "Temporal has no interval type; a loop with add() replaces the each* functions"
  );
  noneFor(
    ["min", "max", "closestTo", "closestIndexTo"],
    "these take arrays of dates; Temporal.ZonedDateTime.compare in a reduce replaces them"
  );
  noneFor(
    [
      "differenceInBusinessDays",
      "addBusinessDays",
      "subBusinessDays",
      "isExists",
      "isValid",
      "isDate",
      "constructFrom",
      "constructNow",
      "transpose",
      "setDefaultOptions",
      "getDefaultOptions",
    ],
    "no Temporal counterpart: business days, validity checks on Dates and Date construction stay as they are"
  );
  noneFor(
    [
      "getWeek",
      "getWeekYear",
      "getWeekOfMonth",
      "getWeeksInMonth",
      "setWeek",
      "setWeekYear",
      "setISOWeek",
      "setISOWeekYear",
      "startOfWeekYear",
      "endOfWeekYear",
      "lastDayOfWeekYear",
    ],
    "week numbering depends on weekStartsOn and firstWeekContainsDate; Temporal knows ISO weeks only"
  );
  noneFor(
    [
      "milliseconds",
      "millisecondsToHours",
      "millisecondsToMinutes",
      "millisecondsToSeconds",
      "secondsToHours",
      "secondsToMilliseconds",
      "secondsToMinutes",
      "minutesToHours",
      "minutesToMilliseconds",
      "minutesToSeconds",
      "hoursToMilliseconds",
      "hoursToMinutes",
      "hoursToSeconds",
      "daysToWeeks",
      "weeksToDays",
      "monthsToQuarters",
      "monthsToYears",
      "quartersToMonths",
      "quartersToYears",
      "yearsToDays",
      "yearsToMonths",
      "yearsToQuarters",
    ],
    "plain arithmetic on numbers, with date-fns's average month and year lengths; nothing of Temporal's"
  );
  noneFor(
    ["addISOWeekYears", "subISOWeekYears", "differenceInISOWeekYears"],
    "ISO week-year arithmetic has no Temporal counterpart: date-fns moves a date to the same week and weekday of another ISO week year"
  );
  noneFor(
    ["formatISODuration"],
    "date-fns writes every field of the duration (P1Y0M0DT0H0M0S) where Temporal.Duration's toString omits the zeros"
  );
  noneFor(
    ["roundToNearestHours", "roundToNearestMinutes"],
    "date-fns rounds the wall-clock fields; a Temporal round() works on the exact time, which differs around DST changes"
  );
}
