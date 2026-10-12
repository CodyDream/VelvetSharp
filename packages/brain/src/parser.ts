/** VelvetSharp brain — tree-sitter C# wrapper: parse, extract symbols & diagnostics */
import Parser, { type Tree, type SyntaxNode } from "web-tree-sitter";
import type { Diagnostic, SymbolInfo, FileSymbols, IdentRef } from "./types";

let ParserCtor: typeof Parser | null = null;
let Lang: Parser.Language | null = null;

export interface ParserHandles {
  parser: Parser;
  Lang: Parser.Language;
}

/** wasmDir: URL/dir containing web-tree-sitter.wasm and tree-sitter-c_sharp.wasm */
export async function initCSharpParser(wasmLocator: (file: string) => string): Promise<ParserHandles> {
  // Node ESM: emscripten glue calls require("fs/promises") — provide a real require.
  const g = globalThis as any;
  if (typeof window === "undefined" && typeof g.require === "undefined" && typeof process !== "undefined") {
    try { g.require = (await import("node:module")).default.createRequire(import.meta.url); } catch { /* ignore */ }
  }
  const mod: any = await import("web-tree-sitter");
  const ParserCtor = mod.Parser ?? mod.default?.Parser ?? mod.default;
  const Language = mod.Language ?? mod.default?.Language;
  await ParserCtor.init({ locateFile: wasmLocator });
  Lang = await Language.load(wasmLocator("tree-sitter-c_sharp.wasm"));
  const parser = new ParserCtor();
  parser.setLanguage(Lang);
  ParserCtorRef = ParserCtor;
  return { parser, Lang: Lang! };
}

let ParserCtorRef: any = null;

const TYPE_NODES = new Set([
  "class_declaration", "struct_declaration", "interface_declaration",
  "enum_declaration", "record_declaration",
]);

/** v0.7.1 CRITICAL FIX (user report: "thinks void is oid, asks for return value"):
 *  this used to accept an oldTree for incremental parsing. web-tree-sitter only
 *  allows that when tree.edit() is called with exact byte/point deltas — we never
 *  did, so the parser silently produced CORRUPTED trees whose nodes pointed at
 *  shifted ranges (node.text sliced mid-token: "void" read back as "oid", which
 *  then failed the isVoid check and fired false "missing return value" errors,
 *  plus a whole class of "weird/duplicate problem" flakiness). Incremental
 *  parsing is now FORBIDDEN structurally: every parse is a clean full re-parse.
 *  Cost is negligible (single-file C# parse is ~1-10 ms; the v0.7.0 pipeline
 *  already merged syntax+semantic into this one parse). */
export function parseCSharp(h: ParserHandles, text: string): Tree {
  return h.parser.parse(text);
}

/* --------------------------- symbol extraction --------------------------- */

function nodeText(n: SyntaxNode | null): string {
  return n ? n.text : "";
}

function identOf(n: SyntaxNode | null): string {
  if (!n) return "";
  if (n.type === "identifier" || n.type === "generic_name") return n.text;
  // qualified_name -> last part
  const parts = n.text.split(".");
  return parts[parts.length - 1] ?? n.text;
}

function firstIdentifier(n: SyntaxNode | null): SyntaxNode | null {
  if (!n) return null;
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (c?.type === "identifier") return c;
  }
  return null;
}

/** first identifier child (variable_declarator names are unnamed in the grammar) */

function modifierFlags(node: SyntaxNode) {
  let isStatic = false, publicish = false, isAbstract = false, isSealed = false, isPartial = false;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === "modifier") {
      const t = c.text;
      if (t === "static") isStatic = true;
      if (t === "abstract") isAbstract = true;
      if (t === "sealed") isSealed = true;
      if (t === "partial") isPartial = true;
      if (t === "public" || t === "protected" || t === "internal" || t === "private protected" || t === "protected internal") publicish = true;
    }
  }
  return { isStatic, publicish, isAbstract, isSealed, isPartial };
}

function paramsOf(methodNode: SyntaxNode): { name: string; type: string }[] {
  const pl = methodNode.childForFieldName("parameters");
  const out: { name: string; type: string }[] = [];
  if (!pl) return out;
  for (let i = 0; i < pl.childCount; i++) {
    const p = pl.child(i);
    if (!p || p.type !== "parameter") continue;
    const tNode = p.childForFieldName("type");
    const nNode = p.childForFieldName("name") ?? firstIdentifier(p);
    let t = nodeText(tNode);
    // out/ref/in prefix: parameter_modifiers child
    if (!t && tNode === null) {
      for (let j = 0; j < p.childCount; j++) {
        const c = p.child(j);
        if (c && (c.type.endsWith("_type") || c.type === "identifier" || c.type === "generic_name" || c.type === "array_type" || c.type === "nullable_type")) { t = c.text; break; }
      }
    }
    out.push({ name: nodeText(nNode), type: t });
  }
  return out;
}

function containerOfName(stack: { kind: string; name: string; ns: string }[]): string {
  // nearest type in stack
  for (let i = stack.length - 1; i >= 0; i--) {
    if (["class", "struct", "interface", "enum", "delegate"].includes(stack[i].kind)) return stack[i].name;
  }
  return "";
}

export function extractFileSymbols(h: ParserHandles, path: string, text: string, tree: Tree): FileSymbols {
  const usings: string[] = [];
  const namespaces: string[] = [];
  const types: SymbolInfo[] = [];
  const members: SymbolInfo[] = [];

  const walk = (node: SyntaxNode, ns: string, stack: { kind: string; name: string; ns: string }[]) => {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c) continue;

      switch (c.type) {
        case "using_directive": {
          const q = c.childForFieldName("name");
          const u = q ? q.text : (c.text.replace(/^using\s+/, "").replace(/;$/, "").trim());
          if (u && !u.startsWith("static") && !u.includes("=")) usings.push(u);
          break;
        }
        case "namespace_declaration": {
          const nNode = c.childForFieldName("name");
          const full = ns ? `${ns}.${nodeText(nNode)}` : nodeText(nNode);
          namespaces.push(full);
          walk(c, full, stack);
          continue;
        }
        case "file_scoped_namespace_declaration": {
          // `namespace X;` — modern C# (Unity 2021+ templates emit this style).
          // Missing this made every type in such files look global (ns=""),
          // which collided identical class names across namespaces.
          const nNode = c.childForFieldName("name");
          const full = ns ? `${ns}.${nodeText(nNode)}` : nodeText(nNode);
          namespaces.push(full);
          walk(c, full, stack);
          continue;
        }
        default:
          break;
      }

      if (TYPE_NODES.has(c.type)) {
        const nameNode = c.childForFieldName("name");
        const name = nodeText(nameNode);
        const kind = c.type.replace("_declaration", "") as SymbolInfo["kind"];
        const flags = modifierFlags(c);
        const bl = c.childForFieldName("bases") ?? c.childForFieldName("base_list");
        const base = bl ? nodeText(bl).replace(/^:\s*/, "") : undefined;
        const entry: SymbolInfo = {
          name, kind: kind as SymbolKind, ns,
          container: containerOfName(stack),
          fqn: (ns ? ns + "." : "") + (stack.filter((s) => s.kind !== "namespace").map((s) => s.name).join(".") + (stack.length ? "." : "") + name),
          // position points at the NAME identifier (not the declaration node start —
          // attributes/modifiers would otherwise be inside the rename range)
          file: path, line: nameNode?.startPosition.row ?? c.startPosition.row, col: nameNode?.startPosition.column ?? c.startPosition.column,
          base: base || undefined,
          static: flags.isStatic,
          abstract: flags.isAbstract || undefined,
          sealed: flags.isSealed || undefined,
          partial: flags.isPartial || undefined,
        };
        // interfaces from base list "IFoo, IBar"
        if (base && base.includes(",")) entry.interfaces = base.split(",").map((s) => s.trim()).filter(Boolean);
        types.push(entry);
        walk(c, ns, [...stack, { kind, name, ns }]);
        continue;
      }

      if (stack.length) {
        const parentType = stack[stack.length - 1];
        if (parentType.kind !== "namespace") {
          const parentFqn = (ns ? ns + "." : "") + stack.map((s) => s.name).join(".");

          if (c.type === "method_declaration") {
            const nameNode = c.childForFieldName("name");
            const tNode = c.childForFieldName("returns") ?? c.childForFieldName("type");
            const flags = modifierFlags(c);
            members.push({
              name: nodeText(nameNode), kind: "method",
              container: parentFqn, fqn: parentFqn + "." + nodeText(nameNode),
              returnType: nodeText(tNode), params: paramsOf(c),
              static: flags.isStatic,
              file: path,
              line: nameNode?.startPosition.row ?? c.startPosition.row,
              col: nameNode?.startPosition.column ?? c.startPosition.column,
            });
          } else if (c.type === "property_declaration") {
            const nameNode = c.childForFieldName("name");
            const tNode = c.childForFieldName("type");
            const flags = modifierFlags(c);
            members.push({
              name: nodeText(nameNode), kind: "property",
              container: parentFqn, fqn: parentFqn + "." + nodeText(nameNode),
              returnType: nodeText(tNode), static: flags.isStatic,
              file: path,
              line: nameNode?.startPosition.row ?? c.startPosition.row,
              col: nameNode?.startPosition.column ?? c.startPosition.column,
            });
          } else if (c.type === "field_declaration") {
            const decl = c.childForFieldName("declaration") ?? c.children.find((x) => x?.type === "variable_declaration") ?? null;
            const tNode = decl?.childForFieldName("type");
            const flags = modifierFlags(c);
            if (decl) {
              for (let j = 0; j < decl.childCount; j++) {
                const vd = decl.child(j);
                if (!vd || vd.type !== "variable_declarator") continue;
                const nNode = vd.childForFieldName("name") ?? firstIdentifier(vd);
                const nm = nodeText(nNode);
                if (!nm) continue;
                members.push({
                  name: nm, kind: "field",
                  container: parentFqn, fqn: parentFqn + "." + nodeText(nNode),
                  returnType: nodeText(tNode), static: flags.isStatic,
                  file: path,
                  line: nNode.startPosition.row,
                  col: nNode.startPosition.column,
                });
              }
            }
          } else if (c.type === "event_declaration" || c.type === "event_field_declaration") {
            const decl = c.childForFieldName("declaration") ?? c;
            const tNode = decl?.childForFieldName("type");
            const nNode = decl?.childForFieldName("name") ?? firstIdentifier(decl ?? c);
            const nm = nodeText(nNode) || (decl ? decl.text.split(/[;\s]+/)[1] ?? "" : "");
            members.push({
              name: nm, kind: "event", container: parentFqn, fqn: parentFqn + "." + nm,
              returnType: nodeText(tNode), file: path,
              line: nNode?.startPosition.row ?? c.startPosition.row,
              col: nNode?.startPosition.column ?? c.startPosition.column,
            });
          } else if (c.type === "enum_member_declaration") {
            const nNode = c.childForFieldName("name");
            members.push({
              name: nodeText(nNode), kind: "enumMember", container: parentFqn,
              fqn: parentFqn + "." + nodeText(nNode), file: path,
              line: nNode?.startPosition.row ?? c.startPosition.row,
              col: nNode?.startPosition.column ?? c.startPosition.column,
            });
          }
        }
      }

      walk(c, ns, stack);
    }
  };

  walk(tree.rootNode, "", []);
  const typeRefs = extractIdentRefs(tree);
  return { path, usings, namespaces, types, members, typeRefs };
}

/* --------------------- identifier reference extraction (v0.6.0) ---------------------
 *
 * One pass over the tree classifying EVERY identifier into a context the
 * dependency graph and the rename engine can consume:
 *   decl    — declaration name (type / member / local / parameter)
 *   ctor    — constructor name (binds to its declaring class)
 *   attr    — attribute usage name (binds to SomeAttribute)
 *   typePos — type position: base lists, generic args, casts, new/typeof/as/is,
 *             variable/parameter/return/property types, patterns, arrays
 *   member  — right-hand side of `recv.name`
 *   bare    — plain identifier expression (locals, bare members, type starts)
 *
 * Comments / strings / preprocessor yield no identifier nodes, so the walker is
 * naturally immune to false positives in text.
 */

const TYPEISH_PARENTS = new Set([
  "generic_name", "qualified_name", "type_argument_list", "array_type",
  "nullable_type", "base_list", "cast_expression", "as_expression",
  "is_expression", "typeof_expression", "object_creation_expression",
  "variable_declaration", "default_expression", "declaration_pattern",
  "function_pointer_type", "stack_alloc_expression", "size_of_expression",
  "explicit_interface_specifier", "type_constraint",
]);

const DECL_PARENT_TYPES = new Set([
  "class_declaration", "struct_declaration", "interface_declaration",
  "enum_declaration", "record_declaration", "method_declaration",
  "property_declaration", "event_declaration", "enum_member_declaration",
  "local_function_statement",
]);

export function extractIdentRefs(tree: Tree, max: number = 8000): IdentRef[] {
  const out: IdentRef[] = [];
  const visit = (n: SyntaxNode): void => {
    if (n.type === "identifier") {
      if (out.length < max) out.push(classifyIdent(n));
      return; // identifiers have no identifier children
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) visit(c);
    }
  };
  visit(tree.rootNode);
  return out;
}

function classifyIdent(n: SyntaxNode): IdentRef {
  const p = n.parent;
  const ref: IdentRef = {
    name: n.text,
    line: n.startPosition.row,
    col: n.startPosition.column,
    length: n.endIndex - n.startIndex,
    ctx: "bare",
  };
  if (!p) return ref;

  // skip using directives + namespace names (they are namespaces, not types)
  if (p.type === "using_directive") return { ...ref, ctx: "typePos", name: "" }; // filtered by empty name
  const gp = p.parent;
  if (p.type === "qualified_name" && gp?.type === "using_directive") return { ...ref, ctx: "typePos", name: "" };
  if (p.type === "namespace_declaration" && p.childForFieldName("name")?.id === n.id) return { ...ref, ctx: "typePos", name: "" };
  if (p.type === "qualified_name" && gp?.type === "namespace_declaration" && gp.childForFieldName("name")?.id === p.id) return { ...ref, ctx: "typePos", name: "" };

  // declaration names — compare by node identity where the grammar exposes the field
  const nameField = p.childForFieldName?.("name");
  const isNameField = nameField ? nameField.id === n.id : false;
  if (isNameField && DECL_PARENT_TYPES.has(p.type)) return { ...ref, ctx: "decl" };
  if (p.type === "variable_declarator" || p.type === "variable_designation") {
    // grammar may not expose the name field — the first identifier child is the name
    const first = firstIdentifier(p);
    if (first && first.id === n.id) return { ...ref, ctx: "decl" };
  }
  if (p.type === "parameter") {
    if (isNameField) return { ...ref, ctx: "decl" };
    return { ...ref, ctx: "typePos" }; // parameter type
  }
  if (p.type === "constructor_declaration" && isNameField) return { ...ref, ctx: "ctor" };
  if (p.type === "attribute" && isNameField) return { ...ref, ctx: "attr" };
  if (p.type === "member_access_expression") {
    if (isNameField) return { ...ref, ctx: "member" };
    return { ...ref, ctx: "bare" }; // object side of the chain
  }
  if (TYPEISH_PARENTS.has(p.type)) return { ...ref, ctx: "typePos" };
  // method/property return & type fields on direct parents
  const typeField = p.childForFieldName?.("type");
  const retField = p.childForFieldName?.("returns");
  if ((typeField && typeField.id === n.id) || (retField && retField.id === n.id)) return { ...ref, ctx: "typePos" };
  return ref;
}

/* ------------------------------ diagnostics ------------------------------ */

export function extractDiagnostics(tree: Tree, max: number = 60): Diagnostic[] {
  const out: Diagnostic[] = [];
  const visit = (n: SyntaxNode) => {
    if (out.length >= max) return;
    if (n.type === "ERROR" || n.hasError || n.isMissing) {
      if (n.type === "ERROR" || n.isMissing) {
        const missingToken = n.isMissing && n.type !== "ERROR";
        out.push({
          line: n.startPosition.row,
          col: n.startPosition.column,
          length: Math.max(1, n.endIndex - n.startIndex),
          message: missingToken
            ? `Missing ${describeMissing(n.type)}`
            : n.childCount === 0 && n.text
              ? `Unexpected token '${n.text.slice(0, 30)}'`
              : "Invalid syntax",
          severity: "error",
          source: "velvetsharp.parser",
        });
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) visit(c);
      if (out.length >= max) return;
    }
  };
  visit(tree.rootNode);
  // dedupe overlapping ERROR rows
  const seen = new Set<string>();
  return out.filter((d) => {
    const k = `${d.line}:${d.col}:${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function describeMissing(type: string): string {
  const map: Record<string, string> = {
    ";": ";", "}": "}", "{": "{", ")": ")", "(": "(", "]": "]",
    ",": ",",
  };
  return map[type] ?? `'${type}'`;
}

/** quick helpers used by inference */
export { firstIdentifier };

export function findNodeAt(tree: Tree, line: number, col: number): SyntaxNode | null {
  let node = tree.rootNode;
  while (node) {
    let next: SyntaxNode | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c) continue;
      const start = c.startPosition;
      const end = c.endPosition;
      if ((line > start.row || (line === start.row && col >= start.column)) &&
          (line < end.row || (line === end.row && col < end.column))) {
        next = c;
        break;
      }
    }
    if (!next) return node;
    node = next;
  }
  return node;
}
