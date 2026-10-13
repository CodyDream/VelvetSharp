════════════════════════════════════════════════════════════════════
  VelvetSharp — PHASE 16  ·  portable build (build 16.0.0)
════════════════════════════════════════════════════════════════════

VERSION SYSTEM
──────────────
The version is the PHASE number — it bumps by exactly one on every
delivered update and is never reused. This is Phase 16. The phase is
always visible in the status bar (bottom right) and in ⚙ Settings.

QUICK START (portable — nothing installs)
─────────────────────────────────────────
1. Unzip anywhere. Run VelvetSharp.exe — no setup file, no admin.
2. If the exe is NOT in your Unity project folder: click the folder
   chip in the status bar or the welcome button to pick your project.
3. First open asks for a COLOR THEME — it is remembered from then on.

WHAT'S NEW IN PHASE 16 — AGENT BRIDGE: WORK HANDS-ON WITH WEB AI
────────────────────────────────────────────────────────────────
▲ THE AI BUTTONS LIVE UP TOP NOW (your request)
  The titlebar carries two new buttons — "⧉ Structure → AI" and
  "⇩ Apply JSON ← AI" — plus the theme (◐) and settings (⚙) chips.
  No more digging through the bottom bar.

▲ WINDOW 1: COPY THE PROJECT STRUCTURE TO ANY WEB AI (your request)
  • A folder tree of your workspace with tri-state checkboxes —
    check a folder to share it AND everything under it; check or
    uncheck sub-folders to fine-tune. Presets: all / none /
    scripts (.cs) only. A filter box narrows big projects.
  • "include file contents" appends every selected file as a
    ```csharp fenced block (needed when the agent must edit exact
    code). Char counter + a truncation warning keep the paste sane.
  • "Copy to clipboard" (with a 3-step fallback chain) and
    "Copy agent instructions" — the second one puts a compact JSON
    contract on your clipboard that teaches ANY web LLM (ChatGPT,
    Claude, Gemini…) how to answer with an applicable payload.

▲ WINDOW 2: PASTE THE AGENT'S JSON — VELVETSHARP DOES THE WORK
  • Paste the JSON your AI replied with, hit validate: every op is
    dry-run against the real workspace and you see a green/red plan
    row per operation with the exact reason when something is off
    (find text missing, target exists, path escaping the project…).
  • Apply now writes the changes: CREATE new scripts (a .cs without
    content gets a MonoBehaviour starter), MODIFY via exact
    find→replace or full-file content, DELETE (the .meta sidecar
    goes too), MOVE (the .meta follows, GUID survives).
  • Open buffers are respected: patches apply to what you SEE
    (unsaved edits included), the model updates in ONE undo step
    (Ctrl+Z reverts the agent), and each file's CRLF/LF ending is
    preserved. The brain re-analyzes what changed — squiggles,
    problems bar and stats refresh immediately.
  • A copyable REPORT summarizes every op — paste it back into the
    chat so the agent can correct itself on the next turn.
  • SAFETY: paths must stay inside the workspace (no .., no drive
    letters), only text extensions, ops and sizes capped. Web-LLM
    dialects are tolerated (new/edit/remove/rename aliases, missing
    protocol marker, find-without-replace).

▲ MCP AGENTS GET WRITE ACCESS TOO
  • The local MCP server now exposes apply_payload — the same
    engine behind the Apply window — so Cursor/Claude Desktop/etc.
    can fix files in one call. Six tools in total now.

WHAT'S NEW IN PHASE 15 — FULL C# + UNITY PREPROCESSOR + SYMBOL AUTOCOMPLETE
───────────────────────────────────────────────────────────────────────────
▲ TYPE `#` AT THE START OF A LINE — every real C# directive completes
  with its usage + docs: #if #elif #else #endif #define #undef #region
  #endregion #warning #error #line #pragma #nullable. Self-closing
  snippets too: "#if … #endif" inserts BOTH ends for you.
▲ TYPE `#if ` (or #elif / #define / #undef + space) — the FULL symbol
  world completes, each entry labelled with where it comes from:
  • Unity built-ins (UNITY_EDITOR, UNITY_STANDALONE_WIN, ENABLE_*…)
  • UNITY_2022_3_OR_NEWER-style version symbols from your project
  • csproj DefineConstants + Player Settings scriptingDefineSymbols
  • Assets/csc.rsp / Assets/mcs.rsp -define: flags (new: scanned!)
  • EVERY `#define` in your own code — with file + line of each site
▲ HOVER any symbol inside a #if line → where it is defined.
  Hover #if / #region … → the directive's usage signature.
▲ #pragma warning → disable/restore → common CS codes with
  descriptions. #nullable → enable/disable/restore (+ warnings /
  annotations forms). #line → default/hidden.
▲ TYPO PROTECTION: an unknown directive warns with a hint — "#regiong"
  suggests #region; "#ifdef" suggests #if (C# has no #ifdef!). A
  #define placed after real code errors CS1032 with a fix hint.
STILL ALL OF PHASE 14 — REAL FIND-IN-FILES + AI AGENTS (MCP)
─────────────────────────────────────────────────────────────
▲ FIND IN PROJECT FILES (Ctrl+Shift+F) — now worth using
  • Live search as you type across EVERY script in the project.
  • Three toggles: Aa (case sensitive), |w| (whole word — matches
    the full identifier only), .* (regular expression).
  • Results grouped per file with counts; the matched text is
    highlighted inside its line; Enter jumps to the first hit;
    Esc clears; click any row to open that exact spot.
  • HONEST COVERAGE: right after a warm start some files are
    indexed from cache without text — the old search silently
    missed them. The panel now says "N files not scanned yet —
    scan & re-run"; click it, the files are read in and the
    search completes. No more silent gaps.

▲ AI AGENTS CAN TALK TO YOUR EDITOR (MCP — Model Context Protocol)
  • The zip now ships mcp/server.mjs + mcp/README.md. Point any
    MCP client (Claude Desktop, Claude Code, Cursor, Cline, …) at
    it — e.g. Claude Desktop config:
      "velvetsharp": { "command": "node",
                       "args": ["<this folder>\\mcp\\server.mjs"] }
    (needs Node.js 18+ installed; zero npm packages).
  • The agent can then ask the RUNNING editor for:
      - get_problems          every error/warning the Problems bar
                              shows (incl. unsaved buffers), in
                              compiler style: File(line,col): ERROR
                              CS1002: ... — perfect for automated
                              fixing loops
      - get_project_structure the workspace file tree
      - search_code           the same engine as Ctrl+Shift+F
      - get_file              file content (live buffer when dirty)
      - get_workspace_summary root, counts, assemblies — first call
  • Connection is automatic: VelvetSharp publishes its port +
    session token to %APPDATA%\VelvetSharp\mcp.json at boot.
    Everything stays on 127.0.0.1 — nothing leaves your machine.
  • ⚙ Settings shows the "AI agents (MCP)" row with the discovery
    path; the command palette has "AI: MCP Connection Info".

▲ ALSO
  • Problem rows now carry the compiler code (CS0219, CS0618, …) —
    in the Problems bar, the copy action, and the MCP output.

STILL ALL OF PHASE 13 — CALL FLOW SHOWS ONLY *YOUR* CODE
────────────────────────────────────────────────────────
▲ UNITY DLL NOISE IS GONE FROM CALL FLOW (your request)
  • Debug.Log, GetComponent, Mathf, Physics… are no longer drawn as
    boxes — they were distractions. The graph now contains ONLY your
    custom methods. What was hidden is counted: the toolbar shows
    "N engine/API hidden" so you know the calls still exist.

▲ CALLS INTO YOUR OTHER SCRIPTS STILL SHOW UP
  • GameManager.Spawn() (another script's type) and player.Heal()
    (a field whose declared type lives in another script) resolve to
    dashed terminal boxes that CARRY their defining file — double-
    click one to open that script. The branch ends there, exactly
    like before, but only for YOUR code.

▲ EXECUTION-ORDER NUMBERS 1·2·3 (your request)
  • Every method's outgoing calls are numbered in the order they
    appear — and execute — inside that method's body. The numbers
    are LOCALIZED per method: each method's sub-tree starts at 1.
    Badges sit right under the caller's box; the details panel
    repeats them ("Calls (in execution order)").

▲ BOXES NOW FIT THEIR ENTIRE NAME (your request)
  • Every graph box measures its own name + sub-line and grows to
    fit — no more "Respa…". This works in every layout, types mode
    included. Very long names still ellipsize past a 360px cap.

▲ IF THE GRAPH EVER FAILS, YOU GET THE ERROR — COPYABLE
  • The graph banner shows WHY something failed and has a
    "⧉ copy error" button: it puts the VelvetSharp version, the
    mode, the script, the message and the FULL STACK on your
    clipboard — paste it into a bug report and it can be fixed
    precisely.
  • A render crash can no longer white-screen the app: an error
    boundary now wraps the graph AND the whole app, showing the
    message + stack + a ⟳ retry button while the rest of the
    editor stays alive.

▲ FIXED ALONG THE WAY
  • Attribute arguments (like [ContextMenu(MakeLabel())]) are no
    longer falsely attributed to the method declared below them.
  • A crash-battery of 16 torture fixtures (null-conditional calls,
    generics, lambdas, 400-method cycles, 900-call hubs…) now runs
    against the flow engine: zero throws, invariants hold.

STILL ALL OF PHASE 12 — THE CONNECTION IS ROCK SOLID
─────────────────────────────────────────────────────
Autocomplete can no longer silently die: the latent range bug that
emptied every suggestion batch since Phase 10 is fixed and word
noise is OFF. Two brain lanes — completions answer on a dedicated
fast worker, never queueing behind deep analysis; instant same-file
floor; prefix-chain cache; crashed workers reject their callers,
respawn and re-sync from disk without a reload. The native bridge
replays in-flight calls after a socket drop, counts CONSECUTIVE
timeouts only (reset on every success), heartbeats when idle, and
reconnects on Windows wake / network regain; file IO gets 25 s.

STILL ALL OF PHASE 11 / 11.1
────────────────────────────
#if UNITY_EDITOR and all # symbols are first-class (Unity define
set + version chain from ProjectVersion.txt + custom defines,
inactive branches dimmed and silent, structural # diagnostics,
#pragma warning + #error/#warning); editor right-click Collapse ▸
submenu (Methods / #Regions / #if Blocks / XML Doc / All / Expand);
/// + Enter generates the XML documentation skeleton; class-aware
Singleton snippet with guarded Awake + OnDestroy cleanup and 8 more
Unity snippets (SingletonPersistent, OnEnableDisable,
TryGetComponent, NullGuard, RequireComponent, EventAction,
Cooldown, GizmoSphere).

STILL ALL OF PHASE 10 / 9 / 8 / 7
─────────────────────────────────
Stable Call Flow with ranked selection and the Vertical tidy-tree
layout, always-popping completions, Alt+Left/Right navigation
history, Ctrl+Wheel zoom; false-positive kills, Problems right-
click copy, singleton self-loops; types-only dependency graph,
base-family completions, Unity magic methods, uses panel
(Shift+F12); self-healing bridge, error popup, disk-backed
settings, 7 themes, CRLF/LF, explorer file ops, F2 project-wide
rename.

VERIFICATION THAT SHIPPED WITH THIS BUILD
─────────────────────────────────────────
• 239 engine assertions — including 17 new Phase 16 tests pinning the
  payload guard (traversal/drive/absolute), the planner (create
  conflicts, find misses, delete-missing), a REAL temp-dir apply
  (create/modify/delete/move + report) and the structure export
  (folder selection, fences, truncation) — all green.
• 116 compiled-dist feature markers — all green.
• 19/19 browser E2E: titlebar buttons, folder tree + presets + fences,
  clipboard round-trips, validate/apply with the copyable report,
  traversal rejection, MCP apply_payload OK + refusal.
• CI/CD: GitHub Actions tests every push and builds the release zip
  automatically on the v16.0.0 tag.

TROUBLESHOOTING
───────────────
• Bridge issues: "● bridge" chip (bottom right) → click to reconnect;
  ⚙ Settings → native bridge → "run self-test".
• Graph problems: the banner has "⧉ copy error" — send us that text.
• Any popup: "copy details" and send us the text.
• Prefs live in %APPDATA%\VelvetSharp\config.json (safe to delete).
