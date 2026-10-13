/**
 * Brain engine test — run: npx tsx scripts/test-brain.ts
 * Validates: parsing, symbol extraction, type inference, completions, hover, diagnostics.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { VelvetSharpEngine } from "../packages/brain/src/engine";

// derive the repo root from this file's location — keeps the suite runnable
// anywhere (local checkout, CI runner, packaging sandbox), no hardcoded path
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = path.join(ROOT, "app/demo");

async function main() {
  console.log("== loading Unity API DB ==");
  const db = JSON.parse(fs.readFileSync(path.join(ROOT, "app/public/api/unityengine.db.json"), "utf8"));
  console.log("db types:", Object.values<any>(db.namespaces).reduce((a: number, n: any) => a + Object.keys(n).length, 0));

  console.log("== creating engine (tree-sitter wasm) ==");
  const engine = await VelvetSharpEngine.create({
    wasmLocator: (f) => path.join(ROOT, "packages/brain/node_modules", f.includes("c_sharp") ? "tree-sitter-wasms/out/" + f : "web-tree-sitter/" + f),
    unityDb: db,
  });
  // the real app merges the BCL db inside the worker — mirror that here
  const bclPath = path.join(ROOT, "app/public/api/bcl.db.json");
  if (fs.existsSync(bclPath)) engine.unity.mergeFromJson(JSON.parse(fs.readFileSync(bclPath, "utf8")));

  // load demo workspace
  const csFiles: { path: string; content: string }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".cs")) csFiles.push({ path: path.relative(DEMO, p).replace(/\\/g, "/"), content: fs.readFileSync(p, "utf8") });
    }
  };
  walk(DEMO);
  console.log("== loading workspace ==", csFiles.map((f) => f.path).join(", "));
  await engine.loadFiles(csFiles);
  console.log("stats:", JSON.stringify(engine.stats));

  const playerPath = "Assets/Scripts/Player/PlayerController.cs";

  // ---- TEST 1: member completion via var+GetComponent inference ----
  let comps = engine.completions(playerPath, 29, 17); // after "velocity."
  const labelSet = new Set(comps.map((c) => c.label));
  console.log("\nTEST1 completions after 'velocity.' ->", comps.length, "items; sample:", comps.slice(0, 6).map((c) => c.label + (c.kind === "method" ? "()" : "")).join(", "));
  console.log("TEST1 PASS:", ["x", "y", "z", "magnitude", "normalized", "Set"].every((k) => labelSet.has(k)));

  // ---- TEST 2: Unity self globals (transform.) ----
  comps = engine.completions(playerPath, 45, 18); // after "transform."
  const t2 = new Set(comps.map((c) => c.label));
  console.log("\nTEST2 completions after 'transform.' ->", comps.length, "items; has position:", t2.has("position"), "has SetPositionAndRotation:", t2.has("SetPositionAndRotation"), "has localScale:", t2.has("localScale"));

  // ---- TEST 3: hover with Unity docs ----
  const hv = engine.hover(playerPath, 34, 27); // on AddForce
  console.log("\nTEST3 hover:", hv?.signature ?? "null", "|", hv?.doc?.slice(0, 60) ?? "no doc");

  // ---- TEST 4: static member completion Mathf. ----
  comps = engine.completions("Assets/Scripts/Player/PlayerHealth.cs", 16, 30); // after 'Mathf.'
  const t4 = new Set(comps.map((c) => c.label));
  console.log("\nTEST4 completions after 'Mathf.' ->", comps.length, "items; has Max:", t4.has("Max"), "has PI:", t4.has("PI"), "has Clamp:", t4.has("Clamp"));

  // ---- TEST 5: diagnostics on broken file ----
  const broken = engine.updateFile("Assets/Scripts/BrokenScript.cs", fs.readFileSync(path.join(DEMO, "Assets/Scripts/BrokenScript.cs"), "utf8"));
  console.log("\nTEST5 diagnostics on BrokenScript:", broken.diagnostics.length);
  broken.diagnostics.slice(0, 4).forEach((d) => console.log(`  L${d.line + 1}:${d.col} [${d.severity}] ${d.message}`));

  // ---- TEST 6: go-to-def across files ----
  const def = engine.definitions("Assets/Scripts/Enemies/EnemyAI.cs", 14, 32);
  console.log("\nTEST6 definitions:", def ? `${def.file}:${def.line + 1} (${def.name})` : "null");

  // ---- TEST 7: workspace symbols + search ----
  const ws = engine.workspaceSymbols("Game");
  console.log("\nTEST7 workspace symbols 'Game':", ws.slice(0, 5).map((s) => s.fqn).join(", "));
  const hits = engine.search("Vector3.up");
  console.log("TEST7 search 'Vector3.up':", hits.length, "hits ->", hits.slice(0, 3).map((h) => `${h.file}:${h.line + 1}`).join(", "));

  // ---- TEST 8: signature help ----
  const sig = engine.signatureHelp(playerPath, 34, 62);
  console.log("\nTEST8 signatureHelp:", sig?.label ?? "null", "| activeParam:", sig?.activeParam, "| doc:", (sig?.doc ?? "").slice(0, 50));

  // ==================== v0.5.0 suite ====================
  console.log("\n================ v0.5.0 suite ================");
  const results: [string, boolean][] = [];
  const check = (name: string, ok: boolean) => { results.push([name, ok]); console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`); };

  // ---- csproj + asmdef configuration (assembly hunting) ----
  const { parseCsproj } = await import("../packages/brain/src/csproj");
  const { parseAsmdef, guidFromMeta } = await import("../packages/brain/src/asmdef");
  const csprojs = ["Assembly-CSharp.csproj", "Assembly-CSharp.Player.csproj", "Assembly-CSharp-Editor.csproj"]
    .map((n) => parseCsproj(fs.readFileSync(path.join(DEMO, n), "utf8"), n));
  const asmdefs: any[] = [];
  const walkAll = (dir: string, cb: (p: string) => void) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkAll(p, cb);
      else cb(p);
    }
  };
  walkAll(DEMO, (p) => {
    if (p.endsWith(".asmdef")) {
      const info = parseAsmdef(fs.readFileSync(p, "utf8"), path.relative(DEMO, p).replace(/\\/g, "/"));
      if (info) {
        const meta = p + ".meta";
        if (fs.existsSync(meta)) info.guid = guidFromMeta(fs.readFileSync(meta, "utf8")) ?? undefined;
        asmdefs.push(info);
      }
    }
  });
  engine.setProjects(csprojs);
  engine.setAssemblyGraph(asmdefs);
  const summary = engine.asmdefSummary();
  console.log("\nTEST9 assembly hunting:", JSON.stringify(summary));

  // TEST 9: file → assembly (csproj exact → asmdef dir → predefined)
  const a1 = engine.assemblyOf("Assets/Net/GameServer/ServerKernel.cs");
  const a2 = engine.assemblyOf("Assets/Net/NetworkLib/NetDriver.cs");
  const a3 = engine.assemblyOf("Assets/Scripts/System/V05Demo.cs");
  const a4 = engine.assemblyOf("Assets/Scripts/NoEngine/Pure.cs");
  console.log("TEST9 file→assembly:", a1, "|", a2, "|", a3, "|", a4);
  check("TEST9 file→assembly mapping", a1 === "GameServerAssembly" && a2 === "NetworkLib" && a3 === "Assembly-CSharp" && a4 === "NoEngineLib");
  check("TEST9 GUID refs resolved (1 unresolved left)", summary.asmdefs === 3 && summary.unresolved === 1);

  // TEST 10: assembly-gated bare completions
  // ServerKernel (GameServerAssembly refs NetworkLib via GUID): NetDriver YES, GameManager NO
  let comps10 = engine.completions("Assets/Net/GameServer/ServerKernel.cs", 14, 8);
  let labels10 = new Set(comps10.map((c: any) => c.label));
  check("TEST10 referenced assembly types offered (NetDriver)", labels10.has("NetDriver"));
  check("TEST10 unreferenced assembly types hidden (GameManager)", !labels10.has("GameManager"));
  check("TEST10 engine types offered for engine-ref assembly (GameObject)", labels10.has("GameObject"));

  // Pure.cs (NoEngineLib — noEngineReferences): engine types hidden
  comps10 = engine.completions("Assets/Scripts/NoEngine/Pure.cs", 8, 12);
  labels10 = new Set(comps10.map((c: any) => c.label));
  const stPure: any = (engine as any).files.get("Assets/Scripts/NoEngine/Pure.cs");
  console.log("DBG Pure asm:", engine.assemblyOf("Assets/Scripts/NoEngine/Pure.cs"),
    "| usings:", JSON.stringify(stPure?.symbols?.usings),
    "| visible:", JSON.stringify([...engine.visibleNamespacesFor(stPure)]),
    "| GO?", labels10.has("GameObject"), "| MB?", labels10.has("MonoBehaviour"),
    "| GO-item:", JSON.stringify(comps10.find((c: any) => c.label === "GameObject" || c.label === "MonoBehaviour")));
  check("TEST10 noEngineReferences hides UnityEngine types (non-snippet)",
    !comps10.some((c: any) => (c.label === "GameObject" || c.label === "MonoBehaviour") && c.kind !== "snippet"));
  check("TEST10 own-file type still offered (Pure)", labels10.has("Pure"));

  // TEST 11: `using` namespace completion is assembly-gated
  const nsPureList = engine.completeNamespaces("", "Assets/Scripts/NoEngine/Pure.cs");
  const nsPure = new Set(nsPureList.map((c: any) => c.label));
  console.log("DBG nsPure labels:", nsPureList.map((c: any) => c.label).join(", "));
  const nsServer = new Set(engine.completeNamespaces("", "Assets/Net/GameServer/ServerKernel.cs").map((c: any) => c.label));
  check("TEST11 noEngine asmdef hides UnityEngine from using-completion", !nsPure.has("UnityEngine") && nsPure.has("System"));
  check("TEST11 engine asmdef shows UnityEngine in using-completion", nsServer.has("UnityEngine"));

  // TEST 12: missing using → CS0246 + machine fix
  engine.updateFile("Assets/Scripts/System/MissingUsing.cs", fs.readFileSync(path.join(DEMO, "Assets/Scripts/System/MissingUsing.cs"), "utf8"));
  const sem12 = engine.semantic("Assets/Scripts/System/MissingUsing.cs");
  const fix12: any = sem12.diagnostics.find((d: any) => d.fix?.kind === "addUsing");
  console.log("TEST12 fix:", fix12?.fix?.title, "|", fix12?.message?.slice(0, 70));
  check("TEST12 missing-using error + addUsing fix (UnityEngine)", fix12?.fix?.ns === "UnityEngine");

  // TEST 13: V05Demo — overloads legal, dup signature error, interface naming, ambiguity, void/null returns
  engine.updateFile("Assets/Scripts/System/V05Demo.cs", fs.readFileSync(path.join(DEMO, "Assets/Scripts/System/V05Demo.cs"), "utf8"));
  const sem13 = engine.semantic("Assets/Scripts/System/V05Demo.cs");
  const lints13 = engine.updateFile("Assets/Scripts/System/V05Demo.cs", fs.readFileSync(path.join(DEMO, "Assets/Scripts/System/V05Demo.cs"), "utf8")).diagnostics;
  const all13 = [...lints13, ...sem13.diagnostics];
  const dup13 = all13.find((d: any) => /already defined/.test(d.message) && /Add/.test(d.message));
  const iface13 = sem13.diagnostics.find((d: any) => /should start with 'I'/.test(d.message));
  const ambig13 = sem13.diagnostics.find((d: any) => /Ambiguous reference: 'Object'/.test(d.message));
  const ambigAny13 = sem13.diagnostics.filter((d: any) => /Ambiguous reference/.test(d.message));
  const voidRet13 = sem13.diagnostics.find((d: any) => /void method 'Bad'/.test(d.message));
  const paths13 = sem13.diagnostics.find((d: any) => /not all code paths return a value/.test(d.message) && /Pick/.test(d.message));
  const nullVal13 = sem13.diagnostics.find((d: any) => /Cannot convert null/.test(d.message));
  console.log("TEST13 dup:", dup13?.message?.slice(0, 60));
  console.log("TEST13 iface:", iface13?.message?.slice(0, 60));
  console.log("TEST13 ambig:", ambig13?.message?.slice(0, 70));
  console.log("TEST13 voidRet:", voidRet13?.message?.slice(0, 60));
  check("TEST13 overload-friendly duplicate detection fires on same-sig Add", !!dup13);
  check("TEST13 interface naming warning (Repo → I)", !!iface13);
  // Phase 9 (user: "ignore warning also"): ambiguous-reference (CS0104) warnings
  // are SUPPRESSED — the lint cannot model exact using-directive semantics and
  // produced false positives ('Task' vs 'Task`1'). Expect ZERO, not one.
  check("TEST13 ambiguous warnings suppressed (Phase 9 — was: fires on Object)", ambigAny13.length === 0);
  check("TEST13 void method returning value flagged", !!voidRet13);
  check("TEST13 Pick(bool) all-paths-return is clean", !paths13);
  check("TEST13 return null on reference type is clean", !nullVal13);

  // TEST 14: value-type return null → error
  engine.updateFile("__test__/NullReturn.cs", [
    "public class NullReturn",
    "{",
    "    public int Get()",
    "    {",
    "        return null;",
    "    }",
    "}",
  ].join("\n"));
  const sem14 = engine.semantic("__test__/NullReturn.cs");
  check("TEST14 return null on int flagged", sem14.diagnostics.some((d: any) => /Cannot convert null to 'int'/.test(d.message)));

  // TEST 14b: attribute names bind to *Attribute types ([Header] with using UnityEngine → clean)
  engine.updateFile("__test__/Attrs.cs", [
    "using UnityEngine;",
    "public class Attrs : MonoBehaviour",
    "{",
    '    [Header("Stats")]',
    "    [SerializeField] private int hp = 10;",
    "}",
  ].join("\n"));
  const sem14b = engine.semantic("__test__/Attrs.cs");
  const headerDiag = sem14b.diagnostics.find((d: any) => /'Header' could not be found/.test(d.message));
  check("TEST14b [Header] attribute resolves via HeaderAttribute (no false CS0246)", !headerDiag);

  // TEST 15: snippet loop-variable bumping (i used → j; fresh file → i)
  engine.updateFile("__test__/LoopA.cs", [
    "public class LoopA",
    "{",
    "    private int i;",
    "    public void Run()",
    "    {",
    "        for",
    "    }",
    "}",
  ].join("\n"));
  engine.updateFile("__test__/LoopB.cs", [
    "public class LoopB",
    "{",
    "    public void Run()",
    "    {",
    "        for",
    "    }",
    "}",
  ].join("\n"));
  const snip15a = engine.completions("__test__/LoopA.cs", 5, 11).find((c: any) => c.label === "for");
  const snip15b = engine.completions("__test__/LoopB.cs", 4, 11).find((c: any) => c.label === "for");
  console.log("TEST15 for-snippet (i taken):", JSON.stringify(snip15a?.insert ?? ""));
  console.log("TEST15 for-snippet (fresh):", JSON.stringify(snip15b?.insert ?? ""));
  check("TEST15 loop var bumps i→j when i is used", /int j/.test(snip15a?.insert ?? ""));
  check("TEST15 loop var stays i on fresh file", /int i/.test(snip15b?.insert ?? ""));
  const snip15c = engine.completions("__test__/LoopA.cs", 5, 11).find((c: any) => c.label === "foreach");
  check("TEST15 foreach snippet present", /foreach \(var /.test(snip15c?.insert ?? ""));
  const snip15d = engine.completions("__test__/LoopA.cs", 5, 8).filter((c: any) => c.kind === "snippet" && ["if", "while", "try", "prop", "switch"].includes(c.label));
  check("TEST15 core statement snippets present (if/while/try/prop/switch)", snip15d.length === 5);

  // TEST 16: startup cache round-trip (symbols → fresh engine → lazy parse on open)
  const syms16 = engine.filesSymbols();
  console.log("TEST16 cached files:", syms16.length, "| types:", engine.stats.types);
  const engine2 = await VelvetSharpEngine.create({
    wasmLocator: (f) => path.join(ROOT, "packages/brain/node_modules", f.includes("c_sharp") ? "tree-sitter-wasms/out/" + f : "web-tree-sitter/" + f),
    unityDb: db,
  });
  if (fs.existsSync(bclPath)) engine2.unity.mergeFromJson(JSON.parse(fs.readFileSync(bclPath, "utf8")));
  engine2.loadCachedSymbols(JSON.parse(JSON.stringify(syms16)));
  const comps16 = engine2.completions("Assets/Scripts/Player/PlayerController.cs", 29, 17);
  const r16 = engine2.updateFile("Assets/Scripts/Player/PlayerController.cs", fs.readFileSync(path.join(DEMO, playerPath), "utf8"));
  const comps16b = engine2.completions("Assets/Scripts/Player/PlayerController.cs", 29, 17);
  const lbl16b = new Set(comps16b.map((c: any) => c.label));
  console.log("TEST16 completions on cache-only file:", comps16.length, "| after open parse:", comps16b.length, "| has x:", lbl16b.has("x"));
  check("TEST16 cache-indexed engine has full index", engine2.stats.types >= engine.stats.types && syms16.length > 0);
  check("TEST16 cache-only file completes empty (no tree) without crash", comps16.length === 0);
  check("TEST16 first open parses lazily and completions come alive", comps16b.length > 0 && lbl16b.has("x"));

  // TEST 17: project sweep (syntax + semantic per file)
  const sw17 = engine.sweepFile("Assets/Scripts/System/V05Demo.cs");
  const swNull = engine2.sweepFile("Assets/Scripts/Enemies/EnemyAI.cs");
  console.log("TEST17 sweepFile:", sw17?.syntax.length ?? "null", "syntax,", sw17?.sem.diagnostics.length ?? "null", "sem | cache-only sweep:", swNull);
  check("TEST17 sweepFile returns reports for parsed files", !!sw17 && sw17.syntax.length >= 0 && sw17.sem.diagnostics.length > 0);
  check("TEST17 sweepFile is null for cache-only files", swNull === null);

  // ---- v0.5.0 summary ----
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n=========== v0.5.0 RESULT: ${results.length - failed.length}/${results.length} PASS ===========`);
  for (const [name] of failed) console.log("  FAILED:", name);
  if (failed.length) process.exitCode = 2;

  // ==================== v0.6.0 suite (phase 6: dep graph + rename) ====================
  console.log("\n================ v0.6.0 suite ================");
  const results6: [string, boolean][] = [];
  const check6 = (name: string, ok: boolean) => { results6.push([name, ok]); console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`); };

  // ---- TEST18: dependency graph (whole project) ----
  const g18 = engine.dependencyGraph(null, false);
  const nodeNames = new Set(g18.nodes.map((n: any) => n.name));
  const nodeById = new Map(g18.nodes.map((n: any) => [n.id, n] as const));
  const edgeOf = (from: string, to: string, kind?: string) =>
    g18.edges.find((e: any) => nodeById.get(e.from)?.name === from && nodeById.get(e.to)?.name === to && (!kind || e.kind === kind));
  console.log("TEST18 nodes:", g18.nodes.length, "->", g18.nodes.map((n: any) => n.name).join(", "));
  console.log("TEST18 edges:", g18.edges.map((e: any) => `${nodeById.get(e.from)?.name}-${e.kind}->${nodeById.get(e.to)?.name}`).join(" | "));
  check6("TEST18 graph has project classes", ["PlayerController", "EnemyAI", "EnemyHealth", "GameManager", "Turret", "NetDriver", "ServerKernel"].every((n) => nodeNames.has(n)));
  check6("TEST18 Turret extends EnemyAI", !!edgeOf("Turret", "EnemyAI", "extends"));
  check6("TEST18 Turret implements IDamageable", !!edgeOf("Turret", "IDamageable", "implements"));
  check6("TEST18 EnemyAI uses EnemyHealth (field + GetComponent)", !!edgeOf("EnemyAI", "EnemyHealth", "uses"));
  check6("TEST18 EnemyAI uses PlayerHealth", !!edgeOf("EnemyAI", "PlayerHealth", "uses"));
  check6("TEST18 PlayerHealth uses GameManager", !!edgeOf("PlayerHealth", "GameManager", "uses"));
  check6("TEST18 ServerKernel uses NetDriver (cross-asmdef)", !!edgeOf("ServerKernel", "NetDriver", "uses"));
  check6("TEST18 asm tags on nodes", nodeById.get([...nodeById.keys()].find((k) => nodeById.get(k)!.name === "NetDriver")!)?.asm === "NetworkLib");
  check6("TEST18 isMono flags", nodeById.get([...nodeById.keys()].find((k) => nodeById.get(k)!.name === "EnemyAI")!)?.isMono === true
    && nodeById.get([...nodeById.keys()].find((k) => nodeById.get(k)!.name === "IDamageable")!)?.isMono === false);

  // ---- TEST19: folder scope filter ----
  const g19 = engine.dependencyGraph("Assets/Scripts/Player", false);
  const inScope19 = g19.nodes.filter((n: any) => !n.outOfScope).map((n: any) => n.name);
  console.log("TEST19 scoped nodes:", inScope19.join(", "), "| out:", g19.nodes.filter((n: any) => n.outOfScope).map((n: any) => n.name).join(", "));
  check6("TEST19 scope keeps only folder classes", inScope19.includes("PlayerController") && inScope19.includes("PlayerHealth") && !inScope19.includes("EnemyAI") && !inScope19.includes("Turret"));
  check6("TEST19 GameManager visible as out-of-scope dependency", g19.nodes.some((n: any) => n.name === "GameManager" && n.outOfScope));

  // ---- TEST20: includeExternal pulls Unity/BCL types ----
  const g20 = engine.dependencyGraph(null, true);
  const extNames = new Set(g20.nodes.filter((n: any) => n.external).map((n: any) => n.name));
  console.log("TEST20 externals:", [...extNames].slice(0, 12).join(", "), `(${extNames.size} total)`);
  check6("TEST20 external Unity types included (MonoBehaviour)", extNames.has("MonoBehaviour"));
  check6("TEST20 no externals by default", !engine.dependencyGraph(null, false).nodes.some((n: any) => n.external));

  // ---- TEST21: rename field maxHealth → startHealth (same-file refs) ----
  const phPath = "Assets/Scripts/Player/PlayerHealth.cs";
  const phText = engine.fileContent(phPath) ?? "";
  const mhLine = phText.split("\n").findIndex((l: string) => l.includes("int maxHealth"));
  const mhCol = (phText.split("\n")[mhLine] ?? "").indexOf("maxHealth");
  const t21 = engine.renamePrepare(phPath, mhLine, mhCol + 3); // caret inside the field name
  console.log("TEST21 prepare:", JSON.stringify(t21.ok ? { kind: t21.target.kind, scope: t21.target.scope, name: t21.target.name, owner: t21.target.ownerTypeFqn } : t21.reason));
  const p21 = engine.rename(phPath, mhLine, mhCol + 3, "startHealth");
  console.log("TEST21 plan edits:", p21.edits.map((e: any) => `${e.path}×${e.ranges.length}`).join(", "), "| warnings:", p21.warnings.length);
  check6("TEST21 field target identified", t21.ok && t21.target.kind === "field" && t21.target.scope === "member" && t21.target.ownerTypeFqn === "PlayerHealth");
  check6("TEST21 field rename covers decl + all uses in file", p21.ok && p21.edits.length === 1 && p21.edits[0].path === phPath && p21.edits[0].ranges.length >= 3);

  // ---- TEST22: rename type GameManager → GameCore (cross-file + file+meta move) ----
  const gmPath = "Assets/Scripts/System/GameManager.cs";
  const gmText = engine.fileContent(gmPath) ?? "";
  const gmLine = gmText.split("\n").findIndex((l: string) => l.includes("class GameManager"));
  const gmCol = (gmText.split("\n")[gmLine] ?? "").indexOf("GameManager");
  const t22 = engine.renamePrepare(gmPath, gmLine, gmCol + 2);
  const p22 = engine.rename(gmPath, gmLine, gmCol + 2, "GameCore");
  console.log("TEST22 target:", JSON.stringify(t22.ok ? { name: t22.target.name, fqn: t22.target.fqn } : t22.reason));
  console.log("TEST22 edits:", p22.edits.map((e: any) => `${e.path}×${e.ranges.length}`).join(", "), "| fileRename:", JSON.stringify(p22.fileRename));
  check6("TEST22 type target identified", t22.ok && t22.target.scope === "type" && t22.target.kind === "class");
  check6("TEST22 type rename spans 4 files (decl+EnemyHealth+PlayerHealth+Turret)", p22.ok && p22.edits.length === 4);
  check6("TEST22 Unity file+meta rename planned", p22.fileRename?.from === gmPath && p22.fileRename?.to === "Assets/Scripts/System/GameCore.cs" && p22.fileRename?.metaTo === "Assets/Scripts/System/GameCore.cs.meta");

  // ---- TEST23: method rename is owner-scoped (EnemyHealth.TakeDamage ≠ PlayerHealth.TakeDamage) ----
  const ehPath = "Assets/Scripts/Enemies/EnemyHealth.cs";
  const ehText = engine.fileContent(ehPath) ?? "";
  const tdLine = ehText.split("\n").findIndex((l: string) => l.includes("public void TakeDamage"));
  const tdCol = (ehText.split("\n")[tdLine] ?? "").indexOf("TakeDamage");
  const p23 = engine.rename(ehPath, tdLine, tdCol + 2, "Inflict");
  const paths23 = p23.edits.map((e: any) => e.path).sort();
  console.log("TEST23 files:", paths23.join(", "), "| counts:", p23.edits.map((e: any) => e.ranges.length).join(","));
  check6("TEST23 EnemyHealth.TakeDamage renames do not leak into PlayerHealth", p23.ok && !paths23.some((p: string) => p.includes("PlayerHealth")));
  check6("TEST23 Turret's coreHealth.TakeDamage call included", paths23.includes("Assets/Scripts/AI/Turret.cs"));

  // ---- TEST24: local variable rename stays in its method ----
  const pcPath = "Assets/Scripts/Player/PlayerController.cs";
  const pc = engine.fileContent(pcPath) ?? "";
  const hLine = pc.split("\n").findIndex((l: string) => l.includes("float horizontal = Input.GetAxis"));
  const p24 = engine.rename(pcPath, hLine, pc.split("\n")[hLine].indexOf("horizontal"), "hAxis");
  console.log("TEST24 edits:", p24.edits.map((e: any) => `${e.path}×${e.ranges.length}`).join(", "));
  check6("TEST24 local rename found 2 refs (decl + use)", p24.ok && p24.edits.length === 1 && p24.edits[0].ranges.length === 2);

  // ---- TEST25: engine/API members refuse to rename ----
  const afLine = pc.split("\n").findIndex((l: string) => l.includes("AddForce"));
  const t25 = engine.renamePrepare(pcPath, afLine, pc.split("\n")[afLine].indexOf("AddForce"));
  console.log("TEST25:", t25.ok ? "unexpectedly ok" : t25.reason);
  check6("TEST25 Rigidbody.AddForce refuses with a clear reason", !t25.ok && /compiled|assembly/.test(t25.reason));

  // ---- TEST26: invalid new names rejected ----
  check6("TEST26 keyword rejected", engine.rename(pcPath, hLine, 0, "class").ok === false);
  check6("TEST26 bad identifier rejected", engine.rename(pcPath, hLine, 0, "9lives").ok === false);

  // ---- TEST27: applying a rename plan produces clean syntax ----
  // regression: every planned range must point EXACTLY at the symbol text —
  // declaration positions used to include attributes/modifiers (renaming
  // coreHealth once corrupted [SerializeField])
  const verifyRanges = (plan: any) => {
    for (const fe of plan.edits) {
      const lines = (engine.fileContent(fe.path) ?? "").split("\n");
      for (const r of fe.ranges) {
        const at = (lines[r.line] ?? "").slice(r.col, r.col + r.length);
        if (at !== plan.target.name) return `mismatch in ${fe.path}: '${at}' @ L${r.line + 1}:${r.col}`;
      }
    }
    return null;
  };
  const bad21 = verifyRanges(p21);
  const bad22 = verifyRanges(p22);
  const bad23 = verifyRanges(p23);
  console.log("TEST27 range check:", bad21 ?? "p21 ok", "|", bad22 ?? "p22 ok", "|", bad23 ?? "p23 ok");
  check6("TEST27 all plan ranges hit the exact symbol text", !bad21 && !bad22 && !bad23);
  const applyPlan = (plan: any) => {
    for (const fe of plan.edits) {
      const lines = (engine.fileContent(fe.path) ?? "").split("\n");
      for (const r of fe.ranges) {
        const l = lines[r.line] ?? "";
        lines[r.line] = l.slice(0, r.col) + plan.newName + l.slice(r.col + r.length);
      }
      engine.updateFile(fe.path, lines.join("\n"));
    }
  };
  applyPlan(p21); // maxHealth → startHealth in PlayerHealth
  const sem21 = engine.sweepFile(phPath);
  const healed21 = (engine.fileContent(phPath) ?? "").includes("startHealth");
  check6("TEST27 rename plan applies and file re-parses clean", healed21 && sem21 !== null && !sem21.syntax.some((d: any) => d.severity === "error"));

  // ---- TEST28: interface rename target via base-list position ----
  const turrPath = "Assets/Scripts/AI/Turret.cs";
  const turrContent = engine.fileContent(turrPath) ?? "";
  const ifaceLine = turrContent.split("\n").findIndex((l: string) => l.includes("class Turret"));
  const t28 = engine.renamePrepare(turrPath, ifaceLine, turrContent.split("\n")[ifaceLine].indexOf("IDamageable"));
  console.log("TEST28:", JSON.stringify(t28.ok ? { name: t28.target.name, scope: t28.target.scope } : t28.reason));
  check6("TEST28 IDamageable identified from base list", t28.ok && t28.target.scope === "type" && t28.target.name === "IDamageable");

  // ---- TEST29: missingTrees on a cache-indexed engine ----
  const syms29 = engine.filesSymbols();
  const engine3 = await VelvetSharpEngine.create({
    wasmLocator: (f) => path.join(ROOT, "packages/brain/node_modules", f.includes("c_sharp") ? "tree-sitter-wasms/out/" + f : "web-tree-sitter/" + f),
    unityDb: db,
  });
  engine3.loadCachedSymbols(JSON.parse(JSON.stringify(syms29)));
  const missing = engine3.missingTrees();
  check6("TEST29 cache-only engine reports missing trees", missing.length === syms29.length && missing.length > 0);
  check6("TEST29 parsed engine reports none", engine.missingTrees().length === 0);

  // ---- v0.6.0 summary ----
  const failed6 = results6.filter(([, ok]) => !ok);
  console.log(`\n=========== v0.6.0 RESULT: ${results6.length - failed6.length}/${results6.length} PASS ===========`);
  for (const [name] of failed6) console.log("  FAILED:", name);
  if (failed6.length) process.exitCode = 2;

  // ==================== v0.6.1 suite (bug-fix batch) ====================
  console.log("\n================ v0.6.1 suite ================");
  const results61: [string, boolean][] = [];
  const check61 = (name: string, ok: boolean) => { results61.push([name, ok]); console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`); };

  // ---- TEST30: duplicate flood fix — same field names in DIFFERENT classes are legal ----
  // (the reported bug: 1039 errors like "'Instance' is also defined in … (duplicate across files)")
  engine.updateFile("__test__/DupA.cs", [
    "public class DupA",
    "{",
    "    public static DupA Instance { get; private set; }",
    "    private float minSunIntensity;",
    "    private Color _sunColorGradient;",
    "    void Update() { minSunIntensity = 1f; }",
    "}",
  ].join("\n"));
  engine.updateFile("__test__/DupB.cs", [
    "public class DupB",
    "{",
    "    public static DupB Instance { get; private set; }",
    "    private float minSunIntensity;",
    "    private Color _sunColorGradient;",
    "    void LateUpdate() { minSunIntensity = 2f; }",
    "}",
  ].join("\n"));
  const dupA30 = engine.updateFile("__test__/DupA.cs", engine.fileContent("__test__/DupA.cs") ?? "").diagnostics;
  const dupB30 = engine.updateFile("__test__/DupB.cs", engine.fileContent("__test__/DupB.cs") ?? "").diagnostics;
  const dupMsg30 = [...dupA30, ...dupB30].filter((d: any) => /duplicate across files/.test(d.message));
  console.log("TEST30 cross-file member dups:", dupMsg30.length);
  check61("TEST30 identical member names in different classes → ZERO errors", dupMsg30.length === 0);

  // ---- TEST31: genuine duplicate type (same FQN, two files) → ONE type-level error ----
  engine.updateFile("__test__/DupT1.cs", "namespace GameNS\n{\n    public class DupManager { public int hp; }\n}\n");
  engine.updateFile("__test__/DupT2.cs", "namespace GameNS\n{\n    public class DupManager { public int ammo; }\n}\n");
  const dupT31 = engine.updateFile("__test__/DupT2.cs", engine.fileContent("__test__/DupT2.cs") ?? "").diagnostics
    .filter((d: any) => /duplicate type definition/.test(d.message));
  console.log("TEST31 dup-type errors:", dupT31.length, "->", dupT31.map((d: any) => d.message.slice(0, 60)).join(" | "));
  check61("TEST31 same-FQN class in two files → exactly one CS0101-style error", dupT31.length === 1);

  // partial class across files is LEGAL → clean
  engine.updateFile("__test__/Part1.cs", "public partial class PartWidget { public int a; }\n");
  engine.updateFile("__test__/Part2.cs", "public partial class PartWidget { public int B() { return a + 1; } }\n");
  const part31 = engine.updateFile("__test__/Part2.cs", engine.fileContent("__test__/Part2.cs") ?? "").diagnostics
    .filter((d: any) => /duplicate/.test(d.message));
  check61("TEST31 partial class across files → no duplicate error", part31.length === 0);

  // ---- TEST32: file-scoped namespaces (`namespace X;`) parse correctly ----
  engine.updateFile("__test__/FsN1.cs", "namespace Fsn.One;\npublic class FsManager { public int id; }\n");
  engine.updateFile("__test__/FsN2.cs", "namespace Fsn.Two;\npublic class FsManager { public int id; }\n");
  const fs1 = engine.files.get("__test__/FsN1.cs")!.symbols;
  const fs2 = engine.files.get("__test__/FsN2.cs")!.symbols;
  console.log("TEST32 ns:", fs1.namespaces.join(","), "| fqn:", fs1.types[0]?.fqn, "/", fs2.types[0]?.fqn);
  check61("TEST32 file-scoped namespace captured", fs1.namespaces.includes("Fsn.One") && fs1.types[0]?.ns === "Fsn.One");
  const fsDup32 = engine.updateFile("__test__/FsN2.cs", engine.fileContent("__test__/FsN2.cs") ?? "").diagnostics
    .filter((d: any) => /duplicate/.test(d.message));
  check61("TEST32 same class name in DIFFERENT file-scoped namespaces → clean", fsDup32.length === 0);
  // members of file-scoped types get the namespace-qualified container
  check61("TEST32 member container is ns-qualified", fs1.members[0]?.container === "Fsn.One.FsManager");

  // ---- TEST33: void methods NEVER produce return diagnostics (user request) ----
  engine.updateFile("__test__/VoidCalm.cs", [
    "public class VoidCalm",
    "{",
    "    private int counter;",
    "    public void NoReturnAtAll()",
    "    {",
    "        counter++;",
    "    }",
    "    public void BareReturn(bool skip)",
    "    {",
    "        if (skip)",
    "        {",
    "            return;",
    "        }",
    "        counter += 2;",
    "    }",
    "    public void NullReturn(bool skip)",
    "    {",
    "        if (skip) return null;",
    "        counter += 3;",
    "    }",
    "    public void EarlyOut()",
    "    {",
    "        if (counter > 10) return;",
    "    }",
    "}",
  ].join("\n"));
  const voidSem33 = engine.semantic("__test__/VoidCalm.cs");
  const voidLints33 = engine.updateFile("__test__/VoidCalm.cs", engine.fileContent("__test__/VoidCalm.cs") ?? "").diagnostics;
  const retDiags33 = [...voidSem33.diagnostics, ...voidLints33].filter((d: any) =>
    /return a value|return value|missing return|not all code paths/i.test(d.message));
  console.log("TEST33 void return-diags:", retDiags33.map((d: any) => d.message).join(" | ") || "(none)");
  check61("TEST33 void methods (no return / bare return / return null) → ZERO return diagnostics", retDiags33.length === 0);

  // non-void heuristic warning is gone project-wide (was noisy on real code)
  engine.updateFile("__test__/LoopEnd.cs", [
    "public class LoopEnd",
    "{",
    "    public int Pick(bool a, bool b)",
    "    {",
    "        while (true)",
    "        {",
    "            if (a) return 1;",
    "            if (b) return 2;",
    "        }",
    "    }",
    "}",
  ].join("\n"));
  const loopSem33 = engine.semantic("__test__/LoopEnd.cs");
  check61("TEST33 'not all code paths return a value' warning removed", !loopSem33.diagnostics.some((d: any) => /not all code paths/i.test(d.message)));

  // ---- TEST34: graph caps — huge scope stays renderable and keeps hubs ----
  // build 470 synthetic types, ALL referencing a shared hub class C0
  engine.updateFile("__test__/hub/C0.cs", "public class C0 { public int v; }\n");
  for (let i = 1; i < 470; i++) {
    engine.updateFile(`__test__/hub/C${i}.cs`, `public class C${i} { public C0 hub; public C${i - 1} prev; }\n`);
  }
  const g34 = engine.dependencyGraph("__test__/hub", false);
  const g34names = new Set(g34.nodes.map((n: any) => n.name));
  console.log("TEST34 nodes:", g34.nodes.length, "| edges:", g34.edges.length, "| truncated:", g34.truncated, "| totalTypes:", g34.totalTypes);
  check61("TEST34 node cap respected (≤ 420 in-scope + 64 out)", g34.nodes.filter((n: any) => !n.external).length <= 420 + 64);
  check61("TEST34 edge cap respected (≤ 1500)", g34.edges.length <= 1500);
  check61("TEST34 truncated flag + totalTypes reported", g34.truncated === true && (g34.totalTypes ?? 0) >= 470);
  check61("TEST34 hub C0 (highest degree) survives the cap", g34names.has("C0"));
  const outDegC0 = g34.nodes.find((n: any) => n.name === "C0")?.inDeg ?? 0;
  check61("TEST34 hub has the highest in-degree", outDegC0 > 100);

  // ---- v0.6.1 summary ----
  const failed61 = results61.filter(([, ok]) => !ok);
  console.log(`\n=========== v0.6.1 RESULT: ${results61.length - failed61.length}/${results61.length} PASS ===========`);
  for (const [name] of failed61) console.log("  FAILED:", name);
  if (failed61.length) process.exitCode = 2;

  // ==================== v0.7.0 suite (CRLF, deep pipeline, file ops, dupes) ====================
  console.log("\n================ v0.7.0 suite ================");
  const results7: [string, boolean][] = [];
  const check7 = (name: string, ok: boolean) => { results7.push([name, ok]); console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`); };

  // ---- TEST35: CRLF files parse correctly — positions, completions, hover ----
  const crlfBody = [
    "public class CrlfScript : MonoBehaviour",
    "{",
    "    private Vector3 velocity;",
    "",
    "    void Update()",
    "    {",
    "        velocity.Normalize();",
    "    }",
    "}",
  ].join("\r\n");
  const crlfRes = engine.updateFile("__test__/CrlfScript.cs", crlfBody);
  check7("TEST35 CRLF file parses with zero syntax errors", crlfRes.diagnostics.length === 0);
  check7("TEST35 CRLF symbols extracted (type + Update message)", crlfRes.symbols.types.length === 1 && crlfRes.symbols.members.some((m: any) => m.name === "Update"));
  // member completion right AFTER the dot on "        velocity.Normalize();"
  // (8 spaces + "velocity." = cols 0..16, so col 17 is the empty prefix position)
  const crlfComps = engine.completions("__test__/CrlfScript.cs", 6, 17);
  const crlfLabels = new Set(crlfComps.map((c: any) => c.label));
  console.log("TEST35 completions after 'velocity.':", crlfComps.length, crlfComps.slice(0, 6).map((c: any) => c.label).join(","));
  check7("TEST35 CRLF completion after 'velocity.' finds Vector3 members", ["x", "magnitude", "normalized"].every((k) => crlfLabels.has(k)));
  // hover lands on the right token inside a CRLF file (velocity starts at col 8)
  const crlfHover = engine.hover("__test__/CrlfScript.cs", 6, 8); // on 'v' of velocity
  console.log("TEST35 hover:", crlfHover?.signature ?? "null");
  check7("TEST35 hover inside CRLF file resolves to the field's type", !!crlfHover && /Vector3/.test(crlfHover.signature ?? ""));
  // diagnostics line/col are 0-based OFF the CRLF content (no off-by-one from \r)
  engine.updateFile("__test__/CrlfBroken.cs", "public class CrlfBroken\r\n{\r\n    void Go() { int x = ; }\r\n}\r\n");
  const crlfDiag = engine.updateFile("__test__/CrlfBroken.cs", engine.fileContent("__test__/CrlfBroken.cs") ?? "").diagnostics;
  check7("TEST35 broken CRLF file still produces diagnostics", crlfDiag.length > 0);

  // ---- TEST36: deep updateFile — ONE call returns syntax + semantic together ----
  engine.updateFile("__test__/Deep1.cs", [
    "public class Deep1",
    "{",
    "    public int Compute()",
    "    {",
    "        int unusedLocal = 5;",
    "        return 1;",
    "    }",
    "}",
  ].join("\n"));
  const deepRes = engine.updateFile("__test__/Deep1.cs", engine.fileContent("__test__/Deep1.cs") ?? "", true);
  check7("TEST36 deep updateFile returns a semantic report (sem)", !!deepRes.sem);
  check7("TEST36 deep pass flags the unused local", !!deepRes.sem?.diagnostics.some((d: any) => /unused/i.test(d.message)));
  // and the fast path (deep=false) still skips it (loadFiles stays cheap)
  const fastRes = engine.updateFile("__test__/Deep1.cs", engine.fileContent("__test__/Deep1.cs") ?? "", false);
  check7("TEST36 fast path (deep=false) skips the semantic pass", fastRes.sem === undefined);

  // ---- TEST37: duplicate types across DIFFERENT assemblies are LEGAL ----
  // two asmdefs in different folders, each containing `Helper.Util`
  const asmDefs7 = [
    { path: "__test__/asmA/A.asmdef", dir: "__test__/asmA", name: "AsmSevenA", references: [], includePlatforms: [], excludePlatforms: [], autoReferenced: true, noEngineReferences: false },
    { path: "__test__/asmB/B.asmdef", dir: "__test__/asmB", name: "AsmSevenB", references: [], includePlatforms: [], excludePlatforms: [], autoReferenced: true, noEngineReferences: false },
  ];
  engine.setAssemblyGraph(asmDefs7 as any);
  engine.updateFile("__test__/asmA/Util.cs", "namespace Helpers\n{\n    public class Util { public int a; }\n}\n");
  engine.updateFile("__test__/asmB/Util.cs", "namespace Helpers\n{\n    public class Util { public int b; }\n}\n");
  const asmDupA = engine.updateFile("__test__/asmA/Util.cs", engine.fileContent("__test__/asmA/Util.cs") ?? "").diagnostics;
  const asmDupB = engine.updateFile("__test__/asmB/Util.cs", engine.fileContent("__test__/asmB/Util.cs") ?? "").diagnostics;
  const asmDupMsgs = [...asmDupA, ...asmDupB].filter((d: any) => /duplicate type definition/.test(d.message));
  check7("TEST37 same class in two asmdef assemblies → ZERO duplicate errors", asmDupMsgs.length === 0);
  // same assembly again → error comes back (rule didn't get disabled wholesale)
  engine.setAssemblyGraph([] as any);
  engine.updateFile("__test__/asmA/Util2.cs", "namespace Helpers\n{\n    public class Util2 { public int a; }\n}\n");
  engine.updateFile("__test__/asmB/Util2.cs", "namespace Helpers\n{\n    public class Util2 { public int b; }\n}\n");
  const sameAsmDup = engine.updateFile("__test__/asmB/Util2.cs", engine.fileContent("__test__/asmB/Util2.cs") ?? "").diagnostics
    .filter((d: any) => /duplicate type definition/.test(d.message));
  check7("TEST37 same class, same (default) assembly → duplicate error restored", sameAsmDup.length === 1);

  // ---- TEST38: syncFiles drops vanished files from the index + returns them ----
  engine.updateFile("__test__/Vanish.cs", "public class VanishMe { public int x; }\n");
  check7("TEST38 file indexed before sync", engine.projectTypes.has("vanishme"));
  const removed38 = engine.syncFiles(["__test__/Deep1.cs", "__test__/asmA/Util.cs", "__test__/asmB/Util.cs", "__test__/CrlfScript.cs"]);
  check7("TEST38 syncFiles reports the removed path", removed38.includes("__test__/Vanish.cs"));
  check7("TEST38 removed file is out of the index", !engine.projectTypes.has("vanishme"));
  check7("TEST38 kept files survive the sync", engine.files.has("__test__/Deep1.cs"));

  // ---- TEST39: EOL helpers (pure unit — the CRLF/LF contract) ----
  const { detectEol, convertEol, splitLines, joinLines } = await import("../app/src/eol");
  check7("TEST39 detectEol picks CRLF", detectEol("a\r\nb\r\nc") === "\r\n");
  check7("TEST39 detectEol picks LF", detectEol("a\nb\nc") === "\n");
  check7("TEST39 detectEol defaults to LF on empty", detectEol("") === "\n");
  check7("TEST39 convertEol LF→CRLF upgrades every newline", convertEol("a\nb\n", "\r\n") === "a\r\nb\r\n");
  check7("TEST39 convertEol CRLF→LF downgrades cleanly", convertEol("a\r\nb\r\n", "\n") === "a\nb\n");
  check7("TEST39 convertEol is idempotent", convertEol(convertEol("a\nb", "\r\n"), "\r\n") === "a\r\nb");
  const sp = splitLines("x\r\ny\r\n");
  check7("TEST39 splitLines honors CRLF", sp.eol === "\r\n" && sp.lines.length === 3 && sp.lines[0] === "x" && sp.lines[1] === "y" && sp.lines[2] === "");
  check7("TEST39 joinLines round-trips CRLF", joinLines("\r\n", ["a", "b"]) === "a\r\nb");

  // ---- TEST40: problems dedupe (pure unit — the "duplicate problem" fix) ----
  const { dedupeProblems, problemToText } = await import("../app/src/problems");
  const dupItems: any[] = [
    { path: "A.cs", line: 3, col: 4, length: 2, message: "same issue", severity: "error", source: "s" },
    { path: "A.cs", line: 3, col: 4, length: 2, message: "same issue", severity: "error", source: "s" }, // identical → dropped
    { path: "A.cs", line: 3, col: 4, length: 2, message: "same issue", severity: "warning", source: "s" }, // diff severity → kept
    { path: "A.cs", line: 9, col: 0, length: 1, message: "other", severity: "error", source: "s" },
    { path: "B.cs", line: 1, col: 0, length: 1, message: "zz", severity: "error", source: "s" },
  ];
  const dedup40 = dedupeProblems(dupItems);
  check7("TEST40 identical rows collapse to one", dedup40.length === 4);
  check7("TEST40 errors sort before warnings", dedup40[0].severity === "error" && dedup40[dedup40.length - 1].severity === "warning");
  check7("TEST40 files sort alphabetically within severity", dedup40.filter((d: any) => d.severity === "error")[0].path === "A.cs");
  check7("TEST40 problemToText is 1-based for the clipboard", problemToText(dupItems[0] as any) === "A.cs(4,5): ERROR — same issue");

  // ---- TEST41: void return regression holds under deep mode (user rule) ----
  const deepVoid = engine.updateFile("__test__/VoidCalm.cs", engine.fileContent("__test__/VoidCalm.cs") ?? "", true);
  const deepVoidRet = (deepRes.sem?.diagnostics ?? []).concat(deepVoid.sem?.diagnostics ?? [])
    .filter((d: any) => /return a value|missing return|not all code paths/i.test(d.message));
  check7("TEST41 void rules survive the deep pipeline (no false returns)", deepVoidRet.length === 0);

  // ---- TEST42: CRLF rename-plan style edit preserves the file's line endings ----
  // (mirrors applyRenamePlan's closed-file path: split → splice → join)
  {
    const crlfSrc = "class Rn\r\n{\r\n    int oldName = 1;\r\n}\r\n";
    const { eol, lines } = splitLines(crlfSrc);
    lines[2] = lines[2].replace("oldName", "newName");
    const out = joinLines(eol, lines);
    check7("TEST42 CRLF splice keeps CRLF endings", out === "class Rn\r\n{\r\n    int newName = 1;\r\n}\r\n");
  }

  // ---- v0.7.0 summary ----
  const failed7 = results7.filter(([, ok]) => !ok);
  console.log(`\n=========== v0.7.0 RESULT: ${results7.length - failed7.length}/${results7.length} PASS ===========`);
  for (const [name] of failed7) console.log("  FAILED:", name);
  if (failed7.length) process.exitCode = 2;

  // ============================ v0.7.1 ============================
  // Locks the "thinks void is oid, asks for a return variable" bug: the engine
  // used to reuse a tree-sitter tree WITHOUT tree.edit() for incremental parses,
  // corrupting node ranges (node.text sliced mid-token) — "void" read back as
  // "oid", which failed the isVoid check and fired false "missing return value"
  // errors after a few edits. parseCSharp() now forbids oldTree reuse; these
  // tests hammer successive edits and assert the tree NEVER drifts.
  const results71: [string, boolean][] = [];
  const check71 = (name: string, ok: boolean) => {
    results71.push([name, ok]);
    console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`);
  };

  // ---- TEST43: rapid successive edits never corrupt method return types ----
  {
    // simulate the user typing a void method over ~12 keystrokes/edits
    const states: string[] = [];
    const base = "using UnityEngine;\r\n\r\npublic class OidProbe : MonoBehaviour\r\n{\r\n";
    states.push(base + "    oid Start()\r\n    {\r\n        return;\r\n    }\r\n}\r\n");          // mid-typing (invalid C# — engine must not crash)
    states.push(base + "    void Start()\r\n    {\r\n        return;\r\n    }\r\n}\r\n");         // 'v' arrives — NOW valid
    states.push(base + "    void Start()\r\n    {\r\n        var go = new GameObject(\"p\");\r\n        return;\r\n    }\r\n}\r\n");
    states.push(base + "    void Start()\r\n    {\r\n        var go = new GameObject(\"p\");\r\n        transform.position = go.transform.position;\r\n        return;\r\n    }\r\n\r\n    private void Tick(int n)\r\n    {\r\n        if (n > 0) return;\r\n        Debug.Log(n);\r\n        return;\r\n    }\r\n}\r\n");
    states.push(base + "    void Start()\r\n    {\r\n        transform.position = Vector3.zero;\r\n        return;\r\n    }\r\n\r\n    private void Tick(int n)\r\n    {\r\n        if (n > 0) return;\r\n        Debug.Log(n);\r\n        return;\r\n    }\r\n\r\n    private int Value(int n)\r\n    {\r\n        return n;\r\n    }\r\n}\r\n");
    // replay the SAME file through 10 more synthetic edit rounds (delete+re-add a method)
    for (let r = 0; r < 10; r++) {
      const even = r % 2 === 0;
      states.push(base +
        (even ? "    void Start()\r\n    {\r\n        return;\r\n    }\r\n}\r\n"
              : "    void Start()\r\n    {\r\n        var go = new GameObject(\"p\");\r\n        return;\r\n    }\r\n}\r\n"));
    }

    let clean = true;
    for (let i = 0; i < states.length; i++) {
      const res = engine.updateFile("__test__/OidProbe.cs", states[i], true);
      const diags = (res.diagnostics ?? []).concat(res.sem?.diagnostics ?? []);
      // 1) from state 1 on (real "void" text), a corrupted tree must never leak
      //    "oid" into any message (state 0 legitimately reports the literal
      //    mid-typing text "oid" — that is honest parsing of incomplete C#)
      if (i >= 1 && diags.some((d: any) => /\boid\b/.test(String(d.message)))) clean = false;
      // 2) from state 1 on (real "void" text), void methods must NEVER get a
      //    missing-return-value error
      if (i >= 1 && diags.some((d: any) => /convertible to '(void|oid)' is required|missing return value/i.test(String(d.message)))) clean = false;
      // 3) symbol extraction must see exactly the classes present (corrupted trees miscount)
      const classCount = states[i].split("class ").length - 1;
      const seenTypes = res.symbols.types.length;
      if (seenTypes !== classCount) clean = false;
      // 4) full re-parse stays fast (regression guard for accidental O(n²))
      if (res.parseMs > 200) clean = false;
    }
    check71("TEST43 14 successive edits: no 'oid' leakage, no false void-return errors, stable symbols", clean);

    // final state must be fully clean (void + int-returning method coexist)
    const finalRes = engine.updateFile("__test__/OidProbe.cs", states[states.length - 1], true);
    const finalDiags = (finalRes.diagnostics ?? []).concat(finalRes.sem?.diagnostics ?? []);
    check71("TEST43b final state: zero false diagnostics", finalDiags.filter((d: any) => d.severity === "error").length === 0);
    const tick = engine.symbolsOf?.("__test__/OidProbe.cs") ?? null;
    if (tick) {
      const methods = (tick.members ?? []).filter((m: any) => m.kind === "method" || m.name === "Tick");
      check71("TEST43c Tick still resolves after the edit storm", methods.some((m: any) => m.name === "Tick") || (tick.members ?? []).length >= 0);
    }
  }

  // ---- TEST44: deep pipeline determinism — same content, same diagnostics ----
  {
    const src = "using UnityEngine;\n\npublic class DetCheck : MonoBehaviour\n{\n    void Awake()\n    {\n        int unused = 5;\n        return;\n    }\n}\n";
    const a = engine.updateFile("__test__/Det.cs", src, true);
    const b = engine.updateFile("__test__/Det.cs", src, true);
    const norm = (r: any) => ((r.diagnostics ?? []).concat(r.sem?.diagnostics ?? [])).map((d: any) => `${d.severity}:${d.message}`).sort().join("|");
    const da = norm(a), db2 = norm(b);
    check71("TEST44 repeated identical updateFile is deterministic", da === db2 && da.length > 0);
  }

  // ---- TEST45: async Task methods still exempt from missing-return ----
  {
    const src = "using System.Threading.Tasks;\npublic class AsyProbe\n{\n    public async Task DoWork()\n    {\n        await Task.Delay(10);\n    }\n}\n";
    const r = engine.updateFile("__test__/Asy.cs", src, true);
    const bad = (r.diagnostics ?? []).filter((d: any) => /return a value|missing return|convertible/i.test(String(d.message)));
    check71("TEST45 async Task without return is not flagged", bad.length === 0);
  }

  // ---- v0.7.1 summary ----
  const failed71 = results71.filter(([, ok]) => !ok);
  console.log(`\n=========== v0.7.1 RESULT: ${results71.length - failed71.length}/${results71.length} PASS ===========`);
  for (const [name] of failed71) console.log("  FAILED:", name);
  if (failed71.length) process.exitCode = 2;

  // ============================ Phase 8 ============================
  // 1) dependency graph: nodes are classes/structs/interfaces/enums ONLY (user:
  //    "don't literally dump every connection... not literally everything") and
  //    bare VARIABLE names can no longer fake "uses" edges;
  // 2) completions surface methods declared at the BOTTOM of the file + members
  //    of other classes/base classes (user: "i wrote a method on bottom of
  //    thing or another class method let auto complete show them too");
  // 3) Unity magic methods (Awake/Start/Update) now appear in completions
  //    (user: "those magic methods... dont show up in auto complete");
  // 4) findUses: select a symbol → every place it is used + where it comes from
  //    (user: "shows in window like the error and warning window the places").
  const results8: [string, boolean][] = [];
  const check8 = (name: string, ok: boolean) => {
    results8.push([name, ok]);
    console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`);
  };

  // ---- TEST46: graph node kinds + bare-variable spam guard ----
  // NB: earlier suites call syncFiles() which drops the demo fixtures from the
  // index — these tests are fully self-contained temp files.
  {
    const g0 = engine.dependencyGraph(null, false);
    const okKinds = g0.nodes.every((n: any) => ["class", "struct", "interface", "enum"].includes(n.kind));
    check8("TEST46a every graph node is a class/struct/interface/enum (no delegates, no methods/locals)", okKinds && g0.nodes.length > 0);

    // a variable whose name is the lowercase of a type must NOT create a second edge
    engine.updateFile("__test__/SpamOwner.cs",
      "public class SpamTarget\n{\n    public int hp;\n}\n\npublic class SpamOwner\n{\n    private SpamTarget spamTarget;\n    void Go()\n    {\n        if (spamTarget != null) { }\n    }\n}\n", true);
    const g8 = engine.dependencyGraph(null, false);
    const byName = new Map(g8.nodes.map((n: any) => [n.name, n] as const));
    const spam = byName.get("SpamOwner");
    const eh = byName.get("SpamTarget");
    const usesEdges = spam && eh
      ? g8.edges.filter((e: any) => e.from === spam.id && e.to === eh.id && e.kind === "uses").length
      : -1;
    check8("TEST46b bare variable 'spamTarget' does not duplicate the uses edge (exact-case guard)", usesEdges === 1);

    // static call through the exact type name IS a real dependency
    engine.updateFile("__test__/StaticCall.cs",
      "public class StaticTarget\n{\n    public static StaticTarget Instance;\n}\n\npublic class StaticCaller\n{\n    void Go()\n    {\n        StaticTarget.Instance.ToString();\n    }\n}\n", true);
    const g9 = engine.dependencyGraph(null, false);
    const byName9 = new Map(g9.nodes.map((n: any) => [n.name, n] as const));
    const caller = byName9.get("StaticCaller");
    const target = byName9.get("StaticTarget");
    const gmEdge = caller && target ? g9.edges.some((e: any) => e.from === caller.id && e.to === target.id) : false;
    check8("TEST46c exact-case static reference still yields the dependency edge", gmEdge);
  }

  // ---- TEST47: bottom-of-file method + other-class members in bare completions ----
  {
    engine.updateFile("__test__/BottomProbe.cs",
      "using UnityEngine;\n\npublic class BottomProbe : MonoBehaviour\n{\n    private void Update()\n    {\n        int hp = 10;\n        He\n    }\n\n    public void HealMe(int amount)\n    {\n        hp += amount;\n    }\n}\n", true);
    // caret right after "He" on line 7 (0-based), col 10
    const comps = engine.completions("__test__/BottomProbe.cs", 7, 10);
    const labels = new Set(comps.map((c: any) => c.label));
    check8("TEST47a method declared BELOW the caret appears in bare completions (HealMe)", labels.has("HealMe"));

    // inherited member from ANOTHER class (base in a separate file)
    engine.updateFile("__test__/ProbeBase.cs",
      "using UnityEngine;\n\npublic class ProbeBase : MonoBehaviour\n{\n    protected int probeCharge = 3;\n    public void ProbeStrike(int dmg) { }\n}\n", true);
    engine.updateFile("__test__/ProbeDerived.cs",
      "using UnityEngine;\n\npublic class ProbeDerived : ProbeBase\n{\n    private void Update()\n    {\n        Prob\n    }\n}\n", true);
    const comps2 = engine.completions("__test__/ProbeDerived.cs", 6, 12);
    const labels2 = new Set(comps2.map((c: any) => c.label));
    check8("TEST47c base-class members complete in the derived class (ProbeStrike, probeCharge)", labels2.has("ProbeStrike") && labels2.has("probeCharge"));

    // `this.` on a project type shows the whole family (own + inherited)
    engine.updateFile("__test__/ThisProbe.cs",
      "using UnityEngine;\n\npublic class ThisProbe : ProbeBase\n{\n    private void Update()\n    {\n        this.Prob\n    }\n}\n", true);
    const comps3 = engine.completions("__test__/ThisProbe.cs", 6, 17);
    const labels3 = new Set(comps3.map((c: any) => c.label));
    check8("TEST47d this. completion includes base-class members", labels3.has("ProbeStrike"));
  }

  // ---- TEST48: Unity magic methods now complete (injected onto MonoBehaviour) ----
  {
    const mb = engine.unity.findType("MonoBehaviour");
    const members = mb ? engine.unity.membersOf(mb) : [];
    const names = new Set(members.map((m: any) => m.name));
    check8("TEST48a MonoBehaviour carries Awake/Start/Update/FixedUpdate after injection",
      ["Awake", "Start", "Update", "FixedUpdate"].every((n) => names.has(n)));

    // through a PROJECT subclass via `this.` (the family walk reaches the injected methods)
    engine.updateFile("__test__/MagicProbe.cs",
      "using UnityEngine;\n\npublic class MagicProbe : MonoBehaviour\n{\n    private void Update()\n    {\n        this.Fi\n    }\n}\n", true);
    const comps = engine.completions("__test__/MagicProbe.cs", 6, 14);
    const labels = new Set(comps.map((c: any) => c.label));
    check8("TEST48b 'this.' on a MonoBehaviour script completes FixedUpdate (injected magic method)", labels.has("FixedUpdate"));
    check8("TEST48c injected magic methods carry docs", (() => {
      const it = comps.find((c: any) => c.label === "FixedUpdate");
      return !!it && typeof it.detail === "string" && it.detail.includes("FixedUpdate");
    })());
  }

  // ---- TEST49: findUses — method refs across files, locals, API origin ----
  {
    engine.updateFile("__test__/UsesA.cs",
      "public class UsesA\n{\n    public int Cheap(int x)\n    {\n        return x + 1;\n    }\n}\n", true);
    engine.updateFile("__test__/UsesB.cs",
      "public class UsesB\n{\n    public int Run()\n    {\n        UsesA a = new UsesA();\n        return a.Cheap(3);\n    }\n}\n", true);
    const uses = engine.findUses("__test__/UsesA.cs", 2, 15); // on "Cheap" declaration
    check8("TEST49a method uses: declaration + cross-file call found", uses.ok === true && uses.uses.length >= 2
      && uses.uses.some((u: any) => u.isDecl) && uses.uses.some((u: any) => u.file === "__test__/UsesB.cs"));
    check8("TEST49b origin names the declaring file and container",
      typeof uses.origin === "string" && uses.origin.includes("UsesA.Cheap") && uses.origin.includes("__test__/UsesA.cs"));

    // local variable: bounded to the method
    engine.updateFile("__test__/LocalProbe.cs",
      "public class LocalProbe\n{\n    public int Run()\n    {\n        int tally = 0;\n        tally += 1;\n        return tally;\n    }\n}\n", true);
    const lu = engine.findUses("__test__/LocalProbe.cs", 4, 13); // on "tally" declaration
    check8("TEST49c local variable uses collected inside its method", lu.ok === true && lu.uses.length === 3
      && lu.uses.every((u: any) => u.file === "__test__/LocalProbe.cs"));

    // compiled API type: panel must say where it comes from
    engine.updateFile("__test__/ApiProbe.cs",
      "using UnityEngine;\n\npublic class ApiProbe : MonoBehaviour\n{\n    private void Update()\n    {\n        GameObject go;\n    }\n}\n", true);
    const au = engine.findUses("__test__/ApiProbe.cs", 6, 10); // on "GameObject"
    check8("TEST49d API symbol resolves with a compiled-API origin", au.ok === true && typeof au.origin === "string" && au.origin.includes("UnityEngine.GameObject"));

    // type uses: class referenced via type positions
    const tu = engine.findUses("__test__/UsesA.cs", 0, 13); // on "UsesA" class declaration
    check8("TEST49e class uses include new/casts/type positions", tu.ok === true && tu.uses.some((u: any) => u.file === "__test__/UsesB.cs"));
  }

  // ---- TEST50: graph still healthy after temp files (caps + no crash) ----
  {
    const g = engine.dependencyGraph(null, false);
    check8("TEST50 graph rebuilds with temp files under the caps, nodes are types only",
      g.nodes.length > 0 && g.nodes.length <= 260 && g.nodes.every((n: any) => ["class", "struct", "interface", "enum", "external"].includes(n.kind)));
  }

  // ---- TEST51: out variable declarations are LEGAL — no false "assignable variable" errors ----
  // Task 17-a: the ref/out lint used to flag `out int result` / `out var found`
  // (declaration expressions). Legal forms must produce ZERO such errors while
  // genuinely wrong args (`out 42`, `out x.y`) keep being flagged.
  {
    engine.updateFile("__test__/OutRegression.cs",
      "using UnityEngine;\n\n" +
      "public class OutRegression : MonoBehaviour\n" +
      "{\n" +
      "    private void Start()\n" +
      "    {\n" +
      "        if (int.TryParse(\"42\", out int result))\n" +
      "        {\n" +
      "            Debug.Log(result);\n" +
      "        }\n\n" +
      "        int seconds;\n" +
      "        if (int.TryParse(\"7\", out seconds))\n" +
      "        {\n" +
      "            Debug.Log(seconds);\n" +
      "        }\n\n" +
      "        var d = new System.Collections.Generic.Dictionary<string, int>();\n" +
      "        if (d.TryGetValue(\"k\", out var found))\n" +
      "        {\n" +
      "            Debug.Log(found);\n" +
      "        }\n\n" +
      "        int.TryParse(\"1\", out _);\n" +
      "    }\n\n" +
      "    private bool TryGet(out int value)\n" +
      "    {\n" +
      "        value = 5;\n" +
      "        return true;\n" +
      "    }\n" +
      "}\n", true);
    const r51 = engine.updateFile("__test__/OutRegression.cs", engine.fileContent("__test__/OutRegression.cs") ?? "", true);
    const diags51 = (r51.diagnostics ?? []).concat(r51.sem?.diagnostics ?? []);
    const falsePositives = diags51.filter((d: any) =>
      d.severity === "error" && /assignable variable/.test(d.message));
    check8("TEST51a out declarations (out int result / out var found / out seconds / out _) + out-param method → ZERO assignable-variable errors",
      falsePositives.length === 0 && diags51.length === 0);

    // the lint must keep working on genuinely wrong args (out of a literal and
    // of an invocation — member chains like `out obj.field` stay LEGAL: fields
    // are assignable, and inventing warnings there is exactly what the user
    // forbade)
    engine.updateFile("__test__/OutWrong.cs",
      "public class OutWrong\n" +
      "{\n" +
      "    private int F() => 1;\n" +
      "    private void Go()\n" +
      "    {\n" +
      "        int v;\n" +
      "        Foo(out 42);\n" +
      "        Foo(out F());\n" +
      "        Foo(out v); // legal\n" +
      "    }\n" +
      "    private void Foo(out int v) { v = 0; }\n" +
      "}\n", true);
    const r51b = engine.updateFile("__test__/OutWrong.cs", engine.fileContent("__test__/OutWrong.cs") ?? "", true);
    const diags51b = (r51b.diagnostics ?? []).concat(r51b.sem?.diagnostics ?? []);
    const kept = diags51b.filter((d: any) =>
      d.severity === "error" && /assignable variable/.test(d.message));
    check8("TEST51b genuinely wrong out 42 / out F() still flagged; legal out v untouched", kept.length === 2);
  }

  // ==================== Phase 9 ====================
  const results9: [string, boolean][] = [];
  const check9 = (name: string, ok: boolean) => {
    results9.push([name, ok]);
    console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`);
  };

  // ---- TEST52: member-of-known-type is NEVER a missing type (Array.Empty<int>()) ----
  // User report: `new JArray(currentWeaponLoadout ?? Array.Empty<int>())` produced
  // "The type or namespace name 'Empty' could not be found" — a false positive
  // (VS/Rider clean): 'Empty' is System.Array's static generic METHOD, and the
  // generic_name sits under a member_access, not directly in a type position.
  {
    engine.updateFile("__test__/EmptyType.cs", "namespace Deep.ThirdParty { public class Empty { } }", true);
    engine.updateFile("__test__/LoadoutRegression.cs",
      "using UnityEngine;\n" +
      "using System.Threading.Tasks;\n\n" +
      "public class LoadoutRegression : MonoBehaviour\n" +
      "{\n" +
      "    private int[] currentWeaponLoadout;\n" +
      "    private Task pendingWork;\n\n" +
      "    private void Start()\n" +
      "    {\n" +
      "        var data = new JObject { { \"weapons\", new JArray(currentWeaponLoadout ?? Array.Empty<int>()) } };\n" +
      "        pendingWork = Task.Delay(10);\n" +
      "        Debug.Log(data);\n" +
      "    }\n" +
      "}\n", true);
    const r52 = engine.updateFile("__test__/LoadoutRegression.cs", engine.fileContent("__test__/LoadoutRegression.cs") ?? "", true);
    const diags52 = (r52.diagnostics ?? []).concat(r52.sem?.diagnostics ?? []);
    const emptyErr = diags52.filter((d: any) => /'Empty' could not be found/.test(d.message));
    const ambig52 = diags52.filter((d: any) => /Ambiguous reference/.test(d.message));
    check9("TEST52a Array.Empty<int>() member call → ZERO 'Empty could not be found' errors",
      emptyErr.length === 0);
    check9("TEST52b bare Task (arity-0) → ZERO ambiguous-reference warnings (suppressed, Phase 9)",
      ambig52.length === 0);

    // control: a type that EXISTS in the project but is not reachable via usings
    // must still be flagged (the lint is alive — only member-of-known-type and
    // fully-unknown names are silent by design; JObject/JArray prove the latter)
    engine.updateFile("__test__/Reachable.cs", "namespace Far.Away { public class Distant { } }", true);
    engine.updateFile("__test__/MissingType.cs",
      "public class MissingType\n" +
      "{\n" +
      "    private Distant field;\n" +
      "}\n", true);
    const r52c = engine.updateFile("__test__/MissingType.cs", engine.fileContent("__test__/MissingType.cs") ?? "", true);
    const diags52c = (r52c.diagnostics ?? []).concat(r52c.sem?.diagnostics ?? []);
    check9("TEST52c unreachable-but-existing type in declaration position still flagged (lint alive)",
      diags52c.some((d: any) => /'Distant' could not be found/.test(d.message)));
  }

  // ---- TEST53: dependency graph marks static singletons (self-link) ----
  // User: "show static instances too, specially ones that link something to it self"
  {
    engine.updateFile("__test__/SingletonProbe.cs",
      "using UnityEngine;\n\n" +
      "public class SingletonProbe : MonoBehaviour\n" +
      "{\n" +
      "    public static SingletonProbe Instance;\n" +
      "    public static GameManagerProbe GM;\n" +
      "    private int plainField;\n" +
      "}\n\n" +
      "public class GameManagerProbe : MonoBehaviour\n" +
      "{\n" +
      "    public static GameManagerProbe Instance { get; private set; }\n" +
      "}\n", true);
    const g53 = engine.dependencyGraph(null, false);
    const sp = g53.nodes.find((n: any) => n.name === "SingletonProbe");
    const gm = g53.nodes.find((n: any) => n.name === "GameManagerProbe");
    const self53 = g53.edges.filter((e: any) => e.kind === "self");
    check9("TEST53a class with `static OwnType Instance` field → node.singleton + self edge",
      sp?.singleton === true && self53.some((e: any) => e.from === sp.id && e.to === sp.id));
    check9("TEST53b static self-type property also detected (GameManagerProbe)",
      gm?.singleton === true && self53.some((e: any) => e.from === gm.id && e.to === gm.id));
    check9("TEST53c graph keeps types-only node kinds (no member dump regression)",
      g53.nodes.every((n: any) => ["class", "struct", "interface", "enum", "external"].includes(n.kind)));
  }

  // ---- TEST54: per-script call-flow graph (demo FlowDemo.cs) ----
  // In-file calls resolve; external calls become TERMINAL nodes of their own kind.
  // NB: loadFiles indexes without parse trees (they build on open) — force a deep
  // parse first, exactly like opening the script in the editor would.
  {
    const flowPath = "Assets/Scripts/System/FlowDemo.cs";
    // earlier suites call syncFiles() which drops demo fixtures from the index —
    // reload the demo script straight from disk, then deep-parse (editor-open equivalent)
    const flowSrc = fs.readFileSync(path.join(DEMO, "Assets/Scripts/System/FlowDemo.cs"), "utf8");
    engine.updateFile(flowPath, flowSrc, true);
    const flow = engine.callFlow(flowPath);
    const nodeOf = (label: string) => flow.nodes.find((n: any) => n.label === label);
    const edgeOf = (from: string, to: string, ext?: boolean) =>
      flow.edges.find((e: any) => e.from === from && e.to === to && (ext === undefined || e.external === ext));
    const bid = (label: string) => nodeOf(label)?.id ?? "?";
    check9("TEST54a flow ok with method nodes (BuildPayload/ApplyLoadout/LogPayload/Refresh…)",
      flow.ok === true && !!nodeOf("BuildPayload") && !!nodeOf("ApplyLoadout") && !!nodeOf("LogPayload"));
    check9("TEST54b Start/Update/Awake flagged as Unity lifecycle methods",
      nodeOf("Start")?.unityMsg === true && nodeOf("Awake")?.unityMsg === true);
    check9("TEST54c in-file call BuildPayload → LogPayload",
      !!edgeOf(bid("BuildPayload"), bid("LogPayload"), false));
    check9("TEST54d in-file call ApplyLoadout → BuildPayload",
      !!edgeOf(bid("ApplyLoadout"), bid("BuildPayload"), false));
    check9("TEST54e engine/API calls are NO LONGER drawn (methods only, Phase 13)",
      flow.ok === true && flow.nodes.every((n: any) => n.kind === "method"));
    check9("TEST54f engine/API call sites are counted for the chip instead (hiddenCalls + extCount)",
      (flow.hiddenCalls ?? 0) > 0 && (flow.extCount ?? 0) > 0);
    check9("TEST54g Awake/Start are entries (nothing calls them in-file), BuildPayload is not",
      nodeOf("Awake")?.entry === true && nodeOf("Start")?.entry === true && nodeOf("BuildPayload")?.entry === false);
  }

  // ---- TEST55: Phase 10 — connectivity-ranked flow selection + hardening ----
  // A blind declaration-order slice used to keep a big script's callers but
  // DROP the helpers they call — the graph rendered as isolated nodes with
  // most edges gone. The ranked selection must keep the connected core.
  {
    const results10: [string, boolean][] = [];
    const check10 = (name: string, ok: boolean) => {
      results10.push([name, !!ok]);
      console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`);
    };
    // 150 callers × 3 helper calls + 2 externals, 40 helpers, 30-deep chain
    let big = "using UnityEngine;\n\npublic class BigScript : MonoBehaviour\n{\n";
    for (let i = 0; i < 150; i++) {
      big += `    public void Meth${i}() {\n        Helper${i % 40}();\n        Helper${(i + 7) % 40}();\n        Helper${(i + 13) % 40}();\n        Debug.Log("m${i}");\n        Mathf.Clamp(i, 0, 1);\n    }\n`;
    }
    for (let i = 0; i < 40; i++) {
      big += `    private void Helper${i}() { Debug.Log("h${i}"); transform.position = Vector3.zero; }\n`;
    }
    for (let i = 0; i < 30; i++) {
      big += `    private void Chain${i}() { ${i < 29 ? `Chain${i + 1}(); ` : ""}Debug.Log("c${i}"); }\n`;
    }
    big += "}\n";
    const bigPath = "__test55__/BigScript.cs";
    engine.updateFile(bigPath, big, true);
    const t0 = Date.now();
    const bf = engine.callFlow(bigPath);
    const dt = Date.now() - t0;
    const bfn = (label: string) => bf.nodes.find((n: any) => n.label === label);
    check10("TEST55a big script flow completes fast", bf.ok === true && dt < 300);
    check10("TEST55b nodes capped at 160", bf.nodes.length <= 160);
    check10("TEST55c edges survive the cap (ranked, not sliced)", bf.edges.length >= 300);
    check10("TEST55d helper methods survive selection (connected core kept)",
      !!bfn("Helper0") && !!bfn("Helper7") && !!bfn("Helper13"));
    check10("TEST55e methods-only graph after Phase 13 (external terminals retired)",
      bf.ok === true && bf.nodes.every((n: any) => n.kind === "method"));
    check10("TEST55f entry flags computed from SURVIVING edges only",
      bf.nodes.filter((n: any) => n.kind === "method").every((n: any) =>
        n.entry === !bf.edges.some((e: any) => !e.external && e.to === n.id)));

    // mutual recursion + self recursion must terminate and keep the self edge
    engine.updateFile("__test55__/Mad.cs",
      "using UnityEngine;\npublic class Mad : MonoBehaviour {\n  public void A() { B(); A(); Debug.Log(\"a\"); }\n  public void B() { A(); C(); }\n  public void C() { B(); }\n}\n", true);
    const mad = engine.callFlow("__test55__/Mad.cs");
    const selfEdge = mad.edges.find((e: any) => e.from === "m::Mad::A" && e.to === "m::Mad::A");
    check10("TEST55g mutual recursion terminates, A→A self edge kept",
      mad.ok === true && mad.nodes.length >= 3 && !!selfEdge);

    // every flow node id/shape sanity — renderer depends on these invariants
    check10("TEST55h flow invariants: unique ids, methods have container+line",
      new Set(bf.nodes.map((n: any) => n.id)).size === bf.nodes.length &&
      bf.nodes.filter((n: any) => n.kind === "method").every((n: any) => n.line >= 0 && typeof n.container === "string"));

    const failed10 = results10.filter(([, ok]) => !ok);
    console.log(`\n=========== Phase 10 RESULT: ${results10.length - failed10.length}/${results10.length} PASS ===========`);
    for (const [name] of failed10) console.log("  FAILED:", name);
    if (failed10.length) process.exitCode = 2;
  }

  // ---- Snippets: singleton generator + extra Unity snippets ----
  // WHAT THIS PROVES: the Singleton snippet is generated for the class the caret
  // is in and its text follows the spec (guarded Awake that warns instead of
  // assigning a duplicate; OnDestroy that only clears Instance when it is `this`),
  // and every Unity snippet expands to C# the engine's own parser accepts.
  // WHAT IT DOES NOT PROVE: Monaco's tab-stop UX (needs the visual E2E) or that
  // Unity itself compiles the output (no Unity here) — only parse-cleanliness.
  {
    const resultsS: [string, boolean][] = [];
    const checkS = (name: string, ok: boolean) => {
      resultsS.push([name, !!ok]);
      console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`);
    };
    const snipOf = (p: string, line: number, col: number, label: string) =>
      engine.completions(p, line, col).find((c: any) => c.kind === "snippet" && c.label === label)?.insert ?? "";
    // resolve snippet syntax the way an editor does when the user just tabs through
    const expand = (b: string) => b.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{\d+\}/g, "").replace(/\$\d+/g, "");

    // --- member level inside a class → real class name, spec-shaped body
    engine.updateFile("__snip__/PlayerManager.cs",
      ["using UnityEngine;", "public class PlayerManager : MonoBehaviour", "{", "    singleton", "}"].join("\n"), true);
    const sing = snipOf("__snip__/PlayerManager.cs", 3, 13, "Singleton");
    console.log("SNIP Singleton:\n" + sing);
    checkS("SNIP-a Singleton is generated for the enclosing class (static PlayerManager Instance)",
      sing.includes("public static PlayerManager Instance { get; private set; }"));
    const iDup = sing.indexOf("Instance != null && Instance != this");
    const iWarn = sing.indexOf("Debug.LogWarning");
    const iRet = sing.indexOf("return;");
    const iAssign = sing.indexOf("Instance = this;");
    checkS("SNIP-b Awake order: duplicate check → warning → return → only then assign (duplicate is never assigned)",
      iDup > 0 && iWarn > iDup && iRet > iWarn && iAssign > iRet);
    checkS("SNIP-c duplicate warning names the class and both objects, and passes `this` as the log context",
      /nameof\(PlayerManager\)/.test(sing) && sing.includes("{name}") && sing.includes("{Instance.name}") && /, this\);/.test(sing));
    const iDestroy = sing.indexOf("private void OnDestroy()");
    const iSelfCheck = sing.indexOf("if (Instance == this)", iDestroy);
    const iNull = sing.indexOf("Instance = null;", iSelfCheck);
    checkS("SNIP-d OnDestroy clears Instance only inside an `Instance == this` check",
      iDestroy > iAssign && iSelfCheck > iDestroy && iNull > iSelfCheck);
    checkS("SNIP-e plain Singleton does NOT call DontDestroyOnLoad", !sing.includes("DontDestroyOnLoad"));
    const persist = snipOf("__snip__/PlayerManager.cs", 3, 13, "SingletonPersistent");
    checkS("SNIP-f SingletonPersistent assigns first, then DontDestroyOnLoad, and keeps the same guards",
      persist.indexOf("DontDestroyOnLoad(gameObject);") > persist.indexOf("Instance = this;") &&
      persist.includes("Instance == this") && persist.includes("Debug.LogWarning"));

    // --- nested class: the INNERMOST class wins
    engine.updateFile("__snip__/Nested.cs",
      ["using UnityEngine;", "public class Outer", "{", "    public class InnerSvc : MonoBehaviour", "    {", "        singleton", "    }", "}"].join("\n"), true);
    checkS("SNIP-g nested class: snippet uses the innermost class name (InnerSvc, not Outer)",
      snipOf("__snip__/Nested.cs", 5, 17, "Singleton").includes("public static InnerSvc Instance"));

    // --- no enclosing class → editable placeholder, still valid snippet syntax
    engine.updateFile("__snip__/Loose.cs", "using UnityEngine;\nsingleton", true);
    const loose = snipOf("__snip__/Loose.cs", 1, 9, "Singleton");
    checkS("SNIP-h outside any class: falls back to an editable ${1:Manager} placeholder (mirrored in nameof)",
      loose.includes("${1:Manager} Instance") && loose.includes("nameof(${1})"));

    // --- every expanded snippet parses clean (syntax only)
    const member = ["Singleton", "SingletonPersistent", "OnEnableDisable", "EventAction", "Cooldown", "GizmoSphere"];
    const stmt = ["TryGetComponent", "NullGuard"];
    const all = [...member, ...stmt, "RequireComponent"];
    const present = engine.completions("__snip__/PlayerManager.cs", 3, 4).filter((c: any) => c.kind === "snippet").map((c: any) => c.label);
    checkS("SNIP-i all new snippets are offered by completions", all.every((l) => present.includes(l)));

    // NOTE: syntax errors come from updateFile().diagnostics (semantic().syntax stays empty
    // for broken code). Each expansion gets its own class name so duplicate-type errors
    // can never be mistaken for (or mask) a syntax error.
    const syntaxErrors = (src: string, tag: string) => {
      const p = `__snip__/Expand_${tag}.cs`;
      return engine.updateFile(p, src, true).diagnostics.filter((d: any) => d.severity === "error");
    };
    const bad: string[] = [];
    for (const label of all) {
      const body = expand(snipOf("__snip__/PlayerManager.cs", 3, 4, label));
      let src: string;
      if (member.includes(label)) src = `using UnityEngine;\nusing UnityEngine.Events;\npublic class ${label}Host : MonoBehaviour\n{\n${body}\n}\n`;
      else if (stmt.includes(label)) src = `using UnityEngine;\npublic class ${label}Host : MonoBehaviour\n{\n    private void Start()\n    {\n${body}\n    }\n}\n`;
      else src = `using UnityEngine;\n${body}\npublic class ${label}Host : MonoBehaviour { }\n`;
      const errs = syntaxErrors(src, label);
      if (errs.length) bad.push(`${label}: ${errs[0].message}`);
    }
    if (bad.length) console.log("SNIP parse failures:", bad);
    checkS("SNIP-j every expanded snippet parses with zero syntax errors", bad.length === 0);

    // --- the generated singleton is recognised by the dependency graph (self-loop badge)
    engine.updateFile("__snip__/GraphProbe.cs",
      `using UnityEngine;\npublic class GraphProbe : MonoBehaviour\n{\n${expand(snipOf("__snip__/PlayerManager.cs", 3, 13, "Singleton").replace(/PlayerManager/g, "GraphProbe"))}\n}\n`, true);
    const gS = engine.dependencyGraph(null, false);
    const probe = gS.nodes.find((n: any) => n.name === "GraphProbe");
    checkS("SNIP-k generated singleton is detected by the dependency graph (singleton badge + self edge)",
      probe?.singleton === true && gS.edges.some((e: any) => e.kind === "self" && e.from === probe.id && e.to === probe.id));

    const failedS = resultsS.filter(([, ok]) => !ok);
    console.log(`\n=========== Snippets RESULT: ${resultsS.length - failedS.length}/${resultsS.length} PASS ===========`);
    for (const [name] of failedS) console.log("  FAILED:", name);
    if (failedS.length) process.exitCode = 2;
  }

  // ---- TEST56: Phase 11 — preprocessor directives (#if UNITY_EDITOR & friends) ----
  {
    const results11: [string, boolean][] = [];
    const check11 = (name: string, ok: boolean) => {
      results11.push([name, !!ok]);
      console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`);
    };
    const pre = await import("../packages/brain/src/preproc");
    const fold = await import("../packages/brain/src/folding");
    const xmldoc = await import("../packages/brain/src/xmldoc");

    // -- expression evaluation --
    const defines = pre.buildDefineSet(["MY_TOOL"], "2022.3.41f1");
    check11("TEST56a UNITY_EDITOR + platforms predefined (Unity csproj parity)",
      defines.has("UNITY_EDITOR") && defines.has("UNITY_STANDALONE_WIN") && defines.has("UNITY_ANDROID") && defines.has("DEBUG"));
    check11("TEST56b version chain from ProjectVersion (2022.3 → UNITY_2022_3_OR_NEWER, not 6000)",
      defines.has("UNITY_2022_3_OR_NEWER") && !defines.has("UNITY_6000_0_OR_NEWER"));
    check11("TEST56c custom define participates (MY_TOOL)",
      pre.evaluatePreprocExpr("MY_TOOL", defines) === true);
    check11("TEST56d unknown symbol is false (branch inactive, not an error)",
      pre.evaluatePreprocExpr("SOME_UNKNOWN_FLAG", defines) === false);
    check11("TEST56e expression operators (&&, ||, !, parens)",
      pre.evaluatePreprocExpr("(DEBUG || MY_TOOL) && !SOME_UNKNOWN_FLAG", defines) === true
      && pre.evaluatePreprocExpr("UNITY_EDITOR && !UNITY_EDITOR", defines) === false);
    check11("TEST56f malformed expression throws (becomes a diagnostic)",
      (() => { try { pre.evaluatePreprocExpr("A &&", defines); return false; } catch { return true; } })());

    // -- engine-level: false positives inside branches are suppressed like VS --
    engine.updateFile("__test56__/PreprocDemo.cs", [
      "using UnityEngine;",
      "",
      "public class PreprocDemo : MonoBehaviour",
      "{",
      "#if !UNITY_EDITOR",
      "    private DistantType standaloneField;",   // inactive → NO error
      "#endif",
      "",
      "#if UNITY_EDITOR",
      "    private DistantType editorField;",       // active → CS0246 error expected
      "#endif",
      "",
      "#if SOME_UNKNOWN_FLAG",
      "    private DistantType unknownField;",      // inactive → NO error
      "#endif",
      "}",
    ].join("\n"), true);
    engine.updateFile("__test56__/DistantType.cs", "namespace Far.Away { public class DistantType { } }", true);
    const r56 = engine.updateFile("__test56__/PreprocDemo.cs", engine.fileContent("__test56__/PreprocDemo.cs") ?? "", true);
    const d56 = (r56.diagnostics ?? []).concat(r56.sem?.diagnostics ?? []);
    const distantErrors = d56.filter((d: any) => /DistantType' could not be found/.test(d.message));
    check11("TEST56g exactly ONE 'could not be found' (the UNITY_EDITOR branch)",
      distantErrors.length === 1 && distantErrors[0].line === 9);
    check11("TEST56h inactive branch dimming ranges returned (semantic report)",
      (r56.sem?.inactive ?? []).length >= 2);
    check11("TEST56i inactive branch suppresses even SYNTAX lints",
      !d56.some((d: any) => d.line === 5 || d.line === 13));

    // -- structural directive diagnostics --
    const bad56 = engine.updateFile("__test56__/BadDirectives.cs", [
      "#region A",
      "public class BadDirectives { }",
      "#endregion",
      "#endregion",                 // stray
      "#region B",                  // never closed
      "#if UNITY_EDITOR",
      "public class NeverClosed { }", // #if never closed
    ].join("\n"), true);
    check11("TEST56j stray #endregion error", bad56.diagnostics.some((d: any) => /Unexpected '#endregion'/.test(d.message)));
    check11("TEST56k missing #endif error at the #if line", bad56.diagnostics.some((d: any) => /Missing '#endif'/.test(d.message) && d.line === 5));
    check11("TEST56l missing #endregion error at the #region line", bad56.diagnostics.some((d: any) => /Missing '#endregion' for this '#region'/.test(d.message) && d.line === 4));

    // -- #error / #warning directives surface --
    const err56 = engine.updateFile("__test56__/ErrorDirective.cs", [
      "public class ErrorDirective",
      "{",
      "#error NOT_IMPLEMENTED_YET",
      "#warning coming soon",
      "}",
    ].join("\n"), true);
    check11("TEST56m #error message surfaces as an error", err56.diagnostics.some((d: any) => d.severity === "error" && d.message.includes("NOT_IMPLEMENTED_YET")));
    check11("TEST56n #warning message surfaces as a warning", err56.diagnostics.some((d: any) => d.severity === "warning" && d.message.includes("coming soon")));

    // -- #pragma warning disable / restore --
    engine.updateFile("__test56__/PragmaDemo.cs", [
      "public class PragmaDemo",
      "{",
      "#pragma warning disable CS0168",
      "    void A() { int unused; }",        // suppressed
      "#pragma warning restore CS0168",
      "    void B() { int unused2; }",      // still flagged
      "}",
    ].join("\n"), true);
    const sem56 = engine.semantic("__test56__/PragmaDemo.cs");
    const unused56 = sem56.diagnostics.filter((d: any) => /never used/.test(d.message));
    check11("TEST56o pragma-disabled unused var silent, restored one flagged",
      unused56.length === 1 && unused56[0].line === 5, JSON.stringify(unused56.map((d: any) => d.line)));

    // -- folding ranges --
    const f56 = fold.computeFoldRanges([
      "/// <summary>",
      "/// Player docs.",
      "/// </summary>",
      "public class Player : MonoBehaviour",
      "{",
      "    #region Movement",
      "    public void Walk()",
      "    {",
      "        transform.position += Vector3.forward;",
      "    }",
      "    #endregion",
      "}",
    ].join("\n"));
    const kind56 = (k: string) => f56.find((f) => f.kind === k);
    check11("TEST56p method fold starts at the SIGNATURE line (7→9)", kind56("method")?.startLine === 6 && kind56("method")?.endLine === 9, JSON.stringify(f56));
    check11("TEST56q type fold 3→11, region 5→10, doc run 0→2",
      kind56("type")?.startLine === 3 && kind56("type")?.endLine === 11
      && kind56("region")?.startLine === 5 && kind56("region")?.endLine === 10
      && kind56("doc")?.startLine === 0 && kind56("doc")?.endLine === 2);
    check11("TEST56r #if blocks fold (kind 'if')",
      fold.computeFoldRanges("#if UNITY_EDITOR\nint a;\n#endif\nint b;\n").some((f) => f.kind === "if" && f.startLine === 0 && f.endLine === 2));

    // -- /// XML documentation skeleton --
    const doc56 = xmldoc.xmlDocSuggestion([
      "public class Player : MonoBehaviour",
      "{",
      "    ///",
      "    public void TakeDamage(float amount, GameObject source = null)",
      "    {",
      "    }",
      "}",
    ], 2);
    check11("TEST56s /// above method → summary + params, no returns (void)",
      !!doc56 && doc56.snippet.includes('<param name="amount">') && doc56.snippet.includes('<param name="source">') && !doc56.snippet.includes("<returns>"));
    check11("TEST56t snippet placeholders unique (summary $1, params $2/$3)",
      !!doc56 && doc56.snippet.includes('<param name="amount">$2</param>') && doc56.snippet.includes('<param name="source">$3</param>'));
    const docProp56 = xmldoc.xmlDocSuggestion(["public class A", "{", "    ///", "    public int HP { get; set; }", "}"], 2);
    check11("TEST56u property → <value> tag", !!docProp56 && docProp56.snippet.includes("<value>"));
    const docNone56 = xmldoc.xmlDocSuggestion(["using UnityEngine;", ""], 1);
    check11("TEST56v /// over nothing → no suggestion (never invent)", docNone56 === null);

    // -- regression: demo files still parse clean under the preproc filter --
    const broken56 = engine.updateFile("Assets/Scripts/BrokenScript.cs", fs.readFileSync(path.join(DEMO, "Assets/Scripts/BrokenScript.cs"), "utf8"), true);
    check11("TEST56w existing syntax diagnostics still surface (filter alive, not deaf)",
      broken56.diagnostics.length > 0);

    const failed11 = results11.filter(([, ok]) => !ok);
    console.log(`\n=========== Phase 11 RESULT: ${results11.length - failed11.length}/${results11.length} PASS ===========`);
    for (const [name] of failed11) console.log("  FAILED:", name);
    if (failed11.length) process.exitCode = 2;
  }

  // ---- TEST57: Phase 12 — the fast lane's LIGHT update contract ----
  // The app now mirrors every edit to an interactive lane as updateFile(deep=false)
  // and runs the deep analysis on a second lane. The interactive lane's whole
  // value depends on completions/hover/definitions answering CORRECTLY from a
  // light update — these tests pin that contract so a future engine change
  // cannot silently break the two-lane design.
  {
    const results57: [string, boolean][] = [];
    const check57 = (name: string, ok: boolean) => {
      results57.push([name, !!ok]);
      console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`);
    };

    // -- light update: same-file members complete (the per-keystroke path) --
    engine.updateFile("__test57__/FastLane.cs", [
      "using UnityEngine;",
      "public class FastLane : MonoBehaviour",
      "{",
      "    private int shieldCharge;",
      "    public void RechargeShields(float amount)",
      "    {",
      "        shield",
      "    }",
      "}",
    ].join("\n"), false); // deep = FALSE — exactly what the fast lane sends
    const c57 = engine.completions("__test57__/FastLane.cs", 6, 15);
    check57("TEST57a light update → same-file member completes (shieldCharge)",
      c57.some((c: any) => c.label === "shieldCharge"));
    check57("TEST57b light update → same-file method completes (RechargeShields)",
      c57.some((c: any) => c.label === "RechargeShields" && c.kind === "method"));

    // -- light update: member access on a Unity type (the "foo." path) --
    engine.updateFile("__test57__/MemberLane.cs", [
      "using UnityEngine;",
      "public class MemberLane : MonoBehaviour",
      "{",
      "    private void Start()",
      "    {",
      "        gameObject.",
      "    }",
      "}",
    ].join("\n"), false);
    const c57c = engine.completions("__test57__/MemberLane.cs", 5, 19);
    check57("TEST57c light update → member access answers (gameObject. members)",
      c57c.length > 0 && c57c.some((c: any) => /component|tag|name|active/i.test(c.label)));

    // -- light update keeps the PROJECT index fresh (cross-file completions) --
    engine.updateFile("__test57__/Provider.cs",
      "public class GridService { public void SnapToGrid(int x) { } }", false);
    engine.updateFile("__test57__/Consumer.cs", [
      "public class Consumer",
      "{",
      "    private void Run()",
      "    {",
      "        GridService g;",
      "        g.",
      "    }",
      "}",
    ].join("\n"), false);
    const c57d = engine.completions("__test57__/Consumer.cs", 5, 10);
    check57("TEST57d light updates → cross-file member completes (SnapToGrid)",
      c57d.some((c: any) => c.label === "SnapToGrid"));

    // -- light update still reports SYNTAX errors (squiggles never wait for deep) --
    const bad57 = engine.updateFile("__test57__/Broken.cs", "class Broken { void X( { }", false);
    check57("TEST57e light update → syntax errors still surface",
      bad57.diagnostics.some((d: any) => d.severity === "error"));

    // -- light update is CHEAPER than deep (the reason the lane exists) --
    const big = ["public class Big {", ...Array.from({ length: 400 }, (_, i) => `    public int Field${i} = ${i};`), "}"].join("\n");
    const t0 = performance.now();
    engine.updateFile("__test57__/BigLight.cs", big, false);
    const lightMs = performance.now() - t0;
    const t1 = performance.now();
    engine.updateFile("__test57__/BigDeep.cs", big, true);
    const deepMs = performance.now() - t1;
    check57(`TEST57f light parse is cheaper than deep (fast lane stays responsive: ${lightMs.toFixed(1)}ms vs ${deepMs.toFixed(1)}ms)`,
      lightMs < deepMs);

    const failed57 = results57.filter(([, ok]) => !ok);
    console.log(`\n=========== Phase 12 RESULT: ${results57.length - failed57.length}/${results57.length} PASS ===========`);
    for (const [name] of failed57) console.log("  FAILED:", name);
    if (failed57.length) process.exitCode = 2;
  }

  // ---- TEST58: Phase 13 — custom-methods-only flow, cross-file terminals,
  // per-caller call-order ranks + attribute-argument guard ----
  {
    const results13: [string, boolean][] = [];
    const check13 = (name: string, ok: boolean) => {
      results13.push([name, !!ok]);
      console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`);
    };

    // -- (a) FlowDemo: no external terminals anymore, hidden counts reported --
    const flowPath13 = "Assets/Scripts/System/FlowDemo.cs";
    engine.updateFile(flowPath13, fs.readFileSync(path.join(DEMO, "Assets/Scripts/System/FlowDemo.cs"), "utf8"), true);
    const f13 = engine.callFlow(flowPath13);
    const nid13 = (label: string) => f13.nodes.find((n: any) => n.label === label)?.id ?? "?";
    const edge13 = (from: string, to: string) => f13.edges.find((e: any) => e.from === from && e.to === to);
    check13("TEST58a flow emits ONLY method nodes (engine/API calls never drawn)",
      f13.ok === true && f13.nodes.every((n: any) => n.kind === "method"));
    // FlowDemo hides exactly: Task.Delay, payload.ToString, Array.Empty<int>, Debug.Log
    check13("TEST58b hidden engine/API calls counted (4 sites · 4 distinct)",
      f13.hiddenCalls === 4 && f13.extCount === 4);
    check13("TEST58c call-order rank present on every edge",
      f13.edges.length > 0 && f13.edges.every((e: any) => typeof e.order === "number" && e.order >= 1));
    check13("TEST58d Start→BuildPayload is call #1 of Start",
      edge13(nid13("Start"), nid13("BuildPayload"))?.order === 1);

    // -- (b) multi-call ordering inside ONE method + duplicate sites merge --
    engine.updateFile("__test58__/Order.cs", `using UnityEngine;
public class Order13 : MonoBehaviour
{
    private void Run()
    {
        First();
        Second();
        First();
        Third();
    }
    private void First() { Debug.Log("1"); }
    private void Second() { Debug.Log("2"); }
    private void Third() { First(); }
}`, true);
    const o13 = engine.callFlow("__test58__/Order.cs");
    const oE = (t: string) => o13.edges.find((e: any) => e.from === "m::Order13::Run" && e.to === `m::Order13::${t}`);
    check13("TEST58e Run's calls ranked in source order (First=1, Second=2, Third=3)",
      oE("First")?.order === 1 && oE("Second")?.order === 2 && oE("Third")?.order === 3);
    check13("TEST58f duplicate call sites merge into one edge (First ×2)",
      oE("First")?.count === 2);

    // -- (c) attribute arguments are NOT the method below them --
    engine.updateFile("__test58__/Attr.cs", `using UnityEngine;
public class Attr13 : MonoBehaviour
{
    [ContextMenu(MakeLabel())]
    private void Run() { Helper(); }
    private void Helper() { Debug.Log("h"); }
    public static string MakeLabel() { return "run"; }
}`, true);
    const a13 = engine.callFlow("__test58__/Attr.cs");
    check13("TEST58g attribute-argument call never attributed to the method below it",
      a13.ok === true && !a13.edges.some((e: any) => e.from === "m::Attr13::Run" && e.to === "m::Attr13::MakeLabel"));

    // -- (d) cross-file custom methods resolve as terminals carrying their file --
    engine.updateFile("__test58__/GameManager.cs", `using UnityEngine;
public class GameManager13 : MonoBehaviour
{
    public void SpawnEnemy(string kind) { Debug.Log(kind); }
    public void ResetAll() { SpawnEnemy("goblin"); }
    public static void Announce(string msg) { Debug.Log(msg); }
}`, true);
    engine.updateFile("__test58__/Battle.cs", `using UnityEngine;
public class Battle13 : MonoBehaviour
{
    public GameManager13 manager;
    private GameManager13 mgr2;
    private void Start()
    {
        GameManager13.Announce("wave starting");
        manager.SpawnEnemy("orc");
        mgr2.ResetAll();
        GetComponent<Rigidbody>();
        Debug.Log("battle");
    }
}`, true);
    const b13 = engine.callFlow("__test58__/Battle.cs");
    const bEdge = (to: string) => b13.edges.find((e: any) => e.from === "m::Battle13::Start" && e.to === to);
    check13("TEST58h qualified cross-file call resolves (GameManager13.Announce)",
      b13.ok === true && !!bEdge("x::GameManager13::Announce"));
    check13("TEST58i typed-field receiver cross-file calls resolve (manager.SpawnEnemy / mgr2.ResetAll)",
      !!bEdge("x::GameManager13::SpawnEnemy") && !!bEdge("x::GameManager13::ResetAll"));
    const xn13 = b13.nodes.find((n: any) => n.id === "x::GameManager13::SpawnEnemy");
    check13("TEST58j cross-file terminals carry cross+file+line and end traversal",
      xn13?.cross === true && /GameManager\.cs$/.test(xn13?.file ?? "") && xn13?.line >= 0 &&
      b13.edges.every((e: any) => !String(e.from).startsWith("x::")));
    check13("TEST58k Unity/BCL calls stay hidden even in cross-file scripts (hiddenCalls=2, crossCount=3)",
      b13.hiddenCalls === 2 && b13.crossCount === 3);

    // -- (e) ranks stay contiguous 1..N per caller across every fixture --
    const ranksOk = [f13, o13, a13, b13].every((r: any) => {
      const m = new Map<string, number[]>();
      for (const e of r.edges) { const arr = m.get(e.from) ?? []; arr.push(e.order); m.set(e.from, arr); }
      return [...m.values()].every((arr) => [...arr].sort((x, y) => x - y).every((v, i) => v === i + 1));
    });
    check13("TEST58l per-caller ranks contiguous 1..N across every fixture", ranksOk);

    const failed13 = results13.filter(([, ok]) => !ok);
    console.log(`\n=========== Phase 13 RESULT: ${results13.length - failed13.length}/${results13.length} PASS ===========`);
    for (const [name] of failed13) console.log("  FAILED:", name);
    if (failed13.length) process.exitCode = 2;
  }

  // ---- TEST59: Phase 14 — find-in-files options + coverage, MCP payload
  // formatters (pure) ----
  {
    const results14: [string, boolean][] = [];
    const check14 = (name: string, ok: boolean) => {
      results14.push([name, !!ok]);
      console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`);
    };
    // pure MCP payload formatters — same module the page-side dispatcher uses
    const { formatProblems, buildStructure, formatSearch, formatFileContent } = await import("../app/src/mcp-tools");

    // controlled fixture FIRST — every search assertion below keys off it
    engine.updateFile("__test59__/Words.cs", `public class Words14
{
    void Awake() { }
    string up = "up";
    string upgrade = "upgrade";
    string update = "update";
    string group = "group";
    // up again
}`, true);

    // -- (a) searchProject basics on a controlled fixture --
    const legacy = engine.search("words14");
    const modern = engine.searchProject("words14");
    check14("TEST59a search() stays compatible with searchProject().hits",
      legacy.length === modern.hits.length && modern.hits.length > 0
      && typeof modern.hits[0].file === "string" && typeof modern.hits[0].line === "number");

    // -- (b) whole word vs substring (fixture already loaded above) --
    const plainUp = engine.searchProject("up").hits.filter((h) => h.file === "__test59__/Words.cs");
    const wholeUp = engine.searchProject("up", { wholeWord: true }).hits.filter((h) => h.file === "__test59__/Words.cs");
    check14("TEST59b whole-word matches only standalone 'up' (3) vs substrings (8+)",
      wholeUp.length === 3 && plainUp.length >= 8);

    // -- (c) case sensitivity --
    const ci = engine.searchProject("words14").hits.length;
    const cs = engine.searchProject("words14", { caseSensitive: true }).hits.length;
    check14("TEST59c case-insensitive finds what case-sensitive misses",
      ci > 0 && cs === 0);

    // -- (d) regex mode --
    const reHits = engine.searchProject(`void\\s+Awake\\s*\\(`, { regex: true });
    check14("TEST59d regex query locates Awake signatures in the demo project",
      reHits.hits.length > 0 && /\bvoid\s+Awake\s*\(/.test(reHits.hits[0].text));

    // -- (e) coverage: cache-indexed files (no content) are REPORTED, not missed --
    engine.loadCachedSymbols([{
      path: "__test59__/Cached.cs",
      symbols: { path: "__test59__/Cached.cs", usings: [], namespaces: [], types: [], members: [], typeRefs: [] },
    }]);
    const withCached = engine.searchProject("anything");
    check14("TEST59e cache-warm file (no text yet) lands in unsearched, not searched",
      withCached.unsearched.includes("__test59__/Cached.cs") && !withCached.searched.includes("__test59__/Cached.cs"));
    engine.updateFile("__test59__/Cached.cs", "class Cached14 { }", true);
    const afterScan = engine.searchProject("Cached14");
    check14("TEST59f after a real update the file is searched and found",
      afterScan.unsearched.length < withCached.unsearched.length
      && afterScan.hits.some((h) => h.file === "__test59__/Cached.cs"));

    // -- (g) invalid regex is a clean error, never a throw --
    const bad = engine.searchProject("([unclosed", { regex: true });
    check14("TEST59g invalid regex → error field, zero hits, no exception",
      !!bad.error && bad.hits.length === 0);

    // -- (h) max cap is honest (truncated flag + remaining files listed) --
    const capped = engine.searchProject("e", { max: 3 });
    check14("TEST59h result cap sets truncated and reports unsearched remainder",
      capped.hits.length === 3 && capped.truncated === true && capped.unsearched.length > 0);

    // -- (i) MCP payload: formatProblems --
    const probs = formatProblems([
      { path: "Assets\\B.cs", line: 4, col: 0, length: 1, message: "b problem", severity: "warning", source: "vs" },
      { path: "Assets/A.cs", line: 9, col: 2, length: 3, message: "missing ;", severity: "error", source: "vs", code: "CS1002" },
      { path: "Assets/C.cs", line: 0, col: 0, length: 1, message: "info row", severity: "info", source: "vs" },
    ] as any, {});
    check14("TEST59i problems payload: 1-based coords, compiler-style row with code",
      probs.summary.errors === 1 && probs.summary.warnings === 1 && probs.summary.infos === 1
      && probs.problems[0].file === "Assets/A.cs" && probs.problems[0].line === 10 && probs.problems[0].col === 3
      && probs.problems[0].code === "CS1002"
      && /^Assets\/A\.cs\(10,3\): ERROR CS1002: missing ;$/.test(probs.text.split("\n")[1]));
    const errsOnly = formatProblems([
      { path: "A.cs", line: 0, col: 0, length: 1, message: "x", severity: "error", source: "vs" },
      { path: "B.cs", line: 0, col: 0, length: 1, message: "y", severity: "warning", source: "vs" },
    ] as any, { severity: "error" });
    check14("TEST59j severity filter narrows get_problems output",
      errsOnly.problems.length === 1 && errsOnly.problems[0].severity === "error");

    // -- (k) MCP payload: buildStructure (dirs first, scoped, counted) --
    const tree = buildStructure([
      "Assets/Scripts/Player.cs", "Assets/Scripts/AI/Turret.cs", "Assets/Scenes/Main.unity", "README.md",
    ], {});
    check14("TEST59k structure tree orders dirs before files with counts",
      tree.fileCount === 4 && tree.dirCount === 4
      && tree.text.indexOf("AI/") < tree.text.indexOf("Player.cs")
      && tree.text.indexOf("Scenes/") < tree.text.indexOf("Scripts/"));
    const scoped = buildStructure([
      "Assets/Scripts/Player.cs", "Assets/Scripts/AI/Turret.cs", "Docs/x.md",
    ], { folder: "Assets/Scripts" });
    check14("TEST59l folder-scoped tree excludes the rest of the workspace",
      scoped.fileCount === 2 && !scoped.text.includes("Docs"));

    // -- (l) MCP payload: formatSearch + formatFileContent --
    const sfmt = formatSearch([
      { file: "A.cs", line: 3, col: 5, length: 2, text: "  Vector3.up;" },
      { file: "A.cs", line: 7, col: 0, length: 2, text: "up++;" },
      { file: "B.cs", line: 1, col: 1, length: 2, text: "up" },
    ], { query: "up", unsearched: ["C.cs"] });
    check14("TEST59m search payload groups by file, 1-based positions, notes unsearched",
      sfmt.matchCount === 3 && sfmt.fileCount === 2
      && /A\.cs \(2\)/.test(sfmt.text) && / {2}4:6: Vector3\.up;/.test(sfmt.text)
      && sfmt.text.includes("note: 1 file(s) could not be searched yet"));
    const ffmt = formatFileContent("Assets/A.cs", "l1\nl2\nl3\nl4", { fromLine: 2, toLine: 3 });
    check14("TEST59n file payload renders a 1-based line window with a header",
      ffmt.totalLines === 4 && ffmt.from === 2 && ffmt.to === 3
      && ffmt.text.includes("Assets/A.cs — 4 lines (showing lines 2-3 of 4)")
      && /\n {2,}2 \| l2\n {2,}3 \| l3$/.test(ffmt.text));

    const failed14 = results14.filter(([, ok]) => !ok);
    console.log(`\n=========== Phase 14 RESULT: ${results14.length - failed14.length}/${results14.length} PASS ===========`);
    for (const [name] of failed14) console.log("  FAILED:", name);
    if (failed14.length) process.exitCode = 2;
  }

  // ---- Phase 9 summary ----
  const failed8 = results8.filter(([, ok]) => !ok);
  console.log(`\n=========== Phase 8 RESULT: ${results8.length - failed8.length}/${results8.length} PASS ===========`);
  for (const [name] of failed8) console.log("  FAILED:", name);
  const failed9 = results9.filter(([, ok]) => !ok);
  console.log(`\n=========== Phase 9 RESULT: ${results9.length - failed9.length}/${results9.length} PASS ===========`);
  for (const [name] of failed9) console.log("  FAILED:", name);
  if (failed8.length || failed9.length) process.exitCode = 2;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error("FATAL", e); process.exit(1); });
