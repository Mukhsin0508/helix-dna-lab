# Scientific evidence for the DNM1 replay

This MVP contains one published case replay: `dnm1-splice-replay`. It makes no live AlphaGenome API request and includes no newly calculated variant score. DNA letters come from the public reference genome. The cell, helix, RNA shapes, and motion are educational illustrations rather than measured geometry or molecular trajectories.

## Published case

The AlphaGenome Atlas paper identifies **GRCh38/hg38 chr9:128225994 G>A**, in DNM1 intron 10, with the transcript-based description **NM_004408.4:c.1335+1605G>A**. The studied brain-specific exon 10a is absent from the MANE Select transcript; transcript choice therefore matters. Do not substitute the canonical transcript to draw exon boundaries without checking its exon structure.

The authors report that the variant creates a cryptic splice acceptor upstream of exon 10a, producing a **39-nucleotide, 13-amino-acid in-frame extension**. Their reference/alternate predictions used glutamatergic-neuron and venous-blood biosamples: the blood prediction showed negligible expression of this brain-specific exon. This is a reported model comparison, not a claim that the replay measures living neurons.

The paper also reports minigene reporter experiments across five cell lines supporting alternative splice-site selection, including this variant. Such reporter evidence supports the molecular mechanism; it does not amount to a complete simulation of an individual's disease or establish identical effects in every cell type. We do not reproduce assay procedures or claim that our app performed these experiments.

Primary source: [AlphaGenome Atlas: in silico mutagenesis of the entire human genome improves prioritization and interpretation of non-coding variants](https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/alphagenome-atlas.pdf), main text printed pages 7–8, Figure 3, and Table S4 (printed page 73). The copy examined is `outputs/alphagenome-research/alphagenome-atlas.pdf`, with extracted text beside it. This is the Atlas paper linked by Google's September 8, 2026 announcement; no peer-review status is asserted here.

[Google DeepMind's announcement](https://deepmind.google/blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/) independently summarizes the DNM1 case and experimental validation. Credit belongs to the AlphaGenome Atlas authors and their collaborating research teams, including the GREGoR/Broad/Boston Children's collaborators. This app is an independent educational presentation and is not endorsed by those organizations.

## Reference sequence provenance

Fetched and checked on **2026-09-10**. Both services returned the same 41 bases after converting letter case to uppercase:

```text
CACTTCTCCTCCCCACCCACGGCTGCTCCTCCTCCTGTCCC
```

| Property                               | Value                                                              |
| -------------------------------------- | ------------------------------------------------------------------ |
| Reference assembly                     | UCSC hg38 / Ensembl GRCh38                                         |
| Chromosome                             | chr9 / 9                                                           |
| Displayed strand                       | Forward (+1), 5′ to 3′                                             |
| Display interval, 1-based inclusive    | 128225974–128226014                                                |
| UCSC query interval, 0-based half-open | [128225973, 128226014)                                             |
| Sequence length                        | 41 bases                                                           |
| Selected index, 0-based                | 20                                                                 |
| Selected genomic position, 1-based     | 128225994                                                          |
| Reference → alternate                  | G → A                                                              |
| Uppercase sequence SHA-256             | `60d754747a821bee58143f993ac3c402ab8c8ea4d1b5fbb2476e71b3ae837396` |

Exact provenance URLs:

- [UCSC sequence API](https://api.genome.ucsc.edu/getData/sequence?genome=hg38;chrom=chr9;start=128225973;end=128226014). Response reported hg38, chr9, start 128225973, end 128226014; its download timestamp was `2026:09:10T04:25:39Z`. UCSC returned mixed case for repeat masking; uppercasing preserves nucleotide identity while omitting that mask from the display.
- [Ensembl sequence API](https://rest.ensembl.org/sequence/region/human/9:128225974..128226014:1?content-type=application/json). Response identifier: `chromosome:GRCh38:9:128225974:128226014:1`.
- [Ensembl DNM1 gene lookup](https://rest.ensembl.org/lookup/symbol/homo_sapiens/DNM1?content-type=application/json). Response: `ENSG00000106976`, assembly GRCh38, chromosome 9, strand `1`. This verifies the gene's forward orientation; it is not being used to infer the brain-specific transcript's exon coordinates.

The 41-base window is for inspecting the selected DNA letter. It does **not** encompass the whole exon extension or the long genomic context used by AlphaGenome. It cannot, on its own, reproduce a model result. Any RNA-splicing illustration must be labeled schematic and must not imply its spacing or timing was measured.

## Replay boundary

- The sourced result applies only to the default experiment, index 20, alternate A, with the stored reference G.
- Selecting a different base or alternative letter is an **unscored edit**. Do not display the 13-amino-acid outcome as a prediction for it.
- Replay progress is animation progress, not a prediction confidence, biological clock, RNA abundance, or disease probability.
- The MVP does not ingest personal genomes or issue medical conclusions.

Verification checks: both reference services agreed byte-for-byte after uppercase normalization; length is 41; every character is A/C/G/T; index 20 is G; the alternate is A; index-to-genome mapping gives 128225994. The TypeScript object conforms to the existing `ExperimentDefinition` interface without changing that interface.
