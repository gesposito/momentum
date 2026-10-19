# Upstream issues

momentum works around a few bugs and gaps in Temporal implementations, in Bun and in Luxon's test
suite. Each workaround links its issue in a comment; this list says what the workaround costs and
what to delete once the fix ships in every version momentum supports. The goal is for all of it,
and eventually momentum itself, to go away.

| Issue | What momentum does meanwhile | Delete when fixed |
| --- | --- | --- |
| [fullcalendar/temporal-polyfill#113](https://github.com/fullcalendar/temporal-polyfill/pull/113): `getTimeZoneTransition("previous")` returns a ~2029 transition for instants more than ~3 years ahead | `transitionWindow()` in `src/impl/temporal.ts` finds a window's start by walking `"next"` forward from a year earlier | the walk, in favour of one `"previous"` call |
| [fullcalendar/temporal-polyfill#114](https://github.com/fullcalendar/temporal-polyfill/pull/114): transitions before 1847 are never found (five zones change on 1844-12-31) | `transitionWindow()` confirms a window's offset at both ends; `resolveWallClock()` confirms cached candidates with a real conversion | the end checks in `transitionWindow()` |
| [fullcalendar/temporal-polyfill#116](https://github.com/fullcalendar/temporal-polyfill/issues/116): unminified builds attach a debug string to every object, which makes `toPlainDateTime()` about three times slower | `wallClock()` reads a polyfill ZonedDateTime directly instead of through `toPlainDateTime()` | the native-code check, if both routes cost the same |
| [fullcalendar/temporal-polyfill#115](https://github.com/fullcalendar/temporal-polyfill/pull/115): every construction re-parses its time zone id | nothing (performance only) | |
| [fabon-f/temporal-polyfill-lite#44](https://github.com/fabon-f/temporal-polyfill-lite/pull/44): `"next"` returns `null` near a 10-year horizon | nothing: lite is not a supported polyfill, and `transitionWindow()` would treat that `null` as "no more transitions" | |
| Native `ZonedDateTime` getters recompute the wall clock on every access: V8 ([crbug.com/575359795](https://issues.chromium.org/issues/575359795)) through temporal_rs ([boa-dev/temporal#505](https://github.com/boa-dev/temporal/issues/505#issuecomment-6268798070)), and JavaScriptCore ([webkit.org/b/328057](https://bugs.webkit.org/show_bug.cgi?id=328057)) | `wallClock()` reads native ZonedDateTimes through one `toPlainDateTime()` | the `toPlainDateTime()` detour |
| [oven-sh/bun#40085](https://github.com/oven-sh/bun/issues/40085) ([comment](https://github.com/oven-sh/bun/issues/40085#issuecomment-6265812438)): Bun on macOS uses Apple's ICU | 19 tests in the `[darwin]` section of `test/bun-known-failures.txt` | that section |
| [oven-sh/bun#46043](https://github.com/oven-sh/bun/issues/46043): snapshots don't call `toJSON()` | one test in `test/bun-known-failures.txt` | its line |
| [oven-sh/bun#46051](https://github.com/oven-sh/bun/issues/46051): a matching snapshot fails when the `.snap` file is read-only | nothing: run `bun test` from a writable checkout | |
| Luxon's suite hardcodes U+202F before AM/PM, which Node 26's V8 replaces with a space (not reported yet) | `scripts/sync-tests.ts` compares those 9 strings with Luxon's whitespace-tolerant matcher | the rewrite |

JavaScriptCore's replacement of thin spaces in date ranges is deliberate, so its two allowlisted
tests stay; see [bun-compatibility.md](bun-compatibility.md).
