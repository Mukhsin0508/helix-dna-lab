import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { analysisDatasetSchema, type AnalysisInference, type JunctionDataset } from '../shared/analysis';
import { datasetToCSV, parseDatasetJSON, parseScoreCSV, parseTrackCSV } from '../shared/analysis-import';
import { analysisCreateSchema, analysisPatchSchema, type FigureSettings } from '../shared/analysis-record';
import { analysisSchemas } from '../shared/analysis-openapi';

/** Synthetic validation data only. No source experiment or model inference generated these values. */
function junctions(): JunctionDataset {
  return {
    schemaVersion: 1, id: 'synthetic-junction-contract', title: 'Synthetic junction schema test', kind: 'junctions',
    provenance: { sourceUrl: '', sourceLabel: 'Synthetic unit test', assembly: 'GRCh38.p13', model: 'Test only', context: 'No inference performed', mode: 'imported' },
    interval: { chromosome: 'chr9', start: 128226006, end: 128226047, coordinateSystem: '0-based-half-open' },
    variant: 'chr9:128226027:G>A',
    rows: [
      { chromosome: 'chr9', start: 128225900, end: 128226070, strand: '+', track: 'test-plus', reference: 0.12345678901234568, alternate: null },
      { chromosome: 'chr9', start: 128226010, end: 128226034, strand: '-', track: 'test-minus', reference: null, alternate: 2.125 },
    ],
    trackMetadata: [
      { chromosome: 'chr9', track: 'test-plus', outputType: 'SPLICE_JUNCTIONS', unit: null, strand: '+', biosampleId: 'TEST:1', biosampleName: 'Synthetic biosample', scope: 'biosample_specific', sourceName: 'Original, "test" track', sourceIndex: 0 },
      { chromosome: 'chr9', track: 'test-minus', outputType: 'SPLICE_JUNCTIONS', unit: 'Model-native signal', strand: '-', biosampleId: null, biosampleName: 'Synthetic biosample', scope: 'biosample_specific', sourceIndex: 1 },
    ],
  };
}

function inference(): AnalysisInference {
  return {
    variant: 'chr9:128226027:G>A', inputInterval: { chromosome: 'chr9', start: 127701739, end: 128750315, coordinateSystem: '0-based-half-open' },
    displayInterval: junctions().interval, modelRevision: 'Synthetic test', clientRevision: 'Synthetic test', checkpointRevision: 'Not reported',
    referenceVersion: 'GRCh38.p13', referenceSha256: null, inputSequenceSha256: 'a'.repeat(64), transformations: ['Synthetic test fixture only'],
  };
}

const settings: FigureSettings = { chart: 'junctions', title: 'Synthetic arc test', modality: 'SPLICE_JUNCTIONS', scorer: '', track: '', gene: '', metric: 'score', limit: 12, variant: '' };

test('junction JSON round-trips both strands, unrounded signals, missing alleles and spanning endpoints', () => {
  const dataset = junctions();
  dataset.provenance.artifact = { filename: 'synthetic-source.json', sha256: 'b'.repeat(64) };
  assert.deepEqual(parseDatasetJSON(JSON.stringify(dataset)), dataset);
  dataset.provenance.inference = inference();
  assert.deepEqual(parseDatasetJSON(JSON.stringify(dataset)), dataset);
  assert.ok(dataset.rows[0].start < dataset.interval.start && dataset.rows[0].end > dataset.interval.end);
  assert.equal(dataset.rows[0].alternate, null);
  assert.equal(dataset.rows[1].reference, null);
  delete dataset.variant;
  assert.equal(analysisDatasetSchema.safeParse(dataset).success, true);
});

test('junction endpoints are ascending safe genomic integers on either strand and must overlap the interval', () => {
  for (const changes of [
    { start: -1 }, { start: 1.25 }, { start: true }, { end: Number.MAX_SAFE_INTEGER + 1 },
    { end: 128225900 }, { start: 128226070, end: 128225900 },
    { start: 128225900, end: 128226006 }, { start: 128226047, end: 128226100 },
    { chromosome: 'chr10' }, { strand: '.' }, { strand: null },
  ]) {
    const dataset = junctions();
    assert.equal(analysisDatasetSchema.safeParse({ ...dataset, rows: [{ ...dataset.rows[0], ...changes }, dataset.rows[1]] }).success, false, JSON.stringify(changes));
  }
  const dataset = junctions();
  dataset.rows[0].end = dataset.interval.start + 1;
  dataset.rows[1].start = dataset.interval.end - 1;
  dataset.rows[1].end = dataset.interval.end + 100;
  assert.equal(analysisDatasetSchema.safeParse(dataset).success, true, 'A one-base overlap is enough; no endpoint clipping');
});

test('junction values require a real nonnegative supplied side and never coerce missing into zero', () => {
  const dataset = junctions();
  for (const reference of [NaN, Infinity, -Infinity, true, '0.1', -0.1, undefined, null]) {
    assert.equal(analysisDatasetSchema.safeParse({ ...dataset, rows: [{ ...dataset.rows[0], reference }, dataset.rows[1]] }).success, false);
  }
  dataset.rows[0].reference = 0;
  assert.equal(analysisDatasetSchema.safeParse(dataset).success, true, 'Measured zero remains distinct from null');
  dataset.rows[0].alternate = 50.5;
  assert.equal(analysisDatasetSchema.safeParse(dataset).success, true, 'Signals can exceed one and need not be integer counts');
  assert.equal(analysisDatasetSchema.safeParse({ ...dataset, rows: [{ ...dataset.rows[0], score: 0.1 }, dataset.rows[1]] }).success, false);
});

test('junction identities cannot collide and metadata is exhaustive without orphan or conflicting strands', () => {
  const duplicate = junctions(); duplicate.rows.push({ ...duplicate.rows[0], alternate: 7 });
  assert.throws(() => parseDatasetJSON(JSON.stringify(duplicate)), /Duplicate junction/);
  const missing = junctions(); missing.trackMetadata.pop();
  assert.throws(() => parseDatasetJSON(JSON.stringify(missing)), /requires matching/);
  const orphan = junctions(); orphan.trackMetadata.push({ ...orphan.trackMetadata[0], track: 'unused' });
  assert.throws(() => parseDatasetJSON(JSON.stringify(orphan)), /no matching data rows/);
  const metadataDuplicate = junctions(); metadataDuplicate.trackMetadata.push({ ...metadataDuplicate.trackMetadata[0] });
  assert.throws(() => parseDatasetJSON(JSON.stringify(metadataDuplicate)), /Duplicate junction metadata/);
  const wrongStrand = junctions(); wrongStrand.trackMetadata[0].strand = '-';
  assert.throws(() => parseDatasetJSON(JSON.stringify(wrongStrand)), /strand-specific/);
  for (const strand of ['.', null] as const) {
    const unknown = junctions(); unknown.trackMetadata[0].strand = strand;
    unknown.rows.push({ ...unknown.rows[0], strand: '-' });
    assert.equal(analysisDatasetSchema.safeParse(unknown).success, true, 'Different biological strands remain distinct row identities');
  }
});

test('junction metadata preserves unknown units and scope, without accepting coverage bin fields', () => {
  for (const patch of [
    { scope: 'tissue_agnostic' }, { scope: 'biosample_specific', biosampleId: null, biosampleName: null },
    { outputType: 'RNA_SEQ' }, { binSize: 1 }, { sourceIndex: -1 }, { unit: '' },
  ]) {
    const dataset = junctions();
    assert.equal(analysisDatasetSchema.safeParse({ ...dataset, trackMetadata: [{ ...dataset.trackMetadata[0], ...patch }, dataset.trackMetadata[1]] }).success, false);
  }
  const agnostic = junctions();
  agnostic.trackMetadata[0] = { ...agnostic.trackMetadata[0], scope: 'tissue_agnostic', biosampleId: null, biosampleName: null, strand: null, unit: null };
  assert.deepEqual(parseDatasetJSON(JSON.stringify(agnostic)), agnostic);
});

test('inference provenance binds exact identity and display while preserving full input-contained arcs', () => {
  const dataset = junctions(); dataset.provenance.inference = inference();
  const outsideInput = structuredClone(dataset); outsideInput.rows[0].start = inference().inputInterval.start - 1;
  assert.throws(() => parseDatasetJSON(JSON.stringify(outsideInput)), /model input interval/);
  const differentDisplay = structuredClone(dataset); differentDisplay.interval.start -= 1;
  assert.throws(() => parseDatasetJSON(JSON.stringify(differentDisplay)), /must equal/);
  const wrongVariant = structuredClone(dataset); wrongVariant.variant = 'chr9:128225994:G>A';
  assert.throws(() => parseDatasetJSON(JSON.stringify(wrongVariant)), /exact variant/);
  const differentAssembly = structuredClone(dataset); differentAssembly.provenance.assembly = 'GRCh37';
  assert.throws(() => parseDatasetJSON(JSON.stringify(differentAssembly)), /same genome assembly/);
  const aliases = structuredClone(dataset); aliases.provenance.assembly = 'hg38';
  assert.equal(analysisDatasetSchema.safeParse(aliases).success, true);
  const independent = junctions(); independent.variant = 'chr9:128225994:G>A';
  assert.equal(analysisDatasetSchema.safeParse(independent).success, true, 'A display may be away from an independently supplied variant');
  independent.variant = 'chr10:128226027:G>A';
  assert.throws(() => parseDatasetJSON(JSON.stringify(independent)), /same chromosome/);
});

test('GRCh38 bounds apply to arcs, display and optional variant, and row and payload limits remain intact', () => {
  for (const target of ['row', 'interval', 'variant'] as const) {
    const dataset = junctions();
    if (target === 'row') dataset.rows[0].end = 138394718;
    if (target === 'interval') dataset.interval.end = 138394718;
    if (target === 'variant') dataset.variant = 'chr9:138394718:G>A';
    assert.throws(() => parseDatasetJSON(JSON.stringify(dataset)), /chromosome's length/);
  }
  const dataset = junctions();
  dataset.rows[0].end = 138394717;
  assert.equal(analysisDatasetSchema.safeParse(dataset).success, true);
  dataset.rows = Array.from({ length: 4999 }, (_, index) => ({ ...dataset.rows[0], start: index }));
  dataset.rows.push(junctions().rows[1]);
  assert.equal(parseDatasetJSON(JSON.stringify(dataset)).rows.length, 5000);
  dataset.rows.push({ ...dataset.rows[0], start: 5000 });
  assert.throws(() => parseDatasetJSON(JSON.stringify(dataset)), /5000/);
  assert.throws(() => parseDatasetJSON(`{"tooLarge":"${'🙂'.repeat(524289)}"}`), /2 MB/);
});

test('junction CSV retains exact endpoints, strand, raw values and explicit nulls', () => {
  const dataset = junctions();
  assert.equal(datasetToCSV(dataset), 'chromosome,start,end,strand,track,reference,alternate\r\nchr9,128225900,128226070,+,test-plus,0.12345678901234568,null\r\nchr9,128226010,128226034,-,test-minus,null,2.125\r\n');
  dataset.rows[0].track = 'track, "quoted"\nname'; dataset.trackMetadata[0].track = dataset.rows[0].track;
  assert.ok(datasetToCSV(dataset).includes('"track, ""quoted""\nname"'));
});

test('junction figure settings preserve raw signals and reject incompatible plot modes', () => {
  const dataset = junctions();
  assert.equal(analysisCreateSchema.safeParse({ dataset, settings }).success, true);
  assert.equal(analysisPatchSchema.safeParse({ dataset, settings: { ...settings, chart: 'table' }, revision: 0 }).success, true);
  for (const invalid of [{ ...settings, metric: 'quantile' }, ...['bars', 'heatmap', 'tracks'].map(chart => ({ ...settings, chart }))]) {
    assert.equal(analysisCreateSchema.safeParse({ dataset, settings: invalid }).success, false);
    assert.equal(analysisPatchSchema.safeParse({ dataset, settings: invalid, revision: 0 }).success, false);
  }
  const tracks = parseTrackCSV('chromosome,position,reference,alternate,track\nchr9,128226026,0,1,test', { assembly: 'GRCh38' });
  assert.equal(analysisCreateSchema.safeParse({ dataset: tracks, settings }).success, false);
  assert.equal(analysisCreateSchema.safeParse({ dataset: tracks, settings: { ...settings, chart: 'tracks' } }).success, true);
  const scores = parseScoreCSV('variant,biosample,modality,scorer,score\nchr9:128226027:G>A,test,RNA_SEQ,test,-0.125', { assembly: 'GRCh38' });
  assert.deepEqual(parseDatasetJSON(JSON.stringify(scores)), scores);
  assert.deepEqual(parseDatasetJSON(JSON.stringify(tracks)), tracks);
});

test('OpenAPI and deployed schema mirrors expose the same junction contract', () => {
  assert.ok(analysisSchemas.AnalysisJunctionRow);
  assert.ok(analysisSchemas.AnalysisJunctionTrackMetadata);
  assert.ok(analysisSchemas.FigureSettings.properties.chart.enum.includes('junctions'));
  assert.ok(analysisSchemas.AnalysisDataset.oneOf.some(schema => schema.properties.kind.const === 'junctions'));
  for (const name of ['analysis.ts', 'analysis-import.ts', 'analysis-record.ts', 'analysis-openapi.ts']) {
    assert.equal(readFileSync(new URL(`../shared/${name}`, import.meta.url), 'utf8'), readFileSync(new URL(`../deploy/higgsfield/src/shared/${name}`, import.meta.url), 'utf8'));
  }
});
