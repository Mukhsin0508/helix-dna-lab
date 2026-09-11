import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.ts';
import { AUTH_SCHEMA_STATEMENTS, type AuthDatabase, type AuthResult, type AuthStatement, type AuthValue } from '../shared/auth-database.ts';
import type { AnalysisInput, AnalysisRecord } from '../shared/analysis-record.ts';
import type { ScoreDataset } from '../shared/analysis.ts';

const migration = readFileSync(new URL('../deploy/higgsfield/migrations/0002_helix.sql', import.meta.url), 'utf8');
export const ORIGINS = { local: 'http://127.0.0.1:4191', cloud: 'https://helix-dna-lab.higgsfield.app' } as const;
export type Backend = keyof typeof ORIGINS;
export type Actor = 'owner' | 'other' | 'anonymous';
export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type TestHeaders = Record<string, string | null>;
export type Call = (path: string, method?: Method, data?: unknown, headers?: TestHeaders, raw?: boolean) => Promise<Response>;
export interface TestIdentity { id: string; token: string; tokenHash: string }

class SqliteStatement implements AuthStatement {
  constructor(readonly db: SqliteD1, readonly sql: string, readonly values: AuthValue[] = []) {}
  bind(...values: AuthValue[]): SqliteStatement { return new SqliteStatement(this.db, this.sql, values); }
  async first<T>(): Promise<T | null> {
    const result = this.db.sqlite.prepare(this.sql).get(...this.values);
    if (/^\s*SELECT\b/i.test(this.sql) && /FROM lab_analyses\b/i.test(this.sql) && /payload/i.test(this.sql)) await this.db.afterAnalysisRead?.();
    return result ? result as T : null;
  }
  async run(): Promise<AuthResult> { return this.execute(); }
  execute(): AuthResult { return { meta: { changes: Number(this.db.sqlite.prepare(this.sql).run(...this.values).changes) } }; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
}

/** D1's real SQL contract backed by SQLite; batches cannot interleave or partly commit. */
export class SqliteD1 implements AuthDatabase {
  readonly sqlite: DatabaseSync;
  afterAnalysisRead?: () => Promise<void>;
  constructor(path = ':memory:') {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.sqlite.exec(migration);
    for (const sql of AUTH_SCHEMA_STATEMENTS) this.sqlite.exec(sql);
  }
  prepare(sql: string): SqliteStatement { return new SqliteStatement(this, sql); }
  async batch(statements: AuthStatement[]): Promise<AuthResult[]> {
    const own = statements.map(statement => {
      if (!(statement instanceof SqliteStatement) || statement.db !== this) throw new Error('A batch must belong to its database.');
      return statement;
    });
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = own.map(statement => statement.execute());
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.sqlite.isTransaction) this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void { this.sqlite.close(); }
}

const cloudPath = new URL('../deploy/higgsfield/src/lib/lab.server.ts', import.meta.url).href;
const { createLabHandler }: {
  createLabHandler(db: AuthDatabase): (request: Request) => Promise<Response>;
} = await import(cloudPath);

/** Seed valid opaque test sessions, never an authentication bypass in a request handler. */
function identity(db: SqliteD1, origin: string, who: 'owner' | 'other'): TestIdentity {
  const id = who === 'owner' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002';
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('base64url');
  const now = Date.now();
  db.sqlite.prepare('INSERT OR IGNORE INTO lab_accounts (id,display_name,user_handle,created_at) VALUES (?,?,?,?)')
    .run(id, `Test ${who}`, randomBytes(32).toString('base64url'), now);
  db.sqlite.prepare('INSERT INTO lab_auth_sessions (token_hash,account_id,origin,created_at,expires_at) VALUES (?,?,?,?,?)')
    .run(tokenHash, id, origin, now, now + 3_600_000);
  return { id, token, tokenHash };
}

export interface Harness {
  call: Call;
  as(actor: Actor, ...args: Parameters<Call>): Promise<Response>;
  db: SqliteD1;
  owner: TestIdentity;
  other: TestIdentity;
  origin: string;
  close(): Promise<void>;
}

export async function harness(kind: Backend, databasePath?: string): Promise<Harness> {
  const directory = !databasePath || databasePath === ':memory:' ? await mkdtemp(join(tmpdir(), 'helix-authenticated-api-')) : null;
  const path = directory ? join(directory, 'lab.sqlite') : databasePath!;
  const origin = ORIGINS[kind];
  const db = new SqliteD1(path);
  const owner = identity(db, origin, 'owner');
  const other = identity(db, origin, 'other');
  const app = kind === 'local' ? await createApp(path) : null;
  const handler = kind === 'cloud' ? createLabHandler(db) : null;
  const as = async (actor: Actor, url: string, method: Method = 'GET', data?: unknown, extra: TestHeaders = {}, raw = false): Promise<Response> => {
    const headers = new Headers({ host: new URL(origin).host, origin });
    if (actor !== 'anonymous') headers.set('cookie', `helix_session=${actor === 'owner' ? owner.token : other.token}`);
    if (data !== undefined) headers.set('content-type', 'application/json');
    for (const [key, value] of Object.entries(extra)) value === null ? headers.delete(key) : headers.set(key, value);
    const body = data === undefined ? undefined : raw ? String(data) : JSON.stringify(data);
    if (app) {
      const result = await app.inject({ url, method, headers: Object.fromEntries(headers), ...(body === undefined ? {} : { payload: body }) });
      return new Response(result.statusCode === 204 ? null : result.body, { status: result.statusCode, headers: result.headers as Record<string, string> });
    }
    return handler!(new Request(origin + url, { method, headers, ...(body === undefined ? {} : { body }) }));
  };
  return { db, owner, other, origin, as, call: (...args) => as('owner', ...args), close: async () => {
    await app?.close(); db.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  } };
}

export async function analysisOf(response: Response, expected = 200, mode: 'owner' | 'legacy-public' = 'owner'): Promise<AnalysisRecord> {
  assert.equal(response.status, expected, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json() as { analysis: AnalysisRecord; access: { mode: string; canWrite: boolean } };
  assert.ok(body.analysis);
  assert.deepEqual(body.access, { mode, canWrite: mode === 'owner' });
  return body.analysis;
}

export function scoreInput(title = 'Imported T-cell scores'): AnalysisInput & { dataset: ScoreDataset } {
  return {
    dataset: {
      schemaVersion: 1, id: 'imported-tcell-example', title, kind: 'scores',
      provenance: {
        sourceUrl: 'https://www.alphagenomedocs.com/colabs/batch_variant_scoring.html',
        sourceLabel: 'Official published AlphaGenome example', assembly: 'GRCh38',
        model: 'AlphaGenome; exact historical version unavailable', context: 'T-cell', mode: 'imported',
      },
      rows: [{
        variant: 'chr16:636337:G>A', biosample: 'T-cell', modality: 'RNA_SEQ',
        scorer: 'GeneMaskLFCScorer(requested_output=RNA_SEQ)',
        score: 0.08991122245788574, quantile: 0.9998994469642639,
        gene: 'METTL26', track: 'CL:0000084 polyA plus RNA-seq',
      }, {
        variant: 'chr3:58394738:A>T', biosample: 'T-cell', modality: 'ATAC',
        scorer: 'CenterMaskScorer(requested_output=ATAC, width=501, aggregation_type=DIFF_LOG2_SUM)',
        score: -0.003777742385864258, quantile: -0.21573995053768158,
        track: 'CL:0000084 ATAC-seq',
      }],
    },
    settings: {
      chart: 'bars', title: 'Published expression comparison', modality: 'RNA_SEQ',
      scorer: 'GeneMaskLFCScorer(requested_output=RNA_SEQ)',
      track: 'CL:0000084 polyA plus RNA-seq', gene: 'METTL26', metric: 'score', limit: 12, variant: '',
    },
  };
}

