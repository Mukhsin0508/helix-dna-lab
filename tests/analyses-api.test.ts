import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { JunctionDataset, MeasurementDataset, TrackDataset } from '../shared/analysis.ts';
import { ANALYSIS_BODY_LIMIT } from '../shared/analysis-record.ts';
import { harness, analysisOf, scoreInput as input } from './analysis-test-support.ts';

for (const kind of ['local', 'cloud'] as const) {
  test(`${kind}: junction arcs retain spanning endpoints, missing alleles and metadata through save and update`, async () => {
    const store = await harness(kind);
    try {
      const dataset: JunctionDataset = {
        schemaVersion: 1, id: 'synthetic-junction-api-test', kind: 'junctions', title: 'Synthetic API test only',
        provenance: { sourceUrl: '', sourceLabel: 'Synthetic unit test', assembly: 'GRCh38.p13', model: 'Test only', context: 'No inference performed', mode: 'imported' },
        interval: { chromosome: 'chr9', start: 128226006, end: 128226047, coordinateSystem: '0-based-half-open' },
        variant: 'chr9:128226027:G>A',
        rows: [
          { chromosome: 'chr9', start: 128225900, end: 128226090, strand: '-', track: 'test', reference: 0.12345678901234568, alternate: null },
          { chromosome: 'chr9', start: 128226010, end: 128226034, strand: '-', track: 'test', reference: null, alternate: 4.5 },
        ],
        trackMetadata: [{ chromosome: 'chr9', track: 'test', outputType: 'SPLICE_JUNCTIONS', unit: null, strand: '-', biosampleId: null,
          biosampleName: 'Synthetic biosample', scope: 'biosample_specific', sourceName: 'Original test name', sourceIndex: 0 }],
      };
      const settings = { ...input().settings, chart: 'junctions' as const, modality: 'SPLICE_JUNCTIONS', scorer: '', gene: '', track: '', variant: '', metric: 'score' as const };
      const created = await analysisOf(await store.call('/api/analyses', 'POST', { dataset, settings }), 201);
      assert.deepEqual((await analysisOf(await store.call(`/api/analyses/${created.id}`))).dataset, dataset);
      const path = `/api/analyses/${created.id}`;
      const updatedDataset = structuredClone(dataset); updatedDataset.rows[0].alternate = 0;
      const updated = await analysisOf(await store.call(path, 'PATCH', { dataset: updatedDataset, settings: { ...settings, chart: 'table' }, revision: 0 }));
      assert.equal(updated.revision, 1);
      assert.deepEqual(updated.dataset, updatedDataset);
      for (const invalid of [
        { dataset: { ...dataset, trackMetadata: [] }, settings },
        { dataset: { ...dataset, rows: [...dataset.rows, dataset.rows[0]] }, settings },
        { dataset: { ...dataset, rows: [{ ...dataset.rows[0], reference: null, alternate: null }] }, settings },
        { dataset, settings: { ...settings, metric: 'quantile' } },
        { dataset, settings: { ...settings, chart: 'tracks' } },
      ]) {
        assert.equal((await store.call('/api/analyses', 'POST', invalid)).status, 400);
        assert.equal((await store.call(path, 'PATCH', { ...invalid, revision: 1 })).status, 400);
      }
      assert.deepEqual(await analysisOf(await store.call(path)), updated);
      const specification = await (await store.call('/api/openapi.json')).json() as { components: { schemas: Record<string, unknown> } };
      assert.ok(specification.components.schemas.AnalysisJunctionRow);
      assert.ok(specification.components.schemas.AnalysisJunctionTrackMetadata);
    } finally { await store.close(); }
  });
}

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

for (const kind of ['local', 'cloud'] as const) {
  test(`${kind}: published experimental means remain measurements through save and reload`, async () => {
    const store = await harness(kind);
    try {
      const source = JSON.parse(readFileSync(new URL('../data/experimental/dnm1-table-s4.measurements.json', import.meta.url), 'utf8'));
      const dataset: MeasurementDataset = {
        schemaVersion: 1, id: 'dnm1-measurement-api-check', title: 'DNM1 measured splicing', kind: 'measurements',
        provenance: { sourceUrl: source.sourceUrl, sourceLabel: 'AlphaGenome Atlas · Table S4', assembly: 'GRCh38', model: 'Not applicable',
          context: source.selection, mode: 'published-example' },
        experiment: { assay: source.assay, endpoint: source.measurement, unit: 'fraction', unitLabel: 'Alternative 3-prime splice-site selection rate',
          aggregation: source.aggregation, conditions: ['Five retained cell-line/promoter combinations'],
          replicatePolicy: 'Per-row replicate count and standard error not reported.', sourceLocator: 'Table S4, page 73' },
        rows: source.rows.map((row: { variant: string; gene: string; alt3ssRate: number; alt3ssRateReportedText: string; sourceRow: number }) => ({
          variant: row.variant, gene: row.gene, value: row.alt3ssRate, reportedValue: row.alt3ssRateReportedText,
          replicates: null, standardError: null, sourceRowIndex: row.sourceRow,
        })),
      };
      const settings = { ...input().settings, chart: 'bars' as const, metric: 'score' as const, track: '', gene: '', variant: 'chr9:128226027:G>A' };
      const created = await analysisOf(await store.call('/api/analyses', 'POST', { dataset, settings }), 201);
      const restored = await analysisOf(await store.call(`/api/analyses/${created.id}`));
      assert.deepEqual(restored.dataset, dataset);
      assert.equal(restored.settings.variant, 'chr9:128226027:G>A');
      assert.equal(restored.dataset.kind, 'measurements');
      if (restored.dataset.kind !== 'measurements') throw new Error('Lost measurement kind');
      assert.equal(restored.dataset.rows.find(row => row.variant === 'chr9:128226027:G>A')?.value, 0.94);
      assert.equal(restored.dataset.rows.find(row => row.variant === 'chr9:128225994:G>A')?.value, 0.76);
      assert.ok(restored.dataset.rows.every(row => row.replicates === null && row.standardError === null));
      assert.equal(restored.dataset.provenance.inference, undefined);
      for (const invalidSettings of [{ ...settings, metric: 'quantile' }, { ...settings, chart: 'heatmap' }, { ...settings, chart: 'tracks' }]) {
        assert.equal((await store.call('/api/analyses', 'POST', { dataset, settings: invalidSettings })).status, 400);
        assert.equal((await store.call(`/api/analyses/${created.id}`, 'PATCH', { dataset, settings: invalidSettings, revision: created.revision })).status, 400);
      }
      const specification = await (await store.call('/api/openapi.json')).json() as { components: { schemas: Record<string, unknown> } };
      assert.ok(specification.components.schemas.AnalysisExperiment);
      assert.ok(specification.components.schemas.AnalysisMeasurementRow);
    } finally { await store.close(); }
  });
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

test('local: independent authenticated API connections cannot replace a stale analysis revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-analysis-cas-'));
  const path = join(directory, 'lab.sqlite');
  const first = await harness('local', path);
  const second = await harness('local', path);
  try {
    const initial = await analysisOf(await first.call('/api/analyses', 'POST', input()), 201);
    const target = `/api/analyses/${initial.id}`;
    const stale = await analysisOf(await second.call(target));
    const changed = input('Winning connection');
    changed.settings.title = 'Winning figure';
    const winner = await analysisOf(await first.call(target, 'PATCH', { ...changed, revision: initial.revision }));
    assert.equal(winner.revision, 1);
    assert.deepEqual(await analysisOf(await second.call(target, 'PATCH', { ...input('Losing connection'), revision: stale.revision }), 409), winner);
    assert.deepEqual(await analysisOf(await second.call(target)), winner);
  } finally { await first.close(); await second.close(); await rm(directory, { recursive: true, force: true }); }
});

test('cloud: simultaneous authenticated analysis writers produce one persisted winner and one 409', async () => {
  const api = await harness('cloud');
  try {
    const initial = await analysisOf(await api.call('/api/analyses', 'POST', input()), 201);
    const path = `/api/analyses/${initial.id}`;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    api.db.afterAnalysisRead = async () => {
      if (++arrivals === 2) { api.db.afterAnalysisRead = undefined; release(); }
      await barrier;
    };
    const writes = ['First writer', 'Second writer'].map(title => {
      const changed = input(title);
      changed.settings.title = `${title} figure`;
      return api.call(path, 'PATCH', { revision: 0, ...changed });
    });
    const responses = await Promise.all(writes);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const winner = await analysisOf(responses.find(response => response.status === 200)!);
    assert.equal(winner.revision, 1);
    assert.deepEqual(await analysisOf(responses.find(response => response.status === 409)!, 409), winner);
    assert.deepEqual(await analysisOf(await api.call(path)), winner);
    const stored = api.db.sqlite.prepare('SELECT payload, revision FROM lab_analyses WHERE id=?').get(initial.id)!;
    assert.equal(stored.revision, 1);
    assert.deepEqual(JSON.parse(stored.payload as string), winner);
  } finally { await api.close(); }
});

test('cloud: cross-origin create and PATCH are forbidden and preserve the existing analysis', async () => {
  const api = await harness('cloud');
  try {
    const data = input();
    const headers = { origin: 'https://other.example' };
    assert.equal((await api.call('/api/analyses', 'POST', data, headers)).status, 403);
    const saved = await analysisOf(await api.call('/api/analyses', 'POST', data), 201);
    const path = `/api/analyses/${saved.id}`;
    assert.equal((await api.call(path, 'PATCH', { revision: 0, ...input('Forbidden replacement') }, headers)).status, 403);
    assert.deepEqual(await analysisOf(await api.call(path)), saved);
  } finally { await api.close(); }
});
