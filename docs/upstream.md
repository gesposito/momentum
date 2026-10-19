# Upstream issues

momentum works around a few bugs and gaps in Temporal implementations, in Bun, in Luxon's test
suite and, for the migration tool, in TypeScript's API. Each workaround links its issue in a
comment; this list says what the workaround costs and what to delete once the fix ships in every
version momentum supports. The goal is for all of it, and eventually momentum itself, to go away.

| Issue | What momentum does meanwhile | Delete when fixed |
| --- | --- | --- |
| [fullcalendar/temporal-polyfill#113](https://github.com/fullcalendar/temporal-polyfill/pull/113): `getTimeZoneTransition("previous")` returns a ~2029 transition for instants more than ~3 years ahead | `transitionWindow()` in `packages/luxon/src/impl/temporal.ts` finds a window's start by walking `"next"` forward from a year earlier | the walk, in favour of one `"previous"` call |
| [fullcalendar/temporal-polyfill#114](https://github.com/fullcalendar/temporal-polyfill/pull/114): transitions before 1847 are never found (five zones change on 1844-12-31) | `transitionWindow()` confirms a window's offset at both ends; `resolveWallClock()` confirms cached candidates with a real conversion | the end checks in `transitionWindow()` |
| [fullcalendar/temporal-polyfill#116](https://github.com/fullcalendar/temporal-polyfill/issues/116): unminified builds attach a debug string to every object, which makes `toPlainDateTime()` about three times slower | `wallClock()` reads a polyfill ZonedDateTime directly instead of through `toPlainDateTime()` | the native-code check, if both routes cost the same |
| [fullcalendar/temporal-polyfill#115](https://github.com/fullcalendar/temporal-polyfill/pull/115): every construction re-parses its time zone id | nothing (performance only) | |
| [fabon-f/temporal-polyfill-lite#44](https://github.com/fabon-f/temporal-polyfill-lite/pull/44): `"next"` returns `null` near a 10-year horizon | nothing: lite is not a supported polyfill, and `transitionWindow()` would treat that `null` as "no more transitions" | |
| Native `ZonedDateTime` getters recompute the wall clock on every access: V8 ([crbug.com/575359795](https://issues.chromium.org/issues/575359795)) through temporal_rs ([boa-dev/temporal#505](https://github.com/boa-dev/temporal/issues/505#issuecomment-6268798070)), and JavaScriptCore ([webkit.org/b/328057](https://bugs.webkit.org/show_bug.cgi?id=328057)) | `wallClock()` reads native ZonedDateTimes through one `toPlainDateTime()` | the `toPlainDateTime()` detour |
| [nodejs/node#66847](https://github.com/nodejs/node/issues/66847): V8 before 14.8 (Node 26 has 14.6) formats Temporal objects before 15 October 1582 in the Julian calendar; V8 14.8 fixed it in [3102739e](https://github.com/v8/v8/commit/3102739ec1d85b94e9f314ecb4e89e31c196ae20), and the issue asks Node 26 to backport it | nothing: the codemod's `toLocaleString` and month-name rewrites carry the `julian-dates` difference | that difference, in `packages/migrate/src/differences.ts` and `packages/migrate/src/rules.ts` |
| [oven-sh/bun#40085](https://github.com/oven-sh/bun/issues/40085) ([comment](https://github.com/oven-sh/bun/issues/40085#issuecomment-6265812438)): Bun on macOS uses Apple's ICU | 19 tests in the `[darwin]` section of `packages/luxon/test/bun-known-failures.txt` | that section |
| [oven-sh/bun#46043](https://github.com/oven-sh/bun/issues/46043): snapshots don't call `toJSON()` | one test in `packages/luxon/test/bun-known-failures.txt` | its line |
| [oven-sh/bun#46051](https://github.com/oven-sh/bun/issues/46051): a matching snapshot fails when the `.snap` file is read-only | nothing: run `bun test` from a writable checkout | |
| Luxon's suite hardcodes U+202F before AM/PM, which Node 26's V8 replaces with a space (not reported yet) | `packages/luxon/scripts/sync-tests.ts` compares those 9 strings with Luxon's whitespace-tolerant matcher | the rewrite |
| [microsoft/TypeScript#63869](https://github.com/microsoft/TypeScript/issues/63869): TypeScript 7.0.2's API panics on the type of an empty array literal typed by a tuple with optional elements; [#64080](https://github.com/microsoft/TypeScript/pull/64080) fixes it in 7.1 | `typesAt()` in `packages/migrate/src/analyze.ts` halves a batch that panics until the node is isolated, which gets no type, and empty arrays are not asked about | the halving, when the tool moves to TypeScript 7.1 |

JavaScriptCore's replacement of thin spaces in date ranges is deliberate, so its two allowlisted
tests stay; see [bun-compatibility.md](bun-compatibility.md).
