import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const origin = process.env.HELIX_QA_URL || 'http://localhost:4190';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const results = [];
const contexts = [];
async function client() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  return { context, page, cdp, authenticatorId };
}
async function call(client, path, data, method = data === undefined ? 'GET' : 'POST') {
  return client.page.evaluate(async ({ path, data, method }) => {
    const response = await fetch(path, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }, { path, data, method });
}
async function ceremony(client, kind, displayName = 'Helix browser QA') {
  const root = kind === 'add' ? '/api/account/passkeys' : `/api/account/${kind}`;
  const options = await call(client, `${root}/options`, kind === 'registration' ? { displayName } : {});
  assert.equal(options.status, 200, JSON.stringify(options));
  const response = await client.page.evaluate(async ({ options, registration }) => {
    const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    const publicKey = { ...options, challenge: decode(options.challenge) };
    if (registration) {
      publicKey.user = { ...options.user, id: decode(options.user.id) };
      publicKey.excludeCredentials = options.excludeCredentials?.map(item => ({ ...item, id: decode(item.id) }));
    } else publicKey.allowCredentials = options.allowCredentials?.map(item => ({ ...item, id: decode(item.id) }));
    const credential = registration ? await navigator.credentials.create({ publicKey }) : await navigator.credentials.get({ publicKey });
    return credential.toJSON();
  }, { options: options.body.options, registration: kind !== 'authentication' });
  const verified = await call(client, `${root}/verify`, { response });
  assert.equal(verified.status, 200, JSON.stringify(verified));
  return verified.body.account;
}
const input = title => ({ dataset: {
  schemaVersion: 1, id: 'browser-qa-private-scores', kind: 'scores', title,
  provenance: { sourceUrl: '', sourceLabel: 'Synthetic browser test', assembly: 'GRCh38', model: 'No model run', context: 'Test only', mode: 'imported' },
  rows: [{ variant: 'chr9:128226027:G>A', biosample: 'Synthetic', modality: 'RNA_SEQ', scorer: 'Test', score: 0.12345678901234568 }],
}, settings: { chart: 'bars', title, modality: '', scorer: '', track: '', gene: '', metric: 'score', limit: 12, variant: '' } });
try {
  const alice = await client(), bob = await client();
  assert.equal((await call(alice, '/api/analyses', input('Anonymous cannot save'))).status, 401);
  const a = await ceremony(alice, 'registration', 'Helix QA Alice');
  assert.equal((await call(alice, '/api/account')).body.account.id, a.id);
  const cookies = await alice.context.cookies();
  const session = cookies.find(item => item.name === 'helix_session');
  assert.ok(session?.httpOnly); assert.equal(session.sameSite, 'Strict');
  if (origin.startsWith('https:')) assert.equal(session.secure, true);
  assert.equal(await alice.page.evaluate(() => document.cookie.includes('helix_session')), false);
  results.push('Real browser passkey registration, verified account and protected cookie');
  const saved = await call(alice, '/api/analyses', input('Private QA precision'));
  assert.equal(saved.status, 201, JSON.stringify(saved)); const id = saved.body.analysis.id;
  assert.equal(saved.body.access.mode, 'owner');
  assert.equal((await call(bob, `/api/analyses/${id}`)).status, 404);
  const b = await ceremony(bob, 'registration', 'Helix QA Bob'); assert.notEqual(a.id, b.id);
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const data = method === 'PATCH' ? { ...input('Forbidden'), revision: 0 } : method === 'DELETE' ? { revision: 0 } : undefined;
    assert.equal((await call(bob, `/api/analyses/${id}`, data, method)).status, 404);
  }
  assert.equal((await call(bob, '/api/analyses')).body.analyses.length, 0);
  assert.equal((await call(alice, `/api/analyses/${id}`)).body.analysis.dataset.rows[0].score, 0.12345678901234568);
  results.push('Private numerical data survives save; other accounts cannot read, write, delete or list it');
  await alice.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: alice.authenticatorId });
  const nextAuthenticator = await alice.cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  alice.authenticatorId = nextAuthenticator.authenticatorId;
  await ceremony(alice, 'add');
  assert.equal((await call(alice, '/api/account/passkeys')).body.passkeys.length, 2);
  results.push('Additional verified passkey remains attached to its account');
  const oldCookie = (await alice.context.cookies()).find(item => item.name === 'helix_session').value;
  assert.equal((await call(alice, '/api/account/logout', {})).status, 200);
  assert.equal((await call(alice, '/api/account')).body.account, null);
  assert.equal((await call(alice, `/api/analyses/${id}`)).status, 404);
  const revoked = await alice.context.request.get(`${origin}/api/account`, { headers: { Cookie: `helix_session=${oldCookie}` } });
  assert.equal((await revoked.json()).account, null);
  const restored = await ceremony(alice, 'authentication');
  assert.equal(restored.id, a.id);
  assert.equal((await call(alice, `/api/analyses/${id}`)).status, 200);
  results.push('Logout revokes the server session; real signed assertion restores the same account');
  const badOrigin = await alice.context.request.patch(`${origin}/api/analyses/${id}`, { headers: { Origin: 'https://unrelated.example' }, data: { ...input('CSRF'), revision: 0 } });
  assert.equal(badOrigin.status(), 403);
  assert.equal((await call(alice, `/api/analyses/${id}`, { revision: 0 }, 'DELETE')).status, 204);
  assert.equal((await call(alice, `/api/analyses/${id}`)).status, 404);
  results.push('Cross-origin change rejected; owner deletion completes');
  await call(alice, '/api/account/logout', {}); await call(bob, '/api/account/logout', {});
  await mkdir('qa-accounts', { recursive: true });
  await writeFile('qa-accounts/api-browser.json', JSON.stringify({ origin, results }, null, 2));
  console.log(JSON.stringify({ origin, passed: results.length, results }, null, 2));
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); }
