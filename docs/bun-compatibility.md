# Bun compatibility notes

`bun run test:bun` runs Luxon's suite on Bun's native Temporal. Twenty-two tests fail there on
macOS while passing on Node, and three of them on Linux too; every one of them comes from the
engine, not from momentum. Nineteen fail on macOS only, because Bun uses Apple's ICU there
(sections 1 to 4); two fail everywhere because JavaScriptCore formats date ranges with plain
spaces (section 5), and one because Bun's snapshots do not call `toJSON()` (section 6).
`MOMENTUM_TEMPORAL=polyfill bun test` fails the same tests, which confirms the Temporal engine
behaves identically on both paths.

## macOS only: Apple's ICU

Bun on macOS links the system's ICU (`/usr/lib/libicucore.A.dylib`, ICU 78.1 with Apple's locale
data), while its Linux and Windows builds bundle ICU 78.3, the version Node 26 ships. The same Bun
build gives Node's results on Linux (checked with the `oven/bun:1.4.3` image), and macOS's own
`jsc` gives Bun's results on macOS. [oven-sh/bun#40085](https://github.com/oven-sh/bun/issues/40085)
(open) reports section 2, and
[a comment on it](https://github.com/oven-sh/bun/issues/40085#issuecomment-6265812438) the others.

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
(open); a build of [#44268](https://github.com/oven-sh/bun/pull/44268), the open pull request
that gives the console, `Bun.inspect` and `bun:test` one value formatter, still fails it.

## Other differences handled in the test setup

- `process.versions.cldr` is not exposed by Bun, so Luxon's `cldrMajorVersion()` helper returns
  null and the suite uses its modern expectations, which match Bun's ICU.
- Bun's loader rejects `test/helpers.js` as Luxon ships it (ESM imports next to CommonJS
  `exports`); `scripts/sync-tests.ts` converts it to an ES module.
- `bun fmt` is documented but not part of any released Bun (latest 1.4.3, 2026-10-10; the
  formatter landed on main on 2026-10-16/17). The repository has no formatter until it ships.
