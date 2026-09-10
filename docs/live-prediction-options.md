# Real prediction options for Helix DNA Lab

Checked **2026-09-10** against official Google DeepMind source code, documentation, terms, and the published Atlas paper. No API key was located or used, no inference was run, and no result below is a newly computed prediction. The current app remains a sourced DNM1 case replay; other edits remain unscored.

## What is available

| Route | What the app can receive | Access and present limit |
| --- | --- | --- |
| Published DNM1 case | Reported mechanism and research findings for the exact G>A variant | Available now from the cited paper. A replay, not a fresh prediction. |
| Downloadable AVI SNV scores | Precomputed AVI and PHRED-scaled scores, suitable for indexed variant lookup | Official downloads list a **88.5 GB Tabix ZIP**. Designated permissive artifacts have a commercial-use exception. Anonymous download success and the archive's exact column schema have **not** been verified. |
| AlphaGenome Atlas Python API | Precomputed variant scores, including supported AVI/scorer data and track metadata | Requires an API key. Querying it now does not make its stored predictions live inference. |
| AlphaGenome prediction API | New reference/alternate molecular tracks for a supported genomic context | Requires an API key and eligible use. No documented anonymous prediction endpoint was found. |
| Self-hosted AlphaGenome research model | Locally computed REF/ALT tracks through the official JAX model | No hosted API key is needed after authorized checkpoint download. HF/Kaggle weights require acceptance of non-commercial model terms; self-hosting does not waive them. |
| Commercial AlphaGenome on Google Cloud | An authenticated model endpoint in a customer's Cloud project | Available through an allowlisted, paid commercial route. This does not establish commercial availability of the separate Atlas service. |

The [official client README](https://github.com/google-deepmind/alphagenome) distinguishes Atlas lookup from model inference. Free-service query rates depend on demand; Atlas generally permits higher throughput. The model API is intended for limited regions or thousands of predictions, rather than a million-query public scan.

An isolated anonymous browser visit to the [Atlas viewer](https://deepmind.google.com/science/alphagenome/atlas) showed a sign-in entry screen. Linking there is feasible. A public webpage is not evidence of an anonymous API or permission to embed/rehost its restricted outputs. The [official download page](https://deepmind.google.com/science/alphagenome/downloads) visibly lists AVI at 88.5 GB, merged splicing scores at 20.6 GB, and AVI feature importance at 283.9 GB; the latter two are marked non-commercial only. Anonymous HEAD and bounded GET Range requests to the [advertised AVI ZIP](https://deepmind.google.com/science/alphagenome/_/download/atlas/avi_scores_snvs_tabix.zip) both returned HTTP 500. That result alone cannot distinguish a temporary server problem from an access requirement. No large download was attempted.

## Licensing boundary

The [September 8 service terms](https://deepmind.google.com/science/alphagenome/terms) restrict the free services to eligible individuals, non-commercial organizations, and journalism. A commercial organization is not eligible merely because its particular project is educational or unpaid. Personal credentials cannot be shared. Output reuse requires the applicable notices, attribution, and disclosure of modifications.

**AVI Score and explicitly designated permissive downloads have a commercial-use exception. AVI feature breakdowns are excluded from that exception.** Do not treat access to one AVI scalar as permission to redistribute every Atlas track or attribution. Apache-2.0 licensing of the client software also does not license model-service output for commercial use. Consult the [output terms](https://deepmind.google.com/science/alphagenome/output-terms) when publishing permitted results.

## Smallest useful implementation

**Now:** finish the existing replay with explicit provenance. Optionally show the paper-reported **AVI PHRED 24.7** for `chr9:128225994 G>A`, labeled “Reported in the Atlas paper”; do not call this a fetched or calculated score. The paper's 13-amino-acid extension is specific to this case. Keep all other edits unscored until actual data exists. The [paper](https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/alphagenome-atlas.pdf), printed pages 7–8 and Figure 3, is the source. A numerical display is optional, not necessary to complete the replay.

**First real integration:** after authorized access is supplied, run one server-side Python job for the exact variant and cache a small, versioned result. Start with reference/alternate RNA-seq and splicing outputs for a metadata-verified glutamatergic-neuron biosample; venous blood can provide the published comparison. Choose biosample IDs from the actual service metadata, not guessed ontology codes. Export the local region needed by the browser, retaining original coordinates, track names, units, and provenance. This needs neither a browser GPU for inference nor a permanently running inference server when using the hosted API.

For an AVI-only public product, obtaining the permitted download and extracting the exact row is a separate viable option. A local Tabix lookup can serve scores without making model calls, once the actual schema and source release are verified. Downloading an 88.5 GB archive for this single replay is a poor first step; do not expose the ZIP in the browser or assume its contents can be remotely queried inside the ZIP.

## Supported Python request and response shapes

The following is a proposed adapter shape, **not executed code or a stored prediction**. Installation and key creation are covered by the [official quick start](https://github.com/google-deepmind/alphagenome#quick-start).

```python
from alphagenome.data import genome
from alphagenome.models import dna_client

variant = genome.Variant(
    chromosome="chr9",
    position=128225994,  # 1-based GRCh38/hg38
    reference_bases="G",
    alternate_bases="A",
)
interval = variant.reference_interval.resize(dna_client.SEQUENCE_LENGTH_1MB)
model = dna_client.create(api_key)  # Obtain securely on the server.
result = model.predict_variant(
    interval=interval,
    variant=variant,
    ontology_terms=verified_ontology_terms,  # Resolve from service metadata.
    requested_outputs=[
        dna_client.OutputType.RNA_SEQ,
        dna_client.OutputType.SPLICE_SITES,
        dna_client.OutputType.SPLICE_SITE_USAGE,
        dna_client.OutputType.SPLICE_JUNCTIONS,
    ],
)
```

The [genome classes](https://github.com/google-deepmind/alphagenome/blob/main/src/alphagenome/data/genome.py) define a 1-based `Variant.position` and 0-based, half-open intervals. `reference_interval` supports the centering operation above. The existing 41-base sequence is a display window; it must not be padded and presented as equivalent to the real 1,048,576-base reference context.

The [output classes](https://github.com/google-deepmind/alphagenome/blob/main/src/alphagenome/models/dna_output.py) return a `VariantOutput` containing `reference` and `alternate`. Their RNA-seq, splice-site, and usage fields are `TrackData`; splice junctions use `JunctionData`. Unrequested fields can be `None`. Preserve these distinctions when converting arrays and metadata to browser JSON. A contact map contains predicted contacts, not an experimentally measured 3D body or DNA structure.

For lookup, the [Atlas client](https://github.com/google-deepmind/alphagenome/blob/main/src/alphagenome/atlas/atlas.py) supports:

```python
from alphagenome.atlas import atlas

client = atlas.create(api_key)
metadata = client.scorer_metadata()
scores = client.query_variant(variant, requested_scorers=verified_scorer_names)
```

Resolve scorer names from `metadata` before requesting them. Optional filters cover ontology terms, gene IDs, and gene names. The result maps scorer names to `AnnData`: `.X` holds scores, `.obs` identifies variants and applicable gene/junction context, `.var` describes tracks, and `.layers["quantiles"]` may hold calibrated scores. The client uses authenticated gRPC with `x-goog-api-key`; no credential-free per-variant REST method is documented in this source. No exact DNM1 API row or biosample availability has yet been verified.

## Commercial route

The [Google Cloud deployment guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/open-models/alphagenome) documents allowlisted access, a paid subscription, self-deployment from Model Garden, IAM authentication, and a Cloud-specific SDK or REST endpoint. Supported serving configurations require **80 GB A100/H100** memory; 40 GB A100 is unsupported. The SDK access process involves the Cloud account team. Minimum deployment is one node, with infrastructure charges in addition to model access. No fine-tuning is offered.

The [September 8 announcement](https://deepmind.google/blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/) says the base model is commercially available on Cloud, while commercial Atlas availability is forthcoming. Do not promise that the paid model endpoint already includes the Atlas lookup service. Owning a GPU on another host does not substitute for the necessary license or access grant.

## Result handling and scientific limits

### Self-hosted model on a Higgsfield GPU

The [official research repository](https://github.com/google-deepmind/alphagenome_research) supports local `dna_model.create(checkpoint_path, ...)` and `predict_variant`. Its recommendation is at least an H100; no precise self-host minimum VRAM, host RAM, or disk requirement was found. One H100 80 GB is our proposed first test, not a proven minimum. The [package](https://github.com/google-deepmind/alphagenome_research/blob/main/pyproject.toml) permits Python >=3.11, while current [JAX](https://pypi.org/pypi/jax/json) requires >=3.12: use Linux/Python 3.12 or 3.13. Follow the [official CUDA/JAX setup](https://docs.jax.dev/en/latest/installation.html#nvidia-gpu) for the actual driver.

The pinned [HF all-folds snapshot](https://huggingface.co/google/alphagenome-all-folds/tree/a8f293a76ee73d5b57f3bf2ae146510589fcf187) totals 734,799,353 bytes in public metadata. Download size must not be mistaken for inference memory. The offline-checkpoint CLI and exact setup/provenance notes are in [inference/README.md](../inference/README.md). It performs a full-context RNA-only smoke test and exports cropped REF/ALT tracks. No checkpoint download or GPU run has occurred here; dependency-free serialization tests do not establish model execution. Use the separate job contract when attaching a verified result to the app.

### App integration

The proposed backend should record `sourceKind` (`published_replay`, `atlas_precomputed`, or `model_inference`), assembly, variant, interval, biosample/track IDs, model or data version when supplied, retrieval time, original source, and any cropping or normalization. Cache by the complete input and model configuration. Report unavailable results as unavailable, never as zero; retain the replay as a separately labeled fallback.

The [official FAQ](https://github.com/google-deepmind/alphagenome/blob/main/docs/source/faqs.md) states that the model does not automatically validate the reference allele, is not inherently diploid-aware, and is not benchmarked for personal-genome prediction. Tissue and long-range effects remain limitations. Our reference G was independently checked against UCSC and Ensembl; retain that validation for new edits. Quantiles are ranks, not confidence or disease probabilities. Molecular predictions cannot justify a whole-person phenotype, diagnosis, superpower, or measured animation. Keep the helix/cell/RNA animation schematic even when real tracks are attached.

## Recommendation for this release

Complete the replay and editing workflow now. Add a server-side provider boundary that can later consume a verified cached DNM1 result, but do not advertise live prediction until an authorized call succeeds and its output is inspected. For individual non-commercial use, a legitimate service API key is the smallest next dependency. For a company-operated product, pursue the commercial Cloud route for molecular tracks or the explicitly permitted AVI download for score-only lookup. No secret discovery or speculative endpoint is needed.
