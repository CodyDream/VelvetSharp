/** VelvetSharp brain — deep semantic analysis pass (v3).
 *  Beyond syntax: unused variables, unreachable code, missing returns,
 *  interface/abstract/static instantiation, ref/out argument misuse,
 *  obsolete API usage. Produces diagnostics + decoration ranges. */
import type { SyntaxNode, Tree } from "web-tree-sitter";
import type { VelvetSharpEngine } from "./engine";
import type { Diagnostic, SemRange, SemanticReport } from "./types";

const MAX_SEMANTIC_DIAGNOSTICS = 120;

const JUMP_TYPES = new Set([
  "return_statement", "throw_statement", "break_statement", "continue_statement",
  "goto_statement",
]);

const isJump = (n: SyntaxNode): boolean =>
  JUMP_TYPES.has(n.type)
  || (n.type === "yield_statement" && /\bbreak\b/.test(n.text));

interface Ctx {
  engine: VelvetSharpEngine;
  path: string;
  st: any;                     // FileState (kept loose to avoid a circular import)
  diags: Diagnostic[];
  unreachable: SemRange[];
  obsolete: SemRange[];
  content: string;
}

function warn(ctx: Ctx, n: SyntaxNode, message: string, length?: number): void {
  if (ctx.diags.length >= MAX_SEMANTIC_DIAGNOSTICS) return;
  ctx.diags.push({
    line: n.startPosition.row,
    col: n.startPosition.column,
    length: length ?? Math.max(1, n.endIndex - n.startIndex),
    message,
    severity: "warning",
    source: "velvetsharp.semantic",
  });
}

function error(ctx: Ctx, n: SyntaxNode, message: string, length?: number): void {
  if (ctx.diags.length >= MAX_SEMANTIC_DIAGNOSTICS) return;
  ctx.diags.push({
    line: n.startPosition.row,
    col: n.startPosition.column,
    length: length ?? Math.max(1, n.endIndex - n.startIndex),
    message,
    severity: "error",
    source: "velvetsharp.semantic",
  });
}

const rangeOf = (n: SyntaxNode): SemRange => ({
  line: n.startPosition.row,
  col: n.startPosition.column,
  endLine: n.endPosition.row,
  endCol: n.endPosition.column,
});

/* ------------------------------ entry point ------------------------------ */

export function semanticAnalysis(engine: VelvetSharpEngine, st: any, tree: Tree, content: string, path: string): SemanticReport {
  const ctx: Ctx = { engine, path, st, diags: [], unreachable: [], obsolete: [], content };
  const root = tree.rootNode;
  if (root.endIndex > 1_200_000) return { diagnostics: [], unreachable: [], obsolete: [] };

  checkUnreachable(ctx, root);
  checkMethodReturns(ctx, root);
  checkUnusedLocals(ctx, root);
  checkInstantiation(ctx, root);
  checkRefOutArgs(ctx, root);
  checkObsolete(ctx, root);
  checkInterfaceNaming(ctx, root);
  checkTypeUsings(ctx, root);

  return { diagnostics: ctx.diags, unreachable: ctx.unreachable, obsolete: ctx.obsolete };
}

/* --------------------------- unreachable code --------------------------- */

/** within one statement list (block body / switch section), any direct child
 *  statement after an unconditional jump is unreachable */
function checkUnreachable(ctx: Ctx, root: SyntaxNode): void {
  const LIST_TYPES = new Set(["block", "switch_section"]);
  const visit = (n: SyntaxNode) => {
    if (LIST_TYPES.has(n.type)) {
      let jumpSeen = false;
      let runStart: SyntaxNode | null = null;
      let runEnd: SyntaxNode | null = null;
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        // skip braces/punctuation (unnamed) and comments — only real statements count
        if (!c || !c.isNamed || c.type === "comment") continue;
        if (jumpSeen) {
          if (!runStart) runStart = c;
          runEnd = c;
        } else if (isJump(c)) {
          jumpSeen = true;
        }
      }
      if (runStart && runEnd) {
        ctx.unreachable.push({
          line: runStart.startPosition.row,
          col: runStart.startPosition.column,
          endLine: runEnd.endPosition.row,
          endCol: runEnd.endPosition.column,
        });
        warn(ctx, runStart, "Unreachable code detected", Math.max(1, runEnd.endIndex - runStart.startIndex));
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) visit(c);
    }
  };
  visit(root);
}

/* ---------------------------- method returns ---------------------------- */

function methodReturnsText(m: SyntaxNode): string {
  return (m.childForFieldName("returns") ?? m.childForFieldName("type"))?.text.trim() ?? "";
}

function methodNameNode(m: SyntaxNode): SyntaxNode | null {
  return m.childForFieldName("name");
}

function containsYield(n: SyntaxNode): boolean {
  return !!n.descendantsOfType?.("yield_statement").length
    || !!n.descendantsOfType?.("yield_return_statement").length
    || !!n.descendantsOfType?.("yield_break_statement").length
    || /(^|\s)yield\s+(return|break)\b/.test(n.text.slice(0, 4000));
}

function endsWithFlow(node: SyntaxNode | null, depth = 0): boolean {
  if (!node || depth > 24) return false;
  switch (node.type) {
    case "block": {
      const stmts = node.namedChildren.filter((c) => c.type !== "comment" && c.type !== "local_function_statement");
      return stmts.length > 0 && endsWithFlow(stmts[stmts.length - 1], depth + 1);
    }
    case "return_statement":
      // `return;` without a value — the caller checks separately; treat as flow end only via throw
      return node.childForFieldName("expression") !== null || node.namedChildCount > 0;
    case "throw_statement":
      return true;
    case "if_statement": {
      const then = node.childForFieldName("consequence");
      const alt = node.childForFieldName("alternative");
      return !!alt && endsWithFlow(then, depth + 1) && endsWithFlow(alt, depth + 1);
    }
    case "while_statement": {
      // `while (true) { ... }` with no break inside always ends in a jump
      // (this grammar exposes no "condition" field — take the child after "(")
      let condText = "";
      let afterParen = false;
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c) continue;
        if (!afterParen) { if (c.text === "(") afterParen = true; continue; }
        if (c.text === ")") break;
        condText = c.text.trim();
        break;
      }
      if (condText === "true" && !node.descendantsOfType("break_statement").length
        && !/(^|\s)break\b/.test(node.text)) return true;
      return false;
    }
    case "block_statement":
      return endsWithFlow(node.namedChildren[node.namedChildren.length - 1], depth + 1);
    default:
      return false;
  }
}

function checkMethodReturns(ctx: Ctx, root: SyntaxNode): void {
  for (const m of root.descendantsOfType("method_declaration")) {
    const ret = methodReturnsText(m);
    const nameN = methodNameNode(m);
    if (!ret || !nameN) continue;
    const body = m.childForFieldName("body");
    if (!body) continue; // expression-bodied / abstract / interface
    if (containsYield(body)) continue; // iterators don't need normal returns

    const retSimple = ret.replace(/\[\]$/, "").replace(/<.*$/, "").split(".").pop() ?? ret;
    const isVoid = retSimple === "void"
      || (/\basync\b/.test(m.text.slice(0, 200)) && /^(Task|System\.Threading\.Tasks\.Task)(\s|$)/.test(ret.trim()));
    const simpleName = nameN.text;

    if (isVoid) {
      // void methods never need a return statement. A bare `return;` is fine, and
      // (user-requested v0.5.0) `return null;` is tolerated in void methods —
      // only returning a real VALUE is flagged.
      for (const r of body.descendantsOfType("return_statement")) {
        if (insideNestedFunction(r, body)) continue;
        const expr = r.childForFieldName("expression") ?? r.namedChildren.find((c) => c.type !== "return");
        if (expr && expr.type !== "null_literal") {
          error(ctx, r, `A return keyword must not be followed by an object expression in a void method '${simpleName}'`, Math.max(1, r.endIndex - r.startIndex));
        }
      }
      continue;
    }

    // non-void: `return;` without a value is an error
    for (const r of body.descendantsOfType("return_statement")) {
      if (insideNestedFunction(r, body)) continue;
      const expr = r.childForFieldName("expression") ?? r.namedChildren.find((c) => c.type !== "return");
      if (!expr) {
        error(ctx, r, `An object of a type convertible to '${ret}' is required (missing return value)`, 6);
        continue;
      }
      // `return null;` — legal for reference types, illegal for value types
      if (expr.type === "null_literal" && isValueTypeReturn(ctx, retSimple)) {
        error(ctx, r, `Cannot convert null to '${ret}' (value type return)`, Math.max(1, r.endIndex - r.startIndex));
      }
    }
    // v0.6.1 (user request): the "not all code paths return a value" warning is
    // GONE. The flow heuristic flooded real Unity code with false warnings, and
    // void methods read as "not returning" — a void method never needs a return
    // (and `return null;` is tolerated). The real mistakes stay ERRORS: a value
    // returned from void, a bare `return;` from a value method, null into a
    // known struct return.
  }
}

const PRIMITIVE_VALUE_TYPES = new Set([
  "int", "float", "double", "decimal", "bool", "char", "byte", "sbyte",
  "short", "ushort", "uint", "ulong", "long", "nint", "nuint",
]);

/** is this return type a value type (null can never be returned)? primitives +
 *  project structs + API structs. Unknown types stay permissive. */
function isValueTypeReturn(ctx: Ctx, retSimple: string): boolean {
  if (PRIMITIVE_VALUE_TYPES.has(retSimple) || PRIMITIVE_VALUE_TYPES.has(retSimple.toLowerCase())) return true;
  const pt = ctx.engine.projectTypes.get(retSimple.toLowerCase())?.[0];
  if (pt) return pt.kind === "struct";
  const apiT = ctx.engine.unity.findType(retSimple);
  return apiT?.info.kind === "struct";
}

function insideNestedFunction(n: SyntaxNode, stop: SyntaxNode): boolean {
  let cur: SyntaxNode | null = n.parent;
  while (cur && cur !== stop) {
    if (cur.type === "local_function_statement" || cur.type === "lambda_expression" || cur.type === "anonymous_method_expression") return true;
    cur = cur.parent;
  }
  return false;
}

/* ----------------------------- unused locals ----------------------------- */

function checkUnusedLocals(ctx: Ctx, root: SyntaxNode): void {
  for (const decl of root.descendantsOfType("local_declaration_statement")) {
    // skip declarations inside field initializers? (none — this is statement-level)
    const varDecl = decl.childForFieldName("declaration") ?? decl.namedChildren.find((c) => c.type === "variable_declaration");
    if (!varDecl) continue;
    for (const vd of varDecl.descendantsOfType("variable_declarator")) {
      const nameN = vd.childForFieldName("name") ?? vd.children.find((c) => c?.type === "identifier");
      if (!nameN) continue;
      const name = nameN.text;
      if (!name || name === "_" || name.startsWith("_") && name.length === 1) continue;
      // find the enclosing function scope
      const scope = enclosingFunction(nameN);
      if (!scope) continue;
      const reads = countReads(scope, nameN, name);
      if (reads === 0) {
        const writes = countWrites(scope, nameN, name);
        warn(
          ctx, nameN,
          writes > 0
            ? `Variable '${name}' is assigned but its value is never used`
            : `Variable '${name}' is declared but never used`,
          name.length,
        );
      }
    }
  }
}

function enclosingFunction(n: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = n.parent;
  while (cur) {
    if (cur.type === "method_declaration" || cur.type === "constructor_declaration"
      || cur.type === "local_function_statement" || cur.type === "accessor_declaration"
      || cur.type === "lambda_expression" || cur.type === "anonymous_method_expression") return cur;
    cur = cur.parent;
  }
  return null;
}

/** count identifier reads: excludes the declaration itself, declarations, and pure-assignment LHS */
function countReads(scope: SyntaxNode, declName: SyntaxNode, name: string): number {
  let reads = 0;
  const visit = (n: SyntaxNode) => {
    if (n.type === "identifier" && n.text === name && n.id !== declName.id) {
      const p = n.parent;
      if (!p) return;
      // declaration positions are never reads
      if (p.type === "variable_declarator" || p.type === "field_declaration" || p.type === "parameter") return;
      // plain-assignment LHS is a write, not a read
      if (p.type === "assignment_expression") {
        const left = p.childForFieldName("left");
        const op = p.children.find((c) => c && c.type !== "identifier" && c.type !== "assignment_expression" && ["=", "+=", "-=", "*=", "/=", "%=", "&&=", "||=", "??=", "<<=", ">>="].includes(c.text));
        if (left?.id === n.id && op?.text === "=") return;
      }
      reads++;
      return;
    }
    // don't descend into nested functions/lambdas that redeclare the same name
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) visit(c);
    }
  };
  visit(scope);
  return reads;
}

function countWrites(scope: SyntaxNode, declName: SyntaxNode, name: string): number {
  let writes = 0;
  const visit = (n: SyntaxNode) => {
    if (n.type === "identifier" && n.text === name && n.id !== declName.id) {
      const p = n.parent;
      if (p?.type === "assignment_expression" && p.childForFieldName("left")?.id === n.id) { writes++; return; }
      if (p?.type === "argument" && /^(\s*)(ref|out)\b/.test(p.text)) { writes++; return; }
      if (p?.type === "prefix_unary_expression" || p?.type === "postfix_unary_expression") { writes++; return; }
      return;
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) visit(c);
    }
  };
  visit(scope);
  return writes;
}

/* -------------------- interface / abstract / static `new` -------------------- */

function simpleTypeName(typeNode: SyntaxNode | null): string {
  if (!typeNode) return "";
  const t = typeNode.text.replace(/<.*$/, "").replace(/\[\]$/, "");
  return t.split(".").pop() ?? t;
}

function checkInstantiation(ctx: Ctx, root: SyntaxNode): void {
  for (const nc of root.descendantsOfType("object_creation_expression")) {
    const typeNode = nc.childForFieldName("type");
    const simple = simpleTypeName(typeNode);
    if (!simple) continue;
    const engine = ctx.engine;

    // project type first
    const pt = engine.projectTypes.get(simple.toLowerCase())?.[0];
    if (pt) {
      if (pt.kind === "interface") {
        error(ctx, nc, `Cannot create an instance of the interface '${simple}'`, simple.length);
      } else if (pt.abstract && pt.sealed) {
        error(ctx, nc, `Cannot create an instance of the static class '${simple}'`, simple.length);
      } else if (pt.abstract) {
        error(ctx, nc, `Cannot create an instance of the abstract class '${simple}'`, simple.length);
      }
      continue;
    }
    // API type (Unity DB or BCL)
    const rt = engine.unity.findType(simple);
    if (rt && (rt.name === simple || stripGeneric(rt.fullName) === stripGeneric(simple))) {
      const kind = rt.info.kind;
      if (kind === "interface") {
        error(ctx, nc, `Cannot create an instance of the interface '${simple}'`, simple.length);
      } else if (kind === "class" && rt.info.abs && rt.info.seal) {
        error(ctx, nc, `Cannot create an instance of the static class '${simple}'`, simple.length);
      } else if (kind === "class" && rt.info.abs) {
        error(ctx, nc, `Cannot create an instance of the abstract class '${simple}'`, simple.length);
      }
    }
  }
}

function stripGeneric(s: string): string {
  return s.replace(/`\d+/g, "");
}

/* ------------------------- ref / out argument misuse ------------------------- */

function checkRefOutArgs(ctx: Ctx, root: SyntaxNode): void {
  // Argument expressions that are always legal targets for ref/out/in:
  //  - identifier                 → pre-declared variable or discard (`out seconds`, `out _`)
  //  - declaration_expression     → OUT VARIABLE DECLARATION (`out int result`, `out var found`).
  //    These are legal C# declaration expressions: the argument DECLARES the variable at the
  //    call site, so they must never be flagged (Task 17-a: user reported false warnings on
  //    `int.TryParse("42", out int result)` / `d.TryGetValue("k", out var found)`).
  //  - member_access_expression / this_expression → `out obj.field`, `out this.x`. A FIELD is
  //    assignable, so flagging every member chain false-positives on perfectly legal code —
  //    and the user's standing rule is "never invent warnings". Only flag what is PROVABLY
  //    wrong (literals, invocations, tuples…).
  //  - element_access_expression  → array/list element (`out slots[i]`)
  //  - parenthesized_expression   → `out (x)`
  const ALLOWED = new Set([
    "identifier", "declaration_expression", "member_access_expression",
    "this_expression", "element_access_expression", "parenthesized_expression",
  ]);
  for (const arg of root.descendantsOfType("argument")) {
    const m = arg.text.match(/^\s*(ref|out|in)\s+\S/);
    if (!m) continue;
    const expr = arg.namedChildren[arg.namedChildren.length - 1];
    if (!expr) continue;
    if (!ALLOWED.has(expr.type)) {
      error(
        ctx, arg,
        `Argument with '${m[1]}' keyword must be an assignable variable — not a literal, method call, or expression`,
        Math.max(1, Math.min(m[1].length + 1 + (expr.endIndex - expr.startIndex), 60)),
      );
    }
  }
}

/* ------------------------------ obsolete API ------------------------------ */

function checkObsolete(ctx: Ctx, root: SyntaxNode): void {
  const engine = ctx.engine;
  if (!engine.unity.loaded) return;

  // member access: recv.Name
  for (const ma of root.descendantsOfType("member_access_expression")) {
    const nameN = ma.childForFieldName("name");
    if (!nameN) continue;
    const dot = ma.text.lastIndexOf(".");
    if (dot <= 0) continue;
    const recvText = ma.text.slice(0, dot);
    try {
      const r = engine.resolveExpression(ctx.st, nameN.startPosition.row, nameN.startPosition.column, recvText);
      const member = resolveMemberOnResolved(engine, r, nameN.text);
      if (member?.obs !== undefined) {
        reportObsolete(ctx, nameN, nameN.text, member.obs);
      }
    } catch { /* inference miss — fine */ }
  }

  // bare type identifiers + object-creation types
  const checked = new Set<number>();
  const checkTypeNode = (n: SyntaxNode) => {
    if (checked.has(n.id)) return;
    checked.add(n.id);
    const rt = engine.unity.findType(n.text);
    if (rt && rt.name === n.text && rt.info.obs !== undefined) {
      reportObsolete(ctx, n, rt.fullName, rt.info.obs);
    }
  };
  for (const nc of root.descendantsOfType("object_creation_expression")) {
    const typeNode = nc.childForFieldName("type");
    const simple = simpleTypeName(typeNode);
    if (simple) {
      const rt = engine.unity.findType(simple);
      if (rt && rt.info.obs !== undefined && typeNode) reportObsolete(ctx, typeNode, rt.fullName, rt.info.obs);
    }
  }
  // declared-type identifiers (fields/params/locals type positions)
  for (const id of root.descendantsOfType("identifier")) {
    if (checked.has(id.id)) continue;
    const p = id.parent;
    if (!p) continue;
    if (["generic_name", "qualified_name", "array_type", "nullable_type", "variable_declaration",
      "parameter", "base_list", "as_expression", "is_expression", "cast_expression",
      "return_type", "type_constraint"].includes(p.type)) {
      checkTypeNode(id);
    }
  }
}

function reportObsolete(ctx: Ctx, n: SyntaxNode, full: string, msg: string): void {
  if (ctx.obsolete.length < 400) ctx.obsolete.push(rangeOf(n));
  const label = full.split(".").slice(-2).join(".");
  warn(
    ctx, n,
    `'${label}' is obsolete${msg ? ": " + msg : ""}`,
    Math.max(1, n.endIndex - n.startIndex),
  );
}

/** member lookup on a resolved expression result (mirrors engine.completeMemberAccess) */
function resolveMemberOnResolved(engine: VelvetSharpEngine, r: any, member: string) {
  if (!r) return null;
  if (r.kind === "type") {
    const rt = r.unityType ?? (r.projectType ? engine.unity.findType(r.projectType.name) : null);
    if (rt) return engine.unity.memberOfType(rt, member);
    return null;
  }
  if (r.kind === "value" && r.typeFullName) {
    const simple = r.typeFullName.split(".").pop()!;
    const rt = engine.unity.findType(simple);
    if (rt && (rt.fullName === r.typeFullName || stripGeneric(rt.fullName) === stripGeneric(r.typeFullName))) {
      return engine.unity.memberOfType(rt, member);
    }
    const pm = engine.projectMembers.get(r.typeFullName.toLowerCase())
      ?? engine.projectMembers.get(stripGeneric(simple).toLowerCase());
    return pm?.find((x) => x.name === member) ?? null;
  }
  return null;
}

/* ------------------------ interface naming convention ------------------------ */

/** interfaces must start with a capital I: `interface Foo` → warning (v0.5.0) */
function checkInterfaceNaming(ctx: Ctx, root: SyntaxNode): void {
  for (const n of root.descendantsOfType("interface_declaration")) {
    const nameN = n.childForFieldName("name");
    if (!nameN) continue;
    const name = nameN.text;
    if (/^I[A-Z]/.test(name)) continue;
    warn(
      ctx, nameN,
      `Interface name '${name}' should start with 'I' (naming convention — e.g. I${name})`,
      name.length,
    );
  }
}

/* ------------------- type usage: missing using + ambiguity ------------------- */

const TYPE_POSITION_PARENTS = new Set([
  "generic_name", "array_type", "nullable_type", "base_list",
  "as_expression", "is_expression", "cast_expression", "typeof_expression",
  "variable_declaration", "attribute", "with_expression", "default_expression",
]);

/** identifier sits in a TYPE position (declaration type, base list, new T(), cast…)? */
function isTypePosition(id: SyntaxNode): boolean {
  const p = id.parent;
  if (!p) return false;
  // never inside a qualified chain — `System.IO.File` is already fully qualified
  if (p.type === "qualified_name") return false;
  // …including `System.Collections.Generic.Dictionary<string, int>` where the generic NAME
  // identifier sits inside a generic_name that is itself INSIDE the qualified chain
  // (Task 17-a probe: fired a false CS0246 "missing using" on a fully-qualified type)
  if (p.type === "generic_name" && p.parent?.type === "qualified_name") return false;
  // generic_name is only a type when it is NOT the function of an invocation
  // (`GetComponent<T>()` — T's parent generic_name is the invoked method)
  if (p.type === "generic_name" && p.parent?.type === "invocation_expression"
    && p.parent.childForFieldName("function")?.id === p.id) return false;
  // …and generic_name as the NAME of a member access is a METHOD, not a type:
  // `Array.Empty<int>()` — 'Empty' is System.Array's static generic method.
  // (Phase 9: user's false positive — VS/Rider clean, we flagged 'Empty' as CS0246)
  if (p.type === "generic_name" && p.parent?.type === "member_access_expression") return false;
  if (TYPE_POSITION_PARENTS.has(p.type)) return true;
  // field-aware nodes: only the TYPE/RETURNS child is a type position —
  // `parameter` also holds the parameter NAME (never a type), and
  // `declaration_expression` (`case GameObject go:`) holds the NAME
  if (p.type === "parameter" || p.type === "object_creation_expression") {
    const t = p.childForFieldName("type");
    return !!t && (t.id === id.id || t.descendantsOfType("identifier").some((x) => x.id === id.id));
  }
  // return-type / declared-type fields (method/property/event/delegate/local function)
  for (const f of ["returns", "type"]) {
    const n = (p as any).childForFieldName?.(f);
    if (n && n.id === id.id) return true;
  }
  return false;
}

/** CS0246 + one-click `using` fix, and CS0104 ambiguous-reference warnings.
 *  Both run over type-position identifiers only (v0.5.0). */
function checkTypeUsings(ctx: Ctx, root: SyntaxNode): void {
  const engine = ctx.engine;
  const st = ctx.st;
  if (!st?.symbols) return;

  let visible: Set<string>;
  try { visible = engine.visibleNamespacesFor(st); } catch { return; }
  const fromAsm: string | null = engine.assemblyOf ? engine.assemblyOf(st.symbols.path) : null;

  const reported = new Set<string>();   // simple name → already reported
  let missingCount = 0;
  const MAX_MISSING = 15;

  for (const id of root.descendantsOfType("identifier")) {
    if (ctx.diags.length >= MAX_SEMANTIC_DIAGNOSTICS) break;
    if (!isTypePosition(id)) continue;
    const name = id.text;
    if (!name || name.length > 64) continue;
    if (/^(int|float|double|decimal|bool|char|string|object|byte|sbyte|short|ushort|uint|ulong|long|nint|nuint|void|var|dynamic)$/.test(name)) continue;

    // attributes: `[Header]` binds to HeaderAttribute — try the suffixed name too
    const isAttribute = id.parent?.type === "attribute";
    let candidates: { full: string; ns: string; origin: "api" | "project"; asm: string | null }[];
    try {
      candidates = engine.typeCandidates(name);
      if (isAttribute) {
        const suffixed = engine.typeCandidates(name + "Attribute");
        if (suffixed.length) candidates = [...suffixed, ...candidates];
      }
    } catch { continue; }
    if (!candidates.length) continue; // fully unknown — parser/other lints handle

    // project candidates from assemblies this file cannot see are not referenceable
    const referencable = candidates.filter((c) => {
      if (c.origin !== "project" || !c.asm || !fromAsm) return true;
      return engine.canSeeAssemblyPublic(fromAsm, c.asm);
    });

    const visibleHits = referencable.filter((c) => (c.ns ? visible.has(c.ns) : true));
    const key = name.toLowerCase();
    if (visibleHits.length === 0) {
      // type exists somewhere but is NOT reachable → CS0246 with a `using` fix
      if (reported.has(key) || missingCount >= MAX_MISSING) continue;
      reported.add(key);
      missingCount++;
      const best = pickFixCandidate(engine, st, referencable, fromAsm);
      if (best && best.ns) {
        const pos = engine.usingInsertPos(st);
        error(ctx, id,
          `The type or namespace name '${name}' could not be found (are you missing a using directive for '${best.ns}'?)`,
          name.length,
        );
        // attach the machine-applicable fix to the diagnostic we just pushed
        const diag = ctx.diags[ctx.diags.length - 1];
        if (diag) {
          diag.fix = {
            kind: "addUsing",
            ns: best.ns,
            title: `using ${best.ns};`,
            line: pos.line,
            col: pos.col,
            text: `using ${best.ns};\n`,
          };
        }
      } else {
        // namespace-less / unresolvable origin — plain error without a fix
        error(ctx, id,
          `The type or namespace name '${name}' could not be found`,
          name.length,
        );
      }
    } else if (visibleHits.length > 1 && new Set(visibleHits.map((c) => c.full.toLowerCase())).size > 1) {
      // CS0104 (ambiguous reference) intentionally NOT reported — Phase 9 user request
      // ("ignore warning also"). Bare-name ambiguity depends on exact using-directive
      // semantics and generic arity (e.g. `Task` binds arity-0 Task, NOT Task<T>), which
      // our symbol index cannot fully model — flagging it produced false positives
      // ('Task' vs 'Task`1', cross-namespace same-name types). Silence > invented warnings.
      //
      // NOTE: bare identifiers only ever bind arity-0 types anyway; generic candidates
      // (name`1) are filtered by the engine when resolving — see typeCandidates users.
    }
  }
}

/** best `using` fix target: same-assembly project ns → Unity → BCL → first */
function pickFixCandidate(
  engine: VelvetSharpEngine,
  st: any,
  candidates: { full: string; ns: string; origin: "api" | "project"; asm: string | null }[],
  fromAsm: string | null,
) {
  const withNs = candidates.filter((c) => !!c.ns);
  if (!withNs.length) return null;
  const score = (c: { origin: string; asm: string | null }): number => {
    if (c.origin === "project") {
      if (!fromAsm || !c.asm) return 0;
      // same assembly or referenced assembly → best
      return 0;
    }
    const providers = engine.unity.assembliesOf(c.ns);
    const bclAsms = new Set(engine.unity.assemblyNames().slice(1));
    return providers.every((p) => bclAsms.has(p)) ? 2 : 1; // BCL after Unity
  };
  withNs.sort((a, b) => score(a) - score(b) || a.full.length - b.full.length);
  return withNs[0];
}
