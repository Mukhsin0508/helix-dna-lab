# Private AlphaGenome service

This is the corrected service implementation for the analytical lab. It reuses the GPU agent's SQLite queue, authenticated routes and single model process, with a request-bound inference engine and the repository's existing numerical exporters. **It has passed offline integration checks only. No checkpoint has been loaded on a GPU, no prediction has been produced, and no live endpoint is configured.**

The public website already imports the resulting `analysis.json`. Public compute submission and user ownership are separate work; this shared service token is for a trusted backend/operator, not browser users.

## What changed from the delivered ZIP

- Both verified DNM1 variants are explicit request inputs. The model loads once; each request constructs and validates its own full reference context before inference.
- Required GTF and splice-site annotations are supplied. Metadata comes from the loaded model.
- Positional tracks and exclusive splice-junction runs use the same exporters as the local runner. Missing values, precise numbers and original metadata are retained.
- A completed job must match its persisted variant, biosample, output selection and crop. The raw JSON's SHA-256 and an independently recomputed analytical dataset must match too.
- The controller rejects null completions, expires queued work before claiming it, fences startup/shutdown and allows one controller per database.
- Every HTTP route requires the private bearer credential and HTTPS, including health and OpenAPI. Requests, tokens and remote error bodies are not logged.

Source: user-supplied `helix-alphagenome-preflight-and-service.zip`, SHA-256 `2b4d1ce4c5f90f0674a4d49ac7574ad03e56caabea296415141c99f1c3cc551c`. Its original `service.py` SHA-256 is `530022e4b9030390b21aeb603fdafb99d1b296080308873667d2032e562f5d4d`. The original attachment remains untouched. The reviewed controller was adapted; its fixed-variant inference adapter and candidate GPU dependency lock were not copied into this runtime.

## Start after authorized model staging

Use the model, reference resources and pinned source described in [the runner guide](../README.md). Install `inference/service/requirements.txt` into that isolated environment. This adds the API dependencies; it does not install or validate CUDA, JAX or the checkpoint.

Configure private environment settings through the host's secret/configuration mechanism:

| Setting | Meaning |
| --- | --- |
| `HELIX_GPU_SERVICE_TOKEN` | Private random bearer credential, 32–512 printable ASCII characters |
| `HELIX_CHECKPOINT_DIR` | Absolute authorized Orbax snapshot directory |
| `HELIX_FASTA_PATH` | Absolute GRCh38.p13 FASTA path; adjacent `.fai` required |
| `HELIX_GTF_PATH` | Absolute GENCODE v46 GTF Feather path |
| `HELIX_SPLICE_SITE_STARTS_PATH` | Absolute splice-start Feather path |
| `HELIX_SPLICE_SITE_ENDS_PATH` | Absolute splice-end Feather path |
| `HELIX_BIOSAMPLE` | Exact name; default `glutamatergic neuron` |
| `HELIX_STATE_DIR` | Private persistent directory for jobs; default `/var/lib/helix-alphagenome` |

Never put a token in a URL, browser bundle, repository or chat. From the repository root:

```sh
PYTHONPATH=inference python -m uvicorn service.app:create_app --factory \
  --host 127.0.0.1 --port 8000 --workers 1 \
  --proxy-headers --forwarded-allow-ips 127.0.0.1 \
  --no-access-log --timeout-keep-alive 5 --limit-concurrency 32
```

Place this behind the operator's verified TLS ingress. The command assumes a trusted reverse proxy on loopback; do not change proxy trust to `*`. A direct HTTP call is rejected even with a valid token. Provision the host's stable HTTPS address and lifecycle independently; this command does neither.

`GET /v1/health` returns HTTP 503 during startup/failure, or HTTP 200 after the model loads and selected metadata is validated. **Ready means initialized; only a completed real job demonstrates inference.** Expected pins are explicitly separate from runtime-reported revisions. No checkpoint revision is claimed independently verified.

## Submit and retrieve

All routes are authenticated:

| Route | Result |
| --- | --- |
| `GET /v1/health` | Initialization state and expected pins |
| `GET /v1/metadata` | Loaded-model track metadata and supported selections |
| `POST /v1/predictions` | HTTP 202 with `jobId` and status |
| `GET /v1/predictions/{jobId}` | `queued`, `running`, `completed` or `failed` |
| `GET /openapi.json` | Current schema |

Example request, with no credential in the body:

```json
{
  "requestId": "dnm1-atlas-first-run",
  "variantId": "chr9:128226027:G>A",
  "biosample": "glutamatergic neuron",
  "outputs": ["RNA_SEQ", "SPLICE_SITES", "SPLICE_SITE_USAGE"],
  "cropBp": 41
}
```

The other allowed variant is `chr9:128225994:G>A`. This initial service does not accept arbitrary DNA. Junction requests use only `outputs: ["SPLICE_JUNCTIONS"]` and default to `cropBp: 32768`; positional requests default to 41. Each inference still uses 1,048,576 bases. The exported raw result and analytical dataset must each fit 2 MiB and preserve all selected rows within the 5000-row limit; an oversized run fails instead of silently dropping data.

Reusing a request ID with the same normalized parameters returns the existing job. Different parameters produce HTTP 409. Jobs expire one hour after submission; expired IDs return HTTP 410 and retain only bounded idempotency tombstones for seven days. Download completed artifacts promptly. Queued work times out after five minutes; the runtime's default inference deadline is five minutes and startup deadline fifteen minutes. Those are initial operational limits, not measured AlphaGenome benchmarks. Confirm them against the first real run.

For an operator workstation, privately configure `HELIX_GPU_API_URL` with the actual HTTPS base URL and `HELIX_GPU_SERVICE_TOKEN`. Then:

```sh
PYTHONPATH=inference python -m service.client \
  --request-id dnm1-atlas-first-run \
  --variant 'chr9:128226027:G>A' \
  --output-dir /absolute/existing/parent/new-result
```

For junctions add `--outputs SPLICE_JUNCTIONS --crop-bp 32768`, a new request ID and a new output directory. The client refuses redirects, mismatched job IDs, invalid results and overwrites. If interrupted, retry the same request ID while the job is retained. Reaching the client's polling deadline does not cancel remote computation.

A completed result envelope contains `schemaVersion: 2`, `analysis`, `sourceResultJson` and `sourceResultSha256`. The client saves:

- `analysis.json`: import this into Helix.
- `source-result.json`: the exact UTF-8 bytes whose hash is recorded by that analysis; keep it alongside the figure.

The old `0.1.0-preflight` service shape is superseded. Do not feed this new envelope to the legacy converter. No live clients were migrated because the old service was never deployed.

## Verification and operational boundary

From the full repository, in an environment with the service requirements and existing Node dependencies:

```sh
PYTHONPATH=inference python -m unittest discover -s inference -p 'test_*.py'
PYTHONPATH=inference python -m unittest service.test_service service.test_engine_client
```

Tests use named synthetic fixtures and process spies. They cover queue lifecycle, authentication, both request identities, output verification, raw artifact preservation and the real TypeScript import boundary. They do not establish model accuracy, CUDA compatibility, GPU memory needs or successful public ingress.

The first deployment proof remains a real request for the exact Atlas variant, downloaded artifacts, visible lab import, actual timings and recorded runtime provenance. Keep the service private until that works. Stop idle paid compute through the host when the test is finished; stopping this Python process alone does not stop GPU billing.
