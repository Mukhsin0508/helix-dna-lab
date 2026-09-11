import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analysisDatasetSchema, scoreComparisonKey, type AnalysisProvenance, type ScoreDataset, type TrackDataset } from "../shared/analysis";
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

function inferenceTracks(): TrackDataset {
  return {
    schemaVersion: 1, id: "synthetic-contract-test", title: "Synthetic test, not a model prediction", kind: "tracks",
    provenance: {
      ...provenance, assembly: "GRCh38.p13", mode: "imported",
      artifact: { filename: "prediction.json", sha256: "ab".repeat(32) },
      inference: {
        variant: "chr9:128225994:G>A",
        inputInterval: { chromosome: "chr9", start: 127701706, end: 128750282, coordinateSystem: "0-based-half-open" },
        displayInterval: { chromosome: "chr9", start: 128225973, end: 128226014, coordinateSystem: "0-based-half-open" },
        modelRevision: "reported-research-revision", clientRevision: "reported-client-revision", checkpointRevision: "reported-checkpoint-revision",
        referenceVersion: "GRCh38.p13", referenceSha256: null, inputSequenceSha256: "cd".repeat(32),
        transformations: ['{"operation":"display_crop","start":128225973,"end":128226014}'],
      },
    },
    rows: [
      { chromosome: "chr9", position: 128225973, reference: 0, alternate: 1.25, track: "RNA_SEQ:0" },
      { chromosome: "chr9", position: 128225975, reference: 0.1, alternate: 0.2, track: "RNA_SEQ:0" },
    ],
    trackMetadata: [{
      chromosome: "chr9", track: "RNA_SEQ:0", sourceName: "Original RNA track", sourceIndex: 0,
      outputType: "RNA_SEQ", unit: null, strand: "+", biosampleId: "CL:0000679", biosampleName: "glutamatergic neuron", scope: "biosample_specific", binSize: 2,
    }],
  };
}

test("optional inference and track metadata round-trip in JSON while old datasets remain valid", () => {
  const dataset = inferenceTracks();
  assert.deepEqual(parseDatasetJSON(JSON.stringify(dataset)), dataset);
  assert.equal(dataset.provenance.mode, "imported");
  assert.equal(dataset.provenance.inference?.referenceSha256, null);
  assert.equal(analysisDatasetSchema.safeParse(scoreDataset()).success, true);
  assert.equal(parseTrackCSV(`${trackHeader}\nchr9,0,1,2,signal`, { assembly: "GRCh38" }).trackMetadata, undefined);
});

test("track metadata keys match rows and prevent duplicate or orphaned declarations", () => {
  const duplicate = inferenceTracks(); duplicate.trackMetadata!.push({ ...duplicate.trackMetadata![0] });
  assert.throws(() => parseDatasetJSON(JSON.stringify(duplicate)), /Duplicate metadata/);
  const orphan = inferenceTracks(); orphan.trackMetadata![0].track = "absent-track";
  assert.throws(() => parseDatasetJSON(JSON.stringify(orphan)), /no matching data rows/);
  const wrongChromosome = inferenceTracks(); wrongChromosome.trackMetadata![0].chromosome = "chr8";
  assert.throws(() => parseDatasetJSON(JSON.stringify(wrongChromosome)), /no matching data rows/);
  const unique = inferenceTracks();
  unique.rows.push({ ...unique.rows[0], track: "RNA_SEQ:1" });
  unique.trackMetadata!.push({ ...unique.trackMetadata![0], track: "RNA_SEQ:1", sourceIndex: 1, strand: "-" });
  assert.equal(analysisDatasetSchema.safeParse(unique).success, true);
});

test("bin validation keeps full bin extents, preserves gaps and rejects misalignment", () => {
  const gaps = inferenceTracks(); gaps.rows[1].position += 2;
  assert.equal(analysisDatasetSchema.safeParse(gaps).success, true);
  const misaligned = inferenceTracks(); misaligned.rows[1].position += 1;
  assert.throws(() => parseDatasetJSON(JSON.stringify(misaligned)), /aligned/);
  for (const invalid of [0, -1, 1.5]) {
    const dataset = inferenceTracks(); dataset.trackMetadata![0].binSize = invalid;
    assert.equal(analysisDatasetSchema.safeParse(dataset).success, false);
  }
  const croppedBin = inferenceTracks(); croppedBin.rows[1].position = 128226013;
  assert.throws(() => parseDatasetJSON(JSON.stringify(croppedBin)), /bin extends beyond.*display/);
  const chromEnd = inferenceTracks(); delete chromEnd.provenance.inference;
  chromEnd.rows = [{ ...chromEnd.rows[0], chromosome: "chrM", position: 16568 }];
  chromEnd.trackMetadata![0].chromosome = "chrM";
  assert.throws(() => parseDatasetJSON(JSON.stringify(chromEnd)), /bin extends beyond the chromosome/);
});

test("inference provenance validates exact variant and contained coordinate intervals", () => {
  const variantOutside = inferenceTracks(); variantOutside.provenance.inference!.variant = "chr3:58394738:A>T";
  assert.throws(() => parseDatasetJSON(JSON.stringify(variantOutside)), /exact variant/);
  const displayOutside = inferenceTracks(); displayOutside.provenance.inference!.displayInterval.start = 127701705;
  assert.throws(() => parseDatasetJSON(JSON.stringify(displayOutside)), /Display interval/);
  const invalidEnd = inferenceTracks(); invalidEnd.provenance.inference!.displayInterval.end = invalidEnd.provenance.inference!.displayInterval.start;
  assert.throws(() => parseDatasetJSON(JSON.stringify(invalidEnd)), /exclusive end/);
  const wrongChrom = inferenceTracks(); wrongChrom.provenance.inference!.displayInterval.chromosome = "chr8";
  assert.throws(() => parseDatasetJSON(JSON.stringify(wrongChrom)), /same chromosome/);
  const outsideRow = inferenceTracks(); outsideRow.rows[0].position = 128225972;
  assert.throws(() => parseDatasetJSON(JSON.stringify(outsideRow)), /outside the recorded display/);
  const mismatchedScore = scoreDataset(); mismatchedScore.provenance = inferenceTracks().provenance;
  assert.throws(() => parseDatasetJSON(JSON.stringify(mismatchedScore)), /Score row differs/);
});

test("source artifact and revision metadata reject missing or malformed evidence fields", () => {
  for (const filename of ["../prediction.json", "folder/prediction.json", "folder\\prediction.json", "..", ".", "bad\u0000name"]) {
    const dataset = inferenceTracks(); dataset.provenance.artifact!.filename = filename;
    assert.throws(() => parseDatasetJSON(JSON.stringify(dataset)), /basename/);
  }
  const invalidHash = inferenceTracks(); invalidHash.provenance.artifact!.sha256 = "not-a-hash";
  assert.throws(() => parseDatasetJSON(JSON.stringify(invalidHash)), /SHA-256/);
  const noRevision = inferenceTracks(); noRevision.provenance.inference!.modelRevision = "";
  assert.equal(analysisDatasetSchema.safeParse(noRevision).success, false);
  const invalidContextHash = inferenceTracks(); invalidContextHash.provenance.inference!.inputSequenceSha256 = "";
  assert.throws(() => parseDatasetJSON(JSON.stringify(invalidContextHash)), /SHA-256/);
  const fabricatedFlag = inferenceTracks();
  assert.throws(() => parseDatasetJSON(JSON.stringify({ ...fabricatedFlag, provenance: { ...fabricatedFlag.provenance, inference: { ...fabricatedFlag.provenance.inference, executionVerified: true } } })), /Unrecognized key/);
});

test("tissue-agnostic metadata cannot masquerade as a named-cell prediction", () => {
  const dataset = inferenceTracks(); dataset.trackMetadata![0].scope = "tissue_agnostic";
  assert.throws(() => parseDatasetJSON(JSON.stringify(dataset)), /must not be assigned a biosample/);
  dataset.trackMetadata![0].biosampleId = null; dataset.trackMetadata![0].biosampleName = null;
  assert.equal(analysisDatasetSchema.safeParse(dataset).success, true);
  dataset.trackMetadata![0].scope = "biosample_specific";
  assert.throws(() => parseDatasetJSON(JSON.stringify(dataset)), /require a biosample/);
});

test("unknown model strand remains null rather than becoming unstranded", () => {
  const dataset = inferenceTracks(); dataset.trackMetadata![0].strand = null;
  const parsed = parseDatasetJSON(JSON.stringify(dataset));
  assert.equal(parsed.kind === "tracks" && parsed.trackMetadata![0].strand, null);
});
