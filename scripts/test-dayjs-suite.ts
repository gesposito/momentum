// Runs Day.js's own test suite (dayjs/test, vendored by scripts/sync-dayjs.ts) against the vendored
// source, then applies the migration tool's exact rewrites to a copy of the suite and runs that too:
// every test that passed must still pass. Each file is analysed as a project of its own, since some
// files load badMutable, which stops every rewrite in a project. The rewritten copy runs with
// Temporal from temporal-polyfill: 80 of the 93 files freeze the clock with MockDate.set(new Date())
// and compare dayjs() with moment(), and the polyfill's Temporal.Now reads Date.now() as Day.js
// does, where native Temporal.Now would be ahead by the time elapsed (docs/migrate.md, Limits).
// Day.js's tests follow the system zone, so each zone is a pair of Jest runs.
//
//   bun run test:dayjs-suite                   America/New_York and Pacific/Auckland
//   bun run test:dayjs-suite Europe/London     the zones given
//
// The rewritten copy stays in dayjs/.rewritten for inspection.

import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { API } from "typescript/unstable/async";
import { analyze, defaultModules, selectRewrites } from "../migrate/analyze.js";
import type { DifferenceId } from "../migrate/differences.js";
import type { LoadedProject } from "../migrate/project.js";
import { renderFile } from "../migrate/render.js";

const root = join(import.meta.dir, "..");
const suite = join(root, "dayjs");
const work = join(suite, ".rewritten");
const zones =
  process.argv.length > 2 ? process.argv.slice(2) : ["America/New_York", "Pacific/Auckland"];
const resolveFrom = (specifier: string) => Bun.resolveSync(specifier, root);

/** Copies the suite into dayjs/.rewritten and applies the exact rewrites, file by file. */
async function rewriteCopy(): Promise<{ rewrites: number; files: number; total: number }> {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, ".tsconfigs"), { recursive: true });
  cpSync(join(suite, "test"), join(work, "test"), { recursive: true });
  // two tests read ../../src and ../../types relative to their own location
  for (const dir of ["src", "types"]) symlinkSync(`../${dir}`, join(work, dir));
  writeFileSync(
    join(work, "setup.cjs"),
    "// temporal-polyfill's Temporal.Now follows MockDate, as Day.js does; native Temporal.Now would not\n" +
      'globalThis.Temporal = require("temporal-polyfill/implementation").Temporal;\n'
  );
  const tests = [...new Bun.Glob("**/*.js").scanSync({ cwd: join(work, "test") })].sort();
  // one project per file; the dayjs entry points resolve to the vendored types and internals
  const configs = tests.map((t, i) => {
    const config = join(work, ".tsconfigs", `${i}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          noEmit: true,
          skipLibCheck: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          types: [],
          paths: {
            dayjs: [join(suite, "types/index.d.ts")],
            "dayjs/plugin/*": [join(suite, "types/plugin/*")],
            "dayjs/locale/*": [join(suite, "types/locale/*")],
            "dayjs/esm/*": [join(suite, "src/*")],
          },
        },
        files: [join(work, "test", t)],
      })
    );
    return config;
  });
  const api = new API({ cwd: work });
  const snapshot = await api.updateSnapshot({ openProjects: configs });
  const accepted = new Set<DifferenceId>();
  let rewrites = 0;
  let files = 0;
  try {
    for (const [i, t] of tests.entries()) {
      const project = snapshot.getProject(configs[i]);
      if (project === undefined) throw new Error(`TypeScript could not load ${configs[i]}`);
      const path = join(work, "test", t);
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
  return { rewrites, files, total: tests.length };
}

/** Runs the suite under `testsRoot` in a zone; the status of each test, by file and name. */
function runJest(zone: string, testsRoot: string, rewritten: boolean): Map<string, string> {
  const output = join(work, `${rewritten ? "after" : "before"}-${zone.replace("/", "_")}.json`);
  const config = {
    rootDir: suite,
    roots: [testsRoot],
    testEnvironment: "node",
    testRegex: "test/(.*?/)?.*test\\.js$", // Day.js's own
    transform: {
      "\\.js$": [
        resolveFrom("babel-jest"),
        { presets: [[resolveFrom("@babel/preset-env"), { targets: { node: "current" } }]] },
      ],
    },
    // the dayjs entry points the tests import, as the vendored source
    moduleNameMapper: {
      "^dayjs$": join(suite, "src/index.js"),
      "^dayjs/plugin/(.*)$": join(suite, "src/plugin/$1/index.js"),
      "^dayjs/locale/(.*)$": join(suite, "src/locale/$1.js"),
      "^dayjs/esm/(.*)$": join(suite, "src/$1.js"),
    },
    // temporal-polyfill ships ESM only; babel turns it into CJS for Jest's module system
    transformIgnorePatterns: ["/node_modules/(?!temporal-polyfill|temporal-spec|temporal-utils)"],
    setupFiles: rewritten ? [join(work, "setup.cjs")] : [],
  };
  const result = Bun.spawnSync(
    [
      "node_modules/.bin/jest",
      "--config",
      JSON.stringify(config),
      "--json",
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
    throw new Error(`Jest produced no report in ${zone}:\n${result.stderr}`);
  }
  const statuses = new Map<string, string>();
  for (const file of report.testResults) {
    const name = relative(testsRoot, file.name);
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
  const before = runJest(zone, join(suite, "test"), false);
  const after = runJest(zone, join(work, "test"), true);
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
