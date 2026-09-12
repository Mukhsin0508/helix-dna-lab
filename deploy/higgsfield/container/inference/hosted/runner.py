"""Official SDK execution and metadata-preserving Helix conversion.

The hosting process must impose a 180-second wall-clock deadline. The public SDK
only exposes a channel-connection timeout, not per-call metadata/prediction deadlines.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import math
import os
import re
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from .contract import (
    CONTEXT_BP, FAI_URL, FASTA_URL, PAYLOAD_LIMIT, ROW_LIMIT, SDK_VERSION,
    HostedError, HostedRequest, JsonObject, JsonValue, encoded, interval,
    require_number, strict_json, verify_reference,
)

if TYPE_CHECKING:
    from alphagenome.data.track_data import TrackData
    import pandas as pd


def _json_native(value: object) -> JsonValue:
    """Preserve native metadata precision; pandas missing cells become explicit null."""
    import numpy as np
    import pandas as pd
    if value is None or value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, np.generic):
        plain = value.item()
        if type(plain) is type(value):
            raise HostedError('result_invalid')
        return _json_native(plain)
    if type(value) in (str, int, bool):
        if type(value) is int and abs(value) > 2**53 - 1:
            raise HostedError('result_invalid')
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return None  # Missing metadata only. Signal arrays are checked separately.
        if not math.isfinite(value):
            raise HostedError('result_invalid')
        return value
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise HostedError('result_invalid')
        return {key: _json_native(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, np.ndarray)):
        return [_json_native(item) for item in value]
    raise HostedError('result_invalid')


def metadata_records(frame: 'pd.DataFrame') -> list[JsonObject]:
    import pandas as pd
    if not isinstance(frame, pd.DataFrame) or not frame.columns.is_unique or not all(isinstance(column, str) for column in frame.columns):
        raise HostedError('result_invalid')
    if not {'name', 'strand', 'ontology_curie'}.issubset(frame.columns):
        raise HostedError('result_invalid')
    # DataFrame.to_json defaults to rounding; to_dict retains native numerical values.
    records = _json_native(frame.to_dict(orient='records'))
    if not isinstance(records, list) or not all(isinstance(record, dict) for record in records):
        raise HostedError('result_invalid')
    return records


def _text(value: object, maximum: int, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value.strip() or value != value.strip() or len(value) > maximum:
        raise HostedError('result_invalid')
    return value


def _metadata_key(metadata: JsonObject, request: HostedRequest) -> tuple[str, str | None]:
    name = _text(metadata.get('name'), 500)
    strand = metadata.get('strand')
    if strand not in ('+', '-', '.', None) or metadata.get('ontology_curie') != request.ontology_term or str(name).lower() == 'padding':
        raise HostedError('result_invalid')
    _text(metadata.get('biosample_name'), 300, nullable=True)
    unit = metadata.get('unit', metadata.get('units'))
    _text(unit, 500, nullable=True)
    if 'unit' in metadata and 'units' in metadata and metadata['unit'] != metadata['units']:
        raise HostedError('result_invalid')
    return name, strand


def _metadata_map(records: list[JsonObject], request: HostedRequest) -> dict[tuple[str, str | None], int]:
    if not records or len(records) > ROW_LIMIT:
        raise HostedError('result_invalid')
    result: dict[tuple[str, str | None], int] = {}
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise HostedError('result_invalid')
        key = _metadata_key(record, request)
        if key in result:
            raise HostedError('result_invalid')
        result[key] = index
    return result


def _metadata_equal(left: JsonObject, right: JsonObject) -> bool:
    """Allow catalog-union null columns to be absent in filtered SDK metadata.

    Identity fields remain explicit. Every reported optional value must still
    match, and neither input record is changed or stripped in the raw artifact.
    """
    required = {'name', 'strand', 'ontology_curie'}
    if not required.issubset(left) or not required.issubset(right):
        return False
    def comparable(record: JsonObject) -> JsonObject:
        return {key: value for key, value in record.items() if key in required or value is not None}
    return encoded(comparable(left)) == encoded(comparable(right))


def _native_interval(value: object) -> JsonObject:
    if value is None:
        raise HostedError('result_invalid')
    chromosome, start, end = value.chromosome, value.start, value.end
    if type(start) is not int or type(end) is not int or value.strand != '.':
        raise HostedError('result_invalid')
    return interval(chromosome, start, end)


def crop_track(data: 'TrackData', request: HostedRequest, expected_metadata: list[JsonObject]) -> JsonObject:
    """Crop exact bins from complete native arrays; do not resample, scale or round."""
    import numpy as np
    if data is None or not isinstance(data.values, np.ndarray):
        raise HostedError('result_invalid')
    values = data.values
    if values.ndim != 2 or values.dtype.kind not in ('f', 'i', 'u') or not np.isfinite(values).all():
        raise HostedError('result_invalid')
    original_interval = _native_interval(data.interval)
    if original_interval != request.input_interval:
        raise HostedError('result_invalid')
    resolution = data.resolution
    if type(resolution) is not int or resolution < 1 or values.shape[0] * resolution != CONTEXT_BP:
        raise HostedError('result_invalid')
    records = metadata_records(data.metadata)
    if values.shape[1] != len(records):
        raise HostedError('result_invalid')
    returned_keys, expected_keys = _metadata_map(records, request), _metadata_map(expected_metadata, request)
    if returned_keys.keys() != expected_keys.keys():
        raise HostedError('result_invalid')
    if any(not _metadata_equal(records[index], expected_metadata[expected_keys[key]]) for key, index in returned_keys.items()):
        raise HostedError('result_invalid')
    display = request.display_interval
    relative_start, relative_end = display['start'] - original_interval['start'], display['end'] - original_interval['start']
    if relative_start % resolution or relative_end % resolution:
        raise HostedError('result_invalid')
    start, end = relative_start // resolution, relative_end // resolution
    if (end - start) * len(records) > ROW_LIMIT:
        raise HostedError('result_too_large')
    cropped = values[start:end]
    if cropped.shape != (request.crop_bp // resolution, len(records)) or not cropped.size:
        raise HostedError('result_invalid')
    return {
        'interval': display, 'resolution': resolution, 'values': cropped.tolist(), 'valuesDtype': str(values.dtype),
        'metadata': records, 'metadataColumns': list(data.metadata.columns),
        'metadataIndex': _json_native(data.metadata.index.tolist()),
        'originalShape': list(values.shape), 'originalInterval': original_interval,
        'uns': _json_native(data.uns),
    }


def _validate_reference_evidence(evidence: object, request: HostedRequest) -> None:
    if not isinstance(evidence, dict) or evidence.get('method') != 'official-fasta-range':
        raise HostedError('result_invalid')
    required = {
        'referenceUrl': FASTA_URL, 'indexUrl': FAI_URL, 'referenceVersion': 'GRCh38.p13',
        'chromosome': request.chromosome, 'position1Based': request.position,
        'expectedReference': request.reference, 'observedReference': request.reference, 'referenceMatches': True,
    }
    if any(type(evidence.get(key)) is not type(value) or evidence.get(key) != value for key, value in required.items()):
        raise HostedError('result_invalid')
    if not all(isinstance(evidence.get(key), str) and re.fullmatch('[a-f0-9]{64}', evidence[key]) for key in ('indexSha256', 'checkedBaseSha256')):
        raise HostedError('result_invalid')
    offset = evidence.get('byteOffset')
    content_range = evidence.get('contentRange')
    match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', content_range) if isinstance(content_range, str) else None
    if type(offset) is not int or offset < 0 or not match or (int(match[1]), int(match[2])) != (offset, offset) or int(match[3]) <= offset:
        raise HostedError('result_invalid')


def _validate_track_payload(value: object, request: HostedRequest) -> tuple[JsonObject, dict[tuple[str, str | None], int]]:
    if not isinstance(value, dict) or set(value) != {'interval', 'resolution', 'values', 'valuesDtype', 'metadata', 'metadataColumns', 'metadataIndex', 'originalShape', 'originalInterval', 'uns'}:
        raise HostedError('result_invalid')
    if encoded(value['interval']) != encoded(request.display_interval) or encoded(value['originalInterval']) != encoded(request.input_interval):
        raise HostedError('result_invalid')
    resolution, values, metadata = value['resolution'], value['values'], value['metadata']
    if type(resolution) is not int or resolution < 1 or not isinstance(metadata, list) or not isinstance(values, list):
        raise HostedError('result_invalid')
    if request.crop_bp % resolution or (request.display_interval['start'] - request.input_interval['start']) % resolution:
        raise HostedError('result_invalid')
    if len(values) * resolution != request.crop_bp or not len(values):
        raise HostedError('result_invalid')
    if len(values) * len(metadata) > ROW_LIMIT:
        raise HostedError('result_too_large')
    metadata_by_key = _metadata_map(metadata, request)
    if not isinstance(value['originalShape'], list) or any(type(size) is not int for size in value['originalShape']) or value['originalShape'] != [CONTEXT_BP // resolution, len(metadata)] or CONTEXT_BP % resolution:
        raise HostedError('result_invalid')
    if not isinstance(value['valuesDtype'], str) or not re.fullmatch(r'(?:float|int|uint)(?:8|16|32|64)', value['valuesDtype']):
        raise HostedError('result_invalid')
    columns, indices = value['metadataColumns'], value['metadataIndex']
    if not isinstance(columns, list) or any(not isinstance(column, str) for column in columns) or len(set(columns)) != len(columns) or not isinstance(indices, list) or len(indices) != len(metadata):
        raise HostedError('result_invalid')
    if any(set(record) != set(columns) for record in metadata):
        raise HostedError('result_invalid')
    for row in values:
        if not isinstance(row, list) or len(row) != len(metadata):
            raise HostedError('result_invalid')
        for signal in row:
            require_number(signal)
    return value, metadata_by_key


def normalize_source(source: object, request: HostedRequest, raw_sha256: str) -> JsonObject:
    """Derive the analysis entirely from checked raw data, without trusting an analysis label."""
    if not isinstance(source, dict) or set(source) != {'schemaVersion', 'sourceKind', 'analysisId', 'request', 'sdk', 'serverModelRevision', 'recordedAt', 'inputInterval', 'displayInterval', 'referenceVerification', 'tracks', 'transformations'}:
        raise HostedError('result_invalid')
    if type(source['schemaVersion']) is not int or source['schemaVersion'] != 1 or source['sourceKind'] != 'alphagenome_hosted_prediction':
        raise HostedError('result_invalid')
    if encoded(source['request']) != encoded(request.source_request()) or source['sdk'] != {'package': 'alphagenome', 'version': SDK_VERSION} or source['serverModelRevision'] is not None:
        raise HostedError('result_invalid')
    if encoded(source['inputInterval']) != encoded(request.input_interval) or encoded(source['displayInterval']) != encoded(request.display_interval):
        raise HostedError('result_invalid')
    try:
        if not isinstance(source['analysisId'], str) or str(uuid.UUID(source['analysisId'])) != source['analysisId']:
            raise ValueError('id')
        recorded = datetime.fromisoformat(source['recordedAt'].replace('Z', '+00:00'))
        if recorded.tzinfo is None:
            raise ValueError('timezone')
    except (TypeError, ValueError, AttributeError) as cause:
        raise HostedError('result_invalid') from cause
    _validate_reference_evidence(source['referenceVerification'], request)
    tracks = source['tracks']
    if not isinstance(tracks, dict) or set(tracks) != {'reference', 'alternate'}:
        raise HostedError('result_invalid')
    reference, ref_keys = _validate_track_payload(tracks['reference'], request)
    alternate, alt_keys = _validate_track_payload(tracks['alternate'], request)
    if reference['resolution'] != alternate['resolution'] or ref_keys.keys() != alt_keys.keys():
        raise HostedError('result_invalid')
    rows: list[JsonObject] = []
    track_metadata: list[JsonObject] = []
    for key, ref_index in ref_keys.items():
        alt_index = alt_keys[key]
        meta, alt_meta = reference['metadata'][ref_index], alternate['metadata'][alt_index]
        if not _metadata_equal(meta, alt_meta):
            raise HostedError('result_invalid')
        name, strand = key
        track_key = f'RNA_SEQ[{ref_index}]:{name}'
        _text(track_key, 500)
        for position_index, row in enumerate(reference['values']):
            rows.append({'chromosome': request.chromosome, 'position': request.display_interval['start'] + position_index * reference['resolution'], 'reference': row[ref_index], 'alternate': alternate['values'][position_index][alt_index], 'track': track_key})
        track_metadata.append({
            'chromosome': request.chromosome, 'track': track_key, 'outputType': 'RNA_SEQ',
            'unit': meta.get('unit', meta.get('units')), 'strand': strand,
            'biosampleId': request.ontology_term, 'biosampleName': meta.get('biosample_name'),
            'scope': 'biosample_specific', 'binSize': reference['resolution'], 'sourceName': name, 'sourceIndex': ref_index,
        })
    if not rows or len(rows) > ROW_LIMIT:
        raise HostedError('result_too_large')
    transformations = source['transformations']
    if encoded(transformations) != encoded(transformations_for(request)):
        raise HostedError('result_invalid')
    analysis: JsonObject = {
        'schemaVersion': 1, 'id': source['analysisId'], 'title': f'{request.variant_id} · RNA-seq prediction', 'kind': 'tracks',
        'provenance': {
            'sourceUrl': 'https://github.com/google-deepmind/alphagenome', 'sourceLabel': 'Google DeepMind · hosted AlphaGenome API',
            'assembly': 'GRCh38', 'model': 'AlphaGenome hosted API · requested ALL_FOLDS',
            'context': f'Actual hosted RNA-seq prediction for {request.ontology_term}. Native {request.crop_bp} bp crop from a 1,048,576 bp context; no resampling. Internal server revision not reported. One REF base independently checked, not the full context.',
            'recordedAt': source['recordedAt'], 'mode': 'imported',
            'artifact': {'filename': 'source-result.json', 'sha256': raw_sha256},
            'inference': {
                'variant': request.variant_id, 'inputInterval': request.input_interval, 'displayInterval': request.display_interval,
                'modelRevision': 'Not reported by hosted service', 'clientRevision': f'alphagenome {SDK_VERSION}',
                'checkpointRevision': 'Not exposed by hosted service', 'referenceVersion': 'GRCh38.p13', 'referenceSha256': None,
                'transformations': [encoded(item, 1000) for item in transformations],
            },
        },
        'rows': rows, 'trackMetadata': track_metadata,
    }
    encoded(analysis)
    return analysis


def transformations_for(request: HostedRequest) -> list[JsonObject]:
    return [
        {'operation': 'crop', 'inputInterval': request.input_interval, 'displayInterval': request.display_interval, 'method': 'Exact native bin slice; full-context arrays are not included in the sidecar.'},
        {'operation': 'flatten', 'method': 'One analysis row per native bin and track; no downsampling, interpolation, scaling or rounding. REF/ALT matched by name and strand after full metadata equality.'},
        {'operation': 'metadata_serialization', 'method': 'Preserve DataFrame records, column order and index; native missing metadata cells are null. Numerical signal NaN or infinity is rejected.'},
    ]


def validate_envelope(envelope: object, request: HostedRequest | dict[str, object]) -> JsonObject:
    """Verify exact raw bytes, request identity and normalized numerical/metadata equality."""
    parsed_request = request if isinstance(request, HostedRequest) else HostedRequest.parse(request)
    if not isinstance(envelope, dict) or set(envelope) != {'analysis', 'sourceResultJson', 'sourceResultSha256'}:
        raise HostedError('result_invalid')
    raw, digest = envelope['sourceResultJson'], envelope['sourceResultSha256']
    if not isinstance(raw, str) or len(raw.encode()) > PAYLOAD_LIMIT or not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
        raise HostedError('result_invalid')
    if hashlib.sha256(raw.encode('utf-8')).hexdigest() != digest:
        raise HostedError('result_invalid')
    try:
        source = strict_json(raw)
    except HostedError as cause:
        raise HostedError('result_invalid') from cause
    normalized = normalize_source(source, parsed_request, digest)
    if encoded(normalized) != encoded(envelope['analysis']):
        raise HostedError('result_invalid')
    encoded(envelope, PAYLOAD_LIMIT * 3)
    return envelope


def _service_error(cause: Exception) -> HostedError:
    # Never stringify a transport error: its details may contain request credentials.
    try:
        import grpc
        if isinstance(cause, grpc.RpcError):
            if cause.code() in (grpc.StatusCode.UNAUTHENTICATED, grpc.StatusCode.PERMISSION_DENIED):
                return HostedError('authentication_failed')
            if cause.code() == grpc.StatusCode.RESOURCE_EXHAUSTED:
                return HostedError('rate_limited')
    except ImportError:
        pass
    return HostedError('service_unavailable')


def run_prediction(request: HostedRequest) -> JsonObject:
    """Run one real human RNA-seq request. No default key, fake result or local checkpoint."""
    api_key = os.environ.get('ALPHAGENOME_API_KEY', '')
    if not api_key or not api_key.strip():
        raise HostedError('missing_api_key')
    try:
        actual_sdk_version = importlib.metadata.version('alphagenome')
        if actual_sdk_version != SDK_VERSION:
            raise HostedError('dependency_error')
        from alphagenome.data import genome
        from alphagenome.models import dna_client
    except HostedError:
        raise
    except Exception as cause:
        raise HostedError('dependency_error') from cause
    native_variant = genome.Variant(chromosome=request.chromosome, position=request.position, reference_bases=request.reference, alternate_bases=request.alternate)
    native_input = native_variant.reference_interval.resize(CONTEXT_BP)
    native_display = native_variant.reference_interval.resize(request.crop_bp)
    if _native_interval(native_input) != request.input_interval or _native_interval(native_display) != request.display_interval:
        raise HostedError('result_invalid')
    reference_evidence = verify_reference(request)
    try:
        model = dna_client.create(api_key, model_version=dna_client.ModelVersion.ALL_FOLDS, timeout=15)
        output_metadata = model.output_metadata(organism=dna_client.Organism.HOMO_SAPIENS)
    except Exception as cause:
        raise _service_error(cause) from cause
    if output_metadata.rna_seq is None:
        raise HostedError('unsupported_tissue')
    records = metadata_records(output_metadata.rna_seq)
    selected = [record for record in records if record.get('ontology_curie') == request.ontology_term]
    if not selected:
        raise HostedError('unsupported_tissue')
    _metadata_map(selected, request)
    # RNA-seq is native 1bp in this API. Fail early for a request that cannot fit;
    # actual returned resolution and row count are checked again, never assumed.
    if len(selected) * request.crop_bp > ROW_LIMIT:
        raise HostedError('result_too_large')
    try:
        output = model.predict_variant(interval=native_input, variant=native_variant,
            organism=dna_client.Organism.HOMO_SAPIENS, requested_outputs=[dna_client.OutputType.RNA_SEQ], ontology_terms=[request.ontology_term])
    except Exception as cause:
        raise _service_error(cause) from cause
    try:
        reference = crop_track(output.reference.rna_seq, request, selected)
        alternate = crop_track(output.alternate.rna_seq, request, selected)
    except HostedError:
        raise
    except Exception as cause:
        raise HostedError('result_invalid') from cause
    source: JsonObject = {
        'schemaVersion': 1, 'sourceKind': 'alphagenome_hosted_prediction', 'analysisId': str(uuid.uuid4()),
        'request': request.source_request(), 'sdk': {'package': 'alphagenome', 'version': actual_sdk_version},
        'serverModelRevision': None, 'recordedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'inputInterval': request.input_interval, 'displayInterval': request.display_interval,
        'referenceVerification': reference_evidence, 'tracks': {'reference': reference, 'alternate': alternate},
        'transformations': transformations_for(request),
    }
    raw = encoded(source)
    digest = hashlib.sha256(raw.encode('utf-8')).hexdigest()
    analysis = normalize_source(source, request, digest)
    return validate_envelope({'analysis': analysis, 'sourceResultJson': raw, 'sourceResultSha256': digest}, request)
