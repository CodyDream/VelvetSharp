#!/usr/bin/env node
/**
 * VelvetSharp metadata CLI
 *   npx tsx packages/metadata/src/cli.ts extract <assembly.dll> <doc.xml> <out.json>
 *   npx tsx packages/metadata/src/cli.ts inspect <assembly.dll>
 */
import * as fs from "node:fs";
import { extractAssembly, mergeDocs, type ApiDb } from "./build";
import { parseDocXml } from "./docxml";
import { Ecma335Reader } from "./ecma335";

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function dbStats(db: ApiDb) {
  let types = 0, methods = 0, props = 0, fields = 0, events = 0, enums = 0, forwarded = 0, documented = 0;
  for (const types_ of Object.values(db.namespaces)) {
    for (const t of Object.values(types_)) {
      types++;
      if (t.kind === "enum") enums++;
      if (t.fwd) forwarded++;
      if (t.d) documented++;
      methods += t.m?.length ?? 0;
      props += t.p?.length ?? 0;
      fields += t.f?.length ?? 0;
      events += t.e?.length ?? 0;
    }
  }
  return { namespaces: Object.keys(db.namespaces).length, types, methods, props, fields, events, enums, forwarded, documented };
}

const [, , cmd, ...args] = process.argv;

if (cmd === "inspect") {
  const buf = new Uint8Array(fs.readFileSync(args[0]));
  const md = new Ecma335Reader(buf);
  console.log("Runtime version :", md.version);
  console.log("Tables          :", md.tables.size, "present");
  for (const [id, t] of md.tables) console.log(`  0x${id.toString(16).padStart(2, "0")} ${t.schema.name.padEnd(18)} ${fmtInt(t.rows)} rows`);
} else if (cmd === "extract") {
  const [dllPath, xmlPath, outPath] = args;
  if (!dllPath || !outPath) {
    console.error("usage: extract <assembly.dll> <doc.xml|-> <out.json>");
    process.exit(1);
  }
  const t0 = Date.now();
  const buf = new Uint8Array(fs.readFileSync(dllPath));
  const db = extractAssembly(buf);
  const t1 = Date.now();
  let docInfo = { merged: 0 };
  if (xmlPath && xmlPath !== "-") {
    const xml = fs.readFileSync(xmlPath, "utf8");
    const doc = parseDocXml(xml);
    docInfo = mergeDocs(db, doc);
    db.source.docs = true;
  }
  const t2 = Date.now();
  const json = JSON.stringify(db);
  fs.writeFileSync(outPath, json);
  const s = dbStats(db);
  console.log("=== VelvetSharp metadata extraction ===");
  console.log(`Assembly        : ${db.assembly} (runtime ${db.version})`);
  console.log(`Mode            : ${db.source.dll === "facade" ? "facade (type forwards)" : "full (typedefs)"}`);
  console.log(`Namespaces      : ${fmtInt(s.namespaces)}`);
  console.log(`Types           : ${fmtInt(s.types)} (${fmtInt(s.enums)} enums, ${fmtInt(s.forwarded)} forwarded)`);
  console.log(`Methods         : ${fmtInt(s.methods)}`);
  console.log(`Properties      : ${fmtInt(s.props)}`);
  console.log(`Fields          : ${fmtInt(s.fields)}`);
  console.log(`Events          : ${fmtInt(s.events)}`);
  console.log(`Doc summaries   : ${fmtInt(s.documented)} types + merged ${fmtInt(docInfo.merged)} doc fragments`);
  console.log(`Parse time      : ${t1 - t0}ms dll, ${t2 - t1}ms xml+merge`);
  console.log(`Output          : ${outPath} (${(json.length / 1024 / 1024).toFixed(2)} MB)`);

  // tiny sample to sanity check (3 entries only)
  const firstNs = Object.keys(db.namespaces)[0];
  if (firstNs) {
    const tName = Object.keys(db.namespaces[firstNs])[0];
    const t = db.namespaces[firstNs][tName];
    console.log(`Sample          : ${firstNs}.${tName} kind=${t.kind} base=${t.base ?? "-"} methods=${t.m?.length ?? 0} props=${t.p?.length ?? 0}`);
    const m = t.m?.[0];
    if (m) console.log(`  method        : ${m.n}(${m.ps.map((p) => p.t).join(", ")}) -> ${m.ret}${m.d ? ` | doc: ${m.d.slice(0, 60)}...` : ""}`);
    const p = t.p?.[0];
    if (p) console.log(`  property      : ${p.n}: ${p.t}${p.d ? ` | doc: ${p.d.slice(0, 60)}...` : ""}`);
  }
} else {
  console.error("commands: inspect <dll> | extract <dll> <xml|-> <out.json>");
  process.exit(1);
}
