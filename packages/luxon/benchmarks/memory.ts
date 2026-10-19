// Retained memory footprint of momentum next to luxon, on Bun or Node.
//
//   bun run benchmark:memory                       Bun's native Temporal
//   bun run benchmark:memory:node                  Node (native Temporal on Node 26)
//   MOMENTUM_TEMPORAL=polyfill ...                 momentum on top of temporal-polyfill
//   MOMENTUM_TEMPORAL_NATIVE=false ...             momentum with Luxon's algorithms
//
// Reports the heap retained per instance by 100k DateTime, Duration and Interval objects, the
// heap kept alive by zone caches after touching 100 zones, and the size of the minified bundles.
// Object counts come from bun:jsc and are only available on Bun. Allocation per operation is
// already part of `bun run benchmark`, which prints mitata's heap column.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

if (process.env.MOMENTUM_TEMPORAL === "polyfill") {
  const { Temporal } = await import("temporal-polyfill/implementation");
  (globalThis as { Temporal?: unknown }).Temporal = Temporal;
}

const isBun = typeof Bun !== "undefined";
const jsc = isBun ? await import("bun:jsc") : null;
const collectGarbage: () => void = isBun
  ? () => Bun.gc(true)
  : typeof globalThis.gc === "function"
    ? () => (globalThis.gc as () => void)()
    : () => {};
if (!isBun && typeof globalThis.gc !== "function") {
  console.warn("run with `node --expose-gc` for stable numbers\n");
}

const momentum = await import("../build/momentum.js").catch(() => {
  throw new Error("build/momentum.js is missing; run `bun run build` first");
});
const luxon = (await import("luxon")) as unknown as typeof momentum;
if (process.env.MOMENTUM_TEMPORAL_NATIVE === "false") momentum.Settings.temporalNative = false;

type Lib = Pick<typeof momentum, "DateTime" | "Duration" | "Interval" | "Settings">;
const libs: [string, Lib][] = [
  ["momentum", momentum],
  ["luxon", luxon],
];

const COUNT = 100000;
const base = Date.UTC(2017, 4, 15, 9, 12, 34, 567);
const zones = Intl.supportedValuesOf("timeZone")
  .filter((z) => z.includes("/"))
  .slice(0, 100);

function heapBytes(): number {
  if (jsc) {
    const stats = jsc.heapStats();
    return stats.heapSize + stats.extraMemorySize;
  }
  return process.memoryUsage().heapUsed;
}

function objectCount(): number | null {
  return jsc ? jsc.heapStats().objectCount : null;
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`;

interface Retained {
  bytes: number;
  objects: number | null;
}

// heap retained by `count` values produced by `make`, per value
function retainedPerInstance(make: (i: number) => unknown, count: number): Retained {
  const keep: unknown[] = new Array(count).fill(null);
  collectGarbage();
  const bytesBefore = heapBytes(),
    objectsBefore = objectCount();
  for (let i = 0; i < count; i++) keep[i] = make(i);
  collectGarbage();
  const objectsAfter = objectCount();
  const result = {
    bytes: (heapBytes() - bytesBefore) / count,
    objects:
      objectsBefore === null || objectsAfter === null ? null : (objectsAfter - objectsBefore) / count,
  };
  if (keep.length !== count) throw new Error("unreachable");
  return result;
}

// memory retained by whatever `run` leaves behind in caches. V8's heap counters exclude ICU's
// native allocations (luxon keeps one Intl.DateTimeFormat per zone), so on Node the resident set
// size is reported as well.
function retainedByCaches(run: () => void): string {
  collectGarbage();
  const heapBefore = heapBytes(),
    rssBefore = process.memoryUsage().rss;
  run();
  collectGarbage();
  const heap = heapBytes() - heapBefore,
    rss = process.memoryUsage().rss - rssBefore;
  return isBun ? kb(heap) : `${kb(heap)} heap, ${kb(rss)} rss`;
}

function instanceCases({ DateTime, Duration, Interval }: Lib): [string, (i: number) => unknown][] {
  const start = DateTime.fromMillis(base);
  return [
    ["DateTime (system zone)", (i) => DateTime.fromMillis(base + i * 60000)],
    ["DateTime (IANA zone)", (i) => DateTime.fromMillis(base + i * 60000, { zone: "Europe/Paris" })],
    ["Duration", (i) => Duration.fromObject({ hours: i, minutes: 30 })],
    ["Interval", (i) => Interval.fromDateTimes(start, start.plus({ minutes: i + 1 }))],
  ];
}

const perInstance = (r: Retained) =>
  r.objects === null ? `${r.bytes.toFixed(0)} B` : `${r.bytes.toFixed(0)} B / ${r.objects.toFixed(1)} objects`;

const runtime = isBun ? `bun ${Bun.version}` : `node ${process.versions.node}`;
const engine =
  process.env.MOMENTUM_TEMPORAL === "polyfill"
    ? "temporal-polyfill"
    : typeof globalThis.Temporal === "object"
      ? "native"
      : "none";
const core = momentum.Settings.temporalNative ? "Temporal-native" : "Luxon's algorithms";
console.log(`runtime: ${runtime}, Temporal: ${engine}, momentum core: ${core}\n`);

const perInstanceRows: Record<string, Record<string, string>> = {};
for (const [name, lib] of libs) {
  lib.Settings.resetCaches();
  for (const [label, make] of instanceCases(lib)) {
    perInstanceRows[label] ??= {};
    perInstanceRows[label][name] = perInstance(retainedPerInstance(make, COUNT));
  }
}
console.log(`retained per instance (${COUNT.toLocaleString("en-US")} instances)`);
console.table(perInstanceRows);

const cacheLabel = `${zones.length} zones touched`;
const cacheRows: Record<string, Record<string, string>> = { [cacheLabel]: {} };
for (const [name, lib] of libs) {
  lib.Settings.resetCaches();
  cacheRows[cacheLabel][name] = retainedByCaches(() => {
    for (const zone of zones) lib.DateTime.fromMillis(base, { zone }).offset;
  });
}
console.log("retained by zone caches");
console.table(cacheRows);

const bundles: Record<string, string> = {
  momentum: fileURLToPath(new URL("../build/momentum.min.js", import.meta.url)),
  luxon: fileURLToPath(new URL("../node_modules/luxon/build/global/luxon.min.js", import.meta.url)),
};
const sizeRows: Record<string, Record<string, string>> = { minified: {}, gzipped: {} };
for (const [name, path] of Object.entries(bundles)) {
  if (!existsSync(path)) {
    sizeRows.minified[name] = sizeRows.gzipped[name] = "missing";
    continue;
  }
  const bytes = readFileSync(path);
  sizeRows.minified[name] = kb(bytes.byteLength);
  sizeRows.gzipped[name] = kb(gzipSync(bytes).byteLength);
}
console.log("bundle size");
console.table(sizeRows);
