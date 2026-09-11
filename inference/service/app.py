"""Private controller adapted from the delivered, unexecuted service scaffold.

Source ZIP SHA-256: 2b4d1ce4c5f90f0674a4d49ac7574ad03e56caabea296415141c99f1c3cc551c
Source service.py SHA-256: 530022e4b9030390b21aeb603fdafb99d1b296080308873667d2032e562f5d4d
Retains its SQLite queue, idempotency tombstones, spawned worker and ASGI guard.
No model result or live service is implied by this controller's presence.
"""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import hmac
import json
import multiprocessing as mp
import os
from pathlib import Path
import sqlite3
import threading
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Callable, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from service.contract import PredictionRequest, ResultEnvelope, validate_result
from track_export import PAYLOAD_LIMIT

EXPECTED_PINS = {
    'model': 'google/alphagenome-all-folds',
    'researchRevision': '0db53bd4352c66d1e00a049a81da373a066e6670',
    'clientRevision': 'aa6fc8f6faadcb8c910fa2b85b57386fbd5c7b5d',
    'checkpointRevision': 'a8f293a76ee73d5b57f3bf2ae146510589fcf187',
}
PUBLIC_ERRORS = {'service_restarted', 'expired', 'queue_timeout', 'prediction_timeout',
                 'prediction_failed', 'worker_unavailable', 'result_validation_failed'}


class JobReceipt(BaseModel):
    jobId: str
    status: Literal['queued', 'running', 'completed', 'failed']


class JobStatus(JobReceipt):
    expiresAtUnix: float
    result: ResultEnvelope | None = None
    error: str | None = None


class Store:
    """Persist bounded jobs and exact verified results, with restart-safe idempotency."""

    def __init__(self, path: str, ttl: float = 3600, queue_limit: int = 4,
                 max_jobs: int = 128, queue_timeout: float = 300,
                 clock: Callable[[], float] = time.time) -> None:
        if min(ttl, queue_limit, max_jobs, queue_timeout) <= 0:
            raise ValueError('Store bounds must be positive.')
        self.lease = open(path + '.controller.lock', 'a', encoding='utf-8')
        try:
            fcntl.flock(self.lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.lease.close()
            raise RuntimeError('A controller already owns this database; run one API worker.') from exc
        os.chmod(path + '.controller.lock', 0o600)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        os.chmod(path, 0o600)
        self.db.row_factory = sqlite3.Row
        self.ttl, self.queue_limit, self.max_jobs = ttl, queue_limit, max_jobs
        self.queue_timeout, self.clock = queue_timeout, clock
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request_id TEXT UNIQUE, payload TEXT, digest TEXT, status TEXT, result TEXT, error TEXT, created REAL, expires REAL)')
        self.db.execute("UPDATE jobs SET status='failed', result=NULL, error='service_restarted' WHERE status IN ('queued','running')")
        self.db.commit()

    def close(self) -> None:
        """Release the database and singleton lease after the runtime has stopped."""
        with self.lock:
            self.db.close()
            if not self.lease.closed:
                fcntl.flock(self.lease.fileno(), fcntl.LOCK_UN)
                self.lease.close()

    def cleanup(self) -> None:
        """Erase expired input/results immediately; retain only bounded idempotency tombstones."""
        with self.lock:
            now = self.clock()
            self.db.execute("UPDATE jobs SET status='failed', payload=NULL, result=NULL, error='expired' WHERE expires <= ?", (now,))
            self.db.execute('DELETE FROM jobs WHERE expires < ?', (now - 7 * 86400,))
            self.db.commit()

    def submit(self, req: PredictionRequest, ready: bool, biosample: str | None) -> dict[str, Any]:
        payload = req.model_dump()
        canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'))
        digest = hashlib.sha256(json.dumps(req.model_dump(exclude={'requestId'}), sort_keys=True,
                                          separators=(',', ':')).encode()).hexdigest()
        with self.lock:
            self.cleanup()
            prior = self.db.execute('SELECT * FROM jobs WHERE request_id=?', (req.requestId,)).fetchone()
            if prior:
                if prior['digest'] != digest:
                    raise HTTPException(409, 'request_id_conflict')
                if prior['expires'] <= self.clock():
                    raise HTTPException(410, 'job_expired')
                return {'jobId': prior['id'], 'status': prior['status']}
            if not ready:
                raise HTTPException(503, 'model_not_ready')
            if req.biosample != biosample:
                raise HTTPException(422, 'biosample_unavailable')
            active = self.db.execute("SELECT COUNT(*) FROM jobs WHERE status='queued'").fetchone()[0]
            live = self.db.execute('SELECT COUNT(*) FROM jobs WHERE expires > ?', (self.clock(),)).fetchone()[0]
            total = self.db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0]
            if active >= self.queue_limit or live >= self.max_jobs or total >= 10000:
                raise HTTPException(429, 'job_capacity_reached', headers={'Retry-After': '30'})
            job_id, now = str(uuid.uuid4()), self.clock()
            self.db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)',
                            (job_id, req.requestId, canonical, digest, 'queued', None, None, now, now + self.ttl))
            self.db.commit()
            return {'jobId': job_id, 'status': 'queued'}

    def take(self) -> dict[str, Any] | None:
        """Atomically claim the oldest unexpired queued job."""
        with self.lock:
            self.cleanup()
            self.db.execute("UPDATE jobs SET status='failed', error='queue_timeout' WHERE status='queued' AND created <= ?", (self.clock() - self.queue_timeout,))
            row = self.db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
            if row:
                self.db.execute("UPDATE jobs SET status='running' WHERE id=?", (row['id'],))
            self.db.commit()
            return {**dict(row), 'status': 'running'} if row else None

    def finish(self, job_id: str, result: dict[str, Any] | None = None,
               error: str | None = None) -> None:
        """Complete only a claimed, live job with a result verified against its stored request."""
        with self.lock:
            self.cleanup()
            row = self.db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
            if not row:
                raise ValueError('Cannot complete an unknown job.')
            if row['expires'] <= self.clock():
                return  # A late worker cannot revive an expired result.
            if row['status'] != 'running':
                raise ValueError('Only a running job can finish.')
            if error is not None:
                safe_error = error if error in PUBLIC_ERRORS else 'prediction_failed'
                self.db.execute("UPDATE jobs SET status='failed', result=NULL, error=? WHERE id=?", (safe_error, job_id))
                self.db.commit()
                return
            try:
                if result is None:
                    raise ValueError('A completed job must contain a verified result.')
                verified = validate_result(result, json.loads(row['payload']))
                encoded = json.dumps(verified, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
            except Exception as exc:
                self.db.execute("UPDATE jobs SET status='failed', result=NULL, error='result_validation_failed' WHERE id=?", (job_id,))
                self.db.commit()
                raise ValueError('Result failed persisted-request validation.') from exc
            self.db.execute("UPDATE jobs SET status='completed', result=?, error=NULL WHERE id=?", (encoded, job_id))
            self.db.commit()

    def fail_active(self, error: str = 'worker_unavailable') -> None:
        with self.lock:
            safe_error = error if error in PUBLIC_ERRORS else 'worker_unavailable'
            self.db.execute("UPDATE jobs SET status='failed', result=NULL, error=? WHERE status IN ('queued','running')", (safe_error,))
            self.db.commit()

    def get(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            self.cleanup()
            row = self.db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
            if not row:
                raise HTTPException(404, 'job_not_found')
            if row['expires'] <= self.clock():
                raise HTTPException(410, 'job_expired')
            result: dict[str, Any] = {'jobId': row['id'], 'status': row['status'], 'expiresAtUnix': row['expires']}
            if row['status'] == 'completed':
                result['result'] = json.loads(row['result'])
            if row['status'] == 'failed':
                result['error'] = row['error']
            return result


def child_main(pipe: Any) -> None:
    """The spawned process owns the real Engine and never logs requests or credentials."""
    try:
        from service.engine import Engine
        engine = Engine()
        metadata = engine.boot()
        pipe.send({'ok': True, 'metadata': metadata})
        while True:
            command = pipe.recv()
            if command is None:
                return
            try:
                pipe.send({'ok': True, 'result': engine.predict(command)})
            except Exception:
                pipe.send({'ok': False, 'error': 'prediction_failed'})
    except Exception:
        try:
            pipe.send({'ok': False, 'error': 'model_initialization_failed'})
        except Exception:
            pass
    finally:
        pipe.close()


class Runtime:
    """Reuse one spawned model process; failures never create successful jobs."""

    def __init__(self, store: Store, *, startup_timeout: float = 900,
                 prediction_timeout: float = 300, worker_target: Callable[..., None] = child_main) -> None:
        self.store = store
        self.ready = False
        self.metadata: dict[str, Any] | None = None
        self.error: str | None = None
        self.stop_event = threading.Event()
        self.process: Any = None
        self.thread: threading.Thread | None = None
        self.process_lock = threading.RLock()
        self.startup_timeout, self.prediction_timeout = startup_timeout, prediction_timeout
        self.worker_target = worker_target

    def start(self) -> None:
        with self.process_lock:
            if self.stop_event.is_set() or self.thread is not None:
                return
            self.thread = threading.Thread(target=self.run, daemon=True)
            self.thread.start()

    def kill_worker(self) -> None:
        with self.process_lock:
            if self.process is not None and self.process.is_alive():
                self.process.terminate()
                self.process.join(5)
                if self.process.is_alive():
                    self.process.kill()
                    self.process.join(5)

    def receive(self, pipe: Any, timeout: float) -> dict[str, Any]:
        """Wait with an interruptible deadline, including while the model boots."""
        deadline = time.monotonic() + timeout
        while not self.stop_event.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            if pipe.poll(min(0.1, remaining)):
                reply = pipe.recv()
                if not isinstance(reply, dict):
                    raise ValueError('Invalid worker reply.')
                return reply
            if self.process is not None and not self.process.is_alive():
                raise RuntimeError('Worker stopped.')
        raise InterruptedError('Service stopped.')

    def run(self) -> None:
        ctx = mp.get_context('spawn')
        parent, child = ctx.Pipe()
        try:
            # close() cannot miss a child that is about to start.
            with self.process_lock:
                if self.stop_event.is_set():
                    return
                self.process = ctx.Process(target=self.worker_target, args=(child,), daemon=True)
                self.process.start()
            child.close()
            boot = self.receive(parent, self.startup_timeout)
            if boot.get('ok') is not True:
                self.error = 'model_initialization_failed'
                return
            metadata = boot.get('metadata')
            if not isinstance(metadata, dict) or not isinstance(metadata.get('biosample'), str) or not metadata['biosample'].strip() or len(metadata['biosample']) > 200:
                self.error = 'model_initialization_failed'
                return
            if len(json.dumps(metadata, ensure_ascii=False, allow_nan=False).encode()) > PAYLOAD_LIMIT:
                self.error = 'model_initialization_failed'
                return
            with self.store.lock:
                if self.stop_event.is_set():
                    return
                self.metadata, self.ready = metadata, True
            while not self.stop_event.wait(0.1):
                job = self.store.take()
                if job is None:
                    if not self.process.is_alive():
                        raise RuntimeError('Worker stopped.')
                    continue
                try:
                    parent.send(json.loads(job['payload']))
                    try:
                        reply = self.receive(parent, self.prediction_timeout)
                    except TimeoutError:
                        self.store.finish(job['id'], error='prediction_timeout')
                        raise
                    if reply.get('ok') is True:
                        self.store.finish(job['id'], result=reply.get('result'))
                    else:
                        self.store.finish(job['id'], error='prediction_failed')
                except Exception:
                    # Preserve a specific timeout/validation error already persisted.
                    try:
                        if self.store.get(job['id'])['status'] == 'running':
                            self.store.finish(job['id'], error='worker_unavailable')
                    except HTTPException:
                        pass
                    raise
        except Exception:
            if self.error is None:
                self.error = 'worker_unavailable'
        finally:
            self._mark_unavailable()
            self.kill_worker()
            parent.close()
            child.close()

    def _mark_unavailable(self) -> None:
        """Fence new submissions and fail existing work in the same queue transaction."""
        with self.store.lock:
            self.ready = False
            self.store.fail_active()

    def close(self) -> None:
        self.stop_event.set()
        self._mark_unavailable()
        # Never hold the queue lock while terminating or joining its worker.
        self.kill_worker()
        if self.thread is not None:
            self.thread.join(12)


class Guard:
    """Original bearer/HTTPS guard; protect every route before parsing bounded bodies."""

    def __init__(self, app: Any, token: str) -> None:
        self.app, self.token = app, token

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)

        async def safe_send(message: dict[str, Any]) -> None:
            if message['type'] == 'http.response.start':
                message = {**message, 'headers': [*message.get('headers', []),
                    (b'cache-control', b'no-store'), (b'x-content-type-options', b'nosniff')]}
            await send(message)

        async def reject(code: int, detail: str) -> None:
            await JSONResponse({'detail': detail}, status_code=code)(scope, receive, safe_send)

        headers = dict(scope['headers'])
        auth = headers.get(b'authorization', b'')
        if sum(key == b'authorization' for key, _ in scope['headers']) != 1 or len(auth) > 1024 or not hmac.compare_digest(auth, ('Bearer ' + self.token).encode()):
            return await reject(401, 'unauthorized')
        if scope.get('scheme') != 'https':
            return await reject(400, 'https_required')
        if headers.get(b'content-encoding', b'identity') != b'identity':
            return await reject(415, 'content_encoding_unsupported')
        body = bytearray()
        try:
            async with asyncio.timeout(10):
                while True:
                    message = await receive()
                    if message['type'] == 'http.disconnect':
                        return
                    body.extend(message.get('body', b''))
                    if len(body) > 4096:
                        return await reject(413, 'request_too_large')
                    if not message.get('more_body', False):
                        break
        except TimeoutError:
            return await reject(408, 'request_timeout')
        delivered = False

        async def replay() -> dict[str, Any]:
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {'type': 'http.request', 'body': bytes(body), 'more_body': False}

        await self.app(scope, replay, safe_send)


def create_app(store: Store | None = None, runtime: Runtime | None = None,
               token: str | None = None) -> FastAPI:
    """Create the private API; injected runtime/store are only for offline controller tests."""
    token = token if token is not None else os.environ.get('HELIX_GPU_SERVICE_TOKEN', '')
    if not 32 <= len(token) <= 512 or any(ord(char) < 33 or ord(char) > 126 for char in token):
        raise RuntimeError('A private printable service token of 32–512 characters is required.')
    owns_store = store is None
    if owns_store:
        state = Path(os.environ.get('HELIX_STATE_DIR', '/var/lib/helix-alphagenome'))
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        store = Store(str(state / 'jobs.sqlite3'))
    runtime = runtime or Runtime(store)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runtime.start()
        try:
            yield
        finally:
            runtime.close()
            if owns_store:
                store.close()

    app = FastAPI(title='Helix AlphaGenome private GPU API', version='2.0.0',
                  docs_url=None, redoc_url=None, openapi_url='/openapi.json', lifespan=lifespan)
    app.add_middleware(Guard, token=token)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({'detail': 'invalid_request'}, status_code=422)

    @app.exception_handler(Exception)
    async def internal_error(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse({'detail': 'internal_error'}, status_code=500)

    @app.get('/v1/health')
    def health() -> JSONResponse:
        result: dict[str, Any] = {'status': 'ready' if runtime.ready else 'starting',
            'expectedPins': EXPECTED_PINS,
            'pinEvidence': 'Expected configuration only; actual boot evidence is available through /v1/metadata.'}
        if runtime.error:
            result['error'] = runtime.error
        return JSONResponse(result, status_code=200 if runtime.ready else 503)

    @app.get('/v1/metadata')
    def metadata() -> dict[str, Any]:
        if not runtime.ready or runtime.metadata is None:
            raise HTTPException(503, 'model_not_ready')
        return runtime.metadata

    @app.post('/v1/predictions', status_code=202, response_model=JobReceipt)
    def submit(req: PredictionRequest) -> dict[str, Any]:
        with store.lock:
            return store.submit(req, runtime.ready, runtime.metadata.get('biosample') if runtime.metadata else None)

    @app.get('/v1/predictions/{jobId}', response_model=JobStatus, response_model_exclude_unset=True)
    def get(jobId: str) -> dict[str, Any]:
        if len(jobId) > 64:
            raise HTTPException(404, 'job_not_found')
        return store.get(jobId)

    schema_fn = app.openapi

    def secured_schema() -> dict[str, Any]:
        schema = schema_fn()
        schema.setdefault('components', {}).setdefault('securitySchemes', {})['ServiceBearer'] = {'type': 'http', 'scheme': 'bearer'}
        schema['security'] = [{'ServiceBearer': []}]
        return schema

    app.openapi = secured_schema
    return app
