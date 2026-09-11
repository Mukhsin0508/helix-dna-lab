import { z } from 'zod';
import type { AuthDatabase } from './auth-database.ts';
import type { createAccountService } from './auth.server.ts';
import {
  analysisCreateSchema, analysisPatchSchema, analysisDeleteSchema, analysisIdSchema, newAnalysis,
  type AnalysisRecord, type AnalysisEnvelope, type AnalysisSummary,
} from './analysis-record.ts';

type Accounts = Pick<ReturnType<typeof createAccountService>, 'accountForRequest' | 'requireWriteOrigin'>;
type Stored = { payload: string; owner_id: string | null };
const initialized = new WeakMap<AuthDatabase, Promise<void>>();
/** Preserve every old record byte-for-byte. Unowned historical links remain read-only. */
export async function ensureAnalysisTable(db: AuthDatabase): Promise<void> {
  let pending = initialized.get(db);
  if (!pending) {
    pending = (async () => {
      await db.prepare(`CREATE TABLE IF NOT EXISTS lab_analyses (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0),
        updated_at TEXT NOT NULL, owner_id TEXT
      )`).run();
      const columns = await db.prepare('PRAGMA table_info(lab_analyses)').all<{ name: string }>();
      if (!columns.results.some(column => column.name === 'owner_id')) {
        try { await db.prepare('ALTER TABLE lab_analyses ADD COLUMN owner_id TEXT').run(); }
        catch (error) {
          const current = await db.prepare('PRAGMA table_info(lab_analyses)').all<{ name: string }>();
          if (!current.results.some(column => column.name === 'owner_id')) throw error;
        }
      }
      await db.prepare('CREATE INDEX IF NOT EXISTS lab_analyses_owner ON lab_analyses(owner_id,updated_at DESC,id DESC)').run();
    })().catch(error => { initialized.delete(db); throw error; });
    initialized.set(db, pending);
  }
  await pending;
}
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
const notFound = () => json({ error: 'analysis_not_found', message: 'This analysis is unavailable.' }, 404);
const signIn = () => json({ error: 'authentication_required', message: 'Sign in to save or manage analyses.' }, 401);
function envelope(row: Stored): AnalysisEnvelope {
  return { analysis: JSON.parse(row.payload) as AnalysisRecord,
    access: { mode: row.owner_id === null ? 'legacy-public' : 'owner', canWrite: row.owner_id !== null } };
}
async function load(db: AuthDatabase, id: string, owner: string | null): Promise<Stored | null> {
  return db.prepare('SELECT payload,owner_id FROM lab_analyses WHERE id=? AND (owner_id IS NULL OR owner_id=?)')
    .bind(id, owner).first<Stored>();
}
const cursorSchema = z.object({ updatedAt: z.string().datetime(), id: analysisIdSchema }).strict();
function decodeCursor(value: string | null): z.infer<typeof cursorSchema> | null {
  if (!value) return null;
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    return cursorSchema.parse(JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))));
  } catch { return cursorSchema.parse({}); }
}
function encodeCursor(row: AnalysisSummary): string {
  return btoa(JSON.stringify({ updatedAt: row.updatedAt, id: row.id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Identical owner checks and revision semantics for local SQLite and hosted D1. */
export async function handleAnalysisRequest(
  db: AuthDatabase, request: Request, readBody: (request: Request) => Promise<unknown>, accounts: Accounts,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const isList = url.pathname === '/api/analyses';
  const match = url.pathname.match(/^\/api\/analyses\/([^/]+)$/);
  if (!isList && !match) return undefined;
  const allowed = isList ? ['GET', 'POST'] : ['GET', 'PATCH', 'DELETE'];
  if (!allowed.includes(request.method)) return json({ error: 'method_not_allowed', message: 'Method not allowed.' }, 405);
  const account = await accounts.accountForRequest(request);
  if (request.method !== 'GET') {
    if (!account) return signIn();
    accounts.requireWriteOrigin(request);
  }
  if (isList && !account) return signIn();
  await ensureAnalysisTable(db);
  if (isList && request.method === 'GET') {
    const limit = z.coerce.number().int().min(1).max(100).parse(url.searchParams.get('limit') ?? 50);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const select = `SELECT id,json_extract(payload,'$.settings.title') AS title,
      json_extract(payload,'$.dataset.kind') AS kind,revision,updated_at AS updatedAt
      FROM lab_analyses WHERE owner_id=?`;
    const result = cursor
      ? await db.prepare(select + ' AND (updated_at<? OR (updated_at=? AND id<?)) ORDER BY updated_at DESC,id DESC LIMIT ?')
        .bind(account!.id, cursor.updatedAt, cursor.updatedAt, cursor.id, limit + 1).all<AnalysisSummary>()
      : await db.prepare(select + ' ORDER BY updated_at DESC,id DESC LIMIT ?').bind(account!.id, limit + 1).all<AnalysisSummary>();
    const analyses = result.results.slice(0, limit);
    return json({ analyses, nextCursor: result.results.length > limit ? encodeCursor(analyses[analyses.length - 1]) : null });
  }
  if (isList) {
    const analysis = newAnalysis(analysisCreateSchema.parse(await readBody(request)), crypto.randomUUID());
    await db.prepare('INSERT INTO lab_analyses (id,payload,revision,updated_at,owner_id) VALUES (?,?,?,?,?)')
      .bind(analysis.id, JSON.stringify(analysis), 0, analysis.updatedAt, account!.id).run();
    return json({ analysis, access: { mode: 'owner', canWrite: true } }, 201);
  }
  const id = analysisIdSchema.parse(match![1]);
  const row = await load(db, id, account?.id ?? null);
  if (!row) return notFound();
  if (request.method === 'GET') return json(envelope(row));
  if (row.owner_id === null) return json({ error: 'read_only_analysis', message: 'This public example is read-only. Save a private copy to keep changes.' }, 403);
  const previous = envelope(row).analysis;
  if (request.method === 'DELETE') {
    const { revision } = analysisDeleteSchema.parse(await readBody(request));
    const result = await db.prepare('DELETE FROM lab_analyses WHERE id=? AND owner_id=? AND revision=?')
      .bind(id, account!.id, revision).run();
    if (result.meta.changes === 1) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } else {
    const { revision, ...input } = analysisPatchSchema.parse(await readBody(request));
    if (previous.revision === revision && revision < Number.MAX_SAFE_INTEGER) {
      const next: AnalysisRecord = { ...previous, ...input, revision: revision + 1, updatedAt: new Date().toISOString() };
      const result = await db.prepare('UPDATE lab_analyses SET payload=?,revision=?,updated_at=? WHERE id=? AND owner_id=? AND revision=?')
        .bind(JSON.stringify(next), next.revision, next.updatedAt, id, account!.id, revision).run();
      if (result.meta.changes === 1) return json({ analysis: next, access: { mode: 'owner', canWrite: true } });
    }
  }
  const winner = await load(db, id, account!.id);
  if (!winner || winner.owner_id !== account!.id) return notFound();
  return json({ error: 'revision_conflict', message: 'This analysis changed in another window. Load the latest version or save a copy.', ...envelope(winner) }, 409);
}
