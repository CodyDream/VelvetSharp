/** VelvetSharp — typed RPC client for the brain worker (promise per call). */
import BrainWorker from "./brain-worker.ts?worker";

interface Pending { res: (v: any) => void; rej: (e: any) => void }

export interface UpdateFileResult {
  diagnostics: { line: number; col: number; length: number; message: string; severity: string; source: string; fix?: QuickFixDto }[];
  parseMs: number;
  stats: { files: number; types: number; members: number; lastParseMs: number };
  symbols: { path: string; usings: string[]; namespaces: string[]; types: any[]; members: any[] };
  assembly: string | null;
  /** v0.5.0 — assembly reference info for the status chip */
  asm?: { name: string | null; refs: string[]; engine: boolean };
  /** v0.7.0 — deep semantic report from the same single parse (updateFile deep mode) */
  sem?: SemanticReport;
}

/** machine-applicable fix payload (addUsing) — mirrors brain QuickFix */
export interface QuickFixDto {
  kind: "addUsing";
  ns: string;
  title: string;
  line: number;
  col: number;
  text: string;
}

export class BrainClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private readyRes!: () => void;
  private readyRej!: (e: any) => void;

  readonly ready: Promise<void>;
  unityInfo = { label: "", types: 0, members: 0 };
  /** optional boot progress hook */
  onStatus: ((s: string) => void) | null = null;

  constructor() {
    this.worker = new BrainWorker();
    this.ready = new Promise((res, rej) => { this.readyRes = res; this.readyRej = rej; });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m?.__ready) {
        this.unityInfo = m.payload;
        this.readyRes();
        return;
      }
      if (m?.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error));
        else p.res(m.result);
      }
    };
    this.worker.onerror = (e) => {
      const msg = `brain worker crashed: ${e.message ?? "unknown"}`;
      this.onStatus?.(msg);
      this.readyRej(new Error(msg));
    };
  }

  private call<T = any>(method: string, payload?: any, transfer?: Transferable[]): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res, rej });
      this.worker.postMessage({ id, method, payload }, transfer ?? []);
    });
  }

  init() { return this.call("init"); }
  configureProjects(list: any[], asmdefs?: any[]) { return this.call("configureProjects", { list, asmdefs }); }
  loadFiles(files: { path: string; content: string }[]) { return this.call("loadFiles", { files }); }
  updateFile(path: string, content: string, deep = false) {
    return this.call<UpdateFileResult>("updateFile", { path, content, deep });
  }
  /** v0.5.0 — startup cache: index cached symbols without parsing */
  indexFromCache(files: { path: string; symbols: any }[]) { return this.call("indexFromCache", { files }); }
  /** v0.5.0 — dump the symbol index (written into the startup cache) */
  filesSymbols() { return this.call<{ path: string; symbols: any }[]>("filesSymbols"); }
  /** v0.5.0 — project-wide diagnostics sweep for a chunk of files */
  sweepChunk(paths: string[]) { return this.call<{ results: SweepResult[] }>("sweepChunk", { paths }); }
  completions(path: string, line: number, col: number) { return this.call<any[]>("completions", { path, line, col }); }
  hover(path: string, line: number, col: number) { return this.call<any>("hover", { path, line, col }); }
  signatureHelp(path: string, line: number, col: number) { return this.call<any>("signatureHelp", { path, line, col }); }
  definitions(path: string, line: number, col: number) { return this.call<any>("definitions", { path, line, col }); }
  outline(path: string) { return this.call<any[]>("outline", { path }); }
  workspaceSymbols(q: string) { return this.call<any[]>("workspaceSymbols", { q }); }
  search(q: string, opts: any = {}) { return this.call<any[]>("search", { q, opts }); }
  semanticTokens(path: string, content: string) { return this.call<Uint32Array>("semanticTokens", { path, content }); }
  semantic(path: string, content?: string) { return this.call<SemanticReport>("semantic", { path, content }); }

  // ---- v0.6.0 — phase 6: dependency graph + rename refactoring ----
  depGraph(scope: string | null, includeExternal = false) {
    return this.call<DepGraphResult>("depGraph", { scope, includeExternal });
  }
  renamePrepare(path: string, line: number, col: number) {
    return this.call<RenamePrepareResult>("renamePrepare", { path, line, col });
  }
  rename(path: string, line: number, col: number, newName: string) {
    return this.call<RenamePlanResult>("rename", { path, line, col, newName });
  }
  /** Phase 8 — all project references of the symbol at the caret + origin */
  findUses(path: string, line: number, col: number) {
    return this.call<SymbolUsesResult>("findUses", { path, line, col });
  }
  /** Phase 9 — per-script call-flow graph (methods + external terminals) */
  callFlow(path: string) {
    return this.call<CallFlowResult>("callFlow", { path });
  }
  /** files indexed from the startup cache without a parse tree — parse these
   *  before renaming so references inside them are not missed */
  missingTrees() { return this.call<string[]>("missingTrees"); }
  /** drop a file from the index (after a file move / delete) */
  removeFile(path: string) { return this.call<{ ok: boolean }>("removeFile", { path }); }
  /** v0.7.0 — drop every indexed file not in the fresh scan (explorer sync) */
  syncFiles(paths: string[]) { return this.call<{ removed: string[] }>("syncFiles", { paths }); }
}

export interface DepNodeResult {
  id: string; name: string; kind: string; file: string; line: number;
  ns: string; asm: string | null; isMono: boolean; external: boolean;
  outOfScope?: boolean; singleton?: boolean; refCount: number; outDeg: number; inDeg: number;
}
export interface DepEdgeResult { from: string; to: string; kind: "extends" | "implements" | "uses" | "self"; weight: number }
export interface DepGraphResult {
  scope: string;
  nodes: DepNodeResult[];
  edges: DepEdgeResult[];
  truncated: boolean;
  totalTypes?: number;      // in-scope types before capping ("top N of M")
}
export interface RenamePrepareResult {
  ok: boolean;
  reason?: string;
  target?: {
    kind: string; name: string; fqn: string; container: string;
    declFile: string; declLine: number; declCol: number;
    scope: "local" | "member" | "type"; ownerTypeFqn: string; via?: string;
  };
}
export interface RenamePlanResult {
  ok: boolean;
  reason?: string;
  target?: RenamePrepareResult["target"];
  newName?: string;
  edits: { path: string; ranges: { line: number; col: number; length: number }[] }[];
  fileRename?: { from: string; to: string; metaFrom?: string; metaTo?: string } | null;
  warnings: string[];
}

/** Phase 8 — usages panel payload */
export interface UseHitDto {
  file: string;
  line: number;
  col: number;
  length: number;
  text: string;
  isDecl: boolean;
}
export interface SymbolUsesResult {
  ok: boolean;
  reason?: string;
  name?: string;
  kind?: string;
  container?: string;
  declFile?: string;
  declLine?: number;
  declCol?: number;
  origin?: string;
  uses: UseHitDto[];
  warnings: string[];
}

/** Phase 9 — call-flow payload (per-script method graph) */
export interface FlowNodeDto {
  id: string;
  label: string;
  kind: "method" | "external";
  container: string;
  line: number;
  ret: string;
  entry: boolean;
  unityMsg: boolean;
}
export interface FlowEdgeDto { from: string; to: string; count: number; external: boolean }
export interface CallFlowResult {
  ok: boolean;
  reason?: string;
  file: string;
  nodes: FlowNodeDto[];
  edges: FlowEdgeDto[];
  truncated: boolean;
  methodCount: number;
  extCount: number;
}

export interface SemRange { line: number; col: number; endLine: number; endCol: number }
export interface SemanticReport {
  diagnostics: { line: number; col: number; length: number; message: string; severity: string; source: string; fix?: QuickFixDto }[];
  unreachable: SemRange[];
  obsolete: SemRange[];
}
/** one file's chunked-sweep result (project-wide Problems bar) */
export interface SweepResult {
  path: string;
  syntax: UpdateFileResult["diagnostics"];
  sem: SemanticReport;
}
