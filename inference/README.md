# Local AlphaGenome DNM1 runner

Run an explicitly selected DNM1 variant against an authorized local checkpoint and export actual reference/alternate positional tracks or splice junctions for Helix. **Full-model inference has not run or been validated on a GPU in this task.** The runner, reference checks and import contract are preparation for that first real run.

The two supported cases are `chr9:128225994:G>A` and the user's requested **`chr9:128226027:G>A`**. `--variant` is required. Each case has its own independently retrieved full-context hash, reference excerpt and coordinates in [data/reference](../data/reference/README.md). Changing the result label cannot change the underlying reference case.

## Environment and authorized files

The [official research README](https://github.com/google-deepmind/alphagenome_research#model-requirements) recommends at least an NVIDIA H100. One H100 80 GB is our first-test configuration, not a demonstrated minimum. Use Linux with Python 3.12; inspect the driver and follow the current [JAX GPU installation instructions](https://docs.jax.dev/en/latest/installation.html#nvidia-gpu). Confirm `jax.devices()` contains an NVIDIA GPU.

Use these official sources and retain the actual installed revisions:

| Component | Source and expected pin |
| --- | --- |
| Model implementation | [alphagenome_research](https://github.com/google-deepmind/alphagenome_research), `0db53bd4352c66d1e00a049a81da373a066e6670` |
| Client/data classes | [alphagenome](https://github.com/google-deepmind/alphagenome), `aa6fc8f6faadcb8c910fa2b85b57386fbd5c7b5d` |
| All-folds checkpoint | [google/alphagenome-all-folds](https://huggingface.co/google/alphagenome-all-folds), `a8f293a76ee73d5b57f3bf2ae146510589fcf187` |

The checkpoint must be obtained through authorized access under the applicable [model terms](https://deepmind.google.com/science/alphagenome/model-terms). The runner does not download weights, sign in, accept terms, provision a GPU or expose a server. Pass the Orbax/OCDBT snapshot root, including its metadata, manifest and tensor shards.

Supply these official files locally:

- [GRCh38.p13 FASTA](https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa) and its [FAI index](https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa.fai).
- [GENCODE v46 GTF Feather](https://storage.googleapis.com/alphagenome/reference/gencode/hg38/gencode.v46.annotation.gtf.gz.feather).
- [GENCODE v46 splice starts](https://storage.googleapis.com/alphagenome/reference/gencode/hg38/gencode.v46.splice_sites_starts.feather) and [splice ends](https://storage.googleapis.com/alphagenome/reference/gencode/hg38/gencode.v46.splice_sites_ends.feather).

The annotation paths are required even for RNA-only output: this pinned `predict_variant` implementation computes junction intermediates internally. Supplied `OrganismSettings` do not inherit omitted defaults. The runner explicitly supplies these paths and hashes their local bytes; it does not independently authenticate annotation file origin. No PAS or variant-calibration file is used. Source-level compatibility still requires a real GPU test.

## Run the requested case

From the repository root, with an existing output directory:

```sh
python inference/run_dnm1.py \
  --variant 'chr9:128226027:G>A' \
  --checkpoint /absolute/path/to/authorized-hf-snapshot \
  --fasta /absolute/path/to/GRCh38.p13.genome.fa \
  --gtf /absolute/path/to/gencode.v46.annotation.gtf.gz.feather \
  --splice-site-starts /absolute/path/to/gencode.v46.splice_sites_starts.feather \
  --splice-site-ends /absolute/path/to/gencode.v46.splice_sites_ends.feather \
  --output /absolute/path/to/results/dnm1-analysis.json
```

The default exact biosample is `glutamatergic neuron`. Default outputs are `RNA_SEQ`, `SPLICE_SITES` and `SPLICE_SITE_USAGE`; `--outputs RNA_SEQ` explicitly narrows the request. The runner resolves actual ontology identifiers from loaded metadata and checks compatible RNA/usage biosamples. Missing metadata fails rather than substituting another tissue. Splice-site tracks remain tissue independent.

The full model input is 1,048,576 bases. The local extracted context, reference allele and independent 41-base excerpt must match the selected descriptor before every prediction. The installed official interval classes must reproduce the verified coordinates. Both species' metadata are retained for checkpoint shape validation while only human reference resources are needed.

`ModelRunner` loads the actual checkpoint once and can serve serial requests. Every call constructs its own variant and intervals and validates its full reference context; a previous request's variant is never reused. Metadata discovery can inspect all output types, while prediction still requires an exclusive junction or positional mode. `modelLoadSeconds` records the separate one-time load, and `durationSeconds` includes the current request's validation, inference and serialization. The CLI remains compatible and uses this same path.

For positional outputs, default `--crop-bp 41` is applied after full-context inference. The requested window and all returned biological tracks must fit 5000 rows and 2 MiB. Larger explicit crops are allowed only within those limits; oversized results fail rather than being truncated, downsampled or silently losing tracks. REF and ALT metadata, dimensions, coordinates and finite values are checked.

## Splice-junction output

Request `SPLICE_JUNCTIONS` alone, using the same checkpoint/reference/annotation arguments:

```sh
python inference/run_dnm1.py \
  --variant 'chr9:128226027:G>A' \
  --checkpoint /absolute/path/to/authorized-hf-snapshot \
  --fasta /absolute/path/to/GRCh38.p13.genome.fa \
  --gtf /absolute/path/to/gencode.v46.annotation.gtf.gz.feather \
  --splice-site-starts /absolute/path/to/gencode.v46.splice_sites_starts.feather \
  --splice-site-ends /absolute/path/to/gencode.v46.splice_sites_ends.feather \
  --outputs SPLICE_JUNCTIONS \
  --crop-bp 32768 \
  --output /absolute/path/to/results/dnm1-junctions.json
```

Junction mode defaults to a 32,768-base centered display if `--crop-bp` is omitted. Its explicit crop may extend up to the full verified input. The 5000-row limit counts **aligned junctions × tracks**, not display bases; both raw and analytical files must fit 2 MiB. Junction and positional outputs cannot share one run/dataset.

The [pinned `JunctionData` class](https://github.com/google-deepmind/alphagenome/blob/aa6fc8f6faadcb8c910fa2b85b57386fbd5c7b5d/src/alphagenome/data/junction_data.py) provides a junctions × tracks matrix, track metadata and genomic junction objects. The [research converter](https://github.com/google-deepmind/alphagenome_research/blob/0db53bd4352c66d1e00a049a81da373a066e6670/src/alphagenome_research/model/dna_model.py) obtains absolute junction coordinates from the [official unstacker](https://github.com/google-deepmind/alphagenome_research/blob/0db53bd4352c66d1e00a049a81da373a066e6670/src/alphagenome_research/model/variant_scoring/splice_junction.py). These returned `start`/`end` values are already zero-based and half-open. The exporter copies them without another offset or strand reversal.

Every returned arc overlapping the display is retained, including arcs whose endpoints extend outside it; both endpoints must remain inside the verified model input. No signal threshold, normalization or rounding is applied. REF and ALT are aligned by chromosome, start, end, strand and original track identity, independently of matrix order. Same-named tracks require identical original metadata. A junction/track absent from one allele remains **null**; a returned numeric zero remains **zero**. If neither allele supplies any overlapping junction, the runner fails clearly instead of manufacturing an empty scientific result.

Junction strands belong to each arc. Original track metadata is strand agnostic in the pinned implementation; absent strand/units remain null, while actual biosample identifiers and names remain attached to each track. The [pinned human metadata](https://github.com/google-deepmind/alphagenome_research/blob/0db53bd4352c66d1e00a049a81da373a066e6670/src/alphagenome_research/model/metadata/OutputMetadataResponse_ORGANISM_HOMO_SAPIENS.textproto) includes `glutamatergic neuron` (`CL:0000679`). Its `Brain_Cortex` GTEx track instead belongs to `frontal cortex` (`UBERON:0001870`); `--biosample 'frontal cortex'` also retains that biosample's separate ENCODE total-RNA track. These biosamples are distinct. Native junction values are not splice-site usage or an experimentally measured alternative-splicing fraction.

## Files returned

`--output dnm1-analysis.json` writes two new files:

- **`dnm1-analysis.json`** — `kind: "tracks"` for positional output, or `kind: "junctions"` for junction mode, accepted directly by the website's JSON import. It preserves supplied values, track identity, units, tissue scope and the appropriate genomic coordinates.
- **`dnm1-analysis.source-result.json`** — original cropped matrices and metadata, exact variant/context, annotation hashes, model/package metadata and runtime provenance. The analytical file records the SHA-256 of these exact sidecar bytes.

Keep both files. Existing files are never overwritten; validation completes before writing and a partial write is cleaned up. The operator should retain the complete successful environment and GPU benchmark separately.

In junction mode the raw sidecar retains the selected matrices in their original row/column order, unclipped junction objects, original track records and DataFrame indices, source junction row indices, full returned junction counts, numeric dtype and `uns`. Missing pandas metadata cells become JSON null; finite numerical metadata retains its precision. It includes checksummed pinned source references describing the format. Those raw matrices contain all display-overlapping junctions, not the entire model output outside the display. This selection is explicit in the sidecar; the full model inference still preceded it.

Normalized junction rows group tracks in REF metadata order followed by ALT-only tracks. Within each track, junctions retain REF order followed by ALT-only junctions. The analytical transformation records this join order; the raw sidecar retains each allele's independent original order.

Installed package VCS metadata is recorded when available; absent revisions are explicitly `Not reported`. Expected pins are not promoted to verified revisions. Checkpoint metadata/manifest hashes do not verify every tensor or prove its origin. The verified full input-context hash is distinct from a whole-genome FASTA hash, which remains unavailable. Importing a file does not independently prove that a GPU produced it.

These outputs do not contain Atlas AVI. Positional splice-site usage cannot stand in for a junction score. No clinical probability, measured splice rate, amino-acid extension or organism phenotype is inferred from either output mode.

## Legacy GPU service converter

The [corrected private service](service/README.md) now reuses this runner and returns the directly importable analysis plus exact raw JSON. It has offline tests and an operator client, but no verified live endpoint or GPU result. The following converter is only for the older attachment format.

The original GPU agent's separate `v0.1.0-preflight` contract returns a raw `PredictionResult`. If a corrected service produces an actual result in that shape:

```sh
npm run import:gpu-result -- \
  --input /absolute/path/to/first-prediction.json \
  --output-dir /absolute/path/to/new-analysis-bundle
```

The new directory receives a byte-for-byte raw copy, an analysis JSON and a provenance README. The converter now accepts either verified DNM1 variant only when all reference/crop/hash fields match that exact case. Tissue scope and original metadata must agree; units and absent strands remain null. Source-reported annotation settings are retained in the raw artifact. No model execution, normalization, aggregation or upload occurs.

The original attachment caches the old variant during initialization and echoes the request label. **Do not relax only its request schema.** Its inference input, reference context, response and cache key all need to derive from the same selected descriptor. See [the delivery review](../docs/gpu-delivery-status.md).

The converter rejects queued job envelopes, unsupported variants, junction arrays, Atlas scores and the new runner's raw sidecar format. The new runner already creates a directly importable analysis; it needs no legacy conversion.

## Offline verification

From the repository root, after `npm ci` (the Python suite invokes the real TypeScript importer for a format round-trip):

```sh
python3 -m unittest discover -s inference -p 'test_*.py' -v
python3 inference/run_dnm1.py --help
npx tsx --test tests/model-result-import.test.ts
npm run build
```

Tests use explicitly synthetic numbers to check format, alignment, exact value preservation, both reference descriptors, mixed-variant rejection, missing metadata, size limits and partial-write behavior. Junction tests additionally cover reordered alleles/tracks, null versus zero, both strands, full crossing endpoints and the actual TypeScript importer. A NumPy/pandas extraction-boundary test runs when those packages are installed. Nested service tests explicitly skip when their optional API dependencies are absent; install `service/requirements.txt` to run them. Lifecycle tests spy on the model boundary to check one-time loading and repeated per-request validation. They do not load real JAX, access a checkpoint, benchmark GPU memory or validate predictive accuracy. The next scientific check is the actual run in the [GPU execution prompt](../docs/higgsfield-gpu-execute.txt).
