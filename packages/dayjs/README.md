# Day.js in momentum

`packages/dayjs` is [Day.js](https://github.com/iamkun/dayjs) 1.11.23 as it is: its `src/`,
`test/`, `types/` and `LICENSE`, byte for byte, with Day.js's own history merged in underneath
(983 commits by 286 authors, tag `dayjs/4549b8d0`), the way Luxon's came in for
`@momentum-js/luxon`. It is not a port: momentum has no Day.js-on-Temporal library and plans none.
It is the reference the migration tool's Day.js rules are checked against, and the subject of a
benchmark of Day.js against the Temporal that replaces it.

## What the migration tool rewrites

`npx @momentum-js/migrate check <project>` finds Day.js uses by their type, in TypeScript and
JavaScript projects, with the utc and timezone plugins. A Day.js value becomes a
`Temporal.ZonedDateTime` in the zone it is read in: the system zone for `dayjs()`, `"UTC"` for
`dayjs.utc()`, the given zone for `dayjs.tz()`. Day.js computes with `Date`'s local-time setters,
which resolve a skipped or repeated wall-clock time like Temporal's `"compatible"` disambiguation,
so setters and the ends of units become `with(fields, { offset: "ignore" })`. When the whole
project switches, the imports of dayjs and its plugins go, with the `dayjs.extend(...)` statements.

| Day.js | Temporal | |
| --- | --- | --- |
| `dayjs()`, `dayjs.utc()` | `Temporal.Now.zonedDateTimeISO()`, to the millisecond | exact |
| `dayjs(isoString)`, `dayjs(ms)`, `dayjs.unix(s)` | `Temporal.PlainDateTime.from(...)`, `Temporal.Instant.from(...)`, `Temporal.Instant.fromEpochMilliseconds(...)` | exact for literals |
| `year()` to `millisecond()`, `get(unit)`, `daysInMonth()` | the fields (`month - 1`, `dayOfWeek % 7`) | exact |
| `date(n)`, `hour(n)` to `millisecond(n)`, `set(unit, n)` | `.with({ ... }, { offset: "ignore" })` | exact in range |
| `year(n)`, `month(n)`, months and years in `add` | `.with(...)`, `.add({ months })` | differ: `dayjs-dst-steps` |
| `add(n, unit)`, `subtract(n, unit)` up to weeks | `.add({ [unit]s: n })` | exact for literals other than 0 |
| `startOf(unit)`, `endOf(unit)` up to years | `.startOfDay()`, `.with(...)` | exact up to days; years and months differ: `dayjs-years` (weeks: none) |
| `isBefore`, `isAfter`, `isSame` | `Temporal.ZonedDateTime.compare` | exact (`isSame` with a unit: none) |
| `diff(other, unit)` up to hours | epoch milliseconds, divided and truncated | exact (days and longer: none) |
| `valueOf()`, `unix()`, `toDate()`, `toISOString()`, `toJSON()`, `toString()`, `clone()` | `.epochMilliseconds`, `new Date(...)`, `.toInstant().toString(...)` | exact |
| `format()` with `HH:mm` and a few other fixed patterns | `.toPlainTime()` or `.toPlainDate()` and `.toString(...)` | exact for times; dates differ: `dayjs-years` |
| `utc()`, `local()`, `isDayjs(x)` | `.withTimeZone(...)`, `x instanceof Temporal.ZonedDateTime` | exact |
| `tz(zone)`, `dayjs.tz(...)`, `dayjs.tz.guess()` | `.withTimeZone(zone)`, `Temporal.Now.timeZoneId()` | timezone plugin: `dayjs-tz` |

What has no replacement: other format tokens, locales, the start of a week, `isSame` with a unit,
`diff` in days and longer units, and what Day.js's other plugins add. In a project that uses the
timezone plugin, values in a zone keep a fixed offset through arithmetic, so its arithmetic carries
`dayjs-zones`. The eight differences named here, most of them Day.js bugs, are described in the
[documented differences](../../docs/migrate.md#documented-differences) of the tool, and
`npx @momentum-js/migrate rules` prints each with an example; a rewrite that carries one is
applied only with `--accept`.

Plugins that patch the methods the tool rewrites count for the whole project. With badMutable
nothing is rewritten, since values become mutable; with preParsePostFormat, parsing and `format`
are left alone, and with advancedFormat, `format` patterns with `S`. devHelper's warnings go with
the calls it watches (`dayjs(...)`, `dayjs.utc(...)`, `dayjs.unix(...)`, `diff`), which carry
`dayjs-plugins`, as does every rewrite in a project that passes `dayjs.extend` a plugin the tool
cannot identify. The other official plugins add inputs, units and tokens that the rewrites leave
alone.

## How the rules are checked

- Property tests, `packages/migrate/test/migrateDayjs.test.js`, evaluate the text of every exact
  rewrite against Day.js itself, over `Date`'s range and around DST transitions, with
  [fast-check](https://fast-check.dev). They run in New York with the rest of the suite, and
  `bun run test:dayjs-zones` repeats them in ten other system zones (Havana, Santiago and Beirut,
  which change at midnight; São Paulo; Lord Howe's half-hour DST; Dublin's negative DST;
  Kathmandu's +05:45; Chatham's +12:45; Sydney; UTC).
- Day.js's own test suite, the one in this directory: `bun run test:dayjs-suite` runs it against
  this source, applies the exact rewrites to a copy of it, file by file since a few files load
  badMutable, which stops every rewrite in a project, and runs the copy: every test that passed
  must still pass. The 227 rewrites in 9 of its 93 files leave 785 of 788 tests passing before and
  after in New York, 784 of 788 in Auckland. The rewritten copy runs with Temporal from
  temporal-polyfill, whose `Temporal.Now` reads `Date.now()` and so follows the clock the suite
  freezes with MockDate, as Day.js does; native `Temporal.Now` would be ahead by the time elapsed.
- `bun run sync-dayjs [path]` re-vendors everything from a Day.js checkout (default `../dayjs`):
  `src/`, `types/` and `LICENSE` as they are, and the tests with their relative imports of the
  source turned into the dayjs package's entry points (`dayjs`, `dayjs/plugin/utc`,
  `dayjs/esm/constant`), which is how a project imports Day.js and how the tool recognizes it;
  `jest.genMockFunction` becomes `jest.fn` and two array-named tests get string names, for
  Jest 29. The Karma spec and a manual mock stay out. The suite runs with Jest mapping those entry
  points back to the source here.

## Day.js against Temporal

Each case times a Day.js call and the Temporal expression the tool rewrites it to, on the
runtime's native Temporal, with [mitata](https://github.com/evanwashere/mitata):
`bun run benchmark:dayjs` and `bun run benchmark:dayjs:node`. Day.js is the published package
with its utc and timezone plugins. Ratios are Day.js's time over Temporal's, so above 1 the
rewrite is faster; measured on an Apple M1 Max.

| Case | Node 26.12 | Bun 1.4.3 |
| --- | --- | --- |
| `dayjs()` | 0.08× | 0.1× |
| `dayjs(ms)` | 0.08× | 0.6× |
| `dayjs("2017-05-15T09:24:15.123Z")` | 0.1× | 0.4× |
| `dayjs("2017-05-15T09:24:15")` | 0.3× | 0.8× |
| `dayjs.utc("2017-05-15T09:24:15.123Z")` | 0.6× | 0.5× |
| `dayjs.tz("2017-05-15 09:24", "Asia/Tokyo")` | 17.9× | 31.6× |
| `dayjs(ms).hour()` | 0.1× | 0.2× |
| `year(), month(), date(), hour()` | 0.2× | 0.01× |
| `hour(3)` | 0.5× | 0.2× |
| `add(1, "day")` | 1.1× | 0.6× |
| `add(1, "month")` | 2.9× | 2.0× |
| `startOf("day")` | 3.3× | 0.4× |
| `endOf("day")` | 0.5× | 0.2× |
| `isBefore(other)` | 2.4× | 12.8× |
| `diff(other, "hour")` | 11.2× | 11.6× |
| `valueOf()` | 0.3× | 0.5× |
| `toISOString()` | 1.0× | 0.7× |
| `format("YYYY-MM-DD")` | 4.9× | 1.9× |
| `format("HH:mm")` | 2.7× | 1.3× |
| `utc()` | 0.7× | 1.2× |
| `tz("Asia/Tokyo")` | 85.3× | 681.5× |
| `tz("Asia/Tokyo").hour()` | 72.5× | 245.9× |

Day.js's core is a thin layer over `Date`, so creating a value and reading its fields take tens
of nanoseconds, where a `Temporal.ZonedDateTime` costs up to a microsecond on Node to construct
and its native getters recompute the wall clock on every read (the engine issue tracked in
[docs/upstream.md](../../docs/upstream.md)). A migration is not a speed-up for `Date`-like
operations in today's engines. It is one for everything that touches a time zone: the timezone
plugin formats through `Intl.DateTimeFormat` on every call, so `tz()` takes 35 to 55 µs against
under half a microsecond, and the same gap applies to `dayjs.tz()` parsing. Comparisons and
differences, month arithmetic and the fixed date formats are faster too.

## License

Day.js's code and tests are MIT, copyright 2018 to the present iamkun; see [LICENSE](LICENSE) in
this directory. What momentum adds here (this page, `scripts/`, `benchmarks/`) is under the
repository's [license](../../LICENSE.md).
