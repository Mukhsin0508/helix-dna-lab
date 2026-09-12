# Use an assistant in Helix

The primary workflow is an assistant operating the [Genetic Engineering Lab website](https://genetic-engineering-lab.higgsfield.app/) through browser controls: open an example, inspect values and source methods, adjust the figure and export it. No AllMCP connection or integration token is required for this route. The complete browser workflow now works without signup: local drafts, source inspection, chart iteration and portable exports.

Follow the [browser-assisted workflow](browser-assistant-workflow.md). The assistant needs interactive browser tools in the chosen client/session. OpenAI documents page interaction and form entry through [cloud browser in ChatGPT Work](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt); availability and website support vary. This does not establish Helix compatibility in every client. The automated browser journey is verified in the release notes; this does not establish compatibility with every assistant client.

The deployed API and AllMCP provider remain optional, previously completed infrastructure. A user's AllMCP credential connection is not a launch requirement. Historical provider and browser checks are recorded in [release validation](assistant-integration-validation.md); they do not establish a completed ChatGPT or Claude browser workflow. The temporary AllMCP verification key was revoked and its absence confirmed after a full key-list reload.

## Optional API access

This section records retained backend capabilities. Account creation and token-management controls are no longer exposed by the no-signup website. Existing authorized API credentials keep their original scope and expiry; this release creates no new credentials. Browser users do not need this route.

## API connection available to a backend client

Use the current base URL `https://genetic-engineering-lab.higgsfield.app`. Send the token only in the `Authorization: Bearer …` header. Browser cookies are not needed for integration requests. The token works only on the origin that issued it; a token from the former hostname is not automatically valid after the rename. If a client supplies an `Origin` header, it must match the issuing website exactly.

| Request | Access | Result |
| --- | --- | --- |
| `GET /api/integrations/identity` | Read | Account identity and granted scopes; verify the intended account before writing. |
| `GET /api/analyses?limit=50` | Read | Your saved summaries and `nextCursor`; pass the cursor to retrieve another page. |
| `GET /api/analyses/{id}` | Read | Full `{analysis, access}` including data, settings and revision. |
| `POST /api/analyses` | Read and edit | Save `{dataset, settings}` as a new private analysis. |
| `PATCH /api/analyses/{id}` | Read and edit | Save `{revision, dataset, settings}` against the current revision. |
| `DELETE /api/analyses/{id}` | Read and edit | Delete the owned record using `{revision}`. |

Read tokens grant `analyses:read`; edit tokens grant both `analyses:read` and `analyses:write`. They cannot manage passkeys or other tokens. A supplied invalid bearer never falls back to an accompanying browser cookie. Private records belonging to another account return 404; read-only credentials cannot write. Historical public examples remain read-only.

See the [live OpenAPI contract](https://genetic-engineering-lab.higgsfield.app/api/openapi.json) and [analytical API guide](api.md) for fields and error responses. A 409 response means the revision changed: retrieve the latest record and reconcile or save a copy instead of overwriting it.

## Optional existing AllMCP provider

The **Helix** provider was released in production AllMCP against the former hostname. Its connection to the renamed website has not been verified; the release steps below are retained for reference and are not required to use the browser workspace:

1. Request `connect_provider(provider_key='helix')` through AllMCP and open its returned browser link.
2. Paste the token into **Helix personal access token** on the connection page. The internal credential field is `api_key`.
3. Run `helix_get_account` and confirm the returned account and scopes. Then list or open an analysis.

The implemented provider tools are `helix_get_account`, `helix_list_analyses`, `helix_get_analysis`, `helix_create_analysis`, `helix_update_analysis` and `helix_export_recipe`. Creation and updates require edit access. The current provider does not expose the API's delete operation.

Use this provider through the supported assistant's AllMCP connection. The Helix website is an HTTP API, not itself an MCP endpoint; do not enter its URL as a ChatGPT or Claude MCP server.

If choosing this optional route later, first verify a read: “List my saved Helix analyses and open the DNM1 analysis.” With edit access, a useful next task is: “Keep the dataset unchanged, update its figure settings, and save a private copy.” Open the returned analysis in Helix to inspect it. No user's stored Helix credential or assistant conversation was verified through this provider; neither is required for the browser-operated launch.

## Preserve the research record

The API supports molecular scores, paired genomic tracks, splice junctions and experimental measurements. It validates up to 5,000 rows and 2 MiB per analysis request. Save exact supplied values, coordinates, nulls, assay/scorer metadata and provenance alongside the figure settings. A chart change should preserve the original dataset. JSON retains the full analysis recipe; CSV is a data export and is not a replacement for its metadata. Keep any checksummed raw-result sidecar separately.

Imported provenance remains source-reported. The analytical API and optional provider manage saved analyses; they do not fetch source URLs, execute AlphaGenome, retrieve live Atlas results or calculate clinical success rates. A separate hosted prediction path requires the owner's AlphaGenome-issued secret; see [hosted API setup](hosted-api-setup.md). That key is missing and no authenticated prediction is verified yet. An analytical access token does not authorize this service. Private analysis links still require the owning account.
