/** VelvetSharp — workspace adapters: browser (demo), Tauri, Neutralino (portable exe) */

/* v0.7.1 BRIDGE REPLACEMENT: the stock @neutralinojs/lib client never reconnects
 * its WebSocket and silently queues native calls forever after any disconnect —
 * the root cause of "file open does nothing / disk reads take forever" on
 * Windows. ./nl-bridge speaks the same protocol with timeouts, auto-reconnect,
 * 127.0.0.1 dialing and token recovery. Same call surface, zero API changes. */
import * as nl from "./nl-bridge";
import { connectBridge } from "./nl-bridge";
import { saveSetting } from "./configStore"; // v0.7.1: prefs survive ephemeral WebView2 storage

export interface WorkspaceAdapter {
  name: string;
  root: string;
  listFiles(onProgress?: (n: number) => void): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** v0.6.0: rename/move a file on disk (desktop only; used by F2 class rename) */
  move?(from: string, to: string): Promise<void>;
  /** v0.7.0: create a folder (rel path) */
  mkdir?(rel: string): Promise<void>;
  /** v0.7.0: delete a file OR a whole folder (rel path) */
  remove?(rel: string, isDir: boolean): Promise<void>;
  /** v0.7.0: rename/move within the workspace (rel paths) */
  rename?(rel: string, newRel: string): Promise<void>;
  /** desktop only: pick a new workspace root via native dialog; resolves true when changed (caller should reload) */
  pickFolder?(): Promise<boolean>;
  /** desktop only: set root programmatically after validating; resolves false when the path is not a folder */
  setRoot?(path: string): Promise<boolean>;
  /** desktop only: check a path exists and is a directory (for typed-path fallbacks) */
  isDir?(path: string): Promise<boolean>;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const isNeutralino = typeof window !== "undefined" && "NL_PORT" in window;

export const isDesktop = isTauri || isNeutralino;

export function getAdapter(): WorkspaceAdapter {
  if (isNeutralino) return neutralinoAdapter;
  if (isTauri) return tauriAdapter;
  return browserAdapter;
}

/** One-time native shell init (Neutralino). No-op in the browser / Tauri. */
let platformInitDone = false;
export function initPlatform(): void {
  if (!isNeutralino || platformInitDone) return;
  platformInitDone = true;
  connectBridge(); // v0.7.1: self-healing socket — replaces nl.init()'s one-shot dial
  nl.events.on("windowClose", async () => {
    try { await nl.app.exit(); } catch { /* already exiting */ }
  });
  // support diagnostics: raw native bridge probes for the dev console
  (window as any).__nl = {
    getStats: (p: string) => nl.filesystem.getStats(p),
    readFile: (p: string) => nl.filesystem.readFile(p),
    readDirectory: (p: string) => nl.filesystem.readDirectory(p),
  };
}

/** last path segment, tolerant of both separators */
export function baseName(p: string): string {
  const parts = String(p ?? "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p ?? "");
}

/* --------------------------- browser (demo) --------------------------- */

let manifest: string[] | null = null;

export const browserAdapter: WorkspaceAdapter = {
  name: "browser-demo",
  root: "DemoUnityProject",
  async listFiles() {
    if (!manifest) {
      const res = await fetch("./demo/manifest.json");
      manifest = await res.json();
    }
    return manifest;
  },
  async read(path) {
    const res = await fetch("./demo/" + path);
    return res.text();
  },
  async write(_path, _content) {
    // browser demo is read-only on disk; edits persist in memory for the session
  },
  async mkdir(_rel) {
    throw new Error("the demo workspace is read-only — open a real project folder");
  },
  async remove(_rel, _isDir) {
    throw new Error("the demo workspace is read-only — open a real project folder");
  },
  async rename(_rel, _newRel) {
    throw new Error("the demo workspace is read-only — open a real project folder");
  },
};

/* ----------------------------- Tauri (real fs) ----------------------------- */

const tauriInvoke: any = (window as any).__TAURI_INTERNALS__?.invoke;

export const tauriAdapter: WorkspaceAdapter = {
  name: "tauri-fs",
  root: "",
  async listFiles() {
    const files = await tauriInvoke("scan_workspace");
    return files as string[];
  },
  async read(path) {
    return (await tauriInvoke("read_text_file", { path })) as string;
  },
  async write(path, content) {
    await tauriInvoke("write_text_file", { path, content });
  },
};

/* ------------------------ Neutralino (portable exe) ------------------------ */
/* Mirrors the Rust scan semantics: same extension allowlist, same
   machine-generated-folder skips, same 2 MB per-file cap and 20k file budget.
   The size cap is enforced lazily at READ time — scanning stays O(dirs)
   WebSocket round-trips so big Unity projects don't look frozen. */

const TEXT_EXT = new Set([
  "cs", "txt", "json", "md", "xml", "yaml", "yml", "shader", "asmdef", "asset", "prefab", "unity",
  "csproj", // needed for auto-detection & auto-configuration of Unity assemblies
]);
const SKIP_DIRS = new Set([
  "Library", "Temp", "Obj", "obj", "Bin", "bin", "Logs", "UserSettings",
  "node_modules", ".git", ".vs", ".idea", "Builds", "Build", "dist", "target",
]);
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db"]);
const SCAN_BUDGET = 20_000;             // generous cap for very large projects
const MAX_FILE_BYTES = 2 * 1024 * 1024; // huge generated assets are rejected at read time
const MAX_DEPTH = 14;                   // symlink-loop insurance

function normRoot(p: unknown): string {
  const s = String(p ?? "").trim().replace(/\\/g, "/");
  return s.replace(/\/+$/, "") || s;
}
function joinPath(root: string, rel: string): string {
  if (!root) return rel;
  return root.replace(/\/+$/, "") + "/" + rel;
}

const VS_ROOT_KEY = "velvetsharp.workspace.root";
const VS_RECENTS_KEY = "velvetsharp.workspace.recents";
let currentRoot = "";
let rootResolved = false;

export function getRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(VS_RECENTS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.map(normRoot).filter(Boolean).slice(0, 5) : [];
  } catch { return []; }
}
function pushRecent(p: string): void {
  try {
    const list = getRecents().filter((x) => x.toLowerCase() !== p.toLowerCase());
    list.unshift(p);
    saveSetting(VS_RECENTS_KEY, JSON.stringify(list.slice(0, 5))); // v0.7.1: also mirrored to disk
  } catch { /* storage off */ }
}

/* --------------------------- root resolution --------------------------- */
/* Priority:
   1. command line  — VelvetSharp.exe D:\Projects\MyGame  |  --project=D:\Projects\MyGame
   2. saved root    — localStorage, but ONLY if it still exists on disk
                      (a stale root must never lock the workspace empty)
   3. NL_CWD if it looks like a Unity project (contains Assets/ + ProjectSettings/)
      — covers "I dropped the exe into my project folder and ran it"
   4. plain NL_CWD                                                  */

async function nlIsDir(p: string): Promise<boolean> {
  if (!p) return false;
  try {
    const st: any = await nl.filesystem.getStats(p);
    return st?.isDirectory === true || String(st?.type ?? "") === "DIRECTORY";
  } catch { return false; }
}

async function looksLikeUnityProject(dir: string): Promise<boolean> {
  if (!dir) return false;
  return (await nlIsDir(joinPath(dir, "Assets"))) && (await nlIsDir(joinPath(dir, "ProjectSettings")));
}

/** absolute-looking path on either OS (Windows drive letter or POSIX root) */
function looksAbsPath(s: string): boolean {
  return /^[a-z]:[\\/]/i.test(s) || (s.startsWith("/") && s.length > 1);
}

function cliProjectPath(): string {
  const args: string[] = ((window as any).NL_ARGS ?? []) as string[];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] ?? "");
    const m = /^--project=(.+)$/i.exec(a);
    if (m) {
      if (looksAbsPath(m[1])) return normRoot(m[1]);
      continue;
    }
    if (a.startsWith("--")) continue;      // other framework flags
    if (i === 0) continue;                 // argv[0]: the exe path itself
    if (looksAbsPath(a)) return normRoot(a);
  }
  return "";
}

async function resolveRoot(): Promise<string> {
  if (rootResolved) return currentRoot;
  rootResolved = true;

  // 1) command line
  const cli = cliProjectPath();
  if (cli && (await nlIsDir(cli))) {
    currentRoot = cli;
    saveSetting(VS_ROOT_KEY, cli); // v0.7.1: also mirrored to disk
    return currentRoot;
  }

  // 2) saved root, validated against disk
  let saved = "";
  try { saved = normRoot(localStorage.getItem(VS_ROOT_KEY) ?? ""); } catch { /* storage off */ }
  if (saved && (await nlIsDir(saved))) {
    currentRoot = saved;
    return currentRoot;
  }
  // stale saved root — drop it so the first-run flow can kick in
  if (saved) {
    try { localStorage.removeItem(VS_ROOT_KEY); } catch { /* storage off */ }
  }

  // 3) CWD that IS a Unity project
  const cwd = normRoot((window as any).NL_CWD ?? "");
  if (cwd && (await looksLikeUnityProject(cwd))) {
    currentRoot = cwd;
    saveSetting(VS_ROOT_KEY, cwd); // v0.7.1: also mirrored to disk
    return currentRoot;
  }

  // 4) plain CWD
  currentRoot = cwd;
  return currentRoot;
}

/* ------------------------------ scanning ------------------------------ */

interface ScanTask { abs: string; rel: string; depth: number }

async function scanWorkspace(root: string, onProgress?: (n: number) => void): Promise<string[]> {
  const out: string[] = [];
  let budget = SCAN_BUDGET;
  let lastTick = 0;
  const stack: ScanTask[] = [{ abs: root, rel: "", depth: 0 }];
  while (stack.length && budget > 0) {
    const { abs, rel, depth } = stack.pop()!;
    let entries: any[];
    try {
      entries = await nl.filesystem.readDirectory(abs);
    } catch { continue; } // unreadable dir — skip
    for (const e of entries) {
      const name = String(e?.entry ?? (typeof e === "string" ? e : baseName(String(e?.path ?? ""))));
      if (!name || name === "." || name === "..") continue;
      const type: string | undefined = typeof e === "string" ? undefined : e?.type;
      const isDir = type === "DIRECTORY";
      const childRel = rel ? rel + "/" + name : name;
      if (isDir) {
        if (SKIP_DIRS.has(name) || name.startsWith(".") || depth >= MAX_DEPTH) continue;
        stack.push({ abs: joinPath(root, childRel), rel: childRel, depth: depth + 1 });
      } else if (type === "FILE" || typeof e === "string") {
        if (SKIP_FILES.has(name)) continue;
        const dot = name.lastIndexOf(".");
        const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
        // .meta sidecars are noise EXCEPT .asmdef.meta — that tiny YAML carries the
        // assembly GUID the "assembly hunting" needs to resolve asmdef references
        if (ext === "meta") {
          if (!name.toLowerCase().endsWith(".asmdef.meta")) continue;
        } else if (!TEXT_EXT.has(ext)) continue;
        out.push(childRel);
        if (--budget === 0) break;
        if (onProgress && out.length - lastTick >= 250) {
          lastTick = out.length;
          onProgress(out.length);
        }
      }
    }
  }
  out.sort();
  return out;
}

async function ensureParentDir(abs: string): Promise<void> {
  const parts = abs.split("/").filter(Boolean);
  if (parts.length <= 1) return;
  let cur = (abs.startsWith("/") ? "/" : "") + parts[0];
  for (let i = 1; i < parts.length - 1; i++) {
    cur += "/" + parts[i];
    try { await nl.filesystem.createDirectory(cur); } catch { /* exists or unwritable — the final write surfaces real errors */ }
  }
}

export const neutralinoAdapter: WorkspaceAdapter = {
  name: "neutralino-fs",
  root: "",
  async listFiles(onProgress) {
    const root = await resolveRoot();
    this.root = root;
    if (!root) return [];
    return scanWorkspace(root, onProgress);
  },
  async read(path) {
    const abs = joinPath(await resolveRoot(), path);
    // v0.7.1: stats + read now run CONCURRENTLY — opening a file costs one
    // round-trip of latency instead of two, and the 2 MB text guard still holds.
    const statP: Promise<any> = nl.filesystem.getStats(abs).catch(() => null);
    const readP = nl.filesystem.readFile(abs);
    const st: any = await statP;
    const size = Number(st?.size ?? 0);
    if (size > MAX_FILE_BYTES) {
      readP.catch(() => { /* the oversized read is discarded on purpose */ });
      throw new Error(`"${path}" is ${(size / 1048576).toFixed(1)} MB — too large to open as text`);
    }
    return await readP;
  },
  async write(path, content) {
    const abs = joinPath(await resolveRoot(), path);
    await ensureParentDir(abs);
    await nl.filesystem.writeFile(abs, content);
  },
  async move(from, to) {
    const root = await resolveRoot();
    const absFrom = joinPath(root, from);
    const absTo = joinPath(root, to);
    await ensureParentDir(absTo);
    await nl.filesystem.move(absFrom, absTo);
  },
  async mkdir(rel) {
    const abs = joinPath(await resolveRoot(), rel);
    await ensureParentDir(abs);
    try { await nl.filesystem.createDirectory(abs); } catch (e: any) {
      // Neutralino errors when the folder already exists — fine for idempotency
      if (!(await nlIsDir(abs))) throw e;
    }
  },
  async remove(rel, isDir) {
    const root = await resolveRoot();
    const abs = joinPath(root, rel);
    try {
      await nl.filesystem.remove(abs);
      return;
    } catch (e: any) {
      if (!isDir) throw e;
      // directory fallback: remove() may refuse non-empty dirs on some builds —
      // walk it depth-first and delete children then the folder itself
      const walk = async (dir: string) => {
        let entries: any[] = [];
        try { entries = await nl.filesystem.readDirectory(dir); } catch { return; }
        for (const ent of entries) {
          const name = String(ent?.entry ?? "");
          if (!name || name === "." || name === "..") continue;
          const child = dir + "/" + name;
          if (ent?.type === "DIRECTORY") await walk(child);
          else { try { await nl.filesystem.remove(child); } catch { /* best effort */ } }
        }
        try { await nl.filesystem.remove(dir); } catch { /* best effort */ }
      };
      await walk(abs);
    }
  },
  async rename(rel, newRel) {
    const root = await resolveRoot();
    const absFrom = joinPath(root, rel);
    const absTo = joinPath(root, newRel);
    await ensureParentDir(absTo);
    await nl.filesystem.move(absFrom, absTo);
  },
  async isDir(path) {
    return await nlIsDir(normRoot(path));
  },
  async setRoot(path) {
    const p = normRoot(path);
    if (!p || !(await nlIsDir(p))) return false;
    currentRoot = p;
    rootResolved = true;
    this.root = p;
    saveSetting(VS_ROOT_KEY, p); // v0.7.1: also mirrored to disk
    pushRecent(p);
    return true;
  },
  async pickFolder() {
    // raise our window first — on Windows the native dialog is owned by it and
    // can otherwise open behind the main window and look "broken"
    try { await nl.window.focus(); } catch { /* window.* may be restricted */ }
    const picked = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("folder dialog timed out")), 120_000);
      nl.os.showFolderDialog("Select your Unity project folder")
        .then((v: string) => { clearTimeout(t); resolve(String(v ?? "")); })
        .catch((err: any) => { clearTimeout(t); reject(err instanceof Error ? err : new Error(String(err?.message ?? err))); });
    });
    const p = normRoot(picked);
    if (!p) return false; // user cancel
    const ok = await this.setRoot!(p);
    if (!ok) throw new Error(`picked folder is not accessible: ${p}`);
    return true;
  },
};
