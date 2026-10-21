# Moving from momentum to native Temporal

momentum is a bridge: Luxon's API today, plain Temporal tomorrow. The migration tool tells you how
far a project is from dropping momentum (or Luxon, Day.js or date-fns) and rewrites what already
has a native replacement.

```sh
npx @momentum-js/migrate check path/to/project            # would the rewrites complete the switch?
npx @momentum-js/migrate check path/to/project --verbose  # every location, not just the first 3
npx @momentum-js/migrate apply path/to/project --dry-run  # show the rewrites as a diff
npx @momentum-js/migrate apply path/to/project            # write them
npx @momentum-js/migrate rules                            # the catalog and the differences
```

The tool is the package `@momentum-js/migrate`, released with momentum under the same version and
bundling the library it was proven against. It runs on Node 20 or later and on Bun (`bunx` works
like `npx`), loading temporal-polyfill where Temporal is missing; in a clone of this repository,
`bun run migrate` runs it from source.

`check` exits with 0 when the project can switch completely and 1 otherwise, so it can gate a CI job.
`--json` prints a machine-readable report, and `--project` points at a tsconfig.json other than the
directory's. Without a tsconfig.json, a temporary one includes every JavaScript and TypeScript file
and TypeScript infers the types.

## How it decides

The tool uses TypeScript 7's compiler API, so a call like `x.plus(...)` counts as momentum's only
when `x` really is a momentum DateTime, wherever that value comes from: a factory, a parameter, a
return value, an object property. It also sees the implicit uses: comparisons and arithmetic
(`a < b`, `a - b`), template literals, `JSON.stringify`, `console` output, and values handed to code
typed `any` or to dependencies that expect momentum or Luxon objects.

Each use gets one of three outcomes:

- **exact**: a native expression gives the same result for every input. Exact rewrites are
  applied by default. Each one is proven by property tests against momentum
  (`packages/migrate/test/migrateRules.test.js`), which evaluate the very text the tool would write.
- **differs**: a native replacement exists but behaves differently in documented cases, listed
  below. These rewrites are applied only with `--accept=<difference>,...` (or `--accept=all`).
- **none**: no native replacement yet. The report lists these with the reason; they are what
  keeps momentum in the project.

Some answers depend on the whole project. Assigning `Settings.now` or `Settings.defaultZone` makes
the factories that rely on them "none"; a locale set anywhere (`setLocale`, `reconfigure`, a
`locale` option, `Settings.defaultLocale`) does the same for the rewrites that format with the
default locale; and `Settings.temporalNative = false` does it for wall-clock arithmetic, because
the opt-out resolves times with Luxon's algorithm.

## What `apply` rewrites

When every use converts, `apply` rewrites the whole project: each use, each `DateTime` and
`Duration` annotation (which become `Temporal.ZonedDateTime` and `Temporal.Duration`), and the
imports, which disappear (`@momentum-js/luxon/polyfill` becomes `temporal-polyfill/global`).
Otherwise it rewrites only self-contained expressions, which start from a momentum factory and
end in a plain value, such as `DateTime.fromMillis(ms).setZone("Asia/Tokyo").hour`. No momentum
value outlives them, so the rest of the program is untouched. Run `check` again afterwards to see
what is left.

The new text keeps everything outside the rewritten expressions byte for byte. After writing,
`apply` type-checks the changed files and reports any new errors.

## Day.js

The same tool migrates Day.js, with its utc and timezone plugins. A Day.js value becomes a
`Temporal.ZonedDateTime` in the zone it is read in: the system zone for `dayjs()`, `"UTC"` for
`dayjs.utc()`, the given zone for `dayjs.tz()`. Day.js computes with `Date`'s local-time setters,
which resolve a skipped or repeated wall-clock time like Temporal's `"compatible"` disambiguation,
so setters and the ends of units become `with(fields, { offset: "ignore" })`. When the whole
project switches, the imports of dayjs and its plugins go, with the `dayjs.extend(...)` statements.

Method by method, what the tool rewrites for Day.js, what differs and what has no replacement, and how
Day.js's plugins affect it, is in the [Day.js page](https://github.com/gesposito/momentum/blob/main/packages/dayjs/README.md)
of the repository, with a benchmark of Day.js against the Temporal that replaces it.

`packages/migrate/test/migrateDayjs.test.js` checks each exact rewrite against Day.js itself, and
`bun run test:dayjs-suite` runs Day.js's own test suite before and after the rewrites (see below).

## date-fns

The same tool migrates date-fns. Its functions take and return plain `Date`s and compute in the
system zone, so each call becomes a Temporal expression that does the same: the argument read as
a `Temporal.ZonedDateTime` in the system zone, the work done there, a `Date` built from the
result's instant. Nested calls become one chain, and a `parseISO` literal starts it in plain
Temporal. Every rewrite of a `Date` argument carries `invalid-throws`, since date-fns passes an
Invalid Date through where Temporal throws; a date-fns project accepts that one difference to
switch. When the whole project switches, the imports of date-fns go. The `in` option, `TZDate`
values, locales and `setDefaultOptions` leave the calls they touch alone.

Function by function, what the tool rewrites for date-fns, what differs and what has no
replacement is in the [date-fns page](https://github.com/gesposito/momentum/blob/main/packages/date-fns/README.md)
of the repository. `packages/migrate/test/migrateDateFns.test.js` checks each exact rewrite against
date-fns itself, and `bun run test:date-fns-suite` runs date-fns's own test suite before and after
the rewrites (see below).

## Documented differences

| Difference | What changes |
| --- | --- |
| `repeated-wall-time` | calendar arithmetic that lands on a repeated wall-clock time picks the earlier instant |
| `repeated-midnight` | the start of a day whose midnight occurs twice is the earlier one |
| `overflow` | out-of-range fields are clamped instead of rolled over |
| `invalid-throws` | invalid input throws a RangeError instead of returning an invalid DateTime |
| `fractional-amounts` | fractional amounts and mixed signs throw |
| `zone-specifiers` | only IANA names and ±HH:MM offsets are accepted as zones |
| `fixed-offset-names` | fixed offsets are named "+03:00" rather than "UTC+3" |
| `iso-format` | ISO strings write UTC as +00:00 and round historical sub-minute offsets |
| `iso-grammar` | only full date-times with an offset are parsed |
| `json-format` | JSON.stringify writes Temporal's string, with the time zone annotation |
| `inspect-output` | console output shows Temporal's representation |
| `julian-dates` | on V8 before 14.8 (Node 26), dates before 15 October 1582 are formatted in the Julian calendar (an engine bug) |
| `link-name-equality` | equals treats link names as the same zone |
| `negative-duration-iso` | negative durations are written -PT2H instead of PT-2H |
| `duration-calendar-units` | durations with years, months or weeks need a reference date to be totalled |
| `dayjs-zones` | Day.js values in a time zone keep a fixed UTC offset through arithmetic |
| `dayjs-tz` | Day.js's timezone plugin is exact only from 1970 to 9999, away from the system zone's DST changes |
| `dayjs-tz-parse` | dayjs.tz reads a repeated wall-clock time by the zone's current offset |
| `dayjs-dst-steps` | around DST changes, Day.js's month and year arithmetic can move the time by an hour |
| `dayjs-offsets` | Day.js rounds UTC offsets to 15 minutes |
| `dayjs-years` | years before 100 or after 9999 differ |
| `dayjs-plugins` | a Day.js plugin that patches the rewritten method stops applying |
| `dayjs-utc-mode` | isUTC is true for any value in the UTC zone |
| `date-fns-years` | in the fixed formats, years outside 1000 to 9999 differ |
| `date-fns-whole-units` | differenceInDays, Weeks, Months, Quarters and Years count whole units differently at month ends and around DST changes |
| `date-fns-dst-steps` | add and sub with months and days, the last days of weeks and ISO week years, endOfISOWeekYear and setDayOfYear keep the shift of a skipped wall-clock time |

`npx @momentum-js/migrate rules` prints each one with an example.

## What keeps momentum alive

The members with no native replacement are the work left before momentum can go: token
formatting and parsing (`toFormat`, `fromFormat`), relative formatting (`toRelative`), `diff`
with fractional units, `Interval`, `Info`, `Settings`, locale configuration on values, and
invalid DateTimes, whose checks (`isValid`) become try/catch around the place they are created.

## Limits

- CommonJS `require("@momentum-js/luxon")` and JSDoc type references in JavaScript files are
  reported but not rewritten.
- Partial rewrites cover self-contained expressions only, not yet values kept in local variables.
- Rewrites are exact, not minimal: `DateTime.fromMillis(ms).setZone(zone)` becomes two Temporal
  calls where one would do. Run your formatter afterwards; long lines are left as they are.
- Values that pass through code typed `any` are invisible to the type checker; the report flags
  where momentum values flow into such code, but cannot follow them further.
- The current time (`DateTime.now()`, `dayjs()`, `startOfToday()`) becomes `Temporal.Now`, which reads the system
  clock rather than `Date`, so a test that freezes `Date` (MockDate, Jest 29's fake timers) sees
  the real time after the rewrite. Fake timers from @sinonjs/fake-timers 15.4 on, as in Jest 30.5,
  fake `Temporal.Now` as well, and temporal-polyfill's `Temporal.Now` reads `Date.now()`.

## How the tool is checked

Besides the property tests (`packages/migrate/test/migrateRules.test.js` against momentum,
`packages/migrate/test/migrateDayjs.test.js` against Day.js, which `bun run test:dayjs-zones` repeats in
ten system zones with unusual DST rules, `packages/migrate/test/migrateDateFns.test.js` against
date-fns, which `bun run test:date-fns-zones` repeats the same way), `packages/migrate/test/migrate.test.js`
runs the tool on the projects in
`packages/migrate/test/fixtures/migrate`, Day.js and date-fns ones among them: the report, the
rewritten files against reviewed outputs, the type check of the result, and the values each project
computes before and after.

As a larger check, applying the exact rewrites to Luxon's own test suite leaves all 1292 tests
passing, and Day.js's own suite (1.11.23) is vendored in `packages/dayjs/` with Day.js's source and history
(`bun run sync-dayjs` re-vendors it from a checkout, pointing its imports at the package's entry
points). `bun run test:dayjs-suite` runs it against that source before and after the exact
rewrites, applied file by file since a few files load badMutable, which stops every rewrite in a
project: the 227 rewrites in 9 of its 93 files leave every passing test passing, in New York (785
of 788) as in Auckland (784 of 788). The rewritten suite runs on temporal-polyfill, whose
`Temporal.Now` follows the clock the suite freezes with MockDate; native `Temporal.Now` would not
(see Limits).

date-fns's own suite (4.4.0) is vendored the same way in `packages/date-fns/` (`bun run
sync-date-fns`), and `bun run test:date-fns-suite` runs it on vitest before and after the rewrites,
with `invalid-throws` accepted since every `Date` argument carries it: the 760 rewrites in 154 of
its 252 test files leave every passing test passing, in New York as in Auckland (3,147 of 3,148
before, 2,966 after; the 181 others pass an Invalid Date and now see a throw, as accepted). The
rewritten suite runs on temporal-polyfill, whose `Temporal.Now` follows vitest's fake timers.
