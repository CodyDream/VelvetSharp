/**
 * VelvetSharp metadata — high-level assembly → API database extraction.
 *
 * extractAssembly(dll)  : TypeDefs (+members) or ExportedTypes (facade) -> UnifiedApiDb
 * mergeDocs(db, docXml) : enrich db entries with XML documentation
 */
import { Ecma335Reader } from "./ecma335";
import { SigDecoder } from "./signatures";
import { parseDocXml, lookupDocs, lookupDocsSmart, type DocFileResult } from "./docxml";

export interface ApiParam { n: string; t: string }
export interface ApiMethod { n: string; ret: string; ps: ApiParam[]; s?: 1; g?: string[]; abs?: 1; d?: string; obs?: string }
export interface ApiProp { n: string; t: string; s?: 1; ro?: 1; d?: string; obs?: string }
export interface ApiField { n: string; t: string; s?: 1; v?: string; d?: string; obs?: string }
export interface ApiEvent { n: string; t: string; d?: string; obs?: string }
export interface ApiType {
  kind: "class" | "struct" | "interface" | "enum" | "delegate";
  base?: string;
  it?: string[];
  g?: string[];
  m?: ApiMethod[];
  p?: ApiProp[];
  f?: ApiField[];
  e?: ApiEvent[];
  d?: string;
  fwd?: string; // facade: forwarded-to assembly
  abs?: 1;      // Abstract flag (0x80) — static classes have abs+seal
  seal?: 1;     // Sealed flag (0x100)
  obs?: string; // [Obsolete("message")] — presence = obsolete, value = message
}
export interface ApiDb {
  assembly: string;
  version: string;
  generated: string;
  source: { dll: "typedef" | "facade"; docs: boolean };
  namespaces: Record<string, Record<string, ApiType>>;
  stats?: Record<string, number>;
}

/* ------------------------------ flags helpers ------------------------------ */

const typeKindOf = (md: Ecma335Reader, row: number, base: string | null): ApiType["kind"] => {
  const td = md.tables.get(0x02)!;
  const flags = td.get(row, "Flags");
  if (flags & 0x20) return "interface"; // ClassSemanticsMask
  if (base === "System.Enum") return "enum";
  if (base === "System.ValueType") return "struct";
  if (base === "System.MulticastDelegate" || base === "System.Delegate") return "delegate";
  return "class";
};

/* ------------------------- custom attributes ([Obsolete]) ------------------------- */

export interface ObsMaps {
  type: Map<number, string>;   // TypeDef row (0-based) -> message
  method: Map<number, string>; // MethodDef row
  field: Map<number, string>;  // Field row
  prop: Map<number, string>;   // Property row
}

/** Walk the CustomAttribute table once, collecting [Obsolete] usages.
 *  HasCustomAttribute coded index (22 tags, 5 bits): 0 MethodDef, 1 Field, 2 TypeRef,
 *  3 TypeDef, 4 Param, 5 InterfaceImpl, 6 MemberRef, 7 Module, 8 Permission, 9 Property,
 *  10 Event, 11 StandAloneSig, 12 ModuleRef, 13 TypeSpec, 14 Assembly, 15 AssemblyRef,
 *  16 File, 17 ExportedType, 18 ManifestResource, 19 GenericParam, 20 GenericParamConstraint,
 *  21 MethodSpec. CustomAttributeType (3 bits): 2 MethodDef, 3 MemberRef. */
export function extractObsolete(md: Ecma335Reader): ObsMaps {
  const out: ObsMaps = { type: new Map(), method: new Map(), field: new Map(), prop: new Map() };
  const ca = md.tables.get(0x0c);
  if (!ca) return out;
  const td = md.tables.get(0x02)!;
  const mdt = md.tables.get(0x06)!;
  const mr = md.tables.get(0x0a);
  const tr = md.tables.get(0x01);
  const decodeStr = (b: Uint8Array, off: number): { v: string; next: number } => {
    const b0 = b[off];
    if (b0 === undefined) return { v: "", next: off };
    if ((b0 & 0x80) === 0) return { v: new TextDecoder().decode(b.subarray(off + 1, off + 1 + b0)), next: off + 1 + b0 };
    if ((b0 & 0xc0) === 0x80) { const len = ((b0 & 0x3f) << 8) | b[off + 1]; return { v: new TextDecoder().decode(b.subarray(off + 2, off + 2 + len)), next: off + 2 + len }; }
    const len = ((b0 & 0x1f) << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3];
    return { v: new TextDecoder().decode(b.subarray(off + 4, off + 4 + len)), next: off + 4 + len };
  };
  // MethodDef row -> owning TypeDef row via MethodList ranges (binary search)
  const methodOwner = (row: number): number => {
    let lo = 0, hi = td.rows - 1, res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (td.get(mid, "MethodList") - 1 <= row) { res = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return res;
  };
  for (let r = 0; r < ca.rows; r++) {
    const tRaw = ca.get(r, "Type");
    const ttag = tRaw & 7, trow = (tRaw >>> 3) - 1;
    if (trow < 0) continue;
    let attrName = "";
    if (ttag === 2 && trow < mdt.rows) {
      const owner = methodOwner(trow);
      if (owner < 0) continue;
      const { ns, name } = md.typeDefFullName(owner);
      attrName = ns ? `${ns}.${name}` : name;
    } else if (ttag === 3 && mr) {
      const cRaw = mr.get(trow, "Class");
      const ctag = cRaw & 7, crow = (cRaw >>> 3) - 1; // MemberRefParent: 0 TypeDef, 1 TypeRef, 2 ModuleRef, 3 MethodDef, 4 TypeSpec
      if (ctag === 1 && crow >= 0 && crow < tr.rows) {
        const ns = md.getStringOf(tr.get(crow, "Namespace"));
        attrName = (ns ? ns + "." : "") + md.getStringOf(tr.get(crow, "Name"));
      }
    }
    if (!/^(System\.)?(ObsoleteAttribute|Obsolete)$/.test(attrName)) continue;
    // [Obsolete] ctor blob: 01 00 [0x0E <len-str>] 00 00 — the string arg is the message
    const blob = md.getBlob(ca.get(r, "Value"));
    let msg = "";
    if (blob.length >= 4 && blob[0] === 1 && blob[1] === 0 && blob[2] === 0x0e) {
      msg = decodeStr(blob, 2).v;
    }
    const pRaw = ca.get(r, "Parent");
    const ptag = pRaw & 31, prow = (pRaw >>> 5) - 1;
    if (prow < 0) continue;
    if (ptag === 3) out.type.set(prow, msg);
    else if (ptag === 0) out.method.set(prow, msg);
    else if (ptag === 1) out.field.set(prow, msg);
    else if (ptag === 9) out.prop.set(prow, msg);
  }
  return out;
}

/* ----------------------------- main extraction ----------------------------- */

export function extractAssembly(buf: Uint8Array): ApiDb {
  const md = new Ecma335Reader(buf);
  const db: ApiDb = {
    assembly: "",
    version: md.version,
    generated: new Date().toISOString(),
    source: { dll: "typedef", docs: false },
    namespaces: {},
  };

  const asm = md.tables.get(0x20);
  if (asm && asm.rows > 0) db.assembly = md.getStringOf(asm.get(0, "Name"));

  const td = md.tables.get(0x02);
  const typedefCount = td?.rows ?? 0;

  if (typedefCount > 0) {
    db.source.dll = "typedef";
    extractTypeDefs(md, db, extractObsolete(md));
  }
  const et = md.tables.get(0x27);
  if (et && et.rows > 0) extractExportedTypes(md, db);

  if (typedefCount === 0) db.source.dll = "facade";
  return db;
}

function ensureNs(db: ApiDb, ns: string): Record<string, ApiType> {
  if (!db.namespaces[ns]) db.namespaces[ns] = {};
  return db.namespaces[ns];
}

function extractTypeDefs(md: Ecma335Reader, db: ApiDb, obs: ObsMaps) {
  const td = md.tables.get(0x02)!;
  const fld = md.tables.get(0x04);
  const mdt = md.tables.get(0x06);
  const par = md.tables.get(0x08);
  const pmap = md.tables.get(0x15);
  const prop = md.tables.get(0x17);
  const emap = md.tables.get(0x12);
  const evt = md.tables.get(0x14);
  const nested = md.tables.get(0x29);
  const iconst = md.tables.get(0x0b);

  // nested map: nested typeDef row (0-based) -> enclosing row (0-based)
  const nestedOf = new Map<number, { encRow: number }>();
  if (nested) {
    for (let r = 0; r < nested.rows; r++) {
      nestedOf.set(nested.get(r, "NestedClass") - 1, { encRow: nested.get(r, "EnclosingClass") - 1 });
    }
  }

  // constants for enum fields: parent coded HasConstant -> tag0 Field
  const constByField = new Map<number, string>();
  if (iconst) {
    for (let r = 0; r < iconst.rows; r++) {
      const raw = iconst.get(r, "Parent");
      if ((raw & 3) === 0) {
        const fieldRow = (raw >>> 2) - 1; // 0-based into Field
        const blob = md.getBlob(iconst.get(r, "Value"));
        if (blob.length >= 2) {
          const t = blob[0];
          let v: string | undefined;
          if (t === 0x08 || t === 0x09 || t === 0x0a || t === 0x0b) {
            let x = 0;
            for (let i = Math.min(blob.length, 5) - 1; i >= 1; i--) x = x * 256 + blob[i];
            if (t === 0x08 || t === 0x0a) x |= 0; // signed
            v = String(x);
          }
          if (v !== undefined) constByField.set(fieldRow, v);
        }
      }
    }
  }

  const tdRows = td.rows;
  for (let row = 0; row < tdRows; row++) {
    if (!md.isPublicTypeDef(row)) continue;
    // skip non-public nested (nested private etc.)
    const nst = nestedOf.get(row);
    if (nst && !md.isPublicTypeDef(nst.encRow)) continue;

    const { ns, name } = md.typeDefFullName(row);
    const extendsRaw = td.get(row, "Extends");
    const base = md.typeName(extendsRaw);
    const kind = typeKindOf(md, row, base ?? null);

    const fullNestedName = nestName(nst, row, nestedOf, tdRows, md);
    const t: ApiType = { kind };
    if (base && base !== "System.Object" && kind !== "interface") t.base = base;
    t.g = md.genericParamsOf("type", row);
    const tFlags = td.get(row, "Flags");
    if (kind === "class") {
      if (tFlags & 0x80) t.abs = 1;
      if (tFlags & 0x100) t.seal = 1;
    }
    const tObs = obs.type.get(row);
    if (tObs !== undefined) t.obs = tObs;

    // interfaces
    const ii = md.tables.get(0x09);
    if (ii) {
      const list: string[] = [];
      for (let r = 0; r < ii.rows; r++) {
        if (ii.get(r, "Class") - 1 === row) {
          const iname = md.typeName(ii.get(r, "Interface"));
          if (iname) list.push(iname);
        }
      }
      if (list.length) t.it = list;
    }

    // fields range
    if (fld) {
      const start = td.get(row, "FieldList") - 1;
      const end = row + 1 < tdRows ? td.get(row + 1, "FieldList") - 1 : fld.rows;
      const fields: ApiField[] = [];
      for (let r = start; r < end && r < fld.rows; r++) {
        const flags = fld.get(r, "Flags");
        const vis = flags & 0x7;
        if (vis < 4) continue; // keep Family(4), FamORAssem(5), Public(6)
        const fname = md.getStringOf(fld.get(r, "Name"));
        let ftype = "unknown";
        try { ftype = SigDecoder.decodeField(md.getBlob(fld.get(r, "Signature")), md); } catch { /* keep */ }
        const isStatic = (flags & 0x0010) !== 0;
        const isEnumVal = kind === "enum";
        if (isEnumVal && !isStatic) continue; // enum instance field __value
        if (isEnumVal && fname === "value__") continue;
        const af: ApiField = { n: fname, t: ftype };
        if (isStatic) af.s = 1;
        const cv = constByField.get(r);
        if (cv !== undefined && (isStatic || isEnumVal)) af.v = cv;
        const fObs = obs.field.get(r);
        if (fObs !== undefined) af.obs = fObs;
        fields.push(af);
      }
      if (fields.length) t.f = fields;
    }

    // methods range
    if (mdt) {
      const start = td.get(row, "MethodList") - 1;
      const end = row + 1 < tdRows ? td.get(row + 1, "MethodList") - 1 : mdt.rows;
      const methods: ApiMethod[] = [];
      for (let r = start; r < end && r < mdt.rows; r++) {
        const flags = mdt.get(r, "Flags");
        const vis = flags & 0x7;
        if (vis < 4) continue; // keep Family(4), FamORAssem(5), Public(6)
        const mname = md.getStringOf(mdt.get(r, "Name"));
        if (mname.startsWith("get_") || mname.startsWith("set_") || mname.startsWith("op_")) continue;
        if (flags & 0x1000) {
          // special name: keep constructors, skip anything else special
          if (mname !== ".ctor" && mname !== ".cctor") continue;
        }
        let sig: ReturnType<typeof SigDecoder.decodeMethod> | null = null;
        try { sig = SigDecoder.decodeMethod(md.getBlob(mdt.get(r, "Signature")), md); } catch { continue; }
        if (!sig) continue;
        const am: ApiMethod = { n: mname, ret: sig.ret, ps: [] };
        if (flags & 0x0010) am.s = 1;
        if (flags & 0x0400) am.abs = 1;
        const mObs = obs.method.get(r);
        if (mObs !== undefined) am.obs = mObs;
        if (sig.genericCount > 0) {
          am.g = md.genericParamsOf("method", r);
          while (am.g.length < sig.genericCount) am.g.push(`T${am.g.length}`);
        }
        // param names from Param table
        let ps = sig.params;
        const pStart = mdt.get(r, "ParamList") - 1;
        const pEnd = r + 1 < mdt.rows ? mdt.get(r + 1, "ParamList") - 1 : par ? par.rows : 0;
        const names: string[] = [];
        if (par) {
          for (let pr = pStart; pr < pEnd && pr < par.rows; pr++) {
            const seq = par.get(pr, "Sequence");
            names[seq] = md.getStringOf(par.get(pr, "Name"));
          }
        }
        am.ps = ps.map((t2, i) => ({ n: names[i + 1] ?? `arg${i}`, t: t2 }));
        methods.push(am);
      }
      if (methods.length) t.m = methods;
    }

    // properties via PropertyMap
    if (pmap && prop) {
      // find PropertyMap row for this typedef
      let pmRow = -1;
      for (let r = 0; r < pmap.rows; r++) if (pmap.get(r, "Parent") - 1 === row) { pmRow = r; break; }
      if (pmRow >= 0) {
        const start = pmap.get(pmRow, "PropertyList") - 1;
        const end = pmRow + 1 < pmap.rows ? pmap.get(pmRow + 1, "PropertyList") - 1 : prop.rows;
        const props: ApiProp[] = [];
        for (let r = start; r < end && r < prop.rows; r++) {
          let ptype = "unknown";
          try { ptype = SigDecoder.decodeProperty(md.getBlob(prop.get(r, "Type")), md); } catch { /* keep */ }
          const ap: ApiProp = { n: md.getStringOf(prop.get(r, "Name")), t: ptype };
          const pObs = obs.prop.get(r);
          if (pObs !== undefined) ap.obs = pObs;
          props.push(ap);
        }
        if (props.length) t.p = props;
      }
    }

    // events via EventMap
    if (emap && evt) {
      let emRow = -1;
      for (let r = 0; r < emap.rows; r++) if (emap.get(r, "Parent") - 1 === row) { emRow = r; break; }
      if (emRow >= 0) {
        const start = emap.get(emRow, "EventList") - 1;
        const end = emRow + 1 < emap.rows ? emap.get(emRow + 1, "EventList") - 1 : evt.rows;
        const events: ApiEvent[] = [];
        for (let r = start; r < end && r < evt.rows; r++) {
          const ename = md.getStringOf(evt.get(r, "Name"));
          const etype = md.typeName(evt.get(r, "EventType")) ?? "unknown";
          events.push({ n: ename, t: etype });
        }
        if (events.length) t.e = events;
      }
    }

    const nsName = ns || "";
    const container = ensureNs(db, nsName);
    container[fullNestedName] = t;
  }
}

function nestName(
  nst: { encRow: number } | undefined,
  row: number,
  nestedOf: Map<number, { encRow: number }>,
  tdRows: number,
  md: Ecma335Reader
): string {
  const { name } = md.typeDefFullName(row);
  if (!nst) return name;
  // build chain up enclosing types
  const chain: string[] = [name];
  let cur: { encRow: number } | undefined = nst;
  const guard = new Set<number>([row]);
  while (cur) {
    const er = cur.encRow;
    if (guard.has(er)) break;
    guard.add(er);
    chain.unshift(md.typeDefFullName(er).name);
    cur = nestedOf.get(er);
  }
  return chain.join(".");
}

function extractExportedTypes(md: Ecma335Reader, db: ApiDb) {
  const et = md.tables.get(0x27)!;
  for (let r = 0; r < et.rows; r++) {
    const flags = et.get(r, "Flags");
    const vis = flags & 0x7;
    if (vis !== 1 && vis !== 2) continue;
    const name = md.getStringOf(et.get(r, "TypeName"));
    const ns = md.getStringOf(et.get(r, "TypeNamespace"));
    const impl = et.get(r, "Implementation");
    const tag = impl & 3;
    const row1 = impl >>> 2; // 1-based
    let fwd = "";
    if (tag === 1) fwd = md.assemblyRefName(row1);
    const t: ApiType = { kind: "class" };
    if (fwd) t.fwd = fwd;
    const container = ensureNs(db, ns || "");
    if (!container[name]) container[name] = t;
  }
}

/* -------------------------------- doc merge -------------------------------- */

export function mergeDocs(db: ApiDb, doc: DocFileResult): { merged: number } {
  let merged = 0;
  const cleanDoc = (s?: string) => {
    if (!s) return undefined;
    const c = s
      .replace(/<(see|paramref)[^>]*cref="([^"]*)"[^>]*\/?>([^<]*)<\/?(see|paramref)?>/g, (_m, _t, ref) => ref)
      .replace(/<paramref name="([^"]*)"\s*\/?>/g, "$1")
      .replace(/<c>(.*?)<\/c>/g, "$1")
      .replace(/<\/?[a-z][^>]*>/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    return c || undefined;
  };

  for (const [ns, types] of Object.entries(db.namespaces)) {
    for (const [typeName, t] of Object.entries(types)) {
      const fullName = ns ? `${ns}.${typeName}` : typeName;
      const td = lookupDocs(doc, `T:${fullName}`);
      if (td?.summary) { t.d = cleanDoc(td.summary); merged++; }

      // type generic params appear as !0 in XML keys: M:Type`1.Method
      const backtick = t.g && t.g.length ? `\`${t.g.length}` : "";

      if (t.m) {
        for (const m of t.m) {
          const mBack = m.g && m.g.length ? `\`${m.g.length}` : "";
          const paramSig = m.ps.map((p) => xmlTypeName(p.t)).join(",");
          const base = `M:${fullName}${backtick}.${m.n}${mBack}`;
          const docs = lookupDocsSmart(doc, `${base}(${paramSig})`, base, paramSig);
          if (docs) {
            const d = cleanDoc(docs.summary);
            if (d) { m.d = d; merged++; }
            if (docs.params && m.ps.length) {
              for (const p of m.ps) {
                const pd = docs.params[p.n];
                if (pd) { (p as any).pd = cleanDoc(pd); merged++; }
              }
            }
            const rd = cleanDoc(docs.returns);
            if (rd) { (m as any).rd = rd; merged++; }
          }
        }
      }
      if (t.p) {
        for (const p of t.p) {
          const docs = lookupDocs(doc, `P:${fullName}${backtick}.${p.n}`);
          if (docs?.summary) { p.d = cleanDoc(docs.summary); merged++; }
        }
      }
      if (t.f) {
        for (const f of t.f) {
          const docs = lookupDocs(doc, `F:${fullName}${backtick}.${f.n}`);
          if (docs?.summary) { f.d = cleanDoc(docs.summary); merged++; }
        }
      }
      if (t.e) {
        for (const e of t.e) {
          const docs = lookupDocs(doc, `E:${fullName}${backtick}.${e.n}`);
          if (docs?.summary) { e.d = cleanDoc(docs.summary); merged++; }
        }
      }
    }
  }
  return { merged };
}

/** Map decoded type names to the style used by VS XML doc keys */
function xmlTypeName(t: string): string {
  // our decoder gives canonical "System.Boolean", "UnityEngine.GameObject", "T0" for VAR, "int[]"
  // XML doc keys use e.g. System.Boolean, UnityEngine.Vector3, !0 (VAR), !!0 (MVAR)
  if (t.startsWith("T")) return `!${t.slice(1)}`;
  if (t.startsWith("M")) return `!!${t.slice(1)}`;
  if (t === "ref System.Void") return "Void";
  return t;
}
