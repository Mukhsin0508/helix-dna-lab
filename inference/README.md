# Local AlphaGenome DNM1 smoke test

This CLI loads a previously authorized **local** official checkpoint, runs `predict_variant` for hg38 `chr9:128225994 G>A`, and writes cropped reference/alternate RNA-seq tracks. It does not download weights, sign in, accept terms, expose a server, or modify the lab. It is a smoke-test scaffold; **full-model inference has not been run or validated here**. The user’s GPU agent owns that next step.

## Hardware and environment

- The [official research README](https://github.com/google-deepmind/alphagenome_research#model-requirements) recommends at least an NVIDIA H100. **One H100 80 GB** is a sensible first test configuration, not a demonstrated absolute minimum. No numerical self-host host-RAM or disk minimum is published in the checked README/model card.
- The research package declares Python >=3.11, but current JAX 0.11.1 requires >=3.12. Use **Linux with Python 3.12 or 3.13** for this setup.
- [JAX's NVIDIA instructions](https://docs.jax.dev/en/latest/installation.html#nvidia-gpu) recommend CUDA 13 pip wheels with driver >=580. CUDA 12 wheels are an alternative for driver >=525. Check the actual host driver before choosing; installing the research package alone does not ensure GPU-enabled JAX.
- Public [HF metadata](https://huggingface.co/api/models/google/alphagenome-all-folds?blobs=true) totals **734,799,353 bytes** for the pinned snapshot below, about 701 MiB. This is serialized download size, not runtime RAM/VRAM. Reference FASTA, dependencies, caches, and compilation need additional space.

Example setup commands for the GPU agent, not run by this task:

```sh
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
git clone https://github.com/google-deepmind/alphagenome_research.git
git -C alphagenome_research checkout 0db53bd4352c66d1e00a049a81da373a066e6670
python -m pip install -e ./alphagenome_research
python -m pip install --upgrade 'jax[cuda13]'
python -m pip check
python -c 'import jax; print(jax.devices())'
```

Use `jax[cuda12]` instead when appropriate for the host. These commands pin the researched AlphaGenome code, not a fully tested dependency lock; retain `pip freeze` after the GPU smoke test succeeds.

## Required files and provenance

1. Obtain access through the official [HF all-folds model page](https://huggingface.co/google/alphagenome-all-folds), accepting applicable terms yourself. Download model ID **`google/alphagenome-all-folds`**, revision **`a8f293a76ee73d5b57f3bf2ae146510589fcf187`**, through your authorized HF tooling. The alternative official source is [Google AlphaGenome on Kaggle](https://www.kaggle.com/models/google/alphagenome), model handle `google/alphagenome/jax/all_folds`; this runner's provenance defaults to the pinned HF snapshot, so use HF for this exact test.
2. Preserve the Orbax/OCDBT directory: `_CHECKPOINT_METADATA`, `_METADATA`, `manifest.ocdbt`, `d/`, and `ocdbt.process_0/`. Pass the snapshot root, not one tensor shard. The official `dna_model.create` loads this format directly.
3. Supply the official [GRCh38.p13 FASTA](https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa) and matching [FAI index](https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa.fai) as local files. Do not relabel a 41-base FASTA as chromosome 9. This runner uses actual chromosome coordinates and a 1,048,576-base context.

The downloadable checkpoint is governed by [non-commercial model terms](https://deepmind.google.com/science/alphagenome/model-terms). Self-hosting on Higgsfield does not remove those restrictions. Commercial permission is a separate dependency. No model has been downloaded or terms accepted by this task.

## Run and inspect

From this directory, after the required files are present:

```sh
python run_dnm1.py \
  --checkpoint /absolute/path/to/authorized-hf-snapshot \
  --fasta /absolute/path/to/GRCh38.p13.genome.fa \
  --output /absolute/path/to/dnm1-rna-neuron.json
```

Default biosample is the exact `glutamatergic neuron` name. Its ontology ID is resolved from the installed model's actual RNA-seq metadata. `--biosample 'venous blood'` runs a separate comparison if that name exists. Missing biosamples fail rather than substituting another tissue. Default output crop is 4096 bp, with unchanged values and all returned track metadata; no normalization or rounding of values. The two species' metadata remain present for checkpoint-shape validation, while only the human local FASTA is loaded. This RNA-only test requests no GTF, reference splice-site annotation, calibration table, or Atlas AVI score.

Result JSON contains `sourceKind: model_inference`, full input coordinates and hash, crop coordinates, per-track metadata, two value matrices, package versions, GPU name, runtime, and checkpoint metadata hash. It records expected repository revisions without pretending a metadata hash proves every checkpoint tensor. The operator should verify the downloaded snapshot revision. Existing output files are rejected. Do not wire a mock result into the lab: inspect a completed GPU result first. The newer GPU agent's service contract and its missing deployment requirements are documented in [GPU delivery status](../docs/gpu-delivery-status.md); this standalone smoke test is not the deployed service.

RNA tracks alone do not establish an amino-acid extension, disease probability, or patient outcome. The app's published 13-amino-acid result remains separately attributed to the paper. The output carries these limitations.

## Local checks completed

```sh
python -m unittest discover -s . -p 'test_*.py' -v
python run_dnm1.py --help
```

Five dependency-free tests cover reference mismatch, bin-aligned cropping, exact biosample lookup, numeric serialization, and rejection of invalid values/shapes. CLI help and Python compilation pass. These checks do not load JAX, check GPU memory, or prove full inference compatibility.

## Import a completed GPU service result into the analytical lab

The separate GPU agent's delivered `v0.1.0-preflight` service writes raw `first-prediction.json` and `warm-prediction.json` files after successful inference. Once one of those **actual result files** is available, run this command from the repository root:

```sh
npm run import:gpu-result -- \
  --input /absolute/path/to/first-prediction.json \
  --output-dir /absolute/path/to/new-analysis-bundle
```

The output directory must not exist, and its parent must exist. The converter validates the entire result before creating the directory and cleans up a partially written bundle if a write fails. `npm run import:gpu-result -- --help` requires no checkpoint or scientific dependencies.

The bundle contains:

- `source-result.json`: a byte-for-byte copy of the input, including original metadata and all source evidence.
- `analysis.json`: an analytical dataset accepted by the lab's JSON import, with all 41 supplied bins per track and the source artifact's SHA-256.
- `README.md`: interpretation, provenance and format limitations.

The converter checks the fixed GRCh38 **chr9:128225994:G>A** variant, verified 1,048,576-base context and 41-base reference crop, track alignment, tissue scope, original metadata, numerical finiteness, and row/payload limits. It keeps equal-name tracks on different strands separate, preserves unknown strand/units as null, and retains `SPLICE_SITES` as tissue agnostic. It does not smooth, normalize, derive scores, fabricate missing bins, upload files or run inference. An oversized result is rejected rather than truncated.

Model/client/checkpoint revisions and reference context hashes remain **source-reported**. An import and a matching file checksum do not independently prove GPU execution or checkpoint identity. The whole-reference FASTA hash is unavailable in this service contract, so it remains null; the input-context hash is retained separately. Keep the raw artifact beside the analytical JSON: it preserves metadata that charts do not display. CSV alone is not a complete provenance-bearing export.

This bridge supports the delivered service's **raw `PredictionResult`**, not its queued/completed job envelope, the standalone `run_dnm1.py` matrix format, Atlas scores, or the newer **chr9:128226027:G>A** variant in the Atlas link. Those require separate adapters; one variant's results cannot stand in for another's.

Run the converter tests with `npx tsx --test tests/model-result-import.test.ts`. All numerical fixtures in those tests are synthetic QA inputs, not bundled model predictions. A completed live model output is still required before this bridge can show a real new prediction in the lab.
