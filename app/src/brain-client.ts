/** VelvetSharp — typed RPC client for the brain workers (Phase 12 two-lane design).
 *
 *  WHY TWO LANES (user report: "sometimes the bridge/brain fails and autocomplete
 *  falls back to plain word suggestions"):
 *
 *  Phase ≤11 ran ONE worker for EVERYTHING. Every typing pause (70 ms debounce)
 *  queues a full deep re-analysis on that worker, and the worker processes
 *  messages strictly sequentially — a completion made mid-analysis waited for
 *  the whole parse (54 ms on 131 lines, 240 ms on 900, 1.3 s on 3 600). The
 *  completion provider only budgets 40 ms before falling back, so under load
 *  the widget popped late, thin, or not at all.
 *
 *  The fix is structural: TWO workers from the SAME brain-worker module.
 *    fast lane  — interactive RPCs only (completions/hover/signature/definitions/
 *                 outline/symbols/search). Every edit mirrors a LIGHT updateFile
 *                 (parse + index, no semantic walk) so its answers are fresh and
 *                 it answers in single-digit milliseconds even while a huge file
 *                 is being analyzed on the other lane.
 *    heavy lane — analysis RPCs (deep updateFile, sweeps, semantic tokens,
 *                 graphs, rename, uses, call flow). Latency here only affects
 *                 the Problems bar / colors / graphs, never the suggest widget.
 *
 *  CRASH RECOVERY (was: a crashed worker never rejected pending calls and never
 *  restarted — member-access completions could wait forever):
 *    - every call has a per-lane timeout and rejects deterministically;
 *    - worker error/exit → all pending calls on that lane reject with a typed
 *      error, the lane RESPAWNS, and `onRespawn` lets the app re-sync engine
 *      state from disk (configureProjects + syncFiles + loadFiles mirror to
 *      both lanes, so the respawned lane rebuilds in the correct order);
 *    - two consecutive per-lane timeouts are treated as a wedged worker and
 *      also trigger the respawn (the counter resets on every success — the
 *      old bridge bug pattern cannot happen here).
 */
import BrainWorker from "./brain-worker.ts?worker";

export type BrainLane = "fast" | "heavy";

interface LanePending { res: (v: any) => void; rej: (e: any) => void; timer?: ReturnType<typeof setTimeout> }
type ResyncFn = (lane: BrainLane) => Promise<void>;

/** interactive lane — answers are expected in single-digit ms; 5 s is already
 *  pathological (huge-file first light parse is ≈0.1 s) */
const FAST_TIMEOUT_MS = 5_000;
/** analysis lane — sweep chunks / deep parses / rename on huge projects */
const HEAVY_TIMEOUT_MS = 120_000;
const INIT_TIMEOUT_MS = 180_000;
/** consecutive timeouts before a lane is declared wedged and respawned */
const LANE_TIMEOUT_RESPAWN = 2;

/** methods that MUST run on the interactive lane */
const FAST_METHODS = new Set([
  "completions", "hover", "signatureHelp", "definitions",
  "outline", "documentSymbols", "workspaceSymbols", "search", "searchProject",
  "preprocCatalog",
]);
/** state-changing calls that BOTH lanes must see (engine state mirroring) */
const MIRROR_METHODS = new Set([
  "configureProjects", "loadFiles", "indexFromCache", "syncFiles", "removeFile",
]);

/* ---------------------------- lane worker ---------------------------- */

class LaneWorker {
  readonly lane: BrainLane;
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, LanePending>();
  private readyRes: (() => void) | null = null;
  private readyRej: ((e: any) => void) | null = null;
  private readyP: Promise<void> | null = null;
  private consecTimeouts = 0;
  private respawning = false;
  /** gate for calls made while the lane is down + resyncing */
  private resyncing: Promise<void> | null = null;

  constructor(private client: BrainClient, lane: BrainLane) {
    this.lane = lane;
    this.spawn();
  }

  private spawn(): void {
    this.readyP = new Promise((res, rej) => { this.readyRes = res; this.readyRej = rej; });
    const w = new BrainWorker();
    this.worker = w;
    w.onmessage = (e: MessageEvent) => {
      const m: any = e.data;
      if (m?.__bootProbe) return; // module-graph probe — not a ready signal
      if (m?.__ready) {
        this.consecTimeouts = 0;
        if (this.lane === "fast" || !this.client.unityInfo.label) this.client.unityInfo = m.payload;
        this.readyRes?.();
        this.readyRes = null; this.readyRej = null;
        return;
      }
      if (m?.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        this.consecTimeouts = 0; // ANY successful answer proves the lane is alive
        if (m.error) p.rej(new Error(m.error));
        else p.res(m.result);
      }
    };
    const crashed = (why: string) => {
      // a superseded worker (respawn already ran) must not double-fire
      if (this.worker !== w) return;
      void this.handleCrash(`brain ${this.lane} lane crashed: ${why}`);
    };
    w.onerror = (e) => crashed(e.message ?? "unknown error");
    w.onmessageerror = () => crashed("unserializable message");
  }

  get ready(): Promise<void> { return this.readyP ?? Promise.resolve(); }

  /** deterministic per-call timeout; consecutive timeouts ⇒ wedged ⇒ respawn */
  call<T = any>(method: string, payload?: any, timeoutMs?: number, transfer?: Transferable[]): Promise<T> {
    const laneTimeout = this.lane === "fast" ? FAST_TIMEOUT_MS : HEAVY_TIMEOUT_MS;
    const budget = timeoutMs ?? laneTimeout;
    const exec = async (): Promise<T> => {
      // mirror calls bypass the resync gate — the respawn's own onRespawn uses
      // them to rebuild the engine, so gating them would deadlock; the worker
      // buffers them until its engine is ready and drains them in order
      if (this.resyncing && !MIRROR_METHODS.has(method)) await this.resyncing;
      if (!this.worker) throw new Error(`brain ${this.lane} lane is down`);
      const id = ++this.seq;
      return new Promise<T>((res, rej) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.consecTimeouts++;
          if (this.consecTimeouts >= LANE_TIMEOUT_RESPAWN) {
            void this.handleCrash(`${this.consecTimeouts} consecutive timeouts — wedged worker`);
            this.consecTimeouts = 0;
          }
          rej(new Error(`brain ${this.lane} lane timeout after ${Math.round(budget / 100) / 10}s — ${method}`));
        }, budget);
        this.pending.set(id, { res, rej, timer });
        try { this.worker!.postMessage({ id, method, payload }, transfer ?? []); }
        catch (e: any) { clearTimeout(timer); this.pending.delete(id); rej(new Error(`brain ${this.lane} lane send failed — ${method}: ${e?.message ?? e}`)); }
      });
    };
    return exec();
  }

  /** crash recovery: reject pending deterministically, respawn, resync */
  async handleCrash(why: string): Promise<void> {
    if (this.respawning) return; // one recovery at a time
    this.respawning = true;
    this.client.onStatus?.(`${why} — restarting the ${this.lane} lane…`);
    const dead = this.worker;
    this.worker = null;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.rej(new Error(`${why} (${this.lane} lane)`)); }
    this.pending.clear();
    try { dead?.terminate(); } catch { /* already gone */ }
    // respawn + re-sync: the fresh worker has an EMPTY engine, so the app
    // re-applies project config / file index via the normal mirrored calls.
    this.resyncing = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          this.spawn();
          // the fresh worker does NOT self-init — the boot path sends init via
          // client.init(); a respawn owns its own init handshake (THE BUG this
          // line fixes: without it the respawned worker waited forever and the
          // whole recovery stalled until the init-timeout race gave up)
          this.worker!.postMessage({ id: ++this.seq, method: "init", payload: undefined });
          await Promise.race([this.ready, new Promise((_, rj) => setTimeout(() => rj(new Error("respawn init timeout")), INIT_TIMEOUT_MS))]);
          await this.client.onRespawn?.(this.lane);
          this.client.onStatus?.(`brain ${this.lane} lane is back online`);
          return;
        } catch (e: any) {
          this.client.onStatus?.(`brain ${this.lane} lane restart failed (attempt ${attempt + 1}/3): ${e?.message ?? e}`);
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
      // give up for now: settle `ready` so boot/callers can proceed — calls on
      // this lane throw "lane is down" (the provider degrades to floors) and a
      // future crash/timeout retries the whole recovery
      this.client.onStatus?.(`brain ${this.lane} lane is DOWN — interactive features degraded until it recovers`);
      this.readyRes?.();
      this.readyRes = null; this.readyRej = null;
    })();
    try { await this.resyncing; } finally { this.resyncing = null; this.respawning = false; }
  }

  /** E2E / diagnostic hook: force the crash-recovery pipeline deterministically */
  simulateCrash(): void { void this.handleCrash("simulated crash (diagnostics)"); }
}

/* ---------------------------- client ---------------------------- */

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
  private fast: LaneWorker;
  private heavy: LaneWorker;
  private seq = 0;

  readonly ready: Promise<void>;
  unityInfo = { label: "", types: 0, members: 0 };
  /** boot/respawn progress hook (status bar) */
  onStatus: ((s: string) => void) | null = null;
  /** app-provided engine re-sync after a lane respawn (configureProjects + loadFiles) */
  onRespawn: ResyncFn | null = null;

  constructor() {
    this.fast = new LaneWorker(this, "fast");
    this.heavy = new LaneWorker(this, "heavy");
    this.ready = Promise.all([this.fast.ready, this.heavy.ready]).then(() => undefined);
  }

  private async route<T>(method: string, payload?: any, timeoutMs?: number, transfer?: Transferable[]): Promise<T> {
    if (MIRROR_METHODS.has(method)) {
      // both lanes must see engine state changes; the heavy result wins
      const [ , heavy ] = await Promise.all([
        this.fast.call(method, payload, timeoutMs, transfer).catch((e) => {
          // a fast-lane mirror failure must not kill the caller — the crash
          // recovery path already restarts it; the heavy lane stays truth
          this.onStatus?.(`fast-lane mirror of "${method}" failed: ${e?.message ?? e}`);
          return null;
        }),
        this.heavy.call<any>(method, payload, timeoutMs, transfer),
      ]);
      return heavy as T;
    }
    const lane = FAST_METHODS.has(method) ? this.fast : this.heavy;
    return lane.call<T>(method, payload, timeoutMs, transfer);
  }

  private call<T = any>(method: string, payload?: any, timeoutMs?: number, transfer?: Transferable[]): Promise<T> {
    void this.seq; // ids live per-lane now; kept for wire-format familiarity
    return this.route<T>(method, payload, timeoutMs, transfer);
  }

  init() {
    // both lanes boot in parallel; each fetches the same Unity DB (HTTP-cached)
    return Promise.all([this.fast.call("init", undefined, INIT_TIMEOUT_MS), this.heavy.call("init", undefined, INIT_TIMEOUT_MS)]);
  }
  configureProjects(list: any[], asmdefs?: any[], unity?: { version: string; defines: string[] }) { return this.call("configureProjects", { list, asmdefs, unity }); }
  loadFiles(files: { path: string; content: string }[]) { return this.call("loadFiles", { files }); }
  updateFile(path: string, content: string, deep = false) {
    // fast lane mirrors LIGHT (parse+index only) so interactive answers stay
    // fresh; the heavy lane runs the caller's request and returns its result.
    void this.fast.call("updateFile", { path, content, deep: false }).catch(() => { /* crash path owns it */ });
    return this.heavy.call<UpdateFileResult>("updateFile", { path, content, deep });
  }
  /** v0.5.0 — startup cache: index cached symbols without parsing */
  indexFromCache(files: { path: string; symbols: any }[]) { return this.call("indexFromCache", { files }); }
  /** v0.5.0 — dump the symbol index (written into the startup cache) */
  filesSymbols() { return this.call<{ path: string; symbols: any }[]>("filesSymbols"); }
  /** v0.5.0 — project-wide diagnostics sweep for a chunk of files */
  sweepChunk(paths: string[]) { return this.call<{ results: SweepResult[] }>("sweepChunk", { paths }); }
  completions(path: string, line: number, col: number) { return this.call<any[]>("completions", { path, line, col }); }
  hover(path: string, line: number, col: number) { return this.call<any>("hover", { path, line, col }); }
  /** Phase 15 — preprocessor symbol catalog: Unity built-ins, version chain,
   *  csproj/scripting defines and in-code #define sites (fast lane — small, cached client-side) */
  preprocCatalog() { return this.call<{ symbols: any[] }>("preprocCatalog", {}); }
  signatureHelp(path: string, line: number, col: number) { return this.call<any>("signatureHelp", { path, line, col }); }
  definitions(path: string, line: number, col: number) { return this.call<any>("definitions", { path, line, col }); }
  outline(path: string) { return this.call<any[]>("outline", { path }); }
  workspaceSymbols(q: string) { return this.call<any[]>("workspaceSymbols", { q }); }
  search(q: string, opts: any = {}) { return this.call<any[]>("search", { q, opts }); }
  /** Phase 14 — find-in-files with options + coverage report (unsearched files) */
  searchProject(q: string, opts: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; max?: number } = {}) {
    return this.call<ProjectSearchResult>("searchProject", { q, opts });
  }
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

  /** Phase 12 diagnostics: force the crash-recovery pipeline on a lane */
  simulateCrash(lane: BrainLane = "fast") {
    (lane === "fast" ? this.fast : this.heavy).simulateCrash();
  }
  /** Phase 12 diagnostics: which lanes exist (bundle marker + self-test) */
  get lanes(): BrainLane[] { return ["fast", "heavy"]; }
}

export interface DepNodeResult {
  id: string; name: string; kind: string; file: string; line: number;
  ns: string; asm: string | null; isMono: boolean; external: boolean;
  outOfScope?: boolean; singleton?: boolean; refCount: number; outDeg: number; inDeg: number;
  cross?: boolean;         // Phase 13 call-flow — custom method declared in ANOTHER script (terminal)
  ret?: string; entry?: boolean; unityMsg?: boolean;
}
export interface DepEdgeResult { from: string; to: string; kind: "extends" | "implements" | "uses" | "self" | "call" | "extcall"; weight: number; order?: number }
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

/** Phase 9 — call-flow payload (per-script method graph).
 *  Phase 13 — ONLY custom methods are drawn: engine/API calls are counted in
 *  hiddenCalls/extCount (toolbar chip), calls into the user's other scripts
 *  arrive as cross:true terminal nodes carrying the defining file, and every
 *  edge carries its 1-based call-order rank within the caller's body. */
export interface FlowNodeDto {
  id: string;
  label: string;
  kind: "method" | "external";
  container: string;
  line: number;
  ret: string;
  entry: boolean;
  unityMsg: boolean;
  cross?: boolean;   // declared in ANOTHER script (terminal node)
  file?: string;     // defining script (cross nodes)
}
export interface FlowEdgeDto { from: string; to: string; count: number; external: boolean; order?: number }
export interface CallFlowResult {
  ok: boolean;
  reason?: string;
  errorStack?: string;   // full stack when ok:false is an internal error (copyable in the UI)
  file: string;
  nodes: FlowNodeDto[];
  edges: FlowEdgeDto[];
  truncated: boolean;
  methodCount: number;
  extCount: number;
  hiddenCalls?: number;  // engine/API call sites not drawn
  crossCount?: number;   // cross-file custom methods drawn
}

export interface SemRange { line: number; col: number; endLine: number; endCol: number }
/** Phase 14 — find-in-files result: hits + which files could not be searched
 *  yet (indexed from the startup cache without text; scan them to complete) */
export interface ProjectSearchResult {
  hits: { file: string; line: number; col: number; length: number; text: string }[];
  searched: string[];
  unsearched: string[];
  truncated: boolean;
  max: number;
  error?: string;
}
export interface SemanticReport {
  diagnostics: { line: number; col: number; length: number; message: string; severity: string; source: string; fix?: QuickFixDto }[];
  unreachable: SemRange[];
  obsolete: SemRange[];
  /** Phase 11 — preprocessor-inactive runs (dimmed in the editor) */
  inactive?: SemRange[];
}
/** one file's chunked-sweep result (project-wide Problems bar) */
export interface SweepResult {
  path: string;
  syntax: UpdateFileResult["diagnostics"];
  sem: SemanticReport;
}
