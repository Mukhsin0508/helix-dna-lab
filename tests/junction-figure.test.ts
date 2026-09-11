import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { JunctionDataset, JunctionRow } from '../shared/analysis';
import type { FigureSettings } from '../shared/analysis-record';
import JunctionFigure from '../src/components/JunctionFigure';
import { junctionArcGeometry, junctionGroups, junctionIdentity, junctionSharedMaximum, junctionStrokeWidth, selectedJunctionRows } from '../src/junctionUtils';

const row = (overrides: Partial<JunctionRow> = {}): JunctionRow => ({ chromosome: 'chr9', start: 100, end: 500, strand: '+', track: 'Cortex', reference: 2, alternate: 8, ...overrides });
const dataset = (rows = [row()]): JunctionDataset => ({
  schemaVersion: 1, id: 'junction-test', title: 'Supplied junction signals', kind: 'junctions',
  provenance: { sourceUrl: '', sourceLabel: 'Test fixture', assembly: 'GRCh38', model: 'Test only', context: 'Synthetic values for rendering tests only', mode: 'imported' },
  interval: { chromosome: 'chr9', start: 150, end: 300, coordinateSystem: '0-based-half-open' }, variant: 'chr9:201:G>A',
  rows,
  trackMetadata: [...new Set(rows.map(item => item.track))].map(track => ({ chromosome: 'chr9', track, outputType: 'SPLICE_JUNCTIONS', unit: null, strand: null, biosampleId: null, biosampleName: null, scope: 'unspecified' })),
});
const settings: FigureSettings = { chart: 'junctions', title: 'Junction comparison', modality: 'SPLICE_JUNCTIONS', scorer: '', track: '', gene: '', metric: 'score', limit: 12, variant: '' };
const render = (data: JunctionDataset, options = settings, width = 900): string => renderToString(createElement(JunctionFigure, { dataset: data, settings: options, width, svgRef: () => undefined }));

test('junction arc widths use one shared maximum across both alleles without minimum-width inflation', () => {
  const rows = [row(), row({ start: 160, end: 280, reference: null, alternate: 4 })];
  const maximum = junctionSharedMaximum(rows);
  assert.equal(maximum, 8);
  assert.equal(junctionStrokeWidth(2, maximum), 1.5);
  assert.equal(junctionStrokeWidth(8, maximum), 6);
  assert.equal(junctionStrokeWidth(0, maximum), 0);
  assert.equal(junctionStrokeWidth(null, maximum), 0);
  assert.equal(junctionStrokeWidth(0.000001, maximum), 0.00000075);
  const html = render(dataset(rows));
  const widths = [...html.matchAll(/data-signal-arc="true"[^>]*stroke-width="([^"]+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(widths, [1.5, 6, 3]);
});

test('missing signal and numeric zero have distinct marks, exact descriptions, and no fabricated arcs', () => {
  const html = render(dataset([row({ reference: 0, alternate: null })]));
  assert.equal((html.match(/data-zero="true"/g) || []).length, 1);
  assert.equal((html.match(/data-missing="true"/g) || []).length, 1);
  assert.doesNotMatch(html, /data-signal-arc/);
  assert.match(html, /reference: 0 · alternate: not supplied/);
  assert.match(html, /Unit not provided/);
  assert.match(html, /Zero signal is an open circle; not supplied is a cross/);
});

test('spanning junctions retain full endpoint identity and exact viewport continuation geometry', () => {
  const data = dataset();
  assert.equal(selectedJunctionRows(data, settings).length, 1);
  const geometry = junctionArcGeometry(data.rows[0], data.interval, 20, 320, 100, 40);
  assert.deepEqual(geometry.continuations, [
    { side: 'left', x: 20, y: 82.5 },
    { side: 'right', x: 320, y: 60 },
  ]);
  const html = render(data);
  assert.match(html, /chr9:\[100, 500\) · 0-based, half-open/);
  assert.equal((html.match(/data-continuation="left"/g) || []).length, 2);
  assert.equal((html.match(/data-continuation="right"/g) || []).length, 2);
  assert.equal(selectedJunctionRows({ ...data, rows: [row({ start: 1, end: 150 }), row({ start: 300, end: 500 })] }, settings).length, 0, 'Touching a half-open boundary does not overlap');
});

test('display limits apply per track, are declared, and do not truncate selected export rows', () => {
  const data = dataset([row(), row({ start: 170, end: 290 }), row({ track: 'Neuron' }), row({ track: 'Neuron', start: 170, end: 290 })]);
  assert.equal(junctionGroups(data).length, 2);
  const limited = { ...settings, limit: 1 };
  assert.equal(selectedJunctionRows(data, limited).length, 4);
  const html = render(data, limited);
  assert.match(html, /2 of 4 selected junctions displayed, up to 1 per track/);
  assert.equal((html.match(/1 of 2 supplied junctions displayed/g) || []).length, 2);
  const oneTrack = { ...settings, track: JSON.stringify(['chr9', 'Cortex']) };
  assert.equal(selectedJunctionRows(data, oneTrack).length, 2);
  assert.equal(selectedJunctionRows(data, { ...settings, variant: 'chr9:202:G>A' }).length, 0);
});

test('SSR preserves full-precision tooltip text, strand identities, keyboard targets and unique SVG clip IDs', () => {
  const negative = row({ strand: '-', reference: 0.1234567891234567, alternate: 0 });
  assert.notEqual(junctionIdentity(negative), junctionIdentity(row()));
  const data = dataset([negative]);
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  let html: string;
  try { html = render(data, settings, 310); } finally { console.error = original; }
  assert.deepEqual(errors, []);
  assert.match(html!, /viewBox="0 0 310 /);
  assert.match(html!, /<title>chr9:\[100, 500\) · 0-based, half-open · strand - · Cortex · reference: 0\.1234567891234567 · alternate: 0/);
  assert.equal((html!.match(/tabindex="0" role="img"/g) || []).length, 2);
  assert.match(html!, /variant position is 1-based/);
  assert.match(html!, /genomic index 200 \(0-based\)/);
  const both = renderToString(createElement('div', {}, createElement(JunctionFigure, { dataset: data, settings, width: 310, svgRef: () => undefined }), createElement(JunctionFigure, { dataset: data, settings, width: 310, svgRef: () => undefined })));
  const ids = [...both.matchAll(/<clipPath id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
});
