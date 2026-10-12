/**
 * VelvetSharp metadata — ECMA-335 II.23.2 signature blob decoder.
 * Decodes method / field / property signatures into readable type names.
 */
import type { Ecma335Reader } from "./ecma335";

const PRIM: Record<number, string> = {
  0x01: "void",
  0x02: "System.Boolean",
  0x03: "System.Char",
  0x04: "System.SByte",
  0x05: "System.Byte",
  0x06: "System.Int16",
  0x07: "System.UInt16",
  0x08: "System.Int32",
  0x09: "System.UInt32",
  0x0a: "System.Int64",
  0x0b: "System.UInt64",
  0x0c: "System.Single",
  0x0d: "System.Double",
  0x0e: "System.String",
  0x18: "System.IntPtr",
  0x19: "System.UIntPtr",
  0x1c: "System.Object",
};

export class SigDecoder {
  private p = 0;
  constructor(private blob: Uint8Array, private md: Ecma335Reader) {}

  static decodeMethod(blob: Uint8Array, md: Ecma335Reader) {
    const d = new SigDecoder(blob, md);
    const head = d.u8();
    let genericCount = 0;
    if (head & 0x10) genericCount = d.cuint();
    const paramCount = d.cuint();
    if (paramCount > 255 || genericCount > 32) throw new Error("implausible signature shape");
    const ret = d.type();
    const params: string[] = [];
    for (let i = 0; i < paramCount; i++) params.push(d.type());
    return { genericCount, ret, params };
  }

  static decodeField(blob: Uint8Array, md: Ecma335Reader): string {
    const d = new SigDecoder(blob, md);
    d.u8(); // FIELD 0x06
    return d.type();
  }

  static decodeProperty(blob: Uint8Array, md: Ecma335Reader): string {
    const d = new SigDecoder(blob, md);
    const head = d.u8(); // PROPERTY (0x08) | HASTHIS 0x20
    let _ = head;
    const _paramCount = d.cuint();
    return d.type(); // first "param" is the property type
  }

  /* --------------------------- primitives --------------------------- */

  private u8(): number {
    if (this.p >= this.blob.length) throw new Error("signature overrun");
    return this.blob[this.p++];
  }

  private cuint(): number {
    if (this.p >= this.blob.length) throw new Error("signature overrun");
    const b0 = this.blob[this.p];
    if ((b0 & 0x80) === 0) { this.p++; return b0; }                 // 0xxxxxxx
    if ((b0 & 0xc0) === 0x80) {                                     // 10xxxxxx xxxxxxxx
      const v = ((b0 & 0x3f) << 8) | this.blob[this.p + 1]; this.p += 2; return v;
    }
    const v = ((b0 & 0x1f) << 24) | (this.blob[this.p + 1] << 16) | (this.blob[this.p + 2] << 8) | this.blob[this.p + 3];
    this.p += 4;
    return v;
  }

  /** decode a Type handle (TypeDefOrRefOrSpecEncoded compressed int) */
  private typeDefOrRefToken(): string | null {
    const raw = this.cuint();
    const table = raw & 3; // 0 TypeDef, 1 TypeRef, 2 TypeSpec
    const row = raw >>> 2; // 1-based
    if (row === 0) return null;
    if (table === 0) {
      const td = this.md.tables.get(0x02)!;
      if (row > td.rows) return null;
      const ns = this.md.getStringOf(td.get(row - 1, "Namespace"));
      const n = this.md.getStringOf(td.get(row - 1, "Name"));
      return ns ? `${ns}.${n}` : n;
    }
    if (table === 1) {
      const tr = this.md.tables.get(0x01)!;
      if (row > tr.rows) return null;
      const ns = this.md.getStringOf(tr.get(row - 1, "Namespace"));
      const n = this.md.getStringOf(tr.get(row - 1, "Name"));
      return ns ? `${ns}.${n}` : n;
    }
    return "generic";
  }

  /** decode a TYPE per II.23.2.12 */
  type(): string {
    const et = this.u8();
    switch (et) {
      case 0x01: return "void";
      case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07:
      case 0x08: case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d:
      case 0x0e: case 0x18: case 0x19: case 0x1c:
        return PRIM[et] ?? "unknown";
      case 0x0f: {
        const inner = this.type();
        return `${inner}*`;
      }
      case 0x10: return `${this.type()}&`; // BYREF — XML doc style: "UnityEngine.RaycastHit&"
      case 0x11: case 0x12: { // VALUETYPE / CLASS
        const t = this.typeDefOrRefToken();
        return t ?? "unknown";
      }
      case 0x13: { const i = this.cuint(); return `T${i}`; } // VAR (type generic)
      case 0x1e: { const i = this.cuint(); return `M${i}`; } // MVAR (method generic)
      case 0x1d: return `${this.type()}[]`;
      case 0x14: { // ARRAY with shape
        const inner = this.type();
        const rank = this.cuint();
        const sizes = this.cuint();
        for (let i = 0; i < sizes; i++) this.cuint();
        const lob = this.cuint();
        for (let i = 0; i < lob; i++) this.cint();
        return `${inner}[${rank > 0 ? ",".repeat(rank - 1) : ""}]`;
      }
      case 0x15: { // GENERICINST
        this.u8(); // CLASS/VALUETYPE flag
        const open = this.typeDefOrRefToken() ?? "generic";
        const argc = this.cuint();
        const args: string[] = [];
        for (let i = 0; i < argc; i++) args.push(this.type());
        const base = open.split("`")[0];
        return `${base}<${args.join(", ")}>`;
      }
      case 0x1b: {
        // FNPTR: embedded full MethodDefSig
        const head = this.u8();
        let gen = 0;
        if (head & 0x10) gen = this.cuint();
        const pc = this.cuint();
        if (pc > 255) throw new Error("implausible fnptr shape");
        this.type(); // ret
        for (let i = 0; i < pc; i++) this.type();
        return "fnptr";
      }
      case 0x16: return "typedref";
      case 0x45: case 0x1f: case 0x20: { // CUSTOMMOD (CMOD_OPT/REQD)
        this.cuint(); // token
        return this.type();
      }
      case 0x54: { // PINNED
        return this.type();
      }
      default:
        return "unknown";
    }
  }

  private cint(): number {
    return this.cuint();
  }
}
