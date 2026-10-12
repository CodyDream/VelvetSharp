# ◆ VelvetSharp

**A lightweight, fast-opening Unity C# IDE — an alternative to Rider, Visual Studio and VS Code.**

> **Current version: Phase 8** (build 8.0.0) — see `VERSIONS.md`. The version
> system is phase-based: every delivered update bumps the phase by one and
> numbers are never reused. The phase is always visible in the status bar.

Zero .NET runtime. Zero OmniSharp. The entire C# intelligence engine is custom-built
in TypeScript, runs off the UI thread in a Web Worker, on tree-sitter (WASM) + a
Unity API database extracted directly from `UnityEngine.dll` by our own ECMA-335
metadata reader.

```
┌─────────────────────────────────────────────────────────────────┐
│  ◆ VelvetSharp — lightweight Unity C# IDE                       │
├───────────┬─────────────────────────────────────────────────────┤
│ Explorer  │  tabs · Monaco editor · velvet theme                │
│ Search    │  IntelliSense backed by @velvetsharp/brain          │
│ Outline   │    • member completions w/ type inference           │
|           |    • Unity event functions (Awake/Start/Update…)    |
│ Ctrl+P    │    • semantic colors: types/methods/fields/msgs     │
│ Ctrl+T    │    • Unity hover docs (from UnityEngine.xml)        │
│ Ctrl+⇧+P  │    • signature help · go-to-definition              │
│ Ctrl+⇧+F  │    • fast syntax squiggles (worker, ~90ms)          │
|           |    • csproj auto-detect → assemblies + defines      |
├───────────┴─────────────────────────────────────────────────────┤
│ ● brain online · 7 files · 8 types · 55 members · 2ms           │
│ ● Unity API: UnityEngine v4.0.30319 · 3,288 types               │
│ ⚙ 3 assemblies · +145 defines (from your .csproj files)         │
└─────────────────────────────────────────────────────────────────┘
```

## What's new in v0.3.0 — prebuilt Windows exe

- **Ready-made Windows build, no toolchain needed** — `VelvetSharp.exe` ships as a
  portable folder (`VelvetSharp.exe` + `resources.neu`, ~5.9 MB zipped) and as an
  NSIS setup wizard (`VelvetSharp-0.3.0-win-x64-setup.exe`, per-user install, no
  admin rights, Start-Menu + Desktop shortcuts, uninstaller).
- The packaged shell is **Neutralino 6 (WebView2)** — the same rendering engine the
  Tauri build uses — so the app behaves identically; the 2.5 MB exe carries the
  VelvetSharp icon and version metadata.
- **First-run workspace picker** — launch from any shortcut and pick your Unity
  project folder; the choice is remembered (status-bar chip or
  `Ctrl+Shift+P → File: Open Workspace Folder...` to switch).
- `desktop/` contains the full packaging project (`neutralino.config.json` +
  `neu build`), and `src-tauri/` remains available for the Rust-built variant.

## What's new in v0.2.0

- **Everything runs in a Web Worker** — parsing, indexing, completions, hover and
  diagnostics never block the UI thread. Typing latency dropped to a 90 ms
  debounce + 1–3 ms parse; the 5.2 MB Unity API loads inside the worker at boot.
- **Incremental project indexing** — editing a file updates only that file's
  symbols in the index (v0.1 rebuilt the whole index per keystroke).
- **Full syntax colorization** — custom C# Monarch grammar (strings, verbatim &
  interpolated strings, chars, hex/bin numbers, attributes, preprocessor,
  control-flow keywords) **plus a semantic token provider** that colors your
  project's classes, methods, fields, properties, enum members and statics by
  real resolution — UnityEngine types are teal, your classes cyan, and Unity
  event functions (**Awake, Start, Update…**) pop in bold velvet pink.
- **Unity event functions in autocomplete** — at class member level you now get
  the full MonoBehaviour message catalog (40 events with docs, tab-stops and
  ready-made bodies). Already-declared ones are hidden. Also available via
  **Ctrl+Shift+P → "Unity: Insert Method…"**.
- **Outline panel** — sidebar ≣ tab shows the active file's classes → members
  with Unity-message badges; click to jump.
- **csproj auto-configuration** — drop into any Unity project folder and
  VelvetSharp finds your `*.csproj` files (Assembly-CSharp, -Editor, .Player…),
  parses DefineConstants (UNITY_*), references and Compile lists, shows the
  assembly chips in the status bar and maps every script to its assembly.

## Why it's light

| | Rider / VS | VS Code + C# | **VelvetSharp** |
|---|---|---|---|
| Runtime | .NET + JVM | .NET + LSP | **none (WASM in webview)** |
| Cold start | 10–60 s | 3–10 s | **< 2 s** |
| Engine | Roslyn/OmniSharp | OmniSharp | **custom TS brain (~40 KB gzip)** |
| Unity API source | packages | NuGet | **your own DLL, parsed locally** |

## Repository layout

```
velvetsharp/
├── app/                    # Vite + React + Monaco frontend
│   ├── public/api/unityengine.db.json   ← generated from YOUR UnityEngine.dll
│   ├── public/demo/        ← demo Unity workspace for browser mode
│   ├── public/wasm/        ← tree-sitter runtime + C# grammar
│   └── src/                # UI, adapters (browser ⇄ Tauri ⇄ Neutralino), monaco setup
├── packages/
│   ├── brain/              # @velvetsharp/brain — the C# intelligence engine
│   └── metadata/           # @velvetsharp/metadata — zero-dep ECMA-335 reader
├── desktop/                # prebuilt-exe packaging (Neutralino shell, `neu build`)
├── src-tauri/              # Tauri 2 shell (minimal Rust: fs + workspace scan)
├── scripts/                # test + tooling scripts
├── BUILD-WINDOWS.md        # ← how to build the desktop app on Windows
└── package.json
```

## Quick start (browser preview, no build needed)

```bash
cd app
npm install
npx vite build
npx vite preview --port 3000   # or any static server for app/dist
```

## Desktop build (Windows / macOS / Linux)

**No-build option (recommended):** download the prebuilt Windows artifacts —
`VelvetSharp-0.3.0-win-x64-setup.exe` (installer) or
`VelvetSharp-0.3.0-win-x64-portable.zip` (portable). Double-click and go.

Rebuild the packaged shell yourself (no Rust needed):

```bash
cd app && npm install && npm run build && cd ..
# put a fresh build into desktop/app/dist, then:
cd desktop
npx neu update      # fetch Neutralino binaries
cp ../app/node_modules/@neutralinojs/lib/dist/neutralino.js .
npx neu build --release   # → dist/VelvetSharp/VelvetSharp-<plat>
```

Or compile the Rust/Tauri variant — see **[BUILD-WINDOWS.md](./BUILD-WINDOWS.md)**. Short version:

```bash
npm install
npm run tauri dev     # live development
npm run tauri build   # ~12 MB installer
```

## How the brain works

1. **Parse** — every `.cs` file is parsed by tree-sitter's C# grammar (compiled to
   WASM, runs in the webview). Errors become squiggles in <50 ms.
2. **Index** — namespaces, types, methods, properties, fields, events and locals
   are extracted into an in-memory project index.
3. **Infer** — when you type `rb.`, the engine walks your scope: fields → locals
   → parameters → `var x = new T()` / `GetComponent<T>()` patterns → Unity
   self-globals (`transform`, `gameObject`…) on MonoBehaviour classes →
   chained member resolution through the Unity DB and your own types.
4. **Complete** — Unity API members come from a compact database (3,288 types,
   13,958 methods, 9,213 properties, 748 enums) extracted from your
   `UnityEngine.dll` by `@velvetsharp/metadata` — a from-scratch ECMA-335 reader
   that needs **no .NET runtime at all** — merged with the official XML docs
   (34,599 doc fragments) so hover shows the real Unity documentation.

## Regenerating the Unity database

For a different Unity version, drop the new `UnityEngine.dll` + `.xml` in and run:

```bash
npx tsx packages/metadata/src/cli.ts extract UnityEngine.dll UnityEngine.xml app/public/api/unityengine.db.json
```

## Extending the brain (roadmap)

- ~~v0.2 — worker engine, semantic colors, Unity messages, outline, csproj auto-config~~ ✅ shipped
- v0.4 — ~~BCL metadata, completion scoping, namespace completion, name suggestions, deep semantic diagnostics~~ ✅ shipped
- v0.5 — find-usages, rename (local), Unity event wizard, semantic lint packs
- v0.5 — optional Roslyn-in-browser (WASM) for full semantic accuracy when you want it

VelvetSharp is yours — extend `packages/brain/src/engine.ts` and make it sharp.

## v0.3.1 — workspace-opening fixes

- **Starting dialog fixed**: the first-run picker now opens whenever the scanned workspace has no project (v0.3.0 gated it on an empty scan, which the readme in the install dir defeated).
- **Never-silent open**: if the native folder dialog fails or opens behind the window, a built-in prompt lets you paste the project path (validated, with recent-projects chips). All entry points (first run, welcome button, status-bar chip, palette command) share one flow.
- **Root resolution order**: `--project=` / bare path CLI arg -> validated saved root -> CWD with Unity signature (Assets/ + ProjectSettings/) -> plain CWD -> picker.
- **In-place workspace reload**: switching projects no longer reloads the page (Neutralino delivers its auth token one-shot, so page reloads are fatal). The editor clears tabs/models and re-indexes live with progress.
- **Fast scan**: one readDirectory per folder (per-file getStats removed; 2 MB text cap enforced at read time).
- **Critical runtime fix**: `@neutralinojs/lib` v6 exports namespaces (`filesystem`, `os`, ...), not a `Neutralino` object - the old named import was `undefined` at runtime, crashing every native call in v0.3.0.

Deliverables: `VelvetSharp-0.3.1-win-x64-setup.exe` (per-user NSIS installer) and `VelvetSharp-0.3.1-win-x64-portable.zip`.

## v0.4.0 — BCL intelligence + deep semantic analysis

- **.NET base class library support**: `mscorlib` + `System` + `System.Core` metadata
  extracted with the same pure-TypeScript ECMA-335 reader (no .NET SDK) and merged
  into the brain — completions, hover and signatures now cover `Console`, `Math`,
  `String`, `List<T>`, `Dictionary<K,V>`, `StringBuilder`, `File`, `Thread`, Linq
  containers and friends: **6,210 types / 58k members** across Unity + BCL.
- **Completion scoping**: bare-context suggestions respect the file's `using`
  directives, the enclosing namespace chain and the auto-detected csproj
  (including Unity 6 `<ImplicitUsings>` = the Roslyn implicit set). A file without
  `using UnityEngine;` no longer suggests `GameObject`.
- **Namespace completion**: type `using System.Collections.G` and pick `Generic` —
  segment-aware matching over every namespace in Unity, the BCL and your project.
- **Smart variable naming**: at declaration sites (`Rigidbody `, `GameObject `,
  `List<int> `, `int `…) the engine suggests idiomatic names — `rb`, `go`, `col`,
  `list`, `i` — with an abbreviation table plus camelCase fallbacks.
- **Deep semantic pass** (new `velvetsharp.semantic` diagnostics, 90 ms debounce):
  - unused variables — greyed + warning (read/write aware)
  - unreachable code — statements after `return`/`break`/`continue`/`throw` are
    greyed out in the editor and warned
  - missing return / `return` with a value in void / missing value in non-void
  - `new` on interfaces, abstract classes and static classes (CS0144/CS0712)
  - `ref`/`out` on literals and method calls (must be assignable variables)
  - **[Obsolete] API** — custom-attribute metadata is extracted from every DLL;
    obsolete types/members get a strikethrough decoration, a warning with the
    obsolete message, and a note in the completion docs (e.g. `Thread.Suspend`).
- **First-run hardening**: a canceled folder dialog with nothing to index now
  surfaces the typed-path prompt instead of stranding you on an empty welcome.

Deliverables: `VelvetSharp-0.4.0-win-x64-setup.exe` and
`VelvetSharp-0.4.0-win-x64-portable.zip` (exe + resources.neu + readme).
