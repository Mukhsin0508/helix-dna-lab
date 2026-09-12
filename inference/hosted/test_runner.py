"""Offline QA only. All prediction arrays here are synthetic; no service is called."""
from __future__ import annotations

import copy
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pandas as pd
from alphagenome.data import genome, track_data
from alphagenome.models import dna_client, dna_output

from . import contract, runner
from .run import _write_new
from .contract import CONTEXT_BP, HostedError, HostedRequest, encoded, strict_json

ROOT = Path(__file__).resolve().parents[2]
REQUEST = {'variantId': 'chr22:36201698:A>C', 'ontologyTerm': 'UBERON:0001157', 'cropBp': 256}


def reference_evidence(request: HostedRequest) -> dict:
    """Synthetic evidence for unit tests; production independently fetches the base."""
    return {
        'method': 'official-fasta-range', 'referenceVersion': 'GRCh38.p13', 'referenceUrl': contract.FASTA_URL,
        'indexUrl': contract.FAI_URL, 'indexSha256': '1' * 64, 'indexEtag': None,
        'chromosome': request.chromosome, 'position1Based': request.position, 'expectedReference': request.reference,
        'observedReference': request.reference, 'referenceMatches': True, 'byteOffset': 50,
        'contentRange': 'bytes 50-50/100', 'fastaEtag': None,
        'checkedBaseSha256': hashlib.sha256(request.reference.encode()).hexdigest(),
        'scope': 'Synthetic reference-check test fixture only; not actual fetched evidence.',
    }


def metadata(request: HostedRequest) -> pd.DataFrame:
    return pd.DataFrame([
        {'name': 'Synthetic RNA plus', 'strand': '+', 'ontology_curie': request.ontology_term, 'biosample_name': 'Synthetic test tissue', 'unit': None, 'nonzero_mean': 0.12345678901234568},
        {'name': 'Synthetic RNA minus', 'strand': '-', 'ontology_curie': request.ontology_term, 'biosample_name': 'Synthetic test tissue', 'unit': None, 'nonzero_mean': 0.23456789012345678},
    ])


def native_output(request: HostedRequest, frame: pd.DataFrame | None = None):
    frame = metadata(request) if frame is None else frame
    native_interval = genome.Variant(chromosome=request.chromosome, position=request.position, reference_bases=request.reference, alternate_bases=request.alternate).reference_interval.resize(CONTEXT_BP)
    ref = np.full((CONTEXT_BP, len(frame)), np.float32(0.123456789), dtype=np.float32)
    alt = np.full_like(ref, np.float32(0.987654321))
    return dna_output.VariantOutput(
        reference=dna_output.Output(rna_seq=track_data.TrackData(ref, frame.copy(), interval=native_interval)),
        alternate=dna_output.Output(rna_seq=track_data.TrackData(alt, frame.copy(), interval=native_interval)),
    )


class FakeModel:
    """Explicit offline spy around actual SDK TrackData containers."""
    def __init__(self, request: HostedRequest, output=None, frame=None):
        self.frame = metadata(request) if frame is None else frame
        self.output = native_output(request, self.frame) if output is None else output
        self.calls = []

    def output_metadata(self, **kwargs):
        self.calls.append(('metadata', kwargs))
        return dna_output.OutputMetadata(rna_seq=self.frame)

    def predict_variant(self, **kwargs):
        self.calls.append(('prediction', kwargs))
        return self.output


def run_offline(request: HostedRequest, model: FakeModel | None = None) -> tuple[dict, FakeModel]:
    model = FakeModel(request) if model is None else model
    with patch.dict(os.environ, {'ALPHAGENOME_API_KEY': 'synthetic-unit-test-key'}), patch.object(runner, 'verify_reference', return_value=reference_evidence(request)), patch.object(dna_client, 'create', return_value=model) as create:
        result = runner.run_prediction(request)
        create.assert_called_once_with('synthetic-unit-test-key', model_version=dna_client.ModelVersion.ALL_FOLDS, timeout=15)
    return result, model


class HostedRunnerTests(unittest.TestCase):
    def test_request_requires_exact_snv_tissue_and_bounded_crop(self):
        request = HostedRequest.parse(REQUEST)
        self.assertEqual(request.input_interval, contract.interval('chr22', 35677410, 36725986))
        self.assertEqual(request.display_interval, contract.interval('chr22', 36201570, 36201826))
        self.assertEqual(HostedRequest.parse({key: value for key, value in REQUEST.items() if key != 'cropBp'}).crop_bp, 256)
        for patch_value in [
            {'variantId': 'chrM:100:A>C'}, {'variantId': 'chr22:1:A>C'}, {'variantId': 'chr22:50818468:A>C'},
            {'variantId': 'chr22:36201698:A>A'}, {'variantId': 'chr22:36201698:AA>C'},
            {'variantId': 'chr22:36201698:a>C'}, {'variantId': 'chr23:36201698:A>C'},
            {'ontologyTerm': ''}, {'ontologyTerm': '*'}, {'cropBp': True}, {'cropBp': 31}, {'cropBp': 1025},
            {'cropBp': 256.0}, {'apiKey': 'must-not-be-accepted'}, {'requestId': 'untrusted'},
        ]:
            with self.subTest(patch_value=patch_value), self.assertRaises(HostedError):
                HostedRequest.parse({**REQUEST, **patch_value})
        for text in ['{"variantId":"a","variantId":"b"}', '{"cropBp":NaN}', '[1]', '']:
            with self.subTest(text=text), self.assertRaises(HostedError):
                HostedRequest.parse(strict_json(text))

    def test_native_result_preserves_sdk_coordinates_precision_metadata_and_unknown_revision(self):
        request = HostedRequest.parse(REQUEST)
        envelope, model = run_offline(request)
        self.assertEqual([name for name, _ in model.calls], ['metadata', 'prediction'])
        call = model.calls[-1][1]
        self.assertEqual(str(call['variant']), REQUEST['variantId'])
        self.assertEqual(call['interval'].start, 35677410)
        self.assertEqual(call['interval'].end, 36725986)
        self.assertEqual(call['requested_outputs'], [dna_client.OutputType.RNA_SEQ])
        self.assertEqual(call['ontology_terms'], [REQUEST['ontologyTerm']])
        self.assertEqual(call['organism'], dna_client.Organism.HOMO_SAPIENS)
        source = strict_json(envelope['sourceResultJson'])
        self.assertEqual(source['sdk']['version'], importlib.metadata.version('alphagenome'))
        self.assertEqual(source['tracks']['reference']['metadata'][0]['nonzero_mean'], 0.12345678901234568)
        self.assertEqual(source['tracks']['reference']['values'][0][0], float(np.float32(0.123456789)))
        self.assertEqual(source['tracks']['reference']['originalShape'], [CONTEXT_BP, 2])
        self.assertEqual(len(envelope['analysis']['rows']), 512)
        self.assertEqual(envelope['analysis']['rows'][0]['position'], 36201570)
        self.assertEqual(envelope['analysis']['rows'][255]['position'], 36201825)
        inference = envelope['analysis']['provenance']['inference']
        self.assertEqual(inference['modelRevision'], 'Not reported by hosted service')
        self.assertIsNone(inference['referenceSha256'])
        self.assertNotIn('inputSequenceSha256', inference)
        self.assertIsNone(envelope['analysis']['trackMetadata'][0]['unit'])
        self.assertEqual(hashlib.sha256(envelope['sourceResultJson'].encode()).hexdigest(), envelope['sourceResultSha256'])
        self.assertEqual(runner.validate_envelope(envelope, REQUEST), envelope)

    def test_both_dnm1_cases_are_bound_independently_to_native_call(self):
        for variant in ('chr9:128225994:G>A', 'chr9:128226027:G>A'):
            request = HostedRequest.parse({**REQUEST, 'variantId': variant})
            envelope, model = run_offline(request)
            self.assertEqual(str(model.calls[-1][1]['variant']), variant)
            self.assertEqual(model.calls[-1][1]['interval'].start, request.input_interval['start'])
            self.assertEqual(envelope['analysis']['provenance']['inference']['variant'], variant)

    def test_reference_mismatch_blocks_client_and_prediction(self):
        request = HostedRequest.parse(REQUEST)
        with patch.dict(os.environ, {'ALPHAGENOME_API_KEY': 'synthetic-unit-test-key'}), patch.object(runner, 'verify_reference', side_effect=HostedError('reference_mismatch')), patch.object(dna_client, 'create') as create:
            with self.assertRaises(HostedError) as caught:
                runner.run_prediction(request)
            self.assertEqual(caught.exception.code, 'reference_mismatch'); create.assert_not_called()

    def test_missing_tissue_and_row_limit_block_prediction(self):
        request = HostedRequest.parse(REQUEST)
        frame = metadata(request); frame['ontology_curie'] = 'UBERON:0000001'
        model = FakeModel(request, frame=frame)
        with self.assertRaises(HostedError) as caught:
            run_offline(request, model)
        self.assertEqual(caught.exception.code, 'unsupported_tissue')
        self.assertEqual([name for name, _ in model.calls], ['metadata'])
        request = HostedRequest.parse({**REQUEST, 'cropBp': 1024})
        frame = pd.concat([metadata(request)] * 3, ignore_index=True); frame['name'] = [f'Synthetic track {i}' for i in range(len(frame))]
        model = FakeModel(request, frame=frame)
        with self.assertRaises(HostedError) as caught:
            run_offline(request, model)
        self.assertEqual(caught.exception.code, 'result_too_large')
        self.assertEqual([name for name, _ in model.calls], ['metadata'])

    def test_reordered_allele_tracks_align_without_changing_raw_order(self):
        request = HostedRequest.parse(REQUEST)
        output = native_output(request)
        reversed_alt = track_data.TrackData(output.alternate.rna_seq.values[:, ::-1].copy(), output.alternate.rna_seq.metadata.iloc[::-1].copy(), interval=output.alternate.rna_seq.interval)
        output = dna_output.VariantOutput(reference=output.reference, alternate=dna_output.Output(rna_seq=reversed_alt))
        envelope, _ = run_offline(request, FakeModel(request, output=output))
        source = strict_json(envelope['sourceResultJson'])
        self.assertEqual(source['tracks']['alternate']['metadata'][0]['strand'], '-')
        self.assertEqual(envelope['analysis']['trackMetadata'][0]['strand'], '+')

    def test_unknown_strand_and_unit_remain_null(self):
        request = HostedRequest.parse(REQUEST)
        frame = metadata(request); frame.loc[0, 'strand'] = None
        envelope, _ = run_offline(request, FakeModel(request, frame=frame))
        self.assertIsNone(envelope['analysis']['trackMetadata'][0]['strand'])
        self.assertIsNone(envelope['analysis']['trackMetadata'][0]['unit'])
        self.assertEqual(envelope['analysis']['trackMetadata'][0]['scope'], 'biosample_specific')

    def test_catalog_null_columns_may_be_absent_in_filtered_returned_metadata(self):
        request = HostedRequest.parse(REQUEST)
        catalog = metadata(request)
        catalog['encode_accession'] = None  # Union column belonging to other catalog tissues.
        output = native_output(request)  # The SDK's filtered result omits this unused column.
        envelope, _ = run_offline(request, FakeModel(request, output=output, frame=catalog))
        source = strict_json(envelope['sourceResultJson'])
        for allele in ('reference', 'alternate'):
            self.assertNotIn('encode_accession', source['tracks'][allele]['metadataColumns'])
            self.assertNotIn('encode_accession', source['tracks'][allele]['metadata'][0])
        self.assertEqual(runner.validate_envelope(envelope, request), envelope)
        catalog.loc[0, 'encode_accession'] = 'non-null-catalog-value'
        with self.assertRaises(HostedError):
            run_offline(request, FakeModel(request, output=output, frame=catalog))

    def test_invalid_native_arrays_and_metadata_fail_without_truncation(self):
        request = HostedRequest.parse(REQUEST)
        native = native_output(request).reference.rna_seq
        expected = runner.metadata_records(metadata(request))
        arrays = [native.values.astype(bool), native.values[:, :1], native.values[:-1], native.values[0], None]
        for values in arrays:
            with self.subTest(shape=getattr(values, 'shape', None)), self.assertRaises(HostedError):
                runner.crop_track(SimpleNamespace(values=values, interval=native.interval, resolution=1, metadata=native.metadata, uns=None), request, expected)
        for invalid in (float('nan'), float('inf')):
            changed = native.values.copy(); changed[0, 0] = invalid  # outside the retained crop
            with self.assertRaises(HostedError):
                runner.crop_track(SimpleNamespace(values=changed, interval=native.interval, resolution=1, metadata=native.metadata, uns=None), request, expected)
        bad_frame = native.metadata.copy(); bad_frame.loc[0, 'ontology_curie'] = 'CL:0000084'
        with self.assertRaises(HostedError):
            runner.crop_track(SimpleNamespace(values=native.values, interval=native.interval, resolution=1, metadata=bad_frame, uns=None), request, expected)
        shifted = genome.Interval('chr22', native.interval.start + 1, native.interval.end + 1)
        with self.assertRaises(HostedError):
            runner.crop_track(SimpleNamespace(values=native.values, interval=shifted, resolution=1, metadata=native.metadata, uns=None), request, expected)

    def test_envelope_rejects_wrong_request_values_hash_and_nonfinite_data(self):
        request = HostedRequest.parse(REQUEST)
        envelope, _ = run_offline(request)
        for changes in ({'variantId': 'chr22:36201698:A>G'}, {'ontologyTerm': 'CL:0000084'}, {'cropBp': 128}):
            with self.assertRaises(HostedError):
                runner.validate_envelope(envelope, {**REQUEST, **changes})
        for change in ('hash', 'number', 'boolean', 'metadata'):
            modified = copy.deepcopy(envelope)
            if change == 'hash': modified['sourceResultJson'] += ' '
            if change == 'number': modified['analysis']['rows'][0]['reference'] += 1
            if change == 'boolean': modified['analysis']['schemaVersion'] = True
            if change == 'metadata': modified['analysis']['trackMetadata'][0]['unit'] = 'Made up units'
            with self.subTest(change=change), self.assertRaises(HostedError):
                runner.validate_envelope(modified, request)
        self.assertRaises(HostedError, encoded, {'oversize': 'x' * contract.PAYLOAD_LIMIT})
        for value in (True, 2**53, 10**10000, float('nan'), float('inf')):
            with self.assertRaises(HostedError):
                contract.require_number(value)

    def test_rpc_errors_are_categorized_without_echoing_details(self):
        import grpc
        class SensitiveRPC(grpc.RpcError):
            def __init__(self, status): self.status = status
            def code(self): return self.status
            def __str__(self): return 'DO-NOT-ECHO-SECRET-OR-REQUEST'
        request = HostedRequest.parse(REQUEST)
        for status, expected in [(grpc.StatusCode.UNAUTHENTICATED, 'authentication_failed'), (grpc.StatusCode.PERMISSION_DENIED, 'authentication_failed'), (grpc.StatusCode.RESOURCE_EXHAUSTED, 'rate_limited'), (grpc.StatusCode.UNAVAILABLE, 'service_unavailable')]:
            with patch.dict(os.environ, {'ALPHAGENOME_API_KEY': 'synthetic-unit-test-key'}), patch.object(runner, 'verify_reference', return_value=reference_evidence(request)), patch.object(dna_client, 'create', side_effect=SensitiveRPC(status)), self.assertRaises(HostedError) as caught:
                runner.run_prediction(request)
            self.assertEqual(caught.exception.code, expected)
            self.assertNotIn('DO-NOT-ECHO', str(caught.exception))

    def test_optional_file_output_is_exact_atomic_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'result.json'
            _write_new(path, '{"offlineTestOnly":true}')
            self.assertEqual(path.read_text(), '{"offlineTestOnly":true}\n')
            with self.assertRaises(HostedError):
                _write_new(path, '{"replacement":true}')
            self.assertEqual(path.read_text(), '{"offlineTestOnly":true}\n')
            self.assertEqual(list(Path(folder).iterdir()), [path])

    def test_reference_reader_checks_exact_index_byte_offset_and_allele(self):
        request = HostedRequest.parse(REQUEST)
        fai = f'chr22\t50818468\t100\t60\t61\n'.encode()
        offset = 100 + ((request.position - 1) // 60) * 61 + (request.position - 1) % 60
        headers = {'ETag': 'synthetic-etag', 'Content-Range': f'bytes {offset}-{offset}/999999999', 'Last-Modified': ''}
        with patch.object(contract, '_fetch_reference', side_effect=[(fai, headers), (b'A', headers)]) as fetch:
            result = contract.verify_reference(request)
            fetch.assert_any_call(contract.FASTA_URL, byte_offset=offset)
            self.assertEqual(result['observedReference'], 'A')
            self.assertEqual(result['indexSha256'], hashlib.sha256(fai).hexdigest())
            self.assertNotIn('inputSequenceSha256', result)
        with patch.object(contract, '_fetch_reference', side_effect=[(fai, headers), (b'G', headers)]), self.assertRaises(HostedError) as caught:
            contract.verify_reference(request)
        self.assertEqual(caught.exception.code, 'reference_mismatch')

    def test_http_range_requires_206_exact_range_and_bounded_body(self):
        class Response:
            def __init__(self, status, headers, data): self.status, self.headers, self.data = status, headers, data
            def __enter__(self): return self
            def __exit__(self, *args): return None
            def read(self, maximum): return self.data[:maximum]
        valid = Response(206, {'Content-Range': 'bytes 50-50/100'}, b'A')
        with patch.object(contract, 'build_opener', return_value=SimpleNamespace(open=lambda request, timeout: valid)):
            self.assertEqual(contract._fetch_reference(contract.FASTA_URL, byte_offset=50)[0], b'A')
        for response in (Response(200, {}, b'A'), Response(206, {}, b'A'), Response(206, {'Content-Range': 'bytes 49-49/100'}, b'A'), Response(206, {'Content-Range': 'bytes 50-50/100'}, b'AB')):
            with patch.object(contract, 'build_opener', return_value=SimpleNamespace(open=lambda request, timeout: response)), self.assertRaises(HostedError):
                contract._fetch_reference(contract.FASTA_URL, byte_offset=50)

    def test_actual_typescript_schema_accepts_the_offline_sdk_conversion(self):
        request = HostedRequest.parse(REQUEST)
        envelope, _ = run_offline(request)
        script = "import {readFileSync} from 'node:fs'; import {parseDatasetJSON} from './shared/analysis-import.ts'; const value = parseDatasetJSON(readFileSync(0,'utf8')); process.stdout.write(JSON.stringify(value));"
        result = subprocess.run(['./node_modules/.bin/tsx', '--eval', script], cwd=ROOT, input=json.dumps(envelope['analysis']), text=True, capture_output=True, check=True, timeout=30)
        # The importer sorts tracks by coordinate, without changing row values.
        parsed = json.loads(result.stdout)
        self.assertEqual(sorted(parsed['rows'], key=lambda row: (row['position'], row['track'])), sorted(envelope['analysis']['rows'], key=lambda row: (row['position'], row['track'])))
        self.assertEqual(parsed['provenance'], envelope['analysis']['provenance'])
        self.assertEqual(parsed['trackMetadata'], envelope['analysis']['trackMetadata'])

    def test_cli_missing_key_bad_json_and_unknown_arguments_are_sanitized(self):
        environment = dict(os.environ); environment.pop('ALPHAGENOME_API_KEY', None)
        for data, args, expected in [(json.dumps(REQUEST), [], 'missing_api_key'), ('{"apiKey":"DO-NOT-ECHO-ME"}', [], 'invalid_request'), ('{"cropBp":NaN}', [], 'invalid_request'), ('{}', ['--api-key', 'DO-NOT-ECHO-ME'], 'invalid_request')]:
            result = subprocess.run([sys.executable, '-m', 'inference.hosted.run', *args], cwd=ROOT, env=environment, input=data, text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['error']['code'], expected)
            self.assertNotIn('DO-NOT-ECHO-ME', result.stdout + result.stderr)
            self.assertEqual(result.stderr, '')

if __name__ == '__main__':
    unittest.main()
