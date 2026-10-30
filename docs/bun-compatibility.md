# Bun compatibility notes

`bun run test:bun` runs Luxon's suite on Bun's native Temporal. Twenty-four tests fail there on
macOS while passing on Node, and three of them on Linux too; every one of them comes from the
engine, not from momentum. Twenty-one fail on macOS only: nineteen because Bun uses Apple's ICU
there (sections 1 to 4), and two because, with the time zone data macOS installed in October 2026,
JavaScriptCore rejects the POSIX-style US zone names (section 8). Two fail everywhere because
JavaScriptCore formats date ranges with plain spaces (section 5), and one because Bun's snapshots do
not call `toJSON()` (section 6). `MOMENTUM_TEMPORAL=polyfill bun test` fails the same tests, which
confirms the Temporal engine behaves identically on both paths, and one test of the migration tool's
(section 9). The allowlist lives in `packages/luxon/test/bun-known-failures.txt`, whose `[darwin]`
section holds the macOS-only failures; `scripts/test-bun.ts` fails only on new failures.

## macOS only: Apple's ICU

Bun on macOS links the system's ICU (`/usr/lib/libicucore.A.dylib`, ICU 78.1 with Apple's locale
data), while its Linux and Windows builds bundle ICU 78.3, the version Node 26 ships. The same Bun
build gives Node's results on Linux (checked with the `oven/bun:1.4.3` and `oven/bun:1.4.4` images),
and macOS's own `jsc` gives Bun's results on macOS.
[oven-sh/bun#40085](https://github.com/oven-sh/bun/issues/40085) (open) reports section 2, and [a
comment on it](https://github.com/oven-sh/bun/issues/40085#issuecomment-6265812438) the others.

### 1. `bn` numbers use Latin digits

```js
new Intl.NumberFormat("bn").resolvedOptions().numberingSystem; // macOS: "latn"   Linux, Node: "beng"
new Intl.NumberFormat("bn").format(12); // macOS: "12"   Linux, Node: "১২"
```

CLDR gives `bn` the default numbering system `beng`; `mr` and `ur-IN` lose their native digits
the same way, and the explicit form `bn-u-nu-beng` works. Affects the fifteen tests that check
the `bn` locale: `DateTime#toFormat` with the numeric tokens `S`, `SSS`, `s`, `ss`, `m`, `mm`,
`h`, `hh`, `H`, `HH`, `y`, `yy` and `yyyy`, `Duration#toFormat localizes the numbers` and
`Info.months respects the locale`.

### 2. Date and time are joined with " at "

```js
new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(2017, 4, 15, 9));
// macOS: "May 15, 2017 at 9:00 AM"   Linux, Node: "May 15, 2017, 9:00 AM"
```

Affects `DateTime#toFormat('ff')` and `('FF')`.

### 3. Spanish time ranges put spaces around the dash

```js
new Intl.DateTimeFormat("es", { hour: "numeric", minute: "2-digit" }).formatRange(new Date(2017, 4, 25, 9), new Date(2017, 4, 25, 11));
// macOS: "9:00 – 11:00"   Linux, Node: "9:00–11:00"
```

Affects `Interval#toLocaleString uses locale-appropriate time formats`.

### 4. Chinese 12-hour times use the flexible day period

```js
new Intl.DateTimeFormat("zh", { hour: "numeric", hourCycle: "h12" }).format(new Date(2016, 10, 13, 19));
// macOS: "晚上7时" ("evening")   Linux, Node: "下午7时" ("PM")
```

Luxon learns the names of AM and PM by formatting 09:00 and 19:00, so on macOS it expects
`上午|晚上` and cannot parse `下午`: `DateTime.fromFormatExplain() parses localized string with
numberingSystem correctly` fails on its Chinese string (the Kannada one passes).

## Every platform

### 5. Date ranges use plain spaces

```js
new Intl.DateTimeFormat("en-US").formatRange(new Date(1982, 4, 25), new Date(1983, 9, 14));
// Bun: "5/25/1982 – 10/14/1983" with U+0020   Node: the same with U+2009 THIN SPACE
```

CLDR puts thin spaces around the range dash. JavaScriptCore deliberately replaces thin and narrow
no-break spaces with plain ones in all date output, for web compatibility
(`replaceNarrowNoBreakSpaceOrThinSpaceWithNormalSpace` in `IntlDateTimeFormat.cpp`); V8 keeps the
thin spaces. A design choice rather than a bug, so nothing is reported upstream. Affects
`Interval#toLocaleString defaults to the DATE_SHORT format` and `Interval#toLocaleString sets the
separator between days for same-month dates`, which compare exact strings.

### 6. Snapshots do not call `toJSON()`

```js
expect({ toJSON: () => "PT1S" }).toMatchInlineSnapshot(`"PT1S"`); // passes in Jest, fails in Bun
```

Jest's and Vitest's serializers call `toJSON()` by default; Bun's prints the object's own
properties, in inline and file snapshots alike. Affects `Duration.fromDurationLike returns a
Duration from millis`. Reported as [oven-sh/bun#46043](https://github.com/oven-sh/bun/issues/46043)
(open); a build of [#44268](https://github.com/oven-sh/bun/pull/44268), the pull request that
gave the console, `Bun.inspect` and `bun:test` one value formatter, still failed it, and it was
closed unmerged on 2026-10-27.

### 7. `Date#setMonth` returns an Invalid Date across more than 8.64e15 ms

```js
const d = new Date(0);
d.setFullYear(-187631, 8, 27);
d.setMonth(3472364); // Node: +101732-09-27, Bun: Invalid Date
```

September 101732 is a valid date, but it lies more than 8.64e15 ms, the width of `Date`'s range,
from the start, and JavaScriptCore's `setMonth` gives `NaN` there (`setFullYear` and `setDate`
do not; V8 is right in every case). date-fns's `differenceInMonths` and `differenceInQuarters`
move the later date by the whole calendar difference with `setMonth`, so on Bun they are wrong
for spans of more than about 273,790 years, and the property tests that compare them with
Temporal (`packages/migrate/test/migrateDateFns.test.js`) keep their pairs within that width where
a probe finds the bug. Not a test of Luxon's suite, so not in the allowlist. Reported as
[oven-sh/bun#46342](https://github.com/oven-sh/bun/issues/46342): a guard in JavaScriptCore's
`DatePrototype.cpp` checks the month count instead of the resulting year, and the fix,
[oven-sh/WebKit#616](https://github.com/oven-sh/WebKit/pull/616), is in review.

## macOS only, with the system's time zone data 2026e

### 8. The POSIX-style US zones are rejected

```js
new Intl.DateTimeFormat("en-US", { timeZone: "PST8PDT" }); // Bun 1.4.3 and 1.4.4 on macOS: RangeError
Temporal.Now.zonedDateTimeISO("EST5EDT"); // RangeError: 'EST5EDT' is not a valid time zone identifier
```

`EST5EDT`, `CST6CDT`, `MST7MDT` and `PST8PDT` are IANA names, which Node accepts. Bun 1.4.3 and
1.4.4 on macOS throw for them, in `Intl.DateTimeFormat` and in Temporal alike, since macOS installed
the time zone data 2026e for its ICU (`/var/db/timezone/icutz/icutz44l.dat`, 2026-10-19); with
`ICU_TIMEZONE_FILES_DIR=/nonexistent`, which makes Apple's ICU use its built-in data, they work. In
that data the four are zones of their own again rather than links, and JavaScriptCore drops the
canonical zone names without a `/`. The other legacy names (`CET`, `EET`, `MET`, `WET`, `EST`,
`MST`, `HST`) still work. Affects `DateTime#setZone accepts whacky zone "EST5EDT"` and `"PST8PDT"`,
which expect a valid DateTime: momentum gets the engine's `RangeError` and returns an invalid one,
as for any zone the engine does not know. The same eight names, these four and `CET`, `EET`, `MET`,
`WET`, failed on Linux in Bun 1.3.14
([oven-sh/bun#30618](https://github.com/oven-sh/bun/issues/30618), closed by the update to ICU 78),
and work there in 1.4.4: the `oven/bun:1.4.4` image, the same revision with the bundled ICU 78.3,
accepts all eight. Reported as [oven-sh/bun#46865](https://github.com/oven-sh/bun/issues/46865),
where Bun's triage traced the cause; the fix, which maps the four names to their city zones before
asking ICU, is on Bun's main branch (#47281, with oven-sh/WebKit#936), and the canary
`1.4.4-canary.1+da867c60b` passes both tests on this Mac.

## With temporal-polyfill

### 9. Link names compare as different zones

```js
import { Temporal } from "temporal-polyfill/implementation";

const a = Temporal.ZonedDateTime.from("2026-01-01T00:00[Asia/Calcutta]");
const b = Temporal.ZonedDateTime.from("2026-01-02T00:00[Asia/Kolkata]");
b.since(a, { largestUnit: "days" }); // Node 26: P1D; Bun: RangeError: Mismatching TimeZones
```

temporal-polyfill 1.0.6 identifies a zone by what `Intl.DateTimeFormat`'s `resolvedOptions()`
returns as its `timeZone`, which V8 canonicalizes (`Asia/Kolkata` gives `Asia/Calcutta`). The
JavaScriptCore of Bun 1.4.3 and 1.4.4, on macOS and Linux alike, returns the identifier as given, as
the specification now requires (test262's `intl402/DateTimeFormat/timezone-not-canonicalized.js`),
so the polyfill takes `Asia/Calcutta` and `Asia/Kolkata` for different zones: `equals` is false, and
`since` and `until` in days or longer units throw. Bun's native Temporal gets both right. Under
`MOMENTUM_TEMPORAL=polyfill bun test`, this fails the migration tool's `each documented difference
is real > link-name-equality`, which expects Temporal to treat the two names as one zone; momentum
compares zone names itself, so the library is not affected. Reported as
[fullcalendar/temporal-polyfill#118](https://github.com/fullcalendar/temporal-polyfill/issues/118).

## Other differences handled in the test setup

- `process.versions.cldr` is not exposed by Bun, so Luxon's `cldrMajorVersion()` helper returns
  null and the suite uses its modern expectations, which match Bun's ICU.
- `bun test` fails a `toMatchSnapshot()` whose `.snap` file is read-only, even when it matches
  ([oven-sh/bun#46051](https://github.com/oven-sh/bun/issues/46051)), so the API-surface snapshot
  test needs a writable checkout, unlike under Jest.
- Bun's loader rejects `packages/luxon/test/helpers.js` as Luxon ships it (ESM imports next to CommonJS
  `exports`); `packages/luxon/scripts/sync-tests.ts` converts it to an ES module.
