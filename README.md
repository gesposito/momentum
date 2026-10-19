# momentum

Luxon's API, running on [Temporal](https://tc39.es/proposal-temporal/).

```js
import { DateTime } from "momentum";

DateTime.now().setZone("America/New_York").minus({ weeks: 1 }).endOf("day").toISO();
```

momentum exposes the same `DateTime`, `Duration`, `Interval`, `Info`, `Settings` and `Zone`
classes as [Luxon](https://moment.github.io/luxon) 3.7, with the same methods, options, parsing
tokens, formatting tokens and validity semantics. It is verified against Luxon's own test suite
(1,200+ tests, vendored with only mechanical rewrites), an API-surface snapshot generated from
Luxon's code, and parity tests for Luxon behaviour that its suite leaves unchecked.

Under the hood, Temporal does the work Luxon built on `Date` and `Intl.DateTimeFormat` tricks. A
DateTime is an instant in a Temporal time zone: its calendar fields are read from a
`Temporal.ZonedDateTime` when first needed, wall-clock times are resolved by Temporal's
disambiguation, calendar arithmetic and week numbers come from `Temporal.PlainDate`, and offsets
are cached per transition window, so repeated zone lookups cost nothing. Reading fields through
Temporal objects is still slow in today's engines, so `Settings.temporalNative = false` opts out
to Luxon's own algorithms, fed with the same Temporal offsets (see
[Opting out](#opting-out-of-the-temporal-native-core)).

The git history tells the story step by step: it starts from a verbatim copy of Luxon and every
commit is a small, test-verified refactor. Luxon's own history is merged in underneath the
vendored copy, so `git blame` points at the original authors, and `git log --first-parent` lists the
migration steps.

## Install

```sh
bun add momentum
```

Temporal is available natively in Node.js 26 (enabled by default since 26.0.0; builds against the
system ICU, such as Homebrew's, gained it in 26.12.0), in Bun and in recent browsers. On older
runtimes install the polyfill and import the `momentum/polyfill` entry point, which installs
`temporal-polyfill` on the global object and re-exports the library:

```sh
bun add temporal-polyfill
```

```js
import { DateTime } from "momentum/polyfill";
```

Using `momentum` without a `Temporal` global throws a `TemporalUnavailableError` on first use. The
error class is exported, so it can be caught by type.

## What is the same

Everything you know from Luxon, including:

- creation: `DateTime.now()`, `local()`, `utc()`, `fromObject()`, `fromISO()`, `fromFormat()`,
  `fromSQL()`, `fromRFC2822()`, `fromHTTP()`, `fromMillis()`, `fromJSDate()`
- transformation: `plus()`, `minus()`, `set()`, `startOf()`, `endOf()`, `setZone()`, `reconfigure()`
- output: `toISO()`, `toFormat()`, `toLocaleString()`, `toRelative()`, `toHuman()`, presets like `DateTime.DATETIME_FULL`
- `Duration` with Luxon's casual/longterm conversion matrices, `Interval` algebra, `Info` listers
- validity (`isValid`, `invalidReason`, `Settings.throwOnInvalid`), `Settings.defaultZone`,
  custom `Zone` implementations, and Luxon's rules for DST gaps and overlaps: a skipped time moves
  forward, an ambiguous one keeps the offset it is guessed to have

Types are generated from the source, so there is no separate `@types` package to install.

## What Temporal adds

A few extra methods bridge the two worlds. With `TemporalUnavailableError` and
`Settings.temporalNative`, they are the only additions to Luxon's API:

| Method | Returns |
| --- | --- |
| `DateTime.fromZonedDateTime(zdt, opts?)` | a `DateTime` in the same zone (IANA or offset) |
| `DateTime.fromInstant(instant, opts?)` | a `DateTime` in the default or given zone |
| `dt.toZonedDateTime()` | `Temporal.ZonedDateTime` |
| `dt.toInstant()` | `Temporal.Instant` |
| `dt.toPlainDateTime()`, `dt.toPlainDate()`, `dt.toPlainTime()` | the wall-clock parts |

The conversions return null for an invalid DateTime. `toZonedDateTime()` also returns null when
Temporal has no matching time zone: its offset time zones are whole minutes under a day, so a
custom zone with a sub-minute offset, or a fixed offset of a day or more, has no counterpart.

Zone identifiers follow Temporal's rules: casing is normalized but link names are preserved
(`IANAZone.normalizeZone("Asia/Calcutta")` stays `"Asia/Calcutta"`), with aliases of UTC such as
`Etc/GMT` resolving to `"UTC"` as before. Historical offsets keep their sub-minute precision, so a
date in 1800 Rome has an offset of 49.93 minutes, just like Luxon reports from Intl data.

## Known differences

A few corner cases behave differently from Luxon:

- Luxon resolves a wall-clock time with a two-step search from a guessed offset, which goes wrong
  where the guess is far from the offsets around a transition. Seen from today, it reports
  existing times as skipped, such as 02:30 on 1979-10-01 in Kiritimati or 01:30 on 2010-09-26 in
  Samoa, and it can take the later instant of an ambiguous time. Temporal's disambiguation gets
  these right; `Settings.temporalNative = false` reproduces Luxon's answers.
- On Node.js, a POSIX `TZ` value such as `GMT+3` means three hours behind UTC to `Date` but three
  hours ahead to `Intl` and Temporal. Luxon names the zone `+03:00` yet computes with `Date`'s
  UTC−3; momentum computes with UTC+3, matching the name.
- Luxon accepts a fixed-offset DateTime whose instant lies just past `Date`'s range (±8.64e15 ms)
  while its local time does not, such as `275760-09-12T23:00` at UTC−2. momentum needs the instant
  itself to be in range, because Temporal's range ends at the same instant.

## Moving on to native Temporal

momentum is meant to be temporary. `bun run migrate check <project>` finds every use of momentum
(or Luxon) with TypeScript's type checker and reports whether the rewrites with a native Temporal
replacement complete the switch, listing what is left when they don't; `bun run migrate apply`
writes them. Rewrites are applied by default only when they are exact, proven against momentum by
property tests; those that differ in documented corner cases wait for `--accept`. See
[docs/migrate.md](docs/migrate.md).

## Opting out of the Temporal-native core

```js
import { Settings } from "momentum";

Settings.temporalNative = false;
```

Every later computation then uses Luxon's own algorithms, fed with the same Temporal offsets:
calendar fields computed up front with closed-form arithmetic, and wall-clock times resolved with
Luxon's offset search. DateTimes created earlier keep their values. Both cores pass the whole
test suite, and property tests check that they agree everywhere but in the DST cases above. The
opt-out trades Temporal's disambiguation for speed on today's engines, as the table below shows.
The Temporal-native core is where momentum is heading; the opt-out can go once engines make
Temporal's field reads cheap.

## Performance and footprint

Measured with Luxon's own benchmark cases, plus three that read the fields of a fresh DateTime,
against the built bundle (`bun run benchmark:node`, `bun run benchmark:compare`,
`bun run benchmark:memory`), each runtime with its native Temporal. Ratios are Luxon's time over
momentum's, so higher is faster; "opt-out" is `Settings.temporalNative = false`.

| Case | Node 26.12 | Node, opt-out | Bun 1.4.3 | Bun, opt-out |
| --- | --- | --- | --- | --- |
| `DateTime.now()` | 2.4× | 1.2× | 1.7× | 0.8× |
| `DateTime.local(y, m, d)` | 0.6× | 1.6× | 0.3× | 0.8× |
| `DateTime.fromObject({}, { locale })` | 0.3× | 1.1× | 0.2× | 0.7× |
| `DateTime.fromISO`, `fromSQL`, `fromFormat` | 0.7–0.8× | 1.0–1.2× | 0.6–0.9× | 0.9–1.0× |
| `DateTime.local(..., { zone })` | 3.5× | 11.0× | 3.3× | 9.0× |
| `DateTime.fromFormatParser(..., { zone })` | 3.0× | 4.7× | 2.6× | 4.0× |
| `DateTime#setZone` | 44.9× | 20.4× | 28.8× | 14.3× |
| `DateTime#setZone().hour` | 3.7× | 21.6× | 4.3× | 13.8× |
| `DateTime.now().toISO()` | 0.4× | 1.1× | 0.35× | 0.8× |
| `plus`, `toISO`, `toLocaleString`, `toRelativeCalendar`, `Info.*` | 0.7–1.3× | 1.0–1.2× | 0.7–1.3× | 0.7–1.1× |

The Temporal-native core derives fields only when they are read, so creating a DateTime from an
instant or moving it to another zone costs well under a microsecond. Anything with an explicit
IANA zone beats Luxon in both cores, because Temporal answers offset queries directly instead of
through `Intl.DateTimeFormat`. Building a DateTime from wall-clock fields, and reading the fields
of a fresh one, cost more than in Luxon: about two thirds of that time is spent in the engines'
own `Temporal.PlainDateTime` and `Temporal.ZonedDateTime` constructors and field getters, which
the opt-out avoids. On temporal-polyfill the gap is wider: creating a DateTime from numbers and
reading a few fields takes about 10 µs with the Temporal-native core and under 1 µs with the
opt-out, which the transition-window cache keeps within a few percent of native. Runtimes that
need the polyfill are better served by the opt-out.

Memory: until its fields are read, a DateTime retains about 610 bytes with the Temporal-native
core; with the opt-out it retains about 700, like Luxon's 680–690. After touching 100 zones,
momentum's offset windows retain 13–100 kB, where Luxon's per-zone `Intl.DateTimeFormat` cache
costs 5.9 MB of ICU memory on Bun and 5.3 MB of resident memory on Node. The minified bundle,
with both cores, is 82.5 kB (25.9 kB gzipped) against Luxon's 79.8 kB (24.1 kB gzipped).

## Package shape

- ESM only, `"sideEffects"` declared so bundlers can drop unused modules; the main entry never
  touches globals, only `momentum/polyfill` does.
- `build/momentum.js` (readable), `build/momentum.min.js` (minified) and `build/types/*.d.ts`.
- Node.js 20+, Bun 1.1+, evergreen browsers.

## Development

Everything runs through Bun:

```sh
bun install
bun run test            # Luxon's suite on Jest; Node's native Temporal, or temporal-polyfill on older Node
bun run test:polyfill   # the same suite with the polyfill forced
bun run test:opt-out    # the same suite with Settings.temporalNative = false
bun run test:bun        # the same suite on bun test, on Bun's native Temporal
bun check               # type check
bun run build           # bundles + declarations
bun run benchmark       # Luxon's benchmark cases, ported to mitata (Bun)
bun run benchmark:compare   # side by side with luxon (Bun)
bun run benchmark:node      # side by side with luxon, on Node
bun run benchmark:memory    # retained memory and bundle size, side by side with luxon (Bun)
bun run benchmark:memory:node
bun run sync-tests      # re-vendor the tests from a luxon checkout (default ../luxon)
bun run migrate check <project>   # how far a project is from native Temporal (docs/migrate.md)
```

The tests come in three groups. Luxon's suite fills `test/`; `bun run sync-tests` vendors it and
it is never edited by hand. `test/parity/` checks Luxon behaviour that its suite does not cover,
with every expectation taken from Luxon 3.7.2. `test/momentum/` covers what momentum adds: the
Temporal interop, the polyfill entry point, the offset cache, the two cores and the API-surface
snapshot. `MOMENTUM_TEMPORAL_NATIVE=false` runs any of the test and benchmark scripts with the
opt-out; tests written for one core set it themselves.

Randomized checks are [fast-check](https://fast-check.dev) properties, so a failure shrinks to a
minimal counterexample and prints the seed and path that replay it. Each property runs 100 times
by default; `FC_NUM_RUNS` raises that for a longer fuzzing session, and `FC_SEED` with `FC_PATH`
replays a reported failure:

```sh
FC_NUM_RUNS=20000 bun run jest test/momentum
FC_SEED=-1819918769 FC_PATH="12:3" bun run jest -t "name of the test"
```

`mise.toml` pins Node 26 and Bun 1.4, so with [mise](https://mise.jdx.dev) the tests run on Node's
native Temporal. `bun run test` is the reference run. `bun run test:bun` compares its failures with
`test/bun-known-failures.txt`, the tests that fail only because of Bun's engine: three on every
platform (JavaScriptCore puts plain spaces in date ranges, and Bun's snapshots do not call
`toJSON()`) and nineteen more on macOS, where Bun uses Apple's ICU (Latin digits for `bn`, " at "
between date and time, among others); see [docs/bun-compatibility.md](docs/bun-compatibility.md).

momentum works around a few upstream bugs in Temporal polyfills, engines and Bun.
[docs/upstream.md](docs/upstream.md) lists each one with its issue and the code its fix lets us
delete.

`scripts/sync-tests.ts` copies Luxon's `test/` directory, rewrites the import paths, turns the
CommonJS helper module into an ES module, and compares strings containing U+202F with Luxon's
own whitespace-tolerant matcher, because Node 26 and Bun replace the U+202F that CLDR puts
between a time and its AM/PM marker with a regular space. The repository has no formatter
configured: Bun's `bun fmt` is not part of a released version yet.

## License

MIT. The API, documentation comments, parsers, formatters and tests derive from Luxon; see
[LICENSE.md](LICENSE.md).
