import { parseMillis, isUndefined, untruncateYear, signedOffset, hasOwnProperty } from "./util.js";
import Formatter from "./formatter.js";
import FixedOffsetZone from "../zones/fixedOffsetZone.js";
import IANAZone from "../zones/IANAZone.js";
import DateTime from "../datetime.js";
import { digitRegex, parseDigits } from "./digits.js";
import { ConflictingSpecificationError } from "../errors.js";
import type Locale from "./locale.js";
import type Zone from "../zone.js";
import type { DateObjectUnits, ExplainedFormat, FormatToken } from "../types.js";

const MISSING_FTP = "missing Intl.DateTimeFormat.formatToParts support";

type Matches = Record<string, number | string>;

interface Unit {
  regex: RegExp;
  deser: (groups: string[]) => number | string;
  groups?: number;
  literal?: boolean;
  token?: FormatToken;
  invalidReason?: string;
}

function intUnit(regex: RegExp, post: (i: number) => number = (i) => i): Unit {
  return { regex, deser: ([s]) => post(parseDigits(s)) };
}

function fixListRegex(s: string): string {
  return s
    .replace(/\./g, "\\.?") // make dots optional and also make them literal
    .replace(/\s/g, "\\s"); // make all whitespace literals into any-whitespace-here markers
}

function stripInsensitivities(s: string): string {
  return s
    .replace(/\./g, "") // ignore dots that were made optional
    .replace(/\s/g, " ") // replace other whitespace with simple spaces
    .toLowerCase();
}

function oneOf(strings: string[] | null, startIndex: number): Unit | null {
  if (strings === null) {
    return null;
  } else {
    return {
      regex: RegExp(strings.map(fixListRegex).join("|")),
      deser: ([s]) =>
        strings.findIndex((i) => stripInsensitivities(s) === stripInsensitivities(i)) + startIndex,
    };
  }
}

function offset(regex: RegExp, groups: number): Unit {
  return { regex, deser: ([, h, m]) => signedOffset(h, m), groups };
}

function simple(regex: RegExp): Unit {
  return { regex, deser: ([s]) => s };
}

function escapeToken(value: string): string {
  return value.replace(/[\-\[\]{}()*+?.,\\\^$|#\s]/g, "\\$&");
}

/**
 * @param token
 * @param loc
 * @ignore
 */
function unitForToken(token: FormatToken, loc: Locale): Unit {
  const one = digitRegex(loc),
    two = digitRegex(loc, "{2}"),
    three = digitRegex(loc, "{3}"),
    four = digitRegex(loc, "{4}"),
    six = digitRegex(loc, "{6}"),
    oneOrTwo = digitRegex(loc, "{1,2}"),
    oneToThree = digitRegex(loc, "{1,3}"),
    oneToSix = digitRegex(loc, "{1,6}"),
    oneToNine = digitRegex(loc, "{1,9}"),
    twoToFour = digitRegex(loc, "{2,4}"),
    fourToSix = digitRegex(loc, "{4,6}"),
    literal = (t: FormatToken): Unit => ({
      regex: RegExp(escapeToken(t.val)),
      deser: ([s]) => s,
      literal: true,
    }),
    unitate = (t: FormatToken): Unit | null => {
      if (token.literal) {
        return literal(t);
      }
      switch (t.val) {
        // era
        case "G":
          return oneOf(loc.eras("short"), 0);
        case "GG":
          return oneOf(loc.eras("long"), 0);
        // years
        case "y":
          return intUnit(oneToSix);
        case "yy":
          return intUnit(twoToFour, untruncateYear);
        case "yyyy":
          return intUnit(four);
        case "yyyyy":
          return intUnit(fourToSix);
        case "yyyyyy":
          return intUnit(six);
        // months
        case "M":
          return intUnit(oneOrTwo);
        case "MM":
          return intUnit(two);
        case "MMM":
          return oneOf(loc.months("short", true), 1);
        case "MMMM":
          return oneOf(loc.months("long", true), 1);
        case "L":
          return intUnit(oneOrTwo);
        case "LL":
          return intUnit(two);
        case "LLL":
          return oneOf(loc.months("short", false), 1);
        case "LLLL":
          return oneOf(loc.months("long", false), 1);
        // dates
        case "d":
          return intUnit(oneOrTwo);
        case "dd":
          return intUnit(two);
        // ordinals
        case "o":
          return intUnit(oneToThree);
        case "ooo":
          return intUnit(three);
        // time
        case "HH":
          return intUnit(two);
        case "H":
          return intUnit(oneOrTwo);
        case "hh":
          return intUnit(two);
        case "h":
          return intUnit(oneOrTwo);
        case "mm":
          return intUnit(two);
        case "m":
          return intUnit(oneOrTwo);
        case "q":
          return intUnit(oneOrTwo);
        case "qq":
          return intUnit(two);
        case "s":
          return intUnit(oneOrTwo);
        case "ss":
          return intUnit(two);
        case "S":
          return intUnit(oneToThree);
        case "SSS":
          return intUnit(three);
        case "u":
          return simple(oneToNine);
        case "uu":
          return simple(oneOrTwo);
        case "uuu":
          return intUnit(one);
        // meridiem
        case "a":
          return oneOf(loc.meridiems(), 0);
        // weekYear (k)
        case "kkkk":
          return intUnit(four);
        case "kk":
          return intUnit(twoToFour, untruncateYear);
        // weekNumber (W)
        case "W":
          return intUnit(oneOrTwo);
        case "WW":
          return intUnit(two);
        // weekdays
        case "E":
        case "c":
          return intUnit(one);
        case "EEE":
          return oneOf(loc.weekdays("short", false), 1);
        case "EEEE":
          return oneOf(loc.weekdays("long", false), 1);
        case "ccc":
          return oneOf(loc.weekdays("short", true), 1);
        case "cccc":
          return oneOf(loc.weekdays("long", true), 1);
        // offset/zone
        case "Z":
        case "ZZ":
          return offset(new RegExp(`([+-]${oneOrTwo.source})(?::(${two.source}))?`), 2);
        case "ZZZ":
          return offset(new RegExp(`([+-]${oneOrTwo.source})(${two.source})?`), 2);
        // we don't support ZZZZ (PST) or ZZZZZ (Pacific Standard Time) in parsing
        // because we don't have any way to figure out what they are
        case "z":
          return simple(/[a-z_+-/]{1,256}?/i);
        // this special-case "token" represents a place where a macro-token expanded into a white-space literal
        // in this case we accept any non-newline white-space
        case " ":
          return simple(/[^\S\n\r]/);
        default:
          return literal(t);
      }
    };

  const unit: Unit = unitate(token) || {
    regex: /(?:)/,
    deser: ([s]) => s,
    invalidReason: MISSING_FTP,
  };

  unit.token = token;

  return unit;
}

const partTypeStyleToTokenVal: Record<string, string | Record<string, string>> = {
  year: {
    "2-digit": "yy",
    numeric: "yyyyy",
  },
  month: {
    numeric: "M",
    "2-digit": "MM",
    short: "MMM",
    long: "MMMM",
  },
  day: {
    numeric: "d",
    "2-digit": "dd",
  },
  weekday: {
    short: "EEE",
    long: "EEEE",
  },
  dayperiod: "a",
  dayPeriod: "a",
  hour12: {
    numeric: "h",
    "2-digit": "hh",
  },
  hour24: {
    numeric: "H",
    "2-digit": "HH",
  },
  minute: {
    numeric: "m",
    "2-digit": "mm",
  },
  second: {
    numeric: "s",
    "2-digit": "ss",
  },
  timeZoneName: {
    long: "ZZZZZ",
    short: "ZZZ",
  },
};

function tokenForPart(
  part: Intl.DateTimeFormatPart,
  formatOpts: Intl.DateTimeFormatOptions,
  resolvedOpts: Intl.ResolvedDateTimeFormatOptions
): FormatToken | undefined {
  const { type, value } = part;

  if (type === "literal") {
    const isSpace = /^\s+$/.test(value);
    return {
      literal: !isSpace,
      val: isSpace ? " " : value,
    };
  }

  const style = (formatOpts as Record<string, unknown>)[type] as string;

  // The user might have explicitly specified hour12 or hourCycle
  // if so, respect their decision
  // if not, refer back to the resolvedOpts, which are based on the locale
  let actualType: string = type;
  if (type === "hour") {
    if (formatOpts.hour12 != null) {
      actualType = formatOpts.hour12 ? "hour12" : "hour24";
    } else if (formatOpts.hourCycle != null) {
      if (formatOpts.hourCycle === "h11" || formatOpts.hourCycle === "h12") {
        actualType = "hour12";
      } else {
        actualType = "hour24";
      }
    } else {
      // tokens only differentiate between 24 hours or not,
      // so we do not need to check hourCycle here, which is less supported anyways
      actualType = resolvedOpts.hour12 ? "hour12" : "hour24";
    }
  }
  let val = partTypeStyleToTokenVal[actualType];
  if (typeof val === "object") {
    val = val[style];
  }

  if (val) {
    return {
      literal: false,
      val,
    };
  }

  return undefined;
}

function buildRegex(units: Unit[]): [string, Unit[]] {
  const re = units.map((u) => u.regex).reduce((f, r) => `${f}(${r.source})`, "");
  return [`^${re}$`, units];
}

function match(input: string, regex: RegExp, handlers: Unit[]): [RegExpMatchArray | null, Matches] {
  const matches = input.match(regex);

  if (matches) {
    const all: Matches = {};
    let matchIndex = 1;
    for (const i in handlers) {
      if (hasOwnProperty(handlers, i)) {
        const h = handlers[i],
          groups = h.groups ? h.groups + 1 : 1;
        if (!h.literal && h.token) {
          all[h.token.val[0]] = h.deser(matches.slice(matchIndex, matchIndex + groups));
        }
        matchIndex += groups;
      }
    }
    return [matches, all];
  } else {
    return [matches, {}];
  }
}

function dateTimeFromMatches(
  matches: Matches
): [DateObjectUnits, Zone | null, number | undefined, string | undefined] {
  const toField = (token: string): keyof DateObjectUnits | "quarter" | null => {
    switch (token) {
      case "S":
        return "millisecond";
      case "s":
        return "second";
      case "m":
        return "minute";
      case "h":
      case "H":
        return "hour";
      case "d":
        return "day";
      case "o":
        return "ordinal";
      case "L":
      case "M":
        return "month";
      case "y":
        return "year";
      case "E":
      case "c":
        return "weekday";
      case "W":
        return "weekNumber";
      case "k":
        return "weekYear";
      case "q":
        return "quarter";
      default:
        return null;
    }
  };

  let zone: Zone | null = null;
  let specificOffset: number | undefined;
  if (!isUndefined(matches.z)) {
    zone = IANAZone.create(matches.z as string);
  }

  if (!isUndefined(matches.Z)) {
    if (!zone) {
      zone = new FixedOffsetZone(matches.Z as number);
    }
    specificOffset = matches.Z as number;
  }

  if (!isUndefined(matches.q)) {
    matches.M = ((matches.q as number) - 1) * 3 + 1;
  }

  let hourInvalidReason: string | undefined;

  if (!isUndefined(matches.h)) {
    if (!isUndefined(matches.a) && ((matches.h as number) < 1 || (matches.h as number) > 12)) {
      // "h" is the 12-hour token, so when a meridiem ("a") is also present the
      // hour must be within [1, 12]. Anything else (e.g. "18:30 AM") is not a
      // valid 12-hour time, so the result is invalid.
      hourInvalidReason = `the 12-hour value "${matches.h}" is not in the [1, 12] range`;
    } else if ((matches.h as number) < 12 && matches.a === 1) {
      (matches.h as number) += 12;
    } else if (matches.h === 12 && matches.a === 0) {
      matches.h = 0;
    }
  }

  if (matches.G === 0 && matches.y) {
    matches.y = -(matches.y as number);
  }

  if (!isUndefined(matches.u)) {
    matches.S = parseMillis(matches.u as string) as number;
  }

  const vals = Object.keys(matches).reduce<Record<string, number | string>>((r, k) => {
    const f = toField(k);
    if (f) {
      r[f] = matches[k];
    }

    return r;
  }, {});

  return [vals as DateObjectUnits, zone, specificOffset, hourInvalidReason];
}

let dummyDateTimeCache: DateTime | null = null;

function getDummyDateTime(): DateTime {
  if (!dummyDateTimeCache) {
    dummyDateTimeCache = DateTime.fromMillis(1555555555555);
  }

  return dummyDateTimeCache;
}

function maybeExpandMacroToken(token: FormatToken, locale: Locale): FormatToken | FormatToken[] {
  if (token.literal) {
    return token;
  }

  const formatOpts = Formatter.macroTokenToFormatOpts(token.val);
  const tokens = formatOptsToTokens(formatOpts, locale);

  if (tokens == null || tokens.includes(undefined)) {
    return token;
  }

  return tokens as FormatToken[];
}

export function expandMacroTokens(tokens: FormatToken[], locale: Locale): FormatToken[] {
  return Array.prototype.concat(...tokens.map((t) => maybeExpandMacroToken(t, locale)));
}

/**
 * @private
 */

export class TokenParser {
  readonly locale: Locale;
  readonly format: string;
  readonly tokens: FormatToken[];
  private readonly units: Unit[];
  private readonly disqualifyingUnit: Unit | undefined;
  private readonly regex?: RegExp;
  private readonly handlers?: Unit[];

  constructor(locale: Locale, format: string) {
    this.locale = locale;
    this.format = format;
    this.tokens = expandMacroTokens(Formatter.parseFormat(format), locale);
    this.units = this.tokens.map((t) => unitForToken(t, locale));
    this.disqualifyingUnit = this.units.find((t) => t.invalidReason);

    if (!this.disqualifyingUnit) {
      const [regexString, handlers] = buildRegex(this.units);
      this.regex = RegExp(regexString, "i");
      this.handlers = handlers;
    }
  }

  explainFromTokens(input: string): ExplainedFormat {
    if (!this.isValid) {
      return { input, tokens: this.tokens, invalidReason: this.invalidReason };
    } else {
      const [rawMatches, matches] = match(input, this.regex as RegExp, this.handlers as Unit[]),
        [result, zone, specificOffset, parseInvalidReason] = matches
          ? dateTimeFromMatches(matches)
          : [null, null, undefined, undefined];
      if (hasOwnProperty(matches, "a") && hasOwnProperty(matches, "H")) {
        throw new ConflictingSpecificationError(
          "Can't include meridiem when specifying 24-hour format"
        );
      }
      return {
        input,
        tokens: this.tokens,
        regex: this.regex,
        rawMatches,
        matches,
        result,
        zone,
        specificOffset,
        invalidReason: parseInvalidReason,
      };
    }
  }

  get isValid(): boolean {
    return !this.disqualifyingUnit;
  }

  get invalidReason(): string | null {
    return this.disqualifyingUnit ? (this.disqualifyingUnit.invalidReason as string) : null;
  }
}

export function explainFromTokens(locale: Locale, input: string, format: string): ExplainedFormat {
  const parser = new TokenParser(locale, format);
  return parser.explainFromTokens(input);
}

export function parseFromTokens(
  locale: Locale,
  input: string,
  format: string
): [
  DateObjectUnits | null | undefined,
  Zone | null | undefined,
  number | undefined,
  string | null | undefined,
] {
  const { result, zone, specificOffset, invalidReason } = explainFromTokens(locale, input, format);
  return [result, zone, specificOffset, invalidReason];
}

export function formatOptsToTokens(
  formatOpts: Intl.DateTimeFormatOptions | undefined,
  locale: Locale
): (FormatToken | undefined)[] | null {
  if (!formatOpts) {
    return null;
  }

  const formatter = Formatter.create(locale, formatOpts);
  const df = formatter.dtFormatter(getDummyDateTime());
  const parts = df.formatToParts();
  const resolvedOpts = df.resolvedOptions();
  return parts.map((p) => tokenForPart(p, formatOpts, resolvedOpts));
}
