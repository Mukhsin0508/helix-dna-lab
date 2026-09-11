import { z } from 'zod';
import type { AuthDatabase } from './auth-database.ts';
import { AccountRequestError, type AccountService } from './auth.server.ts';
import {
  INTEGRATION_TOKEN_ACTIVE_LIMIT, INTEGRATION_TOKEN_BODY_LIMIT, integrationScopes,
  integrationTokenCreateSchema, type IntegrationIdentity, type IntegrationScope,
  type IntegrationTokenCreated, type IntegrationTokenSummary,
} from './integration-tokens.ts';

type Accounts = Pick<AccountService, 'accountForRequest' | 'requireWriteOrigin' | 'requireApprovedOrigin'>;
interface TokenRow {
  id: string; account_id: string; origin: string; label: string; access: 'read' | 'write';
  created_at: number; expires_at: number; last_used_at: number | null;
}
export interface IntegrationTokenService {
  handle(request: Request, readBody: (request: Request) => Promise<unknown>): Promise<Response | undefined>;
  /** An invalid bearer never falls back to a cookie session. */
  authorize(request: Request, scope: IntegrationScope): Promise<IntegrationIdentity>;
}
export const INTEGRATION_TOKEN_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lab_integration_tokens (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES lab_accounts(id),
    token_hash TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, label TEXT NOT NULL,
    access TEXT NOT NULL CHECK(access IN ('read','write')), created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK(expires_at>created_at), last_used_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS lab_integration_tokens_account ON lab_integration_tokens(account_id,expires_at)',
];
const databaseNow = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const idSchema = z.string().uuid();
const secretPattern = /^helix_[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
async function hash(secret: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))));
}
function sessionSecret(request: Request): string | null {
  const values = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith('helix_session='));
  if (values.length !== 1) return null;
  const value = values[0].slice('helix_session='.length);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function summary(row: TokenRow): IntegrationTokenSummary {
  return { id: row.id, label: row.label, scopes: integrationScopes(row.access),
    createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString() };
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function unauthorized(): AccountRequestError {
  return new AccountRequestError(401, 'invalid_integration_token', 'A valid integration token is required.');
}
function signIn(): AccountRequestError {
  return new AccountRequestError(401, 'authentication_required', 'Sign in to manage integration tokens.');
}
async function readInput(request: Request, readBody: (request: Request) => Promise<unknown>): Promise<unknown> {
  try { return await readBody(request); }
  catch (error) {
    if (error instanceof AccountRequestError) throw error;
    const failure = error as { status?: unknown; statusCode?: unknown } | null;
    const status = failure?.statusCode ?? failure?.status;
    // Preserve body-parser failures from either hosting adapter without echoing its error details.
    if (error instanceof SyntaxError || status === 400) throw new AccountRequestError(400, 'invalid_request', 'Use a valid JSON token request.');
    if (status === 413) throw new AccountRequestError(413, 'body_too_large', 'The token request is too large.');
    if (status === 415) throw new AccountRequestError(415, 'invalid_content_type', 'Use JSON for token requests.');
    throw error;
  }
}

/** Private integration credentials share the account database and never grant account-management access. */
export function createIntegrationTokenService(db: AuthDatabase, accounts: Accounts): IntegrationTokenService {
  let initialized: Promise<void> | undefined;
  function ensure(): Promise<void> {
    if (!initialized) initialized = (async () => {
      for (const sql of INTEGRATION_TOKEN_SCHEMA) await db.prepare(sql).run();
    })().catch(error => { initialized = undefined; throw error; });
    return initialized;
  }

  async function authorize(request: Request, scope: IntegrationScope): Promise<IntegrationIdentity> {
    const origin = accounts.requireApprovedOrigin(request);
    if (request.headers.has('origin') && request.headers.get('origin') !== origin) throw new AccountRequestError(403, 'origin_not_allowed', 'This request must come from the same lab website.');
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) throw unauthorized();
    const secret = authorization.slice(7);
    if (!secretPattern.test(secret)) throw unauthorized();
    await ensure();
    const digest = await hash(secret);
    // Lookup the token before joining accounts: a fresh database has no account tables yet.
    const row = await db.prepare(`SELECT id,account_id,origin,label,access,created_at,expires_at,last_used_at
      FROM lab_integration_tokens WHERE token_hash=? AND origin=? AND expires_at>${databaseNow}`)
      .bind(digest, origin).first<TokenRow>();
    if (!row) throw unauthorized();
    const scopes = integrationScopes(row.access);
    if (!scopes.includes(scope)) throw new AccountRequestError(403, 'insufficient_scope', 'This integration token does not allow that action.');
    const owner = await db.prepare('SELECT id,display_name FROM lab_accounts WHERE id=?')
      .bind(row.account_id).first<{ id: string; display_name: string }>();
    if (!owner) throw unauthorized();
    // A concurrent revocation or expiry that wins before this use is recorded fails authorization.
    const used = await db.prepare(`UPDATE lab_integration_tokens SET last_used_at=${databaseNow}
      WHERE id=? AND token_hash=? AND account_id=? AND origin=? AND access=? AND expires_at>${databaseNow}`)
      .bind(row.id, digest, owner.id, origin, row.access).run();
    if (used.meta.changes !== 1) throw unauthorized();
    return { account: { id: owner.id, displayName: owner.display_name }, scopes };
  }

  async function handle(request: Request, readBody: (request: Request) => Promise<unknown>): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    const isList = path === '/api/account/tokens';
    const item = path.match(/^\/api\/account\/tokens\/([^/]+)$/);
    const identity = path === '/api/integrations/identity';
    if (!isList && !item && !identity) return undefined;
    try {
      if (identity) {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed', message: 'Method not allowed.' }, 405);
        return json(await authorize(request, 'analyses:read'));
      }
      // Even a valid bearer paired with an owner cookie must not manage credentials.
      if (request.headers.has('authorization')) throw new AccountRequestError(403, 'cookie_session_required', 'Use your signed-in browser to manage integration tokens.');
      const origin = accounts.requireApprovedOrigin(request);
      const current = await accounts.accountForRequest(request);
      if (!current) throw signIn();
      if (request.method !== 'GET') accounts.requireWriteOrigin(request);
      if (!(isList ? ['GET', 'POST'] : ['DELETE']).includes(request.method)) return json({ error: 'method_not_allowed', message: 'Method not allowed.' }, 405);
      await ensure();
      if (isList && request.method === 'GET') {
        const rows = await db.prepare(`SELECT id,account_id,origin,label,access,created_at,expires_at,last_used_at
          FROM lab_integration_tokens WHERE account_id=? AND expires_at>${databaseNow} ORDER BY created_at DESC,id DESC`)
          .bind(current.id).all<TokenRow>();
        return json({ tokens: rows.results.map(summary) });
      }
      if (isList) {
        const body = await readInput(request, readBody);
        if (new TextEncoder().encode(JSON.stringify(body) ?? '').byteLength > INTEGRATION_TOKEN_BODY_LIMIT) throw new AccountRequestError(413, 'body_too_large', 'The token request is too large.');
        const input = integrationTokenCreateSchema.parse(body);
        const session = sessionSecret(request);
        if (!session) throw signIn();
        const now = Date.now();
        const row: TokenRow = { id: crypto.randomUUID(), account_id: current.id, origin, label: input.label,
          access: input.access, created_at: now, expires_at: now + input.expiresInDays * 86_400_000, last_used_at: null };
        const token = `helix_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
        const sessionHash = await hash(session);
        // Both session validity and the active-account cap are evaluated atomically at insertion.
        const result = await db.prepare(`INSERT INTO lab_integration_tokens
          (id,account_id,token_hash,origin,label,access,created_at,expires_at,last_used_at)
          SELECT ?,s.account_id,?,?,?,?,?,?,NULL FROM lab_auth_sessions s
          WHERE s.token_hash=? AND s.account_id=? AND s.origin=? AND s.expires_at>${databaseNow}
            AND (SELECT COUNT(*) FROM lab_integration_tokens t WHERE t.account_id=s.account_id AND t.expires_at>${databaseNow})<?`)
          .bind(row.id, await hash(token), origin, row.label, row.access, row.created_at, row.expires_at,
            sessionHash, current.id, origin, INTEGRATION_TOKEN_ACTIVE_LIMIT).run();
        if (result.meta.changes !== 1) {
          const activeSession = await db.prepare(`SELECT account_id FROM lab_auth_sessions
            WHERE token_hash=? AND account_id=? AND origin=? AND expires_at>${databaseNow}`)
            .bind(sessionHash, current.id, origin).first<{ account_id: string }>();
          if (!activeSession) throw signIn();
          throw new AccountRequestError(429, 'integration_token_limit', 'Revoke an active token before creating another.');
        }
        return json({ token, details: summary(row) } satisfies IntegrationTokenCreated, 201);
      }
      const id = idSchema.parse(item![1]);
      const removed = await db.prepare('DELETE FROM lab_integration_tokens WHERE id=? AND account_id=?')
        .bind(id, current.id).run();
      if (removed.meta.changes !== 1) return json({ error: 'token_not_found', message: 'This integration token is unavailable.' }, 404);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) {
      if (error instanceof AccountRequestError) return json({ error: error.code, message: error.message }, error.statusCode);
      if (error instanceof z.ZodError) return json({ error: 'invalid_request', message: 'Check the token label, access and expiry.' }, 400);
      return json({ error: 'integration_token_error', message: 'The integration token request could not be completed.' }, 500);
    }
  }
  return { handle, authorize };
}
