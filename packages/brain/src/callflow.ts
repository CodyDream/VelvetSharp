/**
 * Phase 9 — per-script CALL FLOW graph (user: "show a generated flow chart like
 * dependency graph how is the each selected script method traveling works, just
 * scope is inside the script show how methods call each other and when method
 * call something outside the script just use different shape and put end to
 * that branch").
 *
 * Scope is strictly ONE file: nodes are the methods declared in it, edges are
 * calls between them. Any invocation that does not resolve inside the file
 * (Debug.Log, other classes, Unity API…) becomes an EXTERNAL terminal node —
 * a different shape in the UI, and traversal stops there by construction.
 */
import { UNITY_MESSAGE_NAMES } from "./snippets";

export interface FlowNode {
  id: string;            // "m::<Container>::<name>" or "ext::<label>"
  label: string;         // method name, or external call text ("Debug.Log")
  kind: "method" | "external";
  container: string;     // declaring type simple name ("" for external)
  line: number;          // 0-based decl line (methods only)
  ret: string;           // return type text (methods only)
  entry: boolean;        // nothing inside the file calls it (Unity messages usually are)
  unityMsg: boolean;     // name is a Unity lifecycle message
}

export interface FlowEdge {
  from: string;
  to: string;
  count: number;         // call sites (caller → callee)
  external: boolean;     // into an external terminal node
}

export interface CallFlowResult {
  ok: boolean;
  reason?: string;
  file: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  truncated: boolean;
  methodCount: number;   // in-file methods seen (before caps)
  extCount: number;      // distinct external targets (before caps)
}

const MAX_NODES = 160;
const MAX_EDGES = 400;
const MAX_EXT_LABEL = 44;

interface MDecl {
  name: string;
  container: string;     // simple name of the enclosing type
  line: number;
  ret: string;
  nodeId: number;        // tree-sitter node id (unique per parse)
}

export function buildCallFlow(engine: any, path: string): CallFlowResult {
  const empty = (reason: string): CallFlowResult =>
    ({ ok: false, reason, file: path, nodes: [], edges: [], truncated: false, methodCount: 0, extCount: 0 });

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
    return { ok: true, file: path, nodes: [], edges: [], truncated: false, methodCount: 0, extCount: 0 };
  }

  const nodeIdOf = (m: MDecl) => `m::${m.container}::${m.name}`;

  /** resolve an invocation callee to an in-file method — null = external call */
  const resolveCallee = (fn: any, caller: MDecl): MDecl | null => {
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
      return null; // conditional access, invocations of invocations, etc. — external
    }
    if (!name) return null;

    // 1) explicit qualifier that names an in-file TYPE (static call: GameManager.Spawn())
    if (base) {
      const baseSimple = base.split(".").pop() ?? "";
      if (base === "this") {
        const hit = byKey.get(`${caller.container}::${name}`);
        if (hit) return hit;
      } else if (inFileTypeNames.has(baseSimple)) {
        const hit = byKey.get(`${baseSimple}::${name}`);
        if (hit) return hit;
      } else {
        // the qualifier is a variable/unknown — if it (case-insensitively) looks
        // like a known API type (Debug, Physics…), never steal the call in-file
        const probe = baseSimple.charAt(0).toUpperCase() + baseSimple.slice(1);
        if (engine.unity?.findType?.(baseSimple) || engine.unity?.findType?.(probe)) return null;
      }
    }

    // 2) same-class method (bare call, or qualifier is the enclosing type itself)
    const same = byKey.get(`${caller.container}::${name}`);
    if (same) return same;

    // 3) any method in this file with that name (field-of-type-in-file: player.Heal())
    const list = byName.get(name);
    return list?.length ? list[0] : null;
  };

  /* ---------- walk invocations ---------- */
  const edgeMap = new Map<string, FlowEdge>();
  const extById = new Map<string, FlowNode>();
  let truncated = false;

  const addEdge = (from: string, to: string, external: boolean) => {
    const key = `${from}|${to}`;
    const e = edgeMap.get(key);
    if (e) { e.count = Math.min(99, e.count + 1); return; }
    if (edgeMap.size >= MAX_EDGES) { truncated = true; return; }
    edgeMap.set(key, { from, to, count: 1, external });
  };

  for (const inv of root.descendantsOfType("invocation_expression")) {
    // enclosing method (skip field initializers / ctors — no caller node to hang the edge on)
    let caller: MDecl | null = null;
    let p: any = inv.parent;
    while (p) {
      if (p.type === "method_declaration") { caller = byNodeId.get(p.id) ?? null; break; }
      p = p.parent;
    }
    if (!caller) continue;
    const fn = inv.childForFieldName("function");
    const hit = resolveCallee(fn, caller);
    if (hit) {
      addEdge(nodeIdOf(caller), nodeIdOf(hit), false);
    } else {
      const raw = (fn?.text ?? "call()").replace(/\s+/g, "");
      const label = raw.length > MAX_EXT_LABEL ? raw.slice(0, MAX_EXT_LABEL - 1) + "…" : raw;
      const id = "ext::" + label.toLowerCase();
      if (!extById.has(id)) {
        if (extById.size >= 80) { truncated = true; continue; }
        extById.set(id, { id, label, kind: "external", container: "", line: inv.startPosition.row, ret: "", entry: false, unityMsg: false });
      }
      addEdge(nodeIdOf(caller), id, true);
    }
  }

  /* ---------- assemble nodes ---------- */
  const calledInternally = new Set<string>();
  for (const e of edgeMap.values()) if (!e.external) calledInternally.add(e.to);

  const methodNodes: FlowNode[] = methods.map((m) => ({
    id: nodeIdOf(m),
    label: m.name,
    kind: "method",
    container: m.container,
    line: m.line,
    ret: m.ret,
    entry: !calledInternally.has(nodeIdOf(m)),
    unityMsg: UNITY_MESSAGE_NAMES.has(m.name),
  }));

  let nodes: FlowNode[] = [...methodNodes, ...extById.values()];
  if (nodes.length > MAX_NODES) {
    truncated = true;
    nodes = nodes.slice(0, MAX_NODES);
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [...edgeMap.values()].filter((e) => ids.has(e.from) && ids.has(e.to));

  return {
    ok: true,
    file: path,
    nodes,
    edges,
    truncated,
    methodCount: methods.length,
    extCount: extById.size,
  };
}
