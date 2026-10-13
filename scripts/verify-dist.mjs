#!/usr/bin/env node
/** VelvetSharp — post-build DIST assertions (v0.7.1).
 *
 *  Runs AFTER `vite build` (and again after packaging) to catch "the exe
 *  shipped with a stale/broken bundle" regressions: every feature surface
 *  must be present in the compiled artifacts. Clear PASS/FAIL lines, exit 2
 *  on any failure — wire it into CI or run `npm run verify:dist`. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "app", "dist");

const results = [];
const check = (name, ok) => { results.push([name, !!ok]); console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`); };

function read(p) { return fs.readFileSync(p, "utf8"); }
function exists(p) { return fs.existsSync(p); }
function jsBundle() {
  const dir = path.join(DIST, "assets");
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f));
}
function bundleText() {
  return jsBundle().map(read).join("\n");
}

console.log("== verify-dist ==");

// 1. core artifacts
check("dist/index.html exists", exists(path.join(DIST, "index.html")));
check("Unity API db shipped", exists(path.join(DIST, "api/unityengine.db.json")));
check("BCL db shipped", exists(path.join(DIST, "api/bcl.db.json")));
check("tree-sitter wasm shipped", exists(path.join(DIST, "wasm/tree-sitter.wasm")) || fs.readdirSync(path.join(DIST, "wasm")).some((f) => f.startsWith("tree-sitter")));
check("demo workspace manifest", exists(path.join(DIST, "demo/manifest.json")));

const js = bundleText();
const html = read(path.join(DIST, "index.html"));

// 2. v0.5.0 features still present
check("problems bar component", js.includes("Project-wide problems") || /problems-bar/.test(js));
check("snippet engine (loop-var bump)", js.includes("forr") && js.includes("foreach"));
check("asmdef summary chip", js.includes("asmdef"));

// 3. v0.6.0 features still present
check("dependency graph toolbar", js.includes("Dependencies") && /dg-toolbar|dg-layouts/.test(js));
check("4 graph layouts", js.includes("Hierarchical") && js.includes("Organic") && js.includes("Circular") && js.includes("Business"));
check("F2 rename widget", js.includes("Rename") && /rw-input|rename across the project|across the project/.test(js));

// 4. v0.7.0 features present
check("theme picker modal", /theme-grid|theme-card/.test(js));
check("7 themes registered", ["velvet-dark", "rider-dark", "unity-slate", "catppuccin-mocha", "tokyo-night", "gruvbox-dark", "clean-light"].every((t) => js.includes(t)));
check("EOL chip (LF/CRLF)", /CRLF/.test(js) && /EndOfLineSequence/.test(js));
check("explorer file ops (New File/Folder, Delete, Rename)", js.includes("New File") && js.includes("New Folder") && js.includes("Delete") && /Rename/.test(js));
check("auto-save wiring", /autoSave|auto-save/i.test(js));
check("word wrap toggle (Alt+Z)", /wordWrap/.test(js));
check("deep single-RPC edit pipeline", /syncFiles/.test(js));
check("duplicate type lint message", js.includes("duplicate type definition"));

// 4b. v0.7.1 features present
check("self-healing native bridge (nl-bridge module)", js.includes("bridge offline") && js.includes("filesystem.readFile"));
check("bridge status chip", /bridge-chip|bridge ok/.test(js));
check("error popup with stack trace", js.includes("copy details") && /error-popup-stack/.test(js));
check("settings modal (top ⚙ button)", js.includes("Settings") && /settings-modal|settingsOpen/.test(js));
check("disk-backed config store", js.includes("config.json") && /VelvetSharp/.test(js));
check("config hydration at boot", /hydrateConfigFromDisk/.test(js));
check("no fragile stock client import", !/@neutralinojs\/lib/.test(js));

// 4c. version system present (bumped every phase — see VERSIONS.md checklist)
check("version chip (status bar)", /version-chip/.test(js) && js.includes("Phase 13"));
check("Settings version row (build 13.0.0)", js.includes("13.0.0") && /settings-path/.test(js));
check("no stale 0.7.1 branding", !js.includes("v0.7.1 —"));

// 4d. Phase 8 features present
check("usages panel (select symbol → uses + origin)", js.includes("Uses of") && /uses-list|uses-panel/.test(js));
check("findUses RPC wired", /findUses/.test(js));
check("Shift+F12 find-uses keybinding", /F12/.test(js));
check("Unity magic methods injected (injection marker)", js.includes("Unity event function"));
check("graph nodes are types only (legend)", js.includes("enums only"));

// 4e. Phase 9 features present
check("call-flow view mode toggle", /graphMode/.test(js) && js.includes("Call flow"));
check("callFlow RPC wired", /callFlow/.test(js));
check("problems right-click copy menu", js.includes("Copy this problem") && js.includes("Copy all problems"));
check("singleton self-loop legend (graph)", js.includes("static singleton"));
check("no ambiguous-reference warnings (suppressed)", !/Ambiguous reference:/.test(js));
check("phase history retained (VERSIONS.md lists every phase)", (() => {
  try { const v = read(path.join(ROOT, "VERSIONS.md")); return v.includes("9.0.0") && v.includes("8.0.0"); } catch { return false; }
})());

// 4f. Phase 10 features present
check("vertical tidy-tree layout (types mode button)", js.includes("Vertical") && js.includes("flowchart-style tidy tree"));
check("flow mode forces vertical flowchart", js.includes("vertical"));
check("instant bare completions (local fast path)", js.includes("· this file"));
check("suggest fast path + brain RPC wired", /completions\(/.test(js));
check("navigation history (Go Back / Go Forward)", js.includes("Navigate: Go Back") && js.includes("no earlier position"));
check("Alt+Left/Right keybinding registered", /ArrowLeft/.test(js) && /ArrowRight/.test(js));
check("Ctrl+Wheel editor zoom", js.includes("mouseWheelZoom"));
check("graph load-error state (no silent blank)", js.includes("graph failed to load"));
check("non-passive graph wheel listener", js.includes("wheel") && !js.includes("onWheel"));

// 4g. Phase 11 features present
check("editor right-click menu with Collapse submenu", js.includes("Collapse by Methods") && js.includes("Collapse by #Regions") && js.includes("Collapse All") && js.includes("Expand All"));
check("XML doc comments collapse option", js.includes("Collapse XML Doc Comments"));
check("folding range provider registered", js.includes("FoldingRangeKind.Region") && js.includes("FoldingRangeKind.Comment"));
check("/// XML documentation completion", js.includes("/// XML documentation"));
check("Enter accepts suggestions (typed + Enter)", js.includes("acceptSuggestionOnEnter"));
check("inactive branch dimming decoration", /vs-inactive-line/.test(js));
check("preprocessor full-line directive color", js.includes("\\w+.*$") && js.includes("preprocessor"));
check("Unity project version detection (ProjectVersion.txt)", js.includes("ProjectVersion.txt") && js.includes("m_EditorVersion"));
check("custom scripting defines detection", js.includes("scriptingDefineSymbols"));
check("collapse commands in palette", js.includes("View: Collapse by Methods") && js.includes("View: Expand All"));
check("editor context menu capture wiring", js.includes("setEditorCtxMenu"));
check("Phase 13 version chip", js.includes("Phase 13") && js.includes("13.0.0"));
// 4i. Phase 12 — rock-solid bridge + never-miss completions
check("two-lane brain (fast + heavy workers)", js.includes("lane crashed: ") && js.includes("simulateCrash") && js.includes("lane is back online"));
check("lane crash recovery wired (respawn + resync)", js.includes("lane restarted") && js.includes("onRespawn"));
check("prefix-chain cache consumer + guarded late re-trigger", js.includes("vs-brain-late") && js.includes("editor.action.triggerSuggest"));
check("word-based suggestions OFF (no more 'abc' noise)", /wordBasedSuggestions/.test(js) && !/wordBasedSuggestions:"(currentDocument|allDocuments|matchingDocuments|true)"/.test(js));
check("bridge: in-flight replay after socket drop", js.includes("replayed") && js.includes("dropped twice before"));
check("bridge: consecutive-timeout zombie rule (resets on success)", js.includes("consecTimeouts"));
check("bridge: idle heartbeat + wake reconnect", js.includes("app.getProcessId") && /visibilitychange/.test(js) && /"online"/.test(js));
check("bridge: 25s file IO budget", /25e3|25_000|25000/.test(js));
// 4h. Phase 11.1 — PR #1 merged: class-aware singleton + extra Unity snippets
check("class-aware Singleton snippet bundle (PR #1)", js.includes("SingletonPersistent") && js.includes("GizmoSphere") && js.includes("TryGetComponent"));
check("singleton Awake guard shipped", js.includes("an instance already exists on"));

// 4j. Phase 13 — custom-methods-only call flow + crash-proof graph view
check("flow shows ONLY custom methods (engine/API calls not drawn)", js.includes("only your custom methods") && js.includes("engine/API calls are not drawn"));
check("hidden engine/API call chip (toolbar)", js.includes("engine/API hidden") && js.includes("hiddenCalls"));
check("cross-file custom method terminals (x:: + defining file)", js.includes("x::") && js.includes("custom method from another script") && js.includes("crossCount"));
check("per-caller call-order badges (1·2·3 localized per method)", js.includes("dg-ord") && js.includes("call order inside the method body"));
check("dynamic node width (boxes fit the entire name)", js.includes("another script") && js.includes("data-w"));
check("copyable graph errors (version + mode + script + stack)", js.includes("⧉ copy error") && js.includes("graph error copied — paste it into your report"));
check("render-crash containment (error boundary keeps the app alive)", js.includes("hit an internal error while rendering") && js.includes("⟳ retry"));

// 5. no stale references to removed APIs
check("no defineVelvetTheme remnant (theme system replaced it)", !js.includes("defineVelvetTheme"));

// 6. index.html bootstraps the app
check("index.html mounts the root", /id="root"/.test(html));

const failed = results.filter(([, ok]) => !ok);
console.log(`\n=========== verify-dist: ${results.length - failed.length}/${results.length} PASS ===========`);
for (const [name] of failed) console.log("  FAILED:", name);
process.exit(failed.length ? 2 : 0);
