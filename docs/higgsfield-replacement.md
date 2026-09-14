# Higgsfield replacement site

## Latest state: 15 September 2026

This section supersedes the earlier `has_container` blocker and provisioning handoff below. The interrupted retry completed with a terminal failure, but it **did start a Modal/Kaniko image build**. Container provisioning is no longer the first failing gate. The replacement remains undeployed.

Verified progression (build log times are UTC on 14 September):

- 20:23: image build started; `pip install alphagenome==0.9.0` failed after connection resets accessing the package index.
- Official PyPI metadata independently confirms version 0.9.0 exists and supports Python >=3.10. The editing sandbox could reach PyPI successfully. The pip message “No matching distribution” does not establish a missing version here.
- Cloud commit `b1b811a` selected explicit HTTPS PyPI and the system CA bundle, keeping TLS verification enabled. The 20:51 build still failed with connection resets.
- Cloud commit `a64102f` pinned 47 Linux amd64 / CPython 3.12 wheels and their official URLs/hashes. Direct image-builder downloads from `files.pythonhosted.org` also failed with a TCP connection reset at 21:01.
- Current cloud commit **`dbb7d50`** stages those verified public dependencies as one Higgsfield-hosted archive and installs offline with `--require-hashes`, followed by `pip check`. The 21:11 build failed fetching the archive from Higgsfield's CloudFront storage, again with a TCP connection reset. It did not reach package installation or application startup.

The uploaded archive contains only public Python dependencies, no DNA records, source credentials or user data. Upload returned HTTP 200 and was confirmed by Higgsfield. Its URL is recorded in `deploy/higgsfield/container/wheels.lock.json`; SHA-256 is `ded9580ec6403c461a1bb424ce9164ee37e7ab79f8035663370c737379bd25ed`. Each of 47 downloaded wheel digests matched official PyPI metadata. Dependency metadata was checked for Linux CPython 3.12 with zero unresolved requirements. This is dependency validation, not a successful runtime or inference test.

The cloud Dockerfile, requirements lock and wheel provenance manifest have been mirrored into the local deployment source. No wheel binaries are committed. The old app remains unpublished; no further database changes were made. No new API key or live prediction was verified.

**Current platform handoff:** restore working HTTPS downloads in the Kaniko build environment for replacement `46d5b44c-60a8-4bb9-ba5f-309a42b2290c`. PyPI, Python's file host and Higgsfield's own artifact host all returned connection resets from the image builder, while the editing sandbox could download and upload the dependency bundle. Inspect the builder's egress/proxy configuration; the precise network cause is not yet proven. After that, deploy pushed commit `dbb7d50` and verify installation, startup and the web application. No build is known to be running after the final terminal failure above.

## Earlier migration record

Updated 14 September 2026. The selected approach stays on Higgsfield: create a fresh standalone website and test clean provisioning with the existing analytical application. This is a hosting replacement, preserving the no-signup workspace, published source data and analytical figures. It does not add generated imagery or a different product.

## Exact migration targets

| Role | Site ID | Slug and URL |
| --- | --- | --- |
| New replacement | `46d5b44c-60a8-4bb9-ba5f-309a42b2290c` | `genetic-lab` · expected `https://genetic-lab.higgsfield.app/` |
| Old deployment; the only shutdown target | `f03029cb-ce1b-4736-ad02-3b026147a065` | `genetic-engineering-lab` · `https://genetic-engineering-lab.higgsfield.app/` |

New checkout: `/home/user/website-6b79dd4ee3b8075dc4b8d7b6`. This is a temporary Higgsfield checkout, not the permanent source repository.

The replacement website has been created. The complete application from existing cloud commit `003a8da` was copied into its repository, and the old origin references were changed to `genetic-lab.higgsfield.app`. Installation from the frozen dependency lockfile and the cloud TypeScript check passed. Replacement cloud commit **`9d00d45`** was pushed successfully.

**The first replacement deployment failed; the replacement is not live.** Its exact build log was:

```text
build started: slug=genetic-lab env=prod (modal)
[build] FAILED: container app: not supported on the modal build backend, redeploy once has_container is set
```

The expected URL above is not evidence of a successful deployment. The one known public DNM1 source row has been exported and validated locally; no D1 data migration has been executed. The old app has now been reversibly unpublished and appears under Private apps. This does not establish termination of its runtime resources. No other site is a shutdown target.

The earlier source push and container-backend failures remain documented in [hosted API validation](hosted-api-validation.md). The fresh site's first attempt returned the same container-backend failure, so creating a replacement did not resolve the deployment blocker. No deeper platform cause is established by this log. No AlphaGenome API key is configured; authenticated inference remains unverified. Neither a successful source push nor a configured health response proves a Google prediction ran.

## Preserve the one known public DNM1 analysis

The record to preserve is `f838024b-593d-4555-9b81-599df07eca55`, containing 12 experimental DNM1 measurements. It must remain read-only public data with the same ID, dataset, provenance, figure settings, revision and timestamps. Do not copy private analyses, accounts, passkeys, sessions, integration tokens or user tables.

The existing public export path is:

```text
GET https://genetic-engineering-lab.higgsfield.app/api/analyses/f838024b-593d-4555-9b81-599df07eca55
```

Request it without cookies or an Authorization header. The current handler returns `{analysis, access}` and allows an anonymous read only for an unowned row. Require the exact record ID, `access.mode: "legacy-public"`, `access.canWrite: false`, a valid measurement dataset and all 12 rows before accepting the export. Keep the complete response and checksum its bytes. Validate the dataset and settings with the existing shared schemas; compare without rounding numbers or replacing null uncertainty values.

For a byte-exact copy of the database payload, an authorized one-row D1 read can retrieve only:

```sql
SELECT id, payload, revision, updated_at, owner_id
FROM lab_analyses
WHERE id = ? AND owner_id IS NULL;
```

Bind the known ID. Require exactly one row and verify the payload's ID, revision and update timestamp agree with its columns. The raw `payload` string is the record; the API's enclosing `{analysis, access}` response is not a database payload. Initialize the destination's existing `lab_analyses` schema, then use a parameterized insert into the new site's D1:

```sql
INSERT INTO lab_analyses (id, payload, revision, updated_at, owner_id)
VALUES (?, ?, ?, ?, NULL);
```

Do not use `INSERT OR REPLACE`, reset the revision, create a new ID or assign an account owner. If that ID already exists, stop and compare the full row before proceeding. The public `POST /api/analyses` route is unsuitable for this migration: it requires account authentication, generates a new UUID and creates a private analysis.

Source implementation: [public access and storage handler](../shared/analyses.server.ts), [dataset and figure-record validation](../shared/analysis-record.ts), and [cookie-free browser loading](../src/useAnalysis.ts).

### Source export verified on 14 September

An owner-authorized Higgsfield `website_db` query exported only the exact public row, restricted by its ID and `owner_id IS NULL`. The ignored local backup is `qa-hosted/migration-public-dnm1-2026-09-14.json`, containing source site ID, export date and the row, with `row.payload` retained as the exact database string. This backup is not committed or bundled into the app.

Local validation passed against `analysisCreateSchema`, the shared analysis ID schema, and explicit record identity, revision and timestamp checks. The exported row belongs to old site `f03029cb-ce1b-4736-ad02-3b026147a065`, has the expected analysis ID, `owner_id: null`, revision zero, and 12 GRCh38 measurement rows. The two distinct DNM1 entries retain values `0.94` and `0.76`; all replicate counts and standard errors remain null. Schema validation introduced no changes to the dataset or figure settings.

| Checksum representation | SHA-256 |
| --- | --- |
| Exact UTF-8 `row.payload` database string | `981b83ef7bc435fa784c2d7006757d1c150de067271593216fd1325c880466c1` |
| Parsed complete analysis, recursively sorted object keys and compact JSON | `fe86fb1ca81dd6fc1e37fb20ee97fbe0b04a0881e9e0f0777afad4a9685f84ad` |

The full parsed record was also compared with `qa-accounts/legacy-before.json`: every field is equal. Canonicalizing both records reproduces the checksum recorded in [account release validation](account-release-validation.md). The raw-versus-canonical hash difference is serialization, not a changed scientific result. Destination verification must compare the migrated row against this fresh export, retaining the exact raw payload string where possible.

After insertion, anonymously retrieve the same endpoint on `genetic-lab.higgsfield.app` and compare the complete analysis with the fresh source export. Verify the 12 rows, source provenance, exact printed values and null uncertainty, then reload:

```text
https://genetic-lab.higgsfield.app/?analysis=f838024b-593d-4555-9b81-599df07eca55
```

This public link is a verification target, not a completed migration claim. Browser IndexedDB drafts belong to their original origin and are not transferred by copying the application or D1 record; exported analysis JSON is the portable format.

## Completion evidence still needed

- [x] Create the new standalone Higgsfield website with the exact replacement ID above.
- [x] Copy and push the existing analytical application into the new repository (`9d00d45`); frozen-lockfile installation and cloud typecheck passed.
- [x] Export and locally validate only the known public DNM1 source row, preserving its exact payload and confirming equality with the historical record.
- [ ] Deploy successfully and verify the new anonymous homepage, imported data, figures and exports.
- [ ] Preserve and verify the one public DNM1 record on the new origin.
- [ ] Check prediction configuration and error behavior without exposing the service key; real inference remains separate until access is configured and a genuine result is verified.
- [x] Reversibly unpublish only old site `f03029cb-ce1b-4736-ad02-3b026147a065`; verify the owner UI shows Private apps and the status tool reports `listed_in_community: false`.
- [ ] Verify anonymous access behavior and runtime shutdown separately from community unpublishing.

## Owner UI verification and unpublishing

On 14 September, Chrome's Higgsfield profile matched the personal Gmail account confirmed by the user. My apps showed both exact website IDs listed above. For the old Helix app only, Actions → Unpublish → Yes, unpublish completed. The confirmation described removal from the community feed and immediate republication; the app moved from Published apps to Private apps. The MCP status then returned `listed_in_community: false` and `marketplace_url: null`. The source repository and database were not deleted, and no unrelated app was changed.

The replacement appeared under Private apps with Publish disabled. No container provisioning control was reached. Its latest status still reports the exact Modal/`has_container` failure above. The replacement preview did not render a usable lab; the dashboard subsequently rendered blank.

Anonymous HTTP verification of the old homepage and the exact public DNM1 endpoint did not complete: the sandbox reported DNS resolution failures, and the escalated retry was aborted. Therefore unpublishing is verified, but anonymous access blocking and runtime termination are not. Do not describe this as a completed infrastructure shutdown.

## Platform provisioning handoff

For Higgsfield support or an authorized platform operator:

- Replacement site: `46d5b44c-60a8-4bb9-ba5f-309a42b2290c`, slug `genetic-lab`, source commit `9d00d45`.
- The app manifest requests container instance `standard-2`, port `8080`, sleep after `5m`.
- The build is routed to Modal and rejects the container, asking for `has_container` to be set. Please provision a supported container backend or correct this site's deployment routing, then redeploy the existing pushed source. Creating a second site produced the same failure.
- After a successful deployment, verify the homepage and prediction health, migrate only the validated public DNM1 row, and configure the AlphaGenome key through the platform's secret settings. A real prediction must still be tested.
- If full termination is required for the old site, use a supported reversible stop operation for `f03029cb-ce1b-4736-ad02-3b026147a065`. The exposed CLI delete operation also erases the database and repository and was not used.

No destination D1 write or migration was executed. This record establishes the export, source push and reversible unpublishing; replacement deployment and runtime shutdown remain incomplete.
