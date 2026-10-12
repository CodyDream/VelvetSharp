/** VelvetSharp — per-project startup cache (v0.5.0).
 *
 *  Lives NEXT TO THE EXE in  <exe folder>/projects/<project-slug>/cache.json
 *  so a warm start skips disk reads + tree-sitter parsing for every unchanged
 *  script. External modifications are detected with size+mtime fingerprints —
 *  touched files are re-read and re-parsed, removed files dropped, new files
 *  indexed. Desktop (Neutralino) only; browser/Tauri run cache-less. */

import * as nl from "./nl-bridge"; // v0.7.1: self-healing bridge (was @neutralinojs/lib)

export interface FileFingerprint { size: number; mtime: number }

export interface ProjectCache {
  version: number;
  root: string;
  generatedAt: number;
  scan: string[];                            // rel paths of the last scan
  fileHashes: Record<string, FileFingerprint>; // rel .cs/.csproj/.asmdef path → fingerprint
  csprojs: unknown[];                        // parsed CsprojInfo[]
  asmdefs: unknown[];                        // parsed AsmdefInfo[] (with guid)
  symbols: Record<string, unknown>;          // rel .cs path → FileSymbols
}

export const CACHE_VERSION = 8; // v0.6.1: file-scoped namespaces + partial flags in symbols

export function cacheEnabled(): boolean {
  return typeof window !== "undefined" && "NL_PORT" in window;
}

function normRoot(p: string): string {
  return String(p ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** stable short hash (djb2) */
function hash8(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** <exe folder>/projects/<slug>/ — one sub-folder per project root */
export function cacheDirFor(root: string): string {
  const base = normRoot(root).split("/").pop() ?? "project";
  const safe = base.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 48) || "project";
  const appPath = normRoot((window as any).NL_PATH ?? "");
  if (!appPath) return "";
  return `${appPath}/projects/${safe}-${hash8(normRoot(root).toLowerCase())}`;
}

export async function readCache(root: string): Promise<ProjectCache | null> {
  if (!cacheEnabled() || !root) return null;
  try {
    const dir = cacheDirFor(root);
    if (!dir) return null;
    const raw = await nl.filesystem.readFile(`${dir}/cache.json`);
    const j = JSON.parse(raw);
    if (!j || j.version !== CACHE_VERSION || normRoot(j.root) !== normRoot(root)) return null;
    if (!j.fileHashes || typeof j.fileHashes !== "object") return null;
    return j as ProjectCache;
  } catch {
    return null; // no cache / unreadable / version bump — cold start
  }
}

export async function writeCache(root: string, data: ProjectCache): Promise<void> {
  if (!cacheEnabled() || !root) return;
  try {
    const dir = cacheDirFor(root);
    if (!dir) return;
    try { await nl.filesystem.createDirectory(dir); } catch { /* exists */ }
    await nl.filesystem.writeFile(`${dir}/cache.json`, JSON.stringify(data));
  } catch {
    // cache write failures must never break the app — silently skip
  }
}

export async function clearCache(root: string): Promise<void> {
  if (!cacheEnabled() || !root) return;
  try {
    const dir = cacheDirFor(root);
    if (dir) await nl.filesystem.writeFile(`${dir}/cache.json`, JSON.stringify({ version: 0 }));
  } catch { /* best effort */ }
}

const join = (root: string, rel: string) => `${normRoot(root)}/${rel}`;

/** fingerprint many files with batched getStats (32 concurrent) */
export async function statFiles(root: string, rels: string[], onProgress?: (done: number) => void): Promise<Record<string, FileFingerprint>> {
  const out: Record<string, FileFingerprint> = {};
  const CHUNK = 32;
  let done = 0;
  for (let i = 0; i < rels.length; i += CHUNK) {
    const chunk = rels.slice(i, i + CHUNK);
    const results = await Promise.allSettled(chunk.map(async (rel) => {
      const st: any = await nl.filesystem.getStats(join(root, rel));
      const size = Number(st?.size ?? 0);
      const mtime = Number(st?.modifiedAt ?? st?.mtimeMs ?? st?.mtime ?? st?.lastModified ?? 0);
      return { rel, fp: { size, mtime } };
    }));
    for (const r of results) {
      if (r.status === "fulfilled") out[r.value.rel] = r.value.fp;
    }
    done += chunk.length;
    onProgress?.(done);
  }
  return out;
}

/** same fingerprint, but for files whose fresh stats we already know are stale */
export function fingerprintChanged(a: FileFingerprint | undefined, b: FileFingerprint | undefined): boolean {
  if (!a || !b) return true;
  return a.size !== b.size || a.mtime !== b.mtime;
}
