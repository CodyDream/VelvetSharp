import "./index.css";
import { createRoot } from "react-dom/client";
import App, { boot } from "./App";
import { useStore } from "./store";
import { CrashBoundary } from "./crash";
import * as monacoProbe from "monaco-editor/editor/editor.main.js";
(window as any).__probe = { monacoEditor: typeof (monacoProbe as any).editor, monacoLang: typeof (monacoProbe as any).languages, keys: Object.keys(monacoProbe).slice(0, 8) };

window.addEventListener("error", (e) => {
  const msg = String(e.error?.message ?? e.message ?? "unknown").slice(0, 140);
  document.title = "ERR: " + msg; (window as any).__errStack = (e.error?.stack ?? "").slice(0, 500);
  try { useStore.getState().setStatus("js error: " + msg); } catch { /* store not ready */ }
  // v0.7.1: internal errors are no longer silent — the user finally SEES what
  // broke (message + stack, copyable) instead of a dead UI
  try {
    useStore.getState().showErrorPopup("Internal error", msg, String(e.error?.stack ?? "").slice(0, 4000));
  } catch { /* store not ready */ }
});
window.addEventListener("unhandledrejection", (e: any) => {
  const msg = String(e.reason?.message ?? e.reason).slice(0, 140);
  document.title = "REJ: " + msg;
  try { useStore.getState().setStatus("background error: " + msg); } catch { /* store not ready */ }
  try {
    useStore.getState().showErrorPopup(
      "Background error",
      msg,
      String(e.reason?.stack ?? (typeof e.reason === "object" ? JSON.stringify(e.reason, null, 2) : e.reason)).slice(0, 4000),
    );
  } catch { /* store not ready */ }
});

// Neutralino delivers its auth token ONE-SHOT via __neutralino_globals.js; if the
// page ever reloads (F5) the fresh fetch gets an empty token and the client lib's
// fatal handler calls document.body.replaceChildren() — wiping our whole UI.
// Keep the app alive instead: the status bar shows what went wrong.
const originalReplaceChildren = document.body.replaceChildren.bind(document.body);
(document.body as any).replaceChildren = (..._kids: Node[]) => {
  /* no-op — never wipe the app shell */
  void originalReplaceChildren;
};

if (!(window as any).__monacoBooted) { /* init after module eval */ }
(window as any).__mainRan = true;
// support/debug surface: lets a tester open the typed-path fallback directly
(window as any).__vsDebug = {
  openPathPrompt: (reason?: string) => {
    import("./store").then(({ useStore }) => useStore.getState().setPathPrompt({ reason: reason ?? "native folder dialog unavailable" }));
  },
};
const __root = createRoot(document.getElementById("root")!);
(window as any).__rootObj = __root;
// Phase 13 — a render crash anywhere keeps the shell alive + reports itself
// with a copy button instead of unmounting the whole tree ("the app crashed")
__root.render(
  <CrashBoundary
    label="VelvetSharp"
    buildReport={(e: any) => `[VelvetSharp fatal error]\n${String(e?.message ?? e)}\n\n${String(e?.stack ?? "(no stack)")}`}
  >
    <App />
  </CrashBoundary>
);
(window as any).__renderDone = true;
// Phase 13 debug surface — lets the E2E drive graph mode / flow file honestly
// (same spirit as __client / __editor)
(window as any).__vsStore = useStore;
boot();
