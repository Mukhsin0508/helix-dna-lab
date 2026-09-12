import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const base = process.env.HELIX_QA_URL || 'http://127.0.0.1:4191';
const output = process.env.HELIX_QA_OUTPUT || 'test-results/local-workspace';
const source = JSON.parse(await fs.readFile('data/experimental/dnm1-table-s4.measurements.json', 'utf8'));
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage(), errors = [], requests = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
context.on('request', r => { const path = new URL(r.url()).pathname; if (path.startsWith('/api/')) requests.push({ path, method: r.method() }); });
const title = () => page.getByRole('textbox', { name: 'Figure title', exact: true });
const variant = () => page.getByRole('combobox', { name: 'Variant', exact: true });
const saved = () => expect(page.getByText('Saved in this browser', { exact: true })).toBeVisible();
async function download(name) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const next = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return fs.readFile(await (await next).path());
}
try {
  await fs.mkdir(output, { recursive: true }); await page.goto(base);
  await expect(title()).toBeEnabled();
  await expect(page.getByRole('button', { name: /sign in|sign up|create account|save analysis|my analyses/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'DNM1 measurements', exact: true }).click();
  await page.getByRole('combobox', { name: 'Maximum displayed rows' }).selectOption('12');
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const rows = page.locator('.chart-table tbody tr'); await expect(rows).toHaveCount(12);
  for (const item of source.rows) {
    const row = rows.filter({ hasText: item.variant }); await expect(row).toHaveCount(1);
    assert.equal((await row.locator('td').nth(2).textContent()).trim(), item.alt3ssRateReportedText);
  }
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Source & method' })).toContainText('Table S4');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  checks.push('No signup; all 12 real source values and evidence inspection');
  for (let i = 0; i < 4; i++) {
    await variant().selectOption(''); await variant().selectOption('chr9:128226027:G>A');
    await title().fill(`DNM1 · browser iteration ${i}`);
    await expect(variant()).toHaveValue('chr9:128226027:G>A'); await expect(rows).toHaveCount(1);
    await expect(rows.locator('td').nth(2)).toHaveText('0.94');
  }
  await page.getByRole('button', { name: 'Measurements', exact: true }).click(); await saved(); await page.reload();
  await expect(title()).toHaveValue('DNM1 · browser iteration 3'); await expect(variant()).toHaveValue('chr9:128226027:G>A'); await saved();
  checks.push('Rapid editing and exact variant/title restoration after reload');
  const svg = await download('SVG figure'), png = await download('PNG figure'), csv = await download('Selected data CSV'), json = await download('Export JSON');
  assert.match(svg.toString(), /DNM1 · browser iteration 3/); assert.match(svg.toString(), /Table S4/);
  assert.equal(png.readUInt32BE(0), 0x89504e47); assert.match(csv.toString(), /chr9:128226027:G>A/); assert.match(csv.toString(), /0\.94/); assert.doesNotMatch(csv.toString(), /chr9:128225994:G>A/);
  const recipe = JSON.parse(json.toString()); assert.equal(recipe.dataset.rows.length, 12);
  assert.equal(recipe.dataset.rows.find(row => row.variant === 'chr9:128226027:G>A').value, 0.94);
  assert.equal(recipe.settings.variant, 'chr9:128226027:G>A'); assert.equal(recipe.methods.inferencePerformedDuringExport, false);
  await Promise.all([fs.writeFile(`${output}/figure.svg`, svg), fs.writeFile(`${output}/figure.png`, png), fs.writeFile(`${output}/selected.csv`, csv), fs.writeFile(`${output}/analysis.json`, json)]);
  checks.push('Actual SVG/PNG/CSV/JSON downloads retain exact data, selection and source');
  await page.getByRole('button', { name: 'Published T-cell scores', exact: true }).click();
  await page.getByRole('button', { name: 'Open data', exact: true }).click();
  await page.getByRole('textbox', { name: 'Paste analysis data' }).fill(JSON.stringify(recipe));
  await page.getByRole('button', { name: 'Open dataset', exact: true }).click(); await expect(title()).toHaveValue(recipe.settings.title);
  const roundtrip = JSON.parse((await download('Export JSON')).toString()); assert.deepEqual(roundtrip.dataset, recipe.dataset); assert.deepEqual(roundtrip.settings, recipe.settings); await saved();
  checks.push('Exported recipe reimports with identical numerical dataset and settings');
  const second = await context.newPage(); second.on('pageerror', error => errors.push(error.message)); await second.goto(base);
  await expect(second.getByRole('textbox', { name: 'Figure title' })).toBeEnabled();
  await second.getByRole('textbox', { name: 'Figure title' }).fill('Independent second tab');
  await expect(second.getByText('Saved in this browser', { exact: true })).toBeVisible(); await page.reload();
  await expect(title()).toHaveValue(recipe.settings.title); await second.close(); await saved();
  checks.push('Second-tab edits cannot overwrite the first tab on reload');
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true }); await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('svg.plot-svg')).toBeVisible(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Open figure controls', exact: true }).click(); await variant().selectOption('');
  await page.getByRole('button', { name: 'Close figure controls panel', exact: true }).click(); await saved();
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true }); checks.push('Mobile figure and controls without document overflow at 390px');
  assert.deepEqual(requests.filter(r => r.path.startsWith('/api/account') || r.method !== 'GET'), []); assert.deepEqual(errors, []);
  const result = { base, checks, requests, errors, publicWritePerformed: false };
  await fs.writeFile(`${output}/results.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await context.close(); await browser.close(); }
