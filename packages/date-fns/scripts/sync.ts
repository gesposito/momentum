// Vendors date-fns into packages/date-fns, the reference for the migration tool's date-fns rules:
// packages/migrate/scripts/test-date-fns-suite.ts runs its suite against this source before and
// after the tool's rewrites. From a checkout of date-fns's repository (a pnpm workspace), core/src,
// core/test, tz/src, tz/test, utc/src and the three LICENSE.md files are copied; sources, locales
// and the tz and utc packages as they are. In the core tests, the relative imports of the library
// (`./index.ts`, `../otherFunction/index.ts`, `../types.ts`) become the package's entry points
// (`date-fns`, `date-fns/locale`, `date-fns/fp`), which is how a project imports date-fns and how
// the tool recognizes it; the suite's vitest configuration maps them back to the vendored source.
// Imports of the internal `_lib` helpers stay relative. One file stays out:
// core/src/fp/_lib/convertToFP/test.ts, which tests an internal helper against lodash and fp-ts.
//
// Usage: bun packages/date-fns/scripts/sync.ts [path-to-date-fns-checkout]   (default: ../date-fns)

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const dateFnsRoot = resolve(
  process.argv[2] ?? join(import.meta.dir, "..", "..", "..", "..", "date-fns")
);
const targetDir = join(import.meta.dir, "..");

const copied: [string, string][] = [
  ["pkgs/core/test", "core/test"],
  ["pkgs/core/LICENSE.md", "core/LICENSE.md"],
  ["pkgs/tz/src", "tz/src"],
  ["pkgs/tz/test", "tz/test"],
  ["pkgs/tz/LICENSE.md", "tz/LICENSE.md"],
  ["pkgs/utc/src", "utc/src"],
  ["pkgs/utc/LICENSE.md", "utc/LICENSE.md"],
];
const skipped = new Set(["fp/_lib/convertToFP/test.ts"]);

/** The entry point of the date-fns package for a path a test file imports from within src/. */
function entryPoint(fromDir: string, specifier: string): string | null {
  // the directory of the imported module, relative to src/
  const target = relative(".", join(fromDir, dirname(specifier))).split("/");
  if (!/\/index\.ts$|\/types\.ts$/.test(specifier) && specifier !== "./index.ts") return null;
  if (specifier.endsWith("/types.ts")) return "date-fns"; // the root exports every type
  if (target[0] === "_lib" || target.includes("_lib")) return null;
  if (target[0] === "locale") return "date-fns/locale";
  if (target[0] === "fp") return "date-fns/fp";
  return "date-fns";
}

function rewriteImports(text: string, fromDir: string): string {
  return text.replace(
    /(\bfrom\s+)(["'])(\.[^"']+)\2/g,
    (match, lead: string, quote: string, specifier: string) => {
      const entry = entryPoint(fromDir, specifier);
      return entry === null ? match : `${lead}${quote}${entry}${quote}`;
    }
  );
}

for (const [from, to] of copied) {
  rmSync(join(targetDir, to), { recursive: true, force: true });
  cpSync(join(dateFnsRoot, from), join(targetDir, to), { recursive: true });
}

const srcFrom = join(dateFnsRoot, "pkgs/core/src");
const srcTo = join(targetDir, "core/src");
rmSync(srcTo, { recursive: true, force: true });
let files = 0;
let rewritten = 0;
for await (const file of new Bun.Glob("**/*").scan({ cwd: srcFrom })) {
  if (skipped.has(file)) continue;
  const destination = join(srcTo, file);
  mkdirSync(dirname(destination), { recursive: true });
  if (file.endsWith("/test.ts")) {
    const text = await Bun.file(join(srcFrom, file)).text();
    const next = rewriteImports(text, dirname(file));
    if (next !== text) rewritten++;
    await Bun.write(destination, next);
  } else {
    cpSync(join(srcFrom, file), destination);
  }
  files++;
}

console.log(
  `Copied core/test, tz, utc, the licenses and ${files} core/src files (${rewritten} test files with their imports pointed at the package) from ${dateFnsRoot} to ${targetDir}`
);
