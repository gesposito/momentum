// Finds every use of momentum (or Luxon) in a project and decides, with the rules of ./rules.ts,
// what replaces it. Types come from TypeScript's checker, so a method call is attributed to
// momentum only when its receiver really is a momentum value, wherever that value comes from.
//
// Pass 1 walks each file once, asks the checker for the types of every interesting expression in
// one batch, and records uses plus the project-wide facts that some rules depend on (Settings
// assignments, locale configuration). Pass 2 computes each use's outcome with those facts.

import { dirname, relative } from "node:path";
import { SyntaxKind, type Node, type SourceFile } from "typescript/unstable/ast";
import {
  TypeFlags,
  type Type,
  type TypeReference,
  type UnionType,
} from "typescript/unstable/async";
import type { DifferenceId } from "./differences.js";
import type { LoadedProject } from "./project.js";
import {
  classNotes,
  compareOutcome,
  memberOutcome,
  presets,
  toStringOutcome,
  typeReplacement,
  valueOfOutcome,
  type Arg,
  type ClassName,
  type Facts,
  type Outcome,
  type Static,
} from "./rules.js";

export const defaultModules = [
  "@momentum-js/luxon",
  "@momentum-js/luxon/polyfill",
  "date-fns",
  "@date-fns/tz",
  "@date-fns/utc",
  "luxon",
  "dayjs",
];

const classNames: ReadonlySet<string> = new Set<ClassName>([
  "DateTime",
  "Duration",
  "Interval",
  "Info",
  "Settings",
  "Zone",
  "IANAZone",
  "FixedOffsetZone",
  "SystemZone",
  "InvalidZone",
  "Dayjs",
  "DayjsTimezone",
]);

export type UseKind =
  /** a property read or method call on a momentum value or class */
  | "member"
  /** `a < b` between two DateTimes */
  | "compare"
  /** an implicit valueOf: arithmetic, `+x`, `Number(x)`, `new Date(x)`, comparisons with numbers */
  | "valueOf"
  /** an implicit toString: template literals, `String(x)` */
  | "toString"
  /** an implicit conversion that changes output without a rewrite: JSON.stringify, console */
  | "implicit"
  /** a momentum value handed to code the analysis cannot follow */
  | "escape"
  /** a momentum type in an annotation */
  | "type"
  /** a momentum class used as a value (instanceof, passed around) */
  | "class"
  /** an import, re-export or require of momentum */
  | "module";

export interface Use {
  kind: UseKind;
  file: string;
  line: number;
  column: number;
  /** The use's source text on one line. */
  snippet: string;
  /** What is used, as the report groups it: "DateTime#plus", "DateTime.now", "a < b", ... */
  subject: string;
  outcome: Outcome;
  node: Node;
  /** The momentum class of the value this use produces, if it produces one. */
  produces: ClassName | null;
  /** Momentum values this use consumes: its receiver, operands or momentum arguments. */
  inputs: readonly Node[];
  /** Recomputes the outcome from the rendered text of the use's parts. */
  compute: (render: Renderer) => Outcome;
  /** A test for momentum objects: only rewritten when the whole project converts. */
  partialBlocked?: boolean;
}

export interface Renderer {
  /** A node's text with nested rewrites applied. */
  text(node: Node): string;
  /** The same, parenthesized when a rewrite made it unfit to be followed by `.x`. */
  operand(node: Node): string;
  /** For a node rewritten to a Date made from a ZonedDateTime: that ZonedDateTime's text. */
  zonedOf(node: Node): string | undefined;
}

export interface FileInfo {
  path: string;
  sourceFile: SourceFile;
  quote: '"' | "'";
  /** Import declarations of momentum, with the module each one names. */
  imports: { node: Node; module: string }[];
}

export interface Analysis {
  root: string;
  files: FileInfo[];
  uses: Use[];
  facts: Facts;
  inferred: boolean;
}

interface Classified {
  owner: ClassName | null;
  /** The type's name in momentum's declarations, for types that are not classes. */
  name: string;
  isStatic: boolean;
}

const assignmentOperators = new Set<number>([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
]);
const relationalOperators = new Map<number, string>([
  [SyntaxKind.LessThanToken, "<"],
  [SyntaxKind.GreaterThanToken, ">"],
  [SyntaxKind.LessThanEqualsToken, "<="],
  [SyntaxKind.GreaterThanEqualsToken, ">="],
]);
/** Operators that never convert an object operand. */
const neutralOperators = new Set<number>([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.CommaToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.InKeyword,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);
const localeOptionKeys = ["locale", "numberingSystem", "outputCalendar"];
const localeSettings = new Set([
  "defaultLocale",
  "defaultNumberingSystem",
  "defaultOutputCalendar",
]);

/** The classes of Day.js; the others are momentum's (or Luxon's). */
const dayjsClasses: ReadonlySet<string> = new Set<ClassName>(["Dayjs", "DayjsTimezone"]);

/** Libraries whose callable export stands for a class: `typeof dayjs`, as JavaScript types it. */
const staticAliases: Readonly<Record<string, ClassName>> = { dayjs: "Dayjs" };

/** Static members that test for momentum objects: wrong while momentum objects still exist. */
const representationChecks = new Set([
  "DateTime.isDateTime",
  "Duration.isDuration",
  "Dayjs.isDayjs",
]);

const none = (reason: string): Outcome => ({ kind: "none", reason });

export function skipParentheses(node: Node): Node {
  let n = node;
  while (
    n.kind === SyntaxKind.ParenthesizedExpression ||
    n.kind === SyntaxKind.NonNullExpression ||
    n.kind === SyntaxKind.AsExpression ||
    n.kind === SyntaxKind.SatisfiesExpression
  )
    n = (n as any).expression;
  return n;
}

export async function analyze(
  loaded: LoadedProject,
  modules: readonly string[] = defaultModules
): Promise<Analysis> {
  const { project, root } = loaded;
  const checker = project.checker;
  const facts = { settings: new Set<string>(), localeConfigured: false };
  const files: FileInfo[] = [];
  const uses: (Omit<Use, "outcome" | "compute"> & {
    outcomeOf: () => Outcome;
    computeOf: (r: Renderer) => Outcome;
  })[] = [];
  /** The directories holding the libraries' declarations, and whether each is Day.js's. */
  const libraryDirs = new Map<string, boolean>();
  const ofDayjs = (s: string) => s === "dayjs" || s.startsWith("dayjs/");
  /** A listed module or one of its entry points, such as dayjs/plugin/utc. */
  const ofModules = (s: string) => modules.some((m) => s === m || s.startsWith(`${m}/`));
  const classifiedById = new Map<number, Classified | null>();

  /**
   * The types of many nodes, in one request when possible. TypeScript 7.0.2's API panics on the
   * type of some nodes, such as an empty array literal typed by a tuple with optional elements
   * (https://github.com/microsoft/TypeScript/issues/63869, fixed in 7.1); halving the batch
   * isolates them, and they get no type.
   */
  async function typesAt(nodes: Node[]): Promise<(Type | undefined)[]> {
    try {
      return await checker.getTypeAtLocation(nodes);
    } catch (error) {
      if (!String(error).includes("panic:")) throw error;
      if (nodes.length === 1) return [undefined];
      const half = Math.ceil(nodes.length / 2);
      return [...(await typesAt(nodes.slice(0, half))), ...(await typesAt(nodes.slice(half)))];
    }
  }

  async function classify(type: Type | undefined): Promise<Classified | null> {
    if (type === undefined) return null;
    const cached = classifiedById.get(type.id);
    if (cached !== undefined) return cached;
    let result: Classified | null = null;
    if (type.flags & TypeFlags.Union) {
      for (const member of await (type as UnionType).getTypes()) {
        const c = await classify(member);
        if (c) {
          result = c;
          break;
        }
      }
    } else if (type.flags & TypeFlags.Object) {
      const symbol = await type.getSymbol();
      const path = symbol?.declarations[0]?.path?.toLowerCase();
      const dir =
        path === undefined ? undefined : [...libraryDirs.keys()].find((d) => path.startsWith(d));
      if (dir !== undefined) {
        const printed = await checker.typeToString(type);
        const m = /^(typeof )?([\w$]+)(<.*>)?$/.exec(printed);
        // a class name counts in its own library only: Day.js's duration plugin has a Duration too
        const inDayjs = libraryDirs.get(dir)!;
        const own = (name: string): name is ClassName =>
          classNames.has(name) && dayjsClasses.has(name) === inDayjs;
        if (m)
          result = {
            owner: own(m[2])
              ? m[2]
              : m[1] !== undefined && inDayjs
                ? (staticAliases[m[2]] ?? null)
                : null,
            name: m[2],
            isStatic: m[1] !== undefined,
          };
        // dayjs is a function exported with `export =`: its type is the module's
        else if (inDayjs && /^typeof import\(".*[\\/]index\.d\.ts"\)$/.test(printed))
          result = { owner: "Dayjs", name: "dayjs", isStatic: true };
      }
    }
    classifiedById.set(type.id, result);
    return result;
  }

  const instanceOf = async (type: Type | undefined): Promise<ClassName | null> => {
    const c = await classify(type);
    return c && !c.isStatic ? c.owner : null;
  };

  /** A momentum class found inside a type: its properties, elements and union members. */
  const containedById = new Map<number, ClassName | null>();
  async function contained(type: Type | undefined, depth = 0): Promise<ClassName | null> {
    if (type === undefined || depth > 3) return null;
    const cached = containedById.get(type.id);
    if (cached !== undefined) return cached;
    containedById.set(type.id, null);
    let found = await instanceOf(type);
    if (found === null && type.flags & TypeFlags.Union)
      for (const member of await (type as UnionType).getTypes())
        if ((found = await contained(member, depth + 1))) break;
    if (found === null && type.flags & TypeFlags.Object) {
      const properties = await checker.getPropertiesOfType(type);
      if (properties.length <= 64)
        for (const property of properties) {
          if ((found = await contained(await checker.getTypeOfSymbol(property), depth + 1))) break;
        }
      if (
        found === null &&
        ((await checker.isArrayType(type)) || (await checker.isTupleType(type)))
      )
        for (const element of await checker.getTypeArguments(type as TypeReference))
          if ((found = await contained(element, depth + 1))) break;
    }
    containedById.set(type.id, found);
    return found;
  }

  // first the imports of every file: they tell where momentum's declarations live, and files
  // there (momentum's own source, when it sits inside the project) are not analysed
  const prepared: {
    file: FileInfo;
    importedNames: Set<string>;
    /** The module each imported name comes from. */
    importedFrom: Map<string, string>;
    /** The exported name behind each imported name (`import { addDays as plus }`). */
    importedAs: Map<string, string>;
    /** Namespace imports (`import * as fns from "date-fns"`), with their modules. */
    namespaces: Map<string, string>;
  }[] = [];
  for (const path of loaded.files) {
    const sourceFile = await project.program.getSourceFile(path);
    if (sourceFile === undefined) continue;
    const file: FileInfo = { path, sourceFile, quote: '"', imports: [] };
    const importedNames = new Set<string>();
    const importedFrom = new Map<string, string>();
    const importedAs = new Map<string, string>();
    const namespaces = new Map<string, string>();
    prepared.push({ file, importedNames, importedFrom, importedAs, namespaces });
    for (const statement of (sourceFile as any).statements as Node[]) {
      if (statement.kind !== SyntaxKind.ImportDeclaration) continue;
      const spec = (statement as any).moduleSpecifier;
      if (spec?.kind !== SyntaxKind.StringLiteral || !ofModules(spec.text)) continue;
      file.imports.push({ node: statement, module: spec.text });
      const clause = (statement as any).importClause;
      const bindings = clause?.namedBindings;
      for (const name of [
        clause?.name,
        bindings?.kind === SyntaxKind.NamespaceImport ? bindings.name : undefined,
        ...(bindings?.elements ?? []).map((e: any) => e.name),
      ])
        if (name) {
          importedNames.add(name.text);
          importedFrom.set(name.text, spec.text);
        }
      for (const e of bindings?.elements ?? [])
        importedAs.set(e.name.text, e.propertyName?.text ?? e.name.text);
      if (bindings?.kind === SyntaxKind.NamespaceImport)
        namespaces.set(bindings.name.text, spec.text);
    }
    // momentum's declarations live where the imported module and its bindings are declared;
    // following the bindings also finds them behind a module that re-exports momentum
    const bindingNodes: Node[] = [];
    const bindingModules: string[] = [];
    for (const i of file.imports) {
      const clause = (i.node as any).importClause;
      const names = [
        clause?.name,
        ...(clause?.namedBindings?.elements ?? []).map((e: any) => e.name),
      ];
      for (const name of names)
        if (name) {
          bindingNodes.push(name);
          bindingModules.push(i.module);
        }
    }
    const moduleSymbols = await checker.getSymbolAtLocation(
      file.imports.map((i) => (i.node as any).moduleSpecifier)
    );
    const bindingTypes = await checker.getTypeAtLocation(bindingNodes);
    const bindingSymbols = await Promise.all(bindingTypes.map((t) => t?.getSymbol()));
    // which library a directory belongs to follows from the module it was imported as
    const modulesOf = [...file.imports.map((i) => i.module), ...bindingModules];
    [...moduleSymbols, ...bindingSymbols].forEach((symbol, i) => {
      const p = symbol?.declarations[0]?.path;
      if (p) {
        const d = `${dirname(p).toLowerCase()}/`;
        libraryDirs.set(d, (libraryDirs.get(d) ?? false) || ofDayjs(modulesOf[i]));
      }
    });
  }
  const inLibrary = (path: string) =>
    [...libraryDirs.keys()].some((d) => path.toLowerCase().startsWith(d));

  for (const { file, importedNames, importedFrom, importedAs, namespaces } of prepared) {
    if (inLibrary(file.path)) continue;
    const { path, sourceFile } = file;
    const text = sourceFile.text;

    // one walk collects the expressions to type
    const props: Node[] = [];
    const binaries: Node[] = [];
    const unaries: Node[] = [];
    const spans: Node[] = [];
    const calls: Node[] = [];
    const typeRefs: Node[] = [];
    const idents: Node[] = [];
    const moduleUses: { node: Node; reason: string }[] = [];
    let single = 0;
    let double = 0;
    const visit = (node: Node): void => {
      switch (node.kind) {
        case SyntaxKind.ImportDeclaration:
          return;
        case SyntaxKind.ExportDeclaration: {
          const spec = (node as any).moduleSpecifier;
          if (spec?.kind === SyntaxKind.StringLiteral && ofModules(spec.text))
            moduleUses.push({
              node,
              reason: "re-exports momentum's API, which Temporal does not provide",
            });
          break;
        }
        case SyntaxKind.PropertyAccessExpression:
          props.push(node);
          break;
        case SyntaxKind.ElementAccessExpression: {
          const arg = (node as any).argumentExpression;
          if (
            arg?.kind === SyntaxKind.StringLiteral ||
            arg?.kind === SyntaxKind.NoSubstitutionTemplateLiteral
          )
            props.push(node);
          break;
        }
        case SyntaxKind.BinaryExpression:
          binaries.push(node);
          break;
        case SyntaxKind.PrefixUnaryExpression: {
          const op = (node as any).operator;
          if (
            op === SyntaxKind.PlusToken ||
            op === SyntaxKind.MinusToken ||
            op === SyntaxKind.TildeToken
          )
            unaries.push(node);
          break;
        }
        case SyntaxKind.TemplateSpan:
          spans.push(node);
          break;
        case SyntaxKind.CallExpression: {
          const callee = (node as any).expression;
          const [first] = (node as any).arguments ?? [];
          if (
            callee?.kind === SyntaxKind.Identifier &&
            callee.text === "require" &&
            first?.kind === SyntaxKind.StringLiteral &&
            ofModules(first.text)
          )
            moduleUses.push({ node, reason: "CommonJS require of momentum is not rewritten" });
          calls.push(node);
          break;
        }
        case SyntaxKind.NewExpression:
          calls.push(node);
          break;
        case SyntaxKind.TypeReference:
          typeRefs.push(node);
          break;
        case SyntaxKind.Identifier:
          if (importedNames.has((node as any).text)) idents.push(node);
          break;
        case SyntaxKind.StringLiteral:
          if (text[node.getStart(sourceFile)] === "'") single++;
          else double++;
          break;
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
    file.quote = single > double ? "'" : '"';
    if (libraryDirs.size === 0) {
      files.push(file);
      continue;
    }

    // types of everything that may hold a momentum value, in one request
    const queried = new Set<Node>();
    const ask = (n: Node | undefined) => {
      if (n !== undefined) queried.add(n);
    };
    const askObject = (n: Node, depth: number) => {
      const inner = skipParentheses(n);
      if (inner.kind !== SyntaxKind.ObjectLiteralExpression || depth > 2) return;
      for (const p of (inner as any).properties as Node[]) {
        const init =
          (p as any).initializer ??
          (p.kind === SyntaxKind.ShorthandPropertyAssignment ? (p as any).name : undefined);
        if (init) {
          ask(init);
          askObject(init, depth + 1);
        }
      }
    };
    for (const p of props) {
      ask((p as any).expression);
      ask(p);
      const parent = p.parent;
      if (parent?.kind === SyntaxKind.CallExpression && (parent as any).expression === p)
        ask(parent);
    }
    for (const b of binaries) {
      ask((b as any).left);
      ask((b as any).right);
    }
    for (const u of unaries) ask((u as any).operand);
    for (const s of spans) ask((s as any).expression);
    // a call of a library's callable export, such as dayjs(...)
    for (const c of calls) {
      const callee = skipParentheses((c as any).expression);
      if (callee?.kind === SyntaxKind.Identifier && importedNames.has((callee as any).text)) {
        ask(callee);
        ask(c);
      }
    }
    for (const c of calls)
      for (const a of (c as any).arguments ?? []) {
        // an empty array holds nothing, and its type can make TypeScript 7.0.2 panic (typesAt)
        if (a.kind === SyntaxKind.ArrayLiteralExpression && (a as any).elements.length === 0)
          continue;
        ask(a);
        askObject(a, 0);
      }
    for (const t of typeRefs) ask(t);
    for (const i of idents) ask(i);
    const list = [...queried];
    const types = await typesAt(list);
    const typeOf = new Map<Node, Type | undefined>();
    list.forEach((n, i) => typeOf.set(n, types[i]));

    const position = (node: Node) => {
      const start = node.getStart(sourceFile);
      let line = 1;
      let lineStart = 0;
      for (let i = text.indexOf("\n"); i !== -1 && i < start; i = text.indexOf("\n", i + 1)) {
        line++;
        lineStart = i + 1;
      }
      const snippet = text.slice(start, node.end).replace(/\s+/g, " ");
      return {
        line,
        column: start - lineStart + 1,
        snippet: snippet.length > 90 ? `${snippet.slice(0, 87)}...` : snippet,
      };
    };
    const original = (n: Node) => text.slice(n.getStart(sourceFile), n.end);

    /** What is statically known about an expression, its text given by `textOf`. */
    const staticOf = async (node: Node, textOf: (n: Node) => string): Promise<Static> => {
      const n = skipParentheses(node);
      switch (n.kind) {
        case SyntaxKind.NumericLiteral:
          return { kind: "number", value: Number((n as any).text) };
        case SyntaxKind.StringLiteral:
        case SyntaxKind.NoSubstitutionTemplateLiteral:
          return { kind: "string", value: (n as any).text };
        case SyntaxKind.TrueKeyword:
          return { kind: "boolean", value: true };
        case SyntaxKind.FalseKeyword:
          return { kind: "boolean", value: false };
        case SyntaxKind.PrefixUnaryExpression: {
          const operand = skipParentheses((n as any).operand);
          if (operand.kind === SyntaxKind.NumericLiteral) {
            const v = Number((operand as any).text);
            if ((n as any).operator === SyntaxKind.MinusToken) return { kind: "number", value: -v };
            if ((n as any).operator === SyntaxKind.PlusToken) return { kind: "number", value: v };
          }
          break;
        }
        case SyntaxKind.Identifier:
          if ((n as any).text === "undefined") return { kind: "undefined" };
          break;
        case SyntaxKind.ObjectLiteralExpression: {
          const props: Record<string, Arg> = {};
          for (const p of (n as any).properties as Node[]) {
            if (p.kind === SyntaxKind.PropertyAssignment) {
              const name = (p as any).name;
              if (
                name.kind !== SyntaxKind.Identifier &&
                name.kind !== SyntaxKind.StringLiteral &&
                name.kind !== SyntaxKind.NumericLiteral
              )
                return { kind: "dynamic", type: "object" };
              const init = (p as any).initializer;
              props[name.text] = { text: textOf(init), value: await staticOf(init, textOf) };
            } else if (p.kind === SyntaxKind.ShorthandPropertyAssignment) {
              const name = (p as any).name;
              props[name.text] = { text: textOf(name), value: await staticOf(name, textOf) };
            } else return { kind: "dynamic", type: "object" };
          }
          return { kind: "object", props };
        }
        case SyntaxKind.PropertyAccessExpression: {
          const c = await classify(typeOf.get((n as any).expression));
          if (c?.isStatic && c.owner === "DateTime" && (n as any).name.text in presets())
            return { kind: "member", owner: "DateTime", name: (n as any).name.text };
          break;
        }
      }
      const type = typeOf.get(n) ?? typeOf.get(node);
      if (type !== undefined) {
        const value = (type as any).value;
        if (type.flags & TypeFlags.StringLiteral && typeof value === "string")
          return { kind: "string", value };
        if (type.flags & TypeFlags.NumberLiteral && typeof value === "number")
          return { kind: "number", value };
        const owner = await instanceOf(type);
        if (owner) return { kind: "dynamic", type: owner };
        if (type.flags & TypeFlags.Object && (await checker.typeToString(type)) === "Date")
          return { kind: "dynamic", type: "date" };
        if (type.flags & (TypeFlags.Number | TypeFlags.NumberLiteral))
          return { kind: "dynamic", type: "number" };
        if (type.flags & (TypeFlags.String | TypeFlags.StringLiteral))
          return { kind: "dynamic", type: "string" };
        if (type.flags & (TypeFlags.Object | TypeFlags.NonPrimitive))
          return { kind: "dynamic", type: "object" };
      }
      return { kind: "dynamic", type: "unknown" };
    };

    /** The units of a Duration built right there by fromObject (literal units) or fromMillis. */
    const durationUnits = async (receiver: Node): Promise<string[] | undefined> => {
      const call = skipParentheses(receiver) as any;
      if (
        call.kind !== SyntaxKind.CallExpression ||
        call.expression.kind !== SyntaxKind.PropertyAccessExpression
      )
        return undefined;
      const factory = await classify(typeOf.get(call.expression.expression));
      if (!factory?.isStatic || factory.owner !== "Duration") return undefined;
      const name = call.expression.name.text;
      if (name === "fromMillis") return ["milliseconds"];
      if (name !== "fromObject" || call.arguments.length !== 1) return undefined;
      const value = await staticOf(call.arguments[0], original);
      return value.kind === "object"
        ? Object.keys(value.props).map((k) => (k.endsWith("s") ? k : `${k}s`).toLowerCase())
        : undefined;
    };

    const record = (
      kind: UseKind,
      node: Node,
      subject: string,
      produces: ClassName | null,
      inputs: readonly Node[],
      outcomeOf: () => Outcome,
      computeOf?: (r: Renderer) => Outcome
    ) => {
      uses.push({
        kind,
        file: path,
        ...position(node),
        subject,
        node,
        produces,
        inputs,
        outcomeOf,
        computeOf: computeOf ?? outcomeOf,
      });
    };
    const passthrough = (differences: readonly DifferenceId[]) => (): Outcome => ({
      kind: "rewrite",
      text: "",
      differences,
      precedence: "member",
    });

    for (const m of moduleUses)
      record("module", m.node, "momentum module", null, [], () => none(m.reason));

    // property reads and method calls
    const memberNodes = new Set<Node>();
    for (const p of props) {
      const receiver = (p as any).expression as Node;
      const c = await classify(typeOf.get(receiver));
      if (!c || c.owner === null) continue;
      const owner = c.owner;
      const name: string =
        p.kind === SyntaxKind.PropertyAccessExpression
          ? (p as any).name.text
          : (p as any).argumentExpression.text;
      const parent = p.parent;
      if (
        parent?.kind === SyntaxKind.BinaryExpression &&
        (parent as any).left === p &&
        assignmentOperators.has((parent as any).operatorToken.kind)
      ) {
        if (owner === "Settings" && c.isStatic) {
          facts.settings.add(name);
          if (localeSettings.has(name)) facts.localeConfigured = true;
        }
        record("member", parent, `${owner}.${name} =`, null, [], () =>
          none(classNotes[owner] ?? "assigning to momentum objects has no Temporal counterpart")
        );
        continue;
      }
      const isCall = parent?.kind === SyntaxKind.CallExpression && (parent as any).expression === p;
      const node = isCall ? parent : p;
      memberNodes.add(node);
      const args: Node[] = isCall ? [...(parent as any).arguments] : [];
      if (owner === "Dayjs" || owner === "DayjsTimezone") {
        // dayjs.tz.guess(): the use is the outer call, not the read of dayjs.tz
        if (c.isStatic && name === "tz" && !isCall) continue;
        if (isCall && name === "locale" && args.length > 0) facts.localeConfigured = true;
        if (name === "tz" || (name === "utcOffset" && isCall && args.length > 0))
          facts.settings.add("dayjs:zones");
        if (name === "utc") facts.settings.add("dayjs:utc");
        if (owner === "DayjsTimezone" && name === "setDefault")
          facts.settings.add("dayjs.tz.setDefault");
        if (owner === "Dayjs" && c.isStatic && name === "extend" && isCall) {
          // which plugin: the catalog knows what some of them change in Day.js's own methods
          const plugin = args[0] && skipParentheses(args[0]);
          const from =
            plugin?.kind === SyntaxKind.Identifier
              ? importedFrom.get((plugin as any).text)
              : undefined;
          const known = from && /^dayjs\/plugin\/([\w-]+?)(?:\/index)?(?:\.js)?$/.exec(from);
          facts.settings.add(`dayjs:plugin:${known ? known[1] : "?"}`);
          // the statement goes with the imports when the whole project switches
          const statement = parent!.parent;
          if (statement?.kind === SyntaxKind.ExpressionStatement) {
            file.imports.push({ node: statement, module: "dayjs" });
            record("module", parent!, "dayjs.extend", null, [], () => ({
              kind: "rewrite",
              text: "",
              differences: [],
              precedence: "member",
            }));
          } else
            record("module", parent!, "dayjs.extend", null, [], () =>
              none("the result of dayjs.extend is used")
            );
          continue;
        }
      }
      const produces = await instanceOf(typeOf.get(node));
      const inputs: Node[] = c.isStatic ? [] : [receiver];
      for (const a of args) if (await instanceOf(typeOf.get(a))) inputs.push(a);
      if (isCall && !c.isStatic && (name === "setLocale" || name === "reconfigure"))
        facts.localeConfigured = true;
      if (isCall && c.isStatic && owner !== "Settings")
        for (const a of args) {
          const v = await staticOf(a, original);
          if (
            v.kind === "object"
              ? localeOptionKeys.some((k) => k in v.props)
              : v.kind === "dynamic" && v.type === "object"
          )
            facts.localeConfigured = true;
        }
      const form = isCall ? "call" : "get";
      const subject = `${owner}${c.isStatic ? "." : "#"}${name}`;
      const argValues = await Promise.all(args.map((a) => staticOf(a, original)));
      const receiverUnits =
        owner === "Duration" && !c.isStatic ? await durationUnits(receiver) : undefined;
      uses.push({
        kind: "member",
        file: path,
        ...position(node),
        subject,
        node,
        produces,
        inputs,
        outcomeOf: () =>
          memberOutcome(owner, c.isStatic, name, form, {
            recv: original(receiver),
            args: args.map((a, i) => ({ text: original(a), value: argValues[i] })),
            facts,
            quote: file.quote,
            receiverUnits,
          }),
        computeOf: (r: Renderer) =>
          memberOutcome(owner, c.isStatic, name, form, {
            recv: c.isStatic ? original(receiver) : r.operand(receiver),
            args: args.map((a, i) => ({ text: r.text(a), value: rerender(argValues[i], a, r) })),
            facts,
            quote: file.quote,
            receiverUnits,
          }),
        partialBlocked: representationChecks.has(`${owner}.${name}`),
      });
    }

    // calls of a library's callable export: dayjs(...)
    for (const call of calls) {
      if (call.kind !== SyntaxKind.CallExpression || memberNodes.has(call)) continue;
      const callee = skipParentheses((call as any).expression);
      const c = await classify(typeOf.get(callee));
      if (!c?.isStatic || c.owner !== "Dayjs") continue;
      memberNodes.add(call);
      const args: Node[] = [...(call as any).arguments];
      const argValues = await Promise.all(args.map((a) => staticOf(a, original)));
      const inputs: Node[] = [];
      for (const a of args) if (await instanceOf(typeOf.get(a))) inputs.push(a);
      uses.push({
        kind: "member",
        file: path,
        ...position(call),
        subject: `${original(callee)}()`,
        node: call,
        produces: await instanceOf(typeOf.get(call)),
        inputs,
        outcomeOf: () =>
          memberOutcome("Dayjs", true, "()", "call", {
            recv: original(callee),
            args: args.map((a, i) => ({ text: original(a), value: argValues[i] })),
            facts,
            quote: file.quote,
          }),
        computeOf: (r: Renderer) =>
          memberOutcome("Dayjs", true, "()", "call", {
            recv: original(callee),
            args: args.map((a, i) => ({ text: r.text(a), value: rerender(argValues[i], a, r) })),
            facts,
            quote: file.quote,
          }),
      });
    }

    // calls of date-fns's functions: addDays(date, 1), fns.addDays(date, 1)
    const dateFnsModule = (m: string | undefined) =>
      m !== undefined &&
      (m === "date-fns" || m.startsWith("date-fns/") || m.startsWith("@date-fns/"));
    for (const call of calls) {
      if (call.kind !== SyntaxKind.CallExpression || memberNodes.has(call)) continue;
      const callee = skipParentheses((call as any).expression);
      let module: string | undefined;
      let name: string | undefined;
      if (callee.kind === SyntaxKind.Identifier) {
        module = importedFrom.get((callee as any).text);
        name = importedAs.get((callee as any).text) ?? (callee as any).text;
      } else if (
        callee.kind === SyntaxKind.PropertyAccessExpression &&
        (callee as any).expression.kind === SyntaxKind.Identifier
      ) {
        module = namespaces.get((callee as any).expression.text);
        name = (callee as any).name.text;
      }
      if (!dateFnsModule(module) || name === undefined) continue;
      // the curried variants of date-fns/fp take their arguments the other way round
      if (module!.startsWith("date-fns/fp")) name = "fp";
      memberNodes.add(call);
      if (name === "setDefaultOptions") facts.settings.add("date-fns:defaultOptions");
      const args: Node[] = [...(call as any).arguments];
      const argValues = await Promise.all(args.map((a) => staticOf(a, original)));
      const fn = name;
      uses.push({
        kind: "member",
        file: path,
        ...position(call),
        subject: `${fn}()`,
        node: call,
        produces: null,
        inputs: [],
        outcomeOf: () =>
          memberOutcome("DateFns", true, fn, "call", {
            recv: original(callee),
            args: args.map((a, i) => ({ text: original(a), value: argValues[i] })),
            facts,
            quote: file.quote,
          }),
        computeOf: (r: Renderer) =>
          memberOutcome("DateFns", true, fn, "call", {
            recv: original(callee),
            args: args.map((a, i) => ({
              text: r.text(a),
              value: rerender(argValues[i], a, r),
              zoned: r.zonedOf(a),
            })),
            facts,
            quote: file.quote,
          }),
      });
    }

    // operators
    for (const b of binaries) {
      const op = (b as any).operatorToken.kind as number;
      const left = (b as any).left as Node;
      const right = (b as any).right as Node;
      const lc = await classify(typeOf.get(left));
      const rc = await classify(typeOf.get(right));
      if (op === SyntaxKind.InstanceOfKeyword) {
        if (rc?.isStatic && rc.owner) {
          const owner = rc.owner;
          const replacement = typeReplacement(owner);
          record("class", right, `instanceof ${owner}`, null, [], () =>
            replacement
              ? { kind: "rewrite", text: replacement, differences: [], precedence: "member" }
              : none(classNotes[owner] ?? "no Temporal class")
          );
        }
        continue;
      }
      const l = lc && !lc.isStatic ? lc.owner : null;
      const r = rc && !rc.isStatic ? rc.owner : null;
      if (!l && !r) continue;
      if (neutralOperators.has(op)) continue;
      if (
        (op === SyntaxKind.EqualsEqualsToken || op === SyntaxKind.ExclamationEqualsToken) &&
        l &&
        r
      )
        continue;
      const relational = relationalOperators.get(op);
      if (relational && (l === "DateTime" || l === "Dayjs") && l === r) {
        record(
          "compare",
          b,
          `a ${relational} b`,
          null,
          [left, right],
          () => compareOutcome(original(left), relational, original(right)),
          (rr) => compareOutcome(rr.text(left), relational, rr.text(right))
        );
        continue;
      }
      for (const [side, owner] of [
        [left, l],
        [right, r],
      ] as const)
        if (owner)
          record(
            "valueOf",
            side,
            `${owner} as a number`,
            null,
            [side],
            () => valueOfOutcome(owner, original(side), file.quote),
            (rr) => valueOfOutcome(owner, rr.operand(side), file.quote)
          );
    }
    for (const u of unaries) {
      const operand = (u as any).operand as Node;
      const owner = await instanceOf(typeOf.get(operand));
      if (owner)
        record(
          "valueOf",
          operand,
          `${owner} as a number`,
          null,
          [operand],
          () => valueOfOutcome(owner, original(operand), file.quote),
          (rr) => valueOfOutcome(owner, rr.operand(operand), file.quote)
        );
    }
    for (const s of spans) {
      const e = (s as any).expression as Node;
      const owner = await instanceOf(typeOf.get(e));
      if (owner)
        record(
          "toString",
          e,
          `${owner} in a template literal`,
          null,
          [e],
          () => toStringOutcome(owner, original(e), file.quote),
          (rr) => toStringOutcome(owner, rr.operand(e), file.quote)
        );
    }

    // momentum values passed to other functions
    const signatureChecks: { call: Node; index: number; arg: Node; owner: ClassName }[] = [];
    for (const call of calls) {
      if (memberNodes.has(call)) continue;
      const callee = (call as any).expression as Node;
      const calleeText = original(callee);
      const args: Node[] = (call as any).arguments ?? [];
      for (const [index, arg] of args.entries()) {
        const serialized = calleeText === "JSON.stringify" && index === 0;
        const printed = /^console\.\w+$/.test(calleeText);
        const owner =
          serialized || printed
            ? await contained(typeOf.get(arg))
            : await instanceOf(typeOf.get(arg));
        if (!owner) continue;
        if (serialized)
          record(
            "implicit",
            arg,
            "JSON.stringify of a momentum value",
            null,
            [],
            passthrough(
              owner === "DateTime" || owner === "Duration" || owner === "Dayjs"
                ? ["json-format"]
                : []
            )
          );
        else if (printed)
          record(
            "implicit",
            arg,
            "console output of a momentum value",
            null,
            [],
            passthrough(["inspect-output"])
          );
        else if (call.kind === SyntaxKind.CallExpression && calleeText === "String")
          record(
            "toString",
            arg,
            `${owner} in String()`,
            null,
            [arg],
            () => toStringOutcome(owner, original(arg), file.quote),
            (rr) => toStringOutcome(owner, rr.operand(arg), file.quote)
          );
        else if (
          (call.kind === SyntaxKind.CallExpression &&
            (calleeText === "Number" || /^Math\.\w+$/.test(calleeText))) ||
          (call.kind === SyntaxKind.NewExpression && calleeText === "Date")
        )
          record(
            "valueOf",
            arg,
            `${owner} as a number`,
            null,
            [arg],
            () => valueOfOutcome(owner, original(arg), file.quote),
            (rr) => valueOfOutcome(owner, rr.operand(arg), file.quote)
          );
        else signatureChecks.push({ call, index, arg, owner });
      }
    }
    for (const { call, index, arg, owner } of signatureChecks) {
      const signature = await checker.getResolvedSignature(call);
      const declaration = signature?.declaration?.path?.toLowerCase();
      const parameter = signature ? await checker.getParameterType(signature, index) : undefined;
      const expected = await classify(parameter);
      const inProject =
        declaration !== undefined &&
        declaration.startsWith(`${root}/`.toLowerCase()) &&
        !declaration.includes("/node_modules/");
      if (expected && !expected.isStatic && expected.owner !== null) {
        if (!inProject)
          record("escape", arg, `${owner} passed to a dependency`, null, [arg], () =>
            none(
              `a dependency (${declaration ? relative(root, declaration) : "unknown"}) expects momentum or Luxon objects`
            )
          );
        continue;
      }
      const flags = parameter?.flags ?? TypeFlags.Any;
      const opaque =
        flags &
          (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.TypeParameter | TypeFlags.NonPrimitive) ||
        (flags & TypeFlags.Object && (await checker.typeToString(parameter!)) === "{}");
      if (opaque)
        record("escape", arg, `${owner} passed to untyped code`, null, [arg], () =>
          none(
            `passed to code that accepts any value (${original((call as any).expression)}); check it does not use momentum methods`
          )
        );
    }

    // annotations and the classes themselves
    for (const t of typeRefs) {
      const c = await classify(typeOf.get(t));
      if (!c || c.isStatic) continue;
      const replacement = c.owner ? typeReplacement(c.owner) : null;
      const owner = c.owner;
      record("type", t, `type ${c.name}`, null, [], () =>
        replacement
          ? { kind: "rewrite", text: replacement, differences: [], precedence: "member" }
          : none(
              owner
                ? (classNotes[owner] ?? `${owner} has no Temporal type`)
                : `momentum's ${c.name} type has no Temporal counterpart`
            )
      );
    }
    for (const i of idents) {
      const parent = i.parent;
      if (!parent) continue;
      if (parent.kind === SyntaxKind.PropertyAccessExpression && (parent as any).expression === i)
        continue;
      if (
        parent.kind === SyntaxKind.BinaryExpression &&
        (parent as any).right === i &&
        (parent as any).operatorToken.kind === SyntaxKind.InstanceOfKeyword
      )
        continue;
      if (
        parent.kind === SyntaxKind.TypeReference ||
        parent.kind === SyntaxKind.QualifiedName ||
        parent.kind === SyntaxKind.TypeQuery
      )
        continue;
      // dayjs(...): a call of the export, analysed above
      if (parent.kind === SyntaxKind.CallExpression && (parent as any).expression === i) continue;
      if (
        parent.kind === SyntaxKind.ImportSpecifier ||
        parent.kind === SyntaxKind.ImportClause ||
        parent.kind === SyntaxKind.NamespaceImport
      )
        continue;
      if (parent.kind === SyntaxKind.ExportSpecifier) {
        record("module", i, "momentum re-exported", null, [], () =>
          none("re-exports momentum's API, which Temporal does not provide")
        );
        continue;
      }
      const c = await classify(typeOf.get(i));
      if (c?.isStatic && c.owner)
        record("class", i, `${c.owner} used as a value`, null, [], () =>
          none("the class itself is passed around; its Temporal counterpart has a different API")
        );
    }
    files.push(file);
  }

  const finished: Use[] = uses.map((u) => {
    const { outcomeOf, computeOf, ...rest } = u;
    return { ...rest, outcome: outcomeOf(), compute: computeOf };
  });
  return { root, files, uses: finished, facts, inferred: loaded.inferred };

  function rerender(value: Static, node: Node, r: Renderer): Static {
    if (value.kind !== "object") return value;
    const inner = skipParentheses(node);
    const props: Record<string, Arg> = {};
    for (const p of (inner as any).properties as Node[]) {
      const name = (p as any).name;
      const init = (p as any).initializer ?? name;
      const prior = value.props[name.text];
      if (prior) props[name.text] = { text: r.text(init), value: rerender(prior.value, init, r) };
    }
    return { kind: "object", props };
  }
}

export interface Verdict {
  /** Every use converts with the accepted differences. */
  fullSwitch: boolean;
  exact: Use[];
  /** Rewrites whose differences were all accepted. */
  accepted: Use[];
  /** Rewrites waiting for differences to be accepted. */
  pending: Use[];
  /** Uses with no native replacement. */
  leftOff: Use[];
  /** Differences that block pending uses, with how many each blocks. */
  blockingDifferences: Map<DifferenceId, number>;
}

export function verdict(analysis: Analysis, accepted: ReadonlySet<DifferenceId>): Verdict {
  const result: Verdict = {
    fullSwitch: false,
    exact: [],
    accepted: [],
    pending: [],
    leftOff: [],
    blockingDifferences: new Map(),
  };
  for (const use of analysis.uses) {
    const o = use.outcome;
    if (o.kind === "none") result.leftOff.push(use);
    else if (o.differences.length === 0) result.exact.push(use);
    else {
      const missing = o.differences.filter((d) => !accepted.has(d));
      if (missing.length === 0) result.accepted.push(use);
      else {
        result.pending.push(use);
        for (const d of missing)
          result.blockingDifferences.set(d, (result.blockingDifferences.get(d) ?? 0) + 1);
      }
    }
  }
  result.fullSwitch =
    analysis.uses.length > 0 && result.leftOff.length === 0 && result.pending.length === 0;
  return result;
}

/**
 * The uses `apply` rewrites. When the whole project converts, all of them. Otherwise only closed
 * chains: expressions that start from a momentum factory and end in a plain value, so that no
 * momentum object outlives the expression and nothing else in the program sees the change.
 */
export function selectRewrites(
  analysis: Analysis,
  accepted: ReadonlySet<DifferenceId>
): { uses: Use[]; whole: boolean } {
  const v = verdict(analysis, accepted);
  const convertible = (u: Use) =>
    u.outcome.kind === "rewrite" && u.outcome.differences.every((d) => accepted.has(d));
  if (v.fullSwitch) return { uses: analysis.uses.filter((u) => u.kind !== "module"), whole: true };
  const members = new Map<Node, Use>();
  for (const u of analysis.uses) if (u.kind === "member") members.set(u.node, u);
  const chain = (node: Node, out: Use[]): boolean => {
    const u = members.get(skipParentheses(node));
    if (u === undefined || !convertible(u) || u.partialBlocked) return false;
    out.push(u);
    return u.inputs.every((i) => chain(i, out));
  };
  const selected = new Set<Use>();
  for (const u of analysis.uses) {
    if (!convertible(u) || u.partialBlocked) continue;
    const parts: Use[] = [];
    let ok = false;
    if (u.kind === "member" && u.produces === null) ok = u.inputs.every((i) => chain(i, parts));
    else if (u.kind === "compare") ok = u.inputs.every((i) => chain(i, parts));
    else if (u.kind === "valueOf" || u.kind === "toString") ok = chain(u.node, parts);
    if (ok) {
      selected.add(u);
      for (const p of parts) selected.add(p);
    }
  }
  return { uses: analysis.uses.filter((u) => selected.has(u)), whole: false };
}
