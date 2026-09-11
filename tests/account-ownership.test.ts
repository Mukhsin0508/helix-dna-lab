import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { newAnalysis, type AnalysisList, type AnalysisRecord } from '../shared/analysis-record.ts';
import { analysisOf, harness, scoreInput, type Method, type TestHeaders } from './analysis-test-support.ts';

async function status(response: Response, expected: number): Promise<Record<string, unknown>> {
  assert.equal(response.status, expected, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json() as Record<string, unknown>;
  assert.equal('analysis' in body, false, 'Rejected non-owner requests must not disclose a dataset or winning revision.');
  return body;
}

for (const kind of ['local', 'cloud'] as const) {
  test(`${kind}: real sessions own private analyses and cross-account reads, writes and conflicts remain undisclosed`, async () => {
    const api = await harness(kind);
    try {
      const account = await api.call('/api/account');
      assert.equal(account.status, 200);
      assert.equal((await account.json()).account.id, api.owner.id);
      await status(await api.as('anonymous', '/api/analyses', 'POST', scoreInput()), 401);
      const initial = await analysisOf(await api.call('/api/analyses', 'POST', scoreInput('Private owner dataset')), 201);
      const path = `/api/analyses/${initial.id}`;
      const updatedInput = scoreInput('Private winning dataset');
      updatedInput.settings.title = 'Private winning title';
      const winner = await analysisOf(await api.call(path, 'PATCH', { ...updatedInput, revision: 0 }));
      for (const actor of ['other', 'anonymous'] as const) {
        const missing = await status(await api.as(actor, `/api/analyses/${crypto.randomUUID()}`), 404);
        assert.deepEqual(await status(await api.as(actor, path), 404), missing);
        for (const method of ['PATCH', 'DELETE'] as const) {
          for (const revision of [0, 1, 999]) {
            const data = method === 'PATCH' ? { ...scoreInput('Forbidden replacement'), revision } : { revision };
            const response = await api.as(actor, path, method, data);
            await status(response, actor === 'anonymous' ? 401 : 404);
          }
        }
      }
      const conflict = await analysisOf(await api.call(path, 'PATCH', { ...scoreInput('Stale owner'), revision: 0 }), 409);
      assert.deepEqual(conflict, winner);
      assert.deepEqual(await analysisOf(await api.call(path)), winner);
      assert.equal(api.db.sqlite.prepare('SELECT owner_id FROM lab_analyses WHERE id=?').get(initial.id)?.owner_id, api.owner.id);
    } finally { await api.close(); }
  });

  test(`${kind}: client owner fields, forged identity headers, session hashes and invalid sessions cannot grant ownership`, async () => {
    const api = await harness(kind);
    try {
      const initial = await analysisOf(await api.call('/api/analyses', 'POST', scoreInput()), 201);
      const path = `/api/analyses/${initial.id}`;
      for (const forged of [{ owner: api.other.id }, { ownerId: api.other.id }, { owner_id: api.other.id },
        { accountId: api.other.id }, { access: { mode: 'owner', canWrite: true } }]) {
        await status(await api.call('/api/analyses', 'POST', { ...scoreInput(), ...forged }), 400);
        await status(await api.call(path, 'PATCH', { ...scoreInput(), revision: 0, ...forged }), 400);
      }
      const forgedHeaders: TestHeaders[] = [
        { 'x-account-id': api.owner.id, 'x-owner-id': api.owner.id },
        { cookie: `helix_session=${api.owner.tokenHash}` },
        { cookie: `helix_session=${api.owner.token}; helix_session=${api.other.token}` },
      ];
      for (const headers of forgedHeaders) {
        await status(await api.as('anonymous', path, 'GET', undefined, headers), 404);
        await status(await api.as('anonymous', '/api/analyses', 'POST', scoreInput(), headers), 401);
      }
      assert.deepEqual(await analysisOf(await api.call(path)), initial);
      api.db.sqlite.prepare('UPDATE lab_auth_sessions SET origin=? WHERE token_hash=?').run('https://another.example', api.owner.tokenHash);
      await status(await api.call(path), 404);
      await status(await api.call('/api/analyses', 'POST', scoreInput()), 401);
      api.db.sqlite.prepare('UPDATE lab_auth_sessions SET origin=?,expires_at=? WHERE token_hash=?').run(api.origin, Date.now() - 1, api.owner.tokenHash);
      await status(await api.call('/api/analyses'), 401);
      await status(await api.call(path, 'DELETE', { revision: 0 }), 401);
      api.db.sqlite.prepare('DELETE FROM lab_auth_sessions WHERE token_hash=?').run(api.other.tokenHash);
      await status(await api.as('other', '/api/analyses', 'POST', scoreInput()), 401);
      assert.equal(api.db.sqlite.prepare('SELECT COUNT(*) AS count FROM lab_analyses').get()?.count, 1);
    } finally { await api.close(); }
  });

  test(`${kind}: authenticated analytical writes require an exact same-origin header`, async () => {
    const api = await harness(kind);
    try {
      const initial = await analysisOf(await api.call('/api/analyses', 'POST', scoreInput()), 201);
      const path = `/api/analyses/${initial.id}`;
      for (const origin of [null, 'null', 'https://unrelated.example', `${api.origin}/`, 'http://127.0.0.1:4999']) {
        const headers = { origin };
        await status(await api.call('/api/analyses', 'POST', scoreInput(), headers), 403);
        await status(await api.call(path, 'PATCH', { ...scoreInput('Rejected'), revision: 0 }, headers), 403);
        await status(await api.call(path, 'DELETE', { revision: 0 }, headers), 403);
      }
      assert.deepEqual(await analysisOf(await api.call(path)), initial);
      assert.equal(api.db.sqlite.prepare('SELECT COUNT(*) AS count FROM lab_analyses').get()?.count, 1);
    } finally { await api.close(); }
  });

  test(`${kind}: account list pagination contains only precise owner summaries, including tied timestamps`, async () => {
    const api = await harness(kind);
    try {
      const records: Record<'owner' | 'other', AnalysisRecord[]> = { owner: [], other: [] };
      for (let index = 0; index < 7; index += 1) {
        for (const actor of ['owner', 'other'] as const) {
          const input = scoreInput(`${actor} dataset ${index}`);
          input.settings.title = `${actor} figure ${index}`;
          const record = await analysisOf(await api.as(actor, '/api/analyses', 'POST', input), 201);
          record.updatedAt = '2026-09-11T00:00:00.000Z';
          api.db.sqlite.prepare('UPDATE lab_analyses SET payload=?,updated_at=? WHERE id=? AND owner_id=?')
            .run(JSON.stringify(record), record.updatedAt, record.id, api[actor].id);
          records[actor].push(record);
        }
      }
      await status(await api.as('anonymous', '/api/analyses'), 401);
      const seen: string[] = [];
      let cursor: string | null = null;
      let firstCursor: string | null = null;
      let pages = 0;
      do {
        assert.ok(++pages <= records.owner.length + 1, 'Pagination did not terminate.');
        const response = await api.call('/api/analyses?limit=2' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
        assert.equal(response.status, 200);
        const page = await response.json() as AnalysisList;
        assert.ok(page.analyses.length <= 2);
        for (const summary of page.analyses) {
          const record = records.owner.find(value => value.id === summary.id);
          assert.ok(record, 'Another account appeared in an owner page.');
          assert.deepEqual(summary, { id: record.id, title: record.settings.title, kind: record.dataset.kind,
            revision: record.revision, updatedAt: record.updatedAt });
          assert.equal(seen.includes(summary.id), false, 'A cursor repeated a record.');
          seen.push(summary.id);
        }
        cursor = page.nextCursor;
        firstCursor ??= cursor;
        assert.ok(seen.length <= records.owner.length, 'Pagination did not advance.');
      } while (cursor);
      assert.deepEqual(seen, records.owner.map(value => value.id).sort().reverse());
      assert.ok(firstCursor);
      const otherPage = await (await api.as('other', `/api/analyses?limit=50&cursor=${encodeURIComponent(firstCursor)}`)).json() as AnalysisList;
      assert.ok(otherPage.analyses.every(value => records.other.some(record => record.id === value.id)));
      for (const query of ['limit=0', 'limit=-1', 'limit=1.5', 'limit=101', 'limit=invalid', 'cursor=not-json', 'cursor=%3D%3D']) {
        await status(await api.call(`/api/analyses?${query}`), 400);
      }
    } finally { await api.close(); }
  });

  test(`${kind}: DELETE validates revision strictly and returns a private owner conflict before a successful removal`, async () => {
    const api = await harness(kind);
    try {
      const initial = await analysisOf(await api.call('/api/analyses', 'POST', scoreInput()), 201);
      const path = `/api/analyses/${initial.id}`;
      for (const body of [null, [], {}, { revision: -1 }, { revision: 0.5 }, { revision: true },
        { revision: '0' }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { revision: 0, owner: api.owner.id }]) {
        await status(await api.call(path, 'DELETE', body), 400);
      }
      await status(await api.call(path, 'DELETE', '{"revision":', {}, true), 400);
      const winner = await analysisOf(await api.call(path, 'PATCH', { ...scoreInput('Retained winner'), revision: 0 }));
      assert.deepEqual(await analysisOf(await api.call(path, 'DELETE', { revision: 0 }), 409), winner);
      const removed = await api.call(path, 'DELETE', { revision: winner.revision });
      assert.equal(removed.status, 204);
      assert.equal(await removed.text(), '');
      for (const actor of ['owner', 'other', 'anonymous'] as const) await status(await api.as(actor, path), 404);
      await status(await api.call(path, 'DELETE', { revision: winner.revision }), 404);
      assert.equal(api.db.sqlite.prepare('SELECT COUNT(*) AS count FROM lab_analyses').get()?.count, 0);
    } finally { await api.close(); }
  });

  test(`${kind}: additive ownership migration keeps legacy source bytes public and read-only while a copy belongs only to its saver`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'helix-legacy-ownership-'));
    const path = join(directory, 'lab.sqlite');
    const legacy = { ...newAnalysis(scoreInput('Legacy published example'), crypto.randomUUID()), revision: 7 };
    const originalBytes = JSON.stringify(legacy, null, 2) + '\n';
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE lab_analyses (id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL)');
    old.prepare('INSERT INTO lab_analyses VALUES (?,?,?,?)').run(legacy.id, originalBytes, legacy.revision, legacy.updatedAt);
    old.close();
    let api = await harness(kind, path);
    try {
      const target = `/api/analyses/${legacy.id}`;
      for (const actor of ['owner', 'other', 'anonymous'] as const) {
        assert.deepEqual(await analysisOf(await api.as(actor, target), 200, 'legacy-public'), legacy);
        const expected = actor === 'anonymous' ? 401 : 403;
        await status(await api.as(actor, target, 'PATCH', { ...scoreInput('Do not replace legacy'), revision: legacy.revision }), expected);
        await status(await api.as(actor, target, 'DELETE', { revision: legacy.revision }), expected);
      }
      const copied = await analysisOf(await api.call('/api/analyses', 'POST', { dataset: legacy.dataset, settings: legacy.settings }), 201);
      assert.notEqual(copied.id, legacy.id);
      assert.equal(copied.revision, 0);
      assert.deepEqual(copied.dataset, legacy.dataset);
      assert.deepEqual(copied.settings, legacy.settings);
      assert.ok(copied.dataset.kind === 'scores');
      assert.equal(copied.dataset.rows[0].score, 0.08991122245788574);
      assert.equal(copied.dataset.rows[1].score, -0.003777742385864258);
      assert.equal(copied.dataset.rows[0].quantile, 0.9998994469642639);
      await status(await api.as('other', `/api/analyses/${copied.id}`), 404);
      await status(await api.as('anonymous', `/api/analyses/${copied.id}`), 404);
      await analysisOf(await api.call(`/api/analyses/${copied.id}`, 'PATCH', { ...scoreInput('Private copied revision'), revision: 0 }));
      const list = await (await api.call('/api/analyses')).json() as AnalysisList;
      assert.deepEqual(list.analyses.map(value => value.id), [copied.id]);
      assert.deepEqual(api.db.sqlite.prepare('SELECT payload,revision,owner_id FROM lab_analyses WHERE id=?').get(legacy.id),
        Object.assign(Object.create(null), { payload: originalBytes, revision: 7, owner_id: null }));
      await api.close();
      api = await harness(kind, path);
      assert.deepEqual(await analysisOf(await api.as('anonymous', target), 200, 'legacy-public'), legacy);
      assert.equal(api.db.sqlite.prepare('SELECT payload FROM lab_analyses WHERE id=?').get(legacy.id)?.payload, originalBytes);
    } finally { await api.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('cloud: owner change after read fences both mutation and conflict reload to the caller account', async () => {
  for (const method of ['PATCH', 'DELETE'] as const satisfies readonly Method[]) {
    const api = await harness('cloud');
    try {
      const initial = await analysisOf(await api.call('/api/analyses', 'POST', scoreInput('Original owner')), 201);
      const target = `/api/analyses/${initial.id}`;
      api.db.afterAnalysisRead = async () => {
        api.db.afterAnalysisRead = undefined;
        api.db.sqlite.prepare('UPDATE lab_analyses SET owner_id=? WHERE id=?').run(api.other.id, initial.id);
      };
      const body = method === 'PATCH' ? { ...scoreInput('Must not save after losing ownership'), revision: 0 } : { revision: 0 };
      await status(await api.call(target, method, body), 404);
      assert.deepEqual(await analysisOf(await api.as('other', target)), initial);
      assert.equal(api.db.sqlite.prepare('SELECT owner_id FROM lab_analyses WHERE id=?').get(initial.id)?.owner_id, api.other.id);
    } finally { await api.close(); }
  }
});
