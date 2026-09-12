# Enable hosted AlphaGenome predictions

The public website is [genetic-engineering-lab.higgsfield.app](https://genetic-engineering-lab.higgsfield.app/). The hosted runner uses the official `alphagenome==0.9.0` Python client in a CPU container; Google runs the model on its infrastructure. No local GPU or downloaded checkpoint is needed for this route.

**Current status:** the owner's AlphaGenome-issued API key has not been provided. Offline validation is complete, but no actual authenticated inference or end-to-end model result has been verified. Published examples and imported analyses work independently of this key.

## Owner setup

1. Obtain an API key through [Google DeepMind's AlphaGenome access page](https://deepmind.google.com/science/alphagenome), using the service's applicable access terms.
2. Open this website's Higgsfield project, then **Settings → Secrets**.
3. Create the secret named exactly `ALPHAGENOME_API_KEY` and enter the issued key there. Keep it out of chat, request JSON, source code, logs and screenshots. Do not use a `VITE_` variable or any browser-exposed setting.
4. Save the secret, then deploy the website again. Higgsfield applies changed secrets on the next deployment. The server passes the secret to the container; visitors never enter or receive it.
5. Open the public website and run the example below once. A configured status only confirms that a secret exists; the returned prediction is the evidence that authentication, reference retrieval and inference actually succeeded.

## First verification

Use these exact inputs:

| Field | Value |
| --- | --- |
| Variant | `chr22:36201698:A>C` |
| Tissue ontology | `UBERON:0001157` |
| Display crop | `256` bp |
| Assembly and output | Human GRCh38, `RNA_SEQ` |

The one-based SNV determines a 1,048,576-base input interval, `[35677410, 36725986)`, and a display interval of `[36201570, 36201826)` on chr22. The runner independently checks the REF base against the official GRCh38.p13 FASTA before submitting the prediction. This single-base check does not establish a hash of the full model input sequence.

After success, inspect the paired REF/ALT tracks, exact variant, tissue, coordinates and provenance. Export the analysis JSON and retain the raw result JSON separately with its SHA-256. The result records the actual client version and requested `ALL_FOLDS` model selection; the hosted service's internal model/checkpoint revisions remain unreported.

Exporting a figure or recipe does not rerun inference. The recipe field `methods.inferencePerformedDuringExport: false` describes the export operation; it does not erase inference already documented in the dataset's provenance.

The container needs DNS/TLS egress to the official Google reference storage and AlphaGenome service. The caller enforces a 180-second process deadline, including any bounded retries performed by the official SDK. Unsupported tissues, REF mismatches, unavailable access or invalid/oversized results must return an error, not substitute example data.

These are predicted molecular RNA-seq signals, not measured experiments, disease probabilities, vaccine success rates or whole-organism outcomes. This first hosted route does not accept arbitrary FASTA/VCF uploads or produce splice-junction outputs. See the [runner contract and offline tests](../inference/hosted/README.md) for exact bounds and data preservation.
