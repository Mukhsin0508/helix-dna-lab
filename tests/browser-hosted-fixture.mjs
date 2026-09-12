/**
 * LOCAL SOFTWARE FIXTURE ONLY. This serves dist/ unchanged and substitutes only
 * /api/predictions with synthetic SDK data. Never deploy this server or its data.
 * Start: node tests/browser-hosted-fixture.mjs
 * Optional: HELIX_FIXTURE_HEALTH_DELAY_MS=3000 HELIX_FIXTURE_RESULT_DELAY_MS=1000
 */
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = resolve(ROOT, 'dist');
const OUTPUT = resolve(ROOT, 'qa-hosted');
const PYTHON = process.env.HELIX_HOSTED_PYTHON || '/tmp/helix-hosted-sdk-runtime/bin/python';
const HOST = '127.0.0.1', PORT = 4194, ORIGIN = `http://${HOST}:${PORT}`;
const MAX_BYTES = 6 * 1024 * 1024;
const delaySetting = name => {
  const value = Number(process.env[name] || 0);
  if (!Number.isSafeInteger(value) || value < 0 || value > 20000) throw new Error(`${name} must be 0..20000.`);
  return value;
};
const HEALTH_DELAY = delaySetting('HELIX_FIXTURE_HEALTH_DELAY_MS');
const RESULT_DELAY = delaySetting('HELIX_FIXTURE_RESULT_DELAY_MS');
if (!existsSync(resolve(DIST, 'index.html'))) throw new Error('Build dist/ before starting the local fixture.');
if (!existsSync(PYTHON)) throw new Error('Set HELIX_HOSTED_PYTHON to the isolated SDK test interpreter.');
await mkdir(OUTPUT, { recursive: true });
// Keep generated synthetic envelopes and lifecycle files out of Git without touching root .gitignore.
await writeFile(resolve(OUTPUT, '.gitignore'), '*\n');
const rows = new Map(), ids = new Map(), children = new Set();

const GENERATOR = `import json,sys
from inference.hosted.test_runner import run_offline
from inference.hosted.contract import HostedRequest
request=HostedRequest.parse(json.load(sys.stdin))
envelope,_=run_offline(request)
# run_offline validates the real SDK envelope with synthetic arrays and a mocked
# model/reference service. Relabel the presentation for browser QA; retain every
# numerical value, native metadata item, exact sidecar byte and its checksum.
analysis=envelope['analysis']
analysis['title']='SYNTHETIC SOFTWARE TEST · '+request.variant_id
analysis['provenance']['sourceLabel']='Synthetic browser QA fixture · no Google inference'
analysis['provenance']['model']='Synthetic SDK arrays · no model executed'
analysis['provenance']['context']='Local browser workflow test only. Actual AlphaGenome SDK data containers with synthetic arrays and mocked reference/model services. No API key or network inference was used.'
print(json.dumps(envelope,ensure_ascii=False,separators=(',',':')))
`;
const digest = value => createHash('sha256').update(value).digest('hex');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function json(response, status, value) {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Helix-Software-Fixture': 'synthetic-no-inference' });
  response.end(JSON.stringify(value));
}
function fail(response, status, code, message) { json(response, status, { error: { code, message } }); }
function capability(request) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '');
  return match ? digest(match[1]) : null;
}
async function body(request) {
  const parts = []; let count = 0;
  for await (const part of request) {
    count += part.length;
    if (count > 4096) throw new Error('invalid_request');
    parts.push(part);
  }
  const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!value || Object.keys(value).sort().join(',') !== 'cropBp,ontologyTerm,requestId,variantId'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.requestId || '')
    || !/^chr(?:[1-9]|1\d|2[0-2]|X|Y):[1-9]\d{0,8}:[ACGT]>[ACGT]$/.test(value.variantId || '')
    || value.variantId.at(-1) === value.variantId.at(-3)
    || !/^(?:UBERON|CL|EFO|CLO|NTR):\d{4,12}$/.test(value.ontologyTerm || '')
    || !Number.isSafeInteger(value.cropBp) || value.cropBp < 32 || value.cropBp > 1024) throw new Error('invalid_request');
  return value;
}
function generate(input) {
  return new Promise((accept, reject) => {
    const child = spawn(PYTHON, ['-c', GENERATOR], { cwd: ROOT,
      // The subprocess mock supplies its own non-secret sentinel. No host key is forwarded.
      env: { PATH: process.env.PATH || '/usr/bin:/bin', PYTHONPATH: ROOT, PYTHONDONTWRITEBYTECODE: '1', MPLBACKEND: 'Agg' },
      stdio: ['pipe', 'pipe', 'ignore'] });
    children.add(child);
    const parts = []; let bytes = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture_timeout')); }, 20000);
    child.stdout.on('data', part => {
      bytes += part.length;
      if (bytes > MAX_BYTES) { child.kill('SIGKILL'); reject(new Error('fixture_too_large')); }
      else parts.push(part);
    });
    child.on('error', () => { clearTimeout(timer); children.delete(child); reject(new Error('fixture_generation_failed')); });
    child.on('close', code => {
      clearTimeout(timer); children.delete(child);
      try {
        if (code !== 0) throw new Error('fixture_generation_failed');
        const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (!value.analysis?.title?.startsWith('SYNTHETIC SOFTWARE TEST')
          || digest(value.sourceResultJson) !== value.sourceResultSha256) throw new Error('fixture_invalid');
        accept(value);
      } catch { reject(new Error('fixture_generation_failed')); }
    });
    const { requestId: _requestId, ...runnerInput } = input;
    child.stdin.end(JSON.stringify(runnerInput));
  });
}
async function finish(row) {
  try {
    const result = await generate(row.input);
    await sleep(RESULT_DELAY);
    await writeFile(resolve(OUTPUT, `synthetic-${row.jobId}.json`), JSON.stringify(result), { mode: 0o600 });
    row.result = result; row.status = 'completed';
  } catch {
    row.status = 'failed'; row.error = { code: 'fixture_generation_failed', message: 'The local synthetic fixture could not be generated. No Google request was sent.' };
  }
}
async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/predictions/health') {
    await sleep(HEALTH_DELAY); return json(response, 200, { configured: true, softwareFixture: true, realInference: false });
  }
  const owner = capability(request);
  if (!owner) return fail(response, 401, 'unauthorized', 'This local fixture run requires its browser capability.');
  if (request.method === 'POST' && url.pathname === '/api/predictions') {
    if (request.headers.origin !== ORIGIN) return fail(response, 403, 'invalid_origin', 'Use this fixture from its own localhost page.');
    const input = await body(request), identity = `${owner}:${input.requestId}`, fingerprint = digest(JSON.stringify(input));
    const previous = rows.get(ids.get(identity));
    if (previous) {
      if (previous.fingerprint !== fingerprint) return fail(response, 409, 'request_conflict', 'This fixture request ID has different settings.');
      return json(response, 202, { jobId: previous.jobId, status: previous.status });
    }
    if ([...rows.values()].some(row => row.status === 'running')) return fail(response, 429, 'capacity_reached', 'A local fixture is still being generated.');
    const row = { jobId: randomUUID(), owner, fingerprint, input, status: 'running', createdAt: Date.now() };
    rows.set(row.jobId, row); ids.set(identity, row.jobId);
    json(response, 202, { jobId: row.jobId, status: 'starting' });
    void finish(row); return;
  }
  const match = /^\/api\/predictions\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (request.method === 'GET' && match) {
    const row = rows.get(match[1]);
    if (!row || row.owner !== owner) return fail(response, 404, 'not_found', 'This local fixture run was not found.');
    if (Date.now() - row.createdAt > 3600000) return json(response, 410, { jobId: row.jobId, status: 'expired' });
    return json(response, 200, { jobId: row.jobId, status: row.status,
      ...(row.result ? { result: row.result } : {}), ...(row.error ? { error: row.error } : {}) });
  }
  fail(response, 404, 'not_found', 'No such test endpoint.');
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', ORIGIN);
    if (url.pathname.startsWith('/api/predictions')) return await api(request, response, url);
    if (url.pathname === '/__fixture') return json(response, 200, { fixture: 'synthetic software QA', realInference: false, runs: rows.size, healthDelayMs: HEALTH_DELAY, resultDelayMs: RESULT_DELAY });
    if (url.pathname.startsWith('/api/')) return fail(response, 404, 'not_found', 'The fixture does not implement other API routes.');
    if (!['GET', 'HEAD'].includes(request.method || '')) return fail(response, 405, 'method_not_allowed', 'Static test assets are read-only.');
    let path = resolve(DIST, '.' + decodeURIComponent(url.pathname));
    if (path !== DIST && !path.startsWith(DIST + sep)) return fail(response, 404, 'not_found', 'Not found.');
    try { if (!(await stat(path)).isFile()) path = resolve(DIST, 'index.html'); }
    catch { path = resolve(DIST, 'index.html'); }
    const data = await readFile(path);
    response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { fail(response, 400, 'invalid_request', 'The local test request was invalid.'); }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(PORT, HOST, async () => {
  await writeFile(resolve(OUTPUT, 'fixture-server.pid'), String(process.pid));
  console.log(`Synthetic software fixture only: ${ORIGIN} (PID ${process.pid}); no Google calls.`);
});
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => {
  for (const child of children) child.kill('SIGKILL');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
