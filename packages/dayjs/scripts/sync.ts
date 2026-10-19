// Vendors Day.js's source and test suite into packages/dayjs, the reference for the migration tool's Day.js
// rules: packages/migrate/scripts/test-dayjs-suite.ts runs the suite against this source before and after the tool's
// rewrites. src/, types/ and LICENSE are copied as they are. The tests import the source by relative
// paths (`../src`, `../../src/plugin/utc`, `../../src/constant`); those become the entry points of
// the dayjs package (`dayjs`, `dayjs/plugin/utc`, `dayjs/esm/constant`), which is how a project
// imports Day.js and how the tool recognizes it, and the suite's Jest configuration maps them back
// to the vendored source. Two adaptations to Jest 29: `jest.genMockFunction`, gone since Jest 26,
// becomes `jest.fn`, and the array-named cases of plugin/arraySupport.test.js get String() around
// their names. Two files stay out: test/__mocks__/dayjs.js, which the module mapping replaces, and
// test/browser.spec.js, a Karma test.
//
// Usage: bun packages/dayjs/scripts/sync.ts [path-to-dayjs-checkout]   (default: ../dayjs)

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const dayjsRoot = resolve(
  process.argv[2] ?? join(import.meta.dir, "..", "..", "..", "..", "dayjs")
);
const targetDir = join(import.meta.dir, "..");

const skipped = new Set(["__mocks__/dayjs.js", "browser.spec.js"]);

/** The entry point of the dayjs package for a path under Day.js's src/. */
function entryPoint(subpath: string): string {
  if (subpath === "") return "dayjs";
  if (/^\/(plugin|locale)\//.test(subpath)) return `dayjs${subpath.replace(/\/index$/, "")}`;
  return `dayjs/esm${subpath}`; // the internals: constant, utils
}

function rewriteImports(text: string): string {
  return text.replace(
    /(\bfrom\s+|\bimport\s+|\brequire\()(["'])(?:\.\.\/)+src((?:\/[^"']+)?)\2/g,
    (_, lead: string, quote: string, subpath: string) =>
      `${lead}${quote}${entryPoint(subpath)}${quote}`
  );
}

function adaptToJest29(text: string): string {
  return text
    .replace(/\bjest\.genMockFunction\b/g, "jest.fn")
    .replace(/\bit\(testArr,/g, "it(String(testArr),");
}

for (const dir of ["src", "types"]) {
  rmSync(join(targetDir, dir), { recursive: true, force: true });
  cpSync(join(dayjsRoot, dir), join(targetDir, dir), { recursive: true });
}
cpSync(join(dayjsRoot, "LICENSE"), join(targetDir, "LICENSE"));

rmSync(join(targetDir, "test"), { recursive: true, force: true });
const glob = new Bun.Glob("**/*");
let copied = 0;
for await (const relative of glob.scan({ cwd: join(dayjsRoot, "test") })) {
  if (skipped.has(relative)) continue;
  const text = await Bun.file(join(dayjsRoot, "test", relative)).text();
  const destination = join(targetDir, "test", relative);
  mkdirSync(dirname(destination), { recursive: true });
  await Bun.write(destination, adaptToJest29(rewriteImports(text)));
  copied++;
}

console.log(
  `Copied src/, types/, LICENSE and ${copied} test files from ${dayjsRoot} to ${targetDir}`
);
