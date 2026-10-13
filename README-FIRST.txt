════════════════════════════════════════════════════════════════════
  VelvetSharp — PHASE 12  ·  portable build (build 12.0.0)
════════════════════════════════════════════════════════════════════

VERSION SYSTEM
──────────────
The version is the PHASE number — it bumps by exactly one on every
delivered update and is never reused. This is Phase 12. The phase is
always visible in the status bar (bottom right) and in ⚙ Settings.

QUICK START (portable — nothing installs)
─────────────────────────────────────────
1. Unzip anywhere. Run VelvetSharp.exe — no setup file, no admin.
2. If the exe is NOT in your Unity project folder: click the folder
   chip in the status bar or the welcome button to pick your project.
3. First open asks for a COLOR THEME — it is remembered from then on.

WHAT'S NEW IN PHASE 12 — THE CONNECTION IS ROCK SOLID
──────────────────────────────────────────────────────
▲ AUTOCOMPLETE CAN NO LONGER SILENTLY DIE (the real bug, hunted down)
  • Found and fixed a latent renderer bug present since Phase 10: every
    suggestion batch failed Monaco's internal range validation, so the
    widget went EMPTY and Monaco fell back to "suggest words from this
    document" — the literal "abc" noise you saw. It looked random; it
    was deterministic. The /// doc path used a different code path,
    which is why it kept working.
  • Random word suggestions are now OFF entirely, like Rider.

▲ TWO BRAIN LANES — COMPLETIONS NEVER QUEUE BEHIND ANALYSIS
  • Suggestions/hover/go-to-definition run on a dedicated fast worker;
    heavy analysis (deep diagnostics, sweeps, graphs, rename) runs on a
    second worker. Typing in a 3,600-line file no longer delays a
    completion by the analysis time.
  • Same-file answers pop INSTANTLY (synchronous floor); the brain's
    richer answer (docs, parameters, inherited members) upgrades the
    list in place without a flicker.
  • The completion cache finally does its job: a cached answer for a
    shorter prefix now serves longer prefixes (the old cache required
    an exact match and could never help the next keystroke).

▲ CRASHED BRAIN? IT HEALS ITSELF NOW
  • A crashed or wedged analysis/interactive worker used to hang its
    callers forever. Now: pending calls fail fast, the worker
    respawns, the workspace re-syncs from disk automatically (no
    reload), and the status bar tells you what happened. Verified by
    an automated crash drill in the browser test suite.

▲ NATIVE BRIDGE HARDENING
  • A socket drop no longer loses calls that were already sent — they
    are replayed once on the fresh connection.
  • The old zombie-socket rule counted EVERY timeout ever and rebuilt
    a healthy socket on every second timeout, forever. It now counts
    consecutive timeouts and resets on every successful call.
  • A 20-second idle heartbeat detects a dead connection before you
    click; waking Windows from sleep or regaining the network
    reconnects immediately.
  • File reads/writes get 25 s (was 10 s) — big scripts + antivirus
    scans no longer look like a dead bridge.

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
• 169 engine assertions — including 6 new Phase 12 tests pinning the
  light-update contract the fast lane depends on — all green.
• 12 cache-probe assertions (prefix-chain semantics) + 74 compiled-
  dist feature markers — all green.
• 10/10 browser E2E including a live crash → respawn → resync drill
  and a word-noise absence check.
• CI/CD: GitHub Actions tested every push and builds the release
  zip automatically on the v12.0.0 tag.

TROUBLESHOOTING
───────────────
• Bridge issues: "● bridge" chip (bottom right) → click to reconnect;
  ⚙ Settings → native bridge → "run self-test".
• Any popup: "copy details" and send us the text.
• Prefs live in %APPDATA%\VelvetSharp\config.json (safe to delete).
