import {
  newWorkspace,
  workspaceCreateSchema,
  workspaceIdSchema,
  workspacePatchSchema,
  type Workspace,
} from '../shared/workbench'
import type { LabDatabase } from './lab.server'

const initialized = new WeakMap<LabDatabase, Promise<void>>()

/** Additive initialization also supports a site already running the session migration. */
async function ensureTable(db: LabDatabase): Promise<void> {
  let pending = initialized.get(db)
  if (!pending) {
    pending = db.prepare(`CREATE TABLE IF NOT EXISTS lab_workspaces (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      updated_at TEXT NOT NULL
    )`).run().then(() => undefined).catch(error => {
      initialized.delete(db)
      throw error
    })
    initialized.set(db, pending)
  }
  await pending
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

async function load(db: LabDatabase, id: string): Promise<Workspace | undefined> {
  const row = await db.prepare('SELECT payload FROM lab_workspaces WHERE id=?').bind(id).first<{ payload: string }>()
  return row ? JSON.parse(row.payload) as Workspace : undefined
}

/** Called only after the shared API's origin and request-budget checks. */
export async function handleWorkspaceRequest(
  db: LabDatabase,
  request: Request,
  readBody: (request: Request) => Promise<unknown>,
): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname
  const method = request.method
  if (pathname === '/api/workspaces' && method === 'POST') {
    workspaceCreateSchema.parse(await readBody(request))
    await ensureTable(db)
    const workspace = newWorkspace(() => crypto.randomUUID())
    await db.prepare('INSERT INTO lab_workspaces (id,payload,revision,updated_at) VALUES (?,?,?,?)')
      .bind(workspace.id, JSON.stringify(workspace), workspace.revision, workspace.updatedAt).run()
    return json({ workspace }, 201)
  }
  const match = pathname.match(/^\/api\/workspaces\/([^/]+)$/)
  if (!match) return undefined
  const id = workspaceIdSchema.parse(match[1])
  if (method !== 'GET' && method !== 'PATCH') return json({ error: 'method_not_allowed', message: 'Method not allowed.' }, 405)
  const patch = method === 'PATCH' ? workspacePatchSchema.parse(await readBody(request)) : undefined
  await ensureTable(db)
  const previous = await load(db, id)
  if (!previous) return json({ error: 'workspace_not_found', message: 'This workspace does not exist.' }, 404)
  if (!patch) return json({ workspace: previous })
  if (previous.revision >= Number.MAX_SAFE_INTEGER) {
    return json({ error: 'revision_limit', message: 'This workspace reached its revision limit. Export it before creating a new workspace.' }, 409)
  }
  if (patch.revision === previous.revision) {
    const next: Workspace = {
      ...previous,
      candidates: patch.candidates,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString(),
    }
    const result = await db.prepare('UPDATE lab_workspaces SET payload=?,revision=?,updated_at=? WHERE id=? AND revision=?')
      .bind(JSON.stringify(next), next.revision, next.updatedAt, next.id, previous.revision).run()
    if (result.meta.changes === 1) return json({ workspace: next })
  }
  return json({
    error: 'revision_conflict',
    message: 'This workspace changed in another window. Preserve your edits before reloading its latest version.',
    workspace: await load(db, id),
  }, 409)
}
