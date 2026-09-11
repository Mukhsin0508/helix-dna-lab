"""Offline controller QA. Numerical fixtures are synthetic, never GPU evidence.

Auth/queue tests adapt the delivered tests/test_service.py (SHA-256
1767d467b63169468a88cc98e883b8aceaf9c26210199196e7f116e0ba4b6f51).
Optional API dependencies are isolated; ordinary stdlib discovery can skip this module.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
from importlib.util import find_spec
import json
from pathlib import Path
import secrets
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

if any(find_spec(name) is None for name in ('fastapi', 'httpx', 'pydantic')):
    raise unittest.SkipTest('Install service/requirements.txt in an isolated environment for private API QA.')

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from service.app import Runtime, Store, create_app
from service.contract import PredictionRequest, validate_result
from junction_export import normalized_junction_analysis
from test_junction_export import synthetic_source as junction_source
from test_runner import synthetic_source as track_source
from track_export import OUTPUT_TYPES, PAYLOAD_LIMIT, VARIANTS, load_descriptor, normalized_analysis


class ControllerStub:
    """No model loading or output generation; used only to exercise the private API."""

    ready = False
    metadata = None
    error = None

    def start(self) -> None:
        pass

    def close(self) -> None:
        pass


def request_payload(variant: str = VARIANTS[1], junctions: bool = False) -> dict:
    return {'requestId': 'offline-test-request', 'variantId': variant,
            'biosample': 'Synthetic test cells',
            'outputs': ['SPLICE_JUNCTIONS'] if junctions else list(OUTPUT_TYPES)}


def fixture_envelope(variant: str = VARIANTS[1], junctions: bool = False,
                     request_id: str = 'offline-test-request') -> dict:
    source = (junction_source if junctions else track_source)(variant)
    source['schemaVersion'] = 2
    source['serviceRequestId'] = request_id
    raw = json.dumps(source, ensure_ascii=False, allow_nan=False, indent=2) + '\n'
    digest = hashlib.sha256(raw.encode('utf-8')).hexdigest()
    normalize = normalized_junction_analysis if junctions else normalized_analysis
    return {'schemaVersion': 2, 'sourceResultJson': raw, 'sourceResultSha256': digest,
            'analysis': normalize(source, load_descriptor(variant), 'source-result.json', digest)}


def boot_then_wait(pipe) -> None:
    """Spawned test double for timeout/close checks; never emits scientific data."""
    pipe.send({'ok': True, 'metadata': {'biosample': 'Synthetic test cells', 'fixtureOnly': True}})
    try:
        pipe.recv()
        time.sleep(5)
    finally:
        pipe.close()


def never_boot(pipe) -> None:
    """Unresponsive boot test double, deliberately bounded by the controller."""
    time.sleep(5)
    pipe.close()


class ControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix='helix-controller-test-')
        self.now = 10000.0
        self.path = str(Path(self.directory.name) / 'jobs.sqlite3')
        self.store = Store(self.path, clock=lambda: self.now)
        self.runtime = ControllerStub()
        self.token = secrets.token_urlsafe(40)
        self.auth = {'Authorization': 'Bearer ' + self.token}
        self.client = TestClient(create_app(self.store, self.runtime, self.token),
                                 base_url='https://testserver', raise_server_exceptions=False)
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.store.close()
        self.directory.cleanup()

    def ready(self) -> None:
        self.runtime.ready = True
        self.runtime.metadata = {'biosample': 'Synthetic test cells', 'fixtureOnly': True}

    def submit(self, payload: dict | None = None):
        return self.client.post('/v1/predictions', headers=self.auth, json=payload or request_payload())

    def take(self, payload: dict | None = None) -> str:
        self.ready()
        receipt = self.submit(payload)
        self.assertEqual(receipt.status_code, 202)
        job = self.store.take()
        self.assertEqual(job['id'], receipt.json()['jobId'])
        self.assertEqual(self.store.get(job['id'])['status'], 'running')
        return job['id']

    def test_every_route_and_method_requires_bearer(self) -> None:
        for path in ['/v1/health', '/v1/metadata', '/v1/predictions/anything', '/openapi.json', '/docs', '/unknown']:
            for method in ['GET', 'POST', 'PATCH', 'OPTIONS']:
                with self.subTest(path=path, method=method):
                    self.assertEqual(self.client.request(method, path).status_code, 401)
        self.assertEqual(self.client.post('/v1/predictions', json=request_payload()).status_code, 401)

    def test_wrong_or_duplicate_bearer_is_rejected(self) -> None:
        self.assertEqual(self.client.get('/v1/health', headers={'Authorization': 'Bearer wrong'}).status_code, 401)
        self.assertEqual(self.client.get('/v1/health', headers=[*self.auth.items(), *self.auth.items()]).status_code, 401)

    def test_https_is_required_not_forwarded_header(self) -> None:
        result = self.client.get('http://testserver/v1/health', headers={**self.auth, 'X-Forwarded-Proto': 'https'})
        self.assertEqual(result.status_code, 400)
        self.assertEqual(result.json()['detail'], 'https_required')

    def test_not_ready_and_expected_pins_are_distinct_from_runtime_metadata(self) -> None:
        health = self.client.get('/v1/health', headers=self.auth)
        self.assertEqual(health.status_code, 503)
        self.assertIn('expectedPins', health.json())
        self.assertNotIn('modelRevision', health.json())
        self.assertEqual(health.headers['cache-control'], 'no-store')
        self.assertEqual(self.client.get('/v1/metadata', headers=self.auth).status_code, 503)
        self.assertEqual(self.submit().status_code, 503)
        self.ready()
        self.assertEqual(self.client.get('/v1/metadata', headers=self.auth).json(), self.runtime.metadata)

    def test_bodies_are_bounded_and_compression_rejected(self) -> None:
        oversized = self.client.post('/v1/predictions', headers=self.auth, content=b'x' * 4097)
        self.assertEqual(oversized.status_code, 413)
        self.assertNotIn('xxxx', oversized.text)
        compressed = self.client.post('/v1/predictions', headers={**self.auth, 'Content-Encoding': 'gzip'}, content=b'data')
        self.assertEqual(compressed.status_code, 415)

    def test_request_strictness_and_junction_exclusivity(self) -> None:
        invalid = [dict(request_payload(), variantId='chr9:128225995:G>A'),
                   dict(request_payload(), biosample=''), dict(request_payload(), biosample=' '),
                   dict(request_payload(), biosample='x' * 201), dict(request_payload(), cropBp=True),
                   dict(request_payload(), cropBp=41.0), dict(request_payload(), cropBp=None),
                   dict(request_payload(), cropBp=0), dict(request_payload(), cropBp=5001),
                   dict(request_payload(), outputs=['RNA_SEQ', 'RNA_SEQ']),
                   dict(request_payload(), outputs=['SPLICE_JUNCTIONS', 'RNA_SEQ']),
                   dict(request_payload(), outputs=['RNA_SEQ', 'FAKE']),
                   dict(request_payload(), sequence='PRIVATE_GENOMIC_VALUE')]
        for payload in invalid:
            with self.subTest(payload=payload):
                result = self.submit(payload)
                self.assertEqual(result.status_code, 422)
                self.assertEqual(result.json(), {'detail': 'invalid_request'})
                self.assertNotIn('PRIVATE_GENOMIC_VALUE', result.text)

    def test_both_exact_variant_ids_and_default_crops(self) -> None:
        self.ready()
        for index, variant in enumerate(VARIANTS):
            payload = dict(request_payload(variant), requestId=str(index))
            self.assertEqual(self.submit(payload).status_code, 202)
            self.assertEqual(PredictionRequest.model_validate(payload).model_dump()['cropBp'], 41)
        junction = PredictionRequest.model_validate(request_payload(junctions=True)).model_dump()
        self.assertEqual(junction['cropBp'], 32768)
        with self.assertRaises(ValidationError):
            PredictionRequest.model_validate(dict(junction, cropBp=1048577))

    def test_biosample_is_exact_and_not_substituted(self) -> None:
        self.ready()
        self.assertEqual(self.submit(dict(request_payload(), biosample='synthetic test cells')).status_code, 422)
        self.assertEqual(self.submit(dict(request_payload(), biosample='Different cells')).status_code, 422)

    def test_idempotency_normalizes_output_order_and_resolved_crop(self) -> None:
        self.ready()
        first = self.submit()
        changed = request_payload()
        changed['outputs'].reverse()
        changed['cropBp'] = 41
        second = self.submit(changed)
        self.assertEqual(first.json(), second.json())
        row = self.store.db.execute('SELECT payload FROM jobs').fetchone()
        self.assertEqual(json.loads(row['payload'])['requestId'], changed['requestId'])
        self.assertEqual(json.loads(row['payload'])['cropBp'], 41)

    def test_reused_request_id_conflicts_for_changed_settings(self) -> None:
        self.ready()
        self.assertEqual(self.submit().status_code, 202)
        for change in [{'outputs': ['RNA_SEQ']}, {'variantId': VARIANTS[0]}, {'cropBp': 3}, {'biosample': 'Other'}]:
            self.assertEqual(self.submit(dict(request_payload(), **change)).status_code, 409)

    def test_queue_and_total_capacity(self) -> None:
        self.ready()
        self.store.queue_limit = 1
        self.assertEqual(self.submit().status_code, 202)
        self.assertEqual(self.submit(dict(request_payload(), requestId='second')).status_code, 429)
        job = self.store.take()
        self.store.finish(job['id'], error='prediction_failed')
        self.store.max_jobs = 1
        self.assertEqual(self.submit(dict(request_payload(), requestId='second')).status_code, 429)

    def test_success_preserves_exact_raw_json_in_authenticated_response(self) -> None:
        for index, variant in enumerate(VARIANTS):
            for junctions in (False, True):
                payload = dict(request_payload(variant, junctions), requestId=f'{index}-{junctions}')
                job_id = self.take(payload)
                envelope = fixture_envelope(variant, junctions, payload['requestId'])
                self.store.finish(job_id, result=envelope)
                data = self.client.get('/v1/predictions/' + job_id, headers=self.auth).json()
                self.assertEqual(data['status'], 'completed')
                self.assertEqual(data['result'], envelope)
                self.assertEqual(data['result']['sourceResultJson'].encode(), envelope['sourceResultJson'].encode())
                self.assertEqual(self.client.get('/v1/predictions/' + job_id).status_code, 401)

    def test_missing_or_forged_result_never_completes(self) -> None:
        for index, result in enumerate([None, {}, dict(fixture_envelope(), analysis={'rows': []}), fixture_envelope(VARIANTS[0])]):
            job_id = self.take(dict(request_payload(), requestId=str(index)))
            with self.assertRaises(ValueError):
                self.store.finish(job_id, result=result)
            data = self.store.get(job_id)
            self.assertEqual(data['status'], 'failed')
            self.assertEqual(data['error'], 'result_validation_failed')
            self.assertNotIn('result', data)

    def test_identical_scientific_settings_cannot_receive_another_jobs_result(self) -> None:
        first_id = self.take(dict(request_payload(), requestId='request-A'))
        first_result = fixture_envelope(request_id='request-A')
        self.store.finish(first_id, result=first_result)
        second_id = self.take(dict(request_payload(), requestId='request-B'))
        with self.assertRaises(ValueError):
            self.store.finish(second_id, result=first_result)
        self.assertEqual(self.store.get(first_id)['status'], 'completed')
        self.assertEqual(self.store.get(second_id)['error'], 'result_validation_failed')
        self.assertNotIn('result', self.store.get(second_id))

    def test_cannot_finish_unclaimed_or_terminal_jobs(self) -> None:
        self.ready()
        job_id = self.submit().json()['jobId']
        with self.assertRaises(ValueError):
            self.store.finish(job_id, result=fixture_envelope())
        self.store.take()
        self.store.finish(job_id, error='prediction_failed')
        with self.assertRaises(ValueError):
            self.store.finish(job_id, result=fixture_envelope())

    def test_errors_are_sanitized_and_do_not_return_result(self) -> None:
        job_id = self.take()
        self.store.finish(job_id, error='PRIVATE_EXCEPTION_PATH')
        data = self.store.get(job_id)
        self.assertEqual(data['error'], 'prediction_failed')
        self.assertNotIn('result', data)

    def test_expiry_erases_inputs_results_and_retains_idempotency_tombstone(self) -> None:
        job_id = self.take()
        self.store.finish(job_id, result=fixture_envelope())
        self.now += 3601
        self.assertEqual(self.client.get('/v1/predictions/' + job_id, headers=self.auth).status_code, 410)
        self.assertEqual(self.submit().status_code, 410)
        self.assertEqual(self.submit(dict(request_payload(), outputs=['RNA_SEQ'])).status_code, 409)
        self.assertEqual(tuple(self.store.db.execute('SELECT payload,result FROM jobs').fetchone()), (None, None))
        self.now += 7 * 86400
        self.store.cleanup()
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0], 0)

    def test_expired_queued_job_is_never_claimed_and_late_results_not_revived(self) -> None:
        self.ready()
        self.store.ttl = 1
        self.submit()
        self.now += 2
        self.assertIsNone(self.store.take())
        job_id = self.take(dict(request_payload(), requestId='late'))
        self.now += 2
        self.store.finish(job_id, result=fixture_envelope())
        with self.assertRaises(HTTPException) as failure:
            self.store.get(job_id)
        self.assertEqual(failure.exception.status_code, 410)

    def test_queue_deadline_is_separate_from_expiry(self) -> None:
        self.ready()
        job_id = self.submit().json()['jobId']
        self.now += 301
        self.assertIsNone(self.store.take())
        self.assertEqual(self.store.get(job_id)['error'], 'queue_timeout')

    def test_restart_fails_active_jobs_and_preserves_completed_results(self) -> None:
        complete_id = self.take(dict(request_payload(), requestId='complete'))
        self.store.finish(complete_id, result=fixture_envelope(request_id='complete'))
        active_id = self.take()
        self.store.close()
        self.store = Store(self.path, clock=lambda: self.now)
        self.assertEqual(self.store.get(active_id)['error'], 'service_restarted')
        self.assertEqual(self.store.get(complete_id)['status'], 'completed')
        prior = self.store.submit(PredictionRequest.model_validate(request_payload()), False, None)
        self.assertEqual(prior['jobId'], active_id)

    def test_database_has_single_controller_lease(self) -> None:
        with self.assertRaisesRegex(RuntimeError, 'already owns'):
            Store(self.path)

    def test_unknown_job_and_secured_openapi(self) -> None:
        self.assertEqual(self.client.get('/v1/predictions/not-a-job', headers=self.auth).status_code, 404)
        schema = self.client.get('/openapi.json', headers=self.auth).json()
        self.assertEqual(schema['security'], [{'ServiceBearer': []}])
        self.assertIn('ResultEnvelope', schema['components']['schemas'])
        self.assertIn('sourceResultJson', schema['components']['schemas']['ResultEnvelope']['properties'])

    def test_missing_or_weak_token_fails_closed(self) -> None:
        with patch.dict('os.environ', {}, clear=True):
            for token in (None, '', 'short', 'x' * 600, '\n' * 32):
                with self.assertRaises(RuntimeError):
                    create_app(token=token)


class ResultContractTests(unittest.TestCase):
    def test_supported_result_modes_preserve_all_rows(self) -> None:
        for variant in VARIANTS:
            for junctions in (False, True):
                envelope = fixture_envelope(variant, junctions)
                self.assertEqual(validate_result(envelope, request_payload(variant, junctions)), envelope)

    def test_source_hash_is_over_exact_utf8_not_reencoded_json(self) -> None:
        envelope = fixture_envelope()
        self.assertEqual(validate_result(envelope, request_payload()), envelope)
        envelope['sourceResultJson'] += ' '
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            validate_result(envelope, request_payload())

    def test_raw_request_identity_outputs_and_crop_must_match(self) -> None:
        mutations = [lambda source: source.update(variant=VARIANTS[0]),
                     lambda source: source.update(biosample='Other cells'),
                     lambda source: source.update(serviceRequestId='different-job'),
                     lambda source: source.pop('serviceRequestId'),
                     lambda source: source.update(outputs=source['outputs'][:1]),
                     lambda source: source['outputInterval'].update(end=source['outputInterval']['end'] + 1),
                     lambda source: source.update(schemaVersion=1),
                     lambda source: source.update(sourceKind='curated_fixture')]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                envelope = fixture_envelope()
                source = json.loads(envelope['sourceResultJson'])
                mutation(source)
                raw = json.dumps(source)
                envelope.update(sourceResultJson=raw, sourceResultSha256=hashlib.sha256(raw.encode()).hexdigest())
                with self.assertRaises(ValueError):
                    validate_result(envelope, request_payload())

    def test_normalized_analysis_cannot_change_values_or_provenance(self) -> None:
        for field in ('reference', 'provenance'):
            envelope = fixture_envelope()
            if field == 'reference':
                envelope['analysis']['rows'][0]['reference'] = False
            else:
                envelope['analysis']['provenance']['artifact']['filename'] = 'other.json'
            with self.assertRaisesRegex(ValueError, 'authoritative normalization'):
                validate_result(envelope, request_payload())

    def test_finite_json_duplicate_keys_depth_and_both_size_limits(self) -> None:
        invalid_raw = ['{"x":NaN}', '{"x":1e309}', '{"schemaVersion":2,"schemaVersion":2}',
                       '[' * 70 + '0' + ']' * 70, ' ' * (PAYLOAD_LIMIT + 1),
                       json.dumps({'text': '🙂' * (PAYLOAD_LIMIT // 3)}, ensure_ascii=False)]
        for raw in invalid_raw:
            envelope = fixture_envelope()
            envelope.update(sourceResultJson=raw, sourceResultSha256=hashlib.sha256(raw.encode()).hexdigest())
            with self.subTest(size=len(raw)), self.assertRaises(ValueError):
                validate_result(envelope, request_payload())
        envelope = fixture_envelope()
        envelope['analysis']['oversized'] = 'x' * PAYLOAD_LIMIT
        with self.assertRaises(ValueError):
            validate_result(envelope, request_payload())
        envelope = fixture_envelope()
        envelope['analysis']['rows'][0]['reference'] = float('inf')
        with self.assertRaises(ValueError):
            validate_result(envelope, request_payload())


class WorkerLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix='helix-worker-test-')
        self.store = Store(str(Path(self.directory.name) / 'jobs.sqlite3'))
        self.runtime = None

    def tearDown(self) -> None:
        if self.runtime:
            self.runtime.close()
        self.store.close()
        self.directory.cleanup()

    def wait_until(self, predicate, seconds: float = 5) -> None:
        deadline = time.monotonic() + seconds
        while not predicate() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(predicate())

    def test_prediction_timeout_fails_job_and_stops_worker(self) -> None:
        self.runtime = Runtime(self.store, startup_timeout=4, prediction_timeout=0.1, worker_target=boot_then_wait)
        self.runtime.start()
        self.wait_until(lambda: self.runtime.ready)
        req = PredictionRequest.model_validate(request_payload())
        job = self.store.submit(req, True, req.biosample)
        self.wait_until(lambda: self.store.get(job['jobId'])['status'] == 'failed')
        self.assertEqual(self.store.get(job['jobId'])['error'], 'prediction_timeout')
        self.runtime.close()
        self.assertFalse(self.runtime.ready)
        self.assertFalse(self.runtime.process.is_alive())
        self.assertFalse(self.runtime.thread.is_alive())

    def test_close_interrupts_boot_without_orphan(self) -> None:
        self.runtime = Runtime(self.store, startup_timeout=900, worker_target=never_boot)
        self.runtime.start()
        self.wait_until(lambda: self.runtime.process is not None)
        started = time.monotonic()
        self.runtime.close()
        self.assertLess(time.monotonic() - started, 3)
        self.assertFalse(self.runtime.process.is_alive())
        self.assertFalse(self.runtime.thread.is_alive())
        self.assertFalse(self.runtime.ready)
        self.assertIsNone(self.runtime.metadata)

    def test_close_before_start_never_spawns(self) -> None:
        self.runtime = Runtime(self.store, worker_target=never_boot)
        self.runtime.close()
        self.runtime.start()
        self.assertIsNone(self.runtime.process)
        self.assertIsNone(self.runtime.thread)

    def test_boot_deadline_fails_closed(self) -> None:
        self.runtime = Runtime(self.store, startup_timeout=0.1, worker_target=never_boot)
        self.runtime.start()
        self.wait_until(lambda: self.runtime.error is not None)
        self.runtime.close()
        self.assertFalse(self.runtime.ready)
        self.assertIsNone(self.runtime.metadata)
        self.assertFalse(self.runtime.process.is_alive())

    def test_waiting_submit_cannot_enqueue_after_failure_or_shutdown_sweep(self) -> None:
        """Pause the actual route on the queue lock, then finish a failure sweep first."""
        original_lock = self.store.lock
        waiting = threading.Event()

        class ObservedLock:
            def __enter__(self):
                if threading.current_thread().name == 'waiting-submit':
                    waiting.set()
                original_lock.acquire()
                return self

            def __exit__(self, *args):
                original_lock.release()

        self.store.lock = ObservedLock()
        for action in ('failure', 'shutdown'):
            with self.subTest(action=action):
                waiting.clear()
                self.runtime = Runtime(self.store)
                self.runtime.ready = True
                self.runtime.metadata = {'biosample': 'Synthetic test cells', 'fixtureOnly': True}
                app = create_app(self.store, self.runtime, secrets.token_urlsafe(40))
                endpoint = next(route.endpoint for route in app.routes if route.path == '/v1/predictions')
                existing = PredictionRequest.model_validate(dict(request_payload(), requestId=action + '-existing'))
                queued = self.store.submit(existing, True, existing.biosample)
                pending = PredictionRequest.model_validate(dict(request_payload(), requestId=action + '-late'))
                outcome = {}

                def submit():
                    try:
                        outcome['receipt'] = endpoint(pending)
                    except HTTPException as exc:
                        outcome['status'] = exc.status_code

                thread = threading.Thread(target=submit, name='waiting-submit')
                with self.store.lock:
                    thread.start()
                    self.assertTrue(waiting.wait(2), 'Route never reached the queue lock.')
                    if action == 'shutdown':
                        self.runtime.close()
                    else:
                        self.runtime._mark_unavailable()
                thread.join(2)
                self.assertFalse(thread.is_alive())
                self.assertEqual(outcome, {'status': 503})
                self.assertEqual(self.store.get(queued['jobId'])['error'], 'worker_unavailable')
                self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0], 0)
                self.assertIsNone(self.store.db.execute('SELECT id FROM jobs WHERE request_id=?', (pending.requestId,)).fetchone())


if __name__ == '__main__':
    unittest.main()
