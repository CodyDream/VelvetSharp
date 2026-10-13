/** Phase 13 — render crash containment + one-click error reporting.
 *
 *  User report: "call flow make it still crash … you might need to put a error
 *  out what is wrong so i can copy paste to you". A React render-time throw
 *  unmounts the WHOLE component tree (white screen — the app "crashes"), and
 *  window.onerror alone cannot keep the UI alive. An error boundary placed
 *  INSIDE the risky view catches the throw, keeps the rest of the app running,
 *  and shows the full message + stack with a copy button so the report is
 *  exactly what we need to fix it. */

import React from "react";
import { useStore } from "./store";

/** clipboard write with the execCommand fallback (same strategy as the error popup) */
export async function copyText(text: string): Promise<boolean> {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall through */ }
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      ok = true;
    } catch { /* best effort */ }
  }
  return ok;
}

interface BoundaryProps { children: React.ReactNode; label: string; buildReport?: (e: any) => string }
interface BoundaryState { err: any | null }

export class CrashBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { err: null };

  static getDerivedStateFromError(err: any): BoundaryState {
    return { err };
  }

  componentDidCatch(err: any) {
    try {
      useStore.getState().setStatus(`${this.props.label} hit a render error — shown inline with a copy button`);
    } catch { /* store not ready */ }
  }

  private report = (e: any) =>
    this.props.buildReport?.(e) ??
    `[VelvetSharp error]\nwhere: ${this.props.label}\n${String(e?.message ?? e)}\n\n${String(e?.stack ?? "(no stack)")}`;

  render() {
    if (!this.state.err) return this.props.children;
    const e = this.state.err;
    return (
      <div className="dg-empty dg-crash">
        <div className="dg-crash-title">⚠ {this.props.label} hit an internal error while rendering</div>
        <div className="dg-crash-msg">{String(e?.message ?? e)}</div>
        <pre className="dg-crash-stack">{String(e?.stack ?? "(no stack)")}</pre>
        <div className="dg-crash-actions">
          <button className="dg-btn" onClick={() => this.setState({ err: null })}>⟳ retry</button>
          <button className="dg-btn" onClick={() => { void copyText(this.report(e)); }}>⧉ copy error</button>
        </div>
        <div className="dg-crash-hint">paste the copied details into a bug report — this view crashed but the rest of the editor is still alive</div>
      </div>
    );
  }
}
