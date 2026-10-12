/** Phase 8 debug 3 — replicate completions() steps */
import * as fs from "node:fs";
import * as path from "node:path";
import { VelvetSharpEngine } from "../packages/brain/src/engine.ts";

const ROOT = "/home/z/my-project/velvetsharp";
const db = JSON.parse(fs.readFileSync(path.join(ROOT, "app/public/api/unityengine.db.json"), "utf8"));
const engine: any = await VelvetSharpEngine.create({
  wasmLocator: (f) => path.join(ROOT, "packages/brain/node_modules", f.includes("c_sharp") ? "tree-sitter-wasms/out/" + f : "web-tree-sitter/" + f),
  unityDb: db,
});

engine.updateFile("__test__/ProbeBase.cs",
  "using UnityEngine;\n\npublic class ProbeBase : MonoBehaviour\n{\n    protected int probeCharge = 3;\n    public void ProbeStrike(int dmg) { }\n}\n", true);
engine.updateFile("__test__/ThisProbe.cs",
  "using UnityEngine;\n\npublic class ThisProbe : ProbeBase\n{\n    private void Update()\n    {\n        this.Prob\n    }\n}\n", true);

const st = engine.files.get("__test__/ThisProbe.cs");
console.log("content repr:", JSON.stringify(st.content));
// find textToOffset equivalent
const lines = st.content.split("\n");
console.log("line5:", JSON.stringify(lines[5]));
const before = "        this.Prob";
const memberMatch = before.match(/([A-Za-z_][A-Za-z0-9_<>,.\[\]()` ]*?)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)?$/);
console.log("memberMatch on '        this.Prob':", memberMatch?.[1], "|", memberMatch?.[2]);

const ma = engine.completeMemberAccess(st, 5, 17, "this", "Prob");
console.log("completeMemberAccess(this, Prob):", ma.map((c: any) => c.label).slice(0, 10).join(", "));
const r = engine.resolveExpression(st, 5, 17, "this");
console.log("resolve(this):", JSON.stringify(r));
process.exit(0);
