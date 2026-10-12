/** VelvetSharp versioning — Phase numbering system (user request, Phase 7).
 *
 *  The user-facing version is the PHASE number: every delivered prompt bumps
 *  the phase by exactly one — numbers are never reused ("you repeated 0.7.1
 *  like three times — jump it up or it becomes confusing").
 *
 *  Phase 9 == internal build 9.0.0 (false-positive fixes: Array.Empty member
 *  calls + CS0104 suppression · problems right-click copy · singleton self-loops
 *  in the graph · per-script Call Flow view).
 *  History: 0.1–0.4 ≈ Phase 1–4 · 0.5.0 = Phase 5 · 0.6.0 = Phase 6 ·
 *           0.7.x = Phase 7 (renamed — "0.7.1" was repeated 3×) ·
 *           Phase 8 = graph types-only + family completions + magic methods +
 *           uses panel · Phase 9 = this build. Every delivery bumps by one.
 */
export const APP_PHASE = 9;
export const APP_BUILD = "9.0.0";
export const APP_LABEL = `Phase ${APP_PHASE}`;
export const APP_TITLE = `VelvetSharp — ${APP_LABEL}`;
