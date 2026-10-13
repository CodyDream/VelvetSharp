/** Phase 11 smoke — preproc + folding + xmldoc pure modules */
import { scanPreproc, buildDefineSet, evaluatePreprocExpr, versionDefines, pragmaSuppresses } from "../packages/brain/src/preproc";
import { computeFoldRanges } from "../packages/brain/src/folding";
import { xmlDocSuggestion } from "../packages/brain/src/xmldoc";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (ok) { pass++; console.log(`  PASS — ${name}`); }
  else { fail++; console.log(`  FAIL — ${name}${extra ? " · " + extra : ""}`); }
};

console.log("== expression evaluator ==");
const D = buildDefineSet(["MY_TOOL", "VERBOSE"], "2022.3.41f1");
check("UNITY_EDITOR defined", evaluatePreprocExpr("UNITY_EDITOR", D));
check("UNITY_STANDALONE_WIN defined", evaluatePreprocExpr("UNITY_STANDALONE_WIN", D));
check("UNITY_2022_3_OR_NEWER defined (version 2022.3.41f1)", evaluatePreprocExpr("UNITY_2022_3_OR_NEWER", D));
check("UNITY_6000_0_OR_NEWER false on 2022 project", !evaluatePreprocExpr("UNITY_6000_0_OR_NEWER", D));
check("unknown symbol false", !evaluatePreprocExpr("SOME_CUSTOM_FLAG", D));
check("MY_TOOL custom define true", evaluatePreprocExpr("MY_TOOL", D));
check("&& / !", evaluatePreprocExpr("UNITY_EDITOR && !SOME_CUSTOM_FLAG", D));
check("|| chain", evaluatePreprocExpr("SOME_CUSTOM_FLAG || MY_TOOL", D));
check("parens + nesting", evaluatePreprocExpr("(DEBUG || MY_TOOL) && !SOME_CUSTOM_FLAG", D));
check("!= true", evaluatePreprocExpr("MY_TOOL != true", D) === false);
check("unity 6 version chain", versionDefines("6000.0.23f1").includes("UNITY_6000_0_OR_NEWER"));
check("unity 6 minor chain", versionDefines("6000.1.2f1").includes("UNITY_6000_1_OR_NEWER"));
try { evaluatePreprocExpr("A &&", D); check("malformed expr throws", false); }
catch { check("malformed expr throws", true); }

console.log("== scanner ==");
const src = [
  "using UnityEngine;",
  "",
  "#if !UNITY_EDITOR",
  "int wrongBranch = 1;",            // line 3 — inactive (grayed)
  "#endif",
  "",
  "#if SOME_UNKNOWN",
  "int unknownBranch = 2;",          // line 7 — inactive
  "#elif MY_TOOL",
  "int elifBranch = 3;",             // line 9 — active (MY_TOOL defined)
  "#else",
  "int elseBranch = 4;",             // line 11 — inactive (taken)
  "#endif",
  "",
  "#region Gameplay",
  "int activeCode = 5;",             // line 15
  "#endregion",
  "",
  "#pragma warning disable CS0168, CS0219",
  "int unusedA;",                    // line 19
  "#pragma warning restore CS0168",
  "int unusedB;",                    // line 21
  "",
  "#error SOMETHING_BAD",            // line 23 — error
  "#warning heads up",               // line 24 — warning
].join("\n");
const scan = scanPreproc(src, D);
check("line 3 inactive", scan.active[3] === 0);
check("line 7 inactive", scan.active[7] === 0);
check("line 9 active (elif with MY_TOOL)", scan.active[9] === 1);
check("line 11 inactive (else after taken)", scan.active[11] === 0);
check("line 15 active (region)", scan.active[15] === 1);
check("inactive runs merged", scan.inactive.length >= 2 && scan.inactive.some((r) => r.line === 3 && r.endLine === 3));
check("no structural errors", scan.diagnostics.filter((d) => /#endif|#endregion/.test(d.message)).length === 0, JSON.stringify(scan.diagnostics));
check("#error produced", scan.diagnostics.some((d) => d.severity === "error" && d.message.includes("SOMETHING_BAD")));
check("#warning produced", scan.diagnostics.some((d) => d.severity === "warning" && d.message.includes("heads up")));
check("pragma: CS0168 suppressed at line 19", pragmaSuppresses(scan.pragma, 19, "CS0168"));
check("pragma: CS0219 suppressed at line 19", pragmaSuppresses(scan.pragma, 19, "CS0219"));
check("pragma: CS0168 restored at line 21", !pragmaSuppresses(scan.pragma, 21, "CS0168"));
check("pragma: CS0219 still on at line 21", pragmaSuppresses(scan.pragma, 21, "CS0219"));

const unclosed = "#if UNITY_EDITOR\nint x = 1;\n";
const scan2 = scanPreproc(unclosed, D);
check("missing #endif error", scan2.diagnostics.some((d) => /Missing '#endif'/.test(d.message)));
const stray = "#endif\n";
const scan3 = scanPreproc(stray, D);
check("stray #endif error", scan3.diagnostics.some((d) => /Unexpected '#endif'/.test(d.message)));
const strayRegion = "#endregion\n";
check("stray #endregion error", scanPreproc(strayRegion, D).diagnostics.some((d) => /Unexpected '#endregion'/.test(d.message)));
const openRegion = "#region A\nint x;\n";
check("open #region error", scanPreproc(openRegion, D).diagnostics.some((d) => /Missing '#endregion'/.test(d.message)));
const inDefine = "#if TMP\n#define IN_TMP\nint a;\n#endif\nint b;\n";
const scan4 = scanPreproc(inDefine, D);
check("#define inside false branch not applied", scan4.active[2] === 0 && scan4.active[4] === 1);

console.log("== folding ==");
const fsrc = [
  "/// <summary>",
  "/// Player controller docs.",
  "/// </summary>",
  "public class Player : MonoBehaviour",
  "{",
  "    #region Health",
  "",
  "    /// <summary>",
  "    /// Current HP.",
  "    /// </summary>",
  "    public int HP { get; private set; }",
  "",
  "    // note: multi-line block comment follows",
  "    /* internal",
  "       tuning */",
  "    private int hp = 100;",
  "",
  "    public void TakeDamage(int amount, GameObject source)",
  "    {",
  "        if (amount <= 0)",
  "        {",
  "            return;",
  "        }",
  "        hp -= amount;",
  "    }",
  "",
  "    #endregion",
  "}",
].join("\n");
const folds = computeFoldRanges(fsrc);
const at = (k: string) => folds.filter((f) => f.kind === k);
check("class folds 3→28 (signature visible)", at("type").some((f) => f.startLine === 3 && f.endLine === 27), JSON.stringify(folds));
check("method folds 17→24", at("method").some((f) => f.startLine === 17 && f.endLine === 24));
check("if-block not a method fold", !at("method").some((f) => f.startLine === 19));
check("region 5→26", at("region").some((f) => f.startLine === 5 && f.endLine === 26));
check("doc run 0→2", at("doc").some((f) => f.startLine === 0 && f.endLine === 2));
check("inner doc run 7→9", at("doc").some((f) => f.startLine === 7 && f.endLine === 9));
check("block comment 13→14", at("comment").some((f) => f.startLine === 13 && f.endLine === 14));
check("control-flow block NOT folded", !folds.some((f) => f.startLine === 19));
const allman = "public class A\n{\n    void B()\n    {\n        int x;\n    }\n}";
const fa = computeFoldRanges(allman);
check("Allman: method folds from signature line 2", fa.some((f) => f.kind === "method" && f.startLine === 2 && f.endLine === 5), JSON.stringify(fa));

console.log("== xmldoc ==");
const doc = (line: number, ...l: string[]) => xmlDocSuggestion(l, line);
// fromLine = the line where /// was typed — the member starts BELOW it
const d0 = doc(2,
  "public class Player : MonoBehaviour",
  "{",
  "    /// cursor line",
  "    private void TakeDamage(float amount, GameObject source = null)",
  "    {",
  "    }",
  "}");
check("void method: params, NO returns", d0?.kind === "method" && d0.snippet.includes('<param name="amount">') && d0.snippet.includes('<param name="source">') && !d0.snippet.includes("<returns>"), d0?.snippet);
check("placeholder numbering unique (summary $1, first param $2)", d0?.snippet.includes("/// $1") === true && d0?.snippet.includes('<param name="amount">$2</param>') === true, d0?.snippet);
const d1 = doc(2,
  "public class Player : MonoBehaviour",
  "{",
  "    /// cursor line",
  "    public Vector3 GetTarget(float range, LayerMask mask)",
  "    {",
  "        return default;",
  "    }",
  "}");
check("method: params + returns", d1?.snippet.includes('<param name="range">$2</param>') === true && d1?.snippet.includes('<param name="mask">$3</param>') === true && d1?.snippet.includes("<returns>$4</returns>") === true, d1?.snippet);
const d2 = doc(0, "", "public class Player : MonoBehaviour", "{", "}");
check("type: summary only", d2?.kind === "type" && d2.snippet.includes("<summary>") && !d2.snippet.includes("<param>"), d2?.snippet);
const d3 = doc(2,
  "public class A",
  "{",
  "    /// cursor line",
  "    public int HP { get; private set; }",
  "}");
check("property: <value>", d3?.kind === "property" && d3.snippet.includes("<value>"), d3?.snippet);
const d4 = doc(2,
  "public class Player",
  "{",
  "    /// cursor line",
  "    public Player(int hp, string name)",
  "    {",
  "    }",
  "}");
check("ctor: params, no returns", d4?.kind === "constructor" && d4.snippet.includes('<param name="hp">') && !d4.snippet.includes("<returns>"), d4?.snippet);
const d5 = doc(2,
  "public class A",
  "{",
  "    /// cursor line",
  "    public void Tick()",
  "    {",
  "    }",
  "}");
check("void method: no returns tag", d5?.kind === "method" && !d5.snippet.includes("<returns>"), d5?.snippet);
const d6 = doc(2,
  "public class A",
  "{",
  "    /// cursor line",
  "    [Header(\"Stats\")]",
  "    [SerializeField]",
  "    private float moveSpeed = 6f;",
  "}");
check("attributes skipped → field summary doc", d6?.kind === "property" && d6.memberName === "moveSpeed" && !d6.snippet.includes("<value>"), d6?.snippet);
const d7 = doc(2,
  "public class A",
  "{",
  "    /// cursor line",
  "    public Vector3",
  "        GetTarget(",
  "            float range,",
  "            LayerMask mask)",
  "    {",
  "        return default;",
  "    }",
  "}");
check("multi-line signature parsed (params + returns)", d7?.snippet.includes('<param name="range">') === true && d7?.snippet.includes('<param name="mask">') === true && d7?.snippet.includes("<returns>") === true, d7?.snippet);
const d8 = doc(1, "using UnityEngine;", "");
check("nothing to document → null", d8 === null);

console.log(`\n==== SMOKE RESULT: ${pass}/${pass + fail} ====`);
process.exit(fail ? 1 : 0);
