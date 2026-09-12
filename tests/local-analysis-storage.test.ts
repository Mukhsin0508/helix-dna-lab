import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readStoredAnalysis, validateLocalAnalysis } from '../src/localAnalysisStorage';
import { loadPublicAnalysis, useAnalysis } from '../src/useAnalysis';
import { DNM1_MEASUREMENTS, defaultSettings } from '../src/analysisUtils';

const input = () => ({ dataset: structuredClone(DNM1_MEASUREMENTS), settings: defaultSettings(DNM1_MEASUREMENTS) });
const id = 'f838024b-593d-4555-9b81-599df07eca55';
const record = () => ({ ...input(), id, revision: 3, createdAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T11:00:00.000Z' });

test('server rendering does not read browser storage or make an account request', () => {
  function Workspace() { const lab = useAnalysis(); return createElement('span', null, `${lab.dataset.kind}:${lab.ready}:${lab.storageStatus}`); }
  assert.equal(renderToString(createElement(Workspace)), '<span>scores:false:memory-only</span>');
});

test('local snapshot preserves complete measurements, uncertainty, source metadata and figure settings', () => {
  const value = input(); value.settings.variant = 'chr9:128226027:G>A'; value.settings.chart = 'table';
  const restored = readStoredAnalysis(JSON.parse(JSON.stringify({ format: 'helix-local-workspace', version: 1, input: value })));
  assert.deepEqual(restored, value);
  assert.equal(restored.dataset.rows.length, 12);
  assert.equal(restored.dataset.kind === 'measurements' && restored.dataset.rows[0].value, 0.94);
  assert.equal(restored.dataset.kind === 'measurements' && restored.dataset.rows[0].standardError, null);
});

test('local storage refuses account envelopes, malformed scientific data, incompatible settings and oversized inputs', () => {
  assert.throws(() => readStoredAnalysis({ analysis: record(), access: { mode: 'owner', canWrite: true } }));
  assert.throws(() => readStoredAnalysis({ format: 'helix-local-workspace', version: 2, input: input() }));
  assert.throws(() => readStoredAnalysis({ format: 'helix-local-workspace', version: 1, input: input(), owner: 'someone' }));
  assert.throws(() => validateLocalAnalysis({ ...input(), owner: 'someone' }));
  assert.throws(() => validateLocalAnalysis({ ...input(), settings: { ...input().settings, metric: 'quantile' } }));
  const invalid = input();
  if (invalid.dataset.kind === 'measurements') invalid.dataset.rows[0].value = Number.NaN;
  assert.throws(() => validateLocalAnalysis(invalid));
  const oversized = input();
  oversized.dataset.provenance.context = 'x'.repeat(2 * 1024 * 1024);
  assert.throws(() => validateLocalAnalysis(oversized));
});

test('public loading omits credentials, binds the requested ID and refuses every owner response', async () => {
  const original = globalThis.fetch;
  try {
    let body: unknown = { analysis: record(), access: { mode: 'legacy-public', canWrite: false } };
    globalThis.fetch = async (url, options) => {
      assert.equal(url, `/api/analyses/${id}`);
      assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error'); assert.equal(options?.cache, 'no-store');
      assert.equal(options?.method, undefined); assert.equal(options?.headers, undefined);
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    };
    assert.deepEqual(await loadPublicAnalysis(id, new AbortController().signal), record());
    for (const access of [{ mode: 'owner', canWrite: true }, { mode: 'owner', canWrite: false }, { mode: 'legacy-public', canWrite: true }, undefined]) {
      body = { analysis: record(), access };
      await assert.rejects(loadPublicAnalysis(id, new AbortController().signal), /Only public/);
    }
    body = { analysis: { ...record(), id: 'bb7cdb77-6fa5-40df-9be9-21fc67ee6b8b' }, access: { mode: 'legacy-public', canWrite: false } };
    await assert.rejects(loadPublicAnalysis(id, new AbortController().signal), /invalid/);
    body = { analysis: { ...record(), revision: -1 }, access: { mode: 'legacy-public', canWrite: false } };
    await assert.rejects(loadPublicAnalysis(id, new AbortController().signal), /invalid/);
  } finally { globalThis.fetch = original; }
});

test('invalid public IDs never issue a request and private 404 remains unavailable', async () => {
  const original = globalThis.fetch; let requests = 0;
  try {
    globalThis.fetch = async () => { requests += 1; return new Response('{}', { status: 404 }); };
    await assert.rejects(loadPublicAnalysis('not-an-id', new AbortController().signal), /invalid/);
    assert.equal(requests, 0);
    await assert.rejects(loadPublicAnalysis(id, new AbortController().signal), /not a public analysis/);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});
