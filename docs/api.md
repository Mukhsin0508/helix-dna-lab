# DNA Lab API

Run `npm run dev` for the browser on `127.0.0.1:4190` and API on `127.0.0.1:4191`. After `npm run build`, `npm start` also serves the built browser app on API port 4191. SQLite sessions persist in `.data/sessions.sqlite`. The full route contract is available at `/api/openapi.json`.

Create a session with `POST /api/sessions`, optionally passing `{ "experimentId": "dnm1-splice-replay" }`. Read it with `GET /api/sessions/{id}`. Session responses use `{ "session": ... }`.

Save changes with `PATCH /api/sessions/{id}`, supplying the current `revision`. Stale revisions return HTTP 409 with the current session. `selectedIndex` is a zero-based index in the displayed sequence and must be in `0..sequence.length-1`; both API validation and the persistence layer enforce this. `progress` ranges from 0 to 1. Changing the selected letter or alternate clears the previous result.

`POST /api/sessions/{id}/run` returns `unchanged` when the selected alternate equals the reference base, `replayed` for the predefined mutation, or `unscored` for other mutations. An unchanged result is a reference control with no DNA mutation. Every run starts `progress` at zero; a curated replay also sets `view` to `rna` and `compare` to `true` in the same response. The `replayed` status means curated evidence is available, not that animation has finished. The API never calls a model or generates an effect score.

`POST /api/sessions/{id}/reset` restores defaults. Run and reset both accept an optional `{ "revision": 0 }` to reject stale actions. `GET /api/sessions/{id}/export` downloads the session, evidence and explicit scientific limitations as readable JSON; unchanged controls are explicitly identified as having no mutation and no model call. Existing SQLite databases migrate automatically to support the unchanged status while preserving saved session fields.

## Deployment limits

The server binds only to loopback and has no authentication or per-user authorization. A session UUID identifies a local record; it is not an access-control mechanism. Do not expose this API through a public tunnel or bind it publicly without adding authentication and checking session ownership on every session route. Public hosting also needs HTTPS, an explicit origin/CSRF policy, durable storage and backups, and deployment-level rate limiting. The current in-memory rate limit resets on restart and is not shared between replicas.

Requests have a 16 KiB body limit and a 300 requests/minute/IP limit. Only the built `dist` directory is served as static content. Keep database files and any future model credentials outside it; future model calls belong on the server.

The static plugin is updated to `@fastify/static` 10.1.3 or later in that major version. Its [official compatibility table](https://github.com/fastify/fastify-static#compatibility) supports Fastify 5. The application uses Node 22's built-in SQLite API, which emits an experimental-feature notice on Node 22.16.
