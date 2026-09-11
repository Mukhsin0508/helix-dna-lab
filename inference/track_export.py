"""Dependency-free validation for exact-variant AlphaGenome track exports."""

from __future__ import annotations

import json
import math
import hashlib
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TypeAlias

JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]
REFERENCE_WINDOW = "CACTTCTCCTCCCCACCCACGGCTGCTCCTCCTCCTGTCCC"
POSITION = 128225994
CONTEXT_BP = 1048576
ROW_LIMIT = 5000
PAYLOAD_LIMIT = 2 * 1024 * 1024
VARIANTS = ("chr9:128225994:G>A", "chr9:128226027:G>A")
OUTPUT_TYPES = ("RNA_SEQ", "SPLICE_SITES", "SPLICE_SITE_USAGE")
DESCRIPTOR_PATH = Path(__file__).resolve().parents[1] / "data/reference/dnm1-variants.json"


@dataclass(frozen=True)
class VariantDescriptor:
    """One independently verified reference case, with explicit coordinate conventions."""

    id: str
    chromosome: str
    position: int
    reference: str
    alternate: str
    input_start: int
    input_end: int
    display_start: int
    display_end: int
    display_reference: str
    context_sha256: str
    display_sha256: str
    reference_url: str
    reference_version: str


def centered_window(position: int, width: int) -> tuple[int, int]:
    """Return the official forward SNV resize convention in zero-based half-open coordinates."""
    if type(position) is not int or position < 1 or type(width) is not int or width < 1:
        raise ValueError("Position and window width must be positive integers.")
    return position - (width + 1) // 2, position + width // 2


def load_descriptor(variant_id: str, path: Path = DESCRIPTOR_PATH) -> VariantDescriptor:
    """Load an exact supported case; reject modified identity, coordinates or reference evidence."""
    if variant_id not in VARIANTS:
        raise ValueError("Choose one of the two explicitly supported DNM1 G>A variants.")
    document = json.loads(path.read_text(encoding="utf-8"))
    conventions = document.get("coordinateSystem", {})
    if document.get("schemaVersion") != 1 or conventions.get("variant") != "1-based" or conventions.get("interval") != "0-based half-open":
        raise ValueError("Reference descriptor version or coordinate convention is invalid.")
    entries = [row for row in document["variants"] if row.get("id") == variant_id]
    if len(entries) != 1:
        raise ValueError("An exact, unique verified variant descriptor is required.")
    row, source = entries[0], document["reference"]
    position = int(variant_id.split(":")[1])
    if (row["chromosome"], row["position"], row["reference"], row["alternate"]) != ("chr9", position, "G", "A") or type(row["position"]) is not int:
        raise ValueError("Variant descriptor identity does not match the requested edit.")
    for name, width in (("inputInterval", CONTEXT_BP), ("displayInterval", 41)):
        coordinates = row[name]
        if any(type(coordinates[key]) is not int for key in ("start", "end")) or (coordinates["start"], coordinates["end"]) != centered_window(position, width):
            raise ValueError("Variant descriptor has a mismatched input or display interval.")
    if source["assembly"] != "GRCh38" or source["version"] != "GRCh38.p13" or source["url"] != "https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa":
        raise ValueError("Use the verified official GRCh38.p13 reference descriptor.")
    display = row["displayReference"]
    if not isinstance(display, str) or not re.fullmatch("[ACGT]{41}", display) or display[20] != "G":
        raise ValueError("Descriptor display reference must contain the requested G allele.")
    for name in ("contextSha256", "displaySha256"):
        if not isinstance(row[name], str) or not re.fullmatch("[a-f0-9]{64}", row[name]):
            raise ValueError("Reference descriptors require actual SHA-256 values.")
    if hashlib.sha256(display.encode()).hexdigest() != row["displaySha256"]:
        raise ValueError("Descriptor display reference hash does not match its sequence.")
    return VariantDescriptor(variant_id, "chr9", position, "G", "A",
        row["inputInterval"]["start"], row["inputInterval"]["end"],
        row["displayInterval"]["start"], row["displayInterval"]["end"],
        display, row["contextSha256"], row["displaySha256"], source["url"], source["version"])


def validate_context(descriptor: VariantDescriptor, context: str, display: str) -> None:
    """Reject an incomplete or different genome context before loading the model."""
    if len(context) != CONTEXT_BP or hashlib.sha256(context.encode()).hexdigest() != descriptor.context_sha256:
        raise ValueError("Full reference context does not match the selected variant descriptor.")
    offset = descriptor.position - 1 - descriptor.input_start
    if context[offset] != descriptor.reference or display != descriptor.display_reference:
        raise ValueError("Reference allele or display excerpt does not match the selected variant.")
    start, end = descriptor.display_start - descriptor.input_start, descriptor.display_end - descriptor.input_start
    if context[start:end] != display:
        raise ValueError("Display reference is inconsistent with the full input context.")


def validate_reference(sequence: str) -> str:
    """Return the uppercase 41-base window, or reject a different reference."""
    normalized = sequence.upper()
    if normalized != REFERENCE_WINDOW or normalized[20] != "G":
        raise ValueError("Local GRCh38 DNM1 reference differs from the verified 41-base window.")
    return normalized


def json_value(value: object) -> JsonValue:
    """Convert supported plain values to strict JSON; reject non-finite numbers."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Non-finite model value cannot be exported.")
        return value
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("JSON object keys must be strings.")
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    raise ValueError(f"Unsupported JSON value type: {type(value).__name__}")


def metadata_records(serialized: str) -> list[JsonObject]:
    """Validate the JSON records emitted by a metadata DataFrame."""
    value = json_value(json.loads(serialized))
    if not isinstance(value, list) or not all(isinstance(row, dict) for row in value):
        raise ValueError("Expected a list of track metadata records.")
    return [row for row in value if isinstance(row, dict)]


def select_biosample(records: Sequence[JsonObject], name: str) -> list[str]:
    """Return actual ontology IDs for an exact metadata biosample name."""
    ids: set[str] = set()
    for row in records:
        curie = row.get("ontology_curie")
        if str(row.get("biosample_name", "")).casefold() == name.casefold() and isinstance(curie, str):
            ids.add(curie)
    if not ids:
        raise ValueError(f"RNA-seq metadata has no biosample named {name!r}.")
    return sorted(ids)


def crop_indices(start: int, end: int, resolution: int, count: int,
                 crop_start: int, crop_end: int) -> tuple[int, int]:
    """Map a contained, bin-aligned genomic crop to row indices."""
    if resolution < 1 or count < 1 or end - start != count * resolution:
        raise ValueError("Track length, interval, and resolution disagree.")
    if not start <= crop_start < crop_end <= end:
        raise ValueError("Requested crop is outside the predicted interval.")
    if (crop_start - start) % resolution or (crop_end - start) % resolution:
        raise ValueError("Crop boundaries must align to track bins.")
    return (crop_start - start) // resolution, (crop_end - start) // resolution


def track_payload(rows: object, metadata: Sequence[JsonObject], *, start: int,
                  end: int, resolution: int) -> JsonObject:
    """Validate cropped values, retaining every numeric value and track record."""
    values = json_value(rows)
    if not isinstance(values, list) or not metadata:
        raise ValueError("A track requires values and metadata.")
    if end <= start or resolution < 1 or end - start != len(values) * resolution:
        raise ValueError("Cropped values do not match the genomic interval.")
    for row in values:
        if not isinstance(row, list) or len(row) != len(metadata):
            raise ValueError("Value columns do not match track metadata.")
        if any(isinstance(number, bool) or not isinstance(number, (int, float)) for number in row):
            raise ValueError("Track values must be numeric.")
    return {
        "chromosome": "chr9", "start": start, "end": end,
        "coordinateConvention": "0-based half-open", "resolutionBp": resolution,
        "metadata": json_value(list(metadata)), "values": values,
        "valueMeaning": "Native model-predicted values for the enclosing output type; not confidence or disease probability.",
    }


def encoded_json(value: object) -> bytes:
    """Encode precise JSON and reject a payload too large for the analytical import."""
    encoded = (json.dumps(json_value(value), ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode()
    if len(encoded) > PAYLOAD_LIMIT:
        raise ValueError("Result exceeds the 2 MiB analytical limit; choose a narrower explicit crop.")
    return encoded


def normalized_analysis(source: JsonObject, descriptor: VariantDescriptor,
                        artifact_filename: str, artifact_sha256: str) -> JsonObject:
    """Flatten every supplied track bin into the lab schema without changing signal values."""
    if source.get("variant") != descriptor.id or source.get("sourceKind") != "model_inference":
        raise ValueError("Result identity does not match the selected variant descriptor.")
    if not artifact_filename or artifact_filename in (".", "..") or re.search(r"[\\/\x00-\x1f\x7f]", artifact_filename) or len(artifact_filename) > 240 or not re.fullmatch("[a-f0-9]{64}", artifact_sha256):
        raise ValueError("Provide a safe raw artifact basename and its SHA-256.")
    outputs = source.get("outputs")
    runtime = source.get("provenance")
    if not isinstance(outputs, list) or not outputs or not isinstance(runtime, dict):
        raise ValueError("Result is missing its original tracks or runtime provenance.")
    expected_input = {"chromosome": descriptor.chromosome, "start": descriptor.input_start, "end": descriptor.input_end, "coordinateSystem": "0-based-half-open"}
    if source.get("inputInterval") != expected_input or runtime.get("inputSequenceSha256") != descriptor.context_sha256:
        raise ValueError("Result input context differs from the verified variant descriptor.")
    display = source.get("outputInterval")
    if not isinstance(display, dict) or display.get("chromosome") != descriptor.chromosome or display.get("coordinateSystem") != "0-based-half-open":
        raise ValueError("Result display coordinates are missing or invalid.")
    start, end = display.get("start"), display.get("end")
    if type(start) is not int or type(end) is not int or not descriptor.input_start <= start <= descriptor.position - 1 < end <= descriptor.input_end:
        raise ValueError("The display must contain this exact variant inside its verified input context.")
    rows: list[JsonObject] = []
    metadata: list[JsonObject] = []
    seen_outputs: set[str] = set()
    for output in outputs:
        if not isinstance(output, dict) or output.get("outputType") not in OUTPUT_TYPES:
            raise ValueError("Unsupported or missing model output type.")
        name = str(output["outputType"])
        if name in seen_outputs:
            raise ValueError("Duplicate output type.")
        seen_outputs.add(name)
        ref, alt = output.get("reference"), output.get("alternate")
        if not isinstance(ref, dict) or not isinstance(alt, dict) or ref.get("metadata") != alt.get("metadata"):
            raise ValueError("Reference and alternate metadata must match exactly.")
        records = ref.get("metadata")
        if not isinstance(records, list) or not all(isinstance(record, dict) for record in records):
            raise ValueError("Original per-track metadata is required.")
        for matrix in (ref, alt):
            if matrix.get("chromosome") != descriptor.chromosome or matrix.get("start") != start or matrix.get("end") != end or matrix.get("resolutionBp") != 1:
                raise ValueError("All returned tracks must use the same one-base display coordinates.")
            track_payload(matrix.get("values"), records, start=start, end=end, resolution=1)
        if len(rows) + (end - start) * len(records) > ROW_LIMIT:
            raise ValueError("Complete result exceeds 5000 analytical rows; no tracks or bins were dropped.")
        ref_values, alt_values = ref["values"], alt["values"]
        for index, record in enumerate(records):
            track_name = record.get("name")
            if not isinstance(track_name, str) or not track_name.strip() or track_name.lower() == "padding":
                raise ValueError("Every biological model track needs its original name.")
            key = f"{name}:{index}:{track_name}"
            if len(key) > 500:
                raise ValueError("Original track key exceeds the analytical metadata limit.")
            strand = record.get("strand")
            if strand not in (None, "+", "-", "."):
                raise ValueError("Unknown strand encoding; do not recode it silently.")
            unit = record.get("unit")
            if unit is not None and (not isinstance(unit, str) or not unit.strip() or len(unit) > 500):
                raise ValueError("Original units must be text or null when unspecified.")
            tissue_agnostic = name == "SPLICE_SITES"
            biosample_id, biosample_name = record.get("ontology_curie"), record.get("biosample_name")
            if tissue_agnostic and (biosample_id not in (None, "") or biosample_name not in (None, "")):
                raise ValueError("Tissue-agnostic splice-site metadata must not name a biosample.")
            if not tissue_agnostic and (biosample_id not in source.get("ontologyCuries", []) or not isinstance(biosample_name, str) or biosample_name.casefold() != str(source.get("biosample")).casefold()):
                raise ValueError("A tissue-specific track differs from the selected biosample.")
            metadata.append({"chromosome": descriptor.chromosome, "track": key, "outputType": name,
                "unit": unit, "strand": strand, "biosampleId": None if tissue_agnostic else biosample_id,
                "biosampleName": None if tissue_agnostic else biosample_name,
                "scope": "tissue_agnostic" if tissue_agnostic else "biosample_specific", "binSize": 1,
                "sourceName": track_name, "sourceIndex": index})
            rows.extend({"chromosome": descriptor.chromosome, "position": start + bin_index,
                "reference": ref_row[index], "alternate": alt_row[index], "track": key}
                for bin_index, (ref_row, alt_row) in enumerate(zip(ref_values, alt_values, strict=True)))
    if not rows:
        raise ValueError("No numerical tracks were returned.")
    transforms = [{"operation": "display_crop", "afterFullContextInference": True, "start": start, "end": end}]
    analysis: JsonObject = {
        "schemaVersion": 1, "kind": "tracks", "id": f"alphagenome-local-{artifact_sha256}",
        "title": f"DNM1 · {descriptor.id} · REF / ALT",
        "provenance": {"sourceUrl": "https://huggingface.co/google/alphagenome-all-folds",
            "sourceLabel": "Local AlphaGenome model result", "assembly": descriptor.reference_version,
            "model": "AlphaGenome local checkpoint; source identity is operator-supplied",
            "context": f"{descriptor.id}; {source.get('biosample')}; scope is recorded per track.",
            "recordedAt": source.get("createdAt"), "mode": "imported",
            "artifact": {"filename": artifact_filename, "sha256": artifact_sha256},
            "inference": {"variant": descriptor.id, "inputInterval": expected_input, "displayInterval": display,
                "modelRevision": runtime.get("researchRevision", "Not reported"), "clientRevision": runtime.get("clientRevision", "Not reported"),
                "checkpointRevision": "Not reported", "referenceVersion": descriptor.reference_version,
                "referenceSha256": None, "inputSequenceSha256": descriptor.context_sha256,
                "transformations": [json.dumps(item, separators=(",", ":")) for item in transforms]}},
        "rows": rows, "trackMetadata": metadata,
    }
    encoded_json(analysis)
    return analysis
