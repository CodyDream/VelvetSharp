/** Phase 11 probe — what does the brain do TODAY with preprocessor directives? */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { VelvetSharpEngine } from "../packages/brain/src/engine";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const db = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(path.join(ROOT, "app/public/api/unityengine.db.json"), "utf8")));
  const engine = await VelvetSharpEngine.create({
    wasmLocator: (f) => path.join(ROOT, "packages/brain/node_modules", f.includes("c_sharp") ? "tree-sitter-wasms/out/" + f : "web-tree-sitter/" + f),
    unityDb: db,
  });

  const src = `using UnityEngine;

public class PreprocProbe : MonoBehaviour
{
#if UNITY_EDITOR
    private UnityEditor.EditorWindow editorWindow;
#endif

#if !UNITY_EDITOR
    private string standaloneOnly = "built";
#endif

#if UNITY_STANDALONE_WIN && !UNITY_EDITOR
    private void WindowsOnly() { Debug.Log("win"); }
#endif

#if SOME_CUSTOM_FLAG
    private void CustomFlagCode() { Debug.Log("custom"); }
#endif

    private void Update()
    {
#if UNITY_EDITOR
        Debug.Log("editor tick");
#endif
#if DEBUG
        Debug.Log("debug tick");
#endif
    }
}
`;
  const r = engine.updateFile("__probe__/PreprocProbe.cs", src, true);
  console.log("== syntax diagnostics ==");
  for (const d of r.diagnostics) console.log(`  L${d.line + 1}:${d.col} [${d.severity}] ${d.message}`);
  console.log("== semantic diagnostics ==");
  for (const d of r.sem?.diagnostics ?? []) console.log(`  L${d.line + 1}:${d.col} [${d.severity}] ${d.message}`);
  if (!r.diagnostics.length && !r.sem?.diagnostics.length) console.log("  (none)");

  // 2) does the tree expose preproc nodes? where do symbols land?
  const st: any = (engine as any).files.get("__probe__/PreprocProbe.cs");
  const tree = st.tree;
  const seen = new Set<string>();
  const visit = (n: any) => {
    if (n.type.startsWith("preproc")) seen.add(n.type);
    for (let i = 0; i < n.childCount; i++) { const c = n.child(i); if (c) visit(c); }
  };
  visit(tree.rootNode);
  console.log("\n== preproc node types in tree ==");
  console.log(" ", [...seen].join(", ") || "(none)");

  console.log("\n== extracted members ==");
  for (const m of st.symbols.members) console.log(`  ${m.kind} ${m.name} @ line ${m.line + 1}`);
  for (const t of st.symbols.types) console.log(`  ${t.kind} ${t.name} @ line ${t.line + 1}`);

  // 3) outline
  console.log("\n== outline (worker-side) ==");
  console.log(" ", engine.outline("__probe__/PreprocProbe.cs").map((o: any) => o.name).join(", "));

  // 4) callFlow on preproc-heavy file (stability probe)
  try {
    const flow = engine.callFlow("__probe__/PreprocProbe.cs");
    console.log("\n== callFlow ==", flow.ok ? `ok, ${flow.nodes.length} nodes` : "FAILED: " + flow.reason);
  } catch (e: any) {
    console.log("\n== callFlow THREW ==", String(e?.message ?? e));
  }

  // 5) #region + #pragma + stray tokens after directives
  const src2 = `#region Setup
using UnityEngine;
#endregion

#pragma warning disable 0168
public class RegionProbe : MonoBehaviour
{
    #region Core
    void Awake()
    {
        int unusedVar;
#if UNITY_EDITOR
        gameObject.name = "editor";
#elif UNITY_STANDALONE
        gameObject.name = "standalone";
#else
        gameObject.name = "other";
#endif
    }
    #endregion
}
#pragma warning restore 0168
`;
  const r2 = engine.updateFile("__probe__/RegionProbe.cs", src2, true);
  console.log("\n== RegionProbe syntax ==");
  for (const d of r2.diagnostics) console.log(`  L${d.line + 1}:${d.col} [${d.severity}] ${d.message}`);
  console.log("== RegionProbe semantic ==");
  for (const d of r2.sem?.diagnostics ?? []) console.log(`  L${d.line + 1}:${d.col} [${d.severity}] ${d.message}`);
  if (!r2.diagnostics.length && !r2.sem?.diagnostics.length) console.log("  (none)");
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e); process.exit(1); });
