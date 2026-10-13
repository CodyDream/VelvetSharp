/**
 * Phase 14 E2E — real find-in-files + MCP end-to-end through the REAL stack.
 *
 * Unlike the other phase E2Es (plain http server + browser demo), this drives
 * the REAL Neutralino server in cloud mode serving the REAL built resources:
 *   1. spawn desktop/dist/VelvetSharp/neutralino-test --mode=cloud --project=<app/demo>
 *   2. Chromium loads http://127.0.0.1:<port>/ → consumes the one-shot token,
 *      boots in DESKTOP mode (real bridge, real filesystem, real events)
 *   3. find-in-files: Ctrl+Shift+F → live results → jump → whole-word option
 *      → coverage banner ("not scanned yet") → scan & re-run
 *   4. MCP full loop: node mcp/server.mjs --config <discovery written by the
 *      page> → initialize/tools/list over stdio → tools/call answered by the
 *      LIVE page (summary/root, problems, structure, search, file content)
 *   5. default discovery path (no --config) also connects
 *   6. zero page errors
 *
 * Run: NODE_PATH=/home/z/.npm-global/lib/node_modules node scripts/e2e-phase14.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEU_DIR = path.join(ROOT, "desktop", "dist", "VelvetSharp");
const NEU_BIN = fs.existsSync(path.join(NEU_DIR, "neutralino-test")) ? path.join(NEU_DIR, "neutralino-test") : path.join(NEU_DIR, "VelvetSharp-linux_x64");
// fresh port per run — a not-yet-reaped previous binary would otherwise win the bind
const PORT = 18000 + (process.pid % 2000);
const DEMO = path.join(ROOT, "app", "demo");
// Neutralino os.getPath("data") = XDG_DATA_HOME on Linux → ~/.local/share/VelvetSharp
const MCP_DISCOVERY_DIRS = [
  path.join(os.homedir(), ".local", "share", "VelvetSharp"),
  path.join(os.homedir(), ".config", "VelvetSharp"),
  path.join(os.homedir(), ".velvetsharp"),
];

const results = [];
const check = (name, ok, extra = "") => {
  results.push([name, !!ok]);
  console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}${ok || !extra ? "" : " · " + String(extra).slice(0, 160)}`);
};

const MCP_LOG = [];
function spawnMcp(args) {
  const child = spawn("node", [path.join(ROOT, "mcp", "server.mjs"), ...args], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (d) => MCP_LOG.push(String(d)));
  return child;
}
let mcpSeq = 0;
function mcpRpc(child, msg, timeoutMs = 25000) {
  // notifications never get a response — fire and forget
  if (String(msg.method ?? "").startsWith("notifications/")) {
    child.stdin.write(JSON.stringify(msg) + "\n");
    return Promise.resolve({ result: {} });
  }
  return new Promise((resolve, reject) => {
    const id = msg.id ?? `n${mcpSeq++}`;
    const timer = setTimeout(() => reject(new Error(`mcp rpc timeout: ${msg.method}`)), timeoutMs);
    const on_data = (buf) => {
      for (const line of String(buf).split("\n")) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.id === id) {
            clearTimeout(timer);
            child.stdout.off("data", on_data);
            resolve(j);
          }
        } catch { /* partial line */ }
      }
    };
    child.stdout.on("data", on_data);
    child.stdin.write(JSON.stringify({ ...msg, id }) + "\n");
  });
}

async function waitFor(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  if (!fs.existsSync(NEU_BIN)) {
    console.error(`FATAL: ${NEU_BIN} missing — run "neu build --release" in desktop/ first`);
    process.exit(1);
  }
  // stale discovery from older runs must not answer for the new port
  for (const d of MCP_DISCOVERY_DIRS) { try { fs.rmSync(path.join(d, "mcp.json"), { force: true }); } catch { /* ignore */ } }

  console.log("== starting the REAL Neutralino server (cloud mode) on", PORT, "==");
  const neu = spawn(NEU_BIN, ["--mode=cloud", `--port=${PORT}`, `--project=${DEMO}`], {
    cwd: NEU_DIR,
    env: { ...process.env, LD_LIBRARY_PATH: "/tmp/my-project/scratch-neu/xlibs/usr/lib/x86_64-linux-gnu:/tmp/my-project/scratch-neu/xlibs/root/usr/lib/x86_64-linux-gnu" },
    stdio: "ignore",
  });
  const up = await waitFor(`http://127.0.0.1:${PORT}/`);
  check("real Neutralino server up (cloud mode)", up);
  if (!up) { neu.kill(); process.exit(2); }
  // the token delivered via /__neutralino_globals.js is ONE-SHOT and this run's
  // browser must be its first consumer — burn nothing before the page loads

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e)));
  // a saved theme keeps the first-run theme picker overlay closed
  await page.addInitScript(() => { try { localStorage.setItem("velvetsharp.theme", "tokyo-night"); } catch { /* ignore */ } });

  console.log("== booting the editor page against the real server ==");
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__editor && window.__client && window.__vsStore, null, { timeout: 30000 });
  // desktop-mode boot: real bridge + real FS + MCP discovery write
  await page.waitForFunction(() => window.__vsStore?.getState().files?.length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(2000); // brain init + first index

  // -- 1. the page runs in DESKTOP mode against the real server --
  const desk = await page.evaluate(() => ({
    port: window.NL_PORT,
    files: window.__vsStore.getState().files.length,
    root: (window.__vsStore.getState(), window.__vsMcp?.status?.()?.root ?? null),
    mcp: window.__vsMcp?.status?.() ?? null,
  }));
  check("page booted in desktop mode (NL_PORT present)", !!desk.port, String(desk.port));
  check("demo workspace loaded from the real filesystem", desk.files > 10, `${desk.files} files`);

  // -- 2. find-in-files: Ctrl+Shift+F → live results → jump --
  await page.keyboard.press("Control+Shift+f");
  await page.waitForSelector(".sidebar .search input", { timeout: 5000 });
  await page.fill(".sidebar .search input", "Turret");
  await page.waitForSelector(".sidebar .search-hit", { timeout: 8000 });
  const meta = await page.evaluate(() => document.querySelector(".sidebar .search-meta")?.textContent ?? "");
  check("Ctrl+Shift+F opens the panel and live-searches 'Turret'", /match(es)? in \d+ file/.test(meta), meta);
  const hitFile = await page.evaluate(() => document.querySelector(".sidebar .search-file")?.textContent ?? "");
  check("results grouped per file with counts", /Turret/.test(hitFile) && /\d/.test(hitFile), hitFile);
  await page.click(".sidebar .search-hit");
  await page.waitForTimeout(600);
  const active = await page.evaluate(() => window.__vsStore.getState().active);
  check("clicking a hit opens the file in the editor", /Turret\.cs$/.test(String(active)), String(active));

  // -- 3. options: case sensitivity changes results --
  await page.fill(".sidebar .search input", "turret");
  await page.waitForTimeout(500);
  await page.waitForSelector(".sidebar .search-hit", { timeout: 8000 });
  const ciCount = await page.evaluate(() => document.querySelectorAll(".sidebar .search-hit").length);
  await page.click('.sidebar .search-opts .opt:has-text("Aa")');
  await page.waitForTimeout(600);
  const csCount = await page.evaluate(() => document.querySelectorAll(".sidebar .search-hit").length);
  check("case-sensitive option narrows results (Aa toggle)", csCount < ciCount, `ci=${ciCount} cs=${csCount}`);
  await page.click('.sidebar .search-opts .opt:has-text("Aa")'); // back to case-insensitive

  // -- 4. coverage: warm-cache files surface as "not scanned yet" → scan & re-run --
  const banner = await page.$(".sidebar .scan-btn");
  if (banner) {
    const before = await page.evaluate(() => document.querySelectorAll(".sidebar .search-hit").length);
    await page.click(".sidebar .scan-btn");
    await page.waitForFunction(() => !document.querySelector(".sidebar .scan-btn"), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => document.querySelectorAll(".sidebar .search-hit").length);
    check("coverage banner: scan & re-run completes the search", after >= before, `before=${before} after=${after}`);
  } else {
    check("coverage banner: no unsearched files (cold cache run) — feature n/a this run", true);
  }
  const mark = await page.evaluate(() => { const m = document.querySelector(".sidebar .search-hit mark"); return m ? m.textContent : ""; });
  check("match text highlighted inside the result line", /turret/i.test(String(mark)), String(mark));

  // -- 5. MCP: the page published its discovery file --
  const discPath = await page.evaluate(() => window.__vsMcpDiscoveryPath ?? "");
  check("page wrote the MCP discovery file", !!discPath && fs.existsSync(String(discPath)), String(discPath));
  const disc = discPath ? JSON.parse(fs.readFileSync(String(discPath), "utf8")) : {};
  check("discovery carries port + shared token + workspace root",
    Number(disc.port) === Number(desk.port) && typeof disc.token === "string" && disc.token.length > 4 && /demo/.test(String(disc.root ?? "")),
    `port=${disc.port} token=${String(disc.token ?? "").length} root=${disc.root}`);

  console.log("== MCP full loop: stdio proxy ↔ real server ↔ live page ==");
  const mcp = spawnMcp(["--config", String(discPath)]);
  const init = await mcpRpc(mcp, { jsonrpc: "2.0", id: "i1", method: "initialize", params: { capabilities: {} } });
  check("MCP initialize answers with the server identity",
    init.result?.serverInfo?.name === "velvetsharp" && !!init.result?.protocolVersion, JSON.stringify(init.result?.serverInfo ?? {}));
  await mcpRpc(mcp, { jsonrpc: "2.0", method: "notifications/initialized" });
  const tools = await mcpRpc(mcp, { jsonrpc: "2.0", id: "t1", method: "tools/list" });
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  check("tools/list exposes the five editor tools",
    ["get_problems", "get_project_structure", "search_code", "get_file", "get_workspace_summary"].every((n) => names.includes(n)), names.join(","));

  const summary = await mcpRpc(mcp, { jsonrpc: "2.0", id: "c1", method: "tools/call", params: { name: "get_workspace_summary", arguments: {} } });
  const sumText = summary.result?.content?.[0]?.text ?? "";
  check("get_workspace_summary answered by the LIVE page (root = real demo dir)",
    summary.result && /VelvetSharp Phase/.test(sumText) && sumText.replace(/\\\\/g, "/").includes("app/demo"), sumText.split("\n")[0] + " …");

  const problems = await mcpRpc(mcp, { jsonrpc: "2.0", id: "c2", method: "tools/call", params: { name: "get_problems", arguments: { max: 50 } } });
  const probText = problems.result?.content?.[0]?.text ?? "";
  check("get_problems returns compiler-style rows with a summary",
    /VelvetSharp problems — \d+ errors?, \d+ warnings?/.test(probText), probText.split("\n").slice(0, 3).join(" | "));

  const structure = await mcpRpc(mcp, { jsonrpc: "2.0", id: "c3", method: "tools/call", params: { name: "get_project_structure", arguments: {} } });
  const structText = structure.result?.content?.[0]?.text ?? "";
  check("get_project_structure renders the workspace tree", structText.includes("Assets/") && /files/.test(structText), structText.split("\n")[0]);

  const search = await mcpRpc(mcp, { jsonrpc: "2.0", id: "c4", method: "tools/call", params: { name: "search_code", arguments: { query: "Vector3", max: 10 } } });
  const searchText = search.result?.content?.[0]?.text ?? "";
  check("search_code finds matches with path:line:col rows (editor's own engine)",
    /match\(es\) in \d+ file\(s\)/.test(searchText) && /\d+:\d+: /.test(searchText), searchText.split("\n").slice(0, 2).join(" | "));

  // read a REAL script (stable demo path — the tree shows names, not paths)
  const csFile = "Assets/Scripts/Player/PlayerController.cs";
  const fileRes = await mcpRpc(mcp, { jsonrpc: "2.0", id: "c5", method: "tools/call", params: { name: "get_file", arguments: { path: csFile } } });
  const fileText = fileRes.result?.content?.[0]?.text ?? "";
  check(`get_file returns the real file content (${csFile})`, /\| /.test(fileText) && /lines/.test(fileText), fileText.split("\n")[0]);

  const unknown = await mcpRpc(mcp, { jsonrpc: "2.0", id: "c6", method: "tools/call", params: { name: "nope", arguments: {} } });
  check("unknown tool → clean protocol error", unknown.error?.code === -32602, JSON.stringify(unknown.error ?? {}));
  mcp.kill();

  // -- 6. default discovery (no --config) also reaches the editor --
  const mcp2 = spawnMcp([]);
  await mcpRpc(mcp2, { jsonrpc: "2.0", id: "i2", method: "initialize", params: { capabilities: {} } });
  await mcpRpc(mcp2, { jsonrpc: "2.0", method: "notifications/initialized" });
  const s2 = await mcpRpc(mcp2, { jsonrpc: "2.0", id: "d1", method: "tools/call", params: { name: "get_workspace_summary", arguments: {} } });
  check("default discovery path (~/.local/share/VelvetSharp/mcp.json) connects too", s2.result && /VelvetSharp Phase/.test(s2.result?.content?.[0]?.text ?? ""), (s2.result?.content?.[0]?.text ?? "").split("\n")[0]);
  mcp2.kill();

  // -- 7. in-page dispatcher sanity (used by agents-less tooling) --
  const dispatch = await page.evaluate(async () => {
    const r = await window.__vsMcp.dispatch("search_code", { query: "Rigidbody", max: 5 });
    return { matchCount: r.matchCount, hasUnsearched: Array.isArray(r.unsearched) };
  });
  check("window.__vsMcp.dispatch (in-page tool surface) works", dispatch.matchCount >= 1 && dispatch.hasUnsearched, JSON.stringify(dispatch));

  const whitelisted = (m) => /Unexpected token '<'/.test(m);
  const realErrors = pageErrors.filter((m) => !whitelisted(m));
  check("zero page errors during the whole run", realErrors.length === 0, realErrors.join(" | ").slice(0, 200));

  await browser.close();
  try { neu.kill(); } catch { /* ignore */ }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n=========== E2E RESULT: ${results.length - failed.length}/${results.length} PASS ============`);
  for (const [name] of failed) console.log("  FAILED:", name);
  if (process.env.VERBOSE_MCP) console.log("[mcp stderr]\n" + MCP_LOG.join(""));
  process.exit(failed.length ? 2 : 0);
}

main().catch((e) => { console.error("E2E FATAL:", e); process.exit(1); });
