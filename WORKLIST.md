# Helix DNA Lab — worklist

## Current direction: analytical generators

The owner selected a researcher-focused analytical workspace using AlphaGenome Atlas as the reference: compare source results, inspect exact values and methods, and iterate on reproducible figures. Generated imagery and the outcome/replay interface are superseded as the product's main workflow. The full goal remains a DNA Engineering Lab, including real model execution and experimental validation; figure generation alone does not complete it.

- [x] Study official Atlas tools, API, data access, scorer semantics and limitations.
- [x] Retrieve and preserve a real published 524-row AlphaGenome snapshot with exact numbers and source provenance.
- [x] Implement typed CSV/JSON imports, coordinate validation and compatible comparison groups.
- [x] Implement dataset + figure persistence with revision checks in SQLite and D1.
- [x] Verify analytical figure rendering, filtering, imports and SVG/PNG/CSV/recipe exports in the browser.
- [x] Deploy and verify this analytical version publicly, including saved figure settings restored from D1.
- [x] Add a metadata-preserving GPU service-result import bridge with a checksummed raw artifact, exact REF/ALT bins, tissue scope and source-reported inference provenance. A completed real service result is still required; this bridge does not execute or connect a model.
- [x] Independently verify the two DNM1 reference contexts; bind each imported result to its exact variant, sequence, hash and crop instead of relabeling the earlier variant.
- [x] Prepare the explicit-variant runner with required annotations, direct analytical export and raw sidecar; verify the Python output through the actual TypeScript importer. These are offline checks, not model execution.
- [x] Adapt the delivered authenticated service controller to the corrected reusable runner. Validate every completed result against its persisted request and exact raw bytes; verify lifecycle, expiry, both variants and downloaded artifact imports in offline tests. No live endpoint is implied.
- [ ] Run the corrected explicit-variant GPU runner and import its actual analysis/raw-result pair. Offline validation does not check this box.
- [x] Add a dedicated junction JSON dataset, paired REF/ALT arc plots and exact-value table. Preserve ascending genomic endpoints on both strands, zero versus missing/null, one shared REF/ALT scale per track and source metadata.
- [x] Preserve display-overlapping junctions whose endpoints extend outside the viewport; show continuation markers and retain full coordinates in exports. Inference-linked endpoints must remain inside the input interval.
- [x] Export displayed junction figures as SVG/PNG, all selected scalar rows as CSV and complete datasets/settings as reimportable JSON. CSV keeps nulls and unrounded values; it does not carry the full interval/provenance contract.
- [x] Verify junction coordinate, identity, scope, metadata and settings validation, plus local and hosted API save/update behavior. Synthetic test fixtures are validation only, not model results.
- [x] Deploy the junction revision and verify public imports, paired arcs, exact-value tables and exports. Local browser save/reload and both API adapters pass; public checks leave synthetic fixtures unsaved.
- [ ] Save and reopen the first actual junction model result on the public site after GPU execution.
- [ ] Connect live Atlas lookup or an authorized AlphaGenome service, with job status and recorded model version.
- [x] Add typed experimental-measurement JSON imports and a source-backed DNM1 Table S4 plot, preserving printed values and missing uncertainty.
- [ ] Add prediction-versus-measurement analysis once matching predictions, endpoints and assay contexts are available.
- [ ] Validate utility with a research workflow and held-out measurements.
- [x] Add account ownership before accepting private genomic results or paid model execution.
- [ ] Expose the analytical tools through AllMCP to ChatGPT and Claude.

## Historical direction: outcome and evidence workspace

The owner replaced the guided educational journey with a spacious workspace for investigating outcomes and rapidly comparing alternatives. The older release checklist below is historical, not the current product acceptance criteria. See [the outcome workspace contract](docs/OUTCOME_WORKSPACE.md).

- [x] Add persistent comparison candidates, duplication support, notes and revision-protected updates in SQLite and D1.
- [x] Add an interactive blood-cell illustration and the exact historical Casgevy trial endpoint, with its source, denominator and date.
- [x] Replace the landing-page layout with a workspace: outcome viewport, direct setup, evidence inspector and alternatives review.
- [x] Verify duplicate, edit, switch, save, reload and export through the browser on desktop and mobile.
- [ ] Deploy the revised workspace and verify public persistence and the existing session API.
- [ ] Connect actual inference with model provenance and numerical results for a supported endpoint.
- [ ] Validate prediction quality against held-out experimental measurements before claiming predictive research utility.

Saving a hypothesis or changing an illustration does not run a model. Vaccine success probabilities and whole-organism phenotype predictions are not supported by the current engine.

## First working release

- [x] Create a dedicated GitHub repository on the owner's personal account.
- [x] Scaffold React + TypeScript frontend and Node.js API.
- [x] Build a dark, minimal, responsive laboratory, consistent with the Cerebra visual direction.
- [x] Render an interactive 3D cell, DNA helix, and RNA view; support orbit, zoom, pause, and replay.
- [x] Select a DNA letter and compare reference versus alternate views.
- [x] Recreate the published DNM1 splice-change example with traceable sources.
- [x] Keep measured evidence, published predictions, and illustrative motion distinguishable.
- [x] Mark arbitrary edits as unscored; never fabricate AlphaGenome output or organism traits.
- [x] Save and restore experiments with a persistent database and revision checks.
- [x] Expose a documented session API usable by the website and future MCP tools.
- [x] Add a Higgsfield-generated concept view for imagined people/creatures, visibly marked Concept.
- [x] Test controls, persistence, API errors, mobile layout, and browser rendering.
- [x] Open the working lab for review and push the source to GitHub.

## After the lab is proven

- [x] Finish reference-control handling, replay startup, connection recovery, and the 3D fallback.
- [x] Write the Higgsfield GPU handoff with official model/weight sources and an authenticated API contract.
- [x] Build and integrate a native Higgsfield 3D Jutsu cell, with editable Blender source and asset provenance.
- [x] Replace the dashboard-style opening with an immersive, responsive Cell → DNA → RNA journey.
- [x] Implement the D1 hosting adapter and verify persistence, concurrent edits, validation, and recovery in automated tests.
- [ ] Verify authorized model-weight access and run the first real AlphaGenome prediction on a Higgsfield GPU.
- [ ] Connect the lab backend to the verified GPU service; persist and display actual reference/alternate numerical tracks.
- [x] Deploy the lab and API to Higgsfield; verify D1 database and runtime requirements.
- [ ] Verify the selected model/data license permits the intended public deployment.
- [ ] Add the lab API as an AllMCP provider (the owner operates AllMCP).
- [ ] Connect ChatGPT first, then Claude, as the conversation interface; no in-app chat or LangChain needed for the MVP.
- [ ] Link each chat to the same experiment session displayed in the website.
- [ ] Provide MCP tools to create, edit, run, inspect, compare, and export experiments.
- Superseded: on-demand Higgsfield concept generation; the owner removed it from the analytical workflow.
- [ ] Consider integration into Higgsfield's official MCP after validation.

## Product constraints

- Minimal words; clear, comfortably readable controls; full-screen visual focus.
- Start with one complete experiment, then expand from user feedback.
- Concept artwork is creative visualization, not a predicted human/creature phenotype.
- AlphaGenome predicts selected molecular effects; a rendered creature is not evidence of what a DNA edit causes.
- Keep API/data credentials server-side. The public educational release uses unguessable collaboration links for edits to a fixed public sequence; private analytical records now require native passkey accounts; legacy sessions and workspaces remain public. Paid inference still needs authenticated job ownership and a verified live model connection.

This file records the agreed build scope. Checkboxes track delivered work, not promises.

## Native analytical accounts

- [x] Add real passkey registration/authentication and hashed server sessions, with exact origins and single-use challenges.
- [x] Give new analyses account ownership; enforce private reads, list, revision-safe update/delete and conflict privacy in shared local/hosted handlers.
- [x] Preserve legacy public examples as read-only and allow explicit private copies.
- [x] Add My analyses and account controls; clear private state across logout, tabs, delayed requests and downloads.
- [x] Verify the account release on the public Workers/D1 runtime and record evidence (`2c9a166`; 143 tests plus real browser account journeys).
- [ ] Add account-authorized model jobs after checkpoint access and the first verified inference.

## Assistant integration

- [x] Add scoped, expiring and revocable account access tokens for the analytical API; keep passkey and token management cookie-only.
- [x] Implement the native AllMCP Helix provider in an isolated worktree: identity, list, read, create, revision-safe update and full recipe export.
- [x] Deploy token support and verify the provider against real public Helix requests, including private create/update, stale revision conflict and exact recipe export.
- [x] Reopen the provider-created analysis in the signed-in browser and verify the same saved title and 12 source measurements; delete the disposable analysis and revoke its token after QA.
- [ ] Deploy the provider to AllMCP and connect an authorized user through its browser credential flow.
- [ ] Verify the same analysis from ChatGPT or Claude and the website.
