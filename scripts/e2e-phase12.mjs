/**
 * Phase 12 visual E2E — serves app/dist, drives real Chromium (playwright):
 *   1. boot + Phase 12 version chip + TWO brain lanes (fast/heavy)
 *   2. instant bare completions (floor pops immediately, no worker round-trip)
 *   3. member-access completions ("this.") via the fast lane
 *   4. fast-lane CRASH → auto respawn + resync → completions work again
 *   5. word-based suggestions OFF ("zzqqx" → clean "No suggestions", no "abc" noise)
 * Run: NODE_PATH=/home/z/.npm-global/lib/node_modules node scripts/e2e-phase12.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "app", "dist");
const PORT = 3122;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".ttf": "font/ttf", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain" };

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.join(DIST, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ""));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(DIST, "index.html"), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
    res.end(data);
  });
});

const results = [];
const check = (name, ok, extra = "") => {
  results.push([name, !!ok]);
  console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}${ok || !extra ? "" : " · " + extra}`);
};

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  console.log("== serving dist on", PORT, "==");

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/home/z/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ").slice(0, 240)));
  await page.addInitScript(() => { try { localStorage.setItem("velvetsharp.theme", "tokyo-night"); } catch { /* ignore */ } });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__editor && window.__client && document.querySelector(".file"), null, { timeout: 30000 });
  await page.waitForTimeout(2500); // brain boot (BOTH lanes) + workspace index

  // 1. two-lane boot + version chip
  const lanes = await page.evaluate(() => window.__client?.lanes ?? []);
  check("boot + TWO brain lanes (fast + heavy)", Array.isArray(lanes) && lanes.includes("fast") && lanes.includes("heavy"), String(lanes));
  const chip = await page.evaluate(() => document.querySelector(".version-chip")?.textContent ?? "");
  check("version chip shows Phase 12", String(chip).includes("Phase 12"), String(chip));

  // 2. the boot already opened PlayerController.cs (loadWorkspace opens the
  //    first script) — assert it instead of clicking (a wrong click would
  //    land on files[0] = BrokenScript.cs, the intentionally-broken demo)
  const openPath = await page.evaluate(() => decodeURIComponent(window.__editor.getModel().uri.path));
  check("editor is on the demo script (PlayerController.cs)", openPath.includes("PlayerController"), openPath);

  // helper: run a completion trigger inside the page and describe the widget
  const triggerSuggest = () => page.evaluate(() => {
    const ed = window.__editor;
    ed.focus();
    ed.trigger("e2e", "editor.action.triggerSuggest");
  });
  const widgetState = () => page.evaluate(() => {
    const w = document.querySelector(".suggest-widget");
    if (!w || !w.classList.contains("visible")) return { visible: false, rows: -1, text: "" };
    return { visible: true, rows: w.querySelectorAll(".monaco-list-row").length, text: (w.textContent ?? "").slice(0, 120) };
  });
  const statusText = () => page.evaluate(() => [...document.querySelectorAll(".statusbar span")].map((e) => e.textContent ?? "").join(" | "));

  // 3. bare prefix → instant floor with real rows (same-file members complete;
  //    "playerR" matches the playerRigidbody FIELD so the synchronous floor
  //    answers regardless of worker state — that is the whole point)
  await page.evaluate(() => {
    const ed = window.__editor;
    const model = ed.getModel();
    const find = model.findMatches("private void Update", false, false, false, null, false, 1)[0] ?? model.findMatches("void Start", false, false, false, null, false, 1)[0];
    const line = (find ?? { range: { startLineNumber: model.getLineCount() - 1 } }).range.startLineNumber;
    // caret on an empty-ish line inside the body, after a typed prefix
    ed.executeEdits("e2e", [{ range: { startLineNumber: line + 1, startColumn: 1, endLineNumber: line + 1, endColumn: 1 }, text: "    playerR" }]);
    ed.setPosition({ lineNumber: line + 1, column: 12 });
    ed.focus();
  });
  await triggerSuggest();
  await page.waitForTimeout(400);
  let ws = await widgetState();
  check("bare prefix pops suggestions instantly (floor path)", ws.visible && ws.rows > 0, `rows=${ws.rows}`);
  await page.screenshot({ path: "/tmp/e2e-phase12-floor.png" });
  await page.keyboard.press("Escape");

  // 4. member access via the fast lane (brain needs the file tree — open-tab
  //    updateFile provided it; wait out the 70ms edit debounce first). The
  //    probe goes INSIDE Awake's body — `this.` after the class's closing
  //    brace legitimately answers empty.
  await page.evaluate(() => {
    const ed = window.__editor;
    const model = ed.getModel();
    const anchor = model.findMatches("spawnPoint = transform.position", false, false, false, null, false, 1)[0]
      ?? model.findMatches("private void Awake", false, false, false, null, false, 1)[0];
    const line = anchor.range.startLineNumber + 1;
    ed.executeEdits("e2e", [{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, text: "        this." + model.getEOL() }]);
    ed.setPosition({ lineNumber: line, column: 14 }); // right after "this."
    ed.focus();
  });
  await page.waitForTimeout(200);
  await triggerSuggest();
  await page.waitForTimeout(700);
  ws = await widgetState();
  check("member access ('this.') answers via the fast lane", ws.visible && ws.rows > 0, `rows=${ws.rows} :: ${ws.text}`);
  await page.screenshot({ path: "/tmp/e2e-phase12-member.png" });
  await page.keyboard.press("Escape");
  // clean the probe line
  await page.evaluate(() => {
    const ed = window.__editor;
    const model = ed.getModel();
    const last = model.getLineCount();
    const full = model.findMatches("this\\.", false, true, false, null, false, 1)[0];
    if (full) ed.executeEdits("e2e", [{ range: { startLineNumber: full.range.startLineNumber, startColumn: 1, endLineNumber: Math.min(full.range.startLineNumber + 1, last), endColumn: 1 }, text: "" }]);
  });

  // 5. fast-lane CRASH → auto respawn + resync → completions still work
  const statusBefore = await statusText();
  await page.evaluate(() => window.__client.simulateCrash("fast"));
  await page.waitForTimeout(300);
  const crashStatus = await statusText();
  check("fast-lane crash surfaces in the status bar (no silent death)",
    /restarting|restarted|resyncing/i.test(crashStatus) && crashStatus !== statusBefore, crashStatus.slice(0, 120));
  let backOnline = false;
  for (let i = 0; i < 40; i++) { // up to 20 s
    await page.waitForTimeout(500);
    const s = await statusText();
    if (/fast lane is back online|fast lane resynced/i.test(s)) { backOnline = true; break; }
  }
  check("fast lane respawns and resyncs automatically", backOnline, (await statusText()).slice(0, 120));
  await page.evaluate(() => {
    const ed = window.__editor;
    const model = ed.getModel();
    const find = model.findMatches("private void Awake", false, false, false, null, false, 1)[0] ?? model.findMatches("private void Update", false, false, false, null, false, 1)[0];
    const line = (find ?? { range: { startLineNumber: model.getLineCount() - 2 } }).range.startLineNumber;
    ed.executeEdits("e2e", [{ range: { startLineNumber: line + 1, startColumn: 1, endLineNumber: line + 1, endColumn: 1 }, text: "    playerR" }]);
    ed.setPosition({ lineNumber: line + 1, column: 12 });
    ed.focus();
  });
  await triggerSuggest();
  await page.waitForTimeout(700);
  ws = await widgetState();
  check("completions work again after the crash (no reload needed)", ws.visible && ws.rows > 0, `rows=${ws.rows}`);
  await page.keyboard.press("Escape");

  // 6. word-based suggestions are OFF: the option must be set AND a nonsense
  //    prefix must not surface document-word noise (word suggestions show
  //    bare words with NO detail; engine items always carry a detail)
  const wbs = await page.evaluate(() => window.__editor.getRawOptions().wordBasedSuggestions);
  check("wordBasedSuggestions option is OFF", wbs === "off", String(wbs));
  await page.evaluate(() => {
    const ed = window.__editor;
    const model = ed.getModel();
    const find = model.findMatches("private void Awake", false, false, false, null, false, 1)[0] ?? model.findMatches("private void Update", false, false, false, null, false, 1)[0];
    const line = (find ?? { range: { startLineNumber: model.getLineCount() - 2 } }).range.startLineNumber;
    ed.executeEdits("e2e", [{ range: { startLineNumber: line + 3, startColumn: 1, endLineNumber: line + 3, endColumn: 1 }, text: "    zzqqx" }]);
    ed.setPosition({ lineNumber: line + 3, column: 10 });
    ed.focus();
  });
  await triggerSuggest();
  await page.waitForTimeout(700);
  ws = await widgetState();
  const rows = await page.evaluate(() => [...document.querySelectorAll(".suggest-widget .monaco-list-row")].map((r) => ({ label: r.textContent ?? "", detail: (r.querySelector(".label-detail")?.textContent ?? "").trim() })));
  const wordNoise = rows.filter((r) => !r.detail && /zzqqx|spawnPoint|isGrounded/i.test(r.label));
  check("nonsense prefix → NO word-noise fallback (clean empty state)",
    !ws.visible || rows.length === 0 || wordNoise.length === 0, `rows=${rows.length} :: ${JSON.stringify(rows).slice(0, 100)}`);
  await page.screenshot({ path: "/tmp/e2e-phase12-nowords.png" });

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n=========== Phase 12 E2E RESULT: ${results.length - failed.length}/${results.length} PASS ===========`);
  for (const [name] of failed) console.log("  FAILED:", name);
  await browser.close();
  server.close();
  if (failed.length) process.exitCode = 2;
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
