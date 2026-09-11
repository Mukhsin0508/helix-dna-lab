# Junction analysis release · 11 September 2026

Public deployment: `https://helix-dna-lab.higgsfield.app/`, cloud revision `7b6490f`.

## Delivered workflow

Import a `kind: "junctions"` analysis JSON, select a track, compare reference/alternate arcs, inspect exact table values, and export SVG, PNG, selected scalar CSV or a complete reimportable analysis JSON. Both alleles share a linear width scale per track. Numeric zero and absent/null values have different marks. Viewport clipping retains original genomic endpoints and shows continuation markers. Display limits follow dataset order and do not truncate CSV selection.

The prepared model runner also supports an exclusive `--outputs SPLICE_JUNCTIONS` mode. It preserves returned coordinates, matrices, metadata, source indices and missing metadata cells. Alignment uses full junction and track identity, with reference order followed by alternate-only records explicitly recorded. Default positional output is unchanged. This adapter has not run an AlphaGenome checkpoint.

## Verification

- 108 TypeScript tests passed, including junction schema/metadata validation, exact exports, SVG geometry, shared scaling, allele absence and both API adapters' persistence/revision behavior.
- The Zod record validation compatibility adjustment passed its 14 service-import tests and the TypeScript check. This permits the same source to typecheck with local Zod 3 and hosted Zod 4.
- 27 Python tests passed with NumPy and pandas available, without skips. These include actual matrix extraction boundaries, sparse metadata, preserved row order and round trips through the real TypeScript importer for both supported DNM1 variants.
- Local production build and hosted client/server production build passed. The hosting sandbox build used Node 22 and the existing Bun lockfile; production dependencies were not changed.
- Local browser checks at 1440×1000 and 390×844 passed import, shared scaling, zero/missing markers, crossing endpoints, table display, save/reload and four export formats, with no page errors or horizontal document overflow.
- The same public browser checks passed without saving the synthetic fixture. SVG/CSV/JSON retained the full off-viewport endpoint and the high-precision supplied value; PNG had a valid image signature.
- The existing public DNM1 record `f838024b-593d-4555-9b81-599df07eca55` loaded in an isolated browser and returned all 12 experimental rows from D1. `chr9:128226027:G>A` retains the printed measured value `0.94`, with replicate count and standard error unknown. It is not a model prediction.

Repeat local browser checks with `npm run test:junction-browser` against the running server. Use `QA_BASE=https://helix-dna-lab.higgsfield.app npm run test:junction-browser` for an unsaved public draft. Generated checks and screenshots are kept in ignored `qa-junctions/`.

## Remaining scientific checks

No model weights were loaded, GPU started, new scientific junction values produced or live model service connected in this release. Synthetic fixtures test software only. The first actual model result must be imported, inspected and saved/reopened on the public site when the authorized run is available. Imported provenance remains source-reported rather than proof of model execution. Model signals are not disease risks, vaccine efficacy or clinical success probabilities.
