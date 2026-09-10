import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExperimentDefinition, LabSession } from "../shared/types.ts";

interface SessionRow {
  id: string;
  experiment_id: string;
  selected_index: number;
  alternate: LabSession["alternate"];
  view: LabSession["view"];
  compare: number;
  progress: number;
  status: LabSession["status"];
  revision: number;
  created_at: string;
  updated_at: string;
}

const createSessionsTable = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    selected_index INTEGER NOT NULL CHECK (selected_index >= 0),
    alternate TEXT NOT NULL CHECK (alternate IN ('A', 'C', 'G', 'T')),
    view TEXT NOT NULL CHECK (view IN ('cell', 'dna', 'rna')),
    compare INTEGER NOT NULL CHECK (compare IN (0, 1)),
    progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
    status TEXT NOT NULL CHECK (status IN ('ready', 'replayed', 'unscored', 'unchanged')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

function toSession(row: SessionRow): LabSession {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    selectedIndex: row.selected_index,
    alternate: row.alternate,
    view: row.view,
    compare: row.compare === 1,
    progress: row.progress,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Persists independent lab sessions; each update must match its last revision. */
export class SessionStore {
  private readonly database: DatabaseSync;
  private readonly sequenceLengths: ReadonlyMap<string, number>;

  constructor(dbPath: string, experiments: readonly ExperimentDefinition[]) {
    this.sequenceLengths = new Map(
      experiments.map((experiment) => [
        experiment.id,
        experiment.referenceSequence.length,
      ]),
    );
    for (const experiment of experiments)
      this.validateIndex(experiment.id, experiment.defaultIndex);
    if (dbPath !== ":memory:")
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(dbPath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
    this.database.exec(createSessionsTable);
    const schema = this.database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
      .get() as { sql: string };
    if (!schema.sql.includes("'unchanged'")) {
      // SQLite cannot alter a CHECK constraint in place. Preserve every saved field.
      try {
        this.database.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE sessions RENAME TO sessions_before_unchanged;
          ${createSessionsTable}
          INSERT INTO sessions
            (id, experiment_id, selected_index, alternate, view, compare, progress, status, revision, created_at, updated_at)
          SELECT id, experiment_id, selected_index, alternate, view, compare, progress, status, revision, created_at, updated_at
          FROM sessions_before_unchanged;
          DROP TABLE sessions_before_unchanged;
          COMMIT;
        `);
      } catch (error) {
        if (this.database.isTransaction) this.database.exec("ROLLBACK");
        this.database.close();
        throw error;
      }
    }
  }

  create(experiment: ExperimentDefinition): LabSession {
    this.validateIndex(experiment.id, experiment.defaultIndex);
    const now = new Date().toISOString();
    const session: LabSession = {
      id: randomUUID(),
      experimentId: experiment.id,
      selectedIndex: experiment.defaultIndex,
      alternate: experiment.alternate,
      view: "dna",
      compare: false,
      progress: 0,
      status: "ready",
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(
        `
      INSERT INTO sessions
        (id, experiment_id, selected_index, alternate, view, compare, progress, status, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        session.id,
        session.experimentId,
        session.selectedIndex,
        session.alternate,
        session.view,
        Number(session.compare),
        session.progress,
        session.status,
        session.revision,
        session.createdAt,
        session.updatedAt,
      );
    return session;
  }

  get(id: string): LabSession | undefined {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id);
    return row ? toSession(row as unknown as SessionRow) : undefined;
  }

  /** Returns undefined when another client has already changed this revision. */
  update(
    previous: LabSession,
    changes: Partial<
      Pick<
        LabSession,
        | "selectedIndex"
        | "alternate"
        | "view"
        | "compare"
        | "progress"
        | "status"
      >
    >,
  ): LabSession | undefined {
    const next: LabSession = {
      ...previous,
      ...changes,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.validateIndex(next.experimentId, next.selectedIndex);
    const result = this.database
      .prepare(
        `
      UPDATE sessions SET selected_index = ?, alternate = ?, view = ?, compare = ?,
        progress = ?, status = ?, revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `,
      )
      .run(
        next.selectedIndex,
        next.alternate,
        next.view,
        Number(next.compare),
        next.progress,
        next.status,
        next.revision,
        next.updatedAt,
        next.id,
        previous.revision,
      );
    return result.changes === 1 ? next : undefined;
  }

  close(): void {
    this.database.close();
  }

  private validateIndex(experimentId: string, selectedIndex: number): void {
    const length = this.sequenceLengths.get(experimentId);
    if (
      length === undefined ||
      !Number.isInteger(selectedIndex) ||
      selectedIndex < 0 ||
      selectedIndex >= length
    ) {
      throw new RangeError(
        "The selected index must be inside its experiment sequence.",
      );
    }
  }
}
