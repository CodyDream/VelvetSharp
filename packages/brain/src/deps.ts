/** VelvetSharp brain — project dependency graph (v0.6.0, "phase 6").
 *
 * Builds the Rider-style class/script dependency graph the UI renders in four
 * layouts (hierarchical / organic / circular / business):
 *
 *   nodes   — every type declared inside the scope folder (+ out-of-scope project
 *             types and optional Unity/BCL types that in-scope code touches)
 *   edges   — extends (base class), implements (interface), uses (field/property/
 *             parameter/return types, `new T()`, casts, generic args, static refs)
 *
 * Reference extraction comes free from the symbol index: FileSymbols.typeRefs
 * (identifiers in type-ish / bare contexts, persisted in the startup cache) plus
 * the declaration metadata (base lists, member return & parameter types). */

import type {
  DepEdge, DepGraph, DepKind, DepNode, FileSymbols, IdentRef, SymbolInfo,
} from "./types";
import type { ResolvedType } from "./unity";

/** minimal structural view of the engine — no runtime circular import */
export interface DepEngineView {
  projectTypes: Map<string, SymbolInfo[]>;
  projectMembers: Map<string, SymbolInfo[]>;
  assemblyOf(path: string): string | null;
  unity: {
    findType(name: string): ResolvedType | null;
    findTypeExact?(name: string): ResolvedType | null;
  };
}

export const DEP_NODE_CAP = 260;   // Phase 8: types-only graphs — 260 type cards is already a wall
const DEP_EDGE_CAP = 900;          // Phase 8: 1500 raw paths could choke the webview
const EXTERNAL_CAP = 16;
const OUT_OF_SCOPE_CAP = 48;

/** Phase 8 (user: "nodes should be either class, interfaces or structs — not
 *  literally everything"): only real type declarations become nodes. Delegates
 *  (function-pointer types) are excluded — they are noise in a class graph. */
const GRAPH_NODE_KINDS = new Set(["class", "struct", "interface", "enum"]);

const PRIMITIVES = new Set([
  "int", "float", "double", "decimal", "bool", "string", "char", "object",
  "byte", "sbyte", "short", "ushort", "uint", "ulong", "long", "void", "var",
]);

export function normDepPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** simple name out of a source-level type text: "System.Collections.Generic.List<int>" → List */
function simpleNameOf(typeText: string): string {
  const t = typeText.replace(/\s+/g, "").replace(/<.*$/, "").replace(/\[\]$/, "").replace(/\?$/, "");
  const parts = t.split(".");
  return parts[parts.length - 1] ?? t;
}

/** base-list text "MonoBehaviour, IDisposable" → [base, ...interfaces] */
function baseListParts(base: string | undefined): string[] {
  if (!base) return [];
  return base
    .replace(/^\s*:\s*/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface RawEdge { from: string; to: string; kind: DepKind; weight: number }

export function buildDependencyGraph(
  view: DepEngineView,
  allFiles: FileSymbols[],
  scope: string,
  includeExternal: boolean,
): DepGraph {
  const inScope: FileSymbols[] = [];
  const outScope: FileSymbols[] = [];
  const prefix = scope ? normDepPath(scope).replace(/\/+$/, "") + "/" : "";
  for (const f of allFiles) {
    const p = normDepPath(f.path);
    if (!prefix || p.startsWith(prefix)) inScope.push(f);
    else outScope.push(f);
  }
  // Phase 8 crash fix: `isOutOfScope` used to do a LINEAR scan over every
  // in-scope file per resolved reference — on a few-hundred-script project that
  // was billions of comparisons inside the worker (the "graph crashes" report:
  // the request never returned / the worker died). One Set, O(1) lookups.
  const inScopePathSet = new Set(inScope.map((f) => normDepPath(f.path)));

  /* ---------- project type resolution ---------- */
  // simple lower name → declared types (whole project — needed to resolve refs)
  const bySimple = new Map<string, SymbolInfo[]>();
  for (const arr of view.projectTypes.values()) {
    for (const t of arr) {
      const k = t.name.toLowerCase();
      const list = bySimple.get(k);
      if (list) list.push(t);
      else bySimple.set(k, [t]);
    }
  }
  const fqnOf = (t: SymbolInfo): string => t.fqn || (t.ns ? t.ns + "." + t.name : t.name);
  const nodeProjectId = (t: SymbolInfo): string => "p::" + fqnOf(t).toLowerCase();

  const nodesById = new Map<string, DepNode>();
  const rawEdges: RawEdge[] = [];
  const edgeIndex = new Map<string, RawEdge>();

  const addEdge = (fromId: string, toId: string, kind: DepKind, weight = 1) => {
    if (!fromId || !toId) return;
    if (fromId === toId && kind !== "self") return; // self-loops only for the explicit singleton edge (Phase 9)
    const key = `${fromId}|${toId}|${kind}`;
    const existing = edgeIndex.get(key);
    if (existing) existing.weight = Math.min(99, existing.weight + weight);
    else {
      const e: RawEdge = { from: fromId, to: toId, kind, weight };
      edgeIndex.set(key, e);
      rawEdges.push(e);
    }
  };

  const isOutOfScope = (t: SymbolInfo): boolean => !inScopePathSet.has(normDepPath(t.file));

  const ensureProjectNode = (t: SymbolInfo, outOfScope: boolean): string => {
    if (!GRAPH_NODE_KINDS.has(t.kind)) return ""; // Phase 8: classes/structs/interfaces/enums only
    const id = nodeProjectId(t);
    let n = nodesById.get(id);
    if (!n) {
      n = {
        id,
        name: t.name,
        kind: t.kind,
        file: t.file,
        line: t.line,
        ns: t.ns ?? "",
        asm: view.assemblyOf(t.file),
        isMono: /MonoBehaviour|ScriptableObject|NetworkBehaviour|UIBehaviour/.test(t.base ?? ""),
        external: false,
        outOfScope,
        refCount: 0,
        outDeg: 0,
        inDeg: 0,
      };
      nodesById.set(id, n);
    }
    return id;
  };

  const externalById = new Map<string, DepNode>();
  const ensureExternalNode = (rt: ResolvedType): string => {
    const id = "ext::" + rt.fullName.toLowerCase();
    let n = externalById.get(id);
    if (!n) {
      n = {
        id, name: rt.name, kind: "external", file: "", line: 0,
        ns: rt.ns ?? "", asm: (rt as any).asm ?? null,
        isMono: /MonoBehaviour|ScriptableObject|Behaviour/.test(rt.fullName),
        external: true, refCount: 0, outDeg: 0, inDeg: 0,
      };
      externalById.set(id, n);
    }
    n.refCount++;
    return id;
  };

  /** resolve a simple type name as declared in / visible from `file`.
   *  Phase 8: exact-case match wins (C# identifiers are case-sensitive) — the
   *  old all-lowercase lookup let a VARIABLE named `enemy` resolve to the TYPE
   *  `Enemy` and spammed "uses" edges ("don't literally dump every connection"). */
  const resolveProjectType = (simple: string, file: FileSymbols | null): SymbolInfo | null => {
    const cands = bySimple.get(simple.toLowerCase());
    if (!cands?.length) return null;
    if (cands.length === 1) return cands[0];
    const exact = cands.filter((c) => c.name === simple);
    const pool = exact.length ? exact : cands;
    // prefer: declared in this file → same namespace → ns imported via using
    const usings = file ? new Set(file.usings.map((u) => u.trim())) : new Set();
    const fileNss = file ? file.namespaces : [];
    let best: SymbolInfo | null = null;
    let bestScore = -1;
    for (const c of pool) {
      let score = 0;
      if (file && c.file === file.path) score = 4;
      else if (file && c.ns && fileNss.some((n) => n === c.ns || n.startsWith(c.ns + "."))) score = 3;
      else if (c.ns && usings.has(c.ns)) score = 2;
      else if (!c.ns) score = 1;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  };

  /** does `name` resolve to a Unity/BCL type? (project types win) */
  const resolveExternal = (simple: string): ResolvedType | null => {
    if (!simple || PRIMITIVES.has(simple.toLowerCase())) return null;
    if (bySimple.has(simple.toLowerCase())) return null;
    return view.unity.findType(simple);
  };

  /** Phase 8: type-ish positions + bare identifiers. Bare was briefly dropped,
   *  but static calls like `GameManager.Instance` ARE real dependencies (the
   *  v0.6.0 fixtures proved it). The spam guard instead: a bare identifier only
   *  creates an edge when it matches a declared project type EXACTLY (C# is
   *  case-sensitive) — a VARIABLE named `enemy` must never hit the TYPE `Enemy. */
  const isTypePositionCtx = (ctx: IdentRef["ctx"]) => ctx === "typePos" || ctx === "attr" || ctx === "ctor" || ctx === "bare";
  const exactProjectType = (name: string): SymbolInfo | null =>
    (bySimple.get(name.toLowerCase()) ?? []).find((t) => t.name === name) ?? null;

  /* ---------- in-scope declared types → nodes (types only) ---------- */
  for (const f of inScope) {
    for (const t of f.types) ensureProjectNode(t, false);
  }

  /* ---------- inheritance edges (declaration metadata) ---------- */
  for (const f of inScope) {
    for (const t of f.types) {
      const fromId = ensureProjectNode(t, false);
      const parts = baseListParts(t.base);
      for (let i = 0; i < parts.length; i++) {
        const simple = simpleNameOf(parts[i]);
        if (!simple || PRIMITIVES.has(simple.toLowerCase())) continue;
        const target = resolveProjectType(simple, f);
        if (target) {
          const toId = ensureProjectNode(target, isOutOfScope(target));
          addEdge(fromId, toId, i === 0 && target.kind !== "interface" ? "extends" : "implements");
          continue;
        }
        if (includeExternal) {
          const rt = resolveExternal(simple);
          if (rt) {
            const toId = ensureExternalNode(rt);
            addEdge(fromId, toId, i === 0 && !/^I[A-Z]/.test(simple) ? "extends" : "implements");
          }
        }
      }
    }
  }

  /* ---------- member signature types (fields / params / returns) ---------- */
  for (const f of inScope) {
    for (const m of f.members) {
      if (m.kind === "enumMember") continue;
      const ownerSimple = m.container.split(".").pop() ?? "";
      const ownerType = resolveProjectType(ownerSimple, f);
      if (!ownerType || ownerType.file !== f.path) continue; // only inside scope files
      const fromId = ensureProjectNode(ownerType, false);
      // Phase 9 singleton detection (user: "show static instances too, specially
      // ones that link something to itself"): `static <OwnType> Instance` field
      // or property — the classic Unity/global singleton access point. Mark the
      // node and add an explicit self-loop edge (self references were previously
      // dropped by the spam guard).
      if (m.static && (m.kind === "field" || m.kind === "property") && m.returnType) {
        const retSimple = simpleNameOf(m.returnType);
        if (retSimple === ownerType.name) {
          const n = nodesById.get(fromId);
          if (n) n.singleton = true;
          addEdge(fromId, fromId, "self", 1);
        }
      }
      const siteTypes: string[] = [];
      if (m.returnType) siteTypes.push(m.returnType);
      for (const p of m.params ?? []) if (p.type) siteTypes.push(p.type);
      for (const site of siteTypes) {
        const simple = simpleNameOf(site);
        if (!simple || PRIMITIVES.has(simple.toLowerCase())) continue;
        const target = resolveProjectType(simple, f);
        if (target) addEdge(fromId, ensureProjectNode(target, isOutOfScope(target)), "uses");
        else if (includeExternal) {
          const rt = resolveExternal(simple);
          if (rt) addEdge(fromId, ensureExternalNode(rt), "uses");
        }
      }
    }
  }

  /* ---------- identifier references (typeRefs — covers new/casts/statics) ---------- */
  for (const f of inScope) {
    const fileTypes = f.types;
    if (!fileTypes.length) continue;
    // group refs by the declaring type they occur in: nearest enclosing type by line range
    const sortedTypes = [...fileTypes].sort((a, b) => a.line - b.line);
    const ownerTypeOfRef = (line: number): SymbolInfo | null => {
      let owner: SymbolInfo | null = null;
      for (const t of sortedTypes) {
        if (t.line <= line) owner = t;
        else break;
      }
      return owner;
    };
    for (const ref of f.typeRefs) {
      if (!ref.name) continue;
      if (!isTypePositionCtx(ref.ctx)) continue;
      const owner = ownerTypeOfRef(ref.line);
      if (!owner) continue;
      const fromId = ensureProjectNode(owner, false);

      if (ref.ctx === "ctor" || ref.ctx === "decl") continue; // decl names add no dependency

      let names: string[] = [ref.name];
      if (ref.ctx === "attr") names = [ref.name, ref.name + "Attribute"];

      for (const nm of names) {
        if (PRIMITIVES.has(nm.toLowerCase())) continue;
        if (ref.ctx === "bare" && !exactProjectType(nm)) continue; // Phase 8 spam guard (see above)
        const target = resolveProjectType(nm, f);
        if (target) {
          if (target.file === owner.file && target.line === owner.line) continue; // self
          addEdge(fromId, ensureProjectNode(target, isOutOfScope(target)), "uses");
        } else if (includeExternal) {
          const rt = resolveExternal(nm);
          if (rt) addEdge(fromId, ensureExternalNode(rt), "uses");
        }
      }
    }
  }

  /* ---------- assemble: real degrees first, then cap nodes, then cap edges ---------- */
  // v0.6.1 crash fix: giant scopes produced 10k+ SVG paths and killed the
  // webview. Order matters now: (1) count REAL degrees over every raw edge,
  // (2) keep the top in-scope hubs by degree, (3) drop edges that lost an
  // endpoint, (4) cap the remaining edges (inheritance first, then weight),
  // (5) prune externals / out-of-scope nodes that no longer carry an edge.
  const totalInScopeTypes = inScope.reduce((a, f) => a + f.types.length, 0);
  let truncated = false;

  const deg = new Map<string, number>();
  for (const e of rawEdges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }

  const external = [...externalById.values()].sort((a, b) => b.refCount - a.refCount);
  const keptExternal = includeExternal ? external.slice(0, EXTERNAL_CAP) : [];
  const keptExtIds = new Set(keptExternal.map((n) => n.id));

  const projectNodes = [...nodesById.values()];
  const inScopeNodes = projectNodes.filter((n) => !n.outOfScope);
  const outNodes = projectNodes.filter((n) => n.outOfScope);
  const outNodeIds = new Set(outNodes.map((n) => n.id));
  let finalEdges: RawEdge[] = [];

  // in-scope node cap — REAL largest degree first (was: all-zero degrees →
  // arbitrary order, hubs dropped while leaves stayed)
  let keptInScope = inScopeNodes;
  if (inScopeNodes.length > DEP_NODE_CAP) {
    truncated = true;
    keptInScope = [...inScopeNodes]
      .sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0) || a.id.localeCompare(b.id))
      .slice(0, DEP_NODE_CAP);
  }
  // candidate edges: from/to may be kept in-scope nodes, out-of-scope project
  // nodes or externals — out-of-scope/external endpoints are pruned AFTER the
  // edge selection (they only stay when a surviving edge touches them)
  const inScopeIds = new Set(keptInScope.map((n) => n.id));
  const candidateEdges = rawEdges.filter((e) =>
    (inScopeIds.has(e.from) || e.from.startsWith("ext::") || outNodeIds.has(e.from))
    && (inScopeIds.has(e.to) || e.to.startsWith("ext::") || outNodeIds.has(e.to)));

  // edge cap — inheritance edges are the semantic skeleton, keep them all;
  // `uses` edges go by weight (reference-site count)
  if (candidateEdges.length > DEP_EDGE_CAP) {
    truncated = true;
    const rank = (e: RawEdge): number =>
      (e.kind === "uses" ? 1000 : 0) - Math.min(999, e.weight);
    finalEdges = candidateEdges
      .sort((a, b) => rank(a) - rank(b) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
      .slice(0, DEP_EDGE_CAP);
  } else {
    finalEdges = candidateEdges;
  }
  const edgeIds = new Set<string>();
  for (const e of finalEdges) { edgeIds.add(e.from); edgeIds.add(e.to); }

  // out-of-scope project nodes / externals stay only when a kept edge touches them
  const keptOut = outNodes.filter((n) => edgeIds.has(n.id));
  if (outNodes.length > OUT_OF_SCOPE_CAP) truncated = true;
  const finalNodes: DepNode[] = [
    ...keptInScope,
    ...keptOut.slice(0, OUT_OF_SCOPE_CAP),
    ...keptExternal.filter((n) => edgeIds.has(n.id)),
  ];

  const ids = new Set(finalNodes.map((n) => n.id));
  const edges: DepEdge[] = [];
  const nodeById = new Map(finalNodes.map((n) => [n.id, n] as const));
  for (const e of finalEdges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    edges.push({ from: e.from, to: e.to, kind: e.kind, weight: e.weight });
    const from = nodeById.get(e.from)!;
    const to = nodeById.get(e.to)!;
    from.outDeg++;
    to.inDeg++;
    from.refCount += e.weight;
    to.refCount += e.weight;
  }

  return { scope, nodes: finalNodes, edges, truncated, totalTypes: totalInScopeTypes };
}
