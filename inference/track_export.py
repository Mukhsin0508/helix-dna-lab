"""Dependency-free validation for cropped AlphaGenome RNA track exports."""

from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from typing import TypeAlias

JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]
REFERENCE_WINDOW = "CACTTCTCCTCCCCACCCACGGCTGCTCCTCCTCCTGTCCC"
POSITION = 128225994
CONTEXT_BP = 1048576


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
        "valueMeaning": "Model-predicted RNA-seq track values; not confidence or disease probability.",
    }
