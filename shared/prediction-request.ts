import { z } from 'zod';

/** A human nuclear SNV; actual reference alleles are verified by the hosted runner. */
export const predictionRequestSchema = z.object({
  requestId: z.string().uuid(),
  variantId: z.string().regex(/^chr(?:[1-9]|1\d|2[0-2]|X|Y):[1-9]\d{0,8}:[ACGT]>[ACGT]$/),
  ontologyTerm: z.string().regex(/^(?:UBERON|CL|EFO|CLO|NTR):\d{4,12}$/).max(80),
  cropBp: z.number().int().min(32).max(1_024).default(256),
}).strict().refine(value => value.variantId.at(-1) !== value.variantId.at(-3), { path: ['variantId'], message: 'Reference and alternate bases must differ.' });

export type PredictionRequest = z.infer<typeof predictionRequestSchema>;
export type PredictionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'expired';
export interface PredictionResult { analysis: unknown; sourceResultJson: string; sourceResultSha256: string }
export interface PredictionJob {
  jobId: string;
  status: PredictionStatus;
  expiresAt?: string;
  result?: PredictionResult;
  error?: { code: string; message: string };
}

export const PREDICTION_SOURCE_LIMIT = 2 * 1024 * 1024;
export const PREDICTION_ENVELOPE_LIMIT = 6 * 1024 * 1024 + 4096;
export const PREDICTION_BODY_LIMIT = 4_096;

/** A per-run 256-bit capability, never a provider API key and never part of a URL. */
export function runCapability(header: string | null): string | undefined {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header || '');
  return match?.[1];
}
