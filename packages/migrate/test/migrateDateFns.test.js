// The date-fns rewrites the catalog calls exact must agree with date-fns itself. These properties
// evaluate the very text a rewrite produces, with Dates bound as its arguments, and compare the
// results with date-fns's over Date's range and around the system zone's DST transitions. A Date
// argument carries the invalid-throws difference alone (an Invalid Date comes back as NaN from
// date-fns, where Temporal throws), so "exact" here means that difference and no other. The
// documented date-fns differences are reproduced with an example each, and every function date-fns
// exports has a catalog entry.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as dateFns from "date-fns";
import { fc, nearTransition } from "../../luxon/test/momentum/fastCheck";
import { differenceIds } from "../src/differences";
import { findRule } from "../src/rules";

const T = globalThis.Temporal;
const zone = T.Now.timeZoneId();
const zonedOf = (d) => T.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(zone);
const repo = join(__dirname, "../../..");
const facts = { settings: new Set(), localeConfigured: false };
const ctx = (args) => ({ recv: "", args, facts, quote: '"' });
const dateArg = (text) => ({ text, value: { kind: "dynamic", type: "date" } });
const numberArg = (text) => ({ text, value: { kind: "dynamic", type: "number" } });
const lit = (value) =>
  value === undefined
    ? { text: "undefined", value: { kind: "undefined" } }
    : typeof value === "number"
      ? { text: String(value), value: { kind: "number", value } }
      : typeof value === "string"
        ? { text: JSON.stringify(value), value: { kind: "string", value } }
        : { text: String(value), value: { kind: "boolean", value } };
const obj = (props) => ({
  text: `{ ${Object.entries(props)
    .map(([k, v]) => `${k}: ${v.text}`)
    .join(", ")} }`,
  value: { kind: "object", props },
});
function rule(name) {
  const found = findRule("DateFns", true, name, "call");
  expect(found).toBeDefined();
  return found;
}
/** A rewrite whose differences are the ones allowed (a Date argument's invalid-throws by default). */
function dated(outcome, allowed = ["invalid-throws"]) {
  expect(outcome.kind).toBe("rewrite");
  expect(outcome.differences.filter((d) => !allowed.includes(d))).toEqual([]);
  return outcome;
}
/** The rewrite's text, evaluated with the variables bound. */
function evaluate(outcome, vars) {
  // eslint-disable-next-line no-new-func
  return new Function("v", "Temporal", `const { d, e, f, n } = v; return (${outcome.text});`)(
    vars,
    T
  );
}
/** date-fns's result against the rewrite's: the same instant for Dates, Object.is otherwise. */
function same(expected, actual) {
  if (expected instanceof Date) {
    expect(actual).toBeInstanceOf(Date);
    expect(actual.getTime()).toBe(expected.getTime());
  } else expect(actual).toBe(expected);
}
/** A property named after the function it checks, so a failure says which. */
function check(name, property) {
  try {
    fc.assert(property);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

// Dates across Date's range, less a margin for the arithmetic, and near the system zone's DST
// transitions
const inRange = (ms) => Math.abs(ms) <= 8e15;
const instant = fc
  .oneof(fc.integer({ min: -8e15, max: 8e15 }), nearTransition(zone))
  .filter(inRange);
const date = instant.map((ms) => new Date(ms));
const pair = fc.tuple(date, date);
// The whole-unit differences agree away from the system zone's DST changes (date-fns-whole-units):
// no transition within two days of the instant
const awayFromDst = (d) => {
  const next = T.Instant.fromEpochMilliseconds(d.getTime())
    .toZonedDateTimeISO(zone)
    .subtract({ hours: 48 })
    .getTimeZoneTransition("next");
  return next === null || next.epochMilliseconds > d.getTime() + 48 * 3600000;
};
const awayFromDstPair = pair.filter(([d, e]) => awayFromDst(d) && awayFromDst(e));
// JavaScriptCore's Date#setMonth returns an Invalid Date when the result lies more than 8.64e15 ms
// (the width of Date's range) from the date, so date-fns's differenceInMonths and
// differenceInQuarters, which move the later date by the calendar difference with it, are wrong on
// Bun for such spans (oven-sh/bun#46342, docs/bun-compatibility.md): the pairs stay within that
// width there
const setMonthSpansTheRange = (() => {
  const d = new Date(0);
  d.setFullYear(-187631, 8, 27);
  d.setMonth(3472364);
  return !Number.isNaN(d.getTime());
})();
// and, for months, away from month ends, which date-fns rounds its own way
const awayFromMonthEnds = awayFromDstPair.filter(
  ([d, e]) =>
    d.getDate() <= 27 &&
    e.getDate() <= 27 &&
    (setMonthSpansTheRange || Math.abs(d.getTime() - e.getTime()) <= 8.64e15)
);
// temporal-polyfill 1.0.6 rounds the sub-second part of instants before 1970 toward 1970 in
// Instant#toString, ZonedDateTime#toString and Instant#round (fullcalendar/temporal-polyfill#117,
// docs/upstream.md): until the fix ships, the formats that truncate to the second are checked on
// whole seconds there
const instantTruncationIsRight =
  T.Instant.fromEpochMilliseconds(-1).toString({ smallestUnit: "second" }) ===
  "1969-12-31T23:59:59Z";
const wholeSecondsBefore1970 = (dates) =>
  instantTruncationIsRight
    ? dates
    : dates.filter((d) => d.getTime() >= 0 || d.getMilliseconds() === 0);
// iso-format: date-fns writes Z for a zero offset and truncates a sub-minute one, Temporal +00:00
// and the offset rounded to the minute; the strings agree for the other offsets, which a zone
// such as UTC never has (the formats with an offset are not checked there)
const zoneHasOffsets = [0, Date.UTC(2000, 6, 1)].some(
  (ms) => zonedOf(new Date(ms)).offsetNanoseconds !== 0
);
const sameOffsetString = (dates) =>
  dates.filter(
    (d) => d.getTimezoneOffset() !== 0 && zonedOf(d).offsetNanoseconds % 60000000000 === 0
  );
// date-fns-dst-steps: lastDayOfWeek and lastDayOfISOWeek agree where the date's day starts
// at midnight, setDayOfYear where the date's time exists on the same day of January
const startsAtMidnight = (zdt) => zdt.startOfDay().toPlainTime().toString() === "00:00:00";
const dayStartsAtMidnight = date.filter((d) => startsAtMidnight(zonedOf(d)));
const timeExistsInJanuary = date.filter((d) => {
  const z = zonedOf(d);
  return z
    .toPlainDate()
    .with({ month: 1 })
    .toPlainDateTime(z.toPlainTime())
    .toZonedDateTime(zone)
    .toPlainTime()
    .equals(z.toPlainTime());
});
const amount = fc.integer({ min: -1000, max: 1000 });

describe("exact date-fns arithmetic agrees with date-fns", () => {
  const units = [
    "Milliseconds",
    "Seconds",
    "Minutes",
    "Hours",
    "Days",
    "Weeks",
    "Months",
    "Quarters",
    "Years",
  ];
  // date-fns's addMonths reads the last day of the target month at the date's wall-clock time;
  // where a DST change skips that time across midnight (Moscow's 1918 and 1919 changes at 22:00
  // and 23:00 did) it reads the first of the next month and returns that day. The month
  // arithmetic is checked where that step stays on its day.
  const monthEndKeepsDate = (d, months) => {
    const z = zonedOf(d);
    const target = z.toPlainDate().add({ months });
    const last = target.with({ day: target.daysInMonth });
    return last.toPlainDateTime(z.toPlainTime()).toZonedDateTime(zone).toPlainDate().equals(last);
  };
  const monthsIn = { Months: 1, Quarters: 3, Years: 12 };
  test("add<Unit> and sub<Unit> with whole amounts", () => {
    for (const unit of units)
      for (const prefix of ["add", "sub"]) {
        const name = `${prefix}${unit}`;
        const sign = prefix === "add" ? 1 : -1;
        const safe = (d, n) =>
          !(unit in monthsIn) || monthEndKeepsDate(d, sign * n * monthsIn[unit]);
        fc.assert(
          fc.property(date, amount, (d, n) => {
            fc.pre(safe(d, n));
            same(
              dateFns[name](d, n),
              evaluate(dated(rule(name).apply(ctx([dateArg("d"), lit(n)]))), { d })
            );
          })
        );
        // a dynamic amount carries fractional-amounts and invalid-throws, and agrees for integers
        const dynamic = dated(rule(name).apply(ctx([dateArg("d"), numberArg("n")])), [
          "invalid-throws",
          "fractional-amounts",
        ]);
        fc.assert(
          fc.property(date, amount, (d, n) => {
            fc.pre(safe(d, n));
            same(dateFns[name](d, n), evaluate(dynamic, { d, n }));
          })
        );
      }
  });
  test("add and sub with a duration literal", () => {
    const duration = fc.record(
      {
        years: fc.integer({ min: -50, max: 50 }),
        months: fc.integer({ min: -50, max: 50 }),
        weeks: fc.integer({ min: -50, max: 50 }),
        days: fc.integer({ min: -500, max: 500 }),
        hours: fc.integer({ min: -500, max: 500 }),
        minutes: fc.integer({ min: -500, max: 500 }),
        seconds: fc.integer({ min: -500, max: 500 }),
      },
      { requiredKeys: [] }
    );
    // a Temporal duration takes one sign for all its fields; date-fns adds each field in turn
    const sameSign = (dur) =>
      new Set(
        Object.values(dur)
          .filter((v) => v !== 0)
          .map(Math.sign)
      ).size <= 1;
    // date-fns adds the months before the days, so a time skipped at that step shifts the result
    // (date-fns-dst-steps): the properties keep to dates whose time exists after the months
    const steps = (dur) =>
      ("years" in dur || "months" in dur) && ("weeks" in dur || "days" in dur);
    const timeKept = (d, dur, verb) => {
      const z = zonedOf(d);
      const months = { years: dur.years ?? 0, months: dur.months ?? 0 };
      return z[verb](months).toPlainTime().equals(z.toPlainTime());
    };
    const months = (dur, verb) =>
      (verb === "add" ? 1 : -1) * ((dur.years ?? 0) * 12 + (dur.months ?? 0));
    for (const [name, verb] of [
      ["add", "add"],
      ["sub", "subtract"],
    ])
      check(
        name,
        fc.property(date, duration.filter(sameSign), (d, dur) => {
          fc.pre(months(dur, verb) === 0 || monthEndKeepsDate(d, months(dur, verb)));
          fc.pre(!steps(dur) || timeKept(d, dur, verb));
          const literal = obj(Object.fromEntries(Object.entries(dur).map(([k, v]) => [k, lit(v)])));
          same(
            dateFns[name](d, dur),
            evaluate(
              dated(
                rule(name).apply(ctx([dateArg("d"), literal])),
                steps(dur) ? ["invalid-throws", "date-fns-dst-steps"] : undefined
              ),
              { d }
            )
          );
        })
      );
  });
  test("the starts, ends and last days of units", () => {
    const simple = [
      "startOfSecond",
      "endOfSecond",
      "startOfMinute",
      "endOfMinute",
      "startOfHour",
      "endOfHour",
      "startOfDay",
      "endOfDay",
      "startOfMonth",
      "endOfMonth",
      "lastDayOfMonth",
      "startOfQuarter",
      "endOfQuarter",
      "lastDayOfQuarter",
      "startOfYear",
      "endOfYear",
      "lastDayOfYear",
      "startOfDecade",
      "endOfDecade",
      "lastDayOfDecade",
      "startOfISOWeek",
      "endOfISOWeek",
      "startOfISOWeekYear",
    ];
    for (const name of simple)
      check(
        name,
        fc.property(date, (d) =>
          same(dateFns[name](d), evaluate(dated(rule(name).apply(ctx([dateArg("d")]))), { d }))
        )
      );
    for (const name of ["startOfWeek", "endOfWeek"])
      check(
        name,
        fc.property(date, fc.integer({ min: 0, max: 6 }), (d, w) => {
          same(dateFns[name](d), evaluate(dated(rule(name).apply(ctx([dateArg("d")]))), { d }));
          same(
            dateFns[name](d, { weekStartsOn: w }),
            evaluate(dated(rule(name).apply(ctx([dateArg("d"), obj({ weekStartsOn: lit(w) })]))), {
              d,
            })
          );
        })
      );
    // the last day of a week sets midnight before moving the date: date-fns-dst-steps
    const skipped = ["invalid-throws", "date-fns-dst-steps"];
    check(
      "lastDayOfISOWeek",
      fc.property(dayStartsAtMidnight, (d) =>
        same(
          dateFns.lastDayOfISOWeek(d),
          evaluate(dated(rule("lastDayOfISOWeek").apply(ctx([dateArg("d")])), skipped), { d })
        )
      )
    );
    check(
      "lastDayOfWeek",
      fc.property(dayStartsAtMidnight, fc.integer({ min: 0, max: 6 }), (d, w) => {
        same(
          dateFns.lastDayOfWeek(d),
          evaluate(dated(rule("lastDayOfWeek").apply(ctx([dateArg("d")])), skipped), { d })
        );
        same(
          dateFns.lastDayOfWeek(d, { weekStartsOn: w }),
          evaluate(
            dated(
              rule("lastDayOfWeek").apply(ctx([dateArg("d"), obj({ weekStartsOn: lit(w) })])),
              skipped
            ),
            { d }
          )
        );
      })
    );
    // the end and last day of an ISO week year step back from the next year's start, whose
    // skipped midnight shifts them: date-fns-dst-steps
    const nextIsoYearStartsAtMidnight = date.filter((d) => {
      const jan4 = T.PlainDate.from({ year: zonedOf(d).yearOfWeek + 1, month: 1, day: 4 });
      return startsAtMidnight(jan4.subtract({ days: jan4.dayOfWeek - 1 }).toZonedDateTime(zone));
    });
    for (const name of ["endOfISOWeekYear", "lastDayOfISOWeekYear"])
      check(
        name,
        fc.property(nextIsoYearStartsAtMidnight, (d) =>
          same(
            dateFns[name](d),
            evaluate(dated(rule(name).apply(ctx([dateArg("d")])), skipped), { d })
          )
        )
      );
  });
  test("today, tomorrow and yesterday", () => {
    for (const name of [
      "startOfToday",
      "startOfTomorrow",
      "startOfYesterday",
      "endOfToday",
      "endOfTomorrow",
      "endOfYesterday",
    ])
      same(dateFns[name](), evaluate(dated(rule(name).apply(ctx([])), []), {}));
  });
  test("getters", () => {
    const getters = [
      "getYear",
      "getMonth",
      "getDate",
      "getDay",
      "getHours",
      "getMinutes",
      "getSeconds",
      "getMilliseconds",
      "getDayOfYear",
      "getDaysInMonth",
      "getDaysInYear",
      "getQuarter",
      "getISODay",
      "getISOWeek",
      "getISOWeekYear",
      "getISOWeeksInYear",
      "getDecade",
      "getTime",
      "getUnixTime",
      "isLeapYear",
      "isWeekend",
      "isMonday",
      "isTuesday",
      "isWednesday",
      "isThursday",
      "isFriday",
      "isSaturday",
      "isSunday",
      "isFirstDayOfMonth",
      "isLastDayOfMonth",
    ];
    for (const name of getters)
      check(
        name,
        fc.property(date, (d) =>
          same(dateFns[name](d), evaluate(dated(rule(name).apply(ctx([dateArg("d")]))), { d }))
        )
      );
  });
  test("setters with values in range", () => {
    const ranges = {
      setMonth: [0, 11],
      setDate: [1, 28],
      setHours: [0, 23],
      setMinutes: [0, 59],
      setSeconds: [0, 59],
      setMilliseconds: [0, 999],
      setQuarter: [1, 4],
      setDay: [0, 6],
      setISODay: [1, 7],
    };
    for (const [name, [min, max]] of Object.entries(ranges))
      fc.assert(
        fc.property(date, fc.integer({ min, max }), (d, n) =>
          same(
            dateFns[name](d, n),
            evaluate(dated(rule(name).apply(ctx([dateArg("d"), lit(n)]))), { d })
          )
        )
      );
    // setDayOfYear goes through the same day of January: date-fns-dst-steps
    fc.assert(
      fc.property(timeExistsInJanuary, fc.integer({ min: 1, max: 365 }), (d, n) =>
        same(
          dateFns.setDayOfYear(d, n),
          evaluate(
            dated(rule("setDayOfYear").apply(ctx([dateArg("d"), lit(n)])), [
              "invalid-throws",
              "date-fns-dst-steps",
            ]),
            { d }
          )
        )
      )
    );
    // setYear keeps a February 29 as March 1 where Temporal clamps it to February 28: overflow
    fc.assert(
      fc.property(
        date.filter((d) => !(d.getMonth() === 1 && d.getDate() === 29)),
        fc.integer({ min: -20000, max: 20000 }),
        (d, y) =>
          same(
            dateFns.setYear(d, y),
            evaluate(
              dated(rule("setYear").apply(ctx([dateArg("d"), lit(y)])), [
                "invalid-throws",
                "overflow",
              ]),
              { d }
            )
          )
      )
    );
  });
  test("comparisons", () => {
    for (const name of [
      "isBefore",
      "isAfter",
      "isEqual",
      "compareAsc",
      "compareDesc",
      "isSameDay",
      "isSameMonth",
      "isSameYear",
      "isSameQuarter",
      "isSameISOWeekYear",
      "isSameHour",
      "isSameMinute",
      "isSameSecond",
      "isSameISOWeek",
    ])
      check(
        name,
        fc.property(pair, ([d, e]) => {
          const outcome = dated(rule(name).apply(ctx([dateArg("d"), dateArg("e")])));
          same(dateFns[name](d, e), evaluate(outcome, { d, e }));
          same(dateFns[name](d, d), evaluate(outcome, { d, e: d }));
        })
      );
    fc.assert(
      fc.property(pair, fc.integer({ min: 0, max: 6 }), ([d, e], w) =>
        same(
          dateFns.isSameWeek(d, e, { weekStartsOn: w }),
          evaluate(
            dated(
              rule("isSameWeek").apply(
                ctx([dateArg("d"), dateArg("e"), obj({ weekStartsOn: lit(w) })])
              )
            ),
            { d, e }
          )
        )
      )
    );
    fc.assert(
      fc.property(fc.tuple(date, date, date), ([d, e, f]) =>
        same(
          dateFns.isWithinInterval(d, { start: e, end: f }),
          evaluate(
            dated(
              rule("isWithinInterval").apply(
                ctx([dateArg("d"), obj({ start: dateArg("e"), end: dateArg("f") })])
              )
            ),
            { d, e, f }
          )
        )
      )
    );
    for (const name of [
      "isPast",
      "isFuture",
      "isToday",
      "isTomorrow",
      "isYesterday",
      "isThisMonth",
      "isThisYear",
      "isThisQuarter",
      "isThisHour",
      "isThisMinute",
      "isThisSecond",
      "isThisWeek",
      "isThisISOWeek",
    ])
      check(
        name,
        fc.property(
          fc
            .oneof(
              date,
              instant.map((ms) => new Date(Date.now() + (ms % 864000000)))
            )
            // date-fns and the rewrite read the clock a moment apart
            .filter((d) => Math.abs(d.getTime() - Date.now()) > 1000),
          (d) =>
            same(dateFns[name](d), evaluate(dated(rule(name).apply(ctx([dateArg("d")]))), { d }))
        )
      );
  });
  test("differences", () => {
    const plain = [
      "differenceInMilliseconds",
      "differenceInCalendarDays",
      "differenceInCalendarMonths",
      "differenceInCalendarYears",
      "differenceInCalendarQuarters",
      "differenceInCalendarISOWeekYears",
      "differenceInCalendarISOWeeks",
    ];
    for (const name of plain)
      check(
        name,
        fc.property(pair, ([d, e]) =>
          same(
            dateFns[name](d, e),
            evaluate(dated(rule(name).apply(ctx([dateArg("d"), dateArg("e")]))), { d, e })
          )
        )
      );
    const whole = ["invalid-throws", "date-fns-whole-units"];
    for (const [name, pairs] of [
      ["differenceInDays", awayFromDstPair],
      ["differenceInMonths", awayFromMonthEnds],
      ["differenceInYears", awayFromDstPair],
    ])
      check(
        name,
        fc.property(pairs, ([d, e]) =>
          same(
            dateFns[name](d, e),
            evaluate(dated(rule(name).apply(ctx([dateArg("d"), dateArg("e")])), whole), { d, e })
          )
        )
      );
    for (const [name, pairs, allowed] of [
      ["differenceInSeconds", pair],
      ["differenceInMinutes", pair],
      ["differenceInHours", pair],
      ["differenceInWeeks", awayFromDstPair, whole],
      ["differenceInQuarters", awayFromMonthEnds, whole],
    ])
      check(
        name,
        fc.property(
          pairs,
          fc.constantFrom(undefined, "trunc", "round", "floor", "ceil"),
          ([d, e], method) => {
            const args = [
              dateArg("d"),
              dateArg("e"),
              ...(method ? [obj({ roundingMethod: lit(method) })] : []),
            ];
            same(
              dateFns[name](d, e, method ? { roundingMethod: method } : undefined),
              evaluate(dated(rule(name).apply(ctx(args)), allowed), { d, e })
            );
          }
        )
      );
    fc.assert(
      fc.property(pair, fc.integer({ min: 0, max: 6 }), ([d, e], w) =>
        same(
          dateFns.differenceInCalendarWeeks(d, e, { weekStartsOn: w }),
          evaluate(
            dated(
              rule("differenceInCalendarWeeks").apply(
                ctx([dateArg("d"), dateArg("e"), obj({ weekStartsOn: lit(w) })])
              )
            ),
            { d, e }
          )
        )
      )
    );
  });
  test("ISO 8601 strings and the fixed formats", () => {
    for (const s of [
      "2024-02-29",
      "0099-12-31",
      "2024-03-10T02:30",
      "2024-11-03T01:30:00",
      "2017-05-15T09:24:15.123",
      "2017-05-15T09:24:15.123Z",
      "2017-05-15T09:24:15+05:30",
      "2024-01-01T00:00-08:00",
    ])
      same(dateFns.parseISO(s), evaluate(dated(rule("parseISO").apply(ctx([lit(s)])), []), {}));
    const fourDigitYears = date.filter((d) => d.getFullYear() >= 0 && d.getFullYear() <= 9999);
    // formatRFC3339 and formatRFC7231 write years before 1000 unpadded (999): date-fns-years
    const since1000 = fourDigitYears.filter((d) => d.getFullYear() >= 1000);
    const formatted = [
      ["formatISO9075", [], []],
      ["formatISO9075", [obj({ representation: lit("date") })], []],
      ["formatISO9075", [obj({ representation: lit("time") })], []],
      ["formatISO", [obj({ representation: lit("date") })], []],
      ...(zoneHasOffsets
        ? [
            [
              "formatRFC3339",
              [],
              ["iso-format", "date-fns-years"],
              wholeSecondsBefore1970(sameOffsetString(since1000)),
            ],
            [
              "formatRFC3339",
              [obj({ fractionDigits: lit(3) })],
              ["iso-format", "date-fns-years"],
              sameOffsetString(since1000),
            ],
          ]
        : []),
      ["format", [lit("HH:mm")], []],
      ["format", [lit("HH:mm:ss")], []],
      ["format", [lit("HH:mm:ss.SSS")], []],
      ["lightFormat", [lit("HH:mm")], []],
    ];
    for (const [name, args, allowed, years = fourDigitYears] of formatted)
      fc.assert(
        fc.property(years, (d) =>
          same(
            dateFns[name](
              d,
              ...args.map((a) =>
                a.value.kind === "object"
                  ? Object.fromEntries(
                      Object.entries(a.value.props).map(([k, v]) => [k, v.value.value])
                    )
                  : a.value.value
              )
            ),
            evaluate(
              dated(rule(name).apply(ctx([dateArg("d"), ...args])), ["invalid-throws", ...allowed]),
              { d }
            )
          )
        )
      );
    fc.assert(
      fc.property(since1000, (d) =>
        same(dateFns.formatRFC7231(d), evaluate(dated(rule("formatRFC7231").apply(ctx([dateArg("d")])), ["invalid-throws", "date-fns-years"]), { d }))
      )
    );
    // formatISO writes Z for a zero offset where Temporal writes +00:00: iso-format
    if (zoneHasOffsets)
      fc.assert(
        fc.property(
          wholeSecondsBefore1970(sameOffsetString(fourDigitYears)),
          (d) =>
            same(
              dateFns.formatISO(d),
              evaluate(
                dated(rule("formatISO").apply(ctx([dateArg("d")])), [
                  "invalid-throws",
                  "iso-format",
                ]),
                { d }
              )
            )
        )
      );
    for (const pattern of ["yyyy-MM-dd", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm:ss"])
      fc.assert(
        fc.property(fourDigitYears, (d) =>
          same(
            dateFns.format(d, pattern),
            evaluate(
              dated(rule("format").apply(ctx([dateArg("d"), lit(pattern)])), [
                "invalid-throws",
                "date-fns-years",
              ]),
              { d }
            )
          )
        )
      );
  });
  test("conversions and the next and previous weekdays", () => {
    fc.assert(
      fc.property(date, (d) =>
        same(dateFns.toDate(d), evaluate(dated(rule("toDate").apply(ctx([dateArg("d")]))), { d }))
      )
    );
    fc.assert(
      fc.property(fc.integer({ min: -8e12, max: 8e12 }), (s) => {
        same(
          dateFns.fromUnixTime(s),
          evaluate(dated(rule("fromUnixTime").apply(ctx([lit(s)])), []), {})
        );
        same(
          dateFns.fromUnixTime(s),
          evaluate(dated(rule("fromUnixTime").apply(ctx([numberArg("n")]))), { n: s })
        );
      })
    );
    for (const name of ["nextDay", "previousDay"])
      check(
        name,
        fc.property(date, fc.integer({ min: 0, max: 6 }), (d, n) =>
          same(
            dateFns[name](d, n),
            evaluate(dated(rule(name).apply(ctx([dateArg("d"), lit(n)]))), { d })
          )
        )
      );
    for (const day of [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ])
      for (const prefix of ["next", "previous"])
        fc.assert(
          fc.property(date, (d) =>
            same(
              dateFns[`${prefix}${day}`](d),
              evaluate(dated(rule(`${prefix}${day}`).apply(ctx([dateArg("d")]))), { d })
            )
          )
        );
  });
});

describe("the trailing options every function takes", () => {
  test("a literal `in` or a dynamic options object stops the rewrite", () => {
    const context = obj({ in: { text: 'tz("Asia/Tokyo")', value: { kind: "dynamic", type: "unknown" } } });
    const dynamic = { text: "options", value: { kind: "dynamic", type: "object" } };
    for (const [name, args] of [
      ["startOfDay", [dateArg("d")]],
      ["endOfToday", []],
      ["addDays", [dateArg("d"), lit(1)]],
      ["setDate", [dateArg("d"), lit(5)]],
      ["isSameDay", [dateArg("d"), dateArg("e")]],
      ["differenceInHours", [dateArg("d"), dateArg("e")]],
      ["formatRFC7231", [dateArg("d")]],
    ])
      for (const options of [context, dynamic])
        expect(rule(name).apply(ctx([...args, options])).kind).toBe("none");
    expect(rule("startOfDay").apply(ctx([dateArg("d"), lit(undefined)])).kind).toBe("rewrite");
    expect(rule("addDays").apply(ctx([dateArg("d"), lit(1), lit(undefined)])).kind).toBe("rewrite");
  });
});

describe("date-fns's documented differences", () => {
  test("date-fns-years: the fixed date formats pad years to four digits", () => {
    const d = new Date(0);
    d.setFullYear(10000, 0, 1);
    const outcome = rule("format").apply(ctx([dateArg("d"), lit("yyyy-MM-dd")]));
    expect(outcome.differences).toContain("date-fns-years");
    expect(dateFns.format(d, "yyyy-MM-dd")).toBe("10000-01-01");
    expect(evaluate(outcome, { d })).toBe("+010000-01-01");
    const rfc = rule("formatRFC3339").apply(ctx([dateArg("d")]));
    expect(rfc.differences).toContain("date-fns-years");
    const early = new Date(999, 0, 1, 12);
    expect(dateFns.formatRFC3339(early).startsWith("999-01-01T12:00:00")).toBe(true);
    expect(evaluate(rfc, { d: early }).startsWith("0999-01-01T12:00:00")).toBe(true);
  });
  test("date-fns-whole-units: a month's last day counts as a month, a skipped hour as a day", () => {
    const months = rule("differenceInMonths").apply(ctx([dateArg("d"), dateArg("e")]));
    expect(months.differences).toContain("date-fns-whole-units");
    const d = new Date(2026, 1, 28);
    const e = new Date(2025, 11, 31);
    expect(dateFns.differenceInMonths(d, e)).toBe(2);
    expect(evaluate(months, { d, e })).toBe(1);
    const days = rule("differenceInDays").apply(ctx([dateArg("d"), dateArg("e")]));
    expect(days.differences).toContain("date-fns-whole-units");
    if (zone === "America/New_York") {
      // moved back 115 days, 02:30 lands in the hour skipped on 2026-03-08 and becomes 03:30
      const f = new Date(2026, 6, 1, 2, 30);
      const g = new Date(2026, 2, 8, 3, 0);
      expect(dateFns.differenceInDays(f, g)).toBe(115);
      expect(evaluate(days, { d: f, e: g })).toBe(114);
    }
  });
  test("date-fns-dst-steps: add goes through the months first, where 02:30 was skipped in 2026", () => {
    const outcome = rule("add").apply(ctx([dateArg("d"), obj({ months: lit(1), days: lit(1) })]));
    expect(outcome.differences).toContain("date-fns-dst-steps");
    expect(rule("add").apply(ctx([dateArg("d"), obj({ months: lit(1) })])).differences).toEqual([
      "invalid-throws",
    ]);
    if (zone === "America/New_York") {
      const d = new Date(2026, 1, 8, 2, 30);
      expect(dateFns.add(d, { months: 1, days: 1 }).getTime()).toBe(
        new Date(2026, 2, 9, 3, 30).getTime()
      );
      expect(evaluate(outcome, { d }).getTime()).toBe(new Date(2026, 2, 9, 2, 30).getTime());
    }
  });
  test("date-fns-dst-steps: in Havana, the last day of a week keeps a skipped midnight's hour", () => {
    // Havana's DST starts at midnight; 2057-03-11 is such a Sunday, so its first instant is 01:00
    const outcome = rule("lastDayOfWeek").apply(ctx([dateArg("d")]));
    expect(outcome.differences).toContain("date-fns-dst-steps");
    const script =
      'import { lastDayOfWeek } from "date-fns";\n' +
      'const d = new Date("2057-03-11T05:00:00.000Z");\n' +
      `console.log(JSON.stringify([lastDayOfWeek(d).getTime(), (${outcome.text}).getTime()]));`;
    const result = spawnSync("bun", ["-e", script], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, TZ: "America/Havana" },
    });
    expect(result.stderr).toBe("");
    // date-fns: Saturday 01:00 CDT; Temporal: Saturday 00:00 CDT
    expect(JSON.parse(result.stdout)).toEqual([Date.UTC(2057, 2, 17, 5), Date.UTC(2057, 2, 17, 4)]);
  });
  test("every date-fns difference has an example here", () => {
    const reproduced = ["date-fns-years", "date-fns-whole-units", "date-fns-dst-steps"];
    for (const id of differenceIds.filter((d) => d.startsWith("date-fns-")))
      expect(reproduced).toContain(id);
  });
});

describe("the catalog covers date-fns", () => {
  test("every function date-fns exports has a rule", () => {
    const missing = Object.keys(dateFns)
      .filter((name) => typeof dateFns[name] === "function")
      .filter((name) => findRule("DateFns", true, name, "call") === undefined);
    expect(missing).toEqual([]);
  });
});
