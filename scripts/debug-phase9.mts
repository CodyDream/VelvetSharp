/** Phase 9 repro: member-of-known-type false positives + ambiguous-reference noise.
 *  User report (LoadoutManager.cs):
 *    - `new JArray(currentWeaponLoadout ?? Array.Empty<int>())` → CS0246 "Empty could not
 *      be found" (FALSE POSITIVE — VS/Rider clean; Empty is a METHOD on System.Array)
 *    - bare `Task` → "Ambiguous reference: Task vs Task`1" (wrong — arity 0 binds Task)
 *    - ambiguous-reference warnings in general → user wants them GONE
 * Run: npx tsx scripts/debug-phase9.mts
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

// A type named `Empty` somewhere in the project (unreachable from the probe file)
// — the user's real project has one; that's what turns the type-position leak into
// a CS0246 ("could not be found" without a using suggestion, exactly their report)
engine.updateFile("__probe__/Other.cs", `namespace Deep.ThirdParty { public class Empty { } }`, true);

const file = "__probe__/LoadoutProbe.cs";
const src = `using UnityEngine;
using System.Threading.Tasks;

public class LoadoutProbe : MonoBehaviour
{
    private int[] currentWeaponLoadout;
    private Task pending;

    private void Start()
    {
        var data = new JObject { { "weapons", new JArray(currentWeaponLoadout ?? Array.Empty<int>()) } };
        pending = Task.Delay(10);
        Debug.Log(data);
    }
}
`;

const r: any = engine.updateFile(file, src, true);
const diags: any[] = (r.diagnostics ?? []).concat(r.sem?.diagnostics ?? []);
console.log("== diagnostics ==");
for (const d of diags) console.log(`  [${d.severity}] L${(d.range?.start?.line ?? 0) + 1}:${(d.range?.start?.col ?? 0) + 1} — ${d.message}`);
if (!diags.length) console.log("  (none)");

const emptyError = diags.find((d) => /'Empty' could not be found/.test(d.message));
const taskAmbig = diags.find((d) => /Ambiguous reference: 'Task'/.test(d.message));
const anyAmbig = diags.filter((d) => /Ambiguous reference/.test(d.message));
console.log("\n== verdict ==");
console.log("Empty false positive :", emptyError ? "PRESENT (bug)" : "gone ✓");
console.log("Task ambiguity warn  :", taskAmbig ? "PRESENT (bug)" : "gone ✓");
console.log("any ambiguity warns  :", anyAmbig.length ? `${anyAmbig.length} (user wants zero)` : "zero ✓");
if (emptyError || anyAmbig.length) process.exit(1);
console.log("\nPROBE PASS");
