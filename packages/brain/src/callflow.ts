/**
 * Phase 9 — per-script CALL FLOW graph (user: "show a generated flow chart like
 * dependency graph how is the each selected script method traveling works, just
 * scope is inside the script show how methods call each other and when method
 * call something outside the script just use different shape and put end to
 * that branch").
 *
 * Phase 13 (user: "remove that unity dll stuff calls because those are
 * distractions, instead it should only include the custom methods it call out
 * that is not come pre packaged by anothers" + "put side little number like 1
 * or 2 or 3 … so user knows these execute in this order in that sub tree"):
 *
 *   • The graph now contains ONLY custom methods. Engine/API calls
 *     (Debug.Log, GetComponent, Mathf…) are no longer drawn at all — they are
 *     counted in `hiddenCalls` / `extCount` for the toolbar chip instead.
 *   • Calls into the user's OTHER scripts still appear (they are custom, not
 *     pre-packaged): a qualified `GameManager.Spawn()` whose type lives in
 *     another file, or a typed-field receiver `player.Heal()` where the field's
 *     declared type is a workspace type. They become CROSS-FILE terminal nodes
 *     (`kind:"method"`, `cross:true`, `file` = defining script) — traversal
 *     ends there by construction, and the UI can still open the definition.
 *   • Every edge carries `order` — the 1-based rank of its first call site in
 *     the caller's body (top-to-bottom source order, localized per method).
 *     The UI draws 1·2·3 badges so each method's sub-tree reads in the order
 *     the calls execute.
 */
import { UNITY_MESSAGE_NAMES } from "./snippets";

export interface FlowNode {
  id: string;            // "m::<Container>::<name>" or "x::<Container>::<name>"
  label: string;         // method name
  kind: "method" | "external"; // external kept for UI compatibility — never emitted anymore
  container: string;     // declaring type simple name
  line: number;          // 0-based decl line (in-file) or def line (cross)
  ret: string;           // return type text (in-file methods only)
  entry: boolean;        // nothing inside the file calls it (Unity messages usually are)
  unityMsg: boolean;     // name is a Unity lifecycle message
  cross?: boolean;       // Phase 13 — declared in ANOTHER script (terminal node)
  file?: string;         // Phase 13 — defining script (cross nodes)
}

export interface FlowEdge {
  from: string;
  to: string;
  count: number;         // call sites (caller → callee)
  external: boolean;     // kept for UI compatibility — always false now
  order: number;         // Phase 13 — 1-based call-site rank within the caller body
  fr: number;            // first call site row (internal — ranking input)
  fc: number;            // first call site col (internal — ranking input)
}

export interface CallFlowResult {
  ok: boolean;
  reason?: string;
  errorStack?: string;   // Phase 13 — full stack when ok:false is an internal error (copyable in UI)
  file: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  truncated: boolean;
  methodCount: number;   // in-file methods seen (before caps)
  extCount: number;      // distinct engine/API targets NOT drawn (Phase 13 semantics)
  hiddenCalls: number;   // Phase 13 — engine/API call SITES not drawn
  crossCount: number;    // Phase 13 — cross-file custom methods drawn
}

const MAX_NODES = 160;
const MAX_EDGES = 400;
const MAX_XNODES = 96;   // cross-file terminals — plenty for one script's reach
/** Phase 10 — walk-time safety valve: the collector may gather up to this many
 *  raw edges BEFORE selection; the final result is still capped to MAX_EDGES
 *  after the connectivity ranking. A fixed low cap here used to truncate the
 *  walk itself, so big scripts lost their helper nodes but kept their callers
 *  — the rendered graph was a wall of isolated methods. */
const MAX_RAW_EDGES = 4000;

interface MDecl {
  name: string;
  container: string;     // simple name of the enclosing type
  line: number;
  ret: string;
  nodeId: number;        // tree-sitter node id (unique per parse)
}

/** Phase 13 — a resolved call into the user's OTHER scripts */
interface CrossHit {
  file: string;
  line: number;
  container: string;     // simple name of the declaring type
  name: string;
}

const simpleName = (fqn: string) => fqn.split(".").pop() ?? fqn;

export function buildCallFlow(engine: any, path: string): CallFlowResult {
  const empty = (reason: string, errorStack?: string): CallFlowResult =>
    ({ ok: false, reason, errorStack, file: path, nodes: [], edges: [], truncated: false, methodCount: 0, extCount: 0, hiddenCalls: 0, crossCount: 0 });

  const st = engine.files?.get?.(path);
  if (!st) return empty("file is not part of the workspace");
  if (!st.tree) return empty("file is not parsed yet — open it in the editor first");
  const root = st.tree.rootNode;

  /* ---------- in-file method declarations ---------- */
  const decls = root.descendantsOfType("method_declaration");
  const methods: MDecl[] = [];
  const byNodeId = new Map<number, MDecl>();
  const byName = new Map<string, MDecl[]>();
  const byKey = new Map<string, MDecl>();   // "<Container>::<name>" (first overload wins)
  const inFileTypeNames = new Set<string>();

  for (const d of st.tree.rootNode.descendantsOfType(["class_declaration", "struct_declaration", "interface_declaration", "record_declaration"])) {
    const n = d.childForFieldName("name")?.text;
    if (n) inFileTypeNames.add(n);
  }

  for (const d of decls) {
    const nameN = d.childForFieldName("name");
    if (!nameN) continue;
    let container = "";
    let p: any = d.parent;
    while (p) {
      if (/^(class|struct|interface|record)_declaration$/.test(p.type)) {
        container = p.childForFieldName("name")?.text ?? "";
        break;
      }
      p = p.parent;
    }
    const ret = d.childForFieldName("returns")?.text ?? "";
    const m: MDecl = { name: nameN.text, container, line: d.startPosition.row, ret, nodeId: d.id };
    methods.push(m);
    byNodeId.set(d.id, m);
    const list = byName.get(m.name);
    if (list) list.push(m); else byName.set(m.name, [m]);
    const key = `${container}::${m.name}`;
    if (!byKey.has(key)) byKey.set(key, m);
  }

  if (!methods.length) {
    return { ok: true, file: path, nodes: [], edges: [], truncated: false, methodCount: 0, extCount: 0, hiddenCalls: 0, crossCount: 0 };
  }

  const nodeIdOf = (m: MDecl) => `m::${m.container}::${m.name}`;

  /* ---------- Phase 13 — workspace custom-method index ----------
   *  Built from every OTHER indexed script: type simple-name → declarations,
   *  and type FQN → method name → definition. Only user code is in here, so
   *  resolving against it can never drag Unity/BCL noise back in. */
  const wsTypeDecls = new Map<string, { fqn: string; file: string }[]>();
  const wsMethodsByFqn = new Map<string, Map<string, CrossHit>>();
  for (const [p, fst] of engine.files ?? []) {
    if (p === path) continue;                     // this file's methods are in-file
    const syms = fst?.symbols;
    if (!syms) continue;
    for (const t of syms.types ?? []) {
      if (!t?.name || !t?.fqn) continue;
      const list = wsTypeDecls.get(t.name);
      if (list) { if (!list.some((x) => x.fqn === t.fqn)) list.push({ fqn: t.fqn, file: p }); }
      else wsTypeDecls.set(t.name, [{ fqn: t.fqn, file: p }]);
    }
    for (const m of syms.members ?? []) {
      if (m?.kind !== "method" || !m.name || !m.container) continue;
      let bag = wsMethodsByFqn.get(m.container);
      if (!bag) { bag = new Map(); wsMethodsByFqn.set(m.container, bag); }
      if (!bag.has(m.name)) bag.set(m.name, { file: p, line: m.line ?? 0, container: simpleName(m.container), name: m.name });
    }
  }

  const crossLookup = (typeSimple: string, methodName: string): CrossHit | null => {
    if (!typeSimple || !methodName) return null;
    const decls = wsTypeDecls.get(typeSimple);
    if (!decls) return null;
    for (const d of decls) {
      const hit = wsMethodsByFqn.get(d.fqn)?.get(methodName);
      if (hit) return hit;
    }
    return null;
  };

  /* Phase 13 — declared types of this file's fields/properties, so a call like
   * `player.Heal()` resolves through the field's declared type. Locals and
   * parameters are out of reach for now (the symbol index tracks members). */
  const fieldTypeOf = new Map<string, string>();
  for (const m of st.symbols?.members ?? []) {
    if ((m.kind === "field" || m.kind === "property") && m.name && m.returnType) {
      if (!fieldTypeOf.has(m.name)) fieldTypeOf.set(m.name, m.returnType);
    }
  }

  /** resolve an invocation callee — MDecl = in-file, CrossHit = user's other
   *  scripts, null = engine/API call (hidden, counted) */
  const resolveCallee = (fn: any, caller: MDecl): MDecl | CrossHit | null => {
    if (!fn) return null;
    let name = "";
    let base = "";
    if (fn.type === "identifier") {
      name = fn.text;
    } else if (fn.type === "member_access_expression") {
      const nameN = fn.childForFieldName("name");
      if (!nameN) return null;
      // the name may be a generic_name (`Array.Empty<int>`) — take the plain identifier
      name = nameN.type === "generic_name" ? (nameN.childForFieldName("name")?.text ?? "") : nameN.text;
      // NB: the receiver field is `expression` in tree-sitter-c-sharp (NOT `object`)
      base = fn.childForFieldName("expression")?.text ?? "";
    } else if (fn.type === "generic_name") {
      name = fn.childForFieldName("name")?.text ?? "";
    } else {
      return null; // conditional access, invocations of invocations, etc. — hidden
    }
    if (!name) return null;

    if (base) {
      const baseSimple = base.split(".").pop() ?? "";
      if (base === "this") {
        const hit = byKey.get(`${caller.container}::${name}`);
        if (hit) return hit;
      } else {
        // 1) explicit qualifier that names an in-file TYPE (static call: GameManager.Spawn())
        if (inFileTypeNames.has(baseSimple)) {
          const hit = byKey.get(`${baseSimple}::${name}`);
          if (hit) return hit;
        } else {
          // 2) Phase 13 — receiver whose DECLARED type is known from the file's
          //    fields/properties (`player.Heal()` with `Player player;`). This is
          //    precise, so it wins even when the variable NAME looks like an API
          //    type (a field called `camera` must not be eaten by the probe below).
          const t = fieldTypeOf.get(baseSimple);
          if (t) {
            const tSimple = t.split("<")[0].split(".").pop() ?? "";
            if (inFileTypeNames.has(tSimple)) {
              const hit = byKey.get(`${tSimple}::${name}`);
              if (hit) return hit;
            } else {
              const x = crossLookup(tSimple, name);
              if (x) return x;
            }
          }
          // 3) Phase 9 guard (restored) — the qualifier (case-insensitively)
          //    looks like a known API type (Debug, Physics…): the call is an
          //    engine call and must NEVER be stolen in-file, even when the file
          //    declares a method with the same name (Debug.Log vs void Log()).
          const probe = baseSimple.charAt(0).toUpperCase() + baseSimple.slice(1);
          if (engine.unity?.findType?.(baseSimple) || engine.unity?.findType?.(probe)) return null;

          // 4) same-class method (existing heuristic — bare or qualified)
          const same = byKey.get(`${caller.container}::${name}`);
          if (same) return same;

          // 5) any method in this file with that name (field-of-type-in-file)
          const list = byName.get(name);
          if (list?.length) return list[0];

          // 6) Phase 13 — qualifier names a WORKSPACE type from another script
          //    (`GameManager.Spawn()` where GameManager lives elsewhere)
          const x2 = crossLookup(baseSimple, name);
          if (x2) return x2;

          return null;
        }
      }
    }

    // bare call — same class first, then anywhere in this file
    const same = byKey.get(`${caller.container}::${name}`);
    if (same) return same;
    const list = byName.get(name);
    if (list?.length) return list[0];
    return null;
  };

  /* ---------- walk invocations ---------- */
  const edgeMap = new Map<string, FlowEdge>();
  const xById = new Map<string, FlowNode>();
  const hiddenLabels = new Set<string>();
  let hiddenSites = 0;
  let truncated = false;

  const addEdge = (from: string, to: string, at: { row: number; col: number }) => {
    const key = `${from}|${to}`;
    const e = edgeMap.get(key);
    if (e) {
      e.count = Math.min(99, e.count + 1);
      if (at.row < e.fr || (at.row === e.fr && at.col < e.fc)) { e.fr = at.row; e.fc = at.col; }
      return;
    }
    if (edgeMap.size >= MAX_RAW_EDGES) { truncated = true; return; } // ranking happens later — collect generously
    edgeMap.set(key, { from, to, count: 1, external: false, order: 0, fr: at.row, fc: at.col });
  };

  for (const inv of root.descendantsOfType("invocation_expression")) {
    // enclosing method (skip field initializers / ctors — no caller node to hang the edge on)
    // Phase 13: attribute arguments (`[ContextMenu(Count())]`) execute at class-
    // load time, NOT inside the method below them — never attribute those.
    let caller: MDecl | null = null;
    let inAttribute = false;
    let p: any = inv.parent;
    while (p) {
      if (p.type === "attribute" || p.type === "attribute_list") { inAttribute = true; break; }
      if (p.type === "method_declaration") { caller = byNodeId.get(p.id) ?? null; break; }
      p = p.parent;
    }
    if (inAttribute) continue;
    if (!caller) continue;
    const fn = inv.childForFieldName("function");
    const hit = resolveCallee(fn, caller);
    const at = { row: inv.startPosition.row, col: inv.startPosition.column };
    if (hit && "nodeId" in (hit as any)) {
      addEdge(nodeIdOf(caller), nodeIdOf(hit as MDecl), at);
    } else if (hit) {
      const x = hit as CrossHit;
      const id = `x::${x.container}::${x.name}`;
      if (!xById.has(id)) {
        if (xById.size >= MAX_XNODES) { truncated = true; hiddenSites++; hiddenLabels.add((fn?.text ?? "call()").replace(/\s+/g, "")); continue; }
        xById.set(id, {
          id, label: x.name, kind: "method", container: x.container,
          line: x.line, ret: "", entry: false, unityMsg: false, cross: true, file: x.file,
        });
      }
      addEdge(nodeIdOf(caller), id, at);
    } else {
      // engine/API call — counted for the chip, never drawn (Phase 13)
      hiddenSites++;
      const raw = (fn?.text ?? "call()").replace(/\s+/g, "");
      hiddenLabels.add(raw.length > 44 ? raw.slice(0, 43) + "…" : raw);
    }
  }

  /* ---------- assemble: rank by connectivity, THEN cap (Phase 10) ---------- */
  const deg = new Map<string, number>();
  for (const e of edgeMap.values()) {
    const w = Math.max(1, Math.min(9, e.count));
    deg.set(e.from, (deg.get(e.from) ?? 0) + w);
    deg.set(e.to, (deg.get(e.to) ?? 0) + w);
  }

  const rawTotal = methods.length + xById.size;
  let selMethods = methods;
  let selX: FlowNode[] = [...xById.values()];
  if (rawTotal > MAX_NODES) {
    truncated = true;
    const rankedM = [...methods].sort((a, b) =>
      (deg.get(nodeIdOf(b)) ?? 0) - (deg.get(nodeIdOf(a)) ?? 0) || a.line - b.line);
    const rankedX = [...xById.values()].sort((a, b) =>
      (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0) || a.line - b.line);
    const keepM = Math.max(8, Math.min(rankedM.length, Math.round(MAX_NODES * (rankedM.length / rawTotal))));
    selMethods = rankedM.slice(0, keepM);
    selX = rankedX.slice(0, Math.max(0, MAX_NODES - keepM));
  }

  const methodNodes: FlowNode[] = selMethods.map((m) => ({
    id: nodeIdOf(m),
    label: m.name,
    kind: "method",
    container: m.container,
    line: m.line,
    ret: m.ret,
    entry: false, // filled in after edge filtering, below
    unityMsg: UNITY_MESSAGE_NAMES.has(m.name),
  }));

  const nodes: FlowNode[] = [...methodNodes, ...selX];
  const ids = new Set(nodes.map((n) => n.id));
  let edges = [...edgeMap.values()].filter((e) => ids.has(e.from) && ids.has(e.to));
  if (edges.length > MAX_EDGES) {
    truncated = true;
    edges.sort((a, b) => b.count - a.count);
    edges = edges.slice(0, MAX_EDGES);
  }
  // entry = nothing that SURVIVED selection calls it (a caller outside the cap
  // must not make a node look non-entry while its caller is invisible)
  const calledInternally = new Set<string>();
  for (const e of edges) calledInternally.add(e.to);
  for (const n of methodNodes) n.entry = !calledInternally.has(n.id);

  /* ---------- Phase 13 — per-caller call-order ranks ----------
   *  Localized to each method: its surviving outgoing edges are ranked 1..N by
   *  the source position of their first call site, so the badges read in the
   *  order the calls appear (and execute) inside that method's body. */
  const byFrom = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    const arr = byFrom.get(e.from);
    if (arr) arr.push(e); else byFrom.set(e.from, [e]);
  }
  for (const [, arr] of byFrom) {
    arr.sort((a, b) => a.fr - b.fr || a.fc - b.fc);
    arr.forEach((e, i) => { e.order = i + 1; });
  }

  return {
    ok: true,
    file: path,
    nodes,
    edges,
    truncated,
    methodCount: methods.length,
    extCount: hiddenLabels.size,
    hiddenCalls: hiddenSites,
    crossCount: selX.length,
  };
}
