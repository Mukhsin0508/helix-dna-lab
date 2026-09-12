# Hosted RNA-seq runner

This package uses the official `alphagenome==0.9.0` client. Google runs inference; the machine running this package does not need a GPU. The service key belongs in the `ALPHAGENOME_API_KEY` environment variable or the hosting platform's secret store, never in a command argument, request JSON or conversation.

The implementation and offline SDK-container tests are complete. A real authenticated prediction has not been executed by these tests. They use explicitly synthetic arrays and patched service calls.

## Request and execution

From the repository root, install `inference/hosted/requirements.txt` in an isolated Python environment. Supply the API key through the environment, then run:

```sh
python -m inference.hosted.run <<'JSON'
{"variantId":"chr22:36201698:A>C","ontologyTerm":"UBERON:0001157","cropBp":256}
JSON
```

Only human GRCh38 nuclear single-nucleotide substitutions on `chr1`–`chr22`, `chrX` and `chrY` are accepted. Positions are one-based; alleles must be different uppercase A/C/G/T letters. An exact ontology identifier is required and checked against current hosted RNA-seq metadata before prediction. `cropBp` defaults to 256 and must be an integer from 32 through 1024. FASTA, VCF, insertions, deletions and mitochondrial variants are not accepted by this runner.

The official `Variant.reference_interval.resize(1_048_576)` defines the input window. Windows crossing chromosome boundaries are rejected; the runner does not pad them. The example above uses input `[35677410, 36725986)` and display `[36201570, 36201826)` on chr22. Display bins must align with the actual returned resolution; no rounding of crop boundaries occurs.

**The calling platform must kill the complete subprocess after 180 seconds.** The SDK's `create(timeout=15)` bounds only channel readiness. Its metadata call, streaming prediction and built-in retries have no public per-call deadline. Run each request in a separately bounded process, keep its output private to that request, and discard raw dependency/transport diagnostics. The runner requests `ModelVersion.ALL_FOLDS` and `OutputType.RNA_SEQ` explicitly, with `HOMO_SAPIENS` and the exact selected ontology term.

One platform dispatch can include SDK retries: client 0.9.0 retries the prediction up to five attempts on `UNAVAILABLE` or `RESOURCE_EXHAUSTED`. This runner retains the official public method's behavior; it does not claim exactly one Google RPC. The process deadline bounds the whole execution, including these retries.

## Result and provenance

Success writes exactly one JSON envelope to stdout:

```text
{analysis, sourceResultJson, sourceResultSha256}
```

`analysis` is a Helix `kind: "tracks"` dataset. `sourceResultJson` is the exact UTF-8 JSON text to retain as `source-result.json`; its SHA-256 matches both `sourceResultSha256` and `analysis.provenance.artifact.sha256`. The raw sidecar retains cropped native REF/ALT arrays, metadata records/column order/index, data types, unstructured metadata, original shapes and intervals, request identity, SDK version and timestamp. It explicitly records cropping; the full 1 Mb output arrays are not embedded. The service's internal model and checkpoint revisions are not exposed and are recorded as not reported, rather than inferred from `ALL_FOLDS`.

All native output arrays are checked for finite numeric values before cropping. Metadata/value dimensions and exact tissue identity must agree. Allele tracks are matched by name and strand after comparing all reported metadata values. Optional catalog columns that are null may be absent from the filtered returned metadata; this equivalence is used only for comparison, while the returned records and columns remain unchanged in the sidecar. Unknown units are not replaced with an invented count or probability. At most 5,000 normalized rows, 2 MiB of analysis JSON and 2 MiB of raw JSON are accepted; oversized results fail without downsampling or silently dropping tracks. The complete envelope is bounded at 6 MiB.

Reference verification independently downloads the public official GRCh38.p13 FASTA index and requests the single REF byte using a bounded HTTP Range. It requires status 206 and an exact `Content-Range`. The evidence records the fetched index hash, byte position and observed allele. It does **not** establish a hash of the full input sequence or genome. Both are left unclaimed in the analysis provenance.

An optional `--output path.json` creates a new file containing the same envelope and refuses to overwrite. To import manually, write the envelope's `analysis` member as `analysis.json` and retain `sourceResultJson` verbatim in the adjacent `source-result.json`; the envelope itself is the service transport format, not the lab's direct dataset format. Default execution writes no result files.

Errors write `{error:{code,message}}` to stdout and return exit code 1. Messages are fixed and sanitized; no original exception or API key is emitted. Codes distinguish invalid input, missing key/dependencies, reference verification/mismatch, unsupported tissue, oversized/invalid results, service authorization/quota and unavailable service/output. The wrapper can validate successful output without loading the SDK:

```python
from inference.hosted.runner import validate_envelope
validated = validate_envelope(envelope, request_dict)
```

This hashes the exact raw text, binds variant/tissue/crop, reconstructs the analysis from raw values and metadata, and rejects any mismatch. It does not independently repeat the Google call or establish biological accuracy.

## Offline checks

After installing the requirements and the repository's Node dependencies:

```sh
python -m unittest inference.hosted.test_runner -v
python -m inference.hosted.run --help
```

Tests use actual SDK 0.9.0 `Variant`, `TrackData` and `OutputMetadata` objects with synthetic values. Network/model calls are replaced only in tests. The suite covers request bounds, exact coordinates for the chr22 example and both separate DNM1 variants, reference rejection, missing tissue, row limits, REF/ALT alignment, missing/nonfinite arrays, metadata precision, tampered results, HTTP Range checks, sanitized CLI failures and round-trip validation through Helix's real TypeScript dataset schema.

Official sources: [Python client release 0.9.0](https://pypi.org/project/alphagenome/0.9.0/), [client repository](https://github.com/google-deepmind/alphagenome), [official GRCh38.p13 FASTA index](https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa.fai). Hosted API access and its applicable terms remain separate from installing the client.
