// Human and JSON reports of an analysis: whether the codemods complete the switch to native
// Temporal, and what is left when they don't.

import { relative } from "node:path";
import type { Analysis, Use, Verdict } from "./analyze.js";
import { differences, type DifferenceId } from "./differences.js";

const where = (analysis: Analysis, u: Use) =>
  `${relative(analysis.root, u.file)}:${u.line}:${u.column}`;

function group<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return new Map([...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])));
}

export function textReport(
  analysis: Analysis,
  v: Verdict,
  accepted: ReadonlySet<DifferenceId>,
  verbose: boolean
): string {
  const lines: string[] = [];
  const filesUsing = new Set(analysis.uses.map((u) => u.file)).size;
  lines.push(`momentum -> native Temporal: ${analysis.root}`);
  lines.push(
    `  ${analysis.files.length} files analysed, ${analysis.uses.length} uses of momentum in ${filesUsing} of them${analysis.inferred ? " (no tsconfig.json: types inferred)" : ""}`
  );
  if (analysis.uses.length === 0) {
    lines.push("", "momentum is not used: nothing to migrate.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(
    v.fullSwitch
      ? "Full switch: yes. `apply` replaces every use and removes momentum's imports."
      : "Full switch: no. `apply` would only rewrite self-contained expressions; the rest is listed below."
  );
  lines.push("");
  lines.push(`  ${v.exact.length} exact rewrites`);
  if (v.accepted.length > 0)
    lines.push(
      `  ${v.accepted.length} rewrites with accepted differences (${[...accepted].join(", ")})`
    );
  if (v.pending.length > 0) {
    lines.push(
      `  ${v.pending.length} rewrites with documented differences, applied only with --accept:`
    );
    for (const [id, count] of [...v.blockingDifferences].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${id} (${count}): ${differences[id].summary}`);
      if (verbose) {
        for (const u of v.pending.filter(
          (p) => p.outcome.kind === "rewrite" && p.outcome.differences.includes(id)
        ))
          lines.push(`      ${where(analysis, u)}  ${u.snippet}`);
      }
    }
  }
  if (v.leftOff.length > 0) {
    lines.push(`  ${v.leftOff.length} uses with no native replacement (left off):`);
    for (const [key, items] of group(
      v.leftOff,
      (u) => `${u.subject}\u0000${u.outcome.kind === "none" ? u.outcome.reason : ""}`
    )) {
      const [subject, reason] = key.split("\u0000");
      lines.push(`    ${subject} (${items.length}): ${reason}`);
      for (const u of verbose ? items : items.slice(0, 3))
        lines.push(`      ${where(analysis, u)}  ${u.snippet}`);
      if (!verbose && items.length > 3)
        lines.push(`      ... and ${items.length - 3} more (--verbose lists them all)`);
    }
  }
  if (!v.fullSwitch && v.leftOff.length === 0)
    lines.push(
      "",
      `Accepting ${[...v.blockingDifferences.keys()].join(", ")} would complete the switch.`
    );
  return lines.join("\n");
}

export function jsonReport(analysis: Analysis, v: Verdict, accepted: ReadonlySet<DifferenceId>) {
  return {
    root: analysis.root,
    files: analysis.files.length,
    inferredTypes: analysis.inferred,
    accepted: [...accepted],
    fullSwitch: v.fullSwitch,
    counts: {
      uses: analysis.uses.length,
      exact: v.exact.length,
      accepted: v.accepted.length,
      pending: v.pending.length,
      leftOff: v.leftOff.length,
    },
    blockingDifferences: Object.fromEntries(v.blockingDifferences),
    uses: analysis.uses.map((u) => ({
      file: relative(analysis.root, u.file),
      line: u.line,
      column: u.column,
      kind: u.kind,
      subject: u.subject,
      snippet: u.snippet,
      ...(u.outcome.kind === "none"
        ? { replacement: null, reason: u.outcome.reason }
        : {
            replacement: u.kind === "implicit" ? null : u.outcome.text,
            differences: u.outcome.differences,
          }),
    })),
  };
}
