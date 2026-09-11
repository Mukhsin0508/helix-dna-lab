# DNM1 benchmark feasibility

Verified 2026-09-11 against the [official AlphaGenome Atlas technical report](https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/alphagenome-atlas.pdf), linked from the [September 8 launch announcement](https://deepmind.google/blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/).

**Go:** import the 12 published Table S4 measurements for a measured-only table or dot plot. **No-go:** a matched prediction-versus-measurement scatter, agreement line, correlation or locally reproduced model benchmark from the available artifacts.

## Preserved numerical evidence

Files are under [data/experimental](../data/experimental/):

- `dnm1-table-s4.measurements.json` and `.csv`: all 12 Table S4 rows, original variant identifiers, reported rate strings, exon-extension lengths, amino-acid sequences and source status labels. No per-variant prediction is supplied.
- `dnm1-table-s4.source.txt` and `.source-page.png`: extracted source text and a visually checked rendering of the complete table on page 73.
- `dnm1-table-s4.provenance.json`: source URL, whole-PDF hash, extraction method, source pages and file hashes.
- `extract-dnm1-table-s4.py`: reproducible extraction from the exact local PDF version; it rejects a different source hash and performs no network or model calls.

| GRCh38 variant | Published mean alternative 3-prime splice-site rate |
| --- | ---: |
| chr9:128226027:G>A | 0.94 |
| chr9:128226009:T>A | 0.78 |
| chr9:128225997:T>A | 0.69 |
| chr9:128225994:G>A | 0.76 |
| chr9:128225989:C>G | 0.79 |
| chr9:128225964:G>A | 0.22 |
| chr9:128225946:G>A | 0.60 |
| chr9:128225941:C>G | 0.84 |
| chr9:128225932:T>G | 0.18 |
| chr9:128225925:C>A | 0.16 |
| chr9:128225919:C>A | 0.52 |
| chr9:128225898:C>A | 0.53 |

These are selected in-frame exon-extension variants, not the full screened population. The requested `chr9:128226027:G>A` is distinct from `chr9:128225994:G>A`; their measured rates are 0.94 and 0.76 respectively. The paper's main-text AVI PHRED 24.7 belongs to the latter variant and measures a different quantity.

## Assay, units and uncertainty

The measurement is a unitless read fraction from a minigene reporter splicing assay, displayed on a 0-1 scale. The quantification counts qualifying alternative junction outcomes within the upstream intron relative to all downstream-exon reads. Figure 3D and the methods describe averaging valid replicates within each retained condition, then averaging across five retained cell-line/promoter combinations; the figure caption calls these five cell lines. Do not label this aggregate as a measurement in glutamatergic neurons.

The methods report three biological replicates per condition and require at least two valid replicates per retained element. Table S4 supplies neither their individual values nor per-row valid counts, dispersion, standard errors or confidence intervals. `null` marks those missing quantities in the transcription. The printed rates have two decimal places; more precise values or error bars cannot be reconstructed from them. Source: quantification methods page 44, Figure 3D caption page 9 and Table S4 page 73.

## Why the available predictions cannot form a matched scatter

Figure S9B/C shows model-predicted RNA-seq and splice-site-usage tracks for three variants, including the requested one, in glutamatergic neuron and venous-blood contexts. Those plotted tracks are neither exact exported numerical arrays nor the same aggregated reporter readout as Table S4. No values have been estimated from plot pixels.

Figure S9E evaluates active/inactive classification across the experimental screen. It prints AP values for AVI, merged splicing and comparison models, but supplies no per-variant prediction table or replicate uncertainty. The merged splicing score combines model outputs on its own scale; AVI and its feature attributions also have different units from the measured reporter fraction. Equal 0-1 bounds would not establish equal biological meaning. The 12 selected positive examples cannot reproduce the full-screen AP or provide an unbiased calibration dataset.

Page 77 names **Data S1** as the experimental screen data across cell lines. The checked PDF contains no embedded attachments or external link on that page, and the launch announcement and targeted primary-source search did not expose a downloadable Data S1 artifact. This is a bounded retrieval finding, not a claim that the data does not exist. No archive/API probes or authenticated requests were repeated for this review.

## Requirements for a defensible comparison

Obtain the authentic Data S1 rows, replicate/condition identities, counts and filtering metadata, plus numerical predictions for those exact alleles. Join using assembly, chromosome, 1-based position, REF and ALT, then verify transcript, junction and assay context. Preserve replicate structure and show actual uncertainty only when it is supplied or can be calculated from authentic replicates.

For a same-output agreement analysis, define and justify a model readout corresponding to the measured fraction before computing errors or drawing an identity line. Otherwise, use explicitly labeled association/ranking analysis between different quantities, including the full eligible variant population and documented exclusions. None of these measurements or classification metrics represents a patient's outcome probability.
