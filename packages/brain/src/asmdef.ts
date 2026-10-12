/** VelvetSharp brain — Assembly Definition (.asmdef) support (v0.5.0).
 *
 *  Unity projects split scripts into assemblies via .asmdef JSON files. Each
 *  .asmdef gets a GUID (stored in its sibling .asmdef.meta); other assemblies
 *  reference it as "GUID:<hex>" (or by plain name in older projects).
 *
 *  "Assembly hunting" = collecting { .asmdef → guid } pairs and resolving every
 *  GUID reference into a concrete assembly name so the completion engine can
 *  scope its suggestions: a file may only see types from its own assembly plus
 *  the assemblies its assembly actually references (plus auto-referenced ones,
 *  the engine, and the BCL) — exactly like the Unity compiler does. */

export interface AsmdefInfo {
  path: string;              // workspace-relative, forward slashes ("Assets/Net/GameServerAssembly.asmdef")
  dir: string;               // directory part ("Assets/Net")
  name: string;              // assembly name ("GameServerAssembly")
  rootNamespace: string;
  references: string[];      // raw reference strings ("GUID:38b4…" or "OtherAssembly")
  precompiledReferences: string[];  // DLL names when overrideReferences is on
  autoReferenced: boolean;   // every other assembly implicitly references this one
  noEngineReferences: boolean; // UnityEngine is NOT referenced
  overrideReferences: boolean;
  guid?: string;             // from the sibling .asmdef.meta ("guid: 38b4…")
}

/** parse a .asmdef JSON body — tolerant of BOM/comments/trailing junk */
export function parseAsmdef(text: string, path: string): AsmdefInfo | null {
  try {
    const cleaned = text.replace(/^\uFEFF/, "").replace(/^\s*\/\/.*$/gm, "");
    const j = JSON.parse(cleaned);
    if (!j || typeof j.name !== "string" || !j.name.trim()) return null;
    const norm = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
    return {
      path,
      dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
      name: j.name.trim(),
      rootNamespace: typeof j.rootNamespace === "string" ? j.rootNamespace : "",
      references: norm(j.references),
      precompiledReferences: norm(j.precompiledReferences),
      autoReferenced: j.autoReferenced !== false,
      noEngineReferences: j.noEngineReferences === true,
      overrideReferences: j.overrideReferences === true,
      guid: j.guid,
    };
  } catch {
    return null;
  }
}

/** extract the guid from a .asmdef.meta body — the file is a few lines of YAML */
export function guidFromMeta(metaText: string): string | null {
  const m = metaText.match(/guid:\s*([0-9a-fA-F]{32})/);
  return m ? m[1].toLowerCase() : null;
}

export interface AssemblyGraph {
  /** resolved reference edges: assembly name → referenced assembly names */
  refsOf: Map<string, Set<string>>;
  /** normalized rel file → owning assembly (csproj Compile items first, asmdef dirs as fallback) */
  assemblyByFile: Map<string, string>;
  /** asmdef dir prefixes, deepest first (fallback file→assembly for files without csproj entry) */
  asmDirs: { dir: string; name: string }[];
  /** assemblies without an .asmdef (Unity "predefined": Assembly-CSharp & friends) */
  predefined: Set<string>;
  /** asmdef assembly names */
  asmNames: Set<string>;
  /** references that could not be resolved (GUID with no matching .meta, unknown name) */
  unresolved: { from: string; ref: string }[];
  /** assemblies that reference the engine (UnityEngine) */
  usesEngine: Set<string>;
}

const isPredefinedName = (n: string): boolean => /^Assembly-CSharp/i.test(n) || /^Assembly-UnityScript/i.test(n);

/** build the assembly reference graph from parsed .asmdef files + csproj infos.
 *  `csprojs` needs only { name, compileFiles, unityReferences }. */
export function buildAssemblyGraph(
  asmdefs: AsmdefInfo[],
  csprojs: { name: string; compileFiles: string[]; unityReferences: string[] }[],
): AssemblyGraph {
  const g: AssemblyGraph = {
    refsOf: new Map(),
    assemblyByFile: new Map(),
    asmDirs: [],
    predefined: new Set(),
    asmNames: new Set(),
    unresolved: [],
    usesEngine: new Set(),
  };

  // ---- guid → assembly name (assembly hunting core) ----
  const byGuid = new Map<string, string>();
  const byName = new Map<string, AsmdefInfo>();
  for (const a of asmdefs) {
    byName.set(a.name, a);
    if (a.guid) byGuid.set(a.guid.toLowerCase(), a.name);
    g.asmNames.add(a.name);
  }

  // ---- file → asmdef assembly via directory prefix (deepest dir wins) ----
  for (const a of asmdefs) g.asmDirs.push({ dir: a.dir, name: a.name });
  g.asmDirs.sort((x, y) => y.dir.length - x.dir.length);

  // ---- csproj file mapping (exact Compile items — Unity generates one csproj per assembly) ----
  for (const p of csprojs) {
    for (const f of p.compileFiles) {
      const key = f.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
      g.assemblyByFile.set(key, p.name);
    }
  }

  // ---- resolve reference edges ----
  const refsFor = (name: string): Set<string> => g.refsOf.get(name) ?? (() => {
    const s = new Set<string>();
    g.refsOf.set(name, s);
    return s;
  })();

  for (const a of asmdefs) {
    const refs = refsFor(a.name);
    for (const raw of a.references) {
      let target: string | null = null;
      if (/^guid:/i.test(raw)) {
        const guid = raw.slice(5).trim().toLowerCase();
        target = byGuid.get(guid) ?? null;
      } else {
        target = byName.get(raw)?.name ?? null;
      }
      if (target && target !== a.name) refs.add(target);
      else if (!target) g.unresolved.push({ from: a.name, ref: raw });
    }
    // auto-referenced assemblies are implicitly visible to every other assembly
    // (handled at query time via isAutoReferenced, not materialized as edges)
    if (!a.noEngineReferences) g.usesEngine.add(a.name);
  }

  // ---- predefined assemblies (Assembly-CSharp family from csprojs or defaults) ----
  for (const p of csprojs) {
    if (g.asmNames.has(p.name)) continue; // csproj for an asmdef-backed assembly
    g.predefined.add(p.name);
    const refs = refsFor(p.name);
    // predefined assemblies reference every auto-referenced asmdef
    for (const a of asmdefs) if (a.autoReferenced) refs.add(a.name);
    // engine visibility per csproj Unity references (Assembly-CSharp-Editor etc.)
    if (p.unityReferences.length > 0) g.usesEngine.add(p.name);
  }
  // files without any csproj coverage fall back to a virtual Assembly-CSharp
  if (!g.predefined.has("Assembly-CSharp") && !g.asmNames.has("Assembly-CSharp")) {
    g.predefined.add("Assembly-CSharp");
    const refs = refsFor("Assembly-CSharp");
    for (const a of asmdefs) if (a.autoReferenced) refs.add(a.name);
    g.usesEngine.add("Assembly-CSharp");
  }
  // predefined always see the engine + BCL (their csprojs list UnityEngine*)
  for (const n of g.predefined) g.usesEngine.add(n);

  return g;
}

export function normalizeFileKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

/** which assembly owns this file? csproj match → nearest asmdef dir → predefined guess */
export function assemblyForFile(g: AssemblyGraph, relPath: string): string | null {
  const key = normalizeFileKey(relPath);
  const exact = g.assemblyByFile.get(key);
  if (exact) return exact;
  const dir = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
  for (const { dir: adir, name } of g.asmDirs) {
    const ad = normalizeFileKey(adir);
    if (!ad || dir === ad || dir.startsWith(ad + "/")) return name;
  }
  if (g.predefined.size) {
    // Editor/ folders map to the editor variant when it exists
    if (/(^|\/)Editor(\/|$)/.test(dir)) {
      for (const p of g.predefined) if (/editor/i.test(p)) return p;
    }
    for (const p of g.predefined) if (!/editor/i.test(p)) return p;
  }
  return null;
}

/** can a script in `fromAsm` see types from `toAsm`?
 *  (same assembly, explicit/auto reference, or unknown-from → permissive) */
export function canSeeAssembly(g: AssemblyGraph, fromAsm: string | null, toAsm: string): boolean {
  if (!fromAsm) return true;                       // unassigned files stay permissive
  if (fromAsm === toAsm) return true;
  return g.refsOf.get(fromAsm)?.has(toAsm) === true;
}

/** does this assembly reference UnityEngine? (noEngineReferences honours the asmdef flag) */
export function seesEngine(g: AssemblyGraph, fromAsm: string | null): boolean {
  if (!fromAsm) return true;
  if (g.asmNames.has(fromAsm)) return g.usesEngine.has(fromAsm);
  return true; // predefined / unknown → engine visible (csproj listed it)
}
