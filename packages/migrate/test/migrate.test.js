/* global test expect describe */
// End-to-end checks of the migration tool (migrate/cli.ts), run as a subprocess on copies of the
// projects in packages/migrate/test/fixtures/migrate: the report, the rewritten files (compared with the
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(__dirname, "../../..");
const fixtures = join(repo, "packages/migrate/test/fixtures/migrate");
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
          paths: {
            "@momentum-js/luxon": [join(repo, "packages/luxon/src/momentum.ts")],
            dayjs: [join(repo, "node_modules/dayjs")],
            "dayjs/*": [join(repo, "node_modules/dayjs/*")],
            "date-fns": [join(repo, "node_modules/date-fns")],
          },
        },
        include: ["src"],
      })
    );
  else {
    // momentum installed as a package, as a JavaScript project would have it
    mkdirSync(join(dir, "node_modules/@momentum-js/luxon"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules/@momentum-js/luxon/package.json"),
      JSON.stringify({
        name: "@momentum-js/luxon",
        type: "module",
        exports: { ".": "./index.ts" },
        types: "./index.ts",
      })
    );
    writeFileSync(
      join(dir, "node_modules/@momentum-js/luxon/index.ts"),
      `export * from ${JSON.stringify(join(repo, "packages/luxon/src/momentum.ts"))};\n`
    );
    // and Day.js and date-fns, as installed
    symlinkSync(join(repo, "node_modules/dayjs"), join(dir, "node_modules/dayjs"));
    symlinkSync(join(repo, "node_modules/date-fns"), join(dir, "node_modules/date-fns"));
  }
  return dir;
}

const run = (command, args, cwd = repo) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TZ: "America/New_York" },
  });
const cli = (...args) => run("bun", [join(repo, "packages/migrate/src/cli.ts"), ...args]);
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

describe("a Day.js project", () => {
  test(
    "switches completely: the rewrites, dayjs and its plugins gone, the same values",
    () => {
      const dir = copy("dayjs");
      try {
        const r = report(dir);
        expect(r.status).toBe(0);
        expect(r.fullSwitch).toBe(true);
        expect(r.counts).toEqual({ uses: 17, exact: 17, accepted: 0, pending: 0, leftOff: 0 });
        const before = exportsOf(dir, "src/app.ts");
        const result = cli("apply", dir);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(readFileSync(join(dir, "src/app.ts"), "utf8")).toBe(expected("dayjs", "app.ts"));
        expect(run("bun", ["check", "-p", dir, "--no-pretty"]).status).toBe(0);
        expect(exportsOf(dir, "src/app.ts")).toEqual(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    timeout
  );
});

describe("a date-fns project", () => {
  // every Date argument's rewrite carries invalid-throws, format's fixed pattern date-fns-years
  const accept = "--accept=invalid-throws,date-fns-years";

  test(
    "check says which differences stand in the way",
    () => {
      const dir = copy("date-fns");
      try {
        const strict = report(dir);
        expect(strict.status).toBe(1);
        expect(strict.counts).toEqual({ uses: 10, exact: 2, accepted: 0, pending: 8, leftOff: 0 });
        expect(strict.blockingDifferences).toEqual({ "invalid-throws": 8, "date-fns-years": 1 });
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
    "apply rewrites everything, nested calls as one chain, drops date-fns, type-checks and computes the same values",
    () => {
      const dir = copy("date-fns");
      try {
        const before = exportsOf(dir, "src/app.ts");
        const result = cli("apply", dir, accept);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(readFileSync(join(dir, "src/app.ts"), "utf8")).toBe(expected("date-fns", "app.ts"));
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
  "a JavaScript Day.js project: `typeof dayjs` is Day.js, and its Duration is not momentum's",
  () => {
    const dir = copy("dayjs-javascript", { tsconfig: false });
    try {
      const r = report(dir);
      expect(r.inferredTypes).toBe(true);
      expect(r.counts).toEqual({ uses: 8, exact: 7, accepted: 0, pending: 0, leftOff: 1 });
      expect(r.uses.filter((u) => u.subject === "dayjs()")).toHaveLength(2);
      // the duration plugin's Duration is Day.js's, not momentum's
      expect(r.uses.filter((u) => u.replacement === null).map((u) => u.subject)).toEqual([
        "Dayjs.duration",
      ]);
      expect(r.uses.some((u) => u.subject.startsWith("Duration"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  timeout
);

describe("the published command, @momentum-js/migrate", () => {
  test(
    "built for Node, it reports what the source does, with native Temporal and with the polyfill",
    () => {
      expect(run("bun", [join(repo, "packages/migrate/scripts/build.ts")]).status).toBe(0);
      const node = process.versions.bun === undefined ? process.execPath : "node";
      const bin = join(repo, "packages/migrate/build/cli.js");
      // --no-harmony-temporal removes Node's Temporal, so the command loads temporal-polyfill
      expect(run(node, ["--no-harmony-temporal", "-p", "typeof Temporal"]).stdout.trim()).toBe(
        "undefined"
      );
      const dir = copy("partial");
      try {
        const source = cli("check", dir, "--json");
        for (const flags of [[], ["--no-harmony-temporal"]]) {
          const published = run(node, [...flags, bin, "check", dir, "--json"]);
          expect([published.status, JSON.parse(published.stdout)]).toEqual([
            source.status,
            JSON.parse(source.stdout),
          ]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    timeout
  );

  test("is versioned in lockstep with the library", () => {
    const version = (path) => JSON.parse(readFileSync(join(repo, path), "utf8")).version;
    expect(version("packages/migrate/package.json")).toBe(version("packages/luxon/package.json"));
  });
});
