/** Same-origin broker. Provider credentials never enter request or response bodies. */
export interface PredictionBindings {
  ALPHAGENOME_API_KEY?: string;
  CONTAINER?: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
}

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
function response(value: unknown, status = 200): Response { return Response.json(value, { status, headers: HEADERS }); }
function failure(status: number, code: string, message: string): Response { return response({ error: { code, message } }, status); }

export async function handlePredictionRequest(request: Request, bindings: PredictionBindings): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/predictions')) return undefined;
  const configured = Boolean(bindings.CONTAINER && bindings.ALPHAGENOME_API_KEY?.trim());
  if (url.pathname === '/api/predictions/health' && request.method === 'GET') return response({ configured, provider: 'Google AlphaGenome', authenticationVerified: false });
  const id = url.pathname.match(/^\/api\/predictions\/([a-f0-9-]{36})$/)?.[1];
  const submit = url.pathname === '/api/predictions' && request.method === 'POST';
  if (!submit && !(id && request.method === 'GET')) return failure(404, 'not_found', 'Prediction route not found.');
  if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return failure(403, 'origin_rejected', 'Use the prediction controls on this website.');
  if (submit && request.headers.get('origin') !== url.origin) return failure(403, 'origin_rejected', 'Submit predictions from this website.');
  const authorization = request.headers.get('authorization') || '';
  if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) return failure(401, 'run_access_required', 'This run requires its private browser access token.');
  if (!configured) return failure(503, 'not_configured', 'Live predictions are not connected yet. The site owner must configure the AlphaGenome API key.');
  let body: string | undefined;
  if (submit) {
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return failure(415, 'json_required', 'Send a JSON prediction request.');
    const reader = request.body?.getReader();
    if (!reader) return failure(400, 'invalid_request', 'A prediction request is required.');
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2048) { await reader.cancel(); return failure(413, 'request_too_large', 'Use one variant and tissue per request.'); }
        chunks.push(chunk.value);
      }
      const merged = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
      body = new TextDecoder('utf-8', { fatal: true }).decode(merged);
    } catch { return failure(400, 'invalid_request', 'The prediction request could not be read.'); }
    finally { reader.releaseLock(); }
  }
  try {
    const upstream = await bindings.CONTAINER!.getByName('alphagenome').fetch(new Request(`https://internal/runs${id ? `/${id}` : ''}`, { method: request.method, headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body }));
    const headers = new Headers(upstream.headers);
    for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
    headers.delete('set-cookie');
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch { return failure(503, 'service_unavailable', 'The prediction service is unavailable. Resume this run shortly.'); }
}
