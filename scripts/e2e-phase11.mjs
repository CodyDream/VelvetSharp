/**
 * Phase 11 visual E2E — serves app/dist, drives real Chromium (playwright):
 *   1. boot + Phase 11 version chip
 *   2. editor right-click → Collapse ▸ submenu (methods/regions/#if/docs/all)
 *   3. Collapse by Methods actually folds (hidden areas > 0)
 *   4. /// + Enter inserts the XML documentation skeleton
 *   5. false #if branch → .vs-inactive-line dimming
 *   6. stray #endif → structural error in the Problems bar
 * Run: NODE_PATH=/home/z/.npm-global/lib/node_modules node scripts/e2e-phase11.mjs
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
const PORT = 3111;

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
  // skip the first-run theme picker (fresh profile would pop it)
  await page.addInitScript(() => { try { localStorage.setItem("velvetsharp.theme", "tokyo-night"); } catch { /* ignore */ } });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__editor && document.querySelector(".file"), null, { timeout: 30000 });
  await page.waitForTimeout(2500); // brain boot + workspace index

  // 1. version chip
  const chip = await page.evaluate(() => document.querySelector(".version-chip")?.textContent ?? "");
  check("boot + version chip shows Phase 11", String(chip).includes("Phase 11"), String(chip));

  // 2. open the editor with a demo script
  await page.evaluate(() => {
    const files = [...document.querySelectorAll(".file")];
    const target = files.find((f) => f.textContent?.includes("PlayerController.cs")) ?? files[0];
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(1200);

  // 3. editor right-click → our menu with Collapse ▸
  //    (the capture listener lives on Monaco's own dom node — .monaco-editor —
  //     so the synthetic event must be dispatched there)
  await page.evaluate(() => {
    const host = document.querySelector(".monaco-host .monaco-editor") ?? document.querySelector(".monaco-host");
    const rect = host.getBoundingClientRect();
    host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 300, clientY: rect.top + 120 }));
  });
  await page.waitForTimeout(250);
  const menuItems = await page.evaluate(() => [...document.querySelectorAll(".ctx-menu .ctx-item")].map((e) => e.textContent?.trim() ?? ""));
  check("editor right-click opens the VelvetSharp menu", menuItems.some((t) => t.includes("Go to Definition")) && menuItems.some((t) => t.includes("Collapse")), menuItems.join(" | "));

  // 4. open the Collapse submenu (hover)
  await page.hover(".ctx-item.has-sub");
  await page.waitForTimeout(250);
  const subItems = await page.evaluate(() => [...document.querySelectorAll(".ctx-submenu .ctx-item")].map((e) => e.textContent?.trim() ?? ""));
  check("Collapse ▸ submenu lists all six options",
    ["Collapse by Methods", "Collapse by #Regions", "Collapse by #if Blocks", "Collapse XML Doc Comments", "Collapse All", "Expand All"]
      .every((want) => subItems.some((t) => t.includes(want))), subItems.join(" | "));
  await page.screenshot({ path: "/tmp/e2e-phase11-menu.png" });

  // 5. Collapse by Methods → folded regions appear (count via the folding model;
  //    getHiddenAreas() is not exposed by this Monaco version)
  const foldState = () => page.evaluate(async () => {
    const ed = window.__editor;
    const ctrl = ed.getContribution("editor.contrib.folding");
    if (!ctrl) return -1;
    const fm = await ctrl.getFoldingModel();
    if (!fm) return -1;
    let n = 0;
    for (let i = 0; i < fm.regions.length; i++) if (fm.regions.isCollapsed(i)) n++;
    return n;
  });
  try { await page.evaluate(() => { window.__editor.trigger("e2e", "editor.unfoldAll"); }); } catch { /* ignore */ }
  await page.waitForTimeout(200);
  const before = await foldState();
  await page.evaluate(() => {
    const item = [...document.querySelectorAll(".ctx-submenu .ctx-item")].find((e) => e.textContent?.includes("Collapse by Methods"));
    item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const after = await foldState();
  check(`Collapse by Methods folds the script (collapsed regions ${before} → ${after})`, after > 0 && after !== before);
  await page.screenshot({ path: "/tmp/e2e-phase11-collapsed.png" });
  // close the menu for the next checks
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.__editor.trigger("e2e", "editor.unfoldAll"); });

  // 6. /// + Enter → XML documentation skeleton (monaco classes are not
  //    importable from the test scope — everything runs inside evaluate)
  const probe = await page.evaluate(() => {
    const ed = window.__editor;
    const model = ed.getModel();
    const eol = model.getEOL();
    const last = model.getLineCount();
    // insert the probe method at the end
    const insert = eol + "    public void E2EProbe(float dmg)" + eol + "    {" + eol + "    }" + eol;
    ed.executeEdits("e2e", [{
      range: { startLineNumber: last + 1, startColumn: 1, endLineNumber: last + 1, endColumn: 1 },
      text: insert,
    }]);
    // caret on the empty line just above the probe method
    const find = model.findMatches("public void E2EProbe", false, false, false, null, false, 1)[0];
    if (!find) return "no probe method";
    const methodLine = find.range.startLineNumber;
    ed.setPosition({ lineNumber: methodLine - 1, column: 5 });
    ed.focus();
    return "ok";
  });
  check("probe method inserted + caret above it", probe === "ok", String(probe));
  await page.keyboard.type("///");
  await page.waitForTimeout(600);
  const suggestVisible = await page.evaluate(() => {
    const w = document.querySelector(".suggest-widget");
    return w && w.classList.contains("visible") ? (w.textContent ?? "") : "";
  });
  check("/// pops the XML documentation suggestion", suggestVisible.includes("XML documentation"), suggestVisible.slice(0, 80));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const docInserted = await page.evaluate(() => {
    const model = window.__editor.getModel();
    return model.findMatches("/// <summary>", false, false, false, null, false, 1).length > 0
      && model.findMatches('<param name="dmg">', false, false, false, null, false, 1).length > 0;
  });
  check("Enter inserted <summary> + <param name=\"dmg\"> skeleton", docInserted);
  await page.screenshot({ path: "/tmp/e2e-phase11-xmldoc.png" });

  // 7. inactive #if branch → dimming decoration
  await page.evaluate(() => {
    const ed = window.__editor;
    const model = ed.getModel();
    const last = model.getLineCount();
    ed.executeEdits("e2e", [{
      range: { startLineNumber: last + 1, startColumn: 1, endLineNumber: last + 1, endColumn: 1 },
      text: model.getEOL() + "#if SOME_UNKNOWN_FLAG" + model.getEOL() + "int e2eInactive;" + model.getEOL() + "#endif" + model.getEOL(),
    }]);
  });
  await page.waitForTimeout(900); // 70ms debounce + worker + decorations
  const dimmed = await page.evaluate(() => document.querySelectorAll(".vs-inactive-line").length);
  check("false #if branch renders dimmed (.vs-inactive-line)", dimmed >= 1, `count=${dimmed}`);
  await page.screenshot({ path: "/tmp/e2e-phase11-inactive.png" });

  // 8. stray #endif → structural error in Problems bar
  await page.evaluate(() => {
    const ed = window.__editor;
    const model = ed.getModel();
    const last = model.getLineCount();
    ed.executeEdits("e2e", [{
      range: { startLineNumber: last + 1, startColumn: 1, endLineNumber: last + 1, endColumn: 1 },
      text: model.getEOL() + "#endif" + model.getEOL(),
    }]);
    ed.setPosition({ lineNumber: 1, column: 1 }); // leave any snippet mode behind
  });
  await page.waitForTimeout(1500);
  const probText = await page.evaluate(() => {
    const bar = document.querySelector(".problems-bar");
    if (bar && !document.querySelector(".problems-list")) bar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return "";
  }).then(() => page.waitForTimeout(400))
    .then(() => page.evaluate(() => ({
      bar: document.querySelector(".problems-bar")?.textContent ?? "",
      list: [...document.querySelectorAll(".problem-row")].map((e) => e.textContent?.slice(0, 90)),
    })));
  check("stray #endif surfaces the structural error",
    probText.list.some((t) => t && t.includes("Unexpected '#endif'")),
    JSON.stringify({ bar: probText.bar.slice(0, 80), rows: probText.list.length }));

  await browser.close();

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n=========== Phase 11 E2E: ${results.length - failed.length}/${results.length} PASS ===========`);
  for (const [name] of failed) console.log("  FAILED:", name);
  process.exitCode = failed.length ? 2 : 0;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error("FATAL", e); process.exit(1); });
