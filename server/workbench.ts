import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import {
  WORKSPACE_BODY_LIMIT,
  newWorkspace,
  workspaceCreateSchema,
  workspaceIdSchema,
  workspacePatchSchema,
  type Candidate,
  type Workspace,
} from "../shared/workbench.ts";

/** Local workspace persistence uses the same file, with a separate additive table. */
export class WorkspaceStore {
  private readonly database: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(dbPath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS lab_workspaces (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        updated_at TEXT NOT NULL
      );
    `);
  }

  create(): Workspace {
    const workspace = newWorkspace(randomUUID);
    this.database.prepare("INSERT INTO lab_workspaces (id,payload,revision,updated_at) VALUES (?,?,?,?)")
      .run(workspace.id, JSON.stringify(workspace), workspace.revision, workspace.updatedAt);
    return workspace;
  }

  get(id: string): Workspace | undefined {
    const row = this.database.prepare("SELECT payload FROM lab_workspaces WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Workspace : undefined;
  }

  /** Returns undefined if another writer has already committed this revision. */
  update(previous: Workspace, candidates: Candidate[]): Workspace | undefined {
    if (previous.revision >= Number.MAX_SAFE_INTEGER) return undefined;
    const next: Workspace = {
      ...previous,
      candidates,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const result = this.database.prepare("UPDATE lab_workspaces SET payload=?,revision=?,updated_at=? WHERE id=? AND revision=?")
      .run(JSON.stringify(next), next.revision, next.updatedAt, next.id, previous.revision);
    return result.changes === 1 ? next : undefined;
  }

  close(): void { this.database.close(); }
}

/** Adds workspace routes under the app's existing request budget and a bounded workspace body limit. */
export function registerWorkspaceRoutes(app: FastifyInstance, dbPath: string): void {
  const store = new WorkspaceStore(dbPath);
  app.addHook("onClose", async () => { store.close(); });
  app.post("/api/workspaces", async (request, reply) => {
    workspaceCreateSchema.parse(request.body === undefined ? {} : request.body);
    return reply.code(201).send({ workspace: store.create() });
  });
  app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    const workspace = store.get(workspaceIdSchema.parse(request.params.id));
    return workspace
      ? { workspace }
      : reply.code(404).send({ error: "workspace_not_found", message: "This workspace does not exist." });
  });
  app.patch<{ Params: { id: string } }>("/api/workspaces/:id", { bodyLimit: WORKSPACE_BODY_LIMIT }, async (request, reply) => {
    const id = workspaceIdSchema.parse(request.params.id);
    const patch = workspacePatchSchema.parse(request.body);
    const previous = store.get(id);
    if (!previous) return reply.code(404).send({ error: "workspace_not_found", message: "This workspace does not exist." });
    if (previous.revision >= Number.MAX_SAFE_INTEGER) {
      return reply.code(409).send({ error: "revision_limit", message: "This workspace reached its revision limit. Export it before creating a new workspace." });
    }
    const next = patch.revision === previous.revision ? store.update(previous, patch.candidates) : undefined;
    return next
      ? { workspace: next }
      : reply.code(409).send({
        error: "revision_conflict",
        message: "This workspace changed in another window. Preserve your edits before reloading its latest version.",
        workspace: store.get(id),
      });
  });
}
