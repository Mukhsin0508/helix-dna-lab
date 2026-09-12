# Hosted AlphaGenome integration checks

Verified 12 September 2026.

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

The rename release is live and its existing DNM1 analysis link loads all 12 measurement records at the new domain. The hosted prediction feature itself is **not deployed**. Higgsfield `website_repo_access(push)` repeatedly returns `INVALID_ARGUMENT` with a generic repository failure, even after preserving the checkout, obtaining a fresh checkout, and cherry-picking the committed feature onto the current remote parent `2109448`. There are no uncommitted changes or merge conflicts in that prepared cloud checkout. The provider withholds its underlying diagnostic.

Prepared cloud commit: `b66f38e` (same feature tree as the originally checked `37a2cbc`). Site ID: `f03029cb-ce1b-4736-ad02-3b026147a065`. Checkout: `/home/user/website-8a18cec008b4e9a094087c23`; a complete backup and bundle were retained in the sandbox, which is temporary. Permanent source and deployment mirror are stored in the private GitHub repository. No provider credentials were accessed or copied.

After the repository service is working, push the prepared source before deploying. Add the official `@cloudflare/containers` dependency pinned to `0.3.7` to the cloud app and retain its lockfile. Deploy only after push succeeds; recheck `/api/predictions/health` and the public form. Then add the owner's API key in website settings and redeploy to apply it before the first real inference check. A secret-presence health result is not authentication proof.
