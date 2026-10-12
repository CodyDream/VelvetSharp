/** VelvetSharp brain — csproj auto-detection & parsing (Unity-generated MSBuild files).
 *  Unity csproj files are plain XML listing Compile items, DefineConstants and references.
 *  We parse with regexes (no DOM dependency) — robust to 100KB+ generated files. */

export interface CsprojInfo {
  path: string;
  name: string;              // assembly name (Assembly-CSharp)
  defines: string[];         // DefineConstants, split & deduped
  langVersion?: string;
  targetFramework?: string;
  rootNamespace?: string;
  compileFiles: string[];    // normalized relative paths (forward slashes)
  unityReferences: string[]; // UnityEngine* module references
  referenceCount: number;
  projectRefs: number;
  implicitUsings?: boolean;  // <ImplicitUsings>enable</ImplicitUsings> — System + friends are auto-visible
  references: string[];      // all <Reference Include> names (deduped) — BCL gating (System.Core → Linq)
}

function allTags(text: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\s*>([^<]*?)</${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return out;
}

/** XML entity decode — Unity emits paths like `Examples &amp; Extras` */
function xmlDecode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function parseCsproj(text: string, path: string): CsprojInfo {
  // DefineConstants appear per-configuration (Debug/Release) — merge & dedupe.
  const defineSet = new Set<string>();
  for (const raw of allTags(text, "DefineConstants")) {
    for (const d of raw.split(";")) {
      const t = d.trim();
      // skip MSBuild property expressions like $(DefineConstants)
      if (t && !t.includes("$(")) defineSet.add(t);
    }
  }

  const compileFiles: string[] = [];
  const cRe = /<Compile\s+Include="([^"]+)"/gi;
  let cm: RegExpExecArray | null;
  while ((cm = cRe.exec(text))) {
    const p = xmlDecode(cm[1].replace(/\\/g, "/").replace(/^\.\//, "").split('"')[0].trim());
    if (p && p.toLowerCase().endsWith(".cs")) compileFiles.push(p);
  }

  const references: string[] = [];
  const rRe = /<Reference\s+Include="([^">]+)"/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rRe.exec(text))) {
    const name = rm[1].split(",")[0].trim();
    if (name) references.push(name);
  }
  const dedupedRefs = [...new Set(references)];

  // ImplicitUsings: Unity 6 emits <ImplicitUsings>enable</ImplicitUsings> — the
  // compiler then auto-imports System, System.Collections.Generic, System.IO,
  // System.Linq, System.Net.Http, System.Threading, System.Threading.Tasks.
  const iu = allTags(text, "ImplicitUsings")[0]?.toLowerCase();
  const implicitUsings = iu === "enable" || iu === "true";

  return {
    path,
    name: allTags(text, "AssemblyName")[0] ?? path.replace(/\.csproj$/i, "").split("/").pop() ?? "project",
    defines: [...defineSet],
    langVersion: allTags(text, "LangVersion")[0],
    targetFramework: allTags(text, "TargetFrameworkVersion")[0] ?? allTags(text, "TargetFramework")[0],
    rootNamespace: allTags(text, "RootNamespace")[0],
    compileFiles,
    unityReferences: [...new Set(references.filter((r) => r.startsWith("UnityEngine")))],
    referenceCount: references.length,
    projectRefs: (text.match(/<ProjectReference\s+Include=/gi) ?? []).length,
    implicitUsings,
    references: dedupedRefs,
  };
}

/** normalize a relative path for file→assembly matching */
export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}
