/** Phase 9 probe: per-script call-flow graph.
 *  A: in-file calls resolve (Player.Move → Player.Stop, GameManager calls both)
 *  B: external calls become terminal nodes (Debug.Log, rb.AddForce, Mathf.Approximately)
 *  C: Unity lifecycle methods flagged; entry = not called in-file
 *  D: API-qualified calls never stolen in-file even when the name collides
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

const file = "__probe__/FlowProbe.cs";
const src = `using UnityEngine;

public class FlowPlayer : MonoBehaviour
{
    public void Move() { Stop(); Debug.Log("move"); }
    public void Stop() { rb.AddForce(0, 1, 0); }
    private Rigidbody rb;

    private void Update() { Move(); }
    public void UpdateHud() { Log("hud"); }
    private void Log(string s) { Debug.Log(s); }
}
`;
engine.updateFile(file, src, true);
const r: any = engine.callFlow(file);

console.log("== nodes ==");
for (const n of r.nodes) console.log(`  ${n.kind === "external" ? "EXT" : "MTH"} ${n.id} entry=${n.entry} unityMsg=${n.unityMsg}`);
console.log("== edges ==");
for (const e of r.edges) console.log(`  ${e.from} -> ${e.to} x${e.count}${e.external ? " [external]" : ""}`);

const nid = (s: string) => r.nodes.find((n: any) => n.id === s);
const edge = (f: string, t: string, ext?: boolean) =>
  r.edges.find((e: any) => e.from === f && e.to === t && (ext === undefined || e.external === ext));

const checks: [string, boolean][] = [
  ["Move node exists", !!nid("m::FlowPlayer::Move")],
  ["Stop node exists", !!nid("m::FlowPlayer::Stop")],
  ["Update is unityMsg", nid("m::FlowPlayer::Update")?.unityMsg === true],
  ["UpdateHud NOT unityMsg", nid("m::FlowPlayer::UpdateHud")?.unityMsg === false],
  ["Update is entry", nid("m::FlowPlayer::Update")?.entry === true],
  ["Move NOT entry (called by Update)", nid("m::FlowPlayer::Move")?.entry === false],
  ["Move -> Stop internal", !!edge("m::FlowPlayer::Move", "m::FlowPlayer::Stop", false)],
  ["Update -> Move internal", !!edge("m::FlowPlayer::Update", "m::FlowPlayer::Move", false)],
  ["Move -> Debug.Log external", !!edge("m::FlowPlayer::Move", "ext::debug.log", true)],
  ["Stop -> rb.AddForce external", !!edge("m::FlowPlayer::Stop", "ext::rb.addforce", true)],
  ["UpdateHud -> Log internal (name match)", !!edge("m::FlowPlayer::UpdateHud", "m::FlowPlayer::Log", false)],
  ["Log -> Debug.Log external (not stolen)", !!edge("m::FlowPlayer::Log", "ext::debug.log", true)],
  ["no edge Move->Update", !edge("m::FlowPlayer::Move", "m::FlowPlayer::Update")],
  ["ok flag", r.ok === true],
];

let fail = 0;
for (const [name, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`); if (!ok) fail++; }
console.log(`\nRESULT: ${fail === 0 ? "PASS" : `FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
