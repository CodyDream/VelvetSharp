════════════════════════════════════════════════════════════════════
  VelvetSharp — PHASE 11  ·  portable build (build 11.1.0)
════════════════════════════════════════════════════════════════════

VERSION SYSTEM
──────────────
The version is the PHASE number — it bumps by exactly one on every
delivered update and is never reused. This is Phase 11. The phase is
always visible in the status bar (bottom right) and in ⚙ Settings.

QUICK START (portable — nothing installs)
─────────────────────────────────────────
1. Unzip anywhere. Run VelvetSharp.exe — no setup file, no admin.
2. If the exe is NOT in your Unity project folder: click the folder
   chip in the status bar or the welcome button to pick your project.
3. First open asks for a COLOR THEME — it is remembered from then on.

WHAT'S NEW IN BUILD 11.1.0 (PR #1 merged)
──────────────────────────────────────────
▲ THE SINGLETON SNIPPET GOT SMART
  • Type "singleton" inside a class and the generated code uses YOUR
    class name — innermost class wins when classes nest.
  • The Awake is guarded: a second instance WARNS and is not
    assigned (no more Destroy on duplicates).
  • OnDestroy clears Instance only when it is really this object,
    so a rejected duplicate can never wipe the live singleton.

▲ 8 NEW UNITY SNIPPETS (type the name, press Tab)
  • SingletonPersistent — same guards + DontDestroyOnLoad
  • OnEnableDisable · TryGetComponent · NullGuard ·
    RequireComponent · EventAction · Cooldown · GizmoSphere

KNOWN LIMITATION (from the PR, kept honest)
  • If your class already declares Awake or OnDestroy, the snippet
    still inserts its own copy — delete the duplicate after
    expanding. Lifecycle completions already hide existing methods;
    snippets do not yet.

WHAT'S NEW IN PHASE 11
──────────────────────
▲ #if UNITY_EDITOR AND ALL # SYMBOLS ARE FIRST-CLASS NOW
  • VelvetSharp knows Unity's standard define set (all platforms +
    editor flags, exactly like the constants in Unity's generated
    .csproj), so every standard branch is analyzed with zero false
    errors — #if / #elif / #else / #endif, #ifdef, #ifndef.
  • Your project's Unity version is read from ProjectSettings/
    ProjectVersion.txt → UNITY_2022_3_OR_NEWER-style symbols match
    YOUR editor, and custom defines from ProjectSettings.asset
    (scriptingDefineSymbols) participate too.
  • False branches behave like VS: the code is DIMMED in the editor
    and no diagnostics are invented inside it (unknown symbols stay
    gray instead of spraying errors).
  • Real structural checks: stray #endif / #endregion, an #if or
    #region that never closes, #elif after #else, malformed
    expressions — each points at the offending line.
  • #pragma warning disable / restore is honored (CS0219, CS0618,
    CS0162…, or bare "#pragma warning disable" for everything), and
    #error / #warning directives now surface their messages.
  • Whole directive lines get the preprocessor color.

▲ RIGHT-CLICK IN THE EDITOR → COLLAPSE MENU (your request)
  • Right-click any script → "Collapse" with sub-options:
      Collapse by Methods · Collapse by #Regions · Collapse by
      #if Blocks · Collapse XML Doc Comments · Collapse All ·
      Expand All. Also available in Ctrl+Shift+P ("View: Collapse…").
  • Powered by a precise folding engine: methods fold from the
    SIGNATURE line (never hiding the header), #region/#if blocks and
    /// doc comments above methods fold too, and the fold gutter
    arrows are always visible.

▲ /// + ENTER = XML DOCUMENTATION (your request)
  • Type /// on the empty line above a method and press Enter: the
    skeleton inserts itself — <summary>, one <param name="…"> per
    parameter, <returns> for non-void, <value> for properties — with
    tab stops to jump through the placeholders. Constructors,
    indexers, properties, fields and types all get the right shape.
  • Pressing Enter inside a doc comment keeps continuing with ///.

▲ FIXED ALONG THE WAY
  • A latent completion-provider bug (an internal reference that
    could throw and silently empty the suggestion list) is gone.

STILL ALL OF PHASE 10
─────────────────────
Stable Call Flow graph with ranked selection, the Vertical tidy-tree
layout, always-popping completions (instant local fast path), Alt+
Left/Right navigation history, Ctrl+Wheel zoom — and everything from
Phase 9: false-positive kills, Problems right-click copy, singleton
self-loops, Call Flow view; Phase 8: types-only dependency graph,
base-family completions, Unity magic methods, uses panel (Shift+F12);
Phase 7: self-healing bridge, error popup, disk-backed settings,
7 themes, CRLF/LF, explorer file ops, F2 project-wide rename.

VERIFICATION THAT SHIPPED WITH THIS BUILD
─────────────────────────────────────────
• 163 engine assertions — the 152 from Phase 11 plus the 11 new
  snippet tests (SNIP-a..k: class name injection, Awake guard
  order, OnDestroy self-check, parse-clean expansions, dependency-
  graph self-loop) — all green.
• Compiled-dist feature markers — all green (incl. Phase 11 menu,
  folding provider, /// completion, dimming, version detection,
  and the new singleton snippets).
• CI/CD: GitHub Actions tested every push and builds the release
  zip automatically on the v11.1.0 tag.

TROUBLESHOOTING
───────────────
• Bridge issues: "● bridge" chip (bottom right) → click to reconnect;
  ⚙ Settings → native bridge → "run self-test".
• Any popup: "copy details" and send us the text.
• Prefs live in %APPDATA%\VelvetSharp\config.json (safe to delete).
