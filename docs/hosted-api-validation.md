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
