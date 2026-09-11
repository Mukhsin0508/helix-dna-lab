# Experimental measurement release — 2026-09-11

This release adds measured-data figures to the analytical workspace. It does not connect AlphaGenome inference or claim model accuracy.

## Source

The curated example contains the 12 selected DNM1 variants in Table S4, page 73, of the official AlphaGenome Atlas technical report. The extraction script, exact printed numbers, source-page image and PDF checksum are retained in `data/experimental/`. See `dnm1-benchmark-feasibility.md` for assay scope and limitations.

The requested `chr9:128226027:G>A` has a reported mean alternative 3-prime splice-site selection rate of 0.94. The separate `chr9:128225994:G>A` has 0.76. Neither number is an AVI score. Unknown per-row replicate counts and standard errors remain null. No prediction correlation is calculated.

## Validation

- Production build and TypeScript checks pass.
- All 89 automated tests pass, including local SQLite and cloud D1 API contracts, physical measurement ranges, exact reported values, missing uncertainty, persistence and incompatible figure settings.
- Local browser: loaded all 12 measurements, selected the exact requested variant, edited the figure title, saved, reloaded and confirmed the same filter, title and 0.94 value.
- The source drawer describes the minigene assay, five-condition aggregation, missing uncertainty and original PDF location and checksum.
- UI rendering checks cover source ordering, supplied-error-only bars, CSV/JSON export fields and mobile/desktop markup.
- Browser SVG export: downloaded `helix-figure.svg` and parsed its metadata. The title, exact variant, source PDF hash, endpoint, conditions, aggregation and replicate policy are retained.
- Cloud commit `5df54ad` deployed successfully to `helix-dna-lab.higgsfield.app`. In the public mobile browser, opened DNM1 measurements, edited the title, saved to D1 and reloaded the same 12 measurements and title. No browser errors were observed.
- Public saved analysis: https://helix-dna-lab.higgsfield.app/?analysis=f838024b-593d-4555-9b81-599df07eca55

## Remaining access requirement

In the owner's Chrome account, the official Atlas `Start exploring` action opens `Complete profile`, followed by a Terms of Service step. The owner has been asked to complete these steps. No profile was filled, terms accepted, key requested or model job run by this release. The site and measured-data figures can be used independently of that access.
