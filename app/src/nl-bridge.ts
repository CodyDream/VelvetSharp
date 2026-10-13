/** VelvetSharp v0.7.1 — self-healing Neutralino native bridge.
 *
 *  WHY THIS EXISTS (user report: "main bridge fails, backup socket takes forever
 *  to read the disk, why does the native bridge not work on Windows"):
 *
 *  The stock @neutralinojs/lib client has three fatal behaviors on Windows:
 *    1. It opens ONE WebSocket and NEVER reconnects. On any error/close every
 *       subsequent native call is pushed into an internal queue that only
 *       flushes on a "ready" event that never comes — so file reads hang
 *       FOREVER with no error. That silent hang is exactly "clicking a file
 *       does nothing" + "reading the disk takes extremely long".
 *    2. It connects to `window.location.hostname`. On Windows that is
 *       `localhost`, which WebView2 may resolve to IPv6 ::1 (the server listens
 *       on IPv4) or route through a system/VPN proxy — both kill the socket.
 *       We connect to 127.0.0.1 directly (the same host Neutralino itself uses
 *       in injected mode) and fall back to the page host.
 *    3. Its NL_TOKEN is one-shot via __neutralino_globals.js: after any page
 *       reload window.NL_TOKEN is empty and reconnect attempts authenticate
 *       with "" → NE_RT_INVTOKN. We persist the first good token into
 *       sessionStorage at module-eval time and can also re-fetch a fresh one.
 *
 *  This module speaks the same wire protocol (id/method/data/accessToken JSON
 *  over ws://127.0.0.1:<port>?connectToken=<jwt payload>) but adds: per-call
 *  timeouts, automatic reconnection with backoff, queue flush on reconnect,
 *  token recovery, and a state subscription for the status-bar chip.
 */

export type BridgeState = "connecting" | "connected" | "offline";

interface PendingCall {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  data?: any;
  /** Phase 12: set when this call was already replayed once after a drop —
   *  a second drop rejects it instead of replaying forever */
  retried?: boolean;
}

interface QueuedCall {
  method: string;
  data: any;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timeoutMs: number;
  retried?: boolean;
}

const DEFAULT_TIMEOUT = 10_000;   // per-call timeout — no native call may hang forever
const RECONNECT_MAX_MS = 5_000;
const RECONNECT_BASE_MS = 300;
/** Phase 12 — idle heartbeat: proves the socket is alive even when the UI is
 *  quiet, so a zombie socket is detected in seconds instead of at the next
 *  user action. Two missed beats trip the same zombie-reconnect rule. */
const HEARTBEAT_MS = 20_000;

let ws: WebSocket | null = null;
let state: BridgeState = "offline";
let attempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const hostsToTry: string[] = [];
const pending = new Map<string, PendingCall>();
const queue: QueuedCall[] = [];
const stateSubs = new Set<(s: BridgeState) => void>();
let seq = 0; // request id counter

export const bridgeStats = {
  lastError: "",
  lastErrorAt: 0,
  reconnects: 0,
  timeouts: 0,
  /** Phase 12 — CONSECUTIVE timeouts on the current socket; reset by every
   *  successful answer and by reconnects. (The old code tested the LIFETIME
   *  timeout counter for evenness and never reset it, so after two timeouts
   *  ever, every second later timeout tore down a perfectly healthy socket
   *  and orphaned the calls riding on it.) */
  consecTimeouts: 0,
  /** Phase 12 — calls replayed after a socket drop (in-flight recovery) */
  replayed: 0,
  host: "127.0.0.1",
};

/* ------------------------------ token ------------------------------ */

/** persist the one-shot token BEFORE anything can reload the page */
function grabToken(): void {
  try {
    const t = (window as any).NL_TOKEN;
    if (t && !sessionStorage.getItem("NL_TOKEN")) sessionStorage.setItem("NL_TOKEN", String(t));
  } catch { /* storage off */ }
}
grabToken();

function rawToken(): string {
  try {
    return String((window as any).NL_TOKEN || sessionStorage.getItem("NL_TOKEN") || "");
  } catch { return String((window as any).NL_TOKEN || ""); }
}

/** after NE_RT_INVTOKN: the server can hand out a fresh one-shot token */
async function refreshTokenFromServer(): Promise<boolean> {
  try {
    const res = await fetch("/__neutralino_globals.js", { cache: "no-store" });
    const txt = await res.text();
    const m = /NL_TOKEN\s*=\s*["']([^"']+)["']/.exec(txt);
    if (m && m[1] && m[1] !== rawToken()) {
      (window as any).NL_TOKEN = m[1];
      try { sessionStorage.setItem("NL_TOKEN", m[1]); } catch { /* ignore */ }
      return true;
    }
  } catch { /* server unreachable — reconnect loop will keep trying */ }
  return false;
}

/* ------------------------------ state ------------------------------ */

function setState(s: BridgeState): void {
  if (state === s) return;
  state = s;
  for (const cb of stateSubs) { try { cb(s); } catch { /* listener bug */ } }
}

export function getBridgeState(): BridgeState { return state; }
export function subscribeBridge(cb: (s: BridgeState) => void): () => void {
  stateSubs.add(cb);
  cb(state);
  return () => stateSubs.delete(cb);
}

/* ------------------------------ connect ------------------------------ */

function candidateHosts(): string[] {
  const list: string[] = ["127.0.0.1"];
  try {
    const pageHost = window.location?.hostname;
    if (pageHost && pageHost !== "127.0.0.1" && pageHost !== "localhost") list.push(pageHost);
    if (pageHost === "localhost") list.push("localhost"); // last resort: page's own view of loopback
  } catch { /* ignore */ }
  return list;
}

export function connectBridge(): void {
  if (typeof window === "undefined" || !("NL_PORT" in window)) return; // not desktop
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (!hostsToTry.length) hostsToTry.push(...candidateHosts());

  const port = (window as any).NL_PORT;
  const token = rawToken();
  const host = hostsToTry.shift() ?? "127.0.0.1";
  // hostsToTry is consumed round-robin: push the tried host to the back so the
  // next reconnect alternates hosts instead of giving up on the primary
  hostsToTry.push(host);
  bridgeStats.host = host;
  setState("connecting");

  let url = `ws://${host}:${port}`;
  if (token) url += `?connectToken=${encodeURIComponent(token.split(".")[1] ?? token)}`;

  let sock: WebSocket;
  try { sock = new WebSocket(url); } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.addEventListener("open", () => {
    attempts = 0;
    setState("connected");
    flushQueue();
  });

  sock.addEventListener("message", (ev) => {
    let msg: any;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg?.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      bridgeStats.consecTimeouts = 0; // a live answer resets the zombie counter
      if (msg.data?.error) {
        const code = String(msg.data.error.code ?? "NE_UNKNOWN");
        const message = String(msg.data.error.message ?? "native call failed");
        if (code === "NE_RT_INVTOKN") {
          // token invalidated (e.g. server restarted) — fetch a fresh one and re-handshake
          refreshTokenFromServer().then(() => forceReconnect());
        }
        p.reject(new Error(`${code}: ${message}`));
      } else {
        p.resolve(msg.data && Object.prototype.hasOwnProperty.call(msg.data, "returnValue")
          ? msg.data.returnValue
          : msg.data);
      }
    } else if (msg?.event) {
      // same CustomEvent surface the stock lib exposes — events.on keeps working
      try { window.dispatchEvent(new CustomEvent(msg.event, { detail: msg.data })); } catch { /* ignore */ }
    }
  });

  const dropped = () => {
    if (ws !== sock) return; // superseded by a newer socket
    ws = null;
    setState("offline");
    // Phase 12 — IN-FLIGHT RECOVERY (was: only calls made while offline were
    // replayed; calls already sent died on their 10 s timers): calls still
    // waiting for an answer are re-queued ONCE, in order, onto the fresh
    // socket as soon as it opens. Reads are trivially idempotent; writes
    // replay with identical payloads. A call that has already been replayed
    // once and sees a second drop fails LOUDLY instead of looping.
    let front = 0;
    for (const [id, p] of [...pending]) {
      pending.delete(id);
      clearTimeout(p.timer);
      if (p.retried) {
        p.reject(new Error(`bridge dropped twice before "${p.method}" answered — giving up`));
      } else {
        queue.splice(front++, 0, { method: p.method, data: p.data, resolve: p.resolve, reject: p.reject, timeoutMs: DEFAULT_TIMEOUT, retried: true });
        bridgeStats.replayed++;
      }
    }
    scheduleReconnect();
  };
  sock.addEventListener("close", dropped);
  sock.addEventListener("error", dropped);
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, Math.min(attempts, 6)), RECONNECT_MAX_MS);
  attempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, delay);
}

export function forceReconnect(): void {
  bridgeStats.reconnects++;
  try { ws?.close(); } catch { /* ignore */ }
  ws = null;
  setState("offline");
  connectBridge();
}

function flushQueue(): void {
  while (queue.length) {
    const q = queue.shift()!;
    sendNow(q.method, q.data, q.timeoutMs, q.retried).then(q.resolve, q.reject);
  }
}

/* ------------------------------ call ------------------------------ */

function sendNow(method: string, data: any, timeoutMs: number, retried = false): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`bridge offline — "${method}" not sent`));
      return;
    }
    const id = `vs${Date.now().toString(36)}${(seq++).toString(36)}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      bridgeStats.timeouts++;
      bridgeStats.consecTimeouts++;
      bridgeStats.lastError = `timeout: ${method}`;
      bridgeStats.lastErrorAt = Date.now();
      // two consecutive timeouts on the CURRENT socket mean it is a zombie —
      // rebuild it (the counter resets on every answer and on reconnect, so
      // one slow call over a healthy socket can no longer tear it down)
      if (bridgeStats.consecTimeouts >= 2) {
        bridgeStats.consecTimeouts = 0;
        forceReconnect();
      }
      reject(new Error(`native bridge timeout after ${Math.round(timeoutMs / 1000)}s — ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method, data, retried });
    try {
      ws.send(JSON.stringify({ id, method, data, accessToken: rawToken() }));
    } catch (e: any) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`bridge send failed — ${method}: ${e?.message ?? e}`));
    }
  });
}

/** One resilient native call: queues while connecting, times out deterministically. */
export function nlCall(method: string, data?: any, timeoutMs = DEFAULT_TIMEOUT): Promise<any> {
  if (typeof window === "undefined" || !("NL_PORT" in window)) {
    return Promise.reject(new Error("not running inside the VelvetSharp desktop shell"));
  }
  connectBridge();
  if (ws && ws.readyState === WebSocket.OPEN) return sendNow(method, data, timeoutMs);
  return new Promise((resolve, reject) => {
    queue.push({ method, data, resolve, reject, timeoutMs });
    // safety valve: a queued call that waits longer than its own timeout + 15s of
    // reconnect attempts fails LOUDLY instead of hanging forever (the old bug)
    setTimeout(() => {
      const i = queue.findIndex((q) => q.resolve === resolve);
      if (i >= 0) {
        queue.splice(i, 1);
        reject(new Error(`bridge offline for ${Math.round((timeoutMs + 15_000) / 1000)}s — ${method} never ran`));
      }
    }, timeoutMs + 15_000);
  });
}

/* ------------------------------ events ------------------------------ */

export function onBridgeEvent(name: string, cb: (detail: any) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent).detail);
  window.addEventListener(name, h);
  return () => window.removeEventListener(name, h);
}

/** quick health probe used by the settings modal + status chip tooltip */
export async function bridgeSelfTest(): Promise<{ ok: boolean; rttMs: number; detail: string }> {
  const t0 = performance.now();
  try {
    await nlCall("app.getConfig", undefined, 4000);
    const rtt = Math.round(performance.now() - t0);
    return { ok: true, rttMs: rtt, detail: `core answered in ${rtt} ms via ws://${bridgeStats.host}` };
  } catch (e: any) {
    return { ok: false, rttMs: Math.round(performance.now() - t0), detail: String(e?.message ?? e) };
  }
}

/* ---------------------- liveness: heartbeat + wake ----------------------
 *  Windows sleep / VPN blips used to go unnoticed until the next user action
 *  failed. Now: a 20 s heartbeat proves the socket while the UI is idle, and
 *  waking the machine / regaining the network reconnects immediately. */

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (state !== "connected") return;
    try { if (document.visibilityState !== "visible") return; } catch { /* non-DOM */ }
    // a missed beat lands in the timeout path (consecTimeouts++) — two missed
    // beats rebuild the socket without waiting for a user action to fail
    nlCall("app.getProcessId", undefined, 6_000).catch(() => { /* zombie rule owns it */ });
  }, HEARTBEAT_MS);
}

function installWakeHandlers(): void {
  try {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (state === "connected") return;
      // woke up — skip the backoff and reconnect right now
      attempts = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      connectBridge();
    });
    window.addEventListener("online", () => {
      if (state === "connected") return;
      attempts = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      connectBridge();
    });
  } catch { /* non-DOM environment */ }
}
startHeartbeat();
installWakeHandlers();

/* --------------------------- namespace shims ---------------------------
 * Drop-in surface mirroring the parts of @neutralinojs/lib the app uses, so
 * adapters/projectCache/App need zero API changes — they just import THIS
 * module instead of the fragile stock client.                              */

const filesystem = {
  getStats: (path: string) => nlCall("filesystem.getStats", { path }, 15_000),
  // Phase 12: 25 s for file IO — 10 s was short for multi-MB scripts while
  // antivirus scans them; a timeout here used to cascade into a reconnect
  readFile: (path: string) => nlCall("filesystem.readFile", { path }, 25_000),
  writeFile: (path: string, data: string) => nlCall("filesystem.writeFile", { path, data }, 25_000),
  readDirectory: (path: string) => nlCall("filesystem.readDirectory", { path }, 20_000),
  createDirectory: (path: string) => nlCall("filesystem.createDirectory", { path }),
  remove: (path: string) => nlCall("filesystem.remove", { path }),
  move: (source: string, destination: string) => nlCall("filesystem.move", { source, destination }),
  getAbsolutePath: (path: string) => nlCall("filesystem.getAbsolutePath", { path }),
};

const os = {
  showFolderDialog: (title: string) => nlCall("os.showFolderDialog", { title }, 180_000),
  showOpenDialog: (title: string) => nlCall("os.showOpenDialog", { title }, 180_000),
  getPath: (name: string) => nlCall("os.getPath", { name }),
  getEnv: (key: string) => nlCall("os.getEnv", { key }),
};

const windowNs = {
  focus: () => nlCall("window.focus"),
  setTitle: (title: string) => nlCall("window.setTitle", { title }),
  getSize: () => nlCall("window.getSize"),
  center: () => nlCall("window.center"),
};

const app = {
  exit: (code = 0) => nlCall("app.exit", { code }),
  getConfig: () => nlCall("app.getConfig"),
  getProcessId: () => nlCall("app.getProcessId"),
};

const clipboard = {
  writeText: (data: string) => nlCall("clipboard.writeText", { data }),
  readText: () => nlCall("clipboard.readText"),
};

const debug = {
  log: (message: string) => nlCall("debug.log", { message }).catch(() => { /* logging must never throw */ }),
};

export const events = {
  on: (name: string, cb: (e: Event) => void) => {
    window.addEventListener(name, cb);
    return Promise.resolve({ success: true });
  },
  off: (name: string, cb: (e: Event) => void) => {
    window.removeEventListener(name, cb);
    return Promise.resolve({ success: true });
  },
};

export { filesystem, os, windowNs as window, app, clipboard, debug };
export const DEFAULT_CALL_TIMEOUT = DEFAULT_TIMEOUT;
