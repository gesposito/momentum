/* global test expect describe */
// The Day.js part of the migration catalog (migrate/dayjs.ts) promises that some rewrites are
// exact. These properties evaluate the very text a rewrite produces and compare it with Day.js
// itself, for local values (the system zone, America/New_York in the test scripts) and UTC values,
// over any instant in Date's range and near New York's DST transitions. Each Day.js difference is
// reproduced on a known example, and every Day.js method must have an entry in the catalog.

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import devHelper from "dayjs/plugin/devHelper";
import {
  fc,
  nearTransition,
  transitions,
  wallClockNearTransition,
} from "../../luxon/test/momentum/fastCheck";
import { compareOutcome, findRule, toStringOutcome, valueOfOutcome } from "../src/rules";
import { differenceIds } from "../src/differences";

dayjs.extend(utc);
dayjs.extend(timezone);

const T = globalThis.Temporal;
const zone = T.Now.timeZoneId();
const facts = { settings: new Set(), localeConfigured: false };
const ctx = (args = [], extra = {}) => ({ recv: "r", args, facts, quote: '"', ...extra });
const lit = (value) =>
  value === undefined
    ? { text: "undefined", value: { kind: "undefined" } }
    : typeof value === "number"
      ? { text: String(value), value: { kind: "number", value } }
      : typeof value === "string"
        ? { text: JSON.stringify(value), value: { kind: "string", value } }
        : { text: String(value), value: { kind: "boolean", value } };
const other = { text: "t", value: { kind: "dynamic", type: "Dayjs" } };
const rule = (name, isStatic = false, owner = "Dayjs") => {
  const found = findRule(owner, isStatic, name, "call");
  expect(found).toBeDefined();
  return found;
};

/** The rewrite's text, evaluated with `r` and `t` bound. */
function evaluate(outcome, r, t) {
  expect(outcome.kind).toBe("rewrite");
  // eslint-disable-next-line no-new-func
  return new Function("r", "t", "Temporal", `return (${outcome.text});`)(r, t, T);
}
/** An outcome that claims to be exact. */
function exact(outcome) {
  expect(outcome).toMatchObject({ kind: "rewrite", differences: [] });
  return outcome;
}

// the same instant as a Day.js value and as a ZonedDateTime, local or UTC; Date's range, less a
// margin for the arithmetic
const inRange = (ms) => Math.abs(ms) <= 8.6e15;
// a zone without transitions makes nearTransition fall back to any instant: keep the margin
const instant = fc.oneof(
  fc.integer({ min: -8.6e15, max: 8.6e15 }),
  nearTransition(zone).filter(inRange)
);
const asPair = (ms, mode) =>
  mode === "utc"
    ? [dayjs.utc(ms), T.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO("UTC")]
    : [dayjs(ms), T.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone)];
const value = fc
  .tuple(instant, fc.constantFrom("local", "utc"))
  .map(([ms, mode]) => asPair(ms, mode));

/**
 * The timezone plugin computes through the system zone: within a day or so of one of the system
 * zone's DST changes, its results are off (the dayjs-tz difference).
 */
const systemTransitions = transitions(zone, 1900, 2100);
const awayFromSystemDst = (ms) => !systemTransitions.some((t) => Math.abs(t - ms) < 2 * 86400000);

/** Day.js and Temporal results agree: for dates the same instant, wall clock and UTC mode. */
function same(d, z, { mode = true } = {}) {
  if (dayjs.isDayjs(d)) {
    expect(z).toBeInstanceOf(T.ZonedDateTime);
    const fields = (x) => [
      x.epochMilliseconds ?? x.valueOf(),
      x.year,
      x.month,
      x.day,
      x.hour,
      x.minute,
      x.second,
      x.millisecond,
    ];
    expect(fields(z)).toEqual([
      d.valueOf(),
      d.year(),
      d.month() + 1,
      d.date(),
      d.hour(),
      d.minute(),
      d.second(),
      d.millisecond(),
    ]);
    if (mode) expect(z.timeZoneId).toBe(d.isUTC() ? "UTC" : zone);
  } else if (d instanceof Date) {
    expect(z).toBeInstanceOf(Date);
    expect(z.getTime()).toBe(d.getTime());
  } else expect(z === 0 ? 0 : z).toEqual(d === 0 ? 0 : d); // Day.js turns -0 into 0
}

const units = {
  year: ["year", "years", "y"],
  month: ["month", "months", "M"],
  date: ["date", "dates", "D"],
  day: ["day", "days", "d"],
  hour: ["hour", "hours", "h"],
  minute: ["minute", "minutes", "m"],
  second: ["second", "seconds", "s"],
  millisecond: ["millisecond", "milliseconds", "ms"],
};

describe("exact Day.js getters, setters and arithmetic agree with Day.js", () => {
  test("getters and get(unit)", () => {
    for (const [name, spellings] of Object.entries(units)) {
      const getter = exact(rule(name).apply(ctx()));
      fc.assert(fc.property(value, ([d, z]) => same(d[name](), evaluate(getter, z))));
      for (const unit of spellings) {
        const get = exact(rule("get").apply(ctx([lit(unit)])));
        fc.assert(fc.property(value, ([d, z]) => same(d.get(unit), evaluate(get, z))));
      }
    }
  });

  test("setters with values that do not roll over, except years and months", () => {
    for (const [name, max, min = 0] of [
      ["date", 28, 1],
      ["hour", 23],
      ["minute", 59],
      ["second", 59],
      ["millisecond", 999],
    ])
      fc.assert(
        fc.property(value, fc.integer({ min, max }), ([d, z], n) => {
          same(d[name](n), evaluate(exact(rule(name).apply(ctx([lit(n)]))), z));
          same(d.set(name, n), evaluate(exact(rule("set").apply(ctx([lit(name), lit(n)]))), z));
        })
      );
  });

  test("add and subtract whole amounts of time units, days and weeks", () => {
    for (const [unit, bound] of [
      ["millisecond", 1e10],
      ["second", 1e8],
      ["minute", 1e6],
      ["hour", 1e5],
      ["day", 5e4],
      ["week", 5e3],
    ])
      for (const spelling of [unit, `${unit}s`, ...(units[unit]?.slice(2) ?? ["w"])])
        fc.assert(
          fc.property(
            value,
            fc.integer({ min: -bound, max: bound }).filter((n) => n !== 0),
            ([d, z], n) => {
              const add = exact(rule("add").apply(ctx([lit(n), lit(spelling)])));
              same(d.add(n, spelling), evaluate(add, z));
              const subtract = exact(rule("subtract").apply(ctx([lit(n), lit(spelling)])));
              same(d.subtract(n, spelling), evaluate(subtract, z));
            }
          )
        );
  });

  test("fractional amounts: Day.js rounds days and adds exact milliseconds for time units", () => {
    fc.assert(
      fc.property(value, fc.integer({ min: -400, max: 400 }), ([d, z], tenths) => {
        const n = tenths / 2; // halves, where rounding is decided
        if (Math.round(n) !== 0 && Math.round(-n) !== 0) {
          same(d.add(n, "day"), evaluate(exact(rule("add").apply(ctx([lit(n), lit("day")]))), z));
          same(
            d.subtract(n, "day"),
            evaluate(exact(rule("subtract").apply(ctx([lit(n), lit("day")]))), z)
          );
        }
        same(d.add(n, "hour"), evaluate(exact(rule("add").apply(ctx([lit(n), lit("hour")]))), z));
      })
    );
  });

  test("startOf and endOf, from seconds to years", () => {
    for (const unit of ["year", "month", "date", "day", "hour", "minute", "second"])
      for (const spelling of units[unit])
        for (const name of ["startOf", "endOf"]) {
          const outcome = rule(name).apply(ctx([lit(spelling)]));
          // Day.js reads the years 0 to 99 as 1900 to 1999 when it starts or ends years and months
          const yearly = unit === "year" || unit === "month";
          expect(outcome).toMatchObject({
            kind: "rewrite",
            differences: yearly ? ["dayjs-years"] : [],
          });
          fc.assert(
            fc.property(value, ([d, z]) => {
              if (!yearly || d.year() >= 100) same(d[name](spelling), evaluate(outcome, z));
            })
          );
        }
  });

  test("isBefore, isAfter and isSame, without a unit and with one", () => {
    for (const name of ["isBefore", "isAfter", "isSame"]) {
      const plain = exact(rule(name).apply(ctx([other])));
      fc.assert(
        fc.property(value, value, ([d, z], [dt, zt]) => {
          same(d[name](dt), evaluate(plain, z, zt));
          same(d[name](d), evaluate(plain, z, z));
        })
      );
    }
    for (const name of ["isBefore", "isAfter"])
      for (const unit of ["year", "month", "day", "hour", "minute", "second", "millisecond"]) {
        const outcome = rule(name).apply(ctx([other, lit(unit)]));
        const yearly = unit === "year" || unit === "month";
        expect(outcome).toMatchObject({
          kind: "rewrite",
          differences: yearly ? ["dayjs-years"] : [],
        });
        fc.assert(
          fc.property(value, instant, ([d, z], delta) => {
            // values close to each other, where the unit decides
            const ms = Math.max(-8.6e15, Math.min(8.6e15, d.valueOf() + (delta % 1e10)));
            const [dt, zt] = asPair(ms, d.isUTC() ? "utc" : "local");
            if (!yearly || d.year() >= 100) same(d[name](dt, unit), evaluate(outcome, z, zt));
          })
        );
      }
  });

  test("diff in milliseconds, seconds, minutes and hours", () => {
    for (const unit of [undefined, "ms", "millisecond", "s", "seconds", "m", "minute", "h", "hour"])
      for (const float of [undefined, false, true]) {
        const args = [other, lit(unit), ...(float === undefined ? [] : [lit(float)])];
        const outcome = exact(rule("diff").apply(ctx(args)));
        fc.assert(
          fc.property(value, value, ([d, z], [dt, zt]) =>
            same(d.diff(dt, unit, float), evaluate(outcome, z, zt))
          )
        );
      }
  });

  test("conversions and time formats", () => {
    for (const name of [
      "valueOf",
      "unix",
      "toDate",
      "toISOString",
      "toJSON",
      "toString",
      "daysInMonth",
      "clone",
    ]) {
      const outcome = exact(rule(name).apply(ctx()));
      fc.assert(fc.property(value, ([d, z]) => same(d[name](), evaluate(outcome, z))));
    }
    for (const pattern of ["HH:mm", "HH:mm:ss", "HH:mm:ss.SSS"]) {
      const outcome = exact(rule("format").apply(ctx([lit(pattern)])));
      fc.assert(fc.property(value, ([d, z]) => same(d.format(pattern), evaluate(outcome, z))));
    }
  });

  test("comparisons, numbers and template literals", () => {
    const less = exact(compareOutcome("r", "<", "t"));
    const asNumber = exact(valueOfOutcome("Dayjs", "r", '"'));
    const asString = exact(toStringOutcome("Dayjs", "r", '"'));
    fc.assert(
      fc.property(value, value, ([d, z], [dt, zt]) => {
        same(d < dt, evaluate(less, z, zt));
        same(+d, evaluate(asNumber, z));
        same(`${d}`, evaluate(asString, z));
      })
    );
  });
});

describe("exact Day.js factories agree with Day.js", () => {
  test("dayjs() and dayjs.utc() read the clock to the millisecond", () => {
    for (const [name, isStatic, expected] of [
      ["()", true, zone],
      ["utc", true, "UTC"],
    ]) {
      const before = Date.now();
      const z = evaluate(exact(rule(name, isStatic).apply(ctx())));
      const after = Date.now();
      expect(z.timeZoneId).toBe(expected);
      expect(z.epochNanoseconds % 1000000n).toBe(0n);
      expect(z.epochMilliseconds).toBeGreaterThanOrEqual(before);
      expect(z.epochMilliseconds).toBeLessThanOrEqual(after);
    }
  });

  test("dayjs(ms), dayjs.utc(ms) and dayjs.unix(seconds) with literals", () => {
    fc.assert(
      fc.property(fc.integer({ min: -8.6e15, max: 8.6e15 }), (ms) => {
        same(dayjs(ms), evaluate(exact(rule("()", true).apply(ctx([lit(ms)])))));
        same(dayjs.utc(ms), evaluate(exact(rule("utc", true).apply(ctx([lit(ms)])))));
        const s = Math.trunc(ms / 1000);
        same(dayjs.unix(s), evaluate(exact(rule("unix", true).apply(ctx([lit(s)])))));
      })
    );
  });

  test("dayjs(isoString) with literal wall-clock times and instants", () => {
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    const wallClock = fc.oneof(
      fc.record({
        year: fc.integer({ min: 100, max: 9999 }),
        month: fc.integer({ min: 1, max: 12 }),
        day: fc.integer({ min: 1, max: 28 }),
        hour: fc.integer({ min: 0, max: 23 }),
        minute: fc.integer({ min: 0, max: 59 }),
        second: fc.integer({ min: 0, max: 59 }),
        millisecond: fc.integer({ min: 0, max: 999 }),
      }),
      wallClockNearTransition(zone, 1900, 2100).filter((f) => f.year >= 100 && f.year <= 9999)
    );
    fc.assert(
      fc.property(wallClock, fc.integer({ min: 0, max: 4 }), (f, form) => {
        const date = `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}`;
        const time = `${pad(f.hour)}:${pad(f.minute)}`;
        const text = [
          date,
          `${date}T${time}`,
          `${date} ${time}:${pad(f.second)}`,
          `${date}T${time}:${pad(f.second)}.${pad(f.millisecond, 3)}`,
          `${date}t${time}:${pad(f.second)}`,
        ][form];
        same(dayjs(text), evaluate(exact(rule("()", true).apply(ctx([lit(text)])))));
        same(dayjs.utc(text), evaluate(exact(rule("utc", true).apply(ctx([lit(text)])))));
      })
    );
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(0, 0, 1) + 864e5, max: Date.UTC(9999, 11, 30) }),
        fc.integer({ min: -14 * 60, max: 14 * 60 }),
        (ms, offsetMinutes) => {
          const utcText = new Date(ms).toISOString();
          const sign = offsetMinutes < 0 ? "-" : "+";
          const abs = Math.abs(offsetMinutes);
          const local = new Date(ms + offsetMinutes * 60000).toISOString().slice(0, 23);
          const offsetText = `${local}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
          for (const text of [utcText, offsetText]) {
            same(dayjs(text), evaluate(exact(rule("()", true).apply(ctx([lit(text)])))));
            same(dayjs.utc(text), evaluate(exact(rule("utc", true).apply(ctx([lit(text)])))));
          }
        }
      )
    );
    // Day.js reads the fraction digits as milliseconds as they are: ".1" is 1 ms
    expect(rule("()", true).apply(ctx([lit("2026-10-19T12:00:00.1")])).kind).toBe("none");
    expect(rule("()", true).apply(ctx([lit("0050-01-01")])).kind).toBe("none");
  });

  test("dayjs(value) clones and dayjs.utc(value) converts", () => {
    const clone = exact(rule("()", true).apply(ctx([other])));
    const toUtc = exact(rule("utc", true).apply(ctx([other])));
    fc.assert(
      fc.property(value, ([d, z]) => {
        same(dayjs(d), evaluate(clone, undefined, z));
        same(dayjs.utc(d), evaluate(toUtc, undefined, z));
      })
    );
  });

  test("dayjs.tz agrees on the instant from 1970, and documents the plugin's corner cases", () => {
    const zones = ["America/New_York", "Europe/London", "Asia/Kolkata", "Australia/Lord_Howe"];
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4e12 }), fc.constantFrom(...zones), (ms, z) => {
        const outcome = rule("tz", true).apply(ctx([lit(ms), lit(z)]));
        expect(outcome.differences).toEqual(["dayjs-tz"]);
        if (awayFromSystemDst(ms))
          expect(evaluate(outcome).epochMilliseconds).toBe(dayjs.tz(ms, z).valueOf());
      })
    );
    // zones without transitions in those years fall back to any instant: keep 1970 to 9999
    const wallClock = fc
      .constantFrom(...zones)
      .chain((z) => fc.tuple(wallClockNearTransition(z, 1990, 2030), fc.constant(z)))
      .filter(([f]) => f.year >= 1970 && f.year <= 9999);
    fc.assert(
      fc.property(wallClock, ([f, z]) => {
        const text = T.PlainDateTime.from(f).toString({ smallestUnit: "second" });
        const outcome = rule("tz", true).apply(ctx([lit(text), lit(z)]));
        expect(outcome.kind).toBe("rewrite");
        if (outcome.differences.includes("dayjs-tz-parse"))
          expect(outcome.differences).toEqual(["dayjs-tz", "dayjs-tz-parse"]);
        else {
          expect(outcome.differences).toEqual(["dayjs-tz"]);
          const z2 = evaluate(outcome);
          if (awayFromSystemDst(z2.epochMilliseconds))
            expect(z2.epochMilliseconds).toBe(dayjs.tz(text, z).valueOf());
        }
      })
    );
  });

  test("isDayjs", () => {
    const outcome = exact(rule("isDayjs", true).apply(ctx([other])));
    fc.assert(
      fc.property(value, ([d, z]) => same(dayjs.isDayjs(d), evaluate(outcome, undefined, z)))
    );
    expect(evaluate(outcome, undefined, new Date())).toBe(dayjs.isDayjs(new Date()));
    // Day.js also recognizes objects marked as its own, from another copy of the library
    const marked = { text: "x", value: { kind: "dynamic", type: "object" } };
    expect(rule("isDayjs", true).apply(ctx([marked])).kind).toBe("none");
    expect(dayjs.isDayjs({ $isDayjsObject: true })).toBe(true);
  });
});

describe("exact plugin methods agree with Day.js", () => {
  test("utc(), local() and tz(zone)", () => {
    const toUtc = exact(rule("utc").apply(ctx()));
    const toLocal = exact(rule("local").apply(ctx()));
    const zones = ["America/New_York", "Europe/London", "Asia/Kolkata", "Pacific/Chatham"];
    fc.assert(
      fc.property(value, fc.constantFrom(...zones), ([d, z], target) => {
        same(d.utc(), evaluate(toUtc, z));
        same(d.local(), evaluate(toLocal, z));
        const tz = rule("tz").apply(ctx([lit(target)]));
        expect(tz.differences).toEqual(["dayjs-tz"]);
        if (d.valueOf() >= 0 && d.valueOf() <= 4e12 && awayFromSystemDst(d.valueOf()))
          expect(evaluate(tz, z).epochMilliseconds).toBe(d.tz(target).valueOf());
      })
    );
  });

  test("dayjs.tz.guess()", () => {
    expect(evaluate(exact(rule("guess", false, "DayjsTimezone").apply(ctx())))).toBe(
      dayjs.tz.guess()
    );
  });
});

describe("each Day.js difference is real", () => {
  const reproduced = new Set();
  const differs = (id, outcome, fromDayjs, fromTemporal) => {
    expect(outcome.kind).toBe("rewrite");
    expect(outcome.differences).toContain(id);
    expect(fromTemporal).not.toEqual(fromDayjs);
    reproduced.add(id);
  };
  const local = (iso) => T.PlainDateTime.from(iso).toZonedDateTime(zone);

  test("dayjs-zones: a day added across London's DST change keeps Day.js's offset", () => {
    const zoned = { settings: new Set(["dayjs:zones"]), localeConfigured: false };
    const outcome = rule("add").apply(ctx([lit(1), lit("day")], { facts: zoned }));
    const d = dayjs.tz("2026-03-28 12:00", "Europe/London").add(1, "day");
    const z = evaluate(outcome, T.ZonedDateTime.from("2026-03-28T12:00[Europe/London]"));
    differs("dayjs-zones", outcome, d.valueOf(), z.epochMilliseconds);
  });

  test("dayjs-tz: before 1970, a fraction of a second moves the instant", () => {
    const outcome = rule("tz").apply(ctx([lit("America/New_York")]));
    const ms = -123046875001;
    const d = dayjs(ms).tz("America/New_York");
    const z = evaluate(outcome, T.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone));
    differs("dayjs-tz", outcome, d.valueOf(), z.epochMilliseconds);
  });

  test("dayjs-tz-parse: in winter, dayjs.tz reads a repeated time as its later occurrence", () => {
    // Day.js guesses with the zone's offset today: pin today to January 15, outside DST
    const RealDate = Date;
    const january = RealDate.UTC(2026, 0, 15);
    class Winter extends RealDate {
      constructor(...args) {
        super(...(args.length === 0 ? [january] : args));
      }
    }
    let d;
    globalThis.Date = Winter;
    try {
      d = dayjs.tz("2026-11-01 01:30", "America/New_York");
    } finally {
      globalThis.Date = RealDate;
    }
    const outcome = rule("tz", true).apply(ctx([lit("2026-11-01 01:30"), lit("America/New_York")]));
    differs("dayjs-tz-parse", outcome, d.valueOf(), evaluate(outcome).epochMilliseconds);
  });

  test("dayjs-dst-steps: months go through the first, where 02:47 was skipped in 1990", () => {
    const outcome = rule("add").apply(ctx([lit(13), lit("month")]));
    const d = dayjs("1989-03-10T02:47:10.456").add(13, "month");
    const z = evaluate(outcome, local("1989-03-10T02:47:10.456"));
    differs("dayjs-dst-steps", outcome, d.valueOf(), z.epochMilliseconds);
  });

  test("dayjs-offsets: Day.js rounds New York's local mean time to -5:00", () => {
    const outcome = rule("utcOffset").apply(ctx());
    differs(
      "dayjs-offsets",
      outcome,
      dayjs("1880-01-01T12:00").utcOffset(),
      evaluate(outcome, local("1880-01-01T12:00"))
    );
  });

  test("dayjs-years: the start of the year 99, and the year 10000 formatted", () => {
    const start = rule("startOf").apply(ctx([lit("year")]));
    const d = dayjs.utc("0100-01-01T00:00:00Z").subtract(5, "month");
    expect(d.year()).toBe(99);
    differs(
      "dayjs-years",
      start,
      d.startOf("year").valueOf(),
      evaluate(start, T.Instant.fromEpochMilliseconds(d.valueOf()).toZonedDateTimeISO("UTC"))
        .epochMilliseconds
    );
    const format = rule("format").apply(ctx([lit("YYYY-MM-DD")]));
    const text = "+010000-01-01T00:00:00Z";
    differs(
      "dayjs-years",
      format,
      dayjs.utc(text).format("YYYY-MM-DD"),
      evaluate(format, T.Instant.from(text).toZonedDateTimeISO("UTC"))
    );
  });

  test("dayjs-utc-mode: a local value is in UTC when the system zone is UTC", () => {
    const outcome = rule("isUTC").apply(ctx());
    // what dayjs(0) becomes where the system zone is UTC
    differs(
      "dayjs-utc-mode",
      outcome,
      dayjs(0).isUTC(),
      evaluate(outcome, T.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO("UTC"))
    );
  });

  test("dayjs-plugins: devHelper warns about diff() without a date, the rewrite does not", () => {
    const facts = { settings: new Set(["dayjs:plugin:devHelper"]), localeConfigured: false };
    const outcome = rule("diff").apply(ctx([], { facts }));
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      dayjs.extend(devHelper);
      dayjs("2026-10-19T12:00").diff();
      const fromDayjs = warnings.length;
      evaluate(outcome, local("2026-10-19T12:00"));
      differs("dayjs-plugins", outcome, fromDayjs, warnings.length - fromDayjs);
    } finally {
      console.warn = warn;
    }
  });

  test("every Day.js difference is reproduced here", () => {
    expect([...reproduced].sort()).toEqual(
      differenceIds.filter((id) => id.startsWith("dayjs-")).sort()
    );
  });
});

describe("plugins that patch Day.js's own methods", () => {
  const using = (...plugins) => ({
    settings: new Set(plugins.map((p) => `dayjs:plugin:${p}`)),
    localeConfigured: false,
  });
  const iso = lit("2026-10-19T12:00");
  test("badMutable leaves nothing to rewrite, preParsePostFormat no strings or formats", () => {
    expect(rule("add").apply(ctx([lit(1), lit("day")], { facts: using("badMutable") })).kind).toBe(
      "none"
    );
    expect(rule("()", true).apply(ctx([iso], { facts: using("preParsePostFormat") })).kind).toBe(
      "none"
    );
    expect(
      rule("format").apply(ctx([lit("HH:mm")], { facts: using("preParsePostFormat") })).kind
    ).toBe("none");
    expect(
      exact(rule("add").apply(ctx([lit(1), lit("day")], { facts: using("preParsePostFormat") })))
        .kind
    ).toBe("rewrite");
  });
  test("devHelper's warnings and unknown plugins are a documented difference", () => {
    expect(rule("()", true).apply(ctx([iso], { facts: using("devHelper") })).differences).toEqual([
      "dayjs-plugins",
    ]);
    expect(
      exact(rule("add").apply(ctx([lit(1), lit("day")], { facts: using("devHelper") }))).kind
    ).toBe("rewrite");
    expect(rule("add").apply(ctx([lit(1), lit("day")], { facts: using("?") })).differences).toEqual(
      ["dayjs-plugins"]
    );
  });
  test("plugins that only add inputs, units or tokens the catalog never rewrites change nothing", () => {
    const facts = using(
      "customParseFormat",
      "objectSupport",
      "arraySupport",
      "isoWeek",
      "localizedFormat",
      "buddhistEra",
      "weekOfYear"
    );
    expect(exact(rule("()", true).apply(ctx([iso], { facts }))).kind).toBe("rewrite");
    expect(exact(rule("format").apply(ctx([lit("HH:mm:ss.SSS")], { facts }))).kind).toBe("rewrite");
    expect(
      rule("format").apply(ctx([lit("HH:mm:ss.SSS")], { facts: using("advancedFormat") })).kind
    ).toBe("none");
    expect(rule("add").apply(ctx([lit(1), lit("quarter")])).kind).toBe("none");
  });
});

describe("the catalog covers Day.js's API", () => {
  test("every Dayjs method and dayjs function has a rule", () => {
    const methods = Object.getOwnPropertyNames(dayjs.prototype).filter((n) => n !== "constructor");
    expect(methods.filter((n) => !findRule("Dayjs", false, n, "call"))).toEqual([]);
    const statics = ["extend", "locale", "isDayjs", "unix", "utc", "tz"];
    expect(statics.filter((n) => !findRule("Dayjs", true, n, "call"))).toEqual([]);
    expect(findRule("Dayjs", true, "()", "call")).toBeDefined();
    for (const n of ["guess", "setDefault"])
      expect(findRule("DayjsTimezone", false, n, "call")).toBeDefined();
  });
});
