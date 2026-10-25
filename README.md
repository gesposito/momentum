# momentum

Date libraries' APIs on [Temporal](https://tc39.es/proposal-temporal/), and a way off them.

Temporal is in Node.js 26, Bun and recent browsers, but the code that handles dates in most
projects still speaks Luxon, Day.js or date-fns. momentum is a bridge: `@momentum-js/luxon` keeps Luxon code
working with Temporal doing the work underneath, and `@momentum-js/migrate` tells a project how
far it is from plain Temporal and rewrites what already has an exact native replacement. The
bridge is meant to be temporary, and its tooling is built to take it down.

| Package | What it is |
| --- | --- |
| [`@momentum-js/luxon`](packages/luxon/README.md) | Luxon 3.7's `DateTime`, `Duration`, `Interval`, `Info`, `Settings` and zones, with the same methods, options, parsing and formatting, on native Temporal or on temporal-polyfill; verified by Luxon's own test suite |
| [`@momentum-js/migrate`](docs/migrate.md) | `npx @momentum-js/migrate check <project>` finds every Luxon, momentum, Day.js or date-fns use with TypeScript's type checker and reports whether the exact rewrites complete the switch to native Temporal; `apply` writes them |
| [Day.js](packages/dayjs/README.md) | Day.js 1.11.23's code and test suite, vendored with Day.js's history: the reference the migration tool's Day.js rules are checked against, and a benchmark of Day.js against the Temporal that replaces it |
| [date-fns](packages/date-fns/README.md) | date-fns 4.4.0 with `@date-fns/tz` and `@date-fns/utc`, vendored with its history: the reference the migration tool's date-fns rules are checked against |

```sh
bun add @momentum-js/luxon            # Luxon's API on Temporal
npx @momentum-js/migrate check .      # how far this project is from plain Temporal
```

```js
import { DateTime } from "@momentum-js/luxon";

DateTime.now().setZone("America/New_York").minus({ weeks: 1 }).endOf("day").toISO();
```

## How it is built

**Vendored and verified upstream.** The library started as a verbatim copy of Luxon 3.7.2, with
Luxon's own history (736 commits) merged in underneath, so `git blame` reaches the original
authors and `git log --first-parent` lists the migration steps, each a small refactor verified by
Luxon's suite, which fills `packages/luxon/test/`, is re-vendored by a script and is never edited
by hand. Day.js's code and suite came in the same way (983 commits, tag `dayjs/4549b8d0`), and so
did date-fns's (1,678 commits, tag `date-fns/cd53d253`), for the migration tool, which is checked
by running each library's suite before and after its rewrites.

**Temporal underneath.** A DateTime is an instant in a Temporal time zone. Its calendar fields are
read from a `Temporal.ZonedDateTime` when first needed, wall-clock times are resolved by
Temporal's disambiguation, calendar arithmetic and week numbers come from `Temporal.PlainDate`,
and offsets are cached per transition window. Reading fields through Temporal objects is still
slow in today's engines, so `Settings.temporalNative = false` switches to Luxon's own algorithms
fed with the same Temporal offsets; both cores pass the whole suite, and property tests check
that they agree. The [library's README](packages/luxon/README.md) has the details, the known
differences and the measurements.

**Exact or explicit.** The migration tool applies a rewrite by default only when property tests
prove it exact against the library, and Day.js's and date-fns's own suites confirm theirs; rewrites
that differ in documented corner cases wait for `--accept`, and uses with no native replacement
are reported as what keeps a library in the project. [docs/migrate.md](docs/migrate.md) describes
the catalog and the differences.

**Upstream first.** Every workaround for an engine, polyfill or Bun bug links its issue in the
code, and [docs/upstream.md](docs/upstream.md) lists what each one costs and what to delete once
the fix ships. The slow native field getters are reported to V8 and JavaScriptCore. The goal is
for all of this, and eventually momentum itself, to go away.

## Development

The repository is a Bun workspace: the library in `packages/luxon`, the migration tool in
`packages/migrate`, Day.js's code and test suite in `packages/dayjs`, date-fns's in
`packages/date-fns`. The root holds the shared
tooling, and everything runs through Bun from there:

```sh
bun install
bun run test            # Luxon's suite on Jest; Node's native Temporal, or temporal-polyfill on older Node
bun run test:polyfill   # the same suite with the polyfill forced
bun run test:opt-out    # the same suite with Settings.temporalNative = false
bun run test:bun        # the same suite on bun test, on Bun's native Temporal
bun run typecheck       # type check of both packages
bun fmt                 # format the code (bun fmt --check: fail if a file needs formatting)
bun run build           # bundles + declarations
bun run benchmark       # Luxon's benchmark cases, ported to mitata (Bun)
bun run benchmark:compare   # side by side with luxon (Bun)
bun run benchmark:node      # side by side with luxon, on Node
bun run benchmark:memory    # retained memory and bundle size, side by side with luxon (Bun)
bun run benchmark:memory:node
bun run sync-tests      # re-vendor the tests from a luxon checkout (default ../luxon)
bun run test:dayjs-suite    # Day.js's own suite, before and after the migration tool's rewrites
bun run sync-dayjs      # re-vendor Day.js's code and tests from a checkout (default ../dayjs)
bun run test:date-fns-suite # date-fns's own suite, before and after the rewrites
bun run sync-date-fns   # re-vendor date-fns's code and tests from a checkout (default ../date-fns)
bun run migrate check <project>   # how far a project is from native Temporal (docs/migrate.md)
```

The tests come in three groups, plus Day.js's and date-fns's. Luxon's suite fills `packages/luxon/test/`;
`bun run sync-tests` vendors it from a Luxon checkout and it is never edited by hand.
`packages/luxon/test/parity/` checks Luxon behaviour that its suite does not cover, with every
expectation taken from Luxon 3.7.2. `packages/luxon/test/momentum/` covers what the library adds:
the Temporal interop, the polyfill entry point, the offset cache, the two cores and the API-surface
snapshot. The migration tool's tests live in `packages/migrate/test/`: property tests of every
exact rewrite against the library, Day.js and date-fns, a reproduction of each documented
difference, and fixture projects run through the CLI. Day.js's own suite sits in
`packages/dayjs/test`, with Day.js's source, for `bun run test:dayjs-suite`, and date-fns's in
`packages/date-fns/core/src`, with its source, for `bun run test:date-fns-suite`.
`MOMENTUM_TEMPORAL_NATIVE=false` runs any of the test and benchmark scripts with the opt-out;
tests written for one core set it themselves.

Randomized checks are [fast-check](https://fast-check.dev) properties, so a failure shrinks to a
minimal counterexample and prints the seed and path that replay it. Each property runs 100 times
by default; `FC_NUM_RUNS` raises that for a longer fuzzing session, and `FC_SEED` with `FC_PATH`
replays a reported failure:

```sh
FC_NUM_RUNS=20000 bun run jest packages/luxon/test/momentum
FC_SEED=-1819918769 FC_PATH="12:3" bun run jest -t "name of the test"
```

`mise.toml` pins Node 26 and Bun 1.4.4, so with [mise](https://mise.jdx.dev) the tests run on Node's
native Temporal. `bun run test` is the reference run. `bun run test:bun` compares its failures with
`packages/luxon/test/bun-known-failures.txt`, the tests that fail only because of Bun's engine:
three on every platform (JavaScriptCore puts plain spaces in date ranges, and Bun's snapshots do
not call `toJSON()`) and twenty-one more on macOS, where Bun uses Apple's ICU (Latin digits for
`bn`, " at " between date and time, among others) and, since Bun 1.4.4, rejects the POSIX-style US
zone names such as `PST8PDT`; see
[docs/bun-compatibility.md](docs/bun-compatibility.md).

momentum works around a few upstream bugs in Temporal polyfills, engines and Bun.
[docs/upstream.md](docs/upstream.md) lists each one with its issue and the code its fix lets us
delete.

`packages/luxon/scripts/sync-tests.ts` copies Luxon's `test/` directory into
`packages/luxon/test/`, rewrites the import paths, turns the CommonJS helper module into an ES
module, and compares strings containing U+202F with Luxon's own whitespace-tolerant matcher,
because Node 26 and Bun replace the U+202F that CLDR puts between a time and its AM/PM marker
with a regular space. `packages/dayjs/scripts/sync.ts` does the same for Day.js, pointing its
tests' imports at the dayjs package's entry points, and `packages/date-fns/scripts/sync.ts` for
date-fns.

The code is formatted with `bun fmt`, Bun's Prettier-compatible formatter, with the options in
the `[fmt]` section of `bunfig.toml`: lines of 100 columns and trailing commas where ES5 allows
them, the style Luxon's code came with. It leaves out the vendored code, which stays as its
authors wrote it, the migration tool's fixture projects, which its tests compare byte for byte,
and Markdown, which is wrapped by hand. `bun fmt --check` fails when a file needs formatting, and
`bun fmt --staged` formats just the files about to be committed. The root `tsconfig.json` only
references the two packages, so `bun check` at the root type-checks both, like `tsc -b`.

## License

MIT, see [LICENSE.md](LICENSE.md).

- `@momentum-js/luxon`: the API, documentation comments, parsers, formatters and tests derive from
  [Luxon](https://github.com/moment/luxon), MIT, JS Foundation and other contributors.
- `packages/dayjs`: Day.js's code and tests under Day.js's own MIT license,
  [packages/dayjs/LICENSE](packages/dayjs/LICENSE).
- `packages/date-fns`: date-fns's code and tests under date-fns's own MIT licenses,
  [packages/date-fns/core/LICENSE.md](packages/date-fns/core/LICENSE.md), `tz/LICENSE.md` and
  `utc/LICENSE.md`.
