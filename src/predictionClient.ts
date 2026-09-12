import { analysisDatasetSchema, type AnalysisDataset } from '../shared/analysis';

export interface PredictionInput { requestId: string; variantId: string; ontologyTerm: string; cropBp: number }
export interface PendingPrediction { input: PredictionInput; capability: string; jobId?: string; createdAt: number }
export interface PredictionResult { analysis: AnalysisDataset; sourceResultJson: string; sourceResultSha256: string }
export interface PredictionStatus { jobId: string; status: 'starting' | 'running' | 'completed' | 'failed' | 'expired'; result?: unknown; error?: { code: string; message: string } }
export const PENDING_KEY = 'helix-hosted-prediction-v1';
const MAX_BYTES = 6 * 1024 * 1024;

/** Read bounded API JSON; server errors are displayed as text, never HTML. */
export async function predictionJSON<T>(url: string, init: RequestInit = {}): Promise<T> {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000);
  const response = await fetch(url, { ...init, signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!response.body) throw new Error('The prediction service returned no response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('The prediction result is too large.'); }
      text += decoder.decode(item.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('The prediction service did not return JSON.'); }
  if (!response.ok) {
    const body = value as { message?: unknown; error?: { message?: unknown } };
    const message = body?.error?.message ?? body?.message;
    throw new Error(typeof message === 'string' && message.length < 500 ? message : `Prediction request failed (${response.status}).`);
  }
  return value as T;
}

/** Verify the downloaded sidecar and dataset before showing a completed prediction. */
export async function validatePredictionResult(value: unknown, input: PredictionInput): Promise<PredictionResult> {
  const result = value as Partial<PredictionResult> | null;
  if (!result || typeof result.sourceResultJson !== 'string' || !/^[a-f0-9]{64}$/.test(result.sourceResultSha256 || '')) throw new Error('The prediction source artifact is missing.');
  const bytes = new TextEncoder().encode(result.sourceResultJson);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('The prediction source artifact exceeds 2 MB.');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== result.sourceResultSha256) throw new Error('The prediction source checksum does not match.');
  const source = JSON.parse(result.sourceResultJson);
  const analysis = analysisDatasetSchema.parse(result.analysis);
  if (analysis.kind !== 'tracks' || analysis.provenance.inference?.variant !== input.variantId || analysis.provenance.artifact?.sha256 !== digest) throw new Error('The prediction does not match the requested variant or source.');
  const display = analysis.provenance.inference.displayInterval;
  if (source?.sourceKind !== 'alphagenome_hosted_prediction' || source.schemaVersion !== 1 || source.request?.variantId !== input.variantId || source.request?.ontologyTerm !== input.ontologyTerm || source.request?.cropBp !== input.cropBp || source.request?.assembly !== 'GRCh38' || source.request?.requestedModelVersion !== 'ALL_FOLDS' || JSON.stringify(source.request?.outputTypes) !== '["RNA_SEQ"]' || display.end - display.start !== input.cropBp || display.chromosome !== source.displayInterval?.chromosome || display.start !== source.displayInterval?.start || display.end !== source.displayInterval?.end) throw new Error('The prediction does not match the requested tissue or display window.');
  return { analysis, sourceResultJson: result.sourceResultJson, sourceResultSha256: digest };
}

export function createPendingPrediction(input: Omit<PredictionInput, 'requestId'>): PendingPrediction {
  const capability = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  return { input: { ...input, requestId: crypto.randomUUID() }, capability, createdAt: Date.now() };
}

export function readPendingPrediction(): PendingPrediction | null {
  try {
    const value = sessionStorage.getItem(PENDING_KEY);
    if (!value || value.length > 4096) return null;
    const pending = JSON.parse(value) as PendingPrediction;
    if (!/^[a-f0-9]{64}$/.test(pending.capability) || !/^[a-f0-9-]{36}$/.test(pending.input.requestId) || (pending.jobId && !/^[a-f0-9-]{36}$/.test(pending.jobId)) || !Number.isFinite(pending.createdAt) || pending.createdAt > Date.now() || Date.now() - pending.createdAt > 3600000) return null;
    return pending;
  } catch { return null; }
}
