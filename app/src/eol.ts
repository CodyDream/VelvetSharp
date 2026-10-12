/** VelvetSharp — line-ending helpers (v0.7.0 CRLF/LF support).
 *
 *  Every insert the brain or the UI generates is authored with "\n"; before it
 *  touches a Monaco model (or a file on disk) it must be converted to the
 *  document's real EOL so CRLF files never turn mixed-ending. */

export type Eol = "\n" | "\r\n";

/** detect the dominant EOL of a buffer (CRLF wins if any \r\n exists) */
export function detectEol(content: string): Eol {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Monaco model EOL flag (EndOfLineSequence: LF = 1, CRLF = 2) → string */
export function eolOfMonaco(model: { eol?: number } | null | undefined): Eol {
  return model?.eol === 2 ? "\r\n" : "\n";
}

/** convert LF-authored text to the target EOL (idempotent) */
export function convertEol(text: string, eol: Eol): string {
  if (eol === "\r\n") return text.replace(/\r?\n/g, "\r\n");
  return text.replace(/\r\n/g, "\n");
}

/** split a buffer into lines honoring its detected EOL (keeps content intact) */
export function splitLines(content: string): { eol: Eol; lines: string[] } {
  const eol = detectEol(content);
  return { eol, lines: content.split(eol === "\r\n" ? "\r\n" : "\n") };
}

/** join lines back with the same EOL they were read with */
export function joinLines(eol: Eol, lines: string[]): string {
  return lines.join(eol);
}
