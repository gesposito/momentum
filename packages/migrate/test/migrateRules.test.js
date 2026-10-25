/* global test expect describe beforeAll afterAll */
// The migration catalog (migrate/rules.ts) promises that some rewrites are exact. These
// properties evaluate the very text a rewrite produces and compare it with momentum, over any
// valid instant in every IANA zone, UTC and fixed offsets, biased towards DST transitions. Each
// documented difference is reproduced on a known example, and every public member of DateTime
// and Duration must have an entry in the catalog.

import { DateTime, Duration, Info, Settings } from "../../luxon/src/momentum";
import { fc, nearTransition } from "../../luxon/test/momentum/fastCheck";
import { allRules, classNotes, compareOutcome, findRule, valueOfOutcome } from "../src/rules";
import { differenceIds } from "../src/differences";

const T = globalThis.Temporal;

// the catalog describes the default, Temporal-native core
let native;
beforeAll(() => {
  native = Settings.temporalNative;
  Settings.temporalNative = true;
});
afterAll(() => {
  Settings.temporalNative = native;
});
const DAY = 86400000;
const facts = { settings: new Set(), localeConfigured: false };
const ctx = (args = [], extra = {}) => ({ recv: "r", args, facts, quote: '"', ...extra });
const literal = (value) =>
  value === undefined
    ? { text: "undefined", value: { kind: "undefined" } }
    : typeof value === "number"
      ? { text: String(value), value: { kind: "number", value } }
      : typeof value === "string"
        ? { text: JSON.stringify(value), value: { kind: "string", value } }
        : typeof value === "boolean"
          ? { text: String(value), value: { kind: "boolean", value } }
          : {
              text: `{ ${Object.entries(value)
                .map(([k, v]) => `${k}: ${literal(v).text}`)
                .join(", ")} }`,
              value: {
                kind: "object",
                props: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, literal(v)])),
              },
            };
const preset = (name) => ({
  text: `DateTime.${name}`,
  value: { kind: "member", owner: "DateTime", name },
});

/** The rewrite's text, evaluated with `r` bound to the receiver. */
function evaluate(outcome, r) {
  expect(outcome.kind).toBe("rewrite");
  // eslint-disable-next-line no-new-func
  return new Function("r", "Temporal", `return (${outcome.text});`)(r, T);
}

const dstZones = [
  "America/New_York",
  "Europe/London",
  "Australia/Lord_Howe",
  "America/Havana",
  "America/Santiago",
  "Asia/Tehran",
];
const zones = [...Intl.supportedValuesOf("timeZone"), "UTC", "UTC+3", "UTC-5:30"];
const temporalZone = (z) => {
  const m = /^UTC([+-])(\d+)(?::(\d+))?$/.exec(z);
  return m ? `${m[1]}${m[2].padStart(2, "0")}:${(m[3] ?? "0").padStart(2, "0")}` : z;
};
// momentum, like Luxon, also needs the local time within Date's range: stay a day inside it
const validInstant = fc.integer({ min: -8.64e15 + 2 * DAY, max: 8.64e15 - 2 * DAY });
const instantAndZone = fc.oneof(
  fc.tuple(validInstant, fc.constantFrom(...zones)),
  fc.constantFrom(...dstZones).chain((z) => fc.tuple(nearTransition(z), fc.constant(z)))
);
const afterReform = fc.tuple(
  fc.integer({ min: Date.UTC(1583, 0, 1), max: 8.64e15 - 2 * DAY }),
  fc.constantFrom(...zones)
);
const pair = ([ts, z]) => [
  DateTime.fromMillis(ts, { zone: z }),
  T.Instant.fromEpochMilliseconds(ts).toZonedDateTimeISO(temporalZone(z)),
];

/** momentum's result and the rewrite's are the same value. */
function same(a, b) {
  if (DateTime.isDateTime(a)) {
    expect(b).toBeInstanceOf(T.ZonedDateTime);
    expect(b.epochMilliseconds).toBe(a.toMillis());
    expect(b.offsetNanoseconds / 6e10).toBe(a.offset);
    expect([b.year, b.month, b.day, b.hour, b.minute, b.second, b.millisecond]).toEqual([
      a.year,
      a.month,
      a.day,
      a.hour,
      a.minute,
      a.second,
      a.millisecond,
    ]);
  } else if (Duration.isDuration(a)) {
    expect(b).toBeInstanceOf(T.Duration);
    for (const unit of [
      "years",
      "months",
      "weeks",
      "days",
      "hours",
      "minutes",
      "seconds",
      "milliseconds",
    ])
      expect(b[unit]).toBe(a[unit]);
  } else if (a instanceof Date) expect(b.getTime()).toBe(a.getTime());
  else if (
    a !== null &&
    typeof a === "object" &&
    typeof a.toString === "function" &&
    a.constructor !== Object
  )
    expect(String(b)).toBe(String(a));
  else expect(b).toEqual(a);
}

describe("exact DateTime rewrites agree with momentum", () => {
  const getters = allRules().filter((r) => r.owner === "DateTime" && !r.static && r.form === "get");
  for (const rule of getters) {
    const outcome = rule.apply(ctx());
    if (outcome.kind !== "rewrite" || outcome.differences.some((d) => d !== "julian-dates"))
      continue;
    // a julian-dates rewrite is exact from the Gregorian reform on
    const input = outcome.differences.length === 0 ? instantAndZone : afterReform;
    test(`${rule.name}: ${outcome.text}${outcome.differences.length ? " (from 1583)" : ""}`, () => {
      fc.assert(
        fc.property(input, (i) => {
          const [dt, zdt] = pair(i);
          same(dt[rule.name], evaluate(outcome, zdt));
        })
      );
    });
  }

  const calls = [
    ["toMillis"],
    ["valueOf"],
    ["toSeconds"],
    ["toUnixInteger"],
    ["toJSDate"],
    ["toBSON"],
    ["toISODate"],
    ["toUTC"],
    ["toLocal"],
    ["toZonedDateTime"],
    ["toInstant"],
    ["toPlainDate"],
    ["toPlainDateTime"],
    ["toPlainTime"],
    ["toISOTime", { includeOffset: false }],
    ["plus", { hours: 5 }],
    ["plus", { minutes: -90 }],
    ["minus", { seconds: 3601 }],
    ["plus", { milliseconds: 1 }],
    ["minus", 86400000],
    ["set", { hour: 2 }],
    ["set", { minute: 59, second: 0 }],
    ["set", { millisecond: 999 }],
    ["startOf", "hour"],
    ["startOf", "minute"],
    ["startOf", "second"],
    ["startOf", "millisecond"],
    ["endOf", "hour"],
    ["endOf", "minute"],
    ["endOf", "second"],
    ["endOf", "milliseconds"],
    ["setZone", "Asia/Tokyo"],
    ["setZone", "utc"],
    ["setZone", "local"],
    ["setZone", "America/Argentina/Buenos_Aires"],
    ["get", "weekday"],
    ["get", "ordinal"],
  ];
  for (const [name, ...args] of calls) {
    const outcome = findRule("DateTime", false, name, "call").apply(ctx(args.map(literal)));
    test(`${name}(${args.map((a) => JSON.stringify(a)).join(", ")}): ${outcome.kind === "rewrite" ? outcome.text : outcome.reason}`, () => {
      expect(outcome.kind).toBe("rewrite");
      expect(outcome.differences).toEqual([]);
      fc.assert(
        fc.property(instantAndZone, (input) => {
          const [dt, zdt] = pair(input);
          same(dt[name](...args), evaluate(outcome, zdt));
        })
      );
    });
  }

  const formats = Object.getOwnPropertyNames(DateTime).filter((n) =>
    /^(DATE|TIME|DATETIME)_/.test(n)
  );
  for (const name of formats.filter((n) => !("timeZoneName" in DateTime[n]))) {
    test(`toLocaleString(DateTime.${name}) in the default locale and in French`, () => {
      const plain = findRule("DateTime", false, "toLocaleString", "call").apply(
        ctx([preset(name)])
      );
      const french = findRule("DateTime", false, "toLocaleString", "call").apply(
        ctx([preset(name), literal({ locale: "fr" })])
      );
      expect([plain.differences, french.differences]).toEqual([["julian-dates"], ["julian-dates"]]);
      fc.assert(
        fc.property(afterReform, (input) => {
          const [dt, zdt] = pair(input);
          same(dt.toLocaleString(DateTime[name]), evaluate(plain, zdt));
          same(dt.toLocaleString(DateTime[name], { locale: "fr" }), evaluate(french, zdt));
        }),
        { numRuns: 50 }
      );
    });
  }

  test("the presets become the Intl options they stand for", () => {
    for (const name of formats) {
      const outcome = findRule("DateTime", true, name, "get").apply(ctx());
      expect(evaluate(outcome)).toEqual({ ...DateTime[name] });
    }
  });

  test("a < b compares the instants", () => {
    const outcome = compareOutcome("r[0]", "<", "r[1]");
    fc.assert(
      fc.property(instantAndZone, instantAndZone, (x, y) => {
        const [a, za] = pair(x);
        const [b, zb] = pair(y);
        expect(evaluate(outcome, [za, zb])).toBe(a < b);
      })
    );
  });

  test("valueOf conversions read the epoch milliseconds", () => {
    const outcome = valueOfOutcome("DateTime", "r", '"');
    fc.assert(
      fc.property(instantAndZone, (input) => {
        const [dt, zdt] = pair(input);
        expect(evaluate(outcome, zdt)).toBe(+dt);
      })
    );
  });
});

describe("exact DateTime factories agree with momentum", () => {
  test("now()", () => {
    const outcome = findRule("DateTime", true, "now", "call").apply(ctx());
    const before = Date.now();
    const zdt = evaluate(outcome);
    expect(zdt.timeZoneId).toBe(DateTime.now().zoneName);
    expect(zdt.epochMilliseconds).toBeGreaterThanOrEqual(before);
    expect(zdt.epochMilliseconds % 1).toBe(0);
    expect(zdt.epochNanoseconds % 1000000n).toBe(0n);
  });

  test("fromMillis and fromSeconds with integer literals", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -8.64e15 + 2 * DAY, max: 8.64e15 - 2 * DAY }),
        fc.constantFrom(...zones),
        (ms, z) => {
          const outcome = findRule("DateTime", true, "fromMillis", "call").apply(
            ctx([literal(ms), literal({ zone: z })])
          );
          const differences =
            z.startsWith("UTC+") || z.startsWith("UTC-") ? ["fixed-offset-names"] : [];
          expect(outcome.differences).toEqual(differences);
          same(DateTime.fromMillis(ms, { zone: z }), evaluate(outcome));
          const seconds = Math.trunc(ms / 1000) || 0;
          const fromSeconds = findRule("DateTime", true, "fromSeconds", "call").apply(
            ctx([literal(seconds), literal({ zone: z })])
          );
          same(DateTime.fromSeconds(seconds, { zone: z }), evaluate(fromSeconds));
        }
      )
    );
  });

  test("fromISO with a literal date-time that has an offset", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(1, 0, 1), max: Date.UTC(9999, 11, 31) }),
        fc.constantFrom(...zones),
        fc.constantFrom("Z", "+05:30", "-03:00"),
        (ms, z, offset) => {
          const text = DateTime.fromMillis(ms, {
            zone: offset === "Z" ? "utc" : `UTC${offset}`,
          }).toISO({ suppressMilliseconds: ms % 1000 === 0 });
          const outcome = findRule("DateTime", true, "fromISO", "call").apply(
            ctx([literal(text), literal({ zone: z })])
          );
          expect(outcome.kind).toBe("rewrite");
          if (outcome.differences.length === 0)
            same(DateTime.fromISO(text, { zone: z }), evaluate(outcome));
          else expect(outcome.differences).toEqual(["fixed-offset-names"]);
        }
      )
    );
  });

  test("fromObject, local and utc with literal fields: exact unless the time is repeated", () => {
    const fields = fc.record({
      year: fc.integer({ min: -9999, max: 9999 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
      hour: fc.integer({ min: 0, max: 23 }),
      minute: fc.integer({ min: 0, max: 59 }),
      second: fc.integer({ min: 0, max: 59 }),
      millisecond: fc.integer({ min: 0, max: 999 }),
    });
    fc.assert(
      fc.property(
        fields,
        fc.constantFrom(...zones.filter((z) => !z.startsWith("UTC+") && !z.startsWith("UTC-"))),
        (f, z) => {
          for (const [name, args, reference] of [
            [
              "fromObject",
              [literal(f), literal({ zone: z })],
              () => DateTime.fromObject(f, { zone: z }),
            ],
            [
              "local",
              [...Object.values(f).map(literal), literal({ zone: z })],
              () => DateTime.local(...Object.values(f), { zone: z }),
            ],
            ["utc", Object.values(f).map(literal), () => DateTime.utc(...Object.values(f))],
          ]) {
            const outcome = findRule("DateTime", true, name, "call").apply(ctx(args));
            expect(outcome.kind).toBe("rewrite");
            if (outcome.differences.length === 0) same(reference(), evaluate(outcome));
            else expect(outcome.differences).toEqual(["repeated-wall-time"]);
          }
        }
      )
    );
  });

  test("fromInstant and fromZonedDateTime", () => {
    fc.assert(
      fc.property(instantAndZone, ([ts, z]) => {
        if (z.startsWith("UTC+") || z.startsWith("UTC-")) return;
        const instant = T.Instant.fromEpochMilliseconds(ts);
        const fromInstant = findRule("DateTime", true, "fromInstant", "call").apply(
          ctx([{ text: "r", value: { kind: "dynamic", type: "object" } }, literal({ zone: z })])
        );
        same(DateTime.fromInstant(instant, { zone: z }), evaluate(fromInstant, instant));
        const zdt = instant.toZonedDateTimeISO(z);
        const fromZoned = findRule("DateTime", true, "fromZonedDateTime", "call").apply(
          ctx([{ text: "r", value: { kind: "dynamic", type: "object" } }])
        );
        same(DateTime.fromZonedDateTime(zdt), evaluate(fromZoned, zdt));
      })
    );
  });
});

describe("exact Duration rewrites agree with momentum", () => {
  const units = fc
    .record(
      {
        years: fc.nat(50),
        months: fc.nat(50),
        weeks: fc.nat(50),
        days: fc.nat(500),
        hours: fc.nat(500),
        minutes: fc.nat(5000),
        seconds: fc.nat(5000),
        milliseconds: fc.nat(5000),
      },
      { requiredKeys: [] }
    )
    .filter((o) => Object.keys(o).length > 0);
  const signed = fc
    .tuple(units, fc.boolean())
    .map(([o, negative]) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, negative ? -v : v]))
    );

  test("fromObject, getters and negate", () => {
    fc.assert(
      fc.property(signed, (o) => {
        const outcome = findRule("Duration", true, "fromObject", "call").apply(ctx([literal(o)]));
        expect(outcome.differences).toEqual([]);
        const d = evaluate(outcome);
        same(Duration.fromObject(o), d);
        same(
          Duration.fromObject(o).negate(),
          evaluate(findRule("Duration", false, "negate", "call").apply(ctx()), d)
        );
      })
    );
  });

  test("as and toMillis are exact for durations without calendar units", () => {
    const timeUnits = signed
      .map((o) =>
        Object.fromEntries(
          Object.entries(o).filter(([k]) => !["years", "months", "weeks"].includes(k))
        )
      )
      .filter((o) => Object.keys(o).length > 0);
    fc.assert(
      fc.property(
        timeUnits,
        fc.constantFrom("days", "hours", "minutes", "seconds", "milliseconds"),
        (o, unit) => {
          const receiverUnits = Object.keys(o);
          const as = findRule("Duration", false, "as", "call").apply(
            ctx([literal(unit)], { receiverUnits })
          );
          const toMillis = findRule("Duration", false, "toMillis", "call").apply(
            ctx([], { receiverUnits })
          );
          expect([as.differences, toMillis.differences]).toEqual([[], []]);
          const d = T.Duration.from(o);
          expect(evaluate(as, d)).toBeCloseTo(Duration.fromObject(o).as(unit), 9);
          expect(evaluate(toMillis, d)).toBe(Duration.fromObject(o).toMillis());
        }
      )
    );
  });

  test("fromMillis and literal fromISO", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), (ms) => {
        same(
          Duration.fromMillis(ms),
          evaluate(findRule("Duration", true, "fromMillis", "call").apply(ctx([literal(ms)])))
        );
      })
    );
    for (const text of ["P1Y2M3W4DT5H6M7S", "PT1.5S", "P2W", "PT36H"]) {
      const outcome = findRule("Duration", true, "fromISO", "call").apply(ctx([literal(text)]));
      expect(outcome.differences).toEqual([]);
      same(Duration.fromISO(text), evaluate(outcome));
    }
  });
});

describe("each documented difference is real", () => {
  const ny = (iso) => DateTime.fromISO(iso, { setZone: true });
  const zny = (iso) => T.ZonedDateTime.from(iso);
  const examples = {
    "repeated-wall-time": () => [
      ny("2017-11-06T01:30:00-05:00").setZone("America/New_York").minus({ days: 1 }).toISO(),
      zny("2017-11-06T01:30:00-05:00[America/New_York]")
        .subtract({ days: 1 })
        .toString({ fractionalSecondDigits: 3, timeZoneName: "never" }),
    ],
    "repeated-midnight": () => {
      const ms = Date.parse("2031-11-02T05:00:00Z");
      return [
        DateTime.fromMillis(ms, { zone: "America/Havana" }).startOf("day").toMillis(),
        T.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO("America/Havana").startOfDay()
          .epochMilliseconds,
      ];
    },
    overflow: () => [
      DateTime.fromISO("2017-04-15").set({ day: 31 }).toISODate(),
      T.PlainDate.from("2017-04-15").with({ day: 31 }).toString(),
    ],
    "invalid-throws": () => [
      DateTime.fromMillis(NaN).isValid,
      attempt(() => T.Instant.fromEpochMilliseconds(NaN)),
    ],
    "fractional-amounts": () => [
      DateTime.fromMillis(0).plus({ hours: 1.5 }).toMillis(),
      attempt(() =>
        T.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO("UTC").add({ hours: 1.5 })
      ),
    ],
    "zone-specifiers": () => [
      DateTime.fromMillis(0).setZone("UTC+3").isValid,
      attempt(() => T.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO("UTC+3")),
    ],
    "fixed-offset-names": () => [
      DateTime.fromMillis(0, { zone: "UTC+3" }).zoneName,
      T.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO("+03:00").timeZoneId,
    ],
    "iso-format": () => [
      DateTime.fromMillis(0, { zone: "utc" }).toISO(),
      T.Instant.fromEpochMilliseconds(0)
        .toZonedDateTimeISO("UTC")
        .toString({ fractionalSecondDigits: 3, timeZoneName: "never" }),
    ],
    "iso-grammar": () => [
      DateTime.fromISO("2016-W05-4").isValid,
      attempt(() => T.Instant.from("2016-W05-4")),
    ],
    "json-format": () => [
      JSON.stringify(DateTime.fromMillis(0, { zone: "America/New_York" })),
      JSON.stringify(T.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO("America/New_York")),
    ],
    "inspect-output": () => [
      Object.keys(DateTime.fromMillis(0)).length > 0,
      Object.keys(T.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO("UTC")).length > 0,
    ],
    "link-name-equality": () => [
      DateTime.fromMillis(0, { zone: "Asia/Calcutta" }).equals(
        DateTime.fromMillis(0, { zone: "Asia/Kolkata" })
      ),
      T.Instant.fromEpochMilliseconds(0)
        .toZonedDateTimeISO("Asia/Calcutta")
        .equals(T.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO("Asia/Kolkata")),
    ],
    "negative-duration-iso": () => [
      Duration.fromObject({ hours: -2 }).toISO(),
      T.Duration.from({ hours: -2 }).toString(),
    ],
    "duration-calendar-units": () => [
      Duration.fromObject({ months: 1 }).as("days"),
      attempt(() => T.Duration.from({ months: 1 }).total("day")),
    ],
  };
  function attempt(f) {
    try {
      return f();
    } catch (e) {
      return `throws ${e.name}`;
    }
  }
  // Day.js's differences are reproduced against Day.js, in migrateDayjs.test.js
  for (const id of differenceIds.filter(
    (d) => d !== "julian-dates" && !d.startsWith("dayjs-") && !d.startsWith("date-fns-")
  ))
    test(id, () => {
      expect(examples[id]).toBeDefined();
      const [momentum, temporal] = examples[id]();
      expect(temporal).not.toEqual(momentum);
    });

  // an engine bug rather than a difference of design, fixed in V8 14.8: if Node 26 gets the fix
  // (docs/upstream.md), this fails and the difference can go
  test("julian-dates: V8 before 14.8 formats pre-Gregorian dates in the Julian calendar", () => {
    const options = { year: "numeric", month: "long", day: "numeric" };
    const zdt = T.ZonedDateTime.from("1500-03-31T12:00[UTC]");
    const momentum = DateTime.fromMillis(zdt.epochMilliseconds, { zone: "utc" }).toLocaleString(
      options,
      { locale: "en-US" }
    );
    expect(momentum).toBe("March 31, 1500");
    const [major, minor] = process.versions.v8.split(".").map(Number);
    const julian =
      process.versions.bun === undefined &&
      Function.prototype.toString.call(T.ZonedDateTime).includes("[native code]") &&
      major * 100 + minor < 1408;
    expect(zdt.toLocaleString("en-US", options)).toBe(julian ? "March 21, 1500" : momentum);
  });
});

describe("the catalog covers momentum's API", () => {
  const members = (cls) => [
    ...Object.getOwnPropertyNames(cls)
      .filter((n) => !["length", "name", "prototype"].includes(n))
      .map((n) => [true, n]),
    ...Object.getOwnPropertyNames(cls.prototype)
      .filter((n) => n !== "constructor")
      .map((n) => [false, n]),
  ];
  for (const [name, cls] of [
    ["DateTime", DateTime],
    ["Duration", Duration],
  ])
    test(`every member of ${name} has a rule`, () => {
      const missing = members(cls).filter(
        ([isStatic, n]) =>
          !findRule(name, isStatic, n, "get") && !findRule(name, isStatic, n, "call")
      );
      expect(missing.map(([isStatic, n]) => `${name}${isStatic ? "." : "#"}${n}`)).toEqual([]);
    });
  test("classes without a Temporal counterpart are listed with a reason", () => {
    for (const name of [
      "Interval",
      "Info",
      "Settings",
      "Zone",
      "IANAZone",
      "FixedOffsetZone",
      "SystemZone",
      "InvalidZone",
    ])
      expect(classNotes[name]).toEqual(expect.any(String));
    expect(Info).toBeDefined();
  });
});
