"""Export actual AlphaGenome junction matrices without inferred missing values.

Pinned primary sources inspected on 2026-09-11 are recorded in SOURCE_FORMAT.
JunctionData already contains absolute genome.Junction coordinates. In particular,
the research unstacker has already applied its start offset: never add one here.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Sequence
from typing import TYPE_CHECKING

from track_export import (
    ROW_LIMIT, JsonObject, VariantDescriptor, encoded_json, json_value,
)

if TYPE_CHECKING:
    from alphagenome.data.junction_data import JunctionData

JUNCTION_OUTPUT = "SPLICE_JUNCTIONS"
DEFAULT_JUNCTION_CROP_BP = 32768
SOURCE_FORMAT: JsonObject = {
    "clientRevision": "aa6fc8f6faadcb8c910fa2b85b57386fbd5c7b5d",
    "junctionDataSource": "https://raw.githubusercontent.com/google-deepmind/alphagenome/aa6fc8f6faadcb8c910fa2b85b57386fbd5c7b5d/src/alphagenome/data/junction_data.py",
    "junctionDataSourceSha256": "915d5a248889409933a6922920339ee9d4981084e8009e4ec2ad6530bc8c511c",
    "metadataParserSource": "https://raw.githubusercontent.com/google-deepmind/alphagenome/aa6fc8f6faadcb8c910fa2b85b57386fbd5c7b5d/src/alphagenome/models/junction_data_utils.py",
    "metadataParserSourceSha256": "652c205e2b1930843d1446d810eefc99b2603edefe4e19732cc40bf14020ed14",
    "humanMetadataSource": "https://raw.githubusercontent.com/google-deepmind/alphagenome_research/0db53bd4352c66d1e00a049a81da373a066e6670/src/alphagenome_research/model/metadata/OutputMetadataResponse_ORGANISM_HOMO_SAPIENS.textproto",
    "humanMetadataSourceSha256": "413b4063096bbf7a75a7fdf5560030f8e3866c6af2455fb313e58686ae3d49e8",
    "researchRevision": "0db53bd4352c66d1e00a049a81da373a066e6670",
    "converterSource": "https://raw.githubusercontent.com/google-deepmind/alphagenome_research/0db53bd4352c66d1e00a049a81da373a066e6670/src/alphagenome_research/model/dna_model.py",
    "converterSourceSha256": "6966f3ca0b9e6b96a2be15a9bffeb277c9c20436c72d8769c8ded9d3e039cf7a",
    "unstackerSource": "https://raw.githubusercontent.com/google-deepmind/alphagenome_research/0db53bd4352c66d1e00a049a81da373a066e6670/src/alphagenome_research/model/variant_scoring/splice_junction.py",
    "unstackerSourceSha256": "47f84d74393ee4d830e58c668a9b33e746e2697efac296b586bf1fa26e75978f",
    "coordinateRule": "Copy returned genome.Junction start/end, already absolute 0-based half-open; do not offset or reverse-complement.",
    "matrixAxes": ["junction", "track"],
    "verificationScope": "Pinned source inspected and checksummed; this does not authenticate installed code or loaded checkpoint.",
}


def _input_interval(descriptor: VariantDescriptor) -> JsonObject:
    return {"chromosome": descriptor.chromosome, "start": descriptor.input_start,
            "end": descriptor.input_end, "coordinateSystem": "0-based-half-open"}


def _junction_key(record: JsonObject, descriptor: VariantDescriptor) -> tuple[str, int, int, str]:
    """Validate the actual endpoints and return a strand-aware genomic identity."""
    chromosome, start, end, strand = (record.get(key) for key in ("chromosome", "start", "end", "strand"))
    if chromosome != descriptor.chromosome or type(start) is not int or type(end) is not int:
        raise ValueError("Junction coordinates must be integer positions on the verified chromosome.")
    if not descriptor.input_start <= start < end <= descriptor.input_end or strand not in ("+", "-"):
        raise ValueError("Junction endpoints must stay inside the model input and have a + or - strand.")
    return descriptor.chromosome, start, end, str(strand)


def junction_payload(junctions: Sequence[JsonObject], values: object,
                     metadata: Sequence[JsonObject], descriptor: VariantDescriptor,
                     crop_start: int, crop_end: int, *,
                     source_indices: Sequence[int], returned_count: int,
                     uns: object = None, value_dtype: str | None = None) -> JsonObject:
    """Validate a display-overlapping matrix while preserving original row order and endpoints."""
    if not descriptor.input_start <= crop_start <= descriptor.position - 1 < crop_end <= descriptor.input_end:
        raise ValueError("The junction display must contain the exact variant inside its input context.")
    rows, records = json_value(values), json_value(list(metadata))
    if not isinstance(rows, list) or len(rows) != len(junctions) or not records:
        raise ValueError("Junction matrix rows or track metadata are missing or misaligned.")
    if type(returned_count) is not int or returned_count < len(junctions):
        raise ValueError("Returned junction count is inconsistent with the selected matrix.")
    if len(source_indices) != len(junctions) or any(type(index) is not int or not 0 <= index < returned_count for index in source_indices) or list(source_indices) != sorted(set(source_indices)):
        raise ValueError("Source junction row indices must be unique, ordered and in bounds.")
    if len(junctions) * len(metadata) > ROW_LIMIT:
        raise ValueError("Junctions × tracks exceed 5000 rows; choose a narrower explicit crop. No values were dropped.")
    seen: set[tuple[str, int, int, str]] = set()
    for junction, row in zip(junctions, rows, strict=True):
        key = _junction_key(junction, descriptor)
        if key in seen:
            raise ValueError("Duplicate junction identity in one allele cannot be aligned unambiguously.")
        seen.add(key)
        if not key[1] < crop_end or not key[2] > crop_start:
            raise ValueError("Every exported junction must overlap the display interval.")
        if not isinstance(row, list) or len(row) != len(metadata):
            raise ValueError("Junction matrix columns do not match original track metadata.")
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 for value in row):
            raise ValueError("Returned junction values must be finite nonnegative numbers; missing alleles are aligned later.")
    return {"inputInterval": _input_interval(descriptor),
        "coordinateConvention": "0-based-half-open", "matrixAxes": ["junction", "track"],
        "junctions": json_value(list(junctions)), "values": rows, "metadata": records,
        "sourceJunctionIndices": list(source_indices), "returnedJunctionCount": returned_count,
        "valueDtype": value_dtype, "uns": json_value(uns),
        "selection": {"operation": "display_overlap", "start": crop_start, "end": crop_end,
            "endpointsClipped": False, "valueThreshold": None, "normalization": "none_added"},
        "valueMeaning": "Native returned SPLICE_JUNCTIONS values. No normalization, threshold, splice-rate interpretation or clinical probability was added."}


def serialize_junctions(data: JunctionData, descriptor: VariantDescriptor,
                        crop_start: int, crop_end: int) -> JsonObject:
    """Serialize a real returned JunctionData matrix; model dependencies are imported only here."""
    import numpy as np

    interval = data.interval
    if interval is None or (interval.chromosome, interval.start, interval.end) != (descriptor.chromosome, descriptor.input_start, descriptor.input_end) or interval.strand == "-":
        raise ValueError("Returned junction interval does not match the verified forward model input.")
    # The official proto parser creates sparse DataFrame columns. Preserve their
    # missing cells as JSON null, without DataFrame.to_json's float rounding.
    frame = data.metadata.astype(object).where(data.metadata.notna(), None)
    original_records = json_value(frame.to_dict(orient="records"))
    if not isinstance(original_records, list) or not all(isinstance(record, dict) for record in original_records):
        raise ValueError("Original junction track metadata must contain JSON-compatible records.")
    records = [record for record in original_records if isinstance(record, dict)]
    values = np.asarray(data.values)
    if values.ndim != 2 or values.shape != (len(data.junctions), len(records)) or values.dtype.kind not in "fiu" or not np.isfinite(values).all() or (values < 0).any():
        raise ValueError("Returned JunctionData matrix is not finite, nonnegative or aligned with coordinates/metadata.")
    selected: list[int] = []
    junctions: list[JsonObject] = []
    for index, junction in enumerate(data.junctions):
        # The actual research converter returns numpy integer coordinates.
        if isinstance(junction.start, (bool, np.bool_)) or not isinstance(junction.start, (int, np.integer)) or isinstance(junction.end, (bool, np.bool_)) or not isinstance(junction.end, (int, np.integer)):
            raise ValueError("Returned junction endpoints are not integers.")
        record: JsonObject = {"chromosome": junction.chromosome, "start": int(junction.start),
            "end": int(junction.end), "strand": junction.strand,
            "name": junction.name, "info": json_value(junction.info), "k": json_value(junction.k)}
        _, start, end, _ = _junction_key(record, descriptor)
        if start < crop_end and end > crop_start:
            selected.append(index)
            junctions.append(record)
    if len(selected) * len(records) > ROW_LIMIT:
        raise ValueError("Junctions × tracks exceed 5000 rows; choose a narrower explicit crop. No values were dropped.")
    payload = junction_payload(junctions, values[selected].astype(np.float64).tolist(), records,
        descriptor, crop_start, crop_end, source_indices=selected, returned_count=len(data.junctions),
        uns=data.uns, value_dtype=str(values.dtype))
    payload["metadataIndex"] = json_value(data.metadata.index.tolist())
    payload["metadataIndexName"] = json_value(data.metadata.index.name)
    payload["metadataEncoding"] = "Original DataFrame records; missing pandas cells become JSON null; finite numerical metadata is not rounded."
    return payload


def _read_allele(payload: object, descriptor: VariantDescriptor, start: int,
                 end: int) -> tuple[dict[str, JsonObject], dict[tuple[str, int, int, str], dict[str, int | float]]]:
    """Read one raw allele by full junction identity and unique original track name."""
    if not isinstance(payload, dict) or payload.get("inputInterval") != _input_interval(descriptor) or payload.get("coordinateConvention") != "0-based-half-open":
        raise ValueError("Allele junction context or coordinate convention is invalid.")
    junctions, records, values = payload.get("junctions"), payload.get("metadata"), payload.get("values")
    indices, count = payload.get("sourceJunctionIndices"), payload.get("returnedJunctionCount")
    if not isinstance(junctions, list) or not all(isinstance(row, dict) for row in junctions) or not isinstance(records, list) or not all(isinstance(row, dict) for row in records) or not isinstance(indices, list) or type(count) is not int:
        raise ValueError("Original junction coordinates, metadata and source row indices are required.")
    checked = junction_payload(junctions, values, records, descriptor, start, end,
        source_indices=indices, returned_count=count, uns=payload.get("uns"), value_dtype=payload.get("valueDtype"))
    if payload.get("selection") != checked["selection"] or payload.get("matrixAxes") != checked["matrixAxes"]:
        raise ValueError("Junction source selection or matrix axes changed.")
    tracks: dict[str, JsonObject] = {}
    for record in records:
        name = record.get("name")
        if not isinstance(name, str) or not name.strip() or name.strip().lower() == "padding" or len(name) > 400 or name in tracks:
            raise ValueError("Junction metadata requires unique original biological track names.")
        tracks[name] = record
    matrix: dict[tuple[str, int, int, str], dict[str, int | float]] = {}
    for junction, row in zip(junctions, checked["values"], strict=True):
        matrix[_junction_key(junction, descriptor)] = dict(zip(tracks, row, strict=True))
    return tracks, matrix


def normalized_junction_analysis(source: JsonObject, descriptor: VariantDescriptor,
                                artifact_filename: str, artifact_sha256: str) -> JsonObject:
    """Align actual REF/ALT matrices by junction and track identity, representing absence as null."""
    if source.get("variant") != descriptor.id or source.get("sourceKind") != "model_inference":
        raise ValueError("Junction result identity does not match the selected verified variant.")
    if not artifact_filename or artifact_filename in (".", "..") or re.search(r"[\\/\x00-\x1f\x7f]", artifact_filename) or len(artifact_filename) > 240 or not re.fullmatch("[a-f0-9]{64}", artifact_sha256):
        raise ValueError("Provide a safe raw artifact basename and SHA-256.")
    runtime, display, outputs = source.get("provenance"), source.get("outputInterval"), source.get("outputs")
    if not isinstance(runtime, dict) or source.get("inputInterval") != _input_interval(descriptor) or runtime.get("inputSequenceSha256") != descriptor.context_sha256:
        raise ValueError("Junction result context differs from the exact variant's verified sequence.")
    if not isinstance(display, dict) or display.get("chromosome") != descriptor.chromosome or display.get("coordinateSystem") != "0-based-half-open":
        raise ValueError("Junction display coordinates are missing or invalid.")
    start, end = display.get("start"), display.get("end")
    if type(start) is not int or type(end) is not int or not descriptor.input_start <= start <= descriptor.position - 1 < end <= descriptor.input_end:
        raise ValueError("Junction display must contain this variant inside its verified input.")
    if not isinstance(outputs, list) or len(outputs) != 1 or not isinstance(outputs[0], dict) or outputs[0].get("outputType") != JUNCTION_OUTPUT:
        raise ValueError("Junction output is exclusive; do not mix it with positional tracks.")
    ref_tracks, reference = _read_allele(outputs[0].get("reference"), descriptor, start, end)
    alt_tracks, alternate = _read_allele(outputs[0].get("alternate"), descriptor, start, end)
    tracks = dict(ref_tracks)
    for name, record in alt_tracks.items():
        if name in tracks and record != tracks[name]:
            raise ValueError("Same-named REF/ALT junction tracks have different original metadata.")
        tracks[name] = record
    keys = list(reference) + [key for key in alternate if key not in reference]
    selected_curies, selected_biosample = source.get("ontologyCuries"), source.get("biosample")
    if not isinstance(selected_curies, list) or not selected_curies or not all(isinstance(curie, str) and curie for curie in selected_curies) or not isinstance(selected_biosample, str) or not selected_biosample.strip():
        raise ValueError("The actual selected biosample and ontology identifiers are required.")
    rows: list[JsonObject] = []
    metadata: list[JsonObject] = []
    for index, (name, record) in enumerate(tracks.items()):
        strand, unit = record.get("strand"), record.get("unit")
        curie, biosample = record.get("ontology_curie"), record.get("biosample_name")
        if strand not in (None, "+", "-", ".") or (unit is not None and (not isinstance(unit, str) or not unit.strip() or len(unit) > 500)):
            raise ValueError("Junction track strand or unit is invalid; do not recode metadata.")
        if not isinstance(curie, str) or curie not in selected_curies or not isinstance(biosample, str) or biosample.casefold() != selected_biosample.casefold():
            raise ValueError("Junction track metadata differs from the actual selected biosample.")
        track_key = f"{JUNCTION_OUTPUT}:{index}:{name}"
        track_rows: list[JsonObject] = []
        for chromosome, junction_start, junction_end, junction_strand in keys:
            coordinate = (chromosome, junction_start, junction_end, junction_strand)
            ref = reference.get(coordinate, {}).get(name)
            alt = alternate.get(coordinate, {}).get(name)
            if ref is None and alt is None:
                continue
            if strand in ("+", "-") and strand != junction_strand:
                raise ValueError("Junction strand conflicts with its original track metadata.")
            track_rows.append({"chromosome": chromosome, "start": junction_start, "end": junction_end,
                "strand": junction_strand, "track": track_key, "reference": ref, "alternate": alt})
            if len(rows) + len(track_rows) > ROW_LIMIT:
                raise ValueError("Aligned junctions × tracks exceed 5000 rows; no arcs or tracks were dropped.")
        if track_rows:
            rows.extend(track_rows)
            metadata.append({"chromosome": descriptor.chromosome, "track": track_key,
                "outputType": JUNCTION_OUTPUT, "strand": strand, "unit": unit,
                "biosampleId": curie, "biosampleName": biosample, "scope": "biosample_specific",
                "sourceName": name})
    if not rows:
        raise ValueError("No junction overlaps the requested display; no analytical result was created.")
    transform = {"operation": "display_overlap", "afterFullContextInference": True,
        "start": start, "end": end, "endpointsClipped": False,
        "alignment": "chromosome/start/end/strand and original track identity", "missingAllele": None,
        "rowOrder": "Track metadata in REF order then ALT-only; within each track, junctions in REF order then ALT-only."}
    analysis: JsonObject = {"schemaVersion": 1, "kind": "junctions",
        "id": f"alphagenome-local-junctions-{artifact_sha256}", "title": f"DNM1 · {descriptor.id} · junctions",
        "variant": descriptor.id, "interval": display,
        "provenance": {"sourceUrl": "https://huggingface.co/google/alphagenome-all-folds",
            "sourceLabel": "Local AlphaGenome junction result", "assembly": descriptor.reference_version,
            "model": "AlphaGenome local checkpoint; source identity is operator-supplied",
            "context": f"{descriptor.id}; {source.get('biosample')}; native junction values; missing allele is null.",
            "recordedAt": source.get("createdAt"), "mode": "imported",
            "artifact": {"filename": artifact_filename, "sha256": artifact_sha256},
            "inference": {"variant": descriptor.id, "inputInterval": _input_interval(descriptor), "displayInterval": display,
                "modelRevision": runtime.get("researchRevision", "Not reported"), "clientRevision": runtime.get("clientRevision", "Not reported"),
                "checkpointRevision": "Not reported", "referenceVersion": descriptor.reference_version,
                "referenceSha256": None, "inputSequenceSha256": descriptor.context_sha256,
                "transformations": [json.dumps(transform, separators=(",", ":"))]}},
        "rows": rows, "trackMetadata": metadata}
    encoded_json(analysis)
    return analysis
