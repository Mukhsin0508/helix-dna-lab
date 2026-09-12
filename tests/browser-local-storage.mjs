import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const virtualId = 'virtual:helix-local-workspace-qa';
const moduleSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useAnalysis } from '/src/useAnalysis.ts';
import { DNM1_MEASUREMENTS, defaultSettings } from '/src/analysisUtils.ts';
import { createLocalAnalysisStorage } from '/src/localAnalysisStorage.ts';
window.measurements = DNM1_MEASUREMENTS;
window.defaultSettings = defaultSettings;
window.newStore = createLocalAnalysisStorage;
const root = createRoot(document.getElementById('root'));
window.unmountWorkspace = () => root.unmount();
function Harness() {
  const lab = useAnalysis(); window.lab = lab;
  return React.createElement('pre', { id: 'state' }, JSON.stringify({ready:lab.ready, busy:lab.busy, status:lab.storageStatus, title:lab.settings.title, kind:lab.dataset.kind, error:lab.error}));
}
root.render(React.createElement(React.StrictMode, null, React.createElement(Harness)));
`;
const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'isolated-workspace-qa',
  resolveId(id) { if (id === virtualId) return `\0${virtualId}`; },
  load(id) { if (id === `\0${virtualId}`) return moduleSource; },
  configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith('/__workspace')) return next();
      const html = await vite.transformIndexHtml('/__workspace', `<!doctype html><html><body><div id="root"></div><script type="module">import '${virtualId}'</script></body></html>`);
      response.setHeader('Content-Type', 'text/html'); response.end(html);
    });
  },
}] });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const contexts = [], results = [];
async function client() {
  const context = await browser.newContext(); contexts.push(context);
  const page = await context.newPage();
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  const requests = []; page.on('request', request => { if (request.url().includes('/api/')) requests.push(request); });
  return { context, page, failures, requests };
}
async function ready(page) { await page.waitForFunction(() => window.lab?.ready && !window.lab.busy); }
async function saved(page) { await page.waitForFunction(() => window.lab?.storageStatus === 'saved'); }
async function edit(page, title) { await page.evaluate(title => { window.lab.openDataset(window.measurements); window.lab.setSettings({ title, chart: 'table', variant: 'chr9:128226027:G>A' }); }, title); await saved(page); }
try {
  const first = await client();
  await first.page.goto(`${origin}/__workspace`); await ready(first.page); await saved(first.page);
  assert.equal(first.requests.length, 0, 'Root must not call account or analysis APIs');
  await edit(first.page, 'Exact DNM1 browser draft');
  const before = await first.page.evaluate(() => ({ dataset: window.lab.dataset, settings: window.lab.settings }));
  await first.page.reload(); await ready(first.page); await saved(first.page);
  assert.deepEqual(await first.page.evaluate(() => ({ dataset: window.lab.dataset, settings: window.lab.settings })), before);
  assert.equal(first.requests.length, 0);
  results.push('StrictMode root start, validated exact autosave and reload without any account/network call');

  const branch = await first.context.newPage();
  const pointer = await first.page.evaluate(() => sessionStorage.getItem('helix-local-workspace-v1'));
  await branch.addInitScript(pointer => { if (!sessionStorage.getItem('qa-cloned-once')) { sessionStorage.setItem('helix-local-workspace-v1', pointer); sessionStorage.setItem('qa-cloned-once', '1'); } }, pointer);
  await branch.goto(`${origin}/__workspace`); await ready(branch); await saved(branch);
  await edit(branch, 'Independent duplicated tab');
  await first.page.evaluate(() => window.lab.setSettings({ title: 'Original tab preserved' })); await saved(first.page);
  await branch.reload(); await ready(branch); await saved(branch);
  assert.equal(await branch.evaluate(() => window.lab.settings.title), 'Independent duplicated tab');
  const all = await first.page.evaluate(async () => {
    const request = indexedDB.open('helix-local-workspaces-v1', 1);
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = reject; });
    const values = await new Promise((resolve, reject) => { const read = db.transaction('workspaces').objectStore('workspaces').getAll(); read.onsuccess = () => resolve(read.result); read.onerror = reject; });
    db.close(); return values.map(value => value.input.settings.title);
  });
  assert.ok(all.includes('Independent duplicated tab')); assert.ok(all.includes('Original tab preserved'));
  await first.page.reload(); await ready(first.page); await saved(first.page);
  assert.equal(await first.page.evaluate(() => window.lab.settings.title), 'Original tab preserved');
  results.push('Per-document IndexedDB branches preserve independent tab edits');

  const publicClient = await client();
  const publicId = 'f838024b-593d-4555-9b81-599df07eca55';
  const source = { ...before, id: publicId, revision: 4, createdAt: '2026-09-11T10:00:00Z', updatedAt: '2026-09-11T11:00:00Z' };
  await publicClient.context.addCookies([{ name: 'helix_session', value: 'must-not-be-sent', url: origin, httpOnly: true }]);
  await publicClient.page.route('**/api/analyses/**', async route => {
    assert.equal(route.request().headers().cookie, undefined);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ analysis: source, access: { mode: 'legacy-public', canWrite: false } }) });
  });
  await publicClient.page.goto(`${origin}/__workspace?analysis=${publicId}`); await ready(publicClient.page); await saved(publicClient.page);
  assert.equal(await publicClient.page.evaluate(() => window.lab.record.id), publicId);
  await publicClient.page.evaluate(() => window.lab.setSettings({ title: 'Local derivative of public source' })); await saved(publicClient.page);
  assert.equal(new URL(publicClient.page.url()).search, '');
  const calls = publicClient.requests.length;
  await publicClient.page.reload(); await ready(publicClient.page); await saved(publicClient.page);
  assert.equal(await publicClient.page.evaluate(() => window.lab.settings.title), 'Local derivative of public source');
  assert.equal(await publicClient.page.evaluate(() => window.lab.record), undefined);
  assert.equal(publicClient.requests.length, calls, 'Detached draft reload must not reset from the public source');
  results.push('Public source loads with no cookie; edits detach the URL and restore locally without re-fetch');

  const rejected = await client();
  await rejected.page.goto(`${origin}/__workspace`); await ready(rejected.page); await edit(rejected.page, 'Preserve local on private URL');
  await rejected.page.route('**/api/analyses/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ analysis: { ...source, settings: { ...source.settings, title: 'Private must not be cached' } }, access: { mode: 'owner', canWrite: true } }) }));
  await rejected.page.goto(`${origin}/__workspace?analysis=${publicId}`); await ready(rejected.page); await saved(rejected.page);
  assert.equal(await rejected.page.evaluate(() => window.lab.settings.title), 'Preserve local on private URL');
  assert.match(await rejected.page.evaluate(() => window.lab.error), /Only public/);
  results.push('Owner envelope is refused and cannot replace or enter the anonymous workspace');

  const slow = await client(); let release;
  await slow.page.route('**/api/analyses/**', async route => { await new Promise(resolve => { release = resolve; }); await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ analysis: source, access: { mode: 'legacy-public', canWrite: false } }) }).catch(() => {}); });
  await slow.page.goto(`${origin}/__workspace?analysis=${publicId}`);
  await slow.page.waitForFunction(() => window.lab?.busy);
  await edit(slow.page, 'New import wins over stale load'); release?.();
  await slow.page.waitForTimeout(50);
  assert.equal(await slow.page.evaluate(() => window.lab.settings.title), 'New import wins over stale load');
  assert.equal(await slow.page.evaluate(() => { const signal = window.lab.exportSignal; window.lab.openDataset(window.measurements); return signal.aborted; }), true);
  assert.equal(await slow.page.evaluate(() => { const signal = window.lab.exportSignal; window.unmountWorkspace(); return signal.aborted; }), true);
  results.push('New imports supersede pending loads; dataset replacement and unmount abort stale exports');

  const denied = await client();
  await denied.page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Disabled for QA', 'SecurityError'); } }));
  await denied.page.goto(`${origin}/__workspace`); await ready(denied.page);
  assert.equal(await denied.page.evaluate(() => window.lab.storageStatus), 'unavailable');
  await denied.page.evaluate(() => { window.lab.openDataset(window.measurements); window.lab.setSettings({ title: 'Still usable without storage' }); });
  await denied.page.waitForFunction(() => window.lab.storageStatus === 'unavailable');
  assert.equal(await denied.page.evaluate(() => window.lab.settings.title), 'Still usable without storage');
  assert.equal(denied.requests.length, 0);
  results.push('Blocked browser storage stays truthful and keeps local editing usable');

  const noTabStorage = await client();
  await noTabStorage.page.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Disabled for QA', 'SecurityError'); } }));
  await noTabStorage.page.goto(`${origin}/__workspace`); await ready(noTabStorage.page);
  assert.equal(await noTabStorage.page.evaluate(() => window.lab.storageStatus), 'unavailable');
  await noTabStorage.page.evaluate(() => window.lab.setSettings({ title: 'Session-only with no tab pointer' }));
  await noTabStorage.page.waitForFunction(() => window.lab.storageStatus === 'unavailable');
  assert.equal(await noTabStorage.page.evaluate(() => window.lab.settings.title), 'Session-only with no tab pointer');
  results.push('Unavailable per-tab storage cannot claim a safely restorable draft');

  const failedWrite = await client();
  await failedWrite.page.goto(`${origin}/__workspace`); await ready(failedWrite.page); await edit(failedWrite.page, 'Committed before quota failure');
  const oldPointer = await failedWrite.page.evaluate(() => sessionStorage.getItem('helix-local-workspace-v1'));
  await failedWrite.page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'workspaces') throw new DOMException('Synthetic quota rejection', 'QuotaExceededError'); return original.apply(this, args); };
    window.lab.setSettings({ title: 'Must not claim saved' });
  });
  await failedWrite.page.waitForFunction(() => window.lab.storageStatus === 'unavailable');
  assert.equal(await failedWrite.page.evaluate(() => sessionStorage.getItem('helix-local-workspace-v1')), oldPointer);
  await failedWrite.page.reload(); await ready(failedWrite.page); await saved(failedWrite.page);
  assert.equal(await failedWrite.page.evaluate(() => window.lab.settings.title), 'Committed before quota failure');
  results.push('Failed IndexedDB write leaves the committed pointer and previous draft intact');

  const corrupt = await client();
  await corrupt.page.goto(`${origin}/__workspace`); await ready(corrupt.page); await edit(corrupt.page, 'Before corrupted snapshot');
  const corruptKey = await corrupt.page.evaluate(async () => {
    const key = sessionStorage.getItem('helix-local-workspace-v1');
    const request = indexedDB.open('helix-local-workspaces-v1', 1);
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = reject; });
    const transaction = db.transaction('workspaces', 'readwrite'); transaction.objectStore('workspaces').put({ malformed: true }, key);
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = reject; }); db.close(); return key;
  });
  await corrupt.page.reload(); await ready(corrupt.page);
  assert.equal(await corrupt.page.evaluate(() => window.lab.storageStatus), 'unavailable');
  await corrupt.page.waitForTimeout(200);
  assert.equal(await corrupt.page.evaluate(() => sessionStorage.getItem('helix-local-workspace-v1')), corruptKey);
  results.push('Corrupt restored data is rejected without overwriting its recovery pointer with defaults');

  await first.page.evaluate(() => window.lab.setSettings({ title: '' }));
  await first.page.waitForFunction(() => window.lab.storageStatus === 'memory-only');
  await first.page.reload(); await ready(first.page); await saved(first.page);
  assert.equal(await first.page.evaluate(() => window.lab.settings.title), 'Original tab preserved');
  results.push('Invalid transient settings never overwrite the last valid saved draft');

  for (const client of [first, publicClient, rejected, slow, denied, noTabStorage, failedWrite, corrupt]) assert.deepEqual(client.failures, []);
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await server.close(); }
