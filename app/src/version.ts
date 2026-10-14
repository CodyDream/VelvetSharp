/** VelvetSharp versioning — Phase numbering system (user request, Phase 7).
 *
 *  The user-facing version is the PHASE number: every delivered prompt bumps
 *  the phase by exactly one — numbers are never reused ("you repeated 0.7.1
 *  like three times — jump it up or it becomes confusing").
 *
 *  Phase 11 == internal build 11.0.0 (preprocessor directives are first-class:
 *  Unity define set + version symbols from ProjectVersion.txt + custom
 *  scriptingDefineSymbols, #if/#elif/#else/#endif evaluation with inactive-
 *  branch dimming + diagnostic suppression, structural errors for stray/
 *  unterminated directives, #pragma warning disable/restore honored,
 *  #error/#warning surfaced, full-line directive coloring · editor
 *  right-click menu with the Collapse ▸ submenu — by Methods / by #Regions /
 *  by #if Blocks / XML Doc Comments / All / Expand — backed by a precise
 *  folding provider that folds members from the signature line · /// + Enter
 *  generates the XML documentation skeleton (<summary>/<param>/<returns>/
 *  <value>) · completions client ReferenceError fix). History: 0.1–0.4 ≈
 *  Phase 1–4 · 0.5.0 = Phase 5 · 0.6.0 = Phase 6 · 0.7.x = Phase 7 (renamed —
 *  "0.7.1" was repeated 3×) · Phase 8 = graph types-only + family completions
 *  + magic methods + uses panel · Phase 9 = false-positive kills + problems
 *  right-click + singleton self-loops + Call Flow view · Phase 10 = flow
 *  stability + vertical tidy-tree + instant completions + nav history ·
 *  Phase 11 = 11.0.0 · 11.1.0 = PR #1 merged (class-aware Singleton
 *  snippet with guarded Awake + OnDestroy cleanup, 8 more Unity
 *  snippets: SingletonPersistent, OnEnableDisable, TryGetComponent,
 *  NullGuard, RequireComponent, EventAction, Cooldown, GizmoSphere) ·
 *  Phase 12 = rock-solid desktop connection + never-miss autocomplete ·
 *  Phase 13 = call flow shows only custom methods + order badges + copyable
 *  graph errors · Phase 14 = real find-in-files + MCP for AI agents ·
 *  Phase 15 = full C# + Unity preprocessor support (all 13 directives + the
 *  whole define world autocompletes with sources) ·
 *  Phase 17 = this build (UI OVERHAUL + QOL BATCH — the whole shell is
 *  refreshed: a VS Code-style activity rail replaces the cramped sidebar
 *  tab-row (Explorer/Search/Outline/Problems/Graph/Agent with live error
 *  badge, Settings pinned at the bottom, click-active-icon-to-collapse),
 *  the titlebar gains a command-center search pill, tabs get file icons +
 *  drag-reorder + middle-click close + a right-click menu (Close Others /
 *  Close Saved / Copy Path), a breadcrumbs bar (path segments reveal the
 *  explorer, the caret-following symbol chip opens a jump menu), the
 *  welcome screen becomes a shortcut-card dashboard with recent projects,
 *  and the status bar adds selection info + a flash on status changes.
 *  QOL: Ctrl+Tab/Shift+Tab tab cycling, Ctrl+B sidebar, Ctrl+J problems,
 *  Ctrl+, settings, Ctrl+N new script, Ctrl+Alt+S Save All, F8/Shift+F8
 *  next/previous problem, minimap / sticky-scroll / whitespace prefs,
 *  trim-trailing-whitespace-on-save, Sort Usings command, drag-resizable
 *  sidebar, per-workspace session restore (open tabs + cursors survive a
 *  restart) and the OS window title mirrors the active document.
 *  (Phase 16 was: AGENT BRIDGE — LLM managing buttons move UP into
 *  the titlebar: `⧉ Structure → AI` opens the copy window where the user
 *  picks folders/sub-folders (tri-state checkboxes, presets, path filter,
 *  optional fenced file contents) and copies a paste-ready structure for
 *  web AI assistants; `⇩ Apply JSON ← AI` opens the paste window where the
 *  agent's JSON payload is validated, dry-run planned and applied —
 *  create / modify (exact find→replace or full content) / delete / move
 *  with .meta sidecar handling, buffer-first reads, per-file EOL
 *  preservation, one-undo-step buffer updates and a copyable per-op report
 *  to paste back into the chat; the same applier powers the new MCP
 *  `apply_payload` tool, so MCP agents get write access too; payloads are
 *  guarded (workspace-relative paths only, text-extension allowlist, op
 *  and size caps) and web-LLM dialects are tolerated (op aliases, missing
 *  marker, find-without-replace, .cs create without content gets a
 *  MonoBehaviour starter).
 *  (Phase 15 was: FULL C# + Unity preprocessor support: typing `#`
 *  completes all 13 real C# directives with docs and self-closing snippets,
 *  `#if `/`#elif `/`#define `/`#undef ` complete the whole symbol world —
 *  Unity built-ins, the UNITY_<maj>_<min>_OR_NEWER chain from
 *  ProjectVersion.txt, csproj DefineConstants, Player Settings
 *  scriptingDefineSymbols, Assets/csc.rsp+mcs.rsp -define: flags and every
 *  `#define` found in project code, each labelled with its source; hovering
 *  a directive symbol shows WHERE it is defined; #pragma warning/#nullable/
 *  #line complete their keywords; unknown directives warn with a
 *  did-you-mean hint (#ifdef → "#if"); #define after code errors CS1032;
 *  `#ifdef`/`#ifndef` deliberately absent — C# has no such directives).
 *  (Phase 14 was: real find-in-files: live debounced
 *  Ctrl+Shift+F search with case / whole-word / regex options, match
 *  highlighting and an honest coverage report that scans cache-warm files
 *  instead of silently missing them; MCP integration — a zero-dependency
 *  stdio server (mcp/server.mjs) lets AI agents ask the RUNNING editor for
 *  problems (incl. compiler-style codes), project structure, code search and
 *  file contents, discovered via <dataDir>/VelvetSharp/mcp.json).
 *  Every delivery bumps by one.
 */
export const APP_PHASE = 17;
export const APP_BUILD = "17.0.0";
export const APP_LABEL = `Phase ${APP_PHASE}`;
export const APP_TITLE = `VelvetSharp — ${APP_LABEL}`;
