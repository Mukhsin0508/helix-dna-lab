# Higgsfield GPU handoff

Use the current [execution prompt](higgsfield-gpu-execute.txt). It replaces the earlier first-run instructions and targets the exact Atlas variant, **chr9:128226027:G>A**. The earlier variant remains separately supported; its results must not be relabeled.

The first proof is a real model output file that the lab can import. The runner validates the full genomic context, requests positional REF/ALT outputs, and writes an analytical JSON plus its original result sidecar. The UI can chart the first file directly; the second preserves numerical and runtime provenance. No HTTP endpoint is needed for this first proof.

```text
Authorized checkpoint + verified reference + selected variant
    → Higgsfield GPU runs AlphaGenome
    → analysis.json + analysis.source-result.json
    → import analysis.json in Helix
    → filter, compare, save and export the actual signals
```

After inference succeeds, a private authenticated service can wrap the same validated path. Helix still needs a server-side job connector and account ownership before public users can submit paid model runs. Defining the service contract is not a completed integration.

See the [runner requirements](../inference/README.md), [reference descriptors](../data/reference/README.md), and [review of the original GPU delivery](gpu-delivery-status.md). Full-model inference has not run in this repository task. No live service, connected credential or new model prediction is implied by this handoff.
