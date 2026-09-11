const account = { type: 'object', additionalProperties: false, required: ['id', 'displayName'], properties: {
  id: { type: 'string', format: 'uuid' }, displayName: { type: 'string', minLength: 1, maxLength: 80 },
} };
const jsonBody = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });
const jsonResult = (schema: object) => ({ description: 'Account response. Session and ceremony cookies are HttpOnly, SameSite=Strict and Secure on HTTPS.', content: { 'application/json': { schema } } });
const empty = { type: 'object', additionalProperties: false, properties: {} };
const accountResult = jsonResult({ type: 'object', required: ['account'], properties: { account: { anyOf: [account, { type: 'null' }] } } });
const errors = { '400': { description: 'Invalid, expired or already consumed WebAuthn ceremony.' }, '401': { description: 'Sign in to your account.' },
  '403': { description: 'Origin or account binding rejected.' }, '409': { description: 'A concurrent sign-in changed the credential. Retry.' },
  '413': { description: 'Request exceeds 16 KiB.' }, '429': { description: 'Account attempt budget exceeded.' } };
const optionsResult = jsonResult({ type: 'object', required: ['options'], properties: { options: { type: 'object', description: 'WebAuthn JSON options, consumed by the browser passkey API. Challenge is valid for five minutes and bound to an HttpOnly ceremony cookie.' } } });
const credential = jsonBody({ type: 'object', additionalProperties: false, required: ['response'], properties: { response: { type: 'object', description: 'JSON result from navigator.credentials.create/get or SimpleWebAuthn browser. Verified by the server; not a bearer token.' } } });
export const accountSecuritySchemes = { helixSession: { type: 'apiKey', in: 'cookie', name: 'helix_session', description: 'Opaque session established by verified passkey registration or authentication. Expires after seven days. Mutations also require the exact same-origin Origin header.' } };
export const accountPaths = {
  '/api/account': { get: { operationId: 'getAccount', summary: 'Read the current account or null', responses: { '200': accountResult, ...errors } } },
  '/api/account/logout': { post: { operationId: 'signOut', summary: 'Revoke the current server session', requestBody: jsonBody(empty), responses: { '200': accountResult, ...errors } } },
  '/api/account/passkeys': { get: { operationId: 'listPasskeys', summary: 'List your passkey summaries', security: [{ helixSession: [] }], responses: {
    '200': jsonResult({ type: 'object', properties: { passkeys: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' }, lastUsedAt: { type: ['string', 'null'] }, deviceType: { enum: ['singleDevice', 'multiDevice'] }, backedUp: { type: 'boolean' },
    } } } } }), ...errors,
  } } },
  ...Object.fromEntries(['registration', 'authentication', 'passkeys'].flatMap(kind => [
    [`/api/account/${kind}/options`, { post: { operationId: `${kind}Options`, summary: `Begin passkey ${kind === 'passkeys' ? 'addition' : kind}`,
      ...(kind === 'passkeys' ? { security: [{ helixSession: [] }] } : {}),
      requestBody: jsonBody(kind === 'registration' ? { type: 'object', additionalProperties: false, required: ['displayName'], properties: { displayName: { type: 'string', minLength: 1, maxLength: 80 } } } : empty),
      responses: { '200': optionsResult, ...errors } } }],
    [`/api/account/${kind}/verify`, { post: { operationId: `${kind}Verify`, summary: `Verify passkey ${kind === 'passkeys' ? 'addition' : kind}`,
      ...(kind === 'passkeys' ? { security: [{ helixSession: [] }] } : {}), requestBody: credential, responses: { '200': accountResult, ...errors } } }],
  ])),
};
