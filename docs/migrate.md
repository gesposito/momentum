# Moving from momentum to native Temporal

momentum is a bridge: Luxon's API today, plain Temporal tomorrow. The migration tool tells you how
far a project is from dropping momentum (or Luxon) and rewrites what already has a native
replacement.

```sh
bun run migrate check path/to/project              # would the rewrites complete the switch?
bun run migrate check path/to/project --verbose    # every location, not just the first three
bun run migrate apply path/to/project --dry-run    # show the rewrites as a diff
bun run migrate apply path/to/project              # write them
bun run migrate rules                              # the catalog and the documented differences
```

`check` exits with 0 when the project can switch completely and 1 otherwise, so it can gate a CI job.
`--json` prints a machine-readable report, and `--project` points at a tsconfig.json other than the
directory's. Without a tsconfig.json, a temporary one includes every JavaScript and TypeScript file
and TypeScript infers the types.

## How it decides

The tool uses TypeScript 7's compiler API, so a call like `x.plus(...)` counts as momentum's only
when `x` really is a momentum DateTime, wherever that value comes from: a factory, a parameter, a
return value, an object property. It also sees the implicit uses: comparisons and arithmetic
(`a < b`, `a - b`), template literals, `JSON.stringify`, `console` output, and values handed to code
typed `any` or to dependencies that expect momentum or Luxon objects.

Each use gets one of three outcomes:

- **exact**: a native expression gives the same result for every input. Exact rewrites are
  applied by default. Each one is proven by property tests against momentum
  (`test/momentum/migrateRules.test.js`), which evaluate the very text the tool would write.
- **differs**: a native replacement exists but behaves differently in documented cases, listed
  below. These rewrites are applied only with `--accept=<difference>,...` (or `--accept=all`).
- **none**: no native replacement yet. The report lists these with the reason; they are what
  keeps momentum in the project.

Some answers depend on the whole project. Assigning `Settings.now` or `Settings.defaultZone` makes
the factories that rely on them "none"; a locale set anywhere (`setLocale`, `reconfigure`, a
`locale` option, `Settings.defaultLocale`) does the same for the rewrites that format with the
default locale; and `Settings.temporalNative = false` does it for wall-clock arithmetic, because
the opt-out resolves times with Luxon's algorithm.

## What `apply` rewrites

When every use converts, `apply` rewrites the whole project: each use, each `DateTime` and
`Duration` annotation (which become `Temporal.ZonedDateTime` and `Temporal.Duration`), and the
imports, which disappear (`momentum/polyfill` becomes `temporal-polyfill/global`). Otherwise it
rewrites only self-contained expressions, which start from a momentum factory and end in a plain
value, such as `DateTime.fromMillis(ms).setZone("Asia/Tokyo").hour`. No momentum value outlives
them, so the rest of the program is untouched. Run `check` again afterwards to see what is left.

The new text keeps everything outside the rewritten expressions byte for byte. After writing,
`apply` type-checks the changed files and reports any new errors.

## Documented differences

| Difference | What changes |
| --- | --- |
| `repeated-wall-time` | calendar arithmetic that lands on a repeated wall-clock time picks the earlier instant |
| `repeated-midnight` | the start of a day whose midnight occurs twice is the earlier one |
| `overflow` | out-of-range fields are clamped instead of rolled over |
| `invalid-throws` | invalid input throws a RangeError instead of returning an invalid DateTime |
| `fractional-amounts` | fractional amounts and mixed signs throw |
| `zone-specifiers` | only IANA names and ±HH:MM offsets are accepted as zones |
| `fixed-offset-names` | fixed offsets are named "+03:00" rather than "UTC+3" |
| `iso-format` | ISO strings write UTC as +00:00 and round historical sub-minute offsets |
| `iso-grammar` | only full date-times with an offset are parsed |
| `json-format` | JSON.stringify writes Temporal's string, with the time zone annotation |
| `inspect-output` | console output shows Temporal's representation |
| `julian-dates` | on V8 before 14.8 (Node 26), dates before 15 October 1582 are formatted in the Julian calendar (an engine bug) |
| `link-name-equality` | equals treats link names as the same zone |
| `negative-duration-iso` | negative durations are written -PT2H instead of PT-2H |
| `duration-calendar-units` | durations with years, months or weeks need a reference date to be totalled |

`bun run migrate rules` prints each one with an example.

## What keeps momentum alive

The members with no native replacement are the work left before momentum can go: token
formatting and parsing (`toFormat`, `fromFormat`), relative formatting (`toRelative`), `diff`
with fractional units, `Interval`, `Info`, `Settings`, locale configuration on values, and
invalid DateTimes, whose checks (`isValid`) become try/catch around the place they are created.

## Limits

- CommonJS `require("momentum")` and JSDoc type references in JavaScript files are reported but
  not rewritten.
- Partial rewrites cover self-contained expressions only, not yet values kept in local variables.
- Rewrites are exact, not minimal: `DateTime.fromMillis(ms).setZone(zone)` becomes two Temporal
  calls where one would do. Run your formatter afterwards; long lines are left as they are.
- Values that pass through code typed `any` are invisible to the type checker; the report flags
  where momentum values flow into such code, but cannot follow them further.

## How the tool is checked

Besides the property tests, `test/momentum/migrate.test.js` runs the tool on the projects in
`test/momentum/fixtures/migrate`: the report, the rewritten files against reviewed outputs, the
type check of the result, and the values each project computes before and after. As a larger
check, applying the exact rewrites to Luxon's own test suite leaves all 1292 tests passing.
