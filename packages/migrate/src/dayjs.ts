// The Day.js part of the migration catalog: what replaces dayjs(...), the Dayjs methods and the
// utc and timezone plugins in native Temporal code. A Day.js value becomes a
// Temporal.ZonedDateTime in the zone it is read in: the system zone for dayjs(), "UTC" for
// dayjs.utc(), the given zone for dayjs.tz(). Day.js computes with Date's local-time setters,
// which resolve a skipped or repeated wall-clock time like Temporal's "compatible"
// disambiguation, so setter-like rewrites use `with(fields, { offset: "ignore" })`.
// Exactness is checked against Day.js itself by packages/migrate/test/migrateDayjs.test.js.

import type { Arg, ClassName, Context, Outcome, RuleKit } from "./rules.js";
import type { DifferenceId } from "./differences.js";

// Day.js's own parsing pattern for strings without an offset (src/constant.js)
const dayjsParse =
  /^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{0,2})[Tt\s]*(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?[.:]?(\d+)?$/;
const isoWallClock = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/;
const isoInstant =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** Day.js's unit names (Utils.p): short forms are case-sensitive, long ones drop a plural s. */
export function dayjsUnit(arg: Arg | undefined): string | null {
  if (arg === undefined || arg.value.kind === "undefined") return "";
  if (arg.value.kind !== "string") return null;
  const special: Record<string, string> = {
    M: "month",
    y: "year",
    w: "week",
    d: "day",
    D: "date",
    h: "hour",
    m: "minute",
    s: "second",
    ms: "millisecond",
    Q: "quarter",
  };
  const u = arg.value.value;
  return special[u] ?? u.toLowerCase().replace(/s$/, "");
}

/** The Temporal field a Day.js getter or setter unit reads, and how its value differs. */
const fields: Readonly<Record<string, { field: string; get: (r: string) => string }>> = {
  year: { field: "year", get: (r) => `${r}.year` },
  month: { field: "month", get: (r) => `${r}.month - 1` },
  date: { field: "day", get: (r) => `${r}.day` },
  day: { field: "dayOfWeek", get: (r) => `${r}.dayOfWeek % 7` },
  hour: { field: "hour", get: (r) => `${r}.hour` },
  minute: { field: "minute", get: (r) => `${r}.minute` },
  second: { field: "second", get: (r) => `${r}.second` },
  millisecond: { field: "millisecond", get: (r) => `${r}.millisecond` },
};
/** Setter values that never roll over into the next unit, whatever the date. */
const setterRange: Readonly<Record<string, [number, number]>> = {
  month: [0, 11],
  date: [1, 28],
  hour: [0, 23],
  minute: [0, 59],
  second: [0, 59],
  millisecond: [0, 999],
};
const timeSteps: Readonly<Record<string, [string, number]>> = {
  millisecond: ["milliseconds", 1],
  second: ["seconds", 1000],
  minute: ["minutes", 60000],
  hour: ["hours", 3600000],
};

export function defineDayjsRules(kit: RuleKit) {
  const { unsupported, rewrite, none, str, temporal } = kit;
  const owner: ClassName = "Dayjs";

  /** What plugins extended in the project change in the rewrite of `name`. */
  function plugins(ctx: Context, name: string): Outcome | DifferenceId[] {
    const has = (plugin: string) => ctx.facts.settings.has(`dayjs:plugin:${plugin}`);
    if (has("badMutable")) return none("the badMutable plugin makes Day.js values mutable");
    if (has("preParsePostFormat") && ["()", "utc", "tz", "format"].includes(name))
      return none(
        "the preParsePostFormat plugin runs strings through the locale's preparse and postformat"
      );
    return has("?") || (has("devHelper") && ["()", "utc", "unix", "diff"].includes(name))
      ? ["dayjs-plugins"]
      : [];
  }
  /** Every Day.js rule goes through the plugin check. */
  const gated =
    (name: string, apply: (ctx: Context) => Outcome) =>
    (ctx: Context): Outcome => {
      const found = plugins(ctx, name);
      if (!Array.isArray(found)) return found;
      const outcome = apply(ctx);
      return outcome.kind === "rewrite" && found.length > 0
        ? rewrite(outcome.text, [...outcome.differences, ...found], outcome.precedence)
        : outcome;
    };
  const method: RuleKit["method"] = (o, name, doc, apply) =>
    kit.method(o, name, doc, o === owner ? gated(name, apply) : apply);
  const staticCall: RuleKit["staticCall"] = (o, name, doc, apply) =>
    kit.staticCall(o, name, doc, o === owner ? gated(name, apply) : apply);

  /** Day.js values in a time zone keep a fixed offset through arithmetic (the timezone plugin). */
  const zoned = (ctx: Context): DifferenceId[] =>
    ctx.facts.settings.has("dayjs:zones") ? ["dayjs-zones"] : [];
  const ignoreOffset = (q: string) => `{ offset: ${str("ignore", q)} }`;
  const withFields = (ctx: Context, entries: string) =>
    `${ctx.recv}.with({ ${entries} }, ${ignoreOffset(ctx.quote)})`;
  const endOfDay =
    "hour: 23, minute: 59, second: 59, millisecond: 999, microsecond: 0, nanosecond: 0";

  // --- factories

  /** A string literal Day.js and Temporal both read as the same wall-clock fields. */
  function sameWallClock(text: string): boolean {
    if (!isoWallClock.test(text)) return false;
    const d = dayjsParse.exec(text);
    if (!d || Number(d[1]) < 100) return false; // Date maps years 0-99 to 1900-1999
    try {
      const p = temporal().PlainDateTime.from(text);
      // Day.js passes the first three fraction digits to Date as they are: ".1" is 1 ms
      const ms = Number((d[7] || "0").substring(0, 3));
      return (
        p.year === Number(d[1]) &&
        p.month === Number(d[2] ?? 1) &&
        p.day === Number(d[3] || 1) &&
        p.hour === Number(d[4] ?? 0) &&
        p.minute === Number(d[5] ?? 0) &&
        p.second === Number(d[6] ?? 0) &&
        p.millisecond === ms
      );
    } catch {
      return false;
    }
  }
  /** A string literal with an offset, read by Date and by Temporal.Instant as the same instant. */
  function sameInstant(text: string): boolean {
    if (!isoInstant.test(text)) return false;
    try {
      return temporal().Instant.from(text).epochMilliseconds === Date.parse(text);
    } catch {
      return false;
    }
  }

  /** dayjs(input) and dayjs.utc(input): the value read in `zone` (text of a zone id). */
  function factory(ctx: Context, zone: string, utc: boolean): Outcome {
    const q = ctx.quote;
    const [input, ...rest] = ctx.args;
    if (rest.length > 0)
      return none("parsing with a format, locale or strict mode has no Temporal counterpart");
    if (input === undefined || input.value.kind === "undefined")
      return rewrite(
        `Temporal.Now.zonedDateTimeISO(${utc ? zone : ""}).round({ smallestUnit: ${str("millisecond", q)}, roundingMode: ${str("floor", q)} })`
      );
    const v = input.value;
    const fromMillis = (ms: string) =>
      `Temporal.Instant.fromEpochMilliseconds(${ms}).toZonedDateTimeISO(${zone})`;
    if (v.kind === "number")
      return Number.isFinite(v.value) && Math.abs(v.value) <= 8.64e15
        ? rewrite(fromMillis(String(Math.trunc(v.value))))
        : none("Day.js makes an invalid date from this number; Temporal throws");
    if (v.kind === "dynamic" && v.type === "number")
      return rewrite(fromMillis(input.text), ["fractional-amounts", "invalid-throws"]);
    if (v.kind === "dynamic" && v.type === "date")
      return rewrite(fromMillis(`${input.text}.getTime()`), ["invalid-throws"]);
    if (v.kind === "dynamic" && v.type === "Dayjs")
      return utc
        ? rewrite(`${input.text}.withTimeZone(${zone})`)
        : rewrite(input.text, [], /^[\w$.]+(\(\))?$/.test(input.text) ? "member" : "expression");
    if (v.kind === "string") {
      if (sameInstant(v.value))
        return rewrite(`Temporal.Instant.from(${input.text}).toZonedDateTimeISO(${zone})`);
      if (sameWallClock(v.value))
        return rewrite(`Temporal.PlainDateTime.from(${input.text}).toZonedDateTime(${zone})`);
      return none("Day.js reads this string with Date's rules; Temporal only reads ISO 8601");
    }
    if (v.kind === "dynamic" && v.type === "string")
      return none(
        "the string's format is not known statically: Day.js reads strings without an offset as local time"
      );
    return none("this argument has no Temporal counterpart");
  }

  staticCall(
    owner,
    "()",
    "`Temporal.Now.zonedDateTimeISO()` for now, `Temporal.Instant.fromEpochMilliseconds(ms)`, `Temporal.PlainDateTime.from(isoString)` or `Temporal.Instant.from(isoString)`, in the system zone (exact for ISO literals; numbers and Dates differ: fractional-amounts, invalid-throws)",
    (ctx) => factory(ctx, "Temporal.Now.timeZoneId()", false)
  );
  staticCall(owner, "utc", 'the same as `dayjs(...)` in `"UTC"` (utc plugin)', (ctx) =>
    factory(ctx, str("UTC", ctx.quote), true)
  );
  staticCall(
    owner,
    "unix",
    "`Temporal.Instant.fromEpochMilliseconds(s * 1000)` in the system zone",
    (ctx) => {
      const [s] = ctx.args;
      if (ctx.args.length !== 1 || s === undefined) return none("unix() takes one argument");
      const zone = "Temporal.Now.timeZoneId()";
      if (s.value.kind === "number")
        return Number.isFinite(s.value.value) && Math.abs(s.value.value) <= 8.64e12
          ? rewrite(
              `Temporal.Instant.fromEpochMilliseconds(${Math.trunc(s.value.value * 1000)}).toZonedDateTimeISO(${zone})`
            )
          : none("Day.js makes an invalid date from this number; Temporal throws");
      if (s.value.kind === "dynamic" && s.value.type === "number")
        return rewrite(
          `Temporal.Instant.fromEpochMilliseconds(${s.text} * 1000).toZonedDateTimeISO(${zone})`,
          ["fractional-amounts", "invalid-throws"]
        );
      return none("unix() takes a number");
    }
  );
  staticCall(owner, "isDayjs", "`x instanceof Temporal.ZonedDateTime`", (ctx) => {
    const [x] = ctx.args;
    if (ctx.args.length !== 1 || x === undefined) return none("isDayjs() takes one argument");
    // Day.js also recognizes objects marked $isDayjsObject, from another copy of Day.js
    const known =
      x.value.kind === "dynamic"
        ? ["Dayjs", "number", "string", "date"].includes(x.value.type)
        : x.value.kind !== "object" && x.value.kind !== "member";
    return known
      ? rewrite(`${x.text} instanceof Temporal.ZonedDateTime`, [], "expression")
      : none("Day.js also accepts objects marked $isDayjsObject, from another copy of Day.js");
  });
  staticCall(
    owner,
    "extend",
    "removed when the whole project switches: plugins add nothing to Temporal",
    () => rewrite("")
  );
  staticCall(
    owner,
    "tz",
    "`Temporal.PlainDateTime.from(isoString).toZonedDateTime(zone)` or `Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone)` (timezone plugin; a repeated or skipped wall-clock time differs: dayjs-tz-parse)",
    (ctx) => {
      const [input, zone, ...rest] = ctx.args;
      if (rest.length > 0) return none("parsing with a format has no Temporal counterpart");
      if (zone === undefined)
        return none(
          ctx.facts.settings.has("dayjs.tz.setDefault")
            ? "uses the zone set with dayjs.tz.setDefault, which Temporal does not have"
            : "a zone is needed"
        );
      if (
        zone.value.kind !== "string" &&
        !(zone.value.kind === "dynamic" && zone.value.type === "string")
      )
        return none("the zone must be a string");
      const v = input?.value;
      if (v === undefined) return none("dayjs.tz() needs a date");
      if (v.kind === "number")
        return Number.isInteger(v.value) && Math.abs(v.value) <= 8.64e15
          ? rewrite(
              `Temporal.Instant.fromEpochMilliseconds(${input!.text}).toZonedDateTimeISO(${zone.text})`,
              ["dayjs-tz"]
            )
          : none("Day.js makes an invalid date from this number; Temporal throws");
      if (v.kind === "dynamic" && v.type === "number")
        return rewrite(
          `Temporal.Instant.fromEpochMilliseconds(${input!.text}).toZonedDateTimeISO(${zone.text})`,
          ["fractional-amounts", "invalid-throws", "dayjs-tz"]
        );
      if (v.kind === "dynamic" && v.type === "Dayjs")
        return rewrite(`${input!.text}.withTimeZone(${zone.text})`, ["dayjs-tz"]);
      if (v.kind === "dynamic" && v.type === "date")
        return rewrite(
          `Temporal.Instant.fromEpochMilliseconds(${input!.text}.getTime()).toZonedDateTimeISO(${zone.text})`,
          ["invalid-throws", "dayjs-tz"]
        );
      if (v.kind === "string") {
        if (!sameWallClock(v.value))
          return none("Day.js reads this string with Date's rules; Temporal only reads ISO 8601");
        // exact unless the wall-clock time is repeated in the zone: Day.js picks the occurrence by
        // the zone's offset when the code runs, Temporal the earlier one (skipped times move
        // forward in both)
        let unambiguous = false;
        if (zone.value.kind === "string")
          try {
            const p = temporal().PlainDateTime.from(v.value);
            const earlier = p.toZonedDateTime(zone.value.value, { disambiguation: "earlier" });
            const later = p.toZonedDateTime(zone.value.value, { disambiguation: "later" });
            unambiguous =
              earlier.epochNanoseconds === later.epochNanoseconds ||
              !earlier.toPlainDateTime().equals(later.toPlainDateTime());
          } catch {
            unambiguous = false;
          }
        return rewrite(
          `Temporal.PlainDateTime.from(${input!.text}).toZonedDateTime(${zone.text})`,
          unambiguous ? ["dayjs-tz"] : ["dayjs-tz", "dayjs-tz-parse"]
        );
      }
      return none("this argument has no Temporal counterpart");
    }
  );
  unsupported(
    owner,
    true,
    ["locale"],
    "Day.js's global locale has no Temporal counterpart; pass a locale to toLocaleString",
    ["call"]
  );

  method("DayjsTimezone", "guess", "`Temporal.Now.timeZoneId()`", (ctx) =>
    ctx.args.length === 0
      ? rewrite("Temporal.Now.timeZoneId()")
      : none("guess() takes no arguments")
  );
  unsupported(
    "DayjsTimezone",
    false,
    ["setDefault"],
    "Temporal has no default time zone besides the system one",
    ["call"]
  );

  // --- getters and setters

  function getOrSet(ctx: Context, unit: string, value: Arg | undefined): Outcome {
    const f = fields[unit];
    if (f === undefined) return none(`${unit || "this unit"} is not a Day.js field`);
    if (value === undefined)
      return rewrite(
        f.get(ctx.recv),
        [],
        unit === "month" || unit === "day" ? "expression" : "member"
      );
    const v = value.value;
    if (unit === "day")
      return none("setting the weekday needs the current one; Temporal has no single method");
    const literal = v.kind === "number" && Number.isInteger(v.value);
    if (!literal && !(v.kind === "dynamic" && v.type === "number"))
      return none("the value must be a number");
    const range = setterRange[unit];
    const inRange =
      literal && (range === undefined || (v.value >= range[0] && v.value <= range[1]));
    const valueText =
      unit === "month" ? (literal ? String(v.value + 1) : `${value.text} + 1`) : value.text;
    const differences: DifferenceId[] = [...zoned(ctx)];
    if (unit === "year" || unit === "month") differences.push("dayjs-dst-steps");
    if (!inRange) differences.push("overflow");
    if (!literal) differences.push("fractional-amounts");
    return rewrite(withFields(ctx, `${f.field}: ${valueText}`), differences);
  }
  for (const unit of ["year", "month", "date", "day", "hour", "minute", "second", "millisecond"])
    method(
      owner,
      unit,
      `\`.${fields[unit]!.field}\`${unit === "month" ? " - 1" : unit === "day" ? " % 7" : ""} (exact); with a value, \`.with({ ${fields[unit]!.field} }, { offset: "ignore" })\` (exact in range; differs: overflow)`,
      (ctx) => (ctx.args.length > 1 ? none("too many arguments") : getOrSet(ctx, unit, ctx.args[0]))
    );
  method(owner, "get", "the getter of that unit", (ctx) => {
    const unit = dayjsUnit(ctx.args[0]);
    return ctx.args.length === 1 && unit !== null
      ? getOrSet(ctx, unit, undefined)
      : none("the unit is not known statically");
  });
  method(owner, "set", "the setter of that unit", (ctx) => {
    const unit = dayjsUnit(ctx.args[0]);
    return ctx.args.length === 2 && unit !== null
      ? getOrSet(ctx, unit, ctx.args[1])
      : none("the unit is not known statically");
  });
  method(owner, "daysInMonth", "`.daysInMonth` (exact)", (ctx) =>
    ctx.args.length === 0
      ? rewrite(`${ctx.recv}.daysInMonth`)
      : none("daysInMonth() takes no arguments")
  );
  method(owner, "clone", "the value itself: Temporal objects are immutable (exact)", (ctx) =>
    ctx.args.length === 0 ? rewrite(ctx.recv) : none("clone() takes no arguments")
  );

  // --- arithmetic

  function shift(ctx: Context, sign: 1 | -1): Outcome {
    const [amount, unitArg] = ctx.args;
    if (amount === undefined || ctx.args.length > 2)
      return none("add() takes an amount and a unit");
    const unit = dayjsUnit(unitArg);
    if (unit === null) return none("the unit is not known statically");
    if (unit === "quarter")
      return none(
        "quarters depend on the quarterOfYear plugin; without it Day.js adds milliseconds"
      );
    const v = amount.value;
    const literal = v.kind === "number";
    if (!literal && !(v.kind === "dynamic" && v.type === "number"))
      return none("the amount must be a number");
    const verb = sign === 1 ? "add" : "subtract";
    const differences: DifferenceId[] = [...zoned(ctx)];
    const step =
      timeSteps[unit] ??
      (unit === "day" || unit === "week" || unit === "month" || unit === "year"
        ? null
        : timeSteps.millisecond);
    if (step) {
      // Day.js adds amount × step milliseconds to the instant, then truncates to milliseconds
      const [plural, ms] = step;
      if (literal) {
        const total = v.value * ms;
        if (Number.isInteger(v.value))
          return rewrite(`${ctx.recv}.${verb}({ ${plural}: ${v.value} })`, differences);
        if (Number.isInteger(total))
          return rewrite(`${ctx.recv}.${verb}({ milliseconds: ${total} })`, differences);
        return none("a fractional amount of milliseconds is truncated by Day.js");
      }
      return rewrite(`${ctx.recv}.${verb}({ ${plural}: ${amount.text} })`, [
        ...differences,
        "fractional-amounts",
      ]);
    }
    if (unit === "day" || unit === "week") {
      // Day.js rounds amount × 1 or × 7 to whole days and moves the local date with setDate, which
      // re-reads the wall clock: from the second of two repeated times, adding 0 gives the first
      const factor = unit === "week" ? 7 : 1;
      if (literal) {
        const days = Math.round(sign * v.value * factor);
        if (!Number.isFinite(days)) return none("not a finite amount");
        if (days === 0)
          return none(
            "Day.js re-reads the wall clock even for 0 days; Temporal leaves the value as it is"
          );
        return rewrite(
          Number.isInteger(v.value)
            ? `${ctx.recv}.${verb}({ ${unit}s: ${v.value} })`
            : `${ctx.recv}.add({ days: ${days} })`,
          differences
        );
      }
      return rewrite(`${ctx.recv}.${verb}({ ${unit}s: ${amount.text} })`, [
        ...differences,
        "fractional-amounts",
        "dayjs-dst-steps",
      ]);
    }
    // months and years: Day.js sets the month or year through the first of the month, then clamps
    // the day as Temporal does
    if (literal && !Number.isInteger(v.value))
      return none("a fractional amount of months is truncated by Day.js");
    return rewrite(`${ctx.recv}.${verb}({ ${unit}s: ${amount.text} })`, [
      ...differences,
      "dayjs-dst-steps",
      ...(literal ? [] : (["fractional-amounts"] as const)),
    ]);
  }
  method(owner, "add", "`.add({ [unit]s: amount })` (exact for integer amounts)", (ctx) =>
    shift(ctx, 1)
  );
  method(owner, "subtract", "`.subtract({ [unit]s: amount })` (exact for integer amounts)", (ctx) =>
    shift(ctx, -1)
  );

  function startOrEnd(ctx: Context, start: boolean): Outcome {
    if (ctx.args.length !== 1) return none("startOf() takes a unit");
    const unit = dayjsUnit(ctx.args[0]);
    if (unit === null) return none("the unit is not known statically");
    const r = ctx.recv;
    const differences = zoned(ctx);
    // years and months: Day.js builds the date with new Date(y, m, d), which reads 0-99 as 19xx
    const years: DifferenceId[] = [...differences, "dayjs-years"];
    switch (unit) {
      case "year":
        return start
          ? rewrite(`${r}.with({ month: 1, day: 1 }).startOfDay()`, years)
          : rewrite(withFields(ctx, `month: 12, day: 31, ${endOfDay}`), years);
      case "month":
        return start
          ? rewrite(`${r}.with({ day: 1 }).startOfDay()`, years)
          : rewrite(withFields(ctx, `day: 31, ${endOfDay}`), years);
      case "day":
      case "date":
        return start
          ? rewrite(`${r}.startOfDay()`, differences)
          : rewrite(withFields(ctx, endOfDay), differences);
      case "hour":
        return rewrite(
          withFields(
            ctx,
            start
              ? "minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0"
              : "minute: 59, second: 59, millisecond: 999, microsecond: 0, nanosecond: 0"
          ),
          differences
        );
      case "minute":
        return rewrite(
          withFields(
            ctx,
            start
              ? "second: 0, millisecond: 0, microsecond: 0, nanosecond: 0"
              : "second: 59, millisecond: 999, microsecond: 0, nanosecond: 0"
          ),
          differences
        );
      case "second":
        return rewrite(
          withFields(
            ctx,
            start
              ? "millisecond: 0, microsecond: 0, nanosecond: 0"
              : "millisecond: 999, microsecond: 0, nanosecond: 0"
          ),
          differences
        );
      case "week":
        return none(
          "the start of the week needs the weekday and the locale; Temporal has no single method"
        );
      default:
        return none(`${unit} is not a unit Day.js rounds to`);
    }
  }
  method(
    owner,
    "startOf",
    "`.startOfDay()` from the first day of the unit, or `.with(...)` for times (exact; years and months differ: dayjs-years; week: none)",
    (ctx) => startOrEnd(ctx, true)
  );
  method(
    owner,
    "endOf",
    '`.with({ ..., hour: 23, minute: 59, second: 59, millisecond: 999 }, { offset: "ignore" })` (week: none)',
    (ctx) => startOrEnd(ctx, false)
  );

  // --- comparisons and differences

  /** The other value: a Dayjs (rewritten to a ZonedDateTime) or nothing (now). */
  function other(ctx: Context): string | null {
    const [that] = ctx.args;
    if (that === undefined || that.value.kind === "undefined")
      return `Temporal.Now.zonedDateTimeISO().round({ smallestUnit: ${str("millisecond", ctx.quote)}, roundingMode: ${str("floor", ctx.quote)} })`;
    return that.value.kind === "dynamic" && that.value.type === "Dayjs" ? that.text : null;
  }
  for (const [name, operator] of [
    ["isBefore", "<"],
    ["isAfter", ">"],
    ["isSame", "==="],
  ] as const)
    method(
      owner,
      name,
      `\`Temporal.ZonedDateTime.compare(a, b) ${operator} 0\` (exact without a unit; with one, isBefore and isAfter compare with endOf or startOf)`,
      (ctx) => {
        if (ctx.args.length > 2) return none("too many arguments");
        const t = other(ctx);
        if (t === null) return none("compares with a value that is not a Day.js object");
        const unit = dayjsUnit(ctx.args[1]);
        if (unit === null) return none("the unit is not known statically");
        if (unit === "" || unit === "millisecond")
          return rewrite(
            `Temporal.ZonedDateTime.compare(${ctx.recv}, ${t}) ${operator} 0`,
            [],
            "expression"
          );
        if (name === "isSame")
          return none(
            "comparing within a unit needs both ends of it; Temporal has no unit-wise comparison"
          );
        const bound = startOrEnd({ ...ctx, args: [ctx.args[1]!] }, name === "isAfter");
        if (bound.kind !== "rewrite") return bound;
        return name === "isBefore"
          ? rewrite(
              `Temporal.ZonedDateTime.compare(${bound.text}, ${t}) < 0`,
              bound.differences,
              "expression"
            )
          : rewrite(
              `Temporal.ZonedDateTime.compare(${t}, ${bound.text}) < 0`,
              bound.differences,
              "expression"
            );
      }
    );

  method(
    owner,
    "diff",
    "`a.epochMilliseconds - b.epochMilliseconds` divided by the unit, truncated (exact up to hours; days and longer: none)",
    (ctx) => {
      if (ctx.args.length > 3) return none("too many arguments");
      const t = other(ctx);
      if (t === null) return none("measures from a value that is not a Day.js object");
      const unit = dayjsUnit(ctx.args[1]);
      if (unit === null) return none("the unit is not known statically");
      const float = ctx.args[2];
      const isFloat = float !== undefined && float.value.kind === "boolean" && float.value.value;
      if (float !== undefined && float.value.kind !== "boolean" && float.value.kind !== "undefined")
        return none("whether the result is fractional is not known statically");
      const step = unit === "" ? 1 : timeSteps[unit]?.[1];
      if (step === undefined)
        return none("days, weeks, months and years are counted with Day.js's own rules");
      const delta = `${ctx.recv}.epochMilliseconds - ${t}.epochMilliseconds`;
      if (step === 1) return rewrite(delta, [], "expression");
      const ratio = `(${delta}) / ${step}`;
      return rewrite(
        isFloat ? ratio : `Math.trunc(${ratio})`,
        [],
        isFloat ? "expression" : "member"
      );
    }
  );

  // --- conversions

  method(owner, "valueOf", "`.epochMilliseconds` (exact)", (ctx) =>
    ctx.args.length === 0
      ? rewrite(`${ctx.recv}.epochMilliseconds`)
      : none("valueOf() takes no arguments")
  );
  method(owner, "unix", "`Math.floor(x.epochMilliseconds / 1000)` (exact)", (ctx) =>
    ctx.args.length === 0
      ? rewrite(`Math.floor(${ctx.recv}.epochMilliseconds / 1000)`)
      : none("unix() takes no arguments")
  );
  method(owner, "toDate", "`new Date(x.epochMilliseconds)` (exact)", (ctx) =>
    ctx.args.length === 0
      ? rewrite(`new Date(${ctx.recv}.epochMilliseconds)`, [], "expression")
      : none("toDate() takes no arguments")
  );
  for (const name of ["toISOString", "toJSON"])
    method(owner, name, "`x.toInstant().toString({ fractionalSecondDigits: 3 })` (exact)", (ctx) =>
      ctx.args.length === 0
        ? rewrite(`${ctx.recv}.toInstant().toString({ fractionalSecondDigits: 3 })`)
        : none(`${name}() takes no arguments`)
    );
  method(owner, "toString", "`new Date(x.epochMilliseconds).toUTCString()` (exact)", (ctx) =>
    ctx.args.length === 0
      ? rewrite(`new Date(${ctx.recv}.epochMilliseconds).toUTCString()`)
      : none("toString() takes no arguments")
  );
  method(
    owner,
    "utcOffset",
    "`.offsetNanoseconds / 6e10` (differs: dayjs-offsets); with a value: none",
    (ctx) =>
      ctx.args.length === 0
        ? rewrite(`${ctx.recv}.offsetNanoseconds / 6e10`, ["dayjs-offsets"], "expression")
        : none("fixed UTC offsets are zones in Temporal: use withTimeZone with an offset string")
  );
  method(
    owner,
    "format",
    "`.toPlainDate().toString()` for YYYY-MM-DD and a few other fixed patterns (differs: dayjs-years); other patterns: none",
    (ctx) => {
      if (ctx.args.length > 1) return none("too many arguments");
      const [pattern] = ctx.args;
      const r = ctx.recv;
      const q = ctx.quote;
      const extended: DifferenceId[] = [...zoned(ctx), "dayjs-years"];
      if (pattern === undefined || pattern.value.kind === "undefined")
        return rewrite(
          `${r}.toString({ smallestUnit: ${str("second", q)}, timeZoneName: ${str("never", q)} })`,
          [
            ...extended,
            "dayjs-offsets",
            ...(ctx.facts.settings.has("dayjs:utc") ? (["iso-format"] as const) : []),
          ]
        );
      if (pattern.value.kind !== "string") return none("the pattern is not known statically");
      const fixed: Record<string, string> = {
        "YYYY-MM-DD": `${r}.toPlainDate().toString()`,
        "YYYY-MM-DDTHH:mm:ss": `${r}.toPlainDateTime().toString({ smallestUnit: ${str("second", q)} })`,
        "YYYY-MM-DD HH:mm:ss": `${r}.toPlainDateTime().toString({ smallestUnit: ${str("second", q)} }).replace(${str("T", q)}, ${str(" ", q)})`,
        "HH:mm": `${r}.toPlainTime().toString({ smallestUnit: ${str("minute", q)} })`,
        "HH:mm:ss": `${r}.toPlainTime().toString({ smallestUnit: ${str("second", q)} })`,
        "HH:mm:ss.SSS": `${r}.toPlainTime().toString({ smallestUnit: ${str("millisecond", q)} })`,
      };
      const text = fixed[pattern.value.value];
      if (
        ctx.facts.settings.has("dayjs:plugin:advancedFormat") &&
        pattern.value.value.includes("S")
      )
        return none("the advancedFormat plugin reads S as a token of its own");
      if (text === undefined)
        return none(
          "Temporal has no token-based formatter; use toLocaleString or Intl.DateTimeFormat"
        );
      return rewrite(text, pattern.value.value.startsWith("HH") ? zoned(ctx) : extended);
    }
  );

  // --- plugins: utc and timezone

  method(owner, "utc", '`.withTimeZone("UTC")` (utc plugin)', (ctx) =>
    ctx.args.length === 0
      ? rewrite(`${ctx.recv}.withTimeZone(${str("UTC", ctx.quote)})`)
      : none("keeping the local time has no single Temporal method")
  );
  method(owner, "local", "`.withTimeZone(Temporal.Now.timeZoneId())` (utc plugin)", (ctx) =>
    ctx.args.length === 0
      ? rewrite(`${ctx.recv}.withTimeZone(Temporal.Now.timeZoneId())`)
      : none("local() takes no arguments")
  );
  method(
    owner,
    "isUTC",
    '`x.timeZoneId === "UTC"` (utc plugin; differs where the system zone is UTC: dayjs-utc-mode)',
    (ctx) =>
      ctx.args.length === 0
        ? rewrite(
            `${ctx.recv}.timeZoneId === ${str("UTC", ctx.quote)}`,
            ["dayjs-utc-mode"],
            "expression"
          )
        : none("isUTC() takes no arguments")
  );
  method(owner, "tz", "`.withTimeZone(zone)` (timezone plugin)", (ctx) => {
    const [zone, keep] = ctx.args;
    if (keep !== undefined) return none("keeping the local time has no single Temporal method");
    if (zone === undefined)
      return none(
        ctx.facts.settings.has("dayjs.tz.setDefault")
          ? "uses the zone set with dayjs.tz.setDefault, which Temporal does not have"
          : "a zone is needed"
      );
    return zone.value.kind === "string" ||
      (zone.value.kind === "dynamic" && zone.value.type === "string")
      ? rewrite(`${ctx.recv}.withTimeZone(${zone.text})`, ["dayjs-tz"])
      : none("the zone must be a string");
  });
  unsupported(
    owner,
    false,
    ["offsetName"],
    "zone names come from Intl.DateTimeFormat's timeZoneName option",
    ["call"]
  );
  unsupported(
    owner,
    false,
    ["locale"],
    "Day.js locales have no Temporal counterpart; pass a locale to toLocaleString",
    ["call"]
  );
  unsupported(
    owner,
    false,
    ["isValid"],
    "Temporal throws on invalid input instead of returning an invalid object",
    ["call"]
  );
  unsupported(
    owner,
    false,
    ["$locale", "$utils", "$g", "$set", "parse", "init"],
    "Day.js internals",
    ["call"]
  );
}
