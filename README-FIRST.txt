════════════════════════════════════════════════════════════════════
  VelvetSharp — PHASE 7  ·  portable build (build 7.0.0)
════════════════════════════════════════════════════════════════════

NEW VERSION SYSTEM (so numbers never repeat again)
──────────────────────────────────────────────────────────────────
The user-facing version is now the PHASE number. Every delivered
update bumps the phase by exactly one — a number is never reused.

    Phase 5 = 0.5.0 (asmdef, snippets, problems bar, cache)
    Phase 6 = 0.6.0 (dependency graph, F2 rename)
    Phase 7 = 0.7.0 / 0.7.1  ←  THIS BUILD (was mislabeled 0.7.1
              three times, so the 0.7-series is retired and renamed)
    Phase 8 = next delivery, and so on.

The version chip in the bottom status bar always shows the phase of
the build you are running. ⚙ Settings → version shows it too.

QUICK START (portable — nothing installs)
─────────────────────────────────────────
1. Unzip anywhere. Run VelvetSharp.exe — that's it, no setup file.
2. If the exe is NOT in your Unity project folder: click the folder
   chip in the status bar (bottom) or the welcome button to pick your
   Unity project. You can also launch  VelvetSharp.exe <path>  or drop
   the exe into the project folder and run it from there.
3. First time you open a project you will be asked to pick a COLOR
   THEME — it is remembered from then on.

WHAT'S IN PHASE 7 (features shipped across the 0.7.x builds)
────────────────────────────────────────────────────────────
● SELF-HEALING NATIVE BRIDGE (why the bridge "didn't work on Windows")
  • Root cause: the old shell client opened ONE websocket to the disk
    layer and never reconnected — after any hiccup every file read
    silently queued forever (that is why double-clicking a file "did
    nothing", the Problems bar felt dead, and disk reads "took an
    extremely long time": they were hanging, not slow).
  • VelvetSharp now speaks the native protocol itself:
      - dials 127.0.0.1 directly (no proxy / IPv6 / "localhost" traps),
      - every call has a hard timeout — nothing can hang silently,
      - automatic reconnection with backoff + queued-call flush,
      - token recovery after restarts/reloads.
  • "● bridge" chip in the status bar shows connection health; click
    it to reconnect + run a self-test. Failures POP UP with a reason.

▲ ERROR POPUP WITH STACK TRACE
  • Internal errors are no longer swallowed — popup shows message +
    full stack with "copy details" so a bug report can be precise.

▲ THE "oid" RETURN-VALUE BUG — root-caused and fixed
  • The parser engine reused a corrupted internal parse tree, so node
    text was sliced mid-token ("void" read back as "oid") and void
    methods were flagged "missing return value". Structurally gone +
    locked by an edit-storm regression test. void NEVER asks for a
    return value.

▲ SETTINGS THAT SURVIVE RESTARTS
  • Theme / auto-save / wrap / font size / workspace root are ALSO
    written to %APPDATA%\VelvetSharp\config.json on every change —
    no more theme picker on every launch.
  • ⚙ SETTINGS button in the top bar: theme, font size, wrap,
    auto-save, config path, live bridge diagnostics.

▲ UI FIXES
  • Double-clicking a file OPENS it — text selection can never win.
  • Failed opens (single/double click, Problems bar) show the reason.
  • Circular dependency graph is crash-proof (falls back to
    Hierarchical + tells you) and huge graphs are capped.
  • Status bar margin/rounding polish · window resizable · themes
    remembered · CRLF/LF preserved · explorer create/delete/rename
    with .meta pairing · F2 rename across the whole project.

VERIFICATION THAT SHIPPED WITH THIS BUILD
─────────────────────────────────────────
• 101 engine assertions (parser / completions / diagnostics / rename /
  graph / cache / CRLF / void-oid regression) — all green.
• 28 compiled-dist feature markers — all green.
• 18/18 visual end-to-end checks with screenshots (file open by click
  and double-click, Problems jump, theme remembered across reload,
  settings modal, circular graph, error popup).

TROUBLESHOOTING
───────────────
• Bridge issues: check the "● bridge" chip (bottom right). Click it to
  reconnect; open ⚙ Settings → native bridge → "run self-test".
• Any popup: "copy details" and send us the text.
• Prefs live in %APPDATA%\VelvetSharp\config.json (safe to delete).
