/* global test expect describe */
// End-to-end checks of the migration tool (migrate/cli.ts), run as a subprocess on copies of the
// projects in test/momentum/fixtures/migrate: the report, the rewritten files (compared with the
// reviewed outputs in expected/), the type check of the result, and the values the fixture
// computes before and after the rewrite.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
const fixtures = join(repo, "test/momentum/fixtures/migrate");
const timeout = 60000;

function copy(name, { tsconfig = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `momentum-migrate-${name}-`));
  cpSync(join(fixtures, name, "src"), join(dir, "src"), { recursive: true });
  if (tsconfig)
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          lib: ["ESNext"],
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          paths: { momentum: [join(repo, "src/momentum.ts")] },
        },
        include: ["src"],
      })
    );
  else {
    // momentum installed as a package, as a JavaScript project would have it
    mkdirSync(join(dir, "node_modules/momentum"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules/momentum/package.json"),
      JSON.stringify({
        name: "momentum",
        type: "module",
        exports: { ".": "./index.ts" },
        types: "./index.ts",
      })
    );
    writeFileSync(
      join(dir, "node_modules/momentum/index.ts"),
      `export * from ${JSON.stringify(join(repo, "src/momentum.ts"))};\n`
    );
  }
  return dir;
}

const run = (command, args, cwd = repo) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TZ: "America/New_York" },
  });
const cli = (...args) => run("bun", [join(repo, "migrate/cli.ts"), ...args]);
const report = (dir, ...args) => {
  const result = cli("check", dir, "--json", ...args);
  return { status: result.status, ...JSON.parse(result.stdout) };
};
/** The values a fixture module exports, computed by Bun with momentum or with Temporal. */
const exportsOf = (dir, file) =>
  JSON.parse(
    run(
      "bun",
      [
        "-e",
        `const m = await import(${JSON.stringify(join(dir, file))}); console.log(JSON.stringify(m))`,
      ],
      dir
    ).stdout
  );
const expected = (name, file) => readFileSync(join(fixtures, name, "expected", file), "utf8");

describe("a project that cannot switch completely", () => {
  test(
    "check reports the exact rewrites, the documented differences and what is left",
    () => {
      const dir = copy("partial");
      try {
        const r = report(dir);
        expect(r.status).toBe(1);
        expect(r.fullSwitch).toBe(false);
        expect(r.counts).toEqual({ uses: 25, exact: 22, accepted: 0, pending: 2, leftOff: 1 });
        expect(r.blockingDifferences).toEqual({ "repeated-wall-time": 1, "json-format": 1 });
        const leftOff = r.uses.filter((u) => u.replacement === null && u.reason);
        expect(leftOff.map((u) => [u.subject, u.line])).toEqual([["DateTime#toFormat", 17]]);
        // the object with its own plus() and year is not momentum's
        expect(r.uses.some((u) => u.line >= 23)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    timeout
  );

  test(
    "apply rewrites the self-contained expressions only, and they compute the same values",
    () => {
      const dir = copy("partial");
      try {
        const before = exportsOf(dir, "src/app.ts");
        expect(cli("apply", dir).status).toBe(1);
        expect(readFileSync(join(dir, "src/app.ts"), "utf8")).toBe(expected("partial", "app.ts"));
        const after = exportsOf(dir, "src/app.ts");
        delete before.today;
        delete after.today;
        expect(after).toEqual(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    timeout
  );
});

describe("a project that can switch completely", () => {
  const accept = "--accept=repeated-wall-time,iso-format,duration-calendar-units";

  test(
    "check says which differences stand in the way",
    () => {
      const dir = copy("complete");
      try {
        const strict = report(dir);
        expect(strict.status).toBe(1);
        expect(Object.keys(strict.blockingDifferences).sort()).toEqual([
          "duration-calendar-units",
          "iso-format",
          "repeated-wall-time",
        ]);
        const accepted = report(dir, accept);
        expect(accepted.status).toBe(0);
        expect(accepted.fullSwitch).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    timeout
  );

  test(
    "apply rewrites everything, drops momentum, type-checks and computes the same values",
    () => {
      const dir = copy("complete");
      try {
        const before = exportsOf(dir, "src/app.ts");
        const result = cli("apply", dir, accept);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        for (const file of readdirSync(join(fixtures, "complete/expected")))
          expect(readFileSync(join(dir, "src", file), "utf8")).toBe(expected("complete", file));
        expect(run("bun", ["check", "-p", dir, "--no-pretty"]).status).toBe(0);
        expect(exportsOf(dir, "src/app.ts")).toEqual(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    timeout
  );
});

test(
  "a JavaScript project without a tsconfig.json is analysed with inferred types",
  () => {
    const dir = copy("javascript", { tsconfig: false });
    try {
      const r = report(dir);
      expect(r.inferredTypes).toBe(true);
      expect(
        r.uses.map((u) => [
          u.subject,
          u.replacement === null ? "none" : u.differences.join(",") || "exact",
        ])
      ).toEqual([
        ["DateTime.fromISO", "exact"],
        ["DateTime#toISODate", "exact"],
        ["DateTime#setZone", "exact"],
        ["DateTime#toFormat", "none"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  timeout
);

test(
  "rules lists the catalog and every documented difference",
  () => {
    const result = cli("rules");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DateTime#plus(): `.add(duration)`");
    expect(result.stdout).toContain("repeated-wall-time: calendar arithmetic");
  },
  timeout
);
