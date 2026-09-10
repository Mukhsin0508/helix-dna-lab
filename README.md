# Helix DNA Lab

A visual laboratory for exploring a DNA edit, comparing molecular illustrations, and replaying one published splicing experiment. Built with React, TypeScript, Three.js, Fastify, and SQLite.

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

- Orbit and zoom the 3D cell, DNA, and schematic RNA views.
- Select any of 41 verified reference bases and change its alternate letter.
- Compare reference and edited DNA illustrations.
- Replay the published DNM1 G→A splicing example, with pause, resume, scrub, and reset.
- Inspect source evidence without leaving the scene.
- Save sessions, restore after reload, export provenance, and synchronize the same session across browser windows through the API.
- Explore a separate Higgsfield-generated fictional concept portrait.

## Scientific scope

The starting case is **GRCh38/hg38 chr9:128225994 G>A**, a DNM1 intronic variant discussed in the AlphaGenome Atlas report. UCSC and Ensembl independently match the 41-base excerpt and its central G. The publication reports an alternative splice acceptor, retaining 39 RNA bases and adding 13 amino acids, supported by minigene experiments.

This release contains a **curated replay**, not a live AlphaGenome model connection. Molecular geometry, movement, playback timing, and the RNA loop are illustrations. They are not molecular dynamics, measured motion, folding predictions, or a complete cellular simulation. The short DNA excerpt does not contain the entire illustrated RNA extension. The loop conveys an added segment, not its predicted physical conformation.

Other edits remain **unscored**. No made-up scores, disease probabilities, or creature phenotypes are produced. The Higgsfield concept panel is imaginative artwork and is explicitly independent of the selected variant.

See [scientific evidence](docs/scientific-evidence.md) for reference coordinates, retrieval URLs, and publication details. Underlying research is credited to Google DeepMind and the study's collaborators; this project is the interactive visualization layer.

## API and future integrations

[API documentation](docs/api.md) and `/api/openapi.json` describe the implemented session endpoints. Every mutation uses optimistic revisions; conflicts preserve the newer session.

The next integration is an AllMCP provider exposing this API to ChatGPT, then Claude. The website and assistant will work against the same authorized session. This avoids building another chat interface. Provider registration, remote MCP transport, authentication, and live inference are **not implemented yet**.

Higgsfield deployment is also a later stage. Its documented web runtime uses Cloudflare Workers and optional D1. The local Fastify/SQLite adapter cannot be copied directly into that runtime; deploy behind a supported Node service or port the HTTP/database adapters. Before public access, implement per-user authentication, authorization, session ownership, and durable hosted storage. Do not expose the development server with a tunnel.

For a company product, confirm the applicable AlphaGenome license and commercial inference route before adding live model calls. Never ship model or Higgsfield credentials in the browser.

## Project plan

[WORKLIST.md](WORKLIST.md) contains the full agreed scope and remaining integration work. The repository is private while the first version is reviewed.
