/** Real browser-generated credentials, confined to the disposable QA browser. */
export async function installPasskey(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { cdp, authenticatorId };
}
export async function registerInDialog(page, name = 'Helix figure QA') {
  const dialog = page.getByRole('dialog', { name: 'Sign in', exact: true });
  await dialog.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Display name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create account with passkey', exact: true }).click();
  await page.getByRole('button', { name: `Account: ${name}`, exact: true }).waitFor();
  await page.getByRole('dialog', { name: 'Create account', exact: true }).waitFor({ state: 'hidden' });
}
