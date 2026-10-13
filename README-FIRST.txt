════════════════════════════════════════════════════════════════════
  VelvetSharp — PHASE 13  ·  portable build (build 13.0.0)
════════════════════════════════════════════════════════════════════

VERSION SYSTEM
──────────────
The version is the PHASE number — it bumps by exactly one on every
delivered update and is never reused. This is Phase 13. The phase is
always visible in the status bar (bottom right) and in ⚙ Settings.

QUICK START (portable — nothing installs)
─────────────────────────────────────────
1. Unzip anywhere. Run VelvetSharp.exe — no setup file, no admin.
2. If the exe is NOT in your Unity project folder: click the folder
   chip in the status bar or the welcome button to pick your project.
3. First open asks for a COLOR THEME — it is remembered from then on.

WHAT'S NEW IN PHASE 13 — CALL FLOW SHOWS ONLY *YOUR* CODE
──────────────────────────────────────────────────────────
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
• 191 engine assertions — including 12 new Phase 13 tests pinning
  the custom-methods-only flow, cross-file terminals, call-order
  ranks and the attribute guard — all green.
• 16-fixture crash-battery probe (0 throws, all invariants) +
  80 compiled-dist feature markers — all green.
• 15/15 browser E2E: flow renders methods only, badges render and
  match the edges, widths are dynamic, cross-file terminals carry
  their file, the copy-error button really copies, zero page errors.
• CI/CD: GitHub Actions tested every push and builds the release
  zip automatically on the v13.0.0 tag.

TROUBLESHOOTING
───────────────
• Bridge issues: "● bridge" chip (bottom right) → click to reconnect;
  ⚙ Settings → native bridge → "run self-test".
• Graph problems: the banner has "⧉ copy error" — send us that text.
• Any popup: "copy details" and send us the text.
• Prefs live in %APPDATA%\VelvetSharp\config.json (safe to delete).
