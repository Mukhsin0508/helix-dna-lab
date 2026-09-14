# Higgsfield replacement site

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

The expected URL above is not evidence of a successful deployment. No D1 data migration has been executed. Shutdown of the old project is not confirmed and remains pending. No other site is a shutdown target.

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

Source implementation: [public access and storage handler](../shared/analyses.server.ts), [dataset and figure-record validation](../shared/analysis-record.ts), and [cookie-free browser loading](../src/useAnalysis.ts). The earlier account-release check recorded canonical payload SHA-256 `fe86fb1ca81dd6fc1e37fb20ee97fbe0b04a0881e9e0f0777afad4a9685f84ad`; this is historical evidence. Capture and compare a fresh source export for the replacement migration instead of assuming the old digest is current.

After insertion, anonymously retrieve the same endpoint on `genetic-lab.higgsfield.app` and compare the complete analysis with the fresh source export. Verify the 12 rows, source provenance, exact printed values and null uncertainty, then reload:

```text
https://genetic-lab.higgsfield.app/?analysis=f838024b-593d-4555-9b81-599df07eca55
```

This public link is a verification target, not a completed migration claim. Browser IndexedDB drafts belong to their original origin and are not transferred by copying the application or D1 record; exported analysis JSON is the portable format.

## Completion evidence still needed

- [x] Create the new standalone Higgsfield website with the exact replacement ID above.
- [x] Copy and push the existing analytical application into the new repository (`9d00d45`); frozen-lockfile installation and cloud typecheck passed.
- [ ] Deploy successfully and verify the new anonymous homepage, imported data, figures and exports.
- [ ] Preserve and verify the one public DNM1 record on the new origin.
- [ ] Check prediction configuration and error behavior without exposing the service key; real inference remains separate until access is configured and a genuine result is verified.
- [ ] Shut down only old site `f03029cb-ce1b-4736-ad02-3b026147a065`, recording the shutdown result explicitly and keeping replacement availability separate.

No data export, D1 mutation, deployment or shutdown was performed as part of writing this document.
