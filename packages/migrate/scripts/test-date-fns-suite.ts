// Runs date-fns's own test suite (packages/date-fns/core/src/**/test.ts, vendored by
// packages/date-fns/scripts/sync.ts) against the vendored source on vitest, then applies the
// migration tool's exact rewrites to a copy of the suite and runs that too: every test that passed
// must still pass. Each test file is analysed as a project of its own. The rewritten copy runs with
// Temporal from temporal-polyfill, whose Temporal.Now reads Date.now() and so follows vitest's fake
// timers where a test freezes the clock (docs/migrate.md, Limits). date-fns computes in the system
// zone, so each zone is a pair of vitest runs.
//
//   bun run test:date-fns-suite                 America/New_York and Pacific/Auckland
//   bun run test:date-fns-suite Europe/London   the zones given
//
// The rewritten copy stays in packages/date-fns/.rewritten for inspection.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { API } from "typescript/unstable/async";
import { analyze, defaultModules, selectRewrites } from "../src/analyze.js";
import type { DifferenceId } from "../src/differences.js";
import type { LoadedProject } from "../src/project.js";
import { renderFile } from "../src/render.js";

const root = join(import.meta.dir, "../../..");
const vendored = join(root, "packages/date-fns");
const source = join(vendored, "core/src");
const work = join(vendored, ".rewritten");
const zones =
  process.argv.length > 2 ? process.argv.slice(2) : ["America/New_York", "Pacific/Auckland"];

/** The package's entry points, as the sources under `src` (one tree per run, so modules are shared). */
const entryPoints = (src: string) => ({
  "date-fns/locale": join(src, "locale/index.ts"),
  "date-fns/fp": join(src, "fp/index.ts"),
  "date-fns": join(src, "index.ts"),
  "@date-fns/tz": join(vendored, "tz/src/index.ts"),
  "@date-fns/utc": join(vendored, "utc/src/index.ts"),
});

/** Copies the suite into packages/date-fns/.rewritten and applies the exact rewrites, file by file. */
async function rewriteCopy(): Promise<{ rewrites: number; files: number; total: number }> {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, ".tsconfigs"), { recursive: true });
  cpSync(source, join(work, "src"), { recursive: true });
  writeFileSync(
    join(work, "setup.ts"),
    "// temporal-polyfill's Temporal.Now follows fake timers, as date-fns does; native Temporal.Now would not\n" +
      'import { Temporal } from "temporal-polyfill/implementation";\n' +
      "(globalThis as { Temporal?: unknown }).Temporal = Temporal;\n"
  );
  const tests = [...new Bun.Glob("**/test.ts").scanSync({ cwd: join(work, "src") })].sort();
  const configs = tests.map((t, i) => {
    const config = join(work, ".tsconfigs", `${i}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          types: [],
          paths: Object.fromEntries(
            Object.entries(entryPoints(join(work, "src"))).map(([k, v]) => [k, [v]])
          ),
        },
        files: [join(work, "src", t)],
      })
    );
    return config;
  });
  const accepted = new Set<DifferenceId>();
  let rewrites = 0;
  let files = 0;
  // every project pulls in the package's whole index, so a few projects per API instance
  const batch = 20;
  for (let start = 0; start < tests.length; start += batch) {
    const api = new API({ cwd: work });
    const snapshot = await api.updateSnapshot({
      openProjects: configs.slice(start, start + batch),
    });
    try {
      for (let i = start; i < Math.min(start + batch, tests.length); i++) {
        const project = snapshot.getProject(configs[i]);
        if (project === undefined) throw new Error(`TypeScript could not load ${configs[i]}`);
        const path = join(work, "src", tests[i]);
        const loaded: LoadedProject = {
          api,
          project,
          root: work,
          configFile: configs[i],
          files: [path],
          inferred: false,
          reload: async () => project,
          close: async () => {},
        };
        const analysis = await analyze(loaded, defaultModules);
        const { uses, whole } = selectRewrites(analysis, accepted);
        for (const file of analysis.files) {
          const after = renderFile(file, uses, whole);
          if (after !== file.sourceFile.text) {
            writeFileSync(file.path, after);
            files++;
          }
        }
        rewrites += uses.filter((u) => u.kind !== "implicit" && u.kind !== "escape").length;
      }
    } finally {
      await api.close();
    }
  }
  return { rewrites, files, total: tests.length };
}

/** Runs the suite under `dir` in a zone; the status of each test, by file and name. */
function runVitest(zone: string, dir: string, rewritten: boolean): Map<string, string> {
  const label = `${rewritten ? "after" : "before"}-${zone.replace("/", "_")}`;
  const output = join(work, `${label}.json`);
  const config = join(work, `vitest.${label}.config.ts`);
  writeFileSync(
    config,
    `import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: [
${Object.entries(entryPoints(dir))
  .map(
    ([find, replacement]) =>
      `      { find: /^${find.replace(/[/@.-]/g, (c) => `\\${c}`)}$/, replacement: ${JSON.stringify(replacement)} },`
  )
  .join("\n")}
    ],
  },
  test: {
    dir: ${JSON.stringify(dir)},
    include: ["**/test.ts"],
    pool: "threads",
    setupFiles: ${JSON.stringify(rewritten ? [join(work, "setup.ts")] : [])},
  },
});
`
  );
  const result = Bun.spawnSync(
    [
      "node_modules/.bin/vitest",
      "run",
      "--root",
      root,
      "--config",
      config,
      "--reporter=json",
      `--outputFile=${output}`,
    ],
    {
      cwd: root,
      env: { ...process.env, TZ: zone, LANG: "en_US.utf8" },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  let report: any;
  try {
    report = JSON.parse(readFileSync(output, "utf8"));
  } catch {
    throw new Error(`vitest produced no report in ${zone}:\n${result.stderr}\n${result.stdout}`);
  }
  const statuses = new Map<string, string>();
  for (const file of report.testResults) {
    const name = relative(dir, file.name);
    if (file.assertionResults.length === 0) statuses.set(`${name} > (file)`, file.status);
    for (const a of file.assertionResults) statuses.set(`${name} > ${a.fullName}`, a.status);
  }
  return statuses;
}

const { rewrites, files, total } = await rewriteCopy();
console.log(`${rewrites} exact rewrites in ${files} of ${total} files`);
const passed = (statuses: Map<string, string>) =>
  [...statuses.values()].filter((s) => s === "passed").length;
let failed = false;
for (const zone of zones) {
  const before = runVitest(zone, source, false);
  const after = runVitest(zone, join(work, "src"), true);
  const regressions = [...before]
    .filter(([test, status]) => status === "passed" && after.get(test) !== "passed")
    .map(([test]) => test);
  console.log(
    `${zone.padEnd(20)} ${passed(before)} of ${before.size} tests pass before the rewrites, ` +
      `${passed(after)} of ${after.size} after` +
      (regressions.length === 0 ? "" : `: ${regressions.length} regression(s)`)
  );
  for (const test of regressions) console.log(`  ${test}`);
  if (regressions.length > 0) failed = true;
}
console.log(
  failed ? "FAILED: the rewrites break tests that passed" : "OK: every passing test still passes"
);
process.exit(failed ? 1 : 0);
