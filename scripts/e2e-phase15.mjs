/**
 * Phase 15 E2E — full C# + Unity preprocessor: directive + symbol completion.
 *
 * Serves app/dist, drives real Chromium (playwright):
 *   1. boot + Phase 15 version chip
 *   2. typing `#` pops the directive widget (13 directives + self-closing snippets)
 *   3. `#if ` pops the SYMBOL world with source labels; UNITY_ED → "Unity built-in",
 *      UNITY_2 → the version chain (csproj carries it in the demo — both labels honest);
 *      Enter accepts the pick
 *   4. a user-defined `#define E2E_CUSTOM` shows up in `#define ` completions
 *      labelled "defined in code" (catalog TTL refresh honored)
 *   5. mouse hover over the define symbol explains its source + define site
 *      (mid-identifier hover included — getWordUntilPosition stops at the underscore)
 *   6. `#define` after code raises CS1032 in the problems store (header define stays clean)
 *   7. zero page errors (the static server 404s missing files — modules never get HTML)
 *
 * Run: NODE_PATH=/home/z/.npm-global/lib/node_modules node scripts/e2e-phase15.mjs
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
const PORT = 3155;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png",
  ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.join(DIST, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ""));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // missing files must 404 — serving index.html for a missing .js makes the
      // browser parse HTML as a module ("Unexpected token '<'") and masks real errors
      if (path.extname(urlPath) && urlPath !== "/index.html") {
        res.writeHead(404); return res.end("not found");
      }
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
  console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}${ok || !extra ? "" : " · " + String(extra).slice(0, 220)}`);
};

let page;
/** replace the whole model content (clean slate for every probe) */
const setContent = (text) => page.evaluate((t) => {
  const ed = window.__editor;
  const model = ed.getModel();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: t }], () => null);
  ed.setPosition({ lineNumber: 1, column: 1 });
  ed.focus();
}, text);

const widget = () => page.evaluate(() => {
  const w = document.querySelector(".suggest-widget");
  if (!w || !w.classList.contains("visible")) return { visible: false, rows: -1, text: "" };
  return { visible: true, rows: w.querySelectorAll(".monaco-list-row").length, text: w.textContent ?? "" };
});

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  console.log("== serving dist on", PORT, "==");

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e)));
  await page.addInitScript(() => { try { localStorage.setItem("velvetsharp.theme", "tokyo-night"); } catch { /* ignore */ } });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__editor && window.__client && document.querySelector(".file"), null, { timeout: 30000 });
  await page.waitForTimeout(2500); // brain boot (BOTH lanes) + workspace index

  // 1. version chip
  const chip = await page.evaluate(() => document.querySelector(".version-chip")?.textContent ?? "");
  check("boot + version chip shows Phase 15", /Phase 15/.test(String(chip)), String(chip));

  // ---- 2. typing `#` pops the DIRECTIVE widget ----
  await setContent("");
  await page.keyboard.type("#");
  await page.waitForTimeout(700);
  let ws = await widget();
  check("typing `#` pops the directive widget (snippets + directives visible)",
    ws.visible && ws.rows >= 8 && ws.text.includes("#if UNITY_EDITOR") && ws.text.includes("#pragma warning disable"),
    `rows=${ws.rows} :: ${ws.text.slice(0, 150)}`);
  await page.screenshot({ path: "/tmp/e2e-phase15-directives.png" });
  await page.keyboard.press("Escape");

  // ---- 3. `#if ` pops the SYMBOL world with source labels ----
  await setContent("#if ");
  await page.evaluate(() => { window.__editor.setPosition({ lineNumber: 1, column: 5 }); window.__editor.trigger("e2e", "editor.action.triggerSuggest"); });
  await page.waitForTimeout(700);
  ws = await widget();
  check("`#if ` pops the symbol world (source labels visible)",
    ws.visible && ws.rows >= 10 && /DefineConstants|Unity built-in/.test(ws.text), `rows=${ws.rows} :: ${ws.text.slice(0, 150)}`);

  await page.keyboard.type("UNITY_ED");
  await page.waitForTimeout(600);
  ws = await widget();
  check("UNITY_ED → UNITY_EDITOR family, source label 'Unity built-in' visible",
    ws.visible && /UNITY_EDITOR/.test(ws.text) && /Unity built-in/.test(ws.text) && !/UNITY_IOS/.test(ws.text),
    ws.text.slice(0, 150));
  await page.screenshot({ path: path.join(ROOT, "docs", "screenshots", "preproc-completion.png") });

  await setContent("#if UNITY_2");
  await page.evaluate(() => { window.__editor.setPosition({ lineNumber: 1, column: 12 }); window.__editor.trigger("e2e", "editor.action.triggerSuggest"); });
  await page.waitForTimeout(700);
  ws = await widget();
  check("UNITY_2 → version chain completes (csproj/version source label)",
    ws.visible && /UNITY_\d+_\d+_OR_NEWER/.test(ws.text) && /version symbol|DefineConstants/.test(ws.text), ws.text.slice(0, 160));
  await page.keyboard.press("Escape");

  // accepted completion inserts the symbol
  await setContent("#if UNITY_ED");
  await page.evaluate(() => { window.__editor.setPosition({ lineNumber: 1, column: 13 }); window.__editor.trigger("e2e", "editor.action.triggerSuggest"); });
  await page.waitForTimeout(800);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const line1 = await page.evaluate(() => window.__editor.getModel().getLineContent(1));
  check("Enter accepts → line becomes `#if UNITY_EDITOR`", /^\s*#if UNITY_EDITOR/.test(line1), line1.slice(0, 60));

  // ---- 4. user-defined #define completes with its define site ----
  await setContent("#define E2E_CUSTOM\npublic class P15Probe { }\n#define ");
  const last = await page.evaluate(() => window.__editor.getModel().getLineCount());
  await page.evaluate((ln) => window.__editor.setPosition({ lineNumber: ln, column: 9 }), last);
  await page.waitForTimeout(2900); // catalog TTL (2.5s) must expire to re-read the engine
  await page.evaluate(() => window.__editor.trigger("e2e", "editor.action.triggerSuggest"));
  await page.waitForTimeout(900);
  ws = await widget();
  const customRow = (ws.text.match(/E2E_CUSTOMdefined in code/) ?? [])[0];
  check("user-defined #define completes labelled 'defined in code'",
    ws.visible && !!customRow, (ws.text.match(/E2E_CUSTOM[^\n]{0,60}/) ?? ["row missing"])[0]);
  await page.screenshot({ path: "/tmp/e2e-phase15-custom-define.png" });

  // ---- 5. mouse hover explains the define symbol ----
  await page.keyboard.press("Escape");
  await setContent("#define E2E_CUSTOM\npublic class P15Probe { }\n");
  await page.waitForTimeout(400);
  // DOM-anchored coords: the view-line element's box is the ground truth
  const vline = await page.evaluate(() => {
    const el = document.querySelectorAll(".view-lines .view-line")[0];
    const r = el.getBoundingClientRect();
    return { x: r.left + 90, y: r.top + Math.round(r.height / 2) };
  });
  await page.mouse.move(vline.x, vline.y);
  await page.waitForTimeout(300);
  await page.mouse.move(vline.x + 4, vline.y + 2); // nudge arms the hover machinery
  await page.waitForTimeout(2000);
  const hoverText = await page.evaluate(() => (document.querySelector(".monaco-hover") ?? document.querySelector(".monaco-editor-hover"))?.textContent ?? "");
  check("hover on the define symbol shows its source + line",
    /E2E_CUSTOM/.test(hoverText) && /defined in code|line 1/i.test(hoverText), hoverText.slice(0, 200));
  await page.screenshot({ path: "/tmp/e2e-phase15-hover.png" });

  // ---- 6. CS1032: #define after code surfaces in problems ----
  await setContent("// header comment\n#define EARLY_OK\npublic class P15Probe { }\n#define LATE_BIRD\n");
  await page.waitForTimeout(1800); // edit debounce + analysis + problems recompute
  const probs = await page.evaluate(() => (window.__vsStore?.getState?.().problems ?? []).map((p) => String(p.message ?? "")));
  check("CS1032: late #define errors, header define stays clean",
    probs.some((m) => /LATE_BIRD/.test(m) && /first token/.test(m)) && !probs.some((m) => /EARLY_OK/.test(m)),
    JSON.stringify(probs.slice(0, 4)).slice(0, 200));

  // ---- 7. page stayed healthy ----
  check("zero page errors during the whole drill", pageErrors.length === 0, pageErrors.join(" || ").slice(0, 200));

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n=========== Phase 15 E2E RESULT: ${results.length - failed.length}/${results.length} PASS ===========`);
  for (const [name] of failed) console.log("  FAILED:", name);
  await browser.close();
  server.close();
  if (failed.length) process.exitCode = 2;
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
