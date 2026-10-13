/**
 * Phase 13 visual E2E — serves app/dist, drives real Chromium (playwright):
 *   1. boot + Phase 13 version chip + two brain lanes
 *   2. Call Flow on the demo script renders method nodes ONLY (no extcall capsules)
 *   3. hidden engine/API chip counts the calls that are no longer drawn
 *   4. per-caller call-order badges (1·2·3) render, first badge is "1", one badge per edge
 *   5. dynamic node widths — boxes are NOT all the same fixed width
 *   6. cross-file custom methods resolve to dashed terminals carrying their file (injected fixture)
 *   7. details panel lists calls in execution order
 *   8. failure banner shows WHY + ⧉ copy error puts version/script/message on the clipboard
 *   9. zero page errors during the whole run
 * Run: NODE_PATH=/home/z/.npm-global/lib/node_modules node scripts/e2e-phase13.mjs
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
const PORT = 3123;

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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => {
    const detail = `msg=${JSON.stringify(e?.message ?? "")} stack=${String(e?.stack ?? "").split("\n").slice(0, 3).join(" | ").slice(0, 240)}`;
    pageErrors.push(detail);
    console.log("  [pageerror]", detail);
  });
  await page.addInitScript(() => { try { localStorage.setItem("velvetsharp.theme", "tokyo-night"); } catch { /* ignore */ } });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__editor && window.__client && window.__vsStore, null, { timeout: 30000 });
  await page.waitForTimeout(2500); // brain boot (BOTH lanes) + workspace index

  // 1. boot + version chip + lanes
  const chip = await page.evaluate(() => document.querySelector(".version-chip")?.textContent ?? "");
  check("boot + version chip shows Phase 13", String(chip).includes("Phase 13"), String(chip));
  const lanes = await page.evaluate(() => window.__client?.lanes ?? []);
  check("two brain lanes still alive (fast + heavy)", Array.isArray(lanes) && lanes.includes("fast") && lanes.includes("heavy"), String(lanes));

  // 2. open Call Flow on the demo script the boot opened (PlayerController.cs)
  await page.evaluate(() => {
    const s = window.__vsStore;
    s.getState().openGraph(null);
    s.getState().setGraphMode("flow");
  });
  await page.waitForSelector(".dg-svg", { timeout: 15000 });
  await page.waitForTimeout(600);
  const extcalls = await page.evaluate(() => document.querySelectorAll(".dg-node.extcall").length);
  check("flow renders ZERO external capsules (engine/API calls not drawn)", extcalls === 0, `extcall=${extcalls}`);
  const methods = await page.evaluate(() => document.querySelectorAll(".dg-node.method").length);
  check("flow renders method nodes", methods > 0, `methods=${methods}`);

  // 3. hidden engine/API chip
  const hidden = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".dg-warn")].find((n) => /engine\/API hidden/.test(n.textContent ?? ""));
    return el ? parseInt(el.textContent?.match(/(\d+)/)?.[1] ?? "0", 10) : -1;
  });
  check("hidden engine/API chip counts the dropped calls", hidden > 0, `hidden=${hidden}`);

  // 4. inject a fixture with REAL calls (PlayerController has none in-file) and
  //    switch the flow view onto it — badges, widths, cross terminals all read here
  await page.evaluate(() => {
    const c = window.__client;
    return (async () => {
      await c.updateFile("__e2e__/E2eManager.cs", [
        "using UnityEngine;",
        "public class E2eManager",
        "{",
        "    public void Spawn(string kind) { Debug.Log(kind); }",
        "    public static void Announce(string msg) { Debug.Log(msg); }",
        "}",
      ].join("\n"), true);
      await c.updateFile("__e2e__/E2eCaller.cs", [
        "using UnityEngine;",
        "public class E2eCaller : MonoBehaviour",
        "{",
        "    private E2eManager mgr;",
        "    private void Start()",
        "    {",
        "        E2eManager.Announce(\"wave\");",
        "        mgr.Spawn(\"orc\");",
        "        RunHelper();",
        "        Debug.Log(\"x\");",
        "    }",
        "    private void RunHelper() { }",
        "}",
      ].join("\n"), true);
      const s = window.__vsStore;
      s.setState({ graphFlowFile: "__e2e__/E2eCaller.cs", graphSeed: Date.now() });
    })();
  });
  await page.waitForFunction(() => [...document.querySelectorAll(".dg-node.cross")].length >= 2, null, { timeout: 15000 });

  // 5. call-order badges (3 edges: 2 cross-file + 1 in-file)
  await page.waitForSelector(".dg-ord", { timeout: 10000 });
  const badge = await page.evaluate(() => {
    const badges = [...document.querySelectorAll(".dg-ord")];
    const edges = [...document.querySelectorAll(".dg-edge.e-call, .dg-edge.e-self")].length;
    const texts = badges.map((b) => (b.querySelector("text")?.textContent ?? "").trim());
    return { count: badges.length, edges, first: texts[0] ?? "", ones: texts.filter((t) => t === "1").length };
  });
  check("per-caller call-order badges rendered", badge.count > 0, JSON.stringify(badge));
  check("the first call of a method is numbered 1", badge.first === "1" && badge.ones > 0, `first=${badge.first}`);
  check("one badge per call edge (localized per method)", badge.count === badge.edges, `badges=${badge.count} edges=${badge.edges}`);

  // 6. dynamic widths (cross sub-labels push boxes well past the old fixed 158)
  const widths = await page.evaluate(() => {
    const ws = [...document.querySelectorAll(".dg-box[data-w]")].map((r) => parseFloat(r.getAttribute("data-w")));
    return { n: ws.length, distinct: new Set(ws).size, min: Math.min(...ws), max: Math.max(...ws) };
  });
  check("boxes size dynamically (multiple distinct widths, beyond the old 158 fixed)", widths.distinct >= 2 && widths.max > 158, JSON.stringify(widths));

  // 7. cross terminals + details panel in execution order
  const cross = await page.evaluate(() => ({
    nodes: document.querySelectorAll(".dg-node.cross").length,
    labels: [...document.querySelectorAll(".dg-node.cross .dg-name")].map((n) => n.textContent),
  }));
  check("cross-file custom methods render as dashed terminals (Announce + Spawn)", cross.nodes === 2, JSON.stringify(cross));
  const crossDetails = await page.evaluate(() => {
    const caller = [...document.querySelectorAll(".dg-node.method")].find((n) => n.querySelector(".dg-name")?.textContent === "Start");
    caller?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return new Promise((res) => setTimeout(() => res({
      titles: [...document.querySelectorAll(".dgd-list-title")].map((n) => n.textContent),
      ords: [...document.querySelectorAll(".dgd-ord")].map((o) => o.textContent),
      files: [...document.querySelectorAll(".dg-node.cross .dg-sub")].map((n) => n.textContent),
    }), 250));
  });
  check("details panel lists calls in execution order", crossDetails.titles.some((t) => /execution order/.test(t)) && crossDetails.ords[0] === "1.", JSON.stringify(crossDetails));
  check("cross terminals are labeled as other-script methods", crossDetails.files.length === 2 && crossDetails.files.every((f) => /another script/.test(f ?? "")), JSON.stringify(crossDetails.files));

  // 7. failure banner + copyable error
  await page.evaluate(() => {
    const s = window.__vsStore;
    s.setState({ graphFlowFile: "__noe2e__/Missing.cs", graphSeed: Date.now() });
  });
  await page.waitForSelector(".dg-copyerr", { timeout: 10000 });
  const banner = await page.evaluate(() => document.querySelector(".dg-empty")?.textContent ?? "");
  check("failure banner shows WHY (not a silent blank)", /file is not part of the workspace/.test(banner), banner.slice(0, 90));
  await page.click(".dg-copyerr");
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check("⧉ copy error puts version + script + reason on the clipboard",
    clip.includes("VelvetSharp graph error") && clip.includes("Phase 13") && clip.includes("Missing.cs") && /error:/.test(clip), clip.slice(0, 160).replace(/\n/g, " | "));

  // 8. the app never threw during the whole flow exercise — EXCEPT the known
  //    browser-only artifact: index.html's <script src="/__neutralino_globals.js">
  //    falls back to HTML outside the Neutralino shell (desktop serves it fine).
  //    That script's parse error surfaces as exactly `Unexpected token '<'`.
  const whitelisted = (m) => /Unexpected token '<'/.test(m); // neutralino-globals only
  const realErrors = pageErrors.filter((m) => !whitelisted(m));
  check("zero page errors during the whole run (browser-only neutralino-globals artifact whitelisted)",
    realErrors.length === 0, pageErrors.filter((m) => !whitelisted(m)).join(" | ").slice(0, 200));

  await browser.close();
  server.close();

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n=========== E2E RESULT: ${results.length - failed.length}/${results.length} PASS ============`);
  for (const [name] of failed) console.log("  FAILED:", name);
  process.exit(failed.length ? 2 : 0);
}

main().catch((e) => { console.error("E2E FATAL:", e); process.exit(1); });
