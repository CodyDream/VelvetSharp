/** VelvetSharp brain — /// XML documentation snippet generation (Phase 11).
 *
 *  "also add those xml documentation code auto completion shortcut too when
 *  that triple /// typed and enter"
 *
 *  Typing `///` on the empty line above a member and accepting the completion
 *  (Enter/Tab) inserts the VS-style skeleton:
 *
 *      /// <summary>
 *      /// $0
 *      /// </summary>
 *      /// <param name="damage">$1</param>
 *      /// <returns>$2</returns>
 *
 *  Pure text scan (no parser, no worker) so it is instant and consistent —
 *  the member line right below the caret decides the shape:
 *    method / constructor → summary + <param name="…"> per parameter (+ <returns> for non-void)
 *    property             → summary + <value>
 *    indexer              → summary + <param> + <returns>
 *    class/struct/interface/enum/record → summary only
 */

export interface XmlDocResult {
  snippet: string;          // VS-style snippet with $1… placeholders ($0 = final caret)
  memberName: string;
  kind: "method" | "constructor" | "property" | "indexer" | "type";
}

const MOD_RE = /^(?:public|private|protected|internal|static|sealed|abstract|override|virtual|async|extern|unsafe|new|partial|explicit|implicit|readonly|const|volatile|required|file)\s+/;

/** peek the member declaration that starts below `fromLine` (0-based) and build
 *  the doc skeleton. Returns null when no member follows (VS parity: `///` over
 *  nothing generates nothing). */
export function xmlDocSuggestion(lines: string[], fromLine: number): XmlDocResult | null {
  // find the declaration start: skip blanks + attribute lines (but not too far)
  let i = fromLine + 1;
  let scanned = 0;
  while (i < lines.length && scanned < 12) {
    const t = lines[i].trim();
    if (!t || t.startsWith("[")) { i++; scanned++; continue; }
    if (t.startsWith("/") || t.startsWith("*")) return null; // another comment — no member
    break;
  }
  if (i >= lines.length || scanned >= 12) return null;

  // collect the signature: from the first declaration line until ( { | ; | => …
  let sig = "";
  let j = i;
  const MAX_SIG_LINES = 8;
  while (j < lines.length && j - i < MAX_SIG_LINES) {
    const t = lines[j].trim();
    if (!t) break;
    sig += (sig ? " " : "") + t;
    if (/[{;=]/.test(t)) break;
    j++;
  }
  sig = sig.replace(/\s+/g, " ").trim();
  if (!sig) return null;

  // type? class Player : MonoBehaviour { …
  const typeM = sig.match(/\b(class|struct|interface|enum|record)\s+([A-Za-z_]\w*)/);
  if (typeM) {
    return {
      kind: "type",
      memberName: typeM[2],
      snippet: [
        "/// <summary>",
        "/// $1",
        "/// </summary>$0",
      ].join("\n"),
    };
  }

  // extract the parameter list (may span the joined lines)
  const parenStart = sig.indexOf("(");
  const paramMatch = parenStart >= 0
    ? matchBalanced(sig, parenStart)
    : null;
  const params: string[] = [];
  if (paramMatch) {
    const inner = sig.slice(paramMatch.start + 1, paramMatch.end);
    if (inner.trim()) {
      for (const p of inner.split(",")) {
        // `int damage`, `out int result`, `params int[] xs`, `float x = 1.5f`
        // (default values must be stripped BEFORE picking the last token —
        // otherwise `GameObject source = null` reads back the name "null")
        const cleaned = p.trim().replace(/=.*$/, "").trim();
        let name = cleaned.split(/\s+/).pop() ?? "";
        name = name.trim();
        if (name && /^[A-Za-z_]\w*$/.test(name)) params.push(name);
      }
    }
  }

  // constructor? `public Player(int hp)` — name matches the line's identifier after modifiers/type
  // property? `public int HP {` / `public int HP =>` / indexer `public int this[int i]`
  const beforeParen = parenStart >= 0 ? sig.slice(0, parenStart).trim() : sig.replace(/\{.*$|=>.*$|;.*$|=.*$/, "").trim();
  const indexerM = sig.match(/\bthis\s*\[/);
  if (indexerM) {
    const parts = [summary()];
    let ph = 2;
    for (const p of params) parts.push(`/// <param name="${p}">$${ph++}</param>`);
    parts.push(`/// <returns>$${ph++}</returns>$0`);
    return { kind: "indexer", memberName: "this[]", snippet: parts.join("\n") };
  }

  const headTokens = beforeParen.split(/\s+/).filter(Boolean);
  // peel modifiers to find the member name
  let rest = [...headTokens];
  while (rest.length && MOD_RE.test(rest[0] + " ")) rest.shift();
  // rest is now [Type, Name] for methods (2 tokens) or [Name] for ctors where name == type
  let name = rest[rest.length - 1] ?? "";
  // generic methods: Foo<T>( → name is Foo
  name = name.replace(/<.*$/, "");
  const isCtor = rest.length === 1 || (rest.length === 2 && rest[0].split(".").pop() === rest[1]);
  const isGenericName = /^[A-Za-z_]\w*$/.test(name);
  if (!isGenericName) return null;

  // property shape: accessor list `{ get; set; }` or expression body `=>`;
  // a plain `= value;` / `;` tail is a FIELD — VS gives fields a summary only
  if (parenStart < 0) {
    const isAccessor = /\{\s*(?:\[)?\s*(get|set|init|private|protected|internal|public)\b/.test(sig) || /=>/.test(sig);
    const isField = /=$/.test(sig) || /;$/.test(sig);
    if (isAccessor) {
      return {
        kind: "property",
        memberName: name,
        snippet: [
          "/// <summary>",
          "/// $1",
          "/// </summary>",
          "/// <value>$2</value>$0",
        ].join("\n"),
      };
    }
    if (isField) {
      return {
        kind: "property",
        memberName: name,
        snippet: [
          "/// <summary>",
          "/// $1",
          "/// </summary>$0",
        ].join("\n"),
      };
    }
    return null; // `using X;`, expressions, … — not a member to document
  }

  // method or constructor
  const before = beforeParen.split(/\s+/);
  const lastBefore = before[before.length - 1]?.replace(/<.*$/, "") ?? "";
  const kind: XmlDocResult["kind"] = isCtor || lastBefore === name && rest.length === 1 ? "constructor" : "method";
  // return type: token before the name (unless ctor / void / Task-ish async)
  const typeToken = rest.length >= 2 ? rest[rest.length - 2] : "";
  const isVoid = kind === "constructor"
    || /^void$/.test(typeToken)
    || /^(Task|ValueTask)(<.*)?$/.test(typeToken);

  const parts = [summary()];
  let ph = 2; // summary() owns $1 — params/returns continue the numbering
  for (const p of params) parts.push(`/// <param name="${p}">$${ph++}</param>`);
  if (!isVoid) parts.push(`/// <returns>$${ph++}</returns>`);
  parts.push("$0");
  return { kind, memberName: name, snippet: parts.join("\n") };
}

function summary(): string {
  return "/// <summary>\n/// $1\n/// </summary>";
}

/** find the balanced closing paren index for the "(" at start */
function matchBalanced(s: string, start: number): { start: number; end: number } | null {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return { start, end: i };
    } else if (s[i] === "{") break; // malformed — stop
  }
  return null;
}

/** convenience: whole-source overload used by the app (Monaco gives us text) */
export function xmlDocForSource(source: string, line: number): XmlDocResult | null {
  const lines = source.split("\n");
  if (line < 0 || line >= lines.length) return null;
  return xmlDocSuggestion(lines, line);
}
