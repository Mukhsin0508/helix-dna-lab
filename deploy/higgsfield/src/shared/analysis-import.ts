import { z } from "zod";
import {
  ANALYSIS_PAYLOAD_LIMIT, ANALYSIS_ROW_LIMIT, analysisDatasetSchema, sortTrackRows,
  type AnalysisDataset, type AnalysisProvenance, type ScoreDataset, type TrackDataset,
} from "./analysis";

export class AnalysisImportError extends Error {
  constructor(message: string) { super(message); this.name = "AnalysisImportError"; }
}

function assertPayload(text: string): void {
  if (new TextEncoder().encode(text).byteLength > ANALYSIS_PAYLOAD_LIMIT) throw new AnalysisImportError("Import exceeds the 2 MB limit.");
  if (!text.trim()) throw new AnalysisImportError("The import is empty.");
}

function validateDataset(value: unknown): AnalysisDataset {
  try {
    const dataset = analysisDatasetSchema.parse(value);
    return dataset.kind === "tracks" ? { ...dataset, rows: sortTrackRows(dataset.rows) } : dataset;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      throw new AnalysisImportError(`${issue.path.join(".") || "Dataset"}: ${issue.message}`);
    }
    throw error;
  }
}

/** Validates an exported dataset without discarding fields or changing recorded scores. */
export function parseDatasetJSON(text: string): AnalysisDataset {
  assertPayload(text);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new AnalysisImportError("Invalid JSON. Import a complete analysis dataset object."); }
  return validateDataset(value);
}

/** RFC 4180-style quoted fields, doubled quotes, CRLF and embedded newlines. */
function parseCSV(text: string): string[][] {
  assertPayload(text);
  const input = text.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let state: "plain" | "quoted" | "closed" = "plain";
  const endField = (): void => { record.push(field); field = ""; state = "plain"; };
  const endRecord = (): void => {
    endField(); records.push(record); record = [];
    if (records.length > ANALYSIS_ROW_LIMIT + 1) throw new AnalysisImportError(`Import exceeds ${ANALYSIS_ROW_LIMIT.toLocaleString("en-US")} rows.`);
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (state === "quoted") {
      if (character === '"') {
        if (input[index + 1] === '"') { field += '"'; index += 1; }
        else state = "closed";
      } else field += character;
      continue;
    }
    if (character === ",") { endField(); continue; }
    if (character === "\r" || character === "\n") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      endRecord(); continue;
    }
    if (state === "closed") throw new AnalysisImportError(`Unexpected text after a closing quote near character ${index + 1}.`);
    if (character === '"') {
      if (field !== "") throw new AnalysisImportError(`Quote inside an unquoted field near character ${index + 1}.`);
      state = "quoted";
    } else field += character;
  }
  if (state === "quoted") throw new AnalysisImportError("Unclosed quoted field in CSV.");
  if (field !== "" || record.length > 0 || state === "closed") endRecord();
  while (records.length > 0 && records.at(-1)?.every(value => value === "")) records.pop();
  return records;
}

const scoreColumns = ["variant", "biosample", "modality", "scorer", "score", "quantile", "gene", "track", "unit", "signed", "trackStrand", "assay", "sourceRowIndex", "scoredInterval", "geneId", "geneStrand", "histoneMark"] as const;
const trackColumns = ["chromosome", "position", "reference", "alternate", "track"] as const;

function csvObjects(text: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown>[] {
  const [first, ...records] = parseCSV(text);
  if (!first) throw new AnalysisImportError("CSV requires a header and at least one data row.");
  const headers = first.map(value => value.trim());
  if (new Set(headers).size !== headers.length) throw new AnalysisImportError("CSV contains duplicate column names.");
  const unknown = headers.find(value => !allowed.includes(value));
  if (unknown !== undefined) throw new AnalysisImportError(`Unknown CSV column: ${unknown || "(empty)"}.`);
  const missing = required.filter(value => !headers.includes(value));
  if (missing.length) throw new AnalysisImportError(`Missing required CSV columns: ${missing.join(", ")}.`);
  if (records.length === 0) throw new AnalysisImportError("CSV requires at least one data row.");
  return records.map((record, rowIndex) => {
    if (record.length !== headers.length) throw new AnalysisImportError(`CSV row ${rowIndex + 2} has ${record.length} columns; expected ${headers.length}.`);
    return Object.fromEntries(headers.flatMap<[string, unknown]>((key, column) => {
      const value = record[column].trim();
      if (value === "" && !required.includes(key)) return [];
      if (["score", "quantile", "position", "reference", "alternate", "sourceRowIndex"].includes(key)) {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new AnalysisImportError(`CSV row ${rowIndex + 2}, ${key}: expected a finite number; blank values are not zero.`);
        return [[key, Number(value)]];
      }
      if (key === "signed") {
        if (value !== "true" && value !== "false") throw new AnalysisImportError(`CSV row ${rowIndex + 2}, signed: use true or false.`);
        return [[key, value === "true"]];
      }
      return [[key, value]];
    }));
  });
}

export type ImportProvenance = Partial<Omit<AnalysisProvenance, "mode">>;

function importedProvenance(provenance: ImportProvenance = {}): AnalysisProvenance {
  if (!provenance.assembly?.trim()) throw new AnalysisImportError("Specify the reference assembly for this import; it cannot be inferred from coordinates.");
  return {
    sourceUrl: "", sourceLabel: "User import", model: "Not specified", context: "Not specified",
    ...provenance, assembly: provenance.assembly, mode: "imported",
  };
}

/** Imports supplied scores only. It does not execute AlphaGenome or infer missing metadata. */
export function parseScoreCSV(text: string, provenance?: ImportProvenance, title = "Imported molecular scores"): ScoreDataset {
  const metadata = importedProvenance(provenance);
  const rows = csvObjects(text, scoreColumns, ["variant", "biosample", "modality", "scorer", "score"]);
  return validateDataset({ schemaVersion: 1, id: crypto.randomUUID(), title, kind: "scores", provenance: metadata, rows }) as ScoreDataset;
}

/** CSV track positions are zero-based, and each chromosome/position/track must be unique. */
export function parseTrackCSV(text: string, provenance?: ImportProvenance, title = "Imported reference / alternate tracks"): TrackDataset {
  const metadata = importedProvenance(provenance);
  const rows = csvObjects(text, trackColumns, trackColumns);
  return validateDataset({ schemaVersion: 1, id: crypto.randomUUID(), title, kind: "tracks", provenance: metadata, rows }) as TrackDataset;
}

/** Lossless scalar CSV export. JSON remains the complete provenance-bearing format. */
export function datasetToCSV(value: AnalysisDataset): string {
  const dataset = validateDataset(value);
  const columns = dataset.kind === "scores" ? scoreColumns : trackColumns;
  const quote = (value: unknown): string => {
    const text = value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.join(","), ...dataset.rows.map(row => columns.map(key => quote((row as Record<string, unknown>)[key])).join(","))].join("\r\n") + "\r\n";
}

/** Accepts already-normalized source rows and explicitly supplied publication provenance. */
export function normalizePublishedDataset(raw: unknown, provenance: AnalysisProvenance, title = "Published molecular scores", id = "published-molecular-scores"): ScoreDataset {
  if (provenance.mode !== "published-example") throw new AnalysisImportError("Published dataset normalization requires published-example provenance.");
  return validateDataset({ schemaVersion: 1, id, title, kind: "scores", provenance, rows: raw }) as ScoreDataset;
}
