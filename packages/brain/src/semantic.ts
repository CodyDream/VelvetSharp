/** VelvetSharp brain — semantic token legend + encoder (Monaco DocumentSemanticTokens). */

export const SEMANTIC_TOKEN_TYPES = [
  "namespace", "class", "struct", "interface", "enum", "enumMember", "delegate",
  "method", "unityMethod", "property", "field", "variable", "parameter",
  "type", "unityType", "builtin", "event", "attribute",
] as const;

export const SEMANTIC_TOKEN_MODIFIERS = ["declaration", "static"] as const;

/** token name -> legend index */
export const ST = Object.fromEntries(
  SEMANTIC_TOKEN_TYPES.map((t, i) => [t, i])
) as Record<(typeof SEMANTIC_TOKEN_TYPES)[number], number>;

export const MOD_DECLARATION = 1 << 0;
export const MOD_STATIC = 1 << 1;

/** Ordered token collector — Monaco requires strictly non-decreasing positions,
 *  so we sort collected tokens before delta-encoding. */
export class TokenSink {
  private collected: number[][] = [];

  push(line: number, col: number, length: number, type: number, mods: number): void {
    if (line < 0 || col < 0 || length <= 0 || type < 0) return;
    this.collected.push([line, col, Math.min(length, 500), type, mods]);
  }

  encode(): Uint32Array {
    this.collected.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // safety dedupe: drop exact duplicate spans (id-mismatched re-emissions)
    const seen = new Set<string>();
    const uniq = this.collected.filter((t) => {
      const k = `${t[0]}:${t[1]}:${t[2]}:${t[3]}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const out = new Uint32Array(uniq.length * 5);
    let lastLine = 0, lastCol = 0;
    for (let i = 0; i < uniq.length; i++) {
      const [line, col, len, type, mods] = uniq[i];
      const dLine = line - lastLine;
      const dCol = dLine === 0 ? col - lastCol : col;
      out[i * 5] = dLine;
      out[i * 5 + 1] = dCol;
      out[i * 5 + 2] = len;
      out[i * 5 + 3] = type;
      out[i * 5 + 4] = mods;
      lastLine = line;
      lastCol = col;
    }
    return out;
  }
}
