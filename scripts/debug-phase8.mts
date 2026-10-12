/** Phase 8 debug probes */
import * as fs from "node:fs";
import * as path from "node:path";
import { VelvetSharpEngine } from "../packages/brain/src/engine.ts";

const ROOT = "/home/z/my-project/velvetsharp";
const db = JSON.parse(fs.readFileSync(path.join(ROOT, "app/public/api/unityengine.db.json"), "utf8"));
const engine = await VelvetSharpEngine.create({
  wasmLocator: (f) => path.join(ROOT, "packages/brain/node_modules", f.includes("c_sharp") ? "tree-sitter-wasms/out/" + f : "web-tree-sitter/" + f),
  unityDb: db,
});
const bclPath = path.join(ROOT, "app/public/api/bcl.db.json");
if (fs.existsSync(bclPath)) engine.unity.mergeFromJson(JSON.parse(fs.readFileSync(bclPath, "utf8")));

// --- 48a probe ---
const mb = engine.unity.findType("MonoBehaviour");
console.log("MonoBehaviour found:", !!mb, mb?.fullName);
const members = mb ? engine.unity.membersOf(mb) : [];
console.log("member count:", members.length, "has Awake:", members.some((m: any) => m.name === "Awake"));
const mbRaw = db.namespaces["UnityEngine"]?.["MonoBehaviour"];
console.log("db MonoBehaviour.m has Awake:", (mbRaw?.m ?? []).some((m: any) => m.n === "Awake"));

// --- 46 probe ---
engine.updateFile("__test__/SpamOwner.cs",
  "public class SpamOwner\n{\n    private EnemyHealth enemyHealth;\n    void Go()\n    {\n        if (enemyHealth != null) { }\n    }\n}\n", true);
const g8 = engine.dependencyGraph(null, false);
const byName = new Map(g8.nodes.map((n: any) => [n.name, n] as const));
const spam = byName.get("SpamOwner");
console.log("SpamOwner node:", !!spam);
if (spam) {
  const out = g8.edges.filter((e: any) => e.from === spam.id);
  const nb = (id: string) => byName.get(g8.nodes.find((n: any) => n.id === id)?.name ?? "")?.name ?? id;
  console.log("SpamOwner out edges:", out.map((e: any) => `${e.kind}->${nb(e.to)}`).join(" | "));
}
const ph = byName.get("PlayerHealth"), gm = byName.get("GameManager");
console.log("PlayerHealth:", !!ph, "GameManager:", !!gm);
if (ph) {
  const out = g8.edges.filter((e: any) => e.from === ph.id);
  console.log("PlayerHealth out edges:", out.map((e: any) => `${e.kind}->${nb(e.to)}`).join(" | "));
}

// --- 47d probe ---
engine.updateFile("__test__/ProbeBase.cs",
  "using UnityEngine;\n\npublic class ProbeBase : MonoBehaviour\n{\n    protected int probeCharge = 3;\n    public void ProbeStrike(int dmg) { }\n}\n", true);
engine.updateFile("__test__/ThisProbe.cs",
  "using UnityEngine;\n\npublic class ThisProbe : ProbeBase\n{\n    private void Update()\n    {\n        this.Prob\n    }\n}\n", true);
const comps3 = engine.completions("__test__/ThisProbe.cs", 5, 17);
console.log("this.Prob completions:", comps3.map((c: any) => c.label).slice(0, 15).join(", "));
const resolve = (engine as any).resolveExpression;
console.log("---");
process.exit(0);
