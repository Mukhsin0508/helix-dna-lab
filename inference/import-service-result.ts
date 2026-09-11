import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYSIS_PAYLOAD_LIMIT } from "../shared/analysis.ts";
import { convertServiceResultToDataset, parseServiceResultJSON } from "../shared/model-result-import.ts";

const help = `Import an existing Helix AlphaGenome GPU service result into the analytical lab.

Usage:
  npx tsx inference/import-service-result.ts --input /path/first-prediction.json --output-dir /path/new-analysis

The output directory must not exist; its parent directory must already exist.
Accepts the raw PredictionResult shape for either independently verified
GRCh38 DNM1 variant: chr9:128225994:G>A or chr9:128226027:G>A.
All reference hashes and intervals must match the selected variant.
The original GPU attachment still needs coordinated request/model updates
before it can compute chr9:128226027:G>A. Changing its label is insufficient.
Standalone run_dnm1.py analytical outputs can be imported in the website directly.
No API request, GPU execution, credential access or upload occurs.
`;

export interface ServiceImportFiles {
  directory: string;
  analysisPath: string;
  sourcePath: string;
  sourceSha256: string;
  rowCount: number;
}

/** Validates first, creates a new bundle, and removes its directory if any write fails. */
export function importServiceResultFile(input: string, outputDirectory: string): ServiceImportFiles {
  const inputPath = resolve(input);
  const directory = resolve(outputDirectory);
  const info = statSync(inputPath);
  if (!info.isFile()) throw new Error("Input must be an existing JSON file.");
  if (info.size > ANALYSIS_PAYLOAD_LIMIT) throw new Error("Service result exceeds the 2 MB limit.");
  const bytes = readFileSync(inputPath);
  if (bytes.byteLength > ANALYSIS_PAYLOAD_LIMIT) throw new Error("Service result exceeds the 2 MB limit.");
  let sourceText: string;
  try { sourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Service result must be valid UTF-8 JSON."); }
  const result = parseServiceResultJSON(sourceText);
  const variant = `${result.variant.chromosome}:${result.variant.position}:${result.variant.reference}>${result.variant.alternate}`;
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const dataset = convertServiceResultToDataset(result, { filename: "source-result.json", sha256: sourceSha256 });
  const analysisText = JSON.stringify(dataset) + "\n";
  if (Buffer.byteLength(analysisText, "utf8") > ANALYSIS_PAYLOAD_LIMIT) throw new Error("Converted analysis exceeds the 2 MB limit; no rows were dropped.");
  const readme = `# Imported AlphaGenome result

Open analysis.json using the lab's JSON import. It contains ${dataset.rows.length} supplied signal bins for GRCh38 ${variant}.

- source-result.json is a byte-for-byte copy of the supplied raw service result.
- Its SHA-256 is ${sourceSha256} and is recorded in analysis.json.
- All values and per-track tissue scope, strand and units are preserved. No prediction, normalization, smoothing or new scoring was performed.
- Source-reported model/checkpoint revisions and reference context hashes are retained. Import validation does not independently verify that inference ran or that the reported checkpoint was loaded.
- The source reports a full 1,048,576-base context and a 41-base display crop. This bundle contains the supplied display crop, not full-length model arrays.
- The raw artifact retains original metadata, timings, checkpoint manifest hash and other source fields not displayed by the lab. Keep it with analysis.json; the lab does not upload this artifact automatically.
- The whole-reference FASTA SHA-256 was not supplied and remains null. The input context hash is recorded separately.
- JSON is the complete analytical export; a later CSV export alone will not retain the metadata or artifact reference.
- This converter accepts either verified DNM1 variant only when its own context, crop and reference match. It does not accept Atlas score exports or queued/completed job envelopes. The standalone runner's analytical output is already importable by the website and needs no conversion here.

This is imported model output, not independent experimental evidence or a clinical outcome estimate. No live GPU endpoint was connected by this import.
`;

  // mkdir without recursive=true fails atomically if any existing file/directory occupies the path.
  mkdirSync(directory, { mode: 0o700 });
  try {
    writeFileSync(join(directory, "source-result.json"), bytes, { flag: "wx", mode: 0o600 });
    writeFileSync(join(directory, "analysis.json"), analysisText, { flag: "wx", mode: 0o600 });
    writeFileSync(join(directory, "README.md"), readme, { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, analysisPath: join(directory, "analysis.json"), sourcePath: join(directory, "source-result.json"), sourceSha256, rowCount: dataset.rows.length };
}

export function runServiceImportCLI(args: readonly string[]): number {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) { process.stdout.write(help); return 0; }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if (!["--input", "--output-dir"].includes(name) || !value || value.startsWith("--") || options.has(name)) throw new Error("Use --input FILE --output-dir NEW_DIRECTORY, or --help.");
    options.set(name, value);
  }
  if (!options.has("--input") || !options.has("--output-dir")) throw new Error("Both --input and --output-dir are required. Use --help for details.");
  const files = importServiceResultFile(options.get("--input")!, options.get("--output-dir")!);
  process.stdout.write(`Imported ${files.rowCount} supplied bins. Analysis: ${files.analysisPath}\nSource SHA-256: ${files.sourceSha256}\nNo inference or upload was performed.\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runServiceImportCLI(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`Import failed: ${error instanceof Error ? error.message : "Unknown error"}\n`); process.exitCode = 1; }
}
