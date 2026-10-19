# momentum

Luxon-compatible date library (same classes, methods, options and tests as luxon 3.7) built on
Temporal. `src/impl/temporal.ts` holds the Temporal calls: offsets (`offsetAt`, cached per
transition window discovered with `getTimeZoneTransition("next")` only), wall-clock resolution
(`resolveWallClock`), zone identifiers and the interop helpers. The default DateTime core is
Temporal-native: a valid DateTime is `ts` plus a Temporal zone id (`tz`), its fields and offset
derived lazily from a ZonedDateTime into private fields (accessors `fieldsOf`/`offsetOf`/
`plainDateOf` in `src/datetime.ts`), calendar math and week fields from `Temporal.PlainDate`.
`Settings.temporalNative = false` (flag in `src/impl/mode.ts`) switches to luxon's algorithms:
eager fields from the closed-form arithmetic of `src/impl/calendar.ts`, and luxon's `fixOffset`,
which custom zones always use. Each seam checks `isTemporalNative()`, and both cores must pass
the whole suite. Parsing, formatting, Duration math and Interval algebra are ports of luxon. The
git history starts from a verbatim copy of luxon (a merge with luxon's own history filtered
to src/, test/ and benchmarks/, so `git blame` reaches the original authors; `git log --first-parent`
shows the migration steps) and migrates it one verified step at a time.

## Commands (Bun for everything)

- `bun install`
- `bun run test` — reference run: luxon's suite on Jest 29 + Node. Node 26 (pinned by `mise.toml`) provides Temporal natively; older Node gets `temporal-polyfill` from `test/setupTests.js`. `bun run test:polyfill` forces the polyfill. The scripts set TZ=America/New_York, which the tests assume
- `bun run test:opt-out` — the same suite with `Settings.temporalNative = false`: `MOMENTUM_TEMPORAL_NATIVE=false`, read by `test/setupTests.js`, also works for `bun run test:bun` and the benchmarks
- `bun run test:bun` — `scripts/test-bun.ts`: the same suite on `bun test` with Bun's native Temporal, compared against `test/bun-known-failures.txt` (engine-specific failures: 22 on macOS, where Bun uses Apple's ICU, 3 on Linux; see docs/bun-compatibility.md); fails only on new failures. `MOMENTUM_TEMPORAL=polyfill bun test` forces the polyfill.
- `bun check` — type check (`tsconfig.json`, `src` only); `bun run typecheck` also checks `migrate/` (`bun check -p migrate`)
- `bun run build` — `scripts/build.ts` (Bun.build, ESM, `temporal-polyfill` external) + `tsc -p tsconfig.build.json` for `build/types`
- `bun run benchmark` / `benchmark:compare` / `benchmark:node` / `benchmark:memory` / `benchmark:memory:node` — mitata port of luxon's benchmarks against the built bundle (they build first), optionally against luxon, on Bun or Node; retained memory and bundle size
- `bun run sync-tests [path]` — re-vendor luxon's tests (default `../luxon`); applies the rewrites documented at the top of `scripts/sync-tests.ts`
- `bun run migrate check|apply|rules [project]` — `migrate/`: the migration tool to native Temporal (docs/migrate.md). TypeScript 7's async compiler API (`typescript/unstable/async`, works under Bun) finds uses by type; `migrate/rules.ts` is the catalog of replacements, `migrate/differences.ts` the documented differences

## Conventions

- TypeScript source in `src/`, ESM only, relative imports use the `.js` extension (Jest maps them back via `moduleNameMapper`).
- No import-time side effects: caches are module-level `Map`s marked `/* @__PURE__ */`, Temporal is read lazily from `globalThis` in `impl/temporal.ts`. Only `src/polyfill.ts` is side-effectful and is listed in `package.json` `sideEffects`.
- Temporal reports unrepresentable values with `RangeError`; swallow those (invalid DateTime) and rethrow anything else (`isRangeError`).
- `test/` is vendored from luxon except `test/setupTests.js`, `test/bun-known-failures.txt`, `test/parity/*` and `test/momentum/*`. Don't hand-edit vendored files; change `scripts/sync-tests.ts` instead.
- New tests go in `test/parity/` when they pin luxon behaviour that luxon's own suite doesn't check (take every expectation from luxon 3.7.2, the `luxon` devDependency), and in `test/momentum/` when they cover what momentum adds (Temporal interop, polyfill entry, offset cache, the two cores, API-surface snapshot). Tests written for one core set `Settings.temporalNative` themselves (`temporalCore.test.js`, `parity/dstResolution.test.js`); `optOut.test.js` holds the properties that the cores agree.
- Randomized tests are fast-check properties built on `test/momentum/fastCheck.js` (shared configuration and generators: instants, wall clocks near transitions); never `Math.random`. `FC_NUM_RUNS=20000` fuzzes longer; a failure prints `{ seed, path }`, replayed with `FC_SEED`/`FC_PATH`.
- A workaround for an upstream bug links its issue in a comment and has a row in `docs/upstream.md` saying what to delete when the fix ships; remove both together.
- The migration catalog (`migrate/rules.ts`) describes the default core. A rewrite without differences must be exact: add a property test to `test/momentum/migrateRules.test.js` that evaluates its text against momentum. A new difference needs a reproducing example there too, and every public DateTime and Duration member needs an entry (a coverage test checks it). Fixture projects for the CLI live in `test/momentum/fixtures/migrate` with reviewed outputs in `expected/`.
- Adding or removing a public member requires updating the API snapshot deliberately (`bunx jest test/momentum/apiSurface.test.js -u`).
- Public JSDoc comes from luxon; keep it when touching public methods, it ends up in the `.d.ts` files.
