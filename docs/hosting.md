# Higgsfield hosting

The website is live at [genetic-engineering-lab.higgsfield.app](https://genetic-engineering-lab.higgsfield.app/) and listed on the [Higgsfield community](https://higgsfield.ai/supercomputer/apps/00961b5d-05b8-430c-aef1-825c7c4368bf/view). The subdomain was renamed from `helix-dna-lab` on 12 September 2026. Release snapshots below retain the evidence and configuration from their original dates.

## No-signup browser workspace

The primary frontend now saves validated datasets and figure settings in browser IndexedDB. It does not call account endpoints or send imported results to D1. Public source links are fetched without cookies and must be read-only legacy-public envelopes. Existing private D1 records and authenticated API permissions are unchanged. Cloud revision `4ae5df4` is deployed and public browser checks passed. See [release checks](no-signup-release.md).

## Runtime

React and SVG render the analytical figures in the visitor's browser. The older Three.js scene remains as unused source. TanStack Start routes serve the API, and a D1 database stores analyses, sessions and comparison workspaces with atomic revision checks. This deployment does not start an AlphaGenome GPU or stream a remote GPU framebuffer.

The analytical API accepts bounded numerical datasets with provenance. Native Helix passkey accounts own new saved analyses. Reads, changes, deletion, lists and conflict responses are scoped to the owner; a private URL grants no access to someone else. Historical unowned analyses remain public and read-only, and their source payloads are preserved. The unused legacy session and comparison-workspace APIs remain public collaboration capabilities and must not be used for private notes or research data. This account release protects the analytical workspace, not those retired workflows. The application sets a no-referrer policy and no-store API responses. Cookie-authorized state changes enforce same-origin browser requests; scoped bearer analysis calls do not require a browser Origin header. The API applies a 16 KiB body limit (512 KiB for workspace PATCH requests; 2 MiB for analysis POST/PATCH requests), strict schemas, and revision checks. Discovery endpoints are exempt from the 180-request-per-minute IP budget.

The hosted AlphaGenome path uses a CPU container as a proxy to Google's inference service. The official Python client is pinned to `alphagenome==0.9.0`; no model weights or local GPU are needed for this route. The owner's AlphaGenome-issued key is still missing, so an actual authenticated prediction has not been verified. Configure it through [hosted API setup](hosted-api-setup.md). The browser receives validated prediction data and provenance, never the service key. The earlier self-hosted GPU runner remains a separate option.

The current approved hosted origin is exactly `https://genetic-engineering-lab.higgsfield.app`. Browser storage, passkeys and access-token audiences are origin-bound; the rename does not establish migration of drafts, credentials or optional provider connections from the former hostname. Exported analysis JSON remains portable.

## Source mapping

`deploy/higgsfield` contains the hosting overlay for the Higgsfield TanStack starter. Source copies under that directory are included so the cloud API can be tested locally.

To synchronize a future revision in the Higgsfield MCP checkout:

1. Copy local `src/` into `app/src/lab/`, excluding `main.tsx` and `vite-env.d.ts`; copy `src/styles.css` to `app/src/styles.css`.
2. Copy `shared/` into `app/src/shared/` and refresh the matching `deploy/higgsfield/src/shared/` copy for local tests.
3. Overlay `deploy/higgsfield/` onto `app/`. Preserve the hosted OpenAPI document, which intentionally has stricter action revisions than the local adapter.
4. Copy `data/atlas/published-tcell-scores.normalized.json` and its provenance JSON to `app/src/data/atlas/`, and `data/experimental/dnm1-table-s4.measurements.json` with its provenance JSON to `app/src/data/experimental/`, because the hosted frontend lives under `app/src/lab/`. Copy `data/reference/dnm1-variants.json` to `app/src/data/reference/` for the shared import validator. Existing public assets can remain; the analytical UI does not load the old GLB.
5. Keep `three`, `lucide-react`, and `@types/three` dependencies installed. Pin `@simplewebauthn/server` to `14.0.1` and `@simplewebauthn/browser` to `14.0.0`. Apply `0003_accounts.sql` and `0004_integration_tokens.sql`; runtime initialization handles additive columns in previously created account or analysis tables. Preserve the starter's error reporting, design-inspector gate, and platform binding helpers.
6. Run the cloud build and typecheck. Commit, push using `website_repo_access`, then deploy using `deploy_website`.
7. Verify the public browser, analytical API, D1 persistence after reload, imports, filters and exports. Keep the legacy session checks when changing those handlers. A successful build alone is not deployment verification.

For hosted prediction releases, also include `deploy/higgsfield/container/`, its `inference/hosted/` runner copy, and the container configuration in `app.manifest.json`. Set the owner's secret through the platform UI, never in the checkout. Run the real example and inspect its result after deployment; passing offline container tests does not establish Google connectivity or model execution.

Local checks: `npm test` covers both the session and workspace handlers, alongside local API and client recovery tests. The tests exercise the actual handler through an injected D1 interface, including concurrent writes and database reopen persistence.

## Initial journey deployment verification

Deployed and published on 10 September 2026. The local and cloud production builds pass; 20 automated TypeScript tests and 5 Python export-helper tests pass. Twelve live public checks passed against D1: health, anonymous homepage, create/edit, replay, stale-write rejection, persisted progress, unchanged control, unscored export, required revisions, hosted OpenAPI, and byte-identical cell/concept assets. Fresh isolated Chrome sessions verified desktop 1440×1000 and mobile 390×667: UI-created sessions, native GLB load, Cell → DNA → RNA, pause/resume, persisted session and replay position after reload, scrubbed completion, concept image loading, no page/console errors, no failed HTTP responses, and no horizontal overflow. An uninterrupted replay reached completion automatically and remained completed after reload. Browser checks used software WebGL; physical mobile GPU performance was not measured.

## Outcome workspace release

The new workspace adds persistent comparison records, candidate selection in shared URLs, duplication, notes, revision-safe saves, and sourced exports. Each candidate has an isolated replay session; only confirmed playback settings are restored per tab, so different tabs do not overwrite each other.

Local verification: 31 API/storage tests pass, including full-capacity notes, atomic conflicts and additive D1 initialization. Desktop 1440×1000 and mobile 390×844 browser journeys passed persistence, duplication, comparison review, export provenance, sharing disclosure, replay and unscored-edit checks, with no page errors or horizontal overflow. Additional checks passed active-candidate/replay restoration, tab isolation, title normalization, stale-save draft preservation, reference controls and confirmed deletion. Browser rendering used software WebGL.

The earlier outcome deployment completed. Live inference remains disconnected.

## Analytical workspace release

Deployed on 11 September 2026. The browser loads the real 524-row historical AlphaGenome snapshot and its exact source scores. Public save, title restoration, matrix settings and opening the saved link in another tab were verified against D1. The mobile icon controls retain accessible names.

Local validation passed 56 tests and the production build, including server-rendered SVG tooltip regressions. Browser journeys verified filters, save/reload, shared records, stale-write recovery, SVG/PNG source attribution, CSV data, full JSON recipe import, invalid-input rejection and chromosome/track isolation. Browser checks can be repeated with `npm run test:browser` against a running local server. Live Atlas lookup and AlphaGenome inference remain disconnected.

## Junction release

The source now supports `kind: "junctions"` in the shared schema and both API adapters. It adds paired REF/ALT arc figures, exact-value tables, required track metadata, JSON imports and SVG/PNG/CSV/recipe exports. No database migration is required: analyses remain validated dataset/settings records in the existing table. Synchronize both frontend code and shared schemas before deploying, or the hosted API will reject the new dataset kind.

Deployed cloud revision `7b6490f` on 11 September 2026. Public desktop/mobile browser checks passed junction JSON import, shared scaling, null/zero markers, crossing endpoints, tables and SVG/PNG/CSV/JSON exports. Synthetic fixtures remained unsaved drafts. Junction save/reload passed locally; both API adapters passed persistence tests. The existing real 12-row DNM1 measurement record remains available from D1. The first actual junction prediction and its public persistence check remain pending. See [release validation](junction-release-validation.md).

## Native account release

The account UI uses browser passkeys and the same shared verification code on Node and Workers. Registration and authentication require user verification and exact configured origin/RP checks. Cookie sessions are HttpOnly, SameSite=Strict, Secure on HTTPS, and expire after seven days. Challenge cookies expire after five minutes. Only hashed tokens are stored. A final database guard prevents cancelled or logged-out ceremonies from creating usable sessions; logout also revokes sessions whose HTTP responses have not arrived.

Import, plotting and export still work anonymously. Saving prompts for a passkey; My analyses lists only the current account's bounded summaries. An explicit sign-in-to-save action can carry an anonymous draft into that account. Private analysis data is not persisted to browser storage. Account changes invalidate requests, figures, dialogs and pending downloads across tabs. There is no email recovery: users should add a second passkey while they can sign in. Display names are labels, not verified identities.

At this account release, local origins were localhost and 127.0.0.1 on ports 4190/4191 and the hosted origin was exactly https://helix-dna-lab.higgsfield.app. RP ID came from this fixed configuration, not arbitrary request headers. API automation used scoped access tokens created in the account dialog. They grant analytical access only; each token is bound to its issuing origin and stored as a hash. See [assistant integration](assistant-integration.md) for the current workflow. No model endpoint or inference was added in this release.

Validation and deployment evidence: [account release checks](account-release-validation.md).
