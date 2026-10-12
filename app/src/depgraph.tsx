/** VelvetSharp — dependency graph view (v0.6.0, "phase 6").
 *
 * Rider-style class/script dependency renderer. Four layout engines, all
 * implemented locally (no external deps, works fully offline):
 *
 *   hierarchical — layered longest-path (Sugiyama-lite) + barycenter ordering;
 *                  dependencies flow DOWN (dependents on top, foundations below)
 *   organic      — force-directed (Fruchterman–Reingold style) spring simulation
 *   circular     — dependency-ordered ring with center-bent arcs
 *   business     — the layered layout with orthogonal elbow routing + card nodes
 *
 * Interactions: wheel zoom, drag pan, hover highlights the neighborhood,
 * click selects (details card), double-click opens the script, filter dims,
 * scope picker re-requests the brain for any folder. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "./store";
import type { BrainClient, DepGraphResult, DepNodeResult, DepEdgeResult } from "./brain-client";

type LayoutName = "hierarchical" | "organic" | "circular" | "business";

interface Pt { x: number; y: number }
interface LaidNode { node: DepNodeResult; x: number; y: number } // top-left
interface LaidEdge { edge: DepEdgeResult; points: Pt[] }

const NODE_W = 158;
const NODE_H = 44;
const GAP_X = 26;
const GAP_Y = 78;

/** v0.6.1 crash guard — the brain already caps nodes/edges; these are the
 *  render-side backstops. Beyond ~2500 SVG paths WebView2 gives up. */
const MAX_RENDER_NODES = 620;
const MAX_RENDER_EDGES = 2400;

/* --------------------------------- layouts --------------------------------- */

/** adjacency helpers (dependencies = outgoing edges) */
function buildAdj(nodes: DepNodeResult[], edges: DepEdgeResult[]) {
  const deps = new Map<string, string[]>();   // id -> ids it depends on
  const users = new Map<string, string[]>();  // id -> ids depending on it
  for (const n of nodes) { deps.set(n.id, []); users.set(n.id, []); }
  for (const e of edges) {
    if (!deps.has(e.from) || !deps.has(e.to)) continue;
    deps.get(e.from)!.push(e.to);
    users.get(e.to)!.push(e.from);
  }
  return { deps, users };
}

function layered(nodes: DepNodeResult[], edges: DepEdgeResult[]) {
  const { deps } = buildAdj(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const layer = new Map<string, number>();
  // longest-path layering with cycle guard (DFS, gray stack)
  const state = new Map<string, 0 | 1 | 2>();
  const layerOf = (id: string): number => {
    const memo = layer.get(id);
    if (memo !== undefined) return memo;
    if (state.get(id) === 1) { layer.set(id, 0); return 0; } // cycle — pin at 0
    state.set(id, 1);
    let l = 0;
    for (const d of deps.get(id) ?? []) {
      if (d === id) continue;
      l = Math.max(l, layerOf(d) + 1);
    }
    state.set(id, 2);
    layer.set(id, l);
    return l;
  };
  for (const n of nodes) layerOf(n.id);
  let maxLayer = 0;
  layer.forEach((l) => { if (l > maxLayer) maxLayer = l; });

  // group into rows; barycenter ordering sweeps
  const rows: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) rows[layer.get(n.id)!].push(n.id);
  const pos = new Map<string, number>(); // index within row
  rows.forEach((r) => r.forEach((id, i) => pos.set(id, i)));
  const { users } = buildAdj(nodes, edges);
  const bary = (id: string, side: Map<string, string[]>) => {
    const ns = side.get(id) ?? [];
    if (!ns.length) return pos.get(id) ?? 0;
    return ns.reduce((a, x) => a + (pos.get(x) ?? 0), 0) / ns.length;
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? rows : [...rows].reverse();
    for (const row of order) {
      const scored = row.map((id) => ({ id, b: bary(id, down ? users : deps) }));
      scored.sort((a, b) => a.b - b.b || a.id.localeCompare(b.id));
      row.length = 0;
      scored.forEach((s, i) => { row.push(s.id); pos.set(s.id, i); });
    }
  }
  return { rows, maxLayer };
}

function layoutHierarchical(nodes: DepNodeResult[], edges: DepEdgeResult[], business: boolean): { nodes: LaidNode[]; edges: LaidEdge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const { rows, maxLayer } = layered(nodes, edges);
  const laid: LaidNode[] = [];
  const centers = new Map<string, Pt>();
  rows.forEach((row, li) => {
    const y = (maxLayer - li) * (NODE_H + GAP_Y); // dependents on top
    const rowW = row.length * (NODE_W + GAP_X) - GAP_X;
    const x0 = -rowW / 2;
    row.forEach((id, i) => {
      const p = { x: x0 + i * (NODE_W + GAP_X), y };
      centers.set(id, { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 });
      laid.push({ node: byId.get(id)!, ...p });
    });
  });
  const outEdges: LaidEdge[] = [];
  for (const e of edges) {
    const s = centers.get(e.from), t = centers.get(e.to);
    if (!s || !t) continue;
    if (business) outEdges.push({ edge: e, points: elbow(s, t) });
    else outEdges.push({ edge: e, points: bezierDown(s, t) });
  }
  return { nodes: laid, edges: outEdges };
}

function bezierDown(s: Pt, t: Pt): Pt[] {
  if (Math.abs(s.x - t.x) < 4) return [s, t];
  const midY = (s.y + t.y) / 2;
  return [s, { x: s.x, y: midY }, { x: t.x, y: midY }, t];
}

/** orthogonal business elbow: leave the bottom, cross a channel, enter the top.
 *  Backwards edges route around the side. */
function elbow(s: Pt, t: Pt): Pt[] {
  if (t.y >= s.y + NODE_H) {
    const midY = s.y + (t.y - s.y) / 2;
    if (Math.abs(s.x - t.x) < 4) return [s, { x: s.x, y: t.y - 8 }, t];
    return [s, { x: s.x, y: midY }, { x: t.x, y: midY }, { x: t.x, y: t.y - 8 }, t];
  }
  // backwards / sideways: exit the side, elbow outside both rows
  const outX = s.x + (s.x <= t.x ? -(NODE_W / 2 + 22) : NODE_W / 2 + 22);
  const inX = t.x + (s.x <= t.x ? NODE_W / 2 + 22 : -(NODE_W / 2 + 22));
  const midY = t.y >= s.y ? (s.y + t.y) / 2 : s.y - (NODE_H + GAP_Y) / 2;
  return [s, { x: outX, y: s.y }, { x: outX, y: midY }, { x: inX, y: midY }, { x: inX, y: t.y }, t];
}

function layoutOrganic(nodes: DepNodeResult[], edges: DepEdgeResult[]): { nodes: LaidNode[]; edges: LaidEdge[] } {
  const n = nodes.length;
  const byId = new Map(nodes.map((nd) => [nd.id, nd] as const));
  // deterministic seed ring
  const R0 = Math.max(220, n * 24);
  const px = nodes.map((nd, i) => {
    const h = hash32(nd.id);
    const a = (h % 3600) / 3600 * Math.PI * 2;
    const r = R0 * (0.45 + (h % 100) / 220);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  const idx = new Map(nodes.map((nd, i) => [nd.id, i] as const));
  const pairs: [number, number][] = [];
  for (const e of edges) {
    const a = idx.get(e.from), b = idx.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) pairs.push([a, b]);
  }
  const k = Math.max(110, Math.sqrt((2 * R0 * R0) / Math.max(1, n)) * 0.9); // desired dist
  const iters = Math.max(80, Math.min(280, Math.round(9000 / Math.max(1, n))));
  let temp = R0 * 0.22;
  for (let it = 0; it < iters; it++) {
    const fx = new Array(n).fill(0);
    const fy = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = px[i].x - px[j].x, dy = px[i].y - px[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (hash32(nodes[i].id + j) % 7) - 3 || 2; dy = (hash32(nodes[j].id + i) % 7) - 3 || 2; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const rep = (k * k) / d;
        fx[i] += (dx / d) * rep; fy[i] += (dy / d) * rep;
        fx[j] -= (dx / d) * rep; fy[j] -= (dy / d) * rep;
      }
    }
    for (const [a, b] of pairs) {
      let dx = px[a].x - px[b].x, dy = px[a].y - px[b].y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const att = (d * d) / k;
      fx[a] -= (dx / d) * att; fy[a] -= (dy / d) * att;
      fx[b] += (dx / d) * att; fy[b] += (dy / d) * att;
    }
    for (let i = 0; i < n; i++) {
      const fl = Math.max(1, Math.sqrt(fx[i] * fx[i] + fy[i] * fy[i]));
      const step = Math.min(fl, temp);
      px[i].x += (fx[i] / fl) * step;
      px[i].y += (fy[i] / fl) * step;
    }
    temp *= 0.965;
  }
  // center + pad
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const p of px) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const laid: LaidNode[] = nodes.map((nd, i) => ({
    node: nd,
    x: px[i].x - cx - NODE_W / 2,
    y: px[i].y - cy - NODE_H / 2,
  }));
  const centers = new Map(laid.map((l) => [l.node.id, { x: l.x + NODE_W / 2, y: l.y + NODE_H / 2 } as Pt]));
  const outEdges: LaidEdge[] = edges
    .filter((e) => centers.has(e.from) && centers.has(e.to))
    .map((e) => ({ edge: e, points: [centers.get(e.from)!, centers.get(e.to)!] }));
  return { nodes: laid, edges: outEdges };
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function layoutCircular(nodes: DepNodeResult[], edges: DepEdgeResult[]): { nodes: LaidNode[]; edges: LaidEdge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  // dependency-first ring order: layered order, then name (stable, related types cluster)
  const { rows, maxLayer } = layered(nodes, edges);
  const order: string[] = [];
  for (let li = maxLayer; li >= 0; li--) rows[li].sort((a, b) => byId.get(a)!.name.localeCompare(byId.get(b)!.name)).forEach((id) => order.push(id));
  for (const n of nodes) if (!order.includes(n.id)) order.push(n.id);
  const R = Math.max(230, (order.length * (NODE_W + 18)) / (2 * Math.PI));
  const laid: LaidNode[] = [];
  const centers = new Map<string, Pt>();
  order.forEach((id, i) => {
    const a = (i / order.length) * Math.PI * 2 - Math.PI / 2;
    const cxp = Math.cos(a) * R, cyp = Math.sin(a) * R * 0.78; // slight ellipse fits widescreens
    const p = { x: cxp - NODE_W / 2, y: cyp - NODE_H / 2 };
    centers.set(id, { x: cxp, y: cyp });
    laid.push({ node: byId.get(id)!, ...p });
  });
  const outEdges: LaidEdge[] = [];
  for (const e of edges) {
    const s = centers.get(e.from), t = centers.get(e.to);
    if (!s || !t) continue;
    const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
    const cx2 = mx * 0.35, cy2 = my * 0.35; // bend toward the center
    const steps = 14;
    const pts: Pt[] = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const x = (1 - u) * (1 - u) * s.x + 2 * (1 - u) * u * cx2 + u * u * t.x;
      const y = (1 - u) * (1 - u) * s.y + 2 * (1 - u) * u * cy2 + u * u * t.y;
      pts.push({ x, y });
    }
    outEdges.push({ edge: e, points: pts });
  }
  return { nodes: laid, edges: outEdges };
}

export function pathOfPoints(points: Pt[], rounded = false): string {
  if (points.length < 2) return "";
  if (!rounded) {
    return points.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(" ");
  }
  // rounded polyline elbows (business layout)
  let d = `M ${points[0].x} ${points[0].y}`;
  const r = 10;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1], cur = points[i], next = points[i + 1];
    const l1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const l2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const a = { x: cur.x - ((cur.x - prev.x) / (l1 || 1)) * rr, y: cur.y - ((cur.y - prev.y) / (l1 || 1)) * rr };
    const b = { x: cur.x + ((next.x - cur.x) / (l2 || 1)) * rr, y: cur.y + ((next.y - cur.y) / (l2 || 1)) * rr };
    d += ` L ${a.x} ${a.y} Q ${cur.x} ${cur.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function computeLayout(name: LayoutName, nodes: DepNodeResult[], edges: DepEdgeResult[]) {
  // v0.7.1 crash hardening (user report: graph still crashes, especially circular):
  // a layout bug must NEVER take the app down. Every layout runs inside a guard;
  // on any throw (or a degenerate result) we fall back to the plain hierarchical
  // layout, which is pure longest-path layering and cannot loop.
  const safe = (fn: () => { nodes: LaidNode[]; edges: LaidEdge[] }) => {
    try {
      const r = fn();
      if (!r || !Array.isArray(r.nodes) || !Array.isArray(r.edges)) throw new Error("degenerate layout result");
      return r;
    } catch (e: any) {
      try {
        window.setTimeout(() => useStore.getState().showErrorPopup(
          "Dependency graph layout failed",
          `The "${name}" layout could not render ${nodes.length} nodes and fell back to Hierarchical.\n\n${String(e?.message ?? e)}`,
          String(e?.stack ?? ""),
        ), 0);
      } catch { /* store not ready — the fallback still renders */ }
      return layoutHierarchical(nodes, edges, false);
    }
  };
  if (name === "organic") return safe(() => layoutOrganic(nodes, edges));
  if (name === "circular") {
    // the ring geometry grows linearly with node count; beyond ~260 nodes the
    // ring radius (and every arc) becomes absurd — degrade gracefully instead
    if (nodes.length > 260) {
      const capped = nodes.slice(0, 260);
      const keep = new Set(capped.map((n) => n.id));
      return safe(() => layoutCircular(capped, edges.filter((e) => keep.has(e.from) && keep.has(e.to))));
    }
    return safe(() => layoutCircular(nodes, edges));
  }
  return safe(() => layoutHierarchical(nodes, edges, name === "business"));
}

/* --------------------------------- component --------------------------------- */

const KIND_GLYPH: Record<string, string> = {
  class: "▣", struct: "▤", interface: "◇", enum: "◫", external: "⊘",
};
const LAYOUTS: { id: LayoutName; label: string; hint: string }[] = [
  { id: "hierarchical", label: "Hierarchical", hint: "layered top-down — dependencies flow down (Sugiyama)" },
  { id: "organic", label: "Organic", hint: "force-directed clusters (spring simulation)" },
  { id: "circular", label: "Circular", hint: "dependency ring with center arcs" },
  { id: "business", label: "Business", hint: "layered card nodes with orthogonal elbows" },
];

export function DepGraphView({ onOpen }: { onOpen?: (path: string, line: number, col: number) => void }) {
  const client = (window as any).__client as BrainClient | undefined;
  const scope = useStore((s) => s.graphScope);
  const seed = useStore((s) => s.graphSeed);
  const [graph, setGraph] = useState<DepGraphResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [layout, setLayout] = useState<LayoutName>("hierarchical");
  const [includeExternal, setIncludeExternal] = useState(false);
  const [filter, setFilter] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // (re)request the graph
  useEffect(() => {
    if (!client) return;
    let cancel = false;
    setBusy(true);
    client.depGraph(scope, includeExternal)
      .then((g) => { if (!cancel) { setGraph(g); setBusy(false); setSelected(null); } })
      .catch(() => { if (!cancel) { setGraph(null); setBusy(false); } });
    return () => { cancel = true; };
  }, [client, scope, includeExternal, seed]);

  // auto-refresh when the symbol index changes while the graph is open
  // (boot finish, renames, reindex) — guards against requesting mid-boot
  const statsFiles = useStore((s) => s.stats.files);
  const graphOpen = useStore((s) => s.graphOpen);
  useEffect(() => {
    if (graphOpen && statsFiles > 0) useStore.getState().refreshGraph();
  }, [statsFiles]);

  const laid = useMemo(() => {
    if (!graph) return null;
    // render-side safety net (defense in depth — brain caps normally win)
    let nodes = graph.nodes;
    let edges = graph.edges;
    if (nodes.length > MAX_RENDER_NODES) nodes = nodes.slice(0, MAX_RENDER_NODES);
    if (edges.length > MAX_RENDER_EDGES) edges = edges.slice(0, MAX_RENDER_EDGES);
    return computeLayout(layout, nodes, edges);
  }, [graph, layout]);

  const byId = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n] as const)), [graph]);
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of graph?.edges ?? []) {
      if (!m.has(e.from)) m.set(e.from, new Set());
      if (!m.has(e.to)) m.set(e.to, new Set());
      m.get(e.from)!.add(e.to);
      m.get(e.to)!.add(e.from);
    }
    return m;
  }, [graph]);

  const filterLower = filter.trim().toLowerCase();
  const matchesFilter = useCallback((id: string) => {
    if (!filterLower) return true;
    return (byId.get(id)?.name ?? "").toLowerCase().includes(filterLower);
  }, [filterLower, byId]);

  const focusId = hover ?? selected;
  const isDimmedNode = (id: string) => {
    if (filterLower && !matchesFilter(id)) return true;
    if (!focusId || focusId === id) return false;
    return !(neighbors.get(focusId)?.has(id));
  };
  const isDimmedEdge = (e: DepEdgeResult) => {
    if (filterLower && !(matchesFilter(e.from) || matchesFilter(e.to))) return true;
    if (!focusId) return false;
    return e.from !== focusId && e.to !== focusId;
  };

  const fit = useCallback(() => {
    if (!laid || !hostRef.current) return;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const l of laid.nodes) {
      minX = Math.min(minX, l.x); minY = Math.min(minY, l.y);
      maxX = Math.max(maxX, l.x + NODE_W); maxY = Math.max(maxY, l.y + NODE_H);
    }
    const w = hostRef.current.clientWidth, h = hostRef.current.clientHeight;
    const pad = 40;
    const scale = Math.min(1.6, Math.max(0.18, Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxY - minY))));
    setView({
      scale,
      x: w / 2 - ((minX + maxX) / 2) * scale,
      y: h / 2 - ((minY + maxY) / 2) * scale,
    });
  }, [laid]);

  useEffect(() => { fit(); }, [fit]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => {
      const scale = Math.max(0.1, Math.min(3.5, v.scale * factor));
      const k = scale / v.scale;
      return { scale, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
    });
  };
  const onBgMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setView((v) => ({ ...v, x: dragRef.current!.ox + (e.clientX - dragRef.current!.sx), y: dragRef.current!.oy + (e.clientY - dragRef.current!.sy) }));
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  const openNodeFile = (n: DepNodeResult) => {
    if (!n.file) return;
    useStore.getState().closeGraph();
    onOpen?.(n.file, n.line, 0);
  };

  const scopeOptions = useMemo(() => {
    const files = useStore.getState().files.filter((f) => f.endsWith(".cs") || f.endsWith(".asmdef"));
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return ["", ...[...dirs].sort()].map((d) => ({ value: d, label: d || "Whole project" }));
  }, [seed]);

  const selNode = selected ? byId.get(selected) : null;
  const usedBy = selected ? (graph?.edges ?? []).filter((e) => e.to === selected) : [];
  const usesOf = selected ? (graph?.edges ?? []).filter((e) => e.from === selected) : [];
  const nodeCount = (graph?.nodes ?? []).length;

  return (
    <div className="depgraph">
      <div className="dg-toolbar">
        <span className="dg-title">⬢ Dependencies</span>
        <div className="dg-layouts">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              className={"dg-lay" + (layout === l.id ? " active" : "")}
              title={l.hint}
              onClick={() => setLayout(l.id)}
            >{l.label}</button>
          ))}
        </div>
        <select
          className="dg-scope"
          value={scope ?? ""}
          title="Scope: show just one folder and its sub-folders"
          onChange={(e) => useStore.getState().setGraphScope(e.target.value || null)}
        >
          {scopeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label className="dg-chk" title="Show Unity/BCL types the scoped code touches">
          <input type="checkbox" checked={includeExternal} onChange={(e) => setIncludeExternal(e.target.checked)} /> Unity/BCL
        </label>
        <input
          className="dg-filter"
          placeholder="filter types…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
        <button className="dg-btn" title="Zoom to fit" onClick={fit}>⤢ fit</button>
        <button className="dg-btn" title="Rebuild from the latest index" onClick={() => useStore.getState().refreshGraph()}>⟳</button>
        <span className="spacer" />
        {(graph?.truncated || (graph?.totalTypes ?? 0) > nodeCount) && (
          <span
            className="dg-warn"
            title="Scope is huge — showing the most connected types. Pick a folder (⬡ on a folder or the scope dropdown) for the full picture."
          >
            top {nodeCount} of {graph?.totalTypes ?? nodeCount} types
          </span>
        )}
        <span className="dg-stats">{busy ? "building…" : `${nodeCount} types · ${graph?.edges.length ?? 0} dependencies`}</span>
        <button className="dg-btn dg-close" title="Close the graph (Esc)" onClick={() => { useStore.getState().closeGraph(); useStore.getState().setActive(null); }}>×</button>
      </div>
      <div
        className="dg-canvas"
        ref={hostRef}
        onWheel={onWheel}
        onMouseDown={onBgMouseDown}
        onDoubleClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
      >
        {busy && <div className="dg-empty">building the dependency graph…</div>}
        {!busy && !laid?.nodes.length && (
          <div className="dg-empty">no types in this scope — pick another folder or open the whole project</div>
        )}
        {laid && !!laid.nodes.length && (
          <svg className="dg-svg" width="100%" height="100%">
            <defs>
              <marker id="arr-extends" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#b47aff" />
              </marker>
              <marker id="arr-implements" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#4ec9b0" />
              </marker>
              <marker id="arr-uses" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#8a7fae" />
              </marker>
            </defs>
            <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
              {laid.edges.map((le, i) => {
                const kind = le.edge.kind;
                const cls = `dg-edge e-${kind}` + (isDimmedEdge(le.edge) ? " dim" : "")
                  + (focusId && (le.edge.from === focusId || le.edge.to === focusId) ? " hot" : "");
                return (
                  <path
                    key={i}
                    className={cls}
                    d={pathOfPoints(le.points, layout === "business")}
                    markerEnd={`url(#arr-${kind})`}
                    strokeWidth={kind === "uses" ? 1 + Math.min(1.6, (le.edge.weight - 1) * 0.25) : undefined}
                  />
                );
              })}
              {laid.nodes.map((l) => {
                const n = l.node;
                const dim = isDimmedNode(n.id);
                const sel = selected === n.id;
                const cls = "dg-node" + (n.external ? " ext" : "") + (n.outOfScope ? " out" : "")
                  + (n.isMono ? " mono" : "") + (sel ? " sel" : "") + (dim ? " dim" : "")
                  + (n.kind === "interface" ? " iface" : "");
                return (
                  <g
                    key={n.id}
                    className={cls}
                    transform={`translate(${l.x},${l.y})`}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                    onClick={(e) => { e.stopPropagation(); setSelected(n.id); }}
                    onDoubleClick={(e) => { e.stopPropagation(); openNodeFile(n); }}
                  >
                    <rect className="dg-box" x={0} y={0} width={NODE_W} height={NODE_H} rx={layout === "business" ? 3 : 8} />
                    <text className="dg-glyph" x={12} y={19}>{KIND_GLYPH[n.kind] ?? "▣"}</text>
                    <text className="dg-name" x={30} y={19}>{clip(n.name, 16)}</text>
                    <text className="dg-sub" x={12} y={34}>
                      {n.external ? n.ns || "external" : [n.asm ?? "", n.file.split("/").pop() ?? ""].filter(Boolean).join(" · ")}
                    </text>
                    {(n.inDeg > 0 || n.outDeg > 0) && (
                      <g className="dg-degs">
                        {n.inDeg > 0 && <text x={NODE_W - 30} y={34}>↓{n.inDeg}</text>}
                        {n.outDeg > 0 && <text x={NODE_W - 14} y={34}>↑{n.outDeg}</text>}
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        {selNode && (
          <div className="dg-details" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dgd-head">
              <span className="dgd-kind">{selNode.kind}</span>
              <span className="dgd-name">{selNode.name}</span>
              {selNode.isMono && <span className="dgd-badge">Unity</span>}
              {selNode.outOfScope && <span className="dgd-badge out">out of scope</span>}
              {selNode.external && <span className="dgd-badge ext">external</span>}
            </div>
            {selNode.file ? (
              <div className="dgd-file" title={selNode.file} onClick={() => openNodeFile(selNode)}>
                {selNode.file}:{selNode.line + 1}
              </div>
            ) : (
              <div className="dgd-file">compiled — {selNode.ns || "(global)"}</div>
            )}
            {selNode.asm && <div className="dgd-asm">assembly: {selNode.asm}</div>}
            <div className="dgd-list-title">Used by ({usedBy.length})</div>
            <div className="dgd-list">
              {usedBy.length === 0 && <span className="dgd-none">nothing in this scope</span>}
              {usedBy.map((e) => (
                <div key={e.from + e.kind} className={"dgd-item k-" + e.kind} onClick={() => setSelected(e.from)}>
                  <span className="dgd-arrow">{arrowFor(e.kind)}</span>{byId.get(e.from)?.name ?? e.from}
                </div>
              ))}
            </div>
            <div className="dgd-list-title">Uses ({usesOf.length})</div>
            <div className="dgd-list">
              {usesOf.length === 0 && <span className="dgd-none">nothing in this scope</span>}
              {usesOf.map((e) => (
                <div key={e.to + e.kind} className={"dgd-item k-" + e.kind} onClick={() => setSelected(e.to)}>
                  <span className="dgd-arrow">{arrowFor(e.kind)}</span>{byId.get(e.to)?.name ?? e.to}
                  {e.weight > 1 && <span className="dgd-w">×{e.weight}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="dg-legend">
          <span className="lg lg-extends">— inheritance</span>
          <span className="lg lg-implements">‑ ‑ interface</span>
          <span className="lg lg-uses">— uses</span>
          <span className="lg lg-hint">hover: highlight · click: inspect · double-click: open script · wheel: zoom · drag: pan</span>
        </div>
      </div>
    </div>
  );
}

function arrowFor(kind: string): string {
  return kind === "extends" ? "▲" : kind === "implements" ? "◇" : "→";
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export { computeLayout as defaultComputeLayout };
export type { LayoutName, LaidNode, LaidEdge };
