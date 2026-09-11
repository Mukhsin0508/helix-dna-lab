import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { AnalysisStore } from '../server/analyses.ts';
import type { ScoreDataset, TrackDataset } from '../shared/analysis.ts';
import { ANALYSIS_BODY_LIMIT, type AnalysisInput, type AnalysisRecord } from '../shared/analysis-record.ts';

const migration = readFileSync(new URL('../deploy/higgsfield/migrations/0002_helix.sql', import.meta.url), 'utf8');
const origin = 'https://helix-dna-lab.higgsfield.app';

/** Execute the hosted handler's actual SQL against a file-backed SQLite database. */
class SqliteD1 {
  readonly sqlite: DatabaseSync;
  afterAnalysisRead?: () => Promise<void>;

  constructor(path = ':memory:') {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec(migration);
  }

  prepare(sql: string) {
    const statement = (values: SQLInputValue[]) => ({
      bind: (...next: (string | number)[]) => statement(next),
      first: async <T>(): Promise<T | null> => {
        const result = this.sqlite.prepare(sql).get(...values);
        if (sql === 'SELECT payload FROM lab_analyses WHERE id=?') await this.afterAnalysisRead?.();
        return result ? result as T : null;
      },
      run: async () => ({ meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) } }),
      all: async () => ({ results: this.sqlite.prepare(sql).all(...values) }),
    });
    return statement([]);
  }

  close(): void { this.sqlite.close(); }
}

const cloudPath = new URL('../deploy/higgsfield/src/lib/lab.server.ts', import.meta.url).href;
const { createLabHandler }: {
  createLabHandler(db: SqliteD1): (request: Request) => Promise<Response>;
} = await import(cloudPath);

type Call = (
  path: string, method?: 'GET' | 'POST' | 'PATCH', data?: unknown,
  headers?: Record<string, string>, raw?: boolean,
) => Promise<Response>;
interface Harness { call: Call; close(): Promise<void> }

for (const kind of ['local', 'cloud'] as const) {
  test(`${kind}: source-reported track provenance survives saving and retrieval without inventing unknown units`, async () => {
    const store = await harness(kind);
    try {
      const dataset: TrackDataset = {
        schemaVersion: 1, id: 'synthetic-metadata-test', kind: 'tracks', title: 'Synthetic API test only',
        provenance: { sourceUrl: '', sourceLabel: 'Synthetic unit test', assembly: 'GRCh38.p13', model: 'Test only', context: 'Not a model run', mode: 'imported',
          artifact: { filename: 'source-result.json', sha256: 'a'.repeat(64) },
          inference: { variant: 'chr9:128225994:G>A', inputInterval: { chromosome: 'chr9', start: 127701706, end: 128750282, coordinateSystem: '0-based-half-open' },
            displayInterval: { chromosome: 'chr9', start: 128225973, end: 128226014, coordinateSystem: '0-based-half-open' },
            modelRevision: 'test-revision', clientRevision: 'test-client', checkpointRevision: 'test-checkpoint', referenceVersion: 'GRCh38.p13', referenceSha256: null,
            inputSequenceSha256: 'b'.repeat(64), transformations: ['Synthetic test fixture, no inference'] } },
        rows: [{ chromosome: 'chr9', position: 128225973, reference: 0.00000123456789, alternate: 0, track: 'splice-test' }],
        trackMetadata: [{ chromosome: 'chr9', track: 'splice-test', outputType: 'SPLICE_SITES', unit: null, strand: null,
          biosampleId: null, biosampleName: null, scope: 'tissue_agnostic', binSize: 1, sourceName: 'Test', sourceIndex: 0 }],
      };
      const created = await analysisOf(await store.call('/api/analyses', 'POST', { dataset, settings: { ...input().settings, chart: 'tracks', gene: '', track: '' } }), 201);
      const reloaded = await analysisOf(await store.call(`/api/analyses/${created.id}`));
      assert.deepEqual(reloaded.dataset, dataset);
      const specification = await (await store.call('/api/openapi.json')).json() as { components: { schemas: Record<string, { properties?: Record<string, unknown> }> } };
      assert.ok(specification.components.schemas.AnalysisProvenance.properties?.inference);
      assert.ok(specification.components.schemas.AnalysisTrackMetadata.properties?.binSize);
    } finally { await store.close(); }
  });
}

async function harness(kind: 'local' | 'cloud', path = ':memory:'): Promise<Harness> {
  if (kind === 'local') {
    const app = await createApp(path);
    return {
      call: async (url, method = 'GET', data, headers = {}, raw = false) => {
        const response = await app.inject({
          url, method,
          headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
          ...(data === undefined ? {} : { payload: raw ? String(data) : JSON.stringify(data) }),
        });
        return new Response(response.body, { status: response.statusCode, headers: response.headers as Record<string, string> });
      },
      close: () => app.close(),
    };
  }
  const db = new SqliteD1(path);
  const handler = createLabHandler(db);
  return {
    call: (url, method = 'GET', data, headers = {}, raw = false) => handler(new Request(origin + url, {
      method,
      headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(data === undefined ? {} : { body: raw ? String(data) : JSON.stringify(data) }),
    })),
    close: async () => { db.close(); },
  };
}

function input(title = 'Imported T-cell scores'): AnalysisInput & { dataset: ScoreDataset } {
  return {
    dataset: {
      schemaVersion: 1, id: 'imported-tcell-example', title, kind: 'scores',
      provenance: {
        sourceUrl: 'https://www.alphagenomedocs.com/colabs/batch_variant_scoring.html',
        sourceLabel: 'Official published AlphaGenome example', assembly: 'GRCh38',
        model: 'AlphaGenome; exact historical version unavailable', context: 'T-cell', mode: 'imported',
      },
      rows: [{
        variant: 'chr16:636337:G>A', biosample: 'T-cell', modality: 'RNA_SEQ',
        scorer: 'GeneMaskLFCScorer(requested_output=RNA_SEQ)',
        score: 0.08991122245788574, quantile: 0.9998994469642639,
        gene: 'METTL26', track: 'CL:0000084 polyA plus RNA-seq',
      }, {
        variant: 'chr3:58394738:A>T', biosample: 'T-cell', modality: 'ATAC',
        scorer: 'CenterMaskScorer(requested_output=ATAC, width=501, aggregation_type=DIFF_LOG2_SUM)',
        score: -0.003777742385864258, quantile: -0.21573995053768158,
        track: 'CL:0000084 ATAC-seq',
      }],
    },
    settings: {
      chart: 'bars', title: 'Published expression comparison', modality: 'RNA_SEQ',
      scorer: 'GeneMaskLFCScorer(requested_output=RNA_SEQ)',
      track: 'CL:0000084 polyA plus RNA-seq', gene: 'METTL26', metric: 'score', limit: 12, variant: '',
    },
  };
}

async function analysisOf(response: Response, expected = 200): Promise<AnalysisRecord> {
  assert.equal(response.status, expected, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json() as { analysis: AnalysisRecord };
  assert.ok(body.analysis);
  return body.analysis;
}

for (const kind of ['local', 'cloud'] as const) {
  test(`${kind}: analysis dataset, provenance, precise scores and figure settings persist across reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'helix-analysis-'));
    const path = join(directory, 'lab.sqlite');
    let api = await harness(kind, path);
    try {
      const original = input();
      const created = await analysisOf(await api.call('/api/analyses', 'POST', original), 201);
      const other = await analysisOf(await api.call('/api/analyses', 'POST', input('Separate analysis')), 201);
      assert.notEqual(created.id, other.id);
      assert.equal(created.revision, 0);
      assert.deepEqual(created.dataset, original.dataset);
      assert.deepEqual(created.settings, original.settings);
      const replacement = input('Reviewed example');
      replacement.dataset.rows.reverse();
      replacement.settings = { ...replacement.settings, title: 'Chromatin accessibility', modality: 'ATAC',
        scorer: replacement.dataset.rows[0].scorer, track: 'CL:0000084 ATAC-seq', gene: '', metric: 'quantile', limit: 4,
        variant: 'chr3:58394738:A>T' };
      const saved = await analysisOf(await api.call(`/api/analyses/${created.id}`, 'PATCH', { revision: 0, ...replacement }));
      assert.equal(saved.revision, 1);
      assert.equal(saved.id, created.id);
      assert.equal(saved.createdAt, created.createdAt);
      assert.deepEqual(saved.dataset, replacement.dataset);
      assert.deepEqual(saved.settings, replacement.settings);
      await api.close();
      api = await harness(kind, path);
      assert.deepEqual(await analysisOf(await api.call(`/api/analyses/${created.id}`)), saved);
      assert.deepEqual(await analysisOf(await api.call(`/api/analyses/${other.id}`)), other);
      assert.ok(saved.dataset.kind === 'scores');
      assert.equal(saved.dataset.rows[0].score, -0.003777742385864258);
      assert.equal(saved.dataset.rows[1].score, 0.08991122245788574);
      assert.equal(saved.dataset.rows[1].quantile, 0.9998994469642639);
    } finally { await api.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test(`${kind}: stale analysis PATCH returns the winning dataset and settings without overwriting either`, async () => {
    const api = await harness(kind);
    try {
      const original = input();
      const created = await analysisOf(await api.call('/api/analyses', 'POST', original), 201);
      const path = `/api/analyses/${created.id}`;
      const changed = input('Winner dataset');
      changed.settings.title = 'Winner figure';
      const saved = await analysisOf(await api.call(path, 'PATCH', { revision: 0, ...changed }));
      const stale = await api.call(path, 'PATCH', { revision: 0, ...original });
      assert.equal(stale.status, 409);
      assert.deepEqual((await stale.json()).analysis, saved);
      assert.deepEqual(await analysisOf(await api.call(path)), saved);
    } finally { await api.close(); }
  });

  test(`${kind}: invalid bodies, malformed JSON, IDs and revisions cannot change a saved analysis`, async () => {
    const api = await harness(kind);
    try {
      const original = input();
      const created = await analysisOf(await api.call('/api/analyses', 'POST', original), 201);
      const path = `/api/analyses/${created.id}`;
      for (const data of [null, [], {}, { dataset: original.dataset }, { settings: original.settings },
        { ...original, owner: 'unexpected field' },
        { ...original, dataset: { ...original.dataset, rows: [{ ...original.dataset.rows[0], score: null }] } },
        { ...original, settings: { ...original.settings, chart: 'pie' } },
        { ...original, settings: { ...original.settings, limit: 101 } },
      ]) assert.equal((await api.call('/api/analyses', 'POST', data)).status, 400);
      for (const data of [original, { ...original, revision: -1 },
        { ...original, revision: Number.MAX_SAFE_INTEGER + 1 },
        { ...original, revision: 0, settings: { ...original.settings, metric: 'clinical_probability' } },
      ]) assert.equal((await api.call(path, 'PATCH', data)).status, 400);
      assert.equal((await api.call('/api/analyses', 'POST', '{"dataset":', {}, true)).status, 400);
      assert.equal((await api.call(path, 'PATCH', '{"revision":', {}, true)).status, 400);
      assert.equal((await api.call('/api/analyses/not-a-uuid')).status, 400);
      assert.equal((await api.call(`/api/analyses/${crypto.randomUUID()}`)).status, 404);
      assert.deepEqual(await analysisOf(await api.call(path)), created);
    } finally { await api.close(); }
  });

  test(`${kind}: oversized create and PATCH are rejected before replacing saved data`, async () => {
    const api = await harness(kind);
    try {
      const original = input();
      const created = await analysisOf(await api.call('/api/analyses', 'POST', original), 201);
      const oversized = { ...original, padding: 'x'.repeat(ANALYSIS_BODY_LIMIT + 1) };
      for (const [path, method, data] of [
        ['/api/analyses', 'POST', oversized],
        [`/api/analyses/${created.id}`, 'PATCH', { revision: 0, ...oversized }],
      ] as const) {
        const response = await api.call(path, method, data);
        assert.equal(response.status, 413);
        assert.equal((await response.json()).error, 'body_too_large');
      }
      assert.deepEqual(await analysisOf(await api.call(`/api/analyses/${created.id}`)), created);
    } finally { await api.close(); }
  });
}

test('local: independent database connections cannot replace a stale analysis revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-analysis-cas-'));
  const path = join(directory, 'lab.sqlite');
  const first = new AnalysisStore(path);
  const second = new AnalysisStore(path);
  try {
    const initial = first.create(input());
    const stale = second.get(initial.id)!;
    const changed = input('Winning connection');
    changed.settings.title = 'Winning figure';
    const winner = first.update(initial, changed)!;
    assert.equal(winner.revision, 1);
    assert.equal(second.update(stale, input('Losing connection')), undefined);
    assert.deepEqual(second.get(initial.id), winner);
  } finally { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); }
});

test('cloud: simultaneous analysis writers produce one persisted winner and one 409', async () => {
  const db = new SqliteD1();
  try {
    const handler = createLabHandler(db);
    const request = (path: string, method = 'GET', data?: unknown): Request => new Request(origin + path, {
      method, headers: { 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const initial = await analysisOf(await handler(request('/api/analyses', 'POST', input())), 201);
    const path = `/api/analyses/${initial.id}`;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    db.afterAnalysisRead = async () => {
      if (++arrivals === 2) { db.afterAnalysisRead = undefined; release(); }
      await barrier;
    };
    const writes = ['First writer', 'Second writer'].map(title => {
      const changed = input(title);
      changed.settings.title = `${title} figure`;
      return handler(request(path, 'PATCH', { revision: 0, ...changed }));
    });
    const responses = await Promise.all(writes);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const winner = await analysisOf(responses.find(response => response.status === 200)!);
    assert.equal(winner.revision, 1);
    assert.deepEqual((await responses.find(response => response.status === 409)!.json()).analysis, winner);
    assert.deepEqual(await analysisOf(await handler(request(path))), winner);
    const stored = db.sqlite.prepare('SELECT payload, revision FROM lab_analyses WHERE id=?').get(initial.id)!;
    assert.equal(stored.revision, 1);
    assert.deepEqual(JSON.parse(stored.payload as string), winner);
  } finally { db.close(); }
});

test('cloud: cross-origin create and PATCH are forbidden and preserve the existing analysis', async () => {
  const api = await harness('cloud');
  try {
    const data = input();
    const headers = { origin: 'https://other.example' };
    assert.equal((await api.call('/api/analyses', 'POST', data, headers)).status, 403);
    const saved = await analysisOf(await api.call('/api/analyses', 'POST', data, { origin }), 201);
    const path = `/api/analyses/${saved.id}`;
    assert.equal((await api.call(path, 'PATCH', { revision: 0, ...input('Forbidden replacement') }, headers)).status, 403);
    assert.deepEqual(await analysisOf(await api.call(path)), saved);
  } finally { await api.close(); }
});
