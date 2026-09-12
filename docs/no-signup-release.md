# No-signup workspace — September 12, 2026

The primary website now opens directly into analysis. Signup, account menus, cloud-save prompts and token management are removed from its UI. Validated datasets and settings save automatically in browser IndexedDB. Export JSON provides portable sharing; no imported data is uploaded to a server.

The editor has more space around its controls and canvas. Published examples are immediately available in the dataset section. Source evidence and exact values remain accessible, including on mobile. Figures retain the same numerical rendering and provenance.

## Verification

- Production TypeScript/Vite build passed.
- All 168 existing TypeScript API/scientific tests passed, including private ownership and authentication protections.
- Five new storage/public-load unit tests and ten isolated Chrome/IndexedDB test groups passed.
- Local Chrome journey passed all 12 real DNM1 source values, evidence inspection, rapid variant/title edits, committed-save reload, second-tab isolation, SVG/PNG/CSV/JSON downloads and recipe reimport with identical data/settings.
- Desktop 1440×1000 and mobile 390×844 had no browser errors or horizontal document overflow.
- The local browser journey made zero API requests and required no backend.
- Cloud revision `4ae5df4` deployed successfully to https://helix-dna-lab.higgsfield.app.
- The same six-group DNM1 browser journey passed on production with zero API calls, server writes or browser errors.
- The five-group public junction journey passed autosave/reload, exact precision, null/zero handling, shared scales, spanning endpoints, every export format and mobile sizing. Its synthetic fixture stayed in a disposable browser; no server writes occurred.
- The existing public DNM1 source link was reloaded in the user-facing in-app browser and showed all 12 measurements, the new controls and “Saved in this browser.”

Run the active journey with `npm run test:browser`; override `HELIX_QA_URL` for production. Evidence is saved under `test-results/local-workspace/` by default. Account-oriented browser tests from earlier releases are historical; API ownership tests remain active.

## Boundaries

Existing private server records keep their API access protections. Public-source requests omit credentials and reject owner envelopes. Local drafts are not public links or a remote backup. Browser storage failures are reported; JSON export remains available. Live inference is still disconnected and this release introduces no scientific predictions.
