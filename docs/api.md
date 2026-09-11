# Analytical API

The current workspace uses account-private numerical analyses. The full typed contract is served at `/api/openapi.json`.

| Method | Path | Result |
|---|---|---|
| GET | `/api/analyses` | Your saved summaries and a pagination cursor. |
| POST | `/api/analyses` | Saves `{dataset, settings}`; returns `{analysis, access}` with UUID and revision 0. |
| GET | `/api/analyses/:id` | Complete dataset, provenance, figure recipe, revision and access. |
| PATCH | `/api/analyses/:id` | Accepts `{revision, dataset, settings}`. A conflict returns 409 and the latest owner-visible record. |
| DELETE | `/api/analyses/:id` | Accepts `{revision}` and deletes your matching record; returns 204. |

Use a verified passkey cookie session in the browser or an expiring access token in `Authorization: Bearer …` for integrations. Cookie mutations require the exact website Origin. Tokens require `analyses:read` for reads and `analyses:write` for create/update/delete. An invalid bearer is rejected even if a valid browser cookie is also supplied. Account and token management remain browser-session-only.

New analyses belong to their authenticated account. The URL does not grant private access. Historical unowned analyses are public and read-only; save a private copy to edit them. CSV/JSON drafts remain in memory until saved; local image/recipe exports do not upload a draft.

Supported datasets: `scores`, paired `tracks`, `junctions`, and experimental `measurements`. Preserve exact values, nulls, coordinates and source metadata. Maximum 5,000 rows and 2 MiB per analysis request. The API validates and stores supplied values; it does not run inference, retrieve source URLs or independently authenticate imported provenance. See [assistant integration](assistant-integration.md) for token management and AllMCP.

## Historical APIs

These retained educational endpoints are separate from the account-private analytical product. They still use public collaboration semantics and must not hold private research data.


# DNA Lab API

## Saved comparison workspaces

`POST /api/workspaces` with `{}` creates a workspace with one published-evidence comparison. `GET /api/workspaces/{id}` returns `{ "workspace": ... }`. `PATCH /api/workspaces/{id}` accepts `{ "revision": 0, "candidates": [...] }` and replaces the alternatives atomically. A stale revision returns 409 with the latest workspace; preserve and reconcile unsaved edits instead of retrying over another writer.

Each candidate stores its title, question, scenario, comparison settings, notes, creation time and UUID. There must be 1–20 distinct candidates. Titles are limited to 80 characters, questions to 500 and notes to 3,000, subject to the total 16 KiB request limit. Supported scenarios are the fixed sickle-cell evidence case and the existing DNM1 reference window. Candidate records contain no model result or efficacy score. Saving, duplicating or exporting does not perform inference.

The hosted adapter persists these records in an additive D1 table; local development uses SQLite. Hosted workspace URLs are collaboration capabilities: anyone with the link can read or edit the workspace. Do not include private patient information. Workspace endpoints and their schemas are also present in `/api/openapi.json`.

## Molecular replay sessions

Run `npm run dev` for the browser on `127.0.0.1:4190` and API on `127.0.0.1:4191`. After `npm run build`, `npm start` also serves the built browser app on API port 4191. SQLite sessions persist in `.data/sessions.sqlite`. The full route contract is available at `/api/openapi.json`.

Create a session with `POST /api/sessions`, optionally passing `{ "experimentId": "dnm1-splice-replay" }`. Read it with `GET /api/sessions/{id}`. Session responses use `{ "session": ... }`.

Save changes with `PATCH /api/sessions/{id}`, supplying the current `revision`. Stale revisions return HTTP 409 with the current session. `selectedIndex` is a zero-based index in the displayed sequence and must be in `0..sequence.length-1`; both API validation and the persistence layer enforce this. `progress` ranges from 0 to 1. Changing the selected letter or alternate clears the previous result.

`POST /api/sessions/{id}/run` returns `unchanged` when the selected alternate equals the reference base, `replayed` for the predefined mutation, or `unscored` for other mutations. An unchanged result is a reference control with no DNA mutation. Every run starts `progress` at zero; a curated replay also sets `view` to `rna` and `compare` to `true` in the same response. The `replayed` status means curated evidence is available, not that animation has finished. The API never calls a model or generates an effect score.

`POST /api/sessions/{id}/reset` restores defaults. Run and reset both accept an optional `{ "revision": 0 }` to reject stale actions. `GET /api/sessions/{id}/export` downloads the session, evidence and explicit scientific limitations as readable JSON; unchanged controls are explicitly identified as having no mutation and no model call. Existing SQLite databases migrate automatically to support the unchanged status while preserving saved session fields.

## Deployment limits

The server binds only to loopback and has no authentication or per-user authorization. A session UUID identifies a local record; it is not an access-control mechanism. Do not expose this API through a public tunnel or bind it publicly without adding authentication and checking session ownership on every session route. Public hosting also needs HTTPS, an explicit origin/CSRF policy, durable storage and backups, and deployment-level rate limiting. The current in-memory rate limit resets on restart and is not shared between replicas.

Requests have a 16 KiB body limit and a 300 requests/minute/IP limit. Only the built `dist` directory is served as static content. Keep database files and any future model credentials outside it; future model calls belong on the server.

The static plugin is updated to `@fastify/static` 10.1.3 or later in that major version. Its [official compatibility table](https://github.com/fastify/fastify-static#compatibility) supports Fastify 5. The application uses Node 22's built-in SQLite API, which emits an experimental-feature notice on Node 22.16.

Workspace PATCH requests allow up to 512 KiB so all 20 comparisons can hold their full notes. Other request bodies retain the 16 KiB limit.
