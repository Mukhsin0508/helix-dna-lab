# Helix DNA Lab

An analytical workspace for genetic variant results. Import data, select an assay and scoring method, build a scientific figure, and save the inputs and figure settings together. React, TypeScript and SVG in the browser; Fastify/SQLite locally and TanStack Start/D1 when hosted.

[Public site](https://helix-dna-lab.higgsfield.app/) · [Research and data sources](docs/ANALYTICAL_LAB.md) · [Worklist](WORKLIST.md)

## Run locally

Node.js 22.16 or newer is required for the built-in SQLite module.

```bash
npm ci
npm run dev
```

Open **http://127.0.0.1:4190**. The API runs on port 4191. Sessions persist in `.data/sessions.sqlite`, which is excluded from Git. No API key is needed to explore the included published data or plot an imported result.

```bash
npm test
npm run build
npm start
```

After building, `npm start` serves the compiled frontend and API together at **http://127.0.0.1:4191**. The local service intentionally binds to loopback.

## Analytical workflow

- Start from 524 real score rows extracted from Google's published AlphaGenome batch notebook, or import a CSV/JSON result.
- Filter the variant, modality, exact scorer, track and gene. Compare only compatible scoring methods and units.
- Generate signed bars, a comparison heatmap, a result table or aligned reference/alternate signal tracks from an imported track dataset.
- Export the figure as SVG/PNG, the data as CSV, and the complete analysis recipe as JSON.
- Save the dataset and settings in SQLite or D1. Reload or share the saved analysis with optimistic revision checks to prevent overwriting another edit.

The bundled data is a **historical published model-output example** with an upstream notebook execution timestamp of July 21, 2025. It includes four variants and T-cell tracks. Its model version was not recorded. It is not a fresh Atlas query, AVI data, the user's requested DNM1 variant, or genomic track arrays. See [source artifacts and provenance](data/atlas/README.md).

## Data and interpretation

Scores are molecular predictions in scorer-specific units. Signed empirical quantiles are not disease probabilities or AVI PHRED. Missing heatmap cells mean no supplied result; they are not zero. Importing or filtering data does not execute a biological model.

SNV identifiers use one-based positions, for example `chr9:128226027:G>A`. Imported track positions are zero-based; reference/alternate fields are numeric signals. An explicit genome assembly is required. Input validation checks syntax and known GRCh38 bounds, not whether a reference allele matches the genome.

Higgsfield-generated imagery is not part of the analytical interface. Earlier illustrative cell/replay components and their session APIs remain in the repository for compatibility; the active product is the figure workspace.

## Persistence and API

`POST /api/analyses` stores `{dataset, settings}`. `GET /api/analyses/:id` retrieves it. `PATCH /api/analyses/:id` requires `{revision, dataset, settings}` and returns 409 with the latest record on conflict. Schemas and endpoint documentation are exposed at `/api/openapi.json`.

Imports and drafts stay in the current browser until Save/share is used. Anyone with a saved analysis link can view and edit it. These are capability links, not authenticated accounts: use public or non-sensitive research results. Private genomic datasets need account ownership and access control before upload. Each input is capped at 5000 rows and 2 MiB.

The frontend, local API and hosted adapter share the same dataset and figure schemas. See [hosting](docs/hosting.md) for deployment status and synchronization.

## Still to build

Live Atlas lookup and AlphaGenome inference are not connected. The official static AVI archive returned HTTP 500 during verification; no requested DNM1 score was retrieved. Rich Atlas API access and self-hosted predictions require authorized access. No clinical efficacy, disease-risk or whole-organism phenotype probabilities are calculated.

Next stages are actual model/Atlas jobs, evaluation against compatible experimental measurements, and AllMCP tools for the same saved analyses. No separate in-app chat is planned. The broad DNA Engineering Lab goal is ongoing; this release provides its numerical analysis and figure-generation core.
