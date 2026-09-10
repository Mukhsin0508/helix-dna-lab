import {
  analysisCreateSchema, analysisIdSchema, analysisPatchSchema, newAnalysis,
  type AnalysisRecord,
} from '../shared/analysis-record';
import type { LabDatabase } from './lab.server';

const initialized = new WeakMap<LabDatabase, Promise<void>>();
async function ensureTable(db: LabDatabase): Promise<void> {
  let pending = initialized.get(db);
  if (!pending) {
    pending = db.prepare(`CREATE TABLE IF NOT EXISTS lab_analyses (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>=0), updated_at TEXT NOT NULL
    )`).run().then(() => undefined).catch(error => { initialized.delete(db); throw error; });
    initialized.set(db, pending);
  }
  await pending;
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
async function load(db: LabDatabase, id: string): Promise<AnalysisRecord | undefined> {
  const row = await db.prepare('SELECT payload FROM lab_analyses WHERE id=?').bind(id).first<{ payload: string }>();
  return row ? JSON.parse(row.payload) as AnalysisRecord : undefined;
}

/** Uses the hosted API's origin validation, bounded request bodies and request budget. */
export async function handleAnalysisRequest(
  db: LabDatabase, request: Request, readBody: (request: Request) => Promise<unknown>,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === '/api/analyses' && request.method === 'POST') {
    const input = analysisCreateSchema.parse(await readBody(request));
    await ensureTable(db);
    const analysis = newAnalysis(input, crypto.randomUUID());
    await db.prepare('INSERT INTO lab_analyses (id,payload,revision,updated_at) VALUES (?,?,?,?)')
      .bind(analysis.id, JSON.stringify(analysis), 0, analysis.updatedAt).run();
    return json({ analysis }, 201);
  }
  const match = path.match(/^\/api\/analyses\/([^/]+)$/);
  if (!match) return undefined;
  const id = analysisIdSchema.parse(match[1]);
  if (!['GET', 'PATCH'].includes(request.method)) return json({ error: 'method_not_allowed', message: 'Method not allowed.' }, 405);
  const patch = request.method === 'PATCH' ? analysisPatchSchema.parse(await readBody(request)) : undefined;
  await ensureTable(db);
  const previous = await load(db, id);
  if (!previous) return json({ error: 'analysis_not_found', message: 'This analysis does not exist.' }, 404);
  if (!patch) return json({ analysis: previous });
  if (patch.revision === previous.revision && previous.revision < Number.MAX_SAFE_INTEGER) {
    const next: AnalysisRecord = { ...previous, dataset: patch.dataset, settings: patch.settings,
      revision: previous.revision + 1, updatedAt: new Date().toISOString() };
    const result = await db.prepare('UPDATE lab_analyses SET payload=?,revision=?,updated_at=? WHERE id=? AND revision=?')
      .bind(JSON.stringify(next), next.revision, next.updatedAt, id, previous.revision).run();
    if (result.meta.changes === 1) return json({ analysis: next });
  }
  return json({ error: 'revision_conflict', message: 'This analysis changed in another window. Your local edits are preserved; save a copy or load the latest version.',
    analysis: await load(db, id) }, 409);
}
