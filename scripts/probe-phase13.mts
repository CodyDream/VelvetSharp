/** Phase 13 probe: hunt for call-flow crashes + invariant violations.
 *  User report: "call flow make it still crash i think there is bugs because
 *  call flow dependency graph is not so big". This battery throws every nasty
 *  C# shape we can think of at engine.callFlow() and the dependency graph,
 *  then asserts structural invariants the renderer depends on.
 * Run: npx tsx scripts/probe-phase13.mts
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

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} — ${name}${cond || !extra ? "" : " · " + extra}`);
  if (!cond) fails++;
};

/** every fixture returns [name, source] */
const fixtures: [string, string][] = [
  ["null-conditional + invocation-of-invocation", `using UnityEngine;
public class P13A : MonoBehaviour {
  public void Run() { var a = Maybe(); a?.DoIt(); GetThing().Apply(Make()); ((Maybe())?.DoIt)(); transform?.position.ToString(); }
  public P13A Maybe() => this;
  public void DoIt() { Debug.Log("x"); }
  public Wrapper GetThing() => null;
  public Wrapper Make() => null;
}
public class Wrapper { public void Apply(Wrapper w) { Debug.Log("apply"); } }`],
  ["generics everywhere", `using UnityEngine;
using System.Collections.Generic;
public class P13B : MonoBehaviour {
  public void Run() {
    var list = new List<int>();
    list.Add(Get<int>());
    Array.Empty<int>();
    Dictionary<string, List<Rigidbody>> map = new Dictionary<string, List<Rigidbody>>();
    Generic<int, string>(1, "a");
    var arr = System.Array.Empty<P13B>();
  }
  public T Get<T>() where T : Component => null;
  public void Generic<A, B>(A a, B b) { Debug.Log(b.ToString()); }
}`],
  ["lambdas / local funcs / events / nameof", `using UnityEngine;
using System;
public class P13C : MonoBehaviour {
  public event Action OnBoom;
  public void Run() {
    Action a = () => Target();
    Action b = delegate { Target(); };
    Func<int> c = () => { Helper(); return 1; };
    void Local() { Target(); }
    Local();
    OnBoom?.Invoke();
    if (OnBoom != null) OnBoom();
    Debug.Log(nameof(Target));
    this.Run();
  }
  public void Target() { Helper(); }
  public void Helper() { Debug.Log("h"); }` + "\n}"],
  ["ctors, destructors, operators, properties", `using UnityEngine;
public class P13D {
  public P13D() { Init(); }
  ~P13D() { Shutdown(); }
  public static P13D operator +(P13D a, P13D b) { a.Combine(b); return a; }
  public int Count { get { return Compute(); } set { Compute(); } }
  public int this[int i] { get { return Compute(); } }
  void Init() { Debug.Log("init"); }
  void Shutdown() {}
  void Combine(P13D o) {}
  int Compute() => 42;
}`],
  ["deep nesting + awaits + async", `using UnityEngine;
using System.Threading.Tasks;
public class P13E : MonoBehaviour {
  public async void Run() {
    if (true) { if (true) { if (true) { if (true) { if (true) { Deep1(); } } } } }
    await Task.Delay(10);
    await Weird();
    var t = Task.Run(() => Deep1());
  }
  async Task Weird() { await Task.Yield(); Deep1(); }
  void Deep1() { Deep2(); } void Deep2() { Deep3(); } void Deep3() { Deep4(); } void Deep4() { Debug.Log("d"); }
}`],
  ["string interpolation + interpolation calls", `using UnityEngine;
public class P13F : MonoBehaviour {
  public void Run() {
    Debug.Log($"value {Format(42)} and {Mathf.Max(1, 2)}");
    string s = $"{Prefix()}_{Time.time:F2}";
  }
  string Format(int v) { return v.ToString(); }
  string Prefix() { return "p"; }
}`],
  ["extension methods + static qualifiers", `using UnityEngine;
public static class P13Ext {
  public static void Stretch(this Rigidbody rb) { Debug.Log("stretch"); }
}
public class P13G : MonoBehaviour {
  void Start() {
    var rb = GetComponent<Rigidbody>();
    rb.Stretch();
    P13G.StaticThing();
    base.Start();
    this.Start();
  }
  public static void StaticThing() { Debug.Log("s"); }
  void Ping() { Pong(); }
  void Pong() { Ping(); }
}`],
  ["recursive generics + chained member calls", `using UnityEngine;
public class P13H : MonoBehaviour {
  public void Run() {
    Make().Build().Finish();
    Registry<Floater>.Instance.Register(new Floater());
    Chain1().Chain2().Chain3();
  }
  public Builder Make() => new Builder();
  public Builder Chain1() => new Builder();
  public Floater Chain2() => null;
  public void Chain3() { Debug.Log("c3"); }
}
public class Builder {
  public Builder Build() { Debug.Log("build"); return this; }
  public void Finish() { Debug.Log("finish"); }
}
public class Registry<T> { public static Registry<T> Instance = new Registry<T>(); public void Register(T t) {} }
public class Floater {}`],
  ["attributes with invocations + goto", `using UnityEngine;
public class P13I : MonoBehaviour {
  [ContextMenu(Count())]
  public void Run() { int i = 0; again: i++; if (i < 3) goto again; Helper(); }
  void Helper() {}
  public static string Count() { return "x"; }
}`],
  ["closed cycles through many nodes", `using UnityEngine;
public class P13J : MonoBehaviour {
  public void A() { B(); } public void B() { C(); } public void C() { D(); }
  public void D() { E(); } public void E() { F(); } public void F() { G(); }
  public void G() { A(); Debug.Log("loop"); }
}`],
  ["empty bodies + weird whitespace + crlf", "using UnityEngine;\r\npublic class P13K : MonoBehaviour {\r\n  public void A() {}\r\n  public void B() {   }\r\n  public void C() {\r\n\r\n\r\n  }\r\n  public void D() { A(); }\r\n}" ],
  ["same-name methods across classes in ONE file", `using UnityEngine;
public class P13L1 : MonoBehaviour {
  public void Fire() { Debug.Log("l1"); }
  public void Run() { Fire(); }
}
public class P13L2 : MonoBehaviour {
  public void Fire() { Debug.Log("l2"); }
  public void Run() { Fire(); }
}`],
  ["interface calls + abstract", `using UnityEngine;
public interface IP13 { void Tick(); }
public abstract class P13Base : MonoBehaviour { public abstract void Tick(); }
public class P13M : P13Base {
  public override void Tick() { Debug.Log("tick"); }
  public void Update() { Tick(); }
  public void Call(IP13 x) { x.Tick(); }
}`],
  ["conditional + coalesce + is/as patterns", `using UnityEngine;
public class P13N : MonoBehaviour {
  public void Run() {
    var x = Get() as P13N;
    var y = Get() ?? new P13N();
    if (Get() is P13N p) { p.Helper(); }
    switch (Get()) { case P13N q: q.Helper(); break; }
  }
  public P13N Get() => this;
  public void Helper() { Debug.Log("help"); }
}`],
  ["unsafe + fixed + pointers", `using UnityEngine;
public class P13O {
  public unsafe void Run() {
    int[] data = new int[4];
    fixed (int* ptr = data) { Step(ptr); }
  }
  unsafe void Step(int* p) { Debug.Log(*p); }
}`],
];

console.log("== fixture battery ==");
for (const [name, src] of fixtures) {
  const p = `__probe13__/${name.replace(/[^a-z0-9]+/gi, "_")}.cs`;
  try {
    engine.updateFile(p, src, true);
    const r = engine.callFlow(p);
    ok(`${name}: callFlow returned`, !!r && typeof r.ok === "boolean", JSON.stringify(r?.reason ?? ""));
    if (r?.ok) {
      ok(`${name}: only custom method nodes (no external terminals)`, r.nodes.every((n: any) => n.kind === "method"));
      // order invariants: per-caller ranks are 1..N contiguous
      const byFrom = new Map<string, number[]>();
      for (const e of r.edges) {
        const arr = byFrom.get(e.from) ?? []; arr.push(e.order); byFrom.set(e.from, arr);
      }
      let ordersOk = true;
      for (const [, arr] of byFrom) {
        const sorted = [...arr].sort((a, b) => a - b);
        if (sorted.some((v, i) => v !== i + 1)) ordersOk = false;
      }
      ok(`${name}: per-caller call-order ranks contiguous 1..N`, ordersOk, JSON.stringify([...byFrom.entries()].slice(0, 3)));
      ok(`${name}: no NaN/undefined in edges`, r.edges.every((e: any) => typeof e.from === "string" && typeof e.to === "string"));
    }
  } catch (e: any) {
    ok(`${name}: NO THROW`, false, String(e?.stack ?? e).split("\n").slice(0, 3).join(" | "));
  }
}

console.log("\n== pathological sizes ==");
// many methods calling each other + a deep chain
let big = "using UnityEngine;\npublic class P13Big : MonoBehaviour {\n";
for (let i = 0; i < 400; i++) big += `  void M${i}() { M${(i + 1) % 400}(); Debug.Log("m"); }\n`;
big += "}\n";
try {
  const t0 = Date.now();
  engine.updateFile("__probe13__/Big.cs", big, true);
  const r = engine.callFlow("__probe13__/Big.cs");
  ok(`400-method cycle: completes in ${Date.now() - t0}ms, capped sanely`, r.ok === true && r.nodes.length <= 160 && r.edges.length <= 400, `nodes=${r.nodes.length} edges=${r.edges.length}`);
} catch (e: any) { ok("400-method cycle: NO THROW", false, String(e?.message ?? e)); }

// one method with 900 distinct calls (edge-cap + raw-cap path)
let wide = "using UnityEngine;\npublic class P13Wide : MonoBehaviour {\n  void Hub() {\n";
for (let i = 0; i < 900; i++) wide += `    T${i}();\n`;
wide += "  }\n";
for (let i = 0; i < 900; i++) wide += `  void T${i}() { Debug.Log("t"); }\n`;
wide += "}\n";
try {
  const t0 = Date.now();
  engine.updateFile("__probe13__/Wide.cs", wide, true);
  const r = engine.callFlow("__probe13__/Wide.cs");
  ok(`900-call hub: completes in ${Date.now() - t0}ms`, r.ok === true, `nodes=${r.nodes?.length}`);
} catch (e: any) { ok("900-call hub: NO THROW", false, String(e?.message ?? e)); }

console.log("\n== dependency graph still healthy on the same corpus ==");
try {
  const g = engine.dependencyGraph(null, false);
  ok("depGraph (whole project) ok", Array.isArray(g?.nodes), `nodes=${g?.nodes?.length}`);
  const g2 = engine.dependencyGraph("__probe13__", false);
  ok("depGraph (probe scope) ok", Array.isArray(g2?.nodes), `nodes=${g2?.nodes?.length}`);
} catch (e: any) { ok("depGraph NO THROW", false, String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")); }

console.log(`\nRESULT: ${fails === 0 ? "PASS (0 failures)" : `FAIL (${fails})`}`);
process.exit(fails === 0 ? 0 : 1);
