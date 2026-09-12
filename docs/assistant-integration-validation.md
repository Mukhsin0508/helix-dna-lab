# Analytical assistant integration validation

Verified 11 September 2026 against https://helix-dna-lab.higgsfield.app/.

## Current direction

The owner selected direct browser operation as the primary assistant workflow. No AllMCP connection or integration token is required for launch. Public examples can be inspected and exported without sign-in; private analyses retain their passkey account permissions. The complete browser-assisted research workflow is not yet verified. See the [browser workflow](browser-assistant-workflow.md).

The checks below remain evidence for already delivered browser features and optional API/provider infrastructure. They do not imply that a ChatGPT or Claude session has completed the browser workflow.

## Existing public browser feature checks

The integration-token release `95a3239` passed four browser test groups with zero page errors. Tests used real browser-generated passkeys in disposable QA accounts. Read-only/30-day defaults, explicit editing permission, one-time display and copy, no secret persistence in browser storage, confirmed revocation, mobile layout, focus handling and delayed responses after closing or signing out were checked.

The test waits for completed HTTP revocation before checking the token list. Hiding the initial button when its confirmation opens is not evidence that revocation completed. Final cleanup reauthenticates the exact QA account, revokes remaining tokens and signs out.

Follow-up release `d2aff10` preserves client error codes when the local or hosted account-body reader rejects invalid input. Empty/malformed JSON returns 400 rather than 500; valid JSON logout still returns 200. The final local suite has 168 passing tests, and the TypeScript/production build passes.

## Optional provider: registered tools and real Helix HTTP

The isolated AllMCP provider's `scripts/smoke_helix_provider.py --live` invoked actual registered FastMCP tools. Only the AllMCP credential lookup and request context were replaced with in-memory QA values; HTTP, Helix bearer authorization and D1 persistence were real.

Eight calls verified identity, source read, private copy creation, title update, stale-revision conflict, owned listing, persisted read and full recipe export. The complete dataset and settings were checked for equality, including export format, saved revision and `inferencePerformed: false`.

A signed-in browser then opened the same private analysis and checked the exact updated figure title and all 12 published DNM1 measurements. The QA record and token were deleted/revoked, and browser logout returned 200. No user data was changed and no model was run.

## Optional provider: production AllMCP release and connection form

[AllMCP PR 620](https://github.com/Perception-Dynamics-Inc/allmcp.co/pull/620) merged as squash commit `20be84c348b6cfb533d64e5c7595db5355d213d7`. The production deployment [run 34597927894](https://github.com/Perception-Dynamics-Inc/allmcp.co/actions/runs/34597927894) succeeded at `2026-09-11T12:17:15Z`. The production [health endpoint](https://go.allmcp.co/health) returned HTTP 200 with `OK`.

A new check used the real production FastMCP `StreamableHttpTransport`, authenticated with a temporary key created in the verified user's AllMCP browser account. This check did not substitute credential lookup or request context:

- `list_connections(provider='helix')` returned no connections.
- `list_providers(search='Helix')` returned the exact `helix` provider with `enabled: true`, category `analytics` and authentication type `api_key`.
- `describe_category` refused access until a provider connection exists.
- `connect_provider` returned `action_required` with a signed connection URL.
- Chrome opened that URL and rendered the **Helix personal access token** field for the signed, verified user's AllMCP tenant.

The provider check stopped at the user's Helix passkey sign-in. It did not store a Helix credential or complete a user-authorized Helix connection. The owner subsequently removed this connection from the required launch workflow. No ChatGPT or Claude conversation has been verified.

Cleanup is complete. After revoking the temporary AllMCP verification key, a full key-list reload showed the original four keys and no temporary key. Its browser-tool variable and clipboard copy were cleared, and the temporary local verification server was stopped. Cleanup of the earlier Helix HTTP smoke test is also complete.

## Boundaries

- The earlier eight-tool smoke verifies registered tool dispatch and real Helix persistence using substituted AllMCP context. The later production check verifies real AllMCP authentication, provider discovery and the signed connection form. Neither verifies storage and use of a user's Helix credential in production AllMCP.
- Provider deployment is complete and remains optional. A stored AllMCP user connection is no longer a launch requirement. The primary no-signup browser workflow passed on the public site on September 12; see [release checks](no-signup-release.md).
- Provider work is tracked under [ALLMCP-414](https://linear.app/metrix-navigator/issue/ALLMCP-414/add-helix-provider-for-private-numerical-analyses-and-figure-recipes). The AllMCP release and public Helix release are separate deployments.
- Model predictions are not generated by creating a chart, importing a result or saving a recipe.
- Scientific validation against matching measured endpoints remains a separate unfinished step.
