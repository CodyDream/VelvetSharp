/** VelvetSharp brain — shared types */

export interface FileEntry {
  path: string;
  content: string;
}

export type SymbolKind =
  | "class" | "struct" | "interface" | "enum" | "delegate"
  | "method" | "property" | "field" | "event" | "enumMember"
  | "namespace" | "local" | "parameter";

export interface ParamInfo { name: string; type: string; doc?: string }

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  ns?: string;                // declaring namespace ("" for global)
  container: string;          // FQN of containing type ("" for top-level)
  fqn: string;                // full name incl container
  returnType?: string;
  params?: ParamInfo[];
  static?: boolean;
  abstract?: boolean;
  sealed?: boolean;
  partial?: boolean;          // v0.6.1 — partial type (legal to re-declare across files)
  generics?: string[];
  base?: string;
  interfaces?: string[];
  file: string;
  line: number;               // 0-based
  col: number;
  doc?: string;
  enumValue?: string;
}

/** classification of one identifier occurrence (v0.6.0 — dependency graph + rename) */
export interface IdentRef {
  name: string;
  line: number;          // 0-based
  col: number;
  length: number;
  ctx:
    | "decl"             // declaration name (type/member/local/param)
    | "ctor"             // constructor name (binds to its class)
    | "attr"             // attribute name (binds to *Attribute type)
    | "typePos"          // type position: base list, generic args, cast, new, typeof, param/return types…
    | "member"           // right side of `recv.name` (recv captured separately by rename)
    | "bare";            // plain identifier expression
}

export interface FileSymbols {
  path: string;
  usings: string[];
  namespaces: string[];
  types: SymbolInfo[];        // types declared in this file
  members: SymbolInfo[];      // methods/props/fields/events of those types
  /** v0.6.0 — identifier occurrences in type-ish/bare contexts, used by the
   *  dependency graph (and as a fast pre-filter for rename). Persisted in the
   *  startup cache so cache-indexed files still contribute dependencies. */
  typeRefs: IdentRef[];
}

/** machine-applicable quick fix attached to a diagnostic (v0.5.0) */
export interface QuickFix {
  kind: "addUsing";
  ns: string;
  title: string;              // e.g. "using UnityEngine;"
  line: number;               // 0-based insertion point (after the last using, or top)
  col: number;
  text: string;               // full text to insert at [line, col] (ends with \n)
}

export interface Diagnostic {
  line: number;               // 0-based
  col: number;
  length: number;
  message: string;
  severity: "error" | "warning" | "info";
  source: string;
  fix?: QuickFix;             // when present the Problems bar / editor offer a one-click fix
}

export type CompletionKind =
  | "method" | "property" | "field" | "enum" | "enumMember"
  | "class" | "struct" | "interface" | "keyword" | "snippet" | "local" | "event"
  | "namespace" | "nameSuggestion";

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  detail?: string;
  doc?: string;
  insert?: string;            // insert text (defaults to label)
  sortText?: string;
  filterText?: string;
}

export interface HoverResult {
  signature: string;
  doc?: string;
  range: { line: number; col: number; length: number };
}

export interface SignatureInfo {
  label: string;
  params: ParamInfo[];
  doc?: string;
  activeParam: number;
}

export interface DefinitionResult {
  file: string;
  line: number;
  col: number;
  name: string;
}

export interface SearchHit {
  file: string;
  line: number;
  col: number;
  length: number;
  text: string;
}

export interface AnalysisResult {
  symbols: FileSymbols;
  diagnostics: Diagnostic[];
  parseMs: number;
  /** v0.7.0 — deep semantic report computed in the SAME pass (single parse per
   *  keystroke; the old flow parsed twice — once for syntax, once for semantic) */
  sem?: SemanticReport;
}

/** editor range for decorations (unreachable code, obsolete API) */
export interface SemRange {
  line: number;      // 0-based
  col: number;
  endLine: number;   // 0-based inclusive
  endCol: number;    // exclusive
}

/** deep analysis beyond syntax: diagnostics + decoration ranges */
export interface SemanticReport {
  diagnostics: Diagnostic[];
  unreachable: SemRange[];   // grey out
  obsolete: SemRange[];      // strikethrough
}

/** flat, line-ordered outline of one document (classes → members) */
export interface OutlineEntry {
  name: string;
  kind: string;
  line: number;
  col: number;
  depth: number;
  detail?: string;
  isMessage?: boolean;   // Unity special function (Awake/Start/Update…)
}

export interface WorkspaceAdapter {
  /** list all candidate files (relative paths) */
  listFiles(): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** desktop only (v0.6.0): rename/move a file on disk (keeps its .meta sidecar meaningful) */
  move?(from: string, to: string): Promise<void>;
}

/* ------------------- v0.6.0 — dependency graph ------------------- */

export type DepKind = "extends" | "implements" | "uses";

export interface DepNode {
  id: string;              // unique: project fqn ("p::fqn") or "ext::<full>" for externals
  name: string;            // simple name
  kind: string;            // class | struct | interface | enum | external
  file: string;            // declaring file ("" for externals)
  line: number;            // 0-based decl line
  ns: string;              // namespace ("" for global)
  asm: string | null;      // owning assembly
  isMono: boolean;         // derives a Unity behaviour (MonoBehaviour / ScriptableObject)
  external: boolean;       // Unity/BCL type (not in the project)
  /** project type declared OUTSIDE the selected folder scope (drawn dimmed) */
  outOfScope?: boolean;
  refCount: number;        // aggregated reference weight
  outDeg: number;
  inDeg: number;
}

export interface DepEdge {
  from: string;            // node id (dependent)
  to: string;              // node id (dependency)
  kind: DepKind;
  weight: number;          // number of reference sites
}

export interface DepGraph {
  scope: string;           // "" = whole project, else folder prefix ("Assets/Scripts")
  nodes: DepNode[];
  edges: DepEdge[];
  truncated: boolean;      // node cap hit
  /** v0.6.1 — in-scope type count BEFORE any capping (UI shows "top N of M") */
  totalTypes?: number;
}

/* ---------------------- v0.6.0 — rename symbol ---------------------- */

export interface RenameTarget {
  kind: SymbolKind;
  name: string;
  fqn: string;
  container: string;
  declFile: string;
  declLine: number;        // 0-based
  declCol: number;
  scope: "local" | "member" | "type";
  /** FQN of the declaring type for member renames ("" otherwise) */
  ownerTypeFqn: string;
  /** resolved receiver chain the caller used (UI hint) */
  via?: string;
}

export interface RenameRange { line: number; col: number; length: number }
export interface RenameFileEdits { path: string; ranges: RenameRange[] }

export interface RenamePlan {
  ok: boolean;
  reason?: string;
  target?: RenameTarget;
  newName?: string;
  edits: RenameFileEdits[];
  /** Unity: class file name == class name → move the .cs (and its .meta so the GUID survives) */
  fileRename?: { from: string; to: string; metaFrom?: string; metaTo?: string } | null;
  warnings: string[];
}
