/** VelvetSharp brain — C# preprocessor directives (Phase 11).
 *
 *  "add support for the those # symbols, like example #if Unityeditor those
 *  kind of unity" — this module makes #if/#elif/#else/#endif, #region/#endregion,
 *  #define/#undef, #pragma warning and #error/#warning first-class:
 *
 *  • Unity's standard define set (all platforms + editor flags) is pre-defined,
 *    exactly like the DefineConstants in Unity's generated .csproj — so
 *    `#if UNITY_EDITOR` / platform blocks behave like VS/Rider: analyzed, no
 *    false errors.
 *  • UNITY_<major>_<minor>_OR_NEWER symbols are generated from the detected
 *    project version (ProjectSettings/ProjectVersion.txt) — unknown version
 *    symbols evaluate FALSE and the branch is treated as inactive (grayed,
 *    not analyzed) instead of producing invented errors.
 *  • Branches under unknown/false conditions are INACTIVE: diagnostics inside
 *    them are suppressed (Roslyn parity) and the app dims them.
 *  • Structural mistakes get real diagnostics: stray #endif/#endregion,
 *    unterminated #if/#region, #elif after #else, malformed expressions.
 *  • #error/#warning directives emit real diagnostics when their branch is
 *    active; #pragma warning disable/restore suppresses matching warnings.
 */

import type { Diagnostic, SemRange } from "./types";

/* --------------------------- standard Unity defines --------------------------- */

/** Unity's built-in symbols, minus the version symbols handled separately.
 *  Matches the union Unity writes into generated .csproj DefineConstants:
 *  every platform is defined simultaneously so IntelliSense analyzes every
 *  standard branch (VS parity — zero invented errors). */
export const UNITY_BASE_DEFINES: string[] = [
  // editor
  "UNITY_EDITOR", "UNITY_EDITOR_WIN", "UNITY_EDITOR_OSX", "UNITY_EDITOR_LINUX",
  // desktop platforms
  "UNITY_STANDALONE", "UNITY_STANDALONE_WIN", "UNITY_STANDALONE_OSX", "UNITY_STANDALONE_LINUX",
  "UNITY_SERVER",
  // mobile / console / xr / web
  "UNITY_ANDROID", "UNITY_IOS", "UNITY_IPHONE", "UNITY_TVOS", "UNITY_VISIONOS",
  "UNITY_WEBGL", "UNITY_WSA", "UNITY_METRO", "UNITY_VULKAN",
  "UNITY_PS4", "UNITY_PS5", "UNITY_XBOXONE", "UNITY_GAMECORE", "UNITY_SWITCH",
  // scripting / runtime flags
  "ENABLE_MONO", "ENABLE_IL2CPP", "ENABLE_VR", "ENABLE_AR",
  "ENABLE_INPUT_SYSTEM", "ENABLE_LEGACY_INPUT_MANAGER",
  "ENABLE_UNITY_COLLECTIONS_CHECKS", "ENABLE_UNITYEVENTS", "ENABLE_SPRITES",
  "ENABLE_VIDEO", "ENABLE_AUDIO", "ENABLE_PHYSICS", "ENABLE_PHYSICS3D",
  "ENABLE_ANIMATION", "ENABLE_CLOTH", "ENABLE_PARTICLE_SYSTEM", "ENABLE_TERRAIN",
  "ENABLE_TEXTUREID_MAP", "ENABLE_DIRECTOR", "ENABLE_TILEMAP", "ENABLE_2D_PHYSICS",
  // development / test context
  "DEBUG", "TRACE", "DEVELOPMENT_BUILD", "UNITY_ASSERTIONS", "UNITY_INCLUDE_TESTS",
];

/** parse "2022.3.41f1" / "6000.0.23f1" → [2022, 3] (null when unparseable) */
export function parseUnityVersion(v: string): { major: number; minor: number } | null {
  const m = /(\d+)\.(\d+)/.exec(v ?? "");
  if (!m) return null;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

/** UNITY_<major>_<minor>_OR_NEWER for every minor up to and including the
 *  project's version. Without a detected version this yields the 2022.3 LTS
 *  chain (safe middle ground: Unity-6-only branches stay inactive instead of
 *  inventing errors for an unknown project). */
export function versionDefines(version: string): string[] {
  const parsed = parseUnityVersion(version) ?? { major: 2022, minor: 3 };
  const { major, minor } = parsed;
  const out: string[] = [];
  const push = (maj: number, min: number) =>
    out.push(`UNITY_${maj}_${min}_OR_NEWER`);
  if (major >= 6000) {
    // Unity 6 line (6000.x) plus the whole 5.x–2022 history before it
    for (let m = 0; m <= minor && m < 8; m++) push(6000, m);
    for (let y = 5; y <= 5; y++) for (let n = 3; n <= 6; n++) push(5, n);
    for (let y = 2017; y <= 2022; y++) for (let n = 1; n <= (y === 2022 ? 3 : 4); n++) push(y, n);
    out.push("UNITY_6_OR_NEWER");
  } else {
    for (let y = 5; y <= 5; y++) for (let n = 3; n <= 6; n++) push(5, n);
    for (let y = 2017; y <= major; y++) {
      const maxMinor = y === major ? minor : 4;
      for (let n = 1; n <= maxMinor; n++) push(y, n);
    }
  }
  return out;
}

/** the full pre-defined symbol set: Unity base + version chain + custom defines
 *  (csproj DefineConstants / scriptingDefineSymbols) */
export function buildDefineSet(custom: Iterable<string>, unityVersion: string): Set<string> {
  const set = new Set<string>(UNITY_BASE_DEFINES);
  for (const s of versionDefines(unityVersion)) set.add(s);
  for (const s of custom) {
    const t = (s ?? "").trim();
    if (/^[A-Za-z_]\w*$/.test(t)) set.add(t);
  }
  return set;
}

/* --------------------------- condition expressions --------------------------- */

/** evaluate a #if/#elif expression with the given symbol set.
 *  Supports: symbols, !, &&, ||, parentheses, ==/!=, true/false literals.
 *  Throws on malformed input (caller converts to a diagnostic). */
export function evaluatePreprocExpr(expr: string, defined: Set<string>): boolean {
  const src = expr.trim();
  if (!src) throw new Error("empty");
  let pos = 0;

  const skipWs = () => { while (pos < src.length && /\s/.test(src[pos])) pos++; };
  const peek = (s: string) => { skipWs(); return src.startsWith(s, pos); };
  const eat = (s: string) => { if (peek(s)) { pos += s.length; return true; } return false; };

  function primary(): boolean {
    skipWs();
    if (pos >= src.length) throw new Error("unexpected end");
    if (eat("(")) {
      const v = orExpr();
      if (!eat(")")) throw new Error("missing )");
      return v;
    }
    if (eat("!")) return !primary();
    if (src.startsWith("true", pos) && !/[\w.]/.test(src[pos + 4] ?? "")) { pos += 4; return true; }
    if (src.startsWith("false", pos) && !/[\w.]/.test(src[pos + 5] ?? "")) { pos += 5; return false; }
    const m = /^[A-Za-z_][\w.]*/.exec(src.slice(pos));
    if (!m) throw new Error(`unexpected '${src[pos]}'`);
    pos += m[0].length;
    // equality against another symbol / literal (rare; compare defined-ness)
    skipWs();
    if (eat("==")) {
      const rhs = primary();
      const lhs = defined.has(m[0]);
      return lhs === rhs;
    }
    if (eat("!=")) {
      const rhs = primary();
      const lhs = defined.has(m[0]);
      return lhs !== rhs;
    }
    return defined.has(m[0]);
  }

  function andExpr(): boolean {
    let v = primary();
    for (;;) {
      if (eat("&&")) { const r = primary(); v = v && r; }
      else return v;
    }
  }

  function orExpr(): boolean {
    let v = andExpr();
    for (;;) {
      if (eat("||")) { const r = andExpr(); v = v || r; }
      else return v;
    }
  }

  const result = orExpr();
  skipWs();
  if (pos < src.length) throw new Error(`unexpected '${src[pos]}'`);
  return result;
}

/* ------------------------------ directive scan ------------------------------ */

export interface PragmaSpan {
  line: number;            // 0-based line of the #pragma
  ids: string[] | null;    // normalized warning ids, null = ALL warnings
  disable: boolean;        // true = disable, false = restore
}

export interface PreprocScan {
  /** per-line 1 = active (analyzed), 0 = inactive (grayed, not analyzed) */
  active: Uint8Array;
  /** merged runs of inactive NON-directive lines (0-based, inclusive end) */
  inactive: SemRange[];
  diagnostics: Diagnostic[];
  pragma: PragmaSpan[];
}

const DIRECTIVE_RE = /^\s*#\s*(\w+)\s*(.*?)\s*$/;

function preprocDiag(line: number, col: number, length: number, message: string, severity: "error" | "warning"): Diagnostic {
  return { line, col, length, message, severity, source: "velvetsharp.preproc" };
}

/** run the directive state machine over a source file */
export function scanPreproc(source: string, defined: Set<string>): PreprocScan {
  const lines = source.split("\n");
  const active = new Uint8Array(lines.length);
  const diagnostics: Diagnostic[] = [];
  const pragma: PragmaSpan[] = [];
  const inactive: SemRange[] = [];

  // #if stack: parentActive = was the ENCLOSING branch active; selfActive; taken = any branch true so far; seenElse
  const stack: { parentActive: boolean; selfActive: boolean; taken: boolean; seenElse: boolean; line: number; text: string }[] = [];
  const regions: { line: number; text: string }[] = [];

  const localDefined = new Set(defined);
  let runStart = -1; // current inactive run start (0-based), -1 = none

  const flushRun = (endExclusive: number) => {
    if (runStart >= 0) {
      inactive.push({ line: runStart, col: 0, endLine: endExclusive - 1, endCol: 0 });
      runStart = -1;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = DIRECTIVE_RE.exec(raw);
    if (!m) {
      const parentActive = stack.every((f) => f.selfActive);
      active[i] = parentActive ? 1 : 0;
      if (!parentActive) {
        if (runStart < 0) runStart = i;
      } else {
        flushRun(i);
      }
      continue;
    }

    const kind = m[1].toLowerCase();
    const arg = m[2] ?? "";
    const flushInactiveBeforeDirective = () => flushRun(i);

    switch (kind) {
      case "if":
      case "ifdef":
      case "ifndef": {
        flushInactiveBeforeDirective();
        const parentActive = stack.every((f) => f.selfActive);
        let cond: boolean;
        if (kind === "if") {
          try { cond = evaluatePreprocExpr(arg, localDefined); }
          catch (e: any) {
            diagnostics.push(preprocDiag(i, raw.indexOf("#"), Math.max(3, raw.trim().length),
              `Invalid preprocessor expression: ${String(e?.message ?? e)}`, "error"));
            cond = false;
          }
        } else {
          const sym = arg.trim();
          if (!/^[A-Za-z_]\w*$/.test(sym)) {
            diagnostics.push(preprocDiag(i, raw.indexOf("#"), Math.max(3, raw.trim().length),
              `Malformed #${kind} directive — expected a single symbol`, "error"));
            cond = false;
          } else {
            cond = localDefined.has(sym);
            if (kind === "ifndef") cond = !cond;
          }
        }
        active[i] = 1;
        stack.push({ parentActive, selfActive: parentActive && cond, taken: cond, seenElse: false, line: i, text: raw.trim() });
        break;
      }
      case "elif": {
        flushInactiveBeforeDirective();
        active[i] = 1;
        const f = stack[stack.length - 1];
        if (!f) {
          diagnostics.push(preprocDiag(i, raw.indexOf("#"), Math.max(4, raw.trim().length),
            "Unexpected '#elif' — no matching '#if'", "error"));
          break;
        }
        if (f.seenElse) {
          diagnostics.push(preprocDiag(i, raw.indexOf("#"), Math.max(4, raw.trim().length),
            "'#elif' after '#else' — cannot add another branch", "error"));
          break;
        }
        let cond = false;
        try { cond = evaluatePreprocExpr(arg, localDefined); }
        catch (e: any) {
          diagnostics.push(preprocDiag(i, raw.indexOf("#"), Math.max(4, raw.trim().length),
            `Invalid preprocessor expression: ${String(e?.message ?? e)}`, "error"));
        }
        f.selfActive = f.parentActive && !f.taken && cond;
        f.taken = f.taken || cond;
        break;
      }
      case "else": {
        flushInactiveBeforeDirective();
        active[i] = 1;
        const f = stack[stack.length - 1];
        if (!f) {
          diagnostics.push(preprocDiag(i, raw.indexOf("#"), 4,
            "Unexpected '#else' — no matching '#if'", "error"));
          break;
        }
        if (f.seenElse) {
          diagnostics.push(preprocDiag(i, raw.indexOf("#"), 4,
            "Duplicate '#else' — this #if already has one", "error"));
          break;
        }
        f.seenElse = true;
        f.selfActive = f.parentActive && !f.taken;
        f.taken = true;
        break;
      }
      case "endif": {
        flushInactiveBeforeDirective();
        active[i] = 1;
        const f = stack.pop();
        if (!f) {
          diagnostics.push(preprocDiag(i, raw.indexOf("#"), 6,
            "Unexpected '#endif' — no matching '#if'", "error"));
        }
        break;
      }
      case "define":
      case "undef": {
        flushInactiveBeforeDirective();
        active[i] = 1;
        const sym = arg.trim().split(/\s+/)[0] ?? "";
        if (/^[A-Za-z_]\w*$/.test(sym)) {
          if (stack.every((f) => f.selfActive)) {
            if (kind === "define") localDefined.add(sym);
            else localDefined.delete(sym);
          }
        } else {
          diagnostics.push(preprocDiag(i, raw.indexOf("#"), Math.max(6, raw.trim().length),
            `Malformed #${kind} directive — expected a valid symbol`, "error"));
        }
        break;
      }
      case "region": {
        flushInactiveBeforeDirective();
        active[i] = 1;
        regions.push({ line: i, text: raw.trim() });
        break;
      }
      case "endregion": {
        flushInactiveBeforeDirective();
        active[i] = 1;
        if (!regions.pop()) {
          diagnostics.push(preprocDiag(i, raw.indexOf("#"), 9,
            "Unexpected '#endregion' — no matching '#region'", "error"));
        }
        break;
      }
      case "pragma": {
        flushInactiveBeforeDirective();
        active[i] = stack.every((f) => f.selfActive) ? 1 : 0;
        if (active[i] === 1) {
          const pm = /^warning\s+(disable|restore)\b(.*)$/i.exec(arg);
          if (pm) {
            const idsRaw = pm[2].trim();
            const disable = /disable/i.test(pm[1]);
            if (!idsRaw) {
              pragma.push({ line: i, ids: null, disable });
            } else {
              const ids = idsRaw.split(/[,\s]+/).map((s) => s.trim().toUpperCase().replace(/^CS/, "")).filter(Boolean);
              if (ids.length) pragma.push({ line: i, ids, disable });
            }
          }
        }
        break;
      }
      case "error":
      case "warning": {
        flushInactiveBeforeDirective();
        active[i] = 1;
        if (stack.every((f) => f.selfActive)) {
          const msg = arg.trim() || `#${kind}`;
          diagnostics.push(preprocDiag(i, raw.indexOf("#"), Math.max(6, raw.trim().length),
            `#${kind} ${msg}`.trim(), kind === "error" ? "error" : "warning"));
        }
        break;
      }
      default: {
        // #line and anything unknown — directive recognized, no-op (never a parse error)
        flushInactiveBeforeDirective();
        active[i] = 1;
        break;
      }
    }
  }
  flushRun(lines.length);

  // unterminated blocks — report at the opening directive (clearer than EOF)
  for (const f of stack) {
    diagnostics.push(preprocDiag(f.line, 0, Math.max(3, f.text.length),
      `Missing '#endif' for '${f.text.split(" ").slice(0, 2).join(" ")}' — the conditional block never closes`, "error"));
  }
  for (const r of regions) {
    diagnostics.push(preprocDiag(r.line, 0, Math.max(7, r.text.length),
      "Missing '#endregion' for this '#region'", "error"));
  }

  return { active, inactive, diagnostics, pragma };
}

/* --------------------------- pragma suppression --------------------------- */

/** normalize a diagnostic code ("CS0168", "cs0168", "0168") → "0168" */
function normCode(code: string): string {
  return code.toUpperCase().replace(/^CS/, "");
}

/** does an active `#pragma warning disable` cover this warning (code) at line? */
export function pragmaSuppresses(spans: PragmaSpan[], line: number, code: string): boolean {
  if (!spans.length) return false;
  // replay every span at or before the diagnostic line, latest state wins
  const state = new Map<string, boolean>();
  for (const s of spans) {
    if (s.line > line) break;
    if (s.ids === null) {
      // bare `#pragma warning disable/restore` — flip the wildcard
      state.set("*", s.disable);
    } else {
      for (const id of s.ids) state.set(id, s.disable);
    }
  }
  const c = normCode(code);
  return state.get(c) === true || state.get("*") === true;
}
