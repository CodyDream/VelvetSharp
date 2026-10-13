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
import type { BrainClient, DepGraphResult, DepNodeResult, DepEdgeResult, CallFlowResult } from "./brain-client";

type LayoutName = "hierarchical" | "vertical" | "organic" | "circular" | "business";

interface Pt { x: number; y: number }
interface LaidNode { node: DepNodeResult; x: number; y: number } // top-left
interface LaidEdge { edge: DepEdgeResult; points: Pt[] }

const NODE_W = 158;
const NODE_H = 44;
const GAP_X = 26;
const GAP_Y = 78;

/** v0.6.1 crash guard — the brain already caps nodes/edges; these are the
 *  render-side backstops. Phase 8: the brain now emits type declarations only
 *  (classes/structs/interfaces/enums) with far fewer edges, so the render caps
 *  come down to match what the webview can comfortably draw. */
const MAX_RENDER_NODES = 300;
const MAX_RENDER_EDGES = 1000;

/** Phase 9 — map a per-script call-flow result onto the shared renderer.
 *  method nodes keep their own kind; external terminals get "extcall" (drawn
 *  as a different SHAPE, dashed) — and traversal genuinely ends there because
 *  the engine never emits outgoing edges from external nodes. */
function flowToGraph(r: CallFlowResult): DepGraphResult & { flowReason?: string } {
  if (!r.ok) return { scope: r.file, nodes: [], edges: [], truncated: false, totalTypes: 0, flowReason: r.reason };
  const nodes: DepNodeResult[] = r.nodes.map((n) => ({
    id: n.id,
    name: n.label,
    kind: n.kind === "external" ? "extcall" : "method",
    file: r.file,
    line: n.line,
    ns: n.container,
    asm: null,
    isMono: false,
    external: n.kind === "external",
    refCount: 0,
    outDeg: 0,
    inDeg: 0,
    ret: n.ret,
    entry: n.entry,
    unityMsg: n.unityMsg,
  }));
  const edges: DepEdgeResult[] = r.edges.map((e) => ({
    from: e.from,
    to: e.to,
    kind: e.from === e.to && !e.external ? "self" : e.external ? "extcall" : "call",
    weight: e.count,
  }));
  return { scope: r.file, nodes, edges, truncated: r.truncated, totalTypes: Math.max(r.nodes.length, (r.methodCount ?? 0) + (r.extCount ?? 0)) };
}

/** Phase 10 — the flow result must survive even a malformed worker payload:
 *  a throw inside the mapper used to hit the bare .catch and render a silent
 *  blank canvas that looked like "the graph crashed". */
function safeFlowToGraph(r: CallFlowResult): DepGraphResult & { flowReason?: string } {
  try {
    return flowToGraph(r);
  } catch (e: any) {
    return {
      scope: r?.file ?? "", nodes: [], edges: [], truncated: false, totalTypes: 0,
      flowReason: `call flow failed to map: ${String(e?.message ?? e)} — press ⟳ to retry`,
    };
  }
}

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
  const layer = new Map<string, number>();
  // longest-path layering with cycle guard — Phase 10: iterative (explicit
  // stack). The recursive DFS could overflow the JS stack on pathological
  // chains (a 10k-call chain), and a layout crash must never reach the UI.
  const state = new Map<string, 0 | 1 | 2>();
  for (const start of nodes) {
    if (state.get(start.id)) continue;
    state.set(start.id, 1);
    const stack: { id: string; i: number }[] = [{ id: start.id, i: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const dl = deps.get(top.id) ?? [];
      if (top.i < dl.length) {
        const d = dl[top.i++];
        if (d === top.id) continue; // self edge
        const s = state.get(d) ?? 0;
        if (s === 0) { state.set(d, 1); stack.push({ id: d, i: 0 }); }
        else if (s === 1 && !layer.has(d)) layer.set(d, 0); // cycle — pin at 0
      } else {
        let l = 0;
        for (const d of dl) { if (d !== top.id) l = Math.max(l, (layer.get(d) ?? 0) + 1); }
        layer.set(top.id, l);
        state.set(top.id, 2);
        stack.pop();
      }
    }
  }
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

/* --------------------- Phase 10 — vertical tidy-tree ---------------------
 *  A layered layout packs every node of the same depth into ONE row, so a
 *  call flow renders as a wide thin strip ("too much horizontal, not
 *  vertical"). This is a flowchart instead: sources on top, calls flow DOWN,
 *  each branch owns its own column (Reingold–Tilford style subtree packing).
 *  Shared callees parent to the FIRST visitor that reaches them — later
 *  callers draw cross edges. Disjoint cycles seed extra roots, so every node
 *  is always placed. */
function layoutVertical(nodes: DepNodeResult[], edges: DepEdgeResult[]): { nodes: LaidNode[]; edges: LaidEdge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const children = new Map<string, string[]>();
  const inbound = new Map<string, number>();
  for (const n of nodes) { children.set(n.id, []); inbound.set(n.id, 0); }
  const seenTree = new Set<string>();
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    if (e.from === e.to) continue;               // self loops render separately
    const k = e.from + "→" + e.to;
    if (seenTree.has(k)) continue;               // second parent → cross edge
    seenTree.add(k);
    children.get(e.from)!.push(e.to);
    inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);
  }

  const parent = new Map<string, string>();
  const pre: string[] = [];                      // DFS pre-order (parents before children)
  const placed = new Set<string>();

  // one pass: seed → claim unclaimed children depth-first (explicit stack)
  const passFrom = (seed: string) => {
    const stack: string[] = [seed];
    while (stack.length) {
      const id = stack.pop()!;
      if (placed.has(id)) continue;
      placed.add(id);
      pre.push(id);
      const kids = children.get(id) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) {
        const c = kids[i];
        if (placed.has(c) || parent.has(c)) continue;
        parent.set(c, id);
        stack.push(c);
      }
    }
  };

  for (const n of nodes) if ((inbound.get(n.id) ?? 0) === 0 && !placed.has(n.id)) passFrom(n.id);
  for (const n of nodes) if (!placed.has(n.id)) passFrom(n.id); // disjoint cycles / orphans

  const LEAF_W = NODE_W + GAP_X;
  const width = new Map<string, number>();
  const kidsOf = (id: string) => (children.get(id) ?? []).filter((c) => parent.get(c) === id);

  const laid: LaidNode[] = [];
  const center = new Map<string, Pt>();
  let rx = 0;                                    // running x for successive root subtrees
  let maxDepth = 0;

  const placeTree = (seedId: string, depth0: number) => {
    // collect this pass's subtree in pre-order, then width it bottom-up
    const local: string[] = [];
    const inLocal = new Set<string>();
    const stack: string[] = [seedId];
    while (stack.length) {
      const id = stack.pop()!;
      if (inLocal.has(id)) continue;
      inLocal.add(id);
      local.push(id);
      const kids = kidsOf(id).filter((c) => placed.has(c));
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    for (let i = local.length - 1; i >= 0; i--) {
      const id = local[i];
      let w = 0;
      for (const c of kidsOf(id)) w += width.get(c) ?? LEAF_W;
      width.set(id, Math.max(LEAF_W, w));
    }
    // top-down x assignment: parent centered over its children
    const assign = (id: string, cx: number, dep: number) => {
      const node = byId.get(id);
      if (!node) return;
      maxDepth = Math.max(maxDepth, dep);
      center.set(id, { x: cx, y: dep * (NODE_H + GAP_Y) });
      laid.push({ node, x: cx - NODE_W / 2, y: dep * (NODE_H + GAP_Y) });
      const kids = kidsOf(id);
      let w = 0;
      for (const c of kids) w += width.get(c) ?? LEAF_W;
      let x = cx - w / 2;
      for (const c of kids) {
        const cw = width.get(c) ?? LEAF_W;
        assign(c, x + cw / 2, dep + 1);
        x += cw;
      }
    };
    assign(seedId, rx + (width.get(seedId) ?? LEAF_W) / 2, depth0);
    rx += (width.get(seedId) ?? LEAF_W) + GAP_X;
  };

  // place every pass tree left-to-right; `placed` order == discovery order
  const rooted = pre.filter((id) => !parent.has(id));
  for (const r of rooted) if (byId.has(r)) placeTree(r, 0);
  // anything still unplaced (cycle member whose seed was itself claimed as a
  // child) is tiled onto one extra row — a layout must never drop a node
  const laidIds = new Set(laid.map((l) => l.node.id));
  for (const n of nodes) {
    if (laidIds.has(n.id)) continue;
    const cx = rx + LEAF_W / 2;
    center.set(n.id, { x: cx, y: (maxDepth + 1) * (NODE_H + GAP_Y) });
    laid.push({ node: n, x: cx - NODE_W / 2, y: (maxDepth + 1) * (NODE_H + GAP_Y) });
    rx += LEAF_W;
  }

  const outEdges: LaidEdge[] = [];
  for (const e of edges) {
    const s = center.get(e.from), t = center.get(e.to);
    if (!s || !t) continue;
    if (e.from === e.to) { outEdges.push({ edge: e, points: selfLoopPts(s) }); continue; }
    if (t.y >= s.y) outEdges.push({ edge: e, points: bezierDown(s, t) });   // down / sideways
    else outEdges.push({ edge: e, points: elbow(s, t) });                   // back edge — around the side
  }
  return { nodes: laid, edges: outEdges };
}

/** last-resort grid — cannot throw, cannot loop; used only if every real
 *  layout engine somehow fails, so the graph view never blanks the app */
function layoutGrid(nodes: DepNodeResult[], edges: DepEdgeResult[]): { nodes: LaidNode[]; edges: LaidEdge[] } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const centers = new Map<string, Pt>();
  const laid: LaidNode[] = nodes.map((n, i) => {
    const p = { x: (i % cols) * (NODE_W + GAP_X), y: Math.floor(i / cols) * (NODE_H + GAP_Y) };
    centers.set(n.id, { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 });
    return { node: n, ...p };
  });
  const outEdges: LaidEdge[] = [];
  for (const e of edges) {
    const s = centers.get(e.from), t = centers.get(e.to);
    if (!s || !t) continue;
    outEdges.push({ edge: e, points: e.from === e.to ? selfLoopPts(s) : [s, t] });
  }
  return { nodes: laid, edges: outEdges };
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
    if (e.from === e.to) { outEdges.push({ edge: e, points: selfLoopPts(s) }); continue; } // Phase 9
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

/** Phase 9: singleton self-loop — a small circular detour above the node
 *  ("static instances … ones that link something to itself"). */
function selfLoopPts(c: Pt): Pt[] {
  return [
    { x: c.x - 20, y: c.y - NODE_H / 2 },          // leaves the top edge (left of center)
    { x: c.x - 36, y: c.y - NODE_H / 2 - 20 },
    { x: c.x,      y: c.y - NODE_H / 2 - 34 },     // apex
    { x: c.x + 36, y: c.y - NODE_H / 2 - 20 },
    { x: c.x + 20, y: c.y - NODE_H / 2 },          // re-enters the top edge (arrow down)
  ];
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
    .map((e) => ({ edge: e, points: e.from === e.to ? selfLoopPts(centers.get(e.from)!) : [centers.get(e.from)!, centers.get(e.to)!] }));
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
  // Phase 8: the `!order.includes(n.id)` fallback was O(n²) — a Set keeps the
  // huge-project path linear (part of the graph-crash hardening)
  const ordered = new Set(order);
  for (const n of nodes) if (!ordered.has(n.id)) order.push(n.id);
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
    if (e.from === e.to) { outEdges.push({ edge: e, points: selfLoopPts(s) }); continue; } // Phase 9
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
  // layout, which is pure longest-path layering and cannot loop. Phase 10: the
  // caller wraps even this in a try/catch with a grid backstop.
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
      try { return layoutHierarchical(nodes, edges, false); }
      catch { return layoutGrid(nodes, edges); }
    }
  };
  if (name === "vertical") return safe(() => layoutVertical(nodes, edges));
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
  method: "ƒ", extcall: "⊗",   // Phase 9 call-flow nodes
};
const LAYOUTS: { id: LayoutName; label: string; hint: string }[] = [
  { id: "hierarchical", label: "Hierarchical", hint: "layered top-down — dependencies flow down (Sugiyama)" },
  { id: "vertical", label: "Vertical", hint: "flowchart-style tidy tree — every branch gets its own column (great for call flow)" },
  { id: "organic", label: "Organic", hint: "force-directed clusters (spring simulation)" },
  { id: "circular", label: "Circular", hint: "dependency ring with center arcs" },
  { id: "business", label: "Business", hint: "layered card nodes with orthogonal elbows" },
];

export function DepGraphView({ onOpen }: { onOpen?: (path: string, line: number, col: number) => void }) {
  const client = (window as any).__client as BrainClient | undefined;
  const scope = useStore((s) => s.graphScope);
  const seed = useStore((s) => s.graphSeed);
  const mode = useStore((s) => s.graphMode);
  const flowFile = useStore((s) => s.graphFlowFile);
  const [graph, setGraph] = useState<(DepGraphResult & { flowReason?: string }) | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null); // Phase 10 — failed requests show WHY, not a silent blank
  const [layout, setLayout] = useState<LayoutName>("hierarchical");
  const [includeExternal, setIncludeExternal] = useState(false);
  const [filter, setFilter] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // Phase 10 — flow mode ALWAYS renders as a vertical flowchart (that is what
  // a call flow is); the layout picker stays a types-mode tool
  const effLayout: LayoutName = mode === "flow" ? "vertical" : layout;

  // (re)request the graph — Phase 9: "types" mode asks for the project type
  // graph, "flow" mode asks for the ACTIVE SCRIPT's method call graph
  useEffect(() => {
    if (!client) return;
    let cancel = false;
    setBusy(true);
    const req = mode === "flow"
      ? (flowFile
          ? client.callFlow(flowFile).then(safeFlowToGraph)
          : Promise.resolve({ scope: "", nodes: [], edges: [], truncated: false, totalTypes: 0, flowReason: "open a script first, then switch to Call Flow" }))
      : client.depGraph(scope, includeExternal);
    req
      .then((g) => { if (!cancel) { setGraph(g); setLoadError(null); setBusy(false); setSelected(null); } })
      .catch((e: any) => { if (!cancel) { setGraph(null); setLoadError(String(e?.message ?? e)); setBusy(false); } });
    return () => { cancel = true; };
  }, [client, scope, includeExternal, seed, mode, flowFile]);

  // auto-refresh when the symbol index changes while the graph is open
  // (boot finish, renames, reindex) — Phase 10: debounced, so a chunked boot
  // or burst of edits cannot fire a request storm at the brain worker
  const statsFiles = useStore((s) => s.stats.files);
  const graphOpen = useStore((s) => s.graphOpen);
  useEffect(() => {
    if (graphOpen && statsFiles > 0) {
      const t = window.setTimeout(() => useStore.getState().refreshGraph(), 350);
      return () => window.clearTimeout(t);
    }
  }, [statsFiles]);

  // Phase 10 — the flow result must survive even a malformed worker payload:
  // a throw inside the mapper used to hit the bare .catch and render a silent
  // blank canvas that looked like "the graph crashed"
  const laid = useMemo(() => {
    if (!graph) return null;
    // render-side safety net (defense in depth — brain caps normally win)
    let nodes = graph.nodes;
    let edges = graph.edges;
    if (nodes.length > MAX_RENDER_NODES) nodes = nodes.slice(0, MAX_RENDER_NODES);
    if (edges.length > MAX_RENDER_EDGES) edges = edges.slice(0, MAX_RENDER_EDGES);
    const name: LayoutName = effLayout;
    try {
      return computeLayout(name, nodes, edges);
    } catch (e: any) {
      try {
        window.setTimeout(() => useStore.getState().showErrorPopup(
          "Dependency graph layout failed",
          `Rendering ${nodes.length} nodes with the "${name}" layout failed; a plain grid was drawn instead.\n\n${String(e?.message ?? e)}`,
          String(e?.stack ?? ""),
        ), 0);
      } catch { /* store not ready */ }
      return layoutGrid(nodes, edges);
    }
  }, [graph, effLayout]);

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

  // Phase 10 — native non-passive wheel listener. React attaches wheel events
  // passively, so the old synthetic handler's preventDefault() logged console
  // errors in the webview and occasionally let the page scroll under the graph.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setView((v) => {
        const scale = Math.max(0.1, Math.min(3.5, v.scale * factor));
        const k = scale / v.scale;
        return { scale, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);
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
        <span className="dg-title">{mode === "flow" ? "⚡ Call Flow" : "⬢ Dependencies"}</span>
        <div className="dg-modes">
          <button
            className={"dg-lay" + (mode === "types" ? " active" : "")}
            title="Project type graph — classes / structs / interfaces / enums and how they depend on each other"
            onClick={() => useStore.getState().setGraphMode("types")}
          >Types</button>
          <button
            className={"dg-lay" + (mode === "flow" ? " active" : "")}
            title="Per-script call flow — how the methods of ONE script call each other; external calls end as terminal nodes"
            onClick={() => useStore.getState().setGraphMode("flow")}
          >Call flow</button>
        </div>
        {mode === "flow" ? (
          <span className="dg-flowfile" title={flowFile ?? ""}>
            {flowFile ? flowFile.split("/").pop() : "no script selected"}
          </span>
        ) : (
          <>
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
          </>
        )}
        <input
          className="dg-filter"
          placeholder={mode === "flow" ? "filter methods…" : "filter types…"}
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
            title={mode === "flow" ? "Huge script — showing the most connected methods" : "Scope is huge — showing the most connected types. Pick a folder (⬡ on a folder or the scope dropdown) for the full picture."}
          >
            top {nodeCount} of {graph?.totalTypes ?? nodeCount} {mode === "flow" ? "methods" : "types"}
          </span>
        )}
        <span className="dg-stats">{busy ? "building…" : mode === "flow"
          ? `${nodeCount} nodes · ${graph?.edges.length ?? 0} calls`
          : `${nodeCount} types · ${graph?.edges.length ?? 0} dependencies`}</span>
        <button className="dg-btn dg-close" title="Close the graph (Esc)" onClick={() => { useStore.getState().closeGraph(); useStore.getState().setActive(null); }}>×</button>
      </div>
      <div
        className="dg-canvas"
        ref={hostRef}
        onMouseDown={onBgMouseDown}
        onDoubleClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
      >
        {busy && <div className="dg-empty">building the {mode === "flow" ? "call flow" : "dependency graph"}…</div>}
        {!busy && loadError && (
          <div className="dg-empty">
            <div>graph failed to load — {loadError}</div>
            <div style={{ opacity: 0.7, marginTop: 6 }}>the brain worker may be busy or the file may have changed — press ⟳ to retry</div>
          </div>
        )}
        {!busy && !loadError && !laid?.nodes.length && (
          <div className="dg-empty">
            {mode === "flow"
              ? (graph?.flowReason ?? (flowFile
                  ? "no methods found in this script"
                  : "no script selected — open a .cs file, then switch to Call Flow"))
              : "no types in this scope — pick another folder or open the whole project"}
          </div>
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
              <marker id="arr-self" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#e5a158" />
              </marker>
              <marker id="arr-call" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#4ec9b0" />
              </marker>
              <marker id="arr-extcall" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
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
                    d={pathOfPoints(le.points, effLayout === "business")}
                    markerEnd={`url(#arr-${kind})`}
                    strokeWidth={kind === "uses" || kind === "call" ? 1 + Math.min(1.6, (le.edge.weight - 1) * 0.25) : undefined}
                  />
                );
              })}
              {laid.nodes.map((l) => {
                const n = l.node;
                const dim = isDimmedNode(n.id);
                const sel = selected === n.id;
                const isFlow = n.kind === "method" || n.kind === "extcall";
                const cls = "dg-node" + (n.external ? " ext" : "") + (n.outOfScope ? " out" : "")
                  + (n.isMono ? " mono" : "") + (sel ? " sel" : "") + (dim ? " dim" : "")
                  + (n.kind === "interface" ? " iface" : "") + (n.singleton ? " singl" : "")
                  + (n.kind === "method" ? " method" : "") + (n.kind === "extcall" ? " extcall" : "")
                  + (isFlow && (n as any).entry ? " entry" : "");
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
                    {/* extcall nodes get a capsule body — a genuinely different SHAPE
                        (user: "when method call something outside the script just use
                        different shape and put end to that branch") */}
                    <rect
                      className="dg-box"
                      x={0} y={0} width={NODE_W} height={NODE_H}
                      rx={n.kind === "extcall" ? 21 : effLayout === "business" ? 3 : 8}
                    />
                    <text className="dg-glyph" x={12} y={19}>{KIND_GLYPH[n.kind] ?? "▣"}</text>
                    <text className="dg-name" x={30} y={19}>{clip(n.name, 16)}</text>
                    <text className="dg-sub" x={12} y={34}>
                      {n.kind === "extcall"
                        ? "outside the script — branch ends"
                        : n.kind === "method"
                          ? [(n as any).ret || "", n.ns].filter(Boolean).join(" · ")
                          : n.external
                            ? n.ns || "external"
                            : [n.asm ?? "", n.file.split("/").pop() ?? ""].filter(Boolean).join(" · ")}
                    </text>
                    {(n.inDeg > 0 || n.outDeg > 0) && (
                      <g className="dg-degs">
                        {n.inDeg > 0 && <text x={NODE_W - 30} y={34}>↓{n.inDeg}</text>}
                        {n.outDeg > 0 && <text x={NODE_W - 14} y={34}>↑{n.outDeg}</text>}
                      </g>
                    )}
                    {n.singleton && (
                      <g className="dg-singleton" title="static singleton">
                        <circle cx={NODE_W - 10} cy={0} r={7.5} />
                        <text x={NODE_W - 10} y={3.5}>S</text>
                      </g>
                    )}
                    {isFlow && (n as any).unityMsg && (
                      <g className="dg-unitymsg" title="Unity event function — the engine calls it">
                        <circle cx={10} cy={0} r={7.5} />
                        <text x={10} y={3.5}>U</text>
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
            {(selNode as any).ret && <div className="dgd-asm">returns: {(selNode as any).ret}</div>}
            {(selNode as any).unityMsg && <div className="dgd-asm">Unity event function — the engine calls it by name</div>}
            <div className="dgd-list-title">Called by ({usedBy.length})</div>
            <div className="dgd-list">
              {usedBy.length === 0 && <span className="dgd-none">nothing calls this {(selNode as any).unityMsg || mode === "flow" ? "in this script" : "in this scope"}</span>}
              {usedBy.map((e) => (
                <div key={e.from + e.kind} className={"dgd-item k-" + e.kind} onClick={() => setSelected(e.from)}>
                  <span className="dgd-arrow">{arrowFor(e.kind)}</span>{byId.get(e.from)?.name ?? e.from}
                </div>
              ))}
            </div>
            <div className="dgd-list-title">{mode === "flow" ? "Calls" : "Uses"} ({usesOf.length})</div>
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
          {mode === "flow" ? (
            <>
              <span className="lg">scope: ONE script — methods and their calls</span>
              <span className="lg lg-call">— calls in-script</span>
              <span className="lg lg-extcall">⇢ outside the script (terminal)</span>
              <span className="lg lg-self">↺ recursion</span>
              <span className="lg lg-hint">ƒ method · ⊗ external terminal · U badge = Unity event · entry = nothing calls it in-script</span>
            </>
          ) : (
            <>
              <span className="lg">nodes: classes · structs · interfaces · enums only</span>
              <span className="lg lg-extends">— inheritance</span>
              <span className="lg lg-implements">‑ ‑ interface</span>
              <span className="lg lg-uses">— uses</span>
              <span className="lg lg-self">↺ static singleton</span>
              <span className="lg lg-hint">hover: highlight · click: inspect · double-click: open script · wheel: zoom · drag: pan</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function arrowFor(kind: string): string {
  return kind === "extends" ? "▲" : kind === "implements" ? "◇" : kind === "self" ? "↺" : kind === "call" ? "→" : kind === "extcall" ? "⇢" : "→";
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export { computeLayout as defaultComputeLayout };
export type { LayoutName, LaidNode, LaidEdge };
