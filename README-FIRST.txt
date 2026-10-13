════════════════════════════════════════════════════════════════════
  VelvetSharp — PHASE 10  ·  portable build (build 10.0.0)
════════════════════════════════════════════════════════════════════

VERSION SYSTEM
──────────────
The version is the PHASE number — it bumps by exactly one on every
delivered update and is never reused. This is Phase 10. The phase is
always visible in the status bar (bottom right) and in ⚙ Settings.

QUICK START (portable — nothing installs)
─────────────────────────────────────────
1. Unzip anywhere. Run VelvetSharp.exe — no setup file, no admin.
2. If the exe is NOT in your Unity project folder: click the folder
   chip in the status bar or the welcome button to pick your project.
3. First open asks for a COLOR THEME — it is remembered from then on.

WHAT'S NEW IN PHASE 10
──────────────────────
▲ CALL FLOW GRAPH — STABLE (no more crashes / frozen canvas)
  • Big scripts no longer break the view: the engine now walks the
    whole call set and keeps the MOST CONNECTED methods instead of a
    blind first-N cut (a 220-method stress script keeps 400/400 edges;
    it used to render 150 isolated callers with the helpers missing).
  • Any internal error becomes a readable message in the graph panel
    (with a ⟳ retry) — never a silent blank screen or a dead spinner.
  • Layouts hardened end to end: stack-proof layering, an unbreakable
    grid backstop, debounced index refresh, and a fixed wheel listener.

▲ GRAPHS — NEW VERTICAL LAYOUT (your "too horizontal" report)
  • Call Flow now ALWAYS renders as a real flowchart: entries on top,
    calls flow DOWN, every branch owns its own column, external calls
    end as dashed terminals. Deep chains grow tall, not wide.
  • Types mode gets a "Vertical" button too (tidy-tree flowchart) next
    to Hierarchical / Organic / Circular / Business.

▲ AUTO-COMPLETION — ALWAYS POPS, SOLID + CONSISTENT (your report)
  • Same-script methods/fields/properties now come from an instant
    local scan, so the suggestion widget pops immediately every time —
    even while the brain worker is busy parsing. The brain's richer
    answer (docs, parameter placeholders, inherited members) merges in
    the moment it answers and is cached for the next keystroke.
  • A completion bug can no longer pop the global error popup while
    you type — worst case it degrades to plain word suggestions.
  • The space bar no longer triggers the widget after every word.

▲ NEW: NAVIGATION HISTORY (Go Back / Go Forward)
  • Alt+Left walks back through every jump — F12 go-to-definition,
    search hits, problems, outline clicks, uses panel, graph
    double-click. Alt+Right goes forward again. Also in the command
    palette as "Navigate: Go Back / Go Forward".
  • Ctrl+MouseWheel zooms the editor (like Rider / VS Code).

STILL ALL OF PHASE 9
────────────────────
False-positive kills (`Array.Empty<int>()`, ambiguous-reference
suppression), Problems right-click → copy one problem, static
singleton self-loops in the graph, Call Flow view with external
terminals, plus all of Phase 8: types-only dependency graph, whole-
file + base-family completions, Unity magic methods, uses panel
(Shift+F12), and all of Phase 7: self-healing native bridge, error
popup, disk-backed settings, 7 themes, CRLF/LF, explorer file ops,
F2 project-wide rename, Problems bar, snippets, palette, auto-save.

VERIFICATION THAT SHIPPED WITH THIS BUILD
─────────────────────────────────────────
• 139 engine assertions — including 8 new Phase 10 tests: ranked
  selection keeps helpers + 300+ edges on a 220-method script,
  mutual/self recursion terminates, entry flags recomputed from the
  surviving subgraph — all green.
• 53 compiled-dist feature markers — all green.
• 44/44 visual end-to-end checks with screenshots — including the
  flow geometry (rows ≥ 4, no wide strip, Start above BuildPayload
  above LogPayload), suggest-widget pop, F12 → Alt+Left → Alt+Right
  round trip, Ctrl+Wheel zoom.
• 21 content markers inside resources.neu — all green.
• CI/CD: GitHub Actions tested every push and built the release.

TROUBLESHOOTING
───────────────
• Bridge issues: "● bridge" chip (bottom right) → click to reconnect;
  ⚙ Settings → native bridge → "run self-test".
• Any popup: "copy details" and send us the text.
• Prefs live in %APPDATA%\VelvetSharp\config.json (safe to delete).
