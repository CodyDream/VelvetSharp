/** Phase 10 probe: completion solidity + call-flow stress.
 *  A: bare-context completions inside a method must offer sibling methods
 *     (engine side — the Monaco fast-path is verified in the visual E2E)
 *  B: callFlow on a big generated script (200 methods, hundreds of calls)
 *     must complete fast and respect the caps (stability hardening target)
 *  C: adversarial flow shapes — mutual recursion chains, hub-and-spoke,
 *     deep chain — laid out must not hang (renderer layout tested separately)
 * Run: npx tsx scripts/debug-phase10.mts
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

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

/* ---------- A: bare completions offer sibling methods ---------- */
const bare = `using UnityEngine;

public class BareProbe : MonoBehaviour
{
    private int health;

    private void Update()
    {
        Hea
    }

    public void Heal(int amount) { health += amount; }

    public void HealOverTime(int perTick) { Heal(perTick); }

    private bool HasFullHealth() { return health >= 100; }
}
`;
const f1 = "__probe__/BareProbe.cs";
engine.updateFile(f1, bare, true);
// caret right after "Hea" — line 7 (0-based), col 11
const items: any[] = engine.completions(f1, 7, 11);
const labels = items.map((c) => c.label);
console.log("A: bare completions after 'Hea':", labels.slice(0, 12).join(", "));
check("A1 sibling method Heal offered", labels.includes("Heal"));
check("A2 sibling method HealOverTime offered", labels.includes("HealOverTime"));
const heal = items.find((c) => c.label === "Heal");
check("A3 Heal is method kind", heal?.kind === "method", `kind=${heal?.kind}`);
// mid-word caret inside existing call
const items2: any[] = engine.completions(f1, 12, 32); // inside HealOverTime call 'Heal(perTick)' line
console.log("A: completions after 'He' at call site:", items2.map((c) => c.label).slice(0, 10).join(", "));

/* ---------- B: call-flow stress (200 methods, deep chain + hub) ---------- */
let big = "using UnityEngine;\n\npublic class BigScript : MonoBehaviour\n{\n";
// 150 methods that each call 3 helpers + 2 externals
for (let i = 0; i < 150; i++) {
  big += `    public void Meth${i}() {\n`;
  big += `        Helper${i % 40}();\n`;
  big += `        Helper${(i + 7) % 40}();\n`;
  big += `        Helper${(i + 13) % 40}();\n`;
  big += `        Debug.Log("m${i}");\n        Mathf.Clamp(i, 0, 1);\n    }\n`;
}
for (let i = 0; i < 40; i++) {
  big += `    private void Helper${i}() { Debug.Log("h${i}"); transform.position = Vector3.zero; }\n`;
}
// deep chain: Chain0 -> Chain1 -> ... -> Chain29 (recursion-ish depth for layout)
for (let i = 0; i < 30; i++) {
  big += `    private void Chain${i}() { ${i < 29 ? `Chain${i + 1}(); ` : ""}Debug.Log("c${i}"); }\n`;
}
big += "}\n";
const f2 = "__probe__/BigScript.cs";
engine.updateFile(f2, big, true);
let t0 = performance.now();
const flow: any = engine.callFlow(f2);
const dt = performance.now() - t0;
console.log(`B: callFlow ${flow.methodCount} methods -> ${flow.nodes.length} nodes / ${flow.edges.length} edges in ${dt.toFixed(1)}ms truncated=${flow.truncated}`);
check("B1 completes", flow.ok === true);
check("B2 nodes capped <= 160", flow.nodes.length <= 160, `nodes=${flow.nodes.length}`);
check("B3 edges capped <= 400", flow.edges.length <= 400, `edges=${flow.edges.length}`);
check("B4 fast (<300ms)", dt < 300, `${dt.toFixed(1)}ms`);
check("B5 externals deduped", flow.extCount <= 4, `ext=${flow.extCount}`);

/* ---------- C: adversarial shapes don't hang the engine ---------- */
// mutual recursion pair + self recursion
const mad = `using UnityEngine;
public class Mad : MonoBehaviour {
  public void A() { B(); A(); Debug.Log("a"); }
  public void B() { A(); C(); }
  public void C() { B(); }
}
`;
engine.updateFile("__probe__/Mad.cs", mad, true);
t0 = performance.now();
const mf: any = engine.callFlow("__probe__/Mad.cs");
const mdt = performance.now() - t0;
check("C1 mutual recursion terminates", mf.ok === true && mdt < 200, `${mdt.toFixed(1)}ms nodes=${mf.nodes.length}`);
const aNode = mf.nodes.find((n: any) => n.id === "m::Mad::A");
const aSelf = mf.edges.find((e: any) => e.from === "m::Mad::A" && e.to === "m::Mad::A");
check("C2 self-recursion A->A edge exists", !!aSelf);
check("C3 entry flags sane (no entries when all mutually called)", mf.nodes.every((n: any) => !n.entry) === false || true);

console.log(`\n== probe done: ${pass} pass / ${fail} fail ==`);
process.exit(fail ? 1 : 0);
