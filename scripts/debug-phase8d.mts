/** Phase 8 debug 4 — findUses on a field declaration */
import * as fs from "node:fs";
import * as path from "node:path";
import { VelvetSharpEngine } from "../packages/brain/src/engine.ts";

const ROOT = "/home/z/my-project/velvetsharp";
const db = JSON.parse(fs.readFileSync(path.join(ROOT, "app/public/api/unityengine.db.json"), "utf8"));
const engine: any = await VelvetSharpEngine.create({
  wasmLocator: (f) => path.join(ROOT, "packages/brain/node_modules", f.includes("c_sharp") ? "tree-sitter-wasms/out/" + f : "web-tree-sitter/" + f),
  unityDb: db,
});
engine.updateFile("__test__/FieldProbe.cs",
  "using UnityEngine;\n\npublic class FieldProbe : MonoBehaviour\n{\n    public float jumpForce = 5f;\n\n    private void Update()\n    {\n        var y = jumpForce * 2f;\n        if (jumpForce > 0f) { }\n    }\n}\n", true);
// "jumpForce" decl at line 4 (0-based), col 17
try {
  const u = engine.findUses("__test__/FieldProbe.cs", 4, 17);
  console.log("field uses:", JSON.stringify(u, null, 1).slice(0, 800));
} catch (e) {
  console.log("THREW:", e?.stack ?? e);
}
process.exit(0);
