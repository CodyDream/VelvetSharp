════════════════════════════════════════════════════════════════════
  VelvetSharp — PHASE 17  ·  portable build (build 17.0.0)
════════════════════════════════════════════════════════════════════

VERSION SYSTEM
──────────────
The version is the PHASE number — it bumps by exactly one on every
delivered update and is never reused. This is Phase 17. The phase is
always visible in the status bar (bottom right) and in ⚙ Settings.

QUICK START (portable — nothing installs)
─────────────────────────────────────────
1. Unzip anywhere. Run VelvetSharp.exe — no setup file, no admin.
2. If the exe is NOT in your Unity project folder: click the folder
   chip in the status bar or the welcome button to pick your project.
3. First open asks for a COLOR THEME — it is remembered from then on.

WHAT'S NEW IN PHASE 17 — UI OVERHAUL + QOL BATCH
────────────────────────────────────────────────
▲ A NEW SHELL (the whole chrome is refreshed)
  • ACTIVITY RAIL on the left edge (replaces the old sidebar tab-row):
    Explorer / Search / Outline / Problems (with a LIVE ERROR BADGE) /
    Graph / Agent Bridge, and ⚙ Settings pinned at the bottom.
    Click the active icon again to collapse; Ctrl+B hides the sidebar.
  • COMMAND CENTER in the titlebar — a search pill that opens quick
    open (Ctrl+P). Files, symbols and commands all live there.
  • TABS got modern: file icons (C# in accent), DRAG TO REORDER,
    middle-click close, and a RIGHT-CLICK MENU — Close / Close Others
    / Close Saved / Close All / Copy Relative Path / Copy Full Path.
  • BREADCRUMBS under the tabs: Assets › Scripts › Player › file.
    Click a folder segment to reveal it in the explorer. A symbol chip
    follows your caret (ƒ Update) — click it for a jump menu of every
    symbol in the file.
  • WELCOME SCREEN is now a dashboard: four shortcut cards
    (essentials / the brain / views / AI hand-off) + your recent
    projects one click away.
  • STATUS BAR: selection size (chars + lines) next to the cursor
    position, and the status message FLASHES when it changes so you
    actually see "saved PlayerController.cs" happen.
  • SIDEBAR is drag-resizable (the handle remembers its width).

▲ QOL BATCH (the small things, everywhere)
  • Ctrl+Tab / Ctrl+Shift+Tab — cycle through open tabs (wraps).
  • Ctrl+B — toggle sidebar · Ctrl+J — toggle Problems ·
    Ctrl+, — Settings · Ctrl+N — new C# script.
  • Ctrl+Alt+S — SAVE ALL dirty scripts at once.
  • F8 / Shift+F8 — jump to the NEXT / PREVIOUS problem across the
    whole project (wraps around, opens the Problems bar for you).
  • SESSION RESTORE — close VelvetSharp, reopen it: your open tabs,
    the active script and each cursor position come back per
    workspace. (Files deleted meanwhile are skipped.)
  • WINDOW TITLE mirrors the active document ("PlayerController.cs —
    VelvetSharp — Phase 17", a • when there are unsaved edits).
  • EDIT: SORT USINGS — System group first, then the rest
    alphabetically, duplicates removed (palette command).
  • TRIM TRAILING WHITESPACE ON SAVE — off by default; toggle in the
    palette or ⚙ Settings. Runs on Ctrl+S AND auto-save; the editor
    updates in one undo step so the dirty dot clears honestly.
  • Editor preferences that persist: MINIMAP on/off, STICKY SCROLL
    on/off, WHITESPACE visibility — plus the old wrap/autosave/font
    zoom (Ctrl+= / Ctrl+- / Ctrl+0, Ctrl+Wheel).
  • AUTO-REVEAL — switching tabs expands the explorer to the active
    file, and the explorer has a FILTER BOX (type to search, Esc
    clears).
  • Monaco niceties: drag-and-drop selections, cursor surrounding
    lines kept in view.

▲ EVERYTHING FROM PHASE 16 IS STILL HERE
  • ⧉ Structure → AI and ⇩ Apply JSON ← AI in the titlebar (web-AI
    hand-off with tri-state folder pickers and payload auto-apply).
  • MCP for local agents (6 tools incl. apply_payload) — see mcp/README.md.
  • Two-lane brain, call flow with execution-order badges,
    find-in-files, preprocessor support, 7 themes.

VERIFICATION
─────────────────────────────────────────
• 253 engine assertions — including 14 new Phase 17 tests pinning
  sortUsings (System group first + exact-text dedupe), trim trailing
  whitespace (CRLF preserved, indentation untouched), breadcrumb
  segments, the caret-following owning-symbol picker, session
  serialize/revive (vanished files dropped, active fallback),
  tab-cycle wrap math and next/previous-problem indexing — all green.
• 131 compiled-dist feature markers — all green.
• CI/CD: GitHub Actions tests every push and builds the release zip
  automatically on the v17.0.0 tag.

TROUBLESHOOTING
───────────────
• Bridge issues: "● bridge" chip (bottom right) → click to reconnect;
  ⚙ Settings → native bridge → "run self-test".
• Graph problems: the banner has "⧉ copy error" — send us that text.
• Any popup: "copy details" and send us the text.
• Prefs live in %APPDATA%\VelvetSharp\config.json (safe to delete).
