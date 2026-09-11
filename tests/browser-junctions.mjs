import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

// Synthetic UI contract exercise. Never ship or cite these numbers as scientific results.
const dataset = {
  schemaVersion: 1, kind: 'junctions', id: 'synthetic-browser-junction-qa', title: 'Synthetic QA · not a model prediction',
  provenance: { sourceUrl: '', sourceLabel: 'Synthetic UI verification only', assembly: 'GRCh38', model: 'None · synthetic QA', context: 'Fabricated numbers solely for software testing; not biological evidence.', mode: 'imported' },
  interval: { chromosome: 'chr9', start: 128225927, end: 128226127, coordinateSystem: '0-based-half-open' },
  variant: 'chr9:128226027:G>A',
  trackMetadata: [{ chromosome: 'chr9', track: 'SYNTHETIC QA', outputType: 'SPLICE_JUNCTIONS', unit: null, strand: null, biosampleId: null, biosampleName: null, scope: 'unspecified' }],
  rows: [
    { chromosome: 'chr9', start: 128222860, end: 128226034, strand: '+', track: 'SYNTHETIC QA', reference: 0.25, alternate: 1 },
    { chromosome: 'chr9', start: 128225950, end: 128226070, strand: '-', track: 'SYNTHETIC QA', reference: 0, alternate: null },
    { chromosome: 'chr9', start: 128225965, end: 128226100, strand: '+', track: 'SYNTHETIC QA', reference: null, alternate: 0.12345678901234568 },
  ],
};
const base = process.env.QA_BASE || 'http://127.0.0.1:4191';
// Public checks must leave synthetic data as an unsaved browser draft.
const saveAllowed = new URL(base).hostname === '127.0.0.1' || new URL(base).hostname === 'localhost';
const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const errors = [], checks = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
async function download(label) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: label }).click();
  return fs.readFile(await (await pending).path());
}
try {
  await fs.mkdir('qa-junctions', { recursive: true });
  await page.goto(base);
  await page.getByRole('textbox', { name: 'Figure title' }).waitFor();
  await page.locator('[data-chart="junctions"]').click();
  await page.getByRole('textbox', { name: 'Paste analysis data' }).fill(JSON.stringify(dataset));
  await page.getByRole('button', { name: 'Open dataset' }).click();
  await page.locator('svg.plot-svg').waitFor();
  assert.equal(await page.locator('[data-chart="junctions"]').getAttribute('aria-pressed'), 'true');
  const refWidth = Number(await page.locator('[data-allele="reference"] [data-signal-arc]').first().getAttribute('stroke-width'));
  const altWidth = Number(await page.locator('[data-allele="alternate"] [data-signal-arc]').first().getAttribute('stroke-width'));
  assert.equal(altWidth / refWidth, 4);
  assert.equal(await page.locator('[data-zero]').count(), 1);
  assert.equal(await page.locator('[data-missing]').count(), 2);
  assert.ok(await page.locator('[data-continuation="left"]').count());
  checks.push('Shared REF/ALT scale, zero/missing distinction and spanning endpoint');
  await page.getByRole('textbox', { name: 'Figure title' }).fill('Synthetic verification · RNA junctions');
  if (saveAllowed) {
    await page.getByRole('button', { name: 'Save analysis', exact: true }).click();
    await page.getByText('Analysis saved', { exact: true }).waitFor();
    const id = new URL(page.url()).searchParams.get('analysis'); assert.ok(id);
    const saved = await (await page.request.get(`${base}/api/analyses/${id}`)).json();
    assert.deepEqual(saved.analysis.dataset.rows, dataset.rows);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Figure title"]')?.value === 'Synthetic verification · RNA junctions');
    assert.equal(await page.locator('[data-missing]').count(), 2);
    checks.push('Exact junction endpoints, missing values and chart settings survive save/reload');
  }
  const svg = (await download('Vector figure')).toString();
  assert.match(svg, /128222860/); assert.match(svg, /0\.12345678901234568/); assert.match(svg, /Synthetic UI verification only/);
  assert.match(svg, /null/); assert.match(svg, /shared maximum|Shared scale|shared signal/);
  await fs.writeFile('qa-junctions/export.svg', svg);
  const png = await download('High-resolution figure'); assert.equal(png.readUInt32BE(0), 0x89504e47);
  await fs.writeFile('qa-junctions/export.png', png);
  const csv = (await download('Selected data')).toString();
  assert.match(csv, /128222860/); assert.match(csv, /0\.12345678901234568/);
  const recipe = JSON.parse((await download('Complete analysis')).toString());
  assert.deepEqual(recipe.dataset.rows, dataset.rows); assert.equal(recipe.settings.chart, 'junctions');
  assert.equal(recipe.methods.inferencePerformed, false);
  checks.push('SVG/PNG, exact CSV values and complete JSON recipe export');
  await page.locator('[data-chart="table"]').click();
  assert.equal(await page.locator('.chart-table tbody tr').count(), 3);
  assert.match(await page.locator('.chart-table').innerText(), /not supplied/);
  await page.locator('[data-chart="junctions"]').click();
  await page.screenshot({ path: 'qa-junctions/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => Number(document.querySelector('svg.plot-svg')?.getAttribute('viewBox')?.split(' ')[2]) < 400);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.ok(await page.locator('svg.plot-svg').isVisible());
  await page.screenshot({ path: 'qa-junctions/mobile.png', fullPage: true });
  checks.push('Desktop/mobile rendering with no document overflow');
  assert.deepEqual(errors, []);
  const result = { base, syntheticFixture: true, publicWritePerformed: false, localSaveVerified: saveAllowed, checks, errors };
  await fs.writeFile('qa-junctions/results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
