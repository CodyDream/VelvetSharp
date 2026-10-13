#!/usr/bin/env node
/** VelvetSharp — MCP (Model Context Protocol) stdio server. Phase 14.
 *
 *  WHAT: lets AI agents (Claude Desktop / Claude Code / Cursor / Cline / any
 *  MCP client) talk to the RUNNING VelvetSharp editor and pull:
 *    - get_problems            — every syntax error / warning the editor sees
 *                                (incl. unsaved buffers) → drive automated fixes
 *    - get_project_structure   — workspace file tree
 *    - search_code             — the editor's own find-in-files engine
 *    - get_file                — file content (live buffer if dirty)
 *    - get_workspace_summary   — one-shot overview
 *
 *  HOW: VelvetSharp is a Neutralino app; its local server cannot host custom
 *  HTTP routes, so this proxy speaks the Neutralino WebSocket protocol
 *  directly and rides `events.broadcast`:
 *
 *    agent ──stdio (newline JSON-RPC, MCP spec)──▶ this file
 *          ──ws://127.0.0.1:<port>?connectToken=…──▶ Neutralino server
 *          ──broadcast "vsMcpRequest"──▶ editor page (mcp-server.ts)
 *          ◀─broadcast "vsMcpResponse"──┘
 *          ◀──stdio── agent
 *
 *  Auth: the port comes from the editor's discovery file
 *  (<dataDir>/VelvetSharp/mcp.json, same folder as config.json) or --port;
 *  the one-shot token is fetched from /__neutralino_globals.js — exactly how
 *  the editor's own page recovers its token.
 *
 *  Transport notes:
 *    - stdio framing is NEWLINE-DELIMITED JSON-RPC 2.0 (the MCP stdio spec).
 *    - stdout carries ONLY protocol messages; everything human goes to stderr.
 *    - zero npm dependencies — WebSocket client is hand-rolled on net+crypto
 *      (RFC 6455), so this runs on any Node.js ≥ 18 with no install step.
 *
 *  Usage:  node mcp/server.mjs [--port N] [--config path/to/mcp.json] [--url ws://127.0.0.1:PORT]
 */

import net from "node:net";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const VERSION = "14.0.0";
const TOOL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 8_000;

/* ------------------------------ CLI + discovery ------------------------------ */

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--config") out.config = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--version") { console.error(`velvetsharp-mcp ${VERSION}`); process.exit(0); }
  }
  return out;
}
const ARGS = parseArgs(process.argv);

if (ARGS.help) {
  console.error(`VelvetSharp MCP server ${VERSION} — exposes the running VelvetSharp editor to AI agents.

Usage:
  node server.mjs [--port N] [--config mcp.json path] [--url ws://127.0.0.1:PORT]

Discovery order:
  1. --port / --url / VELVETSHARP_MCP_PORT env
  2. --config file
  3. <dataDir>/VelvetSharp/mcp.json  (written by the editor at boot:
     %APPDATA% on Windows, ~/Library/Application Support on macOS,
     ~/.config on Linux, ~/.velvetsharp as fallback)

Requires VelvetSharp to be running (the tools answer from the live editor).
Register in your MCP client (example, Claude Desktop claude_desktop_config.json):
  "velvetsharp": { "command": "node", "args": ["<VelvetSharp folder>/mcp/server.mjs"] }
`);
  process.exit(0);
}

function discoveryCandidates() {
  const list = [];
  if (ARGS.config) list.push(ARGS.config);
  const add = (p) => p && list.push(p);
  const home = os.homedir();
  if (process.platform === "win32" && process.env.APPDATA) add(path.join(process.env.APPDATA, "VelvetSharp", "mcp.json"));
  if (process.platform === "darwin") add(path.join(home, "Library", "Application Support", "VelvetSharp", "mcp.json"));
  if (process.platform !== "win32" && process.platform !== "darwin") {
    // Neutralino os.getPath("data") = XDG_DATA_HOME on Linux (+ historical fallbacks)
    add(path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "VelvetSharp", "mcp.json"));
    add(path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "VelvetSharp", "mcp.json"));
  }
  add(path.join(home, ".velvetsharp", "mcp.json"));
  return list;
}

function readDiscovery() {
  for (const p of discoveryCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j && Number(j.port) > 0) return { ...j, file: p };
    } catch { /* try the next candidate */ }
  }
  return null;
}

/* ------------------------------ MCP tool catalog ------------------------------ */

const TOOLS = [
  {
    name: "get_problems",
    description: "Get the current project problems (syntax errors, semantic warnings, obsolete-API usage) exactly as the VelvetSharp Problems bar shows them, including unsaved editor buffers. Returns compiler-style rows: file(line,col): SEVERITY CODE: message.",
    inputSchema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["all", "error", "warning", "info"], description: "filter (default all)" },
        max: { type: "number", description: "max rows (default 1000)" },
      },
    },
  },
  {
    name: "get_project_structure",
    description: "Get the workspace file tree of the Unity project open in VelvetSharp (scripts, assets, project files known to the editor).",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "optional relative folder to scope the tree to (e.g. Assets/Scripts)" },
        max: { type: "number", description: "max entries (default 2000)" },
      },
    },
  },
  {
    name: "search_code",
    description: "Search code across the whole project with the editor's own find-in-files engine (VelvetSharp Ctrl+Shift+F). Supports literal / whole-word / regex queries. Returns path:line:col plus the matched source line.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "text or pattern to find" },
        regex: { type: "boolean", description: "treat query as a regular expression" },
        wholeWord: { type: "boolean", description: "match whole identifiers only" },
        caseSensitive: { type: "boolean", description: "case sensitive search" },
        max: { type: "number", description: "max hits (default 200)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_file",
    description: "Read a workspace file (optionally a line range). If the file is open in the editor with unsaved changes, the live buffer is returned and flagged. Path is relative to the workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "relative path, e.g. Assets/Scripts/Player.cs" },
        fromLine: { type: "number", description: "1-based first line (default 1)" },
        toLine: { type: "number", description: "1-based last line (default end)" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_workspace_summary",
    description: "One-shot overview of the workspace: root, file/script counts, error/warning totals, assemblies, Unity API status. Call this first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "apply_payload",
    description: "Apply a VelvetSharp Agent Payload: create / modify / delete / move workspace files in ONE call, exactly like the editor's Agent Bridge window does for web AI agents. modify takes either full replacement 'content' or an exact 'find'/'replace' pair. Every operation is planned first (missing find text, existing create targets, collisions are blocked); the response is a copyable per-operation report. Paths are workspace-relative with forward slashes; text files only.",
    inputSchema: {
      type: "object",
      properties: {
        payload: {
          oneOf: [{ type: "object" }, { type: "string" }],
          description: "the Agent Payload object (or a JSON string of it): { velvetsharp: 1, agent, message, operations: [ {op:'create',path,content,overwrite?} | {op:'modify',path,find,replace,all?} | {op:'modify',path,content} | {op:'delete',path} | {op:'move',from,to} ] }",
        },
      },
      required: ["payload"],
    },
  },
];

/* ------------------------------ WebSocket client ------------------------------
 * Minimal RFC 6455 client: enough for Neutralino's JSON control channel. */

class WsClient {
  constructor(url) { this.url = url; this.onmessage = null; this.onclose = null; this.sock = null; }
  connect(timeoutMs = CONNECT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const key = crypto.randomBytes(16).toString("base64");
      const sock = net.connect(Number(u.port || 80), u.hostname, () => {
        const req =
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.hostname}:${u.port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`;
        sock.write(req);
      });
      sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error(`connect timeout after ${timeoutMs}ms — is VelvetSharp running?`)); });
      let buf = Buffer.alloc(0);
      let upgraded = false;
      let frags = [];
      const fail = (e) => { try { sock.destroy(); } catch {} reject(e); };
      sock.on("error", (e) => { if (!upgraded) fail(new Error(`socket error: ${e.message}`)); });
      sock.on("close", () => { if (!upgraded) fail(new Error("connection closed before the websocket handshake finished")); this.onclose?.(); });
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        if (!upgraded) {
          const idx = buf.indexOf("\r\n\r\n");
          if (idx < 0) return;
          const head = buf.slice(0, idx).toString("latin1");
          buf = buf.slice(idx + 4);
          if (!/HTTP\/1\.1 101/i.test(head)) return fail(new Error("websocket handshake refused — is this the VelvetSharp editor port?"));
          upgraded = true;
          this.sock = sock;
          resolve(this);
        }
        // frame stream
        while (buf.length >= 2) {
          const b0 = buf[0], b1 = buf[1];
          const fin = (b0 & 0x80) !== 0;
          const op = b0 & 0x0f;
          const masked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > 32n * 1024n * 1024n) { fail(new Error("frame too large")); return; } len = Number(big); off = 10; }
          if (buf.length < off + len + (masked ? 4 : 0)) return;
          const maskKey = masked ? buf.slice(off, off + 4) : null;
          const payload = buf.slice(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
          if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
          buf = buf.slice(off + len + (masked ? 4 : 0));
          if (op === 0x8) { // close
            try { this._sendFrame(0x8, payload.slice(0, 2)); } catch {}
            sock.destroy();
            this.sock = null;
            this.onclose?.();
            return;
          }
          if (op === 0x9) { try { this._sendFrame(0xA, payload); } catch {} continue; } // ping → pong
          if (op === 0xA) continue; // pong
          if (op === 0x1 || op === 0x2 || op === 0x0) {
            frags.push(payload);
            if (!fin) continue;
            const full = Buffer.concat(frags).toString("utf8");
            frags = [];
            try { this.onmessage?.(full); } catch (e) { log(`message handler error: ${e.message}`); }
          }
        }
      });
    });
  }
  _sendFrame(op, payload = Buffer.alloc(0)) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, 0x80 | len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
  send(text) { if (!this.sock) throw new Error("socket closed"); this._sendFrame(0x1, Buffer.from(text, "utf8")); }
  close() { try { if (this.sock) this._sendFrame(0x8, Buffer.from([0x03, 0xe8])); } catch {} try { this.sock?.destroy(); } catch {} this.sock = null; }
}

/* ------------------------------ editor connection ------------------------------ */

let ws = null;
let wsConnecting = null;
let seq = 0;
let reqSeq = 0;
let RAW_TOKEN = "";
const nativePending = new Map(); // id → {resolve, reject, timer}
const toolPending = new Map();   // mcp request id → {resolve, reject, timer}

function log(msg) { process.stderr.write(`[velvetsharp-mcp] ${msg}\n`); }

async function fetchToken(port) {
  const txt = await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/__neutralino_globals.js", timeout: CONNECT_TIMEOUT_MS }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("token fetch timeout")); });
    req.on("error", reject);
  });
  const m = /NL_TOKEN\s*=\s*["']([^"']+)["']/.exec(txt);
  if (!m) throw new Error("could not read NL_TOKEN from /__neutralino_globals.js — is this the VelvetSharp editor port?");
  return m[1];
}

async function connectToEditor() {
  if (ws?.sock) return ws;
  if (wsConnecting) return wsConnecting;

  wsConnecting = (async () => {
    let port = ARGS.port ?? Number(process.env.VELVETSHARP_MCP_PORT ?? 0);
    let sharedToken = "";
    if (!port || !Number.isFinite(port)) {
      const disc = readDiscovery();
      if (!disc) throw new Error("VelvetSharp editor not found — start VelvetSharp first (it publishes its port to mcp.json), or pass --port N");
      port = Number(disc.port);
      sharedToken = String(disc.token ?? "");
      log(`discovery: port ${port}${disc.root ? `, workspace ${disc.root}` : ""} (from ${disc.file})`);
    } else {
      // an explicit --port may still have a discovery file with the token next to it
      const disc = readDiscovery();
      if (disc && Number(disc.port) === port) sharedToken = String(disc.token ?? "");
    }
    // the editor shares its connect token via the discovery file. Fallback: fetch
    // one from /__neutralino_globals.js (works only when the editor page has not
    // taken the one-shot token yet, e.g. the editor just started).
    let token = sharedToken;
    if (!token) {
      try { token = await fetchToken(port); } catch { token = ""; }
    }
    if (token) log("auth: using the editor's shared session token");
    else log("auth: no token available — trying an unauthenticated local socket");
    RAW_TOKEN = token;
    // the connect token is the JWT payload segment (same rule as the editor page);
    // native calls carry the FULL token as accessToken
    const connectToken = encodeURIComponent(token.split(".")[1] ?? token);
    const sock = new WsClient(`ws://127.0.0.1:${port}/?connectToken=${connectToken}`);
    sock.onmessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg?.id && nativePending.has(msg.id)) {
        const p = nativePending.get(msg.id);
        nativePending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.data?.error) p.reject(new Error(`${msg.data.error.code ?? "NE_UNKNOWN"}: ${msg.data.error.message ?? "native call failed"}`));
        else p.resolve(msg.data && Object.prototype.hasOwnProperty.call(msg.data, "returnValue") ? msg.data.returnValue : msg.data);
        return;
      }
      if (msg?.event === "vsMcpResponse" && msg.data && toolPending.has(msg.data.id)) {
        const p = toolPending.get(msg.data.id);
        toolPending.delete(msg.data.id);
        clearTimeout(p.timer);
        if (msg.data.ok) p.resolve(msg.data.result);
        else p.reject(new Error(msg.data.error || "tool failed in editor"));
      }
      // everything else (server events, our own vsMcpRequest echo) is ignored
    };
    sock.onclose = () => {
      ws = null;
      for (const [, p] of toolPending) { clearTimeout(p.timer); p.reject(new Error("VelvetSharp connection dropped — the editor may have been closed")); }
      toolPending.clear();
      for (const [, p] of nativePending) { clearTimeout(p.timer); p.reject(new Error("connection dropped")); }
      nativePending.clear();
      log("connection to the editor closed");
    };
    await sock.connect();
    ws = sock;
    log(`connected to the VelvetSharp editor on ws://127.0.0.1:${port}`);
    return sock;
  })();

  try { return await wsConnecting; } finally { wsConnecting = null; }
}

/** one Neutralino native method call (used for events.broadcast) */
function nativeCall(method, data, timeoutMs = 8000) {
  return new Promise(async (resolve, reject) => {
    let sock;
    try { sock = await connectToEditor(); } catch (e) { reject(e); return; }
    const id = `mcp${Date.now().toString(36)}${(seq++).toString(36)}`;
    const timer = setTimeout(() => { nativePending.delete(id); reject(new Error(`native call "${method}" timed out`)); }, timeoutMs);
    nativePending.set(id, { resolve, reject, timer });
    try { sock.send(JSON.stringify({ id, method, data, accessToken: RAW_TOKEN })); }
    catch (e) { nativePending.delete(id); clearTimeout(timer); reject(e); }
  });
}

/** ask the editor to run a tool; resolves with the tool result object.
 *  The request reaches the editor as the native method events.broadcast —
 *  clients may not send bare event frames over the Neutralino wire (the
 *  server closes the socket on those; that cost us one E2E round-trip). */
async function callTool(name, args) {
  const sock = await connectToEditor();
  const id = `t${Date.now().toString(36)}${(reqSeq++).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      toolPending.delete(id);
      reject(new Error(`tool "${name}" timed out after ${TOOL_TIMEOUT_MS / 1000}s — the editor may be busy; try again`));
    }, TOOL_TIMEOUT_MS);
    toolPending.set(id, { resolve, reject, timer });
    nativeCall("events.broadcast", { event: "vsMcpRequest", data: { id, tool: name, args: args ?? {} } })
      .catch((e) => log(`broadcast ack failed (still waiting for the tool response): ${e.message}`));
    void sock;
  });
}

/* ------------------------------ MCP stdio protocol ------------------------------
 * Newline-delimited JSON-RPC 2.0 (the MCP stdio transport). */

const PROTOCOL_VERSION = "2024-11-05";

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function result(id, res) { send({ jsonrpc: "2.0", id, result: res }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function toolResult(text, isError = false) {
  return { content: [{ type: "text", text: String(text) }], ...(isError ? { isError: true } : {}) };
}

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case "initialize":
        result(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "velvetsharp", title: "VelvetSharp (Unity C# editor)", version: VERSION },
          instructions: "Tools answer from the RUNNING VelvetSharp editor (a lightweight Unity C# IDE). Typical loop: get_workspace_summary → get_problems (fix the errors) → search_code/get_file to inspect → fix files with your own tools. The editor shows your changes as soon as its sweep notices them (or after the user saves).",
        });
        return;
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/progress":
        return; // notifications never get a response
      case "ping":
        result(id, {});
        return;
      case "tools/list":
        result(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (!TOOLS.some((t) => t.name === name)) {
          error(id, -32602, `unknown tool "${name}" — available: ${TOOLS.map((t) => t.name).join(", ")}`);
          return;
        }
        try {
          const r = await callTool(name, args);
          result(id, toolResult(r && typeof r.text === "string" ? r.text : JSON.stringify(r, null, 2)));
        } catch (e) {
          // tool execution failures are RESULTS with isError (agents read them)
          result(id, toolResult(`${e.message}\n\nTip: tools answer from the RUNNING VelvetSharp editor — start it (and open your Unity project) first, then retry.`, true));
        }
        return;
      }
      default:
        if (!isNotification) error(id, -32601, `method "${method}" not found — this server implements initialize, ping, tools/list, tools/call`);
    }
  } catch (e) {
    log(`rpc handler error: ${e.message}`);
    if (!isNotification) error(id, -32603, `internal error: ${e.message}`);
  }
}

let lineBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  lineBuf += chunk;
  let idx;
  while ((idx = lineBuf.indexOf("\n")) >= 0) {
    const line = lineBuf.slice(0, idx).trim();
    lineBuf = lineBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { error(null, -32700, `parse error: ${e.message}`); continue; }
    void handleRpc(msg).catch((e) => log(`unhandled rpc error: ${e.message}`));
  }
});
process.stdin.on("end", () => { log("stdin closed — shutting down"); try { ws?.close(); } catch {} process.exit(0); });
process.on("SIGINT", () => { try { ws?.close(); } catch {} process.exit(0); });

log(`velvetsharp-mcp ${VERSION} ready — MCP handshake expected on stdio (newline JSON-RPC)`);
if (!ARGS.port && !process.env.VELVETSHARP_MCP_PORT) {
  const d = readDiscovery();
  if (d) log(`editor discovery file found: port ${d.port}${d.root ? ` (${d.root})` : ""}`);
  else log("no discovery file yet — start VelvetSharp, or pass --port (tools still register and explain how to connect)");
}
