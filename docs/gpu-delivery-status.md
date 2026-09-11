# GPU delivery status

Reviewed 11 September 2026. **Prepared, not deployed.** The delivered bundle contains an API scaffold, inference adapter, candidate dependency locks, deployment templates, and preflight evidence. It does not provide a working GPU service or a model prediction.

`DELIVERY-STATUS.json` reports `gpuStarted: false`, `inferencePerformed: false`, `liveBaseUrl: null`, `serviceTokenProvisioned: false`, and `runtimeCredentialConnected: false`. First prediction, prediction plot, and GPU benchmarks are all null. The adapter and candidate inference lock have not been GPU-tested. The README also reports that no weights were downloaded and no GPU rental was started. This review did not inspect a provider account or independently establish its resource state.

## Current configuration and reported access concern

On 11 September 2026, a Chrome review of the GPU-development task still showed the prepared bundle, no started GPU, no endpoint and no connected private checkpoint credential. The public website project's secrets-list tool returned `names: []`; no configured secret names were exposed for that project. These are observations of the inspected task and website configuration, not proof of the resource or credential state of every external account.

The bundle separately records the user's reported accepted model access and personal noncommercial use, while raising an eligibility concern about an unaffiliated personal project. That concern is the bundle author's interpretation of the model terms; this review does not independently resolve or endorse that legal interpretation. A reported eligibility concern and the verified absence of connected runtime configuration are different issues. Regardless of the eventual eligibility determination, this delivery currently supplies no live HTTPS base URL, provisioned service token, connected checkpoint credential or loaded-checkpoint result that Helix can use.

The bundle also reports a managed-downloader restriction and unverified stable ingress/lifecycle support. Those are reported constraints of the inspected route, not a determination that every potential host is unsuitable. No terms were accepted, credentials entered, model calls made or external messages sent during this documentation update.

## Atlas access and the requested DNM1 variant

The independent Atlas recheck on 11 September 2026 found two separate blockers: the [public AVI ZIP](https://deepmind.google.com/science/alphagenome/_/download/atlas/avi_scores_snvs_tabix.zip) returned HTTP 500 for HEAD and a 256-byte range request, and an anonymous request to the official Atlas metadata service returned gRPC `PERMISSION_DENIED`, requiring established caller identity. Exact times and request scope are recorded in [ANALYTICAL_LAB.md](ANALYTICAL_LAB.md#access-recheck-2026-09-11-asiaalmaty). Atlas lookup uses hosted precomputed data and needs no local GPU; no live Atlas score was obtained.

The [official Atlas paper, Table S4](https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/alphagenome-atlas.pdf) does report an experimental alternative 3′ splice-site selection rate of **0.94** for the requested **chr9:128226027:G>A**. This is a literature measurement, not AVI, a model-score row or a new inference result. The bundle below instead targets **chr9:128225994:G>A**. That nearby variant is the one assigned AVI PHRED **24.7** and **69% splicing attribution** in the paper's main text. The variants are 33 bases apart and their results must remain separate.

The paper's Code Availability section states that AVI model source code and weights will be provided upon final publication. Deploying the base AlphaGenome checkpoint does not by itself supply official AVI scoring.

### Exact-variant handoff correction

The original attachment remains unchanged. Its request schema fixes position 128225994, and its adapter caches that variant and context during initialization while returning the request's variant label. Relaxing only the request schema could therefore label the old variant's output as the new one. Any service revision must construct and validate the actual model input from the same descriptor used for its response and cache key.

The repository now has [independently verified descriptors](../data/reference/README.md) for both variants and an explicit-variant [local runner](../inference/README.md). For the requested `chr9:128226027:G>A`, input is `[127701739,128750315)`, display is `[128226006,128226047)`, and the context SHA-256 is `9498733b77b33b237673796c2f5d30396bd8f134494daa2c77043a0caf2f94d4`. The raw-service import bridge rejects mixed variant/context combinations.

The first integration proof is now a real inference result exported as a website-compatible analysis JSON plus its original result sidecar. That does not require a live HTTP service. An authenticated service, its website job adapter and account ownership remain later integration work. The [updated execution prompt](higgsfield-gpu-execute.txt) replaces the old first-run instructions; no GPU run is implied by these repository changes.

Source review also found that the pinned research implementation computes splice-junction intermediates during `predict_variant`, even when only positional tracks are requested. A FASTA-only settings object does not inherit the default splice annotations. The corrected runner supplies explicit GENCODE v46 resources; actual compatibility must still be demonstrated on the GPU. `SPLICE_JUNCTIONS` export and Atlas AVI scoring remain outside this positional-track adapter.

## Delivered artifacts and integrity

The four supplied files were read from `/Users/mukhsinmukhtorov/Downloads/`. No attachment code was executed or imported, and the archive was not extracted.

| File | Bytes | Independently computed SHA-256 |
|---|---:|---|
| `helix-alphagenome-preflight-and-service.zip` | 39,328 | `2b4d1ce4c5f90f0674a4d49ac7574ad03e56caabea296415141c99f1c3cc551c` |
| `openapi.json` | 16,113 | `cd72a094703e65b4df519522642919ea75f130ee5ab311817796d71f14a64a81` |
| `reference-validation.json` | 1,617 | `bb2cbe41592c17aec70caea2aea7be015c33012682e037d97e59eea8e7b0d515` |
| `repository-track-metadata.json` | 8,859 | `a226220fcf82ae056638ea0f7e4b102d887fcd1843a82ba89bb36eb72a7a2291` |

Independent checks passed:

- All 20 files listed in `SHA256SUMS.json` match their recorded hashes. The manifest is the twenty-first archive entry; no other entries are unlisted.
- No duplicate archive paths, absolute paths, parent-directory traversal paths, encrypted entries, or ZIP CRC failures were found.
- Each detached JSON file is byte-for-byte identical to its corresponding archive copy.
- All local OpenAPI references resolve. Every documented operation inherits the global HTTP bearer security declaration.

These checks establish integrity and internal consistency of this delivery. They do not authenticate its author, prove runtime enforcement, or validate model outputs.

## Scientific preflight independently reproduced

The evidence describes GRCh38 `chr9:128225994 G>A`, with the variant position expressed as **1-based**. Both intervals below are **0-based, half-open**:

| Purpose | Chromosome | Start | Exclusive end | Bases |
|---|---|---:|---:|---:|
| Full model input context | chr9 | 127701706 | 128750282 | 1,048,576 |
| Display crop | chr9 | 128225973 | 128226014 | 41 |

An independent read-only request fetched the [official reference index](https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa.fai) and a bounded HTTP byte range from the [official GRCh38.p13 FASTA](https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa). The range contained 1,066,053 bytes including FASTA line breaks; the full reference was not downloaded.

- Index SHA-256 matched: `9293fb33f63b7f09d8fadc055d78e401d07c76de0211243fba778780ff836ff9`.
- Extracted context length and SHA-256 matched: `dbadd0681da906be525c770f4904923dc26a79de515984431d49c057e676e08c`.
- The 41-base crop matched `CACTTCTCCTCCCCACCCACGGCTGCTCCTCCTCCTGTCCC`.
- Reference allele **G** is at display index 20 and input index 524287, both zero-based. The retrieved context contains zero `N` bases and requires no artificial padding.

The pinned [official human output metadata file](https://github.com/google-deepmind/alphagenome_research/blob/0db53bd4352c66d1e00a049a81da373a066e6670/src/alphagenome_research/model/metadata/OutputMetadataResponse_ORGANISM_HOMO_SAPIENS.textproto) was independently fetched. Its 2,637,391 bytes match SHA-256 `413b4063096bbf7a75a7fdf5560030f8e3866c6af2455fb313e58686ae3d49e8`; all 15 supplied track names occur in that source. The delivered rows comprise five CHIP_TF, one DNASE, two RNA_SEQ, five SPLICE_SITES, and two SPLICE_SITE_USAGE entries. The splice-site set includes a Padding row, which is not a biological track.

`CL:0000679` identifies glutamatergic neuron in the supplied repository metadata. **SPLICE_SITES is tissue agnostic** and must not be presented as neuron-specific; its result tracks use a null biosample identifier. RNA-seq and splice-site usage metadata include the requested biosample. This is reference and repository evidence, not metadata verified against a loaded checkpoint: the delivery explicitly sets `loadedModelVerified: false`.

## Reported tests versus checks performed here

The bundled `evidence/test-summary.json` reports **33 tests, zero failures, zero errors, zero skipped**, taking 1.444 seconds on CPython 3.12.11. Its stated scope is offline API/controller behavior and unauthorized-worker startup, with no inference and no public endpoint test. Reported coverage includes authentication, HTTPS enforcement, request validation, queue limits, idempotency, restart persistence, expiry, result-contract rejection, and startup failing without authorization.

**Those tests were not rerun in this review.** Independent work here was limited to archive/file integrity, JSON and contract consistency, and the reference/metadata retrieval checks above. No environment was installed, checkpoint staged, worker started, GPU benchmark performed, or prediction requested.

## API contract and integration boundary

The OpenAPI 3.1.0 document is titled “Helix AlphaGenome private GPU API,” version `0.1.0-preflight`. It specifies:

| Method and route | Contract |
|---|---|
| `GET /v1/health` | Starting/ready status and model/checkpoint revisions |
| `GET /v1/metadata` | Service metadata |
| `POST /v1/predictions` | HTTP 202 job receipt; request ID supports idempotency |
| `GET /v1/predictions/{jobId}` | Queued, running, completed, or failed job, with result/error |

The request schema currently fixes **this one GRCh38 G>A variant**. Supported requested outputs are `RNA_SEQ`, `SPLICE_SITES`, and `SPLICE_SITE_USAGE`. This contract does not enable inference for arbitrary sequence edits. Each result track requires 41 reference and 41 alternate numeric values at one-base resolution, original metadata, and tissue-scope information. A model result must identify `sourceKind: model_inference` and provide reference, model, client, checkpoint, interval, transformation, and timing provenance. No such result is present in this delivery.

The recorded research revision is `0db53bd4352c66d1e00a049a81da373a066e6670`; client revision is `aa6fc8f6faadcb8c910fa2b85b57386fbd5c7b5d`. Checkpoint revision `a8f293a76ee73d5b57f3bf2ae146510589fcf187` is **requested**, not verified as downloaded or loaded.

## What is still needed to connect Helix

1. Establish the actual model-access and host prerequisites for the chosen deployment route. The bundle's eligibility concern is reported separately above; this review makes no eligibility or licensing determination. Connect private credential injection and an approved GPU host with stable authenticated HTTPS ingress and a verified shutdown/resume mechanism.
2. Stage authorized checkpoint files, verify their manifest, install and validate the candidate environment on the actual GPU, and record the successful dependency versions. The README proposes one H100 80 GB; no hardware suitability or performance has been measured in this delivery.
3. Load the real checkpoint, verify its available biosample/track metadata, pass real full-context smoke runs, and retain cold/warm timings and complete output provenance. The service must become ready only after those checks succeed.
4. From the Helix backend's calling network, submit the fixed variant, poll to completion, and inspect the actual JSON, track alignment, numeric values, and first plot. Verify authentication and lifecycle behavior on that live endpoint.
5. Privately set `GPU_API_BASE_URL` to the verified HTTPS URL and `GPU_API_TOKEN` to the service's bearer secret, then connect and verify the lab's backend adapter. Keep credentials server-side. Display actual returned tracks as model inference; retain separate labels for the published illustrated replay and unsupported edits.

Until those steps produce a verified live result, Helix has a validated preflight package and a proposed service contract—not a connected GPU prediction service. There is no endpoint to enter and no inference result to show from these attachments.
