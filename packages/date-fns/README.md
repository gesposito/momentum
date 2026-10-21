# date-fns in momentum

`packages/date-fns` is [date-fns](https://github.com/date-fns/date-fns) 4.4.0 as it is: the
`core` package's `src/` (every function with its tests, the locales, `fp`) and `test/` (its time
zone scripts), `tz/` (`@date-fns/tz` 1.5.0, the `TZDate` class) and `utc/` (`@date-fns/utc`
2.1.1) with their sources and tests, and the three `LICENSE.md` files, byte for byte, with
date-fns's own history merged in underneath (1,678 commits by 371 authors since 2014, tag
`date-fns/cd53d253`), the way Luxon's and Day.js's came in. It is not a port: momentum has no
date-fns-on-Temporal library and plans none. It is the reference the migration tool's date-fns
rules will be checked against.

## What the migration tool rewrites

Nothing yet. date-fns is a library of functions over plain `Date`s (`addDays(date, 1)`,
`startOfDay(date)`, `differenceInHours(a, b)`), 246 of them, with time zones through `TZDate`.
The rules come next: each call becomes a Temporal expression that takes and returns a `Date`
(a `Temporal.ZonedDateTime` in the system zone does the work, like date-fns's own `Date`
arithmetic in local time), proven exact against date-fns itself by property tests, with the
differences documented; self-contained chains become plain Temporal, as for the other libraries.

## How the rules are checked

- date-fns's own test suite, the one in `core/src/**/test.ts`: `bun run test:date-fns-suite`
  runs it on vitest against the vendored source, applies the exact rewrites to a copy of it, file
  by file, and runs the copy: every test that passed must still pass. The rewritten copy runs with
  Temporal from temporal-polyfill, whose `Temporal.Now` follows vitest's fake timers where a test
  freezes the clock, as date-fns does; native `Temporal.Now` would not. Each run is one system zone;
  New York and Auckland by default.
  Today the tool has no date-fns rules, so the two runs are the same: 3,147 of 3,148 tests pass
  before and after in New York and in Auckland; the one left is a test date-fns skips (`isDate`
  with a date from another iframe). Files run isolated, since shared module instances leak
  default options between date-fns's own tests.
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
