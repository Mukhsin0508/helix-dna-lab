"""Single-model adapter for the private service; never downloads or substitutes results."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import os
from pathlib import Path
import time

from junction_export import JUNCTION_OUTPUT, normalized_junction_analysis
from run_dnm1 import (
    HF_REVISION, RESEARCH_COMMIT, ModelRunner, SUPPORTED_OUTPUT_TYPES,
    installed_revision, selected_metadata,
)
from track_export import (
    VARIANTS, JsonObject, encoded_json, load_descriptor, normalized_analysis,
)
from service.contract import PredictionRequest, validate_result


INPUT_SETTINGS = {
    "checkpoint": "HELIX_CHECKPOINT_DIR",
    "fasta_path": "HELIX_FASTA_PATH",
    "gtf": "HELIX_GTF_PATH",
    "splice_site_starts": "HELIX_SPLICE_SITE_STARTS_PATH",
    "splice_site_ends": "HELIX_SPLICE_SITE_ENDS_PATH",
}


def input_paths() -> dict[str, Path]:
    """Return explicit absolute local paths; report missing setting names, never their values."""
    result: dict[str, Path] = {}
    for argument, setting in INPUT_SETTINGS.items():
        value = os.environ.get(setting, "")
        if not value or not Path(value).is_absolute():
            raise ValueError(f"{setting} must name an absolute local path.")
        result[argument] = Path(value)
    return result


class Engine:
    """Load once in the queue's child process and bind every prediction to its own request."""

    def __init__(self) -> None:
        self._runner: ModelRunner | None = None
        self._metadata: JsonObject | None = None

    def boot(self) -> JsonObject:
        """Load the real GPU model and validate selectable metadata; this is not an inference test."""
        if self._metadata is not None:
            return deepcopy(self._metadata)
        biosample = os.environ.get("HELIX_BIOSAMPLE", "glutamatergic neuron")
        if not biosample.strip() or biosample != biosample.strip() or len(biosample) > 200:
            raise ValueError("HELIX_BIOSAMPLE must be an exact, nonempty biosample name.")
        started = time.monotonic()
        paths = input_paths()
        runner = ModelRunner(**paths)
        records = runner.output_metadata_records(tuple(SUPPORTED_OUTPUT_TYPES))
        selected_records: JsonObject = {}
        for output, metadata in records.items():
            curies, _ = selected_metadata({output: metadata}, biosample, 1)
            selected_records[output] = [deepcopy(record) for record in metadata
                if str(record.get("name", "")).lower() != "padding" and (
                    output == "SPLICE_SITES" or (
                        record.get("ontology_curie") in curies
                        and str(record.get("biosample_name", "")).casefold() == biosample.casefold()))]
        variants = []
        for variant_id in VARIANTS:
            descriptor = load_descriptor(variant_id)
            variants.append({"variantId": descriptor.id, "assembly": descriptor.reference_version,
                "inputInterval": {"chromosome": descriptor.chromosome, "start": descriptor.input_start,
                    "end": descriptor.input_end, "coordinateSystem": "0-based-half-open"},
                "expectedInputSequenceSha256": descriptor.context_sha256})
        metadata: JsonObject = {
            "schemaVersion": 2,
            "biosample": biosample,
            "supportedVariants": list(VARIANTS),
            "supportedOutputs": list(SUPPORTED_OUTPUT_TYPES),
            "variants": variants,
            "trackMetadata": selected_records,
            "researchRevision": installed_revision("alphagenome_research"),
            "clientRevision": installed_revision("alphagenome"),
            "expectedResearchCommit": RESEARCH_COMMIT,
            "expectedCheckpointRevision": HF_REVISION,
            "checkpointRevision": "Not independently verified",
            "bootSeconds": time.monotonic() - started,
            "readinessMeaning": "Model loaded and selected metadata checked. A successful prediction still requires a completed job.",
            "execution": "One model instance; serial requests. Each request validates its own full reference context.",
        }
        encoded_json(metadata)
        self._runner, self._metadata = runner, metadata
        return deepcopy(metadata)

    def predict(self, request: dict) -> JsonObject:
        """Return exact raw JSON plus its checksummed analytical dataset after real inference."""
        if self._runner is None or self._metadata is None:
            raise RuntimeError("Model has not completed initialization.")
        validated = PredictionRequest.model_validate(request).model_dump()
        if validated["biosample"] != self._metadata["biosample"]:
            raise ValueError("Requested biosample is not configured for this worker.")
        source = self._runner.predict(
            biosample=validated["biosample"], crop_bp=validated["cropBp"],
            variant_id=validated["variantId"], requested_outputs=tuple(validated["outputs"]),
        )
        source["serviceRequestId"] = validated["requestId"]
        raw = encoded_json(source)
        digest = hashlib.sha256(raw).hexdigest()
        normalize = normalized_junction_analysis if validated["outputs"] == [JUNCTION_OUTPUT] else normalized_analysis
        analysis = normalize(source, load_descriptor(validated["variantId"]), "source-result.json", digest)
        result = {"schemaVersion": 2, "analysis": analysis,
            "sourceResultJson": raw.decode("utf-8"), "sourceResultSha256": digest}
        return validate_result(result, validated)
