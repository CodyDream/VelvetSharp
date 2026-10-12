# VelvetSharp — Version History (Phase system)

> Policy (set by the user at Phase 7): **the user-facing version is the PHASE
> number and it bumps by exactly one on every delivered update. Numbers are
> never reused.** The old `0.x.y` names are retired — 0.7.x was mislabeled
> "0.7.1" three times, which is what triggered this change.
>
> A Phase chip in the status bar + ⚙ Settings → *version* row always show
> which build is running.

| Phase | Internal build | Date | Highlights |
|------:|----------------|------|------------|
| 1–4 | 0.1.0 – 0.4.2 | 2026-09 | brain engine (tree-sitter C#, symbol index, completions, diagnostics), Unity API db from DLL metadata, Monaco UI, multi-tab explorer, palette, global search |
| 5 | 0.5.0 | 2026-10 | asmdef assembly hunting (GUID→assembly), per-assembly completion gating, missing-using quick fix, project Problems bar, overload-aware duplicates, statement snippets, per-project warm-start cache |
| 6 | 0.6.0 | 2026-10 | dependency graph (Hierarchical/Organic/Circular/Business, folder scoping, externals), F2 project-wide rename with receiver resolution + .meta pairing |
| **7** | **7.0.0** | **2026-10-13** | self-healing native bridge (timeouts, auto-reconnect, token recovery, health chip), "void→oid" parse-corruption root-cause fix, error popup with stack trace, disk-backed settings (%APPDATA% config.json), ⚙ Settings modal, crash-proof circular layout, dblclick-opens-file fix, portable-first packaging + source-code drop |
| **8** | **8.0.0** | **2026-10-13** | dependency graph: nodes = classes/structs/interfaces/enums ONLY + exact-case edge guard (no more connection spam) + O(n²) worker hot-spot fixed (the graph "crash"), completions see the whole file + base-class family (`this.` included), Unity magic methods (Awake/Start/Update… 34 messages) injected into MonoBehaviour with docs, symbol USES panel (select → every reference + origin, Shift+F12), `out` variable declarations no longer false-flagged + FQ-generic CS0246 fix. Verified: 118 engine + 37 dist + 24/24 visual E2E |
| 9 | _next delivery_ | — | — |

## Build identity

- Window title: `VelvetSharp — Phase 8`
- Status bar chip: `Phase 8` (click → Settings)
- Settings → version: `VelvetSharp Phase 8 · build 8.0.0`
- Source of truth: `app/src/version.ts` (`APP_PHASE`, `APP_BUILD`)
- Mirror locations: root `package.json`, `app/package.json`,
  `desktop/neutralino.config.json` (all `8.0.0`)

## Next delivery checklist (do this every prompt)

1. Bump `APP_PHASE` / `APP_BUILD` in `app/src/version.ts` (+ the three mirrors).
2. Note the change in this table.
3. `npm run test` (engine + dist assertions) must be green.
4. Rebuild dist → `neu build` → verify markers.
5. Pack portable zip + refreshed source zip under the new phase name.
6. Discord webhook report with the new phase number.
