# Building VelvetSharp from source

> **You probably don't need this page.** VelvetSharp ships prebuilt:
> `VelvetSharp-Phase7-win-x64-portable.zip` — unzip → double-click
> `VelvetSharp.exe`. No installer, no admin, no build step.
>
> This page is for compiling the app **from this source tree**. The current
> desktop shell is **Neutralino 6.x** (a tiny native binary + WebView2 +
> `resources.neu`), not Rust/Tauri — the old Tauri variant is retired.

## What lives where

```
app/                 React + Monaco + TypeScript frontend (Vite)
  src/               UI, nl-bridge (self-healing native bridge), themes, store
  public/api/        Unity + BCL API databases (built from DLL metadata)
  public/wasm/       tree-sitter wasm
  demo/              bundled demo Unity workspace
packages/
  brain/             the C# intelligence engine (parser, index, completions,
                     diagnostics, rename, dependency graph) — Web Worker
  metadata/          ECMA-335 PE/DLL reader + XML doc extractor (build-time)
desktop/             the native shell (Neutralino)
  neutralino.config.json   window + permissions + version
  app/dist/          build output goes here (synced from app/dist)
scripts/
  test-brain.ts      101 engine assertions
  verify-dist.mjs    31 compiled-artifact feature markers
```

## Build & run (Windows / macOS / Linux)

One-time setup (~5 min):

```bat
:: 1. install Node.js 20+ (https://nodejs.org)
:: 2. from this folder:
npm install
npm --prefix app install
npm --prefix packages/brain install
npm --prefix packages/metadata install

:: 3. fetch the Neutralino runtime binaries into desktop\bin
npx neu update
```

Every build after that is ~1 minute:

```bat
npm run build                                :: vite build → app\dist
rd /s /q desktop\app\dist
xcopy /e /i app\dist desktop\app\dist        :: sync into the shell
cd desktop
..\node_modules\.bin\neu build --release     :: → dist\VelvetSharp\
```

You get `dist/VelvetSharp/VelvetSharp-win_x64.exe` + `resources.neu` —
that pair IS the portable app (zip them together with `README-FIRST.txt`).

Run the built app directly:

```bat
cd desktop\dist\VelvetSharp
VelvetSharp-win_x64.exe
```

## Tests (run before every delivery)

```bat
npm run test          :: 101 engine assertions + 31 dist feature markers
```

The engine suite covers parser/completions/diagnostics/rename/dependency
graph/CRLF handling and the regression-locked bug fixes (the "void→oid"
parse corruption, cross-assembly duplicate legality, snippet loop-var
bumping, cache round-trips). `verify-dist.mjs` fails the build if any
feature surface is missing from the compiled bundle — that is the net
that stops "you keep breaking some functionalities".

## Version system

The user-facing version is the **phase number** (see `VERSIONS.md`):
`app/src/version.ts` holds `APP_PHASE` / `APP_BUILD`; mirrored in
`package.json`, `app/package.json` and `desktop/neutralino.config.json`.
Bump all four together — never reuse a number.
