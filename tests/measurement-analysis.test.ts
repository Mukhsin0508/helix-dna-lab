import assert from "node:assert/strict";
import test from "node:test";
import { analysisDatasetSchema, experimentSchema, type AnalysisInference, type MeasurementDataset } from "../shared/analysis";
import { datasetToCSV, parseDatasetJSON, parseScoreCSV, parseTrackCSV } from "../shared/analysis-import";

/** Synthetic schema fixtures only; these numbers are not experimental results. */
function measurements(): MeasurementDataset {
  return {
    schemaVersion: 1, id: "synthetic-measurement-contract", title: "Synthetic measurement validation",
    kind: "measurements",
    provenance: { sourceUrl: "https://example.org/synthetic-schema-test", sourceLabel: "Synthetic test fixture", assembly: "GRCh38", model: "Not applicable", context: "Schema testing only", mode: "published-example" },
    experiment: {
      assay: "Synthetic splice assay", endpoint: "Fraction of included transcripts", unit: "fraction", unitLabel: "Inclusion fraction",
      aggregation: "Reported mean over the specified conditions", conditions: ["Synthetic condition A"],
      replicatePolicy: "Replicate count and standard error were not supplied", sourceLocator: "Synthetic table, row 2",
    },
    rows: [{ variant: "chr9:128226027:G>A", gene: "DNM1", value: 0.12345678901234568, reportedValue: "0.12345678901234568", replicates: null, standardError: null, sourceRowIndex: 2 }],
  };
}

test("measurements preserve assay semantics, unknown uncertainty and original numerical text through JSON", () => {
  const dataset = measurements();
  dataset.rows[0] = { ...dataset.rows[0], value: 0.125, reportedValue: " 1.2500e-1 " };
  dataset.provenance.artifact = { filename: "source-table.tsv", sha256: "a1".repeat(32) };
  assert.deepEqual(parseDatasetJSON(JSON.stringify(dataset)), dataset);
  assert.equal(dataset.rows[0].replicates, null);
  assert.equal(dataset.rows[0].standardError, null);
  assert.equal(dataset.provenance.inference, undefined);
});

test("fraction, percent and count domains prevent impossible measurements without rounding aggregates", () => {
  const dataset = measurements();
  delete dataset.rows[0].reportedValue;
  const cases = [
    { unit: "fraction" as const, valid: [0, 0.23, 1], invalid: [-0.001, 1.001] },
    { unit: "percent" as const, valid: [0, 23.75, 100], invalid: [-0.001, 100.001] },
    { unit: "count" as const, valid: [0, 12.5, 10_000], invalid: [-1] },
    { unit: "arbitrary" as const, valid: [-12.5, 0, 25.75], invalid: [] },
  ];
  for (const { unit, valid, invalid } of cases) {
    dataset.experiment.unit = unit;
    for (const value of valid) {
      dataset.rows[0].value = value;
      assert.equal(analysisDatasetSchema.safeParse(dataset).success, true, `${unit}: ${value}`);
    }
    for (const value of invalid) {
      dataset.rows[0].value = value;
      assert.throws(() => parseDatasetJSON(JSON.stringify(dataset)), /valid range/, `${unit}: ${value}`);
    }
  }
});

test("measurement values and uncertainty reject coercion, infinity and invented missing-value defaults", () => {
  for (const value of [NaN, Infinity, -Infinity, true, "0.1", null]) {
    const dataset = measurements();
    const rows = [{ ...dataset.rows[0], value }];
    assert.equal(analysisDatasetSchema.safeParse({ ...dataset, rows }).success, false);
  }
  for (const replicates of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true, "3", undefined]) {
    const dataset = measurements();
    assert.equal(analysisDatasetSchema.safeParse({ ...dataset, rows: [{ ...dataset.rows[0], replicates }] }).success, false);
  }
  for (const standardError of [-0.1, Infinity, NaN, "0.1", true, undefined]) {
    const dataset = measurements();
    assert.equal(analysisDatasetSchema.safeParse({ ...dataset, rows: [{ ...dataset.rows[0], standardError }] }).success, false);
  }
  const known = measurements();
  known.rows[0].replicates = 3;
  known.rows[0].standardError = 0;
  assert.deepEqual(parseDatasetJSON(JSON.stringify(known)), known);
  const partiallyKnown = measurements();
  partiallyKnown.rows[0].standardError = 0.023;
  assert.deepEqual(parseDatasetJSON(JSON.stringify(partiallyKnown)), partiallyKnown);
});

test("reported source text must match the actual scalar and cannot silently round it", () => {
  const dataset = measurements();
  for (const reportedValue of ["", " ", "NaN", "Infinity", "0x10", "12%", "<0.01", "0.12346", "1e999"]) {
    assert.equal(analysisDatasetSchema.safeParse({ ...dataset, rows: [{ ...dataset.rows[0], reportedValue }] }).success, false, reportedValue);
  }
  const zero = { ...dataset.rows[0], value: 0, reportedValue: "0.000" };
  assert.equal(analysisDatasetSchema.safeParse({ ...dataset, rows: [zero] }).success, true);
  const withoutText = measurements(); delete withoutText.rows[0].reportedValue;
  assert.equal(analysisDatasetSchema.safeParse(withoutText).success, true);
});

test("each dataset declares a single experiment context and rejects ambiguous duplicate variants", () => {
  const dataset = measurements();
  dataset.rows.push({ ...dataset.rows[0], gene: "Different annotation" });
  assert.throws(() => parseDatasetJSON(JSON.stringify(dataset)), /Duplicate variant/);
  dataset.rows[1].variant = "chr9:128226027:G>T";
  assert.equal(analysisDatasetSchema.safeParse(dataset).success, true);
  const noContext = measurements(); noContext.experiment.conditions = [];
  assert.equal(analysisDatasetSchema.safeParse(noContext).success, false);
  for (const key of ["assay", "endpoint", "unitLabel", "aggregation", "replicatePolicy", "sourceLocator"] as const) {
    assert.equal(experimentSchema.safeParse({ ...measurements().experiment, [key]: " " }).success, false, key);
  }
  assert.equal(analysisDatasetSchema.safeParse({ ...measurements(), rows: [{ ...measurements().rows[0], condition: "Another condition" }] }).success, false);
  assert.equal(analysisDatasetSchema.safeParse({ ...measurements(), experiment: { ...measurements().experiment, unit: "probability_of_cure" } }).success, false);
});

test("measurement coordinates use one-based SNVs and retain the existing GRCh38 chromosome bounds", () => {
  const dataset = measurements();
  for (const variant of ["chr9:0:G>A", "chr9:1:G>G", "chr9:1:GA>A", "chr23:1:G>A", "chrM:16570:G>A"]) {
    dataset.rows[0].variant = variant;
    assert.equal(analysisDatasetSchema.safeParse(dataset).success, false, variant);
  }
  dataset.rows[0].variant = "chrM:16569:G>A";
  assert.equal(analysisDatasetSchema.safeParse(dataset).success, true);
  dataset.provenance.assembly = "GRCh38.p14";
  dataset.rows[0].variant = "chrM:16570:G>A";
  assert.equal(analysisDatasetSchema.safeParse(dataset).success, false);
  for (const sourceRowIndex of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const valid = measurements(); valid.rows[0].sourceRowIndex = sourceRowIndex;
    assert.equal(analysisDatasetSchema.safeParse(valid).success, false);
  }
});

test("model execution provenance cannot turn experimental measurements into predictions", () => {
  const inference: AnalysisInference = {
    variant: "chr9:128226027:G>A", inputInterval: { chromosome: "chr9", start: 128226000, end: 128226100, coordinateSystem: "0-based-half-open" },
    displayInterval: { chromosome: "chr9", start: 128226000, end: 128226100, coordinateSystem: "0-based-half-open" },
    modelRevision: "synthetic", clientRevision: "synthetic", checkpointRevision: "synthetic", referenceVersion: "GRCh38", referenceSha256: null, transformations: [],
  };
  const dataset = measurements(); dataset.provenance.inference = inference;
  assert.throws(() => parseDatasetJSON(JSON.stringify(dataset)), /cannot carry model inference provenance/);
  assert.equal(analysisDatasetSchema.safeParse({ ...measurements(), kind: "scores" }).success, false);
  assert.equal(analysisDatasetSchema.safeParse({ ...measurements(), kind: "tracks" }).success, false);
});

test("measurement imports enforce source metadata, row limits and UTF-8 payload limits", () => {
  const dataset = measurements();
  assert.throws(() => parseDatasetJSON(JSON.stringify({ ...dataset, provenance: { ...dataset.provenance, sourceUrl: "" } })), /source URL/);
  assert.equal(analysisDatasetSchema.safeParse({ ...dataset, provenance: { ...dataset.provenance, assembly: " " } }).success, false);
  dataset.rows = Array.from({ length: 5000 }, (_, index) => ({ variant: `chr1:${index + 1}:G>A`, value: 0.25, replicates: null, standardError: null }));
  assert.equal(parseDatasetJSON(JSON.stringify(dataset)).rows.length, 5000);
  dataset.rows.push({ ...dataset.rows[0], variant: "chr1:5001:G>A" });
  assert.throws(() => parseDatasetJSON(JSON.stringify(dataset)), /5000/);
  assert.throws(() => parseDatasetJSON(`{"tooLarge":"${"🙂".repeat(524289)}"}`), /2 MB/);
});

test("measurement CSV exports unrounded values, reported spelling and explicit unknown n and SE", () => {
  const dataset = measurements();
  dataset.rows[0].gene = 'Gene, "quoted"\nannotation';
  const csv = datasetToCSV(dataset);
  assert.equal(csv, 'variant,gene,value,reportedValue,replicates,standardError,sourceRowIndex\r\nchr9:128226027:G>A,"Gene, ""quoted""\nannotation",0.12345678901234568,0.12345678901234568,null,null,2\r\n');
  dataset.rows[0].value = 0.125;
  dataset.rows[0].reportedValue = "1.2500e-1";
  dataset.rows[0].replicates = 4;
  dataset.rows[0].standardError = 0.0000000123456789012345;
  const knownCSV = datasetToCSV(dataset);
  assert.ok(knownCSV.includes(",0.125,1.2500e-1,4,1.23456789012345e-8,2\r\n"));
});

test("existing saved scores and tracks still import and export without measurement metadata", () => {
  const provenance = { assembly: "GRCh38" };
  const scores = parseScoreCSV("variant,biosample,modality,scorer,score\nchr9:128226027:G>A,test,RNA_SEQ,test,-0.125", provenance);
  const tracks = parseTrackCSV("chromosome,position,reference,alternate,track\nchr9,128226026,0.125,0.25,test", provenance);
  assert.deepEqual(parseDatasetJSON(JSON.stringify(scores)), scores);
  assert.deepEqual(parseDatasetJSON(JSON.stringify(tracks)), tracks);
  assert.deepEqual(parseScoreCSV(datasetToCSV(scores), provenance).rows, scores.rows);
  assert.deepEqual(parseTrackCSV(datasetToCSV(tracks), provenance).rows, tracks.rows);
});
