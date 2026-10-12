/**
 * VelvetSharp metadata — ECMA-335 (#~ stream) metadata table reader.
 * Reads TypeDef/MethodDef/Field/Property/Event/ExportedType etc. from a
 * managed assembly, without any .NET runtime. Pure TypeScript.
 */
import { parsePE, rvaToOffset, type PEInfo } from "./pe";

/* ---------------------------------- schema ---------------------------------- */

export interface TableSchema {
  id: number;
  name: string;
  cols: Col[];
}

export type Col =
  | { k: "fixed"; n: string; size: 1 | 2 | 4 }
  | { k: "str"; n: string }
  | { k: "guid"; n: string }
  | { k: "blob"; n: string }
  | { k: "table"; n: string; table: number }
  | { k: "coded"; n: string; group: keyof typeof CODED_GROUPS };

export const CODED_GROUPS = {
  TypeDefOrRef: [0x02, 0x01, 0x1b], // TypeDef, TypeRef, TypeSpec
  ResolutionScope: [0x00, 0x1a, 0x23, 0x01], // Module, ModuleRef, AssemblyRef, TypeRef
  HasConstant: [0x04, 0x08, 0x17], // Field, Param, Property
  HasCustomAttribute: [
    0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14, 0x11,
    0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b,
  ],
  HasFieldMarshal: [0x04, 0x08],
  HasDeclSecurity: [0x02, 0x06, 0x20],
  MemberRefParent: [0x02, 0x01, 0x1a, 0x06, 0x1b],
  HasSemantics: [0x14, 0x17], // Event, Property
  MethodDefOrRef: [0x06, 0x0a],
  MemberForwarded: [0x04, 0x06],
  Implementation: [0x26, 0x23, 0x27], // File, AssemblyRef, ExportedType
  CustomAttributeType: [0xff, 0xff, 0x06, 0x0a, 0xff],
  TypeOrMethodDef: [0x02, 0x06],
} as const;

const SCHEMAS: TableSchema[] = [
  { id: 0x00, name: "Module", cols: [{ k: "fixed", n: "Generation", size: 2 }, { k: "str", n: "Name" }, { k: "guid", n: "Mvid" }, { k: "guid", n: "EncId" }, { k: "guid", n: "EncBaseId" }] },
  { id: 0x01, name: "TypeRef", cols: [{ k: "coded", n: "ResolutionScope", group: "ResolutionScope" }, { k: "str", n: "Name" }, { k: "str", n: "Namespace" }] },
  { id: 0x02, name: "TypeDef", cols: [{ k: "fixed", n: "Flags", size: 4 }, { k: "str", n: "Name" }, { k: "str", n: "Namespace" }, { k: "coded", n: "Extends", group: "TypeDefOrRef" }, { k: "table", n: "FieldList", table: 0x04 }, { k: "table", n: "MethodList", table: 0x06 }] },
  { id: 0x03, name: "FieldPtr", cols: [{ k: "table", n: "Field", table: 0x04 }] },
  { id: 0x04, name: "Field", cols: [{ k: "fixed", n: "Flags", size: 2 }, { k: "str", n: "Name" }, { k: "blob", n: "Signature" }] },
  { id: 0x05, name: "MethodPtr", cols: [{ k: "table", n: "Method", table: 0x06 }] },
  { id: 0x06, name: "MethodDef", cols: [{ k: "fixed", n: "RVA", size: 4 }, { k: "fixed", n: "ImplFlags", size: 2 }, { k: "fixed", n: "Flags", size: 2 }, { k: "str", n: "Name" }, { k: "blob", n: "Signature" }, { k: "table", n: "ParamList", table: 0x08 }] },
  { id: 0x07, name: "ParamPtr", cols: [{ k: "table", n: "Param", table: 0x08 }] },
  { id: 0x08, name: "Param", cols: [{ k: "fixed", n: "Flags", size: 2 }, { k: "fixed", n: "Sequence", size: 2 }, { k: "str", n: "Name" }] },
  { id: 0x09, name: "InterfaceImpl", cols: [{ k: "table", n: "Class", table: 0x02 }, { k: "coded", n: "Interface", group: "TypeDefOrRef" }] },
  { id: 0x0a, name: "MemberRef", cols: [{ k: "coded", n: "Class", group: "MemberRefParent" }, { k: "str", n: "Name" }, { k: "blob", n: "Signature" }] },
  { id: 0x0b, name: "Constant", cols: [{ k: "fixed", n: "Type", size: 1 }, { k: "fixed", n: "Pad", size: 1 }, { k: "coded", n: "Parent", group: "HasConstant" }, { k: "blob", n: "Value" }] },
  { id: 0x0c, name: "CustomAttribute", cols: [{ k: "coded", n: "Parent", group: "HasCustomAttribute" }, { k: "coded", n: "Type", group: "CustomAttributeType" }, { k: "blob", n: "Value" }] },
  { id: 0x0d, name: "FieldMarshal", cols: [{ k: "coded", n: "Parent", group: "HasFieldMarshal" }, { k: "blob", n: "NativeType" }] },
  { id: 0x0e, name: "DeclSecurity", cols: [{ k: "fixed", n: "Action", size: 2 }, { k: "coded", n: "Parent", group: "HasDeclSecurity" }, { k: "blob", n: "PermissionSet" }] },
  { id: 0x0f, name: "ClassLayout", cols: [{ k: "fixed", n: "PackingSize", size: 2 }, { k: "fixed", n: "ClassSize", size: 4 }, { k: "table", n: "Parent", table: 0x02 }] },
  { id: 0x10, name: "FieldLayout", cols: [{ k: "fixed", n: "Offset", size: 4 }, { k: "table", n: "Field", table: 0x04 }] },
  { id: 0x11, name: "StandAloneSig", cols: [{ k: "blob", n: "Signature" }] },
  { id: 0x12, name: "EventMap", cols: [{ k: "table", n: "Parent", table: 0x02 }, { k: "table", n: "EventList", table: 0x14 }] },
  { id: 0x13, name: "EventPtr", cols: [{ k: "table", n: "Event", table: 0x14 }] },
  { id: 0x14, name: "Event", cols: [{ k: "fixed", n: "EventFlags", size: 2 }, { k: "str", n: "Name" }, { k: "coded", n: "EventType", group: "TypeDefOrRef" }] },
  { id: 0x15, name: "PropertyMap", cols: [{ k: "table", n: "Parent", table: 0x02 }, { k: "table", n: "PropertyList", table: 0x17 }] },
  { id: 0x16, name: "PropertyPtr", cols: [{ k: "table", n: "Property", table: 0x17 }] },
  { id: 0x17, name: "Property", cols: [{ k: "fixed", n: "Flags", size: 2 }, { k: "str", n: "Name" }, { k: "blob", n: "Type" }] },
  { id: 0x18, name: "MethodSemantics", cols: [{ k: "fixed", n: "Semantics", size: 2 }, { k: "table", n: "Method", table: 0x06 }, { k: "coded", n: "Association", group: "HasSemantics" }] },
  { id: 0x19, name: "MethodImpl", cols: [{ k: "table", n: "Class", table: 0x02 }, { k: "coded", n: "MethodBody", group: "MethodDefOrRef" }, { k: "coded", n: "MethodDeclaration", group: "MethodDefOrRef" }] },
  { id: 0x1a, name: "ModuleRef", cols: [{ k: "str", n: "Name" }] },
  { id: 0x1b, name: "TypeSpec", cols: [{ k: "blob", n: "Signature" }] },
  { id: 0x1c, name: "ImplMap", cols: [{ k: "fixed", n: "MappingFlags", size: 2 }, { k: "coded", n: "MemberForwarded", group: "MemberForwarded" }, { k: "str", n: "ImportName" }, { k: "table", n: "ImportScope", table: 0x1a }] },
  { id: 0x1d, name: "FieldRVA", cols: [{ k: "fixed", n: "RVA", size: 4 }, { k: "table", n: "Field", table: 0x04 }] },
  { id: 0x1e, name: "EncLog", cols: [{ k: "fixed", n: "Token", size: 4 }, { k: "fixed", n: "FuncCode", size: 4 }] },
  { id: 0x1f, name: "EncMap", cols: [{ k: "fixed", n: "Token", size: 4 }] },
  { id: 0x20, name: "Assembly", cols: [{ k: "fixed", n: "HashAlgId", size: 4 }, { k: "fixed", n: "MajorVersion", size: 2 }, { k: "fixed", n: "MinorVersion", size: 2 }, { k: "fixed", n: "BuildNumber", size: 2 }, { k: "fixed", n: "RevisionNumber", size: 2 }, { k: "fixed", n: "Flags", size: 4 }, { k: "blob", n: "PublicKey" }, { k: "str", n: "Name" }, { k: "str", n: "Culture" }] },
  { id: 0x21, name: "AssemblyProcessor", cols: [{ k: "fixed", n: "Processor", size: 4 }] },
  { id: 0x22, name: "AssemblyOS", cols: [{ k: "fixed", n: "OSPlatformID", size: 4 }, { k: "fixed", n: "OSMajorVersion", size: 4 }, { k: "fixed", n: "OSMinorVersion", size: 4 }] },
  { id: 0x23, name: "AssemblyRef", cols: [{ k: "fixed", n: "MajorVersion", size: 2 }, { k: "fixed", n: "MinorVersion", size: 2 }, { k: "fixed", n: "BuildNumber", size: 2 }, { k: "fixed", n: "RevisionNumber", size: 2 }, { k: "fixed", n: "Flags", size: 4 }, { k: "blob", n: "PublicKeyOrToken" }, { k: "str", n: "Name" }, { k: "str", n: "Culture" }, { k: "blob", n: "HashValue" }] },
  { id: 0x24, name: "AssemblyRefProcessor", cols: [{ k: "fixed", n: "Processor", size: 4 }, { k: "coded", n: "AssemblyRef", group: "ResolutionScope" }] },
  { id: 0x25, name: "AssemblyRefOS", cols: [{ k: "fixed", n: "OSPlatformID", size: 4 }, { k: "fixed", n: "OSMajorVersion", size: 4 }, { k: "fixed", n: "OSMinorVersion", size: 4 }, { k: "coded", n: "AssemblyRef", group: "ResolutionScope" }] },
  { id: 0x26, name: "File", cols: [{ k: "fixed", n: "Flags", size: 4 }, { k: "str", n: "Name" }, { k: "blob", n: "HashValue" }] },
  { id: 0x27, name: "ExportedType", cols: [{ k: "fixed", n: "Flags", size: 4 }, { k: "fixed", n: "TypeDefId", size: 4 }, { k: "str", n: "TypeName" }, { k: "str", n: "TypeNamespace" }, { k: "coded", n: "Implementation", group: "Implementation" }] },
  { id: 0x28, name: "ManifestResource", cols: [{ k: "fixed", n: "Offset", size: 4 }, { k: "fixed", n: "Flags", size: 4 }, { k: "str", n: "Name" }, { k: "coded", n: "Implementation", group: "Implementation" }] },
  { id: 0x29, name: "NestedClass", cols: [{ k: "table", n: "NestedClass", table: 0x02 }, { k: "table", n: "EnclosingClass", table: 0x02 }] },
  { id: 0x2a, name: "GenericParam", cols: [{ k: "fixed", n: "Number", size: 2 }, { k: "fixed", n: "Flags", size: 2 }, { k: "coded", n: "Owner", group: "TypeOrMethodDef" }, { k: "str", n: "Name" }] },
  { id: 0x2b, name: "MethodSpec", cols: [{ k: "coded", n: "Method", group: "MethodDefOrRef" }, { k: "blob", n: "Instantiation" }] },
  { id: 0x2c, name: "GenericParamConstraint", cols: [{ k: "table", n: "Owner", table: 0x2a }, { k: "coded", n: "Constraint", group: "TypeDefOrRef" }] },
];

/* ---------------------------------- reader ---------------------------------- */

export interface TableData {
  schema: TableSchema;
  rows: number;
  /** flat column values, rows * cols */
  data: Uint32Array;
  get(row: number, col: string): number;
}

export class Ecma335Reader {
  pe: PEInfo;
  buf: Uint8Array;
  dv: DataView;
  metadataRootOffset = 0;
  version = "";
  tables = new Map<number, TableData>();
  strings: Uint8Array = new Uint8Array(0);
  blob: Uint8Array = new Uint8Array(0);
  private stringIdxSize = 2;
  private guidIdxSize = 2;
  private blobIdxSize = 2;
  private assemblyRefNames: string[] = [];

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pe = parsePE(buf);
    this.readClrHeader();
    this.readMetadataRoot();
  }

  private readClrHeader() {
    if (!this.pe.clrHeaderRva) throw new Error("Not a managed assembly (no CLR header)");
    // validate: clr header magic
    const off = rvaToOffset(this.pe, this.pe.clrHeaderRva);
    const cb = this.dv.getUint32(off, true);
    if (cb < 72) throw new Error("Invalid CLR header size");
  }

  private readMetadataRoot() {
    const clrOff = rvaToOffset(this.pe, this.pe.clrHeaderRva);
    const mdRva = this.dv.getUint32(clrOff + 8, true);
    const mdSize = this.dv.getUint32(clrOff + 12, true);
    const off = rvaToOffset(this.pe, mdRva);
    this.metadataRootOffset = off;
    const sig = this.dv.getUint32(off, true);
    if (sig !== 0x424a5342) throw new Error("Invalid metadata signature (expected BSJB)");
    const versionLen = this.dv.getUint32(off + 12, true);
    let p = off + 16 + versionLen;
    p += 2; // flags
    const numStreams = this.dv.getUint16(p, true);
    p += 2;
    // version string
    const verStart = off + 16;
    let verEnd = verStart;
    while (verEnd < verStart + versionLen && this.buf[verEnd] !== 0) verEnd++;
    this.version = new TextDecoder().decode(this.buf.subarray(verStart, verEnd));

    const streamHeaders: { offset: number; size: number; name: string }[] = [];
    for (let i = 0; i < numStreams; i++) {
      const sOff = this.dv.getUint32(p, true);
      const sSize = this.dv.getUint32(p + 4, true);
      p += 8;
      let nameEnd = p;
      while (nameEnd < off + mdSize && this.buf[nameEnd] !== 0) nameEnd++;
      const name = new TextDecoder().decode(this.buf.subarray(p, nameEnd));
      p = nameEnd + 1;
      p = (p + 3) & ~3; // pad to 4
      streamHeaders.push({ offset: off + sOff, size: sSize, name });
    }

    for (const sh of streamHeaders) {
      if (sh.name === "#Strings") this.strings = this.buf.subarray(sh.offset, sh.offset + sh.size);
      else if (sh.name === "#Blob") this.blob = this.buf.subarray(sh.offset, sh.offset + sh.size);
      else if (sh.name === "#~" || sh.name === "#-") this.parseTablesStream(sh.offset, sh.size);
    }
  }

  getStringOf(idx: number): string {
    return this.getString(idx);
  }

  private getString(idx: number): string {
    if (idx === 0 || idx >= this.strings.length) return "";
    let end = idx;
    while (end < this.strings.length && this.strings[end] !== 0) end++;
    return new TextDecoder().decode(this.strings.subarray(idx, end));
  }

  getBlobLength(idx: number): { len: number; dataStart: number } {
    if (idx >= this.blob.length) return { len: 0, dataStart: idx };
    const b0 = this.blob[idx];
    if (b0 === 0) return { len: 0, dataStart: idx + 1 };
    if ((b0 & 0xc0) === 0x80) return { len: ((b0 & 0x3f) << 8) | this.blob[idx + 1], dataStart: idx + 2 };
    if ((b0 & 0xe0) === 0xc0)
      return {
        len: ((b0 & 0x1f) << 24) | (this.blob[idx + 1] << 16) | (this.blob[idx + 2] << 8) | this.blob[idx + 3],
        dataStart: idx + 4,
      };
    return { len: b0, dataStart: idx + 1 };
  }

  getBlob(idx: number): Uint8Array {
    const { len, dataStart } = this.getBlobLength(idx);
    return this.blob.subarray(dataStart, dataStart + len);
  }

  private parseTablesStream(off: number, size: number) {
    const dv = this.dv;
    const heapSizes = dv.getUint8(off + 6);
    this.stringIdxSize = heapSizes & 0x01 ? 4 : 2;
    this.guidIdxSize = heapSizes & 0x02 ? 4 : 2;
    this.blobIdxSize = heapSizes & 0x04 ? 4 : 2;

    const valid = BigInt(dv.getUint32(off + 8, true)) | (BigInt(dv.getUint32(off + 12, true)) << 32n);
    let p = off + 24;
    const rowCounts = new Map<number, number>();
    for (let t = 0; t < 64; t++) {
      if ((valid & (1n << BigInt(t))) !== 0n) {
        rowCounts.set(t, dv.getUint32(p, true));
        p += 4;
      }
    }

    const rowsOf = (t: number) => rowCounts.get(t) ?? 0;
    const idxSizeFor = (t: number) => (rowsOf(t) < 0x10000 ? 2 : 4);
    const codedSizeFor = (group: readonly number[]) => {
      const bits = group.length > 16 ? 5 : group.length > 8 ? 4 : group.length > 4 ? 3 : group.length > 2 ? 2 : 1;
      let maxRows = 0;
      for (const t of group) if (t !== 0xff) maxRows = Math.max(maxRows, rowsOf(t));
      return maxRows < 0x10000 >> bits ? 2 : 4;
    };
    const colSize = (c: Col): number => {
      switch (c.k) {
        case "fixed": return c.size;
        case "str": return this.stringIdxSize;
        case "guid": return this.guidIdxSize;
        case "blob": return this.blobIdxSize;
        case "table": return idxSizeFor(c.table);
        case "coded": return codedSizeFor(CODED_GROUPS[c.group]);
      }
    };

    for (const schema of SCHEMAS) {
      const rowCount = rowsOf(schema.id);
      if (!rowCount) continue;
      const colSizes = schema.cols.map(colSize);
      const rowSize = colSizes.reduce((a, b) => a + b, 0);
      const data = new Uint32Array(rowCount * schema.cols.length);
      for (let r = 0; r < rowCount; r++) {
        let cp = p + r * rowSize;
        for (let c = 0; c < colSizes.length; c++) {
          const sz = colSizes[c];
          data[r * schema.cols.length + c] = sz === 1 ? this.buf[cp] : sz === 2 ? dv.getUint16(cp, true) : dv.getUint32(cp, true);
          cp += sz;
        }
      }
      p += rowCount * rowSize;
      this.tables.set(schema.id, { schema, rows: rowCount, data, get: () => 0 });
    }

    // patch the get() helper per table
    for (const td of this.tables.values()) {
      const ncols = td.schema.cols.length;
      const colIndex = new Map<string, number>();
      td.schema.cols.forEach((c, i) => colIndex.set(c.n, i));
      td.get = (row: number, col: string) => {
        const ci = colIndex.get(col);
        if (ci === undefined) throw new Error(`Column ${col} not in ${td.schema.name}`);
        return td.data[row * ncols + ci];
      };
    }

    // AssemblyRef names for facade resolution
    const ar = this.tables.get(0x23);
    if (ar) for (let r = 0; r < ar.rows; r++) this.assemblyRefNames.push(this.getString(ar.get(r, "Name")));
  }

  /* ------------------------- convenience accessors ------------------------- */

  typeName(tdrRaw: number): string | null {
    // coded TypeDefOrRef: tag = raw & 3, row = raw >> 2 (1-based)
    const tag = tdrRaw & 3;
    const row = (tdrRaw >>> 2) - 1;
    if (row < 0) return null;
    if (tag === 0) {
      const td = this.tables.get(0x02)!;
      const ns = this.getString(td.get(row, "Namespace"));
      const n = this.getString(td.get(row, "Name"));
      return ns ? `${ns}.${n}` : n;
    }
    if (tag === 1) {
      const tr = this.tables.get(0x01)!;
      const ns = this.getString(tr.get(row, "Namespace"));
      const n = this.getString(tr.get(row, "Name"));
      return ns ? `${ns}.${n}` : n;
    }
    return "generic"; // TypeSpec — resolved at call site if needed
  }

  isPublicTypeDef(row: number): boolean {
    const td = this.tables.get(0x02)!;
    const flags = td.get(row, "Flags");
    const vis = flags & 0x7;
    return vis === 1 || vis === 2; // Public or NestedPublic
  }

  typeDefFullName(row: number): { ns: string; name: string } {
    const td = this.tables.get(0x02)!;
    const ns = this.getString(td.get(row, "Namespace"));
    const name = this.getString(td.get(row, "Name"));
    return { ns, name };
  }

  genericParamsOf(owner: "type" | "method", row: number): string[] {
    const gp = this.tables.get(0x2a);
    if (!gp) return [];
    const out: string[] = [];
    for (let r = 0; r < gp.rows; r++) {
      const raw = gp.get(r, "Owner");
      const tag = raw & 1;
      const ownerRow = (raw >>> 1) - 1;
      if (tag === (owner === "type" ? 0 : 1) && ownerRow === row) {
        out[gp.get(r, "Number")] = this.getString(gp.get(r, "Name"));
      }
    }
    return out;
  }

  assemblyRefName(idx1based: number): string {
    return this.assemblyRefNames[idx1based - 1] ?? "";
  }
}
