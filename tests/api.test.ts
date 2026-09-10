import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../server/app.ts";
import { SessionStore } from "../server/store.ts";
import { DEFAULT_EXPERIMENT } from "../shared/experiments.ts";
import type { SessionEnvelope } from "../shared/types.ts";

test("the storage boundary rejects out-of-range indexes without saving them", () => {
  const store = new SessionStore(":memory:", [DEFAULT_EXPERIMENT]);
  try {
    const session = store.create(DEFAULT_EXPERIMENT);
    for (const selectedIndex of [
      -1,
      0.5,
      DEFAULT_EXPERIMENT.referenceSequence.length,
      Number.NaN,
    ]) {
      assert.throws(() => store.update(session, { selectedIndex }), RangeError);
      assert.deepEqual(store.get(session.id), session);
    }
    assert.throws(
      () =>
        store.create({
          ...DEFAULT_EXPERIMENT,
          defaultIndex: DEFAULT_EXPERIMENT.referenceSequence.length,
        }),
      RangeError,
    );
  } finally {
    store.close();
  }
});

test("sessions and saved edits survive closing and reopening the database", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dna-lab-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const dbPath = join(directory, "sessions.sqlite");
  const first = await createApp(dbPath);
  const created = await first.inject({
    method: "POST",
    url: "/api/sessions",
    payload: {},
  });
  assert.equal(created.statusCode, 201);
  const { session } = created.json<SessionEnvelope>();
  assert.equal(session.revision, 0);
  assert.equal(session.progress, 0);
  assert.equal(session.view, "dna");
  assert.equal(session.compare, false);
  const saved = await first.inject({
    method: "PATCH",
    url: `/api/sessions/${session.id}`,
    payload: { revision: 0, view: "rna", compare: true, progress: 0.5 },
  });
  assert.equal(saved.statusCode, 200);
  await first.close();

  const second = await createApp(dbPath);
  t.after(async () => {
    await second.close();
  });
  const restored = await second.inject(`/api/sessions/${session.id}`);
  assert.deepEqual(restored.json(), saved.json());
  const another = await second.inject({
    method: "POST",
    url: "/api/sessions",
    payload: {},
  });
  assert.notEqual(another.json<SessionEnvelope>().session.id, session.id);
});

test("stale revisions and invalid edits cannot overwrite a session", async (t) => {
  const app = await createApp(":memory:");
  t.after(async () => {
    await app.close();
  });
  const created = await app.inject({ method: "POST", url: "/api/sessions" });
  const { session } = created.json<SessionEnvelope>();
  const url = `/api/sessions/${session.id}`;
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url,
        payload: { revision: 0, compare: true },
      })
    ).statusCode,
    200,
  );
  const stale = await app.inject({
    method: "PATCH",
    url,
    payload: { revision: 0, compare: false },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json<SessionEnvelope>().session.compare, true);
  for (const patch of [
    { revision: 1, selectedIndex: DEFAULT_EXPERIMENT.referenceSequence.length },
    { revision: 1, selectedIndex: -1 },
    { revision: 1, selectedIndex: 1.5 },
    { revision: 1, alternate: "N" },
    { revision: 1, progress: 1.01 },
    { compare: true },
    { revision: 1, status: "replayed" },
  ]) {
    assert.equal(
      (await app.inject({ method: "PATCH", url, payload: patch })).statusCode,
      400,
    );
  }
  const current = (await app.inject(url)).json<SessionEnvelope>().session;
  assert.equal(current.revision, 1);
  assert.equal(current.status, "ready");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `${url}/run`,
        payload: { revision: 0 },
      })
    ).statusCode,
    409,
  );
});

test("only the curated edit replays; arbitrary edits remain unscored in results and export", async (t) => {
  const app = await createApp(":memory:");
  t.after(async () => {
    await app.close();
  });
  const { session } = (
    await app.inject({ method: "POST", url: "/api/sessions" })
  ).json<SessionEnvelope>();
  const url = `/api/sessions/${session.id}`;
  const run = await app.inject({
    method: "POST",
    url: `${url}/run`,
    payload: { revision: 0 },
  });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json<SessionEnvelope>().session.status, "replayed");
  assert.equal(run.json<SessionEnvelope>().session.progress, 0);
  assert.equal(run.json<SessionEnvelope>().session.view, "rna");
  assert.equal(run.json<SessionEnvelope>().session.compare, true);

  const otherIndex =
    (DEFAULT_EXPERIMENT.defaultIndex + 1) %
    DEFAULT_EXPERIMENT.referenceSequence.length;
  const edited = await app.inject({
    method: "PATCH",
    url,
    payload: { revision: 1, selectedIndex: otherIndex },
  });
  assert.equal(edited.json<SessionEnvelope>().session.status, "ready");
  assert.equal(edited.json<SessionEnvelope>().session.progress, 0);
  const unscored = (
    await app.inject({
      method: "POST",
      url: `${url}/run`,
      payload: { revision: 2 },
    })
  ).json<SessionEnvelope>();
  assert.equal(unscored.session.status, "unscored");
  assert.equal(unscored.session.progress, 0);
  assert.equal("score" in unscored.session, false);
  const exported = await app.inject(`${url}/export`);
  assert.match(exported.headers["content-disposition"] as string, /attachment/);
  const document = exported.json();
  assert.equal(document.scientificProvenance.liveModelUsed, false);
  assert.match(document.scientificProvenance.result, /no model result/i);
  assert.deepEqual(
    document.scientificProvenance.sources,
    DEFAULT_EXPERIMENT.sources,
  );

  const reset = (
    await app.inject({
      method: "POST",
      url: `${url}/reset`,
      payload: { revision: 3 },
    })
  ).json<SessionEnvelope>().session;
  assert.equal(reset.id, session.id);
  assert.equal(reset.createdAt, session.createdAt);
  assert.equal(reset.revision, 4);
  assert.equal(reset.selectedIndex, DEFAULT_EXPERIMENT.defaultIndex);
  assert.equal(reset.status, "ready");
  assert.equal(reset.progress, 0);
});

test("reference controls are unchanged, and editing away clears their saved result", async (t) => {
  const app = await createApp(":memory:");
  t.after(async () => { await app.close(); });
  const { session } = (await app.inject({ method: "POST", url: "/api/sessions" })).json<SessionEnvelope>();
  const url = `/api/sessions/${session.id}`;
  const reference = DEFAULT_EXPERIMENT.referenceSequence[DEFAULT_EXPERIMENT.defaultIndex];

  // Start with an available replay, then select its unchanged reference control.
  const replay = (await app.inject({ method: "POST", url: `${url}/run` })).json<SessionEnvelope>().session;
  const controlEdit = (await app.inject({
    method: "PATCH", url,
    payload: { revision: replay.revision, alternate: reference, progress: 1 },
  })).json<SessionEnvelope>().session;
  assert.equal(controlEdit.status, "ready");
  assert.equal(controlEdit.progress, 0);
  const controlResponse = await app.inject({ method: "POST", url: `${url}/run`, payload: { revision: controlEdit.revision } });
  assert.equal(controlResponse.statusCode, 200);
  const control = controlResponse.json<SessionEnvelope>().session;
  assert.equal(control.status, "unchanged");
  assert.equal(control.progress, 0);
  const exported = (await app.inject(`${url}/export`)).json();
  assert.equal(exported.scientificProvenance.mode, "unchanged reference control");
  assert.equal(exported.scientificProvenance.liveModelUsed, false);
  assert.match(exported.scientificProvenance.result, /DNA sequence is unchanged/);
  assert.match(exported.scientificProvenance.result, /No model was called/);

  const changed = (await app.inject({
    method: "PATCH", url,
    payload: { revision: control.revision, alternate: DEFAULT_EXPERIMENT.alternate },
  })).json<SessionEnvelope>().session;
  assert.equal(changed.status, "ready");
  assert.equal(changed.progress, 0);
  const pendingExport = (await app.inject(`${url}/export`)).json();
  assert.match(pendingExport.scientificProvenance.result, /has not run/);
  const replayAgain = (await app.inject({ method: "POST", url: `${url}/run`, payload: { revision: changed.revision } })).json<SessionEnvelope>().session;
  assert.equal(replayAgain.status, "replayed");
  assert.equal(replayAgain.progress, 0);
  assert.equal(replayAgain.view, "rna");
  assert.equal(replayAgain.compare, true);

  // Reference controls also work outside the one curated locus position.
  const otherIndex = DEFAULT_EXPERIMENT.defaultIndex === 0 ? 1 : 0;
  const other = (await app.inject({
    method: "PATCH", url,
    payload: { revision: replayAgain.revision, selectedIndex: otherIndex, alternate: DEFAULT_EXPERIMENT.referenceSequence[otherIndex] },
  })).json<SessionEnvelope>().session;
  assert.equal(other.status, "ready");
  const otherControl = (await app.inject({ method: "POST", url: `${url}/run`, payload: { revision: other.revision } })).json<SessionEnvelope>().session;
  assert.equal(otherControl.status, "unchanged");

  const reset = (await app.inject({ method: "POST", url: `${url}/reset`, payload: { revision: otherControl.revision } })).json<SessionEnvelope>().session;
  assert.equal(reset.status, "ready");
  assert.equal(reset.progress, 0);
  assert.equal(reset.view, "dna");
  assert.equal(reset.compare, false);
  assert.equal(reset.alternate, DEFAULT_EXPERIMENT.alternate);
});

test("existing SQLite sessions migrate without data loss and persist unchanged results across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dna-lab-migration-"));
  const dbPath = join(directory, "sessions.sqlite");
  const id = "14c178fc-7992-4ad7-8c68-3b9c98cb005f";
  const createdAt = "2026-09-10T00:00:00.000Z";
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, selected_index INTEGER NOT NULL,
    alternate TEXT NOT NULL, view TEXT NOT NULL, compare INTEGER NOT NULL,
    progress REAL NOT NULL, status TEXT NOT NULL CHECK (status IN ('ready', 'replayed', 'unscored')),
    revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  legacy.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, DEFAULT_EXPERIMENT.id, DEFAULT_EXPERIMENT.defaultIndex, DEFAULT_EXPERIMENT.alternate,
    "rna", 1, 0.6, "replayed", 7, createdAt, createdAt,
  );
  legacy.close();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp(dbPath);
    const restored = (await app.inject(`/api/sessions/${id}`)).json<SessionEnvelope>().session;
    assert.equal(restored.id, id);
    assert.equal(restored.revision, 7);
    assert.equal(restored.createdAt, createdAt);
    assert.equal(restored.updatedAt, createdAt);
    assert.equal(restored.view, "rna");
    assert.equal(restored.compare, true);
    assert.equal(restored.progress, 0.6);
    assert.equal(restored.status, "replayed");

    await app.inject({
      method: "PATCH", url: `/api/sessions/${id}`,
      payload: { revision: 7, alternate: DEFAULT_EXPERIMENT.referenceSequence[DEFAULT_EXPERIMENT.defaultIndex] },
    });
    const result = await app.inject({ method: "POST", url: `/api/sessions/${id}/run`, payload: { revision: 8 } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json<SessionEnvelope>().session.status, "unchanged");
    await app.close();
    app = undefined;
    app = await createApp(dbPath);
    assert.deepEqual((await app.inject(`/api/sessions/${id}`)).json(), result.json());
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
