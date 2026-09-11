import { z } from "zod";
import { ANALYSIS_PAYLOAD_LIMIT, ANALYSIS_ROW_LIMIT, analysisDatasetSchema, type TrackDataset } from "./analysis";
import { AnalysisImportError } from "./analysis-import";
import referenceEvidence from "../data/reference/dnm1-variants.json";

export const SERVICE_VARIANT = "chr9:128225994:G>A";
export const SERVICE_REFERENCE = "CACTTCTCCTCCCCACCCACGGCTGCTCCTCCTCCTGTCCC";
const REFERENCE_URL = "https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa";
export const SERVICE_VARIANTS = referenceEvidence.variants.map(variant => variant.id);
const finite = z.number().finite();
const text = z.string().min(1).max(500);
const sha256 = z.string().regex(/^[a-fA-F0-9]{64}$/);
const revision = z.string().regex(/^[a-fA-F0-9]{40}$/, "Expected a source-reported 40-character Git/model revision.");
const strand = z.enum(["+", "-", "."]);

const interval = z.object({
  chromosome: z.literal("chr9"), start: z.number().int().nonnegative(), end: z.number().int().positive(),
  coordinateSystem: z.literal("0-based-half-open"), strand: z.literal("."),
}).passthrough();

const sourceTrackSchema = z.object({
  outputType: z.enum(["RNA_SEQ", "SPLICE_SITES", "SPLICE_SITE_USAGE"]),
  name: text,
  biosampleId: text.nullable(),
  biosampleScope: z.enum(["tissue_agnostic", "biosample_specific"]),
  strand: strand.nullable(),
  unit: text.nullable(),
  chromosome: z.literal("chr9"),
  start: z.number().int().nonnegative(),
  binSizeBases: z.literal(1),
  reference: z.array(finite).length(41),
  alternate: z.array(finite).length(41),
  originalMetadata: z.object({
    name: text,
    strand: strand.nullable().optional(),
    unit: text.nullable().optional(),
    ontology_curie: text.nullable().optional(),
    biosample_name: text.nullable().optional(),
  }).passthrough(),
}).passthrough();

/** Service result bound to an independently verified variant/context pair, not an execution check. */
export const servicePredictionResultSchema = z.object({
  sourceKind: z.literal("model_inference"),
  variant: z.object({
    assembly: z.literal("GRCh38"), chromosome: z.literal("chr9"), position: z.number().int().positive(),
    reference: z.literal("G"), alternate: z.literal("A"),
  }).strict(),
  biosampleId: z.literal("CL:0000679"),
  biosampleLabel: z.literal("glutamatergic neuron"),
  model: z.literal("google/alphagenome-all-folds"),
  modelRevision: revision,
  checkpointRevision: revision,
  checkpointManifestSha256: sha256,
  clientRevision: revision,
  referenceGenome: z.object({
    referenceUrl: z.literal(REFERENCE_URL),
    indexUrl: z.literal(`${REFERENCE_URL}.fai`),
    referenceHeaders: z.record(z.string(), z.unknown()),
    indexSha256: z.literal("9293fb33f63b7f09d8fadc055d78e401d07c76de0211243fba778780ff836ff9"),
    assembly: z.literal("GRCh38"), referenceVersion: z.literal("GRCh38.p13"),
    contextSha256: sha256, contextBases: z.literal(1_048_576),
    contextRevalidatedAt: z.string().datetime({ offset: true }),
  }).passthrough(),
  inputInterval: interval,
  fullOutputInterval: interval,
  outputInterval: interval,
  displayReference: z.string().regex(/^[ACGTN]{41}$/),
  generatedAt: z.string().datetime({ offset: true }),
  predictionSeconds: finite.nonnegative(),
  transformations: z.array(z.object({
    operation: z.literal("display_crop"), afterFullContextInference: z.literal(true),
    start: z.number().int().nonnegative(), end: z.number().int().positive(),
  }).passthrough()).length(1),
  postprocessing: z.object({
    normalization: z.literal("none_added"), aggregation: z.literal("none"), resolutionBases: z.literal(1), note: text,
  }).passthrough(),
  annotationSettings: z.object({ geneMasks: z.boolean(), spliceJunctionAnnotations: z.boolean(), variantCalibration: z.literal(false) }).passthrough(),
  tracks: z.array(sourceTrackSchema).min(1).max(Math.floor(ANALYSIS_ROW_LIMIT / 41), `The complete result exceeds ${ANALYSIS_ROW_LIMIT} analytical rows; import an explicitly narrower upstream result.`),
  benchmark: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough().superRefine((result, context) => {
  const descriptor = referenceEvidence.variants.find(variant => variant.position === result.variant.position);
  if (!descriptor) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["variant", "position"], message: "This variant has no independently verified reference descriptor." });
    return;
  }
  for (const key of ["inputInterval", "fullOutputInterval"] as const) {
    if (result[key].start !== descriptor.inputInterval.start || result[key].end !== descriptor.inputInterval.end) context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Expected the verified 1,048,576-base context for this exact variant." });
  }
  if (result.outputInterval.start !== descriptor.displayInterval.start || result.outputInterval.end !== descriptor.displayInterval.end) context.addIssue({ code: z.ZodIssueCode.custom, path: ["outputInterval"], message: "Expected the verified 41-base crop for this exact variant." });
  if (result.displayReference !== descriptor.displayReference) context.addIssue({ code: z.ZodIssueCode.custom, path: ["displayReference"], message: "Display reference differs from the independently verified sequence for this variant." });
  if (result.referenceGenome.contextSha256.toLowerCase() !== descriptor.contextSha256) context.addIssue({ code: z.ZodIssueCode.custom, path: ["referenceGenome", "contextSha256"], message: "Context hash differs from the independently verified sequence for this variant." });
  if (result.transformations[0].start !== descriptor.displayInterval.start || result.transformations[0].end !== descriptor.displayInterval.end) context.addIssue({ code: z.ZodIssueCode.custom, path: ["transformations"], message: "Crop transformation does not match this variant's verified interval." });
  result.tracks.forEach((track, index) => {
    const issue = (message: string): void => context.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", index], message });
    if (track.start !== descriptor.displayInterval.start) context.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks", index, "start"], message: "Track bins do not start at this variant's verified crop." });
    if (track.name.toLowerCase() === "padding") issue("Padding is not a biological track.");
    if (track.originalMetadata.name !== track.name || (track.originalMetadata.strand ?? null) !== track.strand || (track.originalMetadata.unit ?? null) !== track.unit) issue("Track name, strand or unit differs from the original model metadata.");
    if (track.outputType === "SPLICE_SITES") {
      if (track.biosampleScope !== "tissue_agnostic" || track.biosampleId !== null) issue("SPLICE_SITES must remain tissue-agnostic with a null biosample identifier.");
      if (track.originalMetadata.ontology_curie || track.originalMetadata.biosample_name) issue("Tissue-agnostic SPLICE_SITES contradict the original biosample metadata.");
    } else {
      if (track.biosampleScope !== "biosample_specific" || track.biosampleId !== result.biosampleId || track.originalMetadata.ontology_curie !== result.biosampleId || track.originalMetadata.biosample_name?.toLowerCase() !== result.biosampleLabel.toLowerCase()) issue("RNA/usage track biosample does not match the requested glutamatergic-neuron metadata.");
    }
  });
});

export type ServicePredictionResult = z.infer<typeof servicePredictionResultSchema>;
export type SourceResultArtifact = { filename: string; sha256: string };

function validationError(error: unknown): never {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    throw new AnalysisImportError(`${issue.path.join(".") || "Service result"}: ${issue.message}`);
  }
  throw error;
}

/** Reads one raw first-prediction/warm-prediction result, not a queued job envelope. */
export function parseServiceResultJSON(text: string): ServicePredictionResult {
  if (new TextEncoder().encode(text).byteLength > ANALYSIS_PAYLOAD_LIMIT) throw new AnalysisImportError("Service result exceeds the 2 MB limit.");
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { throw new AnalysisImportError("Invalid service-result JSON; no output was produced."); }
  try { return servicePredictionResultSchema.parse(raw); } catch (error) { return validationError(error); }
}

/** Copies every supplied bin; no smoothing, normalization, scoring or inference occurs. */
export function convertServiceResultToDataset(raw: unknown, artifact: SourceResultArtifact): TrackDataset {
  try {
    const result = servicePredictionResultSchema.parse(raw);
    const variantId = `${result.variant.chromosome}:${result.variant.position}:${result.variant.reference}>${result.variant.alternate}`;
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > ANALYSIS_PAYLOAD_LIMIT) throw new AnalysisImportError("Service result exceeds the 2 MB limit.");
    const keys = result.tracks.map((track, index) => `${track.outputType}:${index}:${track.name}`);
    const cleanInterval = (value: ServicePredictionResult["inputInterval"]) => ({
      chromosome: value.chromosome, start: value.start, end: value.end, coordinateSystem: value.coordinateSystem,
    });
    const dataset = analysisDatasetSchema.parse({
      schemaVersion: 1, id: `alphagenome-service-${artifact.sha256.toLowerCase()}`, title: "DNM1 · Reference / alternate tracks", kind: "tracks",
      provenance: {
        sourceUrl: "https://huggingface.co/google/alphagenome-all-folds", sourceLabel: "Imported AlphaGenome GPU service result",
        assembly: result.referenceGenome.referenceVersion, model: result.model,
        context: `Variant ${variantId}; requested ${result.biosampleLabel}. Tissue scope is recorded per track.`,
        recordedAt: result.generatedAt, mode: "imported", artifact,
        inference: {
          variant: variantId, inputInterval: cleanInterval(result.inputInterval), displayInterval: cleanInterval(result.outputInterval),
          modelRevision: result.modelRevision, clientRevision: result.clientRevision, checkpointRevision: result.checkpointRevision,
          referenceVersion: result.referenceGenome.referenceVersion, referenceSha256: null,
          inputSequenceSha256: result.referenceGenome.contextSha256,
          transformations: result.transformations.map(value => JSON.stringify(value)),
        },
      },
      rows: result.tracks.flatMap((track, index) => track.reference.map((reference, bin) => ({
        chromosome: track.chromosome, position: track.start + bin * track.binSizeBases,
        reference, alternate: track.alternate[bin], track: keys[index],
      }))),
      trackMetadata: result.tracks.map((track, index) => ({
        chromosome: track.chromosome, track: keys[index], sourceName: track.name, sourceIndex: index,
        outputType: track.outputType, unit: track.unit, strand: track.strand,
        biosampleId: track.biosampleId,
        biosampleName: track.biosampleScope === "tissue_agnostic" ? null : track.originalMetadata.biosample_name,
        scope: track.biosampleScope, binSize: track.binSizeBases,
      })),
    });
    if (dataset.kind !== "tracks") throw new AnalysisImportError("Converted dataset must contain tracks.");
    if (new TextEncoder().encode(JSON.stringify(dataset)).byteLength > ANALYSIS_PAYLOAD_LIMIT) throw new AnalysisImportError("Converted analysis exceeds the 2 MB limit; no rows were dropped.");
    return dataset;
  } catch (error) { return validationError(error); }
}
