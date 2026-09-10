import assert from "node:assert/strict";
import { test } from "node:test";
import { request, RequestError } from "../src/apiClient.ts";

test("a hung API request times out instead of keeping the lab busy indefinitely", async (context) => {
  context.mock.method(
    globalThis,
    "fetch",
    async (_path: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  await assert.rejects(
    request("/api/sessions", "GET", undefined, 15),
    (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.status, 0);
      assert.match(error.message, /too long/);
      return true;
    },
  );
});

test("HTML server errors produce a recoverable message", async (context) => {
  context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("<h1>Unavailable</h1>", {
        status: 503,
        headers: { "content-type": "text/html" },
      }),
  );
  await assert.rejects(
    request("/api/sessions"),
    (error: unknown) => error instanceof RequestError && error.status === 503,
  );
});

test("revision conflict preserves the latest server session for reconciliation", async (context) => {
  const session = { id: "latest-session", revision: 5 };
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ message: "Changed", session }, { status: 409 }),
  );
  await assert.rejects(
    request("/api/sessions/current", "PATCH", { revision: 4 }),
    (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.deepEqual(error.session, session);
      assert.equal(error.status, 409);
      return true;
    },
  );
});
