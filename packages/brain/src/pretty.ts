/** VelvetSharp brain — C# display-name prettifier for API type names */

const KEYWORD_TYPES: Record<string, string> = {
  "System.Boolean": "bool",
  "System.Byte": "byte",
  "System.SByte": "sbyte",
  "System.Char": "char",
  "System.Int16": "short",
  "System.UInt16": "ushort",
  "System.Int32": "int",
  "System.UInt32": "uint",
  "System.Int64": "long",
  "System.UInt64": "ulong",
  "System.Single": "float",
  "System.Double": "double",
  "System.Decimal": "decimal",
  "System.String": "string",
  "System.Object": "object",
  "void": "void",
};

/** "UnityEngine.Vector3[]" -> "Vector3[]", "System.Collections.Generic.List<System.Int32>" -> "List<int>" */
export function prettyType(t: string): string {
  if (!t) return t;
  if (KEYWORD_TYPES[t]) return KEYWORD_TYPES[t];
  // generic inst: Base<args>
  const lt = t.indexOf("<");
  if (lt > 0 && t.endsWith(">")) {
    const open = t.slice(0, lt);
    const args = splitTop(t.slice(lt + 1, -1));
    return shortName(open) + "<" + args.map(prettyType).join(", ") + ">";
  }
  if (t.endsWith("&")) return prettyType(t.slice(0, -1)) + "&";
  if (t.endsWith("*")) return prettyType(t.slice(0, -1)) + "*";
  if (t.endsWith("[]")) return prettyType(t.slice(0, -2)) + "[]";
  return shortName(t);
}

function shortName(t: string): string {
  if (KEYWORD_TYPES[t]) return KEYWORD_TYPES[t];
  const dot = t.lastIndexOf(".");
  return dot >= 0 ? t.slice(dot + 1) : t;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "<" || ch === "[") depth++;
    else if (ch === ">" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Build a human signature like: void GameObject.SetActive(bool value) */
export function methodSignature(container: string, m: { n: string; ret: string; ps: { n: string; t: string }[]; s?: number | boolean | 1; g?: string[] }): string {
  const gp = m.g && m.g.length ? `<${m.g.join(", ")}>` : "";
  const ps = m.ps.map((p) => `${prettyType(p.t)} ${p.n}`).join(", ");
  const isCtor = m.n === ".ctor";
  const ret = isCtor ? "" : prettyType(m.ret) + " ";
  const stat = m.s ? "static " : "";
  return `${stat}${ret}${container ? container + "." : ""}${isCtor ? shortName(container) : m.n}${gp}(${ps})`;
}
