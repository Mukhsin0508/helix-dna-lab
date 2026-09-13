# Hosted AlphaGenome integration checks

Software checks verified 12 September 2026. Deployment status updated 13 September 2026.

- Official Python client pinned to `alphagenome==0.9.0`; 16 runner tests use actual SDK data containers with explicitly synthetic arrays and mocked network/model calls.
- Ten container coordinator tests and six Python service wrapper tests cover request isolation, idempotency, deadlines, bounded output, result validation and sanitized failures.
- All 187 Node tests pass, including four prediction broker tests. Both local production build and the actual Higgsfield application TypeScript check pass.
- Browser check through the production frontend against the local software fixture: submit the chromosome 22 example at 256 bp, validate the source checksum, change to 128 bp, confirm the previous result disappears, run again and open the new paired tracks. The dataset is explicitly labeled synthetic and no Google call is made.
- Phone-width check at 390 pixels: 366-pixel dialog, no document horizontal overflow. No browser console errors observed.
- The renamed public website opens without signup at https://genetic-engineering-lab.higgsfield.app/.

## Still awaiting the API key

No AlphaGenome secret is configured, and no authenticated Google prediction has run. These checks establish software behavior; they do not establish model access, Google connectivity from the deployed container, biological accuracy or a working end-to-end inference service. Follow [the setup guide](hosted-api-setup.md), redeploy after adding the secret, and run the public example to establish those service checks.

The local fixture server and its `qa-hosted/` artifacts are test-only and excluded from the deployed source. The deployment includes the genuine hosted runner with no synthetic fallback.

## Deployment handoff

The rename release is live, and its existing saved DNM1 view still loads all 12 measurement records after reload at the new domain. The hosted prediction source was successfully pushed through Higgsfield on **13 September 2026 at 01:54:28 UTC**, at cloud commit **`003a8da`** (parent `2109448`). The cloud application TypeScript check passed. **Two deployment attempts failed; the new hosted prediction features are not live.** A successful push and typecheck do not establish deployment.

The earlier push blocker is resolved. On 12 September, `website_repo_access(push)` repeatedly returned `INVALID_ARGUMENT` with a generic repository failure, including after a fresh checkout and cherry-pick onto `2109448`; the provider did not expose its underlying diagnostic. The earlier prepared commits `b66f38e` and `37a2cbc` are historical preparation records, not the current pushed revision.

Site ID: `f03029cb-ce1b-4736-ad02-3b026147a065`. Permanent source and the deployment mirror remain in the private GitHub repository; temporary checkout backups were retained during the earlier recovery. No provider credentials were accessed or copied.

Both deployment attempts returned this exact build log:

```text
build started: slug=genetic-engineering-lab env=prod (modal)
[build] FAILED: container app: not supported on the modal build backend, redeploy once has_container is set
```

The application manifest matches the container guide. The available public MCP tools expose no backend-selection or `has_container` control, and no API request ID was returned. The required Higgsfield action is to enable or provision a container-supported backend for site `f03029cb-ce1b-4736-ad02-3b026147a065`, then redeploy the pushed source. The log establishes the deployment blocker; no deeper cause has been verified.

After that deployment succeeds, verify `/api/predictions/health` and the public prediction form at the renamed domain. Retain the official `@cloudflare/containers` dependency pinned to `0.3.7` and the cloud lockfile. The owner still needs to configure `ALPHAGENOME_API_KEY` in website settings and redeploy if required to apply it before the first real inference check. No authenticated Google inference is verified. A secret-presence health result is not authentication proof.
