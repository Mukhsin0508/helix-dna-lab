"""Validate requests and exact, bounded results against the existing exporters."""

from __future__ import annotations

import hashlib
import hmac
import json
import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from junction_export import normalized_junction_analysis
from run_dnm1 import validate_output_selection
from track_export import PAYLOAD_LIMIT, centered_window, load_descriptor, normalized_analysis

ENVELOPE_LIMIT = 3 * PAYLOAD_LIMIT + 4096  # Raw JSON escaping plus a 2 MiB analysis.
OutputType = Literal['RNA_SEQ', 'SPLICE_SITES', 'SPLICE_SITE_USAGE', 'SPLICE_JUNCTIONS']


class PredictionRequest(BaseModel):
    """One exact supported variant; cropBp is always resolved before persistence."""

    model_config = ConfigDict(extra='forbid', strict=True)
    requestId: str = Field(min_length=1, max_length=128, pattern=r'^[A-Za-z0-9._-]+$')
    variantId: Literal['chr9:128225994:G>A', 'chr9:128226027:G>A']
    biosample: str = Field(min_length=1, max_length=200)
    outputs: list[OutputType] = Field(min_length=1, max_length=3)
    cropBp: int = 41

    @model_validator(mode='before')
    @classmethod
    def resolve_crop(cls, values: Any) -> Any:
        if isinstance(values, dict) and 'cropBp' not in values:
            return {**values, 'cropBp': 32768 if values.get('outputs') == ['SPLICE_JUNCTIONS'] else 41}
        return values

    @field_validator('biosample')
    @classmethod
    def exact_name(cls, value: str) -> str:
        if not value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError('Provide an exact, printable biosample name.')
        return value

    @model_validator(mode='after')
    def valid_selection(self) -> PredictionRequest:
        validate_output_selection(tuple(self.outputs), self.cropBp)
        self.outputs = sorted(self.outputs)
        return self


class ResultEnvelope(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    schemaVersion: Literal[2]
    analysis: dict[str, Any]
    sourceResultJson: str = Field(min_length=1, max_length=PAYLOAD_LIMIT)
    sourceResultSha256: str = Field(pattern=r'^[a-f0-9]{64}$')


def _finite_json(value: Any, depth: int = 0) -> None:
    """Reject non-JSON values, unbounded nesting and non-finite numbers."""
    if depth > 64:
        raise ValueError('JSON nesting exceeds 64 levels.')
    if value is None or type(value) in (str, bool, int):
        return
    if type(value) is float and math.isfinite(value):
        return
    if type(value) is list:
        for item in value:
            _finite_json(item, depth + 1)
        return
    if type(value) is dict and all(type(key) is str for key in value):
        for item in value.values():
            _finite_json(item, depth + 1)
        return
    raise ValueError('A finite JSON value is required.')


def _encode(value: Any, limit: int) -> bytes:
    _finite_json(value)
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                             separators=(',', ':')).encode('utf-8')
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ValueError('Invalid UTF-8 JSON.') from exc
    if len(encoded) > limit:
        raise ValueError('JSON exceeds the bounded result size.')
    return encoded


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON object keys are not allowed.')
        result[key] = value
    return result


def validate_result(result: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    """Return the exact envelope only after hash, request and normalization checks pass."""
    req = PredictionRequest.model_validate(request)
    envelope = ResultEnvelope.model_validate(result).model_dump()
    _encode(envelope, ENVELOPE_LIMIT)
    try:
        raw_bytes = envelope['sourceResultJson'].encode('utf-8')
    except UnicodeError as exc:
        raise ValueError('Source result must be UTF-8.') from exc
    if len(raw_bytes) > PAYLOAD_LIMIT:
        raise ValueError('Source result exceeds 2 MiB.')
    digest = hashlib.sha256(raw_bytes).hexdigest()
    if not hmac.compare_digest(digest, envelope['sourceResultSha256']):
        raise ValueError('Source result SHA-256 does not match its exact UTF-8 bytes.')
    try:
        source = json.loads(raw_bytes, object_pairs_hook=_unique_object)
        _finite_json(source)
    except (ValueError, RecursionError, UnicodeError) as exc:
        raise ValueError('Source result is not finite, bounded JSON.') from exc
    if not isinstance(source, dict) or type(source.get('schemaVersion')) is not int or source['schemaVersion'] != 2:
        raise ValueError('An actual runner schemaVersion 2 result is required.')
    if source.get('variant') != req.variantId or source.get('biosample') != req.biosample:
        raise ValueError('Source variant or biosample differs from the persisted request.')
    if source.get('serviceRequestId') != req.requestId:
        raise ValueError('Source service request ID differs from the persisted request.')
    outputs = source.get('outputs')
    if not isinstance(outputs, list) or not all(isinstance(output, dict) for output in outputs):
        raise ValueError('Source output types are required.')
    output_names = [output.get('outputType') for output in outputs]
    if not all(isinstance(name, str) for name in output_names) or len(output_names) != len(req.outputs) or set(output_names) != set(req.outputs):
        raise ValueError('Source output types differ from the persisted request.')
    descriptor = load_descriptor(req.variantId)
    start, end = centered_window(descriptor.position, req.cropBp)
    expected_interval = {'chromosome': descriptor.chromosome, 'start': start, 'end': end,
                         'coordinateSystem': '0-based-half-open'}
    if source.get('outputInterval') != expected_interval:
        raise ValueError('Source output interval differs from the requested crop.')
    normalize = normalized_junction_analysis if req.outputs == ['SPLICE_JUNCTIONS'] else normalized_analysis
    expected = normalize(source, descriptor, 'source-result.json', digest)
    # Comparing canonical JSON also distinguishes booleans from numerical values.
    if _encode(envelope['analysis'], PAYLOAD_LIMIT) != _encode(expected, PAYLOAD_LIMIT):
        raise ValueError('Provided analysis differs from authoritative normalization of the raw result.')
    return envelope
