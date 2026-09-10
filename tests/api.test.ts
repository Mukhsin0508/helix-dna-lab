import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.equal(run.json<SessionEnvelope>().session.progress, 1);

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
