# Helix release validation

Verified on 10 September 2026.

- Strict TypeScript and Vite production build pass.
- Nine local API/client tests pass: persistent storage, storage bounds, stale revisions/invalid input, curated replay versus unscored edits, unchanged controls, old-database migration, request timeouts, unexpected responses, and conflict recovery.
- npm audit reports no known vulnerabilities in the installed dependency set.
- Renderer reviewed in 14 desktop and mobile states: DNA, comparison, cell, RNA start/middle/end, and unsupported edits.
- Direct atom selection, orbit drag, zoom, and camera reset worked. Atom selection persisted through the API.
- A selected alternate letter survived a browser reload.
- Two windows using the same session synchronized their view and edit state.
- Pause held its progress; resume continued from that position.
- The concept panel loaded the Higgsfield image and displayed its separation from DNA predictions.
- Layout checked at 1440×960 and 390×844, plus a shorter desktop viewport. No horizontal page overflow; the controls remain reachable through vertical scrolling on short screens.
- The compiled frontend loaded from the local API server, independently of Vite's development reloads.
- Unchanged reference controls return an explicit no-change result, including after database restart. Later edits clear the result.
- Replay starts at progress zero with RNA comparison prepared in the same API response; it no longer flashes the completed result before playback.
- WebGL initialization, first-frame failure, setup errors, and context loss produce a recoverable fallback without uncaught JavaScript errors. Editing and Evidence remain usable; Retry restores the 3D view after WebGL becomes available.
- Session URLs preserve access when browser storage is unavailable. An invalid session link offers a fresh-experiment recovery action.

The self-hosted AlphaGenome handoff is documented separately. No model weights have been loaded and no fresh AlphaGenome prediction has been run in this local app.

The renderer uses illustrative geometry and a capped display resolution. These checks verify application behavior and layout; they do not establish physical accuracy, clinical validity, or performance on every device. Public hosting uses the D1 adapter described below.

## Immersive cell and hosted release

- Original Higgsfield 3D Jutsu GLB: 118 unique meshes, 90,416 unique-mesh triangles, self-contained; source and native preview inspected.
- Fullscreen Cell → DNA → RNA UI, folded spatial RNA comparison, ambient motion independent of replay, responsive camera framing.
- 20 TypeScript tests pass: 9 local API/client checks plus 11 real SQLite-backed checks of the D1 handler. Five dependency-free Python track-export tests and CLI help also pass; these do not run inference.
- Local production build, cloud production build, strict TypeScript, and diff whitespace checks pass.
- Local browser checks cover desktop 1440×1000 and mobile 390×667, full journey, pause, unchanged controls, unscored edits, evidence/dialog access, concept image, persistence, and lack of horizontal overflow.
- Live public API: 12 checks passed against the deployed D1 database, including anonymous homepage/health, create/edit, replay, stale revision rejection, persisted progress, unchanged control, unscored export provenance, mandatory revisions, hosted OpenAPI, and byte-identical GLB/concept assets.
- The initial anonymous check received the platform's private-app response. After publishing the site, anonymous access and API checks passed.
- Public browser verification is recorded in the hosting document.

See [hosting](hosting.md) for the deployed release and [GPU delivery status](gpu-delivery-status.md) for independent checks of the supplied GPU package. No live model output has been substituted with invented values.
