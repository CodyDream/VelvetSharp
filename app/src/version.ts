/** VelvetSharp versioning — Phase numbering system (user request, Phase 7).
 *
 *  The user-facing version is the PHASE number: every delivered prompt bumps
 *  the phase by exactly one — numbers are never reused ("you repeated 0.7.1
 *  like three times — jump it up or it becomes confusing").
 *
 *  Phase 11 == internal build 11.0.0 (preprocessor directives are first-class:
 *  Unity define set + version symbols from ProjectVersion.txt + custom
 *  scriptingDefineSymbols, #if/#elif/#else/#endif evaluation with inactive-
 *  branch dimming + diagnostic suppression, structural errors for stray/
 *  unterminated directives, #pragma warning disable/restore honored,
 *  #error/#warning surfaced, full-line directive coloring · editor
 *  right-click menu with the Collapse ▸ submenu — by Methods / by #Regions /
 *  by #if Blocks / XML Doc Comments / All / Expand — backed by a precise
 *  folding provider that folds members from the signature line · /// + Enter
 *  generates the XML documentation skeleton (<summary>/<param>/<returns>/
 *  <value>) · completions client ReferenceError fix). History: 0.1–0.4 ≈
 *  Phase 1–4 · 0.5.0 = Phase 5 · 0.6.0 = Phase 6 · 0.7.x = Phase 7 (renamed —
 *  "0.7.1" was repeated 3×) · Phase 8 = graph types-only + family completions
 *  + magic methods + uses panel · Phase 9 = false-positive kills + problems
 *  right-click + singleton self-loops + Call Flow view · Phase 10 = flow
 *  stability + vertical tidy-tree + instant completions + nav history ·
 *  Phase 11 = 11.0.0 · 11.1.0 = PR #1 merged (class-aware Singleton
 *  snippet with guarded Awake + OnDestroy cleanup, 8 more Unity
 *  snippets: SingletonPersistent, OnEnableDisable, TryGetComponent,
 *  NullGuard, RequireComponent, EventAction, Cooldown, GizmoSphere).
 *  Every delivery bumps by one.
 */
export const APP_PHASE = 11;
export const APP_BUILD = "11.1.0";
export const APP_LABEL = `Phase ${APP_PHASE}`;
export const APP_TITLE = `VelvetSharp — ${APP_LABEL}`;
