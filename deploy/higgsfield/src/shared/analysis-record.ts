import { z } from 'zod';
import { analysisDatasetSchema } from './analysis.ts';

export const ANALYSIS_BODY_LIMIT = 2 * 1024 * 1024;
export const analysisIdSchema = z.string().uuid();
export const figureSettingsSchema = z.object({
  chart: z.enum(['bars', 'heatmap', 'tracks', 'junctions', 'table']),
  title: z.string().trim().min(1).max(160),
  modality: z.string().max(200),
  scorer: z.string().max(1000),
  track: z.string().max(1000),
  gene: z.string().max(200),
  metric: z.enum(['score', 'quantile']),
  limit: z.number().int().min(1).max(100),
  variant: z.string().max(200),
}).strict();

const analysisInputSchema = z.object({
  dataset: analysisDatasetSchema,
  settings: figureSettingsSchema,
}).strict();
/** Experimental endpoints never acquire model quantiles or genomic coverage through a chart setting. */
function validateFigureKind(input: z.infer<typeof analysisInputSchema>, context: z.RefinementCtx): void {
  if (input.dataset.kind === 'junctions') {
    if (!['junctions', 'table'].includes(input.settings.chart)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'chart'], message: 'Splice junctions support junction arcs or a data table.' });
    if (input.settings.metric !== 'score') context.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'metric'], message: 'Junction values are supplied signals, not model quantiles or probabilities.' });
  } else if (input.settings.chart === 'junctions') context.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'chart'], message: 'Junction arcs require a splice-junction dataset with genomic endpoints.' });
  if (input.dataset.kind !== 'measurements') return;
  if (!['bars', 'table'].includes(input.settings.chart)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'chart'], message: 'Experimental measurements support a dot plot or data table.' });
  if (input.settings.metric !== 'score') context.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'metric'], message: 'Experimental measurements have measured values, not model quantile scores.' });
}
export const analysisCreateSchema = analysisInputSchema.superRefine(validateFigureKind);
export const analysisPatchSchema = analysisInputSchema.extend({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).superRefine(validateFigureKind);
export type FigureSettings = z.infer<typeof figureSettingsSchema>;
export type AnalysisInput = z.infer<typeof analysisCreateSchema>;
export type AnalysisRecord = AnalysisInput & {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** Create a saved analysis. Data and figure settings are stored together, without recomputing scores. */
export function newAnalysis(input: AnalysisInput, id: string): AnalysisRecord {
  const now = new Date().toISOString();
  return { ...input, id, revision: 0, createdAt: now, updatedAt: now };
}
