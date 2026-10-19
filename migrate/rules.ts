// What replaces each member of momentum's API in native Temporal code. A rule turns one use (a
// property read, a method call) into the text of a native expression, given the rendered text of
// its receiver and arguments and what is statically known about them. A rewrite without
// differences is exact: test/momentum/migrateRules.test.js checks every one against momentum with
// fast-check. A rewrite that can behave differently lists its differences (./differences.ts), and
// "none" means there is no native replacement yet.
//
// This module is pure: the analyzer (./analyze.ts) builds the context from the TypeScript AST.

import { DateTime, Duration } from "../src/momentum.js";
import type { DifferenceId } from "./differences.js";
import { defineDayjsRules } from "./dayjs.js";

export type ClassName =
  | "DateTime"
  | "Duration"
  | "Interval"
  | "Info"
  | "Settings"
  | "Zone"
  | "IANAZone"
  | "FixedOffsetZone"
  | "SystemZone"
  | "InvalidZone"
  | "Dayjs"
  | "DayjsTimezone";

/** What the analyzer knows about an expression without running the program. */
export type Static =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "undefined" }
  /** an object literal with plain keys; each property keeps its own text and value */
  | { kind: "object"; props: Readonly<Record<string, Arg>> }
  /** a static member of a momentum class, such as DateTime.DATE_MED */
  | { kind: "member"; owner: ClassName; name: string }
  | { kind: "dynamic"; type: "number" | "string" | "object" | "date" | "unknown" | ClassName };

export interface Arg {
  /** The source text, with nested rewrites applied. */
  text: string;
  value: Static;
}

/** Facts about the whole project that decide whether some rewrites are exact. */
export interface Facts {
  /** Settings properties the project assigns (now, defaultZone, defaultLocale, ...). */
  settings: ReadonlySet<string>;
  /** Whether some DateTime or Duration may carry a locale, numbering system or calendar. */
  localeConfigured: boolean;
}

export interface Context {
  recv: string;
  args: readonly Arg[];
  facts: Facts;
  /** Quote character for the strings a rewrite introduces. */
  quote: '"' | "'";
  /** The units a Duration receiver is known to have, when it was just built from literals. */
  receiverUnits?: readonly string[];
}

/** "member": can be followed by `.x` as is; "expression": needs parentheses there. */
export type Precedence = "member" | "expression";

export type Outcome =
  | { kind: "rewrite"; text: string; differences: readonly DifferenceId[]; precedence: Precedence }
  | { kind: "none"; reason: string };

export interface Rule {
  owner: ClassName;
  static: boolean;
  name: string;
  /** "get" for property reads, "call" for method calls. */
  form: "get" | "call";
  apply(ctx: Context): Outcome;
  /** The replacement as the docs show it, and when it is exact. */
  doc: string;
}

const rewrite = (
  text: string,
  differences: readonly DifferenceId[] = [],
  precedence: Precedence = "member"
): Outcome => ({ kind: "rewrite", text, differences: [...new Set(differences)], precedence });
const none = (reason: string): Outcome => ({ kind: "none", reason });

const temporal = () => (globalThis as { Temporal?: any }).Temporal;

// --- helpers for static values

const isInt = (v: Static): v is { kind: "number"; value: number } =>
  v.kind === "number" && Number.isInteger(v.value);

function str(value: string, quote: string): string {
  return `${quote}${value.replace(/\\/g, "\\\\").replaceAll(quote, `\\${quote}`)}${quote}`;
}

function objectText(entries: readonly (readonly [string, string])[]): string {
  return `{ ${entries.map(([k, v]) => `${k}: ${v}`).join(", ")} }`;
}

/** Wraps an argument in parentheses unless it can be followed by `.x` as written. */
function asReceiver(text: string): string {
  return /^[\w$.]+(\(\))?$/.test(text) ? text : `(${text})`;
}

// --- Luxon's units

const durationUnits = [
  "years",
  "quarters",
  "months",
  "weeks",
  "days",
  "hours",
  "minutes",
  "seconds",
  "milliseconds",
];
const timeUnits = new Set(["hours", "minutes", "seconds", "milliseconds"]);
/** Luxon accepts singular and plural unit names; Temporal durations take the plural. */
function pluralUnit(name: string): string | null {
  const k = name.toLowerCase();
  const plural = k.endsWith("s") ? k : `${k}s`;
  return durationUnits.includes(plural) ? plural : null;
}
const fieldUnits = ["year", "month", "day", "hour", "minute", "second", "millisecond"] as const;
/** Luxon's set() and fromObject() accept either form; Temporal fields are singular. */
function singularField(name: string): string | null {
  const k = name.toLowerCase();
  const singular = k.endsWith("s") ? k.slice(0, -1) : k;
  return (fieldUnits as readonly string[]).includes(singular) ? singular : null;
}
/** Values that never overflow, whatever the other fields (day 28 exists in every month). */
const safeRange: Record<string, [number, number]> = {
  month: [1, 12],
  day: [1, 28],
  hour: [0, 23],
  minute: [0, 59],
  second: [0, 59],
  millisecond: [0, 999],
};
const inSafeRange = (field: string, value: number) => {
  const range = safeRange[field];
  return range === undefined || (value >= range[0] && value <= range[1]);
};

// --- zones

/** A zone argument: its text, the zone id when it is known statically, and differences. */
type Piece = { text: string; id: string | null; differences: DifferenceId[] } | { none: string };

/** The default zone: the system zone unless the project changes Settings.defaultZone. */
function defaultZone(facts: Facts): Piece {
  return facts.settings.has("defaultZone")
    ? { none: "the project sets Settings.defaultZone, which has no Temporal counterpart" }
    : { text: "Temporal.Now.timeZoneId()", id: null, differences: [] };
}

const luxonOffset = /^utc([+-])(\d{1,2})(?::?(\d{2}))?$/i;

/** A zone argument: the string Temporal takes, or why there is none. */
function zonePiece(arg: Arg | undefined, ctx: Context): Piece {
  const v = arg?.value;
  if (arg === undefined || v === undefined || v.kind === "undefined") return defaultZone(ctx.facts);
  if (v.kind === "string") {
    const lower = v.value.toLowerCase();
    if (lower === "default") return defaultZone(ctx.facts);
    if (lower === "local" || lower === "system")
      return { text: "Temporal.Now.timeZoneId()", id: null, differences: [] };
    if (lower === "utc" || lower === "gmt")
      return { text: str("UTC", ctx.quote), id: "UTC", differences: [] };
    const m = luxonOffset.exec(v.value);
    if (m) {
      const offset = `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}`;
      return { text: str(offset, ctx.quote), id: offset, differences: ["fixed-offset-names"] };
    }
    try {
      new (temporal().ZonedDateTime)(0n, v.value);
    } catch {
      return { none: `"${v.value}" is not a time zone Temporal knows` };
    }
    return { text: arg.text, id: v.value, differences: [] };
  }
  if (v.kind === "dynamic" && (v.type === "string" || v.type === "unknown"))
    return { text: arg.text, id: null, differences: ["zone-specifiers", "invalid-throws"] };
  return { none: "Zone objects have no Temporal counterpart; pass the zone's name" };
}

/** Factory options: only `zone` has a Temporal counterpart. */
function optionsZone(
  arg: Arg | undefined,
  ctx: Context,
  allowed: readonly string[] = ["zone"]
): Piece {
  if (arg === undefined || arg.value.kind === "undefined") return defaultZone(ctx.facts);
  if (arg.value.kind !== "object") return { none: "the options are not known statically" };
  for (const name of Object.keys(arg.value.props)) {
    if (!allowed.includes(name))
      return {
        none: ["locale", "numberingSystem", "outputCalendar"].includes(name)
          ? "Temporal objects carry no locale"
          : `the ${name} option has no Temporal counterpart`,
      };
  }
  return zonePiece(arg.value.props.zone, ctx);
}

/**
 * Whether a wall-clock time occurs twice in a zone, decided with Temporal itself. A skipped time
 * moves forward in momentum and in Temporal alike; only a repeated one can resolve differently.
 */
export function isRepeated(fields: Readonly<Record<string, number>>, zone: string): boolean {
  const pdt = temporal().PlainDateTime.from(fields, { overflow: "reject" });
  const earlier = pdt.toZonedDateTime(zone, { disambiguation: "earlier" });
  const later = pdt.toZonedDateTime(zone, { disambiguation: "later" });
  return (
    earlier.epochNanoseconds !== later.epochNanoseconds &&
    earlier.toPlainDateTime().equals(pdt) &&
    later.toPlainDateTime().equals(pdt)
  );
}

/** Opting out of the Temporal-native core brings back Luxon's offset search for wall-clock times. */
const optedOut = (facts: Facts) =>
  facts.settings.has("temporalNative")
    ? "the project sets Settings.temporalNative, whose opt-out resolves wall-clock times with Luxon's algorithm"
    : null;

/**
 * Wall-clock fields to a ZonedDateTime. Exact when every field is an integer literal that cannot
 * overflow and the zone is a literal in which that time occurs once.
 */
function fromFields(
  fields: readonly (readonly [string, Arg])[],
  zone: Piece,
  repeatable: boolean,
  facts: Facts
): Outcome {
  if ("none" in zone) return none(zone.none);
  const opt = optedOut(facts);
  if (opt !== null && repeatable) return none(opt);
  const diffs: DifferenceId[] = [...zone.differences];
  const known: Record<string, number> = {};
  let literal = true;
  for (const [field, arg] of fields) {
    const v = arg.value;
    if (v.kind === "dynamic") literal = false;
    else if (!isInt(v)) return none(`${field} is not an integer`);
    else {
      known[field] = v.value;
      if (!inSafeRange(field, v.value)) diffs.push("overflow");
    }
  }
  if (!literal) diffs.push("overflow", "invalid-throws");
  if (repeatable) {
    const z = zone.id;
    if (!literal || z === null) diffs.push("repeated-wall-time");
    else {
      try {
        if (isRepeated(known, z)) diffs.push("repeated-wall-time");
      } catch {
        diffs.push("overflow");
      }
    }
  }
  return rewrite(
    `Temporal.ZonedDateTime.from(${objectText([...fields.map(([f, a]) => [f, a.text] as const), ["timeZone", zone.text]])})`,
    diffs
  );
}

const numberArg = (value: number): Arg => ({
  text: String(value),
  value: { kind: "number", value },
});

// --- the catalog

const rules = new Map<string, Rule>();
const ruleKey = (owner: ClassName, isStatic: boolean, name: string, form: "get" | "call") =>
  `${owner}${isStatic ? "." : "#"}${name}:${form}`;

function add(
  owner: ClassName,
  isStatic: boolean,
  name: string,
  form: "get" | "call",
  doc: string,
  apply: (ctx: Context) => Outcome
) {
  rules.set(ruleKey(owner, isStatic, name, form), {
    owner,
    static: isStatic,
    name,
    form,
    apply,
    doc,
  });
}
const getter = (owner: ClassName, name: string, doc: string, apply: (ctx: Context) => Outcome) =>
  add(owner, false, name, "get", doc, apply);
const method = (owner: ClassName, name: string, doc: string, apply: (ctx: Context) => Outcome) =>
  add(owner, false, name, "call", doc, apply);
const staticGet = (owner: ClassName, name: string, doc: string, apply: (ctx: Context) => Outcome) =>
  add(owner, true, name, "get", doc, apply);
const staticCall = (
  owner: ClassName,
  name: string,
  doc: string,
  apply: (ctx: Context) => Outcome
) => add(owner, true, name, "call", doc, apply);
function unsupported(
  owner: ClassName,
  isStatic: boolean,
  names: readonly string[],
  reason: string,
  forms: readonly ("get" | "call")[] = ["get", "call"]
) {
  for (const name of names)
    for (const form of forms)
      add(owner, isStatic, name, form, `none: ${reason}`, () => none(reason));
}
const noArgs = (ctx: Context, then: () => Outcome): Outcome =>
  ctx.args.length === 0 ? then() : none("arguments are not supported");

// DateTime getters
for (const name of [
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "millisecond",
  "daysInMonth",
  "daysInYear",
])
  getter("DateTime", name, `\`.${name}\` (exact)`, (ctx) => rewrite(`${ctx.recv}.${name}`));
const renamedGetters: Readonly<Record<string, string>> = {
  weekday: "dayOfWeek",
  ordinal: "dayOfYear",
  weekNumber: "weekOfYear",
  weekYear: "yearOfWeek",
  isInLeapYear: "inLeapYear",
};
for (const [name, native] of Object.entries(renamedGetters))
  getter("DateTime", name, `\`.${native}\` (exact)`, (ctx) => rewrite(`${ctx.recv}.${native}`));
getter("DateTime", "quarter", "`Math.ceil(x.month / 3)` (exact)", (ctx) =>
  rewrite(`Math.ceil(${ctx.recv}.month / 3)`)
);
getter("DateTime", "offset", "`x.offsetNanoseconds / 6e10` (exact)", (ctx) =>
  rewrite(`${ctx.recv}.offsetNanoseconds / 6e10`, [], "expression")
);
getter("DateTime", "zoneName", "`.timeZoneId` (differs: fixed-offset-names)", (ctx) =>
  rewrite(`${ctx.recv}.timeZoneId`, ["fixed-offset-names"])
);
const localeNames: Readonly<Record<string, readonly [string, string]>> = {
  monthLong: ["month", "long"],
  monthShort: ["month", "short"],
  weekdayLong: ["weekday", "long"],
  weekdayShort: ["weekday", "short"],
};
for (const [name, [field, width]] of Object.entries(localeNames))
  getter(
    "DateTime",
    name,
    `\`.toLocaleString(undefined, { ${field}: "${width}" })\` (exact without locale configuration${field === "month" ? "; differs: julian-dates" : ""})`,
    (ctx) =>
      ctx.facts.localeConfigured
        ? none("values may carry a locale; Temporal objects don't")
        : // weekday names do not depend on the calendar; month names do
          rewrite(
            `${ctx.recv}.toLocaleString(undefined, { ${field}: ${str(width, ctx.quote)} })`,
            field === "month" ? ["julian-dates"] : []
          )
  );
unsupported(
  "DateTime",
  false,
  ["isValid", "invalidReason", "invalidExplanation"],
  "Temporal objects are always valid: invalid input throws where it is created instead"
);
unsupported(
  "DateTime",
  false,
  ["zone"],
  "Zone objects have no Temporal counterpart; timeZoneId gives the name"
);
unsupported(
  "DateTime",
  false,
  [
    "locale",
    "numberingSystem",
    "outputCalendar",
    "resolvedLocaleOptions",
    "setLocale",
    "reconfigure",
  ],
  "Temporal objects carry no locale; pass it to toLocaleString instead"
);
unsupported("DateTime", false, ["isOffsetFixed"], "Temporal has no flag for fixed-offset zones");
unsupported("DateTime", false, ["isInDST"], "Temporal has no daylight-saving flag");
unsupported(
  "DateTime",
  false,
  ["isWeekend", "localWeekNumber", "localWeekYear", "localWeekday", "weeksInLocalWeekYear"],
  "Temporal has no locale-dependent weeks"
);
unsupported("DateTime", false, ["weeksInWeekYear"], "Temporal has no weeks-in-year property");
unsupported(
  "DateTime",
  false,
  ["offsetNameShort", "offsetNameLong"],
  "Temporal has no offset names; Intl.DateTimeFormat#formatToParts has them"
);
unsupported(
  "DateTime",
  false,
  ["wasHole"],
  "Temporal does not report whether a wall-clock time was skipped"
);

// DateTime methods
for (const name of ["toMillis", "valueOf"])
  method("DateTime", name, "`.epochMilliseconds` (exact)", (ctx) =>
    noArgs(ctx, () => rewrite(`${ctx.recv}.epochMilliseconds`))
  );
method("DateTime", "toSeconds", "`x.epochMilliseconds / 1000` (exact)", (ctx) =>
  noArgs(ctx, () => rewrite(`${ctx.recv}.epochMilliseconds / 1000`, [], "expression"))
);
method("DateTime", "toUnixInteger", "`Math.floor(x.epochMilliseconds / 1000)` (exact)", (ctx) =>
  noArgs(ctx, () => rewrite(`Math.floor(${ctx.recv}.epochMilliseconds / 1000)`))
);
for (const name of ["toJSDate", "toBSON"])
  method("DateTime", name, "`new Date(x.epochMilliseconds)` (exact)", (ctx) =>
    noArgs(ctx, () => rewrite(`new Date(${ctx.recv}.epochMilliseconds)`))
  );
method("DateTime", "toISODate", "`.toPlainDate().toString()` (exact)", (ctx) =>
  noArgs(ctx, () => rewrite(`${ctx.recv}.toPlainDate().toString()`))
);
method(
  "DateTime",
  "toISOTime",
  "`.toPlainTime().toString({ fractionalSecondDigits: 3 })` for `{ includeOffset: false }` (exact)",
  (ctx) => {
    const [opts] = ctx.args;
    const props = opts?.value.kind === "object" ? opts.value.props : null;
    if (
      ctx.args.length === 1 &&
      props &&
      Object.keys(props).length === 1 &&
      props.includeOffset?.value.kind === "boolean" &&
      !props.includeOffset.value.value
    )
      return rewrite(`${ctx.recv}.toPlainTime().toString({ fractionalSecondDigits: 3 })`);
    return none("a time with its offset has no single Temporal method");
  }
);
for (const name of ["toISO", "toString", "toJSON"])
  method(
    "DateTime",
    name,
    '`.toString({ fractionalSecondDigits: 3, timeZoneName: "never" })` (differs: iso-format)',
    (ctx) =>
      noArgs(ctx, () =>
        rewrite(
          `${ctx.recv}.toString({ fractionalSecondDigits: 3, timeZoneName: ${str("never", ctx.quote)} })`,
          ["iso-format"]
        )
      )
  );
let presetCache: Record<string, Readonly<Record<string, string>>> | null = null;
/** DateTime.DATE_SHORT and friends: plain Intl options objects. */
export function presets(): Record<string, Readonly<Record<string, string>>> {
  if (presetCache === null) {
    presetCache = {};
    for (const name of Object.getOwnPropertyNames(DateTime))
      if (/^(DATE|TIME|DATETIME)_/.test(name))
        presetCache[name] = (DateTime as unknown as Record<string, Record<string, string>>)[name];
  }
  return presetCache;
}
function presetText(name: string, quote: string): string {
  return objectText(Object.entries(presets()[name]).map(([k, v]) => [k, str(v, quote)] as const));
}
method(
  "DateTime",
  "toLocaleString",
  "`.toLocaleString(locale, options)` (differs: julian-dates, and fixed-offset-names when the options name the time zone)",
  (ctx) => {
    const [format, opts] = ctx.args;
    if (ctx.args.length > 2) return none("arguments are not supported");
    let locale = "undefined";
    if (opts !== undefined) {
      if (opts.value.kind !== "object") return none("the options are not known statically");
      for (const [name, v] of Object.entries(opts.value.props)) {
        if (name !== "locale") return none(`the ${name} option has no Temporal counterpart`);
        if (v.value.kind !== "string") return none("the locale is not known statically");
        locale = v.text;
      }
    }
    if (locale === "undefined" && ctx.facts.localeConfigured)
      return none("values may carry a locale; Temporal objects don't");
    let formatText: string;
    let namesZone: boolean;
    const f = format?.value;
    if (f === undefined || f.kind === "undefined") {
      formatText = presetText("DATE_SHORT", ctx.quote);
      namesZone = false;
    } else if (f.kind === "member" && f.owner === "DateTime" && f.name in presets()) {
      formatText = presetText(f.name, ctx.quote);
      namesZone = "timeZoneName" in presets()[f.name];
    } else if (f.kind === "object") {
      formatText = format!.text;
      namesZone = "timeZoneName" in f.props;
    } else {
      formatText = format!.text;
      namesZone = true;
    }
    return rewrite(
      `${ctx.recv}.toLocaleString(${locale}, ${formatText})`,
      namesZone ? ["julian-dates", "fixed-offset-names"] : ["julian-dates"]
    );
  }
);
method("DateTime", "toUTC", '`.withTimeZone("UTC")` (exact)', (ctx) =>
  noArgs(ctx, () => rewrite(`${ctx.recv}.withTimeZone(${str("UTC", ctx.quote)})`))
);
method(
  "DateTime",
  "toLocal",
  "`.withTimeZone(Temporal.Now.timeZoneId())` (exact unless Settings.defaultZone is set)",
  (ctx) =>
    noArgs(ctx, () => {
      const zone = defaultZone(ctx.facts);
      return "none" in zone ? none(zone.none) : rewrite(`${ctx.recv}.withTimeZone(${zone.text})`);
    })
);
method(
  "DateTime",
  "setZone",
  "`.withTimeZone(zone)` (exact for literal IANA names and UTC)",
  (ctx) => {
    const [zone, opts] = ctx.args;
    if (ctx.args.length === 0 || ctx.args.length > 2) return none("arguments are not supported");
    if (
      opts !== undefined &&
      !(opts.value.kind === "object" && Object.keys(opts.value.props).length === 0)
    )
      return none("keepLocalTime has no single Temporal method");
    const piece = zonePiece(zone, ctx);
    return "none" in piece
      ? none(piece.none)
      : rewrite(`${ctx.recv}.withTimeZone(${piece.text})`, piece.differences);
  }
);
for (const [name, native] of [
  ["plus", "add"],
  ["minus", "subtract"],
] as const)
  method(
    "DateTime",
    name,
    `\`.${native}(duration)\` (exact for integer time units; calendar units differ: repeated-wall-time)`,
    (ctx) => {
      if (ctx.args.length !== 1) return none("arguments are not supported");
      const [arg] = ctx.args;
      const v = arg.value;
      const opt = optedOut(ctx.facts);
      if (
        opt !== null &&
        !(
          v.kind === "object" &&
          Object.keys(v.props).every((k) => timeUnits.has(pluralUnit(k) ?? ""))
        )
      )
        return none(opt);
      if (v.kind === "number") {
        if (!Number.isInteger(v.value)) return none("fractional milliseconds would throw");
        return rewrite(`${ctx.recv}.${native}({ milliseconds: ${arg.text} })`);
      }
      if (v.kind === "dynamic" && v.type === "number")
        return rewrite(`${ctx.recv}.${native}({ milliseconds: ${arg.text} })`, [
          "fractional-amounts",
        ]);
      if (v.kind === "dynamic" && v.type === "Duration")
        return rewrite(`${ctx.recv}.${native}(${arg.text})`, [
          "fractional-amounts",
          "repeated-wall-time",
        ]);
      if (v.kind !== "object") return none("the duration's units are not known statically");
      const parts: [string, string][] = [];
      const diffs: DifferenceId[] = [];
      let sign = 0;
      for (const [name, prop] of Object.entries(v.props)) {
        const unit = pluralUnit(name);
        if (unit === null) return none(`${name} is not a duration unit`);
        if (!timeUnits.has(unit)) diffs.push("repeated-wall-time");
        let text: string;
        if (prop.value.kind === "number") {
          if (!Number.isInteger(prop.value.value)) return none("fractional amounts would throw");
          const s = Math.sign(prop.value.value);
          if (s !== 0 && sign !== 0 && s !== sign)
            return none("mixed signs would throw; split it into two calls");
          if (s !== 0) sign = s;
          text = String(unit === "quarters" ? prop.value.value * 3 : prop.value.value);
        } else if (prop.value.kind === "dynamic") {
          diffs.push("fractional-amounts");
          text = unit === "quarters" ? `(${prop.text}) * 3` : prop.text;
        } else return none(`${name} is not a number`);
        parts.push([unit === "quarters" ? "months" : unit, text]);
      }
      return rewrite(`${ctx.recv}.${native}(${objectText(parts)})`, diffs);
    }
  );
method(
  "DateTime",
  "set",
  "`.with(fields)` (exact for time fields in range; date fields differ: overflow)",
  (ctx) => {
    const [arg] = ctx.args;
    if (ctx.args.length !== 1 || arg.value.kind !== "object")
      return none("the fields are not known statically");
    const opt = optedOut(ctx.facts);
    if (opt !== null) return none(opt);
    const parts: [string, string][] = [];
    const diffs: DifferenceId[] = [];
    for (const [name, prop] of Object.entries(arg.value.props)) {
      const field = singularField(name);
      if (field === null) return none(`${name} has no Temporal field`);
      if (field === "year" || field === "month" || field === "day") diffs.push("overflow");
      if (prop.value.kind === "number") {
        if (!Number.isInteger(prop.value.value)) return none(`${name} is not an integer`);
        if (!inSafeRange(field, prop.value.value)) diffs.push("overflow");
      } else if (prop.value.kind === "dynamic") diffs.push("overflow");
      else return none(`${name} is not a number`);
      parts.push([field, prop.text]);
    }
    return rewrite(`${ctx.recv}.with(${objectText(parts)})`, diffs);
  }
);
function unitArg(ctx: Context): string | null {
  const [unit, opts] = ctx.args;
  if (opts !== undefined || unit?.value.kind !== "string") return null;
  const u = unit.value.value.toLowerCase().replace(/s$/, "");
  return (fieldUnits as readonly string[]).includes(u) ? u : null;
}
method(
  "DateTime",
  "startOf",
  '`.round({ smallestUnit, roundingMode: "floor" })` up to hours (exact); `.startOfDay()` for days, months and years (differs: repeated-midnight)',
  (ctx) => {
    const r = ctx.recv;
    const q = ctx.quote;
    switch (unitArg(ctx)) {
      case "millisecond":
        return rewrite(r);
      case "second":
      case "minute":
      case "hour": {
        const unit = unitArg(ctx)!;
        return rewrite(
          `${r}.round({ smallestUnit: ${str(unit, q)}, roundingMode: ${str("floor", q)} })`
        );
      }
      case "day":
        return rewrite(`${r}.startOfDay()`, ["repeated-midnight"]);
      case "month":
        return rewrite(`${r}.with({ day: 1 }).startOfDay()`, ["repeated-midnight"]);
      case "year":
        return rewrite(`${r}.with({ month: 1, day: 1 }).startOfDay()`, ["repeated-midnight"]);
      default:
        return none(
          "weeks, quarters and units not known statically have no single Temporal method"
        );
    }
  }
);
method(
  "DateTime",
  "endOf",
  "the next unit's start minus a millisecond (exact up to hours; days and longer differ: repeated-midnight, repeated-wall-time)",
  (ctx) => {
    const r = ctx.recv;
    const q = ctx.quote;
    const unit = unitArg(ctx);
    switch (unit) {
      case "millisecond":
        return rewrite(r);
      case "second":
      case "minute":
      case "hour":
        return rewrite(
          `${r}.add({ ${unit}s: 1 }).round({ smallestUnit: ${str(unit, q)}, roundingMode: ${str("floor", q)} }).subtract({ milliseconds: 1 })`
        );
      case "day":
        return rewrite(`${r}.add({ days: 1 }).startOfDay().subtract({ milliseconds: 1 })`, [
          "repeated-midnight",
          "repeated-wall-time",
        ]);
      case "month":
        return rewrite(
          `${r}.add({ months: 1 }).with({ day: 1 }).startOfDay().subtract({ milliseconds: 1 })`,
          ["repeated-midnight", "repeated-wall-time"]
        );
      case "year":
        return rewrite(
          `${r}.add({ years: 1 }).with({ month: 1, day: 1 }).startOfDay().subtract({ milliseconds: 1 })`,
          ["repeated-midnight", "repeated-wall-time"]
        );
      default:
        return none(
          "weeks, quarters and units not known statically have no single Temporal method"
        );
    }
  }
);
method("DateTime", "equals", "`.equals(other)` (differs: link-name-equality)", (ctx) => {
  if (ctx.args.length !== 1) return none("arguments are not supported");
  if (ctx.facts.localeConfigured)
    return none("momentum's equals also compares locales, which Temporal objects don't have");
  return rewrite(`${ctx.recv}.equals(${ctx.args[0].text})`, ["link-name-equality"]);
});
method("DateTime", "get", "the getter of that unit", (ctx) => {
  const [unit] = ctx.args;
  if (ctx.args.length !== 1 || unit.value.kind !== "string")
    return none("the unit is not known statically");
  const rule = findRule("DateTime", false, unit.value.value, "get");
  return rule
    ? rule.apply({ ...ctx, args: [] })
    : none(`${unit.value.value} is not a DateTime getter`);
});
method("DateTime", "toZonedDateTime", "the value itself (exact)", (ctx) =>
  noArgs(ctx, () => rewrite(ctx.recv))
);
for (const name of ["toInstant", "toPlainDate", "toPlainDateTime", "toPlainTime"])
  method("DateTime", name, `\`.${name}()\` (exact)`, (ctx) =>
    noArgs(ctx, () => rewrite(`${ctx.recv}.${name}()`))
  );
unsupported(
  "DateTime",
  false,
  ["toFormat"],
  "Temporal has no token formatting; toLocaleString with Intl options is the native way",
  ["call"]
);
unsupported(
  "DateTime",
  false,
  ["toRelative", "toRelativeCalendar"],
  "Intl.RelativeTimeFormat formats a number and a unit; choosing them is momentum's logic",
  ["call"]
);
unsupported(
  "DateTime",
  false,
  ["toSQL", "toSQLDate", "toSQLTime", "toHTTP", "toRFC2822", "toISOWeekDate"],
  "no native formatter writes this format",
  ["call"]
);
unsupported(
  "DateTime",
  false,
  ["toObject"],
  "Temporal has no method returning all fields at once",
  ["call"]
);
unsupported(
  "DateTime",
  false,
  ["toLocaleParts"],
  "Temporal has no formatToParts; Intl.DateTimeFormat needs the zone passed explicitly",
  ["call"]
);
unsupported(
  "DateTime",
  false,
  ["diff", "diffNow"],
  "Temporal's since and until balance units and return integers where momentum returns fractions",
  ["call"]
);
unsupported("DateTime", false, ["hasSame"], "Temporal has no unit-wise comparison", ["call"]);
unsupported("DateTime", false, ["until"], "it returns an Interval, which Temporal does not have", [
  "call",
]);
unsupported(
  "DateTime",
  false,
  ["getPossibleOffsets"],
  "Temporal has no method listing a wall-clock time's offsets",
  ["call"]
);

// DateTime statics
function now(ctx: Context): Outcome {
  if (ctx.facts.settings.has("now"))
    return none("the project sets Settings.now, which Temporal.Now ignores");
  const zone = defaultZone(ctx.facts);
  if ("none" in zone) return none(zone.none);
  const q = ctx.quote;
  return rewrite(
    `Temporal.Now.zonedDateTimeISO().round({ smallestUnit: ${str("millisecond", q)}, roundingMode: ${str("floor", q)} })`
  );
}
staticCall(
  "DateTime",
  "now",
  '`Temporal.Now.zonedDateTimeISO().round({ smallestUnit: "millisecond", roundingMode: "floor" })` (exact)',
  (ctx) => noArgs(ctx, () => now(ctx))
);
function wallClockFactory(ctx: Context, utc: boolean): Outcome {
  let args = ctx.args;
  let opts: Arg | undefined;
  const last = args[args.length - 1];
  if (
    last &&
    (last.value.kind === "object" ||
      (last.value.kind === "dynamic" && last.value.type === "object"))
  ) {
    opts = last;
    args = args.slice(0, -1);
  }
  if (args.length === 0)
    return opts === undefined && !utc
      ? now(ctx)
      : none("the current time with options has no single Temporal call");
  if (args.length > 7) return none("arguments are not supported");
  const fields = fieldUnits.map(
    (field, i) => [field, args[i] ?? numberArg(i < 3 ? 1 : 0)] as const
  );
  let zone: Piece;
  if (utc) {
    const allowed = optionsZone(opts, ctx, []);
    zone =
      opts !== undefined && "none" in allowed
        ? allowed
        : { text: str("UTC", ctx.quote), id: "UTC", differences: [] };
  } else zone = optionsZone(opts, ctx);
  return fromFields(fields, zone, !utc, ctx.facts);
}
staticCall(
  "DateTime",
  "local",
  "`Temporal.ZonedDateTime.from({ ...fields, timeZone })` (exact for literal fields in a literal zone where that time occurs once)",
  (ctx) => wallClockFactory(ctx, false)
);
staticCall(
  "DateTime",
  "utc",
  '`Temporal.ZonedDateTime.from({ ...fields, timeZone: "UTC" })` (exact for literal fields that cannot overflow)',
  (ctx) => wallClockFactory(ctx, true)
);
staticCall(
  "DateTime",
  "fromMillis",
  "`Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone)` (exact for integer literals)",
  (ctx) => {
    const [ms, opts] = ctx.args;
    if (ms === undefined || ctx.args.length > 2) return none("arguments are not supported");
    const zone = optionsZone(opts, ctx);
    if ("none" in zone) return none(zone.none);
    const diffs = [...zone.differences];
    // momentum also needs the local time inside Date's range: the outermost day is "invalid" there
    if (!(isInt(ms.value) && Math.abs(ms.value.value) <= 8.64e15 - 864e5))
      diffs.push("invalid-throws");
    return rewrite(
      `Temporal.Instant.fromEpochMilliseconds(${ms.text}).toZonedDateTimeISO(${zone.text})`,
      diffs
    );
  }
);
staticCall(
  "DateTime",
  "fromSeconds",
  "`Temporal.Instant.fromEpochMilliseconds(seconds * 1000).toZonedDateTimeISO(zone)` (exact for integer literals)",
  (ctx) => {
    const [s, opts] = ctx.args;
    if (s === undefined || ctx.args.length > 2) return none("arguments are not supported");
    const zone = optionsZone(opts, ctx);
    if ("none" in zone) return none(zone.none);
    const diffs = [...zone.differences];
    if (!(isInt(s.value) && Math.abs(s.value.value) <= 8.64e12 - 86400))
      diffs.push("invalid-throws");
    return rewrite(
      `Temporal.Instant.fromEpochMilliseconds(${asReceiver(s.text)} * 1000).toZonedDateTimeISO(${zone.text})`,
      diffs
    );
  }
);
staticCall(
  "DateTime",
  "fromJSDate",
  "`date.toTemporalInstant().toZonedDateTimeISO(zone)` (differs: invalid-throws)",
  (ctx) => {
    const [date, opts] = ctx.args;
    if (date === undefined || ctx.args.length > 2) return none("arguments are not supported");
    const zone = optionsZone(opts, ctx);
    if ("none" in zone) return none(zone.none);
    return rewrite(
      `${asReceiver(date.text)}.toTemporalInstant().toZonedDateTimeISO(${zone.text})`,
      [...zone.differences, "invalid-throws"]
    );
  }
);
staticCall(
  "DateTime",
  "fromISO",
  "`Temporal.Instant.from(text).toZonedDateTimeISO(zone)` (exact for literal date-times with an offset; other strings differ: iso-grammar, invalid-throws)",
  (ctx) => {
    const [text, opts] = ctx.args;
    if (text === undefined || ctx.args.length > 2) return none("arguments are not supported");
    const zone = optionsZone(opts, ctx);
    if ("none" in zone) return none(zone.none);
    if (text.value.kind === "string") return fromIsoLiteral(text.value.value, text.text, zone);
    return rewrite(`Temporal.Instant.from(${text.text}).toZonedDateTimeISO(${zone.text})`, [
      ...zone.differences,
      "iso-grammar",
      "invalid-throws",
    ]);
  }
);
function fromIsoLiteral(
  value: string,
  text: string,
  zone: { text: string; id: string | null; differences: DifferenceId[] }
): Outcome {
  const z = zone.id;
  const reference = DateTime.fromISO(value, z ? { zone: z } : {});
  if (!reference.isValid) return none("momentum rejects this string; Temporal would throw");
  let instant: any;
  try {
    instant = temporal().Instant.from(value);
  } catch {
    // no offset: a wall-clock time, read in the zone
  }
  if (instant !== undefined)
    return instant.epochMilliseconds === reference.toMillis()
      ? rewrite(`Temporal.Instant.from(${text}).toZonedDateTimeISO(${zone.text})`, zone.differences)
      : none("Temporal reads this string as another instant");
  const dateOnly = /^[+-]?\d{4,6}-\d{2}-\d{2}$/.test(value);
  let pdt: any;
  try {
    pdt = temporal().PlainDateTime.from(value);
  } catch {
    return none("week dates, ordinal dates and reduced formats have no Temporal parser");
  }
  const diffs = [...zone.differences];
  const repeated: DifferenceId = dateOnly ? "repeated-midnight" : "repeated-wall-time";
  if (z === null) diffs.push(repeated);
  else {
    const fields = {
      year: pdt.year,
      month: pdt.month,
      day: pdt.day,
      hour: pdt.hour,
      minute: pdt.minute,
      second: pdt.second,
      millisecond: pdt.millisecond,
    };
    if (isRepeated(fields, z)) diffs.push(repeated);
    else if (pdt.toZonedDateTime(z).epochMilliseconds !== reference.toMillis())
      return none("Temporal reads this string as another instant");
  }
  return rewrite(
    dateOnly
      ? `Temporal.PlainDate.from(${text}).toZonedDateTime(${zone.text})`
      : `Temporal.PlainDateTime.from(${text}).toZonedDateTime(${zone.text})`,
    diffs
  );
}
staticCall(
  "DateTime",
  "fromObject",
  "`Temporal.ZonedDateTime.from({ ...fields, timeZone })` (exact for literal fields from the year down, in a literal zone where that time occurs once)",
  (ctx) => {
    const [obj, opts] = ctx.args;
    if (obj === undefined || ctx.args.length > 2) return none("arguments are not supported");
    if (obj.value.kind !== "object") return none("the fields are not known statically");
    const given = new Map<string, Arg>();
    for (const [name, prop] of Object.entries(obj.value.props)) {
      const field = singularField(name);
      if (field === null)
        return none(
          `${name} has no Temporal field (week and ordinal dates have no Temporal constructor)`
        );
      given.set(field, prop);
    }
    if (!given.has("year"))
      return none(
        "missing units default to the current date, which Temporal.ZonedDateTime.from does not do"
      );
    const fields = fieldUnits.map(
      (field, i) => [field, given.get(field) ?? numberArg(i < 3 ? 1 : 0)] as const
    );
    return fromFields(fields, optionsZone(opts, ctx), true, ctx.facts);
  }
);
staticCall("DateTime", "fromZonedDateTime", '`zdt.withCalendar("iso8601")` (exact)', (ctx) => {
  if (ctx.args.length !== 1) return none("options carry a locale, which Temporal objects don't");
  return rewrite(`${asReceiver(ctx.args[0].text)}.withCalendar(${str("iso8601", ctx.quote)})`);
});
staticCall("DateTime", "fromInstant", "`instant.toZonedDateTimeISO(zone)` (exact)", (ctx) => {
  const [instant, opts] = ctx.args;
  if (instant === undefined || ctx.args.length > 2) return none("arguments are not supported");
  const zone = optionsZone(opts, ctx);
  if ("none" in zone) return none(zone.none);
  return rewrite(`${asReceiver(instant.text)}.toZonedDateTimeISO(${zone.text})`, zone.differences);
});
staticCall("DateTime", "isDateTime", "`x instanceof Temporal.ZonedDateTime` (exact)", (ctx) =>
  ctx.args.length === 1
    ? rewrite(`${ctx.args[0].text} instanceof Temporal.ZonedDateTime`, [], "expression")
    : none("arguments are not supported")
);
for (const name of Object.keys(presets()))
  staticGet("DateTime", name, "the Intl options object it stands for (exact)", (ctx) =>
    rewrite(presetText(name, ctx.quote), [], "expression")
  );
unsupported(
  "DateTime",
  true,
  [
    "fromFormat",
    "fromFormatExplain",
    "fromString",
    "fromStringExplain",
    "buildFormatParser",
    "fromFormatParser",
    "expandFormat",
    "parseFormatForOpts",
  ],
  "Temporal has no token-based parser"
);
unsupported(
  "DateTime",
  true,
  ["fromSQL", "fromRFC2822", "fromHTTP"],
  "Temporal parses only RFC 9557 strings"
);
unsupported("DateTime", true, ["invalid"], "Temporal has no invalid objects");
unsupported(
  "DateTime",
  true,
  ["max", "min"],
  "Temporal has no min or max; Temporal.ZonedDateTime.compare sorts"
);
unsupported("DateTime", true, ["resetCache"], "Temporal has no caches to reset");

// Duration
const durationFields = [
  "years",
  "months",
  "weeks",
  "days",
  "hours",
  "minutes",
  "seconds",
  "milliseconds",
];
for (const name of durationFields)
  getter("Duration", name, `\`.${name}\` (exact)`, (ctx) => rewrite(`${ctx.recv}.${name}`));
unsupported("Duration", false, ["quarters"], "Temporal durations have no quarters", ["get"]);
staticCall(
  "Duration",
  "fromObject",
  "`Temporal.Duration.from(fields)` (exact for integer literals of one sign)",
  (ctx) => {
    const [obj] = ctx.args;
    if (ctx.args.length !== 1 || obj.value.kind !== "object")
      return none("the units are not known statically, or options are given");
    const parts: [string, string][] = [];
    const diffs: DifferenceId[] = [];
    let sign = 0;
    for (const [name, prop] of Object.entries(obj.value.props)) {
      const unit = pluralUnit(name);
      if (unit === null) return none(`${name} is not a duration unit`);
      if (unit === "quarters") return none("Temporal durations have no quarters");
      if (prop.value.kind === "number") {
        if (!Number.isInteger(prop.value.value)) return none("fractional amounts would throw");
        const s = Math.sign(prop.value.value);
        if (s !== 0 && sign !== 0 && s !== sign) return none("mixed signs would throw");
        if (s !== 0) sign = s;
      } else if (prop.value.kind === "dynamic") diffs.push("fractional-amounts");
      else return none(`${name} is not a number`);
      parts.push([unit, prop.text]);
    }
    return rewrite(`Temporal.Duration.from(${objectText(parts)})`, diffs);
  }
);
staticCall(
  "Duration",
  "fromMillis",
  "`Temporal.Duration.from({ milliseconds })` (exact for integer literals)",
  (ctx) => {
    const [ms] = ctx.args;
    if (ctx.args.length !== 1) return none("options are not supported");
    return rewrite(
      `Temporal.Duration.from({ milliseconds: ${ms.text} })`,
      isInt(ms.value) ? [] : ["fractional-amounts"]
    );
  }
);
staticCall(
  "Duration",
  "fromISO",
  "`Temporal.Duration.from(text)` (exact for literals both read alike)",
  (ctx) => {
    const [text] = ctx.args;
    if (ctx.args.length !== 1) return none("options are not supported");
    if (text.value.kind !== "string")
      return none(
        "momentum's ISO duration grammar (fractions in any unit) is broader than Temporal's"
      );
    const reference = Duration.fromISO(text.value.value);
    if (!reference.isValid) return none("momentum rejects this string");
    try {
      const d = temporal().Duration.from(text.value.value);
      for (const f of durationFields)
        if ((reference as unknown as Record<string, number>)[f] !== d[f])
          return none("Temporal reads this string differently");
    } catch {
      return none("Temporal cannot parse this string");
    }
    return rewrite(`Temporal.Duration.from(${text.text})`);
  }
);
staticCall("Duration", "isDuration", "`x instanceof Temporal.Duration` (exact)", (ctx) =>
  ctx.args.length === 1
    ? rewrite(`${ctx.args[0].text} instanceof Temporal.Duration`, [], "expression")
    : none("arguments are not supported")
);
const calendarUnits = new Set(["years", "quarters", "months", "weeks"]);
/** Totals are exact when the duration is known to have no years, months or weeks. */
const totalDifferences = (ctx: Context): DifferenceId[] =>
  ctx.receiverUnits !== undefined && ctx.receiverUnits.every((u) => !calendarUnits.has(u))
    ? []
    : ["duration-calendar-units"];
method(
  "Duration",
  "as",
  '`.total("unit")` (exact for durations built from days or smaller units; else differs: duration-calendar-units)',
  (ctx) => {
    const [unit] = ctx.args;
    if (ctx.args.length !== 1 || unit.value.kind !== "string")
      return none("the unit is not known statically");
    const u = pluralUnit(unit.value.value);
    if (u === null || u === "quarters") return none(`${unit.value.value} is not a Temporal unit`);
    return rewrite(`${ctx.recv}.total(${str(u.slice(0, -1), ctx.quote)})`, totalDifferences(ctx));
  }
);
for (const name of ["toMillis", "valueOf"])
  method(
    "Duration",
    name,
    '`.total("millisecond")` (exact for durations built from days or smaller units; else differs: duration-calendar-units)',
    (ctx) =>
      noArgs(ctx, () =>
        rewrite(`${ctx.recv}.total(${str("millisecond", ctx.quote)})`, totalDifferences(ctx))
      )
  );
for (const name of ["toISO", "toString", "toJSON"])
  method("Duration", name, "`.toString()` (differs: negative-duration-iso)", (ctx) =>
    noArgs(ctx, () => rewrite(`${ctx.recv}.toString()`, ["negative-duration-iso"]))
  );
method("Duration", "negate", "`.negated()` (exact)", (ctx) =>
  noArgs(ctx, () => rewrite(`${ctx.recv}.negated()`))
);
method("Duration", "get", "the getter of that unit", (ctx) => {
  const [unit] = ctx.args;
  if (ctx.args.length !== 1 || unit.value.kind !== "string")
    return none("the unit is not known statically");
  const u = pluralUnit(unit.value.value);
  const rule = u === null ? undefined : findRule("Duration", false, u, "get");
  return rule
    ? rule.apply({ ...ctx, args: [] })
    : none(`${unit.value.value} is not a Temporal duration unit`);
});
unsupported(
  "Duration",
  false,
  ["plus", "minus"],
  "Temporal's add balances units (1 hour plus 90 minutes is 2 hours 30 minutes) where momentum keeps them",
  ["call"]
);
unsupported(
  "Duration",
  false,
  ["shiftTo", "shiftToAll", "normalize", "rescale", "removeZeros", "mapUnits", "set"],
  "Temporal's round and total balance units and need relativeTo for calendar units",
  ["call"]
);
unsupported(
  "Duration",
  false,
  ["toFormat", "toHuman", "toISOTime", "toObject"],
  "no native formatter writes this output (Intl.DurationFormat formats differently)",
  ["call"]
);
unsupported("Duration", false, ["equals"], "Temporal durations have no equals", ["call"]);
unsupported(
  "Duration",
  false,
  ["isValid", "invalidReason", "invalidExplanation"],
  "Temporal durations are always valid: invalid input throws where it is created instead"
);
unsupported(
  "Duration",
  false,
  ["locale", "numberingSystem", "reconfigure"],
  "Temporal durations carry no locale"
);
unsupported(
  "Duration",
  true,
  ["fromDurationLike", "fromISOTime", "invalid", "normalizeUnit"],
  "no single Temporal call does this"
);

/** What migrate/dayjs.ts registers its rules with. */
export interface RuleKit {
  method: typeof method;
  staticCall: typeof staticCall;
  unsupported: typeof unsupported;
  rewrite: typeof rewrite;
  none: typeof none;
  str: typeof str;
  temporal: typeof temporal;
}
defineDayjsRules({ method, staticCall, unsupported, rewrite, none, str, temporal });

/** Classes without native counterparts: every use of them is "none". */
export const classNotes: Readonly<Partial<Record<ClassName, string>>> = {
  Interval: "Temporal has no interval type; keep momentum's Interval or store two ZonedDateTimes",
  Info: "Info's listers wrap Intl; Temporal adds nothing to replace them",
  Settings: "global configuration has no Temporal counterpart",
  Zone: "Temporal time zones are identifier strings, not objects",
  IANAZone: "Temporal time zones are identifier strings, not objects",
  FixedOffsetZone: "Temporal time zones are identifier strings, not objects",
  SystemZone: "Temporal time zones are identifier strings, not objects",
  InvalidZone: "Temporal time zones are identifier strings, not objects",
};

export function findRule(
  owner: ClassName,
  isStatic: boolean,
  name: string,
  form: "get" | "call"
): Rule | undefined {
  return rules.get(ruleKey(owner, isStatic, name, form));
}

export function allRules(): Rule[] {
  return [...rules.values()];
}

/** A member use: its rule's outcome, or why there is none. */
export function memberOutcome(
  owner: ClassName,
  isStatic: boolean,
  name: string,
  form: "get" | "call",
  ctx: Context
): Outcome {
  const note = classNotes[owner];
  if (note) return none(note);
  const rule = findRule(owner, isStatic, name, form);
  if (rule) return rule.apply(ctx);
  return none(`${owner}${isStatic ? "." : "#"}${name} is not in the migration catalog`);
}

// --- implicit conversions and operators

/** valueOf: `a - b`, `+a`, `a + 1`, `Number(a)`, `new Date(a)`, comparisons with numbers. */
export function valueOfOutcome(owner: ClassName, recv: string, quote: '"' | "'"): Outcome {
  if (owner === "DateTime" || owner === "Dayjs") return rewrite(`${recv}.epochMilliseconds`);
  if (owner === "Duration")
    return rewrite(`${recv}.total(${str("millisecond", quote)})`, ["duration-calendar-units"]);
  return none(classNotes[owner] ?? "no native counterpart");
}

/** toString: template literals and String(x). */
export function toStringOutcome(owner: ClassName, recv: string, quote: '"' | "'"): Outcome {
  if (owner === "DateTime")
    return rewrite(
      `${recv}.toString({ fractionalSecondDigits: 3, timeZoneName: ${str("never", quote)} })`,
      ["iso-format"]
    );
  if (owner === "Duration") return rewrite(`${recv}.toString()`, ["negative-duration-iso"]);
  if (owner === "Dayjs") return rewrite(`new Date(${recv}.epochMilliseconds).toUTCString()`);
  return none(classNotes[owner] ?? "no native counterpart");
}

/** `a < b` between two DateTimes. */
export function compareOutcome(left: string, operator: string, right: string): Outcome {
  return rewrite(
    `Temporal.ZonedDateTime.compare(${left}, ${right}) ${operator} 0`,
    [],
    "expression"
  );
}

/** The Temporal type or class that replaces a momentum class, if any. */
export function typeReplacement(owner: ClassName): string | null {
  return owner === "DateTime" || owner === "Dayjs"
    ? "Temporal.ZonedDateTime"
    : owner === "Duration"
      ? "Temporal.Duration"
      : null;
}
