/** Phase 9→13 probe: per-script call-flow graph.
 *  Phase 13 spec: ONLY custom methods are drawn — engine/API calls are counted
 *  (hiddenCalls/extCount), calls into the user's OTHER scripts become cross-file
 *  terminals carrying their defining file, and every edge carries the 1-based
 *  call-order rank within its caller's body.
 * Run: npx tsx scripts/debug-callflow.mts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { VelvetSharpEngine } from "../packages/brain/src/engine.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = JSON.parse(fs.readFileSync(path.join(ROOT, "app/public/api/unityengine.db.json"), "utf8"));
const engine: any = await VelvetSharpEngine.create({
  wasmLocator: (f) => path.join(ROOT, "packages/brain/node_modules", f.includes("c_sharp") ? "tree-sitter-wasms/out/" + f : "web-tree-sitter/" + f),
  unityDb: db,
});
const bclPath = path.join(ROOT, "app/public/api/bcl.db.json");
if (fs.existsSync(bclPath)) engine.unity.mergeFromJson(JSON.parse(fs.readFileSync(bclPath, "utf8")));

// a second script so cross-file custom calls have something to resolve to
engine.updateFile("__probe__/FlowManager.cs", `public class FlowManager
{
    public void Kick() { }
}`, true);

const file = "__probe__/FlowProbe.cs";
const src = `using UnityEngine;

public class FlowPlayer : MonoBehaviour
{
    public void Move() { Stop(); manager.Kick(); Debug.Log("move"); }
    public void Stop() { rb.AddForce(0, 1, 0); }
    private Rigidbody rb;
    public FlowManager manager;

    private void Update() { Move(); }
    public void UpdateHud() { Log("hud"); }
    private void Log(string s) { Debug.Log(s); }
}
`;
engine.updateFile(file, src, true);
const r: any = engine.callFlow(file);

console.log("== nodes ==");
for (const n of r.nodes) console.log(`  ${n.cross ? "X-M" : "MTH"} ${n.id}${n.file ? " @" + n.file : ""} entry=${n.entry} unityMsg=${n.unityMsg}`);
console.log("== edges ==");
for (const e of r.edges) console.log(`  ${e.from} -> ${e.to} x${e.count} order=${e.order}`);

const nid = (s: string) => r.nodes.find((n: any) => n.id === s);
const edge = (f: string, t: string) => r.edges.find((e: any) => e.from === f && e.to === t);

const checks: [string, boolean][] = [
  ["Move node exists", !!nid("m::FlowPlayer::Move")],
  ["Stop node exists", !!nid("m::FlowPlayer::Stop")],
  ["Update is unityMsg", nid("m::FlowPlayer::Update")?.unityMsg === true],
  ["UpdateHud NOT unityMsg", nid("m::FlowPlayer::UpdateHud")?.unityMsg === false],
  ["Update is entry", nid("m::FlowPlayer::Update")?.entry === true],
  ["Move NOT entry (called by Update)", nid("m::FlowPlayer::Move")?.entry === false],
  ["Move -> Stop internal", !!edge("m::FlowPlayer::Move", "m::FlowPlayer::Stop")],
  ["Update -> Move internal", !!edge("m::FlowPlayer::Update", "m::FlowPlayer::Move")],
  ["UpdateHud -> Log internal (name match)", !!edge("m::FlowPlayer::UpdateHud", "m::FlowPlayer::Log")],
  ["no edge Move->Update", !edge("m::FlowPlayer::Move", "m::FlowPlayer::Update")],
  // Phase 13 — externals are GONE, counted instead
  ["NO external terminal nodes at all (Phase 13)", r.nodes.every((n: any) => n.kind === "method")],
  ["engine/API call sites counted (rb.AddForce, 2×Debug.Log)", r.hiddenCalls === 3 && r.extCount === 2],
  ["Move->Stop ranked #1 in Move (source order)", edge("m::FlowPlayer::Move", "m::FlowPlayer::Stop")?.order === 1],
  ["UpdateHud->Log is call #1 of UpdateHud", edge("m::FlowPlayer::UpdateHud", "m::FlowPlayer::Log")?.order === 1],
  // Phase 13 — cross-file custom method via typed-field receiver
  ["Move -> FlowManager.Kick cross-file terminal", !!edge("m::FlowPlayer::Move", "x::FlowManager::Kick")],
  ["cross terminal carries cross+file", (() => { const n: any = nid("x::FlowManager::Kick"); return n?.cross === true && /FlowManager\.cs$/.test(n?.file ?? ""); })()],
  ["cross terminals have NO outgoing edges", r.edges.every((e: any) => !String(e.from).startsWith("x::"))],
  ["ok flag", r.ok === true],
];

let fail = 0;
for (const [name, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`); if (!ok) fail++; }
console.log(`\nRESULT: ${fail === 0 ? "PASS" : `FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
