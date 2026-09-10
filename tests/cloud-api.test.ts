import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'
import { DEFAULT_EXPERIMENT } from '../shared/experiments.ts'
import type { LabSession, SessionEnvelope } from '../shared/types.ts'

// The deployment's Cloudflare binding module is deliberately not loaded in Node.
// Import the actual handler factory; every SQL query below executes in SQLite.
const handlerPath = new URL('../deploy/higgsfield/src/lib/lab.server.ts', import.meta.url).href
const { createLabHandler }: {
  createLabHandler(db: SqliteD1 | undefined): (request: Request) => Promise<Response>
} = await import(handlerPath)
const migration = readFileSync(new URL('../deploy/higgsfield/migrations/0002_helix.sql', import.meta.url), 'utf8')

class SqliteD1 {
  readonly sqlite: DatabaseSync
  beforeQuery?: (sql: string) => void
  afterSessionRead?: () => Promise<void>

  constructor(path = ':memory:') {
    this.sqlite = new DatabaseSync(path)
    this.sqlite.exec(migration)
  }

  prepare(sql: string) {
    const execute = (values: SQLInputValue[]) => ({
      bind: (...next: (string | number)[]) => execute(next),
      first: async <T>(): Promise<T | null> => {
        this.beforeQuery?.(sql)
        const result = this.sqlite.prepare(sql).get(...values)
        if (sql.startsWith('SELECT payload')) await this.afterSessionRead?.()
        return result ? result as T : null
      },
      run: async () => {
        this.beforeQuery?.(sql)
        const result = this.sqlite.prepare(sql).run(...values)
        return { meta: { changes: Number(result.changes) } }
      },
      all: async () => {
        this.beforeQuery?.(sql)
        return { results: this.sqlite.prepare(sql).all(...values) }
      },
    })
    return execute([])
  }

  close(): void { this.sqlite.close() }
}

type Handler = ReturnType<typeof createLabHandler>
const origin = 'https://helix-dna-lab.higgsfield.app'
function request(path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(origin + path, {
    method,
    headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
}
async function sessionOf(response: Response, status = 200): Promise<LabSession> {
  assert.equal(response.status, status)
  const result = await response.json() as SessionEnvelope
  assert.ok(result.session)
  return result.session
}
async function create(handler: Handler): Promise<LabSession> {
  return sessionOf(await handler(request('/api/sessions', 'POST', {})), 201)
}

function concurrentReadBarrier(db: SqliteD1): void {
  let arrivals = 0
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  db.afterSessionRead = async () => {
    arrivals += 1
    if (arrivals === 2) {
      db.afterSessionRead = undefined
      release()
    }
    await barrier
  }
}

test('cloud sessions persist across database reopen and remain independent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-d1-'))
  const path = join(directory, 'lab.sqlite')
  let db = new SqliteD1(path)
  try {
    const handler = createLabHandler(db)
    const initial = await create(handler)
    const other = await create(handler)
    assert.notEqual(initial.id, other.id)
    assert.equal(initial.view, 'cell')
    assert.equal(initial.revision, 0)
    const saved = await sessionOf(await handler(request(`/api/sessions/${initial.id}`, 'PATCH', {
      revision: 0, view: 'rna', compare: true, progress: 0.42,
    })))
    assert.equal(saved.revision, 1)
    assert.equal(saved.createdAt, initial.createdAt)
    assert.deepEqual(await sessionOf(await handler(request(`/api/sessions/${other.id}`))), other)
    db.close()
    db = new SqliteD1(path)
    const reopened = createLabHandler(db)
    assert.deepEqual(await sessionOf(await reopened(request(`/api/sessions/${initial.id}`))), saved)
    assert.deepEqual(await sessionOf(await reopened(request(`/api/sessions/${other.id}`))), other)
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('two requests reading the same revision cannot both commit', async () => {
  const db = new SqliteD1()
  try {
    const firstClient = createLabHandler(db)
    const secondClient = createLabHandler(db)
    const session = await create(firstClient)
    const path = `/api/sessions/${session.id}`
    concurrentReadBarrier(db)
    const results = await Promise.all([
      firstClient(request(path, 'PATCH', { revision: 0, alternate: 'T' })),
      secondClient(request(path + '/run', 'POST', { revision: 0 })),
    ])
    assert.deepEqual(results.map(response => response.status).sort(), [200, 409])
    const winner = await sessionOf(results.find(response => response.status === 200)!)
    const loser = await results.find(response => response.status === 409)!.json() as SessionEnvelope & { error: string }
    assert.equal(loser.error, 'revision_conflict')
    assert.deepEqual(loser.session, winner)
    assert.equal(winner.revision, 1)
    const stored = await sessionOf(await firstClient(request(path)))
    assert.deepEqual(stored, winner)
    const row = db.sqlite.prepare('SELECT revision, payload FROM lab_sessions WHERE id=?').get(session.id)!
    assert.equal(row.revision, winner.revision)
    assert.deepEqual(JSON.parse(row.payload as string), winner)
  } finally { db.close() }
})

test('stale or missing revisions and invalid edits cannot mutate saved state', async () => {
  const db = new SqliteD1()
  try {
    const handler = createLabHandler(db)
    const session = await create(handler)
    const path = `/api/sessions/${session.id}`
    const saved = await sessionOf(await handler(request(path, 'PATCH', { revision: 0, compare: true })))
    for (const payload of [
      { selectedIndex: -1, revision: 1 }, { selectedIndex: 1.5, revision: 1 },
      { selectedIndex: DEFAULT_EXPERIMENT.referenceSequence.length, revision: 1 },
      { alternate: 'N', revision: 1 }, { progress: 1.1, revision: 1 },
      { status: 'replayed', revision: 1 }, { id: crypto.randomUUID(), revision: 1 },
      { compare: false }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    ]) assert.equal((await handler(request(path, 'PATCH', payload))).status, 400)
    for (const action of ['/run', '/reset']) {
      assert.equal((await handler(request(path + action, 'POST', {}))).status, 400)
      assert.equal((await handler(request(path + action, 'POST'))).status, 400)
      const stale = await handler(request(path + action, 'POST', { revision: 0 }))
      assert.equal(stale.status, 409)
      assert.deepEqual((await stale.json() as SessionEnvelope).session, saved)
    }
    const stalePatch = await handler(request(path, 'PATCH', { revision: 0, compare: false }))
    assert.equal(stalePatch.status, 409)
    assert.deepEqual((await stalePatch.json() as SessionEnvelope).session, saved)
    assert.deepEqual(await sessionOf(await handler(request(path))), saved)
  } finally { db.close() }
})

test('curated replay, reference controls, arbitrary edits and reset retain honest state and provenance', async () => {
  const db = new SqliteD1()
  try {
    const handler = createLabHandler(db)
    const initial = await create(handler)
    const path = `/api/sessions/${initial.id}`
    let current = await sessionOf(await handler(request(path + '/run', 'POST', { revision: 0 })))
    assert.equal(current.status, 'replayed')
    assert.equal(current.progress, 0)
    assert.equal(current.view, 'rna')
    assert.equal(current.compare, true)
    current = await sessionOf(await handler(request(path, 'PATCH', { revision: current.revision, progress: 0.8 })))
    assert.equal(current.status, 'replayed')
    current = await sessionOf(await handler(request(path, 'PATCH', {
      revision: current.revision, alternate: DEFAULT_EXPERIMENT.referenceSequence[DEFAULT_EXPERIMENT.defaultIndex], progress: 1,
    })))
    assert.equal(current.status, 'ready')
    assert.equal(current.progress, 0)
    current = await sessionOf(await handler(request(path + '/run', 'POST', { revision: current.revision })))
    assert.equal(current.status, 'unchanged')
    let exportedResponse = await handler(request(path + '/export'))
    assert.match(exportedResponse.headers.get('content-disposition')!, /attachment/)
    let exported = await exportedResponse.json()
    assert.equal(exported.scientificProvenance.mode, 'unchanged reference control')
    assert.equal(exported.scientificProvenance.liveModelUsed, false)
    assert.match(exported.scientificProvenance.sequenceNotice, /reference excerpt/)
    assert.match(exported.scientificProvenance.result, /No model was called/)
    assert.deepEqual(exported.scientificProvenance.sources, DEFAULT_EXPERIMENT.sources)
    const reference = DEFAULT_EXPERIMENT.referenceSequence[0]
    const different = reference === 'A' ? 'C' : 'A'
    current = await sessionOf(await handler(request(path, 'PATCH', {
      revision: current.revision, selectedIndex: 0, alternate: different,
    })))
    assert.equal(current.status, 'ready')
    current = await sessionOf(await handler(request(path + '/run', 'POST', { revision: current.revision })))
    assert.equal(current.status, 'unscored')
    exported = await (await handler(request(path + '/export'))).json()
    assert.match(exported.scientificProvenance.result, /no model result/)
    assert.equal('score' in exported.session, false)
    const reset = await sessionOf(await handler(request(path + '/reset', 'POST', { revision: current.revision })))
    assert.equal(reset.id, initial.id)
    assert.equal(reset.createdAt, initial.createdAt)
    assert.equal(reset.selectedIndex, initial.selectedIndex)
    assert.equal(reset.alternate, initial.alternate)
    assert.equal(reset.view, 'cell')
    assert.equal(reset.compare, false)
    assert.equal(reset.status, 'ready')
    assert.equal(reset.progress, 0)
    assert.equal(reset.revision, current.revision + 1)
  } finally { db.close() }
})

test('create rejects empty IDs and malformed bodies instead of silently selecting a case', async () => {
  const db = new SqliteD1()
  try {
    const handler = createLabHandler(db)
    for (const data of [{ experimentId: '' }, { experimentId: 'absent' }, { extra: true }, null, []]) {
      assert.equal((await handler(request('/api/sessions', 'POST', data))).status, 400)
    }
    assert.equal((await handler(new Request(origin + '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken',
    }))).status, 400)
    assert.equal((await handler(new Request(origin + '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json-not-valid' }, body: '{}',
    }))).status, 415)
    assert.equal((await handler(request('/api/sessions', 'POST', {}, { origin: 'https://other.example' }))).status, 403)
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM lab_sessions').get()!.count, 0)
    assert.equal((await handler(request('/api/sessions', 'POST'))).status, 201)
    assert.equal((await handler(request('/api/sessions', 'POST', {}, { 'content-type': 'application/json; charset=utf-8' }))).status, 201)
  } finally { db.close() }
})

test('body limit applies to bytes even without Content-Length', async () => {
  const db = new SqliteD1()
  try {
    const handler = createLabHandler(db)
    const oversized = JSON.stringify({ experimentId: 'x'.repeat(16 * 1024) })
    const response = await handler(new Request(origin + '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: oversized,
    }))
    assert.equal(response.status, 413)
    assert.equal((await response.json()).error, 'body_too_large')
    const headerRejected = await handler(request('/api/sessions', 'POST', {}, { 'content-length': '20000' }))
    assert.equal(headerRejected.status, 413)
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM lab_sessions').get()!.count, 0)
  } finally { db.close() }
})

test('a database error while reloading a conflict returns JSON instead of rejecting the request', async () => {
  const db = new SqliteD1()
  try {
    const handler = createLabHandler(db)
    const session = await create(handler)
    let reads = 0
    db.beforeQuery = sql => {
      if (sql.startsWith('SELECT payload') && ++reads === 2) throw new Error('private database details')
    }
    const response = await handler(request(`/api/sessions/${session.id}`, 'PATCH', { revision: 8, compare: true }))
    assert.equal(response.status, 500)
    const content = await response.text()
    assert.match(content, /internal_error/)
    assert.doesNotMatch(content, /private database details/)
    db.beforeQuery = undefined
    assert.deepEqual(await sessionOf(await handler(request(`/api/sessions/${session.id}`))), session)
  } finally { db.close() }
})

test('storage failure is recoverable and an unsuccessful create does not claim persistence', async () => {
  assert.equal((await createLabHandler(undefined)(request('/api/sessions', 'POST', {}))).status, 503)
  const db = new SqliteD1()
  try {
    const handler = createLabHandler(db)
    db.beforeQuery = sql => { if (sql.startsWith('INSERT INTO lab_sessions')) throw new Error('disk write failed') }
    const response = await handler(request('/api/sessions', 'POST', {}))
    assert.equal(response.status, 500)
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM lab_sessions').get()!.count, 0)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  } finally { db.close() }
})

test('rate counter increments atomically and remains independent across client IPs', async () => {
  const db = new SqliteD1()
  try {
    const handler = createLabHandler(db)
    const ip = '198.51.100.7'
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))).toString('hex')
    const minute = Math.floor(Date.now() / 60_000)
    db.sqlite.prepare('INSERT INTO lab_request_limits (key,count,expires) VALUES (?,?,?)').run(`${hash}:${minute}`, 179, minute + 2)
    const responses = await Promise.all([
      handler(request('/api/absent', 'GET', undefined, { 'cf-connecting-ip': ip })),
      handler(request('/api/absent', 'GET', undefined, { 'cf-connecting-ip': ip })),
    ])
    assert.deepEqual(responses.map(response => response.status).sort(), [404, 429])
    const limited = responses.find(response => response.status === 429)!
    assert.equal(limited.headers.get('retry-after'), '60')
    assert.equal((await limited.json()).error, 'rate_limit')
    assert.equal((await handler(request('/api/absent', 'GET', undefined, { 'cf-connecting-ip': '198.51.100.8' }))).status, 404)
  } finally { db.close() }
})

test('revision exhaustion does not save an unsafe number or corrupt future CAS checks', async () => {
  const db = new SqliteD1()
  try {
    const handler = createLabHandler(db)
    const session = await create(handler)
    session.revision = Number.MAX_SAFE_INTEGER
    db.sqlite.prepare('UPDATE lab_sessions SET payload=?,revision=? WHERE id=?').run(JSON.stringify(session), session.revision, session.id)
    const response = await handler(request(`/api/sessions/${session.id}`, 'PATCH', { revision: session.revision, compare: true }))
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error, 'revision_limit')
    assert.deepEqual(await sessionOf(await handler(request(`/api/sessions/${session.id}`))), session)
  } finally { db.close() }
})

test('route errors and discovery endpoints retain the client response envelope', async () => {
  const db = new SqliteD1()
  try {
    const handler = createLabHandler(db)
    assert.deepEqual(await (await handler(request('/api/experiments'))).json(), [DEFAULT_EXPERIMENT])
    assert.equal((await (await handler(request('/api/health'))).json()).storage, 'd1')
    assert.equal((await handler(request('/api/sessions/not-a-uuid'))).status, 400)
    assert.equal((await handler(request(`/api/sessions/${crypto.randomUUID()}`))).status, 404)
    const response = await handler(request('/api/sessions', 'DELETE'))
    assert.equal(response.status, 405)
    assert.equal((await response.json()).error, 'method_not_allowed')
    assert.ok(response.headers.get('allow'))
  } finally { db.close() }
})
