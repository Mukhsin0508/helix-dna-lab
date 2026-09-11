import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { installPasskey, registerInDialog } from './browser-passkey-helper.mjs';
const base = process.env.HELIX_QA_URL || 'http://localhost:4190';
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage(), checks = [], pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
await installPasskey(context, page);
const accountName = `Helix token UI QA ${Date.now()}`;
let registeredAccountId, copiedSecret;
const releaseHeld = [], settledRoutes = [];
const cleanup = { remainingTokensRevoked: 0, activeTokensRemaining: null, signedOut: false };
async function openAccount() {
  await page.getByRole('button', { name: `Account: ${accountName}`, exact: true }).click();
  await page.getByRole('button', { name: 'Account & passkeys', exact: true }).click();
  await page.getByRole('button', { name: 'Create access token', exact: true }).waitFor();
}
async function listTokens() { const response = await context.request.get(`${base}/api/account/tokens`); assert.ok(response.ok(), 'Token list must load for the signed-in account.'); return (await response.json()).tokens; }
async function openCreate(label) {
  await page.getByRole('button', { name: 'Create access token', exact: true }).click();
  await page.getByRole('textbox', { name: 'Token label', exact: true }).fill(label);
}
async function revoke(label) {
  await page.getByRole('button', { name: `Revoke ${label}`, exact: true }).click();
  const response = page.waitForResponse(value => value.request().method() === 'DELETE' && new URL(value.url()).pathname.startsWith('/api/account/tokens/'));
  await page.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
  assert.equal((await response).status(), 204, 'Revocation must finish successfully before checking the active list.');
  await page.getByRole('button', { name: 'Confirm revoke', exact: true }).waitFor({ state: 'hidden' });
}
try {
  await page.goto(base); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await registerInDialog(page, accountName);
  registeredAccountId = (await (await context.request.get(`${base}/api/account`)).json()).account?.id;
  assert.ok(registeredAccountId, 'The disposable account must be verified before token checks.');
  await openAccount();
  await openCreate('QA read token');
  assert.equal(await page.getByRole('combobox', { name: 'Token permission' }).inputValue(), 'read');
  assert.equal(await page.getByRole('combobox', { name: 'Token expiry' }).inputValue(), '30');
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  const secretField = page.getByRole('textbox', { name: 'Access token shown once', exact: true });
  await secretField.waitFor(); const secret = await secretField.inputValue(); copiedSecret = secret;
  assert.ok(secret.startsWith('helix_'), 'Creation must return a real one-time integration token.');
  const first = (await listTokens()).find(item => item.label === 'QA read token');
  assert.deepEqual(first?.scopes, ['analyses:read']);
  assert.ok(Math.abs(Date.parse(first.expiresAt) - Date.parse(first.createdAt) - 30 * 86400000) < 1000, 'Default expiry must be 30 days.');
  assert.ok(!JSON.stringify(await listTokens()).includes(secret), 'Listing must never expose a token secret.');
  await page.getByRole('button', { name: 'Copy token', exact: true }).click();
  assert.ok(await page.evaluate(value => navigator.clipboard.readText().then(text => text === value), secret), 'Copy must copy the shown token.');
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.ok(!storage.includes(secret), 'Token secrets must never be persisted in browser storage.');
  checks.push('Real token creation defaults to read-only/30 days; one-time copy works without storing the secret');
  await page.getByRole('button', { name: 'Close account dialog', exact: true }).click();
  await openAccount(); assert.equal(await secretField.count(), 0);
  await revoke('QA read token');
  assert.ok(!(await listTokens()).some(item => item.id === first.id), 'Revoked token must disappear from the active list.');
  checks.push('Closing the dialog removes the secret; reopening lists metadata only; revocation requires confirmation');
  await openCreate('QA edit token');
  await page.getByRole('combobox', { name: 'Token permission' }).selectOption('write');
  await page.getByRole('combobox', { name: 'Token expiry' }).selectOption('7');
  await page.getByRole('button', { name: 'Create token', exact: true }).click(); await secretField.waitFor();
  const editing = (await listTokens()).find(item => item.label === 'QA edit token');
  assert.deepEqual(editing?.scopes, ['analyses:read', 'analyses:write']);
  await page.getByRole('button', { name: 'Hide access token', exact: true }).click();
  await openCreate('QA delayed close');
  assert.equal(await page.getByRole('combobox', { name: 'Token permission' }).inputValue(), 'read');
  assert.equal(await page.getByRole('combobox', { name: 'Token expiry' }).inputValue(), '30');
  let releaseClose, startedClose, completedClose;
  const closeHeld = new Promise(resolve => { releaseClose = resolve; }), closeStarted = new Promise(resolve => { startedClose = resolve; }), closeCompleted = new Promise(resolve => { completedClose = resolve; });
  releaseHeld.push(releaseClose);
  await page.route('**/api/account/tokens', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    settledRoutes.push(closeCompleted);
    try { const response = await route.fetch(); startedClose(); await closeHeld; await route.fulfill({ response }); } catch { /* Unmounted UI must ignore the delayed response. */ } finally { completedClose(); }
  });
  await page.getByRole('button', { name: 'Create token', exact: true }).click(); await closeStarted;
  await page.getByRole('button', { name: 'Close account dialog', exact: true }).click(); releaseClose();
  await closeCompleted; await page.unroute('**/api/account/tokens'); await openAccount();
  await page.getByRole('button', { name: 'Revoke QA delayed close', exact: true }).waitFor();
  assert.equal(await secretField.count(), 0);
  await revoke('QA delayed close'); await revoke('QA edit token');
  checks.push('Edit permission is explicit per token; delayed creation cannot reveal a secret after dialog unmount');
  await page.setViewportSize({ width: 390, height: 844 });
  await openCreate('QA mobile');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The account token form must fit mobile width.');
  await page.getByRole('combobox', { name: 'Token permission' }).focus(); await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), 'Token controls must remain within the dialog focus trap.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const second = await context.newPage(); await second.goto(base);
  await second.getByRole('button', { name: `Account: ${accountName}`, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close account dialog', exact: true }).click(); await openAccount();
  await openCreate('QA delayed logout');
  let releaseLogout, startedLogout, completedLogout;
  const logoutHeld = new Promise(resolve => { releaseLogout = resolve; }), logoutStarted = new Promise(resolve => { startedLogout = resolve; }), logoutCompleted = new Promise(resolve => { completedLogout = resolve; });
  releaseHeld.push(releaseLogout);
  await page.route('**/api/account/tokens', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    settledRoutes.push(logoutCompleted);
    try { const response = await route.fetch(); startedLogout(); await logoutHeld; await route.fulfill({ response }); } catch { /* Revoked session must not accept a delayed UI response. */ } finally { completedLogout(); }
  });
  await page.getByRole('button', { name: 'Create token', exact: true }).click(); await logoutStarted;
  await second.getByRole('button', { name: `Account: ${accountName}`, exact: true }).click();
  await second.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().waitFor(); releaseLogout();
  await page.waitForTimeout(150);
  assert.equal(await secretField.count(), 0);
  assert.ok(!(await page.locator('body').innerText()).includes('QA delayed logout'), 'Logout must remove token metadata as well as secrets.');
  checks.push('Mobile controls fit and trap focus; cross-tab logout rejects a delayed secret response');
  assert.deepEqual(pageErrors, []);
} finally {
  try {
    for (const release of releaseHeld) release();
    await Promise.allSettled(settledRoutes);
    await page.unrouteAll({ behavior: 'wait' });
    for (const other of context.pages()) if (other !== page) await other.close();
    if (registeredAccountId) {
      const current = (await (await context.request.get(`${base}/api/account`)).json()).account;
      if (!current) {
        await page.goto(base);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
        await page.getByRole('button', { name: `Account: ${accountName}`, exact: true }).waitFor();
      }
      const owner = (await (await context.request.get(`${base}/api/account`)).json()).account;
      assert.ok(owner?.id === registeredAccountId, 'Cleanup must stay within this disposable account.');
      for (const item of await listTokens()) {
        const response = await context.request.delete(`${base}/api/account/tokens/${encodeURIComponent(item.id)}`, { headers: { Origin: new URL(base).origin } });
        assert.equal(response.status(), 204, 'Each remaining disposable token must be revoked.');
        cleanup.remainingTokensRevoked += 1;
      }
      cleanup.activeTokensRemaining = (await listTokens()).length;
      assert.equal(cleanup.activeTokensRemaining, 0, 'Cleanup must leave no active disposable tokens.');
      if (copiedSecret) await page.evaluate(async expected => { if (await navigator.clipboard.readText() === expected) await navigator.clipboard.writeText(''); }, copiedSecret);
      const response = await context.request.post(`${base}/api/account/logout`, { headers: { Origin: new URL(base).origin }, data: {} });
      assert.ok(response.ok(), 'The disposable browser session must be signed out.');
      cleanup.signedOut = true;
    }
  } finally { copiedSecret = undefined; await context.close(); await browser.close(); }
}
console.log(JSON.stringify({ base, checks, pageErrors, cleanup }, null, 2));
