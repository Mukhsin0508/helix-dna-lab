"""Run an explicitly selected DNM1 case and export actual REF/ALT tracks or junctions."""

from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from importlib.metadata import distribution, PackageNotFoundError, version
import json
from pathlib import Path
import re
import sys
import time
from typing import TYPE_CHECKING

from track_export import (
    CONTEXT_BP, OUTPUT_TYPES, ROW_LIMIT, VARIANTS, JsonObject, VariantDescriptor,
    centered_window, crop_indices, encoded_json, load_descriptor, metadata_records,
    normalized_analysis, select_biosample, track_payload, validate_context,
)
from junction_export import (
    DEFAULT_JUNCTION_CROP_BP, JUNCTION_OUTPUT, SOURCE_FORMAT,
    normalized_junction_analysis, serialize_junctions,
)

if TYPE_CHECKING:
    from alphagenome.data.track_data import TrackData

RESEARCH_COMMIT = "0db53bd4352c66d1e00a049a81da373a066e6670"
HF_REVISION = "a8f293a76ee73d5b57f3bf2ae146510589fcf187"
SUPPORTED_OUTPUT_TYPES = (*OUTPUT_TYPES, JUNCTION_OUTPUT)
ANNOTATION_FILES = {
    "gtf": "gencode.v46.annotation.gtf.gz.feather",
    "spliceSiteStarts": "gencode.v46.splice_sites_starts.feather",
    "spliceSiteEnds": "gencode.v46.splice_sites_ends.feather",
}


def annotation_provenance(paths: dict[str, Path]) -> list[JsonObject]:
    """Require all explicit annotation inputs and hash their local bytes without claiming their origin."""
    if set(paths) != set(ANNOTATION_FILES):
        raise ValueError("GTF and both splice-site Feather annotations are required for this pinned variant path.")
    result: list[JsonObject] = []
    for kind, path in paths.items():
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Missing or empty {kind} annotation file.")
        with path.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        result.append({"kind": kind, "sha256": digest,
            "expectedSourceUrl": f"https://storage.googleapis.com/alphagenome/reference/gencode/hg38/{ANNOTATION_FILES[kind]}",
            "sourceVerification": "Local bytes hashed; their source is operator-supplied and not independently authenticated."})
    return result


def installed_revision(package: str) -> str:
    """Report installed package VCS metadata, or explicitly leave its revision unknown."""
    try:
        raw = distribution(package).read_text("direct_url.json")
        data = json.loads(raw) if raw else {}
        commit = data.get("vcs_info", {}).get("commit_id")
        return commit if isinstance(commit, str) and re.fullmatch("[a-fA-F0-9]{40}", commit) else "Not reported"
    except (PackageNotFoundError, ValueError, AttributeError):
        return "Not reported"


def serialize_track(track: TrackData, descriptor: VariantDescriptor,
                    crop_start: int, crop_end: int) -> JsonObject:
    """Check the actual full output and preserve its requested crop and original metadata."""
    import numpy as np

    interval = track.interval
    if interval is None or (interval.chromosome, interval.start, interval.end) != (descriptor.chromosome, descriptor.input_start, descriptor.input_end) or interval.strand == "-":
        raise ValueError("Model output does not match this variant's forward input interval.")
    if track.resolution != 1:
        raise ValueError("This export requires actual one-base RNA/splicing tracks.")
    records = metadata_records(track.metadata.to_json(orient="records"))
    full_values = np.asarray(track.values)
    if full_values.ndim != 2 or full_values.shape != (CONTEXT_BP, len(records)) or full_values.dtype.kind not in "fiu" or not np.isfinite(full_values).all():
        raise ValueError("Model output has invalid dimensions, numeric values or metadata alignment.")
    first, last = crop_indices(interval.start, interval.end, track.resolution,
                               len(full_values), crop_start, crop_end)
    values = full_values[first:last].astype(np.float64).tolist()
    return track_payload(values, records, start=crop_start, end=crop_end, resolution=1)


def selected_metadata(records_by_output: dict[str, list[JsonObject]], biosample: str,
                      crop_bp: int) -> tuple[list[str], int]:
    """Resolve a common exact tissue identifier and reject oversized requested exports early."""
    tissue_sets = [set(select_biosample(records, biosample)) for output, records in records_by_output.items() if output != "SPLICE_SITES"]
    common = set.intersection(*tissue_sets) if tissue_sets else set()
    if tissue_sets and not common:
        raise ValueError("The requested RNA/usage outputs do not share this exact biosample.")
    count = 0
    for output, records in records_by_output.items():
        selected = [record for record in records if str(record.get("name", "")).lower() != "padding" and (
            output == "SPLICE_SITES" or (record.get("ontology_curie") in common and str(record.get("biosample_name", "")).casefold() == biosample.casefold()))]
        if not selected:
            raise ValueError(f"No biological {output} tracks are available for the requested selection.")
        count += len(selected)
    junction_mode = JUNCTION_OUTPUT in records_by_output
    if junction_mode and len(records_by_output) != 1:
        raise ValueError("SPLICE_JUNCTIONS is exclusive; do not mix junction and positional outputs.")
    if not junction_mode and count * crop_bp > ROW_LIMIT:
        raise ValueError(f"Requested crop would contain {count * crop_bp} rows; choose a smaller --crop-bp (maximum {ROW_LIMIT // count} for {count} tracks).")
    return sorted(common), count


def validate_output_names(requested_outputs: tuple[str, ...]) -> None:
    """Require unique supported metadata names without imposing a prediction mode."""
    if not requested_outputs or len(set(requested_outputs)) != len(requested_outputs) or any(name not in SUPPORTED_OUTPUT_TYPES for name in requested_outputs):
        raise ValueError("Choose unique supported RNA/splicing output types.")


def validate_output_selection(requested_outputs: tuple[str, ...], crop_bp: int) -> bool:
    """Validate exclusive junction mode; return whether row limits apply to arcs instead of bases."""
    validate_output_names(requested_outputs)
    junction_mode = JUNCTION_OUTPUT in requested_outputs
    if junction_mode and requested_outputs != (JUNCTION_OUTPUT,):
        raise ValueError("SPLICE_JUNCTIONS is exclusive; do not mix junction and positional outputs.")
    maximum = CONTEXT_BP if junction_mode else ROW_LIMIT
    if type(crop_bp) is not int or not 1 <= crop_bp <= maximum:
        raise ValueError(f"--crop-bp must be an integer from 1 through {maximum} for the requested output mode.")
    return junction_mode


def write_result_files(source: JsonObject, descriptor: VariantDescriptor,
                       output_path: Path) -> tuple[Path, int]:
    """Write an importable analysis and the exact raw result exclusively; clean up partial writes."""
    source_path = output_path.with_name(f"{output_path.stem}.source-result.json")
    if source_path == output_path or output_path.exists() or source_path.exists():
        raise ValueError("Analysis or raw result already exists; choose a new --output path.")
    if not output_path.parent.is_dir():
        raise ValueError("The output parent directory must already exist.")
    source_bytes = encoded_json(source)
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    outputs = source.get("outputs")
    junction_mode = isinstance(outputs, list) and any(isinstance(output, dict) and output.get("outputType") == JUNCTION_OUTPUT for output in outputs)
    normalize = normalized_junction_analysis if junction_mode else normalized_analysis
    analysis = normalize(source, descriptor, source_path.name, source_hash)
    analysis_bytes = encoded_json(analysis)
    created: list[Path] = []
    try:
        for path, content in ((source_path, source_bytes), (output_path, analysis_bytes)):
            with path.open("xb") as handle:
                created.append(path)
                handle.write(content)
            path.chmod(0o600)
    except BaseException:
        for path in reversed(created):
            path.unlink(missing_ok=True)
        raise
    return source_path, len(analysis["rows"])


class ModelRunner:
    """Load one real GPU model and serve independently validated requests; callers serialize GPU use."""

    def __init__(self, checkpoint: Path, fasta_path: Path, *, gtf: Path,
                 splice_site_starts: Path, splice_site_ends: Path) -> None:
        """Validate static inputs and load the actual checkpoint exactly once for this runner."""
        for name in ("_CHECKPOINT_METADATA", "_METADATA", "manifest.ocdbt"):
            if not (checkpoint / name).is_file():
                raise ValueError(f"Checkpoint directory is missing {name}.")
        if not fasta_path.is_file() or not Path(str(fasta_path) + ".fai").is_file():
            raise ValueError("Provide a local GRCh38.p13 FASTA and its existing .fai index.")
        annotations = annotation_provenance({"gtf": gtf, "spliceSiteStarts": splice_site_starts, "spliceSiteEnds": splice_site_ends})

        # Runtime imports keep help and pure export validation independent of model dependencies.
        import jax
        from alphagenome.data import genome
        from alphagenome.io import fasta
        from alphagenome_research.model import dna_model

        devices = [device for device in jax.devices() if device.platform == "gpu"]
        if not devices:
            raise ValueError("No JAX GPU device found; verify the Linux CUDA/JAX installation.")
        self.device = devices[0]
        self._genome = genome
        self._output_type = dna_model.OutputType
        self.extractor = fasta.FastaExtractor(str(fasta_path))
        # Retain both species' metadata to validate the actual checkpoint's complete parameter shapes.
        settings = {
            dna_model.Organism.HOMO_SAPIENS: dna_model.OrganismSettings(
                fasta_path=str(fasta_path), gtf_feather_path=str(gtf),
                splice_site_starts_feather_path=str(splice_site_starts), splice_site_ends_feather_path=str(splice_site_ends)),
            dna_model.Organism.MUS_MUSCULUS: dna_model.OrganismSettings(),
        }
        self.provenance: JsonObject = {
            "checkpointSource": "https://huggingface.co/google/alphagenome-all-folds",
            "expectedCheckpointRevision": HF_REVISION, "expectedResearchCommit": RESEARCH_COMMIT,
            "researchRevision": installed_revision("alphagenome_research"), "clientRevision": installed_revision("alphagenome"),
            "revisionVerification": "Installed package direct-url metadata only. Expected pins and checkpoint origin are not verified by this runner.",
            "checkpointMetadataSha256": hashlib.sha256((checkpoint / "_METADATA").read_bytes()).hexdigest(),
            "checkpointManifestFileSha256": hashlib.sha256((checkpoint / "manifest.ocdbt").read_bytes()).hexdigest(),
            "referenceIndexSha256": hashlib.sha256(Path(str(fasta_path) + ".fai").read_bytes()).hexdigest(),
            "annotations": annotations, "gpu": self.device.device_kind,
        }
        for field, package in (("researchPackageVersion", "alphagenome_research"), ("clientPackageVersion", "alphagenome"), ("jaxVersion", "jax")):
            try:
                self.provenance[field] = version(package)
            except PackageNotFoundError:
                self.provenance[field] = "Not reported"
        started = time.monotonic()
        self.model = dna_model.create(str(checkpoint), organism_settings=settings, device=self.device)
        self.model_load_seconds = time.monotonic() - started

    def output_metadata_records(self, requested_outputs: tuple[str, ...]) -> dict[str, list[JsonObject]]:
        """Return the loaded model's original metadata for explicit supported output types."""
        validate_output_names(requested_outputs)
        records: dict[str, list[JsonObject]] = {}
        loaded_metadata = self.model.output_metadata()
        for name in requested_outputs:
            frame = loaded_metadata.get(self._output_type[name])
            if frame is None:
                raise ValueError(f"The loaded model provides no {name} metadata.")
            records[name] = metadata_records(frame.to_json(orient="records"))
        return records

    def predict(self, biosample: str, crop_bp: int, variant_id: str,
                requested_outputs: tuple[str, ...] = OUTPUT_TYPES) -> JsonObject:
        """Validate this request's exact reference, run the loaded model, and return its raw export."""
        started = time.monotonic()
        descriptor = load_descriptor(variant_id)
        if not isinstance(biosample, str) or not biosample.strip() or len(biosample) > 200:
            raise ValueError("Provide an exact biosample name of 1–200 characters.")
        junction_mode = validate_output_selection(requested_outputs, crop_bp)
        # Variant and all intervals are local to this request. No variant or result is cached.
        variant = self._genome.Variant(chromosome=descriptor.chromosome, position=descriptor.position,
                                      reference_bases=descriptor.reference, alternate_bases=descriptor.alternate)
        interval = variant.reference_interval.resize(CONTEXT_BP)
        display = variant.reference_interval.resize(41)
        if (interval.start, interval.end, display.start, display.end) != (descriptor.input_start, descriptor.input_end, descriptor.display_start, descriptor.display_end):
            raise ValueError("Installed genome interval classes disagree with the selected verified descriptor.")
        full_reference = self.extractor.extract(interval)
        reference = self.extractor.extract(display)
        validate_context(descriptor, full_reference, reference)
        crop = variant.reference_interval.resize(crop_bp)
        if (crop.start, crop.end) != centered_window(descriptor.position, crop_bp):
            raise ValueError("Installed genome classes use an unexpected display crop convention.")
        records_by_output = self.output_metadata_records(requested_outputs)
        curies, _ = selected_metadata(records_by_output, biosample, crop_bp)
        result = self.model.predict_variant(interval=interval, variant=variant,
            ontology_terms=curies or None,
            requested_outputs=[self._output_type[name] for name in requested_outputs])
        outputs: list[JsonObject] = []
        for name in requested_outputs:
            output_type = self._output_type[name]
            ref, alt = result.reference.get(output_type), result.alternate.get(output_type)
            if ref is None or alt is None:
                raise ValueError(f"The model returned no REF/ALT {name} result.")
            serialize = serialize_junctions if junction_mode else serialize_track
            reference_tracks = serialize(ref, descriptor, crop.start, crop.end)
            alternate_tracks = serialize(alt, descriptor, crop.start, crop.end)
            if not junction_mode and reference_tracks["metadata"] != alternate_tracks["metadata"]:
                raise ValueError("REF/ALT track metadata differ; do not compare mismatched tracks.")
            outputs.append({"outputType": name, "reference": reference_tracks, "alternate": alternate_tracks})
        payload: JsonObject = {
            "schemaVersion": 2, "sourceKind": "model_inference", "provider": "alphagenome_research",
            "assembly": descriptor.reference_version, "variant": descriptor.id,
            "outputRepresentation": "junctions" if junction_mode else "positional_tracks",
            "variantPositionConvention": "1-based", "biosample": biosample, "ontologyCuries": curies,
            "inputInterval": {"chromosome": descriptor.chromosome, "start": interval.start, "end": interval.end, "coordinateSystem": "0-based-half-open"},
            "outputInterval": {"chromosome": descriptor.chromosome, "start": crop.start, "end": crop.end, "coordinateSystem": "0-based-half-open"},
            "outputs": outputs, "verifiedReferenceExcerpt": reference,
            "verifiedReferenceInterval": {"chromosome": descriptor.chromosome, "start": display.start, "end": display.end, "coordinateSystem": "0-based-half-open"},
            "createdAt": datetime.now(timezone.utc).isoformat(), "durationSeconds": time.monotonic() - started,
            "modelLoadSeconds": self.model_load_seconds,
            "timingMeaning": "durationSeconds covers this request's reference validation, metadata selection, inference and serialization; modelLoadSeconds records the separate one-time model load.",
            "provenance": {
                **deepcopy(self.provenance),
                "referenceWindowSha256": hashlib.sha256(reference.encode()).hexdigest(),
                "inputSequenceSha256": hashlib.sha256(full_reference.encode()).hexdigest(),
                "referenceSource": descriptor.reference_url,
            },
            "limitations": [
                "Local molecular model inference, not Atlas AVI or independent experimental evidence.",
                "Junction tracks retain the actual selected biosample metadata." if junction_mode else "Splice sites are tissue agnostic; RNA-seq and splice-site usage retain their actual biosample metadata.",
                "No AVI score is exported." if junction_mode else "No splice-junction or AVI score is exported.",
                "Explicit GENCODE GTF and splice-site annotation files were supplied for the pinned model path; their source identity remains operator-supplied. No PAS or calibration file was used.",
                "All junctions overlapping the explicit display are exported with unclipped endpoints; absence in one returned allele is null, not zero. No value threshold or normalization was added." if junction_mode else "Only the explicit display crop is exported. Full-context inference preceded cropping; no normalization, smoothing or outcome probability was added.",
            ],
        }
        if junction_mode:
            payload["junctionSourceFormat"] = SOURCE_FORMAT
        encoded_json(payload)
        return payload


def predict(checkpoint: Path, fasta_path: Path, output_path: Path,
            biosample: str, crop_bp: int, variant_id: str,
            requested_outputs: tuple[str, ...] = OUTPUT_TYPES, *,
            gtf: Path, splice_site_starts: Path, splice_site_ends: Path) -> None:
    """Run one explicit request and save its analysis plus raw result without overwriting files."""
    descriptor = load_descriptor(variant_id)
    source_path = output_path.with_name(f"{output_path.stem}.source-result.json")
    if output_path.exists() or source_path.exists() or not output_path.parent.is_dir():
        raise ValueError("Use a new output filename inside an existing directory.")
    if not isinstance(biosample, str) or not biosample.strip() or len(biosample) > 200:
        raise ValueError("Provide an exact biosample name of 1–200 characters.")
    junction_mode = validate_output_selection(requested_outputs, crop_bp)
    runner = ModelRunner(checkpoint, fasta_path, gtf=gtf,
                         splice_site_starts=splice_site_starts, splice_site_ends=splice_site_ends)
    payload = runner.predict(biosample, crop_bp, variant_id, requested_outputs)
    raw_path, row_count = write_result_files(payload, descriptor, output_path)
    row_kind = "junction/track rows" if junction_mode else "REF/ALT bins"
    print(f"Saved {row_count} supplied {row_kind} for {descriptor.id}: {output_path}\nOriginal result: {raw_path}")


def main() -> int:
    """Parse explicit inputs; return zero only after a real result and analytical export are saved."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=VARIANTS, required=True, help="Exact one-based GRCh38 variant; the cases are never substituted")
    parser.add_argument("--checkpoint", type=Path, required=True, help="Previously authorized local all-folds Orbax snapshot root")
    parser.add_argument("--fasta", type=Path, required=True, help="Local GRCh38.p13.genome.fa with .fai")
    parser.add_argument("--gtf", type=Path, required=True, help="Local GENCODE v46 annotation.gtf.gz.feather")
    parser.add_argument("--splice-site-starts", type=Path, required=True, help="Local GENCODE v46 splice_sites_starts.feather")
    parser.add_argument("--splice-site-ends", type=Path, required=True, help="Local GENCODE v46 splice_sites_ends.feather")
    parser.add_argument("--output", type=Path, required=True, help="New analysis JSON path; an adjacent raw result is retained")
    parser.add_argument("--biosample", default="glutamatergic neuron")
    parser.add_argument("--crop-bp", type=int, default=None, help="Centered display width: default 41 for positional tracks, 32768 for junctions; full inference remains 1,048,576 bp. Junction endpoints are never clipped.")
    parser.add_argument("--outputs", nargs="+", choices=SUPPORTED_OUTPUT_TYPES, default=list(OUTPUT_TYPES), help="Default: RNA_SEQ SPLICE_SITES SPLICE_SITE_USAGE. SPLICE_JUNCTIONS must be requested alone.")
    args = parser.parse_args()
    try:
        crop_bp = args.crop_bp if args.crop_bp is not None else (DEFAULT_JUNCTION_CROP_BP if args.outputs == [JUNCTION_OUTPUT] else 41)
        predict(args.checkpoint.resolve(), args.fasta.resolve(), args.output.resolve(),
                args.biosample, crop_bp, args.variant, tuple(args.outputs),
                gtf=args.gtf.resolve(), splice_site_starts=args.splice_site_starts.resolve(), splice_site_ends=args.splice_site_ends.resolve())
    except (ValueError, OSError, ImportError, KeyError) as error:
        print(f"No result produced: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
