/** VelvetSharp v0.7.1 — disk-backed settings store.
 *
 *  WHY (user report: "second launch still shows the theme picker"): the v0.7.0
 *  theme/autosave/root prefs lived ONLY in WebView2 localStorage. If WebView2
 *  cannot write its profile next to the exe (read-only folder, OneDrive-locked
 *  path, portable run from a temp dir) it silently falls back to an IN-MEMORY
 *  profile — every pref evaporates on exit and the first-run picker fires
 *  forever. This module mirrors every setting into a JSON file under the
 *  user's REAL profile dir (%APPDATA%/VelvetSharp/config.json — always
 *  writable), and re-hydrates localStorage from it at boot when a value is
 *  missing. localStorage stays the fast path; disk is the durable copy.
 *
 *  Browser demo: native calls reject → everything degrades to localStorage-only,
 *  exactly like v0.7.0.                                                     */

export interface VelvetConfig {
  theme?: string;
  autoSave?: boolean;
  wordWrap?: boolean;
  fontSize?: number;
  root?: string;
  recents?: string[];
  // Phase 17 — editor QOL prefs + per-workspace open-tab sessions
  minimap?: boolean;
  stickyScroll?: boolean;
  renderWhitespace?: boolean;
  trimTrailing?: boolean;
  sidebarWidth?: number;
  sessions?: Record<string, import("./qol").EditorSession>;
}

/** localStorage key → config field */
const KEY_MAP: Record<string, keyof VelvetConfig> = {
  "velvetsharp.theme": "theme",
  "velvetsharp.autoSave": "autoSave",
  "velvetsharp.wordWrap": "wordWrap",
  "velvetsharp.fontSize": "fontSize",
  "velvetsharp.workspace.root": "root",
  "velvetsharp.workspace.recents": "recents",
};

let dataDir: string | null | undefined; // undefined = not resolved, null = unavailable
let writeChain: Promise<void> = Promise.resolve();
let isDesktopCache: boolean | undefined;

function desktop(): boolean {
  if (isDesktopCache === undefined) {
    isDesktopCache = typeof window !== "undefined" && "NL_PORT" in window;
  }
  return isDesktopCache;
}

/** lazy import keeps the browser bundle free of the bridge unless needed */
async function bridge(): Promise<any> {
  return await import("./nl-bridge");
}

async function resolveDataDir(): Promise<string | null> {
  if (dataDir !== undefined) return dataDir;
  try {
    const { nlCall } = await bridge();
    // %APPDATA% on Windows; XDG config home on Linux
    const base = await nlCall("os.getPath", { name: "data" }, 5000).catch(() => "");
    if (base) {
      dataDir = String(base).replace(/[\\/]+$/, "") + "/VelvetSharp";
      return dataDir;
    }
    const home = await nlCall("os.getPath", { name: "home" }, 5000).catch(() => "");
    if (home) {
      dataDir = String(home).replace(/[\\/]+$/, "") + "/.velvetsharp";
      return dataDir;
    }
  } catch { /* not desktop */ }
  dataDir = null;
  return dataDir;
}

export async function readDiskConfig(): Promise<VelvetConfig | null> {
  if (!desktop()) return null;
  const dir = await resolveDataDir();
  if (!dir) return null;
  try {
    const { nlCall } = await bridge();
    const raw = await nlCall("filesystem.readFile", { path: `${dir}/config.json` }, 6000);
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed as VelvetConfig : null;
  } catch {
    return null; // missing/corrupt config = first run, not an error
  }
}

/** merge-persist one field. Serialized through writeChain so concurrent saves
 *  can't read-modify-write over each other. Fire-and-forget by design. */
export function saveConfigField<K extends keyof VelvetConfig>(field: K, value: VelvetConfig[K]): void {
  if (!desktop()) return;
  writeChain = writeChain.then(async () => {
    try {
      const dir = await resolveDataDir();
      if (!dir) return;
      const { nlCall } = await bridge();
      const cur = (await readDiskConfig()) ?? {};
      cur[field] = value;
      await nlCall("filesystem.createDirectory", { path: dir }, 6000).catch(() => { /* exists */ });
      await nlCall("filesystem.writeFile", { path: `${dir}/config.json`, data: JSON.stringify(cur, null, 2) }, 6000);
    } catch { /* disk prefs are best-effort; localStorage remains */ }
  });
}

/** generic localStorage setter that ALSO mirrors to disk (drop-in for prefs) */
export function saveSetting(lsKey: string, value: string): void {
  try { localStorage.setItem(lsKey, value); } catch { /* storage off */ }
  const field = KEY_MAP[lsKey];
  if (field) saveConfigField(field, value as any);
}

/** boot-time hydration: disk fills in ONLY the values localStorage is missing,
 *  so the current session's explicit choices always win over the durable copy. */
export async function hydrateConfigFromDisk(): Promise<VelvetConfig | null> {
  const cfg = await readDiskConfig();
  if (!cfg) return null;
  const put = (lsKey: string, raw: string) => {
    try {
      if (!localStorage.getItem(lsKey)) localStorage.setItem(lsKey, raw);
    } catch { /* storage off */ }
  };
  if (cfg.theme) put("velvetsharp.theme", String(cfg.theme));
  if (typeof cfg.autoSave === "boolean") put("velvetsharp.autoSave", cfg.autoSave ? "1" : "0");
  if (typeof cfg.wordWrap === "boolean") put("velvetsharp.wrap", cfg.wordWrap ? "1" : "0");
  if (typeof cfg.fontSize === "number") put("velvetsharp.fontSize", String(cfg.fontSize));
  if (cfg.root) put("velvetsharp.workspace.root", String(cfg.root));
  if (Array.isArray(cfg.recents)) put("velvetsharp.workspace.recents", JSON.stringify(cfg.recents.slice(0, 5)));
  // Phase 17 — QOL prefs hydrate the same way (localStorage wins when present)
  if (typeof cfg.minimap === "boolean") put("velvetsharp.minimap", cfg.minimap ? "1" : "0");
  if (typeof cfg.stickyScroll === "boolean") put("velvetsharp.stickyScroll", cfg.stickyScroll ? "1" : "0");
  if (typeof cfg.renderWhitespace === "boolean") put("velvetsharp.renderWhitespace", cfg.renderWhitespace ? "1" : "0");
  if (typeof cfg.trimTrailing === "boolean") put("velvetsharp.trimTrailing", cfg.trimTrailing ? "1" : "0");
  if (typeof cfg.sidebarWidth === "number") put("velvetsharp.sidebarWidth", String(Math.max(170, Math.min(520, cfg.sidebarWidth))));
  (window as any).__vsConfig = cfg; // Phase 17 — session map reads this directly
  return cfg;
}

/** where is the config file? (shown in the settings modal) */
export async function configFilePath(): Promise<string> {
  const dir = await resolveDataDir();
  return dir ? `${dir}/config.json` : "";
}

/* ----------------------- Phase 14 — MCP discovery -----------------------
 * AI agents talk to the RUNNING editor through mcp/server.mjs, which needs
 * to find the Neutralino server (the port is random — "port": 0). The editor
 * publishes its connection info here at boot; the proxy reads the same file. */

export interface McpDiscovery {
  port: number;
  pid?: number;
  phase?: number;
  root?: string;
  /** FULL shared auth token (JWT) — the WS url uses its payload segment as
   *  ?connectToken=, native calls carry it whole as accessToken.
   *  /__neutralino_globals.js is one-shot, so the MCP proxy cannot fetch its
   *  own; the editor shares its session token. Localhost-only. */
  token?: string;
  at: number;
}

/** path of the discovery file (same dir as config.json) */
export async function mcpDiscoveryPath(): Promise<string> {
  const dir = await resolveDataDir();
  return dir ? `${dir}/mcp.json` : "";
}

/** publish {port, pid, root} so the stdio MCP proxy can reach this editor.
 *  Serialized through writeChain like every other disk write. Fire-and-forget. */
export function writeMcpDiscovery(info: Omit<McpDiscovery, "at">): void {
  if (!desktop()) return;
  writeChain = writeChain.then(async () => {
    try {
      const dir = await resolveDataDir();
      if (!dir) return;
      const { nlCall } = await bridge();
      await nlCall("filesystem.createDirectory", { path: dir }, 6000).catch(() => { /* exists */ });
      await nlCall("filesystem.writeFile", { path: `${dir}/mcp.json`, data: JSON.stringify({ ...info, at: Date.now() }, null, 2) }, 6000);
    } catch { /* discovery is best-effort; the proxy has --port as a fallback */ }
  });
}
