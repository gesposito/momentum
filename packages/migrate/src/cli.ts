// momentum's migration tool: reports whether a project can switch from momentum (or Luxon) to
// native Temporal, and applies the rewrites that have a direct native replacement. Published as the
// `momentum-migrate` command of @momentum-js/migrate (migrate/bin.ts, built by
// scripts/build-migrate.ts); in this repository `bun run migrate` runs this file.
//
//   momentum-migrate check [directory] [--accept=a,b|all] [--project=tsconfig.json] [--json] [--verbose]
//   momentum-migrate apply [directory] [--accept=a,b|all] [--project=tsconfig.json] [--dry-run]
//   momentum-migrate rules
//
// `check` exits with 0 when the codemods complete the switch, 1 when something is left.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { analyze, defaultModules, selectRewrites, verdict } from "./analyze.js";
import { differenceIds, differences, type DifferenceId } from "./differences.js";
import { loadProject } from "./project.js";
import { renderFile } from "./render.js";
import { jsonReport, textReport } from "./report.js";
import { allRules } from "./rules.js";

const usage = `usage: momentum-migrate <check|apply|rules> [directory] [options]
  --accept=a,b|all     apply rewrites with these documented differences (see "rules")
  --project=path       tsconfig.json to use (default: <directory>/tsconfig.json, else inferred)
  --modules=a,b        modules to migrate from (default: ${defaultModules.join(",")})
  --json               machine-readable report (check)
  --verbose            list every location (check)
  --dry-run            print the changes instead of writing them (apply)`;

function parse(argv: string[]) {
  const [command, ...rest] = argv;
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of rest) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (m) options.set(m[1], m[2] ?? "true");
    else positional.push(arg);
  }
  return { command, directory: positional[0] ?? ".", options };
}

function acceptedDifferences(value: string | undefined): Set<DifferenceId> {
  if (value === undefined) return new Set();
  if (value === "all") return new Set(differenceIds);
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids)
    if (!(id in differences))
      throw new Error(`unknown difference "${id}"; see \`bun migrate/cli.ts rules\``);
  return new Set(ids as DifferenceId[]);
}

function rulesText(): string {
  const lines = ["Rules (momentum, Luxon, Day.js or date-fns member -> native replacement):", ""];
  for (const rule of allRules().sort((a, b) =>
    `${a.owner}${a.name}`.localeCompare(`${b.owner}${b.name}`)
  ))
    lines.push(
      `  ${rule.owner}${rule.static ? "." : "#"}${rule.name}${rule.form === "call" ? "()" : ""}: ${rule.doc}`
    );
  lines.push("", "Documented differences (accept with --accept=id,...):", "");
  for (const id of differenceIds)
    lines.push(`  ${id}: ${differences[id].summary}`, `      ${differences[id].detail}`);
  return lines.join("\n");
}

/** A unified diff of one file's rewrite, from the system's diff. */
function diff(path: string, before: string, after: string, label: string): string {
  const temp = mkdtempSync(join(tmpdir(), "momentum-migrate-diff-"));
  try {
    const a = join(temp, "before");
    const b = join(temp, "after");
    writeFileSync(a, before);
    writeFileSync(b, after);
    const result = spawnSync(
      "diff",
      ["-u", "--label", `a/${label}`, "--label", `b/${label}`, a, b],
      { encoding: "utf8" }
    );
    return result.stdout || `(diff unavailable for ${path})`;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const { command, directory, options } = parse(process.argv.slice(2));
  if (command === "rules") {
    console.log(rulesText());
    return 0;
  }
  if (command !== "check" && command !== "apply") {
    console.error(usage);
    return 2;
  }
  const accepted = acceptedDifferences(options.get("accept"));
  const modules = options.get("modules")?.split(",") ?? defaultModules;
  const loaded = await loadProject(directory, options.get("project"));
  try {
    const analysis = await analyze(loaded, modules);
    const v = verdict(analysis, accepted);
    if (command === "check") {
      if (options.has("json"))
        console.log(JSON.stringify(jsonReport(analysis, v, accepted), null, 2));
      else console.log(textReport(analysis, v, accepted, options.has("verbose")));
      return v.fullSwitch ? 0 : 1;
    }

    const { uses, whole } = selectRewrites(analysis, accepted);
    const changed: { path: string; before: string; after: string }[] = [];
    for (const file of analysis.files) {
      const after = renderFile(file, uses, whole);
      if (after !== file.sourceFile.text)
        changed.push({ path: file.path, before: file.sourceFile.text, after });
    }
    const rewritten = uses.filter((u) => u.kind !== "implicit" && u.kind !== "escape").length;
    console.log(
      `${whole ? "Whole project" : "Self-contained expressions only"}: ${rewritten} rewrites in ${changed.length} files.`
    );
    if (options.has("dry-run")) {
      for (const c of changed)
        console.log(diff(c.path, c.before, c.after, relative(analysis.root, c.path)));
      return 0;
    }
    if (changed.length === 0) return v.fullSwitch ? 0 : 1;
    const errorsBefore = new Map<string, number>();
    for (const c of changed)
      errorsBefore.set(
        c.path,
        (await loaded.project.program.getSemanticDiagnostics(c.path)).length
      );
    for (const c of changed) writeFileSync(c.path, c.after);
    const project = await loaded.reload(changed.map((c) => c.path));
    let newErrors = 0;
    for (const c of changed) {
      const diagnostics = await project.program.getSemanticDiagnostics(c.path);
      const added = diagnostics.length - (errorsBefore.get(c.path) ?? 0);
      if (added > 0) {
        newErrors += added;
        console.error(
          `${relative(analysis.root, c.path)}: ${added} new type errors, for example: ${diagnostics[0]?.text ?? ""}`
        );
      }
    }
    if (newErrors > 0)
      console.error("\nThe rewrites type-check worse than the original; see the errors above.");
    const after = await analyze({ ...loaded, project }, modules);
    console.log(`\n${textReport(after, verdict(after, accepted), accepted, false)}`);
    return newErrors > 0
      ? 2
      : verdict(after, accepted).fullSwitch || after.uses.length === 0
        ? 0
        : 1;
  } finally {
    await loaded.close();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  return 2;
});
