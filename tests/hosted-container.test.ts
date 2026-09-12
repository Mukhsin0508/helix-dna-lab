import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { PredictionRequest } from '../shared/prediction-request';

// Exercise the actual DO class with only Cloudflare's lifecycle primitives replaced.
const root = resolve(import.meta.dirname, '..');
const compiled = await build({ entryPoints: [resolve(root, 'deploy/higgsfield/src/lib/hosted-container.server.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false, plugins: [{ name: 'cloudflare-test-runtime', setup(builder) {
    builder.onResolve({ filter: /^@cloudflare\/containers$/ }, () => ({ path: 'runtime', namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `export class Container {
      constructor(ctx,env){this.mock=ctx;this.envVars={};ctx.instances.push(this);}
      async startAndWaitForPorts(){this.mock.boots++;if(this.mock.bootBarrier)await this.mock.bootBarrier;this.mock.containerState='healthy';}
      async getState(){return {status:this.mock.containerState};}
      async containerFetch(url,init){return this.mock.transport(url,init);}
      async schedule(when,callback,payload){this.mock.schedules.push({when,callback,payload});return {};}
      renewActivityTimeout(){this.mock.renewals++;}
      async stop(){this.mock.stops++;this.mock.containerState='stopped';}
    }` }));
    builder.onResolve({ filter: /^\.\.\/shared\// }, args => ({ path: resolve(root, 'shared', args.path.replace('../shared/', '') + '.ts') }));
  } }] });
const { AppContainer, validateHostedResult } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

class Storage {
  rows = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.rows.get(key)) as T | undefined; }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof key === 'string' ? [[key, value] as const] : Object.entries(key);
    for (const [name, item] of entries) {
      const size = item instanceof Uint8Array ? item.byteLength : Buffer.byteLength(JSON.stringify(item));
      assert.ok(size <= 128 * 1024, `Storage value ${name} exceeds the platform value bound`);
      if (item instanceof Uint8Array) assert.ok(size <= 64 * 1024);
      this.rows.set(name, structuredClone(item));
    }
  }
  async delete(key: string | string[]): Promise<void> { for (const item of Array.isArray(key) ? key : [key]) this.rows.delete(item); }
  async transaction<T>(callback: (tx: Storage) => Promise<T>): Promise<T> {
    const before = structuredClone(this.rows);
    try { return await callback(this); } catch (error) { this.rows = before; throw error; }
  }
}
function harness(existing = new Storage(), configured = true) {
  const context = {
    storage: existing, instances: [] as unknown[], schedules: [] as unknown[], background: [] as Promise<unknown>[],
    boots: 0, stops: 0, starts: 0, renewals: 0, containerState: 'stopped', bootBarrier: undefined as Promise<void> | undefined,
    status: undefined as unknown,
    waitUntil(promise: Promise<unknown>) { this.background.push(promise); },
    async transport(url: string, init?: RequestInit) {
      if (url === 'http://c/start') {
        this.starts++; const body = JSON.parse(String(init?.body));
        this.status = { jobId: body.jobId, status: 'running' };
        return Response.json(this.status, { status: 202 });
      }
      return Response.json(this.status);
    },
  };
  const key = 'server-only-key-not-for-any-http-response';
  const instance = new AppContainer(context, configured ? { ALPHAGENOME_API_KEY: key } : {});
  const flush = async () => { await Promise.all(context.background); };
  return { instance, context, flush, key };
}
const input = (): PredictionRequest => ({ requestId: randomUUID(), variantId: 'chr9:128226027:G>A', ontologyTerm: 'UBERON:0001157', cropBp: 256 });
const cap = () => randomBytes(32).toString('hex');
const post = (request: PredictionRequest, token: string) => new Request('https://internal/runs', { method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) });
const get = (id: string, token: string) => new Request(`https://internal/runs/${id}`, { headers: { authorization: `Bearer ${token}` } });

function fixture(request: PredictionRequest, padding = '') {
  const position = Number(request.variantId.split(':')[1]);
  const interval = { chromosome: 'chr9', start: position - Math.floor((request.cropBp + 1) / 2), end: position + Math.floor(request.cropBp / 2), coordinateSystem: '0-based-half-open' };
  const full = { ...interval, start: position - 524288, end: position + 524288 };
  const raw = JSON.stringify({ schemaVersion: 1, sourceKind: 'alphagenome_hosted_prediction',
    request: { ...request, organism: 'HOMO_SAPIENS', assembly: 'GRCh38', requestedModelVersion: 'ALL_FOLDS', outputTypes: ['RNA_SEQ'] },
    inputInterval: full, displayInterval: interval, softwareTestPadding: padding });
  const digest = createHash('sha256').update(raw).digest('hex');
  return { sourceResultJson: raw, sourceResultSha256: digest,
    analysis: { schemaVersion: 1, id: 'synthetic-software-check', title: 'Synthetic software check', kind: 'tracks',
      provenance: { sourceUrl: 'https://example.org/software-fixture', sourceLabel: 'Synthetic software test only',
        assembly: 'GRCh38', model: 'No model executed', context: 'Fixture for bridge contract tests', mode: 'imported',
        artifact: { filename: 'source-result.json', sha256: digest },
        inference: { variant: request.variantId, inputInterval: full, displayInterval: interval,
          modelRevision: 'Not run', clientRevision: 'Not run', checkpointRevision: 'Not applicable',
          referenceVersion: 'GRCh38', referenceSha256: null, transformations: [] } },
      rows: [{ chromosome: 'chr9', position: interval.start, reference: 0.123456789012345, alternate: 0, track: 'fixture' }] } };
}

test('unconfigured health and submissions never boot, and all run routes require a capability', async () => {
  const h = harness(undefined, false);
  assert.deepEqual(await (await h.instance.fetch(new Request('https://internal/health'))).json(), { configured: false });
  assert.equal((await h.instance.fetch(post(input(), cap()))).status, 503);
  assert.equal((await h.instance.fetch(new Request('https://internal/runs'))).status, 401);
  assert.equal((await h.instance.fetch(new Request('https://internal/start'))).status, 401);
  assert.equal(h.context.boots, 0);
});

test('only one active run; idempotency preserves the run and rejects changed parameters', async () => {
  const h = harness(), request = input(), token = cap();
  const first = await h.instance.fetch(post(request, token)), receipt = await first.json();
  assert.equal(first.status, 202); await h.flush();
  const repeat = await h.instance.fetch(post(request, token));
  assert.equal((await repeat.json()).jobId, receipt.jobId);
  assert.equal((await h.instance.fetch(post({ ...request, cropBp: 512 }, token))).status, 409);
  assert.equal((await h.instance.fetch(post(input(), cap()))).status, 429);
  assert.equal((await h.instance.fetch(get(receipt.jobId, cap()))).status, 404);
  assert.equal(h.context.starts, 1);
  const stored = JSON.stringify([...h.context.storage.rows]);
  assert.ok(!stored.includes(token)); assert.ok(!stored.includes(h.key));
});

test('concurrent submissions cannot both acquire the one active slot', async () => {
  const h = harness();
  const responses = await Promise.all([h.instance.fetch(post(input(), cap())), h.instance.fetch(post(input(), cap()))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [202, 429]);
  await h.flush(); assert.equal(h.context.starts, 1);
});

test('cold boot remains background work and monitors do not dispatch or poll early', async () => {
  const h = harness(); let release!: () => void;
  h.context.bootBarrier = new Promise<void>(resolve => { release = resolve; });
  const receipt = await (await h.instance.fetch(post(input(), cap()))).json();
  assert.equal(receipt.status, 'starting');
  await h.instance.monitorRun({ jobId: receipt.jobId });
  assert.equal(h.context.starts, 0);
  release(); await h.flush(); assert.equal(h.context.starts, 1);
});

test('completed results preserve exact bytes and numerical precision through bounded storage chunks', async () => {
  const h = harness(), request = input(), token = cap();
  const receipt = await (await h.instance.fetch(post(request, token))).json(); await h.flush();
  const result = fixture(request, 'µ'.repeat(110000));
  h.context.status = { jobId: receipt.jobId, status: 'completed', result };
  await h.instance.monitorRun({ jobId: receipt.jobId });
  const response = await (await h.instance.fetch(get(receipt.jobId, token))).json();
  assert.equal(response.status, 'completed'); assert.deepEqual(response.result, result);
  assert.ok([...h.context.storage.rows.keys()].filter(key => key.startsWith('result:')).length >= 4);
  assert.equal(response.result.analysis.rows[0].reference, 0.123456789012345);
  assert.equal(response.result.analysis.rows[0].alternate, 0);
});

test('forged hashes, wrong requests and malformed datasets cannot complete', async () => {
  const request = input(), result = fixture(request);
  await assert.rejects(validateHostedResult({ ...result, sourceResultSha256: '0'.repeat(64) }, request));
  await assert.rejects(validateHostedResult(result, { ...request, variantId: 'chr9:128225994:G>A' }));
  await assert.rejects(validateHostedResult({ ...result, analysis: { fake: true } }, request));
  const h = harness(), token = cap();
  const receipt = await (await h.instance.fetch(post(request, token))).json(); await h.flush();
  h.context.status = { jobId: receipt.jobId, status: 'completed', result: {} };
  await h.instance.monitorRun({ jobId: receipt.jobId });
  assert.equal((await (await h.instance.fetch(get(receipt.jobId, token))).json()).error.code, 'result_invalid');
});

test('a restarted container never replays an uncertain provider submission', async () => {
  const h = harness(), request = input(), token = cap();
  const receipt = await (await h.instance.fetch(post(request, token))).json(); await h.flush();
  const restarted = harness(h.context.storage);
  await restarted.instance.monitorRun({ jobId: receipt.jobId });
  const response = await (await restarted.instance.fetch(get(receipt.jobId, token))).json();
  assert.equal(response.status, 'failed'); assert.equal(response.error.code, 'service_interrupted');
  assert.equal(restarted.context.starts, 0);
  assert.equal((await (await restarted.instance.fetch(post(request, token))).json()).jobId, receipt.jobId);
  assert.equal(restarted.context.starts, 0);
});

test('deadline failures redact provider exceptions; expiry removes exact results and prevents retry', async context => {
  const h = harness(), request = input(), token = cap();
  const now = Date.now(); context.mock.method(Date, 'now', () => now);
  const receipt = await (await h.instance.fetch(post(request, token))).json(); await h.flush();
  context.mock.method(Date, 'now', () => now + 240001);
  await h.instance.monitorRun({ jobId: receipt.jobId });
  const failure = await (await h.instance.fetch(get(receipt.jobId, token))).json();
  assert.equal(failure.error.code, 'prediction_timeout'); assert.equal(h.context.stops, 1);
  context.mock.method(Date, 'now', () => now + 3600001);
  await h.instance.expireRun({ jobId: receipt.jobId });
  assert.equal((await h.instance.fetch(get(receipt.jobId, token))).status, 410);
  assert.equal((await h.instance.fetch(post(request, token))).status, 410);
  assert.ok(![...h.context.storage.rows.values()].some(value => typeof value === 'object' && value !== null && 'request' in value));
});

test('thirty attempted runs exhaust the daily allowance without storing a provider key', async () => {
  const h = harness();
  for (let n = 0; n < 30; n++) {
    const receipt = await (await h.instance.fetch(post(input(), cap()))).json(); await h.flush();
    h.context.status = { jobId: receipt.jobId, status: 'failed', error: { code: `provider-${h.key}` } };
    await h.instance.monitorRun({ jobId: receipt.jobId });
  }
  const response = await h.instance.fetch(post(input(), cap()));
  assert.equal(response.status, 429); assert.equal((await response.json()).error.code, 'daily_limit');
  assert.ok(!JSON.stringify([...h.context.storage.rows]).includes(h.key));
});

test('the actual SDK offline fixture passes Python-to-Worker envelope validation', async context => {
  const python = process.env.HELIX_HOSTED_PYTHON || '/tmp/helix-hosted-sdk-runtime/bin/python';
  if (!existsSync(python)) { context.skip('Set HELIX_HOSTED_PYTHON to the isolated AlphaGenome SDK test interpreter.'); return; }
  const generated = spawnSync(python, ['-c', [
    'import json',
    'from inference.hosted.test_runner import run_offline, REQUEST',
    'from inference.hosted.contract import HostedRequest',
    'envelope,_ = run_offline(HostedRequest.parse(REQUEST))',
    'print(json.dumps({"request": REQUEST, "result": envelope}))',
  ].join('\n')], { cwd: root, encoding: 'utf8', maxBuffer: 6 * 1024 * 1024, timeout: 20000 });
  assert.equal(generated.status, 0, 'The offline SDK fixture must generate successfully; provider output is not logged.');
  const { request, result } = JSON.parse(generated.stdout);
  assert.deepEqual(await validateHostedResult(result, { requestId: randomUUID(), ...request }), result);
});
