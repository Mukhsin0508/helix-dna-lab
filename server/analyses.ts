import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import {
  ANALYSIS_BODY_LIMIT, analysisCreateSchema, analysisPatchSchema, analysisIdSchema,
  newAnalysis, type AnalysisInput, type AnalysisRecord,
} from '../shared/analysis-record.ts';

/** Stores imported results and the exact figure recipe in a separate additive table. */
export class AnalysisStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS lab_analyses (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>=0), updated_at TEXT NOT NULL
      );`);
  }
  create(input: AnalysisInput): AnalysisRecord {
    const analysis = newAnalysis(input, randomUUID());
    this.db.prepare('INSERT INTO lab_analyses (id,payload,revision,updated_at) VALUES (?,?,?,?)')
      .run(analysis.id, JSON.stringify(analysis), 0, analysis.updatedAt);
    return analysis;
  }
  get(id: string): AnalysisRecord | undefined {
    const row = this.db.prepare('SELECT payload FROM lab_analyses WHERE id=?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as AnalysisRecord : undefined;
  }
  update(previous: AnalysisRecord, input: AnalysisInput): AnalysisRecord | undefined {
    if (previous.revision >= Number.MAX_SAFE_INTEGER) return undefined;
    const next: AnalysisRecord = { ...previous, ...input, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
    const result = this.db.prepare('UPDATE lab_analyses SET payload=?,revision=?,updated_at=? WHERE id=? AND revision=?')
      .run(JSON.stringify(next), next.revision, next.updatedAt, next.id, previous.revision);
    return result.changes === 1 ? next : undefined;
  }
  close(): void { this.db.close(); }
}

export function registerAnalysisRoutes(app: FastifyInstance, path: string): void {
  const store = new AnalysisStore(path);
  app.addHook('onClose', async () => { store.close(); });
  app.post('/api/analyses', { bodyLimit: ANALYSIS_BODY_LIMIT }, async (request, reply) => {
    return reply.code(201).send({ analysis: store.create(analysisCreateSchema.parse(request.body)) });
  });
  app.get<{ Params: { id: string } }>('/api/analyses/:id', async (request, reply) => {
    const analysis = store.get(analysisIdSchema.parse(request.params.id));
    return analysis ? { analysis } : reply.code(404).send({ error: 'analysis_not_found', message: 'This analysis does not exist.' });
  });
  app.patch<{ Params: { id: string } }>('/api/analyses/:id', { bodyLimit: ANALYSIS_BODY_LIMIT }, async (request, reply) => {
    const id = analysisIdSchema.parse(request.params.id);
    const { revision, ...input } = analysisPatchSchema.parse(request.body);
    const previous = store.get(id);
    if (!previous) return reply.code(404).send({ error: 'analysis_not_found', message: 'This analysis does not exist.' });
    const next = previous.revision === revision ? store.update(previous, input) : undefined;
    return next ? { analysis: next } : reply.code(409).send({
      error: 'revision_conflict',
      message: 'This analysis changed in another window. Your local edits are preserved; save a copy or load the latest version.',
      analysis: store.get(id),
    });
  });
}
