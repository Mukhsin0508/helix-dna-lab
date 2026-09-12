"""Private CPU container: one bounded subprocess, no credentials in HTTP or logs."""

from __future__ import annotations

from copy import deepcopy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
import re
import selectors
import signal
import subprocess
import sys
import threading
import time
from typing import Any, Callable
from urllib.parse import urlsplit

BODY_LIMIT = 4_096
SOURCE_LIMIT = 2 * 1024 * 1024
ENVELOPE_LIMIT = 6 * 1024 * 1024 + 4096
JOB_TTL_SECONDS = 3_600
RUN_TIMEOUT_SECONDS = 180
SAFE_ERRORS = frozenset({
    'invalid_request', 'missing_api_key', 'dependency_error', 'reference_unavailable',
    'reference_mismatch', 'unsupported_tissue', 'result_invalid', 'result_too_large',
    'service_unavailable', 'rate_limited', 'authentication_failed', 'prediction_timeout',
})


class BridgeError(Exception):
    """An allowlisted public failure code; provider exception messages never escape."""

    def __init__(self, code: str, status: int = 422) -> None:
        self.code = code if code in SAFE_ERRORS else 'service_unavailable'
        self.status = status
        super().__init__(self.code)


def strict_json(data: bytes | str) -> Any:
    """Parse bounded JSON, rejecting duplicate keys and non-finite numeric values."""
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate')
            result[key] = value
        return result
    def invalid(_value: str) -> None:
        raise ValueError('nonfinite')
    value = json.loads(data, object_pairs_hook=pairs, parse_constant=invalid)
    def inspect(item: Any, depth: int = 0) -> None:
        if depth > 80 or isinstance(item, float) and not math.isfinite(item):
            raise ValueError('invalid')
        if isinstance(item, dict):
            for child in item.values():
                inspect(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                inspect(child, depth + 1)
    inspect(value)
    return value


def validate_start(value: Any) -> tuple[str, dict[str, Any]]:
    """Return an exact job identity and the narrow, non-secret runner request."""
    if not isinstance(value, dict) or set(value) != {'jobId', 'request'}:
        raise BridgeError('invalid_request')
    job_id, request = value['jobId'], value['request']
    if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', job_id):
        raise BridgeError('invalid_request')
    if not isinstance(request, dict) or set(request) != {'variantId', 'ontologyTerm', 'cropBp'}:
        raise BridgeError('invalid_request')
    if not isinstance(request['variantId'], str) or not re.fullmatch(r'chr(?:[1-9]|1\d|2[0-2]|X|Y):[1-9]\d{0,8}:[ACGT]>[ACGT]', request['variantId']) or request['variantId'][-1] == request['variantId'][-3]:
        raise BridgeError('invalid_request')
    if not isinstance(request['ontologyTerm'], str) or not re.fullmatch(r'(?:UBERON|CL|EFO|CLO|NTR):\d{4,12}', request['ontologyTerm']):
        raise BridgeError('invalid_request')
    if type(request['cropBp']) is not int or not 32 <= request['cropBp'] <= 1024:
        raise BridgeError('invalid_request')
    return job_id, deepcopy(request)


def validate_result(value: Any, request: dict[str, Any]) -> dict[str, Any]:
    """Validate exact bytes, then regenerate the analysis with the official adapter's validator."""
    if not isinstance(value, dict) or set(value) != {'analysis', 'sourceResultJson', 'sourceResultSha256'}:
        raise BridgeError('result_invalid')
    raw = value['sourceResultJson']
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > SOURCE_LIMIT:
        raise BridgeError('result_too_large')
    if hashlib.sha256(raw.encode('utf-8')).hexdigest() != value['sourceResultSha256']:
        raise BridgeError('result_invalid')
    if len(json.dumps(value['analysis'], ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()) > SOURCE_LIMIT:
        raise BridgeError('result_too_large')
    strict_json(raw)
    from inference.hosted.runner import validate_envelope
    return validate_envelope(value, request)


def execute(request: dict[str, Any], *, timeout: float = RUN_TIMEOUT_SECONDS,
            command: list[str] | None = None,
            validator: Callable[[Any, dict[str, Any]], dict[str, Any]] = validate_result) -> dict[str, Any]:
    """Run once and return validated output; cap memory, wall time, and child lifetime."""
    process = subprocess.Popen(command or [sys.executable, '-m', 'inference.hosted.run'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        start_new_session=True, env=os.environ.copy())
    output = bytearray()
    deadline = time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    try:
        assert process.stdin is not None and process.stdout is not None
        process.stdin.write(json.dumps(request, separators=(',', ':')).encode())
        process.stdin.close()
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BridgeError('prediction_timeout')
            for key, _ in selector.select(min(remaining, .1)):
                chunk = os.read(key.fileobj.fileno(), 64 * 1024)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                output.extend(chunk)
                if len(output) > ENVELOPE_LIMIT:
                    raise BridgeError('result_too_large')
        try:
            process.wait(timeout=max(.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as exc:
            raise BridgeError('prediction_timeout') from exc
        try:
            parsed = strict_json(output)
        except (ValueError, RecursionError, UnicodeError) as exc:
            raise BridgeError('result_invalid') from exc
        if process.returncode != 0:
            code = parsed.get('error', {}).get('code') if isinstance(parsed, dict) and isinstance(parsed.get('error'), dict) else None
            raise BridgeError(code if code in SAFE_ERRORS else 'service_unavailable')
        try:
            return validator(parsed, request)
        except BridgeError:
            raise
        except Exception as exc:
            raise BridgeError('result_invalid') from exc
    finally:
        selector.close()
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait()
        if process.stdout:
            process.stdout.close()
        if process.stdin and not process.stdin.closed:
            process.stdin.close()


class Jobs:
    """Ephemeral per-job results. A restarted container never silently replays work."""

    def __init__(self, runner: Callable[[dict[str, Any]], dict[str, Any]] = execute,
                 clock: Callable[[], float] = time.time) -> None:
        self.lock = threading.RLock()
        self.rows: dict[str, dict[str, Any]] = {}
        self.runner, self.clock = runner, clock

    def _cleanup(self) -> None:
        for job_id, row in list(self.rows.items()):
            if row['expires'] <= self.clock():
                # Keep a tiny tombstone for this container's lifetime to prevent replay.
                self.rows[job_id] = {'status': 'expired', 'digest': row['digest'], 'expires': row['expires']}

    def start(self, value: Any) -> tuple[int, dict[str, Any]]:
        job_id, request = validate_start(value)
        digest = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
        with self.lock:
            self._cleanup()
            prior = self.rows.get(job_id)
            if prior:
                if prior['digest'] != digest:
                    return 409, {'error': {'code': 'request_conflict'}}
                if prior['status'] == 'expired':
                    return 410, {'jobId': job_id, 'status': 'expired'}
                return 202, {'jobId': job_id, 'status': prior['status']}
            if any(row['status'] == 'running' for row in self.rows.values()):
                return 429, {'error': {'code': 'capacity_reached'}}
            if len(self.rows) >= 256:
                return 429, {'error': {'code': 'capacity_reached'}}
            self.rows[job_id] = {'status': 'running', 'digest': digest, 'expires': self.clock() + JOB_TTL_SECONDS}
            threading.Thread(target=self._run, args=(job_id, request), daemon=True).start()
            return 202, {'jobId': job_id, 'status': 'running'}

    def _run(self, job_id: str, request: dict[str, Any]) -> None:
        try:
            result = self.runner(request)
            patch = {'status': 'completed', 'result': result}
        except BridgeError as exc:
            patch = {'status': 'failed', 'error': {'code': exc.code}}
        except Exception:
            patch = {'status': 'failed', 'error': {'code': 'service_unavailable'}}
        with self.lock:
            row = self.rows[job_id]
            if row['status'] == 'running' and row['expires'] > self.clock():
                row.update(patch)

    def get(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            self._cleanup()
            row = self.rows.get(job_id)
            if not row:
                return {'jobId': job_id, 'status': 'unknown'}
            return deepcopy({'jobId': job_id, **{key: row[key] for key in ('status', 'result', 'error') if key in row}})


class Handler(BaseHTTPRequestHandler):
    server_version = 'Helix'

    def log_message(self, _format: str, *_args: Any) -> None:
        pass

    def _respond(self, status: int, value: dict[str, Any]) -> None:
        body = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self) -> None:
        try:
            if urlsplit(self.path).path != '/start':
                return self._respond(404, {'error': {'code': 'not_found'}})
            if not os.environ.get('ALPHAGENOME_API_KEY', '').strip():
                return self._respond(503, {'error': {'code': 'missing_api_key'}})
            if self.headers.get('Transfer-Encoding') or self.headers.get_content_type() != 'application/json':
                raise BridgeError('invalid_request')
            length = int(self.headers.get('Content-Length', '-1'))
            if not 0 < length <= BODY_LIMIT:
                raise BridgeError('invalid_request', 413)
            self.connection.settimeout(10)
            value = strict_json(self.rfile.read(length))
            status, result = self.server.jobs.start(value)  # type: ignore[attr-defined]
            self._respond(status, result)
        except BridgeError as exc:
            self._respond(exc.status, {'error': {'code': exc.code}})
        except Exception:
            self._respond(400, {'error': {'code': 'invalid_request'}})

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == '/health':
            return self._respond(200, {'status': 'ok'})
        match = re.fullmatch(r'/status/([a-f0-9-]{36})', path)
        if not match:
            return self._respond(404, {'error': {'code': 'not_found'}})
        self._respond(200, self.server.jobs.get(match[1]))  # type: ignore[attr-defined]


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], jobs: Jobs | None = None) -> None:
        self.jobs = jobs or Jobs()
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(address, Handler)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Base HTTP servers otherwise print uncaught exception text and request details.
        pass


if __name__ == '__main__':
    Server(('0.0.0.0', 8080)).serve_forever(poll_interval=.25)
