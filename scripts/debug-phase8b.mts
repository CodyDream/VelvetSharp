/** Phase 8 debug probes 2 — this. resolution + injection */
import * as fs from "node:fs";
import * as path from "node:path";
import { VelvetSharpEngine } from "../packages/brain/src/engine.ts";

const ROOT = "/home/z/my-project/velvetsharp";
const db = JSON.parse(fs.readFileSync(path.join(ROOT, "app/public/api/unityengine.db.json"), "utf8"));
const engine: any = await VelvetSharpEngine.create({
  wasmLocator: (f) => path.join(ROOT, "packages/brain/node_modules", f.includes("c_sharp") ? "tree-sitter-wasms/out/" + f : "web-tree-sitter/" + f),
  unityDb: db,
});
const bclPath = path.join(ROOT, "app/public/api/bcl.db.json");
if (fs.existsSync(bclPath)) engine.unity.mergeFromJson(JSON.parse(fs.readFileSync(bclPath, "utf8")));

// injection probe
const mb = engine.unity.findType("MonoBehaviour");
const members = engine.unity.membersOf(mb);
console.log("MB members:", members.length, "Awake?", members.some((m: any) => m.name === "Awake"), "Start?", members.some((m: any) => m.name === "Start"));
const mbi = (engine.unity as any).typeByFull.get("UnityEngine.MonoBehaviour");
console.log("raw info.m count:", mbi?.info?.m?.length, "has Awake in m:", (mbi?.info?.m ?? []).some((x: any) => x.n === "Awake"));
console.log("assemblyLabel:", engine.unity.assemblyLabel);

engine.updateFile("__test__/ProbeBase.cs",
  "using UnityEngine;\n\npublic class ProbeBase : MonoBehaviour\n{\n    protected int probeCharge = 3;\n    public void ProbeStrike(int dmg) { }\n}\n", true);
engine.updateFile("__test__/ThisProbe.cs",
  "using UnityEngine;\n\npublic class ThisProbe : ProbeBase\n{\n    private void Update()\n    {\n        this.Prob\n    }\n}\n", true);

const r = engine.resolveExpression(engine.files.get("__test__/ThisProbe.cs"), 5, 17, "this");
console.log("resolveExpression(this):", JSON.stringify(r));
const cur = (engine as any).currentTypeName(engine.files.get("__test__/ThisProbe.cs"), 5, 17);
console.log("currentTypeName:", cur);
const pm = (engine as any).projectMembers;
console.log("projectMembers keys:", [...pm.keys()].join(", "));
const pt = (engine as any).projectTypes;
console.log("projectTypes keys:", [...pt.keys()].join(", "));
const comps3 = engine.completions("__test__/ThisProbe.cs", 5, 17);
console.log("this.Prob completions:", comps3.map((c: any) => c.label).slice(0, 20).join(", "));
process.exit(0);
