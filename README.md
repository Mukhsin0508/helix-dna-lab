# Helix DNA Lab

A workspace for comparing biological mechanisms, saving alternative hypotheses and reviewing published evidence. Built with React, TypeScript, Three.js, Fastify, and SQLite.

**[Open the live lab](https://helix-dna-lab.higgsfield.app/)** · [Higgsfield community](https://higgsfield.ai/supercomputer/apps/00961b5d-05b8-430c-aef1-825c7c4368bf/view)

The hosted version uses TanStack Start and D1. It includes a published experimental replay; live AlphaGenome inference remains unconnected.

## Run locally

Node.js 22.16 or newer is required for the built-in SQLite module.

```bash
npm ci
npm run dev
```

Open **http://127.0.0.1:4190**. The API runs on port 4191. Sessions persist in `.data/sessions.sqlite`, which is excluded from Git. No API keys are needed for the included replay.

```bash
npm test
npm run build
npm start
```

After building, `npm start` serves the compiled frontend and API together at **http://127.0.0.1:4191**. The local service intentionally binds to loopback.

## What works

- Compare an illustrative sickle-cell mechanism with the mechanism described for Casgevy. Review the historical FDA endpoint and cohort, without treating it as a simulated clinical result.
- Save, duplicate, edit and compare alternatives with notes and revision-protected persistence; export their actual saved state.
- Inspect an original Blender cell built through Higgsfield 3D Jutsu, DNA, and schematic RNA. Orbit, zoom, and pause the scene.
- Select any of 41 verified reference bases and change its alternate letter.
- Compare reference and edited DNA illustrations.
- Replay the published DNM1 G→A splicing example, with pause, resume, and scrubbing.
- Inspect source evidence without leaving the scene.
- Restore the selected comparison after reload and export source provenance. Replay sessions are isolated between browser tabs; each tab restores its last confirmed pause position.

## Scientific scope

The starting case is **GRCh38/hg38 chr9:128225994 G>A**, a DNM1 intronic variant discussed in the AlphaGenome Atlas report. UCSC and Ensembl independently match the 41-base excerpt and its central G. The publication reports an alternative splice acceptor, retaining 39 RNA bases and adding 13 amino acids, supported by minigene experiments.

This release contains a **curated replay**, not a live AlphaGenome model connection. Molecular geometry, movement, playback timing, and the RNA loop are illustrations. They are not molecular dynamics, measured motion, folding predictions, or a complete cellular simulation. The short DNA excerpt does not contain the entire illustrated RNA extension. The loop conveys an added segment, not its predicted physical conformation.

Other edits remain **unscored**. No disease probabilities, vaccine efficacy estimates, or creature phenotypes are inferred. The new blood-cell animation is also illustrative: its geometry, speeds and proportions are not calibrated physiological predictions. The supplied Higgsfield concept artwork remains a creative asset in the repository.

The Casgevy clinical observation and DNM1 molecular example are independent cases. Changing a candidate's question, notes or illustration never changes the source study's result. See the [outcome workspace contract](docs/OUTCOME_WORKSPACE.md) for the distinction between measured observations, predictions and illustrations.

See [scientific evidence](docs/scientific-evidence.md) for reference coordinates, retrieval URLs, and publication details. Underlying research is credited to Google DeepMind and the study's collaborators; this project is the interactive visualization layer.

## API and future integrations

[API documentation](docs/api.md) and `/api/openapi.json` describe session and workspace endpoints. Workspace updates require optimistic revisions; conflicts preserve the newer server record and leave unsaved client edits available for recovery.

The next integration is an AllMCP provider exposing this API to ChatGPT, then Claude. The website and assistant will work against the same authorized session. This avoids building another chat interface. Provider registration, remote MCP transport, authentication, and live inference are **not implemented yet**.

The Higgsfield hosting adapter is in `deploy/higgsfield`: TanStack Start server routes run against D1, while the interactive scene renders on the visitor's GPU. The local Fastify adapter continues to use SQLite. See [hosting and verification](docs/hosting.md) for deployment status and the sync procedure.

The current release shares workspaces through unguessable collaboration links. Anyone with a link can read or edit its comparisons and notes; this is collaboration by possession of the link, not account authentication. It only accepts edits to the included public reference sequence. Private DNA uploads, model credentials, and live inference are not supported by the public API. Account ownership and authentication are required before adding private genomic data or paid model execution.

For a company product, confirm the applicable AlphaGenome license and commercial inference route before adding live model calls. Never ship model or Higgsfield credentials in the browser.

## Project plan

[WORKLIST.md](WORKLIST.md) contains the full agreed scope and remaining integration work. The repository is private while the first version is reviewed.
