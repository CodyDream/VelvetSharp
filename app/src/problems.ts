/** VelvetSharp — Problems-bar model helpers (v0.7.0, pure & unit-testable). */
import type { ProblemItem } from "./store";

/** stable identity of one problem row: same position + message + severity
 *  coming from overlapping syntax/semantic passes collapses to one entry */
export function problemKey(p: ProblemItem): string {
  return `${p.path}|${p.line}|${p.col}|${p.length}|${p.severity}|${p.message}`;
}

/** errors first, warnings after; then file → line → col. Duplicates removed. */
export function dedupeProblems(items: ProblemItem[]): ProblemItem[] {
  const seen = new Set<string>();
  const out: ProblemItem[] = [];
  for (const p of items) {
    const k = problemKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  const sevRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  out.sort((a, b) =>
    (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3)
    || a.path.localeCompare(b.path)
    || a.line - b.line || a.col - b.col);
  return out;
}

/** clipboard text for one row (matches the Problems-bar Ctrl+C contract).
 *  Phase 14 — includes the compiler-style code when the engine knows it. */
export function problemToText(p: ProblemItem): string {
  const code = (p as { code?: string }).code ? ` ${(p as { code?: string }).code}` : "";
  return `${p.path}(${p.line + 1},${p.col + 1}): ${p.severity.toUpperCase()}${code} — ${p.message}`;
}
