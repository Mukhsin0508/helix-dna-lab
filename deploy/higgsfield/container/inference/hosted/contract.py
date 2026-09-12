"""Strict, dependency-free request and reference validation for hosted inference."""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from typing import TypeAlias
from urllib.request import HTTPRedirectHandler, Request, build_opener

JsonValue: TypeAlias = str | int | float | bool | None | list['JsonValue'] | dict[str, 'JsonValue']
JsonObject: TypeAlias = dict[str, JsonValue]
CONTEXT_BP = 1_048_576
ROW_LIMIT = 5_000
PAYLOAD_LIMIT = 2 * 1024 * 1024
INPUT_LIMIT = 4096
SDK_VERSION = '0.9.0'
FASTA_URL = 'https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa'
FAI_URL = FASTA_URL + '.fai'
CHROMOSOME_LENGTHS = dict(zip(
    [f'chr{i}' for i in range(1, 23)] + ['chrX', 'chrY'],
    [248956422, 242193529, 198295559, 190214555, 181538259, 170805979,
     159345973, 145138636, 138394717, 133797422, 135086622, 133275309,
     114364328, 107043718, 101991189, 90338345, 83257441, 80373285,
     58617616, 64444167, 46709983, 50818468, 156040895, 57227415], strict=True))
ERROR_MESSAGES = {
    'invalid_request': 'Use one human GRCh38 nuclear SNV, a supported ontology term, and cropBp from 32 to 1024.',
    'missing_api_key': 'The hosted AlphaGenome API key is not configured.',
    'dependency_error': 'Install the pinned hosted AlphaGenome client requirements.',
    'reference_unavailable': 'The official GRCh38 reference could not be verified.',
    'reference_mismatch': 'The supplied reference allele does not match official GRCh38.p13 DNA.',
    'unsupported_tissue': 'This ontology term has no matching RNA-seq tracks in the hosted metadata.',
    'result_invalid': 'The returned prediction could not be validated. No analysis was created.',
    'result_too_large': 'The complete requested result exceeds the analysis limit. Choose a smaller explicit crop.',
    'service_unavailable': 'The hosted prediction service is unavailable or did not finish.',
    'rate_limited': 'The hosted prediction service quota is currently exhausted.',
    'authentication_failed': 'The hosted prediction service did not authorize this API key.',
    'output_unavailable': 'The requested output file could not be created.',
}

class HostedError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(ERROR_MESSAGES[code])


def strict_json(text: str) -> JsonValue:
    def pairs(items: list[tuple[str, JsonValue]]) -> JsonObject:
        value: JsonObject = {}
        for key, item in items:
            if key in value:
                raise HostedError('invalid_request')
            value[key] = item
        return value
    def nonfinite(_: str) -> None:
        raise HostedError('invalid_request')
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=nonfinite)
    except (ValueError, TypeError, RecursionError) as cause:
        raise HostedError('invalid_request') from cause


def encoded(value: JsonValue, limit: int = PAYLOAD_LIMIT) -> str:
    try:
        text = json.dumps(value, allow_nan=False, ensure_ascii=False, separators=(',', ':'))
    except (ValueError, TypeError, RecursionError) as cause:
        raise HostedError('result_invalid') from cause
    if len(text.encode('utf-8')) > limit:
        raise HostedError('result_too_large')
    return text


def interval(chromosome: str, start: int, end: int) -> JsonObject:
    return {'chromosome': chromosome, 'start': start, 'end': end, 'coordinateSystem': '0-based-half-open'}


@dataclass(frozen=True)
class HostedRequest:
    variant_id: str
    ontology_term: str
    crop_bp: int
    chromosome: str
    position: int
    reference: str
    alternate: str

    @classmethod
    def parse(cls, value: object) -> 'HostedRequest':
        if not isinstance(value, dict) or set(value) - {'variantId', 'ontologyTerm', 'cropBp'}:
            raise HostedError('invalid_request')
        variant_id, ontology_term, crop_bp = value.get('variantId'), value.get('ontologyTerm'), value.get('cropBp', 256)
        if not isinstance(variant_id, str) or not isinstance(ontology_term, str):
            raise HostedError('invalid_request')
        match = re.fullmatch(r'(chr(?:[1-9]|1\d|2[0-2]|X|Y)):([1-9]\d{0,8}):([ACGT])>([ACGT])', variant_id)
        if not match or match[3] == match[4] or not re.fullmatch(r'(?:UBERON|CL|EFO|CLO|NTR):\d{4,12}', ontology_term):
            raise HostedError('invalid_request')
        if type(crop_bp) is not int or not 32 <= crop_bp <= 1024:
            raise HostedError('invalid_request')
        chromosome, position, reference, alternate = match[1], int(match[2]), match[3], match[4]
        request = cls(variant_id, ontology_term, crop_bp, chromosome, position, reference, alternate)
        if request.input_interval['start'] < 0 or request.input_interval['end'] > CHROMOSOME_LENGTHS[chromosome]:
            raise HostedError('invalid_request')
        return request

    def centered(self, width: int) -> JsonObject:
        # Independently cross-check the official forward Variant.reference_interval.resize convention.
        return interval(self.chromosome, self.position - (width + 1) // 2, self.position + width // 2)

    @property
    def input_interval(self) -> JsonObject:
        return self.centered(CONTEXT_BP)

    @property
    def display_interval(self) -> JsonObject:
        return self.centered(self.crop_bp)

    def as_dict(self) -> JsonObject:
        return {'variantId': self.variant_id, 'ontologyTerm': self.ontology_term, 'cropBp': self.crop_bp}

    def source_request(self) -> JsonObject:
        return {**self.as_dict(), 'organism': 'HOMO_SAPIENS', 'assembly': 'GRCh38', 'outputTypes': ['RNA_SEQ'], 'requestedModelVersion': 'ALL_FOLDS'}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _fetch_reference(url: str, *, byte_offset: int | None = None) -> tuple[bytes, dict[str, str]]:
    headers = {'Accept-Encoding': 'identity'}
    if byte_offset is not None:
        headers['Range'] = f'bytes={byte_offset}-{byte_offset}'
    request = Request(url, headers=headers)
    limit = 65_536 if byte_offset is None else 1
    try:
        with build_opener(_NoRedirect()).open(request, timeout=15) as response:
            expected_status = 200 if byte_offset is None else 206
            if response.status != expected_status or response.headers.get('Content-Encoding', 'identity') != 'identity':
                raise HostedError('reference_unavailable')
            data = response.read(limit + 1)
            if not data or len(data) > limit:
                raise HostedError('reference_unavailable')
            if byte_offset is not None:
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                if not match or (int(match[1]), int(match[2])) != (byte_offset, byte_offset) or int(match[3]) <= byte_offset or len(data) != 1:
                    raise HostedError('reference_unavailable')
            return data, {key: response.headers.get(key, '') for key in ('ETag', 'Content-Range', 'Last-Modified')}
    except HostedError:
        raise
    except Exception as cause:
        raise HostedError('reference_unavailable') from cause


def verify_reference(request: HostedRequest) -> JsonObject:
    """Fetch only the public index and exact REF byte; never claim a full context hash."""
    index, index_headers = _fetch_reference(FAI_URL)
    try:
        entries = [line.split('\t') for line in index.decode('ascii').splitlines() if line.split('\t')[0] == request.chromosome]
        if len(entries) != 1 or len(entries[0]) != 5:
            raise ValueError('index')
        length, offset, line_bases, line_bytes = (int(value) for value in entries[0][1:])
        if length != CHROMOSOME_LENGTHS[request.chromosome] or offset < 0 or not 0 < line_bases <= line_bytes or line_bytes - line_bases > 2:
            raise ValueError('index')
        base_index = request.position - 1
        byte_offset = offset + (base_index // line_bases) * line_bytes + base_index % line_bases
        if not 0 <= byte_offset <= 2**53 - 1:
            raise ValueError('index')
    except (ValueError, UnicodeError) as cause:
        raise HostedError('reference_unavailable') from cause
    raw, headers = _fetch_reference(FASTA_URL, byte_offset=byte_offset)
    try:
        base = raw.decode('ascii').upper()
    except UnicodeError as cause:
        raise HostedError('reference_unavailable') from cause
    if base not in ('A', 'C', 'G', 'T'):
        raise HostedError('reference_unavailable')
    if base != request.reference:
        raise HostedError('reference_mismatch')
    return {
        'method': 'official-fasta-range', 'referenceVersion': 'GRCh38.p13', 'referenceUrl': FASTA_URL,
        'indexUrl': FAI_URL, 'indexSha256': hashlib.sha256(index).hexdigest(), 'indexEtag': index_headers['ETag'] or None,
        'chromosome': request.chromosome, 'position1Based': request.position,
        'expectedReference': request.reference, 'observedReference': base, 'referenceMatches': True,
        'byteOffset': byte_offset, 'contentRange': headers['Content-Range'], 'fastaEtag': headers['ETag'] or None,
        'checkedBaseSha256': hashlib.sha256(raw).hexdigest(),
        'scope': 'One reference allele checked; the full model input sequence was not fetched or hashed.',
    }


def require_number(value: object) -> int | float:
    if type(value) not in (int, float) or (type(value) is int and abs(value) > 2**53 - 1):
        raise HostedError('result_invalid')
    if not math.isfinite(value):
        raise HostedError('result_invalid')
    return value
