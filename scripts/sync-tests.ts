// Vendors Luxon's test suite into ./test so momentum is checked against the exact same
// expectations. Import paths are rewritten from Luxon's entry module to momentum's, and expected
// strings containing U+202F (narrow no-break space) are compared with Luxon's own
// `toMatchIgnoringWeirdSpaces` matcher: CLDR puts U+202F between a time and its AM/PM marker,
// and Node 26 and Bun replace it with a regular space.
//
// Usage: bun scripts/sync-tests.ts [path-to-luxon-checkout]   (default: ../luxon)

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const luxonRoot = resolve(process.argv[2] ?? join(import.meta.dir, "..", "..", "luxon"));
const sourceDir = join(luxonRoot, "test");
const targetDir = join(import.meta.dir, "..", "test");

// setupTests.js is owned by momentum
const skipped = new Set(["setupTests.js"]);

function rewriteImports(text: string): string {
  return text.replace(/(["'])((?:\.\.\/)+src\/)luxon\1/g, "$1$2momentum$1");
}

function rewriteMatchers(text: string): string {
  return text.replace(
    /\.toBe\((\s*"(?:[^"\\]|\\.)*(?:\\u202F|\u202F)(?:[^"\\]|\\.)*"\s*)\)/g,
    ".toMatchIgnoringWeirdSpaces($1)"
  );
}

const glob = new Bun.Glob("**/*.js");
let copied = 0;
for await (const relative of glob.scan({ cwd: sourceDir })) {
  if (skipped.has(relative)) continue;
  const text = rewriteMatchers(rewriteImports(await Bun.file(join(sourceDir, relative)).text()));
  const destination = join(targetDir, relative);
  mkdirSync(dirname(destination), { recursive: true });
  await Bun.write(destination, text);
  copied++;
}

console.log(`Copied ${copied} test files from ${sourceDir} to ${targetDir}`);
