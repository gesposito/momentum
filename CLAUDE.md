# momentum

Luxon-compatible date library (same classes, methods, options and tests as luxon 3.7) whose time
zone engine is Temporal: `src/impl/temporal.ts` answers offset queries (`offsetAt`, cached per
transition window discovered with `getTimeZoneTransition("next")` only), validates zone
identifiers and powers the Temporal interop methods. `src/impl/calendar.ts` holds the closed-form
Gregorian arithmetic (epoch <-> fields, weekday). Parsing, formatting, Duration math, Interval
algebra and luxon's offset-resolution algorithm (`fixOffset` in `src/datetime.ts`) are ports of
luxon. The git history starts from a verbatim copy of luxon (a merge with luxon's own history filtered
to src/, test/ and benchmarks/, so `git blame` reaches the original authors; `git log --first-parent`
shows the migration steps) and migrates it one verified step at a time.

## Commands (Bun for everything)

- `bun install`
- `bun run test` — reference run: luxon's suite on Jest 29 + Node. Node 26 (pinned by `mise.toml`) provides Temporal natively; older Node gets `temporal-polyfill` from `test/setupTests.js`. `bun run test:polyfill` forces the polyfill. The scripts set TZ=America/New_York, which the tests assume
- `bun run test:bun` — the same suite on `bun test` with Bun's native Temporal; 22 tests fail for engine reasons on macOS, where Bun uses Apple's ICU, and 3 on Linux (see docs/bun-compatibility.md). `MOMENTUM_TEMPORAL=polyfill bun test` forces the polyfill.
- `bun check` — type check (`tsconfig.json`, `src` only)
- `bun run build` — `scripts/build.ts` (Bun.build, ESM, `temporal-polyfill` external) + `tsc -p tsconfig.build.json` for `build/types`
- `bun run benchmark` / `benchmark:compare` / `benchmark:node` / `benchmark:memory` / `benchmark:memory:node` — mitata port of luxon's benchmarks against the built bundle (they build first), optionally against luxon, on Bun or Node; retained memory and bundle size
- `bun run sync-tests [path]` — re-vendor luxon's tests (default `../luxon`); applies the rewrites documented at the top of `scripts/sync-tests.ts`

## Conventions

- TypeScript source in `src/`, ESM only, relative imports use the `.js` extension (Jest maps them back via `moduleNameMapper`).
- No import-time side effects: caches are module-level `Map`s marked `/* @__PURE__ */`, Temporal is read lazily from `globalThis` in `impl/temporal.ts`. Only `src/polyfill.ts` is side-effectful and is listed in `package.json` `sideEffects`.
- Temporal reports unrepresentable values with `RangeError`; swallow those (invalid DateTime) and rethrow anything else (`isRangeError`).
- `test/` is vendored from luxon except `test/setupTests.js`, `test/parity/*` and `test/momentum/*`. Don't hand-edit vendored files; change `scripts/sync-tests.ts` instead.
- New tests go in `test/parity/` when they pin luxon behaviour that luxon's own suite doesn't check (take every expectation from luxon 3.7.2, the `luxon` devDependency), and in `test/momentum/` when they cover what momentum adds (Temporal interop, polyfill entry, offset cache, API-surface snapshot).
- Adding or removing a public member requires updating the API snapshot deliberately (`bunx jest test/momentum/apiSurface.test.js -u`).
- Public JSDoc comes from luxon; keep it when touching public methods, it ends up in the `.d.ts` files.
