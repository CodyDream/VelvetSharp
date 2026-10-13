/** VelvetSharp — Monaco setup v3: 7 themes, custom C# language, brain-backed providers */
// @ts-ignore — monaco 0.57 exports map: API surface lives here (root entry only registers languages)
import * as monacoApi from "monaco-editor/editor/editor.main.js";
// @ts-ignore — vite worker import (local shim avoids package-exports resolution issues)
import EditorWorker from "./editor-worker.ts?worker";
import { CS_MONARCH, CS_LANGUAGE_CONFIG, CSHARP_LANG } from "./cs-monarch";
import { SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS } from "@brain/semantic";
import { computeFoldRanges } from "@brain/folding";
import { xmlDocForSource } from "@brain/xmldoc";
import { PP_DIRECTIVES } from "@brain/preproc";
import type { BrainClient } from "./brain-client";
import { cacheLookup, cacheStore, newCacheStore } from "./completion-cache";
import { defineAllThemes, applyTheme, getSavedThemeId, DEFAULT_THEME } from "./themes";
import { eolOfMonaco, convertEol } from "./eol";

(self as any).MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

export { defineAllThemes, applyTheme, getSavedThemeId, DEFAULT_THEME };

let langReady = false;
export function ensureLanguage() {
  if (langReady) return;
  langReady = true;
  monaco.languages.register({ id: CSHARP_LANG });
  monaco.languages.setMonarchTokensProvider(CSHARP_LANG, CS_MONARCH as any);
  monaco.languages.setLanguageConfiguration(CSHARP_LANG, CS_LANGUAGE_CONFIG as any);

  // Phase 11 — precise folding ranges power BOTH the gutter arrows and the
  // right-click Collapse submenu: member bodies fold from the SIGNATURE line
  // (VS/Rider behaviour), plus #region / #if / doc comments / block comments.
  // Registering a provider replaces Monaco's indentation-based ranges.
  monaco.languages.registerFoldingRangeProvider(CSHARP_LANG, {
    provideFoldingRanges(model) {
      try {
        return computeFoldRanges(model.getValue()).map((r) => ({
          start: r.startLine + 1,
          end: r.endLine + 1,
          kind: r.kind === "region" || r.kind === "if"
            ? monaco.languages.FoldingRangeKind.Region
            : r.kind === "doc" || r.kind === "comment"
              ? monaco.languages.FoldingRangeKind.Comment
              : undefined,
        }));
      } catch {
        return [];
      }
    },
  });
}

let KIND_MAP: Record<string, monaco.languages.CompletionItemKind> | null = null;
function getKindMap(): Record<string, monaco.languages.CompletionItemKind> {
  if (KIND_MAP) return KIND_MAP;
  KIND_MAP = {
  method: monaco.languages.CompletionItemKind.Method,
  property: monaco.languages.CompletionItemKind.Property,
  field: monaco.languages.CompletionItemKind.Field,
  enum: monaco.languages.CompletionItemKind.Enum,
  enumMember: monaco.languages.CompletionItemKind.EnumMember,
  class: monaco.languages.CompletionItemKind.Class,
  struct: monaco.languages.CompletionItemKind.Struct,
  interface: monaco.languages.CompletionItemKind.Interface,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  snippet: monaco.languages.CompletionItemKind.Snippet,
  local: monaco.languages.CompletionItemKind.Variable,
  event: monaco.languages.CompletionItemKind.Event,
  namespace: monaco.languages.CompletionItemKind.Module,
  nameSuggestion: monaco.languages.CompletionItemKind.Variable,
  };
  return KIND_MAP;
}

/* ---------------- Phase 10/12 — instant bare completions (fast path) ----------------
 *  The brain is the source of truth, but it lives in a worker that is often
 *  busy the moment you need suggestions (every keystroke queues a parse, plus
 *  project sweeps and auto-save IO). Under load the suggest widget popped
 *  late, flickered or not at all — "completion does not pop, not solid, not
 *  consistent". The fast path computes same-file methods / fields /
 *  properties synchronously from the model text, so the widget ALWAYS pops
 *  immediately; the brain's richer answer (docs, parameter placeholders,
 *  inherited family members) is merged in via the prefix-chain cache and a
 *  guarded late re-trigger.
 *
 *  Phase 12 fixes on top:
 *   - the cache is now a PREFIX CHAIN (a "tr" answer filters down to "tri") —
 *     the old exact-match lookup made the documented longer-prefix purpose
 *     impossible;
 *   - when the synchronous floor is non-empty it is returned IMMEDIATELY and
 *     the brain answer upgrades the cache (and the open widget) in the
 *     background — typing is never blocked by a worker round-trip;
 *   - member access ("foo.") is bounded (300 ms) and falls back to the last
 *     good member answer for the file instead of waiting forever;
 *   - the provider never returns a bare empty list on error — it serves the
 *     last good answer for the file (word-based suggestions are OFF, see
 *     App.tsx, so empty means a clean "No suggestions", never "abc" noise). */
const bareCache = newCacheStore();
const lastGoodByPath = new Map<string, RawItem[]>();
const lastMemberByPath = new Map<string, RawItem[]>();
let lastAutoRetrigger = 0;

const raceBudget = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
const C_KEYWORDS = new Set([
  "if", "else", "for", "foreach", "while", "do", "switch", "case", "catch", "using",
  "return", "throw", "new", "await", "lock", "fixed", "unsafe", "checked", "unchecked",
  "yield", "when", "typeof", "nameof", "sizeof", "get", "set", "add", "remove", "value",
]);

/** the bare identifier being typed, or null when the caret is NOT in a bare
 *  context (member access `x.` and using-directives go straight to the brain) */
function barePrefixAt(model: any, position: any): string | null {
  try {
    const lineText = model.getLineContent(position.lineNumber) ?? "";
    const before = lineText.slice(0, position.column - 1);
    if (/(?:^|\s)using\s+[\w.]*$/.test(before)) return null; // namespace completion
    const m = before.match(/([A-Za-z_][A-Za-z0-9_]*)?$/);
    const prefix = m?.[1] ?? "";
    const rest = before.slice(0, before.length - prefix.length);
    if (rest.trimEnd().endsWith(".")) return null; // member access — brain path
    return prefix;
  } catch { return null; }
}

function sameCaret(ed: any, lineNumber: number, column: number): boolean {
  try {
    const p = ed?.getPosition?.();
    return !!p && p.lineNumber === lineNumber && p.column === column;
  } catch { return false; }
}

function suggestWidgetVisible(): boolean {
  try { return !!document.querySelector(".suggest-widget.visible"); } catch { return false; }
}

/** Phase 12 — background upgrade: when the brain answers AFTER we already
 *  served the instant floor, merge its richer answer into the prefix-chain
 *  cache and — ONLY if the caret has not moved and the suggest widget is
 *  still open and the answer adds something the user cannot already see —
 *  re-trigger suggest so the widget refreshes in place. Guards (cooldown,
 *  caret check, visibility check, "nothing new" check) make this loop-free:
 *  the re-trigger hits the just-updated cache and returns instantly. */
function lateUpgrade(
  req: Promise<RawItem[]>, path: string, prefix: string, locals: RawItem[],
  shown: RawItem[], lineNumber: number, column: number,
): void {
  void req.then((brain) => {
    if (!Array.isArray(brain) || !brain.length) return;
    cacheStore(bareCache, path, prefix, dedupeItems(brain, locals));
    const ed = (window as any).__editor;
    if (!ed || !sameCaret(ed, lineNumber, column)) return; // typing moved on — cache only
    if (!suggestWidgetVisible()) return;                   // widget closed — never pop it open
    if (Date.now() - lastAutoRetrigger < 500) return;      // retrigger cooldown
    const have = new Set(shown.map((i) => i?.label));
    if (!brain.some((i) => i && i.label && !have.has(i.label))) return; // nothing new to show
    lastAutoRetrigger = Date.now();
    try { ed.trigger("vs-brain-late", "editor.action.triggerSuggest"); } catch { /* widget gone */ }
  }).catch(() => { /* lane crash → recovery path owns it */ });
}

/** same-file declarations scanned synchronously from the model text. Line-based
 *  and deliberately conservative: this is the always-there floor, not the
 *  brain's replacement — the raced RPC result stays the richer source. */
function localMemberItems(model: any, prefix: string): RawItem[] {
  let text = "";
  try { text = model.getValue() ?? ""; } catch { return []; }
  if (!text || text.length > 500_000) return []; // huge files → brain only
  const p = prefix.toLowerCase();
  const out: RawItem[] = [];
  const seen = new Set<string>();
  const push = (name: string, kind: "method" | "property" | "field", detail: string) => {
    if (!name || C_KEYWORDS.has(name) || seen.has(name)) return;
    if (p && !name.toLowerCase().startsWith(p)) return;
    seen.add(name);
    out.push({
      label: name,
      kind: kind === "method" ? "method" : kind === "field" ? "field" : "property",
      detail: detail + " · this file",
      insert: kind === "method" ? name + "()" : name,
      sortText: (kind === "method" ? "03" : "04") + name.toLowerCase(),
      filterText: name,
    });
  };
  const modRe = /^(?:public|private|protected|internal|static|async|override|virtual|sealed|abstract|extern|unsafe|partial|new|const|readonly|volatile|required)\s+/;
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t || t.length > 300 || t.startsWith("//") || t.startsWith("*") || t.startsWith("[")) continue;
    let s = t;
    let mods = "";
    for (;;) { // peel modifiers to find the shape underneath
      const m2 = s.match(modRe);
      if (!m2) break;
      mods += m2[0];
      s = s.slice(m2[0].length);
    }
    // method: Type Name( — same line params only (floor quality; the brain
    // completes multi-line signatures when it answers)
    let m = s.match(/^([A-Za-z_][\w.<>\[\],?]*?(?:\s*<[^<>]*>)?(?:\s*\[\s*\])?)\s+([A-Za-z_][\w]*)\s*\(/);
    if (m && !C_KEYWORDS.has(m[2])) { push(m[2], "method", `${m[1].trim()} ${m[2]}(…)`); continue; }
    // field / property: needs modifiers so locals never leak in
    if (mods) {
      m = s.match(/^([A-Za-z_][\w.<>\[\],?]*?(?:<[^<>]*>)?(?:\[\s*\])?)\s+([A-Za-z_][\w]*)\s*(?=[;={])/);
      if (m && !C_KEYWORDS.has(m[2])) {
        const isProp = s[m[0].length] === "{";
        push(m[2], isProp ? "property" : "field", `${m[1].trim()} ${m[2]}`);
      }
    }
  }
  return out;
}

function dedupeItems(primary: RawItem[], fallback: RawItem[]): RawItem[] {
  const seen = new Set(primary.map((c) => c.label));
  const out = [...primary];
  for (const c of fallback) if (!seen.has(c.label)) { seen.add(c.label); out.push(c); }
  return out;
}

let activeClient: BrainClient | null = null;

async function provideCompletionImpl(model: any, position: any): Promise<{ suggestions: monaco.languages.CompletionItem[] }> {
  // Phase 11 — `///` above a member offers the XML documentation skeleton
  // (typed + Enter inserts <summary>/<param>/<returns> with tab stops).
  // Intercepted BEFORE everything else so the widget is instant and stable.
  const docSnippet = docCommentSuggestion(model, position);
  if (docSnippet) return docSnippet;

  // Phase 11 latent-bug fix: this module-level function referenced `client`,
  // which only existed as registerProviders' parameter — at runtime the
  // provider threw ReferenceError and the try/catch swallowed it into an
  // empty suggestion list. The registered client now lives in activeClient
  // (with the boot() window hook as a belt-and-braces fallback).
  const client = activeClient ?? ((window as any).__client as BrainClient | null);
  if (!client) return { suggestions: [] };

  const line = position.lineNumber - 1;
  const col = position.column - 1;
  const path = pathOf(model);
  const prefix = barePrefixAt(model, position);
  const req = client.completions(path, line, col);

  if (prefix === null) {
    // member access / using — the brain's specialised paths. Phase 12: the
    // wait is BOUNDED (the old code awaited unbounded, so a wedged worker
    // meant "foo." never completed) and a miss falls back to the file's last
    // good member answer while the live answer upgrades the cache behind it.
    let brain: RawItem[] | null = null;
    try { brain = await raceBudget(req, 300); } catch { brain = null; }
    if (brain) {
      if (brain.length) {
        lastMemberByPath.set(path, brain);
        lastGoodByPath.set(path, brain);
      }
      return { suggestions: toSuggestions(brain, model, position) };
    }
    lateUpgrade(req, path, "", [], lastMemberByPath.get(path) ?? [], position.lineNumber, position.column);
    return { suggestions: toSuggestions(lastMemberByPath.get(path) ?? [], model, position) };
  }

  // ---- bare context: instant local floor + background brain upgrade ----
  const locals = localMemberItems(model, prefix);
  const cachedItems = cacheLookup(bareCache, path, prefix) as RawItem[];
  const floor = dedupeItems(cachedItems, locals);

  if (floor.length) {
    // instant answer — typing is never blocked by a worker round-trip
    lateUpgrade(req, path, prefix, locals, floor, position.lineNumber, position.column);
    lastGoodByPath.set(path, floor);
    return { suggestions: toSuggestions(floor, model, position) };
  }
  // empty floor (brand-new identifier, or a huge file's first light parse):
  // give the fast lane a short budget before answering empty — the widget
  // then shows a clean "No suggestions" and the late upgrade refreshes it.
  try {
    const brain = await raceBudget(req, 140);
    if (brain) {
      if (brain.length) {
        cacheStore(bareCache, path, prefix, dedupeItems(brain, locals) as any);
        lastGoodByPath.set(path, brain);
      }
      return { suggestions: toSuggestions(brain, model, position) };
    }
  } catch { /* lane crash → recovery path; serve what we have */ }
  lateUpgrade(req, path, prefix, locals, [], position.lineNumber, position.column);
  return { suggestions: [] };
}

export function registerProviders(client: BrainClient) {
  activeClient = client;
  monaco.languages.registerCompletionItemProvider(CSHARP_LANG, {
    // Phase 10: plain space removed — it fired a request after EVERY finished
    // word and popped the widget with the whole universe (a "not consistent"
    // complaint); quickSuggestions handles typing naturally.
    // Phase 11: "/" triggers the /// XML documentation skeleton.
    // Phase 15: "#" starts directive completion and " " pops the symbol list
    // inside #if/#define argument zones — EVERYWHERE ELSE a space fires the
    // provider only to answer empty, so the Phase 10 universe-pop stays dead.
    triggerCharacters: [".", "[", "@", "(", "/", "#", " "],
    async provideCompletionItems(model, position, context: any) {
      const spaceFired = context?.triggerCharacter === " "
        && context?.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter;
      try {
        const pp = await preprocSuggestions(model, position, activeClient ?? ((window as any).__client as BrainClient | null));
        if (pp) return { suggestions: pp };
      } catch { /* preproc hiccup must never break the normal path */ }
      if (spaceFired) return { suggestions: [] };
      try {
        return await provideCompletionImpl(model, position);
      } catch {
        // a completion bug must NEVER surface as an unhandled rejection (which
        // opens the global error popup mid-typing). Phase 12: degrade to the
        // file's last GOOD answer instead of a bare empty list — Monaco
        // filters it against the typed prefix, so a stale superset is safe,
        // and with word-based suggestions off the alternative is a clean
        // "No suggestions" rather than random words from the document.
        try {
          const last = lastGoodByPath.get(pathOf(model));
          if (last?.length) return { suggestions: toSuggestions(last, model, position) };
        } catch { /* model gone */ }
        return { suggestions: [] };
      }
    },
  });

  monaco.languages.registerHoverProvider(CSHARP_LANG, {
    async provideHover(model, position) {
      // Phase 15 — hovering a directive name or symbol on a # line explains it
      // (usage signature / define source + sites) without the brain round-trip
      try {
        const pp = await ppHover(model, position, activeClient ?? ((window as any).__client as BrainClient | null));
        if (pp) return pp;
      } catch { /* fall through to the normal hover */ }
      let h: any;
      try {
        h = await client.hover(pathOf(model), position.lineNumber - 1, position.column - 1);
      } catch {
        return null;
      }
      if (!h) return null;
      return {
        range: new monaco.Range(position.lineNumber, 1, position.lineNumber, 1),
        contents: [
          { value: "```csharp\n" + h.signature + "\n```" },
          ...(h.doc ? [{ value: h.doc }] : []),
        ],
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider(CSHARP_LANG, {
    signatureHelpTriggerCharacters: ["(", ","],
    async provideSignatureHelp(model, position) {
      let s: any;
      try {
        s = await client.signatureHelp(pathOf(model), position.lineNumber - 1, position.column - 1);
      } catch {
        return null;
      }
      if (!s) return null;
      return {
        dispose: () => {},
        value: {
          activeSignature: 0,
          activeParameter: Math.max(0, s.activeParam),
          signatures: [{
            label: s.label,
            parameters: (s.params ?? []).map((p: any) => ({ label: `${p.type} ${p.name}`.trim(), documentation: (p as any).doc })),
            documentation: s.doc ? { value: s.doc } : undefined,
          }],
        },
      };
    },
  });

  monaco.languages.registerDefinitionProvider(CSHARP_LANG, {
    async provideDefinition(model, position) {
      let d: any;
      try {
        d = await client.definitions(pathOf(model), position.lineNumber - 1, position.column - 1);
      } catch {
        return null;
      }
      if (!d) return null;
      return {
        uri: model.uri.with({ path: "/" + d.file }),
        range: new monaco.Range(d.line + 1, d.col + 1, d.line + 1, d.col + 1 + d.name.length),
      };
    },
  });

  monaco.languages.registerDocumentSemanticTokensProvider(CSHARP_LANG, {
    getLegend() {
      return { tokenTypes: SEMANTIC_TOKEN_TYPES as unknown as string[], tokenModifiers: SEMANTIC_TOKEN_MODIFIERS as unknown as string[] };
    },
    async provideDocumentSemanticTokens(model) {
      try {
        const data = await client.semanticTokens(pathOf(model), model.getValue());
        return { data: data instanceof Uint32Array ? data : new Uint32Array(data ?? []) };
      } catch {
        return { data: new Uint32Array(0) };
      }
    },
    releaseDocumentSemanticTokens() {},
  });
}

/** v0.5.0 — machine-applicable quick fixes (auto `using N;` on CS0246).
 *  `getDiags` is injected by App.tsx so the provider reads the freshest
 *  semantic diagnostics for the open document. */
export function registerQuickFixes(getDiags: (path: string) => { line: number; col: number; length: number; fix?: { kind: string; ns: string; title: string; line: number; col: number; text: string } }[]) {
  monaco.languages.registerCodeActionProvider(CSHARP_LANG, {
    provideCodeActions(model, range) {
      const path = pathOf(model);
      const diags = getDiags(path) ?? [];
      const actions: monaco.languages.CodeAction[] = [];
      const applied = new Set<string>();
      for (const d of diags) {
        if (!d.fix || d.fix.kind !== "addUsing") continue;
        if (applied.has(d.fix.ns)) continue;
        // the fix must intersect the requested range (marker line / cursor line)
        const startLine = d.line + 1;
        const endLine = d.line + 1;
        const startCol = d.col + 1;
        const endCol = d.col + 1 + Math.max(1, d.length);
        const intersects = !(range.endLineNumber < startLine
          || (range.endLineNumber === startLine && range.endColumn < startCol)
          || range.startLineNumber > endLine
          || (range.startLineNumber === endLine && range.startColumn > endCol));
        if (!intersects) continue;
        applied.add(d.fix.ns);
        actions.push({
          title: d.fix.title,
          kind: "quickfix",
          isPreferred: true,
          edit: {
            edits: [{
              resource: model.uri,
              versionId: model.getVersionId(),
              textEdit: {
                range: new monaco.Range(d.fix.line + 1, d.fix.col + 1, d.fix.line + 1, d.fix.col + 1),
                text: convertEol(d.fix.text, eolOfMonaco(model)), // CRLF documents stay CRLF
              },
            } as any],
          },
        });
      }
      return { actions, dispose: () => {} };
    },
  }, {
    providedCodeActionKinds: ["quickfix"],
  });
}

function pathOf(model: monaco.editor.ITextModel): string {
  return decodeURIComponent(model.uri.path).replace(/^\//, "");
}

/* ---------------- Phase 11 — /// XML documentation completion ----------------
 *  VS parity: type /// on the empty line above a member → a completion offers
 *  the doc skeleton; Enter inserts <summary> (+ <param> per parameter,
 *  <returns> for non-void, <value> for properties) with tab stops.
 *  Pure text scan — no worker round-trip, so it never "does not pop". */
function docCommentSuggestion(model: any, position: any): { suggestions: monaco.languages.CompletionItem[] } | null {
  try {
    const lineText: string = model.getLineContent(position.lineNumber) ?? "";
    // fires only when the line IS the just-typed /// (whitespace before is ok)
    if (!/^\s*\/\/\/\s*$/.test(lineText)) return null;
    const src: string = model.getValue();
    const doc = xmlDocForSource(src, position.lineNumber - 1);
    if (!doc) return null;
    const eol = eolOfMonaco(model);
    const indent = (lineText.match(/^\s*/) ?? [""])[0];
    // keep the typed indentation on every skeleton line
    const body = doc.snippet.split("\n").map((l) => indent + l).join("\n");
    return {
      suggestions: [{
        label: "/// XML documentation",
        kind: monaco.languages.CompletionItemKind.Snippet,
        detail: `${doc.kind} ${doc.memberName} — insert <summary>${doc.kind === "method" || doc.kind === "constructor" || doc.kind === "indexer" ? "/<param>" : ""}${doc.kind === "method" || doc.kind === "indexer" ? "/<returns>" : ""}${doc.kind === "property" ? "/<value>" : ""}`,
        insertText: convertEol(body, eol),
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range: new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column),
        sortText: "0000",
        filterText: "///",
        preselect: true,
      }],
    };
  } catch {
    return null;
  }
}

/* ---------------- Phase 15 — preprocessor completions + hover ----------------
 *  Typing `#` completes every C# directive (plus self-closing snippets for
 *  #if/#region); after `#if ` / `#elif ` / `#define ` / `#undef ` the widget
 *  offers the FULL symbol world — Unity built-ins, the UNITY_x_y_OR_NEWER
 *  chain, csproj DefineConstants, scriptingDefineSymbols, csc.rsp defines and
 *  every `#define` found in project code, each labelled with WHERE it comes
 *  from. `#pragma`/`#nullable`/`#line` complete their keywords. Hovering a
 *  symbol (or a directive name) inside a directive line explains it inline.
 *  The symbol catalog is one small fast-lane RPC cached for 2.5 s. */
interface PPDefInfoDto { name: string; source: string; detail: string; definedIn: { path: string; line: number }[] }
/** monaco.* namespace types do not resolve in type positions in this file
 *  (pre-existing TS2503 class, the proxy is typed `any`) — local alias */
type MonacoCompletionItem = any;

const PP_CATALOG_TTL_MS = 2500;
let ppCatalogCache: { at: number; symbols: PPDefInfoDto[] } | null = null;

async function ppSymbols(client: BrainClient | null): Promise<PPDefInfoDto[]> {
  if (ppCatalogCache && Date.now() - ppCatalogCache.at < PP_CATALOG_TTL_MS) return ppCatalogCache.symbols;
  if (!client) return ppCatalogCache?.symbols ?? [];
  try {
    const res = await client.preprocCatalog();
    const symbols = Array.isArray(res?.symbols) ? res.symbols : [];
    ppCatalogCache = { at: Date.now(), symbols };
    return symbols;
  } catch {
    return ppCatalogCache?.symbols ?? [];
  }
}

const PP_SOURCE_LABELS: Record<string, string> = {
  code: "defined in code",
  scripting: "Player Settings · Scripting Define Symbols",
  project: "csproj · DefineConstants",
  version: "Unity version symbol",
  unity: "Unity built-in",
};

function ppSymbolMd(s: PPDefInfoDto): string {
  const parts: string[] = [`**${s.name}** — ${s.detail}`];
  const sites = s.definedIn ?? [];
  if (sites.length) {
    parts.push("", "Defined in:");
    for (const d of sites.slice(0, 4)) parts.push(`- \`${d.path}\` (line ${d.line + 1})`);
    if (sites.length > 4) parts.push(`- …and ${sites.length - 4} more`);
  }
  return parts.join("\n");
}

type PPContext =
  | { type: "directive"; typed: string; hashCol: number }   // typing the directive word itself
  | { type: "symbol"; typed: string }                       // argument zone of #if/#elif/#define/#undef
  | { type: "arg"; directive: string; arg: string };        // keyword zone of #pragma/#nullable/#line

/** classify the caret's position inside a preprocessor directive line, or
 *  null when the caret is not in a completable preprocessor context. The `#`
 *  must be the first non-whitespace character of the line (C# rules). */
function preprocContext(model: any, position: any): PPContext | null {
  try {
    const lineText: string = model.getLineContent(position.lineNumber) ?? "";
    const before = lineText.slice(0, position.column - 1);
    const hash = before.search(/#/);
    if (hash < 0) return null;
    if (before.slice(0, hash).trim() !== "") return null; // # inside code/string — not a directive
    const afterHash = before.slice(hash + 1);
    // only directive-ish characters may sit between the # and the caret
    if (/[^A-Za-z0-9_\s!()&|=]/.test(afterHash)) return null;
    const m = /^(\w*)(?:\s+(.*))?$/.exec(afterHash);
    if (!m) return null;
    const word = (m[1] ?? "").toLowerCase();
    const arg = m[2] ?? "";
    const caretAfterWord = arg === "" && before.length === hash + 1 + word.length;
    if (!word || caretAfterWord) {
      return { type: "directive", typed: m[1] ?? "", hashCol: hash + 1 };
    }
    if (word === "if" || word === "elif" || word === "define" || word === "undef") {
      return { type: "symbol", typed: /[A-Za-z_]\w*$/.exec(arg)?.[0] ?? "" };
    }
    if (word === "pragma" || word === "nullable" || word === "line") {
      return { type: "arg", directive: word, arg: arg.trim() };
    }
    return null; // #region/#error/#warning/#else… — freeform, no completion
  } catch { return null; }
}

/** the completion widget for any preprocessor context (null = not a directive
 *  line — the caller falls through to the normal completion path) */
async function preprocSuggestions(model: any, position: any, client: BrainClient | null): Promise<MonacoCompletionItem[] | null> {
  const ctx = preprocContext(model, position);
  if (!ctx) return null;
  const lineNo: number = position.lineNumber;

  if (ctx.type === "directive") {
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(lineNo, ctx.hashCol, lineNo, Math.max(ctx.hashCol, word.endColumn ?? ctx.hashCol));
    const items: MonacoCompletionItem[] = [];
    for (const d of PP_DIRECTIVES) {
      items.push({
        label: "#" + d.name,
        kind: monaco.languages.CompletionItemKind.Keyword,
        detail: d.sig,
        documentation: { value: d.doc },
        insertText: "#" + d.name,
        range,
        sortText: "02" + d.name,
        filterText: "#" + d.name,
      });
    }
    // self-closing snippets — the pairs everyone types manually today
    const snippets: [string, string, string][] = [
      ["#if … #endif", "#if ${1:UNITY_EDITOR}\n$0\n#endif", "conditional block with both ends"],
      ["#if UNITY_EDITOR … #endif", "#if UNITY_EDITOR\n$0\n#endif", "editor-only code (Unity define)"],
      ["#region … #endregion", "#region ${1:Name}\n$0\n#endregion", "collapsible region"],
      ["#pragma warning disable", "#pragma warning disable ${1:CS0168}", "suppress a compiler warning"],
    ];
    for (const [label, insert, detail] of snippets) {
      items.push({
        label,
        kind: monaco.languages.CompletionItemKind.Snippet,
        detail,
        insertText: convertEol(insert, eolOfMonaco(model)),
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
        sortText: "01" + label,
        filterText: label,
      });
    }
    return items;
  }

  if (ctx.type === "symbol") {
    const symbols = await ppSymbols(client);
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(lineNo, word.startColumn, lineNo, word.endColumn);
    const SRC_SORT: Record<string, string> = { code: "0", scripting: "1", project: "2", version: "3", unity: "4" };
    return symbols.map((s) => ({
      label: s.name,
      kind: monaco.languages.CompletionItemKind.EnumMember,
      detail: PP_SOURCE_LABELS[s.source] ?? s.detail,
      documentation: { value: ppSymbolMd(s) },
      insertText: s.name,
      range,
      sortText: (SRC_SORT[s.source] ?? "5") + s.name.toLowerCase(),
      filterText: s.name,
    }));
  }

  // ---- keyword arguments of #pragma / #nullable / #line ----
  const word = model.getWordUntilPosition(position);
  const range = new monaco.Range(lineNo, word.startColumn, lineNo, word.endColumn);
  const mk = (label: string, detail: string): MonacoCompletionItem => ({
    label,
    kind: monaco.languages.CompletionItemKind.Keyword,
    detail,
    insertText: label,
    range,
    sortText: "01" + label,
  });
  if (ctx.directive === "pragma") {
    if (!ctx.arg) return [mk("warning", "#pragma warning disable/restore — suppress or re-enable warnings")];
    const wm = /^warning(\s+(.*))?$/i.exec(ctx.arg);
    if (wm) {
      const rest = (wm[2] ?? "").trim().toLowerCase();
      if (/^(disable|restore)\s*$/.test(rest) || /^[a-z]+$/i.test(rest)) {
        // partial "dis…" still returns both — Monaco filters by the typed word
        return [
          mk("disable", "suppress matching warnings from here on"),
          mk("restore", "re-enable matching warnings from here on"),
        ];
      }
      if (/^(disable|restore)\s+.*$/i.test(ctx.arg)) {
        return [
          mk("CS0168", "variable declared but never used"),
          mk("CS0219", "variable assigned but its value never used"),
          mk("CS0414", "field assigned but its value never used"),
          mk("CS0649", "field never assigned to, always default"),
          mk("CS4014", "task not awaited — the call may never run"),
          mk("CS0108", "member hides an inherited member — use new"),
        ];
      }
    }
    return [];
  }
  if (ctx.directive === "nullable") {
    const forms = ["enable", "disable", "restore", "enable warnings", "enable annotations", "disable warnings", "disable annotations", "restore warnings", "restore annotations"];
    const typed = ctx.arg.toLowerCase();
    return forms.filter((f) => !typed || f.startsWith(typed)).map((f) => mk(f, "nullable analysis context (C# 8+)"));
  }
  if (ctx.directive === "line") {
    return [mk("default", "restore the real line numbers"), mk("hidden", "hide the following lines from stepper")];
  }
  return [];
}

/** hover for a directive line: directive names get their usage, symbols get
 *  their SOURCE (Unity built-in / version chain / csproj / Player Settings /
 *  the exact #define sites in code). Returns null → normal hover path. */
async function ppHover(model: any, position: any, client: BrainClient | null): Promise<any | null> {
  const lineText: string = model.getLineContent(position.lineNumber) ?? "";
  if (!/^\s*#/.test(lineText)) return null;
  // the caret/mouse can sit MID-identifier (e.g. on the underscore of
  // E2E_CUSTOM) — getWordUntilPosition would only see the half BEFORE it, so
  // reconstruct the whole identifier from both sides of the caret
  const idx: number = Math.min(position.column - 1, lineText.length); // 0-based
  const before = /[A-Za-z_]\w*$/.exec(lineText.slice(0, idx))?.[0] ?? "";
  const after = /^\w+/.exec(lineText.slice(idx))?.[0] ?? "";
  const word = before + after;
  if (!word || !/^[A-Za-z_]\w*$/.test(word)) return null;
  const startCol = idx - before.length + 1;
  const endCol = startCol + word.length;
  const range = new monaco.Range(position.lineNumber, startCol, position.lineNumber, endCol);
  const dir = PP_DIRECTIVES.find((d) => d.name === word.toLowerCase());
  if (dir) {
    return {
      range,
      contents: [
        { value: "```csharp\n" + dir.sig + "\n```" },
        { value: dir.doc },
      ],
    };
  }
  const symbols = await ppSymbols(client);
  const s = symbols.find((x) => x.name === word);
  if (!s) return null;
  return {
    range,
    contents: [
      { value: "```csharp\n#if " + s.name + "\n```" },
      { value: ppSymbolMd(s) },
    ],
  };
}

/** a completion item as the brain (and the local fast path) emit it */
interface RawItem {
  label: string;
  kind?: string;
  detail?: string;
  doc?: string;
  insert?: string;
  sortText?: string;
  filterText?: string;
}

/** brain items (or fast-path locals) → Monaco suggestions (shared shaping).
 *  `position` is the PROVIDER's caret — ITextModel has no getPosition(). */
function toSuggestions(items: RawItem[], model: monaco.editor.ITextModel, position: monaco.Position): monaco.languages.CompletionItem[] {
  // Phase 12 CRITICAL FIX: `getWordUntilPosition` returns IWordAtPosition —
  // { word, startColumn, endColumn } — which has NO line fields. Since the
  // Phase 10 refactor this code read `word.startLineNumber` (undefined), so
  // EVERY suggestion batch failed Monaco's range validation and the whole
  // widget silently dropped to empty — the real cause of "autocomplete fails
  // and falls back to word suggestions". (v9 had it right; v10 broke it.)
  const word = model.getWordUntilPosition(position);
  const range = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };
  const eol = eolOfMonaco(model); // snippets authored with \n must match the document
  const seen = new Set<string>();
  const suggestions: monaco.languages.CompletionItem[] = [];
  for (const c of items) {
    if (!c || !c.label || seen.has(c.label)) continue;
    seen.add(c.label);
    const rawInsert = c.insert ?? c.label;
    suggestions.push({
      label: c.label,
      kind: getKindMap()[c.kind ?? ""] ?? monaco.languages.CompletionItemKind.Text,
      detail: c.detail,
      documentation: c.doc ? { value: mdDoc(c.detail ?? "", c.doc) } : undefined,
      insertText: convertEol(rawInsert, eol),
      insertTextRules: rawInsert.includes("$") ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
      range,
      sortText: c.sortText ?? c.label,
      filterText: c.filterText ?? c.label,
    });
  }
  return suggestions;
}

function mdDoc(detail: string, doc: string): string {
  return (detail ? `\`${detail}\`\n\n` : "") + doc;
}

// Proxy keeps every property read live regardless of module eval order
const localExports: Record<string, unknown> = { defineAllThemes, applyTheme, getSavedThemeId, DEFAULT_THEME, ensureLanguage, registerProviders, registerQuickFixes, CSHARP_LANG };
export const monaco: any = new Proxy({ __brand: "monaco" } as any, {
  get(_t, k) { return (localExports as any)[k] ?? (monacoApi as any)[k]; },
  has(_t, k) { return k in (localExports as any) || k in (monacoApi as any); },
});

// real ESM named export (proxy properties are not importable)
export { CSHARP_LANG };
