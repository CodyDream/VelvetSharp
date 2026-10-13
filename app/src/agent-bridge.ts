/** VelvetSharp Phase 16 — Agent Bridge (PURE — zero imports).
 *
 *  The MCP layer (Phase 14) serves AI agents that CAN reach the local
 *  machine. Web LLMs (ChatGPT, Claude.ai, Gemini, …) cannot — the user
 *  copy-pastes to them. Phase 16 closes that loop with a structured JSON
 *  hand-off:
 *
 *    1. the user picks folders/sub-folders in the "Structure → AI" window
 *       and copies the structure (optionally with file contents) into a
 *       web LLM;
 *    2. the LLM answers with a JSON payload (schema below);
 *    3. the user pastes that JSON into the "Apply JSON ← AI" window and the
 *       editor creates / modifies / deletes / moves the scripts itself.
 *
 *  Everything here is a pure function over plain data so the engine test
 *  suite (scripts/test-brain.ts) locks the wire format down with no DOM,
 *  no worker and no filesystem (apply takes the IO surface as a parameter).
 *
 *  Payload contract (stable — agents parse it):
 *    { "velvetsharp": 1, "agent": "ChatGPT", "message": "adds dash",
 *      "operations": [
 *        { "op": "create", "path": "Assets/Scripts/Dash.cs", "content": "…" },
 *        { "op": "modify", "path": "Assets/Scripts/Player.cs",
 *          "find": "<exact existing text>", "replace": "<new text>", "all": false },
 *        { "op": "modify", "path": "Assets/Scripts/Old.cs", "content": "…full file…" },
 *        { "op": "delete", "path": "Assets/Scripts/Obsolete.cs" },
 *        { "op": "move",   "from": "A.cs", "to": "Folder/B.cs" } ] }
 *
 *  Tolerances (web LLMs improvise — accept their dialects):
 *    - missing velvetsharp marker  → warning, still applied
 *    - "ops" alias for "operations"
 *    - op aliases: new→create · edit/patch/replace→modify · remove→delete · rename→move
 *    - modify with find but no replace → replace = "" (warning)
 *    - create of a .cs with no content → MonoBehaviour starter template
 *  Strictness (safety):
 *    - paths must be workspace-relative, forward-slash, no "..", no drives,
 *      no UNC, no empty segments
 *    - writes limited to a text-extension allowlist
 *    - operations capped; per-op content capped
 */

/* ------------------------------ types ------------------------------ */

export interface AgentPayload {
  velvetsharp: 1;
  agent?: string;
  message?: string;
  operations: AgentOp[];
}

export type AgentOp =
  | { op: "create"; path: string; content?: string; overwrite?: boolean }
  | { op: "modify"; path: string; content?: string; find?: string; replace?: string; all?: boolean }
  | { op: "delete"; path: string }
  | { op: "move"; from: string; to: string };

export interface NormalizedPayload {
  payload: AgentPayload | null;
  errors: string[];
  warnings: string[];
}

export interface OpResult {
  index: number;
  op: string;
  path: string;
  ok: boolean;
  detail: string;
  bytes?: number;
}

/** the surface applyPayload needs — the workspace adapter (or a test tmpdir) */
export interface PayloadIo {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/* ----------------------------- constants ----------------------------- */

/** extensions the bridge may create/modify (text-only — binary ops refused) */
export const WRITABLE_EXTS = [
  ".cs", ".meta", ".asmdef", ".json", ".txt", ".md", ".rsp", ".xml",
  ".yaml", ".yml", ".shader", ".hlsl", ".compute", ".uxml", ".uss", ".asset",
] as const;

/** hard ceiling on operations per payload (one agent turn is nowhere near this) */
export const MAX_OPERATIONS = 200;
/** hard ceiling on a single op's content — protects the editor from runaway payloads */
export const MAX_CONTENT_CHARS = 2_000_000;

const OP_ALIASES: Record<string, AgentOp["op"]> = {
  create: "create", new: "create", add: "create",
  modify: "modify", edit: "modify", patch: "modify", replace: "modify", update: "modify",
  delete: "delete", remove: "delete", destroy: "delete",
  move: "move", rename: "move",
};

/* --------------------------- path handling --------------------------- */

/** safeRelPath — normalize to a workspace-relative POSIX path or null.
 *  Rejects absolute paths, drive letters, UNC, ".." segments, empty segments. */
export function safeRelPath(p: unknown): string | null {
  const raw = String(p ?? "");
  if (!raw) return null;
  if (/^[a-zA-Z]:/.test(raw)) return null;             // C:\…
  if (raw.startsWith("/") || raw.startsWith("\\")) return null;
  if (raw.startsWith("//") || raw.startsWith("\\\\")) return null; // UNC
  const norm = raw.replace(/\\/g, "/");
  const parts = norm.split("/");
  if (parts.some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return parts.join("/");
}

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i).toLowerCase() : "";
}

function writablePath(p: string): boolean {
  return (WRITABLE_EXTS as readonly string[]).includes(extOf(p));
}

/* --------------------------- starter content --------------------------- */

/** starter MonoBehaviour for create ops without content (class == file name) */
export function starterCsContent(className: string): string {
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

/* ---------------------------- normalization ---------------------------- */

/** normalizePayload — validate an unknown blob into an AgentPayload.
 *  Collects ALL problems (never throws) so the UI can show them in one shot. */
export function normalizePayload(raw: unknown): NormalizedPayload {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { payload: null, errors: ["payload must be a JSON object with an \"operations\" array"], warnings };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.velvetsharp !== 1 && obj.velvetsharp !== "1") {
    warnings.push("protocol marker missing — expected \"velvetsharp\": 1 at the top level (applied anyway)");
  }

  const opsRaw = (obj.operations ?? obj.ops) as unknown;
  if (!Array.isArray(opsRaw)) {
    return {
      payload: null,
      errors: ["\"operations\" must be an array of operation objects — nothing to apply"],
      warnings,
    };
  }
  if (opsRaw.length === 0) errors.push("\"operations\" is empty — nothing to apply");
  if (opsRaw.length > MAX_OPERATIONS) {
    return { payload: null, errors: [`too many operations (${opsRaw.length}) — the bridge accepts at most ${MAX_OPERATIONS} per payload`], warnings };
  }

  const operations: AgentOp[] = [];
  opsRaw.forEach((o, i) => {
    const tag = `operations[${i}]`;
    if (o == null || typeof o !== "object" || Array.isArray(o)) {
      errors.push(`${tag}: must be an object`);
      return;
    }
    const rec = o as Record<string, unknown>;
    const kindRaw = String(rec.op ?? rec.kind ?? rec.type ?? "").toLowerCase().trim();
    if (!kindRaw) {
      errors.push(`${tag}: missing "op" — use create / modify / delete / move`);
      return;
    }
    const kind = OP_ALIASES[kindRaw];
    if (!kind) {
      errors.push(`${tag}: unknown op "${kindRaw}" — use create / modify / delete / move`);
      return;
    }

    if (kind === "move") {
      const from = safeRelPath(rec.from ?? rec.path);
      const to = safeRelPath(rec.to ?? rec.newPath ?? rec.newName);
      if (!from || !to) {
        errors.push(`${tag}: move needs "from" and "to" workspace-relative paths`);
        return;
      }
      if (from === to) {
        errors.push(`${tag}: move source and destination are the same`);
        return;
      }
      if (!writablePath(from) || !writablePath(to)) {
        errors.push(`${tag}: move is limited to text files (${WRITABLE_EXTS.slice(0, 6).join(" ")} …)`);
        return;
      }
      operations.push({ op: "move", from, to });
      return;
    }

    const path = safeRelPath(rec.path ?? rec.file ?? rec.target);
    if (!path) {
      errors.push(`${tag}: "${kind}" needs a "path" that is workspace-relative with forward slashes (no "..", no drive letters)`);
      return;
    }
    if (!writablePath(path)) {
      errors.push(`${tag}: "${path}" — only text files can be bridged (${WRITABLE_EXTS.slice(0, 6).join(" ")} …)`);
      return;
    }

    if (kind === "create") {
      let content = typeof rec.content === "string" ? rec.content : undefined;
      if (content != null && content.length > MAX_CONTENT_CHARS) {
        errors.push(`${tag}: content exceeds ${MAX_CONTENT_CHARS} characters`);
        return;
      }
      if (content == null && extOf(path) === ".cs") {
        warnings.push(`${tag}: create "${path}" has no content — a MonoBehaviour starter template will be used`);
        content = starterCsContent(path.slice(path.lastIndexOf("/") + 1).replace(/\.cs$/i, ""));
      }
      operations.push({ op: "create", path, content: content ?? "", overwrite: rec.overwrite === true });
      return;
    }

    if (kind === "modify") {
      const hasContent = typeof rec.content === "string";
      const hasFind = typeof rec.find === "string" && rec.find.length > 0;
      if (!hasContent && !hasFind) {
        errors.push(`${tag}: modify "${path}" needs either "content" (full replacement) or a "find"/"replace" pair`);
        return;
      }
      if (hasContent) {
        const content = rec.content as string;
        if (content.length > MAX_CONTENT_CHARS) {
          errors.push(`${tag}: content exceeds ${MAX_CONTENT_CHARS} characters`);
          return;
        }
        operations.push({ op: "modify", path, content });
        return;
      }
      const find = rec.find as string;
      if (find.length > MAX_CONTENT_CHARS) {
        errors.push(`${tag}: find exceeds ${MAX_CONTENT_CHARS} characters`);
        return;
      }
      if (typeof rec.replace !== "string") {
        warnings.push(`${tag}: modify "${path}" has "find" but no "replace" — the find text will be deleted`);
      }
      operations.push({
        op: "modify", path,
        find,
        replace: typeof rec.replace === "string" ? rec.replace : "",
        all: rec.all === true || rec.replaceAll === true,
      });
      return;
    }

    // delete
    operations.push({ op: "delete", path });
  });

  if (errors.length) return { payload: null, errors, warnings };

  const agent = typeof obj.agent === "string" ? obj.agent.slice(0, 80) : undefined;
  const message = typeof obj.message === "string" ? obj.message.slice(0, 300) : undefined;
  return { payload: { velvetsharp: 1, agent, message, operations }, errors, warnings };
}

/* ------------------------------- planner ------------------------------- */

/** one find/replace probe result */
export interface FindProbe {
  occurrences: number;
  firstLine?: number;   // 0-based
  preview?: string;     // context around the first occurrence
}

/** probeFind — count exact occurrences of `find` inside `content` (pure). */
export function probeFind(content: string, find: string): FindProbe {
  if (!find) return { occurrences: 0 };
  let occurrences = 0;
  let firstLine: number | undefined;
  let preview: string | undefined;
  let idx = content.indexOf(find);
  while (idx >= 0) {
    if (occurrences === 0) {
      firstLine = content.slice(0, idx).split("\n").length - 1;
      const lineStart = content.lastIndexOf("\n", idx) + 1;
      const lineEnd = content.indexOf("\n", idx + find.length);
      preview = content.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim().slice(0, 120);
    }
    occurrences++;
    idx = content.indexOf(find, idx + Math.max(1, find.length));
  }
  return { occurrences, firstLine, preview };
}

/** planPayload — dry-run every op against the IO surface WITHOUT writing.
 *  Returns one OpResult per operation (ok=false carries the exact reason). */
export async function planPayload(payload: AgentPayload, io: PayloadIo): Promise<OpResult[]> {
  const out: OpResult[] = [];
  for (let i = 0; i < payload.operations.length; i++) {
    const op = payload.operations[i];
    const path = op.op === "move" ? `${op.from} → ${op.to}` : op.path;
    try {
      if (op.op === "create") {
        const exists = await io.exists(op.path);
        if (exists && !op.overwrite) {
          out.push({ index: i, op: "create", path: op.path, ok: false, detail: `"${op.path}" already exists — add "overwrite": true or use a modify op` });
        } else {
          const bytes = (op.content ?? "").length;
          out.push({ index: i, op: "create", path: op.path, ok: true, detail: exists ? "overwrites the existing file" : "new file", bytes });
        }
      } else if (op.op === "modify") {
        let current: string;
        try {
          current = await io.read(op.path);
        } catch {
          out.push({ index: i, op: "modify", path: op.path, ok: false, detail: `"${op.path}" does not exist — use a create op` });
          continue;
        }
        if (op.content != null) {
          out.push({ index: i, op: "modify", path: op.path, ok: true, detail: `full rewrite (${current.split("\n").length} → ${op.content.split("\n").length} lines)`, bytes: op.content.length });
        } else {
          const probe = probeFind(current, op.find ?? "");
          if (probe.occurrences === 0) {
            out.push({ index: i, op: "modify", path: op.path, ok: false, detail: `find text not found in "${op.path}" (exact match incl. whitespace) — copy the text from the code you were given` });
          } else if (probe.occurrences > 1 && !op.all) {
            out.push({ index: i, op: "modify", path: op.path, ok: false, detail: `find text matches ${probe.occurrences} places — add "all": true to replace every occurrence, or make the find text more specific (first at line ${(probe.firstLine ?? 0) + 1}: ${probe.preview ?? ""})` });
          } else {
            out.push({ index: i, op: "modify", path: op.path, ok: true, detail: `replaces ${probe.occurrences} occurrence${probe.occurrences === 1 ? "" : "s"} (first at line ${(probe.firstLine ?? 0) + 1})`, bytes: (op.replace ?? "").length });
          }
        }
      } else if (op.op === "delete") {
        const exists = await io.exists(op.path);
        out.push(exists
          ? { index: i, op: "delete", path: op.path, ok: true, detail: "file will be removed (its .meta sidecar goes too)" }
          : { index: i, op: "delete", path: op.path, ok: false, detail: `"${op.path}" does not exist` });
      } else {
        // move
        const fromExists = await io.exists(op.from);
        if (!fromExists) {
          out.push({ index: i, op: "move", path, ok: false, detail: `source "${op.from}" does not exist` });
          continue;
        }
        const toExists = await io.exists(op.to);
        if (toExists) {
          out.push({ index: i, op: "move", path, ok: false, detail: `destination "${op.to}" already exists` });
          continue;
        }
        out.push({ index: i, op: "move", path, ok: true, detail: "renamed/moved (its .meta sidecar follows)" });
      }
    } catch (e) {
      out.push({ index: i, op: op.op, path, ok: false, detail: `planner error: ${String((e as Error)?.message ?? e)}` });
    }
  }
  return out;
}

/* ------------------------------- applier ------------------------------- */

export interface ApplySummary {
  results: OpResult[];
  applied: number;
  failed: number;
  report: string;
  /** paths touched successfully — the caller refreshes the index for these */
  touched: { created: string[]; modified: string[]; deleted: string[]; moved: { from: string; to: string }[] };
}

function opTag(op: AgentOp): string {
  if (op.op === "move") return `${op.from} → ${op.to}`;
  return op.path;
}

function detailOf(res: OpResult): string {
  return res.ok ? res.detail : `FAILED — ${res.detail}`;
}

/** applyPayload — execute the plan sequentially. One failed op does NOT stop
 *  the rest (agents batch many small fixes; partial success + a copyable
 *  report beats abort-everything). */
export async function applyPayload(payload: AgentPayload, io: PayloadIo): Promise<ApplySummary> {
  // plan first — an op the planner already rejects is never executed
  const plan = await planPayload(payload, io);
  const results: OpResult[] = plan.map((r) => ({ ...r }));
  const touched: ApplySummary["touched"] = { created: [], modified: [], deleted: [], moved: [] };

  for (let i = 0; i < payload.operations.length; i++) {
    const op = payload.operations[i];
    if (!results[i].ok) continue;
    try {
      if (op.op === "create") {
        await io.write(op.path, op.content ?? "");
        touched.created.push(op.path);
        results[i] = { ...results[i], detail: `created (${(op.content ?? "").length} bytes)` };
      } else if (op.op === "modify") {
        const current = await io.read(op.path);
        const next = op.content != null
          ? op.content
          : applyFindReplace(current, op.find ?? "", op.replace ?? "", op.all === true);
        await io.write(op.path, next);
        touched.modified.push(op.path);
        results[i] = { ...results[i], detail: `modified (${next.length} bytes now)` };
      } else if (op.op === "delete") {
        await io.remove(op.path);
        touched.deleted.push(op.path);
        results[i] = { ...results[i], detail: "deleted" };
      } else {
        await io.move(op.from, op.to);
        touched.moved.push({ from: op.from, to: op.to });
        results[i] = { ...results[i], detail: "moved" };
      }
    } catch (e) {
      results[i] = { ...results[i], ok: false, detail: `FAILED — ${String((e as Error)?.message ?? e)}` };
    }
  }

  const applied = results.filter((r) => r.ok).length;
  const failed = results.length - applied;
  return { results, applied, failed, report: formatApplyReport(results, payload), touched };
}

/** applyFindReplace — exact-string replace (first or all occurrences). */
export function applyFindReplace(content: string, find: string, replace: string, all: boolean): string {
  if (!find) return content;
  if (all) return content.split(find).join(replace);
  const idx = content.indexOf(find);
  if (idx < 0) return content;
  return content.slice(0, idx) + replace + content.slice(idx + find.length);
}

/** formatApplyReport — the text the user copies back to the agent. */
export function formatApplyReport(results: OpResult[], payload?: AgentPayload): string {
  const applied = results.filter((r) => r.ok).length;
  const failed = results.length - applied;
  const head = `VelvetSharp apply report — ${applied} applied, ${failed} failed`
    + (payload?.agent ? ` (agent: ${payload.agent})` : "")
    + (payload?.message ? ` — "${payload.message}"` : "");
  const rows = results.map((r) =>
    `  ${r.ok ? "OK  " : "FAIL"} ${r.op.padEnd(6)} ${r.path}${r.detail ? ` — ${detailOf(r)}` : ""}`);
  const tail = failed === 0
    ? "All operations landed. Ask the agent for the next step if you need one."
    : `${failed} operation(s) need attention — paste this report back to the agent so it can correct its payload.`;
  return [head, ...rows, tail].join("\n");
}

/* --------------------------- structure export --------------------------- */

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}

/** buildFileTree — nested, dirs-first, alphabetical (pure). */
export function buildFileTree(files: string[]): TreeNode[] {
  interface N { name: string; dir: boolean; kids: Map<string, N> }
  const root: N = { name: "", dir: true, kids: new Map() };
  for (const f of [...files].map((s) => s.replace(/\\/g, "/")).sort()) {
    const parts = f.split("/");
    let cur = root;
    parts.forEach((name, i) => {
      const leaf = i === parts.length - 1;
      if (!cur.kids.has(name)) cur.kids.set(name, { name, dir: !leaf, kids: new Map() });
      cur = cur.kids.get(name)!;
    });
  }
  const walk = (n: N, prefix: string): TreeNode[] =>
    [...n.kids.values()]
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
      .map((k) => {
        const path = prefix ? `${prefix}/${k.name}` : k.name;
        return { name: k.name, path, dir: k.dir, children: k.dir ? walk(k, path) : [] };
      });
  return walk(root, "");
}

/** expandSelection — files covered by the checked set (checked folder = its
 *  whole subtree; checked file = itself). Pure. */
export function expandSelection(files: string[], checked: Set<string>): string[] {
  if (!checked.size) return [];
  const prefixes = [...checked].map((c) => (c.endsWith("/") ? c : c + "/"));
  const out: string[] = [];
  for (const f of files.map((s) => s.replace(/\\/g, "/"))) {
    if (checked.has(f)) { out.push(f); continue; }
    if (prefixes.some((p) => f.startsWith(p))) out.push(f);
  }
  return [...new Set(out)].sort();
}

/** selectionState — tri-state checkbox logic for one tree node (pure).
 *  A folder counts as "on" when its own path OR every leaf under it is checked. */
export function selectionState(node: TreeNode, checked: Set<string>): "on" | "off" | "mixed" {
  if (checked.has(node.path)) return "on";
  const leaves: string[] = [];
  const collect = (n: TreeNode): void => {
    if (n.dir) {
      if (checked.has(n.path)) { return; } // subtree covered by the folder entry
      n.children.forEach(collect);
    } else leaves.push(n.path);
  };
  if (node.dir) collect(node);
  else return checked.has(node.path) ? "on" : "off";
  if (!leaves.length) return checked.has(node.path) ? "on" : "off";
  const inCount = leaves.filter((f) => checked.has(f)).length;
  return inCount === 0 ? "off" : inCount === leaves.length ? "on" : "mixed";
}

export interface StructureExport {
  text: string;
  fileCount: number;
  dirCount: number;
  chars: number;
  truncated: boolean;
}

/** buildStructureExport — the copyable payload for the web LLM.
 *  includeCode appends the selected files' contents as fenced code blocks. */
export function buildStructureExport(
  files: string[],
  checked: Set<string>,
  opts: { includeCode?: boolean; read?: (path: string) => string; rootLabel?: string; maxChars?: number } = {},
): StructureExport {
  const maxChars = opts.maxChars ?? 600_000;
  const selected = expandSelection(files, checked);
  const tree = buildFileTree(selected);

  const lines: string[] = [];
  let fileCount = 0;
  let dirCount = 0;
  const walk = (nodes: TreeNode[], indent: string): void => {
    for (const n of nodes) {
      if (n.dir) {
        dirCount++;
        lines.push(`${indent}${n.name}/`);
        walk(n.children, indent + "  ");
      } else {
        fileCount++;
        lines.push(`${indent}${n.name}`);
      }
    }
  };
  walk(tree, "");

  const rootLabel = opts.rootLabel || "Unity project";
  let text = `${rootLabel} — selected ${fileCount} file(s), ${dirCount} folder(s):\n${lines.join("\n")}\n`;

  let truncated = false;
  if (opts.includeCode && opts.read) {
    for (const f of selected) {
      let body: string;
      try {
        body = opts.read(f);
      } catch {
        body = "(unreadable)";
      }
      const lang = f.toLowerCase().endsWith(".cs") ? "csharp" : "";
      const block = `\n--- ${f} ---\n\`\`\`${lang}\n${body.replace(/\s+$/, "")}\n\`\`\`\n`;
      if (text.length + block.length > maxChars) {
        text += `\n(file contents truncated at ${maxChars} characters — unselect folders or paste in parts)\n`;
        truncated = true;
        break;
      }
      text += block;
    }
  }
  return { text, fileCount, dirCount, chars: text.length, truncated };
}

/* -------------------------- agent instructions -------------------------- */

/** AGENT_INSTRUCTIONS — copy-paste prompt that teaches ANY web LLM the JSON
 *  payload contract. Kept short enough to paste every turn. */
export const AGENT_INSTRUCTIONS = `You are helping with a Unity C# project (edited in VelvetSharp).

Reply with ONE JSON object and nothing else — no markdown fences, no prose:

{
  "velvetsharp": 1,
  "agent": "your-name",
  "message": "one line describing what you changed",
  "operations": [
    { "op": "create", "path": "Assets/Scripts/Foo.cs", "content": "FULL FILE TEXT" },
    { "op": "modify", "path": "Assets/Scripts/Foo.cs", "find": "EXACT existing text", "replace": "new text", "all": false },
    { "op": "modify", "path": "Assets/Scripts/Bar.cs", "content": "FULL replacement file text" },
    { "op": "delete", "path": "Assets/Scripts/Old.cs" },
    { "op": "move", "from": "Assets/Scripts/A.cs", "to": "Assets/Scripts/Util/A.cs" }
  ]
}

Rules:
- paths are workspace-relative, forward slashes, no "..", no drive letters
- "find" must match the file EXACTLY (copy it from the code you were given — same whitespace)
- prefer small modify ops with precise find text over full-file rewrites
- create needs the FULL file content; a .cs without content gets a MonoBehaviour starter
- every op targets ONE file; folders cannot be created or deleted directly
- to replace a whole file, use modify with "content" (or create with "overwrite": true)
`;
