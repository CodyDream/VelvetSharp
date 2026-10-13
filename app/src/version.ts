/** VelvetSharp versioning — Phase numbering system (user request, Phase 7).
 *
 *  The user-facing version is the PHASE number: every delivered prompt bumps
 *  the phase by exactly one — numbers are never reused ("you repeated 0.7.1
 *  like three times — jump it up or it becomes confusing").
 *
 *  Phase 10 == internal build 10.0.0 (call-flow graph stability + true
 *  connectivity-ranked selection · new VERTICAL tidy-tree flowchart layout
 *  (flow mode default) · instant bare-identifier completions with a
 *  stale-while-revalidate brain cache · navigation history (Alt+Left/Right)
 *  + Ctrl+Wheel zoom · graph load-error state instead of silent blanks).
 *  History: 0.1–0.4 ≈ Phase 1–4 · 0.5.0 = Phase 5 · 0.6.0 = Phase 6 ·
 *           0.7.x = Phase 7 (renamed — "0.7.1" was repeated 3×) ·
 *           Phase 8 = graph types-only + family completions + magic methods +
 *           uses panel · Phase 9 = false-positive kills + problems right-click
 *           + singleton self-loops + Call Flow view · Phase 10 = this build.
 *           Every delivery bumps by one.
 */
export const APP_PHASE = 10;
export const APP_BUILD = "10.0.0";
export const APP_LABEL = `Phase ${APP_PHASE}`;
export const APP_TITLE = `VelvetSharp — ${APP_LABEL}`;
