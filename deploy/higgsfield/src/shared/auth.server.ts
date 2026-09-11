import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import type { Account, PasskeySummary } from './account.ts';
import { AUTH_COLUMN_MIGRATIONS, AUTH_SCHEMA_STATEMENTS, type AuthDatabase, type AuthStatement } from './auth-database.ts';

export const AUTH_BODY_LIMIT = 16 * 1024;
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const CEREMONY_SECONDS = 5 * 60;
const SESSION_COOKIE = 'helix_session';
const CEREMONY_COOKIE = 'helix_ceremony';
const ALGORITHMS = [-7, -257];
const encodedValue = /^[A-Za-z0-9_-]+$/;
const emptySchema = z.object({}).strict();
const registrationSchema = z.object({ displayName: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u) }).strict();
const credentialSchema = z.object({
  id: z.string().min(1).max(2048).regex(encodedValue),
  rawId: z.string().min(1).max(2048).regex(encodedValue),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()), authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
}).strict();
const bytesSchema = z.string().min(1).max(AUTH_BODY_LIMIT).regex(encodedValue);
const registrationResponseSchema = z.object({ response: credentialSchema.extend({ response: z.object({
  clientDataJSON: bytesSchema, attestationObject: bytesSchema,
  authenticatorData: bytesSchema.optional(), transports: z.array(z.string().min(1).max(64)).max(10).optional(),
  publicKeyAlgorithm: z.number().int().optional(), publicKey: bytesSchema.optional(),
}).strict() }) }).strict();
const authenticationResponseSchema = z.object({ response: credentialSchema.extend({ response: z.object({
  clientDataJSON: bytesSchema, authenticatorData: bytesSchema, signature: bytesSchema, userHandle: bytesSchema.optional(),
}).strict() }) }).strict();

interface AccountRow { id: string; display_name: string; user_handle: string }
interface PasskeyRow {
  id: string; account_id: string; public_key: string; counter: number;
  device_type: 'singleDevice' | 'multiDevice'; backed_up: number;
  transports: string; rp_id: string; created_at: number; last_used_at: number | null;
}
interface Ceremony {
  purpose: 'registration' | 'authentication' | 'add-key'; challenge: string;
  origin: string; rp_id: string; account_id: string | null;
  user_handle: string | null; display_name: string | null; expires_at: number; session_token_hash: string | null;
}
interface ClaimedCeremony extends Ceremony { token_hash: string; claimed: 1 }
interface Origin { origin: string; rpId: string; secure: boolean }
export interface AccountService {
  handle(request: Request, readBody: (request: Request) => Promise<unknown>): Promise<Response | undefined>;
  accountForRequest(request: Request): Promise<Account | null>;
  requireWriteOrigin(request: Request): void;
}
export class AccountRequestError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!encodedValue.test(value)) throw new AccountRequestError(400, 'invalid_response', 'The passkey response is invalid.');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));
  if (base64url(bytes) !== value) throw new AccountRequestError(400, 'invalid_response', 'The passkey response is invalid.');
  return bytes;
}
function token(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
async function hash(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
function cookieToken(request: Request, name: string): string | null {
  const values = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return value.length === 43 && encodedValue.test(value) ? value : null;
}
function cookie(name: string, value: string, seconds: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}
function json(value: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  cookies.forEach(value => headers.append('Set-Cookie', value));
  return Response.json(value, { status, headers });
}
function account(row: AccountRow): Account { return { id: row.id, displayName: row.display_name }; }
function requireCredentialContext(response: RegistrationResponseJSON | AuthenticationResponseJSON): void {
  if (response.rawId !== response.id) throw new AccountRequestError(400, 'invalid_response', 'The passkey response is inconsistent.');
  const client = JSON.parse(new TextDecoder().decode(decode(response.response.clientDataJSON))) as { crossOrigin?: unknown; topOrigin?: unknown };
  if (!client || typeof client !== 'object' || client.crossOrigin === true || client.topOrigin !== undefined) throw new AccountRequestError(400, 'invalid_response', 'Open the lab directly to use your passkey.');
}

/** Native passkeys and opaque cookie sessions. No genomic data or analytical ownership lives here. */
export function createAccountService(db: AuthDatabase, config: { origins: readonly string[] }): AccountService {
  const approved = new Map<string, Origin>();
  for (const value of config.origins) {
    const url = new URL(value);
    if (value !== url.origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Configure exact HTTPS origins, or explicit loopback development origins.');
    approved.set(value, { origin: value, rpId: url.hostname, secure: url.protocol === 'https:' });
  }
  if (!approved.size) throw new Error('At least one approved account origin is required.');
  let initialized: Promise<void> | undefined;
  function ensure(): Promise<void> {
    if (!initialized) initialized = (async () => {
      for (const sql of AUTH_SCHEMA_STATEMENTS.filter(sql => sql.startsWith('CREATE TABLE'))) await db.prepare(sql).run();
      for (const migration of AUTH_COLUMN_MIGRATIONS) {
        const columns = () => db.prepare(`PRAGMA table_info(${migration.table})`).all<{ name: string }>();
        if (!(await columns()).results.some(column => column.name === migration.column)) {
          try { await db.prepare(migration.sql).run(); }
          catch (error) { if (!(await columns()).results.some(column => column.name === migration.column)) throw error; }
        }
      }
      for (const sql of AUTH_SCHEMA_STATEMENTS.filter(sql => !sql.startsWith('CREATE TABLE'))) await db.prepare(sql).run();
    })().catch(error => { initialized = undefined; throw error; });
    return initialized;
  }
  function originFor(request: Request): Origin {
    const origin = approved.get(new URL(request.url).origin);
    if (!origin) throw new AccountRequestError(403, 'origin_not_allowed', 'Open the lab from its approved website.');
    return origin;
  }
  function requireWriteOrigin(request: Request): void {
    const origin = originFor(request);
    if (request.headers.get('origin') !== origin.origin) throw new AccountRequestError(403, 'origin_not_allowed', 'This request must come from the same lab website.');
  }
  async function accountForRequest(request: Request): Promise<Account | null> {
    const origin = originFor(request);
    const secret = cookieToken(request, SESSION_COOKIE);
    if (!secret) return null;
    await ensure();
    const row = await db.prepare(`SELECT a.id,a.display_name,a.user_handle FROM lab_auth_sessions s
      JOIN lab_accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.origin=? AND s.expires_at>?`)
      .bind(await hash(secret), origin.origin, Date.now()).first<AccountRow>();
    return row ? account(row) : null;
  }
  async function authenticated(request: Request): Promise<Account> {
    const result = await accountForRequest(request);
    if (!result) throw new AccountRequestError(401, 'authentication_required', 'Sign in to your account.');
    return result;
  }
  async function body(request: Request, readBody: (request: Request) => Promise<unknown>): Promise<unknown> {
    const data = await readBody(request);
    if (new TextEncoder().encode(JSON.stringify(data) ?? '').byteLength > AUTH_BODY_LIMIT) throw new AccountRequestError(413, 'body_too_large', 'The passkey request is too large.');
    return data;
  }
  async function budget(request: Request, origin: Origin): Promise<void> {
    const now = Date.now(); const bucket = Math.floor(now / 300_000);
    // Hosting/local entry points overwrite this internal header with their canonical client address.
    const address = request.headers.get('x-helix-client-address') || 'unknown';
    const key = await hash(`${origin.origin}\n${address}\n${bucket}`);
    await db.prepare('DELETE FROM lab_auth_limits WHERE expires_at<=?').bind(now).run();
    await db.prepare('DELETE FROM lab_auth_ceremonies WHERE expires_at<=?').bind(now).run();
    await db.prepare('DELETE FROM lab_auth_sessions WHERE expires_at<=?').bind(now).run();
    const result = await db.prepare(`INSERT INTO lab_auth_limits (key,count,expires_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`).bind(key, (bucket + 2) * 300_000).first<{ count: number }>();
    if (!result || result.count > 60) throw new AccountRequestError(429, 'rate_limit', 'Too many account attempts. Try again in a few minutes.');
  }
  async function begin(request: Request, details: Ceremony): Promise<string> {
    const previous = cookieToken(request, CEREMONY_COOKIE);
    const secret = token();
    const statements = [db.prepare(`INSERT INTO lab_auth_ceremonies
      (token_hash,purpose,challenge,origin,rp_id,account_id,user_handle,display_name,expires_at,session_token_hash) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(await hash(secret), details.purpose, details.challenge, details.origin, details.rp_id, details.account_id, details.user_handle, details.display_name, details.expires_at, details.session_token_hash)];
    if (previous) statements.push(db.prepare('DELETE FROM lab_auth_ceremonies WHERE token_hash=?').bind(await hash(previous)));
    await db.batch(statements);
    return secret;
  }
  async function consume(request: Request, purpose: Ceremony['purpose'], origin: Origin): Promise<ClaimedCeremony> {
    const secret = cookieToken(request, CEREMONY_COOKIE);
    if (!secret) throw new AccountRequestError(400, 'ceremony_expired', 'Start the passkey step again.');
    // A single claim prevents replay; retaining the row lets logout cancel an in-flight verification.
    const result = await db.prepare('UPDATE lab_auth_ceremonies SET claimed=1 WHERE token_hash=? AND claimed=0 RETURNING *').bind(await hash(secret)).first<ClaimedCeremony>();
    if (!result || result.expires_at <= Date.now() || result.purpose !== purpose || result.origin !== origin.origin || result.rp_id !== origin.rpId) throw new AccountRequestError(400, 'ceremony_expired', 'Start the passkey step again.');
    return result;
  }
  async function newSession(request: Request, id: string, origin: Origin, ceremony: ClaimedCeremony,
    expectedKey?: { id: string; counter: number }): Promise<{ secret: string; statements: AuthStatement[] }> {
    const secret = token(); const now = Date.now(); const previous = cookieToken(request, SESSION_COOKIE);
    // The NOT NULL constraint fails the entire batch if logout/expiry/counter change won before commit.
    const statements = [db.prepare(`INSERT INTO lab_auth_sessions (token_hash,account_id,origin,created_at,expires_at,ceremony_hash)
      VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM lab_auth_ceremonies c
        WHERE c.token_hash=? AND c.claimed=1 AND c.purpose=? AND c.origin=? AND c.rp_id=?
          AND c.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
          AND (c.purpose<>'add-key' OR (c.account_id=? AND c.session_token_hash=? AND EXISTS (
            SELECT 1 FROM lab_auth_sessions s WHERE s.token_hash=c.session_token_hash AND s.account_id=? AND s.origin=?
              AND s.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))))
          AND (? IS NULL OR EXISTS (SELECT 1 FROM lab_passkeys k WHERE k.id=? AND k.account_id=? AND k.counter=?)))
        THEN ? ELSE NULL END, ?, ?, ?, ?)`)
      .bind(await hash(secret), ceremony.token_hash, ceremony.purpose, origin.origin, origin.rpId,
        id, previous ? await hash(previous) : null, id, origin.origin,
        expectedKey?.id ?? null, expectedKey?.id ?? null, id, expectedKey?.counter ?? null,
        id, origin.origin, now, now + SESSION_SECONDS * 1000, ceremony.token_hash)];
    if (previous) statements.push(db.prepare('DELETE FROM lab_auth_sessions WHERE token_hash=?').bind(await hash(previous)));
    statements.push(db.prepare('DELETE FROM lab_auth_ceremonies WHERE token_hash=?').bind(ceremony.token_hash));
    return { secret, statements };
  }
  async function commit(statements: AuthStatement[]): Promise<void> {
    try { await db.batch(statements); }
    catch { throw new AccountRequestError(409, 'ceremony_changed', 'This sign-in step changed or was cancelled. Start again.'); }
  }
  function finishedCookies(origin: Origin, session?: string): string[] {
    return [cookie(CEREMONY_COOKIE, '', 0, origin.secure), ...(session ? [cookie(SESSION_COOKIE, session, SESSION_SECONDS, origin.secure)] : [])];
  }

  async function handle(request: Request, readBody: (request: Request) => Promise<unknown>): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (path !== '/api/account' && !path.startsWith('/api/account/')) return undefined;
    let approvedOrigin: Origin | undefined;
    let claimedHash: string | undefined;
    const verification = path.endsWith('/verify');
    try {
      approvedOrigin = originFor(request);
      const origin = approvedOrigin;
      if (request.method === 'GET' && path === '/api/account') return json({ account: await accountForRequest(request) });
      if (request.method === 'GET' && path === '/api/account/passkeys') {
        const current = await authenticated(request);
        const { results } = await db.prepare('SELECT * FROM lab_passkeys WHERE account_id=? ORDER BY created_at,id').bind(current.id).all<PasskeyRow>();
        const passkeys: PasskeySummary[] = results.map(key => ({ id: key.id, createdAt: new Date(key.created_at).toISOString(), lastUsedAt: key.last_used_at === null ? null : new Date(key.last_used_at).toISOString(), deviceType: key.device_type, backedUp: key.backed_up === 1 }));
        return json({ passkeys });
      }
      if (request.method !== 'POST') return json({ error: 'method_not_allowed', message: 'Method not allowed.' }, 405);
      requireWriteOrigin(request); await ensure();

      if (path === '/api/account/logout') {
        emptySchema.parse(await body(request, readBody));
        const session = cookieToken(request, SESSION_COOKIE); const ceremony = cookieToken(request, CEREMONY_COOKIE);
        const logout: AuthStatement[] = [];
        if (session) logout.push(db.prepare('DELETE FROM lab_auth_sessions WHERE token_hash=?').bind(await hash(session)));
        if (ceremony) {
          const ceremonyHash = await hash(ceremony);
          // This also revokes a committed session whose Set-Cookie response has not reached the browser.
          logout.push(db.prepare('DELETE FROM lab_auth_sessions WHERE ceremony_hash=?').bind(ceremonyHash));
          logout.push(db.prepare('DELETE FROM lab_auth_ceremonies WHERE token_hash=?').bind(ceremonyHash));
        }
        if (logout.length) await db.batch(logout);
        return json({ account: null }, 200, [...finishedCookies(origin), cookie(SESSION_COOKIE, '', 0, origin.secure)]);
      }
      await budget(request, origin);
      if (path === '/api/account/registration/options' || path === '/api/account/passkeys/options') {
        const adding = path.includes('/passkeys/');
        let user: AccountRow;
        if (adding) {
          const current = await authenticated(request); emptySchema.parse(await body(request, readBody));
          const existing = await db.prepare('SELECT * FROM lab_accounts WHERE id=?').bind(current.id).first<AccountRow>();
          if (!existing) throw new AccountRequestError(401, 'authentication_required', 'Sign in to your account.');
          user = existing;
        } else {
          const data = registrationSchema.parse(await body(request, readBody));
          user = { id: crypto.randomUUID(), display_name: data.displayName, user_handle: token() };
        }
        const { results: keys } = adding ? await db.prepare('SELECT * FROM lab_passkeys WHERE account_id=? AND rp_id=?').bind(user.id, origin.rpId).all<PasskeyRow>() : { results: [] };
        const options = await generateRegistrationOptions({ rpName: 'Helix', rpID: origin.rpId,
          userID: decode(user.user_handle), userName: user.display_name, userDisplayName: user.display_name,
          attestationType: 'none', supportedAlgorithmIDs: ALGORITHMS, timeout: CEREMONY_SECONDS * 1000,
          excludeCredentials: keys.map(key => ({ id: key.id, transports: JSON.parse(key.transports) as string[] })),
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        });
        const secret = await begin(request, { purpose: adding ? 'add-key' : 'registration', challenge: options.challenge, origin: origin.origin, rp_id: origin.rpId, account_id: user.id, user_handle: user.user_handle, display_name: user.display_name, expires_at: Date.now() + CEREMONY_SECONDS * 1000,
          session_token_hash: adding ? await hash(cookieToken(request, SESSION_COOKIE)!) : null });
        return json({ options }, 200, [cookie(CEREMONY_COOKIE, secret, CEREMONY_SECONDS, origin.secure)]);
      }
      if (path === '/api/account/registration/verify' || path === '/api/account/passkeys/verify') {
        const adding = path.includes('/passkeys/');
        const ceremony = await consume(request, adding ? 'add-key' : 'registration', origin);
        claimedHash = ceremony.token_hash;
        if (adding && (await authenticated(request)).id !== ceremony.account_id) throw new AccountRequestError(403, 'account_mismatch', 'Start the passkey step from your own account.');
        const data = registrationResponseSchema.parse(await body(request, readBody));
        const response: RegistrationResponseJSON = data.response;
        requireCredentialContext(response);
        const result = await verifyRegistrationResponse({ response, expectedChallenge: ceremony.challenge,
          expectedOrigin: origin.origin, expectedRPID: origin.rpId, requireUserVerification: true, supportedAlgorithmIDs: ALGORITHMS });
        if (!result.verified || !result.registrationInfo || !ceremony.account_id || !ceremony.user_handle || !ceremony.display_name) throw new AccountRequestError(400, 'verification_failed', 'The passkey could not be verified. Start again.');
        const info = result.registrationInfo; const credential = info.credential; const now = Date.now();
        if (credential.id !== response.id) throw new AccountRequestError(400, 'invalid_response', 'The passkey response is inconsistent.');
        const statements: AuthStatement[] = [];
        if (!adding) statements.push(db.prepare('INSERT INTO lab_accounts (id,display_name,user_handle,created_at) VALUES (?,?,?,?)').bind(ceremony.account_id, ceremony.display_name, ceremony.user_handle, now));
        statements.push(db.prepare(`INSERT INTO lab_passkeys (id,account_id,public_key,counter,device_type,backed_up,transports,rp_id,created_at,last_used_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(credential.id, ceremony.account_id, base64url(credential.publicKey), credential.counter, info.credentialDeviceType, Number(info.credentialBackedUp), JSON.stringify(credential.transports || []), origin.rpId, now, null));
        const session = await newSession(request, ceremony.account_id, origin, ceremony); statements.push(...session.statements);
        await commit(statements);
        return json({ account: { id: ceremony.account_id, displayName: ceremony.display_name } satisfies Account }, 200, finishedCookies(origin, session.secret));
      }
      if (path === '/api/account/authentication/options') {
        emptySchema.parse(await body(request, readBody));
        const options = await generateAuthenticationOptions({ rpID: origin.rpId, userVerification: 'required', timeout: CEREMONY_SECONDS * 1000 });
        const secret = await begin(request, { purpose: 'authentication', challenge: options.challenge, origin: origin.origin, rp_id: origin.rpId, account_id: null, user_handle: null, display_name: null, expires_at: Date.now() + CEREMONY_SECONDS * 1000, session_token_hash: null });
        return json({ options }, 200, [cookie(CEREMONY_COOKIE, secret, CEREMONY_SECONDS, origin.secure)]);
      }
      if (path === '/api/account/authentication/verify') {
        const ceremony = await consume(request, 'authentication', origin);
        claimedHash = ceremony.token_hash;
        const data = authenticationResponseSchema.parse(await body(request, readBody));
        const response: AuthenticationResponseJSON = data.response;
        requireCredentialContext(response);
        const key = await db.prepare('SELECT * FROM lab_passkeys WHERE id=? AND rp_id=?').bind(response.id, origin.rpId).first<PasskeyRow>();
        const user = key ? await db.prepare('SELECT * FROM lab_accounts WHERE id=?').bind(key.account_id).first<AccountRow>() : null;
        // The library verifies the signature, but the RP must bind discoverable userHandle to its account.
        if (!key || !user || response.response.userHandle !== user.user_handle) throw new AccountRequestError(400, 'verification_failed', 'The passkey could not be verified. Start again.');
        const result = await verifyAuthenticationResponse({ response, expectedChallenge: ceremony.challenge, expectedOrigin: origin.origin, expectedRPID: origin.rpId,
          credential: { id: key.id, publicKey: decode(key.public_key), counter: key.counter, transports: JSON.parse(key.transports) as string[] }, requireUserVerification: true });
        if (!result.verified) throw new AccountRequestError(400, 'verification_failed', 'The passkey could not be verified. Start again.');
        const session = await newSession(request, user.id, origin, ceremony, key);
        session.statements.push(db.prepare('UPDATE lab_passkeys SET counter=?,backed_up=?,last_used_at=? WHERE id=? AND counter=?')
          .bind(result.authenticationInfo.newCounter, Number(result.authenticationInfo.credentialBackedUp), Date.now(), key.id, key.counter));
        await commit(session.statements);
        return json({ account: account(user) }, 200, finishedCookies(origin, session.secret));
      }
      return json({ error: 'not_found', message: 'This account route does not exist.' }, 404);
    } catch (error) {
      const cookies = verification && approvedOrigin ? finishedCookies(approvedOrigin) : [];
      if (claimedHash) {
        try { await db.prepare('DELETE FROM lab_auth_ceremonies WHERE token_hash=? AND claimed=1').bind(claimedHash).run(); } catch { /* Expiry also removes a failed claim; no authentication can reuse it. */ }
      }
      if (error instanceof AccountRequestError) return json({ error: error.code, message: error.message }, error.statusCode, cookies);
      if (error instanceof z.ZodError || verification) return json({ error: 'verification_failed', message: 'The passkey request could not be accepted. Start again.' }, 400, cookies);
      return json({ error: 'account_unavailable', message: 'The account service could not complete this request.' }, 500, cookies);
    }
  }
  return { handle, accountForRequest, requireWriteOrigin };
}
