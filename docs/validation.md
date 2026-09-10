# First prototype validation

Verified on 10 September 2026.

- Strict TypeScript and Vite production build pass.
- Four API tests pass: persistent storage, storage bounds, stale revisions/invalid input, and curated replay versus unscored edits.
- npm audit reports no known vulnerabilities in the installed dependency set.
- Renderer reviewed in 14 desktop and mobile states: DNA, comparison, cell, RNA start/middle/end, and unsupported edits.
- Direct atom selection, orbit drag, zoom, and camera reset worked. Atom selection persisted through the API.
- A selected alternate letter survived a browser reload.
- Two windows using the same session synchronized their view and edit state.
- Pause held its progress; resume continued from that position.
- The concept panel loaded the Higgsfield image and displayed its separation from DNA predictions.
- Layout checked at 1440×960 and 390×844, plus a shorter desktop viewport. No horizontal page overflow; the controls remain reachable through vertical scrolling on short screens.
- The compiled frontend loaded from the local API server, independently of Vite's development reloads.

The 3D renderer uses illustrative geometry and a capped display resolution. These checks establish a working browser prototype, not physical accuracy, clinical validity, a performance guarantee on every device, or readiness for unauthenticated public hosting.
