"""Offline wrapper checks. Synthetic SDK fixtures never call Google or use an API key."""
from __future__ import annotations

from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError

PATH = Path(__file__).with_name('server.py')
spec = importlib.util.spec_from_file_location('helix_cpu_bridge', PATH)
bridge = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(bridge)
REQUEST = {'variantId': 'chr22:36201698:A>C', 'ontologyTerm': 'UBERON:0001157', 'cropBp': 256}
JOB = 'b8c2d1d1-9c1b-4b00-8b7c-701d5a780191'


class ContainerTests(unittest.TestCase):
    def test_exact_request_and_finite_bounded_json(self):
        self.assertEqual(bridge.validate_start({'jobId': JOB, 'request': REQUEST}), (JOB, REQUEST))
        for changes in ({'cropBp': True}, {'cropBp': 31}, {'cropBp': 1025}, {'apiKey': 'not-allowed'}, {'variantId': 'chr22:10:A>A'}, {'ontologyTerm': '*'}):
            with self.subTest(changes=changes), self.assertRaises(bridge.BridgeError):
                bridge.validate_start({'jobId': JOB, 'request': {**REQUEST, **changes}})
        for raw in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":1e400}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError): bridge.strict_json(raw)

    def test_subprocess_deadline_terminates_instead_of_returning_empty_success(self):
        began = time.monotonic()
        with self.assertRaises(bridge.BridgeError) as caught:
            bridge.execute(REQUEST, timeout=.1, command=[sys.executable, '-c', 'import time;time.sleep(60)'])
        self.assertEqual(caught.exception.code, 'prediction_timeout')
        self.assertLess(time.monotonic() - began, 3)

    def test_output_cap_and_safe_failure_codes_never_include_raw_errors(self):
        with self.assertRaises(bridge.BridgeError) as caught:
            bridge.execute(REQUEST, command=[sys.executable, '-c', 'import sys;sys.stdout.write("x" * 7000000)'])
        self.assertEqual(caught.exception.code, 'result_too_large')
        secret = 'synthetic-provider-secret-must-never-escape'
        script = 'import sys,json;sys.stderr.write(' + repr(secret) + ');print(json.dumps({"error":{"code":"authentication_failed","message":' + repr(secret) + '}}));sys.exit(1)'
        with self.assertRaises(bridge.BridgeError) as caught:
            bridge.execute(REQUEST, command=[sys.executable, '-c', script])
        self.assertEqual(str(caught.exception), 'authentication_failed')
        self.assertNotIn(secret, str(caught.exception))
        with self.assertRaises(bridge.BridgeError) as caught:
            bridge.execute(REQUEST, command=[sys.executable, '-c', 'print("not-json")'])
        self.assertEqual(caught.exception.code, 'result_invalid')

    def test_one_active_subprocess_idempotency_conflict_and_expiry(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        def runner(request):
            calls.append(request); entered.set(); release.wait(2)
            return {'synthetic': True}
        clock = [1000.0]
        jobs = bridge.Jobs(runner, lambda: clock[0])
        self.assertEqual(jobs.start({'jobId': JOB, 'request': REQUEST})[0], 202)
        self.assertTrue(entered.wait(1))
        self.assertEqual(jobs.start({'jobId': JOB, 'request': REQUEST})[0], 202)
        self.assertEqual(jobs.start({'jobId': JOB, 'request': {**REQUEST, 'cropBp': 512}})[0], 409)
        other = 'b8c2d1d1-9c1b-4b00-8b7c-701d5a780192'
        self.assertEqual(jobs.start({'jobId': other, 'request': REQUEST})[0], 429)
        release.set()
        for _ in range(100):
            if jobs.get(JOB)['status'] == 'completed': break
            time.sleep(.005)
        self.assertEqual(jobs.get(JOB)['status'], 'completed'); self.assertEqual(len(calls), 1)
        clock[0] += 3601
        self.assertEqual(jobs.get(JOB), {'jobId': JOB, 'status': 'expired'})
        self.assertEqual(jobs.start({'jobId': JOB, 'request': REQUEST})[0], 410)

    def test_http_returns_fast_status_without_secrets_and_rejects_oversized_body(self):
        release = threading.Event()
        def runner(_request): release.wait(1); return {'synthetic': True}
        server = bridge.Server(('127.0.0.1', 0), bridge.Jobs(runner))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        address = 'http://127.0.0.1:' + str(server.server_port)
        try:
            request = Request(address + '/start', data=json.dumps({'jobId': JOB, 'request': REQUEST}).encode(), headers={'Content-Type': 'application/json'})
            with patch.dict(os.environ, {'ALPHAGENOME_API_KEY': ''}), self.assertRaises(HTTPError) as caught:
                urlopen(request)
            self.assertEqual(caught.exception.code, 503)
            with patch.dict(os.environ, {'ALPHAGENOME_API_KEY': 'synthetic-only-key'}):
                with urlopen(request) as response:
                    self.assertEqual(response.status, 202)
                    self.assertEqual(json.load(response), {'jobId': JOB, 'status': 'running'})
                oversized = Request(address + '/start', data=b'x' * 5000, headers={'Content-Type': 'application/json'})
                with self.assertRaises(HTTPError) as caught: urlopen(oversized)
                self.assertEqual(caught.exception.code, 413)
            with urlopen(address + '/status/' + JOB) as response:
                self.assertEqual(json.load(response)['jobId'], JOB)
        finally:
            release.set(); server.shutdown(); server.server_close(); thread.join(2)

    def test_actual_offline_sdk_envelope_is_request_bound_and_byte_exact(self):
        try:
            from inference.hosted.test_runner import run_offline
            from inference.hosted.contract import HostedRequest
        except ModuleNotFoundError as error:
            if error.name and error.name.split('.')[0] in ('numpy', 'pandas', 'alphagenome'):
                self.skipTest('Use the isolated hosted SDK environment for the real SDK fixture.')
            raise
        envelope, _ = run_offline(HostedRequest.parse(REQUEST))
        self.assertEqual(bridge.validate_result(envelope, REQUEST), envelope)
        changed = deepcopy(envelope)
        changed['analysis']['rows'][0]['alternate'] = 42
        with self.assertRaises(Exception): bridge.validate_result(changed, REQUEST)
        with self.assertRaises(Exception): bridge.validate_result(envelope, {**REQUEST, 'cropBp': 512})


if __name__ == '__main__': unittest.main()
