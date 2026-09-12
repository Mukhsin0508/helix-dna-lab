# Helix DNA Lab

An analytical workspace for researchers comparing genetic variant results. Import source data, select an assay and scoring method, inspect reference and alternate signals, and export reproducible figures with their inputs. No signup: edits save in this browser. React, TypeScript and SVG in the browser; Fastify/SQLite locally and TanStack Start/D1 when hosted.

[Public site](https://genetic-engineering-lab.higgsfield.app/) · [Research and data sources](docs/ANALYTICAL_LAB.md) · [Browser assistant workflow](docs/browser-assistant-workflow.md) · [Hosted API setup](docs/hosted-api-setup.md) · [Worklist](WORKLIST.md)

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

- Start from 524 real score rows extracted from Google's published AlphaGenome batch notebook, open the 12 published DNM1 measurements, or import a CSV/JSON result.
- Filter the variant, modality, exact scorer, track and gene. Compare only compatible scoring methods and units.
- Generate signed bars, a comparison heatmap, a result table or aligned reference/alternate signal tracks from an imported track dataset.
- Import splice-junction JSON and compare paired REF/ALT arcs on one signal scale per track, with the exact endpoint values available in a table.
- Experimental datasets have their own measured-value dot plot and table. Assay, aggregation, conditions and unknown replicate counts remain explicit; they cannot be switched to model quantiles.
- Export the figure as SVG/PNG, the data as CSV, and the complete analysis recipe as JSON.
- Keep the current dataset and figure settings in browser storage automatically. Reload to resume; export JSON to move the analysis to another browser or share it.

The T-cell dataset is a **historical published model-output example** with an upstream notebook execution timestamp of July 21, 2025. It includes four variants and T-cell tracks. Its model version was not recorded. It is not a fresh Atlas query, AVI data, the user's requested DNM1 variant, or genomic track arrays. See [source artifacts and provenance](data/atlas/README.md).

The separate **experimental DNM1 dataset** contains the 12 selected variants in Table S4 of the official Atlas technical report. It includes `chr9:128226027:G>A`, with a reported mean alternative splice-site rate of 0.94, and the distinct `chr9:128225994:G>A`, with 0.76. These minigene-assay averages combine five retained cell-line/promoter conditions. They are not glutamatergic-neuron model predictions. Per-row replicate counts and uncertainty are unavailable and remain null. The selected rows do not establish model accuracy or represent the full screen. See [benchmark feasibility and sources](docs/dnm1-benchmark-feasibility.md).

## Data and interpretation

Scores are molecular predictions in scorer-specific units. Signed empirical quantiles are not disease probabilities or AVI PHRED. Missing heatmap cells mean no supplied result; they are not zero. Importing or filtering data does not execute a biological model.

SNV identifiers use one-based positions, for example `chr9:128226027:G>A`. Imported track positions are zero-based; reference/alternate fields are numeric signals. An explicit genome assembly is required. Input validation checks syntax and known GRCh38 bounds, not whether a reference allele matches the genome.

Measurement JSON uses `kind: "measurements"`, a shared `experiment` context, and rows containing `variant`, `value`, `replicates` and `standardError`. Unknown replicate count or standard error must be `null`. Optional `reportedValue` preserves the source's numeric spelling, such as `0.60`. Measurement exports include both fields; JSON retains the complete assay metadata. One dataset represents a single comparable endpoint/condition aggregate.

The [local GPU runner](inference/README.md) is prepared to export an analysis JSON plus its checksummed raw REF/ALT result. It requires an explicit variant and verifies that variant's full reference context against [independently retrieved descriptors](data/reference/README.md). The earlier service variant `chr9:128225994:G>A` and the requested `chr9:128226027:G>A` are kept separate. This preparation has not executed the model.

## Splice-junction workflow

Open **Import data → Analysis JSON** with a `kind: "junctions"` dataset or a previously exported Helix recipe. Each row supplies `chromosome`, ascending `start` and `end`, `strand`, `track`, `reference` and `alternate`. Both strands use zero-based, half-open genomic coordinates. The required dataset `interval` defines the viewport; an optional one-based `variant` identifies the edit without asserting that inference ran. Positional `SPLICE_SITE_USAGE` values are a different output and cannot be imported as junction arcs.

Select a track and switch between **Junctions** and **Data**. REF and ALT share one linear signal-width scale within each displayed track. Arc height separates connections visually; it does not encode confidence, effect size or an outcome. A numerical zero is an open circle; an absent allele is `null` and appears as a cross. Values can exceed one and are not interpreted as probabilities. The display limit follows dataset order per track.

Junctions that cross the viewport remain visible, with continuation markers where an endpoint lies beyond it. Their original endpoints are retained in data and exports. With inference provenance, the viewport must equal the recorded display interval and both endpoints must remain inside the model input interval. Required `trackMetadata` records the original track, tissue scope, strand and known unit for every chromosome/track pair; unspecified units and strand remain null. Junction metadata has no coverage `binSize`.

- **SVG/PNG:** export the displayed figure with its title, source, assembly and status. SVG also retains structured source metadata. Image exports are visual representations; use JSON or CSV for exact numerical data.
- **CSV:** export every selected junction, including those beyond the display-count limit, with exact unrounded numerical values, full endpoints, strand and explicit `null`. CSV omits the dataset interval and track provenance and is not a complete junction import format.
- **Complete analysis JSON:** retain the full dataset, interval, optional variant, track metadata, provenance and figure settings for reimport. A checksummed raw source artifact is referenced when supplied; its bytes remain in the separate original file.

The junction workflow is deployed and browser-verified; see [release validation](docs/junction-release-validation.md). It includes no fabricated example or bundled live junction prediction. A completed model result is still needed.

## Product scope

Higgsfield-generated imagery is not part of the analytical interface. Earlier illustrative cell/replay components and their session APIs remain in the repository for compatibility; the active product is the figure workspace.

## Persistence and API

`POST /api/analyses` stores `{dataset, settings}`. `GET /api/analyses/:id` retrieves it. `PATCH /api/analyses/:id` requires `{revision, dataset, settings}` and returns 409 with the latest record on conflict. Schemas and endpoint documentation are exposed at `/api/openapi.json`.

The website has no signup, account checks or cloud-save prompts. Imports and edits stay in IndexedDB in this browser. Each document writes a separate draft branch so concurrent tabs do not overwrite one another; reload restores the committed branch. Wait for “Saved in this browser” before closing. Storage failures remain visible, and JSON export remains available. Clearing site data removes browser drafts. Export JSON for a portable copy. Each input is capped at 5000 rows and 2 MiB.

Historical public analysis links are loaded without cookies and are never changed. Editing one creates a browser draft and removes its source URL parameter. Private server records are never loaded into this anonymous workspace; existing API ownership protections are unchanged.

An assistant with interactive browser tools can use the website directly; no AllMCP connection or integration token is required. No account is needed for the whole analytical workflow. Browser-tool availability depends on the client and session. Follow the [browser assistant workflow](docs/browser-assistant-workflow.md) and [release checks](docs/no-signup-release.md).

Existing scoped access tokens and the deployed AllMCP provider remain backend compatibility features for previously authorized private analyses. Their account management UI is no longer part of this release. Read-only is the default; editing requires an explicit grant. The provider passed real public Helix requests and production discovery checks, but no stored user connection or ChatGPT/Claude conversation has been verified. See [optional assistant integration](docs/assistant-integration.md).

The frontend, local API and hosted adapter share the same dataset and figure schemas. See [hosting](docs/hosting.md) for deployment status and synchronization.

## Still to build

The hosted AlphaGenome RNA-seq path is implemented using the official client through a CPU proxy to Google's service. The owner's `ALPHAGENOME_API_KEY` is still missing, and no actual authenticated inference has been verified; follow [hosted API setup](docs/hosted-api-setup.md). Live Atlas lookup is not connected. The official static AVI archive returned HTTP 500 during earlier verification; no requested DNM1 score was retrieved. Rich Atlas API access and self-hosted predictions require authorized access. No clinical efficacy, disease-risk or whole-organism phenotype probabilities are calculated.

Next stages are verifying an authenticated hosted result, connecting any further Atlas/model outputs, and evaluation against compatible experimental measurements. No separate in-app chat or AllMCP connection is required. The broad DNA Engineering Lab goal is ongoing; this release provides its numerical analysis and figure-generation core.
