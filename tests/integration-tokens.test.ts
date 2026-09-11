import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createAuthDatabase } from '../server/auth-database.ts';
import { AUTH_SCHEMA_STATEMENTS, type AuthDatabase, type AuthStatement } from '../shared/auth-database.ts';
import { AccountRequestError, createAccountService } from '../shared/auth.server.ts';
import { createIntegrationTokenService } from '../shared/integration-tokens.server.ts';
import type { IntegrationTokenCreated, IntegrationTokenSummary } from '../shared/integration-tokens.ts';
import { ORIGINS, SqliteD1, harness, scoreInput, analysisOf } from './analysis-test-support.ts';

const listPath = '/api/account/tokens';
const identityPath = '/api/integrations/identity';
const hash = (value: string): string => createHash('sha256').update(value).digest('base64url');
type Actor = 'owner' | 'other' | 'anonymous';
type Overrides = Record<string, string | null>;

async function setup(kind: 'local' | 'cloud') {
  const db = kind === 'local' ? createAuthDatabase(':memory:') : new SqliteD1();
  for (const sql of AUTH_SCHEMA_STATEMENTS) await db.prepare(sql).run();
  const origin = ORIGINS[kind];
  const otherOrigin = kind === 'local' ? 'http://localhost:4191' : 'https://another-approved.example';
  const accounts = createAccountService(db, { origins: [origin, otherOrigin] });
  const identities = {} as Record<'owner' | 'other', { id: string; secret: string }>;
  for (const actor of ['owner', 'other'] as const) {
    const id = crypto.randomUUID(), secret = randomBytes(32).toString('base64url'), now = Date.now();
    await db.prepare('INSERT INTO lab_accounts (id,display_name,user_handle,created_at) VALUES (?,?,?,?)')
      .bind(id, `Test ${actor}`, randomBytes(32).toString('base64url'), now).run();
    await db.prepare('INSERT INTO lab_auth_sessions (token_hash,account_id,origin,created_at,expires_at) VALUES (?,?,?,?,?)')
      .bind(hash(secret), id, origin, now, now + 3_600_000).run();
    identities[actor] = { id, secret };
  }
  const tokens = createIntegrationTokenService(db, accounts);
  function request(path: string, method = 'GET', actor: Actor = 'owner', headers: Overrides = {}, destination: string = origin): Request {
    const values = new Headers({ origin: destination });
    if (actor !== 'anonymous') values.set('cookie', `helix_session=${identities[actor].secret}`);
    for (const [name, value] of Object.entries(headers)) value === null ? values.delete(name) : values.set(name, value);
    return new Request(destination + path, { method, headers: values });
  }
  async function call(path: string, method = 'GET', body?: unknown, actor: Actor = 'owner', headers: Overrides = {}, destination: string = origin): Promise<Response> {
    const result = await tokens.handle(request(path, method, actor, headers, destination), async () => body);
    assert.ok(result, `Handler should recognize ${path}`);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    return result;
  }
  async function create(access: 'read' | 'write' = 'read', actor: 'owner' | 'other' = 'owner'): Promise<IntegrationTokenCreated> {
    const response = await call(listPath, 'POST', { label: 'AllMCP', access, expiresInDays: 30 }, actor);
    assert.equal(response.status, 201, await response.clone().text());
    return response.json() as Promise<IntegrationTokenCreated>;
  }
  return { db, origin, otherOrigin, accounts, tokens, identities, request, call, create };
}

async function expectAuthorizationFailure(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(promise, error => error instanceof AccountRequestError && error.statusCode === status && error.code === code);
}

/** Pause one statement around actual SQLite execution; no authentication or token verifier is mocked. */
function beforeRun(db: AuthDatabase, pattern: RegExp, callback: () => Promise<void>): AuthDatabase {
  let called = false;
  function wrap(statement: AuthStatement, sql: string): AuthStatement {
    return {
      bind: (...values) => wrap(statement.bind(...values), sql),
      first: () => statement.first(), all: () => statement.all(),
      run: async () => { if (!called && pattern.test(sql)) { called = true; await callback(); } return statement.run(); },
    };
  }
  return { prepare: sql => wrap(db.prepare(sql), sql), batch: statements => db.batch(statements) };
}

for (const kind of ['local', 'cloud'] as const) {
  test(`${kind}: integration secret is shown once, stored hashed and scoped to its owner`, async () => {
    const api = await setup(kind);
    try {
      const start = Date.now();
      const created = await api.create();
      assert.match(created.token, /^helix_[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(created.details.scopes, ['analyses:read']);
      assert.equal(created.details.label, 'AllMCP');
      assert.equal(created.details.lastUsedAt, null);
      assert.equal(Date.parse(created.details.expiresAt) - Date.parse(created.details.createdAt), 30 * 86_400_000);
      assert.ok(Date.parse(created.details.createdAt) >= start);
      const stored = await api.db.prepare('SELECT * FROM lab_integration_tokens WHERE id=?').bind(created.details.id).first<Record<string, unknown>>();
      assert.ok(stored);
      assert.equal(stored.account_id, api.identities.owner.id);
      assert.equal(stored.origin, api.origin);
      assert.equal(stored.token_hash, hash(created.token));
      assert.equal(JSON.stringify(stored).includes(created.token), false);
      const listed = await api.call(listPath);
      assert.deepEqual(await listed.json(), { tokens: [created.details] });
      const another = await api.create('write', 'other');
      assert.deepEqual(another.details.scopes, ['analyses:read', 'analyses:write']);
      const otherList = await api.call(listPath, 'GET', undefined, 'other');
      assert.deepEqual(await otherList.json(), { tokens: [another.details] });
      const invalidated = await api.call(`${listPath}/${created.details.id}`, 'DELETE', undefined, 'other');
      assert.equal(invalidated.status, 404);
      const absent = await api.call(`${listPath}/${crypto.randomUUID()}`, 'DELETE', undefined, 'other');
      assert.deepEqual(await invalidated.json(), await absent.json());
    } finally { api.db.close(); }
  });

  test(`${kind}: bearer identity ignores cookies; read cannot write and use timestamps are recorded`, async () => {
    const api = await setup(kind);
    try {
      const created = await api.create('read');
      const headers = { authorization: `Bearer ${created.token}` };
      const identity = await api.call(identityPath, 'GET', undefined, 'other', headers);
      assert.equal(identity.status, 200);
      assert.deepEqual(await identity.json(), { account: { id: api.identities.owner.id, displayName: 'Test owner' }, scopes: ['analyses:read'] });
      const list = await (await api.call(listPath)).json() as { tokens: IntegrationTokenSummary[] };
      assert.ok(list.tokens[0].lastUsedAt);
      assert.ok(Date.parse(list.tokens[0].lastUsedAt!) >= Date.parse(created.details.createdAt) - 1);
      await expectAuthorizationFailure(api.tokens.authorize(api.request('/api/analyses', 'POST', 'other', headers), 'analyses:write'), 403, 'insufficient_scope');
      const write = await api.create('write');
      const authorization = await api.tokens.authorize(api.request('/api/analyses', 'POST', 'anonymous', { authorization: `Bearer ${write.token}`, origin: null }), 'analyses:write');
      assert.deepEqual(authorization, { account: { id: api.identities.owner.id, displayName: 'Test owner' }, scopes: ['analyses:read', 'analyses:write'] });
      assert.equal((await api.call(identityPath, 'GET', undefined, 'owner')).status, 401, 'A cookie cannot authenticate the integration identity endpoint.');
    } finally { api.db.close(); }
  });

  test(`${kind}: malformed, revoked, expired and wrong-audience bearers cannot fall back to cookies`, async () => {
    const api = await setup(kind);
    try {
      const created = await api.create('write');
      const invalid = [created.token, `Basic ${created.token}`, 'Bearer ', `Bearer ${hash(created.token)}`, `Bearer ${created.token}, Bearer ${created.token}`, `Bearer ${created.token}extra`, `Bearer helix_${'A'.repeat(43)}`];
      for (const value of invalid) {
        const response = await api.call(identityPath, 'GET', undefined, 'owner', { authorization: value });
        assert.equal(response.status, 401, value);
        assert.equal((await response.text()).includes(created.token), false);
      }
      assert.equal((await api.call(`${identityPath}?token=${created.token}`, 'GET', undefined, 'owner')).status, 401);
      assert.equal((await api.call(identityPath, 'GET', undefined, 'owner', { authorization: `Bearer ${created.token}` }, api.otherOrigin)).status, 401);
      assert.equal((await api.call(identityPath, 'GET', undefined, 'anonymous', { authorization: `Bearer ${created.token}` }, 'https://unapproved.example')).status, 403);
      for (const origin of ['null', '', 'https://unapproved.example', api.otherOrigin]) {
        assert.equal((await api.call(identityPath, 'GET', undefined, 'anonymous', { authorization: `Bearer ${created.token}`, origin })).status, 403);
      }
      const expired = await api.create();
      await api.db.prepare('UPDATE lab_integration_tokens SET created_at=?,expires_at=? WHERE id=?')
        .bind(Date.now() - 2000, Date.now() - 1000, expired.details.id).run();
      assert.equal((await api.call(identityPath, 'GET', undefined, 'owner', { authorization: `Bearer ${expired.token}` })).status, 401);
      assert.equal((await api.call(`${listPath}/${created.details.id}`, 'DELETE')).status, 204);
      assert.equal((await api.call(identityPath, 'GET', undefined, 'owner', { authorization: `Bearer ${created.token}` })).status, 401);
      assert.deepEqual(await (await api.call(listPath)).json(), { tokens: [] });
    } finally { api.db.close(); }
  });

  test(`${kind}: token management is cookie-only and mutating requests require the exact approved origin`, async () => {
    const api = await setup(kind);
    try {
      const created = await api.create();
      for (const path of [listPath, `${listPath}/${created.details.id}`]) {
        const method = path === listPath ? 'POST' : 'DELETE';
        for (const origin of [null, 'null', api.otherOrigin, `${api.origin}/`, 'https://unapproved.example']) {
          assert.equal((await api.call(path, method, { label: 'Denied' }, 'owner', { origin })).status, 403);
        }
      }
      for (const authorization of ['', `Bearer ${created.token}`, 'invalid']) {
        for (const method of ['GET', 'POST']) assert.equal((await api.call(listPath, method, { label: 'Denied' }, 'owner', { authorization })).status, 403);
        assert.equal((await api.call(`${listPath}/${created.details.id}`, 'DELETE', undefined, 'owner', { authorization })).status, 403);
      }
      for (const method of ['GET', 'POST']) assert.equal((await api.call(listPath, method, { label: 'Denied' }, 'anonymous')).status, 401);
      for (const cookie of [`helix_session=${api.identities.owner.secret}; helix_session=${api.identities.other.secret}`, `helix_session=${hash(api.identities.owner.secret)}`]) {
        assert.equal((await api.call(listPath, 'POST', { label: 'Denied' }, 'anonymous', { cookie })).status, 401);
      }
      assert.equal((await api.call(listPath, 'GET', undefined, 'owner', { origin: null })).status, 200, 'Same-origin browser GETs need not send Origin.');
      assert.equal((await api.call(listPath, 'POST', { label: 'Denied' }, 'owner', {}, 'https://unapproved.example')).status, 403);
    } finally { api.db.close(); }
  });

  test(`${kind}: strict bounded token input accepts only supported expiry/access without client identity fields`, async () => {
    const api = await setup(kind);
    try {
      for (const input of [null, {}, [], { label: '' }, { label: ' ' }, { label: 'x'.repeat(81) }, { label: 'bad\nlabel' },
        { label: 'x', access: 'admin' }, { label: 'x', expiresInDays: '30' }, { label: 'x', expiresInDays: true },
        { label: 'x', expiresInDays: 1 }, { label: 'x', expiresInDays: 365 }, { label: 'x', ownerId: api.identities.other.id },
        { label: 'x', scopes: ['analyses:write'] }, { label: 'x', token: 'client-supplied' }]) {
        const response = await api.call(listPath, 'POST', input);
        assert.equal(response.status, 400, JSON.stringify(input));
      }
      assert.equal((await api.call(listPath, 'POST', { label: 'x'.repeat(3000) })).status, 413);
      for (const days of [7, 30, 90]) {
        const response = await api.call(listPath, 'POST', { label: '  AllMCP  ', expiresInDays: days });
        assert.equal(response.status, 201);
        const value = await response.json() as IntegrationTokenCreated;
        assert.equal(value.details.label, 'AllMCP');
        assert.deepEqual(value.details.scopes, ['analyses:read']);
        assert.equal(Date.parse(value.details.expiresAt) - Date.parse(value.details.createdAt), days * 86_400_000);
      }
      const defaults = await api.call(listPath, 'POST', { label: 'Defaults' });
      assert.equal(defaults.status, 201);
      const details = (await defaults.json() as IntegrationTokenCreated).details;
      assert.equal(Date.parse(details.expiresAt) - Date.parse(details.createdAt), 30 * 86_400_000);
      assert.equal((await api.call(`${listPath}/not-an-id`, 'DELETE')).status, 400);
      assert.equal((await api.call(identityPath, 'POST')).status, 405);
      assert.equal((await api.call(listPath, 'PATCH')).status, 405);
      assert.equal(await api.tokens.handle(api.request('/api/analyses'), async () => ({})), undefined);
    } finally { api.db.close(); }
  });

  test(`${kind}: concurrent creation cannot exceed 20 active tokens; revocation and expiry release slots`, async () => {
    const api = await setup(kind);
    try {
      const issued: IntegrationTokenCreated[] = [];
      for (let index = 0; index < 19; index += 1) issued.push(await api.create());
      const responses = await Promise.all([api.call(listPath, 'POST', { label: 'Race A' }), api.call(listPath, 'POST', { label: 'Race B' })]);
      assert.deepEqual(responses.map(value => value.status).sort(), [201, 429]);
      const listed = await (await api.call(listPath)).json() as { tokens: IntegrationTokenSummary[] };
      assert.equal(listed.tokens.length, 20);
      assert.equal((await api.call(listPath, 'POST', { label: 'Over limit' })).status, 429);
      assert.equal((await api.call(`${listPath}/${issued[0].details.id}`, 'DELETE')).status, 204);
      await api.create();
      await api.db.prepare('UPDATE lab_integration_tokens SET created_at=?,expires_at=? WHERE id=?')
        .bind(Date.now() - 2000, Date.now() - 1000, issued[1].details.id).run();
      await api.create();
      assert.equal(((await (await api.call(listPath)).json()) as { tokens: unknown[] }).tokens.length, 20);
      await api.create('read', 'other');
    } finally { api.db.close(); }
  });

  test(`${kind}: logout after cookie authentication but before issuance leaves no integration credential`, async () => {
    const api = await setup(kind);
    try {
      let logoutStatus = 0;
      const delayed = beforeRun(api.db, /INSERT INTO lab_integration_tokens/, async () => {
        const response = await api.accounts.handle(api.request('/api/account/logout', 'POST'), async () => ({}));
        logoutStatus = response!.status;
      });
      const service = createIntegrationTokenService(delayed, api.accounts);
      const response = await service.handle(api.request(listPath, 'POST'), async () => ({ label: 'Must not issue' }));
      assert.equal(logoutStatus, 200);
      assert.equal(response!.status, 401);
      const row = await api.db.prepare('SELECT COUNT(*) AS count FROM lab_integration_tokens').first<{ count: number }>();
      assert.equal(row!.count, 0);
      assert.equal((await response!.text()).includes('helix_'), false);
    } finally { api.db.close(); }
  });

  test(`${kind}: session expiry at insert and token revocation during authorization are checked at use time`, async () => {
    const api = await setup(kind);
    try {
      const issued = await api.create();
      const expiredSession = beforeRun(api.db, /INSERT INTO lab_integration_tokens/, async () => {
        await api.db.prepare('UPDATE lab_auth_sessions SET expires_at=? WHERE token_hash=?')
          .bind(Date.now() - 1, hash(api.identities.owner.secret)).run();
      });
      const service = createIntegrationTokenService(expiredSession, api.accounts);
      const response = await service.handle(api.request(listPath, 'POST'), async () => ({ label: 'Expired session' }));
      assert.equal(response!.status, 401);
      const revokeDuringUse = beforeRun(api.db, /UPDATE lab_integration_tokens SET last_used_at/, async () => {
        await api.db.prepare('DELETE FROM lab_integration_tokens WHERE id=?').bind(issued.details.id).run();
      });
      const verifier = createIntegrationTokenService(revokeDuringUse, api.accounts);
      await expectAuthorizationFailure(verifier.authorize(api.request('/api/analyses', 'GET', 'anonymous', { authorization: `Bearer ${issued.token}` }), 'analyses:read'), 401, 'invalid_integration_token');
    } finally { api.db.close(); }
  });

  test(`${kind}: completed issuance survives later browser logout, but cannot be used to create another token`, async () => {
    const api = await setup(kind);
    try {
      const issued = await api.create('write');
      const response = await api.accounts.handle(api.request('/api/account/logout', 'POST'), async () => ({}));
      assert.equal(response!.status, 200);
      assert.equal((await api.call(identityPath, 'GET', undefined, 'anonymous', { authorization: `Bearer ${issued.token}` })).status, 200);
      assert.equal((await api.call(listPath, 'POST', { label: 'Forbidden' })).status, 401);
      assert.equal((await api.call(listPath, 'POST', { label: 'Forbidden' }, 'anonymous', { authorization: `Bearer ${issued.token}` })).status, 403);
    } finally { api.db.close(); }
  });

  test(`${kind}: real analytical routes use bearer ownership, enforce scopes and never downgrade invalid tokens`, async () => {
    const api = await harness(kind);
    try {
      async function createToken(access: 'read' | 'write'): Promise<IntegrationTokenCreated> {
        const response = await api.call(listPath, 'POST', { label: 'AllMCP route test', access, expiresInDays: 7 });
        assert.equal(response.status, 201, await response.clone().text());
        return response.json() as Promise<IntegrationTokenCreated>;
      }
      const read = await createToken('read'), write = await createToken('write');
      assert.equal((await api.call(listPath, 'POST', '{"label":', {}, true)).status, 400);
      assert.equal((await api.call(listPath, 'POST', { label: 'Wrong content type' }, { 'content-type': 'text/plain' })).status, kind === 'cloud' ? 415 : 400);
      const owned = await analysisOf(await api.call('/api/analyses', 'POST', scoreInput('Owner dataset')), 201);
      const other = await analysisOf(await api.as('other', '/api/analyses', 'POST', scoreInput('Other dataset')), 201);
      const readHeaders = { authorization: `Bearer ${read.token}`, origin: null };
      const writeHeaders = { authorization: `Bearer ${write.token}`, origin: null };
      const view = await api.as('other', `/api/analyses/${owned.id}`, 'GET', undefined, readHeaders);
      assert.equal(view.status, 200);
      assert.deepEqual(await view.json(), { analysis: owned, access: { mode: 'owner', canWrite: false } });
      const list = await api.as('other', '/api/analyses', 'GET', undefined, readHeaders);
      assert.equal(list.status, 200);
      assert.deepEqual((await list.json()).analyses.map((row: { id: string }) => row.id), [owned.id]);
      assert.equal((await api.as('other', `/api/analyses/${other.id}`, 'GET', undefined, readHeaders)).status, 404);
      for (const [path, method, data] of [
        ['/api/analyses', 'POST', scoreInput()],
        [`/api/analyses/${owned.id}`, 'PATCH', { ...scoreInput(), revision: 0 }],
        [`/api/analyses/${owned.id}`, 'DELETE', { revision: 0 }],
      ] as const) assert.equal((await api.as('owner', path, method, data, readHeaders)).status, 403);
      const machine = await analysisOf(await api.as('other', '/api/analyses', 'POST', scoreInput('Machine dataset'), writeHeaders), 201);
      assert.equal(api.db.sqlite.prepare('SELECT owner_id FROM lab_analyses WHERE id=?').get(machine.id)?.owner_id, api.owner.id);
      const patched = await analysisOf(await api.as('other', `/api/analyses/${machine.id}`, 'PATCH', { ...scoreInput('Machine revision'), revision: 0 }, writeHeaders));
      assert.equal(patched.revision, 1);
      assert.equal((await api.as('other', `/api/analyses/${machine.id}`, 'DELETE', { revision: 1 }, writeHeaders)).status, 204);
      for (const method of ['GET', 'POST'] as const) {
        assert.equal((await api.call('/api/analyses', method, method === 'POST' ? scoreInput() : undefined, { authorization: 'Bearer invalid', origin: null })).status, 401);
        assert.equal((await api.call('/api/analyses', method, method === 'POST' ? scoreInput() : undefined, { ...writeHeaders, origin: 'https://unapproved.example' })).status, 403);
      }
      assert.equal((await api.call(`${listPath}/${read.details.id}`, 'DELETE')).status, 204);
      assert.equal((await api.call(`/api/analyses/${owned.id}`, 'GET', undefined, readHeaders)).status, 401);
    } finally { await api.close(); }
  });
}

test('a token-looking bearer on a pristine account database returns 401 without initializing fake accounts', async () => {
  const db = createAuthDatabase(':memory:');
  const accounts = createAccountService(db, { origins: [ORIGINS.cloud] });
  const tokens = createIntegrationTokenService(db, accounts);
  try {
    const request = new Request(ORIGINS.cloud + identityPath, { headers: { authorization: `Bearer helix_${randomBytes(32).toString('base64url')}` } });
    const response = await tokens.handle(request, async () => undefined);
    assert.equal(response!.status, 401);
    const accountTable = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lab_accounts'").first<{ name: string }>();
    assert.equal(accountTable, null);
  } finally { db.close(); }
});

test('storage failures never echo a token, session or database error', async () => {
  const api = await setup('local');
  try {
    const throwing = beforeRun(api.db, /INSERT INTO lab_integration_tokens/, async () => { throw new Error(`private detail ${api.identities.owner.secret}`); });
    const response = await createIntegrationTokenService(throwing, api.accounts).handle(api.request(listPath, 'POST'), async () => ({ label: 'Failed' }));
    assert.equal(response!.status, 500);
    assert.equal((await response!.text()).includes(api.identities.owner.secret), false);
    const row = await api.db.prepare('SELECT COUNT(*) AS count FROM lab_integration_tokens').first<{ count: number }>();
    assert.equal(row!.count, 0);
  } finally { api.db.close(); }
});
