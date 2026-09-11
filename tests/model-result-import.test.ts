import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseDatasetJSON } from "../shared/analysis-import";
import { convertServiceResultToDataset, parseServiceResultJSON, SERVICE_REFERENCE, type ServicePredictionResult } from "../shared/model-result-import";
import { importServiceResultFile } from "../inference/import-service-result";

/** Synthetic numbers test conversion only. They are not recorded scientific predictions. */
function syntheticResult(): ServicePredictionResult {
  const interval = { chromosome: "chr9" as const, start: 127701706, end: 128750282, coordinateSystem: "0-based-half-open" as const, strand: "." as const };
  const display = { ...interval, start: 128225973 as const, end: 128226014 as const };
  const values = Array.from({ length: 41 }, (_, index) => index === 20 ? 0.12345678901234568 : index / 100);
  return {
    sourceKind: "model_inference", variant: { assembly: "GRCh38", chromosome: "chr9", position: 128225994, reference: "G", alternate: "A" },
    biosampleId: "CL:0000679", biosampleLabel: "glutamatergic neuron", model: "google/alphagenome-all-folds",
    modelRevision: "a".repeat(40), checkpointRevision: "b".repeat(40), clientRevision: "c".repeat(40), checkpointManifestSha256: "d".repeat(64),
    referenceGenome: {
      referenceUrl: "https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa",
      indexUrl: "https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa.fai",
      referenceHeaders: { syntheticFixture: true },
      indexSha256: "9293fb33f63b7f09d8fadc055d78e401d07c76de0211243fba778780ff836ff9",
      assembly: "GRCh38", referenceVersion: "GRCh38.p13", contextSha256: "dbadd0681da906be525c770f4904923dc26a79de515984431d49c057e676e08c",
      contextBases: 1048576, contextRevalidatedAt: "2026-09-11T00:00:00+00:00",
    },
    inputInterval: interval, fullOutputInterval: { ...interval }, outputInterval: display, displayReference: SERVICE_REFERENCE,
    generatedAt: "2026-09-11T00:00:01+00:00", predictionSeconds: 0,
    transformations: [{ operation: "display_crop", afterFullContextInference: true, start: display.start, end: display.end }],
    postprocessing: { normalization: "none_added", aggregation: "none", resolutionBases: 1, note: "Synthetic contract fixture only." },
    annotationSettings: { geneMasks: false, spliceJunctionAnnotations: false, variantCalibration: false },
    tracks: [
      { outputType: "RNA_SEQ", name: "same name", biosampleId: "CL:0000679", biosampleScope: "biosample_specific", strand: "+", unit: null, chromosome: "chr9", start: display.start, binSizeBases: 1, reference: values, alternate: values.map(value => value * 2), originalMetadata: { name: "same name", strand: "+", ontology_curie: "CL:0000679", biosample_name: "glutamatergic neuron", extraProvenance: { testOnly: true } } },
      { outputType: "RNA_SEQ", name: "same name", biosampleId: "CL:0000679", biosampleScope: "biosample_specific", strand: "-", unit: null, chromosome: "chr9", start: display.start, binSizeBases: 1, reference: values.map(value => -value), alternate: [...values], originalMetadata: { name: "same name", strand: "-", ontology_curie: "CL:0000679", biosample_name: "glutamatergic neuron" } },
      { outputType: "SPLICE_SITES", name: "donor", biosampleId: null, biosampleScope: "tissue_agnostic", strand: null, unit: null, chromosome: "chr9", start: display.start, binSizeBases: 1, reference: [...values], alternate: [...values], originalMetadata: { name: "donor", strand: null } },
    ],
    testOnlySyntheticData: true,
  };
}

const artifact = { filename: "source-result.json", sha256: "e".repeat(64) };

test("converts all supplied bins exactly and keeps same-name strands distinct", () => {
  const result = syntheticResult();
  const dataset = convertServiceResultToDataset(result, artifact);
  assert.equal(dataset.rows.length, 123);
  assert.equal(new Set(dataset.trackMetadata!.map(track => track.track)).size, 3);
  result.tracks.forEach((track, trackIndex) => {
    const key = dataset.trackMetadata![trackIndex].track;
    const rows = dataset.rows.filter(row => row.track === key);
    assert.deepEqual(rows.map(row => row.reference), track.reference);
    assert.deepEqual(rows.map(row => row.alternate), track.alternate);
    assert.deepEqual(rows.map(row => row.position), Array.from({ length: 41 }, (_, index) => 128225973 + index));
    assert.equal(dataset.trackMetadata![trackIndex].sourceName, track.name);
    assert.equal(dataset.trackMetadata![trackIndex].sourceIndex, trackIndex);
  });
  assert.equal(dataset.rows[20].reference, 0.12345678901234568);
  assert.equal(dataset.trackMetadata![2].strand, null);
  assert.equal(dataset.trackMetadata![2].unit, null);
  assert.equal(dataset.trackMetadata![2].biosampleName, null);
  assert.equal(dataset.trackMetadata![2].scope, "tissue_agnostic");
});

test("records source-reported provenance without inventing whole-genome verification", () => {
  const source = syntheticResult();
  const dataset = convertServiceResultToDataset(source, artifact);
  assert.equal(dataset.provenance.mode, "imported");
  assert.deepEqual(dataset.provenance.artifact, artifact);
  assert.equal(dataset.provenance.inference?.referenceSha256, null);
  assert.equal(dataset.provenance.inference?.inputSequenceSha256, source.referenceGenome.contextSha256);
  assert.equal(dataset.provenance.inference?.modelRevision, source.modelRevision);
  assert.deepEqual(dataset.provenance.inference?.transformations, source.transformations.map(value => JSON.stringify(value)));
  assert.equal(dataset.provenance.inference?.variant, "chr9:128225994:G>A");
  assert.equal(dataset.provenance.assembly, "GRCh38.p13");
});

test("rejects missing results, job envelopes, standalone outputs and the other DNM1 variant", () => {
  for (const raw of [{ status: "queued" }, { status: "completed", result: syntheticResult() }, { sourceKind: "model_inference", reference: {}, alternate: {} }]) {
    assert.throws(() => parseServiceResultJSON(JSON.stringify(raw)));
  }
  const wrongVariant = syntheticResult() as unknown as { variant: { position: number } }; wrongVariant.variant.position = 128226027;
  assert.throws(() => convertServiceResultToDataset(wrongVariant, artifact), /variant.position/);
});

test("rejects changed reference, context, display crop and allele orientation", () => {
  const cases: Array<(result: ServicePredictionResult) => void> = [
    result => { result.displayReference = `A${SERVICE_REFERENCE.slice(1)}` as typeof SERVICE_REFERENCE; },
    result => { result.inputInterval.start += 1; },
    result => { result.fullOutputInterval.end -= 1; },
    result => { result.outputInterval.end -= 1; },
    result => { (result.referenceGenome as unknown as { contextBases: number }).contextBases = 41; },
    result => { (result.referenceGenome as unknown as { contextSha256: string }).contextSha256 = "f".repeat(64); },
    result => { (result.variant as unknown as { reference: string }).reference = "A"; },
  ];
  for (const mutate of cases) { const result = syntheticResult(); mutate(result); assert.throws(() => convertServiceResultToDataset(result, artifact)); }
});

test("rejects non-finite values, booleans, mismatched shapes and incorrect bin starts", () => {
  for (const invalid of [Number.NaN, Infinity, -Infinity, true, null, "0.1"]) {
    const source = syntheticResult(); (source.tracks[0].reference as unknown[])[0] = invalid;
    assert.throws(() => convertServiceResultToDataset(source, artifact), /tracks.0.reference.0/);
  }
  const shape = syntheticResult(); shape.tracks[0].alternate.pop();
  assert.throws(() => convertServiceResultToDataset(shape, artifact), /alternate/);
  const start = syntheticResult(); (start.tracks[0] as unknown as { start: number }).start += 1;
  assert.throws(() => convertServiceResultToDataset(start, artifact), /start/);
  assert.throws(() => parseServiceResultJSON(JSON.stringify(syntheticResult()).replace('"predictionSeconds":0', '"predictionSeconds":1e999')), /predictionSeconds/);
});

test("rejects mismatched tissue scope and inconsistent original metadata", () => {
  const cases: Array<(result: ServicePredictionResult) => void> = [
    result => { result.tracks[2].biosampleScope = "biosample_specific"; },
    result => { result.tracks[2].biosampleId = "CL:0000679"; },
    result => { result.tracks[0].biosampleId = "CL:0000084"; },
    result => { result.tracks[0].originalMetadata.biosample_name = "T-cell"; },
    result => { result.tracks[0].originalMetadata.ontology_curie = "CL:0000084"; },
    result => { result.tracks[0].originalMetadata.strand = "-"; },
    result => { result.tracks[0].unit = "invented units"; },
    result => { result.tracks[0].name = "renamed"; },
    result => { result.tracks[2].name = "Padding"; result.tracks[2].originalMetadata.name = "Padding"; },
  ];
  for (const mutate of cases) { const result = syntheticResult(); mutate(result); assert.throws(() => convertServiceResultToDataset(result, artifact)); }
});

test("rejects extra transformations instead of silently interpreting altered signals", () => {
  const source = syntheticResult();
  source.transformations.push({ operation: "display_crop", afterFullContextInference: true, start: 128225973, end: 128226014 });
  assert.throws(() => convertServiceResultToDataset(source, artifact), /transformations/);
  const normalization = syntheticResult(); (normalization.postprocessing as unknown as { normalization: string }).normalization = "scaled";
  assert.throws(() => convertServiceResultToDataset(normalization, artifact), /normalization/);
});

test("enforces raw byte, converted byte and complete row limits without truncation", () => {
  const tooMany = syntheticResult(); tooMany.tracks = Array.from({ length: 122 }, () => ({ ...tooMany.tracks[0] }));
  assert.throws(() => convertServiceResultToDataset(tooMany, artifact), /5000 analytical rows/);
  const source = syntheticResult(); source.largeUnusedMetadata = "x".repeat(2 * 1024 * 1024);
  assert.throws(() => parseServiceResultJSON(JSON.stringify(source)), /2 MB/);
  assert.throws(() => convertServiceResultToDataset(source, artifact), /Service result exceeds the 2 MB/);
  const expanded = syntheticResult(); expanded.tracks = Array.from({ length: 121 }, () => {
    const track = { ...expanded.tracks[0], name: "x".repeat(380), originalMetadata: { ...expanded.tracks[0].originalMetadata, name: "x".repeat(380) } };
    return track;
  });
  assert.throws(() => convertServiceResultToDataset(expanded, artifact), /Converted analysis exceeds the 2 MB/);
});

test("CLI bundle retains original bytes, computes the matching SHA and imports into current schema", () => {
  const temp = mkdtempSync(join(tmpdir(), "helix-import-"));
  try {
    const input = join(temp, "original.json"); const output = join(temp, "bundle");
    const bytes = Buffer.from(`\uFEFF${JSON.stringify(syntheticResult(), null, 2)}\r\n`, "utf8");
    writeFileSync(input, bytes);
    const files = importServiceResultFile(input, output);
    assert.deepEqual(readFileSync(files.sourcePath), bytes);
    assert.equal(files.sourceSha256, createHash("sha256").update(bytes).digest("hex"));
    const dataset = parseDatasetJSON(readFileSync(files.analysisPath, "utf8"));
    assert.equal(dataset.kind, "tracks");
    assert.equal(dataset.rows.length, 123);
    assert.equal(dataset.provenance.artifact!.sha256, files.sourceSha256);
    assert.match(readFileSync(join(output, "README.md"), "utf8"), /does not independently verify/);
    assert.equal(JSON.parse(readFileSync(input, "utf8").replace(/^\uFEFF/, "")).testOnlySyntheticData, true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("invalid input creates no directory and existing output is never overwritten", () => {
  const temp = mkdtempSync(join(tmpdir(), "helix-import-"));
  try {
    const input = join(temp, "input.json"); const output = join(temp, "bundle");
    writeFileSync(input, '{"status":"queued"}');
    assert.throws(() => importServiceResultFile(input, output));
    assert.equal(existsSync(output), false);
    writeFileSync(input, JSON.stringify(syntheticResult())); mkdirSync(output); writeFileSync(join(output, "keep.txt"), "keep");
    assert.throws(() => importServiceResultFile(input, output), /EEXIST/);
    assert.equal(readFileSync(join(output, "keep.txt"), "utf8"), "keep");
    assert.equal(existsSync(join(output, "analysis.json")), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("a partial filesystem failure removes only the newly created bundle", t => {
  const temp = mkdtempSync(join(tmpdir(), "helix-import-"));
  const input = join(temp, "input.json"); const output = join(temp, "bundle");
  writeFileSync(input, JSON.stringify(syntheticResult()));
  const originalWrite = fs.writeFileSync;
  const mocked = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).endsWith("analysis.json")) throw new Error("Synthetic disk failure");
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => importServiceResultFile(input, output), /Synthetic disk failure/);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(input), true);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); rmSync(temp, { recursive: true, force: true }); }
});

test("CLI help does not require input, and malformed arguments fail without writes", () => {
  const cli = new URL("../inference/import-service-result.ts", import.meta.url).pathname;
  const help = spawnSync(process.execPath, ["--import", "tsx", cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /No API request, GPU execution/);
  const invalid = spawnSync(process.execPath, ["--import", "tsx", cli, "--input", "missing.json"], { encoding: "utf8" });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Both --input and --output-dir/);
});
