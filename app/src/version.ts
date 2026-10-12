/** VelvetSharp versioning — Phase numbering system (user request, Phase 7).
 *
 *  The user-facing version is the PHASE number: every delivered prompt bumps
 *  the phase by exactly one — numbers are never reused ("you repeated 0.7.1
 *  like three times — jump it up or it becomes confusing").
 *
 *  Phase 7 == internal build 7.0.0 (follows 0.7.1; same feature set, renamed).
 *  History: 0.1–0.4 ≈ Phase 1–4 · 0.5.0 = Phase 5 · 0.6.0 = Phase 6 ·
 *           0.7.0/0.7.1 = Phase 7 (0.7.1 was mislabeled 3× → renamed).
 */
export const APP_PHASE = 7;
export const APP_BUILD = "7.0.0";
export const APP_LABEL = `Phase ${APP_PHASE}`;
export const APP_TITLE = `VelvetSharp — ${APP_LABEL}`;
