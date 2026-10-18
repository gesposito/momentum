// Runs Luxon's suite under `bun test` and compares the failing tests with the allowlist in
// test/bun-known-failures.txt, which lists failures caused by Bun's engine (see
// docs/bun-compatibility.md), some of them on one platform only. New failures fail the run;
// fixed ones are reported so the list can be trimmed. Extra arguments are passed to `bun test`.

const allowlist = new URL("../test/bun-known-failures.txt", import.meta.url);
// names before the first [platform] line fail everywhere, later ones only on that platform
const known = new Set<string>();
let platform: string | undefined;
for (const line of (await Bun.file(allowlist).text()).split("\n").map((line) => line.trim())) {
  if (line === "" || line.startsWith("#")) continue;
  const section = /^\[(\w+)\]$/.exec(line);
  if (section !== null) platform = section[1];
  else if (platform === undefined || platform === process.platform) known.add(line);
}

const proc = Bun.spawn(["bun", "test", ...process.argv.slice(2)], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, TZ: "America/New_York" },
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout, stderr] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]);
await proc.exited;

const output = `${stdout}\n${stderr}`;

// a crash, a module that fails to load or an empty run must not pass as "no unexpected failures"
const ran = Number(output.match(/^Ran (\d+) tests? /m)?.[1] ?? 0);
if (ran === 0 || (proc.exitCode !== 0 && !/^\(fail\) /m.test(output))) {
  console.error(output.slice(-2000).trim());
  console.error(`\nbun test exited with code ${proc.exitCode} without completing the suite.`);
  process.exit(1);
}
const failing = new Set(
  [...output.matchAll(/^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?$/gm)].map((match) => match[1])
);
// an error outside any test (a test file that fails to load, say) is never an engine difference
const errors = Number(output.match(/^ *(\d+) errors?$/m)?.[1] ?? 0);
const summary = output.match(/^ *\d+ pass\n *\d+ fail\n[\s\S]*?Ran .*$/m)?.[0] ?? output.slice(-400);

const unexpected = [...failing].filter((name) => !known.has(name));
const fixed = [...known].filter((name) => !failing.has(name));

console.log(summary.trim());
if (fixed.length > 0) {
  console.log(`\n${fixed.length} known failure(s) now pass; remove them from test/bun-known-failures.txt:`);
  for (const name of fixed) console.log(`  ${name}`);
}
if (unexpected.length > 0) {
  console.error(`\n${unexpected.length} unexpected failure(s):`);
  for (const name of unexpected) console.error(`  ${name}`);
}
if (errors > 0) {
  console.error(`\n${errors} error(s) outside tests, reported as "Unhandled error between tests".`);
}
if (unexpected.length > 0 || errors > 0) process.exit(1);
console.log(`\n${failing.size} failure(s), all known engine differences.`);
