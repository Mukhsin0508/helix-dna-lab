# Connect an assistant to Helix

Helix exposes the same saved numerical analyses to the website and an authenticated API. The assistant can inspect data and, with edit permission, save a figure recipe that you reopen in the lab.

**Status — 11 September 2026:** access-token support is deployed to [Helix](https://helix-dna-lab.higgsfield.app/). Public browser checks pass for creation, scopes, one-time display, revocation, mobile controls and delayed-response handling. Eight registered AllMCP tool calls passed against real public Helix requests; the browser reopened the same private analysis with all 12 source measurements intact. The AllMCP credential lookup was substituted in memory for this test. Its provider is not deployed or connected, and no ChatGPT or Claude connection has been verified. These are separate delivery steps.

## Create access

1. Open [helix-dna-lab.higgsfield.app](https://helix-dna-lab.higgsfield.app/) and sign in with your passkey.
2. Open **Account → Connect an assistant → Create access token**.
3. Label the connection, for example `AllMCP`. Start with **Read only**. Choose **Read and edit** only when the assistant should create, update or delete analyses.
4. Choose 7, 30 or 90 days. The default is 30 days.
5. Copy the token directly into the integration's private credential field. It is shown once. Do not paste it into a conversation, URL, source file or screenshot.

The account panel lists active tokens, expiry and last use. Use **Revoke → Confirm revoke** to disconnect one. Signing out of the browser does not revoke an already-issued integration token. An expired or revoked token cannot authenticate; create a replacement when needed. Each account can have up to 20 active tokens.

## API connection available to a backend client

Use the fixed base URL `https://helix-dna-lab.higgsfield.app`. Send the token only in the `Authorization: Bearer …` header. Browser cookies are not needed for integration requests. The token works only on the website that issued it. If a client supplies an `Origin` header, it must match that website exactly.

| Request | Access | Result |
| --- | --- | --- |
| `GET /api/integrations/identity` | Read | Account identity and granted scopes; verify the intended account before writing. |
| `GET /api/analyses?limit=50` | Read | Your saved summaries and `nextCursor`; pass the cursor to retrieve another page. |
| `GET /api/analyses/{id}` | Read | Full `{analysis, access}` including data, settings and revision. |
| `POST /api/analyses` | Read and edit | Save `{dataset, settings}` as a new private analysis. |
| `PATCH /api/analyses/{id}` | Read and edit | Save `{revision, dataset, settings}` against the current revision. |
| `DELETE /api/analyses/{id}` | Read and edit | Delete the owned record using `{revision}`. |

Read tokens grant `analyses:read`; edit tokens grant both `analyses:read` and `analyses:write`. They cannot manage passkeys or other tokens. A supplied invalid bearer never falls back to an accompanying browser cookie. Private records belonging to another account return 404; read-only credentials cannot write. Historical public examples remain read-only.

See the [live OpenAPI contract](https://helix-dna-lab.higgsfield.app/api/openapi.json) and [analytical API guide](api.md) for fields and error responses. A 409 response means the revision changed: retrieve the latest record and reconcile or save a copy instead of overwriting it.

## AllMCP connection after provider deployment

Once the **Helix** provider is released in AllMCP:

1. Request `connect_provider(provider_key='helix')` through AllMCP and open its returned browser link.
2. Paste the token into **Helix personal access token** on the connection page. The internal credential field is `api_key`.
3. Run `helix_get_account` and confirm the returned account and scopes. Then list or open an analysis.

The implemented provider tools are `helix_get_account`, `helix_list_analyses`, `helix_get_analysis`, `helix_create_analysis`, `helix_update_analysis` and `helix_export_recipe`. Creation and updates require edit access. The current provider does not expose the API's delete operation.

Use this provider through the supported assistant's AllMCP connection. The Helix website is an HTTP API, not itself an MCP endpoint; do not enter its URL as a ChatGPT or Claude MCP server.

First verify a read: “List my saved Helix analyses and open the DNM1 analysis.” With edit access, a useful next task is: “Keep the dataset unchanged, update its figure settings, and save a private copy.” Open the returned analysis in Helix to inspect it. These are intended workflows to verify after the provider is deployed, not claims that an assistant is connected today.

## Preserve the research record

The API supports molecular scores, paired genomic tracks, splice junctions and experimental measurements. It validates up to 5,000 rows and 2 MiB per analysis request. Save exact supplied values, coordinates, nulls, assay/scorer metadata and provenance alongside the figure settings. A chart change should preserve the original dataset. JSON retains the full analysis recipe; CSV is a data export and is not a replacement for its metadata. Keep any checksummed raw-result sidecar separately.

Imported provenance remains source-reported. The API does not fetch source URLs, run AlphaGenome, retrieve live Atlas results, or calculate clinical success rates. The integration provides access to saved analyses; a token does not connect or authorize GPU inference. Private analysis links still require the owning account.
