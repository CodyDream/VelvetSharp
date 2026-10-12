/** VelvetSharp — color themes (v0.7.0).
 *
 *  Seven full themes, each driving BOTH layers of the UI:
 *    1. the app chrome (titlebar/sidebar/tabs/problems/graph) via CSS custom
 *       properties applied inline on :root — index.css only consumes variables
 *    2. the Monaco editor via monaco.editor.defineTheme
 *
 *  The user picks a theme in a first-run modal (nothing configured yet) and can
 *  change it any time from the command palette or the status bar. */

export type ChromeVars = Record<string, string>;

export interface MonoPalette {
  base: "vs" | "vs-dark";
  bg: string; fg: string;
  lineNum: string; lineNumActive: string;
  selection: string; inactiveSel: string; lineHighlight: string;
  cursor: string; indent: string; indentActive: string;
  widgetBg: string; widgetBorder: string; suggestSel: string;
  scrollbar: string; scrollbarHover: string;
  comment: string; doc: string;
  keyword: string; control: string;
  string: string; escape: string; number: string;
  operator: string; delimiter: string;
  attribute: string; preprocessor: string;
  method: string; type: string; builtin: string;
  namespace: string;
  cls: string; struct: string; iface: string; enum: string; enumMember: string; delegate: string;
  unityMethod: string; property: string; field: string; variable: string; parameter: string;
  unityType: string; event: string;
  bracket1: string; bracket2: string; bracket3: string;
  err: string; warn: string;
}

export interface ThemeDef {
  id: string;
  label: string;
  sub: string;
  dark: boolean;
  /** swatch preview for the picker cards (accent, editor bg, string, keyword) */
  swatches: [string, string, string, string];
  chrome: ChromeVars;
  mono: MonoPalette;
}

/* helper so each theme block below stays readable */
const C = <T,>(o: T): T => o;

/* ------------------------------------------------------------------ */
/* 1. Velvet Dark — the signature look (default)                      */
/* ------------------------------------------------------------------ */
const VELVET: ThemeDef = {
  id: "velvet-dark",
  label: "Velvet Dark",
  sub: "VelvetSharp signature",
  dark: true,
  swatches: ["#b47aff", "#171220", "#a8e38a", "#ff7ad9"],
  chrome: C<ChromeVars>({
    "--bg-deepest": "#120e17",
    "--bg-panel": "#191320",
    "--bg-editor": "#171220",
    "--bg-raised": "#1f1728",
    "--bg-inset": "#14101f",
    "--bg-titlebar": "#1c1229",
    "--bg-statusbar": "#1c1229",
    "--bg-problems": "#1a1326",
    "--bg-problems-hover": "#221933",
    "--bg-dg": "#14101f",
    "--border": "#2a2138",
    "--widget-border": "#3a2d4e",
    "--widget-bg": "#1d1528",
    "--text": "#e8e0f0",
    "--muted": "#8a7f96",
    "--accent": "#b47aff",
    "--accent2": "#ff7ad9",
    "--accent-hover-text": "#d0b3ff",
    "--accent-soft": "#b47aff22",
    "--focus-ring": "#b47aff33",
    "--grad-a": "#8a4dff",
    "--grad-b": "#b47aff",
    "--ok": "#7ce38b",
    "--warn": "#ffcb6b",
    "--err": "#ff5c7a",
    "--row-sel": "#3a2a55",
    "--file-active-bg": "#2c2140",
    "--file-active-text": "#ffffff",
    "--overlay-bg": "rgba(12,8,16,.67)",
    "--hint-text": "#5a5070",
    "--faint-text": "#4a4260",
    "--chev": "#7a6d96",
    "--pr-text": "#c9c2e0",
    "--fix-bg": "#2b2140",
    "--fix-border": "#4a3a66",
    "--fix-text": "#b47aff",
    "--err-bg": "#2a1218",
    "--err-text": "#ffb3c2",
    "--warn-chip-bg": "#2a2412",
    "--warn-chip-border": "#55451a",
    "--scroll": "#3a2d4e66",
    "--scroll-hover": "#4a3a6699",
    "--dg-canvas-a": "#1a1330",
    "--dg-canvas-b": "#120e1c",
    "--dg-canvas-c": "#0e0b16",
    "--dg-edge": "#6a5f7a",
    "--dg-edge-uses": "#8a7fae",
    "--dg-node-bg": "#1d1530",
    "--dg-node-stroke": "#3a2d4e",
    "--dg-node-hover-bg": "#241a3a",
    "--dg-node-hover-stroke": "#7a5fae",
    "--dg-node-sel-bg": "#2a1d40",
    "--dg-ext-bg": "#151420",
    "--dg-ext-stroke": "#242030",
    "--glyph-class": "#7ad9ff",
    "--glyph-struct": "#4ec9b0",
    "--glyph-iface": "#b8d7a3",
    "--glyph-method": "#dcdcaa",
    "--glyph-prop": "#9cdcfe",
    "--glyph-field": "#d8d0e8",
    "--glyph-event": "#ffcb6b",
  }),
  mono: C<MonoPalette>({
    base: "vs-dark",
    bg: "#171220", fg: "#e8e0f0",
    lineNum: "#544a66", lineNumActive: "#b47aff",
    selection: "#4a2d6e88", inactiveSel: "#3a2a5566", lineHighlight: "#241b33",
    cursor: "#ff7ad9", indent: "#2a2138", indentActive: "#4a3a66",
    widgetBg: "#1d1528", widgetBorder: "#3a2d4e", suggestSel: "#3a2a55",
    scrollbar: "#3a2d4e66", scrollbarHover: "#4a3a6699",
    comment: "#6a5f7a", doc: "#7a8a5f",
    keyword: "#b47aff", control: "#ff9e64",
    string: "#a8e38a", escape: "#d0ff9e", number: "#ffcb6b",
    operator: "#ff7ad9", delimiter: "#9a8fae",
    attribute: "#ffb86c", preprocessor: "#ffb86c",
    method: "#dcdcaa", type: "#7ad9ff", builtin: "#569cd6",
    namespace: "#9a8fae",
    cls: "#7ad9ff", struct: "#4ec9b0", iface: "#b8d7a3", enum: "#b8d7a3", enumMember: "#b8d7a3", delegate: "#4ec9b0",
    unityMethod: "#ff7ad9", property: "#9cdcfe", field: "#d8d0e8", variable: "#c9c2e0", parameter: "#b9a8dc",
    unityType: "#4ec9b0", event: "#ffcb6b",
    bracket1: "#b47aff", bracket2: "#7ad9ff", bracket3: "#ffcb6b",
    err: "#ff5c7a", warn: "#ffcb6b",
  }),
};

/* ------------------------------------------------------------------ */
/* 2. Rider Dark — JetBrains style                                    */
/* ------------------------------------------------------------------ */
const RIDER: ThemeDef = {
  id: "rider-dark",
  label: "Rider Dark",
  sub: "JetBrains style",
  dark: true,
  swatches: ["#cc7832", "#1e1f22", "#6aab73", "#ffc66d"],
  chrome: C<ChromeVars>({
    "--bg-deepest": "#161618",
    "--bg-panel": "#1e1f22",
    "--bg-editor": "#1e1f22",
    "--bg-raised": "#2b2d30",
    "--bg-inset": "#191a1c",
    "--bg-titlebar": "#2b2d30",
    "--bg-statusbar": "#2b2d30",
    "--bg-problems": "#1e1f22",
    "--bg-problems-hover": "#2b2d30",
    "--bg-dg": "#1b1c1f",
    "--border": "#333537",
    "--widget-border": "#43454a",
    "--widget-bg": "#2b2d30",
    "--text": "#dfe1e5",
    "--muted": "#9da0a8",
    "--accent": "#cc7832",
    "--accent2": "#ffc66d",
    "--accent-hover-text": "#e8a05c",
    "--accent-soft": "#cc783222",
    "--focus-ring": "#cc783244",
    "--grad-a": "#b3521c", "--grad-b": "#cc7832",
    "--ok": "#5faf6f", "--warn": "#d6ae58", "--err": "#f75464",
    "--row-sel": "#2e436e",
    "--file-active-bg": "#2e436e",
    "--file-active-text": "#ffffff",
    "--overlay-bg": "rgba(10,10,12,.62)",
    "--hint-text": "#6f737b",
    "--faint-text": "#5a5d63",
    "--chev": "#868a91",
    "--pr-text": "#c8cad0",
    "--fix-bg": "#2e436e", "--fix-border": "#3d568c", "--fix-text": "#9ec1ff",
    "--err-bg": "#3a1d21", "--err-text": "#f0a3ab",
    "--warn-chip-bg": "#33291a", "--warn-chip-border": "#5c4a24",
    "--scroll": "#47484b66", "--scroll-hover": "#5a5b5e99",
    "--dg-canvas-a": "#212327", "--dg-canvas-b": "#1b1c1f", "--dg-canvas-c": "#161719",
    "--dg-edge": "#6f737b", "--dg-edge-uses": "#8a8f98",
    "--dg-node-bg": "#26282c", "--dg-node-stroke": "#43454a",
    "--dg-node-hover-bg": "#2f3a52", "--dg-node-hover-stroke": "#4f74b8",
    "--dg-node-sel-bg": "#31446e", "--dg-ext-bg": "#1f2023", "--dg-ext-stroke": "#2e3033",
    "--glyph-class": "#c77dbb", "--glyph-struct": "#4ec9b0", "--glyph-iface": "#b3b060",
    "--glyph-method": "#ffc66d", "--glyph-prop": "#9ec1ff", "--glyph-field": "#a9b7c6", "--glyph-event": "#d6ae58",
  }),
  mono: C<MonoPalette>({
    base: "vs-dark",
    bg: "#1e1f22", fg: "#bcbec4",
    lineNum: "#4b5059", lineNumActive: "#9da0a8",
    selection: "#21428388", inactiveSel: "#21428344", lineHighlight: "#26282e",
    cursor: "#dfe1e5", indent: "#313336", indentActive: "#4b5059",
    widgetBg: "#2b2d30", widgetBorder: "#43454a", suggestSel: "#2e436e",
    scrollbar: "#47484b66", scrollbarHover: "#5a5b5e99",
    comment: "#7a7e85", doc: "#629755",
    keyword: "#cf8e6d", control: "#cf8e6d",
    string: "#6aab73", escape: "#cc7832", number: "#2aacb8",
    operator: "#acada1", delimiter: "#adada9",
    attribute: "#b3ae60", preprocessor: "#b3ae60",
    method: "#56a8f5", type: "#c77dbb", builtin: "#cf8e6d",
    namespace: "#8a8f98",
    cls: "#c77dbb", struct: "#4ec9b0", iface: "#b3b060", enum: "#4ec9b0", enumMember: "#2aacb8", delegate: "#c77dbb",
    unityMethod: "#ffc66d", property: "#9ec1ff", field: "#a9b7c6", variable: "#a9b7c6", parameter: "#bcbec4",
    unityType: "#4ec9b0", event: "#d6ae58",
    bracket1: "#e8a05c", bracket2: "#8888ff", bracket3: "#6aab73",
    err: "#f75464", warn: "#d6ae58",
  }),
};

/* ------------------------------------------------------------------ */
/* 3. Unity Slate — matches the Unity Editor grey                     */
/* ------------------------------------------------------------------ */
const UNITY: ThemeDef = {
  id: "unity-slate",
  label: "Unity Slate",
  sub: "Unity Editor grey",
  dark: true,
  swatches: ["#68b0d8", "#2b2b2b", "#c8a06a", "#6fa8dc"],
  chrome: C<ChromeVars>({
    "--bg-deepest": "#252525",
    "--bg-panel": "#383838",
    "--bg-editor": "#2b2b2b",
    "--bg-raised": "#414141",
    "--bg-inset": "#333333",
    "--bg-titlebar": "#3c3c3c",
    "--bg-statusbar": "#3c3c3c",
    "--bg-problems": "#333333",
    "--bg-problems-hover": "#3d3d3d",
    "--bg-dg": "#303030",
    "--border": "#4c4c4c",
    "--widget-border": "#5a5a5a",
    "--widget-bg": "#383838",
    "--text": "#d2d2d2",
    "--muted": "#9a9a9a",
    "--accent": "#68b0d8",
    "--accent2": "#8ecbf0",
    "--accent-hover-text": "#a5d6f2",
    "--accent-soft": "#68b0d822",
    "--focus-ring": "#68b0d844",
    "--grad-a": "#3d7ea6", "--grad-b": "#68b0d8",
    "--ok": "#7ab87a", "--warn": "#d8b45a", "--err": "#e07070",
    "--row-sel": "#2c5d87",
    "--file-active-bg": "#2c5d87",
    "--file-active-text": "#ffffff",
    "--overlay-bg": "rgba(20,20,20,.62)",
    "--hint-text": "#7d7d7d",
    "--faint-text": "#6a6a6a",
    "--chev": "#8f8f8f",
    "--pr-text": "#c4c4c4",
    "--fix-bg": "#2c5d87", "--fix-border": "#3d76a8", "--fix-text": "#9ed0f0",
    "--err-bg": "#3d2525", "--err-text": "#eba0a0",
    "--warn-chip-bg": "#3a3222", "--warn-chip-border": "#5c5030",
    "--scroll": "#5a5a5a66", "--scroll-hover": "#6e6e6e99",
    "--dg-canvas-a": "#343434", "--dg-canvas-b": "#2d2d2d", "--dg-canvas-c": "#272727",
    "--dg-edge": "#7d7d7d", "--dg-edge-uses": "#8f8f8f",
    "--dg-node-bg": "#3d3d3d", "--dg-node-stroke": "#5a5a5a",
    "--dg-node-hover-bg": "#45505a", "--dg-node-hover-stroke": "#68b0d8",
    "--dg-node-sel-bg": "#2c5d87", "--dg-ext-bg": "#353535", "--dg-ext-stroke": "#484848",
    "--glyph-class": "#6fa8dc", "--glyph-struct": "#5fb8a0", "--glyph-iface": "#b8c88a",
    "--glyph-method": "#c8a06a", "--glyph-prop": "#8ecbf0", "--glyph-field": "#c0c0c0", "--glyph-event": "#d8b45a",
  }),
  mono: C<MonoPalette>({
    base: "vs-dark",
    bg: "#2b2b2b", fg: "#d2d2d2",
    lineNum: "#6a6a6a", lineNumActive: "#c0c0c0",
    selection: "#2c5d8788", inactiveSel: "#2c5d8744", lineHighlight: "#333333",
    cursor: "#d2d2d2", indent: "#3f3f3f", indentActive: "#5c5c5c",
    widgetBg: "#383838", widgetBorder: "#5a5a5a", suggestSel: "#2c5d87",
    scrollbar: "#5a5a5a66", scrollbarHover: "#6e6e6e99",
    comment: "#8a8a8a", doc: "#7ba87b",
    keyword: "#6fa8dc", control: "#c8a06a",
    string: "#a8c88a", escape: "#c8a06a", number: "#d8b45a",
    operator: "#b0b0b0", delimiter: "#9a9a9a",
    attribute: "#c8a06a", preprocessor: "#c8a06a",
    method: "#e0c090", type: "#8ecbf0", builtin: "#6fa8dc",
    namespace: "#9a9a9a",
    cls: "#8ecbf0", struct: "#5fb8a0", iface: "#b8c88a", enum: "#b8c88a", enumMember: "#d8b45a", delegate: "#5fb8a0",
    unityMethod: "#e8a06a", property: "#a5d6f2", field: "#c0c0c0", variable: "#c4c4c4", parameter: "#b0b8c0",
    unityType: "#5fb8a0", event: "#d8b45a",
    bracket1: "#68b0d8", bracket2: "#c8a06a", bracket3: "#a8c88a",
    err: "#e07070", warn: "#d8b45a",
  }),
};

/* ------------------------------------------------------------------ */
/* 4. Catppuccin Mocha — soft modern pastel                           */
/* ------------------------------------------------------------------ */
const CATPPUCCIN: ThemeDef = {
  id: "catppuccin-mocha",
  label: "Catppuccin Mocha",
  sub: "Soft modern pastel",
  dark: true,
  swatches: ["#cba6f7", "#1e1e2e", "#a6e3a1", "#f5c2e7"],
  chrome: C<ChromeVars>({
    "--bg-deepest": "#11111b",
    "--bg-panel": "#181825",
    "--bg-editor": "#1e1e2e",
    "--bg-raised": "#262637",
    "--bg-inset": "#191927",
    "--bg-titlebar": "#181825",
    "--bg-statusbar": "#181825",
    "--bg-problems": "#181825",
    "--bg-problems-hover": "#232334",
    "--bg-dg": "#17171f",
    "--border": "#313244",
    "--widget-border": "#45475a",
    "--widget-bg": "#1e1e2e",
    "--text": "#cdd6f4",
    "--muted": "#9399b2",
    "--accent": "#cba6f7",
    "--accent2": "#f5c2e7",
    "--accent-hover-text": "#dcc2fb",
    "--accent-soft": "#cba6f722",
    "--focus-ring": "#cba6f733",
    "--grad-a": "#9b6bd8", "--grad-b": "#cba6f7",
    "--ok": "#a6e3a1", "--warn": "#f9e2af", "--err": "#f38ba8",
    "--row-sel": "#3c3a52",
    "--file-active-bg": "#414559",
    "--file-active-text": "#ffffff",
    "--overlay-bg": "rgba(17,17,27,.66)",
    "--hint-text": "#6c7086",
    "--faint-text": "#585b70",
    "--chev": "#7f849c",
    "--pr-text": "#bac2de",
    "--fix-bg": "#3c3a52", "--fix-border": "#50496e", "--fix-text": "#dcc2fb",
    "--err-bg": "#3b2530", "--err-text": "#f2a5bd",
    "--warn-chip-bg": "#39331e", "--warn-chip-border": "#63582c",
    "--scroll": "#45475a66", "--scroll-hover": "#585b7099",
    "--dg-canvas-a": "#21222f", "--dg-canvas-b": "#191927", "--dg-canvas-c": "#14141f",
    "--dg-edge": "#6c7086", "--dg-edge-uses": "#8d93a8",
    "--dg-node-bg": "#24243a", "--dg-node-stroke": "#45475a",
    "--dg-node-hover-bg": "#31304a", "--dg-node-hover-stroke": "#89b4fa",
    "--dg-node-sel-bg": "#414559", "--dg-ext-bg": "#1c1c2a", "--dg-ext-stroke": "#2c2c3e",
    "--glyph-class": "#89b4fa", "--glyph-struct": "#94e2d5", "--glyph-iface": "#a6e3a1",
    "--glyph-method": "#f9e2af", "--glyph-prop": "#89dceb", "--glyph-field": "#cdd6f4", "--glyph-event": "#fab387",
  }),
  mono: C<MonoPalette>({
    base: "vs-dark",
    bg: "#1e1e2e", fg: "#cdd6f4",
    lineNum: "#585b70", lineNumActive: "#cba6f7",
    selection: "#4c4f6988", inactiveSel: "#41455955", lineHighlight: "#262639",
    cursor: "#f5e0dc", indent: "#313244", indentActive: "#4c4f69",
    widgetBg: "#1e1e2e", widgetBorder: "#45475a", suggestSel: "#414559",
    scrollbar: "#45475a66", scrollbarHover: "#585b7099",
    comment: "#6c7086", doc: "#8ec07c",
    keyword: "#cba6f7", control: "#f5c2e7",
    string: "#a6e3a1", escape: "#f5c2e7", number: "#fab387",
    operator: "#94e2d5", delimiter: "#9399b2",
    attribute: "#f9e2af", preprocessor: "#f9e2af",
    method: "#89b4fa", type: "#f9e2af", builtin: "#89dceb",
    namespace: "#9399b2",
    cls: "#89b4fa", struct: "#94e2d5", iface: "#a6e3a1", enum: "#a6e3a1", enumMember: "#fab387", delegate: "#94e2d5",
    unityMethod: "#f5c2e7", property: "#89dceb", field: "#cdd6f4", variable: "#cdd6f4", parameter: "#b4befe",
    unityType: "#94e2d5", event: "#fab387",
    bracket1: "#cba6f7", bracket2: "#89b4fa", bracket3: "#f9e2af",
    err: "#f38ba8", warn: "#f9e2af",
  }),
};

/* ------------------------------------------------------------------ */
/* 5. Tokyo Night — midnight blue / neon                              */
/* ------------------------------------------------------------------ */
const TOKYO: ThemeDef = {
  id: "tokyo-night",
  label: "Tokyo Night",
  sub: "Midnight blue / neon",
  dark: true,
  swatches: ["#7aa2f7", "#1a1b26", "#9ece6a", "#bb9af7"],
  chrome: C<ChromeVars>({
    "--bg-deepest": "#13131a",
    "--bg-panel": "#16161e",
    "--bg-editor": "#1a1b26",
    "--bg-raised": "#1f2233",
    "--bg-inset": "#16161e",
    "--bg-titlebar": "#16161e",
    "--bg-statusbar": "#16161e",
    "--bg-problems": "#16161e",
    "--bg-problems-hover": "#1f2233",
    "--bg-dg": "#14151d",
    "--border": "#24283b",
    "--widget-border": "#2f334d",
    "--widget-bg": "#1f2233",
    "--text": "#c0caf5",
    "--muted": "#7982a9",
    "--accent": "#7aa2f7",
    "--accent2": "#bb9af7",
    "--accent-hover-text": "#a8c0ff",
    "--accent-soft": "#7aa2f722",
    "--focus-ring": "#7aa2f733",
    "--grad-a": "#4a6df0", "--grad-b": "#7aa2f7",
    "--ok": "#9ece6a", "--warn": "#e0af68", "--err": "#f7768e",
    "--row-sel": "#2c3352",
    "--file-active-bg": "#2c3352",
    "--file-active-text": "#ffffff",
    "--overlay-bg": "rgba(13,13,20,.68)",
    "--hint-text": "#565f89",
    "--faint-text": "#495073",
    "--chev": "#6a7099",
    "--pr-text": "#a9b1d6",
    "--fix-bg": "#2c3352", "--fix-border": "#3d4670", "--fix-text": "#a8c0ff",
    "--err-bg": "#3a2330", "--err-text": "#f0a0b0",
    "--warn-chip-bg": "#332d1e", "--warn-chip-border": "#5c5030",
    "--scroll": "#2f334d66", "--scroll-hover": "#41486899",
    "--dg-canvas-a": "#1c1f30", "--dg-canvas-b": "#15161f", "--dg-canvas-c": "#101118",
    "--dg-edge": "#565f89", "--dg-edge-uses": "#6a7099",
    "--dg-node-bg": "#1f2233", "--dg-node-stroke": "#2f334d",
    "--dg-node-hover-bg": "#252a45", "--dg-node-hover-stroke": "#7aa2f7",
    "--dg-node-sel-bg": "#2c3352", "--dg-ext-bg": "#191b28", "--dg-ext-stroke": "#24273a",
    "--glyph-class": "#2ac3de", "--glyph-struct": "#73daca", "--glyph-iface": "#9ece6a",
    "--glyph-method": "#7aa2f7", "--glyph-prop": "#73daca", "--glyph-field": "#c0caf5", "--glyph-event": "#e0af68",
  }),
  mono: C<MonoPalette>({
    base: "vs-dark",
    bg: "#1a1b26", fg: "#c0caf5",
    lineNum: "#3b4261", lineNumActive: "#7aa2f7",
    selection: "#33467c88", inactiveSel: "#292e4244", lineHighlight: "#212234",
    cursor: "#c0caf5", indent: "#24283b", indentActive: "#3b4261",
    widgetBg: "#1f2233", widgetBorder: "#2f334d", suggestSel: "#2c3352",
    scrollbar: "#2f334d66", scrollbarHover: "#41486899",
    comment: "#565f89", doc: "#7aa889",
    keyword: "#bb9af7", control: "#9d7cd8",
    string: "#9ece6a", escape: "#bb9af7", number: "#ff9e64",
    operator: "#89ddff", delimiter: "#89ddff",
    attribute: "#e0af68", preprocessor: "#e0af68",
    method: "#7aa2f7", type: "#2ac3de", builtin: "#0db9d7",
    namespace: "#7982a9",
    cls: "#2ac3de", struct: "#73daca", iface: "#9ece6a", enum: "#9ece6a", enumMember: "#ff9e64", delegate: "#73daca",
    unityMethod: "#ff007c", property: "#73daca", field: "#c0caf5", variable: "#c0caf5", parameter: "#a9b1d6",
    unityType: "#73daca", event: "#e0af68",
    bracket1: "#7aa2f7", bracket2: "#bb9af7", bracket3: "#e0af68",
    err: "#f7768e", warn: "#e0af68",
  }),
};

/* ------------------------------------------------------------------ */
/* 6. Gruvbox Dark — warm earthy retro                                */
/* ------------------------------------------------------------------ */
const GRUVBOX: ThemeDef = {
  id: "gruvbox-dark",
  label: "Gruvbox Dark",
  sub: "Warm earthy retro",
  dark: true,
  swatches: ["#fe8019", "#282828", "#b8bb26", "#fabd2f"],
  chrome: C<ChromeVars>({
    "--bg-deepest": "#1d2021",
    "--bg-panel": "#282828",
    "--bg-editor": "#282828",
    "--bg-raised": "#32302f",
    "--bg-inset": "#222222",
    "--bg-titlebar": "#32302f",
    "--bg-statusbar": "#32302f",
    "--bg-problems": "#282828",
    "--bg-problems-hover": "#3c3836",
    "--bg-dg": "#242424",
    "--border": "#3c3836",
    "--widget-border": "#504945",
    "--widget-bg": "#32302f",
    "--text": "#ebdbb2",
    "--muted": "#a89984",
    "--accent": "#fe8019",
    "--accent2": "#fabd2f",
    "--accent-hover-text": "#ff9d4d",
    "--accent-soft": "#fe801922",
    "--focus-ring": "#fe801933",
    "--grad-a": "#d65d0e", "--grad-b": "#fe8019",
    "--ok": "#b8bb26", "--warn": "#fabd2f", "--err": "#fb4934",
    "--row-sel": "#504945",
    "--file-active-bg": "#504945",
    "--file-active-text": "#fbf1c7",
    "--overlay-bg": "rgba(20,18,16,.66)",
    "--hint-text": "#7c6f64",
    "--faint-text": "#665c54",
    "--chev": "#928374",
    "--pr-text": "#d5c4a1",
    "--fix-bg": "#504945", "--fix-border": "#665c54", "--fix-text": "#ffd5a0",
    "--err-bg": "#3d2b26", "--err-text": "#f0a8a0",
    "--warn-chip-bg": "#3a3424", "--warn-chip-border": "#5c5430",
    "--scroll": "#50494566", "--scroll-hover": "#665c5499",
    "--dg-canvas-a": "#2e2c2a", "--dg-canvas-b": "#262626", "--dg-canvas-c": "#201f1e",
    "--dg-edge": "#7c6f64", "--dg-edge-uses": "#928374",
    "--dg-node-bg": "#32302f", "--dg-node-stroke": "#504945",
    "--dg-node-hover-bg": "#3d3a36", "--dg-node-hover-stroke": "#fe8019",
    "--dg-node-sel-bg": "#504945", "--dg-ext-bg": "#2a2828", "--dg-ext-stroke": "#3c3836",
    "--glyph-class": "#83a598", "--glyph-struct": "#8ec07c", "--glyph-iface": "#b8bb26",
    "--glyph-method": "#fabd2f", "--glyph-prop": "#83a598", "--glyph-field": "#ebdbb2", "--glyph-event": "#d3869b",
  }),
  mono: C<MonoPalette>({
    base: "vs-dark",
    bg: "#282828", fg: "#ebdbb2",
    lineNum: "#665c54", lineNumActive: "#fabd2f",
    selection: "#50494588", inactiveSel: "#3c383666", lineHighlight: "#32302f",
    cursor: "#ebdbb2", indent: "#3c3836", indentActive: "#504945",
    widgetBg: "#32302f", widgetBorder: "#504945", suggestSel: "#504945",
    scrollbar: "#50494566", scrollbarHover: "#665c5499",
    comment: "#928374", doc: "#8ec07c",
    keyword: "#fb4934", control: "#fe8019",
    string: "#b8bb26", escape: "#fabd2f", number: "#d3869b",
    operator: "#8ec07c", delimiter: "#a89984",
    attribute: "#fabd2f", preprocessor: "#fabd2f",
    method: "#fabd2f", type: "#83a598", builtin: "#83a598",
    namespace: "#a89984",
    cls: "#83a598", struct: "#8ec07c", iface: "#b8bb26", enum: "#b8bb26", enumMember: "#d3869b", delegate: "#8ec07c",
    unityMethod: "#d3869b", property: "#83a598", field: "#ebdbb2", variable: "#ebdbb2", parameter: "#d5c4a1",
    unityType: "#8ec07c", event: "#d3869b",
    bracket1: "#fe8019", bracket2: "#fabd2f", bracket3: "#b8bb26",
    err: "#fb4934", warn: "#fabd2f",
  }),
};

/* ------------------------------------------------------------------ */
/* 7. Clean Light — high-contrast light mode                          */
/* ------------------------------------------------------------------ */
const CLEAN: ThemeDef = {
  id: "clean-light",
  label: "Clean Light",
  sub: "High-contrast light",
  dark: false,
  swatches: ["#005fb8", "#ffffff", "#a31515", "#0f8a5f"],
  chrome: C<ChromeVars>({
    "--bg-deepest": "#e8e8ea",
    "--bg-panel": "#f5f5f6",
    "--bg-editor": "#ffffff",
    "--bg-raised": "#ececee",
    "--bg-inset": "#f0f0f2",
    "--bg-titlebar": "#f0f0f2",
    "--bg-statusbar": "#f0f0f2",
    "--bg-problems": "#f7f7f8",
    "--bg-problems-hover": "#ececee",
    "--bg-dg": "#f4f4f6",
    "--border": "#dcdce0",
    "--widget-border": "#c8c8ce",
    "--widget-bg": "#ffffff",
    "--text": "#1f1f23",
    "--muted": "#616168",
    "--accent": "#005fb8",
    "--accent2": "#b3227a",
    "--accent-hover-text": "#0a7ae0",
    "--accent-soft": "#005fb818",
    "--focus-ring": "#005fb833",
    "--grad-a": "#0a6ec9", "--grad-b": "#1a84dc",
    "--ok": "#0f8a3a", "--warn": "#b27d0a", "--err": "#d13438",
    "--row-sel": "#d6e5f8",
    "--file-active-bg": "#cfe3f8",
    "--file-active-text": "#12283f",
    "--overlay-bg": "rgba(30,30,36,.35)",
    "--hint-text": "#8a8a92",
    "--faint-text": "#a0a0a8",
    "--chev": "#8a8a92",
    "--pr-text": "#333338",
    "--fix-bg": "#d6e5f8", "--fix-border": "#9cc3ee", "--fix-text": "#005fb8",
    "--err-bg": "#fbe9eb", "--err-text": "#a5262c",
    "--warn-chip-bg": "#f8f0dc", "--warn-chip-border": "#e0cd94",
    "--scroll": "#b4b4bc77", "--scroll-hover": "#98989f99",
    "--dg-canvas-a": "#fafafc", "--dg-canvas-b": "#f2f2f5", "--dg-canvas-c": "#eaeaee",
    "--dg-edge": "#a8a8b0", "--dg-edge-uses": "#8a8a94",
    "--dg-node-bg": "#ffffff", "--dg-node-stroke": "#c8c8ce",
    "--dg-node-hover-bg": "#eef4fc", "--dg-node-hover-stroke": "#005fb8",
    "--dg-node-sel-bg": "#d6e5f8", "--dg-ext-bg": "#f0f0f2", "--dg-ext-stroke": "#d4d4da",
    "--glyph-class": "#0f7ab8", "--glyph-struct": "#0f8a7a", "--glyph-iface": "#5c7a10",
    "--glyph-method": "#8a6d10", "--glyph-prop": "#0568a8", "--glyph-field": "#3a3a40", "--glyph-event": "#a05a10",
  }),
  mono: C<MonoPalette>({
    base: "vs",
    bg: "#ffffff", fg: "#1f1f23",
    lineNum: "#a0a0a8", lineNumActive: "#005fb8",
    selection: "#add6ff", inactiveSel: "#add6ff66", lineHighlight: "#f0f2f7",
    cursor: "#1f1f23", indent: "#e4e4e8", indentActive: "#c8c8ce",
    widgetBg: "#f5f5f6", widgetBorder: "#c8c8ce", suggestSel: "#d6e5f8",
    scrollbar: "#b4b4bc77", scrollbarHover: "#98989f99",
    comment: "#3a7a3a", doc: "#4a7a4a",
    keyword: "#0000cf", control: "#af00db",
    string: "#a31515", escape: "#a31515", number: "#098658",
    operator: "#333338", delimiter: "#55555c",
    attribute: "#8a5a10", preprocessor: "#8a5a10",
    method: "#795e26", type: "#267f99", builtin: "#0000cf",
    namespace: "#616168",
    cls: "#267f99", struct: "#0f8a7a", iface: "#5c7a10", enum: "#5c7a10", enumMember: "#098658", delegate: "#267f99",
    unityMethod: "#b3227a", property: "#0568a8", field: "#1f1f23", variable: "#1f1f23", parameter: "#44444a",
    unityType: "#0f8a7a", event: "#a05a10",
    bracket1: "#005fb8", bracket2: "#af00db", bracket3: "#098658",
    err: "#d13438", warn: "#b27d0a",
  }),
};

export const THEMES: ThemeDef[] = [VELVET, RIDER, UNITY, CATPPUCCIN, TOKYO, GRUVBOX, CLEAN];

const THEME_KEY = "velvetsharp.theme";
export const DEFAULT_THEME = VELVET.id;

export function getSavedThemeId(): string | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v && THEMES.some((t) => t.id === v) ? v : null;
  } catch { return null; }
}

export function themeById(id: string): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? VELVET;
}

/** Monaco theme definition from a palette (rules cover the custom C# grammar
 *  token names + semantic token names the brain emits). */
function monacoRules(p: MonoPalette): { token: string; foreground?: string; fontStyle?: string }[] {
  return [
    { token: "", foreground: p.fg.slice(1), background: p.bg.slice(1) },
    { token: "comment", foreground: p.comment.slice(1), fontStyle: "italic" },
    { token: "comment.doc", foreground: p.doc.slice(1), fontStyle: "italic" },
    { token: "keyword", foreground: p.keyword.slice(1) },
    { token: "keyword.control", foreground: p.control.slice(1) },
    { token: "string", foreground: p.string.slice(1) },
    { token: "string.escape", foreground: p.escape.slice(1) },
    { token: "string.char", foreground: p.string.slice(1) },
    { token: "string.inter", foreground: p.property.slice(1) },
    { token: "number", foreground: p.number.slice(1) },
    { token: "number.float", foreground: p.number.slice(1) },
    { token: "number.hex", foreground: p.number.slice(1) },
    { token: "number.bin", foreground: p.number.slice(1) },
    { token: "identifier", foreground: p.fg.slice(1) },
    { token: "delimiter", foreground: p.delimiter.slice(1) },
    { token: "operator", foreground: p.operator.slice(1) },
    { token: "attribute", foreground: p.attribute.slice(1) },
    { token: "preprocessor", foreground: p.preprocessor.slice(1) },
    { token: "method", foreground: p.method.slice(1) },
    { token: "type", foreground: p.type.slice(1) },
    { token: "type.builtin", foreground: p.builtin.slice(1) },
    { token: "namespace", foreground: p.namespace.slice(1) },
    { token: "class", foreground: p.cls.slice(1) },
    { token: "struct", foreground: p.struct.slice(1) },
    { token: "interface", foreground: p.iface.slice(1) },
    { token: "enum", foreground: p.enum.slice(1) },
    { token: "enumMember", foreground: p.enumMember.slice(1) },
    { token: "delegate", foreground: p.delegate.slice(1) },
    { token: "unityMethod", foreground: p.unityMethod.slice(1), fontStyle: "bold" },
    { token: "property", foreground: p.property.slice(1) },
    { token: "field", foreground: p.field.slice(1) },
    { token: "variable", foreground: p.variable.slice(1) },
    { token: "parameter", foreground: p.parameter.slice(1) },
    { token: "unityType", foreground: p.unityType.slice(1) },
    { token: "builtin", foreground: p.builtin.slice(1) },
    { token: "event", foreground: p.event.slice(1) },
  ];
}

function monacoColors(p: MonoPalette): Record<string, string> {
  return {
    "editor.background": p.bg,
    "editor.foreground": p.fg,
    "editorLineNumber.foreground": p.lineNum,
    "editorLineNumber.activeForeground": p.lineNumActive,
    "editor.selectionBackground": p.selection,
    "editor.inactiveSelectionBackground": p.inactiveSel,
    "editor.lineHighlightBackground": p.lineHighlight,
    "editorCursor.foreground": p.cursor,
    "editorIndentGuide.background1": p.indent,
    "editorIndentGuide.activeBackground1": p.indentActive,
    "editorWidget.background": p.widgetBg,
    "editorWidget.border": p.widgetBorder,
    "editorSuggestWidget.background": p.widgetBg,
    "editorSuggestWidget.selectedBackground": p.suggestSel,
    "editorSuggestWidget.border": p.widgetBorder,
    "editorHoverWidget.background": p.widgetBg,
    "editorHoverWidget.border": p.widgetBorder,
    "scrollbarSlider.background": p.scrollbar,
    "scrollbarSlider.hoverBackground": p.scrollbarHover,
    "editorBracketHighlight.foreground1": p.bracket1,
    "editorBracketHighlight.foreground2": p.bracket2,
    "editorBracketHighlight.foreground3": p.bracket3,
    "editorError.foreground": p.err,
    "editorWarning.foreground": p.warn,
  };
}

/** define all themes once at boot (cheap — Monaco stores them) */
export function defineAllThemes(monaco: any): void {
  for (const t of THEMES) {
    monaco.editor.defineTheme(t.id, {
      base: t.mono.base,
      inherit: true,
      rules: monacoRules(t.mono),
      colors: monacoColors(t.mono),
    });
  }
}

/** apply a theme: chrome CSS variables + Monaco theme (no persistence — call saveTheme) */
export function applyTheme(monaco: any, id: string): void {
  const t = themeById(id);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.chrome)) root.style.setProperty(k, v);
  root.dataset.theme = t.id;
  if (monaco) {
    try { monaco.editor.setTheme(t.id); } catch { /* editor not created yet */ }
  }
}

export function saveTheme(id: string): void {
  try { localStorage.setItem(THEME_KEY, id); } catch { /* storage off */ }
  // v0.7.1: durable copy in %APPDATA%/VelvetSharp/config.json — the picker must
  // never reappear just because WebView2's profile was ephemeral
  import("./configStore").then((m) => m.saveSetting(THEME_KEY, id)).catch(() => { /* best effort */ });
}
