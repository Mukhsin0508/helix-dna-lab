export type Base = "A" | "C" | "G" | "T";
export type ViewMode = "cell" | "dna" | "rna";
export type ExperimentStatus = "ready" | "replayed" | "unscored";
export interface LabSession {
  id: string;
  experimentId: string;
  selectedIndex: number;
  alternate: Base;
  view: ViewMode;
  compare: boolean;
  progress: number;
  status: ExperimentStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface SessionEnvelope {
  session: LabSession;
}
export interface EvidenceSource {
  title: string;
  url: string;
}
export interface ExperimentDefinition {
  id: string;
  gene: string;
  title: string;
  tissue: string;
  referenceSequence: string;
  sequenceKind: "illustrative" | "reference";
  defaultIndex: number;
  alternate: Base;
  summary: string;
  mechanism: string;
  evidence: string;
  limitation: string;
  sources: EvidenceSource[];
}
export interface SessionPatch {
  selectedIndex?: number;
  alternate?: Base;
  view?: ViewMode;
  compare?: boolean;
  progress?: number;
  revision: number;
}
