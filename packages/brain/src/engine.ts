/** VelvetSharp brain — the intelligence engine facade */
import type { Tree, SyntaxNode } from "web-tree-sitter";
import {
  initCSharpParser, parseCSharp, extractFileSymbols, extractDiagnostics, findNodeAt, firstIdentifier,
  type ParserHandles,
} from "./parser";
import { UnityApi, type ResolvedType, type ResolvedMember } from "./unity";
import { prettyType } from "./pretty";
import { UNITY_SNIPPETS, CSHARP_SNIPPETS, CSHARP_KEYWORDS, UNITY_LIFECYCLE, UNITY_MESSAGE_NAMES, pickLoopVar, buildLoopSnippet, buildForeachSnippet, buildSingletonSnippet, type LifecycleDef } from "./snippets";
import { ST, MOD_DECLARATION, MOD_STATIC, TokenSink } from "./semantic";
import { normalizeRelPath, type CsprojInfo } from "./csproj";
import {
  buildAssemblyGraph, assemblyForFile, canSeeAssembly, seesEngine,
  type AssemblyGraph, type AsmdefInfo,
} from "./asmdef";
import { semanticAnalysis } from "./diagnostics";
import { scanPreproc, buildDefineSet, type PreprocScan } from "./preproc";
import { buildDependencyGraph } from "./deps";
import { symbolAt, computeRename, findSymbolUses, type SymbolUsesResult } from "./rename";
import { buildCallFlow, type CallFlowResult } from "./callflow";
import type {
  AnalysisResult, CompletionItem, Diagnostic, FileSymbols, HoverResult,
  SearchHit, SignatureInfo, DefinitionResult, SymbolInfo, OutlineEntry,
  SemanticReport, SemRange, DepGraph, RenameTarget, RenamePlan,
} from "./types";

export interface EngineOptions {
  wasmLocator: (file: string) => string;
  unityDb?: ApiDbJson | null;
  /** optional second API DB (BCL: mscorlib/System/System.Core) merged on top */
  bclDb?: ApiDbJson | null;
}

// structural type to avoid importing metadata here
type ApiDbJson = {
  assembly: string; version: string;
  namespaces: Record<string, Record<string, any>>;
};

export interface FileState {
  content: string;
  /** null when the file was indexed from the startup cache without a parse —
   *  the tree is built on first open/edit (updateFile) */
  tree: Tree | null;
  symbols: FileSymbols;
  version: number;
}

export class VelvetSharpEngine {
  private h!: ParserHandles;
  readonly unity = new UnityApi();
  /** file path → parsed state (public so the rename engine can walk every script) */
  files = new Map<string, FileState>();
  /** type simple-name (lower) -> SymbolInfo[] across project */
  projectTypes = new Map<string, SymbolInfo[]>();
  /** "container.fqn" -> members */
  projectMembers = new Map<string, SymbolInfo[]>();
  private projects: CsprojInfo[] = [];
  /** normalized relative file path -> assembly name (from csproj auto-config) */
  private assemblyByFile = new Map<string, string>();
  /** union of all detected csproj DefineConstants */
  readonly defines = new Set<string>();
  /** Phase 11 — Unity editor version from ProjectSettings/ProjectVersion.txt
   *  (drives the UNITY_<major>_<minor>_OR_NEWER symbol chain) */
  private unityVersion = "";
  /** Phase 11 — project custom defines (ProjectSettings scriptingDefineSymbols
   *  + any extra sources); unioned with csproj DefineConstants for #if */
  private unityDefines = new Set<string>();
  /** v0.5.0 — .asmdef reference graph (assembly hunting + completion scoping) */
  private asmGraph: AssemblyGraph | null = null;
  private asmInfo: AsmdefInfo[] = [];
  private nsAsmIndexCache: Map<string, Set<string>> | null = null;
  stats = { files: 0, types: 0, members: 0, lastParseMs: 0 };

  static async create(opts: EngineOptions): Promise<VelvetSharpEngine> {
    const e = new VelvetSharpEngine();
    e.h = await initCSharpParser(opts.wasmLocator);
    if (opts.unityDb) e.unity.loadFromJson(opts.unityDb as any);
    if (opts.bclDb) e.unity.mergeFromJson(opts.bclDb as any);
    return e;
  }

  /* ------------------------------ workspace ------------------------------ */

  async loadFiles(files: { path: string; content: string }[]): Promise<void> {
    const t0 = performance.now();
    for (let i = 0; i < files.length; i++) {
      this.updateFile(files[i].path, files[i].content);
      // yield so concurrently-queued worker calls (completions/diagnostics) can interleave
      if (i % 25 === 24) await new Promise((r) => setTimeout(r, 0));
    }
    this.stats.lastParseMs = Math.round(performance.now() - t0);
  }

  /** `deep` also runs the semantic pass in this call (v0.7.0): one parse serves
   *  syntax + semantics, halving keystroke latency vs the old two-RPC flow */
  updateFile(path: string, content: string, deep = false): AnalysisResult {
    if (!path.endsWith(".cs")) {
      return { symbols: { path, usings: [], namespaces: [], types: [], members: [], typeRefs: [] }, diagnostics: [], parseMs: 0 };
    }
    const t0 = performance.now();
    const prev = this.files.get(path);
    // v0.7.1: full re-parse every time — passing prev.tree without tree.edit()
    // corrupted trees (see parseCSharp doc comment; the "oid" return-type bug)
    const tree = parseCSharp(this.h, content);
    const symbols = extractFileSymbols(this.h, path, content, tree);
    const diagnostics = extractDiagnostics(tree);
    diagnostics.push(...this.extraLints(content, symbols));
    // Phase 11 — preprocessor: structural directive diagnostics, inactive-branch
    // suppression for syntax/lints, inactive ranges for the editor's dimming
    const pre = this.preprocPass(content, diagnostics);
    this.files.set(path, { content, tree, symbols, version: (prev?.version ?? 0) + 1 });
    // incremental index update — only this file's old contributions are removed (was: full rebuild)
    this.reindexFile(path, prev?.symbols ?? null, symbols);
    this.stats.files = this.files.size;
    let sem: SemanticReport | undefined;
    if (deep) {
      try { sem = semanticAnalysis(this, this.files.get(path)!, tree, content, path, pre); } catch { /* semantic is best-effort */ }
    }
    return { symbols, diagnostics, parseMs: Math.round(performance.now() - t0), sem };
  }

  removeFile(path: string): void {
    const prev = this.files.get(path);
    if (!prev) return;
    this.files.delete(path);
    this.reindexFile(path, prev.symbols, { path, usings: [], namespaces: [], types: [], members: [], typeRefs: [] });
    this.stats.files = this.files.size;
  }

  /** v0.7.0 — keep the index in sync after explorer file operations (create /
   *  delete / rename): drop every entry that is no longer in the fresh scan.
   *  New files are pushed separately via updateFile/loadFiles. Returns the
   *  removed paths so the caller can also clean UI state. */
  syncFiles(paths: string[]): string[] {
    const keep = new Set(paths.map((p) => normalizeRelPath(p)));
    const removed: string[] = [];
    for (const p of [...this.files.keys()]) {
      if (!keep.has(normalizeRelPath(p))) {
        this.removeFile(p);
        removed.push(p);
      }
    }
    return removed;
  }

  /** v0.5.0 — index files from the startup cache WITHOUT re-parsing (tree stays
   *  null; a file is fully parsed the first time it is opened or edited). This is
   *  what makes warm starts fast: no disk reads, no tree-sitter for unchanged files. */
  loadCachedSymbols(entries: { path: string; symbols: FileSymbols }[]): void {
    for (const e of entries) {
      if (!e.path.endsWith(".cs") || !e.symbols) continue;
      const st: FileState = { content: "", tree: null, symbols: e.symbols, version: 0 };
      this.files.set(e.path, st);
      this.reindexFile(e.path, null, e.symbols);
    }
    this.stats.files = this.files.size;
  }

  /** JSON-safe snapshot of the whole index (written to the startup cache) */
  filesSymbols(): { path: string; symbols: FileSymbols }[] {
    const out: { path: string; symbols: FileSymbols }[] = [];
    for (const [path, st] of this.files) out.push({ path, symbols: st.symbols });
    return out;
  }

  /** project-wide sweep for ONE file: syntax + deep semantic report (v0.5.0
   *  Problems bar). Returns null for cache-indexed files without a parse yet —
   *  the caller parses those lazily on open/edit. */
  sweepFile(path: string): { syntax: Diagnostic[]; sem: SemanticReport } | null {
    const st = this.files.get(path);
    if (!st || !st.tree) return null;
    const syntax = extractDiagnostics(st.tree);
    syntax.push(...this.extraLints(st.content, st.symbols));
    // Phase 11 — preprocessor filter + structural diagnostics (same as updateFile)
    const pre = this.preprocPass(st.content, syntax);
    const sem = semanticAnalysis(this, st, st.tree, st.content, path, pre);
    return { syntax, sem };
  }

  /** add one file's symbols to the project index — O(file), not O(workspace) */
  private reindexFile(path: string, oldSyms: FileSymbols | null, newSyms: FileSymbols): void {
    this.nsAsmIndexCache = null; // namespace→assembly index depends on the project index
    if (oldSyms) {
      for (const t of oldSyms.types) this.removeFromIndex(this.projectTypes, t.name.toLowerCase(), path);
      for (const m of oldSyms.members) this.removeFromIndex(this.projectMembers, m.container.toLowerCase(), path);
    }
    for (const t of newSyms.types) this.addToIndex(this.projectTypes, t.name.toLowerCase(), t);
    for (const m of newSyms.members) this.addToIndex(this.projectMembers, m.container.toLowerCase(), m);
    let types = 0, members = 0;
    this.projectTypes.forEach((a) => (types += a.length));
    this.projectMembers.forEach((a) => (members += a.length));
    this.stats.types = types;
    this.stats.members = members;
  }

  private addToIndex(map: Map<string, SymbolInfo[]>, key: string, sym: SymbolInfo): void {
    const arr = map.get(key);
    if (arr) arr.push(sym);
    else map.set(key, [sym]);
  }

  private removeFromIndex(map: Map<string, SymbolInfo[]>, key: string, file: string): void {
    const arr = map.get(key);
    if (!arr) return;
    const i = arr.findIndex((s) => s.file === file);
    if (i >= 0) {
      arr.splice(i, 1);
      if (!arr.length) map.delete(key);
    }
  }

  /* --------------------------- csproj auto-config --------------------------- */

  /** configure from auto-detected .csproj files (assembly map + define constants) */
  setProjects(list: CsprojInfo[]): void {
    this.projects = list;
    this.assemblyByFile.clear();
    this.defines.clear();
    for (const pr of list) {
      for (const d of pr.defines) this.defines.add(d);
      for (const f of pr.compileFiles) this.assemblyByFile.set(normalizeRelPath(f), pr.name);
    }
  }

  projectsSummary(): { name: string; files: number; defines: number; unityRefs: number; langVersion?: string }[] {
    return this.projects.map((p) => ({
      name: p.name, files: p.compileFiles.length, defines: p.defines.length,
      unityRefs: p.unityReferences.length, langVersion: p.langVersion,
    }));
  }

  /** which assembly does this script belong to?
   *  csproj Compile items (exact) → nearest .asmdef directory → predefined guess */
  assemblyOf(path: string): string | null {
    const cs = this.assemblyByFile.get(normalizeRelPath(path));
    if (cs) return cs;
    if (this.asmGraph) return assemblyForFile(this.asmGraph, path);
    return null;
  }

  /** v0.5.0 — register parsed .asmdef files and build the reference graph.
   *  Uses the csproj list registered via setProjects for file→assembly mapping. */
  setAssemblyGraph(asmdefs: AsmdefInfo[]): void {
    this.asmInfo = asmdefs;
    this.asmGraph = buildAssemblyGraph(asmdefs, this.projects);
    this.nsAsmIndexCache = null;
  }

  asmdefSummary(): { assemblies: number; asmdefs: number; unresolved: number; names: string[] } {
    const g = this.asmGraph;
    if (!g) return { assemblies: 0, asmdefs: 0, unresolved: 0, names: [] };
    return {
      assemblies: g.asmNames.size + g.predefined.size,
      asmdefs: g.asmNames.size,
      unresolved: g.unresolved.length,
      names: [...g.asmNames].sort(),
    };
  }

  /** namespace → set of project assemblies declaring types in it (lazy index) */
  private nsAsmIndex(): Map<string, Set<string>> {
    if (this.nsAsmIndexCache) return this.nsAsmIndexCache;
    const m = new Map<string, Set<string>>();
    for (const arr of this.projectTypes.values()) {
      for (const t of arr) {
        if (!t.ns) continue;
        const asm = this.assemblyOf(t.file);
        if (!asm) continue;
        let s = m.get(t.ns);
        if (!s) { s = new Set(); m.set(t.ns, s); }
        s.add(asm);
      }
    }
    this.nsAsmIndexCache = m;
    return m;
  }

  /** v0.5.0 — drop namespaces the file's assembly cannot legally reference:
   *  engine namespaces need engine refs (noEngineReferences honours .asmdef),
   *  project namespaces need the owning assembly to be referenced. */
  private gateNamespaces(set: Set<string>, path: string): Set<string> {
    const g = this.asmGraph;
    if (!g) return set;
    const fromAsm = this.assemblyOf(path);
    const engineOk = seesEngine(g, fromAsm);
    const allDbAsms = this.unity.assemblyNames();
    const bclAsms = new Set(allDbAsms.slice(1)); // dbs[0] = Unity engine db
    const idx = this.nsAsmIndex();
    const out = new Set<string>();
    for (const ns of set) {
      if (!ns) { out.add(ns); continue; }        // global namespace always visible
      const providers = this.unity.assembliesOf(ns);
      if (providers.length) {
        const onlyBcl = providers.every((p) => bclAsms.has(p));
        if (!onlyBcl && !engineOk) continue;     // asmdef with noEngineReferences
        out.add(ns);
        continue;
      }
      const asms = idx.get(ns);                  // project-declared namespace
      if (asms && asms.size) {
        let ok = false;
        for (const a of asms) if (canSeeAssembly(g, fromAsm, a)) { ok = true; break; }
        if (ok) out.add(ns);
        continue;
      }
      out.add(ns);                               // unknown namespace — keep (typed text, empty yet)
    }
    return out;
  }

  /** reference info for the status-bar assembly chip */
  assemblyRefsOf(path: string): { name: string | null; refs: string[]; engine: boolean } {
    const name = this.assemblyOf(path);
    const g = this.asmGraph;
    if (!g || !name) return { name, refs: [], engine: seesEngine(g, name) };
    return { name, refs: [...(g.refsOf.get(name) ?? [])].sort(), engine: seesEngine(g, name) };
  }

  /** public gate for the diagnostics pass: can `fromAsm` legally reference `toAsm`? */
  canSeeAssemblyPublic(fromAsm: string, toAsm: string): boolean {
    if (!this.asmGraph) return true;
    return canSeeAssembly(this.asmGraph, fromAsm, toAsm);
  }

  /** all known types with this simple name — API DBs + project (CS0246 / CS0104) */
  typeCandidates(name: string): { full: string; ns: string; origin: "api" | "project"; asm: string | null }[] {
    const out: { full: string; ns: string; origin: "api" | "project"; asm: string | null }[] = [];
    const seen = new Set<string>();
    for (const rt of this.unity.typeCandidates(name)) {
      if (seen.has(rt.fullName.toLowerCase())) continue;
      seen.add(rt.fullName.toLowerCase());
      out.push({ full: rt.fullName, ns: rt.ns, origin: "api", asm: null });
    }
    for (const t of this.projectTypes.get(name.toLowerCase()) ?? []) {
      const full = t.fqn || (t.ns ? t.ns + "." + t.name : t.name);
      if (seen.has(full.toLowerCase())) continue;
      seen.add(full.toLowerCase());
      out.push({ full, ns: t.ns ?? "", origin: "project", asm: this.assemblyOf(t.file) });
    }
    return out;
  }

  /** insertion point for a new `using N;` — after the last top-level using, else file top */
  usingInsertPos(st: FileState): { line: number; col: number } {
    const root = st.tree?.rootNode;
    if (root) {
      let last = -1;
      for (const c of root.namedChildren) {
        if (c.type === "using_directive") last = c.endPosition.row;
        else if (c.type !== "comment") break;
      }
      if (last >= 0) return { line: last + 1, col: 0 };
    }
    return { line: 0, col: 0 };
  }

  definesOf(): string[] {
    return [...this.defines];
  }

  /** Phase 11 — register the Unity editor version (e.g. "2022.3.41f1") read by
   *  the app from ProjectSettings/ProjectVersion.txt. Powers the
   *  UNITY_<major>_<minor>_OR_NEWER chain used by #if evaluation. */
  setUnityVersion(version: string): void {
    this.unityVersion = (version ?? "").trim();
  }

  /** Phase 11 — project-level Unity info: editor version + custom scripting
   *  defines (ProjectSettings.asset scriptingDefineSymbols). Custom defines
   *  survive csproj re-config (setProjects clears only ITS OWN define set). */
  setUnityProjectInfo(version: string, customDefines: string[]): void {
    this.unityVersion = (version ?? "").trim();
    this.unityDefines.clear();
    for (const d of customDefines ?? []) {
      const t = (d ?? "").trim();
      if (/^[A-Za-z_]\w*$/.test(t)) this.unityDefines.add(t);
    }
  }

  /** Phase 11 — the effective pre-defined symbol set for #if evaluation:
   *  Unity base set + version chain + csproj/scriptingDefineSymbols custom set */
  preprocDefines(): Set<string> {
    return buildDefineSet([...this.defines, ...this.unityDefines], this.unityVersion);
  }

  /** Phase 11 — run the directive scanner and produce the file's preproc view:
   *  structural diagnostics + inactive runs, with syntax/extra lints filtered
   *  to active lines (VS parity: an inactive branch is not compiled). */
  private preprocPass(content: string, diagnostics: Diagnostic[]): PreprocScan {
    const scan = scanPreproc(content, this.preprocDefines());
    const isActive = (line: number) => line < scan.active.length && scan.active[line] === 1;
    const kept = diagnostics.filter((d) => isActive(d.line));
    diagnostics.length = 0;
    diagnostics.push(...kept, ...scan.diagnostics);
    return scan;
  }

  /** project the file belongs to (per csproj Compile items) */
  projectOf(path: string): CsprojInfo | null {
    const asm = this.assemblyOf(path);
    if (!asm) return null;
    return this.projects.find((p) => p.name === asm) ?? null;
  }

  /* --------------------------- namespace visibility --------------------------- */

  /** namespaces whose members can be referenced unqualified from this file:
   *  usings + enclosing namespace chain + csproj implicit usings (+ sane defaults) */
  visibleNamespacesFor(st: FileState): Set<string> {
    const out = new Set<string>([""]);          // global namespace
    for (const u of st.symbols.usings) out.add(u.trim());
    for (const ns of st.symbols.namespaces) {
      out.add(ns);
      const parts = ns.split(".");
      for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("."));
    }
    // csproj ImplicitUsings → compiler-injected namespaces
    const proj = this.projectOf(st.symbols.path);
    if (proj?.implicitUsings) {
      for (const ns of IMPLICIT_USING_SET) out.add(ns);
    }
    // bare files (no usings at all): keep the classic helpful defaults
    if (st.symbols.usings.length === 0 && !proj?.implicitUsings) {
      out.add("System");
      out.add("UnityEngine");
    }
    // v0.5.0 — assembly gating: a file only sees what its assembly references
    return this.gateNamespaces(out, st.symbols.path);
  }

  private extraLints(content: string, symbols: FileSymbols): Diagnostic[] {
    const out: Diagnostic[] = [];
    // duplicate members within the same type (same file). Methods are keyed by
    // (name, param types) so OVERLOADS are legal — only true signature
    // collisions error (CS0111/CS0102).
    const sigOf = (m: SymbolInfo) => (m.params ?? []).map((p) => (p.type ?? "").replace(/\s+/g, "").trim()).join(",");
    const keyOf = (m: SymbolInfo) =>
      m.kind === "method"
        ? `${m.container}::${m.name}(${sigOf(m)})`
        : `${m.container}::${m.kind}:${m.name}`;
    const seen = new Map<string, SymbolInfo>();
    for (const m of symbols.members) {
      if (m.kind === "enumMember") continue;
      const k = keyOf(m);
      const prev = seen.get(k);
      if (prev && prev.line !== m.line) {
        out.push({
          line: m.line, col: m.col, length: m.name.length,
          message: m.kind === "method"
            ? `Method '${m.name}(${sigOf(m)})' is already defined in '${m.container.split(".").pop()}' (duplicate signature)`
            : `Member '${m.name}' is already defined in '${m.container.split(".").pop()}'`,
          severity: "error", source: "velvetsharp.lint",
        });
      } else seen.set(k, m);
    }
    // v0.6.1 — cross-file duplicates are TYPE-level only (CS0101). The old
    // member-level cross-file check flooded real Unity projects (1039 errors):
    // identical field names like `Instance` in different classes are perfectly
    // legal C#, and partial classes / copy-refactor files made it worse. Now a
    // duplicate is reported only when the SAME full type name (namespace +
    // nested path + name) is declared in another file — and never when either
    // declaration is `partial`.
    // v0.7.0 — same-name types in DIFFERENT assemblies are also legal Unity C#
    // (two asmdefs each declaring `Helpers.Util` compile fine because the types
    // are in separate compilation units), so rivals must live in the same
    // assembly to be an error.
    const fileKey = normalizeRelPath(symbols.path);
    const myAsm = this.assemblyOf(fileKey);
    const dupTypeReported = new Set<string>();
    for (const t of symbols.types) {
      if (!t.name || t.partial) continue;
      const fqnKey = t.fqn.toLowerCase();
      if (dupTypeReported.has(fqnKey)) continue;
      const rivals = (this.projectTypes.get(t.name.toLowerCase()) ?? []).filter((x) =>
        x.fqn.toLowerCase() === fqnKey
        && normalizeRelPath(x.file) !== fileKey
        && !x.partial
        && this.assemblyOf(normalizeRelPath(x.file)) === myAsm);
      if (rivals.length) {
        dupTypeReported.add(fqnKey);
        out.push({
          line: t.line, col: t.col, length: t.name.length,
          message: `Type '${t.name}' is also defined in ${rivals[0].file} (duplicate type definition — same assembly & namespace)`,
          severity: "error", source: "velvetsharp.lint",
        });
      }
    }
    return out;
  }

  fileContent(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  /* ------------------------------ completion ------------------------------ */

  completions(path: string, line: number, col: number): CompletionItem[] {
    const st = this.files.get(path);
    if (!st || !st.tree) return [];
    const text = st.content;
    const pos = textToOffset(text, line, col);
    const before = text.slice(Math.max(0, pos - 300), pos);

    // 1) using-directive → namespace completion (must run before member access —
    //    "System.Collections.G" would otherwise be treated as a receiver chain)
    const usingMatch = before.match(/(^|[\r\n])\s*(?:static\s+)?using\s+([A-Za-z0-9_.]*)(\s*=)?$/);
    if (usingMatch && !usingMatch[3]) {
      return this.completeNamespaces(usingMatch[2] ?? "", path);
    }

    // 2) member access: receiver dot (possibly dotted chain)
    const memberMatch = before.match(/([A-Za-z_][A-Za-z0-9_<>,.\[\]()` ]*?)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)?$/);
    if (memberMatch) {
      const recvText = memberMatch[1].trim();
      const prefix = memberMatch[2] ?? "";
      return this.completeMemberAccess(st, line, col, recvText, prefix);
    }

    // 3) variable/field declaration position → suggest a smart name for the type
    const declMatch = before.match(/([A-Za-z_][A-Za-z0-9_]*(?:<[^<>]*>)?(?:\s*\[\s*\])?)\s+([A-Za-z_][A-Za-z0-9_]*)?$/);
    if (declMatch && !/[.]\s*[A-Za-z_][A-Za-z0-9_]*\s+$/.test(before)) {
      const typeToken = declMatch[1];
      const partial = declMatch[2] ?? "";
      const prev = before.slice(0, before.length - declMatch[0].length).trimEnd();
      const isDeclContext = /^(return|throw|case|is|as|new|when|await|in|out|ref)$/.test(prev.split(/[\s({\[]/).pop() ?? "") === false;
      if (isDeclContext && this.isKnownTypeName(typeToken)) {
        const names = this.nameSuggestionsFor(typeToken).filter((n) => !partial || n.toLowerCase().startsWith(partial.toLowerCase()));
        if (names.length) {
          return names.map((n) => ({
            label: n,
            kind: "local" as const,
            detail: `suggested name for ${typeToken.replace(/\s+/g, "")}`,
            insert: n,
            sortText: "0" + n.toLowerCase(),
            filterText: n,
          }));
        }
      }
    }

    // 4) bare context
    const bareMatch = before.match(/([A-Za-z_][A-Za-z0-9_]*)?$/);
    const prefix = bareMatch?.[1] ?? "";
    return this.completeBare(st, line, col, prefix);
  }

  /** is this text a type name we know (API DB, project, builtin, or var)? */
  private isKnownTypeName(token: string): boolean {
    const t = token.replace(/\s+/g, "").replace(/<.*$/, "").replace(/\[\]$/, "");
    if (t === "var") return true;
    if (/^(int|float|double|decimal|bool|string|char|long|short|byte|uint|ulong|ushort|sbyte|object)$/.test(t)) return true;
    const simple = t.split(".").pop() ?? t;
    if (this.unity.findType(simple) || this.unity.findTypeExact(t)) return true;
    const arr = this.projectTypes.get(simple.toLowerCase());
    return !!arr?.length;
  }

  /** smart variable-name suggestions for a declared type (rb / go / playerHealth…) */
  nameSuggestionsFor(typeToken: string): string[] {
    const clean = typeToken.replace(/\s+/g, "").replace(/<.*$/, "").replace(/\[\]$/, "");
    if (clean === "var") return [];
    const simple = clean.split(".").pop() ?? clean;
    const lower = simple.toLowerCase();
    const keywords = new Set(CSHARP_KEYWORDS);
    const out: string[] = [];
    const push = (n: string | undefined) => {
      if (!n) return;
      if (!/^[a-z_][A-Za-z0-9_]*$/.test(n)) return;
      if (keywords.has(n) || UnityApi.SELF_GLOBALS[n]) return;
      if (!out.includes(n)) out.push(n);
    };
    for (const a of NAME_ABBREV[lower] ?? []) push(a);
    push(camel(simple));
    const stripped = simple.replace(/^(My|Custom|Base|Abstract)/, "").replace(/(Controller|Manager|Component|Behaviour|Behavior|Script|Handler|Service|Data|Info)$/, "");
    if (stripped && stripped !== simple && stripped.length >= 2) push(camel(stripped));
    push(lower);
    return out.slice(0, 4);
  }

  /** `using` directive completion — namespaces from API DBs + the project,
   *  gated to what this file's assembly can legally reference (v0.5.0).
   *  Segment-aware: "UnityE" → UnityEngine/UnityEditor, "System.Collections.G" → Generic. */
  completeNamespaces(typed: string, path?: string): CompletionItem[] {
    const all = new Set<string>(this.unity.allNamespaces);
    for (const arr of this.projectTypes.values()) {
      for (const t of arr) if (t.ns) all.add(t.ns);
    }
    const gated = this.gateNamespaces(all, path ?? "");
    const out: CompletionItem[] = [];
    const seen = new Set<string>();
    const typedLower = typed.toLowerCase();
    const tSegs = typedLower.split(".");
    for (const ns of gated) {
      if (!ns) continue; // skip the global "" namespace
      const nsSegs = ns.toLowerCase().split(".");
      // all typed segments except the last must match exactly; the last is a prefix
      let ok = true;
      for (let i = 0; i < tSegs.length; i++) {
        if (i >= nsSegs.length) { ok = false; break; }
        if (i === tSegs.length - 1) {
          if (!nsSegs[i].startsWith(tSegs[i])) { ok = false; break; }
        } else if (nsSegs[i] !== tSegs[i]) { ok = false; break; }
      }
      if (!ok) continue;
      // remaining path starting at the last (partially) matched segment
      const lastSegStart = tSegs.length > 1
        ? tSegs.slice(0, -1).reduce((a, s) => a + s.length + 1, 0)
        : 0;
      const rest = ns.slice(lastSegStart);
      const insert = typed === "" ? ns.split(".")[0] + ";" : rest + ";";
      const nextSeg = rest.split(".")[0];
      const key = nextSeg.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        label: nextSeg,
        kind: "namespace" as const,
        detail: `namespace ${ns}`,
        insert,
        sortText: "0" + key + "." + rest.toLowerCase(),
        filterText: rest,
      });
      if (out.length > 120) break;
    }
    out.sort((a, b) => (a.sortText ?? "").localeCompare(b.sortText ?? ""));
    return out;
  }

  private completeMemberAccess(st: FileState, line: number, col: number, recvText: string, prefix: string): CompletionItem[] {
    const resolved = this.resolveExpression(st, line, col, recvText);
    if (resolved.kind === "type") {
      const rt = resolved.unityType
        ? resolved.unityType
        : resolved.projectType
          ? this.unity.findType(resolved.projectType.name)
          : null;
      if (rt) return this.unity.completeStaticMembers(rt, prefix);
      // project type statics
      if (resolved.projectType) {
        const members = this.projectMembers.get(resolved.projectType.fqn.toLowerCase()) ?? [];
        return members.filter((m) => m.static === true).map((m) => this.projectMemberToItem(m, prefix));
      }
      return [];
    }
    if (resolved.kind === "value" && resolved.typeFullName) {
      const simple = resolved.typeFullName.split(".").pop()!;
      // try Unity first
      const rt = this.unity.findType(simple);
      if (rt && apiTypeMatches(rt, resolved.typeFullName)) {
        return this.unity.completeMembers(rt, prefix);
      }
      // project type — Phase 8: the whole FAMILY (own + inherited + Unity messages)
      const own = this.projectMembers.get(resolved.typeFullName.toLowerCase())
        ?? this.projectMembers.get(simple.toLowerCase());
      if (own) {
        const fam: CompletionItem[] = [];
        this.familyMemberItems(st, resolved.typeFullName, prefix, new Set(), fam, new Set());
        return fam.length ? fam : own.map((m) => this.projectMemberToItem(m, prefix));
      }
      // enums / primitives
      if (resolved.typeFullName === "System.String") {
        return UnityApi.STRING_MEMBERS.map((s) => ({
          label: s.name, kind: "property" as const, detail: s.sig,
          sortText: "0" + s.name.toLowerCase(),
        })).filter((c) => !prefix || c.label.toLowerCase().startsWith(prefix.toLowerCase()));
      }
      const simpleMembers = this.projectMembers.get(simple.toLowerCase());
      if (simpleMembers) {
        const fam: CompletionItem[] = [];
        this.familyMemberItems(st, simple, prefix, new Set(), fam, new Set());
        return fam.length ? fam : simpleMembers.map((m) => this.projectMemberToItem(m, prefix));
      }
    }
    return [];
  }

  private projectMemberToItem(m: SymbolInfo, prefix: string): CompletionItem {
    const sig = m.kind === "method"
      ? `${m.returnType ?? "void"} ${m.name}(${(m.params ?? []).map((p) => `${prettyLocalType(p.type)} ${p.name}`).join(", ")})`
      : `${m.returnType ?? ""} ${m.name}`.trim();
    return {
      label: m.name,
      kind: m.kind === "method" ? "method" : m.kind,
      detail: sig,
      doc: m.doc,
      insert: m.kind === "method" ? `${m.name}(${(m.params ?? []).map((_, i) => `\${${i + 1}:arg${i + 1}}`).join(", ")})` : m.name,
      sortText: (m.kind === "method" ? "1" : "0") + m.name.toLowerCase(),
      filterText: m.name,
    };
  }

  /** Phase 8 — every member of a project type's FAMILY: the type's own members
   *  (declared anywhere in the file — bottom of file included — the index is
   *  position independent) plus inherited members walked up the base chain:
   *  project bases recurse, Unity/BCL bases resolve through the API db (which
   *  now carries the injected Unity messages, so MonoBehaviour-derived scripts
   *  see Awake/Start/Update here too). `outNames` dedupes; locals win over
   *  shadowing members by seeding it with the in-scope local names. */
  private familyMemberItems(
    st: FileState, typeName: string, prefix: string,
    seenTypes: Set<string>, out: CompletionItem[], outNames: Set<string>,
  ): void {
    const simple = typeName.split(".").pop()!;
    const key = simple.toLowerCase();
    if (seenTypes.has(key)) return;
    seenTypes.add(key);
    const p = prefix.toLowerCase();

    const collect = (arr: SymbolInfo[] | undefined) => {
      for (const m of arr ?? []) {
        if (m.kind === "enumMember" || m.kind === "namespace" || m.kind === "local" || m.kind === "parameter") continue;
        if (outNames.has(m.name)) continue;
        if (p && !m.name.toLowerCase().startsWith(p)) continue;
        outNames.add(m.name);
        out.push(this.projectMemberToItem(m, prefix));
      }
    };
    // container keys are stored under the declaring type's name — try fqn and simple
    collect(this.projectMembers.get(typeName.toLowerCase()));
    collect(this.projectMembers.get(key));

    // base chain
    const typeSym = this.projectTypes.get(key)?.find((t) => t.name === simple) ?? this.projectTypes.get(key)?.[0];
    const baseTxt = typeSym?.base ?? "";
    for (const part of baseTxt.replace(/^\s*:\s*/, "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const baseSimple = part.replace(/<.*$/, "").split(".").pop()!.trim();
      if (!baseSimple || /^(object|ValueType|Enum|Delegate|MulticastDelegate)$/i.test(baseSimple)) continue;
      const projArr = this.projectTypes.get(baseSimple.toLowerCase());
      const proj = projArr?.find((t) => t.name === baseSimple) ?? projArr?.[0];
      if (proj) {
        this.familyMemberItems(st, proj.fqn || proj.name, prefix, seenTypes, out, outNames);
        continue;
      }
      const rt = this.unity.findType(baseSimple);
      if (rt) {
        for (const item of this.unity.completeMembers(rt, prefix)) {
          if (outNames.has(item.label)) continue;
          outNames.add(item.label);
          out.push(item);
        }
      }
    }
  }

  private completeBare(st: FileState, line: number, col: number, prefix: string): CompletionItem[] {
    const out: CompletionItem[] = [];
    const p = prefix.toLowerCase();
    const lineText = this.lineText(st.content, line);
    const trimmed = lineText.slice(0, col).trimStart();

    // Unity message context: member level of a class (also covers "override " / "void " lines)
    const ctx = this.memberContext(st, line, col);
    const afterVoid = /\bvoid\s+[A-Za-z_]*$/.test(trimmed);
    if (ctx && !ctx.insideMethod) {
      const declared = new Set(
        (this.projectMembers.get((ctx.className ?? "").toLowerCase()) ?? []).map((m) => m.name)
      );
      const rank = ctx.isMono ? "0" : "2";
      for (const l of UNITY_LIFECYCLE) {
        if (p && !l.name.toLowerCase().startsWith(p)) continue;
        if (ctx.className && declared.has(l.name)) continue; // already defined in this class
        out.push(this.lifecycleItem(l, rank, afterVoid ? "name" : "insert"));
      }
    }

    // locals in scope
    const scope = this.scopeSymbols(st, line, col);
    for (const s of scope) {
      if (p && !s.name.toLowerCase().startsWith(p)) continue;
      out.push({
        label: s.name, kind: s.kind === "local" ? "local" : "property",
        detail: `${prettyLocalType(s.returnType ?? "")} ${s.name}`,
        sortText: "0" + s.name.toLowerCase(),
      });
    }

    // Phase 8 — the enclosing class's OWN members (methods/fields/properties —
    // including ones declared BELOW the caret) + inherited members from base
    // classes and Unity messages. Bare completions used to offer only locals,
    // so calling a sibling method written at the bottom of the file (or on the
    // base class) showed nothing — exactly what the user reported.
    const curType = this.currentTypeName(st, line, col);
    if (curType) {
      const fam: CompletionItem[] = [];
      const famNames = new Set<string>(scope.map((s) => s.name)); // locals shadow members
      this.familyMemberItems(st, curType, prefix, new Set(), fam, famNames);
      out.push(...fam);
    }

    // snippets — Unity templates + C# statement snippets (if / for / forr /
    // foreach / while / try / prop …). Loop snippets pick an index variable that
    // is not already used anywhere in the file: i → j → k → l …  (v0.5.0)
    const taken = new Set<string>([
      ...(st.content.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []),
      ...this.scopeSymbols(st, line, col).map((s) => s.name),
    ]);
    const pushSnippet = (label: string, detail: string, body: string) => {
      if (p && !label.toLowerCase().startsWith(p)) return;
      out.push({ label, kind: "snippet", detail, insert: body, sortText: "4" + label.toLowerCase() });
    };
    for (const s of UNITY_SNIPPETS) {
      let body = s.body;
      // singleton snippets are generated for the class the caret is in
      if (s.label === "Singleton") body = buildSingletonSnippet(curType);
      else if (s.label === "SingletonPersistent") body = buildSingletonSnippet(curType, { persistent: true });
      pushSnippet(s.label, s.detail, body);
    }
    for (const s of CSHARP_SNIPPETS) {
      let body = s.body;
      if (s.label === "for" || s.label === "forr") body = buildLoopSnippet(s.label as "for" | "forr", pickLoopVar(taken, "index"));
      else if (s.label === "foreach") body = buildForeachSnippet(pickLoopVar(taken, "foreach"));
      pushSnippet(s.label, s.detail, body);
    }

    // API types (Unity + BCL) — strictly scoped to the file's visible namespaces
    const visible = [...this.visibleNamespacesFor(st)];
    out.push(...this.unity.completeTypes(visible, prefix));

    // project types — scoped to visible namespaces / same file / global,
    // AND gated by the assembly reference graph (v0.5.0)
    const fromAsm = this.assemblyOf(st.symbols.path);
    for (const arr of this.projectTypes.values()) {
      for (const t of arr) {
        if (p && !t.name.toLowerCase().startsWith(p)) continue;
        const sameFile = t.file === st.symbols.path;
        const nsOk = !t.ns || visible.includes(t.ns);
        if (!sameFile) {
          if (!nsOk) continue;
          // assembly scoping: the owner must be referenced (or auto-referenced)
          const tAsm = this.assemblyOf(t.file);
          if (tAsm && fromAsm && !canSeeAssembly(this.asmGraph, fromAsm, tAsm)) continue;
        }
        out.push({
          label: t.name, kind: t.kind === "interface" ? "interface" : t.kind,
          detail: `${t.ns ? t.ns + "." : ""}${t.name} (project)`, sortText: "2" + t.name.toLowerCase(),
        });
      }
    }

    // keywords
    for (const k of CSHARP_KEYWORDS) {
      if (p && !k.startsWith(p)) continue;
      out.push({ label: k, kind: "keyword", sortText: "9" + k });
    }
    return out;
  }

  private lifecycleItem(l: LifecycleDef, rank: string, mode: "insert" | "name"): CompletionItem {
    const params = l.params
      ? l.params.split(",").map((s, i) => `{${i + 1}:${s.trim().split(/\s+/).pop()}}`).join(", ")
      : "";
    const bodyPh = l.params ? "${2}" : "${1}";
    return {
      label: `${l.name}()`,
      kind: "method",
      detail: `Unity event function · void ${l.name}(${l.params})`,
      doc: l.doc,
      insert: mode === "insert"
        ? `private void ${l.name}(${params})\n{\n    ${bodyPh}\n}`
        : `${l.name}(${params})\n{\n    ${bodyPh}\n}`,
      sortText: rank + l.name.toLowerCase(),
      filterText: l.name,
    };
  }

  /** cursor context: null = inside a method body (expression context, no message suggestions) */
  private memberContext(st: FileState, line: number, col: number): { insideMethod: boolean; atMemberLevel: boolean; className: string | null; isMono: boolean } | null {
    let node: SyntaxNode | null = findNodeAt(st.tree, line, col);
    while (node) {
      if (node.type === "method_declaration" || node.type === "constructor_declaration" || node.type === "local_function_statement") {
        return null;
      }
      if (node.type === "class_declaration" || node.type === "struct_declaration") {
        const name = node.childForFieldName("name")?.text ?? null;
        const base = node.childForFieldName("bases")?.text ?? "";
        return {
          insideMethod: false, atMemberLevel: true, className: name,
          isMono: /MonoBehaviour|ScriptableObject|NetworkBehaviour/.test(base),
        };
      }
      node = node.parent;
    }
    return null;
  }

  /* ------------------------------- inference ------------------------------- */

  private lineText(content: string, line: number): string {
    let start = 0;
    const lines = content.split("\n");
    return lines[line] ?? "";
  }

  /** in-scope locals/params/fields with types, nearest-first */
  scopeSymbols(st: FileState, line: number, col: number): SymbolInfo[] {
    if (!st.tree) return []; // cache-indexed file without a parse yet
    const out: SymbolInfo[] = [];
    const root = st.tree.rootNode;
    // find enclosing method/class chain
    const chain: SyntaxNode[] = [];
    let node: SyntaxNode | null = findNodeAt(st.tree, line, col);
    while (node) { chain.push(node); node = node.parent; }
    chain.reverse(); // root -> leaf

    // params of enclosing method
    const method = [...chain].reverse().find((n) => n.type === "method_declaration");
    if (method) {
      const pl = method.childForFieldName("parameters");
      if (pl) {
        for (let i = 0; i < pl.childCount; i++) {
          const p = pl.child(i);
          if (p?.type === "parameter") {
            const t = p.childForFieldName("type");
            const n = p.childForFieldName("name");
            if (t && n) out.push({ name: n.text, kind: "parameter", returnType: t.text, container: "", fqn: "", file: st.symbols.path, line: p.startPosition.row, col: p.startPosition.column });
          }
        }
      }
    }

    // locals declared before cursor within enclosing method block
    const methodBlock = method?.childForFieldName("body");
    if (methodBlock) {
      const visit = (n: SyntaxNode) => {
        if (n.startPosition.row > line) return;
        if (n.type === "local_declaration_statement") {
          const decl = n.childForFieldName("declaration") ?? n.children.find((c) => c?.type === "variable_declaration") ?? null;
          const tNode = decl?.childForFieldName("type");
          if (decl) {
            for (let j = 0; j < decl.childCount; j++) {
              const vd = decl.child(j);
              if (vd?.type !== "variable_declarator") continue;
              const nNode = vd.childForFieldName("name") ?? firstIdentifier(vd);
              const init = initializerOf(vd);
              let ty = tNode?.text ?? "";
              if (ty === "var" && init) {
                ty = inferFromInitializer(this, st, init.text);
              }
              if (nNode) out.push({ name: nNode.text, kind: "local", returnType: ty, container: "", fqn: "", file: st.symbols.path, line: vd.startPosition.row, col: vd.startPosition.column });
            }
          }
        }
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i);
          if (c) visit(c);
        }
      };
      if (methodBlock.startPosition.row <= line) visit(methodBlock);
    }

    // fields + properties of enclosing types (walk chain for class nodes)
    for (const n of chain) {
      if (n.type === "class_declaration" || n.type === "struct_declaration" || n.type === "interface_declaration") {
        const clsName = n.childForFieldName("name")?.text ?? "";
        const members = this.projectMembers.get(clsName.toLowerCase()) ?? [];
        for (const m of members) {
          if (m.kind === "field" || m.kind === "property" || m.kind === "event") out.push(m);
        }
      }
    }
    return out;
  }

  /**
   * Resolve the type of an expression string (receiver of a member access).
   */
  resolveExpression(
    st: FileState, line: number, col: number, expr: string
  ): { kind: "value" | "type"; typeFullName?: string; unityType?: ResolvedType | null; projectType?: SymbolInfo; member?: ResolvedMember | null } {
    // split top-level segments; each segment: ident[<T,...>][(args)]
    const segs = splitSegments(expr);
    if (!segs.length) return { kind: "value" };

    let state: { kind: "value" | "type"; typeFullName?: string; unityType?: ResolvedType | null; projectType?: SymbolInfo } = { kind: "value" };

    // first segment resolution
    const first = segs[0];
    let inferred: string | null = null;

    // built-in literal receivers
    if (first.name === "this") {
      inferred = this.currentTypeName(st, line, col);
    } else if (/^\d+(\.\d+)?f?$/.test(first.name)) {
      inferred = /\./.test(first.name) || /f$/.test(first.name) ? "System.Single" : "System.Int32";
    } else if (/^".*"$/.test(first.name) || /^@?".*"$/.test(first.name)) {
      inferred = "System.String";
    } else if (/^'.*'$/.test(first.name)) {
      inferred = "System.Char";
    } else if (first.name === "true" || first.name === "false") {
      inferred = "System.Boolean";
    }

    if (!inferred) {
      // scope lookup
      const scope = this.scopeSymbols(st, line, col);
      const hit = scope.find((s) => s.name === first.name);
      if (hit) {
        let ty = hit.returnType ?? "";
        if (!ty || ty === "var") return { kind: "value" };
        if (hit.kind === "local" || hit.kind === "parameter" || hit.kind === "field" || hit.kind === "property") {
          inferred = this.canonicalizeType(st, ty);
        }
      }
    }

    if (!inferred) {
      // Unity self globals (transform, gameObject...) on MonoBehaviour-derived classes
      const curType = this.currentTypeName(st, line, col);
      if (curType) {
        const pt = this.projectTypes.get(curType.toLowerCase())?.[0];
        const baseTxt = pt?.base ?? "";
        const isUnityBehav = /MonoBehaviour|ScriptableObject|Behaviour|UIBehaviour/.test(baseTxt);
        if (isUnityBehav) {
          const g = UnityApi.SELF_GLOBALS[first.name];
          if (g) {
            state = { kind: "value", typeFullName: g };
            return this.continueChain(state, st, segs);
          }
        }
      }
      // static/enum type reference? (C# is case-sensitive — verify exact name)
      const uType = this.unity.findTypeIn(visibleUsings(st), first.name);
      const projArr = this.projectTypes.get(first.name.toLowerCase());
      if (projArr?.length && projArr[0].name === first.name) {
        state = { kind: "type", projectType: projArr[0] };
        return this.continueChain(state, st, segs);
      }
      if (uType && uType.name === first.name) {
        state = { kind: "type", unityType: uType, typeFullName: uType.fullName };
        return this.continueChain(state, st, segs);
      }
      return { kind: "value" };
    }

    state = { kind: "value", typeFullName: inferred };
    return this.continueChain(state, st, segs);
  }

  private continueChain(state: { kind: "value" | "type"; typeFullName?: string; unityType?: ResolvedType | null; projectType?: SymbolInfo }, st: FileState, segs: Segment[]) {
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i];
      if (state.kind === "type") {
        // static member access: Mathf.PI, GameObject.Find(...)
        let m: { type: string; kind: string } | null = null;
        if (state.unityType) {
          const mem = this.unity.memberOfType(state.unityType, seg.name);
          if (mem && (mem.static || mem.kind === "enumMember")) m = { type: mem.type, kind: mem.kind };
          else return { kind: "value" };
        } else if (state.projectType) {
          const members = this.projectMembers.get(state.projectType.fqn.toLowerCase()) ?? [];
          const mem = members.find((x) => x.name === seg.name && x.static);
          if (!mem) return { kind: "value" };
          m = { type: mem.returnType ?? "", kind: mem.kind };
        }
        if (!m) return { kind: "value" };
        state = { kind: "value", typeFullName: this.canonicalizeType(st, m.type) };
      } else if (state.kind === "value" && state.typeFullName) {
        const mem = this.resolveMemberOnType(st, state.typeFullName, seg.name, seg.isCall);
        if (!mem) return { kind: "value" };
        state = { kind: "value", typeFullName: mem, member: null } as any;
        state = { kind: "value", typeFullName: mem };
      }
    }
    return state;
  }

  /** resolve member -> canonical type full name (Unity db or project) */
  private resolveMemberOnType(st: FileState, typeFullName: string, member: string, isCall?: boolean): string | null {
    const simple = typeFullName.split(".").pop()!;
    const rt = this.unity.findType(simple);
    if (rt && apiTypeMatches(rt, typeFullName)) {
      const mem = this.unity.memberOfType(rt, member);
      if (mem) {
        if (mem.kind === "method") return this.canonicalizeType(st, mem.type, true);
        return this.canonicalizeType(st, mem.type, true);
      }
      return null;
    }
    // project type
    const members = this.projectMembers.get(typeFullName.toLowerCase())
      ?? this.projectMembers.get(simple.toLowerCase());
    if (members) {
      const mem = members.find((m) => m.name === member);
      if (mem?.returnType) return this.canonicalizeType(st, mem.returnType, true);
    }
    // common property supplements for types outside DB
    const SUPPLEMENT: Record<string, Record<string, string>> = {
      "System.String": { Length: "System.Int32" },
    };
    return SUPPLEMENT[typeFullName]?.[member] ?? null;
  }

  /** map a source-level type text to canonical name usable in index/db lookups */
  canonicalizeType(st: FileState, ty: string, fromApi = false): string {
    let t = ty.trim();
    if (t.endsWith("[]")) return this.canonicalizeType(st, t.slice(0, -2), fromApi) + "[]";
    if (t.endsWith("?")) return this.canonicalizeType(st, t.slice(0, -1), fromApi);
    const lt = t.indexOf("<");
    if (lt > 0 && t.endsWith(">")) {
      return this.canonicalizeType(st, t.slice(0, lt), fromApi); // generics: use open type for member lookup
    }
    if (/^(int|long|short|byte|sbyte|uint|ulong|ushort)$/.test(t)) return "System.Int32";
    if (/^(float)$/.test(t)) return "System.Single";
    if (/^(double)$/.test(t)) return "System.Double";
    if (/^(decimal)$/.test(t)) return "System.Decimal";
    if (t === "bool") return "System.Boolean";
    if (t === "string") return "System.String";
    if (t === "char") return "System.Char";
    if (t === "object") return "System.Object";
    if (t === "void") return "System.Void";
    // qualified or unqualified Unity type?
    if (this.unity.findType(t.split(".").pop()!)) {
      const rt = this.unity.findType(t.split(".").pop()!)!;
      const last = t.split(".").pop()!;
      if (fromApi || rt.fullName === t || stripTicks(rt.fullName).toLowerCase().endsWith("." + stripTicks(last).toLowerCase())) return rt.fullName;
    }
    // project type with namespace?
    const arr = this.projectTypes.get(t.split(".").pop()!.toLowerCase());
    if (arr?.length) return arr[0].fqn;
    return t;
  }

  private currentTypeName(st: FileState, line: number, col: number): string | null {
    if (!st.tree) return null;
    let node: SyntaxNode | null = findNodeAt(st.tree, line, col);
    while (node) {
      if (node.type === "class_declaration" || node.type === "struct_declaration") {
        return node.childForFieldName("name")?.text ?? null;
      }
      node = node.parent;
    }
    return null;
  }

  /* --------------------------------- hover --------------------------------- */

  hover(path: string, line: number, col: number): HoverResult | null {
    const st = this.files.get(path);
    if (!st || !st.tree) return null;
    const node = findNodeAt(st.tree, line, col);
    const ident = nearestIdentifier(node);
    if (!ident) return null;
    const range = { line: ident.startPosition.row, col: ident.startPosition.column, length: ident.endIndex - ident.startIndex };

    // MEMBER hover first: is this ident preceded by "recv."?
    const offEnd = textToOffset(st.content, ident.endPosition.row, ident.endPosition.column);
    const chain = chainBefore(st.content, offEnd);
    if (chain && chain.name === ident.text) {
      const r = this.resolveExpression(st, line, col, chain.recv);
      if (r.kind === "value" && r.typeFullName) {
        const simple = r.typeFullName.split(".").pop()!;
        const rt = this.unity.findType(simple);
        if (rt && apiTypeMatches(rt, r.typeFullName)) {
          const mem = this.unity.memberOfType(rt, ident.text);
          if (mem) return { signature: mem.signature, doc: mem.doc, range };
        }
        const pm = (this.projectMembers.get(r.typeFullName.toLowerCase()) ?? this.projectMembers.get(simple.toLowerCase()) ?? []).find((x) => x.name === ident.text);
        if (pm) {
          return {
            signature: pm.kind === "method"
              ? `${pm.returnType ?? "void"} ${pm.name}(${(pm.params ?? []).map((p) => p.name).join(", ")})`
              : `${pm.returnType ?? ""} ${pm.name}`.trim(),
            doc: `defined in ${pm.file}:${pm.line + 1}`,
            range,
          };
        }
      }
    }

    // resolve identifier as expression receiver (type hover)
    const resolved = this.resolveExpression(st, line, col, ident.text);
    if (resolved.kind === "type") {
      if (resolved.unityType) {
        const t = resolved.unityType;
        return {
          signature: `${t.info.kind} ${t.fullName}`,
          doc: t.info.d,
          range,
        };
      }
      if (resolved.projectType) {
        const t = resolved.projectType;
        return {
          signature: `${t.kind} ${t.name}  —  ${t.file}:${t.line + 1}`,
          doc: t.base ? `: ${t.base}` : undefined,
          range,
        };
      }
    }
    if (resolved.kind === "value" && resolved.typeFullName) {
      const simple = resolved.typeFullName.split(".").pop()!;
      const rt = this.unity.findType(simple);
      if (rt && apiTypeMatches(rt, resolved.typeFullName)) {
        return { signature: `${rt.info.kind} ${rt.fullName}`, doc: rt.info.d, range };
      }
      return { signature: prettyType(resolved.typeFullName), range };
    }
    return null;
  }

  /* ----------------------------- signature help ---------------------------- */

  signatureHelp(path: string, line: number, col: number): SignatureInfo | null {
    const st = this.files.get(path);
    if (!st || !st.tree) return null;
    const offset = textToOffset(st.content, line, col);
    const node = findNodeAt(st.tree, line, col);
    if (!node) return null;
    // climb to argument_list
    let argList: SyntaxNode | null = node;
    while (argList && argList.type !== "argument_list") argList = argList.parent;
    if (!argList) return null;
    const invocation = argList.parent; // invocation_expression
    const func = invocation?.childForFieldName("function");
    if (!func) return null;
    const calleeText = func.text; // may be dotted
    const calleeName = calleeText.split(".").pop()?.replace(/\(.*$/, "") ?? "";
    // receiver
    const recv = calleeText.includes(".") ? calleeText.slice(0, calleeText.lastIndexOf(".")) : "";
    // active param: count top-level commas before cursor inside list
    const upto = st.content.slice(offset - (node.startIndex <= offset ? 0 : 0), offset);
    const listStart = argList.startIndex;
    const inside = st.content.slice(listStart, offset);
    let depth = 0, active = 0;
    for (const ch of inside) {
      if (ch === "(" || ch === "<" || ch === "[") depth++;
      else if (ch === ")" || ch === ">" || ch === "]") depth--;
      else if (ch === "," && depth === 1) active++;
    }
    // gather candidates
    const infos: SignatureInfo[] = [];
    if (recv) {
      const r = this.resolveExpression(st, line, col, recv);
      if (r.kind === "value" && r.typeFullName) {
        const rt = this.unity.findType(r.typeFullName.split(".").pop()!);
        if (rt && apiTypeMatches(rt, r.typeFullName)) {
          const t = rt.info;
          for (const m of t.m ?? []) {
            if (m.n !== calleeName) continue;
            infos.push({
              label: prettyLabel(r.typeFullName, m),
              params: m.ps.map((p) => ({ name: p.n, type: p.t, doc: (p as any).pd })),
              doc: m.d,
              activeParam: Math.min(active, (m.ps.length ?? 1) - 1),
            });
          }
        }
      }
    } else {
      // bare call: Unity static types visible + project
      for (const ns of visibleUsings(st)) {
        const container = (this.unity as any).db?.namespaces?.[ns];
        if (!container) continue;
        for (const [tn, t] of Object.entries<any>(container)) {
          for (const m of t.m ?? []) {
            if (m.n !== calleeName || !m.s) continue;
            infos.push({
              label: prettyLabel(tn, m),
              params: m.ps.map((p) => ({ name: p.n, type: p.t, doc: (p as any).pd })),
              doc: m.d,
              activeParam: Math.min(active, (m.ps?.length ?? 1) - 1),
            });
          }
        }
      }
    }
    return infos[0] ?? null;
  }

  /* ------------------------------- go-to-def ------------------------------- */

  definitions(path: string, line: number, col: number): DefinitionResult | null {
    const st = this.files.get(path);
    if (!st || !st.tree) return null;
    const ident = nearestIdentifier(findNodeAt(st.tree, line, col));
    if (!ident) return null;
    const name = ident.text;

    // in-file locals first
    const scope = this.scopeSymbols(st, line, col);
    const local = scope.find((s) => s.name === name && s.file === path);
    if (local) return { file: local.file, line: local.line, col: local.col, name };

    // project members
    for (const arr of this.projectMembers.values()) {
      const m = arr.find((x) => x.name === name);
      if (m) return { file: m.file, line: m.line, col: m.col, name };
    }
    // project types
    const arr = this.projectTypes.get(name.toLowerCase());
    if (arr?.length) {
      const t = arr[0];
      return { file: t.file, line: t.line, col: t.col, name };
    }
    return null;
  }

  /* ------------------------------ symbols misc ----------------------------- */

  documentSymbols(path: string): SymbolInfo[] {
    const st = this.files.get(path);
    if (!st) return [];
    return [...st.symbols.types, ...st.symbols.members.filter((m) => m.kind !== "enumMember")];
  }

  /** hierarchical, line-ordered outline for the outline panel */
  outline(path: string): OutlineEntry[] {
    const st = this.files.get(path);
    if (!st) return [];
    const out: OutlineEntry[] = [];
    for (const t of st.symbols.types) {
      out.push({
        name: t.name, kind: t.kind, line: t.line, col: t.col, depth: 0,
        detail: t.base ? `: ${t.base.replace(/^\s*:\s*/, "")}` : undefined,
      });
    }
    for (const m of st.symbols.members) {
      if (m.kind === "enumMember") continue;
      out.push({
        name: m.name, kind: m.kind, line: m.line, col: m.col, depth: 1,
        detail: m.kind === "method" ? `(${(m.params ?? []).map((p) => p.type).join(", ")})` : (m.returnType ?? ""),
        isMessage: m.kind === "method" && UNITY_MESSAGE_NAMES.has(m.name),
      });
    }
    out.sort((a, b) => a.line - b.line || a.col - b.col);
    return out;
  }

  workspaceSymbols(query: string): SymbolInfo[] {
    const q = query.toLowerCase();
    const out: SymbolInfo[] = [];
    for (const arr of this.projectTypes.values()) {
      for (const t of arr) if (!q || t.name.toLowerCase().includes(q)) out.push(t);
    }
    for (const arr of this.projectMembers.values()) {
      for (const m of arr) if ((!q || m.name.toLowerCase().includes(q)) && m.kind === "method") out.push(m);
    }
    return out.slice(0, 200);
  }

  search(query: string, opts: { regex?: boolean; caseSensitive?: boolean; max?: number } = {}): SearchHit[] {
    const max = opts.max ?? 500;
    const hits: SearchHit[] = [];
    let re: RegExp | null = null;
    if (opts.regex) {
      try { re = new RegExp(query, opts.caseSensitive ? "g" : "gi"); } catch { return []; }
    }
    for (const [path, st] of this.files) {
      const lines = st.content.split("\n");
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        const line = lines[i];
        if (opts.regex && re) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(line)) && hits.length < max) {
            hits.push({ file: path, line: i, col: m.index, length: m[0].length, text: line });
            if (m[0].length === 0) re.lastIndex++;
          }
        } else {
          const hay = opts.caseSensitive ? line : line.toLowerCase();
          const needle = opts.caseSensitive ? query : query.toLowerCase();
          const idx = hay.indexOf(needle);
          if (idx >= 0) hits.push({ file: path, line: i, col: idx, length: query.length, text: line });
        }
      }
      if (hits.length >= max) break;
    }
    return hits;
  }

  /* --------------------------- semantic analysis --------------------------- */

  /** deep analysis: unused locals, unreachable code, missing returns, ref/interface
   *  misuse, obsolete API — returns diagnostics + decoration ranges */
  semantic(path: string, content?: string): SemanticReport {
    const st = this.files.get(path);
    let tree = st?.tree;
    let effective = st?.content ?? content ?? "";
    if (content !== undefined && st && st.content !== content) {
      tree = parseCSharp(this.h, content);
      effective = content;
    }
    if (!tree) return { diagnostics: [], unreachable: [], obsolete: [] };
    const workSt: FileState = st && st.content === effective
      ? st
      : { content: effective, tree, symbols: st?.symbols ?? { path, usings: [], namespaces: [], types: [], members: [], typeRefs: [] }, version: st?.version ?? 0 };
    // Phase 11 — the semantic() RPC is also preproc-aware (inactive suppression,
    // pragma, inactive ranges). Structural directive diagnostics already flow
    // through updateFile/sweepFile; semantic() only returns the semantic report.
    const pre = scanPreproc(effective, this.preprocDefines());
    return semanticAnalysis(this, workSt, tree, effective, path, pre);
  }

  /* ------------------- v0.6.0 — dependency graph + rename ------------------- */

  /** Rider-style class dependency graph. `scope` = folder prefix ("Assets/Net")
   *  or null/"" for the whole project; `includeExternal` adds Unity/BCL types. */
  dependencyGraph(scope: string | null, includeExternal = false): DepGraph {
    const all: FileSymbols[] = [];
    for (const st of this.files.values()) all.push(st.symbols);
    return buildDependencyGraph(this, all, scope ?? "", includeExternal);
  }

  /** identify the renameable symbol under the cursor (F2 target preview) */
  renamePrepare(path: string, line: number, col: number):
    { ok: true; target: RenameTarget } | { ok: false; reason: string } {
    return symbolAt(this, path, line, col);
  }

  /** full project-wide rename plan (ranges are 0-based, sorted bottom-up) */
  rename(path: string, line: number, col: number, newName: string): RenamePlan {
    return computeRename(this, path, line, col, newName);
  }

  /** Phase 8 — every project reference of the symbol at the caret + its origin
   *  (the usages panel). Same machinery as F2 rename, read-only. */
  findUses(path: string, line: number, col: number): SymbolUsesResult {
    return findSymbolUses(this, path, line, col);
  }

  /** Phase 9 — per-script call-flow graph: in-file method nodes + in-file call
   *  edges. Phase 13 (user: "only include the custom methods, remove the unity
   *  dll stuff"): engine/API calls are no longer drawn — calls into the user's
   *  OTHER scripts resolve as cross-file terminal nodes, everything pre-packaged
   *  is counted in hiddenCalls/extCount for the toolbar chip. Edges carry the
   *  per-caller call-order rank. Phase 10: an internal error lands as a
   *  readable empty result with the full stack, never as a dead RPC. */
  callFlow(path: string): CallFlowResult {
    try {
      return buildCallFlow(this, path);
    } catch (e: any) {
      // Phase 13 — the UI shows this reason AND a copy button, so include the
      // full stack: the user can paste exactly what went wrong into a report
      return {
        ok: false,
        reason: `internal error: ${String(e?.message ?? e)}`,
        errorStack: String(e?.stack ?? ""),
        file: path,
        nodes: [],
        edges: [],
        truncated: false,
        methodCount: 0,
        extCount: 0,
        hiddenCalls: 0,
        crossCount: 0,
      };
    }
  }

  /** files indexed from the startup cache that have no parse tree yet —
   *  the app reads these from disk + loadFiles before running rename */
  missingTrees(): string[] {
    const out: string[] = [];
    for (const [path, st] of this.files) if (!st.tree) out.push(path);
    return out;
  }

  /* --------------------------- semantic highlighting --------------------------- */

  /**
   * Full-document semantic tokens. `content` lets the caller pass fresher text than
   * the last analyzed snapshot — we parse a throwaway tree instead of serving stale
   * offsets (stale offsets would misplace colors while typing).
   */
  semanticTokens(path: string, content?: string): Uint32Array {
    const st = this.files.get(path);
    let tree = st?.tree;
    let effective = st?.content ?? content ?? "";
    if (content !== undefined && st && st.content !== content) {
      tree = parseCSharp(this.h, content);
      effective = content;
    }
    if (!tree) return new Uint32Array(0);
    const workSt: FileState = st && st.content === effective
      ? st
      : { content: effective, tree, symbols: st?.symbols ?? { path, usings: [], namespaces: [], types: [], members: [], typeRefs: [] }, version: st?.version ?? 0 };
    return this.buildSemanticTokens(workSt, tree);
  }

  private buildSemanticTokens(st: FileState, tree: Tree): Uint32Array {
    const sink = new TokenSink();
    const root = tree.rootNode;
    if (root.endIndex > 1_200_000) return sink.encode();
    const skip = new Set<number>(); // node.id — web-tree-sitter wrappers are NOT identity-stable
    const emit = (n: SyntaxNode | null, type: number, mods = 0) => {
      if (n) sink.push(n.startPosition.row, n.startPosition.column, n.endIndex - n.startIndex, type, mods);
    };

    // scope cache keyed by line (one scopeSymbols() walk per line, not per identifier)
    let scopeLine = -1;
    let scopeCache: SymbolInfo[] = [];
    const scopeAt = (line: number): SymbolInfo[] => {
      if (line !== scopeLine) {
        scopeCache = this.scopeSymbols(st, line, 0);
        scopeLine = line;
      }
      return scopeCache;
    };

    const typeTokenFor = (nameNode: SyntaxNode): number => {
      const name = nameNode.text.split(".").pop()?.replace(/<.*/, "") ?? nameNode.text;
      const rt = this.unity.findType(name);
      if (rt && (rt.name === name || rt.fullName === nameNode.text)) return ST.unityType;
      const arr = this.projectTypes.get(name.toLowerCase());
      if (arr?.length) {
        const k = arr[0].kind;
        return k === "interface" ? ST.interface : k === "struct" ? ST.struct : k === "enum" ? ST.enum : ST.class;
      }
      return ST.type;
    };

    /** resolve `recv.member` at a position against Unity DB + project index */
    const resolveMember = (recvText: string, member: string, line: number, col: number): { type: number; mods: number } | null => {
      let r: any;
      try { r = this.resolveExpression(st, line, col, recvText); } catch { return null; }
      const kindOf = (kind: string, isStatic: boolean): { type: number; mods: number } => ({
        type: kind === "method"
          ? (UNITY_MESSAGE_NAMES.has(member) ? ST.unityMethod : ST.method)
          : kind === "enumMember" ? ST.enumMember
          : kind === "event" ? ST.event
          : kind === "field" ? ST.field
          : ST.property,
        mods: isStatic ? MOD_STATIC : 0,
      });
      if (r?.kind === "type") {
        const rt = r.unityType ?? (r.projectType ? this.unity.findType(r.projectType.name) : null);
        if (rt) {
          const m = this.unity.memberOfType(rt, member);
          if (m) return kindOf(m.kind, m.static);
        }
        if (r.projectType) {
          const pm = (this.projectMembers.get(r.projectType.fqn.toLowerCase()) ?? []).find((x) => x.name === member);
          if (pm) return kindOf(pm.kind, !!pm.static);
        }
        return null;
      }
      if (r?.kind === "value" && r.typeFullName) {
        const simple = r.typeFullName.split(".").pop()!;
        const rt = this.unity.findType(simple);
        if (rt && rt.fullName === r.typeFullName) {
          const m = this.unity.memberOfType(rt, member);
          if (m) return kindOf(m.kind, m.static);
        }
        const pm = (this.projectMembers.get(r.typeFullName.toLowerCase()) ?? this.projectMembers.get(simple.toLowerCase()) ?? []).find((x) => x.name === member);
        if (pm) return kindOf(pm.kind, !!pm.static);
      }
      return null;
    };

    const TYPE_PARENTS = new Set([
      "generic_name", "qualified_name", "array_type", "nullable_type", "base_list",
      "as_expression", "is_expression", "cast_expression", "typeof_expression",
    ]);
    const DECL_MAP: Record<string, number> = {
      class_declaration: ST.class, struct_declaration: ST.struct,
      interface_declaration: ST.interface, enum_declaration: ST.enum,
      record_declaration: ST.class, delegate_declaration: ST.delegate,
      constructor_declaration: ST.class, destructor_declaration: ST.class,
      method_declaration: ST.method, property_declaration: ST.property,
      enum_member_declaration: ST.enumMember, event_declaration: ST.event,
    };

    const walk = (n: SyntaxNode) => {
      if (n.type === "identifier" && !skip.has(n.id)) {
        const parent = n.parent;
        const ptype = parent?.type ?? "";
        if (parent) {
          // field-name checks must compare node.id — wrappers differ per access
          const nameN = parent.childForFieldName?.("name");
          const typeN = parent.childForFieldName?.("type");
          const retN = parent.childForFieldName?.("returns");
          const isNameField = nameN ? nameN.id === n.id : false;
          const isTypeField = (typeN ? typeN.id === n.id : false) || (retN ? retN.id === n.id : false);
          if (isNameField && DECL_MAP[ptype] !== undefined) { emit(n, DECL_MAP[ptype], MOD_DECLARATION); return; }
          if (isTypeField || TYPE_PARENTS.has(ptype)) { emit(n, typeTokenFor(n)); return; }
          if (ptype === "attribute") { emit(n, ST.attribute); return; }
          if (ptype === "parameter") { emit(n, ST.parameter); return; }
          if (ptype === "variable_declarator") { emit(n, ST.variable, MOD_DECLARATION); return; }
        }
        // expression context
        const hit = scopeAt(n.startPosition.row).find((s) => s.name === n.text);
        if (hit) {
          const t = hit.kind === "parameter" ? ST.parameter
            : hit.kind === "field" ? ST.field
            : hit.kind === "property" ? ST.property
            : ST.variable;
          emit(n, t, hit.static ? MOD_STATIC : 0);
          return;
        }
        if (UnityApi.SELF_GLOBALS[n.text]) { emit(n, ST.property); return; }
        const rt = this.unity.findType(n.text);
        if (rt && rt.name === n.text) { emit(n, ST.unityType); return; }
        const pt = this.projectTypes.get(n.text.toLowerCase());
        if (pt?.length) { emit(n, typeTokenFor(n)); return; }
        if (/^[A-Z]/.test(n.text)) { emit(n, ST.type); return; }
        emit(n, ST.variable);
        return;
      }

      switch (n.type) {
        case "using_directive": {
          const nameN = n.childForFieldName("name");
          if (nameN) {
            const ids = nameN.type === "identifier" ? [nameN] : nameN.descendantsOfType("identifier");
            ids.forEach((id) => { skip.add(id.id); emit(id, ST.namespace); });
          }
          break;
        }
        case "namespace_declaration": {
          const nameN = n.childForFieldName("name");
          if (nameN) {
            const ids = nameN.type === "identifier" ? [nameN] : nameN.descendantsOfType("identifier");
            ids.forEach((id) => { skip.add(id.id); emit(id, ST.namespace); });
          }
          break;
        }
        case "class_declaration": case "struct_declaration": case "interface_declaration":
        case "enum_declaration": case "record_declaration": {
          const nameN = n.childForFieldName("name");
          if (nameN) {
            skip.add(nameN.id);
            const idx = n.type === "struct_declaration" ? ST.struct
              : n.type === "interface_declaration" ? ST.interface
              : n.type === "enum_declaration" ? ST.enum : ST.class;
            emit(nameN, idx, MOD_DECLARATION);
          }
          const bases = n.childForFieldName("bases");
          if (bases) {
            for (const id of bases.descendantsOfType("identifier")) {
              if (skip.has(id.id)) continue;
              skip.add(id.id);
              emit(id, typeTokenFor(id));
            }
          }
          break;
        }
        case "method_declaration": {
          const nameN = n.childForFieldName("name");
          if (nameN && !skip.has(nameN.id)) {
            skip.add(nameN.id);
            emit(nameN, UNITY_MESSAGE_NAMES.has(nameN.text) ? ST.unityMethod : ST.method, MOD_DECLARATION);
          }
          break;
        }
        case "field_declaration": {
          const decl = n.childForFieldName("declaration") ?? n.children.find((c) => c?.type === "variable_declaration");
          if (decl) {
            for (const vd of decl.descendantsOfType("variable_declarator")) {
              const nm = vd.childForFieldName("name") ?? firstIdentifier(vd);
              if (nm && nm.type === "identifier") { skip.add(nm.id); emit(nm, ST.field, MOD_DECLARATION); }
            }
          }
          break;
        }
        case "event_field_declaration": {
          for (const vd of n.descendantsOfType("variable_declarator")) {
            const nm = vd.childForFieldName("name") ?? firstIdentifier(vd);
            if (nm && nm.type === "identifier") { skip.add(nm.id); emit(nm, ST.event, MOD_DECLARATION); }
          }
          break;
        }
        case "variable_declarator": {
          const nm = n.childForFieldName("name") ?? firstIdentifier(n);
          if (nm && nm.type === "identifier" && !skip.has(nm.id)) { skip.add(nm.id); emit(nm, ST.variable, MOD_DECLARATION); }
          break;
        }
        case "invocation_expression": {
          const func = n.childForFieldName("function");
          if (func) {
            if (func.type === "identifier") {
              skip.add(func.id);
              emit(func, ST.method);
            } else if (func.type === "member_access_expression") {
              const nameN = func.childForFieldName("name");
              if (nameN && !skip.has(nameN.id)) {
                skip.add(nameN.id);
                const objText = func.text.slice(0, func.text.lastIndexOf("."));
                const r = objText ? resolveMember(objText, nameN.text, nameN.startPosition.row, nameN.startPosition.column) : null;
                emit(nameN, r?.type ?? ST.method, r?.mods ?? 0);
              }
            } else if (func.type === "generic_name") {
              const id = func.children.find((c) => c?.type === "identifier");
              if (id) { skip.add(id.id); emit(id, ST.method); }
            }
          }
          break;
        }
        case "member_access_expression": {
          const nameN = n.childForFieldName("name");
          if (nameN && !skip.has(nameN.id)) {
            skip.add(nameN.id);
            // this grammar version doesn't populate the "object" field — derive receiver from text
            const dot = n.text.lastIndexOf(".");
            const objText = dot > 0 ? n.text.slice(0, dot) : "";
            const r = objText ? resolveMember(objText, nameN.text, nameN.startPosition.row, nameN.startPosition.column) : null;
            if (r) emit(nameN, r.type, r.mods);
            else if (/^[A-Z]/.test(nameN.text)) emit(nameN, ST.property);
            else emit(nameN, ST.variable);
          }
          break;
        }
        case "attribute_list": {
          for (const attr of n.descendantsOfType("attribute")) {
            const nm = attr.childForFieldName("name");
            if (nm) { skip.add(nm.id); emit(nm, ST.attribute); }
          }
          break;
        }
        default:
          break;
      }

      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (c) walk(c);
      }
    };

    walk(root);
    return sink.encode();
  }
}

/* ------------------------------- helpers -------------------------------- */

/** namespaces injected by <ImplicitUsings>enable</ImplicitUsings> (Roslyn default set) */
const IMPLICIT_USING_SET = [
  "System", "System.Collections.Generic", "System.IO", "System.Linq",
  "System.Net.Http", "System.Threading", "System.Threading.Tasks",
];

/** idiomatic Unity/C# variable name abbreviations (lowercased type name -> candidates) */
const NAME_ABBREV: Record<string, string[]> = {
  rigidbody: ["rb", "body"],
  rigidbody2d: ["rb2d", "body2d"],
  gameobject: ["go", "obj"],
  transform: ["tr", "trs"],
  collider: ["col"],
  collider2d: ["col2d"],
  spriterenderer: ["sr", "rend"],
  textmeshpro: ["tmp"],
  textmeshprougui: ["tmpText", "tmp"],
  tmp_text: ["tmpText"],
  recttransform: ["rt", "rect"],
  canvasgroup: ["cg"],
  animator: ["anim"],
  animation: ["anim"],
  audiosource: ["audioSrc", "sfx"],
  audioclip: ["clip"],
  camera: ["cam"],
  renderer: ["rend"],
  charactercontroller: ["cc", "controller"],
  navmeshagent: ["agent", "nav"],
  button: ["btn"],
  image: ["img"],
  text: ["txt"],
  waitforseconds: ["delay", "wait"],
  stringbuilder: ["sb", "builder"],
  list: ["list", "items"],
  dictionary: ["dict", "map"],
  hashset: ["set"],
  queue: ["queue"],
  stack: ["stack"],
  particlesystem: ["ps", "particles"],
  material: ["mat"],
  texture: ["tex"],
  texture2d: ["tex"],
  vector3: ["v3", "vec"],
  vector2: ["v2", "vec"],
  color: ["col", "clr"],
  ray: ["ray"],
  raycasthit: ["hit"],
  coroutine: ["routine"],
  ienumerator: ["enumerator", "routine"],
  // builtins
  int: ["i", "count", "num"],
  float: ["f", "speed", "amount"],
  double: ["d", "value"],
  string: ["s", "str", "text"],
  bool: ["b", "flag", "isActive"],
  long: ["l"],
  char: ["c"],
};

/** PascalCase / SCREAMING parts -> lowerCamel (TMP_Text → tmpText, PlayerHealth → playerHealth) */
function camel(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "");
  if (!cleaned) return "";
  // split on caps & underscores: "TMP_Text" -> [tmp, text]
  const parts = cleaned.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").split(/\s+/).filter(Boolean);
  if (!parts.length) return cleaned.toLowerCase();
  const lowerFirst = (s: string) => (s.length > 1 && s === s.toUpperCase() ? s.toLowerCase() : s.charAt(0).toLowerCase() + s.slice(1));
  return parts.map((w, i) => (i === 0 ? lowerFirst(w) : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join("");
}

interface Segment { name: string; isCall: boolean }

/** API fullName match tolerant to backtick-generic suffixes (List vs List`1) and bare simple names */
function apiTypeMatches(rt: { fullName: string; name?: string }, typeFullName: string): boolean {
  if (rt.fullName === typeFullName) return true;
  const a = stripTicks(rt.fullName).toLowerCase();
  const b = stripTicks(typeFullName).toLowerCase();
  if (a === b) return true;
  // bare simple-name usage (canonicalizeType fell through to the simple name)
  if (b === rt.name?.toLowerCase()) return true;
  return false;
}

function stripTicks(s: string): string {
  return s.replace(/`\d+/g, "");
}

/** initializer of a variable_declarator — this grammar version does not expose the
 *  "initializer" field; the "=" lives inside an equals_value_clause child node */
function initializerOf(vd: SyntaxNode): SyntaxNode | null {
  const f = vd.childForFieldName("initializer");
  if (f) return f;
  for (let i = 0; i < vd.childCount; i++) {
    const c = vd.child(i);
    if (!c) continue;
    if (c.type === "equals_value_clause") {
      for (let j = 0; j < c.childCount; j++) {
        const cc = c.child(j);
        if (cc && cc.text !== "=") return cc; // the expression itself
      }
      return c;
    }
    if (c.text === "=") {
      const next = vd.child(i + 1);
      if (next) return next;
    }
  }
  return null;
}

function splitSegments(expr: string): Segment[] {
  // handle name<T>(...) and name(...) and name
  const segs: Segment[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if ("(<[=".includes(ch)) depth++;
    if (")>])".includes(ch)) depth--;
    if (ch === "." && depth === 0) { segs.push(finalize(cur)); cur = ""; }
    else cur += ch;
  }
  segs.push(finalize(cur));
  return segs.filter((s) => s.name);

  function finalize(s: string): Segment {
    const isCall = /\(.*\)\s*$/.test(s.trim());
    const name = s.trim().replace(/\(.*$/, "").replace(/<.*$/, "").trim();
    return { name, isCall };
  }
}

function visibleUsings(st: FileState): string[] {
  const usings = [...st.symbols.usings];
  if (!usings.includes("UnityEngine")) usings.push("UnityEngine");
  if (!usings.includes("System")) usings.push("System");
  return usings;
}

function textToOffset(text: string, line: number, col: number): number {
  // v0.7.0 — CRLF-aware: each line consumes its REAL newline width (\r\n = 2,
  // \n = 1). The old split("\n")+1 math dropped one char per prior line in
  // CRLF files, silently shifting every completion/hover/go-to-def target.
  let off = 0;
  const lines = text.split("\n");
  const n = Math.min(line, lines.length);
  for (let i = 0; i < n; i++) {
    off += lines[i].length;
    if (text.charCodeAt(off) === 13) off += 2; // \r\n
    else off += 1;                             // \n
  }
  return off + col;
}

function nearestIdentifier(node: SyntaxNode | null): SyntaxNode | null {
  let n: SyntaxNode | null = node;
  while (n) {
    if (n.type === "identifier") return n;
    // prefer last identifier child (for generic_name etc.)
    for (let i = n.childCount - 1; i >= 0; i--) {
      const c = n.child(i);
      if (c?.type === "identifier" && c.text) return c;
    }
    n = n.parent;
  }
  return null;
}

function chainBefore(content: string, offset: number): { recv: string; name: string } | null {
  const before = content.slice(Math.max(0, offset - 200), offset);
  const m = before.match(/([A-Za-z_][A-Za-z0-9_.]*)\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!m) return null;
  return { recv: m[1], name: m[2] };
}

function inferFromInitializer(engine: VelvetSharpEngine, st: FileState, init: string): string {
  let s = init.trim();
  // new Type(...)
  const nw = s.match(/^new\s+([A-Za-z_][A-Za-z0-9_.<>]*)/);
  if (nw) return nw[1];
  // GetComponent<T>()
  const gc = s.match(/GetComponent<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>/);
  if (gc) return gc[1];
  // AddComponent<T>()
  const ac = s.match(/AddComponent<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>/);
  if (ac) return ac[1];
  if (s.startsWith('"') || s.startsWith('$"') || s.startsWith('@\"')) return "string";
  if (/^\d+\.\d*f?$/.test(s) || /^-?\d+f$/.test(s)) return "float";
  if (/^-?\d+$/.test(s)) return "int";
  if (s === "true" || s === "false") return "bool";
  // chained: gameObject.transform
  const noSemi = s.replace(/;$/, "");
  return noSemi; // caller may re-resolve
}

function prettyLocalType(t: string): string {
  if (!t) return "";
  return t
    .replace("System.Collections.Generic.", "")
    .replace(/^System\./, "");
}

function prettyLabel(container: string, m: any): string {
  const ps = (m.ps ?? []).map((p: any) => `${prettyLocalType(p.t)} ${p.n}`).join(", ");
  const gp = m.g ? `<${m.g.join(", ")}>` : "";
  return `${m.ret === "void" ? "void" : prettyLocalType(m.ret)} ${container.split(".").pop()}.${m.n}${gp}(${ps})`;
}
