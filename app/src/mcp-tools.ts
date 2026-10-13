/** VelvetSharp Phase 14 — MCP tool payload formatters (PURE — zero imports).
 *
 *  The Model Context Protocol layer (mcp/server.mjs + mcp-server.ts) lets
 *  AI agents (Claude, Cursor, Cline, …) ask the RUNNING editor for problems,
 *  project structure, code search and file contents — so an agent can read
 *  what VelvetSharp sees and then fix it in its own tooling.
 *
 *  Everything in this module is a pure function over plain data so the engine
 *  test-suite (scripts/test-brain.ts) can lock the wire format down without a
 *  DOM, a worker, or a live editor. The page-side dispatcher in mcp-server.ts
 *  feeds store/worker state in, these functions shape what goes on the wire.
 *
 *  Formatting contract (stable — agents parse it):
 *    - problems  → "path(line,col): severity [CODE]: message" (1-based, like
 *      compiler output; path is POSIX relative to the workspace root)
 *    - structure → indented tree, dirs first, alphabetical, counts in header
 *    - search    → "path:line:col: trimmed line text" grouped by file
 */

/** one problem row as seen by the MCP layer (mirror of the Problems bar) */
export interface McpProblem {
  path: string;
  line: number;      // 0-based internally
  col: number;       // 0-based internally
  length: number;
  message: string;
  severity: "error" | "warning" | "info" | string;
  source: string;
  code?: string;     // Phase 14 — compiler-style code (CS0219 …) when known
}

export interface ProblemsPayload {
  summary: { errors: number; warnings: number; infos: number; total: number };
  problems: { file: string; line: number; col: number; severity: string; code?: string; message: string; source: string }[];
  text: string;
}

const posix = (p: string): string => p.replace(/\\/g, "/");

/** toMcpProblem — normalize one Problems-bar row for the wire (1-based coords). */
export function toMcpProblem(p: McpProblem): ProblemsPayload["problems"][number] {
  const out: ProblemsPayload["problems"][number] = {
    file: posix(p.path),
    line: (p.line ?? 0) + 1,
    col: (p.col ?? 0) + 1,
    severity: String(p.severity ?? "error"),
    message: String(p.message ?? ""),
    source: String(p.source ?? "velvetsharp"),
  };
  if (p.code) out.code = p.code;
  return out;
}

/** formatProblems — full payload for the get_problems tool. */
export function formatProblems(items: McpProblem[], opts: { severity?: string; max?: number } = {}): ProblemsPayload {
  const max = Math.max(1, opts.max ?? 1000);
  const filtered = opts.severity && opts.severity !== "all"
    ? items.filter((p) => p.severity === opts.severity)
    : items;
  const rank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const sorted = [...filtered].sort((a, b) =>
    (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)
    || posix(a.path).localeCompare(posix(b.path))
    || (a.line ?? 0) - (b.line ?? 0));
  const rows = sorted.slice(0, max).map(toMcpProblem);
  const summary = {
    errors: items.filter((p) => p.severity === "error").length,
    warnings: items.filter((p) => p.severity === "warning").length,
    infos: items.filter((p) => p.severity === "info").length,
    total: items.length,
  };
  const head = `VelvetSharp problems — ${summary.errors} errors, ${summary.warnings} warnings, ${summary.infos} infos (${summary.total} total)`
    + (rows.length < sorted.length ? ` — showing first ${rows.length}` : "");
  const lines = rows.map((r) =>
    `${r.file}(${r.line},${r.col}): ${r.severity.toUpperCase()}${r.code ? ` ${r.code}` : ""}: ${r.message}`);
  if (rows.length < sorted.length) lines.push(`… ${sorted.length - rows.length} more (raise the max argument to see them)`);
  return { summary, problems: rows, text: lines.length ? head + "\n" + lines.join("\n") : head + "\n(no problems — the workspace is clean)" };
}

/** buildStructure — project file tree for the get_project_structure tool. */
export function buildStructure(files: string[], opts: { folder?: string; max?: number } = {}): { text: string; fileCount: number; dirCount: number } {
  const max = Math.max(1, opts.max ?? 2000);
  const prefix = opts.folder ? posix(opts.folder).replace(/\/+$/, "") + "/" : "";
  const selected = files
    .map(posix)
    .filter((f) => !prefix || f.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b));
  // build a nested tree, dirs first, then render it with box-drawing indents
  interface N { name: string; dir: boolean; kids: Map<string, N> }
  const root: N = { name: "", dir: true, kids: new Map() };
  for (const f of selected) {
    const parts = f.split("/");
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const leaf = i === parts.length - 1;
      const name = parts[i];
      if (!cur.kids.has(name)) cur.kids.set(name, { name, dir: !leaf, kids: new Map() });
      cur = cur.kids.get(name)!;
    }
  }
  const lines: string[] = [];
  let fileCount = 0;
  let dirCount = 0;
  const walk = (n: N, indent: string): void => {
    const kids = [...n.kids.values()].sort((a, b) =>
      (a.dir === b.dir) ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1));
    for (let i = 0; i < kids.length; i++) {
      if (lines.length >= max) { lines.push(`… (truncated at ${max} entries)`); return; }
      const k = kids[i];
      const last = i === kids.length - 1;
      const branch = last ? "└─ " : "├─ ";
      if (k.dir) {
        dirCount++;
        lines.push(`${indent}${branch}${k.name}/`);
        walk(k, indent + (last ? "   " : "│  "));
      } else {
        fileCount++;
        lines.push(`${indent}${branch}${k.name}`);
      }
    }
  };
  walk(root, "");
  const scope = prefix ? ` under ${prefix}` : "";
  const text = `VelvetSharp workspace${scope} — ${fileCount} files, ${dirCount} folders:\n` + lines.join("\n");
  return { text, fileCount, dirCount };
}

/** formatSearch — code-search results for the search_code tool (grouped text). */
export function formatSearch(
  hits: { file: string; line: number; col: number; length: number; text: string }[],
  opts: { query?: string; max?: number; unsearched?: string[]; truncated?: boolean } = {},
): { text: string; matchCount: number; fileCount: number } {
  const max = Math.max(1, opts.max ?? 200);
  const shown = hits.slice(0, max);
  const byFile = new Map<string, typeof shown>();
  for (const h of shown) {
    if (!byFile.has(posix(h.file))) byFile.set(posix(h.file), []);
    byFile.get(posix(h.file))!.push(h);
  }
  const lines: string[] = [];
  for (const [file, list] of byFile) {
    lines.push(`${file} (${list.length})`);
    for (const h of list) {
      const trimmed = h.text.replace(/\t/g, "  ").trim().slice(0, 200);
      lines.push(`  ${h.line + 1}:${h.col + 1}: ${trimmed}`);
    }
  }
  const notes: string[] = [];
  if (hits.length > shown.length) notes.push(`${hits.length - shown.length} more matches not shown (raise max)`);
  if (opts.truncated) notes.push(`result cap reached — the query kept matching beyond ${opts.max ?? max} hits`);
  if (opts.unsearched?.length) notes.push(`${opts.unsearched.length} file(s) could not be searched yet (indexed from cache without text) — they are scanned as soon as they are opened, swept, or fetched via get_file`);
  const head = `VelvetSharp code search "${opts.query ?? ""}" — ${hits.length} match(es) in ${byFile.size} file(s)`
    + (notes.length ? `\n` + notes.map((n) => `note: ${n}`).join("\n") : "");
  return { text: lines.length ? head + "\n" + lines.join("\n") : head, matchCount: hits.length, fileCount: byFile.size };
}

/** formatFileContent — get_file tool payload (line window, 1-based header). */
export function formatFileContent(
  path: string,
  content: string,
  opts: { fromLine?: number; toLine?: number; unsaved?: boolean } = {},
): { text: string; totalLines: number; from: number; to: number } {
  const lines = content.split("\n");
  const total = lines.length;
  const from = Math.max(1, opts.fromLine ?? 1);
  const to = Math.min(total, Math.max(from, opts.toLine ?? total));
  const body: string[] = [];
  for (let i = from; i <= to; i++) body.push(`${String(i).padStart(4, " ")} | ${lines[i - 1]}`);
  const flags: string[] = [];
  if (opts.unsaved) flags.push("UNSAVED — this is the editor buffer, newer than the file on disk");
  if (to - from + 1 < total) flags.push(`showing lines ${from}-${to} of ${total}`);
  const head = `${posix(path)} — ${total} lines` + (flags.length ? ` (${flags.join("; ")})` : "");
  return { text: head + "\n" + body.join("\n"), totalLines: total, from, to };
}
