import { z } from "zod";

export const ANALYSIS_ROW_LIMIT = 5_000;
export const ANALYSIS_PAYLOAD_LIMIT = 2 * 1024 * 1024;

export const chromosomeSchema = z.string().regex(/^chr(?:[1-9]|1\d|2[0-2]|X|Y|M)$/, "Use a primary human chromosome, such as chr9.");
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const strandSchema = z.enum(["+", "-", "."]);
const safeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/, "Expected a 64-character hexadecimal SHA-256 hash.");

/** Human SNV identifiers use one-based positions. This checks syntax, not reference alleles. */
export const variantSchema = z.string().regex(/^chr(?:[1-9]|1\d|2[0-2]|X|Y|M):[1-9]\d*:[ACGT]>[ACGT]$/, "Use a one-based SNV identifier such as chr9:128226027:G>A.")
  .superRefine((variant, context) => {
    const match = /:([1-9]\d*):([ACGT])>([ACGT])$/.exec(variant);
    if (!match) return;
    if (!Number.isSafeInteger(Number(match[1]))) context.addIssue({ code: z.ZodIssueCode.custom, message: "Variant position must be a safe integer." });
    if (match[2] === match[3]) context.addIssue({ code: z.ZodIssueCode.custom, message: "Reference and alternate alleles must differ." });
  });

export const analysisIntervalSchema = z.object({
  chromosome: chromosomeSchema,
  start: safeIntegerSchema,
  end: safeIntegerSchema,
  coordinateSystem: z.literal("0-based-half-open"),
}).strict().refine(interval => interval.end > interval.start, { path: ["end"], message: "An interval's exclusive end must be greater than its start." });

/** These identifiers are source-reported; importing a result does not verify its execution. */
export const analysisInferenceSchema = z.object({
  variant: variantSchema,
  inputInterval: analysisIntervalSchema,
  displayInterval: analysisIntervalSchema,
  modelRevision: boundedText(200),
  clientRevision: boundedText(200),
  checkpointRevision: boundedText(200),
  referenceVersion: boundedText(200),
  // Hash of the reference genome file, when supplied. A context hash belongs below.
  referenceSha256: sha256Schema.nullable(),
  inputSequenceSha256: sha256Schema.optional(),
  transformations: z.array(boundedText(1_000)).max(50),
}).strict().superRefine((inference, context) => {
  const { inputInterval: input, displayInterval: display } = inference;
  if (display.chromosome !== input.chromosome || display.start < input.start || display.end > input.end) context.addIssue({ code: z.ZodIssueCode.custom, path: ["displayInterval"], message: "Display interval must be contained in the model input interval on the same chromosome." });
  const [chromosome, position] = inference.variant.split(":");
  const zeroBased = Number(position) - 1;
  if (chromosome !== input.chromosome || zeroBased < input.start || zeroBased >= input.end) context.addIssue({ code: z.ZodIssueCode.custom, path: ["variant"], message: "The exact variant must be contained in the model input interval." });
});

export const analysisProvenanceSchema = z.object({
  sourceUrl: z.string().max(2_048).refine(value => {
    if (value === "") return true; // An import need not have a public source URL.
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }, "Source URL must be an HTTP(S) URL without embedded credentials, or empty for an import."),
  sourceLabel: boundedText(200),
  assembly: boundedText(80),
  model: boundedText(200),
  context: boundedText(500),
  recordedAt: z.string().datetime({ offset: true }).optional(),
  mode: z.enum(["published-example", "imported"]),
  artifact: z.object({
    filename: z.string().min(1).max(240).refine(value => value !== "." && value !== ".." && !/[\\/\x00-\x1f\x7f]/.test(value), "Artifact filename must be a basename without paths or control characters."),
    sha256: sha256Schema,
  }).strict().optional(),
  inference: analysisInferenceSchema.optional(),
}).strict();

export const scoreRowSchema = z.object({
  variant: variantSchema,
  biosample: boundedText(300),
  modality: boundedText(100),
  scorer: boundedText(1_000),
  score: z.number().finite(),
  // AlphaGenome includes signed empirical quantiles. This is not a probability.
  quantile: z.number().finite().min(-1).max(1).optional(),
  gene: boundedText(200).optional(),
  track: boundedText(500).optional(),
  unit: boundedText(500).optional(),
  signed: z.boolean().optional(),
  trackStrand: strandSchema.optional(),
  assay: boundedText(300).optional(),
  sourceRowIndex: safeIntegerSchema.optional(),
  scoredInterval: boundedText(200).optional(),
  geneId: boundedText(200).optional(),
  geneStrand: strandSchema.optional(),
  histoneMark: boundedText(200).optional(),
}).strict();

/** Scalar reference/alternate signals at zero-based genomic positions; never DNA bases. */
export const trackRowSchema = z.object({
  chromosome: chromosomeSchema,
  position: safeIntegerSchema,
  reference: z.number().finite(),
  alternate: z.number().finite(),
  track: boundedText(500),
}).strict();

/** A dataset represents one assay endpoint and one explicitly described condition aggregate. */
export const experimentSchema = z.object({
  assay: boundedText(500),
  endpoint: boundedText(500),
  unit: z.enum(["fraction", "percent", "count", "arbitrary"]),
  unitLabel: boundedText(200),
  aggregation: boundedText(1_000),
  conditions: z.array(boundedText(500)).min(1).max(100),
  replicatePolicy: boundedText(1_000),
  sourceLocator: boundedText(1_000),
}).strict();

/** Reported observations, not model scores. Missing uncertainty is explicit, never inferred. */
export const measurementRowSchema = z.object({
  variant: variantSchema,
  gene: boundedText(200).optional(),
  value: z.number().finite(),
  // Keep the original numerical spelling, including trailing zeroes or exponent notation.
  reportedValue: z.string().min(1).max(200).refine(value => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) && Number.isFinite(Number(value)), "Reported value must be finite numerical source text.").optional(),
  replicates: safeIntegerSchema.refine(value => value > 0, "Replicate count must be a positive integer, or null when unknown.").nullable(),
  standardError: z.number().finite().min(0).nullable(),
  sourceRowIndex: safeIntegerSchema.optional(),
}).strict().superRefine((row, context) => {
  if (row.reportedValue !== undefined && Number(row.reportedValue) !== row.value) context.addIssue({ code: z.ZodIssueCode.custom, path: ["reportedValue"], message: "Reported numerical text must equal the unrounded measurement value." });
});

/** Optional original model metadata for each chromosome / displayed track key. */
export const analysisTrackMetadataSchema = z.object({
  chromosome: chromosomeSchema,
  track: boundedText(500),
  outputType: boundedText(100),
  unit: boundedText(500).nullable(),
  strand: strandSchema.nullable(),
  biosampleId: boundedText(200).nullable(),
  biosampleName: boundedText(300).nullable(),
  scope: z.enum(["biosample_specific", "tissue_agnostic", "unspecified"]),
  binSize: safeIntegerSchema.refine(value => value > 0, "Bin size must be a positive integer."),
  sourceName: boundedText(500).optional(),
  sourceIndex: safeIntegerSchema.optional(),
}).strict().superRefine((metadata, context) => {
  if (metadata.scope === "tissue_agnostic" && (metadata.biosampleId !== null || metadata.biosampleName !== null)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: "Tissue-agnostic tracks must not be assigned a biosample." });
  if (metadata.scope === "biosample_specific" && metadata.biosampleId === null && metadata.biosampleName === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: "Biosample-specific tracks require a biosample name or identifier." });
});

const datasetBase = {
  schemaVersion: z.literal(1),
  id: boundedText(200),
  title: boundedText(200),
  provenance: analysisProvenanceSchema,
};
export const scoreDatasetSchema = z.object({
  ...datasetBase,
  kind: z.literal("scores"),
  rows: z.array(scoreRowSchema).min(1).max(ANALYSIS_ROW_LIMIT),
}).strict();
export const trackDatasetSchema = z.object({
  ...datasetBase,
  kind: z.literal("tracks"),
  rows: z.array(trackRowSchema).min(1).max(ANALYSIS_ROW_LIMIT),
  trackMetadata: z.array(analysisTrackMetadataSchema).min(1).max(ANALYSIS_ROW_LIMIT).optional(),
}).strict();
export const measurementDatasetSchema = z.object({
  ...datasetBase,
  kind: z.literal("measurements"),
  experiment: experimentSchema,
  rows: z.array(measurementRowSchema).min(1).max(ANALYSIS_ROW_LIMIT),
}).strict();

// UCSC primary hg38 chromosome sizes, verified 2026-09-11:
// https://hgdownload.soe.ucsc.edu/goldenPath/hg38/bigZips/hg38.chrom.sizes
const human38Lengths: Readonly<Record<string, number>> = {
  chr1: 248956422, chr2: 242193529, chr3: 198295559, chr4: 190214555,
  chr5: 181538259, chr6: 170805979, chr7: 159345973, chr8: 145138636,
  chr9: 138394717, chr10: 133797422, chr11: 135086622, chr12: 133275309,
  chr13: 114364328, chr14: 107043718, chr15: 101991189, chr16: 90338345,
  chr17: 83257441, chr18: 80373285, chr19: 58617616, chr20: 64444167,
  chr21: 46709983, chr22: 50818468, chrX: 156040895, chrY: 57227415,
  chrM: 16569,
};

export const analysisDatasetSchema = z.discriminatedUnion("kind", [scoreDatasetSchema, trackDatasetSchema, measurementDatasetSchema])
  .superRefine((dataset, context) => {
    const hg38 = /^(?:GRCh38(?:\.p\d+)?(?:\/hg38)?|hg38)$/i.test(dataset.provenance.assembly);
    const seen = new Set<string>();
    const inference = dataset.provenance.inference;
    if (dataset.kind === "measurements" && inference) context.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance", "inference"], message: "Experimental measurements cannot carry model inference provenance." });
    if (inference && hg38) {
      for (const intervalName of ["inputInterval", "displayInterval"] as const) {
        const interval = inference[intervalName];
        if (interval.end > human38Lengths[interval.chromosome]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance", "inference", intervalName, "end"], message: "Interval exceeds this GRCh38 chromosome's length." });
      }
    }
    dataset.rows.forEach((row, index) => {
      if ("variant" in row) {
        const [chromosome, position] = row.variant.split(":");
        if (hg38 && Number(position) > human38Lengths[chromosome]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "variant"], message: "Variant position exceeds this GRCh38 chromosome's length." });
        if (dataset.kind === "scores" && inference && row.variant !== inference.variant) context.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "variant"], message: "Score row differs from the single variant recorded in inference provenance." });
      } else if ("position" in row) {
        if (hg38 && row.position >= human38Lengths[row.chromosome]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "position"], message: "Zero-based track position exceeds this GRCh38 chromosome's length." });
        const key = JSON.stringify([row.chromosome, row.position, row.track]);
        if (seen.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index], message: "Duplicate chromosome, position and track; provide one value per coordinate." });
        seen.add(key);
        if (inference && (row.chromosome !== inference.displayInterval.chromosome || row.position < inference.displayInterval.start || row.position >= inference.displayInterval.end)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "position"], message: "Track row lies outside the recorded display interval." });
      }
    });
    if (dataset.kind === "measurements") {
      const variants = new Set<string>();
      dataset.rows.forEach((row, index) => {
        if (variants.has(row.variant)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "variant"], message: "Duplicate variant; use a separate dataset for another assay or condition aggregate." });
        variants.add(row.variant);
        const unit = dataset.experiment.unit;
        if ((unit === "fraction" && (row.value < 0 || row.value > 1)) || (unit === "percent" && (row.value < 0 || row.value > 100)) || (unit === "count" && row.value < 0)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "value"], message: `Measurement value is outside the valid range for ${unit} units.` });
      });
    }
    if (dataset.kind === "tracks" && dataset.trackMetadata) {
      const metadataPairs = new Set<string>();
      dataset.trackMetadata.forEach((metadata, metadataIndex) => {
        const pair = JSON.stringify([metadata.chromosome, metadata.track]);
        if (metadataPairs.has(pair)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["trackMetadata", metadataIndex], message: "Duplicate metadata for a chromosome and track pair." });
        metadataPairs.add(pair);
        const rows = dataset.rows.filter(row => row.chromosome === metadata.chromosome && row.track === metadata.track);
        if (!rows.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["trackMetadata", metadataIndex], message: "Declared track metadata has no matching data rows." });
        const firstPosition = rows[0]?.position;
        for (const row of rows) {
          if ((row.position - firstPosition) % metadata.binSize !== 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["trackMetadata", metadataIndex, "binSize"], message: "Track positions are not aligned to the declared bin size." });
          const binEnd = row.position + metadata.binSize;
          if (!Number.isSafeInteger(binEnd) || (hg38 && binEnd > human38Lengths[row.chromosome])) context.addIssue({ code: z.ZodIssueCode.custom, path: ["trackMetadata", metadataIndex, "binSize"], message: "A track bin extends beyond the chromosome or valid integer range." });
          if (inference && binEnd > inference.displayInterval.end) context.addIssue({ code: z.ZodIssueCode.custom, path: ["trackMetadata", metadataIndex, "binSize"], message: "A track bin extends beyond the recorded display interval." });
        }
      });
    }
    if (dataset.provenance.mode === "published-example" && !dataset.provenance.sourceUrl) context.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance", "sourceUrl"], message: "Published examples require a source URL." });
  });

export type AnalysisDataset = z.infer<typeof analysisDatasetSchema>;
export type ScoreDataset = z.infer<typeof scoreDatasetSchema>;
export type TrackDataset = z.infer<typeof trackDatasetSchema>;
export type MeasurementDataset = z.infer<typeof measurementDatasetSchema>;
export type ScoreRow = z.infer<typeof scoreRowSchema>;
export type TrackRow = z.infer<typeof trackRowSchema>;
export type MeasurementRow = z.infer<typeof measurementRowSchema>;
export type Experiment = z.infer<typeof experimentSchema>;
export type AnalysisProvenance = z.infer<typeof analysisProvenanceSchema>;
export type AnalysisTrackMetadata = z.infer<typeof analysisTrackMetadataSchema>;
export type AnalysisInference = z.infer<typeof analysisInferenceSchema>;
export type AnalysisInterval = z.infer<typeof analysisIntervalSchema>;

/** A conservative comparison group. Never combine modalities or unrelated scorer units. */
export function scoreComparisonKey(row: ScoreRow): string {
  return JSON.stringify([row.modality, row.scorer, row.track ?? "", row.trackStrand ?? "", row.unit ?? "", row.signed ?? null]);
}

/** Input coordinates stay intact; only deterministic display order changes. */
export function sortTrackRows(rows: readonly TrackRow[]): TrackRow[] {
  const order = (chromosome: string): number => ({ X: 23, Y: 24, M: 25 }[chromosome.slice(3)] ?? Number(chromosome.slice(3)));
  return [...rows].sort((left, right) => order(left.chromosome) - order(right.chromosome) || left.position - right.position || left.track.localeCompare(right.track));
}
