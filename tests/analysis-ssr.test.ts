import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import AnalysisFigure from '../src/components/AnalysisFigure';
import { DEFAULT_DATASET, defaultSettings } from '../src/analysisUtils';
import type { AnalysisDataset } from '../shared/analysis';

/** React 19 omits a title with multiple JSX children during SSR, causing hydration to fail. */
function serverTitles(dataset: AnalysisDataset, chart: 'bars' | 'heatmap' | 'tracks'): string[] {
  const html = renderToString(createElement(AnalysisFigure, {
    dataset,
    settings: { ...defaultSettings(dataset), chart },
    svgRef: () => undefined,
    onSelect: () => undefined,
  }));
  const titles = [...html.matchAll(/<title>(.*?)<\/title>/g)].map(match => match[1]);
  assert.ok(titles.length > 0, 'SSR must retain the SVG descriptions');
  assert.ok(titles.every(title => title.length > 0), 'An empty server title would mismatch the client');
  return titles;
}

test('bar and matrix SVG titles retain their complete text during SSR', () => {
  const bars = serverTitles(DEFAULT_DATASET, 'bars');
  assert.equal(bars.length, 4);
  assert.ok(bars.some(title => title.includes('chr16:636337:G&gt;A') && title.includes('score: 0.11435222625732422')));
  const matrix = serverTitles(DEFAULT_DATASET, 'heatmap');
  assert.ok(matrix.some(title => title.includes('T-cell') && title.includes('0.11435222625732422')));
});

test('reference and alternate SVG titles retain coordinates and values during SSR', () => {
  const titles = serverTitles({
    ...DEFAULT_DATASET,
    kind: 'tracks',
    rows: [{ chromosome: 'chr9', position: 128226026, reference: 2, alternate: 3, track: 'Test signal' }],
  }, 'tracks');
  assert.deepEqual(titles, [
    'chr9 · Test signal · position 128226026 (0-based) · reference: 2',
    'chr9 · Test signal · position 128226026 (0-based) · alternate: 3',
  ]);
});
