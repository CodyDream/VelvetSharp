/**
 * VelvetSharp metadata — Visual Studio XML documentation file parser.
 * Produces a lookup map: "M:UnityEngine.GameObject.SetActive(System.Boolean)" -> docs
 */
import { XMLParser } from "fast-xml-parser";

export interface MemberDocs {
  kind: "T" | "M" | "P" | "F" | "E";
  key: string;
  summary?: string;
  params?: Record<string, string>;
  returns?: string;
  value?: string;
}

export interface DocFileResult {
  assemblyName: string;
  members: Map<string, MemberDocs>;
  /** index: "M:Type.Method" -> member keys (for arity-less lookup fallback) */
  byNameIndex: Map<string, string[]>;
}

export function parseDocXml(xml: string): DocFileResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: false,
    parseTagValue: false,
  });
  const root = parser.parse(xml) as any;
  const doc = root?.doc ?? {};
  const assemblyName: string = doc?.assembly?.name ?? "";
  const rawMembers = doc?.members?.member ?? [];
  const members = new Map<string, MemberDocs>();
  const byNameIndex = new Map<string, string[]>();
  const list = Array.isArray(rawMembers) ? rawMembers : [rawMembers];

  /** recursively flatten nested doc markup (<summary><para>..</para></summary> etc.) to text */
  const flattenText = (v: unknown): string | undefined => {
    if (v == null) return undefined;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return v.map(flattenText).filter(Boolean).join(" ") || undefined;
    if (typeof v === "object") return Object.values(v).map(flattenText).filter(Boolean).join(" ") || undefined;
    return undefined;
  };
  const clean = (s: unknown): string | undefined => {
    const flat = flattenText(s);
    if (flat === undefined) return undefined;
    return flat.replace(/\s+/g, " ").trim() || undefined;
  };
  md_loop: for (const m of list) {
    const name: string = m?.["@_name"];
    if (!name) continue;
    const kind = name[0] as MemberDocs["kind"];
    const key = name.slice(2); // after "X:"
    const md: MemberDocs = { kind, key };
    md.summary = clean(m?.summary);
    md.returns = clean(m?.returns);
    md.value = clean(m?.value);
    if (m?.param) {
      const ps = Array.isArray(m.param) ? m.param : [m.param];
      const pm: Record<string, string> = {};
      for (const p of ps) {
        const pn = p?.["@_name"];
        const pd = clean(p?.["#text"] ?? p?.["__text"] ?? (typeof p === "string" ? p : undefined));
        if (pn) pm[pn] = pd ?? "";
      }
      md.params = pm;
    }
    members.set(name, md);
    const nameNoParens = kind === "M" ? name.slice(0, name.indexOf("(")) : name;
    const arr = byNameIndex.get(nameNoParens);
    if (arr) arr.push(name);
    else byNameIndex.set(nameNoParens, [name]);
  }
  return { assemblyName, members, byNameIndex };
}

/** Fetch docs for a member key with graceful fallbacks */
export function lookupDocs(
  doc: DocFileResult,
  key: string,
  fallbackNameNoParens?: string
): MemberDocs | undefined {
  const direct = doc.members.get(key);
  if (direct) return direct;
  if (fallbackNameNoParens) {
    const cands = doc.byNameIndex.get(fallbackNameNoParens);
    if (cands && cands.length === 1) return doc.members.get(cands[0]);
  }
  return undefined;
}

/** Count top-level commas in a "(...)" param list -> arity (handles generics/arrays) */
function paramArity(paramSig: string): number {
  if (!paramSig) return 0;
  let depth = 0, count = 1;
  for (const ch of paramSig) {
    if (ch === "[" || ch === "<") depth++;
    else if (ch === "]" || ch === ">") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

/**
 * Docs lookup with version-drift tolerance:
 * 1) exact key  2) same method name + same param arity  3) unique name match
 */
export function lookupDocsSmart(
  doc: DocFileResult,
  key: string,
  baseNameNoParens: string,
  paramSig: string
): MemberDocs | undefined {
  const direct = doc.members.get(key);
  if (direct) return direct;
  const cands = doc.byNameIndex.get(baseNameNoParens);
  if (cands && cands.length) {
    const want = paramArity(paramSig);
    const sameArity = cands.filter((c) => {
      const open = c.indexOf("(");
      return paramArity(open >= 0 ? c.slice(open + 1, c.length - 1) : "");
    });
    const arityMatches = sameArity.filter((c) => {
      const open = c.indexOf("(");
      const sig = open >= 0 ? c.slice(open + 1, c.length - 1) : "";
      return paramArity(sig) === want;
    });
    if (arityMatches.length === 1) return doc.members.get(arityMatches[0]);
    if (cands.length === 1) return doc.members.get(cands[0]);
  }
  return undefined;
}
