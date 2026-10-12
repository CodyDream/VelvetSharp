/** VelvetSharp — Monaco setup v3: 7 themes, custom C# language, brain-backed providers */
// @ts-ignore — monaco 0.57 exports map: API surface lives here (root entry only registers languages)
import * as monacoApi from "monaco-editor/editor/editor.main.js";
// @ts-ignore — vite worker import (local shim avoids package-exports resolution issues)
import EditorWorker from "./editor-worker.ts?worker";
import { CS_MONARCH, CS_LANGUAGE_CONFIG, CSHARP_LANG } from "./cs-monarch";
import { SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS } from "@brain/semantic";
import type { BrainClient } from "./brain-client";
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

export function registerProviders(client: BrainClient) {
  monaco.languages.registerCompletionItemProvider(CSHARP_LANG, {
    triggerCharacters: [".", " ", "[", "@", "("],
    async provideCompletionItems(model, position) {
      const line = position.lineNumber - 1;
      const col = position.column - 1;
      let items: any[];
      try {
        items = await client.completions(pathOf(model), line, col);
      } catch {
        return { suggestions: [] };
      }
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
        if (seen.has(c.label)) continue;
        seen.add(c.label);
        const rawInsert = c.insert ?? c.label;
        suggestions.push({
          label: c.label,
          kind: getKindMap()[c.kind] ?? monaco.languages.CompletionItemKind.Text,
          detail: c.detail,
          documentation: c.doc ? { value: mdDoc(c.detail ?? "", c.doc) } : undefined,
          insertText: convertEol(rawInsert, eol),
          insertTextRules: rawInsert.includes("$") ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range,
          sortText: c.sortText ?? c.label,
          filterText: c.filterText ?? c.label,
        });
      }
      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider(CSHARP_LANG, {
    async provideHover(model, position) {
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
