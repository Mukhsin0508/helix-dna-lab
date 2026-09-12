import { Container } from '@cloudflare/containers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { analysisDatasetSchema } from '../shared/analysis';
import {
  predictionRequestSchema, runCapability, PREDICTION_BODY_LIMIT,
  PREDICTION_ENVELOPE_LIMIT, PREDICTION_SOURCE_LIMIT,
  type PredictionRequest, type PredictionResult, type PredictionJob,
} from '../shared/prediction-request';

const TTL_MS = 60 * 60 * 1000;
const DEADLINE_MS = 240_000;
const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;
const CHUNK_BYTES = 64 * 1024;
const DAILY_LIMIT = 30;
const encoder = new TextEncoder();
type Context = ConstructorParameters<typeof Container>[0];
export interface HostedContainerEnv { ALPHAGENOME_API_KEY?: string }
interface Run {
  jobId: string; capabilityHash: string; idempotencyKey: string; digest: string;
  request?: PredictionRequest; createdAt: number; expiresAt: number;
  status: PredictionJob['status']; dispatchAttempted: boolean;
  chunks?: number; error?: { code: string; message: string };
}

const MESSAGES: Record<string, string> = {
  not_configured: 'Live predictions are not configured yet.',
  unauthorized: 'This run requires its private browser capability.',
  not_found: 'This run was not found.',
  invalid_request: 'Check the variant, tissue and display width.',
  request_conflict: 'This request ID already belongs to a different experiment.',
  capacity_reached: 'Another prediction is running. Please try again shortly.',
  daily_limit: 'The daily prediction allowance has been reached.',
  expired: 'This run has expired. Export completed results to keep them.',
  prediction_timeout: 'The prediction exceeded its time limit. No result was produced.',
  service_interrupted: 'The service restarted before this run completed. It was not replayed.',
  service_unavailable: 'The prediction service is unavailable. Please try a new run later.',
  result_invalid: 'The returned result did not pass validation.',
  result_too_large: 'The result exceeds the supported size. Try a smaller display width.',
  invalid_reference: 'The reference allele does not match the genome.',
  reference_mismatch: 'The reference allele does not match the genome.',
  reference_unavailable: 'The reference sequence could not be verified.',
  unsupported_tissue: 'No compatible RNA-seq track was returned for this tissue.',
  rate_limited: 'AlphaGenome is temporarily limiting requests. Please try later.',
  authentication_failed: 'The configured AlphaGenome connection was not accepted.',
  missing_api_key: 'Live predictions are not configured yet.',
  dependency_error: 'The prediction service could not initialize.',
};
function safeError(code: string): { code: string; message: string } {
  const safe = Object.hasOwn(MESSAGES, code) ? code : 'service_unavailable';
  return { code: safe, message: MESSAGES[safe] };
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(status === 429 ? { 'Retry-After': '30' } : {}),
  } });
}
function failure(code: string, status: number): Response { return json({ error: safeError(code) }, status); }
async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function boundedText(response: Request | Response, limit: number): Promise<string> {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > limit || !response.body) throw new Error('invalid_body');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('invalid_body'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

/** A second boundary check: only an exact request-bound, checksummed dataset is persisted. */
export async function validateHostedResult(value: unknown, request: PredictionRequest): Promise<PredictionResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_result');
  const result = value as PredictionResult;
  if (Object.keys(result).sort().join(',') !== 'analysis,sourceResultJson,sourceResultSha256'
    || typeof result.sourceResultJson !== 'string' || typeof result.sourceResultSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(result.sourceResultSha256)
    || encoder.encode(result.sourceResultJson).byteLength > PREDICTION_SOURCE_LIMIT
    || encoder.encode(JSON.stringify(result.analysis)).byteLength > PREDICTION_SOURCE_LIMIT
    || encoder.encode(JSON.stringify(result)).byteLength > PREDICTION_ENVELOPE_LIMIT) throw new Error('invalid_result');
  if (await hash(result.sourceResultJson) !== result.sourceResultSha256) throw new Error('invalid_result');
  const source = JSON.parse(result.sourceResultJson);
  const analysis = analysisDatasetSchema.parse(result.analysis);
  if (source?.sourceKind !== 'alphagenome_hosted_prediction' || source.schemaVersion !== 1
    || source.request?.variantId !== request.variantId || source.request?.ontologyTerm !== request.ontologyTerm
    || source.request?.cropBp !== request.cropBp || source.request?.organism !== 'HOMO_SAPIENS'
    || source.request?.assembly !== 'GRCh38' || source.request?.requestedModelVersion !== 'ALL_FOLDS'
    || JSON.stringify(source.request?.outputTypes) !== '["RNA_SEQ"]'
    || analysis.kind !== 'tracks' || analysis.provenance.inference?.variant !== request.variantId
    || analysis.provenance.artifact?.sha256 !== result.sourceResultSha256) throw new Error('invalid_result');
  const interval = analysis.provenance.inference.displayInterval;
  if (interval.end - interval.start !== request.cropBp || source.displayInterval?.start !== interval.start
    || source.displayInterval?.end !== interval.end || source.displayInterval?.chromosome !== interval.chromosome
    || source.inputInterval?.start !== analysis.provenance.inference.inputInterval.start
    || source.inputInterval?.end !== analysis.provenance.inference.inputInterval.end) throw new Error('invalid_result');
  return result;
}

/** Exactly one named object/container serves the whole site: getByName('alphagenome'). */
export class AppContainer extends Container<HostedContainerEnv> {
  defaultPort = 8080;
  sleepAfter = '5m';
  enableInternet = true;
  private readonly hostState: Pick<DurableObjectState, 'storage' | 'waitUntil'>;
  private readonly config: HostedContainerEnv;
  private operation: Promise<unknown> = Promise.resolve();
  private bootingJob: string | undefined;

  constructor(ctx: Context, env: HostedContainerEnv) {
    super(ctx, env);
    this.hostState = ctx; this.config = env;
    // Documented Container.envVars secret injection; never included in a request or storage.
    this.envVars = env.ALPHAGENOME_API_KEY ? { ALPHAGENOME_API_KEY: env.ALPHAGENOME_API_KEY } : {};
  }
  private configured(): boolean { return Boolean(this.config.ALPHAGENOME_API_KEY?.trim()); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.operation.then(work, work);
    this.operation = next.catch(() => undefined);
    return next;
  }
  private background(work: Promise<unknown>): void { this.hostState.waitUntil(work.catch(() => undefined)); }
  // Never automatically forward unknown routes: the container is private, not an HTTP proxy.
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ configured: this.configured() });
    const capability = runCapability(request.headers.get('authorization'));
    if (!capability) return failure('unauthorized', 401);
    const capabilityHash = await hash(capability);
    try {
      if (request.method === 'POST' && url.pathname === '/runs') {
        if (!this.configured()) return failure('not_configured', 503);
        if (!request.headers.get('content-type')?.startsWith('application/json')) return failure('invalid_request', 400);
        let value: unknown;
        try { value = JSON.parse(await boundedText(request, PREDICTION_BODY_LIMIT)); }
        catch { return failure('invalid_request', 400); }
        const input = predictionRequestSchema.safeParse(value);
        if (!input.success) return failure('invalid_request', 400);
        return await this.submit(input.data, capabilityHash);
      }
      const match = /^\/runs\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(url.pathname);
      if (request.method === 'GET' && match) return await this.status(match[1], capabilityHash);
      return failure('not_found', 404);
    } catch { return failure('service_unavailable', 503); }
  }

  private async submit(request: PredictionRequest, capabilityHash: string): Promise<Response> {
    const idempotencyKey = `idem:${await hash(`${capabilityHash}:${request.requestId}`)}`;
    const digest = await hash(JSON.stringify(request));
    let created: Run | undefined;
    const response = await this.serial(async () => this.hostState.storage.transaction(async tx => {
      const priorId = await tx.get<string>(idempotencyKey);
      if (priorId) {
        const prior = await tx.get<Run>(`run:${priorId}`);
        if (!prior || prior.expiresAt <= Date.now()) return failure('expired', 410);
        if (prior.digest !== digest) return failure('request_conflict', 409);
        return json(this.receipt(prior), 202);
      }
      if (await tx.get('active')) return failure('capacity_reached', 429);
      const quotaKey = `quota:${Math.floor(Date.now() / 86_400_000)}`;
      const count = await tx.get<number>(quotaKey) || 0;
      if (count >= DAILY_LIMIT) return failure('daily_limit', 429);
      const now = Date.now();
      created = { jobId: crypto.randomUUID(), capabilityHash, idempotencyKey, digest, request,
        createdAt: now, expiresAt: now + TTL_MS, status: 'starting', dispatchAttempted: false };
      await tx.put({ [idempotencyKey]: created.jobId, [`run:${created.jobId}`]: created,
        active: created.jobId, [quotaKey]: count + 1 });
      return json(this.receipt(created), 202);
    }));
    if (created) {
      try {
        await this.schedule(2, 'monitorRun', { jobId: created.jobId });
        await this.schedule(new Date(created.expiresAt), 'expireRun', { jobId: created.jobId });
        const jobId = created.jobId;
        this.bootingJob = jobId;
        this.background(this.bootAndStart(created).finally(() => { if (this.bootingJob === jobId) this.bootingJob = undefined; }));
      } catch { await this.finish(created.jobId, 'service_unavailable'); }
    }
    return response;
  }
  private receipt(run: Run): PredictionJob {
    return { jobId: run.jobId, status: run.status, expiresAt: new Date(run.expiresAt).toISOString(),
      ...(run.error ? { error: run.error } : {}) };
  }
  private async status(jobId: string, capabilityHash: string): Promise<Response> {
    return this.serial(async () => {
      const run = await this.hostState.storage.get<Run>(`run:${jobId}`);
      if (!run || run.capabilityHash !== capabilityHash) return failure('not_found', 404);
      if (run.expiresAt <= Date.now()) return json({ jobId, status: 'expired', error: safeError('expired') }, 410);
      const receipt = this.receipt(run);
      if (run.status === 'completed') {
        const chunks: Uint8Array[] = []; let size = 0;
        for (let i = 0; i < (run.chunks || 0); i++) {
          const chunk = await this.hostState.storage.get<Uint8Array>(`result:${jobId}:${i}`);
          if (!chunk) return failure('service_unavailable', 503);
          chunks.push(chunk); size += chunk.byteLength;
        }
        if (!size || size > PREDICTION_ENVELOPE_LIMIT) return failure('service_unavailable', 503);
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        receipt.result = JSON.parse(new TextDecoder().decode(bytes));
      }
      return json(receipt);
    });
  }

  private async bootAndStart(run: Run): Promise<void> {
    try {
      // Cold startup is background request work, never an alarm-blocking short fetch.
      await this.startAndWaitForPorts({ ports: [8080],
        cancellationOptions: { instanceGetTimeoutMS: 120_000, portReadyTimeoutMS: 120_000,
          abort: AbortSignal.timeout(120_000) },
        startOptions: { envVars: this.envVars, enableInternet: true } });
      const dispatch = await this.serial(async () => {
        const current = await this.hostState.storage.get<Run>(`run:${run.jobId}`);
        if (!current || current.status !== 'starting' || current.dispatchAttempted || Date.now() - current.createdAt >= DEADLINE_MS) return false;
        current.dispatchAttempted = true;
        await this.hostState.storage.put(`run:${run.jobId}`, current);
        return true;
      });
      if (!dispatch) return;
      const { requestId: _requestId, ...input } = run.request!;
      // Persisting dispatchAttempted before this call guarantees no replay after uncertainty.
      const response = await this.containerFetch('http://c/start', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: run.jobId, request: input }), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) { await this.finish(run.jobId, 'service_unavailable'); return; }
      await this.serial(async () => {
        const current = await this.hostState.storage.get<Run>(`run:${run.jobId}`);
        if (current?.status === 'starting') { current.status = 'running'; await this.hostState.storage.put(`run:${run.jobId}`, current); }
      });
    } catch {
      // An uncertain POST may already have reached Google. Do not send it again.
      await this.finish(run.jobId, 'service_unavailable');
    }
  }

  async monitorRun({ jobId }: { jobId: string }): Promise<void> {
    const run = await this.hostState.storage.get<Run>(`run:${jobId}`);
    if (!run || !['starting', 'running'].includes(run.status)) return;
    if (Date.now() - run.createdAt >= DEADLINE_MS) { await this.finish(jobId, 'prediction_timeout'); return; }
    this.renewActivityTimeout();
    try {
      if (this.bootingJob === jobId) { await this.schedule(3, 'monitorRun', { jobId }); return; }
      const state = await this.getState();
      if (state.status !== 'healthy') {
        // A lost ephemeral process is an explicit failure, never a duplicate provider request.
        if (run.dispatchAttempted) { await this.finish(jobId, 'service_interrupted'); return; }
        await this.schedule(3, 'monitorRun', { jobId }); return;
      }
      if (!run.dispatchAttempted) { await this.schedule(3, 'monitorRun', { jobId }); return; }
      const response = await this.containerFetch(`http://c/status/${jobId}`, { signal: AbortSignal.timeout(6_000) });
      if (!response.ok) { await this.schedule(3, 'monitorRun', { jobId }); return; }
      const status = JSON.parse(await boundedText(response, PREDICTION_ENVELOPE_LIMIT + 1024));
      if (status.jobId !== jobId) { await this.finish(jobId, 'result_invalid'); return; }
      if (status.status === 'completed') {
        let result: PredictionResult;
        try { result = await validateHostedResult(status.result, run.request!); }
        catch { await this.finish(jobId, 'result_invalid'); return; }
        await this.finish(jobId, undefined, result); return;
      }
      if (status.status === 'failed') { await this.finish(jobId, status.error?.code || 'service_unavailable'); return; }
      if (status.status === 'unknown' || status.status === 'expired') { await this.finish(jobId, 'service_interrupted'); return; }
    } catch { /* Temporary polling errors are bounded by the durable run deadline. */ }
    await this.schedule(3, 'monitorRun', { jobId });
  }

  private async finish(jobId: string, code?: string, result?: PredictionResult): Promise<void> {
    await this.serial(async () => {
      const run = await this.hostState.storage.get<Run>(`run:${jobId}`);
      if (!run || !['starting', 'running'].includes(run.status)) return;
      // Keep active reserved until stop completes, so a new run cannot inherit an old process.
      if (!result) { try { await this.stop('SIGKILL'); } catch { /* deadline stops renewal regardless */ } }
      await this.hostState.storage.transaction(async tx => {
        const current = await tx.get<Run>(`run:${jobId}`);
        if (!current || !['starting', 'running'].includes(current.status)) return;
        if (result && current.expiresAt > Date.now()) {
          const bytes = encoder.encode(JSON.stringify(result));
          current.chunks = Math.ceil(bytes.byteLength / CHUNK_BYTES);
          for (let i = 0; i < current.chunks; i++) await tx.put(`result:${jobId}:${i}`, bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
          current.status = 'completed';
        } else { current.status = 'failed'; current.error = safeError(code || 'expired'); }
        await tx.put(`run:${jobId}`, current);
        if (await tx.get('active') === jobId) await tx.delete('active');
      });
    });
  }

  async expireRun({ jobId }: { jobId: string }): Promise<void> {
    const pending = await this.hostState.storage.get<Run>(`run:${jobId}`);
    if (!pending) return;
    if (pending.expiresAt > Date.now()) { await this.schedule(new Date(pending.expiresAt + 1000), 'expireRun', { jobId }); return; }
    if (['starting', 'running'].includes(pending.status)) await this.finish(jobId, 'expired');
    await this.serial(async () => this.hostState.storage.transaction(async tx => {
      const run = await tx.get<Run>(`run:${jobId}`);
      if (!run || run.expiresAt > Date.now()) return;
      for (let i = 0; i < (run.chunks || 0); i++) await tx.delete(`result:${jobId}:${i}`);
      delete run.request; delete run.chunks;
      run.status = 'expired'; run.error = safeError('expired');
      await tx.put(`run:${jobId}`, run);
    }));
    await this.schedule(new Date(Date.now() + TOMBSTONE_MS), 'forgetRun', { jobId });
  }
  async forgetRun({ jobId }: { jobId: string }): Promise<void> {
    const pending = await this.hostState.storage.get<Run>(`run:${jobId}`);
    if (pending && pending.expiresAt + TOMBSTONE_MS > Date.now()) {
      await this.schedule(new Date(pending.expiresAt + TOMBSTONE_MS + 1000), 'forgetRun', { jobId }); return;
    }
    await this.serial(async () => this.hostState.storage.transaction(async tx => {
      const run = await tx.get<Run>(`run:${jobId}`);
      if (!run || run.expiresAt + TOMBSTONE_MS > Date.now()) return;
      await tx.delete([`run:${jobId}`, run.idempotencyKey]);
      await tx.delete(`quota:${Math.floor(run.createdAt / 86_400_000)}`);
    }));
  }
  override onError(_error: unknown): void { /* Do not log provider or environment errors. */ }
}
