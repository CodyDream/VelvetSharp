════════════════════════════════════════════════════════════════════
  VelvetSharp — PHASE 8  ·  portable build (build 8.0.0)
════════════════════════════════════════════════════════════════════

VERSION SYSTEM
──────────────
The version is the PHASE number — it bumps by exactly one on every
delivered update and is never reused. This is Phase 8. The phase is
always visible in the status bar (bottom right) and in ⚙ Settings.

QUICK START (portable — nothing installs)
─────────────────────────────────────────
1. Unzip anywhere. Run VelvetSharp.exe — no setup file, no admin.
2. If the exe is NOT in your Unity project folder: click the folder
   chip in the status bar or the welcome button to pick your project.
3. First open asks for a COLOR THEME — it is remembered from then on.

WHAT'S NEW IN PHASE 8
─────────────────────
▲ DEPENDENCY GRAPH — the "crashes + dumps everything" fix
  • Nodes are now CLASS, STRUCT, INTERFACE and ENUM declarations ONLY
    (user: "nodes should be either class interfaces or structs, not
    literally everything"). Delegates, methods, locals — gone.
  • Connection spam removed: a variable named `enemy` used to resolve
    (case-insensitively!) to the TYPE `Enemy` and create fake "uses"
    edges everywhere. Bare identifiers now only count when they match
    a declared type EXACTLY — so `GameManager.Instance` is still a
    real edge, but ordinary variable reads no longer are.
  • The actual crash root-caused: the graph builder did a linear scan
    over every in-scope file PER resolved reference — on a few hundred
    scripts that was billions of operations inside the engine worker
    (the request never returned / the worker died). Now one Set, O(1).
  • Node/edge caps tightened (260 nodes / 900 edges) + circular-layout
    O(n²) removed + render caps lowered to what WebView2 can draw.

▲ COMPLETIONS SEE THE WHOLE FILE + OTHER CLASSES
  • "i wrote a method on bottom of thing or another class method let
    auto complete show them too" — fixed. Bare completions now include
    the enclosing class's OWN members (methods declared BELOW the
    caret included — the index is position independent) plus INHERITED
    members walked up the base chain (project bases recurse, Unity
    bases through the API db). `this.` on any project type shows the
    whole family too.

▲ UNITY MAGIC METHODS IN AUTO COMPLETE
  • "awake start update those magic methods... dont show up" — fixed.
    Unity's message methods are called BY NAME but are not real .NET
    methods, so the DLL metadata never contained them. They are now
    synthesized onto MonoBehaviour (34 messages: Awake/Start/Update/
    FixedUpdate/OnCollisionEnter/OnTriggerEnter/OnGUI/OnValidate…)
    with docs — so every script offers them via `this.` completions,
    hover and signature help, exactly like real methods.

▲ USES PANEL — "where is this used / where does it come from"
  • Select (double-click or drag) any method, variable, field, class…
    → a panel under the editor — like the Problems bar — lists EVERY
    place it is used across the project (declaration row first) plus
    the header shows the ORIGIN: "field PlayerController.jumpForce —
    Assets/Scripts/Player/PlayerController.cs:8 · Assembly-CSharp".
  • Click a row to jump. Shift+F12 = find uses of the word under the
    caret without selecting. Esc or × closes. Compiled API symbols
    (e.g. MonoBehaviour) say "comes from the engine assemblies".
  • Same resolution machinery as F2 rename — locals stay bounded to
    their method, members follow overrides across the type family.

▲ OUT EXPRESSIONS — false warnings eliminated
  • "currently it give me weird false warning" — the ref/out lint
    flagged `int.TryParse(text, out int result)` and `out var found`
    (legal out variable declarations). Fixed: out declarations,
    discards (`out _`), member chains (`out obj.field`) and element
    access are accepted; only provably wrong args (`out 42`,
    `out Foo()`) are flagged. Also fixed a related false "missing
    using" on fully-qualified generic types like
    System.Collections.Generic.Dictionary<K,V>.

STILL ALL OF PHASE 7
────────────────────
Self-healing native bridge (timeouts, auto-reconnect, health chip),
error popup with stack trace, disk-backed settings, ⚙ Settings modal,
crash-proof layouts, 7 themes, CRLF/LF handling, explorer file ops
with .meta pairing, F2 project-wide rename, Problems bar, snippets,
command palette, auto-save, wrap, zoom.

VERIFICATION THAT SHIPPED WITH THIS BUILD
─────────────────────────────────────────
• 118 engine assertions (incl. 17 new Phase 8: graph node kinds,
  exact-case edge guard, bottom-of-file completions, base-family
  completions, magic-method injection, findUses, out regression) —
  all green.
• 37 compiled-dist feature markers — all green.
• 24/24 visual end-to-end checks with screenshots (file opens,
  Problems jump, uses panel on selection for API + project symbols,
  Esc close, theme persists, circular graph, error popup).

TROUBLESHOOTING
───────────────
• Bridge issues: "● bridge" chip (bottom right) → click to reconnect;
  ⚙ Settings → native bridge → "run self-test".
• Any popup: "copy details" and send us the text.
• Prefs live in %APPDATA%\VelvetSharp\config.json (safe to delete).
