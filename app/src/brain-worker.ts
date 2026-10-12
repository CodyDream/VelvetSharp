// VelvetSharp brain worker — ALL intelligence runs here so the UI thread never blocks:
// tree-sitter parsing, symbol indexing, diagnostics, completions, hover, semantic tokens.
import { VelvetSharpEngine } from "@brain/engine";

const ctx = self as any;

// probe: proves the worker module graph evaluated (client ignores unknown messages)
try { ctx.postMessage({ __bootProbe: true }); } catch { /* ignore */ }

let engine: VelvetSharpEngine | null = null;
let ready = false;
const queue: any[] = [];

function post(msg: any, transfer?: Transferable[]) {
  ctx.postMessage(msg, transfer ?? []);
}

async function init(): Promise<{ label: string; types: number; members: number }> {
  // wasm init and API DB fetches in parallel — DBs live only inside this worker
  const dbPromise = fetch(new URL("/api/unityengine.db.json", ctx.location.origin).href)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const bclPromise = fetch(new URL("/api/bcl.db.json", ctx.location.origin).href)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  engine = await VelvetSharpEngine.create({
    wasmLocator: (f: string) => new URL("/wasm/" + f, ctx.location.origin).href,
    unityDb: null,
  });

  const [db, bcl] = await Promise.all([dbPromise, bclPromise]);
  let label = "";
  if (db) {
    engine.unity.loadFromJson(db);
    label = `${db.assembly} ${db.version} · ${engine.unity.typeCount} types`;
    if (bcl) {
      engine.unity.mergeFromJson(bcl);
      label += ` · BCL ${engine.unity.typeCount} types`;
    }
  }
  return { label, types: engine.unity.typeCount, members: engine.unity.memberCount };
}

const handlers: Record<string, (p: any) => any> = {
  configureProjects: (p) => {
    engine!.setProjects(p.list ?? []);
    // v0.5.0 — assembly hunting: .asmdef graph gates completions per assembly
    if (p.asmdefs) engine!.setAssemblyGraph(p.asmdefs ?? []);
    return {
      projects: engine!.projectsSummary(),
      defines: engine!.definesOf(),
      asmdef: engine!.asmdefSummary(),
    };
  },
  loadFiles: async (p) => {
    await engine!.loadFiles(p.files ?? []);
    return { stats: { ...engine!.stats } };
  },
  updateFile: (p) => {
    const r = engine!.updateFile(p.path, p.content, !!p.deep);
    return {
      diagnostics: r.diagnostics,
      parseMs: r.parseMs,
      stats: { ...engine!.stats },
      symbols: r.symbols,
      sem: r.sem,
      assembly: engine!.assemblyOf(p.path),
      asm: engine!.assemblyRefsOf(p.path),
    };
  },
  // v0.5.0 — startup cache: index cached symbols without parsing / dump them back
  indexFromCache: (p) => {
    engine!.loadCachedSymbols(p.files ?? []);
    return { stats: { ...engine!.stats } };
  },
  filesSymbols: () => engine!.filesSymbols(),
  // v0.5.0 — project-wide diagnostics sweep, chunked so the worker stays responsive
  sweepChunk: (p) => {
    const results: any[] = [];
    for (const path of p.paths ?? []) {
      const r = engine!.sweepFile(path);
      if (r) results.push({ path, syntax: r.syntax, sem: r.sem });
    }
    return { results };
  },
  completions: (p) => engine!.completions(p.path, p.line, p.col),
  hover: (p) => engine!.hover(p.path, p.line, p.col),
  signatureHelp: (p) => engine!.signatureHelp(p.path, p.line, p.col),
  definitions: (p) => engine!.definitions(p.path, p.line, p.col),
  outline: (p) => engine!.outline(p.path),
  documentSymbols: (p) => engine!.outline(p.path),
  workspaceSymbols: (p) => engine!.workspaceSymbols(p.q ?? ""),
  search: (p) => engine!.search(p.q ?? "", p.opts ?? {}),
  semanticTokens: (p) => engine!.semanticTokens(p.path, p.content),
  semantic: (p) => engine!.semantic(p.path, p.content),

  // v0.6.0 — phase 6: dependency graph + rename refactoring
  depGraph: (p) => engine!.dependencyGraph(p.scope ?? null, !!p.includeExternal),
  renamePrepare: (p) => engine!.renamePrepare(p.path, p.line, p.col),
  rename: (p) => engine!.rename(p.path, p.line, p.col, p.newName ?? ""),
  // Phase 8 — usages panel (all project references + origin of a symbol)
  findUses: (p) => engine!.findUses(p.path, p.line, p.col),
  // Phase 9 — per-script call-flow graph (methods + external terminals)
  callFlow: (p) => engine!.callFlow(p.path),
  missingTrees: () => engine!.missingTrees(),
  removeFile: (p) => { engine!.removeFile(p.path); return { ok: true }; },
  // v0.7.0 — explorer file-operations sync (drop entries missing from a fresh scan)
  syncFiles: (p) => ({ removed: engine!.syncFiles(p.paths ?? []) }),
};

async function handle(m: any) {
  try {
    if (m.method === "init") {
      const payload = await init();
      ready = true;
      for (const q of queue) void handle(q);
      queue.length = 0;
      post({ __ready: true, payload });
      // also resolve the awaiting RPC call (client awaits init() before anything else)
      if (m.id !== undefined) post({ id: m.id, result: payload });
      return;
    }
    const result = await handlers[m.method](m.payload);
    const transfer: Transferable[] = [];
    if (result instanceof Uint32Array) transfer.push(result.buffer);
    post({ id: m.id, result }, transfer);
  } catch (err: any) {
    post({ id: m.id, error: String(err?.message ?? err) });
  }
}

ctx.onmessage = (e: MessageEvent) => {
  const m = e.data;
  // strictly queue every non-init call until the engine is ready (no interleaving)
  if (!ready && m.method !== "init") {
    queue.push(m);
    return;
  }
  void handle(m);
};
