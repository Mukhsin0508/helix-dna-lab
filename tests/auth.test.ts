import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import test from 'node:test';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { createAuthDatabase } from '../server/auth-database.ts';
import { createAccountService, type AccountService } from '../shared/auth.server.ts';
import type { Account } from '../shared/account.ts';
import type { AuthStatement } from '../shared/auth-database.ts';

const ORIGIN = 'https://helix.example';
const RP = 'helix.example';
const sha = (value: string | Uint8Array): Buffer => createHash('sha256').update(value).digest();
const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString('base64url');
const u8 = (value: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(value);

/** Actual test keys and signatures exercise the verifier; no verifier or auth endpoint is mocked. */
function authenticator(kind: 'ec' | 'rsa' = 'ec') {
  const pair = kind === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const id = randomBytes(32); const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const publicFields = kind === 'rsa' ? new Map<number, number | Uint8Array>([
    [1, 3], [3, -257], [-1, u8(Buffer.from(publicJwk.n!, 'base64url'))], [-2, u8(Buffer.from(publicJwk.e!, 'base64url'))],
  ]) : new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, u8(Buffer.from(publicJwk.x!, 'base64url'))], [-3, u8(Buffer.from(publicJwk.y!, 'base64url'))],
  ]);
  const cose = isoCBOR.encode(publicFields);
  return {
    id: b64(id),
    register(challenge: string, options: { origin?: string; rp?: string; uv?: boolean; counter?: number; algorithm?: number } = {}): RegistrationResponseJSON {
      const count = Buffer.alloc(4); count.writeUInt32BE(options.counter ?? 0);
      const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
      const publicKey = options.algorithm === undefined ? cose : isoCBOR.encode(new Map(publicFields).set(3, options.algorithm));
      const data = Buffer.concat([sha(options.rp ?? RP), Buffer.from([options.uv === false ? 0x41 : 0x45]), count, Buffer.alloc(16), length, id, publicKey]);
      const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, string>>([
        ['fmt', 'none'], ['attStmt', new Map()], ['authData', u8(data)],
      ]));
      return { id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64(JSON.stringify({ type: 'webauthn.create', challenge, origin: options.origin ?? ORIGIN, crossOrigin: false })), attestationObject: b64(attestation), transports: ['internal'] } };
    },
    authenticate(challenge: string, userHandle: string, options: { origin?: string; rp?: string; uv?: boolean; counter?: number; badSignature?: boolean } = {}): AuthenticationResponseJSON {
      const count = Buffer.alloc(4); count.writeUInt32BE(options.counter ?? 0);
      const data = Buffer.concat([sha(options.rp ?? RP), Buffer.from([options.uv === false ? 0x01 : 0x05]), count]);
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: options.origin ?? ORIGIN, crossOrigin: false }));
      const signature = sign('sha256', Buffer.concat([data, sha(clientData)]), pair.privateKey);
      if (options.badSignature) signature[signature.length - 1] ^= 1;
      return { id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64(clientData), authenticatorData: b64(data), signature: b64(signature), userHandle } };
    },
  };
}

function harness() {
  const db = createAuthDatabase(':memory:');
  const service = createAccountService(db, { origins: [ORIGIN] });
  function browser() {
    const cookies = new Map<string, string>();
    async function call(path: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Response> {
      const request = new Request(ORIGIN + path, { method: payload === undefined ? 'GET' : 'POST',
        headers: { origin: ORIGIN, cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), 'content-type': 'application/json', ...headers },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      const response = await service.handle(request, req => req.json()); assert.ok(response);
      for (const header of response.headers.getSetCookie()) {
        const [name, value] = header.split(';', 1)[0].split('=');
        if (value) cookies.set(name, value); else cookies.delete(name);
      }
      return response;
    }
    return { cookies, call };
  }
  return { db, service, browser };
}
type Browser = ReturnType<ReturnType<typeof harness>['browser']>;
async function register(browser: Browser, key = authenticator(), name = 'Researcher') {
  const started = await browser.call('/api/account/registration/options', { displayName: name });
  assert.equal(started.status, 200);
  const { options } = await started.json();
  const response = key.register(options.challenge);
  const finished = await browser.call('/api/account/registration/verify', { response });
  assert.equal(finished.status, 200, await finished.clone().text());
  return { key, userHandle: options.user.id as string, account: (await finished.json()).account as Account, finished };
}
async function authenticate(browser: Browser, key: ReturnType<typeof authenticator>, userHandle: string, options: Parameters<typeof key.authenticate>[2] = {}) {
  const started = await browser.call('/api/account/authentication/options', {}); assert.equal(started.status, 200);
  const value = await started.json();
  return browser.call('/api/account/authentication/verify', { response: key.authenticate(value.options.challenge, userHandle, options) });
}

test('real passkey registration and assertion create only hashed sessions, preserve user identity and logout', async () => {
  const h = harness(); const browser = h.browser();
  try {
    assert.deepEqual(await (await browser.call('/api/account')).json(), { account: null });
    const result = await register(browser);
    assert.deepEqual(await (await browser.call('/api/account')).json(), { account: result.account });
    for (const header of result.finished.headers.getSetCookie()) {
      assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/); assert.match(header, /Secure/); assert.match(header, /Path=\//); assert.doesNotMatch(header, /Domain=/);
    }
    const raw = browser.cookies.get('helix_session')!;
    const session = await h.db.prepare('SELECT * FROM lab_auth_sessions').first<{ token_hash: string; expires_at: number; created_at: number }>(); assert.ok(session);
    assert.notEqual(session.token_hash, raw); assert.equal(session.token_hash, b64(sha(raw)));
    assert.equal(session.expires_at - session.created_at, 7 * 86400_000);
    const logout = await browser.call('/api/account/logout', {}); assert.equal(logout.status, 200);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_auth_sessions').first<{ n: number }>())!.n, 0);
    assert.deepEqual(await (await browser.call('/api/account')).json(), { account: null });
    assert.equal((await authenticate(browser, result.key, result.userHandle)).status, 200);
    assert.deepEqual(await (await browser.call('/api/account')).json(), { account: result.account });
    const listed = await (await browser.call('/api/account/passkeys')).json();
    assert.equal(listed.passkeys.length, 1); assert.equal(listed.passkeys[0].id, result.key.id);
    assert.equal(listed.passkeys[0].deviceType, 'singleDevice'); assert.equal(listed.passkeys[0].backedUp, false);
    assert.ok(listed.passkeys[0].lastUsedAt); assert.equal(listed.passkeys[0].publicKey, undefined);
    // Synced authenticators can validly keep a zero counter, but still sign fresh one-use challenges.
    assert.equal((await authenticate(browser, result.key, result.userHandle)).status, 200);
    assert.equal((await h.db.prepare('SELECT counter FROM lab_passkeys').first<{ counter: number }>())!.counter, 0);
  } finally { h.db.close(); }
});

test('registration options require discoverable credentials, user verification, none attestation and approved algorithms', async () => {
  const h = harness(); const browser = h.browser();
  try {
    const response = await browser.call('/api/account/registration/options', { displayName: ' A scientist ' });
    const { options } = await response.json();
    assert.equal(options.rp.id, RP); assert.equal(options.user.name, 'A scientist'); assert.equal(options.attestation, 'none');
    assert.equal(options.authenticatorSelection.residentKey, 'required'); assert.equal(options.authenticatorSelection.userVerification, 'required');
    assert.deepEqual(options.pubKeyCredParams.map((item: { alg: number }) => item.alg), [-7, -257]);
    assert.equal(Buffer.from(options.user.id, 'base64url').length, 32);
    const stored = await h.db.prepare('SELECT token_hash,challenge FROM lab_auth_ceremonies').first<{ token_hash: string; challenge: string }>(); assert.ok(stored);
    assert.notEqual(stored.token_hash, browser.cookies.get('helix_ceremony')); assert.equal(stored.challenge, options.challenge);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_accounts').first<{ n: number }>())!.n, 0);
  } finally { h.db.close(); }
});

test('RS256 registration and an actual RSA assertion verify through the same approved flow', async () => {
  const h = harness(); const browser = h.browser();
  try {
    const result = await register(browser, authenticator('rsa'));
    await browser.call('/api/account/logout', {});
    assert.equal((await authenticate(browser, result.key, result.userHandle)).status, 200);
  } finally { h.db.close(); }
});

test('mutations require exact configured Origin and request URL without trusting Host or forwarded headers', async () => {
  const h = harness(); const browser = h.browser();
  try {
    for (const origin of ['', 'null', 'https://other.example', `${ORIGIN}/`, 'https://sub.helix.example']) {
      assert.equal((await browser.call('/api/account/registration/options', { displayName: 'User' }, { origin, host: RP, 'x-forwarded-host': RP })).status, 403);
    }
    const unknown = new Request('https://attacker.example/api/account/registration/options', { method: 'POST', headers: { origin: ORIGIN }, body: '{}' });
    assert.equal((await h.service.handle(unknown, req => req.json()))!.status, 403);
    assert.throws(() => createAccountService(h.db, { origins: ['https://helix.example/'] }));
    assert.throws(() => createAccountService(h.db, { origins: ['http://public.example'] }));
  } finally { h.db.close(); }
});

test('registration rejects wrong challenge, RP, client origin, UV and unsupported algorithm, and consumes failures', async () => {
  const cases = [
    { challenge: 'wrong' }, { rp: 'other.example' }, { origin: 'https://other.example' }, { uv: false }, { algorithm: -8 },
  ];
  for (const mismatch of cases) {
    const h = harness(); const browser = h.browser(); const key = authenticator();
    try {
      const { options } = await (await browser.call('/api/account/registration/options', { displayName: 'User' })).json();
      const oldCookie = browser.cookies.get('helix_ceremony')!;
      const response = key.register('challenge' in mismatch ? mismatch.challenge! : options.challenge, mismatch);
      const rejected = await browser.call('/api/account/registration/verify', { response });
      assert.equal(rejected.status, 400); assert.equal(browser.cookies.has('helix_session'), false);
      assert.doesNotMatch(await rejected.text(), /expected|challenge "|SQLITE|Error:/);
      browser.cookies.set('helix_ceremony', oldCookie);
      assert.equal((await browser.call('/api/account/registration/verify', { response: key.register(options.challenge) })).status, 400);
      assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_accounts').first<{ n: number }>())!.n, 0);
    } finally { h.db.close(); }
  }
});

test('expired and malformed ceremonies cannot issue sessions, including retrying the same challenge', async () => {
  const h = harness(); const browser = h.browser(); const key = authenticator();
  try {
    const { options } = await (await browser.call('/api/account/registration/options', { displayName: 'User' })).json();
    await h.db.prepare('UPDATE lab_auth_ceremonies SET expires_at=?').bind(Date.now() - 1).run();
    assert.equal((await browser.call('/api/account/registration/verify', { response: key.register(options.challenge) })).status, 400);
    await browser.call('/api/account/registration/options', { displayName: 'User' });
    assert.equal((await browser.call('/api/account/registration/verify', { response: {} })).status, 400);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_auth_ceremonies').first<{ n: number }>())!.n, 0);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_auth_sessions').first<{ n: number }>())!.n, 0);
  } finally { h.db.close(); }
});

test('assertion verifies the signature, UV, RP, origin and exact stored discoverable userHandle', async () => {
  const h = harness(); const browser = h.browser();
  try {
    const result = await register(browser); await browser.call('/api/account/logout', {});
    for (const change of [{ badSignature: true }, { uv: false }, { rp: 'other.example' }, { origin: 'https://other.example' }]) {
      assert.equal((await authenticate(browser, result.key, result.userHandle, change)).status, 400);
      assert.equal(browser.cookies.has('helix_session'), false);
    }
    assert.equal((await authenticate(browser, result.key, b64(randomBytes(32)))).status, 400);
    assert.equal((await authenticate(browser, result.key, result.userHandle, { counter: 1 })).status, 200);
    await browser.call('/api/account/logout', {});
    assert.equal((await authenticate(browser, result.key, result.userHandle, { counter: 1 })).status, 400);
    assert.equal((await authenticate(browser, result.key, result.userHandle, { counter: 2 })).status, 200);
  } finally { h.db.close(); }
});

test('a consumed successful assertion cannot be replayed with its original cookie', async () => {
  const h = harness(); const browser = h.browser();
  try {
    const result = await register(browser); await browser.call('/api/account/logout', {});
    const { options } = await (await browser.call('/api/account/authentication/options', {})).json();
    const ceremony = browser.cookies.get('helix_ceremony')!; const response = result.key.authenticate(options.challenge, result.userHandle);
    assert.equal((await browser.call('/api/account/authentication/verify', { response })).status, 200);
    await browser.call('/api/account/logout', {}); browser.cookies.set('helix_ceremony', ceremony);
    assert.equal((await browser.call('/api/account/authentication/verify', { response })).status, 400);
    assert.equal(browser.cookies.has('helix_session'), false);
  } finally { h.db.close(); }
});

test('concurrent signed assertions use counter CAS; the losing request cannot obtain a session', async context => {
  const h = harness(); const owner = h.browser(); const first = h.browser(); const second = h.browser();
  try {
    const registered = await register(owner); await owner.call('/api/account/logout', {});
    const a = await (await first.call('/api/account/authentication/options', {})).json();
    const b = await (await second.call('/api/account/authentication/options', {})).json();
    const prepare = h.db.prepare.bind(h.db); let arrivals = 0; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    context.mock.method(h.db, 'prepare', (sql: string): AuthStatement => {
      const original = prepare(sql);
      if (sql !== 'SELECT * FROM lab_passkeys WHERE id=? AND rp_id=?') return original;
      const wrapped = (statement: AuthStatement): AuthStatement => ({
        bind: (...values) => wrapped(statement.bind(...values)), run: () => statement.run(), all: <T>() => statement.all<T>(),
        first: async <T>() => { const value = await statement.first<T>(); if (++arrivals === 2) release(); await barrier; return value; },
      });
      return wrapped(original);
    });
    const responses = await Promise.all([
      first.call('/api/account/authentication/verify', { response: registered.key.authenticate(a.options.challenge, registered.userHandle, { counter: 1 }) }),
      second.call('/api/account/authentication/verify', { response: registered.key.authenticate(b.options.challenge, registered.userHandle, { counter: 1 }) }),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(Number(first.cookies.has('helix_session')) + Number(second.cookies.has('helix_session')), 1);
    assert.equal((await prepare('SELECT count(*) AS n FROM lab_auth_sessions').first<{ n: number }>())!.n, 1);
  } finally { context.mock.restoreAll(); h.db.close(); }
});

test('credential ID mismatch and cross-origin client data are rejected before issuing a session', async () => {
  const h = harness(); const browser = h.browser();
  try {
    for (const change of ['rawId', 'embeddedId', 'crossOrigin']) {
      const { options } = await (await browser.call('/api/account/registration/options', { displayName: 'User' })).json();
      const response = authenticator().register(options.challenge);
      if (change === 'rawId') response.rawId = b64(randomBytes(32));
      if (change === 'embeddedId') response.rawId = response.id = b64(randomBytes(32));
      if (change === 'crossOrigin') response.response.clientDataJSON = b64(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN, crossOrigin: true }));
      assert.equal((await browser.call('/api/account/registration/verify', { response })).status, 400);
      assert.equal(browser.cookies.has('helix_session'), false);
    }
  } finally { h.db.close(); }
});

test('add-key is authenticated and bound to the initiating account; duplicate key failure rolls back registration', async () => {
  const h = harness(); const first = h.browser(); const second = h.browser(); const third = h.browser();
  try {
    assert.equal((await third.call('/api/account/passkeys/options', {})).status, 401);
    const a = await register(first, authenticator(), 'A'); const b = await register(second, authenticator(), 'B');
    const { options } = await (await first.call('/api/account/passkeys/options', {})).json();
    assert.equal(options.user.id, a.userHandle); assert.deepEqual(options.excludeCredentials.map((key: { id: string }) => key.id), [a.key.id]);
    const extra = authenticator(); second.cookies.set('helix_ceremony', first.cookies.get('helix_ceremony')!);
    assert.equal((await second.call('/api/account/passkeys/verify', { response: extra.register(options.challenge) })).status, 403);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_passkeys').first<{ n: number }>())!.n, 2);
    const next = await (await first.call('/api/account/passkeys/options', {})).json();
    assert.equal((await first.call('/api/account/passkeys/verify', { response: extra.register(next.options.challenge) })).status, 200);
    assert.equal((await (await first.call('/api/account/passkeys')).json()).passkeys.length, 2);
    assert.equal((await (await second.call('/api/account/passkeys')).json()).passkeys.length, 1);
    const duplicate = await (await third.call('/api/account/registration/options', { displayName: 'Should roll back' })).json();
    assert.equal((await third.call('/api/account/registration/verify', { response: a.key.register(duplicate.options.challenge) })).status, 409);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_accounts').first<{ n: number }>())!.n, 2);
    assert.equal(third.cookies.has('helix_session'), false);
    assert.notEqual(a.account.id, b.account.id);
  } finally { h.db.close(); }
});

test('session expiry, revoked tokens and another origin cannot authenticate an account', async () => {
  const h = harness(); const browser = h.browser();
  try {
    const registered = await register(browser); const secret = browser.cookies.get('helix_session')!;
    await h.db.prepare('UPDATE lab_auth_sessions SET expires_at=?').bind(Date.now() - 1).run();
    assert.deepEqual(await (await browser.call('/api/account')).json(), { account: null });
    const another: AccountService = createAccountService(h.db, { origins: ['https://another.example'] });
    const request = new Request('https://another.example/api/account', { headers: { cookie: `helix_session=${secret}` } });
    assert.equal(await another.accountForRequest(request), null);
    assert.equal((await authenticate(browser, registered.key, registered.userHandle)).status, 200);
    const original = browser.cookies.get('helix_session')!;
    await browser.call('/api/account/logout', {}); browser.cookies.set('helix_session', original);
    assert.deepEqual(await (await browser.call('/api/account')).json(), { account: null });
  } finally { h.db.close(); }
});

test('auth rate limits persist without plaintext address and cleanup expired buckets', async () => {
  const h = harness(); const browser = h.browser(); const address = '192.0.2.123';
  try {
    for (let i = 0; i < 60; i++) assert.equal((await browser.call('/api/account/authentication/options', {}, { 'x-helix-client-address': address })).status, 200);
    assert.equal((await browser.call('/api/account/authentication/options', {}, { 'x-helix-client-address': address })).status, 429);
    const { results } = await h.db.prepare('SELECT * FROM lab_auth_limits').all<{ key: string }>();
    assert.equal(results.length, 1); assert.doesNotMatch(JSON.stringify(results), /192\.0\.2/);
    await h.db.prepare('UPDATE lab_auth_limits SET expires_at=0').run();
    assert.equal((await browser.call('/api/account/authentication/options', {}, { 'x-helix-client-address': address })).status, 200);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_auth_ceremonies').first<{ n: number }>())!.n, 1);
  } finally { h.db.close(); }
});

test('the ceremony rate limit cannot prevent an existing account from signing out', async () => {
  const h = harness(); const browser = h.browser();
  try {
    await register(browser);
    await h.db.prepare('UPDATE lab_auth_limits SET count=60').run();
    assert.equal((await browser.call('/api/account/authentication/options', {})).status, 429);
    assert.equal((await browser.call('/api/account/logout', {})).status, 200);
    assert.equal(browser.cookies.has('helix_session'), false);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_auth_sessions').first<{ n: number }>())!.n, 0);
  } finally { h.db.close(); }
});

for (const purpose of ['registration', 'authentication', 'passkeys'] as const) {
  for (const timing of ['before-commit', 'after-commit-before-response'] as const) {
    test(`logout fences ${purpose} verification ${timing}`, async context => {
      const h = harness(); const browser = h.browser();
      try {
        const existing = purpose === 'registration' ? undefined : await register(browser);
        if (purpose === 'authentication') await browser.call('/api/account/logout', {});
        const { options } = await (await browser.call(`/api/account/${purpose}/options`, purpose === 'registration' ? { displayName: 'Pending user' } : {})).json();
        const response = purpose === 'authentication'
          ? existing!.key.authenticate(options.challenge, existing!.userHandle, { counter: 1 })
          : authenticator().register(options.challenge);
        const originalBatch = h.db.batch.bind(h.db); let reached!: () => void; let release!: () => void;
        const arrived = new Promise<void>(resolve => { reached = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        let paused = false;
        context.mock.method(h.db, 'batch', async (statements: AuthStatement[]) => {
          const issuance = !paused && statements.some(statement => (statement as unknown as { sql: string }).sql.startsWith('INSERT INTO lab_auth_sessions'));
          if (!issuance) return originalBatch(statements);
          paused = true;
          if (timing === 'before-commit') { reached(); await gate; return originalBatch(statements); }
          const result = await originalBatch(statements); reached(); await gate; return result;
        });
        const pending = browser.call(`/api/account/${purpose}/verify`, { response });
        await arrived;
        const logout = await browser.call('/api/account/logout', {}); assert.equal(logout.status, 200);
        assert.deepEqual(await (await browser.call('/api/account')).json(), { account: null });
        release(); const finished = await pending;
        assert.equal(finished.status, timing === 'before-commit' ? 409 : 200);
        // The delayed response may set an already-revoked cookie; that cookie must grant no access.
        assert.deepEqual(await (await browser.call('/api/account')).json(), { account: null });
        assert.equal((await browser.call('/api/account/passkeys')).status, 401);
        assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_auth_sessions').first<{ n: number }>())!.n, 0);
        assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_auth_ceremonies').first<{ n: number }>())!.n, 0);
        if (timing === 'before-commit') {
          assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_accounts').first<{ n: number }>())!.n, existing ? 1 : 0);
          assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_passkeys').first<{ n: number }>())!.n, existing ? 1 : 0);
          if (existing) assert.equal((await h.db.prepare('SELECT counter FROM lab_passkeys WHERE id=?').bind(existing.key.id).first<{ counter: number }>())!.counter, 0);
        }
      } finally { context.mock.restoreAll(); h.db.close(); }
    });
  }
}

test('add-key final commit revalidates its initiating session even when logout cannot see the ceremony cookie', async context => {
  const h = harness(); const browser = h.browser(); const otherTab = h.browser();
  try {
    await register(browser); otherTab.cookies.set('helix_session', browser.cookies.get('helix_session')!);
    const { options } = await (await browser.call('/api/account/passkeys/options', {})).json();
    const originalBatch = h.db.batch.bind(h.db); let reached!: () => void; let release!: () => void;
    const arrived = new Promise<void>(resolve => { reached = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    context.mock.method(h.db, 'batch', async (statements: AuthStatement[]) => {
      if (statements.some(statement => (statement as unknown as { sql: string }).sql.startsWith('INSERT INTO lab_auth_sessions'))) { reached(); await gate; }
      return originalBatch(statements);
    });
    const pending = browser.call('/api/account/passkeys/verify', { response: authenticator().register(options.challenge) });
    await arrived;
    assert.equal((await otherTab.call('/api/account/logout', {})).status, 200);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_auth_ceremonies WHERE claimed=1').first<{ n: number }>())!.n, 1);
    release(); assert.equal((await pending).status, 409);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM lab_passkeys').first<{ n: number }>())!.n, 1);
    assert.deepEqual(await (await browser.call('/api/account')).json(), { account: null });
  } finally { context.mock.restoreAll(); h.db.close(); }
});

test('account initialization adds logout-fence columns to existing databases without deleting valid sessions', async () => {
  const db = createAuthDatabase(':memory:');
  try {
    await db.prepare('CREATE TABLE lab_accounts (id TEXT PRIMARY KEY,display_name TEXT NOT NULL,user_handle TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)').run();
    await db.prepare('CREATE TABLE lab_auth_sessions (token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,origin TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)').run();
    await db.prepare('CREATE TABLE lab_auth_ceremonies (token_hash TEXT PRIMARY KEY,purpose TEXT NOT NULL,challenge TEXT NOT NULL,origin TEXT NOT NULL,rp_id TEXT NOT NULL,account_id TEXT,user_handle TEXT,display_name TEXT,expires_at INTEGER NOT NULL)').run();
    const secret = b64(randomBytes(32)); const now = Date.now(); const id = crypto.randomUUID();
    await db.prepare('INSERT INTO lab_accounts VALUES (?,?,?,?)').bind(id, 'Existing account', b64(randomBytes(32)), now).run();
    await db.prepare('INSERT INTO lab_auth_sessions VALUES (?,?,?,?,?)').bind(b64(sha(secret)), id, ORIGIN, now, now + 60000).run();
    for (let i = 0; i < 2; i++) {
      const service = createAccountService(db, { origins: [ORIGIN] });
      assert.deepEqual(await service.accountForRequest(new Request(`${ORIGIN}/api/account`, { headers: { cookie: `helix_session=${secret}` } })), { id, displayName: 'Existing account' });
    }
    const sessionColumns = (await db.prepare('PRAGMA table_info(lab_auth_sessions)').all<{ name: string }>()).results.map(column => column.name);
    const ceremonyColumns = (await db.prepare('PRAGMA table_info(lab_auth_ceremonies)').all<{ name: string }>()).results.map(column => column.name);
    assert.ok(sessionColumns.includes('ceremony_hash')); assert.ok(ceremonyColumns.includes('claimed')); assert.ok(ceremonyColumns.includes('session_token_hash'));
  } finally { db.close(); }
});
