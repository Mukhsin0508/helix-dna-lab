import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePredictionRequest } from '../shared/predictions.server';

const origin = 'https://genetic-engineering-lab.higgsfield.app';
const capability = 'a'.repeat(64);
const secret = 'server-only-test-secret';
const body = { requestId: 'ce435beb-9a83-4109-bcd4-3c12407fd1ae', variantId: 'chr22:36201698:A>C', ontologyTerm: 'UBERON:0001157', cropBp: 256 };
function input(path = '', method = 'POST', options: { origin?: string; token?: string; body?: string } = {}): Request {
  return new Request(`${origin}/api/predictions${path}`, { method, headers: { Origin: options.origin ?? origin, Authorization: `Bearer ${options.token ?? capability}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: options.body ?? JSON.stringify(body) } : {}) });
}

test('health and missing-key requests never wake or disclose the CPU service', async () => {
  let called = false;
  const bindings = { CONTAINER: { getByName: () => { called = true; throw new Error('must not start'); } } };
  const health = await handlePredictionRequest(input('/health', 'GET'), bindings);
  assert.equal((await health!.json()).configured, false);
  assert.equal((await handlePredictionRequest(input(), bindings))!.status, 503);
  assert.equal(called, false);
});

test('mutations require exact origin and per-run capability; input is bounded', async () => {
  let calls = 0;
  const bindings = { ALPHAGENOME_API_KEY: secret, CONTAINER: { getByName: () => { calls++; throw new Error('must not start'); } } };
  assert.equal((await handlePredictionRequest(input('', 'POST', { origin: 'https://other.example' }), bindings))!.status, 403);
  assert.equal((await handlePredictionRequest(input('', 'POST', { token: 'not-a-token' }), bindings))!.status, 401);
  assert.equal((await handlePredictionRequest(input('', 'POST', { body: ' '.repeat(2049) }), bindings))!.status, 413);
  const noOrigin = input(); noOrigin.headers.delete('Origin');
  assert.equal((await handlePredictionRequest(noOrigin, bindings))!.status, 403);
  assert.equal(calls, 0);
});

test('only the run token and variant request cross the private container boundary', async () => {
  let captured: Request | undefined;
  const bindings = { ALPHAGENOME_API_KEY: secret, CONTAINER: { getByName: (name: string) => {
    assert.equal(name, 'alphagenome');
    return { fetch: async (request: Request) => { captured = request; return Response.json({ jobId: body.requestId, status: 'starting' }, { status: 202, headers: { 'set-cookie': 'do-not-forward=1' } }); } };
  } } };
  const result = await handlePredictionRequest(input(), bindings);
  assert.equal(result!.status, 202); assert.equal(result!.headers.get('Cache-Control'), 'no-store');
  assert.equal(result!.headers.has('set-cookie'), false);
  assert.equal(captured!.headers.get('Authorization'), `Bearer ${capability}`);
  assert.equal(captured!.headers.has('cookie'), false);
  assert.deepEqual(await captured!.json(), body);
  assert.equal((await result!.text()).includes(secret), false);
});

test('upstream errors cannot leak credentials through server exception text', async () => {
  const bindings = { ALPHAGENOME_API_KEY: secret, CONTAINER: { getByName: () => ({ fetch: async () => { throw new Error(secret); } }) } };
  const result = await handlePredictionRequest(input(), bindings);
  assert.equal(result!.status, 503); assert.equal((await result!.text()).includes(secret), false);
  assert.equal(await handlePredictionRequest(new Request(`${origin}/api/analyses`), bindings), undefined);
});
