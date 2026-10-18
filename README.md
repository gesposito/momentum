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
Luxon's code, and parity tests for Luxon behaviour that its suite leaves unchecked. Under the
hood, the time zone machinery Luxon built on `Date` and
`Intl.DateTimeFormat` tricks is replaced by Temporal: UTC offsets, DST transitions and zone
identifiers come from `Temporal.ZonedDateTime`, with a transition-window cache so repeated
lookups cost nothing. Pure Gregorian calendar arithmetic uses closed-form algorithms, because
materializing Temporal objects for every field read is slow in today's engines.

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
  custom `Zone` implementations, DST gap and overlap resolution (Luxon's own algorithm, fed by
  Temporal offsets)

Types are generated from the source, so there is no separate `@types` package to install.

## What Temporal adds

A few extra methods bridge the two worlds; with `TemporalUnavailableError`, they are the only
additions to Luxon's API:

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

Two corner cases behave differently from Luxon:

- On Node.js, a POSIX `TZ` value such as `GMT+3` means three hours behind UTC to `Date` but three
  hours ahead to `Intl` and Temporal. Luxon names the zone `+03:00` yet computes with `Date`'s
  UTC−3; momentum computes with UTC+3, matching the name.
- Luxon accepts a fixed-offset DateTime whose instant lies just past `Date`'s range (±8.64e15 ms)
  while its local time does not, such as `275760-09-12T23:00` at UTC−2. momentum needs the instant
  itself to be in range, because Temporal's range ends at the same instant.

## Performance and footprint

Measured with Luxon's own benchmark cases against the built bundle (`bun run benchmark:node`,
`bun run benchmark:compare`, `bun run benchmark:memory`), each runtime with its native Temporal:

| Case (ratio to Luxon, higher is faster) | Node 26.12 | Bun 1.4.3 |
| --- | --- | --- |
| `DateTime.now()` | 1.4× | 0.85× |
| `DateTime.local(y, m, d)` | 1.6× | 0.7× |
| `DateTime.fromISO`, `fromSQL`, `fromFormat` | 1.0–1.2× | 0.8–0.9× |
| `DateTime.local(..., { zone })` | 10.9× | 9.8× |
| `DateTime.fromFormatParser(..., { zone })` | 4.5× | 4.0× |
| `DateTime#setZone` | 21.7× | 15.4× |
| `DateTime#plus`, `toISO`, `toLocaleString`, `toRelativeCalendar`, `Info.*` | 1.0–1.2× | 1.0–1.2× |

Anything involving an explicit IANA zone is much faster because Temporal answers offset queries
directly instead of through `Intl.DateTimeFormat`. On Node with `temporal-polyfill` forced, the
numbers are within a few percent of native, since the transition-window cache keeps the polyfill
out of the hot paths.

Memory: instances have the same shape and retain the same memory as Luxon's (about 690 bytes per
`DateTime`). After touching 100 zones, momentum's offset windows retain 20–90 kB where Luxon's
per-zone `Intl.DateTimeFormat` cache costs 6 MB of ICU memory on Bun and 16 MB of resident memory
on Node. Minified bundles are the same size: 77.7 kB (24.2 kB gzipped) against Luxon's 79.8 kB
(24.1 kB gzipped).

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
bun run test:bun        # the same suite on bun test, on Bun's native Temporal
bun check               # type check
bun run build           # bundles + declarations
bun run benchmark       # Luxon's benchmark cases, ported to mitata (Bun)
bun run benchmark:compare   # side by side with luxon (Bun)
bun run benchmark:node      # side by side with luxon, on Node
bun run benchmark:memory    # retained memory and bundle size, side by side with luxon (Bun)
bun run benchmark:memory:node
bun run sync-tests      # re-vendor the tests from a luxon checkout (default ../luxon)
```

The tests come in three groups. Luxon's suite fills `test/`; `bun run sync-tests` vendors it and
it is never edited by hand. `test/parity/` checks Luxon behaviour that its suite does not cover,
with every expectation taken from Luxon 3.7.2. `test/momentum/` covers what momentum adds: the
Temporal interop, the polyfill entry point, the offset cache and the API-surface snapshot.

`mise.toml` pins Node 26 and Bun 1.4, so with [mise](https://mise.jdx.dev) the tests run on Node's
native Temporal. `bun run test` is the reference run. Under `bun run test:bun`, three tests fail
on every platform only because of Bun's engine (JavaScriptCore puts plain spaces in date ranges,
and Bun's snapshots do not call `toJSON()`), and nineteen more on macOS, where Bun uses Apple's
ICU (Latin digits for `bn`, " at " between date and time, among others); see
[docs/bun-compatibility.md](docs/bun-compatibility.md).

`scripts/sync-tests.ts` copies Luxon's `test/` directory, rewrites the import paths, turns the
CommonJS helper module into an ES module, and compares strings containing U+202F with Luxon's
own whitespace-tolerant matcher, because Node 26 and Bun replace the U+202F that CLDR puts
between a time and its AM/PM marker with a regular space. The repository has no formatter
configured: Bun's `bun fmt` is not part of a released version yet.

## License

MIT. The API, documentation comments, parsers, formatters and tests derive from Luxon; see
[LICENSE.md](LICENSE.md).
