import { z } from 'zod'
import { DEFAULT_EXPERIMENT, EXPERIMENTS } from '../shared/experiments'
import type { LabSession } from '../shared/types'

/** Only the D1 operations used by this API; tests provide real SQLite statements. */
export interface LabStatement {
  bind(...values: (string | number)[]): LabStatement
  first<T>(): Promise<T | null>
  run(): Promise<{ meta: { changes: number } }>
  all(): Promise<unknown>
}

export interface LabDatabase {
  prepare(query: string): LabStatement
}

const uuid = z.string().uuid()
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const patchSchema = z.object({
  selectedIndex: z.number().int().nonnegative().optional(),
  alternate: z.enum(['A', 'C', 'G', 'T']).optional(),
  view: z.enum(['cell', 'dna', 'rna']).optional(),
  compare: z.boolean().optional(),
  progress: z.number().min(0).max(1).optional(),
  revision,
}).strict()
const createSchema = z.object({ experimentId: z.string().min(1).max(100).optional() }).strict()
// Hosted clients must supply a revision for every mutation, including run/reset.
const actionSchema = z.object({ revision }).strict()
const BODY_LIMIT = 16 * 1024

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  })
}

class RequestFailure extends Error {
  constructor(public status: number, message: string, public code = 'invalid_request') {
    super(message)
  }
}

async function body(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') || 0)
  if (length > BODY_LIMIT) throw new RequestFailure(413, 'Request is too large.', 'body_too_large')
  if (!request.body) return {}
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') throw new RequestFailure(415, 'Use JSON for requests.')

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > BODY_LIMIT) {
        await reader.cancel()
        throw new RequestFailure(413, 'Request is too large.', 'body_too_large')
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new RequestFailure(400, 'Invalid JSON.')
  }
}

async function load(db: LabDatabase, id: string): Promise<LabSession | undefined> {
  const row = await db.prepare('SELECT payload FROM lab_sessions WHERE id=?').bind(id).first<{ payload: string }>()
  return row ? JSON.parse(row.payload) as LabSession : undefined
}

/** Returns undefined if another request won the atomic revision check. */
async function save(db: LabDatabase, previous: LabSession, changes: Partial<LabSession>): Promise<LabSession | undefined> {
  if (previous.revision >= Number.MAX_SAFE_INTEGER) {
    throw new RequestFailure(409, 'This session reached its revision limit. Create a new session.', 'revision_limit')
  }
  const next: LabSession = {
    ...previous,
    ...changes,
    id: previous.id,
    revision: previous.revision + 1,
    updatedAt: new Date().toISOString(),
  }
  const result = await db.prepare('UPDATE lab_sessions SET payload=?, revision=?, updated_at=? WHERE id=? AND revision=?')
    .bind(JSON.stringify(next), next.revision, next.updatedAt, next.id, previous.revision).run()
  return result.meta.changes === 1 ? next : undefined
}

async function budget(db: LabDatabase, request: Request): Promise<void> {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
  const hash = Array.from(new Uint8Array(digest)).map(n => n.toString(16).padStart(2, '0')).join('')
  const minute = Math.floor(Date.now() / 60000)
  const row = await db.prepare('INSERT INTO lab_request_limits (key, count, expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count')
    .bind(`${hash}:${minute}`, minute + 2).first<{ count: number }>()
  if (!row) throw new Error('Request limit counter was not persisted.')
  if (row.count > 180) throw new RequestFailure(429, 'Too many requests. Try again shortly.', 'rate_limit')
  if (row.count === 1) await db.prepare('DELETE FROM lab_request_limits WHERE expires < ?').bind(minute).run()
}

async function conflict(db: LabDatabase, id: string): Promise<Response> {
  return json({
    error: 'revision_conflict',
    message: 'This session changed. Latest revision is available.',
    session: await load(db, id),
  }, 409)
}

/** Creates a request handler bound to persistent storage, without loading platform bindings. */
export function createLabHandler(db: LabDatabase | undefined): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      const pathname = url.pathname
      const method = request.method
      if (!db) return json({ error: 'storage_unavailable', message: 'The lab is starting. Please retry shortly.' }, 503)
      if (method === 'GET' && pathname === '/api/health') {
        await db.prepare('SELECT 1 FROM lab_sessions LIMIT 1').all()
        return json({ status: 'ok', storage: 'd1', mode: 'hosted', predictionMode: 'curated-replay' })
      }
      if (method === 'GET' && pathname === '/api/experiments') return json(EXPERIMENTS)
      if (method === 'GET' && pathname === '/api/openapi.json') {
        const { openApiDocument } = await import('../lab/openapi')
        return json({ ...openApiDocument, servers: [{ url: 'https://helix-dna-lab.higgsfield.app' }] })
      }
      if (!['GET', 'POST', 'PATCH'].includes(method)) {
        return json({ error: 'method_not_allowed', message: 'Method not allowed.' }, 405, { Allow: 'GET, POST, PATCH' })
      }
      if (method !== 'GET') {
        const origin = request.headers.get('origin')
        if (origin && origin !== url.origin) throw new RequestFailure(403, 'Cross-site changes are not allowed.')
      }
      await budget(db, request)
      if (pathname === '/api/sessions' && method === 'POST') {
        const data = createSchema.parse(await body(request))
        const experiment = data.experimentId ? EXPERIMENTS.find(e => e.id === data.experimentId) : DEFAULT_EXPERIMENT
        if (!experiment) throw new RequestFailure(400, 'Choose a published experiment.', 'unknown_experiment')
        const now = new Date().toISOString()
        const session: LabSession = {
          id: crypto.randomUUID(), experimentId: experiment.id,
          selectedIndex: experiment.defaultIndex, alternate: experiment.alternate,
          view: 'cell', compare: false, progress: 0, status: 'ready',
          revision: 0, createdAt: now, updatedAt: now,
        }
        await db.prepare('INSERT INTO lab_sessions (id,payload,revision,updated_at) VALUES (?,?,?,?)')
          .bind(session.id, JSON.stringify(session), 0, now).run()
        return json({ session }, 201)
      }
      const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(run|reset|export))?$/)
      if (!match) return json({ error: 'not_found', message: 'This route does not exist.' }, 404)
      const id = uuid.parse(match[1])
      const action = match[2]
      const session = await load(db, id)
      if (!session) return json({ error: 'session_not_found', message: 'This session does not exist.' }, 404)
      const experiment = EXPERIMENTS.find(e => e.id === session.experimentId)
      if (!experiment) throw new RequestFailure(404, 'Experiment unavailable.')
      if (method === 'GET' && !action) return json({ session })
      if (method === 'GET' && action === 'export') {
        return json({
          format: 'dna-lab-session', version: '1.0', exportedAt: new Date().toISOString(), session, experiment,
          scientificProvenance: {
            mode: session.status === 'unchanged' ? 'unchanged reference control' : 'curated educational replay',
            liveModelUsed: false,
            sequenceKind: experiment.sequenceKind,
            sequenceNotice: experiment.sequenceKind === 'illustrative'
              ? 'This displayed sequence is illustrative and must not be interpreted as a genomic reference coordinate.'
              : 'The displayed sequence is a reference excerpt; consult its cited source for coordinates and assembly.',
            result: session.status === 'replayed'
              ? 'The selected edit matches this curated educational example. Its mechanism is replayed from cited evidence; no live prediction or numeric score was generated.'
              : session.status === 'unchanged'
                ? 'The selected alternate is identical to the reference base. The DNA sequence is unchanged: this is a reference control, not a mutation. No model was called and no molecular or organism-level effect was inferred.'
                : session.status === 'unscored'
                  ? 'This edit has no model result. No molecular or organism-level effect has been inferred.'
                  : 'This session has not run its current edit.',
            evidence: experiment.evidence, limitation: experiment.limitation, sources: experiment.sources,
          },
        }, 200, { 'Content-Disposition': 'attachment; filename="helix-experiment.json"' })
      }
      if (method === 'PATCH' && !action) {
        const patch = patchSchema.parse(await body(request))
        if (patch.revision !== session.revision) return await conflict(db, id)
        if (patch.selectedIndex !== undefined && patch.selectedIndex >= experiment.referenceSequence.length) {
          throw new RequestFailure(400, 'Select a letter within the displayed sequence.', 'index_out_of_range')
        }
        const { revision: _revision, ...changes } = patch
        const changed = (changes.selectedIndex !== undefined && changes.selectedIndex !== session.selectedIndex)
          || (changes.alternate !== undefined && changes.alternate !== session.alternate)
        const next = await save(db, session, changed ? { ...changes, status: 'ready', progress: 0 } : changes)
        return next ? json({ session: next }) : await conflict(db, id)
      }
      if (method === 'POST' && (action === 'run' || action === 'reset')) {
        const data = actionSchema.parse(await body(request))
        if (data.revision !== session.revision) return await conflict(db, id)
        const unchanged = session.alternate === experiment.referenceSequence[session.selectedIndex]
        const curated = !unchanged && session.selectedIndex === experiment.defaultIndex && session.alternate === experiment.alternate
        const changes: Partial<LabSession> = action === 'reset'
          ? { selectedIndex: experiment.defaultIndex, alternate: experiment.alternate, view: 'cell', compare: false, progress: 0, status: 'ready' }
          : { status: unchanged ? 'unchanged' : curated ? 'replayed' : 'unscored', progress: 0, ...(curated ? { view: 'rna', compare: true } : {}) }
        const next = await save(db, session, changes)
        return next ? json({ session: next }) : await conflict(db, id)
      }
      return json({ error: 'method_not_allowed', message: 'Method not allowed.' }, 405)
    } catch (error) {
      if (error instanceof z.ZodError) return json({ error: 'validation_error', message: 'The request contains invalid fields.' }, 400)
      if (error instanceof RequestFailure) {
        return json({ error: error.code, message: error.message }, error.status, error.status === 429 ? { 'Retry-After': '60' } : {})
      }
      return json({ error: 'internal_error', message: 'The lab could not complete this request. Please retry.' }, 500)
    }
  }
}

/** The deployed entry still obtains the platform D1 binding on every request. */
export async function handleLab(request: Request): Promise<Response> {
  try {
    const { bindings } = await import('./bindings.server')
    return await createLabHandler(bindings().DB)(request)
  } catch {
    return json({ error: 'storage_unavailable', message: 'The lab is starting. Please retry shortly.' }, 503)
  }
}
