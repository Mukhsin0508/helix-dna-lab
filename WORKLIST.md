# Helix DNA Lab — worklist

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
- [ ] Add authenticated, on-demand Higgsfield concept generation and shareable media.
- [ ] Consider integration into Higgsfield's official MCP after validation.

## Product constraints

- Minimal words; clear, comfortably readable controls; full-screen visual focus.
- Start with one complete experiment, then expand from user feedback.
- Concept artwork is creative visualization, not a predicted human/creature phenotype.
- AlphaGenome predicts selected molecular effects; a rendered creature is not evidence of what a DNA edit causes.
- Keep API/data credentials server-side. The public educational release uses unguessable collaboration links for edits to a fixed public sequence; private DNA or paid inference requires account-level ownership and authorization.

This file records the agreed build scope. Checkboxes track delivered work, not promises.
