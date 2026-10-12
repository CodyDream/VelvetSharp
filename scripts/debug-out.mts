/** repro/probe: out-expression diagnostics (Task 17-a)
 *  Section A: LEGAL out/ref patterns — must produce ZERO diagnostics.
 *  Section B: genuinely wrong ref/out args — must still be flagged.
 * Run: npx tsx scripts/debug-out.mts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { VelvetSharpEngine } from "../packages/brain/src/engine.ts";

const ROOT = "/home/z/my-project/velvetsharp";
const db = JSON.parse(fs.readFileSync(path.join(ROOT, "app/public/api/unityengine.db.json"), "utf8"));
const engine: any = await VelvetSharpEngine.create({
  wasmLocator: (f) => path.join(ROOT, "packages/brain/node_modules", f.includes("c_sharp") ? "tree-sitter-wasms/out/" + f : "web-tree-sitter/" + f),
  unityDb: db,
});

// ---- Section A: every LEGAL out pattern (false positives used to live here) ----
const src = `using UnityEngine;

public class OutProbe : MonoBehaviour
{
    private void Start()
    {
        if (int.TryParse("42", out int result))
        {
            Debug.Log(result);
        }

        int seconds;
        if (int.TryParse("7", out seconds))
        {
            Debug.Log(seconds);
        }

        var d = new System.Collections.Generic.Dictionary<string, int>();
        if (d.TryGetValue("k", out var found))
        {
            Debug.Log(found);
        }

        int.TryParse("1", out _);

        int sum = 0;
        int i = 0;
        while (i < 3 && int.TryParse("2", out int n))
        {
            sum += n;
            i++;
        }

        M(out int a, out int b);
        Debug.Log(a + b);

        int local = 1;
        R(ref local);
        ref int rl = ref local;
        rl = 7;
        Debug.Log(rl);

        int[] slots = new int[3];
        W(out slots[0]);
    }

    private void M(out int a, out int b)
    {
        a = 1;
        b = 2;
    }

    private void R(ref int x) { x++; }
    private void W(out int x) { x = 9; }

    private bool TryGet(out int value)
    {
        value = 5;
        return true;
    }
}
`;
const r = engine.updateFile("__test__/OutProbe.cs", src, true);
const diags = (r.diagnostics ?? []).concat(r.sem?.diagnostics ?? []);
console.log("Section A (legal patterns) diagnostics:", diags.length);
for (const d of diags) console.log(`  [${d.severity}] line ${d.line + 1}: ${d.message}`);

// covered legal forms:
//  (a)  out int result          → tree-sitter node: declaration_expression  (was FALSE-POSITIVED)
//  (b)  out var found           → declaration_expression                    (was FALSE-POSITIVED)
//  (c)  out seconds             → identifier (pre-declared, always worked)
//  (d)  out _                   → identifier (discard)
//  (e)  out int n in while-cond → declaration_expression, variable used in body
//  (f)  M(out int a, out int b) → multi-arg declarations + out-param methods (no return-path warnings)
//  (g)  ref local / ref int rl = ref local  → ref arg + ref locals
//  (h)  out slots[0]            → element_access_expression (assignable)
//  (i)  bool TryGet(out int value) { value = 5; return true; } → zero errors

// ---- Section B: genuinely wrong args must STILL be flagged ----
// NB: `out obj.field` / `out obj.Deep.Prop` are LEGAL (fields are assignable) —
// restored to the accepted set so the lint never invents warnings. Only provably
// wrong args stay flagged.
const bad = `using UnityEngine;

public class OutBad : MonoBehaviour
{
    private void Start()
    {
        Foo(out 42);
        Foo(out Build());
        Foo(out "str");
        Foo(out (a, b));
        Foo(out new object());
        Foo(out 1 + 2);
    }
    private void Foo(out int v) { v = 0; }
    private int Build() => 1;
}
`;
const rb = engine.updateFile("__test__/OutBad.cs", bad, true);
const badDiags = (rb.diagnostics ?? []).concat(rb.sem?.diagnostics ?? []);
console.log("\nSection B (wrong args) diagnostics:", badDiags.length, "(expect 6)");
for (const d of badDiags) console.log(`  [${d.severity}] line ${d.line + 1}: ${d.message}`);

const okA = diags.length === 0;
const okB = badDiags.length === 6 && badDiags.every((d: any) => /assignable variable/.test(d.message));
console.log(`\nRESULT: ${okA && okB ? "PASS" : "FAIL"} (legal clean=${okA}, wrong still flagged=${okB})`);
process.exit(okA && okB ? 0 : 1);
