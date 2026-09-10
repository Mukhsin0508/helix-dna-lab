import { z } from "zod";
import { DEFAULT_EXPERIMENT } from "./experiments";
import { SICKLE_CELL_EVIDENCE } from "./outcomes";

// Fits 20 fully populated candidates, including JSON-escaped Unicode notes.
export const WORKSPACE_BODY_LIMIT = 512 * 1024;

export const workspaceIdSchema = z.string().uuid();
export const workspaceRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** A saved comparison setup. It contains no model result or estimated efficacy. */
export const candidateSchema = z.object({
  id: workspaceIdSchema,
  title: z.string().trim().min(1).max(80),
  question: z.string().trim().min(1).max(500),
  scenario: z.enum(["sickle-cell", "dnm1"]),
  intervention: z.enum(["baseline", "intervention"]),
  selectedIndex: z.number().int().min(0).max(40),
  alternate: z.enum(["A", "C", "G", "T"]),
  notes: z.string().max(3000),
  createdAt: z.string().datetime(),
}).strict().superRefine((candidate, context) => {
  // The clinical evidence case is not an editable DNA sequence or gene-therapy simulator.
  if (candidate.scenario === "sickle-cell" && (candidate.selectedIndex !== 20 || candidate.alternate !== "A")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedIndex"],
      message: "The sickle-cell evidence case uses fixed sequence settings.",
    });
  }
});

export const candidatesSchema = z.array(candidateSchema).min(1).max(20).superRefine((candidates, context) => {
  if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Candidate IDs must be unique." });
  }
});

export const workspaceSchema = z.object({
  id: workspaceIdSchema,
  revision: workspaceRevisionSchema,
  candidates: candidatesSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const workspaceCreateSchema = z.object({}).strict();
export const workspacePatchSchema = z.object({
  revision: workspaceRevisionSchema,
  candidates: candidatesSchema,
}).strict();

export type Candidate = z.infer<typeof candidateSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspacePatch = z.infer<typeof workspacePatchSchema>;
export interface WorkspaceEnvelope { workspace: Workspace }

/** Creates one evidence comparison; UUID generation is provided by the host. */
export function newWorkspace(randomId: () => string, now = new Date().toISOString()): Workspace {
  return {
    id: randomId(),
    revision: 0,
    candidates: [{
      id: randomId(),
      title: "Fetal hemoglobin",
      question: "Can gene therapy reduce sickle-cell crises?",
      scenario: "sickle-cell",
      intervention: "intervention",
      selectedIndex: 20,
      alternate: "A",
      notes: "",
      createdAt: now,
    }],
    createdAt: now,
    updatedAt: now,
  };
}

/** Serializes the last server-confirmed workspace without inventing analysis results. */
export function workspaceToJSON(workspace: Workspace): string {
  const saved = workspaceSchema.parse(workspace);
  return JSON.stringify({
    format: "helix-workspace",
    version: "1.0",
    exportedAt: new Date().toISOString(),
    workspace: saved,
    evidenceReferences: saved.candidates.map(candidate => {
      if (candidate.scenario === "sickle-cell") return {
        candidateId: candidate.id,
        relationship: "Historical context for an illustrative mechanism; not a computed outcome for this candidate.",
        source: SICKLE_CELL_EVIDENCE,
      };
      const unchanged = DEFAULT_EXPERIMENT.referenceSequence[candidate.selectedIndex] === candidate.alternate;
      const matchesStudy = candidate.selectedIndex === DEFAULT_EXPERIMENT.defaultIndex && candidate.alternate === DEFAULT_EXPERIMENT.alternate;
      return {
        candidateId: candidate.id,
        status: unchanged ? "unchanged" : matchesStudy ? "published-replay-available" : "unscored",
        referenceAssembly: DEFAULT_EXPERIMENT.locus.assembly,
        chromosome: DEFAULT_EXPERIMENT.locus.chromosome,
        positionOneBased: DEFAULT_EXPERIMENT.locus.start + candidate.selectedIndex,
        reference: DEFAULT_EXPERIMENT.referenceSequence[candidate.selectedIndex],
        alternate: candidate.alternate,
        ...(matchesStudy ? { publishedEvidence: DEFAULT_EXPERIMENT.evidence, sources: DEFAULT_EXPERIMENT.sources } : {}),
      };
    }),
    scientificProvenance: {
      mode: "saved evidence comparison setup",
      liveModelUsed: false,
      results: "This export records questions, comparison settings and notes. It contains no new biological prediction, treatment success estimate or experimental result.",
    },
  }, null, 2);
}
