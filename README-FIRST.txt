════════════════════════════════════════════════════════════════════
  VelvetSharp — PHASE 9  ·  portable build (build 9.0.0)
════════════════════════════════════════════════════════════════════

VERSION SYSTEM
──────────────
The version is the PHASE number — it bumps by exactly one on every
delivered update and is never reused. This is Phase 9. The phase is
always visible in the status bar (bottom right) and in ⚙ Settings.

QUICK START (portable — nothing installs)
─────────────────────────────────────────
1. Unzip anywhere. Run VelvetSharp.exe — no setup file, no admin.
2. If the exe is NOT in your Unity project folder: click the folder
   chip in the status bar or the welcome button to pick your project.
3. First open asks for a COLOR THEME — it is remembered from then on.

WHAT'S NEW IN PHASE 9
─────────────────────
▲ FALSE-POSITIVE DIAGNOSTICS KILLED (you checked in VS + Rider — we
  agree with them now)
  • `new JArray(currentWeaponLoadout ?? Array.Empty<int>())` no longer
    reports "The type or namespace name 'Empty' could not be found".
    Root cause: 'Empty' is System.Array's static generic METHOD, but
    the type-position detector treated any generic name under a member
    access as a TYPE. `Array.Empty<int>()`, `List.AddRange`, any
    `Type.Member<T>()` call — all safe now.
  • "Ambiguous reference: 'Task' matches Task and Task`1" — gone.
    That warning was wrong on its face (a bare `Task` binds the
    non-generic Task), and ambiguous-reference detection needs exact
    using-directive semantics we do not model — so per your request it
    is suppressed entirely. Genuinely missing types still flag.

▲ PROBLEMS BAR — RIGHT-CLICK → COPY ONE PROBLEM
  • Right-click any row: "Copy this problem" (just that one, formatted
    file(line,col): message), "Copy all problems (N)", "Go to
    location". Esc or a click elsewhere closes the menu. Ctrl+click
    multi-select + Ctrl+C still works for bulk copies.

▲ DEPENDENCY GRAPH — STATIC SINGLETONS (self-links)
  • `public static GameManager Instance;` (or a self-typed property) —
    the classic singleton — now shows an "S" badge on the node and a
    dashed self-loop arrow: the ones that "link something to itself".
    Nodes remain classes/structs/interfaces/enums ONLY.

▲ NEW: CALL FLOW VIEW (per-script flowchart)
  • Open a script → ⚡ graph toolbar "Call flow" button (or
    Ctrl+Shift+P → "Call Flow of Current Script") → a generated flow
    chart of how THAT script's methods call each other:
      ƒ  solid green nodes = methods of the script
      ⊗  dashed capsule nodes = calls that leave the script
         (Debug.Log, other classes, the Unity API) — the branch ENDS
         there, exactly as you asked
      U  gold badge = Unity event function (Awake/Start/Update…)
      bold border = entry points (nothing calls them in-script)
  • Try it on the bundled FlowDemo.cs. Click a node to see who calls
    it and what it calls.

STILL ALL OF PHASE 8
────────────────────
Types-only dependency graph (4 layouts, folder scoping, Unity/BCL
externals), whole-file + base-family completions, Unity magic methods
(34, with docs) in autocomplete, uses panel (select a symbol → every
reference + where it comes from, Shift+F12), out-declaration lint
fixes, plus all of Phase 7: self-healing native bridge, error popup
with stack trace, disk-backed settings, ⚙ Settings modal, 7 themes,
CRLF/LF handling, explorer file ops with .meta pairing, F2 project-
wide rename, Problems bar, snippets, palette, auto-save, wrap, zoom.

VERIFICATION THAT SHIPPED WITH THIS BUILD
─────────────────────────────────────────
• 131 engine assertions — Phase 8 (17) + new Phase 9 (13: Empty member
  guard + control, ambiguity suppression + control, singleton
  detection, call-flow nodes/edges/terminals/entries) — all green.
• 43 compiled-dist feature markers — all green.
• 34/34 visual end-to-end checks with screenshots (boot, file opens,
  Problems jump, right-click copy menu, settings, uses panel, theme
  persists, circular graph, CALL FLOW view, error popup).
• 17 content markers inside resources.neu — all green.
• CI/CD: GitHub Actions tested every push and built this release.

TROUBLESHOOTING
───────────────
• Bridge issues: "● bridge" chip (bottom right) → click to reconnect;
  ⚙ Settings → native bridge → "run self-test".
• Any popup: "copy details" and send us the text.
• Prefs live in %APPDATA%\VelvetSharp\config.json (safe to delete).
