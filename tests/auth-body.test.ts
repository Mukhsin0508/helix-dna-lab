import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountService } from '../shared/auth.server.ts';
import { createAuthDatabase } from '../server/auth-database.ts';
import { harness, type TestHeaders } from './analysis-test-support.ts';

const logout = '/api/account/logout';
for (const kind of ['local', 'cloud'] as const) {
  test(`${kind}: invalid logout bodies return sanitized client errors and preserve the session until valid logout`, async () => {
    const api = await harness(kind);
    try {
      const marker = 'PRIVATE_BODY_MARKER';
      const cases: Array<{ text: string; headers: TestHeaders; status: number }> = [
        { text: `{"${marker}":`, headers: {}, status: 400 },
        { text: '', headers: {}, status: 400 },
        { text: '   ', headers: {}, status: 400 },
        { text: marker, headers: { 'content-type': 'application/octet-stream' }, status: 415 },
        { text: JSON.stringify({ payload: marker + 'x'.repeat(17 * 1024) }), headers: {}, status: 413 },
        { text: JSON.stringify({ payload: marker + 'x'.repeat(65 * 1024) }), headers: {}, status: 413 },
      ];
      for (const input of cases) {
        const response = await api.call(logout, 'POST', input.text, input.headers, true);
        assert.equal(response.status, input.status, await response.clone().text());
        const value = await response.text();
        assert.equal(value.includes(marker), false, 'Body-parser failures must not echo supplied data.');
        assert.equal(value.includes(api.owner.token), false);
        assert.equal(value.includes('stack'), false);
        const account = await api.call('/api/account');
        assert.equal((await account.json()).account.id, api.owner.id, 'An invalid body must not partially log out.');
      }
      const valid = await api.call(logout, 'POST', {});
      assert.equal(valid.status, 200);
      assert.deepEqual(await valid.json(), { account: null });
      assert.deepEqual(await (await api.call('/api/account')).json(), { account: null });
      assert.equal(api.db.sqlite.prepare('SELECT COUNT(*) AS n FROM lab_auth_sessions WHERE token_hash=?').get(api.owner.tokenHash)?.n, 0);
      const missing = await api.as('other', logout, 'POST');
      assert.equal(missing.status, 200, 'A genuinely absent body is the existing empty-object logout action.');
      assert.deepEqual(await (await api.as('other', '/api/account')).json(), { account: null });
    } finally { await api.close(); }
  });
}

test('a direct Request.json reader rejects an empty body as 400 instead of an internal account error', async () => {
  const db = createAuthDatabase(':memory:');
  const origin = 'https://helix.example';
  const accounts = createAccountService(db, { origins: [origin] });
  try {
    const request = new Request(origin + logout, { method: 'POST', headers: { origin, 'content-type': 'application/json' } });
    const result = await accounts.handle(request, req => req.json());
    assert.equal(result!.status, 400);
    assert.deepEqual(await result!.json(), { error: 'invalid_request', message: 'Use a valid JSON account request.' });
    const valid = await accounts.handle(new Request(origin + logout, { method: 'POST', headers: { origin }, body: '{}' }), req => req.json());
    assert.equal(valid!.status, 200);
  } finally { db.close(); }
});
