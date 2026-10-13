import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { monaco, CSHARP_LANG, defineAllThemes, applyTheme, getSavedThemeId, DEFAULT_THEME } from "./monaco";
import { THEMES, themeById, saveTheme } from "./themes";
import { getAdapter, browserAdapter, initPlatform, isDesktop, baseName, getRecents } from "./adapters";
import { useStore } from "./store";
import { BrainClient, type UpdateFileResult, type SemanticReport, type RenamePlanResult, type ProjectSearchResult } from "./brain-client";
import { DepGraphView } from "./depgraph";
import { parseCsproj } from "@brain/csproj";
import { parseAsmdef, guidFromMeta } from "@brain/asmdef";
import { computeFoldRanges } from "@brain/folding";
import { readCache, writeCache, statFiles, fingerprintChanged, cacheEnabled, CACHE_VERSION } from "./projectCache";
import { UNITY_LIFECYCLE, UNITY_MESSAGE_NAMES } from "@brain/snippets";
import { detectEol, convertEol, eolOfMonaco, splitLines, joinLines, type Eol } from "./eol";
import { dedupeProblems, problemToText } from "./problems";
import { hydrateConfigFromDisk, configFilePath, mcpDiscoveryPath, saveConfigField } from "./configStore";
import { getBridgeState, subscribeBridge, bridgeStats, bridgeSelfTest, forceReconnect, type BridgeState } from "./nl-bridge";
import { startMcpServer, refreshMcpDiscovery } from "./mcp-server";
import { APP_LABEL, APP_BUILD, APP_PHASE } from "./version"; // Phase numbering system (user request)
import fuzzysort from "fuzzysort";
import "./index.css";

/* ------------------------------- boot ------------------------------- */

export async function boot() {
  const store = useStore.getState();
  try {
    initPlatform(); // native shell handshake (Neutralino) — no-op in browser/Tauri
    // v0.7.1: restore theme/autosave/wrap/root from %APPDATA% config BEFORE the
    // first-run theme check runs — an ephemeral WebView2 profile must not make
    // the picker (or re-picking the workspace) fire on every launch
    try { await hydrateConfigFromDisk(); } catch { /* best-effort */ }
    defineAllThemes(monaco);
    applyTheme(monaco, getSavedThemeId() ?? DEFAULT_THEME);
    monaco.ensureLanguage();

    // brain worker: wasm + 5.2MB Unity DB load off the main thread
    const client = new BrainClient();
    (window as any).__client = client;
    client.onStatus = (s) => useStore.getState().setStatus(s);
    // Phase 12 — when a lane crashes (or wedges), it respawns with an EMPTY
    // engine; this hook rebuilds its state from disk so completions keep
    // working without a page reload.
    client.onRespawn = async (lane) => {
      useStore.getState().setStatus(`brain ${lane} lane restarted — resyncing workspace…`);
      await resyncBrainAfterSpawn();
      useStore.getState().setStatus(`brain ${lane} lane resynced · ${useStore.getState().stats.files} files indexed`);
    };
    useStore.getState().setStatus("engine booting (worker)…");
    await client.init();
    if (client.unityInfo.label) {
      useStore.getState().setUnity(true, client.unityInfo.label);
    } else {
      useStore.getState().setUnity(false, "Unity API unavailable");
    }
    useStore.getState().setBrainReady(true);

    monaco.registerProviders(client);
    // v0.5.0 — Ctrl+. quick fixes (auto `using N;`) read the freshest diagnostics
    monaco.registerQuickFixes((path) => allDiagnostics(path) as any);

    // workspace: scan → csproj auto-config → index → open first script
    await loadWorkspace(client);

    // Phase 14 — MCP: let AI agents ask the running editor for problems,
    // project structure, code search and file contents (desktop only)
    startMcpServer();

    // v0.7.0 — one RPC per keystroke: updateFile(deep) parses once and returns
    // syntax + semantic together (the old flow made two worker round-trips and
    // parsed the file twice — the main cause of slow error propagation).
    let timer: any = null;
    (window as any).__onEdit = (path: string, content: string) => {
      if (!path.endsWith(".cs")) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const r = await client.updateFile(path, content, true);
          applyAnalysis(r);
          if (r.sem) applySemantics(path, r.sem);
        } catch { /* worker hiccup — next keystroke retries */ }
      }, 70);
      // v0.7.0 auto-save: write 1.2s after the last keystroke (toggleable)
      scheduleAutoSave(path);
    };
  } catch (e: any) {
    store.setError(String(e?.message ?? e));
    store.setStatus("boot failed");
    store.setLoading(false);
  }
}

/* ------------------------- v0.7.0 auto-save ------------------------- */

const autoSaveTimers = new Map<string, any>();

function scheduleAutoSave(path: string): void {
  const st = useStore.getState();
  if (!st.autoSave) return;
  clearTimeout(autoSaveTimers.get(path));
  autoSaveTimers.set(path, setTimeout(async () => {
    const s = useStore.getState();
    const tab = s.tabs.find((t) => t.path === path);
    if (!tab || tab.content === tab.original) return;
    try {
      await getAdapter().write(path, tab.content);
      s.markSaved(path);
    } catch { /* read-only demo — silent */ }
  }, 1200));
}

/** flush any pending auto-save immediately (workspace switch / tab close) */
async function flushAutoSave(path?: string): Promise<void> {
  const st = useStore.getState();
  const paths = path ? [path] : [...autoSaveTimers.keys()];
  for (const p of paths) {
    clearTimeout(autoSaveTimers.get(p));
    autoSaveTimers.delete(p);
    const tab = st.tabs.find((t) => t.path === p);
    if (!tab || tab.content === tab.original) continue;
    try { await getAdapter().write(p, tab.content); st.markSaved(p); } catch { /* read-only */ }
  }
}

/** Re-run the workspace load after the user picked a different root.
 *  In-place (no location.reload) — safe for the native bridge auth. */
/** Scan + csproj auto-config + index + open first script. Called from boot()
 *  and again after a workspace change (no page reload — the Neutralino
 *  websocket auth does not survive navigations reliably). */
/* ------------------- Phase 12 — lane-respawn engine resync ------------------- */

/** the exact configureProjects payload applied at boot — replayed verbatim
 *  when a brain lane respawns so the fresh engine sees the same world */
let lastProjectConfig: { csprojInfos: any[]; asmdefs: any[]; unity: { version: string; defines: string[] } } | null = null;

/** rebuild a respawned lane's engine state from disk: fresh scan → sync →
 *  project config → loadFiles. Mirrored calls reach BOTH lanes (the healthy
 *  one no-ops over identical state; the respawned one rebuilds), and the
 *  respawned lane's worker buffers them until its engine is ready, so the
 *  ordering configureProjects → syncFiles → loadFiles is preserved. */
async function resyncBrainAfterSpawn() {
  const client = (window as any).__client as BrainClient | undefined;
  if (!client) return;
  const adapter = getAdapter();
  const files = await adapter.listFiles();
  const csFiles = files.filter((f) => f.endsWith(".cs"));
  const loaded: { path: string; content: string }[] = [];
  for (const p of csFiles) {
    try { loaded.push({ path: p, content: await adapter.read(p) }); }
    catch { /* vanished mid-resync — syncFiles below drops it */ }
  }
  if (lastProjectConfig) {
    await client.configureProjects(lastProjectConfig.csprojInfos, lastProjectConfig.asmdefs, lastProjectConfig.unity);
  }
  await client.syncFiles(csFiles);
  if (loaded.length) await client.loadFiles(loaded);
  // auto-save flushed the active tab ≤1.2 s ago, so disk content is fresh;
  // any keystroke after the resync re-uploads the live model via __onEdit
}

async function loadWorkspace(client: BrainClient) {
  const adapter = getAdapter();
  useStore.getState().setStatus(`scanning ${adapter.name}…`);
  let files = await adapter.listFiles((n) => useStore.getState().setStatus(`scanning… ${n} files`));
  // desktop exe with nothing to index (install dir / stale root / canceled pick):
  // offer the project picker EVERY time — a saved-but-empty root must never lock
  // the workspace empty (v0.3.1 fix for "starting dialog does not work")
  if (adapter.name === "neutralino-fs" && files.length === 0 && adapter.pickFolder) {
    useStore.getState().setStatus("no project here — open your Unity project folder…");
    // native dialog may open, fail, or fall back to the typed-path modal; either
    // way boot re-scans right after — the modal itself loads the workspace when
    // it succeeds later (reloadWorkspace, no page reload)
    const picked = await openWorkspaceFlow();
    files = await adapter.listFiles();
    // dialog canceled/failed AND still nothing to index → surface the typed-path
    // modal so an empty workspace always has a way forward (not just on failure)
    if (files.length === 0 && picked !== "picked") {
      useStore.getState().setPathPrompt({
        reason: picked === "canceled" ? "no project was selected" : "native folder dialog unavailable",
      });
      useStore.getState().setStatus("pick a folder or type your Unity project path…");
    }
  }
  useStore.getState().setFiles(files);

  /* ---------- v0.5.0 — fingerprints + csproj config + assembly hunting ---------- */
  const csFiles = files.filter((f) => f.endsWith(".cs"));
  const csprojFiles = files.filter((f) => f.endsWith(".csproj"));
  const asmdefFiles = files.filter((f) => f.endsWith(".asmdef"));
  const asmdefMetaFiles = files.filter((f) => f.endsWith(".asmdef.meta"));

  // startup cache: size+mtime fingerprints tell us what changed on disk since
  // the last run — unchanged files are indexed from cached symbols (no read,
  // no tree-sitter), which is what makes warm starts fast.
  const cache = await readCache(adapter.root);
  const configTargets = [...csprojFiles, ...asmdefFiles, ...asmdefMetaFiles];
  const fps = cacheEnabled() && (csFiles.length + configTargets.length) > 0
    ? await statFiles(adapter.root, [...csFiles, ...configTargets])
    : {} as Record<string, { size: number; mtime: number }>;
  const fileChanged = (rel: string | undefined) =>
    !rel || !cache || !cache.fileHashes?.[rel] || !fps[rel] || fingerprintChanged(cache.fileHashes[rel], fps[rel]);

  // csproj auto-detection & auto-configuration (cached when unchanged on disk)
  const csprojInfos: ReturnType<typeof parseCsproj>[] = [];
  for (const p of csprojFiles) {
    const cachedInfo = (cache?.csprojs as any[] | undefined)?.find((c) => c?.path === p);
    if (!fileChanged(p) && cachedInfo) { csprojInfos.push(cachedInfo); continue; }
    try { csprojInfos.push(parseCsproj(await adapter.read(p), p)); } catch { /* unreadable csproj — skip */ }
  }

  // assembly hunting: parse every .asmdef and pair it with the GUID living in
  // its .asmdef.meta sidecar — that GUID is how other asmdefs reference it
  const metaByAsmdef = new Map(asmdefMetaFiles.map((m) => [m.slice(0, -".meta".length), m] as const));
  const asmdefs: NonNullable<ReturnType<typeof parseAsmdef>>[] = [];
  for (const p of asmdefFiles) {
    const cachedDef = (cache?.asmdefs as any[] | undefined)?.find((a) => a?.path === p);
    const metaRel = metaByAsmdef.get(p);
    if (cachedDef && !fileChanged(p) && !fileChanged(metaRel)) { asmdefs.push(cachedDef); continue; }
    try {
      const info = parseAsmdef(await adapter.read(p), p);
      if (info) {
        if (metaRel) {
          try { info.guid = guidFromMeta(await adapter.read(metaRel)) ?? info.guid; } catch { /* meta unreadable */ }
        }
        asmdefs.push(info);
      }
    } catch { /* malformed asmdef — skip */ }
  }

  {
    // Phase 11 — read the Unity project identity so #if sees the right world:
    //   ProjectSettings/ProjectVersion.txt → UNITY_<major>_<minor>_OR_NEWER chain
    //   ProjectSettings.asset              → scriptingDefineSymbols custom defines
    let unityVersion = "";
    const projectDefines: string[] = [];
    const settingsDir = files.find((f) => /^projectsettings\//i.test(f));
    if (settingsDir) {
      try {
        const pv = await adapter.read("ProjectSettings/ProjectVersion.txt");
        const m = /m_EditorVersion(?:WithRevision)?:\s*(.+)/.exec(pv);
        if (m) unityVersion = m[1].trim();
      } catch { /* no ProjectVersion.txt — default 2022.3 chain */ }
      try {
        const ps = await adapter.read("ProjectSettings/ProjectSettings.asset");
        const m = /scriptingDefineSymbols:\s*\{[^}]*?1:\s*([^\n}]+)/.exec(ps);
        if (m) for (const d of m[1].split(";")) { const t = d.trim(); if (t) projectDefines.push(t); }
      } catch { /* no ProjectSettings.asset — csproj defines only */ }
    }
    const res = await client.configureProjects(csprojInfos, asmdefs, { version: unityVersion, defines: projectDefines });
    // Phase 12 — remembered so a lane-respawn resync can re-apply the exact
    // same project config without re-parsing csproj/asmdef files
    lastProjectConfig = { csprojInfos, asmdefs, unity: { version: unityVersion, defines: projectDefines } };
    useStore.getState().setProjects(res.projects, res.defines ?? []);
    if (res.asmdef) {
      useStore.getState().setAsmdefInfo(
        res.asmdef.asmdefs ? `⬡ ${res.asmdef.asmdefs} asmdef · ${res.asmdef.assemblies} assemblies` : ""
      );
    }
    const parts: string[] = [];
    if (csprojInfos.length) {
      parts.push(`${csprojInfos.length} project${csprojInfos.length > 1 ? "s" : ""} auto-configured (${csprojInfos.map((i) => i.name).join(", ")})`);
    }
    if (asmdefs.length) {
      parts.push(`${asmdefs.length} asmdef${asmdefs.length > 1 ? "s" : ""} hunted${res.asmdef?.unresolved ? ` · ${res.asmdef.unresolved} unresolved GUID ref${res.asmdef.unresolved > 1 ? "s" : ""}` : ""}`);
    }
    if (unityVersion) parts.push(`Unity ${unityVersion.split(".").slice(0, 2).join(".")} defines`);
    if (projectDefines.length) parts.push(`+${projectDefines.length} custom define${projectDefines.length > 1 ? "s" : ""}`);
    useStore.getState().setStatus(parts.join(" · "));
  }

  /* ---------------- index scripts (cache-aware, v0.5.0) ---------------- */
  const cachedEntries: { path: string; symbols: any }[] = [];
  const toRead: string[] = [];
  for (const p of csFiles) {
    const sym = cache?.symbols?.[p];
    if (cache && sym && !fileChanged(p)) cachedEntries.push({ path: p, symbols: sym });
    else toRead.push(p);
  }
  if (cachedEntries.length) {
    const cachedRes = await client.indexFromCache(cachedEntries);
    useStore.getState().setStats({
      files: cachedRes.stats.files,
      types: cachedRes.stats.types,
      members: cachedRes.stats.members,
      parseMs: 0,
    });
  }

  const loaded: { path: string; content: string }[] = [];
  let skipped = 0;
  for (let i = 0; i < toRead.length; i++) {
    try {
      loaded.push({ path: toRead[i], content: await adapter.read(toRead[i]) });
    } catch { skipped++; continue; } // unreadable / oversized — skip
    if (i % 40 === 0) useStore.getState().setStatus(`indexing ${i + 1}/${toRead.length} scripts…`);
  }
  if (loaded.length) {
    const res = await client.loadFiles(loaded);
    useStore.getState().setStats({
      files: res.stats.files,
      types: res.stats.types,
      members: res.stats.members,
      parseMs: res.stats.lastParseMs ?? 0,
    });
  }
  for (const f of loaded) treeReady.add(f.path);
  useStore.getState().setStatus(
    `${cachedEntries.length} scripts from cache · ${loaded.length} reindexed${skipped ? ` · ${skipped} skipped` : ""}`
  );
  useStore.getState().setLoading(false);

  // v0.7.0 — first-run theme picker: nothing configured yet + a project is
  // actually open → let the user choose once (later changes live in settings)
  if (files.length > 0 && !getSavedThemeId()) {
    useStore.getState().setThemePicker({ firstRun: true });
  }

  // persist the refreshed cache (non-blocking) — next start is a warm one
  void (async () => {
    try {
      const syms = await client.filesSymbols();
      const symbols: Record<string, unknown> = {};
      for (const s of syms) symbols[s.path] = s.symbols;
      await writeCache(adapter.root, {
        version: CACHE_VERSION, root: adapter.root, generatedAt: Date.now(),
        scan: files, fileHashes: fps, csprojs: csprojInfos as any, asmdefs: asmdefs as any, symbols,
      });
    } catch { /* cache write is best-effort */ }
  })();

  // project-wide diagnostics sweep fills the Problems bar in the background
  void sweepProject();

  // open first script (cache-indexed files read their content lazily here)
  const first = loaded.find((f) => f.path.includes("Player")) ?? loaded[0] ?? cachedEntries[0];
  if (first) await openFileByPath(first.path);
}

/** Re-run the workspace load after the user picked a different root.
 *  In-place (no location.reload) — safe for the native bridge auth. */
async function reloadWorkspace() {
  const client = (window as any).__client as BrainClient | undefined;
  if (!client) return;
  const st = useStore.getState();
  st.tabs.forEach((t) => st.closeTab(t.path));
  st.setProjects([], []);
  st.setActiveAssembly(null);
  st.setAsmInfo([], true);
  st.setAsmdefInfo("");
  st.setProblems([]);
  st.setOutline([]);
  st.setErrors(0);
  treeReady.clear();
  sweepSeq++; // stop any in-flight sweep from the previous workspace
  clearWorkspaceAnalysis();
  monaco.editor.getModels().forEach((m: any) => m.dispose());
  try {
    await loadWorkspace(client);
    // Phase 14 — the workspace root changed; re-publish MCP discovery
    void refreshMcpDiscovery();
  } catch (e: any) {
    st.setStatus("workspace reload failed: " + String(e?.message ?? e));
  }
}

/* ---------------------- analysis → markers & decorations ---------------------- */

/** last syntax-diagnostics per path (merged with the semantic pass for markers) */
const syntaxByPath = new Map<string, UpdateFileResult["diagnostics"]>();
/** semantic reports per path (decorations: grey unreachable, strike obsolete) */
const semanticByPath = new Map<string, SemanticReport>();
/** live decoration ids per path */
const decorationsByPath = new Map<string, string[]>();

function applyAnalysis(r: UpdateFileResult) {
  const st = useStore.getState();
  st.setStats({
    files: r.stats.files,
    types: r.stats.types,
    members: r.stats.members,
    parseMs: r.parseMs,
  });
  const path = keyOf(r.symbols?.path ?? "");
  syntaxByPath.set(path, r.diagnostics);
  if (r.asm) st.setAsmInfo(r.asm.refs ?? [], r.asm.engine !== false);
  st.setOutline(outlineFromSymbols(r.symbols));
  recomputeProblems();
  refreshActiveMarkers();
}

function applySemantics(path: string, report: SemanticReport) {
  semanticByPath.set(keyOf(path), report);
  recomputeProblems();
  refreshActiveMarkers();
}

const keyOf = (p: string) => p.replace(/^\.\//, "");

function allDiagnostics(path: string) {
  const syntax = syntaxByPath.get(keyOf(path)) ?? [];
  const sem = semanticByPath.get(keyOf(path))?.diagnostics ?? [];
  return [...syntax, ...sem];
}

/* --------------------- project-wide problems (v0.5.0) --------------------- */

/** recompute the project-wide Problems list from every analyzed file.
 *  Errors come first, warnings after — per the Problems-bar contract.
 *  v0.7.0 — identical rows (same path/pos/message/severity) collapse to ONE
 *  entry instead of stacking up from overlapping syntax+semantic passes. */
function recomputeProblems() {
  const st = useStore.getState();
  const items: import("./store").ProblemItem[] = [];
  const paths = new Set<string>([...syntaxByPath.keys(), ...semanticByPath.keys()]);
  for (const p of paths) {
    for (const d of syntaxByPath.get(p) ?? []) {
      items.push({ path: p, line: d.line, col: d.col, length: d.length, message: d.message, severity: d.severity as any, source: d.source, fix: d.fix as any, code: (d as any).code });
    }
    for (const d of semanticByPath.get(p)?.diagnostics ?? []) {
      items.push({ path: p, line: d.line, col: d.col, length: d.length, message: d.message, severity: d.severity as any, source: d.source, fix: d.fix as any, code: (d as any).code });
    }
  }
  st.setProblems(dedupeProblems(items));
  st.setErrors(useStore.getState().problems.filter((x) => x.severity === "error").length);
}

/** push fresh markers/decorations into the ACTIVE editor model only */
function refreshActiveMarkers() {
  const st = useStore.getState();
  const ed = (window as any).__editor;
  if (!ed || !st.active) return;
  try {
    monaco.editor.setModelMarkers(ed.getModel(), "velvetsharp", allDiagnostics(st.active).map(toMarker));
    applySemanticDecorations(ed);
  } catch { /* model disposed mid-sweep */ }
}

/** files known to hold a parsed tree (cache-indexed files parse lazily on first
 *  open/edit — the background sweep parses them for project-wide diagnostics) */
const treeReady = new Set<string>();
let sweepSeq = 0;

/** background project sweep: syntax + deep semantic pass over EVERY script,
 *  chunked so the UI + completions stay responsive (v0.5.0 Problems bar). */
async function sweepProject() {
  const client = (window as any).__client as BrainClient | undefined;
  if (!client) return;
  const seq = ++sweepSeq;
  const adapter = getAdapter();
  const files = useStore.getState().files.filter((f) => f.endsWith(".cs") && !treeReady.has(f));
  const CHUNK = 10;
  let done = 0;
  for (let i = 0; i < files.length; i += CHUNK) {
    if (seq !== sweepSeq) return; // workspace switched mid-sweep
    const chunk = files.slice(i, i + CHUNK);
    // v0.7.0 — read the whole chunk CONCURRENTLY (was: one WebSocket round-trip
    // per file, the slowest part of the sweep on real projects)
    const reads = await Promise.allSettled(chunk.map((p) => adapter.read(p)));
    const contents: { p: string; content: string }[] = [];
    reads.forEach((r, j) => {
      const p = chunk[j];
      if (r.status === "fulfilled") {
        contents.push({ p, content: r.value });
      } else {
        treeReady.add(p); // unreadable — never retry-loop
      }
    });
    for (const { p, content } of contents) {
      try {
        await client.updateFile(p, content);
        treeReady.add(p);
      } catch { treeReady.add(p); /* engine hiccup — never retry-loop */ }
    }
    if (contents.length) {
      try {
        const res = await client.sweepChunk(contents.map((c) => c.p));
        for (const r of res?.results ?? []) {
          syntaxByPath.set(keyOf(r.path), r.syntax);
          semanticByPath.set(keyOf(r.path), r.sem as any);
        }
      } catch { /* chunk failed — keep sweeping */ }
    }
    done += chunk.length;
    recomputeProblems();
    refreshActiveMarkers();
    if (done % 40 === 0) useStore.getState().setStatus(`project sweep… ${done}/${files.length}`);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (seq === sweepSeq && files.length) {
    useStore.getState().setStatus(`project sweep complete · ${files.length} scripts`);
  }
}

function toMarker(d: { line: number; col: number; length: number; message: string; severity: string; source: string }) {
  return {
    startLineNumber: d.line + 1,
    endLineNumber: d.line + 1,
    startColumn: d.col + 1,
    endColumn: d.col + 1 + Math.max(1, d.length),
    message: d.message,
    severity: d.severity === "error" ? monaco.MarkerSeverity.Error : d.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
    source: d.source,
  };
}

/** grey-out unreachable code + strikethrough obsolete API (freshest report wins) */
function applySemanticDecorations(ed: any) {
  const model = ed.getModel?.();
  if (!model) return;
  const modelPath = keyOf(decodeURIComponent(model.uri.path).replace(/^\//, ""));
  const report = semanticByPath.get(modelPath);
  const olds = decorationsByPath.get(modelPath) ?? [];
  const next: any[] = [];
  if (report) {
    for (const u of report.unreachable) {
      next.push({
        range: new monaco.Range(u.line + 1, u.col + 1, u.endLine + 1, u.endCol + 1),
        options: {
          inlineClassName: "vs-unreachable",
          hoverMessage: { value: "Unreachable code detected" },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    for (const o of report.obsolete) {
      next.push({
        range: new monaco.Range(o.line + 1, o.col + 1, o.endLine + 1, o.endCol + 1),
        options: {
          inlineClassName: "vs-obsolete",
          hoverMessage: { value: "Obsolete API" },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    // Phase 11 — dim preprocessor-inactive branches (VS grays false #if code;
    // the brain already suppresses diagnostics inside them)
    for (const r of report.inactive ?? []) {
      next.push({
        range: new monaco.Range(r.line + 1, 1, r.endLine + 1, 1),
        options: {
          isWholeLine: true,
          className: "vs-inactive-line",
          hoverMessage: { value: "Inactive — preprocessor condition is false for this context" },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
  }
  try {
    decorationsByPath.set(modelPath, ed.deltaDecorations(olds, next));
  } catch { /* editor disposed mid-update */ }
}

function clearWorkspaceAnalysis() {
  syntaxByPath.clear();
  semanticByPath.clear();
  decorationsByPath.clear();
}

function outlineFromSymbols(symbols: UpdateFileResult["symbols"]) {
  const out: any[] = [];
  const types = symbols.types ?? [];
  const members = symbols.members ?? [];
  for (const t of types) {
    out.push({ name: t.name, kind: t.kind, line: t.line, col: t.col, depth: 0, detail: t.base ? `: ${String(t.base).replace(/^\s*:\s*/, "")}` : undefined });
  }
  for (const m of members) {
    if (m.kind === "enumMember") continue;
    out.push({
      name: m.name, kind: m.kind, line: m.line, col: m.col, depth: 1,
      detail: m.kind === "method" ? `(${(m.params ?? []).map((p: any) => p.type).join(", ")})` : (m.returnType ?? ""),
      isMessage: m.kind === "method" && UNITY_MESSAGE_NAMES.has(m.name),
    });
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return out;
}

/* ------------------------------- app ------------------------------- */

function App() {
  const palette = useStore((s) => s.palette);
  const isDesktopShell = typeof window !== "undefined" && "NL_PORT" in window;

  // v0.7.1 — mirror the native bridge state into the store for the status chip
  useEffect(() => {
    if (!isDesktopShell) return;
    const unsub = subscribeBridge((s: BridgeState) => useStore.getState().setBridge(s));
    return unsub;
  }, [isDesktopShell]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F2 — rename the symbol under the caret (editor focused or not)
      if (e.key === "F2") { e.preventDefault(); void startRename(); return; }
      // Shift+F12 — find all uses of the symbol under the caret (Phase 8)
      if (e.key === "F12" && e.shiftKey) { e.preventDefault(); (window as any).__requestUses?.(); return; }
      // Esc — leave the dependency graph
      if (e.key === "Escape" && useStore.getState().active === "__graph__") {
        e.preventDefault(); closeGraphAction(); return;
      }
      // Esc — close the usages panel (Phase 8)
      if (e.key === "Escape" && useStore.getState().uses) {
        useStore.getState().closeUses(); return;
      }
      // Alt+Z — word wrap toggle (v0.7.0)
      if (e.altKey && (e.key === "z" || e.key === "Z") && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); useStore.getState().toggleWordWrap(); return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "p" && !e.shiftKey) { e.preventDefault(); useStore.getState().setPalette("files"); }
      else if (k === "p" && e.shiftKey) { e.preventDefault(); useStore.getState().setPalette("commands"); }
      else if (k === "t") { e.preventDefault(); useStore.getState().setPalette("symbols"); }
      else if (k === "f" && e.shiftKey) { e.preventDefault(); useStore.getState().setSidebarView("search"); }
      else if (k === "s") { e.preventDefault(); void (async () => { await saveActive(); })(); }
      else if (k === "w") { e.preventDefault(); const st = useStore.getState(); if (st.active === "__graph__") closeGraphAction(); else if (st.active) st.closeTab(st.active); }
      // Ctrl+= / Ctrl+- / Ctrl+0 — editor zoom (v0.7.0)
      else if (k === "=" || k === "+") { e.preventDefault(); const st = useStore.getState(); st.setFontSize(st.fontSize + 1); }
      else if (k === "-") { e.preventDefault(); const st = useStore.getState(); st.setFontSize(st.fontSize - 1); }
      else if (k === "0") { e.preventDefault(); useStore.getState().setFontSize(13.5); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Phase 10 — capture-phase keys that must run BEFORE the editor sees them
  useEffect(() => {
    const onCapKey = (e: KeyboardEvent) => {
      // plain F12 — snapshot the pre-jump position for Go Back, then let
      // Monaco reveal the definition (do NOT preventDefault here)
      if (e.key === "F12" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        navPush(currentMark());
        return;
      }
      // Alt+Left / Alt+Right — navigation history (Go Back / Go Forward)
      if (e.altKey && e.key === "ArrowLeft" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); navGo(-1); return;
      }
      if (e.altKey && e.key === "ArrowRight" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); navGo(1); return;
      }
    };
    window.addEventListener("keydown", onCapKey, true);
    return () => window.removeEventListener("keydown", onCapKey, true);
  }, []);

  return (
    <div className="app">
      <div className="titlebar">
        <span className="logo">◆ VelvetSharp</span>
        <span className="subtitle">{APP_LABEL} · lightweight Unity C# IDE</span>
        <span className="titlebar-right">
          {browserAdapter.name === "browser-demo" ? "demo workspace" : "local workspace"}
          {/* v0.7.1 — dedicated settings entry point (user request: top settings button) */}
          <button
            className="settings-btn"
            title="Settings (theme, editor, connection diagnostics)"
            onClick={() => useStore.getState().setSettingsOpen(true)}
          >⚙</button>
        </span>
      </div>
      <div className="main">
        <MemoSidebar />
        <MemoEditorArea />
      </div>
      <MemoStatusBar />
      {palette && <Palette key={palette} />}
      <PathPromptModal />
      <ThemePicker />
      <RenameWidget />
      <ExplorerCtxMenu />
      <EditorCtxMenu />
      <ErrorPopup />
      <SettingsModal />
    </div>
  );
}

const MemoSidebar = React.memo(Sidebar);
const MemoEditorArea = React.memo(EditorArea);
const MemoStatusBar = React.memo(StatusBar);

async function saveActive() {
  const st = useStore.getState();
  const tab = st.tabs.find((t) => t.path === st.active);
  if (!tab) return;
  const adapter = getAdapter();
  await adapter.write(tab.path, tab.content);
  st.markSaved(tab.path);
  st.setStatus("saved " + tab.path);
}

/* --------------------- F2 rename symbol (v0.6.0) --------------------- */

/** open the inline rename widget for the symbol under the caret */
async function startRename() {
  const st = useStore.getState();
  const tab = st.tabs.find((t) => t.path === st.active);
  const ed = (window as any).__editor;
  const client = (window as any).__client as BrainClient | undefined;
  if (!tab || !ed || !client) {
    st.setStatus("rename: open a script and place the caret on a symbol first");
    return;
  }
  const pos = ed.getPosition();
  if (!pos) return;
  const line = pos.lineNumber - 1;
  const col = pos.column - 1;
  try {
    await client.updateFile(tab.path, tab.content); // the worker must see the freshest text
    const prep = await client.renamePrepare(tab.path, line, col);
    if (!prep.ok || !prep.target) {
      st.setStatus("rename: " + (prep.reason ?? "symbol cannot be renamed"));
      return;
    }
    st.setRenameWidget({ path: tab.path, line, col, oldName: prep.target.name, kind: prep.target.kind });
    st.setStatus(`rename ${prep.target.kind}: ${prep.target.name}`);
  } catch (e: any) {
    st.setStatus("rename failed: " + String(e?.message ?? e));
  }
}

/** apply a rename plan: open models get undo-able edits, closed files are
 *  rewritten on disk, Unity class moves also move the .cs + .meta pair */
async function applyRenamePlan(plan: RenamePlanResult) {
  const st = useStore.getState();
  const adapter = getAdapter();
  const client = (window as any).__client as BrainClient | undefined;
  const newName = plan.newName ?? "";
  if (!client) return;

  const modelByPath = new Map<string, any>(
    monaco.editor.getModels().map((m: any) => [keyOf(decodeURIComponent(m.uri.path).replace(/^\//, "")), m] as const)
  );

  let files = 0;
  let edits = 0;
  for (const fe of plan.edits) {
    const model = modelByPath.get(fe.path);
    if (model) {
      model.pushEditOperations([], fe.ranges.map((r) => ({
        range: new monaco.Range(r.line + 1, r.col + 1, r.line + 1, r.col + 1 + r.length),
        text: newName,
      })), () => null);
      const content = model.getValue();
      try { await adapter.write(fe.path, content); st.markSaved(fe.path); } catch { /* read-only demo */ }
      void client.updateFile(fe.path, content).then((r) => { syntaxByPath.set(keyOf(fe.path), r.diagnostics); }).catch(() => {});
      void client.semantic(fe.path, content).then((sem) => { semanticByPath.set(keyOf(fe.path), sem as any); }).catch(() => {});
      files++; edits += fe.ranges.length;
    } else {
      try {
        const content = await adapter.read(fe.path);
        // v0.7.0 — split/join with the file's REAL line ending (CRLF files keep CRLF)
        const { eol, lines } = splitLines(content);
        for (const r of fe.ranges) {
          const l = lines[r.line] ?? "";
          lines[r.line] = l.slice(0, r.col) + newName + l.slice(r.col + r.length);
        }
        const next = joinLines(eol, lines);
        await adapter.write(fe.path, next);
        await client.updateFile(fe.path, next);
        files++; edits += fe.ranges.length;
      } catch { /* unreadable file — skip */ }
    }
  }

  // Unity class move: .cs + .meta (GUID survives, so scene/prefab links hold)
  let moved = "";
  if (plan.fileRename && adapter.move) {
    const fr = plan.fileRename;
    try {
      const oldModel = modelByPath.get(fr.from);
      if (oldModel) await adapter.write(fr.from, oldModel.getValue());
      await adapter.move(fr.from, fr.to);
      if (fr.metaFrom) {
        try { await adapter.move(fr.metaFrom, fr.metaTo ?? fr.metaFrom); } catch { /* meta may not exist */ }
      }
      st.setFiles(useStore.getState().files.map((f) => (f === fr.from ? fr.to : f === fr.metaFrom ? (fr.metaTo ?? f) : f)));
      if (useStore.getState().tabs.some((t) => t.path === fr.from)) st.closeTab(fr.from);
      await client.removeFile(fr.from);
      moved = ` · file renamed to ${fr.to.split("/").pop()}`;
      await openFileByPath(fr.to);
      useStore.getState().markSaved(fr.to);
    } catch (e: any) {
      st.setStatus("rename applied, but the file move failed: " + String(e?.message ?? e));
    }
  } else if (plan.fileRename && !adapter.move) {
    st.setStatus("rename applied — file rename skipped (read-only demo workspace)");
  }

  recomputeProblems();
  refreshActiveMarkers();
  if (useStore.getState().graphOpen) useStore.getState().refreshGraph();

  const warnText = plan.warnings.length ? "  ⚠ " + plan.warnings[0] : "";
  st.setStatus(`renamed '${plan.target?.name}' → '${newName}' · ${files} file${files === 1 ? "" : "s"} · ${edits} edit${edits === 1 ? "" : "s"}${moved}${warnText}`);
  for (const w of plan.warnings.slice(1)) console.warn("[rename]", w);
}

function RenameWidget() {
  const rw = useStore((s) => s.renameWidget);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!rw) return;
    setName(rw.oldName);
    setErr("");
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 30);
  }, [rw?.path, rw?.line, rw?.col]);

  if (!rw) return null;
  const ed = (window as any).__editor;
  let style: React.CSSProperties = { left: 120, top: 120 };
  if (ed) {
    try {
      const pos = ed.getScrolledVisiblePosition({ lineNumber: rw.line + 1, column: rw.col + 1 });
      const host = ed.getDomNode();
      if (pos && host) {
        style = { left: Math.max(8, host.offsetLeft + pos.left), top: Math.max(8, host.offsetTop + pos.top + 22) };
      }
    } catch { /* default position */ }
  }

  const submit = async () => {
    if (busy) return;
    const client = (window as any).__client as BrainClient | undefined;
    if (!client) return;
    setBusy(true);
    setErr("");
    try {
      // parse any cache-only scripts first so references in them are not missed
      const missing: string[] = await client.missingTrees();
      if (missing.length) {
        const adapter = getAdapter();
        const payload: { path: string; content: string }[] = [];
        for (const p of missing) {
          try { payload.push({ path: p, content: await adapter.read(p) }); } catch { /* skip */ }
        }
        if (payload.length) await client.loadFiles(payload);
      }
      const plan = await client.rename(rw.path, rw.line, rw.col, name.trim());
      if (!plan.ok) {
        setErr(plan.reason ?? "cannot rename");
        setBusy(false);
        return;
      }
      useStore.getState().setRenameWidget(null);
      await applyRenamePlan(plan);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setBusy(false);
    }
  };

  return (
    <div className="rename-layer" onMouseDown={() => useStore.getState().setRenameWidget(null)}>
      <div className="rename-widget" style={style} onMouseDown={(e) => e.stopPropagation()} ref={anchorRef}>
        <div className="rw-title">Rename {rw.kind} <code>{rw.oldName}</code> <span className="rw-hint">across the project</span></div>
        <input
          ref={inputRef}
          className="rw-input"
          value={name}
          spellCheck={false}
          onChange={(e) => { setName(e.target.value); setErr(""); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void submit(); }
            if (e.key === "Escape") { e.preventDefault(); useStore.getState().setRenameWidget(null); }
          }}
        />
        {err && <div className="rw-err">{err}</div>}
        <div className="rw-actions">
          <span className="rw-tip">Enter to rename · Esc to cancel</span>
          <button className="btn" onClick={() => useStore.getState().setRenameWidget(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void submit()}>{busy ? "Renaming…" : "Rename"}</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------- explorer file ops (v0.7.0) --------------------- */

/** re-scan the workspace and sync the brain index with reality:
 *  new .cs files are read+indexed, vanished files dropped (with their problems) */
async function rescanWorkspaceFiles(client?: BrainClient): Promise<string[]> {
  const adapter = getAdapter();
  const files = await adapter.listFiles();
  const old = useStore.getState().files;
  useStore.getState().setFiles(files);
  if (client) {
    const newCs = files.filter((f) => f.endsWith(".cs") && !old.includes(f));
    if (newCs.length) {
      const loaded: { path: string; content: string }[] = [];
      for (const p of newCs) {
        try { loaded.push({ path: p, content: await adapter.read(p) }); } catch { /* unreadable — skip */ }
      }
      if (loaded.length) {
        await client.loadFiles(loaded);
        for (const f of loaded) treeReady.delete(f.path); // sweep will parse+diagnose them
      }
    }
    try {
      const { removed } = await client.syncFiles(files);
      for (const p of removed) {
        syntaxByPath.delete(keyOf(p));
        semanticByPath.delete(keyOf(p));
        decorationsByPath.delete(keyOf(p));
      }
      if (removed.length) { recomputeProblems(); refreshActiveMarkers(); }
    } catch { /* index sync is best-effort */ }
  }
  return files;
}

/** starter template for a brand-new .cs file (class name == file name) */
function starterCsContent(className: string): string {
  return `using UnityEngine;

public class ${className} : MonoBehaviour
{
    void Start()
    {

    }

    void Update()
    {

    }
}
`;
}

async function createEntry(dir: string | null, name: string, kind: "file" | "folder"): Promise<boolean> {
  const adapter = getAdapter();
  const base = dir ? dir + "/" : "";
  const rel = base + name;
  const st = useStore.getState();
  if (st.files.includes(rel)) { st.setStatus(`"${rel}" already exists`); return false; }
  try {
    if (kind === "folder") {
      await adapter.mkdir!(rel);
      st.setStatus("folder created: " + rel);
    } else {
      const content = name.toLowerCase().endsWith(".cs") ? starterCsContent(name.replace(/\.cs$/i, "")) : "";
      await adapter.write(rel, content);
      const client = (window as any).__client as BrainClient | undefined;
      if (name.toLowerCase().endsWith(".cs") && client) {
        await client.updateFile(rel, content);
        treeReady.add(rel);
      }
      st.setStatus("file created: " + rel);
    }
    await rescanWorkspaceFiles();
    if (kind === "file") await openFileByPath(rel);
    return true;
  } catch (e: any) {
    st.setStatus("create failed: " + String(e?.message ?? e));
    return false;
  }
}

async function deleteEntry(path: string, isDir: boolean): Promise<void> {
  const adapter = getAdapter();
  const st = useStore.getState();
  try {
    await adapter.remove!(path, isDir);
    // Unity .meta sidecar goes with the asset (Unity regenerates fresh GUIDs)
    const meta = path + ".meta";
    if (st.files.includes(meta)) {
      try { await adapter.remove!(meta, false); } catch { /* best effort */ }
    }
    for (const t of st.tabs.filter((t) => (isDir ? t.path.startsWith(path + "/") : t.path === path))) {
      st.closeTab(t.path);
    }
    const client = (window as any).__client as BrainClient | undefined;
    await rescanWorkspaceFiles(client);
    st.setStatus((isDir ? "folder" : "file") + " deleted: " + path);
  } catch (e: any) {
    st.setStatus("delete failed: " + String(e?.message ?? e));
  }
}

async function renameEntry(path: string, isDir: boolean, newName: string): Promise<void> {
  const adapter = getAdapter();
  const st = useStore.getState();
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const newRel = (parent ? parent + "/" : "") + newName;
  if (newRel === path) return;
  if (st.files.includes(newRel)) { st.setStatus(`"${newRel}" already exists`); return; }
  try {
    await flushAutoSave(path);
    await adapter.rename!(path, newRel);
    // Unity .meta sidecar follows the rename — the GUID survives, so scene and
    // prefab references keep working (same rule as the F2 class rename)
    const meta = path + ".meta";
    if (st.files.includes(meta)) {
      try { await adapter.rename!(meta, newRel + ".meta"); } catch { /* sidecar best effort */ }
    }
    const wasActive = st.active === path;
    const openTabs = st.tabs.filter((t) => (isDir ? t.path.startsWith(path + "/") : t.path === path));
    for (const t of openTabs) {
      const nextPath = isDir ? newRel + t.path.slice(path.length) : newRel;
      st.closeTab(t.path);
      try { st.openFile(nextPath, await adapter.read(nextPath)); } catch { /* reopen best effort */ }
    }
    const client = (window as any).__client as BrainClient | undefined;
    await rescanWorkspaceFiles(client);
    if (wasActive && !isDir) useStore.getState().setActive(newRel);
    st.setStatus(`renamed to ${newRel}`);
  } catch (e: any) {
    st.setStatus("rename failed: " + String(e?.message ?? e));
  }
}

/* --------------------- explorer context menu (v0.6.0 + v0.7.0 file ops) --------------------- */

type CtxMode = "main" | "newFile" | "newFolder" | "rename" | "confirmDelete";

function ExplorerCtxMenu() {
  const ctx = useStore((s) => s.ctxMenu);
  const [mode, setMode] = useState<CtxMode>("main");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setMode("main"); setName(""); }, [ctx?.path, ctx?.x, ctx?.y]);
  useEffect(() => { if (mode !== "main") inputRef.current?.focus(); }, [mode]);
  useEffect(() => {
    if (!ctx) return;
    const close = () => useStore.getState().setCtxMenu(null);
    const t = setTimeout(() => {
      window.addEventListener("click", close, { once: true });
      window.addEventListener("contextmenu", close, { once: true });
    }, 0);
    return () => { clearTimeout(t); window.removeEventListener("click", close); window.removeEventListener("contextmenu", close); };
  }, [ctx?.path, ctx?.x, ctx?.y]);
  if (!ctx) return null;
  const scope = ctx.dir ? ctx.path : ctx.path.includes("/") ? ctx.path.slice(0, ctx.path.lastIndexOf("/")) : null;
  const parentDir = ctx.dir ? ctx.path : scope;
  const currentName = ctx.path.split("/").pop() ?? "";

  const close = () => useStore.getState().setCtxMenu(null);
  const openGraph = () => {
    close();
    useStore.getState().openGraph(scope);
  };
  const act = (fn: () => Promise<void>) => { setBusy(true); void fn().then(() => { setBusy(false); close(); }); };

  const style: React.CSSProperties = {
    left: Math.min(ctx.x, window.innerWidth - 300),
    top: Math.min(ctx.y, window.innerHeight - 260),
  };
  const canFs = !!getAdapter().mkdir; // desktop adapter exposes file ops

  return (
    <div className="ctx-layer" onMouseDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }}>
      <div className="ctx-menu" style={style} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        {mode === "main" && (
          <>
            {!ctx.dir && (
              <div className="ctx-item" onClick={() => { close(); void openFileByPath(ctx.path); }}>
                <span className="ctx-glyph">↗</span> Open
              </div>
            )}
            {canFs && (
              <>
                {ctx.dir && (
                  <>
                    <div className="ctx-item" onClick={() => { setMode("newFile"); setName(""); }}>
                      <span className="ctx-glyph">＋</span> New File…
                    </div>
                    <div className="ctx-item" onClick={() => { setMode("newFolder"); setName(""); }}>
                      <span className="ctx-glyph">⛯</span> New Folder…
                    </div>
                  </>
                )}
                <div className="ctx-item" onClick={() => { setMode("rename"); setName(currentName); }}>
                  <span className="ctx-glyph">✎</span> Rename…
                </div>
                <div className="ctx-item ctx-danger" onClick={() => setMode("confirmDelete")}>
                  <span className="ctx-glyph">✕</span> Delete…
                </div>
              </>
            )}
            <div className="ctx-item" onClick={openGraph}>
              <span className="ctx-glyph">⬢</span> Show Dependency Graph
              <span className="ctx-sub">{ctx.dir ? "this folder + sub-folders" : "the script's folder"}</span>
            </div>
            <div className="ctx-note">{ctx.path}</div>
          </>
        )}
        {(mode === "newFile" || mode === "newFolder") && (
          <div className="ctx-form">
            <div className="ctx-form-title">{mode === "newFile" ? `New file in ${parentDir ?? "project root"}` : `New folder in ${parentDir ?? "project root"}`}</div>
            <input
              ref={inputRef}
              className="ctx-input"
              value={name}
              placeholder={mode === "newFile" ? "PlayerController.cs" : "Scripts"}
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) act(() => createEntry(parentDir, name.trim(), mode === "newFile" ? "file" : "folder"));
                if (e.key === "Escape") setMode("main");
              }}
            />
            <div className="ctx-form-actions">
              <button className="btn" onClick={() => setMode("main")}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !name.trim()}
                onClick={() => act(() => createEntry(parentDir, name.trim(), mode === "newFile" ? "file" : "folder"))}>
                Create
              </button>
            </div>
          </div>
        )}
        {mode === "rename" && (
          <div className="ctx-form">
            <div className="ctx-form-title">Rename <code>{currentName}</code></div>
            <input
              ref={inputRef}
              className="ctx-input"
              value={name}
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && name.trim() !== currentName) act(() => renameEntry(ctx.path, ctx.dir, name.trim()));
                if (e.key === "Escape") setMode("main");
              }}
            />
            <div className="ctx-form-actions">
              <button className="btn" onClick={() => setMode("main")}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !name.trim() || name.trim() === currentName}
                onClick={() => act(() => renameEntry(ctx.path, ctx.dir, name.trim()))}>
                Rename
              </button>
            </div>
            <div className="ctx-sub">.meta sidecar follows the rename — Unity GUIDs survive</div>
          </div>
        )}
        {mode === "confirmDelete" && (
          <div className="ctx-form">
            <div className="ctx-form-title">Delete <code>{currentName}</code>{ctx.dir ? " and everything inside?" : "?"}</div>
            <div className="ctx-form-actions">
              <button className="btn" onClick={() => setMode("main")}>Cancel</button>
              <button className="btn btn-danger" disabled={busy} onClick={() => act(() => deleteEntry(ctx.path, ctx.dir))}>
                {busy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** close the graph tab and land on a real editor tab (or the welcome screen) */
function closeGraphAction() {
  const st = useStore.getState();
  st.closeGraph();
  const remaining = st.tabs.filter((t) => t.path !== "__graph__");
  if (st.active === "__graph__") st.setActive(remaining[remaining.length - 1]?.path ?? null);
}

/* ------------------- Phase 11 — editor right-click + Collapse ▸ -------------------
 *  "when right click script so my collaspe option and it sub option give
 *  collaspe option for collaspe by methods, collaspe by #regions, collaspe all
 *  options, and also collaspe xml documentation on top of methods and stuff"
 *
 *  The submenu folds precisely: the folding provider computes VS-style ranges
 *  (methods fold from the SIGNATURE line), so each option folds exactly the
 *  ranges of its kind in ONE Monaco command: editor.fold { selectionLines }. */

function foldRangesOfKinds(kinds: string[]): number[] {
  const ed = (window as any).__editor;
  const model = ed?.getModel?.();
  if (!ed || !model) return [];
  try {
    const ranges = computeFoldRanges(model.getValue());
    return [...new Set(ranges.filter((r) => kinds.includes(r.kind)).map((r) => r.startLine))].sort((a, b) => a - b);
  } catch { return []; }
}

function collapseByKinds(kinds: string[], label: string): void {
  const ed = (window as any).__editor;
  if (!ed) return;
  const lines = foldRangesOfKinds(kinds);
  if (!lines.length) {
    useStore.getState().setStatus(`collapse ${label}: nothing to collapse in this script`);
    return;
  }
  try {
    // Monaco's fold command accepts the 0-based start lines of every region to
    // collapse in one call — no per-region flicker
    ed.trigger("velvetsharp", "editor.fold", { selectionLines: lines });
    useStore.getState().setStatus(`collapsed ${lines.length} ${label}${lines.length === 1 ? "" : "s"}`);
  } catch {
    useStore.getState().setStatus("collapse failed — try again");
  }
}

function collapseAll(): void {
  const ed = (window as any).__editor;
  if (!ed) return;
  try { ed.trigger("velvetsharp", "editor.foldAll"); useStore.getState().setStatus("collapsed everything foldable"); }
  catch { /* best-effort */ }
}

function expandAll(): void {
  const ed = (window as any).__editor;
  if (!ed) return;
  try { ed.trigger("velvetsharp", "editor.unfoldAll"); useStore.getState().setStatus("expanded all"); }
  catch { /* best-effort */ }
}

async function copyEditorSelection(): Promise<void> {
  const ed = (window as any).__editor;
  const model = ed?.getModel?.();
  const sel = ed?.getSelection?.();
  if (!ed || !model || !sel) return;
  const text = model.getValueInRange(sel) ?? "";
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall through */ }
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch { ok = false; }
  }
  useStore.getState().setStatus(ok ? "copied selection" : "copy failed");
}

async function pasteIntoEditor(): Promise<void> {
  const ed = (window as any).__editor;
  const model = ed?.getModel?.();
  if (!ed || !model) return;
  let text = "";
  try { text = await navigator.clipboard.readText(); } catch { /* denied / unsupported */ }
  if (!text) {
    useStore.getState().setStatus("clipboard empty or unavailable");
    return;
  }
  const sel = ed.getSelection();
  ed.executeEdits("velvetsharp.paste", [{ range: sel ?? undefined, text, paste: true } as any]);
  ed.focus();
  useStore.getState().setStatus("pasted");
}

function goToDefinitionFromMenu(): void {
  const ed = (window as any).__editor;
  navPush(currentMark());
  try { ed?.getAction?.("editor.action.revealDefinition")?.run?.(); } catch { /* best-effort */ }
}

/** the editor's own right-click menu (Phase 11) — mirrors ExplorerCtxMenu styling */
function EditorCtxMenu() {
  const menu = useStore((s) => s.editorCtxMenu);
  const [subOpen, setSubOpen] = useState(false);
  useEffect(() => { setSubOpen(false); }, [menu?.x, menu?.y]);
  useEffect(() => {
    if (!menu) return;
    const close = () => useStore.getState().setEditorCtxMenu(null);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const t = setTimeout(() => {
      window.addEventListener("mousedown", close, { once: true });
      window.addEventListener("contextmenu", close, { once: true });
      window.addEventListener("resize", close);
      window.addEventListener("keydown", esc);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menu?.x, menu?.y]);
  if (!menu) return null;

  const close = () => useStore.getState().setEditorCtxMenu(null);
  const run = (fn: () => void | Promise<void>) => { close(); void fn(); };
  const W = 258, H = 380;
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(menu.x, window.innerWidth - W - 8)),
    top: Math.max(8, Math.min(menu.y, window.innerHeight - H - 8)),
  };

  return (
    <div className="ctx-layer" onMouseDown={close} onContextMenu={(e) => { e.preventDefault(); close(); }}>
      <div className="ctx-menu" style={style} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <div className="ctx-item" onClick={() => run(goToDefinitionFromMenu)}>
          <span className="ctx-glyph">→</span> Go to Definition <span className="ctx-key">F12</span>
        </div>
        <div className="ctx-item" onClick={() => run(() => (window as any).__requestUses?.())}>
          <span className="ctx-glyph">◈</span> Find All Uses <span className="ctx-key">Shift+F12</span>
        </div>
        <div className="ctx-item" onClick={() => run(() => { void startRename(); })}>
          <span className="ctx-glyph">✎</span> Rename Symbol <span className="ctx-key">F2</span>
        </div>
        <div className="ctx-sep" />
        <div className="ctx-item" onClick={() => run(() => { void copyEditorSelection(); })}>
          <span className="ctx-glyph">⧉</span> Copy
        </div>
        <div className="ctx-item" onClick={() => run(() => { void pasteIntoEditor(); })}>
          <span className="ctx-glyph">⎘</span> Paste
        </div>
        <div className="ctx-sep" />
        <div
          className={"ctx-item has-sub" + (subOpen ? " open" : "")}
          onMouseEnter={() => setSubOpen(true)}
          onMouseLeave={() => setSubOpen(false)}
          onClick={() => setSubOpen((v) => !v)}
        >
          <span className="ctx-glyph">▾</span> Collapse <span className="ctx-key">▸</span>
          {subOpen && (
            <div className="ctx-submenu" onClick={(e) => e.stopPropagation()}>
              <div className="ctx-item" onClick={() => run(() => collapseByKinds(["method"], "methods"))}>
                <span className="ctx-glyph">ƒ</span> Collapse by Methods
              </div>
              <div className="ctx-item" onClick={() => run(() => collapseByKinds(["region"], "#regions"))}>
                <span className="ctx-glyph">#</span> Collapse by #Regions
              </div>
              <div className="ctx-item" onClick={() => run(() => collapseByKinds(["if"], "#if blocks"))}>
                <span className="ctx-glyph">⚑</span> Collapse by #if Blocks
              </div>
              <div className="ctx-item" onClick={() => run(() => collapseByKinds(["doc"], "XML doc comments"))}>
                <span className="ctx-glyph">///</span> Collapse XML Doc Comments
              </div>
              <div className="ctx-sep" />
              <div className="ctx-item" onClick={() => run(collapseAll)}>
                <span className="ctx-glyph">⊟</span> Collapse All
              </div>
              <div className="ctx-item" onClick={() => run(expandAll)}>
                <span className="ctx-glyph">⊞</span> Expand All
              </div>
            </div>
          )}
        </div>
        <div className="ctx-note">{useStore.getState().active ?? ""}</div>
      </div>
    </div>
  );
}

/* ------------------------- workspace opening ------------------------- */

type OpenFlowResult = "picked" | "canceled" | "fallback";

/** One entry point for every "open workspace" action (first run, welcome button,
 *  status-bar chip, palette command). Never silently dead: if the native folder
 *  dialog is unavailable / hidden behind the window, an in-app path prompt opens
 *  where the project path can be typed and validated. */
async function openWorkspaceFlow(): Promise<OpenFlowResult> {
  const adapter = getAdapter();
  if (!adapter.pickFolder) return "fallback";
  try {
    const changed = await adapter.pickFolder();
    return changed ? "picked" : "canceled";
  } catch (e: any) {
    const reason = String(e?.message ?? e);
    useStore.getState().setPathPrompt({ reason });
    useStore.getState().setStatus("native folder dialog unavailable — type the project path");
    return "fallback";
  }
}

function PathPromptModal() {
  const prompt = useStore((s) => s.pathPrompt);
  const [path, setPath] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  if (!prompt) return null;
  const recents = getRecents();

  const submit = async (raw: string) => {
    const p = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!p) return;
    setBusy(true); setErr("");
    const adapter = getAdapter();
    const ok = adapter.setRoot ? await adapter.setRoot(p) : false;
    setBusy(false);
    if (ok) {
      useStore.getState().setPathPrompt(null);
      await reloadWorkspace();
      return;
    }
    setErr(`not a folder: ${p}`);
  };

  return (
    <div className="overlay" onClick={() => useStore.getState().setPathPrompt(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">⛁ Open Unity project folder</div>
        {prompt.reason && (
          <div className="modal-reason">Native dialog unavailable ({prompt.reason}). Type the full path instead — the folder that contains Assets\ and ProjectSettings\</div>
        )}
        <input
          ref={inputRef}
          className="modal-input"
          value={path}
          placeholder={"C:\\Unity\\MyGame"}
          onChange={(e) => { setPath(e.target.value); setErr(""); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit(path);
            if (e.key === "Escape") useStore.getState().setPathPrompt(null);
          }}
          spellCheck={false}
        />
        {err && <div className="modal-err">{err}</div>}
        <div className="modal-actions">
          {recents.length > 0 && (
            <div className="recents">
              {recents.map((r) => (
                <button key={r} className="recent-chip" title={r} onClick={() => submit(r)}>{baseName(r)}</button>
              ))}
            </div>
          )}
          <span className="spacer" />
          <button className="btn" onClick={() => useStore.getState().setPathPrompt(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => submit(path)}>{busy ? "Opening…" : "Open Folder"}</button>
        </div>
        <div className="modal-hint">Tips: drop VelvetSharp.exe into the project folder and run it from there, or launch <code>VelvetSharp.exe &lt;project-path&gt;</code>.</div>
      </div>
    </div>
  );
}

/* ------------------------------ themes (v0.7.0) ------------------------------ */

function ThemePicker() {
  const tp = useStore((s) => s.themePicker);
  const [active, setActive] = useState<string>(() => getSavedThemeId() ?? DEFAULT_THEME);
  if (!tp) return null;

  const choose = (id: string) => {
    setActive(id);
    applyTheme(monaco, id); // live preview
  };

  const confirm = (id: string) => {
    saveTheme(id);
    applyTheme(monaco, id);
    useStore.getState().setThemePicker(null);
    useStore.getState().setStatus(`theme: ${themeById(id).label} — change any time via ◐ in the status bar or Ctrl+Shift+P`);
  };

  return (
    <div className="overlay" onClick={() => confirm(active)}>
      <div className="modal theme-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">◐ Choose your color theme</div>
        {tp.firstRun && (
          <div className="modal-reason">First time here — pick the look of the editor. You can change it any time from the status bar (◐) or the command palette.</div>
        )}
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={"theme-card" + (active === t.id ? " sel" : "")}
              onClick={() => choose(t.id)}
              onDoubleClick={() => confirm(t.id)}
            >
              <span className="theme-swatches">
                {t.swatches.map((c, i) => <span key={i} className="theme-dot" style={{ background: c }} />)}
              </span>
              <span className="theme-name">{t.label}</span>
              <span className="theme-sub">{t.sub}</span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button className="btn btn-primary" onClick={() => confirm(active)}>Use this theme</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ sidebar ------------------------------ */

function Sidebar() {
  const view = useStore((st) => st.sidebarView);
  const setView = useStore((st) => st.setSidebarView);
  const hideMeta = useStore((st) => st.hideMeta);
  const toggleHideMeta = useStore((st) => st.toggleHideMeta);
  const files = useStore((st) => st.files);
  const openDirsRef = useRef<Set<string>>(new Set(["Assets", "Assets/Scripts"]));
  const [, force] = useState(0);

  const visible = useMemo(
    () => files.filter((f) => !hideMeta || !f.endsWith(".meta")),
    [files, hideMeta]
  );
  const tree = useMemo(() => buildTree(visible), [visible]);

  const toggleDir = (path: string) => {
    const next = openDirsRef.current;
    next.has(path) ? next.delete(path) : next.add(path);
    force((x) => x + 1);
  };

  return (
    <div className="sidebar">
      <div className="sidebar-tabs">
        <button className={view === "explorer" ? "active" : ""} onClick={() => setView("explorer")} title="Explorer">⛁</button>
        <button className={view === "search" ? "active" : ""} onClick={() => setView("search")} title="Search (Ctrl+Shift+F)">⌕</button>
        <button className={view === "outline" ? "active" : ""} onClick={() => setView("outline")} title="Outline">≣</button>
        <span className="spacer" />
        <button onClick={toggleHideMeta} title="Toggle .meta files">{hideMeta ? "◉" : "○"}</button>
      </div>
      {view === "search" ? <SearchPanel inline /> : view === "outline" ? <OutlinePanel /> : (
        <div className="explorer">
          <div className="section-title">EXPLORER</div>
          <TreeNode node={tree} openDirs={openDirsRef.current} toggleDir={toggleDir} depth={0} isRoot />
        </div>
      )}
    </div>
  );
}

interface TNode { name: string; path: string; dir: boolean; children: TNode[] }

function buildTree(paths: string[]): TNode {
  const root: TNode = { name: "", path: "", dir: true, children: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let child = cur.children.find((c) => c.name === parts[i]);
      if (!child) {
        child = { name: parts[i], path, dir: !isFile, children: [] };
        cur.children.push(child);
      }
      cur = child;
    }
  }
  const sortRec = (n: TNode) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

function TreeNode({ node, openDirs, toggleDir, depth, isRoot = false }: {
  node: TNode;
  openDirs: Set<string>;
  toggleDir: (p: string) => void;
  depth: number;
  isRoot?: boolean;
}) {
  // per-node selectors: a keystroke no longer re-renders the whole tree
  const active = useStore((s) => s.active === node.path);
  const dirty = useStore((s) => {
    const t = s.tabs.find((x) => x.path === node.path);
    return !!t && t.content !== t.original;
  });

  if (!node.dir) {
    return (
      <div
        className={"file" + (active ? " active" : "")}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={async () => {
          try {
            const adapter = getAdapter();
            useStore.getState().openFile(node.path, await adapter.read(node.path));
          } catch (e: any) {
            // v0.7.1: a failed open is a POPUP with the real reason, not a
            // silent status-line flicker (bridge errors now visible + copyable)
            useStore.getState().showErrorPopup(
              "Could not open file",
              `${node.path}\n\n${String(e?.message ?? e)}`,
              String(e?.stack ?? ""),
            );
          }
        }}
        onDoubleClick={(e) => {
          // v0.7.1: dblclick must OPEN the file — never fall through to the
          // browser's text-selection (user saw "double-click just selects the
          // filename text" when a hung bridge stalled the open promise)
          e.preventDefault();
          e.stopPropagation();
          void (async () => {
            try {
              const adapter = getAdapter();
              useStore.getState().openFile(node.path, await adapter.read(node.path));
            } catch (err: any) {
              useStore.getState().showErrorPopup(
                "Could not open file",
                `${node.path}\n\n${String(err?.message ?? err)}`,
                String(err?.stack ?? ""),
              );
            }
          })();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          useStore.getState().setCtxMenu({ x: e.clientX, y: e.clientY, path: node.path, dir: false });
        }}
      >
        <span className={"file-icon " + iconFor(node.name)}>{iconFor(node.name) === "cs" ? "⌾" : "≡"}</span>
        {node.name}{dirty && <span className="dirty">●</span>}
      </div>
    );
  }
  const open = openDirs.has(node.path);
  if (isRoot) return <>{node.children.map((c) => <TreeNode key={c.path} node={c} openDirs={openDirs} toggleDir={toggleDir} depth={0} />)}</>;
  return (
    <div>
      <div
        className="dir"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => toggleDir(node.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          useStore.getState().setCtxMenu({ x: e.clientX, y: e.clientY, path: node.path, dir: true });
        }}
      >
        <span className="chev">{open ? "▾" : "▸"}</span>{node.name}
        <span
          className="dir-graph"
          title="Dependency graph — this folder + sub-folders (v0.6.0)"
          onClick={(e) => { e.stopPropagation(); useStore.getState().openGraph(node.path); }}
        >⬡</span>
      </div>
      {open && node.children.map((c) => <TreeNode key={c.path} node={c} openDirs={openDirs} toggleDir={toggleDir} depth={depth + 1} />)}
    </div>
  );
}

function iconFor(name: string): string {
  if (name.endsWith(".cs")) return "cs";
  if (name.endsWith(".meta")) return "meta";
  if (name.endsWith(".unity")) return "scene";
  return "txt";
}

/* ------------------------------ outline ------------------------------ */

const KIND_GLYPH: Record<string, string> = {
  class: "▣", struct: "▣", interface: "▣", enum: "▣", delegate: "▣",
  method: "ƒ", property: "◇", field: "•", event: "◈",
};

function OutlinePanel() {
  const outline = useStore((s) => s.outline);
  const active = useStore((s) => s.active);

  if (!active) return <div className="outline-empty">No active script.</div>;
  if (!outline.length) return <div className="outline-empty">No symbols found in this file.</div>;

  return (
    <div className="outline">
      <div className="section-title">OUTLINE — {active.split("/").pop()}</div>
      {outline.map((o, i) => (
        <div key={i} className="outline-item" style={{ paddingLeft: 8 + o.depth * 14 }} onClick={() => jumpToLine(o.line, o.col)}>
          <span className={"k " + o.kind}>{KIND_GLYPH[o.kind] ?? "·"}</span>
          <span className="outline-name">{o.name}</span>
          {o.isMessage && <span className="unity-badge" title="Unity event function">U</span>}
          <span className="detail">{o.detail}</span>
          <span className="ln">{o.line + 1}</span>
        </div>
      ))}
    </div>
  );
}

function jumpToLine(line: number, col: number) {
  navPush(currentMark()); // Phase 10 — every jump is a Go Back waypoint
  const ed = (window as any).__editor;
  if (!ed) return;
  ed.revealLineInCenter(line + 1);
  ed.setPosition({ lineNumber: line + 1, column: col + 1 });
  ed.focus();
}

/* ------------------------- problems bar (v0.5.0) ------------------------- */

/** apply a diagnostic's machine fix (auto `using N;`) — opens the file first
 *  if the problem is in a different script */
async function applyQuickFix(p: import("./store").ProblemItem) {
  if (!p.fix) return;
  const st = useStore.getState();
  if (st.active !== p.path) {
    await openAt(p.path, p.line, p.col);
    await new Promise((r) => setTimeout(r, 150));
  }
  const ed = (window as any).__editor;
  const model = ed?.getModel?.();
  if (!ed || !model) return;
  ed.executeEdits("velvetsharp.fix", [{
    range: new monaco.Range(p.fix.line + 1, p.fix.col + 1, p.fix.line + 1, p.fix.col + 1),
    text: convertEol(p.fix.text, eolOfMonaco(model)), // CRLF documents stay CRLF (v0.7.0)
    forceMoveMarkers: false,
  }]);
  ed.focus();
  useStore.getState().setStatus(`added ${p.fix.title}`);
}

function ProblemsBar() {
  const problems = useStore((s) => s.problems);
  const open = useStore((s) => s.problemsOpen);
  const toggle = useStore((s) => s.toggleProblems);
  const active = useStore((s) => s.active);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setSel(new Set()); }, [problems.length]);

  // right-click menu closes on any click elsewhere / Esc / resize (Phase 9:
  // "copy only 1 problem at a time from problem bar right click option")
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.length - errors;

  const copyText = (items: import("./store").ProblemItem[]) =>
    items.map(problemToText).join("\r\n");

  const copyItems = async (items: import("./store").ProblemItem[]) => {
    if (!items.length) return;
    const text = copyText(items);
    // 1) standard async clipboard (works on user gesture in WebView2)
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall through */ }
    // 2) Neutralino native clipboard — most reliable inside the desktop shell.
    //    Raced with a timeout: without the native bridge (browser demo) the call
    //    would hang forever, so fall through to the legacy path instead.
    if (!ok) {
      try {
        const res: boolean = await Promise.race([
          import("./nl-bridge")
            .then((m: any) => m?.clipboard?.writeText?.(text))
            .then(() => true)
            .catch(() => false),
          new Promise<boolean>((res) => setTimeout(() => res(false), 2500)),
        ]);
        ok = res === true;
      } catch { /* not available */ }
    }
    // 3) hidden textarea + execCommand legacy fallback
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    useStore.getState().setStatus(ok
      ? `copied ${items.length} problem${items.length === 1 ? "" : "s"} to clipboard`
      : "clipboard copy failed");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === "a") {
      e.preventDefault();
      setSel(new Set(problems.map((_, i) => i)));
    } else if (k === "c") {
      e.preventDefault();
      void copyItems(sel.size ? problems.filter((_, i) => sel.has(i)) : problems);
    }
  };

  const shown = problems.slice(0, 400);
  return (
    <div className="problems">
      <div className="problems-bar" onClick={toggle} title="Project-wide problems — errors first, then warnings">
        <span className={"pb-chev" + (open ? " open" : "")}>▸</span>
        <span className={"pb-count" + (errors ? " has-errors" : "")}>✖ {errors} error{errors === 1 ? "" : "s"}</span>
        <span className={"pb-count" + (warnings ? " has-warnings" : "")}>⚠ {warnings} warning{warnings === 1 ? "" : "s"}</span>
        <span className="pb-hint">
          {open
            ? "jump: click a row · copy 1: right-click it · copy many: Ctrl+click then Ctrl+C (all: Ctrl+A first)"
            : "click to expand — every script in the project is swept automatically"}
        </span>
      </div>
      {open && (
        <div className="problems-list" tabIndex={0} ref={boxRef} onKeyDown={onKeyDown}>
          {shown.length === 0 && <div className="problems-empty">No problems detected across the project.</div>}
          {shown.map((p, i) => (
            <div
              key={`${p.path}:${p.line}:${p.col}:${i}`}
              className={"problem-row sev-" + p.severity + (sel.has(i) ? " sel" : "") + (p.path === active ? " in-active" : "")}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  // pure multi-select — no jump, for Ctrl+A → Ctrl+C copy flows
                  const next = new Set(sel);
                  if (next.has(i)) next.delete(i); else next.add(i);
                  setSel(next);
                  boxRef.current?.focus();
                  return;
                }
                // v0.6.1: plain click selects AND jumps (double-click still jumps —
                // this is the fix for "double-clicking errors does not focus": the
                // jump now happens on the FIRST click, no dblclick timing involved)
                const next = new Set<number>();
                next.add(i);
                setSel(next);
                boxRef.current?.focus();
                openAt(p.path, p.line, p.col);
              }}
              onDoubleClick={() => openAt(p.path, p.line, p.col)}
              onContextMenu={(e) => {
                // Phase 9: right-click a row → copy JUST that problem (no selection dance)
                e.preventDefault();
                e.stopPropagation();
                setSel(new Set([i]));
                setMenu({ x: e.clientX, y: e.clientY, index: i });
              }}
            >
              <span className="pr-glyph">{p.severity === "error" ? "✖" : "⚠"}</span>
              <span className="pr-msg" title={p.message}>{p.message}</span>
              {p.fix && (
                <button className="pr-fix" title={`Quick fix: ${p.fix.title}`}
                  onClick={(e) => { e.stopPropagation(); void applyQuickFix(p); }}>
                  {p.fix.title}
                </button>
              )}
              <span className="pr-file" title={p.path}>{p.path.split("/").pop()}:{p.line + 1}:{p.col + 1}</span>
            </div>
          ))}
          {problems.length > shown.length && (
            <div className="problems-empty">…and {problems.length - shown.length} more — fix the current ones first</div>
          )}
        </div>
      )}
      {menu && (() => {
        const p = problems[menu.index];
        if (!p) return null;
        const W = 230, H = 118;
        const x = Math.max(8, Math.min(menu.x, window.innerWidth - W - 8));
        const y = Math.max(8, Math.min(menu.y, window.innerHeight - H - 8));
        return (
          <div className="ctx-menu" style={{ left: x, top: y }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}>
            <button className="ctx-item"
              onClick={() => { void copyItems([p]); setMenu(null); }}>
              Copy this problem
            </button>
            <button className="ctx-item"
              onClick={() => { void copyItems(problems); setMenu(null); }}>
              Copy all problems ({problems.length})
            </button>
            <div className="ctx-sep" />
            <button className="ctx-item"
              onClick={() => { setMenu(null); openAt(p.path, p.line, p.col); }}>
              Go to location
            </button>
          </div>
        );
      })()}
    </div>
  );
}

/* ------------------------------ editor ------------------------------ */

/** Phase 8 — usages panel (user: "when selected method or variable it shows in
 *  window like the error and warning window the places that method or variable
 *  ... able to point where does it come from"). Select a symbol → every project
 *  reference (declaration first) + a header stating WHERE the symbol comes from
 *  (file:line · assembly). Rows click-jump. Esc / × closes. */
function UsesBar() {
  const uses = useStore((s) => s.uses);
  const active = useStore((s) => s.active);
  if (!uses) return null;
  const r = uses.result;
  return (
    <div className="uses-panel" data-testid="uses-panel">
      <div className="uses-header" title={r?.origin || r?.reason || ""}>
        <span className="uses-glyph">◈</span>
        {uses.loading ? (
          <span className="uses-title">finding uses…</span>
        ) : r?.ok ? (
          <>
            <span className="uses-title">Uses of <b>{r.name}</b></span>
            <span className="uses-count">{r.uses.length} reference{r.uses.length === 1 ? "" : "s"}</span>
            <span className="uses-origin" title={r.origin}>{r.origin}</span>
          </>
        ) : (
          <span className="uses-title">{r?.reason ?? "select a symbol to see where it is used"}</span>
        )}
        <span className="spacer" />
        <button className="uses-close" onClick={() => useStore.getState().closeUses()} title="close (Esc)">×</button>
      </div>
      {r?.ok && !!r.uses.length && (
        <div className="uses-list">
          {r.uses.slice(0, 300).map((u, i) => (
            <div
              key={`${u.file}:${u.line}:${u.col}:${i}`}
              className={"use-row" + (u.isDecl ? " is-decl" : "") + (u.file === active ? " in-active" : "")}
              onClick={() => { void openAt(u.file, u.line, u.col); }}
              title={`${u.file}:${u.line + 1}:${u.col + 1} — click to jump`}
            >
              <span className={"use-kind" + (u.isDecl ? " decl" : "")}>{u.isDecl ? "decl" : "ref"}</span>
              <span className="use-text">{u.text || "—"}</span>
              <span className="use-file">{u.file.split("/").pop()}:{u.line + 1}:{u.col + 1}</span>
            </div>
          ))}
          {r.uses.length > 300 && <div className="problems-empty">…and {r.uses.length - 300} more</div>}
        </div>
      )}
      {r?.ok && !r.uses.length && (
        <div className="problems-empty">
          {r.origin ? "Compiled API symbol — it comes from the engine assemblies, not your scripts." : "No project references found."}
        </div>
      )}
      {!!r?.warnings?.length && <div className="uses-warn">⚠ {r.warnings.join(" · ")}</div>}
    </div>
  );
}

function EditorArea() {
  const active = useStore((s) => s.active);
  const tabs = useStore((s) => s.tabs);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  const graphOpen = useStore((s) => s.graphOpen);
  const showGraph = graphOpen && active === "__graph__";
  const edRef = useRef<any>(null);

  const ensureModelFor = (tab: { path: string; content: string }) => {
    let model = monaco.editor.getModels().find((m: any) => m.uri.path === "/" + tab.path);
    if (!model) {
      model = monaco.editor.createModel(tab.content, tab.path.endsWith(".cs") ? CSHARP_LANG : undefined, monaco.Uri.parse("inmemory:///" + tab.path));
      // v0.7.0 — pin the model's EOL to the file's real ending (Monaco's default
      // detection only looks at the first line; CRLF files must stay CRLF so
      // edits, fixes and saves never produce mixed endings)
      const wantCrlf = detectEol(tab.content) === "\r\n";
      try { model.setEOL(wantCrlf ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF); } catch { /* model gone */ }
      model.onDidChangeContent(() => {
        useStore.getState().updateContent(tab.path, model!.getValue());
        (window as any).__onEdit?.(tab.path, model!.getValue());
      });
      // analyze once on open (fast squiggles)
      (window as any).__onEdit?.(tab.path, model.getValue());
    }
    return model;
  };

  // callback ref (stable identity): the welcome branch renders no host div, and
  // workspace reloads toggle welcome→editor — (re)create the editor whenever the
  // host mounts
  const attachHost = useCallback((el: HTMLDivElement | null) => {
    if (el && !edRef.current) {
      edRef.current = monaco.editor.create(el, {
        theme: "velvet-dark",
        language: CSHARP_LANG,
        automaticLayout: true,
        minimap: { enabled: true, size: "proportional", scale: 1 },
        fontSize: 13.5,
        fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
        fontLigatures: true,
        smoothScrolling: true,
        mouseWheelZoom: true, // Phase 10 — Ctrl+Wheel zooms the editor like Rider/VS Code
        cursorBlinking: "phase",
        cursorSmoothCaretAnimation: "on",
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
        renderLineHighlight: "all",
        padding: { top: 10 },
        scrollBeyondLastLine: false,
        stickyScroll: { enabled: true },
        // Phase 11 — /// suggestion accepts on Enter ("typed and enter"), and
        // the fold gutter is always visible next to the new folding provider
        acceptSuggestionOnEnter: "on",
        showFoldingControls: "always",
        // Phase 12 — Monaco's built-in "suggest words from this document" was
        // the "abc" noise the user saw whenever the C# provider came up empty
        // (worker busy / crashed). The engine now guarantees a real answer
        // (instant floor + prefix-chain cache + last-good fallback), so the
        // word fallback is pure noise — off, like Rider.
        wordBasedSuggestions: "off",
      });
      (window as any).__editor = edRef.current;

      // Phase 11 — editor right-click opens the VelvetSharp menu with the
      // Collapse submenu. The listener is registered on the CONTAINER (an
      // ancestor of Monaco's DOM) in the CAPTURE phase, so it wins against
      // Monaco's own context-menu controller no matter where inside the
      // editor the user right-clicked (target-phase listeners run later).
      el.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        useStore.getState().setEditorCtxMenu({ x: e.clientX, y: e.clientY });
      }, true);
      edRef.current.onDidChangeCursorPosition((e: any) => {
        const el2 = document.getElementById("cursor-pos");
        if (el2) el2.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
      });

      // ---- Phase 8 — usages panel triggers ----
      // Select (double-click or drag) a symbol → the panel under the editor lists
      // every place it is used + where it comes from. Empty selections are IGNORED
      // so clicking a use-row (which moves the caret) never closes the panel.
      let usesTimer: any = null;
      const requestUsesFromSelection = () => {
        const ed = edRef.current;
        if (!ed) return;
        const st = useStore.getState();
        if (!st.active || st.active === "__graph__") return;
        const sel = ed.getSelection?.();
        const model = ed.getModel?.();
        if (!sel || !model || sel.isEmpty()) return; // keep the current panel
        const text = model.getValueInRange(sel);
        if (!text || /\s/.test(text) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return;
        const client = (window as any).__client;
        if (!client?.findUses) return;
        st.setUsesLoading();
        const myReq = useStore.getState().uses?.reqId ?? 0;
        client.findUses(st.active, sel.startLineNumber - 1, sel.startColumn - 1)
          .then((res: any) => {
            const cur = useStore.getState().uses;
            if (!cur || cur.reqId !== myReq) return; // a newer request superseded this one
            useStore.getState().setUses(res);
          })
          .catch(() => { /* engine busy — leave the panel as it was */ });
      };
      edRef.current.onDidChangeCursorSelection(() => {
        if (usesTimer) clearTimeout(usesTimer);
        usesTimer = setTimeout(requestUsesFromSelection, 320);
      });
      // Shift+F12 — word under the caret, no selection needed
      (window as any).__requestUses = () => {
        const ed = edRef.current;
        if (!ed) return;
        const pos = ed.getPosition?.();
        const model = ed.getModel?.();
        if (!pos || !model) return;
        const word = model.getWordAtPosition(pos);
        if (!word) return;
        ed.setSelection(new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn));
        setTimeout(requestUsesFromSelection, 0);
      };
      // a fresh editor must show the current tab (same rel path can exist in a
      // different project — the model-switch effect would not re-run for it)
      const st = useStore.getState();
      const tab = st.tabs.find((t) => t.path === st.active);
      if (tab) edRef.current.setModel(ensureModelFor(tab));
    } else if (!el && edRef.current) {
      try { edRef.current.dispose(); } catch { /* already gone */ }
      edRef.current = null;
      (window as any).__editor = null;
    }
  }, []);

  useEffect(() => () => { try { edRef.current?.dispose(); } catch { /* noop */ } }, []);

  // switch models when active tab changes
  useEffect(() => {
    const tab = tabs.find((t) => t.path === active);
    if (!edRef.current) return;
    if (!tab) { edRef.current.setModel(monaco.editor.createModel("")); return; }
    edRef.current.setModel(ensureModelFor(tab));
    // status bar reflects this document's line endings (v0.7.0)
    useStore.getState().setEol(eolOfMonaco(edRef.current.getModel()));
    // restore the deep-analysis decorations for the newly active file
    applySemanticDecorations(edRef.current);
    // consume a pending error/search jump that targeted this file (first open)
    consumePendingJump(tab.path);
  }, [active, tabs.length]);

  // v0.7.0 — word wrap + font size live-apply to the editor
  const wordWrap = useStore((s) => s.wordWrap);
  const fontSize = useStore((s) => s.fontSize);
  useEffect(() => {
    edRef.current?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  }, [wordWrap]);
  useEffect(() => {
    edRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  // refresh outline when switching files
  useEffect(() => {
    if (!active) return;
    let cancel = false;
    (window as any).__client?.outline(active)
      .then((o: any[]) => { if (!cancel) useStore.getState().setOutline(o ?? []); })
      .catch(() => {});
    return () => { cancel = true; };
  }, [active]);

  if (!active && !loading) {
    const adapter = getAdapter();
    return (
      <div className="editor-area">
        <div className="welcome">
          <div className="welcome-logo">◆</div>
          <h1>VelvetSharp</h1>
          <p>Lightweight Unity C# IDE — custom intelligence engine, zero .NET required.</p>
          {isDesktop && (
            <div className="welcome-actions">
              <button className="btn btn-primary" onClick={async () => {
                const r = await openWorkspaceFlow();
                if (r === "picked") await reloadWorkspace();
              }}>⛁ Open Unity Project Folder…</button>
              {!!adapter.root && <span className="welcome-root" title={adapter.root}>{baseName(adapter.root)}</span>}
            </div>
          )}
          <ul>
            <li><b>Ctrl+P</b> quick open · <b>Ctrl+Shift+P</b> commands · <b>Ctrl+T</b> symbols</li>
            <li><b>Ctrl+Shift+F</b> search · <b>F12</b> go to definition · <b>F2</b> rename symbol project-wide · <b>Alt+Left/Right</b> navigate back/forward · <b>Ctrl+Wheel</b> zoom</li>
            <li>Select any method/variable → the <b>uses panel</b> shows every place it is used and where it comes from</li>
            <li><b>⚡ Call Flow</b> (graph view, or Ctrl+Shift+P → "Call Flow") — how one script's methods call each other; outside calls end as dashed terminals</li>
            <li><b>#if UNITY_EDITOR</b> and friends are first-class: false branches dim, <b>#pragma warning</b> is honored, right-click → <b>Collapse ▸</b> folds methods/regions/docs</li>
            <li>Type <code>///</code> above a method and press <b>Enter</b> — the XML documentation skeleton inserts itself</li>
            <li><b>⬡</b> dependency graph — left-click the ⬡ on a folder or right-click it (4 layouts)</li>
            <li>Type <code>transform.</code>, <code>rb.</code>, or <code>Aw</code> in a class body to feel the brain</li>
            <li>Unity messages (<b>Awake / Start / Update</b>) complete at class member level</li>
          </ul>
          {error && <div className="errbox">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="editor-area">
      <div className="tabs">
        {tabs.map((t) => (
          <MemoTabChip key={t.path} path={t.path} isActive={active === t.path} />
        ))}
        {graphOpen && (
          <div
            className={"tab graph-tab" + (showGraph ? " active" : "")}
            onClick={() => useStore.getState().setActive("__graph__")}
            title="Dependency graph (Rider-style) — Esc to close"
          >
            <span className="tab-name">⬢ Dependencies</span>
            <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeGraphAction(); }}>×</span>
          </div>
        )}
      </div>
      <ProblemsBar />
      <UsesBar />
      {showGraph ? (
        <DepGraphView onOpen={(p, l, c) => { void openAt(p, l, c); }} />
      ) : null}
      <div ref={attachHost} className={"monaco-host" + (showGraph ? " hidden" : "")} />
    </div>
  );
}

function TabChip({ path, isActive }: { path: string; isActive: boolean }) {
  const dirty = useStore((s) => {
    const t = s.tabs.find((x) => x.path === path);
    return !!t && t.content !== t.original;
  });
  return (
    <div className={"tab" + (isActive ? " active" : "")} onClick={() => useStore.getState().setActive(path)}>
      <span className="tab-name">{path.split("/").pop()}</span>
      {dirty && <span className="dirty">●</span>}
      <span className="tab-close" onClick={(e) => { e.stopPropagation(); useStore.getState().closeTab(path); }}>×</span>
    </div>
  );
}
const MemoTabChip = React.memo(TabChip);

/* ---------------------------- status bar ---------------------------- */

function StatusBar() {
  const s = useStore();
  const projTip = s.projects.map((p) => `${p.name}: ${p.files} scripts · ${p.defines} defines · ${p.unityRefs} Unity refs`).join("\n");
  const warnCount = s.problems.filter((p) => p.severity !== "error").length;
  const asmTip = s.activeAssembly
    ? `assembly: ${s.activeAssembly}${s.asmRefs.length ? `\nreferences: ${s.asmRefs.join(", ")}` : "\nreferences: (none)"}${s.asmEngine ? "\nengine: UnityEngine referenced" : "\nengine: NOT referenced (noEngineReferences)"}`
    : "";
  return (
    <div className="statusbar">
      <span className={"dot " + (s.brainReady ? "ok" : "warn")} title="intelligence engine" /> brain {s.brainReady ? `${s.stats.files} files · ${s.stats.types} types · ${s.stats.members} members · ${s.stats.parseMs}ms parse` : "loading"}
      <span className={"dot " + (s.unityReady ? "ok" : "warn")} /> {s.unityReady ? `Unity API: ${s.unityLabel}` : "Unity API: —"}
      {(s.projects.length > 0 || s.asmdefInfo) && (
        <span className="proj-info" title={projTip}>
          {s.projects.length > 0 && <span className="asm-chip">⚙ {s.projects.length} {s.projects.length > 1 ? "assemblies" : "assembly"}</span>}
          {s.activeAssembly && <span className="asm-chip asm-active" title={asmTip}>{s.activeAssembly}</span>}
          {s.asmdefInfo && <span className="asm-chip asm-def" title="assembly definitions hunted from .asmdef + .meta GUIDs">{s.asmdefInfo}</span>}
          <span className="defines" title={s.defines.join(", ")}>+{s.defines.length} defines</span>
        </span>
      )}
      <span className="spacer" />
      {isDesktop && (
        <BridgeChip />
      )}
      {isDesktop && (
        <span
          className="asm-chip"
          style={{ cursor: "pointer" }}
          title={getAdapter().root ? `workspace: ${getAdapter().root} — click to change` : "click to open your Unity project folder"}
          onClick={async () => {
            const r = await openWorkspaceFlow();
            if (r === "picked") await reloadWorkspace();
          }}
        >
          ⛁ {getAdapter().root ? baseName(getAdapter().root) : "open folder…"}
        </span>
      )}
      <EolChip />
      <button
        className={"asm-chip" + (s.autoSave ? "" : " off")}
        style={{ cursor: "pointer" }}
        title={s.autoSave ? "auto-save is ON — edits are written 1.2s after you stop typing (click to disable)" : "auto-save is OFF — Ctrl+S to save (click to enable)"}
        onClick={() => useStore.getState().toggleAutoSave()}
      >
        AS {s.autoSave ? "on" : "off"}
      </button>
      <button
        className="asm-chip"
        style={{ cursor: "pointer" }}
        title="Color theme — click to change (v0.7.0)"
        onClick={() => useStore.getState().setThemePicker({ firstRun: false })}
      >
        ◐ theme
      </button>
      {(s.errors > 0 || warnCount > 0) && (
        <button
          className="err-count"
          onClick={() => useStore.getState().toggleProblems()}
          title="Toggle the Problems bar (project-wide)"
        >
          ✖ {s.errors} · ⚠ {warnCount}
        </button>
      )}
      <span id="cursor-pos">Ln 1, Col 1</span>
      <span>{s.status}</span>
      {/* Phase chip — always visible so the shipped version is never ambiguous again */}
      <button
        className="asm-chip version-chip"
        style={{ cursor: "pointer", opacity: 0.85 }}
        title={`VelvetSharp ${APP_LABEL} (build ${APP_BUILD}) — every delivery bumps the phase number`}
        onClick={() => useStore.getState().setSettingsOpen(true)}
      >
        {APP_LABEL}
      </button>
    </div>
  );
}

/** LF / CRLF status chip — click converts the active document in place (v0.7.0) */
function EolChip() {
  const eol = useStore((s) => s.eol);
  const active = useStore((s) => s.active);
  if (!active) return null;
  return (
    <button
      className="asm-chip"
      style={{ cursor: "pointer" }}
      title={"line endings of this file — click to convert to " + (eol === "\n" ? "CRLF (Windows)" : "LF (Unix)")}
      onClick={() => {
        const ed = (window as any).__editor;
        const model = ed?.getModel?.();
        if (!model) return;
        const next: "\n" | "\r\n" = eol === "\n" ? "\r\n" : "\n";
        model.setEOL(next === "\r\n" ? (monaco as any).editor.EndOfLineSequence.CRLF : (monaco as any).editor.EndOfLineSequence.LF);
        useStore.getState().setEol(next);
        (window as any).__onEdit?.(active, model.getValue());
        useStore.getState().setStatus(`converted line endings to ${next === "\r\n" ? "CRLF" : "LF"} — Ctrl+S to persist`);
      }}
    >
      {eol === "\r\n" ? "CRLF" : "LF"}
    </button>
  );
}

/* ------------------------------ palette ------------------------------ */

function insertLifecycle(l: { name: string; params: string }) {
  const ed = (window as any).__editor;
  if (!ed) return;
  const pos = ed.getPosition();
  const model = ed.getModel?.();
  const eol = eolOfMonaco(model); // respect the document's line endings
  const text = [`private void ${l.name}(${l.params})`, "{", "    ", "}"].join(eol);
  ed.executeEdits("velvetsharp", [{
    range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
    text,
  }]);
  ed.focus();
}

function Palette() {
  const s = useStore();
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [sel, setSel] = useState(0);
  const [symItems, setSymItems] = useState<{ text: string; path: string; line: number; col: number }[]>([]);
  useEffect(() => inputRef.current?.focus(), []);

  const client = (window as any).__client as BrainClient | undefined;

  // symbols mode is async against the worker
  useEffect(() => {
    if (s.palette !== "symbols" || !client) return;
    let cancel = false;
    client.workspaceSymbols(q)
      .then((syms) => {
        if (cancel) return;
        setSymItems(syms.map((x: any) => ({
          text: `${x.name}  —  ${x.kind}${x.container ? " in " + x.container : ""}`,
          path: x.file, line: x.line, col: x.col,
        })));
      })
      .catch(() => setSymItems([]));
    return () => { cancel = true; };
  }, [q, s.palette]);

  const commands = [
    { label: "File: Save", run: saveActive },
    ...(getAdapter().pickFolder ? [{
      label: "File: Open Workspace Folder…",
      run: async () => {
        const r = await openWorkspaceFlow();
        if (r === "picked") await reloadWorkspace();
      },
    }] : []),
    { label: "Preferences: Select Color Theme…", run: () => useStore.getState().setThemePicker({ firstRun: false }) },
    { label: "View: Toggle Word Wrap (Alt+Z)", run: () => useStore.getState().toggleWordWrap() },
    { label: "File: Toggle Auto-Save", run: () => { useStore.getState().toggleAutoSave(); useStore.getState().setStatus("auto-save " + (useStore.getState().autoSave ? "ON" : "OFF")); } },
    { label: "File: New C# Script…", run: () => {
      useStore.getState().setSidebarView("explorer");
      useStore.getState().setCtxMenu({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 3), path: "Assets/Scripts", dir: true });
    } },
    { label: "Unity: Insert Method…", keepOpen: true, run: () => useStore.getState().setPalette("unity") },
    { label: "View: Show Dependency Graph (project)", run: () => useStore.getState().openGraph(null) },
    { label: "View: Call Flow of Current Script", run: () => {
      useStore.getState().openGraph(null);
      useStore.getState().setGraphMode("flow");
    } },
    { label: "Refactor: Rename Symbol (F2)", run: () => void startRename() },
    { label: "References: Find All Uses of Symbol (Shift+F12)", run: () => (window as any).__requestUses?.() },
    // Phase 11 — collapse commands (right-click menu has the full submenu)
    { label: "View: Collapse by Methods", run: () => collapseByKinds(["method"], "methods") },
    { label: "View: Collapse by #Regions", run: () => collapseByKinds(["region"], "#regions") },
    { label: "View: Collapse XML Doc Comments", run: () => collapseByKinds(["doc"], "XML doc comments") },
    { label: "View: Collapse All", run: collapseAll },
    { label: "View: Expand All", run: expandAll },
    // Phase 10 — navigation history
    { label: "Navigate: Go Back (Alt+Left)", run: () => navGo(-1) },
    { label: "Navigate: Go Forward (Alt+Right)", run: () => navGo(1) },
    { label: "View: Toggle Explorer", run: () => useStore.getState().setSidebarView("explorer") },
    { label: "Search: Find in Project Files (Ctrl+Shift+F)", run: () => useStore.getState().setSidebarView("search") },
    { label: "AI: MCP Connection Info (for external agents)", run: () => useStore.getState().setSettingsOpen(true) },
    { label: "View: Toggle Outline", run: () => useStore.getState().setSidebarView("outline") },
    { label: "View: Toggle .meta visibility", run: () => useStore.getState().toggleHideMeta() },
    { label: "File: Close All Tabs", run: () => { const st = useStore.getState(); st.tabs.forEach((t) => st.closeTab(t.path)); } },
    { label: "Brain: Reindex Workspace", run: async () => {
      if (!client) return;
      const adapter = getAdapter();
      const files = await adapter.listFiles();
      const loaded: { path: string; content: string }[] = [];
      for (const p of files.filter((f) => f.endsWith(".cs"))) loaded.push({ path: p, content: await adapter.read(p) });
      await client.loadFiles(loaded);
      useStore.getState().setStatus("workspace reindexed");
    } },
  ];

  const items = useMemo(() => {
    if (s.palette === "commands") {
      return q ? fuzzysort.go(q, commands.map((c) => c.label)).map((r) => {
        const cmd = commands.find((c) => c.label === r.target)!;
        return { text: r.target, run: cmd.run, keepOpen: (cmd as any).keepOpen };
      })
        : commands.map((c) => ({ text: c.label, run: c.run, keepOpen: (c as any).keepOpen }));
    }
    if (s.palette === "symbols") {
      return symItems.map((x) => ({ ...x, run: () => openAt(x.path, x.line, x.col) }));
    }
    if (s.palette === "unity") {
      const ql = q.toLowerCase();
      return UNITY_LIFECYCLE
        .filter((l) => !ql || l.name.toLowerCase().includes(ql))
        .map((l) => ({
          text: `void ${l.name}(${l.params})${l.params ? "" : "  ·  insert Unity method"}`,
          run: () => insertLifecycle(l),
        }));
    }
    // files
    const files = useStore.getState().files.filter((f) => !f.endsWith(".meta"));
    const res = q ? fuzzysort.go(q.replace(/\s/g, ""), files, { key: (f: string) => f }) : files.map((f) => ({ target: f, score: 0 }));
    return (res as any).slice(0, 50).map((r: any) => ({ text: r.target ?? r, run: () => openFileByPath(r.target ?? r) }));
  }, [q, s.palette]);

  return (
    <div className="overlay" onClick={() => s.setPalette(null)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder={s.palette === "files" ? "Go to file…" : s.palette === "symbols" ? "Go to symbol…" : s.palette === "unity" ? "Insert Unity method…" : "Run command…"}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") s.setPalette(null);
            if (e.key === "Enter") {
              const it = items[sel] as any;
              it?.run?.();
              if (!(it as any)?.keepOpen) s.setPalette(null);
            }
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((x) => Math.min(x + 1, items.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((x) => Math.max(x - 1, 0)); }
          }}
        />
        <div className="palette-list">
          {items.slice(0, 30).map((it: any, i) => (
            <div key={i} className={"palette-item" + (i === sel ? " sel" : "")} onMouseEnter={() => setSel(i)} onClick={() => { it.run?.(); if (!(it as any).keepOpen) s.setPalette(null); }}>
              {it.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

async function openFileByPath(path: string) {
  try {
    const adapter = getAdapter();
    const content = await adapter.read(path);
    useStore.getState().openFile(path, content);
  } catch (e: any) {
    // v0.7.1: clicking a Problem entry that fails to load now SHOWS the reason
    // (previously a silent status flicker — the hung bridge made this look like
    // "clicking the error bar does nothing")
    useStore.getState().showErrorPopup(
      "Could not open file",
      `${path}\n\n${String(e?.message ?? e)}\n\n(The Problems bar keeps working — try again once the bridge chip shows "bridge ok".)`,
      String(e?.stack ?? ""),
    );
  }
}

/** pending reveal — set by openAt, consumed either here (already-open path) or
 *  by the editor's model-switch effect (file was NOT open: read → store →
 *  render → setModel is async, and the old fixed 120ms timer raced it, so the
 *  jump landed on the previous model and looked like "nothing happened"). */
let pendingJump: { path: string; line: number; col: number } | null = null;

function consumePendingJump(path: string): void {
  if (pendingJump?.path === path) {
    const j = pendingJump;
    pendingJump = null;
    jumpToLine(j.line, j.col);
  }
}

async function openAt(path: string, line: number, col = 0) {
  navPush(currentMark()); // Phase 10 — every jump is a Go Back waypoint
  pendingJump = { path, line, col };
  await openFileByPath(path);
  // poll briefly — the model-switch effect usually consumes the jump first
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 75));
    const ed = (window as any).__editor;
    if (ed && useStore.getState().active === path && pendingJump?.path === path) {
      pendingJump = null;
      jumpToLine(line, col);
      return;
    }
  }
  if (pendingJump?.path === path) pendingJump = null;
}

/* ------------------ Phase 10 — navigation history (Go Back / Go Forward) ------------------
 *  Rider/VS Code users hit "navigate back" constantly after F12, search hits,
 *  problems and outline jumps — without it deep dives are one-way. openAt /
 *  jumpToLine record the pre-jump caret position; Alt+Left walks the stack
 *  back, Alt+Right forward. F12 snapshots via a capture-phase key listener. */
type NavMark = { path: string; line: number; col: number };
const navBack: NavMark[] = [];
const navFwd: NavMark[] = [];
let navRestoring = false;

function currentMark(): NavMark | null {
  const st = useStore.getState();
  const ed = (window as any).__editor;
  const pos = ed?.getPosition?.();
  if (!st.active || st.active === "__graph__" || !pos) return null;
  return { path: st.active, line: pos.lineNumber - 1, col: pos.column - 1 };
}

function navPush(mark: NavMark | null): void {
  if (navRestoring || !mark) return;
  const last = navBack[navBack.length - 1];
  if (last && last.path === mark.path && last.line === mark.line && last.col === mark.col) return;
  navBack.push(mark);
  if (navBack.length > 100) navBack.shift();
  navFwd.length = 0;
}

function navGo(dir: -1 | 1): void {
  const hist = dir === -1 ? navBack : navFwd;
  const other = dir === -1 ? navFwd : navBack;
  const cur = currentMark();
  let m = hist.pop();
  if (!m) { useStore.getState().setStatus(dir === -1 ? "navigation history: no earlier position" : "navigation history: no forward position"); return; }
  // skip a mark that is exactly where we already are (jump then jump back)
  if (cur && m.path === cur.path && m.line === cur.line && m.col === cur.col) {
    const next = hist.pop();
    if (next) m = next;
  }
  navRestoring = true;
  try {
    if (cur) other.push(cur);
    useStore.getState().setStatus(`${dir === -1 ? "back to" : "forward to"} ${m.path.split("/").pop()}:${m.line + 1}`);
    void openAt(m.path, m.line, m.col);
  } finally {
    window.setTimeout(() => { navRestoring = false; }, 400);
  }
}

/* --------------------------- search (Phase 14) ---------------------------
 *  Find-in-files got real: live debounced search, case / whole-word / regex
 *  options, match highlighting with line context, per-file grouping with
 *  counts — and an honest coverage report: files indexed from the startup
 *  cache have no text in the engine yet, so the panel offers "scan & re-run"
 *  instead of silently missing them (the old behavior). The MCP search_code
 *  tool shares the exact same engine call. */

const SEARCH_DEBOUNCE_MS = 250;
const HITS_PER_FILE = 20;

/** slice a source line around the match and mark the match itself */
function HitLine({ hit }: { hit: { text: string; col: number; length: number } }) {
  const start = Math.max(0, hit.col - 42);
  const end = Math.min(hit.text.length, hit.col + hit.length + 70);
  const pre = (start > 0 ? "…" : "") + hit.text.slice(start, hit.col);
  const match = hit.text.slice(hit.col, hit.col + hit.length);
  const post = hit.text.slice(hit.col + hit.length, end) + (end < hit.text.length ? "…" : "");
  return (
    <code>
      {pre}
      <mark>{match || " "}</mark>
      {post}
    </code>
  );
}

function SearchPanel({ inline }: { inline?: boolean }) {
  const [q, setQ] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [res, setRes] = useState<ProjectSearchResult | null>(null);
  const [searched, setSearched] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runIdRef = useRef(0);

  const client = (window as any).__client as BrainClient | undefined;
  const adapter = getAdapter();

  const run = (immediate = false) => {
    if (!q) { setRes(null); setSearched(false); return; }
    if (!client) return;
    if (!immediate && debounceRef.current) clearTimeout(debounceRef.current);
    const id = ++runIdRef.current;
    const t0 = performance.now();
    const opts = { regex, caseSensitive, wholeWord, max: 600 };
    const go = () => {
      client.searchProject(q, opts)
        .then((r) => { if (id === runIdRef.current) { setRes(r); setSearched(true); setElapsed(Math.round(performance.now() - t0)); } })
        .catch(() => { /* stale worker — the next keystroke retries */ });
    };
    if (immediate) go();
    else debounceRef.current = setTimeout(go, SEARCH_DEBOUNCE_MS);
  };

  // live search: re-run whenever the query or an option changes
  useEffect(() => {
    if (!q) { setRes(null); setSearched(false); return; }
    run();
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [q, caseSensitive, wholeWord, regex]);

  // focus + preselect when the panel opens (Ctrl+Shift+F)
  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.focus(); el.select(); }
  }, []);

  /** Phase 14 coverage fix: read the cache-only files the engine has no text
   *  for, feed them to the worker (light index), then re-run the search. */
  const scanMissing = async () => {
    const missing = res?.unsearched ?? [];
    if (!missing.length || scanning || !client) return;
    setScanning(true);
    try {
      const CHUNK = 10;
      for (let i = 0; i < missing.length; i += CHUNK) {
        const chunk = missing.slice(i, i + CHUNK);
        const reads = await Promise.allSettled(chunk.map((p) => adapter.read(p)));
        for (let j = 0; j < chunk.length; j++) {
          const r = reads[j];
          if (r.status !== "fulfilled") continue; // unreadable — the engine stays without it
          try { await client.updateFile(chunk[j], r.value); } catch { /* worker hiccup — keep going */ }
        }
      }
      run(true);
    } finally {
      setScanning(false);
    }
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run(true);
      const first = res?.hits?.[0];
      if (first) openAt(first.file, first.line, first.col);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (q) { setQ(""); setRes(null); setSearched(false); }
      else if (!inline) useStore.getState().setSidebarView("explorer");
    }
  };

  const hits = res?.hits ?? [];
  const fileCount = new Set(hits.map((h) => h.file)).size;
  const optBtn = (on: boolean, set: (v: boolean) => void, label: string, title: string) => (
    <button
      className={"opt" + (on ? " on" : "")}
      title={title}
      onClick={() => set(!on)}
    >{label}</button>
  );

  return (
    <div className={"search" + (inline ? "" : " floating")} onClick={(e) => e.stopPropagation()}>
      <div className="search-row">
        <input
          ref={inputRef}
          autoFocus
          value={q}
          placeholder="Search across all project scripts…  (Enter = jump to first match)"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onInputKey}
        />
        <button onClick={() => run(true)} title="search now">Find</button>
        {!inline && <button className="close" onClick={() => useStore.getState().setSidebarView("explorer")}>×</button>}
      </div>
      <div className="search-opts">
        {optBtn(caseSensitive, setCaseSensitive, "Aa", "case sensitive")}
        {optBtn(wholeWord, setWholeWord, "|w|", "whole word — matches the full identifier only")}
        {optBtn(regex, setRegex, ".*", "regular expression")}
        <span className="search-opts-hint">Esc clears · Enter jumps to the first match</span>
      </div>
      <div className="search-results">
        {searched && res && (
          <div className="search-meta">
            <span className="search-count">
              {res.error ? res.error : `${hits.length} match${hits.length === 1 ? "" : "es"} in ${fileCount} file${fileCount === 1 ? "" : "s"} · ${elapsed} ms`}
              {res.truncated ? " — capped, refine the query" : ""}
            </span>
            {res.unsearched.length > 0 && (
              <button className="scan-btn" onClick={scanMissing} disabled={scanning} title="these files are indexed from the startup cache and have no text in the engine yet — read them now and search again">
                {scanning ? "scanning…" : `+ ${res.unsearched.length} file${res.unsearched.length === 1 ? "" : "s"} not scanned yet — scan & re-run`}
              </button>
            )}
          </div>
        )}
        {groupBy(hits).map(([file, list]) => (
          <div key={file} className="search-filegroup">
            <div className="search-file" onClick={() => openAt(file, list[0].line, list[0].col)}>
              {file} <span className="cnt">{list.length}</span>
            </div>
            {list.slice(0, HITS_PER_FILE).map((h: any, i: number) => (
              <div key={i} className="search-hit" onClick={() => openAt(h.file, h.line, h.col)}>
                <span className="ln">{h.line + 1}</span>
                <HitLine hit={h} />
              </div>
            ))}
            {list.length > HITS_PER_FILE && (
              <div className="search-more">+ {list.length - HITS_PER_FILE} more in this file</div>
            )}
          </div>
        ))}
        {searched && !res?.error && hits.length === 0 && (
          <div className="search-empty">no matches{res && res.unsearched.length ? " in the scanned files — the scan-more button above covers the rest" : ""}</div>
        )}
      </div>
    </div>
  );
}

function groupBy(hits: any[]): [string, any[]][] {
  const m = new Map<string, any[]>();
  for (const h of hits) {
    if (!m.has(h.file)) m.set(h.file, []);
    m.get(h.file)!.push(h);
  }
  return [...m.entries()];
}

/* --------------------- v0.7.1 — error popup + settings + bridge chip --------------------- */

const BRIDGE_LABEL: Record<string, string> = {
  browser: "browser",
  connected: "bridge ok",
  connecting: "bridge…",
  offline: "bridge down",
};

/** status-bar chip showing the native bridge health; click = reconnect now */
function BridgeChip() {
  const bridge = useStore((s) => s.bridge);
  const cls = bridge === "connected" ? "ok" : bridge === "connecting" ? "warn" : "err";
  const label = BRIDGE_LABEL[bridge] ?? bridge;
  return (
    <button
      className={"asm-chip bridge-chip " + cls}
      style={{ cursor: "pointer" }}
      title={
        bridge === "connected"
          ? `native bridge connected via ws://${bridgeStats.host} — click to run a self-test`
          : `${label} — the disk bridge reconnects automatically (host: ${bridgeStats.host}${bridgeStats.lastError ? `, last error: ${bridgeStats.lastError}` : ""}) — click to retry now`
      }
      onClick={async () => {
        forceReconnect();
        const res = await bridgeSelfTest();
        useStore.getState().setStatus(`bridge self-test: ${res.detail}`);
        if (!res.ok) {
          useStore.getState().showErrorPopup(
            "Native bridge problem",
            `The disk bridge could not answer a health check.\n\n${res.detail}\n\nFile access will keep retrying in the background. If this persists, restart VelvetSharp — and if it STILL fails, report this popup text.`,
            `host: ${bridgeStats.host}\nreconnects: ${bridgeStats.reconnects}\ntimeouts: ${bridgeStats.timeouts}\nlast error: ${bridgeStats.lastError || "(none)"}`,
          );
        }
      }}
    >● {label}</button>
  );
}

/** v0.7.1 (user request): internal errors pop up with message + stack trace so
 *  they can be reported instead of dying silently inside the status bar. */
function ErrorPopup() {
  const err = useStore((s) => s.errorPopup);
  if (!err) return null;
  const copy = async () => {
    const text = `[VelvetSharp error]\n${err.title}\n${err.message}\n\n${err.stack ?? "(no stack)"}`;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall through */ }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
      } catch { /* best effort */ }
    }
    useStore.getState().setStatus("error details copied — paste them into your bug report");
  };
  return (
    <div className="overlay" onClick={() => useStore.getState().dismissErrorPopup()}>
      <div className="modal error-popup" onClick={(e) => e.stopPropagation()}>
        <div className="error-popup-title">⚠ {err.title}</div>
        <pre className="error-popup-msg">{err.message}</pre>
        {err.stack && <pre className="error-popup-stack">{err.stack}</pre>}
        <div className="error-popup-actions">
          <button className="btn" onClick={copy}>⧉ copy details</button>
          <button className="btn btn-primary" onClick={() => useStore.getState().dismissErrorPopup()}>dismiss</button>
        </div>
        <div className="error-popup-hint">this popup appears whenever an internal error happens — paste the copied details into a bug report so it can be fixed precisely</div>
      </div>
    </div>
  );
}

/** v0.7.1 (user request): dedicated settings modal — theme, editor prefs and
 *  native-bridge diagnostics in one place, reachable from the ⚙ titlebar button. */
function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const bridge = useStore((s) => s.bridge);
  const wordWrap = useStore((s) => s.wordWrap);
  const autoSave = useStore((s) => s.autoSave);
  const fontSize = useStore((s) => s.fontSize);
  const [cfgPath, setCfgPath] = useState("");
  const [selfTest, setSelfTest] = useState<string>("");
  const [mcpPath, setMcpPath] = useState("");
  const [mcpTools, setMcpTools] = useState<string[]>([]);
  useEffect(() => {
    if (!open) { setSelfTest(""); return; }
    configFilePath().then(setCfgPath).catch(() => setCfgPath(""));
    mcpDiscoveryPath().then(setMcpPath).catch(() => setMcpPath(""));
    try { setMcpTools((window as any).__vsMcp?.status()?.tools ?? []); } catch { setMcpTools([]); }
  }, [open]);
  if (!open) return null;
  const isDesk = typeof window !== "undefined" && "NL_PORT" in window;
  const Row = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
    <div className="settings-row" title={hint}>
      <span className="settings-label">{label}</span>
      <span className="settings-value">{children}</span>
    </div>
  );
  return (
    <div className="overlay" onClick={() => useStore.getState().setSettingsOpen(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-title">⚙ Settings</div>
        <Row label="version" hint="the phase number is the user-facing version — it bumps with every delivered update and is never reused">
          <span className="settings-inline">
            <span className="bridge-state ok" style={{ fontWeight: 700 }}>VelvetSharp {APP_LABEL}</span>
            <code className="settings-path">build {APP_BUILD}</code>
          </span>
        </Row>
        <Row label="color theme" hint="opens the full theme picker with live preview">
          <button className="btn" onClick={() => { useStore.getState().setSettingsOpen(false); useStore.getState().setThemePicker({ firstRun: false }); }}>change theme…</button>
        </Row>
        <Row label="font size">
          <span className="settings-inline">
            <button className="btn" onClick={() => { const st = useStore.getState(); st.setFontSize(st.fontSize - 1); }}>−</button>
            <span className="settings-num">{fontSize}px</span>
            <button className="btn" onClick={() => { const st = useStore.getState(); st.setFontSize(st.fontSize + 1); }}>+</button>
            <button className="btn" onClick={() => useStore.getState().setFontSize(13.5)}>reset</button>
          </span>
        </Row>
        <Row label="word wrap" hint="Alt+Z anywhere">
          <button className={"btn" + (wordWrap ? " primary" : "")} onClick={() => useStore.getState().toggleWordWrap()}>{wordWrap ? "on" : "off"}</button>
        </Row>
        <Row label="auto-save" hint="writes edits 1.2 s after you stop typing">
          <button className={"btn" + (autoSave ? " primary" : "")} onClick={() => useStore.getState().toggleAutoSave()}>{autoSave ? "on" : "off"}</button>
        </Row>
        <Row label="preferences file" hint="theme/editor/workspace prefs persist here — they survive even if the window profile resets">
          <code className="settings-path">{cfgPath || "(browser demo — settings stay in localStorage)"}</code>
        </Row>
        {isDesk && (
          <Row label="native bridge" hint="the disk connection between the editor UI and your files">
            <span className="settings-inline">
              <span className={"bridge-state " + (bridge === "connected" ? "ok" : bridge === "connecting" ? "warn" : "err")}>
                ● {BRIDGE_LABEL[bridge] ?? bridge}
              </span>
              <button className="btn" onClick={async () => {
                setSelfTest("testing…");
                forceReconnect();
                const r = await bridgeSelfTest();
                setSelfTest(r.detail);
              }}>run self-test</button>
              <button className="btn" onClick={() => forceReconnect()}>reconnect</button>
            </span>
          </Row>
        )}
        {isDesk && (
          <Row label="AI agents (MCP)" hint={`external AI assistants connect through mcp/server.mjs and can query this live editor — tools: ${mcpTools.join(", ") || "booting…"}. Point the agent's config at the VelvetSharp folder's mcp/server.mjs (needs Node.js 18+).`}>
            <span className="settings-inline">
              <span className={"bridge-state " + (mcpTools.length ? "ok" : "warn")}>
                ● {mcpTools.length ? "listening" : "booting"}
              </span>
              <code className="settings-path">{mcpPath || "(discovery file unavailable)"}</code>
            </span>
          </Row>
        )}
        {selfTest && <div className="settings-selftest">{selfTest}</div>}
        <div className="settings-actions">
          <button className="btn btn-primary" onClick={() => useStore.getState().setSettingsOpen(false)}>done</button>
        </div>
      </div>
    </div>
  );
}

export default App;
