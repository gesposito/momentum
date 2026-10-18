// Builds the distributable ESM bundles into ./build with Bun's bundler.
// Type declarations are emitted separately by `tsc -p tsconfig.build.json`.

import { rm } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
process.chdir(root);

await rm("build", { recursive: true, force: true });

const shared = {
  format: "esm",
  target: "browser",
  sourcemap: "linked",
  // consumers that need the polyfill resolve it from their own dependency tree
  external: ["temporal-polyfill"],
} as const;

const results = await Promise.all([
  Bun.build({
    entrypoints: ["src/momentum.ts", "src/polyfill.ts"],
    outdir: "build",
    splitting: true,
    ...shared,
  }),
  Bun.build({
    entrypoints: ["src/momentum.ts"],
    outdir: "build",
    naming: "[dir]/[name].min.[ext]",
    minify: true,
    ...shared,
  }),
]);

let failed = false;
for (const result of results) {
  if (!result.success) {
    failed = true;
    for (const log of result.logs) console.error(log);
  }
  for (const output of result.outputs) {
    if (output.kind !== "sourcemap") {
      console.log(`${output.path.replace(root, "")}  ${(output.size / 1024).toFixed(1)} kB`);
    }
  }
}

if (failed) process.exit(1);

// Tree-shaking check: a consumer that imports one small export must not get DateTime with it.
// An import-time side effect in any module (a class static block, an unannotated top-level call)
// would keep it in the bundle.
const probe = "build/tree-shaking-probe.js";
await Bun.write(
  probe,
  'import { FixedOffsetZone } from "./momentum.js";\nconsole.log(FixedOffsetZone);\n'
);
const shaken = await Bun.build({ entrypoints: [probe], minify: true, target: "browser" });
await rm(probe);
const shakenText = shaken.success ? await shaken.outputs[0].text() : "";
if (!shaken.success || shakenText.includes("toISOWeekDate")) {
  console.error("Tree-shaking check failed: importing FixedOffsetZone alone bundles DateTime.");
  process.exit(1);
}
const shakenSize = (shakenText.length / 1024).toFixed(1);
console.log(`FixedOffsetZone alone  ${shakenSize} kB (tree-shaking check)`);
