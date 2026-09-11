# Analytical lab: data, capabilities and interpretation

Verified against official sources on 2026-09-11. The lab can organize, filter, compare and export supplied molecular predictions. Its initial dataset is a real, historical AlphaGenome notebook output. Loading this dataset does not run AlphaGenome or query Atlas.

## Initial numerical dataset

Google DeepMind's [batch variant scoring notebook](https://github.com/google-deepmind/alphagenome/blob/main/colabs/batch_variant_scoring.ipynb) publishes a complete interactive table in cell 7. We extracted its 524 rows without executing notebook JavaScript or model code. The upstream execution metadata is dated **2025-07-21**; it is not a verified publication date. Model and annotation versions are not recorded.

| Variant, human GRCh38/hg38 | Rows |
| --- | ---: |
| chr3:58394738:A>T | 64 |
| chr8:28520:G>C | 50 |
| chr16:636337:G>A | 202 |
| chr16:1135446:G>T | 208 |

Every row concerns **T-cells, CL:0000084**. Rows represent variant–track or variant–gene–track combinations, not independent variants. This fixture contains no DNM1 scores, AVI scores, ref/alt coverage arrays, personal-genome predictions or experimentally measured outcomes. Missing tissues and modalities must remain missing.

Files under `data/atlas/`:

- `published-tcell-scores.source.json`: original upstream scoring and output cells.
- `published-tcell-scores.json`: original column names and full numerical precision.
- `published-tcell-scores.normalized.json`: the UI row contract below.
- `published-tcell-scores.provenance.json`: source URLs, timestamps, hashes, assembly, provenance and limitations.

Normalized rows contain `variant`, `biosample`, `modality`, `score`, `quantile`, `scorer`, `unit`, `signed`, `track`, `trackStrand`, `assay`, `sourceRowIndex` and `scoredInterval`. Gene, gene ID, gene strand and histone mark are optional. `score` is the original raw score; `quantile` is the original empirical quantile. Extraction unwrapped table values and changed source NaN entries to JSON null. It did not recalculate predictions.

## Meaningful charts

Preserve **scorer + track + strand** when comparing raw scores. Modality alone is insufficient: the fixture's 488 `RNA_SEQ` rows include **486 gene-expression rows and two polyadenylation rows**.

| Supplied scorer | Raw score meaning | Chart use |
| --- | --- | --- |
| ATAC/DNASE center mask | Signed log2 ratio of summed predictions with a +1 pseudocount; 501-bp mask | Compare supplied variants within one assay/track. |
| Histone center mask | Same log2 ratio; 2001-bp mask | Compare within one histone mark/track. |
| GeneMaskLFCScorer | Signed difference of log mean exon signal, with +0.001 pseudocount | Compare named genes within one assay; retain gene and strand. |
| GeneMaskSplicingScorer | Maximum absolute splice-site usage difference across a gene | Unsigned magnitude chart; it does not reveal gain versus loss. |
| PolyadenylationScorer | Maximum absolute log-fold change of proximal/distal isoform ratios | Separate unsigned chart; never label it gene-expression fold change. |

These descriptions follow the [official scoring guide](https://www.alphagenomedocs.com/variant_scoring.html) and [scorer definitions](https://github.com/google-deepmind/alphagenome/blob/main/src/alphagenome/models/variant_scorers.py). They do not establish the exact historical server implementation. No active-allele scorers are present in this fixture. Active-allele scores, when imported, describe activity rather than ALT-minus-REF effects.

The simplest default is **ATAC**, which supplies four comparable variant rows. A useful gene view selects `GeneMaskLFCScorer(requested_output=RNA_SEQ)` and one track, such as `CL:0000084 polyA plus RNA-seq`. Retain strand and gene labels. Ranking by absolute raw score is a view transformation, not additional biological evidence. Do not sum unlike raw scores into a universal impact score.

Quantiles describe relative extremeness within the scorer/track background. They are not AVI PHRED, confidence intervals or disease probabilities. A cross-modality quantile display must retain scorer labels and clarify that it compares relative ranks, not common biological units. Use raw scores to describe effect direction and magnitude. Do not turn scalar scores into invented genomic coverage curves.

## Coordinates and imports

Variant positions are **1-based**, matching the notebook's `POS` input. AlphaGenome intervals are **0-based, half-open**. Thus chr9:128226027:G>A refers to interval `[128226026, 128226027)` on chr9. That variant is not in this fixture.

Require assembly and alleles with each imported variant. Do not silently reinterpret hg19 as hg38, swap REF/ALT, or infer a missing score as zero. Retain the source's exact scorer, track, assembly and version metadata. The [official FAQ](https://www.alphagenomedocs.com/faqs.html) documents these conventions and the distinct raw/quantile scales.

## Atlas lookup, new inference and access

Atlas already provides precomputed variant/region queries, AVI, molecular scores and feature attributions. Its [Python client](https://www.alphagenomedocs.com/api/generated/alphagenome.atlas.atlas.AtlasClient.html) accepts an API key and supports variant lists, intervals, gene filters and tissue ontology filters. These hosted lookups need no local GPU. New sequence, haplotype or ref/alt track predictions use the separate AlphaGenome model API; they are not generated by the static example viewer.

The [official downloads page](https://alphagenome.google/downloads) lists a permissively licensed static AVI SNV ZIP. Richer Atlas API data and model outputs have different terms from the permissive AVI artifact. Treat this notebook fixture as a noncommercial research example under the [AlphaGenome terms](https://deepmind.google.com/science/alphagenome/terms); preserve Google DeepMind attribution.

### Access recheck: 2026-09-11, Asia/Almaty

These checks ran on 2026-09-10 UTC, corresponding to 2026-09-11 locally. No credentials were supplied, terms accepted or model predictions requested.

| Access path | Observed result |
| --- | --- |
| Downloads page | HTTP 200, redirecting to `deepmind.google.com/science/alphagenome/downloads`. |
| [Published AVI ZIP](https://deepmind.google.com/science/alphagenome/_/download/atlas/avi_scores_snvs_tabix.zip), HEAD at 23:25:39 UTC | HTTP 500 from `UploadServer`. |
| Same ZIP, GET `Range: bytes=0-255` at 23:26:43 UTC | HTTP 500; only a 21-byte `Internal Server Error` response was received. No ZIP, Tabix index or score data was obtained. |
| Official Atlas `ListVariantScoresMetadata`, human organism 9606, at 23:30:17 UTC | Anonymous request returned gRPC status 7, `PERMISSION_DENIED`, requiring an API key or established caller identity. HTTP 200 was the gRPC transport status, not successful data access. |

The ZIP failure does not establish an authentication requirement for that public artifact. The API failure does establish that the tested anonymous metadata request is denied. The [official client implementation](https://github.com/google-deepmind/alphagenome/blob/main/src/alphagenome/atlas/atlas.py) sends the API key to `gdmscience.googleapis.com:443`; its [public service definition](https://github.com/google-deepmind/alphagenome/blob/main/src/alphagenome/protos/atlas_service.proto) documents the metadata, variant and interval methods. An authorized Atlas API key, an authentic export, or restoration of the public download route remains necessary to obtain actual Atlas scores here.

The [Atlas technical report](https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/alphagenome-atlas.pdf), Code Availability section, says AVI model code and weights will be provided upon final publication. Running the separate base AlphaGenome checkpoint therefore does not by itself reproduce an official AVI score.

### Exact DNM1 observation and coordinate caution

The same [technical report, Table S4](https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/alphagenome-atlas.pdf) reports an alternative 3′ splice-site selection rate of **0.94** for **chr9:128226027:G>A**. This is a published experimental splicing measurement associated with the screen in Figure 3D. It is not an AVI score, a model quantile, a clinical probability or a fresh Atlas response. It is documented here as a literature observation and has not been added as a model-score row to the initial dataset.

The paper's main-text **AVI PHRED 24.7** and **69% splicing attribution** concern **chr9:128225994:G>A**, a different variant 33 bases away. Neither number can be assigned to chr9:128226027:G>A. No live Atlas numerical result for the requested variant was obtained in this recheck.

## Useful analytical generators

### Delivered result-import bridge

`npm run import:gpu-result -- --input first-prediction.json --output-dir NEW_DIRECTORY` converts the delivered GPU service's raw result into an importable analysis bundle. It preserves every supplied numeric bin, the raw result bytes and SHA-256, track units, strand, tissue scope, bin size, model revisions and source-reported input context. Unknown units and strand remain unknown. The raw artifact must be kept alongside the analysis JSON; uploading the analysis does not upload that separate artifact.

This converter supports only the delivered service contract for **chr9:128225994:G>A**. It does not execute inference, obtain Atlas data, or support the requested chr9:128226027:G>A by relabelling a nearby result. A completed, authentic service result is still required. See [the import instructions](../inference/README.md#import-a-completed-gpu-service-result-into-the-analytical-lab) for format details.

The workspace renders declared genomic bins across their full half-open intervals and leaves gaps empty. Metadata-free imports display points rather than inventing interpolated coverage. Source details survive API persistence and appear in the figure/source drawer and complete JSON/SVG exports.

Validation on 2026-09-11: 77 automated tests and the production build passed. A synthetic local browser-only case verified 128-base bin widths, a missing interval, unknown unit/strand, tissue-agnostic labels, and save/reload. It was not published as scientific data. The production update restored the existing saved ATAC matrix without new browser errors.

The lab can generate filtered score tables, comparable-score figures, evidence summaries, saved query manifests and reproducible exports from supplied data. Each result should preserve source rows and distinguish a researcher's hypothesis from a model prediction or independent observation. A missing-data report can identify which tissues, modalities or variants need an authenticated lookup or targeted inference next.

Atlas and AlphaGenome predict molecular effects. They do not supply vaccine efficacy, treatment success, personal disease risk or clinical outcome probabilities. An analytical generator should produce reviewable research evidence and clearly specified next analyses, without inventing those outcomes. The [Atlas launch announcement](https://deepmind.google/blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/) and [technical report](https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/alphagenome-atlas.pdf) describe the resource's molecular scope and research limitations.
