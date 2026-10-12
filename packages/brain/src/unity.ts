/** VelvetSharp brain — Unity API layer: loads the generated DB, answers member/type queries */
import type { ApiDb, ApiType, ApiMethod, ApiParam, ApiProp, ApiField } from "../../metadata/src/build";
import { prettyType, methodSignature } from "./pretty";
import { UNITY_LIFECYCLE } from "./snippets";
import type { CompletionItem } from "./types";

export interface ResolvedMember {
  name: string;
  kind: "method" | "property" | "field" | "event" | "enumMember";
  type: string;          // return/declared type (raw canonical)
  static: boolean;
  signature: string;
  doc?: string;
  paramDocs?: Record<string, string>;
  returnsDoc?: string;
  enumValue?: string;
  obs?: string;          // [Obsolete("message")] — presence = obsolete
}

export interface ResolvedType {
  fullName: string;      // e.g. UnityEngine.GameObject
  ns: string;
  name: string;
  info: ApiType;
}

export class UnityApi {
  private db: ApiDb | null = null;
  private dbs: ApiDb[] = [];             // multiple assemblies (UnityEngine + BCL)
  /** lowercased simple type name -> full names (insertion order = preference: Unity first) */
  private typeByName = new Map<string, ResolvedType[]>();
  /** fullName (lower) -> ResolvedType — exact lookups for base chains */
  private typeByFull = new Map<string, ResolvedType>();
  /** stripped-generic fullName (lower) -> ResolvedType (List<T> also findable as ...List) */
  private typeByFullStripped = new Map<string, ResolvedType>();
  /** fullName -> flattened member list (incl. inherited) — the DB is immutable so cache forever */
  private membersCache = new Map<string, ResolvedMember[]>();
  /** namespace -> assemblies providing it */
  nsAssemblies = new Map<string, Set<string>>();
  /** every namespace in every loaded DB (sorted) — for `using` completion */
  allNamespaces: string[] = [];
  typeCount = 0;
  memberCount = 0;
  assemblyLabel = "";

  async load(url: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Unity API DB fetch failed: ${res.status}`);
    this.loadFromJson(await res.json());
  }

  loadFromJson(db: ApiDb): void {
    this.db = db;
    this.dbs = [db];
    this.typeByName.clear();
    this.typeByFull.clear();
    this.typeByFullStripped.clear();
    this.membersCache.clear();
    this.nsAssemblies.clear();
    this.typeCount = 0;
    this.memberCount = 0;
    this.assemblyLabel = `${db.assembly} ${db.version}`;
    this.mergeInto(db);
    this.injectMagicMethods();
    this.rebuildNamespaceList();
  }

  /** add another assembly's DB (e.g. the BCL) on top — no reset, Unity names win duplicates */
  mergeFromJson(db: ApiDb): void {
    this.dbs.push(db);
    this.membersCache.clear(); // cross-assembly base chains may now resolve
    this.mergeInto(db);
    this.injectMagicMethods();
    this.rebuildNamespaceList();
  }

  /** Phase 8 (user: "awake start update those magic methods... dont show up in
   *  auto complete"): Unity's message methods (Awake/Start/Update/FixedUpdate/
   *  OnCollisionEnter…) are called BY NAME by the engine but are NOT real .NET
   *  methods on MonoBehaviour, so the DLL metadata db never contained them.
   *  We synthesize them onto UnityEngine.MonoBehaviour (as `void Name(params)`,
   *  instance, protected-by-convention) so every MonoBehaviour-derived type —
   *  project scripts included — now offers them in member/`this.` completions,
   *  hover and signature help through the normal member walk. */
  private injectMagicMethods(): void {
    // NB: typeByFull keys are LOWERCASED (see mergeInto) — a mixed-case lookup here silently no-ops
    const mb = this.typeByFull.get("unityengine.monobehaviour");
    if (!mb) return;
    const info = mb.info;
    info.m = info.m ?? [];
    const existing = new Set(info.m.map((m) => m.n));
    let added = 0;
    for (const l of UNITY_LIFECYCLE) {
      if (existing.has(l.name)) continue;
      const ps: ApiParam[] = (l.params ? l.params.split(",") : [])
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => {
          const parts = p.split(/\s+/);
          return { n: parts[parts.length - 1] ?? "arg", t: parts.slice(0, -1).join(" ") || "object" };
        });
      const m: ApiMethod = {
        n: l.name,
        ret: "void",
        ps,
        d: `${l.doc}\n\nUnity event function — the engine calls it by name; keep the signature exact.`,
      };
      info.m.push(m);
      added++;
      this.memberCount++;
    }
    this.membersCache.clear(); // rebuilt lazily — next membersOf() sees the injected methods
    if (added) {
      this.assemblyLabel += ` · +${added} Unity messages`;
    }
  }

  private mergeInto(db: ApiDb): void {
    for (const [ns, types] of Object.entries(db.namespaces)) {
      let asmSet = this.nsAssemblies.get(ns);
      if (!asmSet) { asmSet = new Set(); this.nsAssemblies.set(ns, asmSet); }
      asmSet.add(db.assembly);
      for (const [name, t] of Object.entries(types)) {
        const full = ns ? `${ns}.${name}` : name;
        // first assembly to claim a namespace.type wins (UnityEngine db loads first)
        if (this.typeByFull.has(full.toLowerCase())) continue;
        const rt: ResolvedType = { fullName: full, ns, name, info: t };
        this.typeByFull.set(full.toLowerCase(), rt);
        const strippedFull = full.toLowerCase().replace(/`\d+$/g, "");
        if (!this.typeByFullStripped.has(strippedFull)) this.typeByFullStripped.set(strippedFull, rt);
        // simple-name index: strip the backtick arity (List`1 → list) so source
        // text like "List" and canonical names like "List`1" both resolve
        const key = name.toLowerCase().replace(/`\d+$/g, "");
        const arr = this.typeByName.get(key);
        if (arr) arr.push(rt);
        else this.typeByName.set(key, [rt]);
        this.typeCount++;
        this.memberCount += (t.m?.length ?? 0) + (t.p?.length ?? 0) + (t.f?.length ?? 0) + (t.e?.length ?? 0);
      }
    }
  }

  private rebuildNamespaceList(): void {
    this.allNamespaces = [...this.nsAssemblies.keys()].sort();
  }

  get loaded(): boolean {
    return this.db !== null;
  }

  /** assemblies that provide a namespace (for csproj reference gating) */
  assembliesOf(ns: string): string[] {
    return [...(this.nsAssemblies.get(ns) ?? [])];
  }

  /** assembly names of every loaded db (dbs[0] = Unity engine db, rest = BCL merge) */
  assemblyNames(): string[] {
    return this.dbs.map((d) => d.assembly);
  }

  /** ALL types with this simple name across every loaded DB — used by the
   *  CS0246 missing-using check and the CS0104 ambiguity check (v0.5.0) */
  typeCandidates(simpleName: string): ResolvedType[] {
    const key = simpleName.toLowerCase().replace(/`\d+$/g, "");
    return this.typeByName.get(key) ?? [];
  }

  findType(simpleOrFull: string): ResolvedType | null {
    const key = simpleOrFull.toLowerCase().replace(/`\d+/g, "");
    const arr = this.typeByName.get(key);
    if (!arr) return null;
    return arr[0];
  }

  /** exact fully-qualified match ("System.Object" must never hit UnityEngine.Object) */
  findTypeExact(fullName: string): ResolvedType | null {
    const k = fullName.toLowerCase();
    const hit = this.typeByFull.get(k);
    if (hit) return hit;
    return this.typeByFullStripped.get(k.replace(/`\d+/g, "")) ?? null;
  }

  /** find type visible from a set of using namespaces (usings are raw texts like "UnityEngine") */
  findTypeIn(nsList: Iterable<string>, simpleName: string): ResolvedType | null {
    const arr = this.typeByName.get(simpleName.toLowerCase());
    if (!arr) return null;
    for (const ns of nsList) {
      const hit = arr.find((t) => t.ns === ns || t.fullName === ns + "." + simpleName);
      if (hit) return hit;
    }
    // nested types: "UnityEngine.UI.Button" declaring nested — cheap pass
    return arr[0] ?? null;
  }

  /** all members of a type INCLUDING inherited Unity base types (Object, Component, MonoBehaviour...).
   *  Cached per type — building the flattened list walks the whole base chain. */
  membersOf(rt: ResolvedType, seen?: Set<string>): ResolvedMember[] {
    if (!seen) {
      const cached = this.membersCache.get(rt.fullName);
      if (cached) return cached;
      const out: ResolvedMember[] = [];
      this.collectMembers(rt, out, new Set());
      this.membersCache.set(rt.fullName, out);
      return out;
    }
    const out: ResolvedMember[] = [];
    this.collectMembers(rt, out, seen);
    return out;
  }

  private collectMembers(rt: ResolvedType, out: ResolvedMember[], seen: Set<string>): void {
    const visit = (t: ResolvedType | null) => {
      if (!t || seen.has(t.fullName)) return;
      seen.add(t.fullName);
      const info = t.info;
      const addMethods = (ms: ApiMethod[] | undefined) => {
        if (!ms) return;
        for (const m of ms) {
          if (m.n === ".ctor" || m.n === ".cctor") continue;
          out.push({
            name: m.n, kind: "method", type: m.ret, static: !!m.s,
            signature: methodSignature(t.name === info.name ? t.name : t.fullName, m),
            doc: m.d, obs: (m as any).obs,
            paramDocs: Object.fromEntries((m.ps ?? []).filter((p: any) => p.pd).map((p: any) => [p.n, p.pd])),
            returnsDoc: (m as any).rd,
          });
        }
      };
      addMethods(info.m);
      if (info.p) for (const p of (info.p as ApiProp[])) {
        out.push({ name: p.n, kind: "property", type: p.t, static: !!p.s, signature: `${prettyType(p.t)} ${t.name}.${p.n} { get; }`, doc: p.d, obs: (p as any).obs });
      }
      if (info.f) for (const f of (info.f as ApiField[])) {
        out.push({
          name: f.n, kind: t.info.kind === "enum" ? "enumMember" : "field",
          type: f.t, static: !!f.s, signature: `${prettyType(f.t)} ${t.name}.${f.n}`,
          doc: f.d, enumValue: f.v, obs: (f as any).obs,
        });
      }
      if (info.e) for (const e of info.e) {
        out.push({ name: e.n, kind: "event", type: e.t, static: false, signature: `event ${prettyType(e.t)} ${t.name}.${e.n}`, doc: e.d, obs: (e as any).obs });
      }
      // walk base chain INSIDE the DB — exact full-name match only (System.Object
      // must never resolve to UnityEngine.Object via simple-name collision)
      if (info.base) {
        const bt = this.findTypeExact(info.base) ?? (info.base === "System.Enum" || info.base === "System.ValueType" || info.base === "System.MulticastDelegate" || info.base === "System.Delegate" ? null : this.findType(info.base.split(".").pop()!));
        if (bt && (bt.fullName === info.base || !this.typeByFull.has(info.base.toLowerCase()))) visit(bt);
      }
    };
    visit(rt);
  }

  /** members matching prefix (staticOnly filters to static members + enum members) */
  completeMembers(rt: ResolvedType, prefix: string, staticOnly = false): CompletionItem[] {
    const seen = new Set<string>();
    const items: CompletionItem[] = [];
    const p = prefix.toLowerCase();
    for (const m of this.membersOf(rt)) {
      if (seen.has(m.name)) continue;
      seen.add(m.name);
      if (staticOnly && !(m.static || m.kind === "enumMember")) continue;
      if (p && !m.name.toLowerCase().startsWith(p)) continue;
      items.push({
        label: m.name,
        kind: m.kind === "method" ? "method" : m.kind === "enumMember" ? "enumMember" : m.kind,
        detail: m.signature,
        doc: m.obs !== undefined
          ? [m.doc, `⚠ Obsolete${m.obs ? ": " + m.obs : ""}`].filter(Boolean).join("\n\n")
          : m.doc,
        insert: m.kind === "method"
          ? m.name + "(" + m.signature.slice(m.signature.indexOf("(") + 1, -1).split(", ").map((_, i) => `\${${i + 1}:arg${i + 1}}`).join(", ") + ")"
          : m.name,
        sortText: (m.kind === "property" || m.kind === "field" || m.kind === "enumMember" ? "0" : "1") + m.name.toLowerCase(),
        filterText: m.name,
      });
    }
    return items;
  }

  /** type names + namespaces for bare completion, filtered by visible namespaces */
  completeTypes(nsList: Iterable<string>, prefix: string): CompletionItem[] {
    const p = prefix.toLowerCase();
    const out: CompletionItem[] = [];
    const seen = new Set<string>();
    for (const ns of nsList) {
      if (!ns) continue;
      // iterate every loaded DB — a namespace may span assemblies (System: mscorlib+System)
      const containers = this.dbs.map((d) => d.namespaces[ns]).filter(Boolean) as Record<string, ApiType>[];
      for (const container of containers) {
        for (const [name, t] of Object.entries(container)) {
          // generic types are stored as "List`1" — present as "List" with a <T> detail
          const plain = name.replace(/`\d+$/, "");
          if (seen.has(plain)) continue;
          seen.add(plain);
          if (p && !plain.toLowerCase().startsWith(p)) continue;
          out.push({
            label: plain,
            kind: t.kind === "interface" ? "interface" : t.kind === "struct" ? "struct" : t.kind === "enum" ? "enum" : t.kind === "delegate" ? "class" : "class",
            detail: `${ns}.${name}${t.g?.length ? `<${t.g.join(", ")}>` : ""}`,
            doc: t.d,
            sortText: "2" + plain.toLowerCase(),
          });
        }
      }
      // namespace itself as completion root (UnityEngine.Xxx) — only when filtering
      if (p && ns.toLowerCase().startsWith(p)) {
        out.push({ label: ns, kind: "class", detail: "namespace", sortText: "3" + ns.toLowerCase() });
      }
    }
    return out;
  }

  /** static member access on a TYPE name (e.g. Mathf.) */
  completeStaticMembers(rt: ResolvedType, prefix: string): CompletionItem[] {
    return this.completeMembers(rt, prefix, true);
  }

  /** lookup member for hover/signature: type + member name */
  memberOfType(rt: ResolvedType, memberName: string): ResolvedMember | null {
    return this.membersOf(rt).find((m) => m.name === memberName) ?? null;
  }

  /** common Unity MonoBehaviour "self" globals */
  static readonly SELF_GLOBALS: Record<string, string> = {
    gameObject: "UnityEngine.GameObject",
    transform: "UnityEngine.Transform",
    name: "System.String",
    tag: "System.String",
    hideFlags: "UnityEngine.HideFlags",
  };

  /** hardcoded string members for fast literal completion */
  static readonly STRING_MEMBERS: { name: string; sig: string }[] = [
    { name: "Length", sig: "int string.Length" },
    { name: "Substring", sig: "string string.Substring(int startIndex, int length)" },
    { name: "Replace", sig: "string string.Replace(string oldValue, string newValue)" },
    { name: "Split", sig: "string[] string.Split(params char[] separator)" },
    { name: "ToUpper", sig: "string string.ToUpper()" },
    { name: "ToLower", sig: "string string.ToLower()" },
    { name: "Trim", sig: "string string.Trim()" },
    { name: "Contains", sig: "bool string.Contains(string value)" },
    { name: "StartsWith", sig: "bool string.StartsWith(string value)" },
    { name: "EndsWith", sig: "bool string.EndsWith(string value)" },
    { name: "IndexOf", sig: "int string.IndexOf(string value)" },
    { name: "Insert", sig: "string string.Insert(int startIndex, string value)" },
    { name: "Remove", sig: "string string.Remove(int startIndex, int count)" },
    { name: "ToString", sig: "string string.ToString()" },
    { name: "CompareTo", sig: "int string.CompareTo(string strB)" },
    { name: "IsNullOrEmpty", sig: "bool string.IsNullOrEmpty(string value)" },
  ];
}
