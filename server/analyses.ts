import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ANALYSIS_BODY_LIMIT } from '../shared/analysis-record.ts';
import { handleAnalysisRequest } from '../shared/analyses.server.ts';
import { createAccountService } from '../shared/auth.server.ts';
import { createIntegrationTokenService } from '../shared/integration-tokens.server.ts';
import { createAuthDatabase } from './auth-database.ts';

const LOCAL_ORIGINS = ['http://localhost:4191', 'http://127.0.0.1:4191', 'http://localhost:4190', 'http://127.0.0.1:4190'];
/** Internal rate-limit identity comes from Fastify, never a caller-controlled header. */
function webRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
    else if (value !== undefined) headers.set(name, String(value));
  }
  headers.set('x-helix-client-address', request.ip);
  return new Request(`${request.protocol}://${request.headers.host}${request.url}`, { method: request.method, headers });
}
async function send(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  response.headers.forEach((value, name) => { if (name !== 'set-cookie') reply.header(name, value); });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header('set-cookie', cookies);
  return reply.code(response.status).send(response.status === 204 ? undefined : await response.text());
}
/** Account and analysis handlers share one SQLite connection, including in-memory tests. */
export function registerAnalysisRoutes(app: FastifyInstance, path: string): void {
  const db = createAuthDatabase(path);
  const accounts = createAccountService(db, { origins: LOCAL_ORIGINS });
  const tokens = createIntegrationTokenService(db, accounts);
  app.addHook('onClose', async () => { db.close(); });
  for (const url of ['/api/account', '/api/account/*', '/api/integrations/identity']) {
    app.route({ method: ['GET', 'POST', 'DELETE'], url, bodyLimit: 64 * 1024, handler: async (request, reply) => {
      const converted = webRequest(request);
      const response = await tokens.handle(converted, async () => request.body ?? {})
        ?? await accounts.handle(converted, async () => request.body ?? {});
      return send(reply, response ?? Response.json({ error: 'not_found', message: 'Account endpoint not found.' }, { status: 404 }));
    } });
  }
  for (const url of ['/api/analyses', '/api/analyses/:id']) {
    app.route({ method: ['GET', 'POST', 'PATCH', 'DELETE'], url, bodyLimit: ANALYSIS_BODY_LIMIT, handler: async (request, reply) => {
      const response = await handleAnalysisRequest(db, webRequest(request), async () => request.body, accounts, tokens);
      return send(reply, response ?? Response.json({ error: 'not_found' }, { status: 404 }));
    } });
  }
}
