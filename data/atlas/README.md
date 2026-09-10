# Published AlphaGenome numerical example

`published-tcell-scores.json` contains 524 actual numerical rows extracted from Google DeepMind's public `batch_variant_scoring.ipynb`, cell 7. `published-tcell-scores.source.json` preserves the original upstream input/scoring cell and complete output cell. Provenance, hashes, semantics and limitations are in `published-tcell-scores.provenance.json`.

`published-tcell-scores.normalized.json` provides the UI contract: `variant`, `biosample`, `modality`, `score`, `quantile`, `scorer`, `unit`, `signed`, `track`, plus source row and optional gene metadata. Raw score and quantile values are unchanged. Filter by scorer and track: RNA_SEQ contains 486 gene-expression rows and two distinct polyadenylation rows.

This is a published historical model-output snapshot. It is not live inference, not Atlas AVI, and does not contain the requested DNM1 variant. The upstream execution metadata is dated 2025-07-21. Use the supplied variant IDs and tissue label in every view. Missing modalities or tissues must remain missing.

The four variants are chr3:58394738:A>T, chr8:28520:G>C, chr16:636337:G>A, and chr16:1135446:G>T (human GRCh38, positions 1-based). Every row is for T-cells (CL:0000084). Scores span ATAC, DNASE, CHIP_HISTONE, SPLICE_SITE_USAGE, and RNA_SEQ; the 524 rows include multiple gene/track scores, not 524 independent variants.

A chart can compare signed quantile scores across supplied variant/scorer combinations, while retaining raw score, gene, track and scorer definitions in details. Raw scores from different scoring methods are not interchangeable. Quantiles are not disease probabilities. Do not represent these scalar values as genomic coverage tracks.

Source: https://github.com/google-deepmind/alphagenome/blob/main/colabs/batch_variant_scoring.ipynb
Documentation: https://www.alphagenomedocs.com/colabs/batch_variant_scoring.html
Output terms: https://deepmind.google.com/science/alphagenome/terms
