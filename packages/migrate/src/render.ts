// Applies selected rewrites to a file. The new text is rebuilt bottom-up from slices of the
// original, so everything outside a rewritten expression keeps its exact formatting and comments.

import { SyntaxKind, type Node } from "typescript/unstable/ast";
import type { FileInfo, Renderer, Use } from "./analyze.js";
import type { Outcome } from "./rules.js";

const assignments = new Set<number>([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Whether an expression of any precedence can replace `node` without parentheses. */
function standsAlone(node: Node): boolean {
  const parent = node.parent as any;
  if (parent === undefined) return true;
  switch (parent.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.ExpressionStatement:
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.TemplateSpan:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.IfStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.ForStatement:
    case SyntaxKind.CaseClause:
    case SyntaxKind.SwitchStatement:
    case SyntaxKind.ThrowStatement:
    case SyntaxKind.SpreadElement:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.JsxExpression:
      return true;
    case SyntaxKind.ArrowFunction:
      return parent.body === node;
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
      return parent.expression !== node;
    case SyntaxKind.ConditionalExpression:
      return parent.condition !== node;
    case SyntaxKind.BinaryExpression: {
      const op = parent.operatorToken.kind;
      return (
        op === SyntaxKind.AmpersandAmpersandToken ||
        op === SyntaxKind.BarBarToken ||
        op === SyntaxKind.QuestionQuestionToken ||
        op === SyntaxKind.CommaToken ||
        (assignments.has(op) && parent.right === node)
      );
    }
    default:
      return false;
  }
}

function childrenOf(node: Node): Node[] {
  const out: Node[] = [];
  node.forEachChild(
    (child) => {
      out.push(child);
    },
    (array) => {
      out.push(...array);
    }
  );
  return out.sort((a, b) => a.pos - b.pos);
}

/**
 * The file with `uses` rewritten. With `whole`, the project no longer uses the library, so its
 * imports go too, with dayjs.extend(plugin) (@momentum-js/luxon/polyfill becomes
 * temporal-polyfill's global entry).
 */
export function renderFile(file: FileInfo, uses: readonly Use[], whole: boolean): string {
  const sf = file.sourceFile;
  const text = sf.text;
  const primary = new Map<Node, Use>();
  const wrappers = new Map<Node, Use[]>();
  for (const u of uses) {
    if (u.file !== file.path || u.kind === "implicit" || u.kind === "module" || u.kind === "escape")
      continue;
    if (u.kind === "valueOf" || u.kind === "toString")
      wrappers.set(u.node, [...(wrappers.get(u.node) ?? []), u]);
    else primary.set(u.node, u);
  }
  const replaced = new Map<Node, string>();
  if (whole)
    for (const i of file.imports)
      replaced.set(
        i.node,
        i.module === "@momentum-js/luxon/polyfill" ? 'import "temporal-polyfill/global";' : ""
      );
  if (primary.size === 0 && wrappers.size === 0 && replaced.size === 0) return text;

  const marked = new Set<Node>();
  for (const n of [...primary.keys(), ...wrappers.keys(), ...replaced.keys()])
    for (let p: Node | undefined = n; p !== undefined && !marked.has(p); p = p.parent)
      marked.add(p);
  const precedence = new Map<Node, "member" | "expression">();

  const settle = (node: Node, o: Outcome, what: string): string => {
    if (o.kind !== "rewrite") throw new Error(`${what} cannot be rewritten: ${o.reason}`);
    if (o.precedence === "expression" && !standsAlone(node)) {
      precedence.set(node, "member");
      return `(${o.text})`;
    }
    precedence.set(node, o.precedence);
    return o.text;
  };
  const paren = (node: Node, t: string) => (precedence.get(node) === "expression" ? `(${t})` : t);

  const zonedOf = (n: Node): string | undefined => {
    const use = primary.get(n);
    if (use === undefined) return undefined;
    const o = use.compute(renderer);
    return o.kind === "rewrite" ? o.zoned : undefined;
  };
  const renderer: Renderer = {
    text: (n) => render(n),
    operand: (n) => paren(n, render(n)),
    zonedOf,
  };

  function render(node: Node): string {
    let out = inner(node);
    for (const w of wrappers.get(node) ?? []) {
      const current = out;
      const o = w.compute({
        text: (n) => (n === node ? current : render(n)),
        operand: (n) => (n === node ? paren(node, current) : renderer.operand(n)),
        zonedOf,
      });
      out = settle(node, o, w.snippet);
    }
    return out;
  }

  function inner(node: Node): string {
    const use = primary.get(node);
    if (use !== undefined) return settle(node, use.compute(renderer), use.snippet);
    if (!marked.has(node)) return text.slice(node.getStart(sf), node.end);
    const isFile = node.kind === SyntaxKind.SourceFile;
    let cursor = isFile ? 0 : node.getStart(sf);
    let out = "";
    for (const child of childrenOf(node)) {
      if (!marked.has(child)) continue;
      const start = child.getStart(sf);
      const replacement = replaced.get(child);
      if (replacement !== undefined) {
        out += text.slice(cursor, start) + replacement;
        cursor = child.end;
        if (replacement === "") {
          if (text.startsWith("\r\n", cursor)) cursor += 2;
          else if (text[cursor] === "\n") cursor += 1;
          // no blank line left behind at the top of the file or doubled with the one before
          if ((out === "" || out.endsWith("\n\n")) && text[cursor] === "\n") cursor += 1;
        }
        continue;
      }
      out += text.slice(cursor, start) + render(child);
      cursor = child.end;
    }
    return out + text.slice(cursor, isFile ? text.length : node.end);
  }

  return render(sf);
}
