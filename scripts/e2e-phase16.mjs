/**
 * Phase 16 E2E — Agent Bridge: top-bar LLM buttons + the two hand-off windows.
 *
 * Serves app/dist, drives real Chromium (playwright):
 *   1. boot + Phase 16 version chip; AI buttons live in the TOP titlebar;
 *      the theme chip moved up (bottom bar no longer has ◐ theme)
 *   2. `⧉ Structure → AI` opens the bridge: folder tree renders, preview
 *      shows the selected-files export, "scripts (.cs) only" preset shrinks it
 *   3. "include file contents" switches the export to fenced code blocks
 *   4. Copy to clipboard + Copy agent instructions (real clipboard, granted)
 *   5. Apply tab: insert example → validate → plan shows 2 ok; a poisoned
 *      payload (../ traversal) is rejected with a visible error row
 *   6. Apply now → report "2 applied, 0 failed" + copyable report
 *   7. MCP: window.__vsMcp.dispatch("apply_payload", …) applies a modify and
 *      refuses a traversal payload (same engine behind both doors)
 *   8. Esc closes; zero page errors all along
 *
 * Run: NODE_PATH=/home/z/.npm-global/lib/node_modules node scripts/e2e-phase16.mjs
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
const PORT = 3156;

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
  await page.addInitScript(() => { try { localStorage.setItem("velvetsharp.theme", "tokyo-night"); } catch { /* ignore */ } });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__editor && window.__client && document.querySelector(".file"), null, { timeout: 30000 });
  await page.waitForTimeout(2500); // brain boot (BOTH lanes) + workspace index

  // ---- 1. boot + chrome layout ----
  const chip = await page.evaluate(() => document.querySelector(".version-chip")?.textContent ?? "");
  check("boot + version chip shows Phase 16", /Phase 16/.test(String(chip)), String(chip));

  const chrome = await page.evaluate(() => {
    const bar = document.querySelector(".titlebar");
    const btns = [...bar.querySelectorAll(".settings-btn")].map((b) => b.textContent);
    return { btns, statusbar: document.querySelector(".statusbar").textContent };
  });
  check("titlebar hosts BOTH AI buttons (up top, not the bottom bar)",
    chrome.btns.some((t) => /Structure → AI/.test(t)) && chrome.btns.some((t) => /Apply JSON ← AI/.test(t)),
    chrome.btns.join(" | "));
  check("theme chip moved up: ◐ in the titlebar, gone from the status bar",
    chrome.btns.includes("◐") && !/◐ theme/.test(chrome.statusbar));

  // ---- 2. Structure → AI window ----
  await page.click(".titlebar .settings-btn.ai-btn"); // first AI button = structure
  await page.waitForSelector(".agent-modal", { timeout: 5000 });
  const struct1 = await page.evaluate(() => {
    const rows = document.querySelectorAll(".ab-tree-row").length;
    const out = document.querySelector(".ab-output").value;
    return { rows, head: out.split("\n")[0], hasPlayer: out.includes("PlayerController.cs"), selected: document.querySelector(".ab-export-head span").textContent };
  });
  check("structure window: tree renders the demo workspace", struct1.rows > 5, `rows=${struct1.rows}`);
  check("structure export lists scripts + counts (default = everything non-meta)",
    /\d+ files? selected/.test(struct1.selected) && struct1.hasPlayer, struct1.selected);

  // presets shrink the selection
  const presetBtns = await page.$$(".ab-toolbar .btn");
  await presetBtns[2].click(); // "scripts (.cs) only"
  await page.waitForTimeout(250);
  const struct2 = await page.evaluate(() => ({
    head: document.querySelector(".ab-export-head span").textContent,
    out: document.querySelector(".ab-output").value,
  }));
  check("preset 'scripts (.cs) only' narrows the export", /\.cs/.test(struct2.out) && !/manifest|\.png/.test(struct2.out), struct2.head + " :: " + struct2.out.slice(0, 90));

  // include file contents → fenced blocks
  await page.click(".ab-toolbar .ab-opt input"); // first checkbox = include contents
  await page.waitForTimeout(700);
  const struct3 = await page.evaluate(() => document.querySelector(".ab-output").value);
  check("include-contents mode emits ```csharp fenced code blocks",
    struct3.includes("```csharp") && struct3.includes("public class"), struct3.slice(0, 120));

  // ---- 3. clipboard round-trips ----
  await page.click(".ab-actions .btn-primary"); // Copy to clipboard
  await page.waitForTimeout(400);
  const clip1 = await page.evaluate(() => navigator.clipboard.readText());
  check("copy-to-clipboard carries the export", clip1.includes("```csharp") && clip1.includes("PlayerController.cs"), clip1.slice(0, 90));
  await page.evaluate(() => [...document.querySelectorAll(".ab-actions .btn")].find((b) => /instructions/.test(b.textContent)).click());
  await page.waitForTimeout(400);
  const clip2 = await page.evaluate(() => navigator.clipboard.readText());
  check("copy-agent-instructions carries the JSON contract",
    clip2.includes('"velvetsharp": 1') && clip2.includes('"op": "modify"') && clip2.includes("EXACT"), clip2.slice(0, 90));
  await page.screenshot({ path: "/tmp/e2e-phase16-structure.png" });

  // ---- 4. Apply JSON ← AI window ----
  await page.click(".ab-tabs .ab-tab:nth-child(2)");
  await page.waitForTimeout(200);
  await page.evaluate(() => [...document.querySelectorAll(".ab-actions .btn")].find((b) => /insert example/.test(b.textContent)).click());
  await page.waitForTimeout(200);
  await page.evaluate(() => [...document.querySelectorAll(".ab-actions .btn")].find((b) => /^validate$/.test(b.textContent)).click());
  await page.waitForTimeout(900);
  const plan1 = await page.evaluate(() => ({
    title: document.querySelector(".ab-plan-title")?.textContent ?? "",
    rows: [...document.querySelectorAll(".ab-plan-row")].map((r) => r.className + "::" + r.textContent.slice(0, 80)),
    warns: [...document.querySelectorAll(".ab-warn-row")].map((w) => w.textContent),
  }));
  check("validate dry-runs the example: 2 ok, 0 blocked, zero warnings (both ops fully specified)",
    plan1.title.includes("2 ok, 0 blocked") && plan1.rows.length === 2 && plan1.rows.every((r) => r.includes("ok")) && plan1.warns.length === 0,
    plan1.title + " | " + plan1.rows.join(" || ") + " | " + plan1.warns.join(" | "));
  check("validate surfaces the blocked ops' exact reasons (plan + apply share the planner)",
    plan1.rows.every((r) => /replaces 1 occurrence|new file/.test(r)), plan1.rows.join(" || "));

  // poisoned payload: traversal + garbage op
  await page.evaluate(() => {
    const ta = document.querySelector(".ab-input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, JSON.stringify({ velvetsharp: 1, operations: [
      { op: "create", path: "../evil.cs", content: "x" },
      { op: "zork", path: "Assets/A.cs" },
    ]}));
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => [...document.querySelectorAll(".ab-actions .btn")].find((b) => /^validate$/.test(b.textContent)).click());
  await page.waitForTimeout(400);
  const errs = await page.evaluate(() => [...document.querySelectorAll(".ab-err-row")].map((e) => e.textContent));
  check("traversal + unknown op rejected with visible per-op errors",
    errs.length === 2 && /workspace-relative/.test(errs[0]) && /unknown op/.test(errs[1]), errs.join(" | "));

  // apply the example for real (demo adapter: writes are session-only)
  await page.evaluate(() => [...document.querySelectorAll(".ab-actions .btn")].find((b) => /insert example/.test(b.textContent)).click());
  await page.evaluate(() => [...document.querySelectorAll(".ab-actions .btn")].find((b) => /Apply now/.test(b.textContent)).click());
  await page.waitForTimeout(1500);
  const apply1 = await page.evaluate(() => ({
    report: document.querySelector(".ab-report-text")?.textContent ?? "",
    title: document.querySelector(".ab-plan-title")?.textContent ?? "",
  }));
  check("apply now executes: report says 2 applied, 0 failed",
    /2 applied, 0 failed/.test(apply1.report) && apply1.title.includes("2 ok, 0 blocked"), apply1.report.slice(0, 160));
  await page.screenshot({ path: "/tmp/e2e-phase16-apply.png" });

  // copy report
  await page.evaluate(() => [...document.querySelectorAll(".ab-report .btn")].find((b) => /Copy report/.test(b.textContent)).click());
  await page.waitForTimeout(400);
  const clip3 = await page.evaluate(() => navigator.clipboard.readText());
  check("copy report round-trips the apply report", clip3.includes("VelvetSharp apply report — 2 applied, 0 failed"), clip3.slice(0, 90));

  // Esc closes
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check("Esc closes the bridge", await page.$(".agent-modal") === null);

  // ---- 5. MCP door: apply_payload through window.__vsMcp.dispatch ----
  const mcpOk = await page.evaluate(async () => {
    const r = await window.__vsMcp.dispatch("apply_payload", { payload: {
      velvetsharp: 1, agent: "Cursor", message: "mcp probe",
      operations: [{ op: "modify", path: "Assets/Scripts/Player/PlayerHealth.cs", find: "public class PlayerHealth", replace: "public class PlayerHealth", all: false }],
    }});
    return r;
  });
  check("MCP apply_payload modifies through the same engine",
    mcpOk?.applied === 1 && mcpOk?.failed === 0 && /VelvetSharp apply report/.test(mcpOk.text), JSON.stringify(mcpOk).slice(0, 160));

  const mcpBad = await page.evaluate(async () => {
    try {
      await window.__vsMcp.dispatch("apply_payload", { payload: { velvetsharp: 1, operations: [{ op: "delete", path: "../../etc/passwd" }] } });
      return { threw: false, error: "" };
    } catch (e) { return { threw: true, error: String(e?.message ?? e) }; }
  });
  check("MCP apply_payload refuses traversal with a tool error",
    mcpBad.threw && /workspace-relative/.test(mcpBad.error), mcpBad.error.slice(0, 120));

  const mcpTools = await page.evaluate(() => window.__vsMcp.status().tools);
  check("MCP tool list now includes apply_payload (6 tools)",
    mcpTools.includes("apply_payload") && mcpTools.length === 6, mcpTools.join(", "));

  // ---- 6. page stayed healthy ----
  check("zero page errors during the whole drill", pageErrors.length === 0, pageErrors.join(" || ").slice(0, 200));

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n=========== Phase 16 E2E RESULT: ${results.length - failed.length}/${results.length} PASS ===========`);
  for (const [name] of failed) console.log("  FAILED:", name);
  await browser.close();
  server.close();
  if (failed.length) process.exitCode = 2;
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
