# Helix DNA Lab — worklist

## Current direction: analytical generators

The owner selected data-driven analytical tools using AlphaGenome Atlas as the reference. Generated imagery and the outcome/replay interface are superseded as the product's main workflow. The full goal remains a DNA Engineering Lab, including real model execution and experimental validation; figure generation alone does not complete it.

- [x] Study official Atlas tools, API, data access, scorer semantics and limitations.
- [x] Retrieve and preserve a real published 524-row AlphaGenome snapshot with exact numbers and source provenance.
- [x] Implement typed CSV/JSON imports, coordinate validation and compatible comparison groups.
- [x] Implement dataset + figure persistence with revision checks in SQLite and D1.
- [x] Verify analytical figure rendering, filtering, imports and SVG/PNG/CSV/recipe exports in the browser.
- [x] Deploy and verify this analytical version publicly, including saved figure settings restored from D1.
- [ ] Connect live Atlas lookup or an authorized AlphaGenome service, with job status and recorded model version.
- [ ] Add compatible experimental-result imports and prediction-versus-measurement analysis.
- [ ] Validate utility with a research workflow and held-out measurements.
- [ ] Add account ownership before accepting private genomic results or paid model execution.
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
- Keep API/data credentials server-side. The public educational release uses unguessable collaboration links for edits to a fixed public sequence; private DNA or paid inference requires account-level ownership and authorization.

This file records the agreed build scope. Checkboxes track delivered work, not promises.
