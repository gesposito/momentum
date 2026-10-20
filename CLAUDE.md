# momentum

Luxon-compatible date library (same classes, methods, options and tests as luxon 3.7) built on
Temporal. `packages/luxon/src/impl/temporal.ts` holds the Temporal calls: offsets (`offsetAt`, cached per
transition window discovered with `getTimeZoneTransition("next")` only), wall-clock resolution
(`resolveWallClock`), zone identifiers and the interop helpers. The default DateTime core is
Temporal-native: a valid DateTime is `ts` plus a Temporal zone id (`tz`), its fields and offset
derived lazily from a ZonedDateTime into private fields (accessors `fieldsOf`/`offsetOf`/
`plainDateOf` in `packages/luxon/src/datetime.ts`), calendar math and week fields from `Temporal.PlainDate`.
`Settings.temporalNative = false` (flag in `packages/luxon/src/impl/mode.ts`) switches to luxon's algorithms:
eager fields from the closed-form arithmetic of `packages/luxon/src/impl/calendar.ts`, and luxon's `fixOffset`,
which custom zones always use. Each seam checks `isTemporalNative()`, and both cores must pass
the whole suite. Parsing, formatting, Duration math and Interval algebra are ports of luxon. The
git history starts from a verbatim copy of luxon (a merge with luxon's own history filtered
to src/, test/ and benchmarks/, so `git blame` reaches the original authors; `git log --first-parent`
shows the migration steps) and migrates it one verified step at a time. Day.js's code and test
suite are vendored the same way under `packages/dayjs/` (tag `dayjs/4549b8d0`), as the reference the
migration tool's Day.js rules are checked against. The repository is a Bun workspace:
`packages/luxon` is the library (`@momentum-js/luxon`), `packages/migrate` the migration tool (`@momentum-js/migrate`) and `packages/dayjs` the
vendored Day.js; the root holds the shared tooling (Jest, Babel, the TypeScript base config, the
devDependencies) and its scripts delegate to the packages.

## Commands (Bun for everything)

- `bun install`
- `bun run test` — reference run: luxon's suite on Jest 29 + Node. Node 26 (pinned by `mise.toml`) provides Temporal natively; older Node gets `temporal-polyfill` from `packages/luxon/test/setupTests.js`. `bun run test:polyfill` forces the polyfill. The scripts set TZ=America/New_York, which the tests assume
- `bun run test:opt-out` — the same suite with `Settings.temporalNative = false`: `MOMENTUM_TEMPORAL_NATIVE=false`, read by `packages/luxon/test/setupTests.js`, also works for `bun run test:bun` and the benchmarks
- `bun run test:bun` — `scripts/test-bun.ts`: the same suite on `bun test` with Bun's native Temporal, compared against `packages/luxon/test/bun-known-failures.txt` (engine-specific failures: 22 on macOS, where Bun uses Apple's ICU, 3 on Linux; see docs/bun-compatibility.md); fails only on new failures. `MOMENTUM_TEMPORAL=polyfill bun test` forces the polyfill.
- `bun run test:dayjs-zones [zone...]` — `packages/migrate/scripts/test-dayjs-zones.ts`: the "agree with Day.js" properties of `packages/migrate/test/migrateDayjs.test.js`, one Jest run per system zone (ten zones with unusual DST rules by default), since Day.js's local values follow the system zone and the suite runs in New York only
- `bun run test:dayjs-suite [zone...]` — `packages/migrate/scripts/test-dayjs-suite.ts`: Day.js's own suite (`packages/dayjs/test`) against the vendored source, before and after the tool's exact rewrites applied file by file (one project per file, since badMutable stops every rewrite in a project); the rewritten copy (`packages/dayjs/.rewritten`, ignored) runs on temporal-polyfill, whose `Temporal.Now` follows the suite's MockDate clock. New York and Auckland by default
- `bun run typecheck` — type check of both packages (`bun check -p packages/luxon`, `src` only, and `bun check -p packages/migrate`)
- `bun run build` — both packages: `packages/luxon/scripts/build.ts` (Bun.build, ESM, `temporal-polyfill` external) + `tsc -p tsconfig.build.json` for `build/types`, then `packages/migrate/scripts/build.ts`; `build:luxon` and `build:migrate` take one
- `bun run benchmark` / `benchmark:compare` / `benchmark:node` / `benchmark:memory` / `benchmark:memory:node` — mitata port of luxon's benchmarks against the built bundle (they build first), optionally against luxon, on Bun or Node; retained memory and bundle size
- `bun run sync-tests [path]` — re-vendor luxon's tests (default `../luxon`); applies the rewrites documented at the top of `packages/luxon/scripts/sync-tests.ts`
- `bun run sync-dayjs [path]` — re-vendor Day.js's `src/`, `types/`, `LICENSE` and tests into `packages/dayjs/` (default `../dayjs`); applies the rewrites documented at the top of `packages/dayjs/scripts/sync.ts`
- `bun run migrate check|apply|rules [project]` — `packages/migrate/`: the migration tool from momentum, Luxon or Day.js to native Temporal (docs/migrate.md). TypeScript 7.0's async compiler API (`typescript/unstable/async`, works under Bun; 7.1 moves it, so both package.json files ask for `~7.0.2`) finds uses by type; `packages/migrate/src/rules.ts` is the catalog of replacements, `packages/migrate/src/differences.ts` the documented differences. Published as `@momentum-js/migrate` (command `momentum-migrate`): `packages/migrate/src/bin.ts` bundled for Node by `packages/migrate/packages/luxon/scripts/build.ts` (`bun run build:migrate`), versioned in lockstep with the library; a release publishes both (`npm publish` in `packages/luxon` and in `packages/migrate`)

## Conventions

- TypeScript source in `packages/luxon/src/`, ESM only, relative imports use the `.js` extension (Jest maps them back via `moduleNameMapper`).
- No import-time side effects: caches are module-level `Map`s marked `/* @__PURE__ */`, Temporal is read lazily from `globalThis` in `impl/temporal.ts`. Only `packages/luxon/src/polyfill.ts` is side-effectful and is listed in `package.json` `sideEffects`.
- Temporal reports unrepresentable values with `RangeError`; swallow those (invalid DateTime) and rethrow anything else (`isRangeError`).
- `packages/luxon/test/` is vendored from luxon except `packages/luxon/test/setupTests.js`, `packages/luxon/test/bun-known-failures.txt`, `packages/luxon/test/parity/*` and `packages/luxon/test/momentum/*`. Don't hand-edit vendored files; change `packages/luxon/scripts/sync-tests.ts` instead.
- `packages/dayjs/` is vendored from Day.js 1.11.23 (`bun run sync-dayjs`): `src/`, `types/` and `LICENSE` verbatim, `packages/luxon/test/` with its imports pointed at the dayjs package's entry points. Don't hand-edit it either; change `packages/dayjs/scripts/sync.ts`. The `moment`, `moment-timezone` and `mockdate` devDependencies serve its tests only, pinned to the versions its lockfile resolves.
- New tests go in `packages/luxon/test/parity/` when they pin luxon behaviour that luxon's own suite doesn't check (take every expectation from luxon 3.7.2, the `luxon` devDependency), and in `packages/luxon/test/momentum/` when they cover what momentum adds (Temporal interop, polyfill entry, offset cache, the two cores, API-surface snapshot). Tests written for one core set `Settings.temporalNative` themselves (`temporalCore.test.js`, `parity/dstResolution.test.js`); `optOut.test.js` holds the properties that the cores agree.
- Randomized tests are fast-check properties built on `packages/luxon/test/momentum/fastCheck.js` (shared configuration and generators: instants, wall clocks near transitions); never `Math.random`. `FC_NUM_RUNS=20000` fuzzes longer; a failure prints `{ seed, path }`, replayed with `FC_SEED`/`FC_PATH`.
- A workaround for an upstream bug links its issue in a comment and has a row in `docs/upstream.md` saying what to delete when the fix ships; remove both together.
- The migration catalog (`packages/migrate/src/rules.ts`, with Day.js's part in `packages/migrate/src/dayjs.ts`) describes the default core. A rewrite without differences must be exact: add a property test that evaluates its text against the library, in `packages/migrate/test/migrateRules.test.js` for momentum and `packages/migrate/test/migrateDayjs.test.js` for Day.js (the `dayjs` devDependency). A new difference needs a reproducing example there too, and every public DateTime and Duration member, and every Dayjs method, needs an entry (coverage tests check it). Fixture projects for the CLI live in `packages/migrate/test/fixtures/migrate` with reviewed outputs in `expected/`.
- Adding or removing a public member requires updating the API snapshot deliberately (`bunx jest packages/luxon/test/momentum/apiSurface.test.js -u`).
- Public JSDoc comes from luxon; keep it when touching public methods, it ends up in the `.d.ts` files.
- Three READMEs: the root `README.md` is the project's page (packages, approach, development); `packages/luxon/README.md` is the library's, committed and shipped to npm as is (install, API, differences, measurements; absolute links, since npm renders it); `packages/migrate/README.md` is a copy of `docs/migrate.md` made at build time and ignored by git.
