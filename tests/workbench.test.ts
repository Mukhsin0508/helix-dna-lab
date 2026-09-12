import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { createApp } from "../server/app.ts";
import { WorkspaceStore } from "../server/workbench.ts";
import { workspaceToJSON, type Candidate, type Workspace, type WorkspaceEnvelope } from "../shared/workbench.ts";

const cloudPath = new URL("../deploy/higgsfield/src/lib/lab.server.ts", import.meta.url).href;
const { createLabHandler }: { createLabHandler(db: SqliteD1): (request: Request) => Promise<Response> } = await import(cloudPath);
const migration = readFileSync(new URL("../deploy/higgsfield/migrations/0002_helix.sql", import.meta.url), "utf8");
const origin = "https://genetic-engineering-lab.higgsfield.app";

class SqliteD1 {
  readonly sqlite: DatabaseSync;
  afterWorkspaceRead?: () => Promise<void>;
  beforeQuery?: (sql: string) => void;
  constructor(path = ":memory:") {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec(migration);
  }
  prepare(sql: string) {
    const statement = (values: SQLInputValue[]) => ({
      bind: (...next: (string | number)[]) => statement(next),
      first: async <T>(): Promise<T | null> => {
        this.beforeQuery?.(sql);
        const result = this.sqlite.prepare(sql).get(...values);
        if (sql === "SELECT payload FROM lab_workspaces WHERE id=?") await this.afterWorkspaceRead?.();
        return result ? result as T : null;
      },
      run: async () => {
        this.beforeQuery?.(sql);
        return { meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) } };
      },
      all: async () => ({ results: this.sqlite.prepare(sql).all(...values) }),
    });
    return statement([]);
  }
  close(): void { this.sqlite.close(); }
}

type Call = (path: string, method?: "GET" | "POST" | "PATCH", data?: unknown, headers?: Record<string, string>) => Promise<Response>;
interface Harness { call: Call; close: () => Promise<void> }
async function harness(kind: "local" | "cloud", path = ":memory:"): Promise<Harness> {
  if (kind === "local") {
    const app = await createApp(path);
    return {
      call: async (url, method = "GET", data, headers = {}) => {
        const response = await app.inject({
          url, method, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers },
          ...(data === undefined ? {} : { payload: JSON.stringify(data) }),
        });
        return new Response(response.body, { status: response.statusCode, headers: response.headers as Record<string, string> });
      },
      close: () => app.close(),
    };
  }
  const db = new SqliteD1(path);
  const handler = createLabHandler(db);
  return {
    call: (url, method = "GET", data, headers = {}) => handler(new Request(origin + url, {
      method, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })),
    close: async () => { db.close(); },
  };
}
async function workspaceOf(response: Response, expected = 200): Promise<Workspace> {
  assert.equal(response.status, expected, await response.clone().text());
  return (await response.json() as WorkspaceEnvelope).workspace;
}
async function create(call: Call): Promise<Workspace> {
  return workspaceOf(await call("/api/workspaces", "POST", {}), 201);
}
function alternative(workspace: Workspace, title = "Reference comparison"): Candidate {
  return { ...workspace.candidates[0], id: crypto.randomUUID(), title, intervention: "baseline" };
}

for (const kind of ["local", "cloud"] as const) {
  test(`${kind}: alternatives persist after reopen, independent of other workspaces and old sessions`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "helix-workbench-"));
    const path = join(directory, "lab.sqlite");
    let api = await harness(kind, path);
    try {
      const oldSession = (await (await api.call("/api/sessions", "POST", {})).json()).session;
      const first = await create(api.call);
      const second = await create(api.call);
      assert.notEqual(first.id, second.id);
      assert.notEqual(first.candidates[0].id, second.candidates[0].id);
      assert.equal(first.candidates[0].question, "Can gene therapy reduce sickle-cell crises?");
      assert.equal(first.candidates[0].title, "Fetal hemoglobin");
      const candidates = [
        { ...first.candidates[0], notes: "Compare reported outcomes and study limitations." },
        alternative(first),
      ];
      const saved = await workspaceOf(await api.call(`/api/workspaces/${first.id}`, "PATCH", { revision: first.revision, candidates }));
      assert.equal(saved.revision, 1);
      assert.equal(saved.createdAt, first.createdAt);
      assert.deepEqual(saved.candidates, candidates);
      await api.close();
      api = await harness(kind, path);
      assert.deepEqual(await workspaceOf(await api.call(`/api/workspaces/${first.id}`)), saved);
      assert.deepEqual(await workspaceOf(await api.call(`/api/workspaces/${second.id}`)), second);
      assert.deepEqual((await (await api.call(`/api/sessions/${oldSession.id}`)).json()).session, oldSession);
      const exported = JSON.parse(workspaceToJSON(saved));
      assert.deepEqual(exported.workspace, saved);
      assert.equal(exported.scientificProvenance.liveModelUsed, false);
      assert.match(exported.scientificProvenance.results, /no new biological prediction/);
      assert.equal("score" in exported.workspace.candidates[0], false);
      assert.equal(exported.evidenceReferences[0].source.evaluable, 31);
      assert.equal(exported.evidenceReferences[0].source.responders, 29);
    } finally { await api.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test(`${kind}: every allowed comparison can save its full notes`, async () => {
    const api = await harness(kind);
    try {
      const workspace = await create(api.call);
      const candidates = Array.from({ length: 20 }, () => ({
        ...alternative(workspace), title: "t".repeat(80), question: "q".repeat(500), notes: "\u0000".repeat(3000),
      }));
      const saved = await workspaceOf(await api.call(`/api/workspaces/${workspace.id}`, "PATCH", { revision: 0, candidates }));
      assert.deepEqual(saved.candidates, candidates);
      assert.deepEqual((await workspaceOf(await api.call(`/api/workspaces/${workspace.id}`))).candidates, candidates);
    } finally { await api.close(); }
  });

  test(`${kind}: invalid candidate inputs and missing or stale revisions cannot replace saved alternatives`, async () => {
    const api = await harness(kind);
    try {
      const workspace = await create(api.call);
      const path = `/api/workspaces/${workspace.id}`;
      const original = workspace.candidates[0];
      for (const replacement of [
        { ...original, id: "not-uuid" }, { ...original, title: " " },
        { ...original, title: "a".repeat(81) }, { ...original, question: "a".repeat(501) },
        { ...original, notes: "a".repeat(3001) }, { ...original, selectedIndex: -1 },
        { ...original, selectedIndex: 41 }, { ...original, alternate: "N" },
        { ...original, scenario: "vaccine-efficacy" }, { ...original, intervention: "custom-dose" },
        { ...original, createdAt: "tomorrow" }, { ...original, efficacy: 0.9 },
        { ...original, scenario: "sickle-cell", alternate: "C" },
      ]) {
        assert.equal((await api.call(path, "PATCH", { revision: 0, candidates: [replacement] })).status, 400);
      }
      for (const payload of [
        { candidates: [original] }, { revision: -1, candidates: [original] },
        { revision: Number.MAX_SAFE_INTEGER + 1, candidates: [original] },
        { revision: 0, candidates: [] }, { revision: 0, candidates: [original, original] },
        { revision: 0, candidates: Array.from({ length: 21 }, () => alternative(workspace)) },
        { revision: 0, candidates: [original], owner: "me" },
      ]) assert.equal((await api.call(path, "PATCH", payload)).status, 400);
      assert.deepEqual(await workspaceOf(await api.call(path)), workspace);
      const candidates: Candidate[] = [{ ...original, scenario: "dnm1", selectedIndex: 0, alternate: "C" }];
      const saved = await workspaceOf(await api.call(path, "PATCH", { revision: 0, candidates }));
      const stale = await api.call(path, "PATCH", { revision: 0, candidates: [original] });
      assert.equal(stale.status, 409);
      assert.deepEqual((await stale.json()).workspace, saved);
      assert.deepEqual(await workspaceOf(await api.call(path)), saved);
      const unknownExport = JSON.parse(workspaceToJSON(saved));
      assert.equal(unknownExport.evidenceReferences[0].status, "unchanged");
      assert.equal("publishedEvidence" in unknownExport.evidenceReferences[0], false);
      const unscoredExport = JSON.parse(workspaceToJSON({ ...saved, candidates: [{ ...saved.candidates[0], alternate: "G" }] }));
      assert.equal(unscoredExport.evidenceReferences[0].status, "unscored");
      assert.equal("publishedEvidence" in unscoredExport.evidenceReferences[0], false);
      for (const data of [null, [], { id: crypto.randomUUID() }, { candidates: [original] }]) {
        assert.equal((await api.call("/api/workspaces", "POST", data)).status, 400);
      }
      assert.equal((await api.call("/api/workspaces/not-uuid")).status, 400);
      assert.equal((await api.call(`/api/workspaces/${crypto.randomUUID()}`)).status, 404);
    } finally { await api.close(); }
  });
}

test("cloud: two simultaneous writers cannot both replace workspace revision zero", async () => {
  const db = new SqliteD1();
  try {
    const handler = createLabHandler(db);
    const make = (path: string, method = "GET", data?: unknown) => new Request(origin + path, {
      method, headers: { "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const workspace = await workspaceOf(await handler(make("/api/workspaces", "POST", {})), 201);
    const path = `/api/workspaces/${workspace.id}`;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    db.afterWorkspaceRead = async () => {
      arrivals += 1;
      if (arrivals === 2) { db.afterWorkspaceRead = undefined; release(); }
      await barrier;
    };
    const responses = await Promise.all([
      handler(make(path, "PATCH", { revision: 0, candidates: [alternative(workspace, "First")] })),
      handler(make(path, "PATCH", { revision: 0, candidates: [alternative(workspace, "Second")] })),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const winner = await workspaceOf(responses.find(response => response.status === 200)!);
    assert.equal(winner.revision, 1);
    assert.deepEqual((await responses.find(response => response.status === 409)!.json()).workspace, winner);
    assert.deepEqual(await workspaceOf(await handler(make(path))), winner);
  } finally { db.close(); }
});

test("local store: another connection cannot write a stale workspace revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helix-workspace-cas-"));
  const path = join(directory, "lab.sqlite");
  const first = new WorkspaceStore(path);
  const second = new WorkspaceStore(path);
  try {
    const previous = first.create();
    const otherRead = second.get(previous.id)!;
    const saved = first.update(previous, [alternative(previous)])!;
    assert.equal(saved.revision, 1);
    assert.equal(second.update(otherRead, previous.candidates), undefined);
    assert.deepEqual(second.get(previous.id), saved);
  } finally { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cloud: workspace writes inherit origin, body-size, and request-budget guards", async () => {
  const api = await harness("cloud");
  try {
    const workspace = await create(api.call);
    const path = `/api/workspaces/${workspace.id}`;
    const payload = { revision: 0, candidates: workspace.candidates };
    assert.equal((await api.call(path, "PATCH", payload, { origin: "https://other.example" })).status, 403);
    assert.equal((await api.call(path, "PATCH", { ...payload, oversized: "x".repeat(512 * 1024 + 1) })).status, 413);
    assert.deepEqual(await workspaceOf(await api.call(path)), workspace);
    for (let index = 0; index < 178; index += 1) await api.call(`/api/workspaces/${workspace.id}`);
    assert.equal((await api.call(path, "PATCH", payload)).status, 429);
  } finally { await api.close(); }
});

test("cloud: additive workspace initialization retries a transient failure without reporting a saved record", async () => {
  const db = new SqliteD1();
  try {
    const handler = createLabHandler(db);
    const make = () => new Request(origin + "/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    db.beforeQuery = sql => { if (sql.startsWith("CREATE TABLE IF NOT EXISTS lab_workspaces")) throw new Error("internal database message"); };
    const failed = await handler(make());
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /internal database message/);
    db.beforeQuery = undefined;
    const recovered = await handler(make());
    assert.equal(recovered.status, 201);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM lab_workspaces").get()!.count, 1);
  } finally { db.close(); }
});

test("local and deployed workspace validation schemas remain identical", () => {
  const local = readFileSync(new URL("../shared/workbench.ts", import.meta.url), "utf8");
  const deployed = readFileSync(new URL("../deploy/higgsfield/src/shared/workbench.ts", import.meta.url), "utf8");
  assert.equal(deployed, local);
});
