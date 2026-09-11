const date = { type: 'string', format: 'date-time' };
const scopes = { type: 'array', items: { enum: ['analyses:read', 'analyses:write'] }, minItems: 1, maxItems: 2 };
const summary = { type: 'object', additionalProperties: false,
  required: ['id', 'label', 'scopes', 'createdAt', 'expiresAt', 'lastUsedAt'], properties: {
    id: { type: 'string', format: 'uuid' }, label: { type: 'string', minLength: 1, maxLength: 80 }, scopes,
    createdAt: date, expiresAt: date, lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
  } };
const result = (schema: object, description: string) => ({ description, content: { 'application/json': { schema } } });
const errors = { '400': { description: 'Invalid fields.' }, '401': { description: 'Required session or access token is missing, revoked or expired.' },
  '403': { description: 'Wrong origin, insufficient scope, or token used to manage account credentials.' },
  '404': { description: 'Token unavailable or belongs to another account.' }, '413': { description: 'Token management request exceeds 2 KiB.' },
  '429': { description: 'Token or request limit reached.' } };
const session = [{ helixSession: [] }];
const bearer = [{ helixAccessToken: [] }];

export const integrationSecuritySchemes = {
  helixAccessToken: { type: 'http', scheme: 'bearer', description: 'Opaque scoped Helix token, issued once from Account → Connect an assistant. Send in Authorization only, never a URL. Read access permits owned analysis retrieval/list; write also permits create/update/delete. Valid only for its issuing website. Does not grant passkey/token management, model execution or access to other accounts.' },
};
export const integrationPaths = {
  '/api/integrations/identity': { get: { operationId: 'getIntegrationIdentity', summary: 'Verify an access token and its account/scopes', security: bearer,
    responses: { '200': result({ type: 'object', required: ['account', 'scopes'], properties: {
      account: { type: 'object', required: ['id', 'displayName'], properties: { id: { type: 'string', format: 'uuid' }, displayName: { type: 'string' } } }, scopes,
    } }, 'Verified identity. Does not return the credential or create a browser session.'), ...errors } } },
  '/api/account/tokens': {
    get: { operationId: 'listIntegrationTokens', summary: 'List your unexpired integration tokens', security: session,
      description: 'Passkey session only; Authorization headers are rejected. Secrets are never returned by listing.',
      responses: { '200': result({ type: 'object', required: ['tokens'], properties: { tokens: { type: 'array', items: summary } } }, 'Token metadata only.'), ...errors } },
    post: { operationId: 'createIntegrationToken', summary: 'Create an expiring integration token', security: session,
      description: 'Passkey session and exact same-origin Origin required. Maximum 20 active tokens per account. Copy the secret directly into the integration connection form; do not send it in a conversation. Signing out does not revoke previously issued integration tokens; revoke them explicitly.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false,
        required: ['label'], properties: { label: { type: 'string', minLength: 1, maxLength: 80 }, access: { enum: ['read', 'write'], default: 'read' }, expiresInDays: { enum: [7, 30, 90], default: 30 } },
      } } } },
      responses: { '201': result({ type: 'object', required: ['token', 'details'], properties: { token: { type: 'string', description: 'Shown once; only its hash is persisted.' }, details: summary } }, 'New credential. no-store response.'), ...errors } },
  },
  '/api/account/tokens/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    delete: { operationId: 'revokeIntegrationToken', summary: 'Revoke your integration token', security: session,
      description: 'Passkey session and exact same-origin Origin required. Cannot revoke another account’s token.',
      responses: { '204': { description: 'Revoked. Subsequent token requests fail authentication.' }, ...errors } },
  },
};
