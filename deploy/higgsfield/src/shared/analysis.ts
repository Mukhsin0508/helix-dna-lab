import { z } from "zod";

export const ANALYSIS_ROW_LIMIT = 5_000;
export const ANALYSIS_PAYLOAD_LIMIT = 2 * 1024 * 1024;

export const chromosomeSchema = z.string().regex(/^chr(?:[1-9]|1\d|2[0-2]|X|Y|M)$/, "Use a primary human chromosome, such as chr9.");
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const strandSchema = z.enum(["+", "-", "."]);
const safeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Human SNV identifiers use one-based positions. This checks syntax, not reference alleles. */
export const variantSchema = z.string().regex(/^chr(?:[1-9]|1\d|2[0-2]|X|Y|M):[1-9]\d*:[ACGT]>[ACGT]$/, "Use a one-based SNV identifier such as chr9:128226027:G>A.")
  .superRefine((variant, context) => {
    const match = /:([1-9]\d*):([ACGT])>([ACGT])$/.exec(variant);
    if (!match) return;
    if (!Number.isSafeInteger(Number(match[1]))) context.addIssue({ code: z.ZodIssueCode.custom, message: "Variant position must be a safe integer." });
    if (match[2] === match[3]) context.addIssue({ code: z.ZodIssueCode.custom, message: "Reference and alternate alleles must differ." });
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

export const analysisDatasetSchema = z.discriminatedUnion("kind", [scoreDatasetSchema, trackDatasetSchema])
  .superRefine((dataset, context) => {
    const hg38 = /^(?:GRCh38(?:\/hg38)?|hg38)$/i.test(dataset.provenance.assembly);
    const seen = new Set<string>();
    dataset.rows.forEach((row, index) => {
      if (dataset.kind === "scores" && "variant" in row) {
        const [chromosome, position] = row.variant.split(":");
        if (hg38 && Number(position) > human38Lengths[chromosome]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "variant"], message: "Variant position exceeds this GRCh38 chromosome's length." });
      } else if ("position" in row) {
        if (hg38 && row.position >= human38Lengths[row.chromosome]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "position"], message: "Zero-based track position exceeds this GRCh38 chromosome's length." });
        const key = JSON.stringify([row.chromosome, row.position, row.track]);
        if (seen.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index], message: "Duplicate chromosome, position and track; provide one value per coordinate." });
        seen.add(key);
      }
    });
    if (dataset.provenance.mode === "published-example" && !dataset.provenance.sourceUrl) context.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance", "sourceUrl"], message: "Published examples require a source URL." });
  });

export type AnalysisDataset = z.infer<typeof analysisDatasetSchema>;
export type ScoreDataset = z.infer<typeof scoreDatasetSchema>;
export type TrackDataset = z.infer<typeof trackDatasetSchema>;
export type ScoreRow = z.infer<typeof scoreRowSchema>;
export type TrackRow = z.infer<typeof trackRowSchema>;
export type AnalysisProvenance = z.infer<typeof analysisProvenanceSchema>;

/** A conservative comparison group. Never combine modalities or unrelated scorer units. */
export function scoreComparisonKey(row: ScoreRow): string {
  return JSON.stringify([row.modality, row.scorer, row.track ?? "", row.trackStrand ?? "", row.unit ?? "", row.signed ?? null]);
}

/** Input coordinates stay intact; only deterministic display order changes. */
export function sortTrackRows(rows: readonly TrackRow[]): TrackRow[] {
  const order = (chromosome: string): number => ({ X: 23, Y: 24, M: 25 }[chromosome.slice(3)] ?? Number(chromosome.slice(3)));
  return [...rows].sort((left, right) => order(left.chromosome) - order(right.chromosome) || left.position - right.position || left.track.localeCompare(right.track));
}
