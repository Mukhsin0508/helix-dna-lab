import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analysisDatasetSchema, scoreComparisonKey, type AnalysisProvenance, type ScoreDataset } from "../shared/analysis";
import {
  AnalysisImportError, datasetToCSV, normalizePublishedDataset, parseDatasetJSON,
  parseScoreCSV, parseTrackCSV,
} from "../shared/analysis-import";

const provenance: AnalysisProvenance = {
  sourceUrl: "https://github.com/google-deepmind/alphagenome/blob/main/colabs/batch_variant_scoring.ipynb",
  sourceLabel: "Google DeepMind published notebook output",
  assembly: "GRCh38",
  model: "AlphaGenome; model version not recorded",
  context: "T-cell",
  recordedAt: "2025-07-21T15:55:12.546000+00:00",
  mode: "published-example",
};

function scoreDataset(): ScoreDataset {
  return {
    schemaVersion: 1, id: "test-scores", title: "T-cell variants", kind: "scores", provenance,
    rows: [{ variant: "chr3:58394738:A>T", biosample: "T-cell", modality: "ATAC", scorer: "CenterMaskScorer(requested_output=ATAC, width=501, aggregation_type=DIFF_LOG2_SUM)", score: -0.003777742385864258, quantile: -0.21573995053768158, track: "CL:0000084 ATAC-seq", unit: "log2 ratio of summed predicted signal (+1 pseudocount)", signed: true, trackStrand: ".", sourceRowIndex: 0 }],
  };
}

const scoreHeader = "variant,biosample,modality,scorer,score";
const scoreLine = "chr3:58394738:A>T,T-cell,ATAC,custom-scorer,-0.003777742385864258";
const trackHeader = "chromosome,position,reference,alternate,track";

test("published normalization retains all 524 real source rows and full signed numerical precision", () => {
  const rows = JSON.parse(readFileSync(new URL("../data/atlas/published-tcell-scores.normalized.json", import.meta.url), "utf8"));
  const dataset = normalizePublishedDataset(rows, provenance, "Published T-cell scores", "official-tcells");
  assert.equal(dataset.rows.length, 524);
  assert.deepEqual(dataset.rows, rows);
  assert.equal(dataset.rows[0].score, -0.003777742385864258);
  assert.equal(dataset.rows[0].quantile, -0.21573995053768158);
  assert.deepEqual(parseDatasetJSON(JSON.stringify(dataset)), dataset);
  assert.throws(() => normalizePublishedDataset(rows, { ...provenance, mode: "imported" }), /published-example/);
});

test("score CSV round-trips full precision, signs and optional metadata", () => {
  const dataset = scoreDataset();
  dataset.rows[0] = { ...dataset.rows[0], gene: "A, B", assay: 'Quoted "assay"\nsecond line', geneStrand: "+", geneId: "ENSG000000001", histoneMark: "H3K27ac", scoredInterval: "chr3:57870450-58919026:." };
  const csv = datasetToCSV(dataset);
  const imported = parseScoreCSV(csv, provenance, dataset.title);
  assert.deepEqual(imported.rows, dataset.rows);
  assert.equal(imported.provenance.mode, "imported");
  assert.equal(imported.title, dataset.title);
  assert.notEqual(imported.id, dataset.id);
});

test("CSV does not turn missing or non-finite scores into zero", () => {
  for (const value of ["", "NaN", "Infinity", "-Infinity", "null", "1e999", "0x10"]) {
    assert.throws(() => parseScoreCSV(`${scoreHeader}\nchr3:58394738:A>T,T-cell,ATAC,custom,${value}`, { assembly: "GRCh38" }), /finite number/);
  }
  const zero = parseScoreCSV(`${scoreHeader},quantile\nchr3:58394738:A>T,T-cell,ATAC,custom,0,`, { assembly: "GRCh38" });
  assert.equal(zero.rows[0].score, 0);
  assert.equal(zero.rows[0].quantile, undefined);
});

test("CSV quoting supports BOM, CRLF, commas, quotes and line breaks", () => {
  const csv = `\uFEFF${scoreHeader}\r\nchr3:58394738:A>T,"T-cell, activated",ATAC,"quoted ""scorer""\nline",-3.777742385864258e-3\r\n`;
  const dataset = parseScoreCSV(csv, { assembly: "GRCh38" });
  assert.equal(dataset.rows[0].biosample, "T-cell, activated");
  assert.equal(dataset.rows[0].scorer, 'quoted "scorer"\nline');
  assert.equal(dataset.rows[0].score, -0.003777742385864258);
  assert.deepEqual(parseScoreCSV(datasetToCSV(dataset), dataset.provenance).rows, dataset.rows);
});

test("malformed CSV produces explicit errors without partial datasets", () => {
  const cases: Array<[string, RegExp]> = [
    [`${scoreHeader},score\n${scoreLine},1`, /duplicate column/],
    [`${scoreHeader},banana\n${scoreLine},1`, /Unknown CSV column/],
    ["variant,score\nchr3:58394738:A>T,1", /Missing required/],
    [`${scoreHeader}\n${scoreLine},extra`, /expected 5/],
    [`${scoreHeader}\nchr3:58394738:A>T,T-cell,ATAC,"broken,1`, /Unclosed/],
    [`${scoreHeader}\nchr3:58394738:A>T,T-cell,ATAC,"closed"junk,1`, /Unexpected text/],
    [`${scoreHeader}\nchr3:58394738:A>T,T-cell,ATAC,un"quoted,1`, /Quote inside/],
  ];
  for (const [csv, message] of cases) assert.throws(() => parseScoreCSV(csv, { assembly: "GRCh38" }), message);
});

test("variant validation preserves reference orientation and requires supported SNV coordinates", () => {
  for (const variant of ["chr9:0:G>A", "chr9:01:G>A", "chr9:1:N>A", "chr9:1:G>G", "chr23:1:G>A", "chr9:1:GA>A", "chr9:9007199254740992:G>A"]) {
    const dataset = scoreDataset(); dataset.rows[0].variant = variant;
    assert.equal(analysisDatasetSchema.safeParse(dataset).success, false, variant);
  }
  const dataset = scoreDataset(); dataset.rows[0].variant = "chr9:128226027:G>A";
  const parsed = parseDatasetJSON(JSON.stringify(dataset));
  assert.equal(parsed.kind === "scores" && parsed.rows[0].variant, "chr9:128226027:G>A");
});

test("GRCh38 bounds distinguish one-based variants and zero-based track positions", () => {
  const dataset = scoreDataset();
  dataset.rows[0].variant = "chrM:16569:G>A";
  assert.equal(analysisDatasetSchema.safeParse(dataset).success, true);
  dataset.rows[0].variant = "chrM:16570:G>A";
  assert.equal(analysisDatasetSchema.safeParse(dataset).success, false);
  assert.equal(parseTrackCSV(`${trackHeader}\nchrM,16568,1,2,signal`, { assembly: "GRCh38" }).rows[0].position, 16568);
  assert.throws(() => parseTrackCSV(`${trackHeader}\nchrM,16569,1,2,signal`, { assembly: "GRCh38" }), /Zero-based/);
});

test("track imports sort coordinates without fabricating or averaging signals", () => {
  const dataset = parseTrackCSV(`${trackHeader}\nchr10,2,0.12,0.45,signal\nchr2,0,0,0.000001,signal\nchr2,3,-1,2,signal`, { assembly: "GRCh38" });
  assert.deepEqual(dataset.rows.map(row => [row.chromosome, row.position]), [["chr2", 0], ["chr2", 3], ["chr10", 2]]);
  assert.equal(dataset.rows[1].reference, -1);
  assert.deepEqual(parseTrackCSV(datasetToCSV(dataset), dataset.provenance).rows, dataset.rows);
  assert.throws(() => parseTrackCSV(`${trackHeader}\nchr2,0,1,2,signal\nchr2,0,3,4,signal`, { assembly: "GRCh38" }), /Duplicate/);
  assert.throws(() => parseTrackCSV(`${trackHeader}\nchr2,-1,1,2,signal`, { assembly: "GRCh38" }), /position/);
  assert.throws(() => parseTrackCSV(`${trackHeader}\nchr2,0.5,1,2,signal`, { assembly: "GRCh38" }), /position/);
  assert.throws(() => parseTrackCSV("position,reference,alternate,track\n0,1,2,signal", { assembly: "GRCh38" }), /chromosome/);
});

test("dataset discriminator rejects score rows posing as genomic tracks and unknown fields", () => {
  assert.throws(() => parseDatasetJSON(JSON.stringify({ ...scoreDataset(), kind: "tracks" })), AnalysisImportError);
  assert.throws(() => parseDatasetJSON(JSON.stringify({ ...scoreDataset(), livePrediction: true })), /Unrecognized key/);
  const dataset = scoreDataset();
  assert.throws(() => parseDatasetJSON(JSON.stringify({ ...dataset, rows: [{ ...dataset.rows[0], score: null }] })), /score/);
  assert.throws(() => parseDatasetJSON("[1,2,3]"), /Dataset/);
  assert.throws(() => parseDatasetJSON("{"), /Invalid JSON/);
});

test("metadata requires explicit assembly, preserves known source and does not claim inference", () => {
  assert.throws(() => parseScoreCSV(`${scoreHeader}\n${scoreLine}`), /reference assembly/);
  const dataset = parseScoreCSV(`${scoreHeader}\n${scoreLine}`, { assembly: "GRCh37" });
  assert.deepEqual(dataset.provenance, { assembly: "GRCh37", sourceUrl: "", sourceLabel: "User import", model: "Not specified", context: "Not specified", mode: "imported" });
  assert.throws(() => parseScoreCSV(`${scoreHeader}\n${scoreLine}`, { assembly: "GRCh38", sourceUrl: "javascript:alert(1)" }), /Source URL/);
  assert.throws(() => parseScoreCSV(`${scoreHeader}\n${scoreLine}`, { assembly: "GRCh38", sourceUrl: "https://user:secret@example.org" }), /Source URL/);
  assert.throws(() => parseDatasetJSON(JSON.stringify({ ...scoreDataset(), provenance: { ...provenance, sourceUrl: "" } })), /source URL/);
});

test("signed quantiles remain distinct from probabilities and comparison groups retain assay semantics", () => {
  const row = scoreDataset().rows[0];
  for (const quantile of [-1, -0.2, 0, 1]) assert.equal(analysisDatasetSchema.safeParse({ ...scoreDataset(), rows: [{ ...row, quantile }] }).success, true);
  for (const quantile of [-1.1, 1.1]) assert.equal(analysisDatasetSchema.safeParse({ ...scoreDataset(), rows: [{ ...row, quantile }] }).success, false);
  for (const changed of [{ scorer: "another scorer" }, { track: "another track" }, { trackStrand: "+" as const }, { modality: "RNA_SEQ" }, { unit: "different units" }, { signed: false }]) {
    assert.notEqual(scoreComparisonKey(row), scoreComparisonKey({ ...row, ...changed }));
  }
});

test("imports enforce 5000 rows and a UTF-8 two-megabyte payload limit", () => {
  assert.equal(parseScoreCSV(`${scoreHeader}\n${Array(5000).fill(scoreLine).join("\n")}`, { assembly: "GRCh38" }).rows.length, 5000);
  assert.throws(() => parseScoreCSV(`${scoreHeader}\n${Array(5001).fill(scoreLine).join("\n")}`, { assembly: "GRCh38" }), /5,000 rows/);
  assert.throws(() => parseDatasetJSON(`{"large":"${"🙂".repeat(524289)}"}`), /2 MB/);
  const dataset = scoreDataset();
  assert.throws(() => parseDatasetJSON(JSON.stringify({ ...dataset, rows: Array(5001).fill(dataset.rows[0]) })), /5000/);
});
