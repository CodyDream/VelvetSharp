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
| **9** | **9.0.0** | **2026-10-13** | false-positive kills (user-verified against VS/Rider): `Array.Empty<int>()` member calls no longer flagged CS0246 (generic_name-under-member_access guard), ambiguous-reference (CS0104) warnings suppressed entirely; Problems bar **right-click → Copy this problem** (+ copy all + go-to-location); dependency graph **static singleton self-loops** (`static OwnType Instance` → badge + self edge); **⚡ Call Flow view** — per-script method call graph, external calls drawn as dashed terminal capsules (branch ends there), Unity-event U-badges, entry highlighting. New demo script FlowDemo.cs. Verified: 131 engine (17 Phase 8 + 13 Phase 9) + 43 dist + 34/34 visual E2E + 17 neu markers. CI/CD: GitHub Actions builds + publishes the release zip on `v*` tags |

| **10** | **10.0.0** | **2026-10-13** | **Call-flow stability + vertical flowchart + solid completions + navigation history** (user reports fixed): call-flow graph no longer crashes/blanks — walk cap raised (4000 raw edges) with **connectivity-ranked node selection** (a big script keeps its helpers instead of a wall of isolated callers — 400/400 edges vs 60 before), engine callFlow wrapped (readable empty state, never a dead RPC), graph load-error UI + safe flow mapper + debounced index-refresh + non-passive wheel listener; **new Vertical layout** — tidy-tree flowchart (sources on top, calls flow down, each branch owns a column) auto-selected in Call Flow mode and available in Types mode, layering made iterative (stack-overflow proof) + unbreakable grid backstop; **completions always pop** — instant same-file member fast path (methods/fields/props scanned synchronously) raced against the brain with stale-while-revalidate caching, space trigger removed; **QoL: navigation history** — Alt+Left/Right Go Back/Forward across F12/search/problems/outline/graph jumps + Ctrl+Wheel editor zoom. Verified: 139 engine (8 new Phase 10) + dist markers + visual E2E |

## Build identity

- Window title: `VelvetSharp — Phase 10`
- Status bar chip: `Phase 10` (click → Settings)
- Settings → version: `VelvetSharp Phase 10 · build 10.0.0`
- Source of truth: `app/src/version.ts` (`APP_PHASE`, `APP_BUILD`)
- Mirror locations: root `package.json`, `app/package.json`,
  `desktop/neutralino.config.json` (all `10.0.0`)

## Next delivery checklist (do this every prompt)

1. Bump `APP_PHASE` / `APP_BUILD` in `app/src/version.ts` (+ the three mirrors).
2. Note the change in this table.
3. `npm run test` (engine + dist assertions) must be green.
4. Rebuild dist → `neu build` → verify markers.
5. Pack portable zip + refreshed source zip under the new phase name.
6. Push to GitHub + tag `vX.Y.Z` → the release workflow builds and publishes the zip.
7. Discord webhook report with the new phase number.
