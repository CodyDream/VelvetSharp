/** VelvetSharp brain — semantic rename refactoring (v0.6.0, "phase 6").
 *
 * F2 on any symbol plans a project-wide rename using the same machinery the
 * completions/hover/go-to-def use:
 *
 *   locals / parameters   — bounded to the enclosing body, shadow-aware
 *   fields / properties / methods / events — declaring type + derived types
 *                            (bare uses inside the family, `recv.member` resolved
 *                            through the type-inference engine, virtual overrides)
 *   types                 — every type-position identifier that legally resolves
 *                            to the type (base lists, `new`, casts, generics,
 *                            var decls, attributes), plus its constructors
 *
 * Unity-aware extras: renaming a class whose file matches its name also moves the
 * .cs AND its .meta (the GUID inside the meta keeps scene/prefab links alive);
 * serialized fields and Unity message methods produce explicit warnings instead
 * of silent breaks. Unity/BCL symbols refuse to rename with a clear reason. */

import type { SyntaxNode, Tree } from "web-tree-sitter";
import { findNodeAt } from "./parser";
import { UNITY_MESSAGE_NAMES } from "./snippets";
import type {
  RenameFileEdits, RenamePlan, RenameRange, RenameTarget, SymbolInfo, FileSymbols, IdentRef,
} from "./types";

const CSHARP_RESERVED = new Set([
  "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char",
  "checked", "class", "const", "continue", "decimal", "default", "delegate",
  "do", "double", "else", "enum", "event", "explicit", "extern", "false",
  "finally", "fixed", "float", "for", "foreach", "goto", "if", "implicit", "in",
  "int", "interface", "internal", "is", "lock", "long", "namespace", "new",
  "null", "object", "operator", "out", "override", "params", "private",
  "protected", "public", "readonly", "ref", "return", "sbyte", "sealed",
  "short", "sizeof", "stackalloc", "static", "string", "struct", "switch",
  "this", "throw", "true", "try", "typeof", "uint", "ulong", "unchecked",
  "unsafe", "ushort", "using", "virtual", "void", "volatile", "while",
]);

export function validRenameName(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "not a valid C# identifier";
  if (CSHARP_RESERVED.has(name)) return `'${name}' is a reserved keyword`;
  return null;
}

/* ------------------------------------------------------------------ */
/* symbol identification                                              */
/* ------------------------------------------------------------------ */

/** classify the identifier under the cursor and bind it to a concrete symbol */
export function symbolAt(
  engine: any,
  path: string,
  line: number,
  col: number,
): { ok: true; target: RenameTarget } | { ok: false; reason: string } {
  const st = engine.files.get(path);
  if (!st?.tree) return { ok: false, reason: "script is not parsed yet — open it once and retry" };
  const ident = identAtCaret(st, line, col);
  if (!ident) return { ok: false, reason: "place the caret on a symbol to rename" };

  const name = ident.text;
  const parent = ident.parent;
  const ptype = parent?.type ?? "";
  const refs: IdentRef[] = st.symbols.typeRefs ?? [];
  const ctx: IdentRef["ctx"] =
    refs.find((r) => r.line === ident.startPosition.row && r.col === ident.startPosition.column && r.name === name)?.ctx
    ?? guessCtx(parent, ident);

  const mkTarget = (t: Partial<RenameTarget>): RenameTarget => ({
    kind: t.kind ?? "local",
    name,
    fqn: t.fqn ?? "",
    container: t.container ?? "",
    declFile: t.declFile ?? path,
    declLine: t.declLine ?? ident.startPosition.row,
    declCol: t.declCol ?? ident.startPosition.column,
    scope: t.scope ?? "local",
    ownerTypeFqn: t.ownerTypeFqn ?? "",
    via: t.via,
  });

  /* declaration positions — the easy, exact case */
  const typeSym = st.symbols.types.find((t: SymbolInfo) => t.line === ident.startPosition.row && name === t.name);
  if (ctx === "decl" && typeSym) {
    return { ok: true, target: mkTarget({ kind: typeSym.kind, fqn: typeSym.fqn, container: typeSym.container, declCol: typeSym.col, scope: "type" }) };
  }
  const memberSym = st.symbols.members.find((m: SymbolInfo) =>
    m.line === ident.startPosition.row && name === m.name && (m.kind !== "enumMember"));
  if (ctx === "decl" && memberSym) {
    return { ok: true, target: mkTarget({ kind: memberSym.kind, fqn: memberSym.fqn, container: memberSym.container, declCol: memberSym.col, scope: "member", ownerTypeFqn: memberSym.container }) };
  }
  if (ctx === "ctor") {
    const t = engine.projectTypes.get(name.toLowerCase())?.find((x: SymbolInfo) => x.file === path);
    if (t) return { ok: true, target: mkTarget({ kind: t.kind, fqn: t.fqn, container: t.container, declCol: t.col, scope: "type" }) };
  }

  /* member access `recv.name` — resolve the receiver type */
  if (ctx === "member" && parent?.type === "member_access_expression") {
    const dot = parent.text.lastIndexOf(".");
    const recv = dot > 0 ? parent.text.slice(0, dot) : "";
    const r = safeResolve(engine, st, st.tree, line, col, recv);
    if (r?.kind === "value" && r.typeFullName) {
      const simple = r.typeFullName.split(".").pop()!;
      // project members first (a project type may share a simple name with an API type)
      const hit = findMemberOn(engine, r.typeFullName, name);
      if (hit) {
        return { ok: true, target: mkTarget({
          kind: hit.kind, fqn: hit.fqn, container: hit.container,
          declFile: hit.file, declLine: hit.line, declCol: hit.col,
          scope: "member", ownerTypeFqn: hit.container, via: recv,
        }) };
      }
      // Unity/BCL member — refuse with a clear reason
      const rt = engine.unity.findType(simple);
      if (rt && apiMatches(rt.fullName, r.typeFullName)) {
        return { ok: false, reason: `'${name}' is defined in the compiled '${rt.fullName.split(".")[0]}' assembly — engine/API symbols cannot be renamed` };
      }
      return { ok: false, reason: `cannot resolve member '${recv}.${name}' to a project symbol` };
    }
    return { ok: false, reason: `cannot resolve the receiver of '.${name}'` };
  }

  /* bare identifier — scope wins, then the type family, then types */
  if (ctx === "bare" || ctx === "decl" || ctx === "typePos" || ctx === "attr") {
    // 1) locals / params / fields in scope
    const scope = engine.scopeSymbols(st, line, col) as SymbolInfo[];
    const local = scope.find((s) => s.name === name && (s.kind === "local" || s.kind === "parameter"));
    if (local && (local.line < line || (local.line === line && local.col <= col))) {
      return { ok: true, target: mkTarget({
        kind: local.kind, declFile: local.file, declLine: local.line, declCol: local.col, scope: "local",
      }) };
    }
    const scopeField = scope.find((s) => s.name === name && (s.kind === "field" || s.kind === "property" || s.kind === "event"));
    if (scopeField && scopeField.container) {
      return { ok: true, target: mkTarget({
        kind: scopeField.kind, fqn: scopeField.fqn, container: scopeField.container,
        declFile: scopeField.file, declLine: scopeField.line, declCol: scopeField.col,
        scope: "member", ownerTypeFqn: scopeField.container,
      }) };
    }
    // 2) bare method call inside a type family (override-aware)
    const ownerFqn2 = enclosingTypeName(st.tree, line, col);
    if (ownerFqn2) {
      const hit = findMemberOn(engine, ownerFqn2, name) ?? findMemberOnDerived(engine, ownerFqn2, name);
      if (hit) {
        return { ok: true, target: mkTarget({
          kind: hit.kind, fqn: hit.fqn, container: hit.container,
          declFile: hit.file, declLine: hit.line, declCol: hit.col,
          scope: "member", ownerTypeFqn: hit.container, via: "this",
        }) };
      }
    }
    // 3) static member via type name or a type identifier itself
    const cands = engine.projectTypes.get(name.toLowerCase()) as SymbolInfo[] | undefined;
    if (cands?.length) {
      const t = pickTypeCandidate(cands, st, path);
      return { ok: true, target: mkTarget({ kind: t.kind, fqn: t.fqn, container: t.container, declFile: t.file, declLine: t.line, declCol: t.col, scope: "type" }) };
    }
    // 4) static member access through a type simple name that IS the identifier? handled above.
    return { ok: false, reason: `'${name}' does not resolve to a project symbol (engine/API symbols cannot be renamed)` };
  }

  return { ok: false, reason: `'${name}' cannot be renamed here` };
}

function guessCtx(parent: SyntaxNode | null, ident: SyntaxNode): IdentRef["ctx"] {
  if (!parent) return "bare";
  if (parent.type === "member_access_expression" && parent.childForFieldName("name")?.id === ident.id) return "member";
  if (parent.type === "constructor_declaration") return "ctor";
  if (parent.type === "attribute") return "attr";
  return "bare";
}

/** the identifier under (or adjacent to) the caret — word-aware, so a caret on
 *  the last letter or just past a word still hits the symbol (VS/Rider behavior) */
function identAtCaret(st: any, line: number, col: number): SyntaxNode | null {
  const text = (st.content ?? "").split("\n")[line] ?? "";
  const isWord = (ch: string | undefined) => !!ch && /[A-Za-z0-9_]/.test(ch);
  let c = Math.min(col, Math.max(0, text.length));
  if (!isWord(text[c])) {
    if (isWord(text[c - 1])) c -= 1;
    else if (isWord(text[c + 1])) c += 1; // caret just before the word
    else {
      // caret on punctuation — try the deepest tree node's identifier fallback
      const node = findNodeAt(st.tree, line, Math.max(0, col - 1));
      return node?.type === "identifier" ? node : null;
    }
  }
  let start = c;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (c + 1 < text.length && isWord(text[c + 1])) c++;
  const word = text.slice(start, c + 1);
  if (!word || !/^[A-Za-z_]/.test(word)) return null;
  const node = findNodeAt(st.tree, line, start);
  // climb to an identifier whose text + start position match the word
  let n: SyntaxNode | null = node;
  while (n) {
    if (n.type === "identifier" && n.text === word
      && n.startPosition.row === line && Math.abs(n.startPosition.column - start) <= 1) return n;
    const ids = n.descendantsOfType?.("identifier") ?? [];
    for (const idn of ids) {
      if (idn.text === word && idn.startPosition.row === line
        && Math.abs(idn.startPosition.column - start) <= 1) return idn;
    }
    n = n.parent;
  }
  return null;
}

function nearestIdent(node: SyntaxNode | null, line: number, col: number): SyntaxNode | null {
  let n: SyntaxNode | null = node;
  while (n) {
    if (n.type === "identifier") return n;
    for (let i = n.childCount - 1; i >= 0; i--) {
      const c = n.child(i);
      if (c?.type === "identifier" && c.text) {
        const s = c.startPosition;
        if (s.row === line && col >= s.column && col <= s.column + c.text.length) return c;
        return c;
      }
    }
    n = n.parent;
  }
  return null;
}

function safeResolve(engine: any, st: any, tree: Tree, line: number, col: number, expr: string) {
  try { return engine.resolveExpression(st, line, col, expr); } catch { return null; }
}

function apiMatches(rtFull: string, typeFull: string): boolean {
  if (rtFull === typeFull) return true;
  const strip = (s: string) => s.replace(/`\d+/g, "").toLowerCase();
  return strip(rtFull) === strip(typeFull) || typeFull.toLowerCase() === rtFull.split(".").pop()?.toLowerCase();
}

/** find a member with `name` on the project type (or its base chain) */
function findMemberOn(engine: any, typeFqn: string, name: string): SymbolInfo | null {
  const seen = new Set<string>();
  let cur: string | null = typeFqn;
  while (cur && !seen.has(cur.toLowerCase())) {
    seen.add(cur.toLowerCase());
    const members = (engine.projectMembers.get(cur.toLowerCase())
      ?? engine.projectMembers.get(cur.split(".").pop()!.toLowerCase())) as SymbolInfo[] | undefined;
    const hit = members?.find((m) => m.name === name);
    if (hit) return hit;
    // walk to the base type
    const arr = engine.projectTypes.get(cur.split(".").pop()!.toLowerCase()) as SymbolInfo[] | undefined;
    const baseSimple = arr?.[0]?.base?.replace(/^\s*:\s*/, "").split(",")[0]?.trim().split(".").pop() ?? null;
    if (!baseSimple || baseSimple === cur.split(".").pop()) return null;
    const baseTypes = engine.projectTypes.get(baseSimple.toLowerCase()) as SymbolInfo[] | undefined;
    cur = baseTypes?.[0]?.fqn ?? null;
  }
  return null;
}

function findMemberOnDerived(engine: any, typeFqn: string, name: string): SymbolInfo | null {
  // breadth over derived project types: does any subclass override `name`?
  const simple = typeFqn.split(".").pop()!.toLowerCase();
  const out: SymbolInfo[] = [];
  for (const arr of engine.projectTypes.values()) {
    for (const t of arr) {
      const parts = (t.base ?? "").replace(/^\s*:\s*/, "").split(",").map((s: string) => s.trim().split(".").pop()!.toLowerCase());
      if (parts.includes(simple)) out.push(t);
    }
  }
  for (const t of out) {
    const hit = findMemberOn(engine, t.fqn || t.name, name);
    if (hit) return hit;
  }
  return null;
}

function enclosingTypeName(tree: Tree, line: number, col: number): string | null {
  let node: SyntaxNode | null = findNodeAt(tree, line, col);
  while (node) {
    if (node.type === "class_declaration" || node.type === "struct_declaration") {
      return node.childForFieldName("name")?.text ?? null;
    }
    node = node.parent;
  }
  return null;
}

function pickTypeCandidate(cands: SymbolInfo[], st: FileSymbols, path: string): SymbolInfo {
  if (cands.length === 1) return cands[0];
  const sameFile = cands.find((c) => c.file === path);
  if (sameFile) return sameFile;
  const nsSet = new Set(st.namespaces);
  const usings = new Set(st.usings.map((u) => u.trim()));
  const sameNs = cands.find((c) => c.ns && (nsSet.has(c.ns) || [...nsSet].some((n) => n.startsWith(c.ns + "."))));
  if (sameNs) return sameNs;
  const used = cands.find((c) => c.ns && usings.has(c.ns));
  if (used) return used;
  return cands[0];
}

/* ------------------------------------------------------------------ */
/* reference collection                                               */
/* ------------------------------------------------------------------ */

interface CollectedRef { file: string; line: number; col: number; length: number }

function addRef(map: Map<string, CollectedRef[]>, file: string, line: number, col: number, length: number) {
  const list = map.get(file);
  const r: CollectedRef = { line, col, length };
  if (list) {
    if (list.some((x) => x.line === line && x.col === col)) return;
    list.push(r);
  } else map.set(file, [r]);
}

/** all types whose base chain (or interface list) hits `rootSimple` — includes root */
function typeFamily(engine: any, rootFqn: string): Map<string, SymbolInfo> {
  const rootSimple = rootFqn.split(".").pop()!.toLowerCase();
  const family = new Map<string, SymbolInfo>();
  const rootArr = (engine.projectTypes.get(rootSimple) ?? []) as SymbolInfo[];
  const root = rootArr.find((t) => (t.fqn || t.name).toLowerCase() === rootFqn.toLowerCase()) ?? rootArr[0];
  if (root) family.set((root.fqn || root.name).toLowerCase(), root);
  let changed = true;
  while (changed) {
    changed = false;
    for (const arr of engine.projectTypes.values()) {
      for (const t of arr) {
        const key = (t.fqn || t.name).toLowerCase();
        if (family.has(key)) continue;
        const parts = (t.base ?? "").replace(/^\s*:\s*/, "").split(",").map((s: string) => s.trim().split(".").pop()!.toLowerCase()).filter(Boolean);
        if (parts.some((p) => family.has(p) || p === rootSimple)) {
          family.set(key, t);
          changed = true;
        }
      }
    }
  }
  return family;
}

/** can `file` see symbols from namespace `ns`? (for type simple-name disambiguation) */
function fileSeesNs(file: FileSymbols, ns: string): boolean {
  if (!ns) return true;
  if (file.namespaces.some((n) => n === ns || n.startsWith(ns + ".") || ns.startsWith(n + "."))) return true;
  if (file.usings.some((u) => u.trim() === ns)) return true;
  // a parent namespace is imported implicitly: file has namespace A.B, symbol ns A.B.C? no —
  // but file ns A + symbol ns A.B is visible unqualified only from inside A's *scope*: covered by prefix above
  return false;
}

/** innermost enclosing body block of the declaration at (line, col) */
function enclosingBlock(tree: Tree, line: number, col: number): SyntaxNode | null {
  let node: SyntaxNode | null = findNodeAt(tree, line, col);
  let block: SyntaxNode | null = null;
  while (node) {
    if (node.type === "block") block = node;
    if (node.type === "method_declaration" || node.type === "constructor_declaration"
      || node.type === "local_function_statement" || node.type === "accessor_declaration"
      || node.type === "property_declaration") break;
    node = node.parent;
  }
  return block;
}

/** plan a full rename. `newName` empty → target info only (validation still runs). */
export function computeRename(
  engine: any,
  path: string,
  line: number,
  col: number,
  newName: string,
): RenamePlan {
  const at = symbolAt(engine, path, line, col);
  if (!at.ok) return { ok: false, reason: at.reason, edits: [], warnings: [] };
  const target = at.target;
  const warnings: string[] = [];

  const invalid = newName ? validRenameName(newName) : null;
  if (invalid && newName) return { ok: false, reason: invalid, target, edits: [], warnings: [] };
  if (newName && newName === target.name) {
    return { ok: true, target, newName, edits: [], warnings: ["name is unchanged — nothing to do"] };
  }

  const { refs, unparsed, ambiguous } = collectRefs(engine, target);

  if (target.scope === "member") {
    if (target.kind === "field") {
      warnings.push("Unity serializes fields by name — scene/prefab Inspector links keep the old name until re-linked in the Editor.");
    }
    if (target.kind === "method" && UNITY_MESSAGE_NAMES.has(target.name)) {
      warnings.push(`'${target.name}' is a Unity message — the engine calls it by name, so renaming changes when (and if) Unity invokes it.`);
    }
  }

  if (ambiguous.size) {
    warnings.push(`${ambiguous.size} file${ambiguous.size === 1 ? "" : "s"} skipped — another type named '${target.name}' is visible there; rename those manually.`);
  }

  if (unparsed > 0) {
    warnings.push(`${unparsed} script${unparsed === 1 ? "" : "s"} not loaded yet were skipped — open the workspace fully (Brain: Reindex Workspace) for 100% coverage.`);
  }

  // Unity file pairing: class Foo in Foo.cs → move Foo.cs + Foo.cs.meta
  if (target.scope === "type" && (target.kind === "class" || target.kind === "struct")) {
    const base = target.declFile.split("/").pop() ?? "";
    if (base.toLowerCase() === target.name.toLowerCase() + ".cs") {
      warnings.push(`class file will be renamed to ${newName}.cs (and its .meta — the asset GUID is preserved).`);
      warnings.push("Unity scene/prefab references use the asset GUID, so components keep working after the rename.");
    }
  }

  const edits: RenameFileEdits[] = [...refs.entries()]
    .map(([fpath, ranges]) => ({
      path: fpath,
      ranges: ranges.sort((a, b) => b.line - a.line || b.col - a.col), // bottom-up for stable application
    }))
    .filter((e) => e.ranges.length > 0);

  let fileRename: RenamePlan["fileRename"] = null;
  if (target.scope === "type" && (target.kind === "class" || target.kind === "struct") && newName) {
    const base = target.declFile.split("/").pop() ?? "";
    if (base.toLowerCase() === target.name.toLowerCase() + ".cs" && newName.toLowerCase() !== target.name.toLowerCase()) {
      const dir = target.declFile.includes("/") ? target.declFile.slice(0, target.declFile.lastIndexOf("/")) : "";
      fileRename = {
        from: target.declFile,
        to: (dir ? dir + "/" : "") + newName + ".cs",
        metaFrom: target.declFile + ".meta",
        metaTo: (dir ? dir + "/" : "") + newName + ".cs.meta",
      };
    }
  }

  return { ok: true, target, newName: newName || undefined, edits, fileRename, warnings };
}

/* ======================= Phase 8 — find all uses ======================= */

/** collected reference ranges per file + diagnostics shared by rename and find-uses */
interface CollectedRefs {
  refs: Map<string, CollectedRef[]>;
  unparsed: number;
  ambiguous: Set<string>;
}

function collectRefs(engine: any, target: RenameTarget): CollectedRefs {
  const refs = new Map<string, CollectedRef[]>();
  const files = engine.files as Map<string, { content: string; tree: Tree | null; symbols: FileSymbols }>;
  let unparsed = 0;
  const ambiguous = new Set<string>();

  /* ---------------- local / parameter ---------------- */
  if (target.scope === "local") {
    const st = files.get(target.declFile);
    if (!st?.tree) return { refs, unparsed, ambiguous };
    addRef(refs, target.declFile, target.declLine, target.declCol, target.name.length);
    const block = enclosingBlock(st.tree, target.declLine, target.declCol) ?? st.tree.rootNode;
    const visit = (n: SyntaxNode) => {
      if (n.type === "identifier") {
        if (n.text === target.name) {
          const ctx = refCtxOf(st.symbols.typeRefs, n);
          if (ctx !== "decl" || (n.startPosition.row === target.declLine && n.startPosition.column === target.declCol)) {
            addRef(refs, target.declFile, n.startPosition.row, n.startPosition.column, n.text.length);
          }
        }
        return;
      }
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (c) visit(c);
      }
    };
    visit(block);
  }

  /* ---------------- member (field / property / method / event) ---------------- */
  if (target.scope === "member" && target.ownerTypeFqn) {
    const family = typeFamily(engine, target.ownerTypeFqn);
    const familySimples = new Set([...family.keys()].map((k) => k.split(".").pop()!));

    // declaration itself + overrides in derived classes (same simple name, container in family)
    for (const arr of (engine.projectMembers as Map<string, SymbolInfo[]>).values()) {
      for (const m of arr) {
        if (m.name !== target.name || m.kind === "enumMember") continue;
        if (!familySimples.has(m.container.split(".").pop()!.toLowerCase())) continue;
        // method overrides must share the kind; fields with the same name in a subclass shadow — still rename both? no:
        if (m.kind !== target.kind) continue;
        addRef(refs, m.file, m.line, m.col, m.name.length);
      }
    }

    for (const [fpath, st] of files) {
      if (!st.tree) { unparsed++; continue; }
      const f = st.symbols;
      const familyFiles = new Set([...family.values()].map((t) => t.file));
      const insideFamily = familyFiles.has(fpath) || [...family.values()].some((t) => (t.fqn || t.name) === "");
      for (const r of f.typeRefs ?? []) {
        if (r.name !== target.name) continue;
        if (r.ctx === "member") {
          const recv = receiverBefore(st.content, r.line, r.col);
          if (!recv) continue;
          const resolved = safeResolve(engine, st, st.tree, r.line, r.col, recv);
          if (resolved?.kind === "value" && resolved.typeFullName) {
            const simple = resolved.typeFullName.split(".").pop()!.toLowerCase();
            if (familySimples.has(simple) || [...family.keys()].some((k) => k === resolved.typeFullName.toLowerCase())) {
              addRef(refs, fpath, r.line, r.col, r.length);
            }
          }
          continue;
        }
        if (r.ctx === "bare" && (insideFamily || familySimples.has((enclosingTypeName(st.tree, r.line, r.col) ?? "").toLowerCase()))) {
          // skip locals shadowing the member
          const shadow = (engine.scopeSymbols(st, r.line, r.col) as SymbolInfo[])
            .some((s) => s.name === target.name && (s.kind === "local" || s.kind === "parameter"));
          if (shadow) continue;
          addRef(refs, fpath, r.line, r.col, r.length);
          continue;
        }
        if (r.ctx === "ctor") continue; // constructor names bind to classes, not members
        // decl refs of the same member kind in family containers were added above via the index
      }
    }
  }

  /* ---------------- type ---------------- */
  if (target.scope === "type") {
    const simpleLower = target.name.toLowerCase();
    const attrMode = target.name.endsWith("Attribute");
    const attrSimple = attrMode ? target.name.slice(0, -"Attribute".length).toLowerCase() : null;

    // same simple name declared elsewhere → per-file ambiguity guard
    const rivals = ([...(engine.projectTypes as Map<string, SymbolInfo[]>).values()].flat())
      .filter((t) => t.name.toLowerCase() === simpleLower && (t.fqn || t.name).toLowerCase() !== target.fqn.toLowerCase());

    addRef(refs, target.declFile, target.declLine, target.declCol, target.name.length);

    for (const [fpath, st] of files) {
      if (!st.tree) { unparsed++; continue; }
      const f = st.symbols;
      const rivalVisible = rivals.some((rv) => fileSeesNs(f, rv.ns ?? ""));
      for (const r of f.typeRefs ?? []) {
        const isName = r.name === target.name
          || (r.ctx === "attr" && attrSimple !== null && r.name.toLowerCase() === attrSimple);
        if (!isName) continue;
        if (r.ctx === "decl") {
          // another declaration with the same name in this file: only skip when it is NOT our target
          if (!(fpath === target.declFile && r.line === target.declLine)) continue;
          addRef(refs, fpath, r.line, r.col, r.length);
          continue;
        }
        if (r.ctx === "ctor") {
          // constructor binds to its enclosing class — must be OUR class
          const owner = ctorOwnerName(st.tree, r.line, r.col);
          if (owner === target.name) addRef(refs, fpath, r.line, r.col, r.length);
          continue;
        }
        if (rivalVisible) { ambiguous.add(fpath); continue; }
        addRef(refs, fpath, r.line, r.col, r.length);
      }
    }
  }

  return { refs, unparsed, ambiguous };
}

/** Phase 8 — one hit for the usages panel. */
export interface UseHit {
  file: string;
  line: number;         // 0-based
  col: number;          // 0-based
  length: number;
  text: string;         // trimmed source line for the panel row
  isDecl: boolean;
}

/** Phase 8 (user: "when selected method or variable it shows in window like the
 *  error and warning window the places that method or variable ... able to point
 *  where does it come from") — resolve the symbol at the caret and return every
 *  project reference plus a human-readable origin. Same resolution machinery as
 *  F2 rename, so scope/family/override rules stay identical. */
export interface SymbolUsesResult {
  ok: boolean;
  reason?: string;
  name?: string;
  kind?: string;
  container?: string;
  declFile?: string;
  declLine?: number;
  declCol?: number;
  origin?: string;      // "method Enemy.TakeDamage — Assets/.../Enemy.cs:42 · Assembly-CSharp"
  uses: UseHit[];
  warnings: string[];
}

export function findSymbolUses(engine: any, path: string, line: number, col: number): SymbolUsesResult {
  const files = engine.files as Map<string, { content: string; tree: Tree | null; symbols: FileSymbols }>;
  const at = symbolAt(engine, path, line, col);
  if (!at.ok) {
    // not a project symbol — but if it is a compiled API type we can still say WHERE IT COMES FROM
    const st = files.get(path);
    if (st?.tree) {
      const ident = identAtCaret(st, line, col);
      const nm = ident?.text ?? "";
      if (nm) {
        const rt = engine.unity.findType(nm);
        if (rt) {
          return {
            ok: true, name: rt.name, kind: rt.info.kind ?? "class", container: rt.ns,
            declFile: "", declLine: 0, declCol: 0,
            origin: `${rt.fullName} — compiled API (${(engine.unity.assemblyNames?.() ?? []).join(", ") || "Unity/BCL"})`,
            uses: [],
            warnings: [],
          };
        }
      }
    }
    return { ok: false, reason: at.reason, uses: [], warnings: [] };
  }

  const target = at.target;
  const { refs, unparsed, ambiguous } = collectRefs(engine, target);

  const uses: UseHit[] = [];
  for (const [fpath, ranges] of refs) {
    const st = files.get(fpath);
    const lines = st ? st.content.split("\n") : [];
    for (const r of ranges) {
      uses.push({
        file: fpath, line: r.line, col: r.col, length: r.length,
        text: (lines[r.line] ?? "").trim().slice(0, 240),
        isDecl: fpath === target.declFile && r.line === target.declLine && r.col === target.declCol,
      });
    }
  }
  uses.sort((a, b) => (b.isDecl ? 1 : 0) - (a.isDecl ? 1 : 0) || a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);

  const warnings: string[] = [];
  if (unparsed > 0) warnings.push(`${unparsed} script${unparsed === 1 ? "" : "s"} not parsed yet — some references may be missing until the workspace is fully indexed.`);
  if (ambiguous.size > 0) warnings.push(`${ambiguous.size} file${ambiguous.size === 1 ? "" : "s"} skipped — another type named '${target.name}' is visible there.`);

  const where = `${target.declFile}:${(target.declLine ?? 0) + 1}`;
  const asm: string | null = engine.assemblyOf ? engine.assemblyOf(target.declFile) : null;
  let origin: string;
  if (target.scope === "member" && target.container) {
    origin = `${target.kind} ${target.container.split(".").pop()}.${target.name} — ${where}${asm ? ` · ${asm}` : ""}`;
  } else if (target.scope === "type") {
    origin = `${target.kind} ${target.name}${target.container ? ` in ${target.container}` : ""} — ${where}${asm ? ` · ${asm}` : ""}`;
  } else {
    origin = `${target.kind} ${target.name} — ${where}`;
  }

  return {
    ok: true,
    name: target.name,
    kind: target.kind,
    container: target.container,
    declFile: target.declFile,
    declLine: target.declLine,
    declCol: target.declCol,
    origin,
    uses,
    warnings,
  };
}

function refCtxOf(refs: IdentRef[] | undefined, n: SyntaxNode): IdentRef["ctx"] {
  return refs?.find((r) => r.line === n.startPosition.row && r.col === n.startPosition.column && r.name === n.text)?.ctx ?? "bare";
}

/** receiver text of `recv.name` whose name starts at (line, col) */
function receiverBefore(content: string, line: number, col: number): string | null {
  const lines = content.split("\n");
  const text = lines[line] ?? "";
  const before = text.slice(0, col);
  const m = before.match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\.\s*$/);
  return m ? m[1] : null;
}

function ctorOwnerName(tree: Tree, line: number, col: number): string | null {
  let node: SyntaxNode | null = findNodeAt(tree, line, col);
  while (node) {
    if (node.type === "constructor_declaration") {
      // keep climbing to the owning class
      let p = node.parent;
      while (p) {
        if (p.type === "class_declaration" || p.type === "struct_declaration") {
          return p.childForFieldName("name")?.text ?? null;
        }
        p = p.parent;
      }
    }
    node = node.parent;
  }
  return null;
}
