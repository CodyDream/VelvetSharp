/** VelvetSharp — global state (zustand) */
import { create } from "zustand";
import { saveConfigField } from "./configStore"; // v0.7.1: prefs also persist to %APPDATA% config.json
import type { SymbolUsesResult } from "./brain-client"; // Phase 8 — usages panel

export interface Tab { path: string; content: string; original: string; cursor?: { line: number; col: number } }

export interface ProjectSummary {
  name: string;
  files: number;
  defines: number;
  unityRefs: number;
  langVersion?: string;
}

export interface OutlineEntry {
  name: string;
  kind: string;
  line: number;
  col: number;
  depth: number;
  detail?: string;
  isMessage?: boolean;
}

export type SidebarView = "explorer" | "search" | "outline" | "problems";

/** one row in the project-wide Problems bar (v0.5.0) */
export interface ProblemItem {
  path: string;
  line: number;
  col: number;
  length: number;
  message: string;
  severity: "error" | "warning" | "info";
  source: string;
  fix?: { kind: "addUsing"; ns: string; title: string; line: number; col: number; text: string };
  /** Phase 14 — compiler-style code (CS0219, CS0168, CS0618 …) surfaced to the
   *  Problems bar copy + the MCP get_problems tool */
  code?: string;
}

interface VSState {
  files: string[];
  tabs: Tab[];
  active: string | null;
  loading: boolean;
  status: string;
  brainReady: boolean;
  unityReady: boolean;
  unityLabel: string;
  stats: { files: number; types: number; members: number; parseMs: number };
  hideMeta: boolean;
  sidebarView: SidebarView;
  palette: null | "files" | "commands" | "symbols" | "unity";
  errors: number;
  error: string | null;

  // csproj auto-config
  projects: ProjectSummary[];
  defines: string[];
  activeAssembly: string | null;
  /** v0.5.0 — referenced assemblies of the active file's assembly */
  asmRefs: string[];
  asmEngine: boolean;
  /** v0.5.0 — assembly-hunting summary (asmdef count etc.) */
  asmdefInfo: string;

  // v0.5.0 — project-wide Problems bar (errors first, then warnings)
  problems: ProblemItem[];
  warnings: number;
  problemsOpen: boolean;

  // v0.6.0 — dependency graph pseudo-tab + F2 rename widget + explorer menu
  graphOpen: boolean;
  graphScope: string | null;          // null = whole project
  graphSeed: number;                  // bump to force a re-request of the same scope
  // Phase 9 — call-flow mode: "types" graph or per-script "flow" graph
  graphMode: "types" | "flow";
  graphFlowFile: string | null;       // the script the flow view renders
  renameWidget: null | { path: string; line: number; col: number; oldName: string; kind: string };
  ctxMenu: null | { x: number; y: number; path: string; dir: boolean };
  /** Phase 11 — right-click menu INSIDE the editor (Collapse ▸ submenu etc.) */
  editorCtxMenu: null | { x: number; y: number };

  // v0.7.0 — themes, editor preferences, line endings
  themePicker: null | { firstRun: boolean };
  wordWrap: boolean;
  autoSave: boolean;
  fontSize: number;
  eol: "\n" | "\r\n";                 // EOL of the ACTIVE document (status chip)

  // outline of the active document
  outline: OutlineEntry[];

  // in-app "type the project path" fallback (native dialog unavailable / canceled)
  pathPrompt: null | { reason?: string };

  // v0.7.1 — global error popup (message + stack trace, copyable) + bridge chip
  errorPopup: null | { title: string; message: string; stack?: string; at: number };
  bridge: "browser" | "connected" | "connecting" | "offline";
  settingsOpen: boolean;
  showErrorPopup: (title: string, message: string, stack?: string) => void;
  dismissErrorPopup: () => void;
  setBridge: (b: VSState["bridge"]) => void;
  setSettingsOpen: (v: boolean) => void;

  // Phase 8 — usages panel (like the Problems bar, but for the selected symbol)
  uses: null | { loading: boolean; result: SymbolUsesResult | null; reqId: number };
  setUsesLoading: () => void;
  setUses: (result: SymbolUsesResult) => void;
  closeUses: () => void;

  setFiles: (f: string[]) => void;
  openFile: (path: string, content: string) => void;
  closeTab: (path: string) => void;
  setActive: (path: string | null) => void;
  updateContent: (path: string, content: string) => void;
  setLoading: (v: boolean) => void;
  setStatus: (s: string) => void;
  setBrainReady: (v: boolean) => void;
  setUnity: (v: boolean, label: string) => void;
  setStats: (s: VSState["stats"]) => void;
  setErrors: (n: number) => void;
  setError: (e: string | null) => void;
  toggleHideMeta: () => void;
  setSidebarView: (v: SidebarView) => void;
  setPalette: (p: VSState["palette"]) => void;
  setProjects: (p: ProjectSummary[], defines: string[]) => void;
  setActiveAssembly: (a: string | null) => void;
  setAsmInfo: (refs: string[], engine: boolean) => void;
  setAsmdefInfo: (s: string) => void;
  setProblems: (p: ProblemItem[]) => void;
  toggleProblems: () => void;
  setOutline: (o: OutlineEntry[]) => void;
  markSaved: (path: string) => void;
  setPathPrompt: (p: VSState["pathPrompt"]) => void;
  openGraph: (scope: string | null) => void;
  closeGraph: () => void;
  setGraphScope: (scope: string | null) => void;
  setGraphMode: (m: "types" | "flow") => void;
  refreshGraph: () => void;
  setRenameWidget: (r: VSState["renameWidget"]) => void;
  setCtxMenu: (c: VSState["ctxMenu"]) => void;
  setEditorCtxMenu: (m: VSState["editorCtxMenu"]) => void;
  setThemePicker: (p: VSState["themePicker"]) => void;
  toggleWordWrap: () => void;
  toggleAutoSave: () => void;
  setFontSize: (n: number) => void;
  setEol: (e: "\n" | "\r\n") => void;
}

export const useStore = create<VSState>((set) => ({
  files: [],
  tabs: [],
  active: null,
  loading: true,
  status: "starting…",
  brainReady: false,
  unityReady: false,
  unityLabel: "",
  stats: { files: 0, types: 0, members: 0, parseMs: 0 },
  hideMeta: true,
  sidebarView: "explorer",
  palette: null,
  errors: 0,
  error: null,
  projects: [],
  defines: [],
  activeAssembly: null,
  asmRefs: [],
  asmEngine: true,
  asmdefInfo: "",
  problems: [],
  warnings: 0,
  problemsOpen: false,
  outline: [],
  pathPrompt: null,
  errorPopup: null,
  bridge: (typeof window !== "undefined" && "NL_PORT" in window) ? "connecting" : "browser",
  showErrorPopup: (title, message, stack) => set((s) => {
    // dedupe: identical error within 1.5 s → keep the first (avoids popup storms)
    if (s.errorPopup && s.errorPopup.message === message && Date.now() - s.errorPopup.at < 1500) return {};
    return { errorPopup: { title, message, stack, at: Date.now() } };
  }),
  dismissErrorPopup: () => set({ errorPopup: null }),
  setBridge: (bridge) => set({ bridge }),
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  // Phase 8 — usages panel state (reqId guards stale responses)
  uses: null,
  setUsesLoading: () => set((s) => ({ uses: { loading: true, result: s.uses?.result ?? null, reqId: (s.uses?.reqId ?? 0) + 1 } })),
  setUses: (result) => set((s) => ({ uses: { loading: false, result, reqId: (s.uses?.reqId ?? 0) + 1 } })),
  closeUses: () => set({ uses: null }),
  graphOpen: false,
  graphScope: null,
  graphSeed: 0,
  graphMode: "types",
  graphFlowFile: null,
  renameWidget: null,
  ctxMenu: null,
  editorCtxMenu: null,
  themePicker: null,
  wordWrap: (() => { try { return localStorage.getItem("velvetsharp.wordWrap") === "1"; } catch { return false; } })(),
  autoSave: (() => { try { return localStorage.getItem("velvetsharp.autoSave") !== "0"; } catch { return true; } })(),
  fontSize: (() => {
    try {
      const v = parseFloat(localStorage.getItem("velvetsharp.fontSize") ?? "");
      return Number.isFinite(v) && v >= 9 && v <= 28 ? v : 13.5;
    } catch { return 13.5; }
  })(),
  eol: "\n",

  setFiles: (files) => set({ files }),
  openFile: (path, content) => set((s) => {
    const existing = s.tabs.find((t) => t.path === path);
    if (existing) return { active: path, tabs: s.tabs.map((t) => t.path === path ? { ...t, content } : t) };
    return { tabs: [...s.tabs, { path, content, original: content }], active: path };
  }),
  closeTab: (path) => set((s) => {
    const tabs = s.tabs.filter((t) => t.path !== path);
    const active = s.active === path ? (tabs[tabs.length - 1]?.path ?? null) : s.active;
    return { tabs, active };
  }),
  setActive: (active) => set({ active }),
  updateContent: (path, content) => set((s) => ({
    tabs: s.tabs.map((t) => t.path === path ? { ...t, content } : t),
  })),
  markSaved: (path) => set((s) => ({ tabs: s.tabs.map((t) => t.path === path ? { ...t, original: t.content } : t) })),
  setLoading: (loading) => set({ loading }),
  setStatus: (status) => set({ status }),
  setBrainReady: (brainReady) => set({ brainReady }),
  setUnity: (unityReady, unityLabel) => set({ unityReady, unityLabel }),
  setStats: (stats) => set({ stats }),
  setErrors: (errors) => set({ errors }),
  setError: (error) => set({ error }),
  toggleHideMeta: () => set((s) => ({ hideMeta: !s.hideMeta })),
  setSidebarView: (sidebarView) => set({ sidebarView }),
  setPalette: (palette) => set({ palette }),
  setProjects: (projects, defines) => set({ projects, defines }),
  setActiveAssembly: (activeAssembly) => set({ activeAssembly }),
  setAsmInfo: (asmRefs, asmEngine) => set({ asmRefs, asmEngine }),
  setAsmdefInfo: (asmdefInfo) => set({ asmdefInfo }),
  setProblems: (problems) => set({ problems }),
  toggleProblems: () => set((s) => ({ problemsOpen: !s.problemsOpen })),
  setOutline: (outline) => set({ outline }),
  setPathPrompt: (pathPrompt) => set({ pathPrompt }),
  // opening the graph remembers the script that was active so Call Flow can
  // render it (active becomes "__graph__" while the pseudo-tab is open)
  openGraph: (scope) => set((s) => ({
    graphOpen: true,
    graphScope: scope,
    active: "__graph__",
    graphSeed: Date.now(),
    graphFlowFile: s.active && s.active !== "__graph__" && s.active.endsWith(".cs") ? s.active : s.graphFlowFile,
  })),
  closeGraph: () => set({ graphOpen: false }),
  setGraphScope: (graphScope) => set({ graphScope, graphSeed: Date.now() }),
  setGraphMode: (graphMode) => set({ graphMode, graphSeed: Date.now() }),
  refreshGraph: () => set({ graphSeed: Date.now() }),
  setRenameWidget: (renameWidget) => set({ renameWidget }),
  setCtxMenu: (ctxMenu) => set({ ctxMenu }),
  setEditorCtxMenu: (editorCtxMenu) => set({ editorCtxMenu }),
  setThemePicker: (themePicker) => set({ themePicker }),
  toggleWordWrap: () => set((s) => {
    const wordWrap = !s.wordWrap;
    try { localStorage.setItem("velvetsharp.wordWrap", wordWrap ? "1" : "0"); } catch { /* storage off */ }
    saveConfigField("wordWrap", wordWrap); // v0.7.1: disk mirror
    return { wordWrap };
  }),
  toggleAutoSave: () => set((s) => {
    const autoSave = !s.autoSave;
    try { localStorage.setItem("velvetsharp.autoSave", autoSave ? "1" : "0"); } catch { /* storage off */ }
    saveConfigField("autoSave", autoSave); // v0.7.1: disk mirror
    return { autoSave };
  }),
  setFontSize: (fontSize) => {
    const clamped = Math.max(9, Math.min(28, fontSize));
    if (clamped !== fontSize) fontSize = clamped;
    set({ fontSize });
    try { localStorage.setItem("velvetsharp.fontSize", String(fontSize)); } catch { /* storage off */ }
    saveConfigField("fontSize", fontSize); // v0.7.1: disk mirror
  },
  setEol: (eol) => set({ eol }),
}));

export const activeTab = () => {
  const s = useStore.getState();
  return s.tabs.find((t) => t.path === s.active) ?? null;
};
