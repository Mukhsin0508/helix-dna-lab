# Native analytical accounts — release verification

Verified 11 September 2026. Hosted revision `2c9a166` is deployed at https://helix-dna-lab.higgsfield.app/.

## Delivered

Helix passkey accounts own newly saved analyses. Anonymous import, filtering, figures and exports remain available. Historical unowned analysis links remain public and read-only; saving a copy creates a new private record. My analyses supports bounded pagination, open and revision-checked deletion. The account dialog supports additional passkeys and sign-out; no email recovery service is configured.

Local SQLite and hosted D1 use the same analysis authorization and passkey verification modules. Private reads, updates, deletes and conflict payloads enforce the stored owner. Cookies contain random tokens; the database stores hashes. Every account/analysis mutation requires an exact configured Origin. Passkey verification requires user verification, expected RP ID, origin, challenge, credential identity and user-handle ownership. Final transaction guards fence logout and concurrent authentication, including a verification response arriving after logout.

## Verification

- 143 TypeScript tests passed, including 22 real-cryptography auth tests and 30 scientific persistence/ownership tests across local and hosted adapters. No verifier bypass or fake authentication endpoint is used.
- Local production build and hosted Node 22 client/Worker build passed.
- Disposable Chrome virtual authenticators exercised real registration and signed authentication against both local SQLite and the deployed Worker/D1 service. Registration, second passkey, private save, exact numerical retrieval, other-account denial, logout/revocation, reauthentication, CSRF rejection and owner deletion passed.
- Public UI checks passed explicit anonymous-draft sign-in/save, My analyses/open, private-link wording, no private browser-storage cache, two-tab identity changes, late private responses after logout, cancelled PNG downloads and mobile deletion. All seven UI checks completed with no page errors. Private QA analyses were deleted and sessions signed out.
- Desktop viewport: 1440 × 1000. Mobile viewport: 390 × 844. Sign-in stayed within the viewport and supported keyboard focus and Escape. Browser emulation is not a physical-device passkey compatibility test.
- Existing browser figure journeys passed exact 524-row published data, filters, save/reload, owner-only access, conflict/copy, SVG/PNG, JSON roundtrip, invalid CSV rejection and track isolation. Junction checks passed endpoint identity, REF/ALT shared scale, null versus zero, save/reload, all exports and responsive layout.
- A delayed account request blocks premature editing. If that request returns 503, anonymous editing and export unlock and retain newly typed input.

The existing DNM1 analysis `f838024b-593d-4555-9b81-599df07eca55` retained all 12 measured rows, revision zero and every field in its canonical serialized analysis payload. Before/after SHA-256: `fe86fb1ca81dd6fc1e37fb20ee97fbe0b04a0881e9e0f0777afad4a9685f84ad`. Its access envelope is now `legacy-public`, `canWrite: false`.

## Reproduce

Run `npm test` and `npm run build`. With a local server at an approved localhost origin, run `HELIX_QA_URL=http://localhost:4191 npm run test:accounts`, `QA_BASE=http://localhost:4191 npm run test:browser` and `QA_BASE=http://localhost:4191 npm run test:junction-browser`.

Account browser tests create clearly named QA accounts with disposable software authenticators; the keys are not user credentials. The two account scripts also ran against the public URL. Generated reports/screenshots are ignored under `qa-accounts/`, `qa-analysis/` and `qa-junctions/`.

## Remaining scope

This release adds account ownership to the analytical product. It does not connect AlphaGenome inference, supply model weights, add clinical probabilities, or authorize future AllMCP calls. Legacy educational session/workspace endpoints retain their public collaboration semantics. No model prediction or GPU job ran during this account release.
