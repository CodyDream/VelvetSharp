/** VelvetSharp — full C# Monarch tokenizer (replaces Monaco's stripped builtin grammar).
 *  Colors: keywords, control-flow, builtin types, strings (normal/verbatim/interpolated/char),
 *  numbers (dec/hex/bin/float), comments (line/block/xml-doc), attributes, preprocessor,
 *  PascalCase types + method-call heuristics. The semantic token provider refines identifiers
 *  with real project/Unity resolution on top of this. */

export const CSHARP_LANG = "velvet-csharp";

const CONTROL = new Set([
  "if", "else", "for", "foreach", "while", "do", "switch", "case", "default",
  "break", "continue", "return", "goto", "try", "catch", "finally", "throw",
  "yield", "await", "when", "lock", "checked", "unchecked", "fixed",
]);

const BUILTIN = new Set([
  "bool", "byte", "char", "decimal", "double", "dynamic", "float", "int", "long",
  "object", "sbyte", "short", "string", "uint", "ulong", "ushort", "void", "var",
]);

const KEYWORDS = [
  "abstract", "as", "async", "base", "class", "const", "delegate", "event", "explicit",
  "extern", "false", "get", "global", "implicit", "in", "init", "interface", "internal",
  "is", "namespace", "new", "null", "not", "operator", "out", "override", "params",
  "partial", "private", "protected", "public", "readonly", "record", "ref", "required",
  "sealed", "set", "sizeof", "stackalloc", "static", "struct", "this", "true", "typeof",
  "unsafe", "using", "virtual", "volatile", "add", "remove", "alias", "file", "scoped",
  "nameof", "typeof", "assembly", "field", "method", "param", "property", "type",
];

const toArr = (s: Set<string>) => [...s];

export const CS_MONARCH = {
  // treat @keywords* as named token classes via "cases"
  controlKeywords: toArr(CONTROL),
  builtinTypes: toArr(BUILTIN),
  keywords: [...new Set(KEYWORDS)].filter((k) => !CONTROL.has(k) && !BUILTIN.has(k)),

  tokenizer: {
    root: [
      // preprocessor directives — the WHOLE line takes the directive color
      // (Phase 11: previously only `#if` was tinted and the symbol looked like
      // a type; VS tints the entire directive line)
      [/^\s*#\s*\w+.*$/, "preprocessor"],

      // comments
      [/\/\/\/.*$/, "comment.doc"],
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],

      // strings: $"..." / @$"..." / $@"..." (interpolated), @"..." (verbatim), "..." (normal)
      [/\$@?"/, { token: "string", bracket: "@open", next: "@istring" }],
      [/@"\$/, { token: "string", bracket: "@open", next: "@istring" }],
      [/@"/, { token: "string", bracket: "@open", next: "@verbatim" }],
      [/\$"/, { token: "string", bracket: "@open", next: "@istring" }],
      [/"/, { token: "string", bracket: "@open", next: "@string" }],
      [/'(?:[^'\\]|\\.)*'/, "string.char"],
      [/@[a-zA-Z_]\w*/, "identifier"], // verbatim identifiers (@class, @event)

      // numbers
      [/\d[\d_]*\.\d[\d_]*(?:[eE][-+]?\d+)?[fFmMdD]?/, "number.float"],
      [/\.\d[\d_]*(?:[eE][-+]?\d+)?[fFmMdD]?/, "number.float"],
      [/\d[\d_]*[eE][-+]?\d+[fFmMdD]?/, "number.float"],
      [/0[xX][\da-fA-F][\da-fA-F_]*[uUlL]*/, "number.hex"],
      [/0[bB][01][01_]*[uUlL]*/, "number.bin"],
      [/\d[\d_]*[uUlLfFmMdD]*/, "number"],

      // PascalCase immediately followed by "(" → method call heuristic
      [/[A-Z]\w*(?=\s*\()/, "method"],
      // PascalCase → likely a type/class/struct/interface
      [/[A-Z]\w*/, "type"],

      // identifiers (lowercase start)
      [/[a-z_]\w*/, {
        cases: {
          "@controlKeywords": "keyword.control",
          "@builtinTypes": "type.builtin",
          "@keywords": "keyword",
          "@default": "identifier",
        },
      }],

      // attributes — color the bracket-adjacent name (PascalCase already caught above;
      // this catches lowercase attribute names like [serializefield] edge cases)
      [/\[/, "@brackets"],

      // brackets & delimiters
      [/[{}()\[\]]/, "@brackets"],
      [/[;,]/, "delimiter"],
      [/[<>\-+=*/%!&|^~?:.]+/, "operator"],

      // whitespace / anything else
      [/./, "identifier"],
    ],

    comment: [
      [/[^/*]+/, "comment"],
      [/\/\*/, "comment", "@push"],
      [/\*\//, "comment", "@pop"],
      [/[/*]/, "comment"],
    ],

    string: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, { token: "string", bracket: "@close", next: "@pop" }],
    ],

    verbatim: [
      [/[^"]+/, "string"],
      [/""/, "string.escape"],
      [/"/, { token: "string", bracket: "@close", next: "@pop" }],
    ],

    istring: [
      [/"/, { token: "string", bracket: "@close", next: "@pop" }],
      // complete simple hole {expr} or {expr:format} in one match
      [/\{[^{}"']*\}/, "string.inter"],
      // opening of a hole containing quotes/nesting — color the brace, keep scanning string
      [/\{/, "string.inter"],
      [/\}/, "string.inter"],
      [/\\./, "string.escape"],
      [/[^"{}\\]+/, "string"],
    ],
  },
};

export const CS_LANGUAGE_CONFIG = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] as [string, string] },
  brackets: [["{", "}"], ["[", "]"], ["(", ")"]] as [string, string][],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "'", close: "'", notIn: ["string", "comment"] },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "/*", close: " */", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "'", close: "'" },
    { open: '"', close: '"' },
  ],
  folding: {
    markers: {
      start: /^\s*#region\b/,
      end: /^\s*#endregion\b/,
    },
  },
  wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
  indentationRules: {
    increaseIndentPattern: /^.*\{[^}"']*$/,
    decreaseIndentPattern: /^(.*\*\/)?\s*\}.*$/,
  },
  onEnterRules: [
    {
      // after /// push another ///
      beforeText: /^\s*\/\/\/.*$/,
      action: { indentAction: "none" as const, appendText: "/// " },
    },
  ],
};
