# Higgsfield hosting

The Helix website is live at [helix-dna-lab.higgsfield.app](https://helix-dna-lab.higgsfield.app/) and listed on the [Higgsfield community](https://higgsfield.ai/supercomputer/apps/00961b5d-05b8-430c-aef1-825c7c4368bf/view).

## Runtime

React and Three.js render the interactive scene in the visitor's browser. The native cell GLB was created in Higgsfield 3D Jutsu. TanStack Start routes serve the API, and a D1 database stores sessions with atomic revision checks. This deployment does not start an AlphaGenome GPU or stream a remote GPU framebuffer.

The server only accepts selections and letter substitutions within the provided 41-base public reference. Session links are collaboration capabilities: anyone who has a link can read, edit, and export it. There is no account authentication or private genomic data upload. The application sets a no-referrer policy and no-store API responses. State changes enforce same-origin browser requests, a 16 KB body limit, strict schemas, and revision checks. Discovery endpoints are exempt from the 180-request-per-minute IP budget.

The real GPU service remains separate. No inference credentials or model weights are included. When an authorized service is running, only the server should call it with a private token. The browser must receive validated prediction results, never that token.

## Source mapping

`deploy/higgsfield` contains the hosting overlay for the Higgsfield TanStack starter. Source copies under that directory are included so the cloud API can be tested locally.

To synchronize a future revision in the Higgsfield MCP checkout:

1. Copy local `src/` into `app/src/lab/`, excluding `main.tsx` and `vite-env.d.ts`; copy `src/styles.css` to `app/src/styles.css`.
2. Copy `shared/` into `app/src/shared/` and refresh the matching `deploy/higgsfield/src/shared/` copy for local tests.
3. Overlay `deploy/higgsfield/` onto `app/`. Preserve the hosted OpenAPI document, which intentionally has stricter action revisions than the local adapter.
4. Copy the GLB and concept image into matching `app/public/` folders. The editable Blender source stays in the personal GitHub repository.
5. Keep `three`, `lucide-react`, and `@types/three` dependencies installed. Preserve the starter's error reporting, design-inspector gate, and platform binding helpers.
6. Run the cloud build and typecheck. Commit, push using `website_repo_access`, then deploy using `deploy_website`.
7. Verify the public browser, API, D1 persistence after reload, replay, unchanged control, and custom unscored edits. A successful build alone is not deployment verification.

Local checks: `npm test` includes 11 SQLite-backed tests of the D1 handler, in addition to the local API and client recovery tests. The tests exercise the actual handler through an injected D1 interface, including concurrent writes and database reopen persistence.

## Deployment verification

Deployed and published on 10 September 2026. The local and cloud production builds pass; 20 automated TypeScript tests and 5 Python export-helper tests pass. Twelve live public checks passed against D1: health, anonymous homepage, create/edit, replay, stale-write rejection, persisted progress, unchanged control, unscored export, required revisions, hosted OpenAPI, and byte-identical cell/concept assets. Fresh isolated Chrome sessions verified desktop 1440×1000 and mobile 390×667: UI-created sessions, native GLB load, Cell → DNA → RNA, pause/resume, persisted session and replay position after reload, scrubbed completion, concept image loading, no page/console errors, no failed HTTP responses, and no horizontal overflow. An uninterrupted replay reached completion automatically and remained completed after reload. Browser checks used software WebGL; physical mobile GPU performance was not measured.
