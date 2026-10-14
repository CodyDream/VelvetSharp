/** VelvetSharp — Phase 17 QOL pure helpers.
 *
 *  Everything in here is intentionally framework-free and side-effect-free so
 *  the engine test harness (scripts/test-brain.ts) can assert on it directly,
 *  the same way the Phase 16 agent-bridge payload logic is tested.
 */

/* ------------------------------ sort usings ------------------------------ */

/** extract the leading `using` block of a C# document.
 *  Returns null when the file has no usings or the block is not at the top
 *  (usings may be preceded by comments/blank lines — that is fine). */
export function leadingUsingBlock(
  lines: string[],
): { start: number; end: number; usings: { line: number; text: string; ns: string; alias: string | null; staticKw: boolean }[] } | null {
  const usings: { line: number; text: string; ns: string; alias: string | null; staticKw: boolean }[] = [];
  let start = -1;
  let end = -1;
  let sawCode = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) continue;
    const m = /^using\s+(?:(\w+)\s*=\s*)?(static\s+)?([\w.]+)\s*;/.exec(t);
    if (m) {
      if (sawCode) break; // using block must be contiguous at the top
      if (start < 0) start = i;
      end = i;
      usings.push({ line: i, text: lines[i], ns: m[3], alias: m[1] ?? null, staticKw: !!m[2] });
      continue;
    }
    if (t.startsWith("#")) continue; // preprocessor lines around usings are legal
    // any other token = code started (attribute targets, namespace, etc.)
    if (usings.length) break;
    sawCode = true;
  }
  if (!usings.length || start < 0) return null;
  return { start, end, usings };
}

/** true when the using block is already perfectly sorted + deduped:
 *  order = alias-free plain usings first, then static usings; within each
 *  group System.* first, then the rest, both case-insensitive by namespace. */
export function usingsSorted(lines: string[]): boolean {
  const block = leadingUsingBlock(lines);
  if (!block) return true; // nothing to sort = sorted
  const texts = block.usings.map((u) => u.text.trim());
  const want = sortedUsingTexts(block.usings);
  return texts.join("\n") === want.join("\n");
}

export function usingSortKey(u: { ns: string; alias: string | null; staticKw: boolean }): number {
  // alias usings keep their place relative to nothing — treat as "other"
  const group = u.staticKw ? 1 : 0;
  const sys = /^system(\.|$)/i.test(u.ns) ? 0 : 1;
  return group * 2 + sys;
}

/** the sorted + deduped using lines (as they should be written back).
 *  Dedupe is EXACT-TEXT: case-variant usings (System vs system) are distinct
 *  namespaces in C#, so only identical lines collapse. */
export function sortedUsingTexts(usings: { text: string; ns: string; alias: string | null; staticKw: boolean }[]): string[] {
  const seen = new Set<string>();
  const sorted = [...usings]
    .sort((a, b) => {
      const ga = usingSortKey(a);
      const gb = usingSortKey(b);
      if (ga !== gb) return ga - gb;
      const ns = a.ns.toLowerCase().localeCompare(b.ns.toLowerCase());
      if (ns !== 0) return ns;
      return a.text.localeCompare(b.text);
    })
    .map((u) => u.text.trim())
    .filter((t) => {
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
  return sorted;
}

/** sort the document's leading using block. Returns the new content, or null
 *  when there is nothing to change (caller keeps the original). */
export function sortUsings(content: string): string | null {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r\n|\n/);
  const block = leadingUsingBlock(lines);
  if (!block) return null;
  const want = sortedUsingTexts(block.usings);
  const have = block.usings.map((u) => u.text.trim());
  if (have.join("\n") === want.join("\n")) return null; // already sorted
  const next = [...lines];
  // replace the block lines; if the sorted list is shorter (dupes removed),
  // the leftover lines become empty and the gap is collapsed below
  for (let i = 0; i < block.end - block.start + 1; i++) {
    next[block.start + i] = i < want.length ? want[i] : "";
  }
  // collapse the gap left by removed duplicates (keep exactly one blank line
  // between the using block and the code that follows, if any)
  const out: string[] = [];
  for (let i = 0; i < next.length; i++) {
    if (next[i] === "" && i > block.start && i <= block.end) continue; // in-block gap
    out.push(next[i]);
  }
  return out.join(eol);
}

/* -------------------------- trim trailing whitespace -------------------------- */

/** trim trailing spaces/tabs from every line. Returns null when the document
 *  is already clean (no write needed). EOL is preserved. */
export function trimTrailingWhitespace(content: string): string | null {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r\n|\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    // do not touch a line's content beyond trailing horizontal whitespace
    const trimmed = lines[i].replace(/[ \t]+$/, "");
    if (trimmed !== lines[i]) { lines[i] = trimmed; changed = true; }
  }
  if (!changed) return null;
  return lines.join(eol);
}

/* ------------------------------- breadcrumbs ------------------------------- */

/** breadcrumb segments for a workspace-relative path:
 *  ["Assets", "Scripts", "Player", "PlayerController.cs"] */
export function breadcrumbSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** pick the outline entry that "owns" a caret line — the innermost symbol
 *  whose start is <= the line (top-level types first, then members). Used by
 *  the breadcrumb symbol chip. */
export function owningSymbol(
  outline: { name: string; kind: string; line: number; depth: number }[],
  line: number,
): { name: string; kind: string; line: number } | null {
  let best: { name: string; kind: string; line: number; depth: number } | null = null;
  for (const o of outline) {
    if (o.line > line) continue;
    if (!best || o.depth > best.depth || (o.depth === best.depth && o.line > best.line)) best = o;
  }
  return best ? { name: best.name, kind: best.kind, line: best.line } : null;
}

/* ------------------------------ session restore ------------------------------ */

/** the persisted open-tab session for one workspace. Kept deliberately tiny:
 *  tab paths in display order + the active path + per-tab last cursor. */
export interface EditorSession {
  version: 1;
  tabs: { path: string; cursor?: { line: number; col: number } }[];
  active: string | null;
}

export function serializeSession(tabs: { path: string; cursor?: { line: number; col: number } }[], active: string | null): EditorSession {
  return {
    version: 1,
    tabs: tabs
      .filter((t) => t.path && t.path.endsWith(".cs"))
      .slice(0, 40) // sanity cap — 40 open scripts is beyond generous
      .map((t) => ({ path: t.path, cursor: t.cursor })),
    active: active && active.endsWith(".cs") ? active : null,
  };
}

/** drop session entries whose files no longer exist on disk */
export function reviveSession(
  saved: EditorSession | null | undefined,
  filesOnDisk: string[],
): { tabs: { path: string; cursor?: { line: number; col: number } }[]; active: string | null } {
  if (!saved || saved.version !== 1) return { tabs: [], active: null };
  const have = new Set(filesOnDisk);
  const tabs = saved.tabs.filter((t) => have.has(t.path)).slice(0, 40);
  const active = saved.active && have.has(saved.active) ? saved.active : (tabs[tabs.length - 1]?.path ?? null);
  return { tabs, active };
}

/* ------------------------------ tab cycling ------------------------------ */

/** next active index when cycling tabs with Ctrl+Tab / Ctrl+Shift+Tab.
 *  Wraps around; empty tab list keeps the current (null) selection. */
export function cycleTabIndex(count: number, currentIndex: number, back: boolean): number {
  if (count <= 0) return -1;
  if (count === 1) return 0;
  const step = back ? -1 : 1;
  return (currentIndex + step + count) % count;
}

/* ------------------------------ next problem ------------------------------ */

/** index of the next/previous problem after a given flat position
 *  (line-major compare over the row identity the Problems bar shows).
 *  Returns -1 when there is nothing to move to. */
export function nextProblemIndex(
  problems: { path: string; line: number; col: number }[],
  current: { path: string | null; line: number; col: number } | null,
  back: boolean,
): number {
  if (!problems.length) return -1;
  const key = (p: { path: string; line: number; col: number }) => `${p.path}:${p.line}:${p.col}`;
  const curKey = current && current.path ? key(current as { path: string; line: number; col: number }) : null;
  const idx = curKey ? problems.findIndex((p) => key(p) === curKey) : -1;
  if (idx < 0) return back ? problems.length - 1 : 0;
  if (back) return idx > 0 ? idx - 1 : problems.length - 1;
  return idx < problems.length - 1 ? idx + 1 : 0;
}
