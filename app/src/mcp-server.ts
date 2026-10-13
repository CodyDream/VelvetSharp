/** VelvetSharp Phase 14 — MCP page-side dispatcher.
 *
 *  WHY: the user wants OTHER AI agents to talk to the running editor — "return
 *  what kind of syntax errors or another problems or warnings of this project
 *  so ai those fixing could be automated" + project structure + code search.
 *
 *  HOW: MCP (Model Context Protocol) agents spawn a stdio server. Neutralino's
 *  built-in server cannot host custom HTTP routes, so mcp/server.mjs (the
 *  process agents spawn) connects to the SAME Neutralino WebSocket the editor
 *  uses and the two talk over `events.broadcast`:
 *
 *      agent ──stdio──▶ server.mjs ──ws broadcast──▶ THIS dispatcher
 *                     ◀── vsMcpResponse broadcast ──┘
 *
 *  The dispatcher answers from LIVE editor state: the Problems bar (including
 *  unsaved buffers' diagnostics), the workspace file list, the brain search
 *  (same engine as Ctrl+Shift+F) and disk/buffer file contents.
 *
 *  Discovery: the proxy finds this editor via <dataDir>/VelvetSharp/mcp.json
 *  ({port, pid, root} — written at boot; the Neutralino port is random).
 *
 *  Browser demo: every native call no-ops → the MCP layer simply never starts.
 */

import { useStore } from "./store";
import { getAdapter } from "./adapters";
import { writeMcpDiscovery, mcpDiscoveryPath } from "./configStore";
import { onBridgeEvent, nlCall, getConnectToken } from "./nl-bridge";
import { formatProblems, buildStructure, formatSearch, formatFileContent } from "./mcp-tools";
import { APP_PHASE, APP_BUILD } from "./version";
import type { ProblemItem } from "./store";
import type { BrainClient } from "./brain-client";

export const MCP_TOOL_NAMES = [
  "get_problems",
  "get_project_structure",
  "search_code",
  "get_file",
  "get_workspace_summary",
] as const;

/** tool descriptions — mirrored in mcp/README.md and tools/list */
export const MCP_TOOL_DESCRIPTIONS: Record<string, string> = {
  get_problems: "Get the current project problems (syntax errors, semantic warnings, obsolete-API usage) exactly as VelvetSharp's Problems bar shows them, including unsaved editor buffers. Returns compiler-style rows: file(line,col): SEVERITY CODE: message.",
  get_project_structure: "Get the workspace file tree (Unity project scripts and assets known to the editor). Optional folder filter scopes the tree to a subfolder.",
  search_code: "Search code across the whole project — the same engine as the editor's Ctrl+Shift+F find-in-files. Supports literal, whole-word and regular-expression queries, case sensitivity, and a result cap. Returns path:line:col plus the matched source line.",
  get_file: "Read a workspace file's content (optionally one line range). Prefers the live editor buffer when the file is open with unsaved changes and flags that in the response.",
  get_workspace_summary: "One-shot overview: workspace root, file/script counts, error/warning totals, assemblies, Unity API status, VelvetSharp phase — the first thing an agent should call.",
};

/** max characters of any single text payload on the wire */
const MAX_TEXT = 200_000;
/** hard ceiling for one tool call (search uses the fast lane's own 5 s too) */
const TOOL_TIMEOUT_MS = 20_000;

let listening = false;
let lastError = "";
let publishedRoot: string | undefined;
let publishedToken = "";

export interface McpStatus {
  listening: boolean;
  port: number | null;
  pid: number | null;
  root: string | null;
  discoveryPath: string | null;
  tools: string[];
  lastError: string;
}

function problemRows(items: ProblemItem[]): any[] {
  return items.map((p) => ({ ...p }));
}

function clip(text: string): string {
  return text.length <= MAX_TEXT ? text : text.slice(0, MAX_TEXT) + `\n… (truncated at ${MAX_TEXT} characters)`;
}

function relPathSafe(p: string): string | null {
  const norm = String(p ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || /^[a-zA-Z]:/.test(p ?? "") || p?.startsWith("/") || p?.startsWith("\\\\")) return null;
  const parts = norm.split("/");
  if (parts.some((seg) => seg === "..")) return null;
  return norm;
}

async function dispatchTool(tool: string, args: any): Promise<any> {
  const st = useStore.getState();
  const adapter = getAdapter();
  switch (tool) {
    case "get_problems": {
      const severity = String(args?.severity ?? "all");
      const max = Number(args?.max ?? 1000);
      const payload = formatProblems(problemRows(st.problems) as any, { severity, max });
      return {
        ...payload,
        analyzedNote: "problems cover every script VelvetSharp has analyzed this session (all scripts after the background sweep finishes)",
      };
    }
    case "get_project_structure": {
      const folder = args?.folder ? relPathSafe(String(args.folder)) : undefined;
      if (args?.folder && !folder) throw new Error(`folder must be a relative path inside the workspace (got "${args.folder}")`);
      const payload = buildStructure(st.files, { folder, max: Number(args?.max ?? 2000) });
      return { ...payload, root: adapter.root || null, folder: folder ?? null };
    }
    case "search_code": {
      const query = String(args?.query ?? "");
      if (!query) throw new Error("query is required");
      const client = (window as any).__client as BrainClient | undefined;
      if (!client) throw new Error("brain engine is not ready yet");
      const res = await client.searchProject(query, {
        regex: !!args?.regex,
        caseSensitive: !!args?.caseSensitive,
        wholeWord: !!args?.wholeWord,
        max: Math.min(2000, Math.max(1, Number(args?.max ?? 200))),
      });
      const fmt = formatSearch(res.hits, {
        query,
        max: res.max,
        unsearched: res.unsearched,
        truncated: res.truncated,
      });
      return { ...fmt, unsearched: res.unsearched, error: res.error };
    }
    case "get_file": {
      const rel = relPathSafe(String(args?.path ?? ""));
      if (!rel) throw new Error(`path must be a relative path inside the workspace (got "${args?.path}")`);
      const fromLine = args?.fromLine ? Math.max(1, Number(args.fromLine)) : undefined;
      const toLine = args?.toLine ? Math.max(1, Number(args.toLine)) : undefined;
      const tab = st.tabs.find((t) => t.path === rel);
      if (tab && tab.content !== tab.original) {
        return { ...formatFileContent(rel, tab.content, { fromLine, toLine, unsaved: true }), source: "editor-buffer" };
      }
      const content = await adapter.read(rel);
      return { ...formatFileContent(rel, content, { fromLine, toLine }), source: "disk" };
    }
    case "get_workspace_summary": {
      const errors = st.problems.filter((p) => p.severity === "error").length;
      const warnings = st.problems.filter((p) => p.severity === "warning" || p.severity === "info").length;
      const cs = st.files.filter((f) => f.endsWith(".cs")).length;
      const lines = [
        `VelvetSharp Phase ${APP_PHASE} (build ${APP_BUILD}) — workspace report`,
        `root: ${adapter.root || "(browser demo)"}`,
        `files: ${st.files.length} known (${cs} C# scripts)`,
        `problems: ${errors} errors, ${warnings} warnings/infos (get_problems for the rows)`,
        `assemblies: ${st.projects.map((p) => p.name).join(", ") || "(none detected)"}`,
        `unity api: ${st.unityReady ? st.unityLabel : "unavailable"}`,
        `brain: ${st.brainReady ? `ready — ${st.stats.files} files, ${st.stats.types} types indexed` : "booting"}`,
      ];
      return { text: lines.join("\n") };
    }
    default:
      throw new Error(`unknown tool "${tool}" — available: ${MCP_TOOL_NAMES.join(", ")}`);
  }
}

async function handleRequest(data: any): Promise<void> {
  const id = data?.id;
  if (id == null) return;
  let ok = true;
  let result: any;
  let error: string | undefined;
  try {
    result = await Promise.race([
      dispatchTool(String(data.tool ?? ""), data.args ?? {}),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`tool "${data.tool}" timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)),
    ]);
  } catch (e: any) {
    ok = false;
    error = String(e?.message ?? e);
    lastError = error;
  }
  if (result && typeof result.text === "string") result = { ...result, text: clip(result.text) };
  try {
    await nlCall("events.broadcast", { event: "vsMcpResponse", data: { id, ok, result, error } }, 8000);
  } catch (e: any) {
    lastError = `broadcast failed: ${String(e?.message ?? e)}`;
  }
}

/** publish connection info for the stdio proxy (boot + whenever root changes)
 *  Includes the shared localhost connect token — /__neutralino_globals.js is
 *  one-shot, so the proxy cannot fetch its own after the page took the first. */
export async function refreshMcpDiscovery(): Promise<void> {
  try {
    if (typeof window === "undefined" || !("NL_PORT" in window)) return;
    const port = Number((window as any).NL_PORT);
    const pid = Number.isFinite(Number((window as any).NL_PID)) ? Number((window as any).NL_PID) : undefined;
    const root = getAdapter().root || undefined;
    const token = getConnectToken();
    if (publishedRoot === root && listening && publishedToken === token) return; // nothing changed
    publishedRoot = root;
    publishedToken = token;
    writeMcpDiscovery({ port, pid, phase: APP_PHASE, root, token });
  } catch { /* best-effort */ }
}

/** start listening for MCP requests (desktop only; idempotent) */
export function startMcpServer(): void {
  try {
    if (listening) return;
    if (typeof window === "undefined" || !("NL_PORT" in window)) return; // browser demo
    listening = true;
    onBridgeEvent("vsMcpRequest", (data: any) => { void handleRequest(data); });
    void refreshMcpDiscovery();
    void mcpDiscoveryPath().then((p) => { (window as any).__vsMcpDiscoveryPath = p || null; });
    // debug/test surface (E2E drives tools through this without a WS hop)
    (window as any).__vsMcp = {
      status: (): McpStatus => ({
        listening,
        port: Number((window as any).NL_PORT) || null,
        pid: Number((window as any).NL_PID) || null,
        root: getAdapter().root || null,
        discoveryPath: (window as any).__vsMcpDiscoveryPath ?? null,
        tools: [...MCP_TOOL_NAMES],
        lastError,
      }),
      dispatch: (tool: string, args: any) => dispatchTool(tool, args),
    };
  } catch (e: any) {
    lastError = String(e?.message ?? e);
  }
}
