/** VelvetSharp brain — C# folding ranges (Phase 11).
 *
 *  "when right click script so my collaspe option and it sub option give
 *  collaspe option for collaspe by methods, collaspe by #regions, collaspe all
 *  options, and also collaspe xml documentation on top of methods and stuff"
 *
 *  One precise, pure function powers BOTH the editor's fold gutter and the
 *  right-click Collapse ▸ submenu. Ranges preserve signatures (a method folds
 *  from its SIGNATURE line, not the `{` line — VS/Rider behaviour), and cover:
 *
 *    method    — method / constructor / operator / property bodies
 *    type      — class / struct / interface / enum / record bodies
 *    namespace — namespace bodies
 *    region    — #region … #endregion
 *    if        — #if … #endif
 *    doc       — consecutive /// runs above members (≥ 2 lines)
 *    comment   — /* … *​/ blocks (≥ 2 lines)
 */

export type FoldKind = "method" | "type" | "namespace" | "region" | "if" | "doc" | "comment";

export interface FoldRange {
  startLine: number;   // 0-based, signature/first line (stays visible when folded)
  endLine: number;     // 0-based inclusive (closing brace / #endregion / last ///)
  kind: FoldKind;
}

const DIRECTIVE_RE = /^\s*#\s*(\w+)\s*(.*?)\s*$/;

/** strip string literals + line comments so brace counting is safe */
function stripLiterals(line: string): string {
  let out = "";
  let inStr = false, inChar = false, inLineComment = false;
  let verbatim = false, interp = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (inLineComment) break;
    if (inStr) {
      if (!verbatim && c === "\\") { i++; continue; }
      if (verbatim && c === '"' && next === '"') { i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (inChar) {
      if (c === "\\") { i++; continue; }
      if (c === "'") inChar = false;
      continue;
    }
    if (c === "/" && next === "/") { inLineComment = true; i++; continue; }
    if (c === '"') {
      inStr = true;
      verbatim = i > 0 && line[i - 1] === "@";
      interp = line[i - 1] === "$" || (i > 1 && line[i - 1] === "@" && line[i - 2] === "$");
      continue;
    }
    if (c === "'") { inChar = true; continue; }
    out += c;
  }
  return out;
}

const MEMBER_RE = /(?:^|\s)(?:public|private|protected|internal|static|sealed|abstract|override|virtual|async|extern|unsafe|new|partial|explicit|implicit|operator|readonly|const|volatile|required|file)\s+.*$/;
const TYPE_RE = /\b(class|struct|interface|enum|record)\s+\w+/;
const NAMESPACE_RE = /^\s*(?:namespace\s+[\w.]+)\s*(\{|$)/;

/** classify an open-brace line (plus the signature line above it for Allman
 *  braces) into a fold kind. Returns null for plain blocks / control flow. */
function classifyBraceOwner(header: string): FoldKind | null {
  if (TYPE_RE.test(header)) return "type";
  if (NAMESPACE_RE.test(header)) return "namespace";
  if (/\boperator\s*\(/.test(header) || /(~\s*\w+)\s*\(/.test(header)) return "method";
  // method / constructor: a signature ENDING with the parameter list
  if (/\)\s*$/.test(header) && /\b\w+\s*\(/.test(header)
    && !/\b(if|for|foreach|while|switch|catch|using|lock|fixed|checked|unchecked|do)\s*\(/.test(header)) {
    return "method";
  }
  // property with a body: `public int HP` (Allman `{` next line) or `public int HP {`
  if (MEMBER_RE.test(header) && !/\b(if|for|foreach|while|switch|catch|return|throw|new)\b/.test(header)
    && /(\w+\s*\{$)|(\w+\s*$)|(\w+\s*=>)/.test(header)) {
    return "method";
  }
  return null;
}

/** compute every foldable range of a C# source file (pure — worker-free so the
 *  editor can call it synchronously and the test suite can assert on it) */
export function computeFoldRanges(source: string): FoldRange[] {
  const lines = source.split("\n");
  const out: FoldRange[] = [];
  const braceStack: { line: number; kind: FoldKind | null }[] = [];

  // directive tracking (#region / #if)
  const regionStack: number[] = [];
  const ifStack: { line: number; depth: number }[] = [];

  let inBlockComment = false;
  let blockCommentStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const dir = DIRECTIVE_RE.exec(raw);
    if (dir) {
      const kind = dir[1].toLowerCase();
      if (kind === "region") regionStack.push(i);
      else if (kind === "endregion") {
        const start = regionStack.pop();
        if (start !== undefined && i > start) out.push({ startLine: start, endLine: i, kind: "region" });
      } else if (kind === "if" || kind === "ifdef" || kind === "ifndef") {
        ifStack.push({ line: i, depth: regionStack.length });
      } else if (kind === "endif") {
        // pop the nearest #if opened deeper than any open #region boundary
        for (let s = ifStack.length - 1; s >= 0; s--) {
          if (ifStack[s].depth === regionStack.length) {
            const f = ifStack.splice(s, 1)[0];
            if (i > f.line) out.push({ startLine: f.line, endLine: i, kind: "if" });
            break;
          }
        }
      }
      continue; // directive lines never participate in brace folding
    }

    const code = stripLiterals(raw);
    const trimmed = code.trim();

    // block comments (foldable when ≥ 2 lines)
    if (inBlockComment) {
      if (code.includes("*/")) {
        inBlockComment = false;
        if (i > blockCommentStart) out.push({ startLine: blockCommentStart, endLine: i, kind: "comment" });
      }
      continue;
    }
    const bcOpen = code.indexOf("/*");
    if (bcOpen >= 0 && !code.slice(0, bcOpen).includes("//")) {
      if (code.includes("*/", bcOpen + 2)) continue; // single-line /* */
      inBlockComment = true;
      blockCommentStart = i;
      continue;
    }

    // /// doc runs are collected in the second pass below (lookahead needed)
    // braces
    for (const ch of code) {
      if (ch === "{") {
        // Allman style (`{` alone): the fold starts at the SIGNATURE line above,
        // so collapsing keeps the signature visible — VS/Rider behaviour.
        let ownerLine = raw;
        let startLine = i;
        if (trimmed.length === 1 && i > 0) {
          let k = i - 1;
          while (k > 0 && !lines[k]?.trim()) k--;
          ownerLine = lines[k] ?? "";
          startLine = k;
        }
        const kind = classifyBraceOwner(ownerLine);
        braceStack.push({ line: startLine, kind });
      } else if (ch === "}") {
        const f = braceStack.pop();
        if (f && f.kind && i > f.line) out.push({ startLine: f.line, endLine: i, kind: f.kind });
      }
    }
  }

  // /// doc-comment runs (≥ 2 consecutive lines) — VS folds them everywhere
  // ("collapse xml documentation on top of methods and stuff")
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\/\/\//.test(lines[i])) continue;
    let end = i;
    while (end + 1 < lines.length && /^\s*\/\/\//.test(lines[end + 1])) end++;
    if (end > i) out.push({ startLine: i, endLine: end, kind: "doc" });
    i = end;
  }

  return out;
}
