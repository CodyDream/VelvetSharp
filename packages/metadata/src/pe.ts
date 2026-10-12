/**
 * VelvetSharp metadata — minimal PE32 reader (ECMA-335 carrier format).
 * Pure TypeScript, zero dependencies, browser & node safe.
 */

export interface PESection {
  vaddr: number;
  vsize: number;
  rawptr: number;
  rawsize: number;
}

export interface PEInfo {
  sections: PESection[];
  clrHeaderRva: number;
}

export function parsePE(buf: Uint8Array): PEInfo {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 0x40) throw new Error("File too small to be a PE image");
  const dosSig = dv.getUint16(0, true);
  if (dosSig !== 0x5a4d) throw new Error("Not a PE file (missing MZ signature)");
  const e_lfanew = dv.getUint32(0x3c, true);
  if (e_lfanew + 24 > buf.length) throw new Error("Corrupt PE header");
  const peSig = dv.getUint32(e_lfanew, true);
  if (peSig !== 0x00004550) throw new Error("Invalid PE signature (expected PE\\0\\0)");

  const coff = e_lfanew + 4;
  const numSections = dv.getUint16(coff + 2, true);
  const optSize = dv.getUint16(coff + 16, true);
  const opt = coff + 20;
  if (opt + optSize > buf.length) throw new Error("Corrupt optional header");
  const magic = dv.getUint16(opt, true);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`Unsupported PE magic 0x${magic.toString(16)}`);
  const ddOffset = opt + (magic === 0x20b ? 112 : 96);
  const numDirs = dv.getUint32(opt + (magic === 0x20b ? 108 : 92), true);
  let clrHeaderRva = 0;
  if (numDirs > 14) {
    clrHeaderRva = dv.getUint32(ddOffset + 14 * 8, true);
  }

  const sectOff = opt + optSize;
  const sections: PESection[] = [];
  for (let i = 0; i < numSections; i++) {
    const s = sectOff + i * 40;
    if (s + 40 > buf.length) break;
    sections.push({
      vsize: dv.getUint32(s + 8, true),
      vaddr: dv.getUint32(s + 12, true),
      rawsize: dv.getUint32(s + 16, true),
      rawptr: dv.getUint32(s + 20, true),
    });
  }
  return { sections, clrHeaderRva };
}

export function rvaToOffset(pe: PEInfo, rva: number): number {
  for (const s of pe.sections) {
    const span = Math.max(s.vsize, s.rawsize);
    if (rva >= s.vaddr && rva < s.vaddr + span) {
      const delta = rva - s.vaddr;
      if (delta >= s.rawsize) throw new Error(`RVA 0x${rva.toString(16)} points into uninitialized section data`);
      return s.rawptr + delta;
    }
  }
  throw new Error(`RVA 0x${rva.toString(16)} not mapped by any section`);
}
