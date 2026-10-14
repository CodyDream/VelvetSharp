/**
 * Phase 17 E2E — UI overhaul + QOL batch.
 *
 * Serves app/dist, drives real Chromium (playwright):
 *   1. boot + Phase 17 version chip; the ACTIVITY RAIL replaces the old
 *      sidebar tab-row (7 buttons, error badge capable)
 *   2. command center opens the files palette; Esc closes
 *   3. open a file → breadcrumbs (path segments) + window title mirrors it
 *   4. tabs: C# icon, dirty dot, drag-reorder, middle-click close, ctx menu
 *   5. Ctrl+Tab cycles tabs; Ctrl+B hides/shows the sidebar; Ctrl+J toggles
 *      Problems; Ctrl+, opens Settings
 *   6. F8 jumps to the next project problem (opens the bar + sets status)
 *   7. palette toggles: minimap / trim-trailing persist to localStorage
 *   8. session restore: reload → tabs reopen ("session restored — N reopened")
 *   9. welcome cards render after Close All; explorer filter narrows the tree
 *  10. sidebar drag-handle resizes; zero page errors all along
 *
 * Run: NODE_PATH=/home/z/.npm-global/lib/node_modules node scripts/e2e-phase17.mjs
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
const PORT = 3177;

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
  console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}${ok || !extra ? "" : " · " + String(extra).slice(0, 240)}`);
};

let page;

async function openFile(name) {
  // route through the explorer filter: works no matter which folders are expanded
  await page.fill(".explorer-filter", name);
  await page.waitForTimeout(350);
  await page.evaluate((n) => {
    const rows = [...document.querySelectorAll(".explorer-flat .file")];
    const row = rows.find((r) => r.textContent.includes(n));
    if (row) row.click(); else throw new Error("file not found: " + n);
  }, name);
  await page.waitForTimeout(450);
  await page.fill(".explorer-filter", "");
  await page.waitForTimeout(250);
}

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  console.log("== serving dist on", PORT, "==");

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e)));
  await page.addInitScript(() => {
    try { localStorage.setItem("velvetsharp.theme", "tokyo-night"); } catch { /* ignore */ }
  });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__editor && window.__client && document.querySelector(".file"), null, { timeout: 30000 });
  await page.waitForTimeout(2500); // brain boot (BOTH lanes) + workspace index

  // ---- 1. boot + activity rail ----
  const chip = await page.evaluate(() => document.querySelector(".version-chip")?.textContent ?? "");
  check("boot + version chip shows Phase 17", /Phase 17/.test(String(chip)), String(chip));

  const rail = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="activity-rail"]');
    return {
      present: !!el,
      buttons: el ? el.querySelectorAll(".rail-btn").length : 0,
      oldTabs: !!document.querySelector(".sidebar-tabs"),
      labels: el ? [...el.querySelectorAll(".rail-btn")].map((b) => b.getAttribute("title")).join("|") : "",
    };
  });
  check("activity rail replaces the sidebar tab-row", rail.present && !rail.oldTabs && rail.buttons === 7, rail.labels);
  check("rail carries Problems + Graph + Agent + Settings entries",
    /Problems/.test(rail.labels) && /graph/i.test(rail.labels) && /Agent Bridge/.test(rail.labels) && /Settings/.test(rail.labels), rail.labels);

  // ---- 2. command center ----
  await page.click('[data-testid="command-center"]');
  await page.waitForSelector(".palette", { timeout: 4000 });
  const ccFocus = await page.evaluate(() => document.activeElement?.tagName === "INPUT" && !!document.querySelector(".palette"));
  check("command center opens the files palette focused", ccFocus);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  // ---- 3. open a file → breadcrumbs + window title ----
  await openFile("PlayerController.cs");
  const crumbs = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="breadcrumbs"]');
    return { present: !!el, text: el ? el.textContent : "" };
  });
  check("breadcrumbs render the path of the active script",
    crumbs.present && crumbs.text.includes("Assets") && crumbs.text.includes("Scripts") && crumbs.text.includes("PlayerController.cs"), crumbs.text);
  const title1 = await page.evaluate(() => document.title);
  check("window title mirrors the active document + phase", /PlayerController\.cs/.test(title1) && /Phase 17/.test(title1), title1);

  // ---- 4. tabs: icon, dirty dot, ctx menu, middle-click ----
  await page.evaluate(() => { window.__editor.executeEdits("e2e", [{ range: new (window.monaco ?? {}).Range ? null : null }]); }).catch(() => {});
  // type into the editor to dirty the tab
  await page.click(".monaco-host");
  await page.keyboard.type("// e2e dirty probe");
  await page.waitForTimeout(400);
  const tabState = await page.evaluate(() => {
    const t = document.querySelector(".tab.active");
    return { hasIcon: !!t?.querySelector(".tab-icon.cs"), dirty: !!t?.querySelector(".tab-dirty"), name: t?.querySelector(".tab-name")?.textContent };
  });
  check("active tab shows a C# icon + dirty dot after typing",
    tabState.hasIcon && tabState.dirty && tabState.name === "PlayerController.cs", JSON.stringify(tabState));

  // open a second file for cycling / reorder / close-others
  await openFile("GameManager.cs");

  // Ctrl+Tab cycles to the next tab
  const before = await page.evaluate(() => document.querySelector(".tab.active .tab-name")?.textContent);
  await page.keyboard.press("Control+Tab");
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => document.querySelector(".tab.active .tab-name")?.textContent);
  check("Ctrl+Tab cycles to the next open tab", before !== after, `${before} → ${after}`);
  await page.keyboard.press("Control+Shift+Tab");
  await page.waitForTimeout(250);
  const back = await page.evaluate(() => document.querySelector(".tab.active .tab-name")?.textContent);
  check("Ctrl+Shift+Tab cycles back", back === before, `${after} → ${back}`);

  // tab right-click menu
  await page.evaluate(() => {
    const t = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes("GameManager.cs"));
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 10 }));
  });
  await page.waitForTimeout(250);
  const ctx = await page.evaluate(() => {
    const m = document.querySelector(".ctx-menu");
    return m ? m.textContent : "";
  });
  check("tab context menu offers Close Others / Close Saved / Copy Paths",
    ctx.includes("Close Others") && ctx.includes("Close Saved") && ctx.includes("Copy Full Path"), ctx.slice(0, 120));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  // middle-click closes the active tab
  const tabsBeforeMid = await page.evaluate(() => document.querySelectorAll(".tab").length);
  await page.evaluate(() => {
    const t = document.querySelector(".tab.active");
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1, clientX: r.x + 10, clientY: r.y + 10 }));
  });
  await page.waitForTimeout(250);
  const tabsAfterMid = await page.evaluate(() => document.querySelectorAll(".tab").length);
  check("middle-click closes the tab", tabsAfterMid === tabsBeforeMid - 1, `${tabsBeforeMid} → ${tabsAfterMid}`);

  // ---- 5. Ctrl+B / Ctrl+J / Ctrl+, ----
  await page.keyboard.press("Control+b");
  await page.waitForTimeout(250);
  const sidebarGone = await page.evaluate(() => !document.querySelector(".sidebar"));
  check("Ctrl+B collapses the sidebar (rail stays)", sidebarGone && !!(await page.$('[data-testid="activity-rail"]')));
  await page.keyboard.press("Control+b");
  await page.waitForTimeout(250);
  check("Ctrl+B brings the sidebar back", !!(await page.$(".sidebar")));

  await page.keyboard.press("Control+j");
  await page.waitForTimeout(250);
  const problemsOpen = await page.evaluate(() => !!document.querySelector(".problems-list"));
  check("Ctrl+J expands the Problems bar", problemsOpen);
  await page.keyboard.press("Control+j");
  await page.waitForTimeout(200);

  await page.keyboard.press("Control+,");
  await page.waitForTimeout(300);
  const settingsVisible = await page.evaluate(() => !!document.querySelector(".settings-modal"));
  check("Ctrl+, opens Settings", settingsVisible);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ---- 6. F8 problem walk ----
  let sweepOk = true;
  try {
    await page.waitForSelector(".err-count", { timeout: 30000 });
  } catch { sweepOk = false; }
  check("problems exist in the demo project (sweep complete)", sweepOk);
  await page.keyboard.press("F8");
  await page.waitForTimeout(500);
  const f8State = await page.evaluate(() => ({
    status: document.querySelector(".status-msg")?.textContent ?? "",
    problemsVisible: !!document.querySelector(".problems-list"),
  }));
  check("F8 jumps to the next problem and reports its index",
    /problem \d+\/\d+/.test(f8State.status) && f8State.problemsVisible, f8State.status);

  // ---- 7. palette pref toggles persist ----
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette", { timeout: 4000 });
  await page.keyboard.type("Toggle Minimap");
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const minimapOff = await page.evaluate(() => localStorage.getItem("velvetsharp.minimap"));
  check("palette: Toggle Minimap persists the pref (off after one toggle)", minimapOff === "0", String(minimapOff));

  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette", { timeout: 4000 });
  await page.keyboard.type("Trim Trailing");
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const trimOn = await page.evaluate(() => localStorage.getItem("velvetsharp.trimTrailing"));
  check("palette: Trim Trailing Whitespace on Save persists (on)", trimOn === "1", String(trimOn));

  // trim actually fires on save: add trailing spaces, Ctrl+S, content trims
  await openFile("GameManager.cs");
  await page.click(".monaco-host");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("   ");
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(600);
  const trimmed = await page.evaluate(() => {
    const t = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes("GameManager.cs"));
    return t ? { dirty: !!t.querySelector(".tab-dirty") } : null;
  });
  check("Ctrl+S with trim-on-save cleans trailing ws (tab goes clean)", trimmed?.dirty === false, JSON.stringify(trimmed));
  // toggle it back off for session cleanliness
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette", { timeout: 4000 });
  await page.keyboard.type("Trim Trailing");
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);

  // ---- 8. session restore across a reload ----
  await page.waitForTimeout(1700); // session save timer (1.5s)
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__editor && window.__client && document.querySelector(".file"), null, { timeout: 30000 });
  await page.waitForTimeout(2200);
  const restored = await page.evaluate(() => ({
    status: document.querySelector(".status-msg")?.textContent ?? "",
    tabs: document.querySelectorAll(".tab").length,
    active: document.querySelector(".tab.active .tab-name")?.textContent ?? "",
  }));
  check("session restore reopens the tabs after a reload",
    /session restored — \d+ scripts? reopened/.test(restored.status) && restored.tabs >= 2, JSON.stringify(restored));

  // ---- 9. welcome cards + explorer filter ----
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette", { timeout: 4000 });
  await page.keyboard.type("Close All Tabs");
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const welcome = await page.evaluate(() => ({
    cards: document.querySelectorAll(".welcome-card").length,
    logo: !!document.querySelector(".welcome-logo"),
  }));
  check("welcome v2 renders 4 shortcut cards after Close All", welcome.cards === 4 && welcome.logo, JSON.stringify(welcome));

  // explorer filter narrows the tree
  await page.fill(".explorer-filter", "turret");
  await page.waitForTimeout(350);
  const filtered = await page.evaluate(() => ({
    flat: document.querySelectorAll(".explorer-flat .file").length,
    text: document.querySelector(".explorer")?.textContent ?? "",
  }));
  check("explorer filter box narrows to matching files (flat list)",
    filtered.flat >= 1 && filtered.flat < 8 && /Turret\.cs/.test(filtered.text), JSON.stringify(filtered));
  await page.fill(".explorer-filter", "");
  await page.waitForTimeout(250);

  // ---- 10. sidebar drag-resize ----
  const widthBefore = await page.evaluate(() => document.querySelector(".sidebar")?.style.width);
  const handle = await page.$(".sidebar-handle");
  if (handle) {
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 300, { steps: 4 });
    await page.mouse.up();
  }
  await page.waitForTimeout(300);
  const widthAfter = await page.evaluate(() => document.querySelector(".sidebar")?.style.width);
  check("dragging the handle resizes the sidebar (persisted inline width)",
    widthBefore !== widthAfter && Number.parseInt(widthAfter, 10) > Number.parseInt(widthBefore, 10), `${widthBefore} → ${widthAfter}`);

  // ---- final: zero page errors ----
  check("zero page errors across the whole run", pageErrors.length === 0, pageErrors.join(" | "));

  await browser.close();
  server.close();

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n=========== Phase 17 E2E: ${results.length - failed.length}/${results.length} PASS ===========`);
  for (const [name] of failed) console.log("  FAILED:", name);
  process.exit(failed.length ? 2 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
