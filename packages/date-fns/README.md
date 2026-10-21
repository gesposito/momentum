# date-fns in momentum

`packages/date-fns` is [date-fns](https://github.com/date-fns/date-fns) 4.4.0 as it is: the
`core` package's `src/` (every function with its tests, the locales, `fp`) and `test/` (its time
zone scripts), `tz/` (`@date-fns/tz` 1.5.0, the `TZDate` class) and `utc/` (`@date-fns/utc`
2.1.1) with their sources and tests, and the three `LICENSE.md` files, byte for byte, with
date-fns's own history merged in underneath (1,678 commits by 371 authors since 2014, tag
`date-fns/cd53d253`), the way Luxon's and Day.js's came in. It is not a port: momentum has no
date-fns-on-Temporal library and plans none. It is the reference the migration tool's date-fns
rules are checked against.

## What the migration tool rewrites

`npx @momentum-js/migrate check <project>` finds date-fns calls by their import, in TypeScript
and JavaScript projects: a call counts when its function comes from `date-fns` (or a subpath such
as `date-fns/addDays`, or a namespace import) and its arguments are `Date`s and literals the rule
reads. date-fns is a library of functions over plain `Date`s, 246 of them, which compute in the
system zone with `Date`'s local-time setters, so each call becomes a Temporal expression that
takes and returns a `Date`: the argument is read as a `Temporal.ZonedDateTime` in the system zone
(`Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(Temporal.Now.timeZoneId())`),
the work happens there, and a `Date` result is `new Date(result.epochMilliseconds)`. Nested calls
(`endOfDay(addDays(date, 14))`) become one chain without the round trip, and a `parseISO` literal
starts a chain in plain Temporal. A skipped or repeated wall-clock time resolves as date-fns's
`Date` arithmetic does, so setters and the ends of units are `with(fields, { offset: "ignore" })`.

Every rewrite of a `Date` argument carries `invalid-throws`: date-fns passes an Invalid Date
through as `Invalid Date` or `NaN`, Temporal throws, so a date-fns project accepts that one
difference (`--accept=invalid-throws`) to switch, and checks validity where its dates are created.
When the whole project switches, the imports of date-fns go. The `in` option (a context from
`@date-fns/tz`), `TZDate` and `UTCDate` values, the `locale` option and a project that calls
`setDefaultOptions` leave the calls they touch alone.

| date-fns | Temporal | |
| --- | --- | --- |
| `addDays(d, n)` to `addYears`, `addQuarters`, `sub*`, `add(d, duration)`, `sub(d, duration)` | `.add({ days: n })`, `.subtract(...)` | exact for whole amounts; a fractional or NaN amount: `fractional-amounts` |
| `startOfDay` to `startOfYear`, `startOfDecade`, `startOfWeek`, `startOfISOWeek`, `startOfISOWeekYear`, the `endOf*` and `lastDayOf*` | `.startOfDay()`, `.toPlainDate().with(...)`, `.with(..., { offset: "ignore" })` | exact |
| `startOfToday`, `endOfTomorrow` and the other four | `Temporal.Now.plainDateISO()` | exact |
| `getYear` to `getMilliseconds`, `getDay`, `getISODay`, `getDayOfYear`, `getISOWeek`, `getISOWeekYear`, `getISOWeeksInYear`, `getQuarter`, `getDecade`, `getDaysInMonth`, `getDaysInYear`, `getTime`, `getUnixTime` | the fields (`.month - 1`, `.dayOfWeek % 7`, `.weekOfYear`) | exact |
| `setYear` to `setMilliseconds`, `set(d, values)`, `setDay`, `setISODay`, `setDayOfYear`, `setQuarter` | `.with({ ... }, { offset: "ignore" })`, `.add({ days })` | exact for values in range; out of range, and `setYear` from a 29 February: `overflow` |
| `isAfter`, `isBefore`, `isEqual`, `compareAsc`, `compareDesc`, `isWithinInterval` | `Temporal.ZonedDateTime.compare` | exact |
| `isSameDay` to `isSameYear`, `isSameWeek`, `isSameISOWeek`, `isSameQuarter`, `isSameISOWeekYear` | `.toPlainDate().equals(...)`, the fields | exact |
| `isToday`, `isTomorrow`, `isYesterday`, `isThisWeek` to `isThisYear`, `isThisHour` to `isThisSecond`, `isPast`, `isFuture` | `Temporal.Now.plainDateISO()`, `Temporal.Now.zonedDateTimeISO()`, `Temporal.Now.instant()` | exact |
| `isMonday` to `isSunday`, `isWeekend`, `isLeapYear`, `isFirstDayOfMonth`, `isLastDayOfMonth` | `.dayOfWeek`, `.inLeapYear`, `.day` | exact |
| `differenceInMilliseconds`, `differenceInSeconds`, `differenceInMinutes`, `differenceInHours` | epoch milliseconds, divided and rounded as `roundingMethod` says | exact |
| `differenceInCalendarDays` to `differenceInCalendarYears`, `differenceInCalendarWeeks`, `differenceInCalendarISOWeeks`, `differenceInCalendarQuarters`, `differenceInCalendarISOWeekYears` | `.toPlainDate().since(...)`, the fields | exact |
| `differenceInDays`, `differenceInWeeks`, `differenceInMonths`, `differenceInQuarters`, `differenceInYears` | `.since(other, { largestUnit })` | differ at month ends and around DST changes: `date-fns-whole-units` |
| `nextDay`, `previousDay`, `nextMonday` to `nextSunday`, `previousMonday` to `previousSunday` | `.add({ days })`, `.subtract({ days })` | exact |
| `parseISO`, `fromUnixTime`, `toDate` | `Temporal.PlainDate.from`, `Temporal.PlainDateTime.from`, `Temporal.Instant.from`, `Temporal.Instant.fromEpochMilliseconds` | exact for ISO literals; other strings: `iso-grammar` |
| `formatISO`, `formatISO9075`, `formatRFC3339`, `formatRFC7231` | `.toString({ smallestUnit: "second", ... })`, `toUTCString()` | `formatISO9075` exact; `iso-format` (`formatISO`, `formatRFC3339`), `date-fns-years` (`formatRFC3339`, `formatRFC7231`) |
| `format`, `formatDate`, `lightFormat` with `yyyy-MM-dd`, `HH:mm` and a few other fixed patterns | `.toPlainDate()`, `.toPlainTime()` and `.toString(...)` | exact for times; dates differ: `date-fns-years` |

What has no replacement, 81 functions: `date-fns/fp` and its curried functions; the locale-aware
and relative formatters (`formatDistance` and its variants, `formatRelative`, `formatDuration`,
`formatISODuration`, `intlFormat`, `intlFormatDistance`) and `format` with other tokens, for which
`toLocaleString`, `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat` are the native tools;
`parse`, `parseJSON` and `isMatch`, since Temporal reads ISO 8601 only; intervals (`interval`,
`eachDayOfInterval` and the other `each*`, `areIntervalsOverlapping`,
`getOverlappingDaysInIntervals`, `clamp`, `intervalToDuration`) and the array functions (`min`,
`max`, `closestTo`, `closestIndexTo`), which a loop or a reduce over
`Temporal.ZonedDateTime.compare` replaces; business days; `isValid`, `isDate`, `isExists`,
`constructFrom`, `constructNow`, `transpose` and the default options; week numbering with
`weekStartsOn` and `firstWeekContainsDate` (`getWeek`, `getWeekYear`, `getWeekOfMonth`,
`getWeeksInMonth`, `setWeek`, `setWeekYear`, `setISOWeek`, `setISOWeekYear`, `startOfWeekYear`,
`endOfWeekYear`, `lastDayOfWeekYear`), since Temporal knows ISO weeks only; ISO week-year
arithmetic (`addISOWeekYears`, `subISOWeekYears`, `differenceInISOWeekYears`); the unit
conversions (`hoursToMinutes` and the others), plain arithmetic with date-fns's average month and
year; and `roundToNearestHours` and `roundToNearestMinutes`, which round wall-clock fields. The
differences named here are described in the
[documented differences](../../docs/migrate.md#documented-differences) of the tool, and
`npx @momentum-js/migrate rules` prints each with an example; a rewrite that carries one is
applied only with `--accept`.

## How the rules are checked

- Property tests, `packages/migrate/test/migrateDateFns.test.js`, evaluate the text of every exact
  rewrite against date-fns itself, over `Date`'s range and around DST transitions, with
  [fast-check](https://fast-check.dev); "exact" there means the `invalid-throws` of a `Date`
  argument and no other difference. The two date-fns differences are reproduced with an example
  each, and every function date-fns exports has a catalog entry. They run in New York with the
  rest of the suite.
- date-fns's own test suite, the one in `core/src/**/test.ts`: `bun run test:date-fns-suite`
  runs it on vitest against the vendored source, applies the rewrites to a copy of it, file by
  file, with `invalid-throws` accepted, and runs the copy: every test that passed must still pass,
  except the ones that pass an Invalid Date, which now see a throw and are counted apart. The 784
  rewrites in 159 of its 252 files leave 2,961 of 3,148 tests passing in New York and in Auckland,
  from 3,147 before: the 186 others are the Invalid Date tests, and the one failing before is a
  test date-fns skips (`isDate` with a date from another iframe). The rewritten copy runs with
  Temporal from temporal-polyfill, whose `Temporal.Now` follows vitest's fake timers where a test
  freezes the clock, as date-fns does; native `Temporal.Now` would not. Each run is one system
  zone; New York and Auckland by default. Files run isolated, since shared module instances leak
  default options between date-fns's own tests, and each is analysed as a project of its own, with
  date-fns resolved from the repository's `node_modules` so that the suite is not taken for the
  library.
- `bun run sync-date-fns [path]` re-vendors everything from a checkout of date-fns's repository
  (default `../date-fns`): sources, locales, `tz` and `utc` as they are, and the core tests with
  their relative imports of the library (`./index.ts`, `../otherFunction/index.ts`,
  `../types.ts`) turned into the package's entry points (`date-fns`, `date-fns/locale`,
  `date-fns/fp`), which is how a project imports date-fns and how the tool recognizes it; the
  suite's vitest configuration maps them back to the vendored source, and imports of the internal
  `_lib` helpers stay relative. One file stays out, `fp/_lib/convertToFP/test.ts`, which tests an
  internal helper against lodash and fp-ts. The `tz` and `utc` tests are vendored but not run.

## License

date-fns's code and tests are MIT, copyright Sasha Koss and Lesha Koss (core) and Sasha Koss (tz, utc); see `core/LICENSE.md`,
`tz/LICENSE.md` and `utc/LICENSE.md`. What momentum adds here (this page, `scripts/`) is under the
repository's [license](../../LICENSE.md).
