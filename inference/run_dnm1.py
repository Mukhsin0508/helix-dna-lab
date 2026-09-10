"""Run one local-checkpoint DNM1 REF/ALT prediction. No download or public server."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import sys
import time
from typing import TYPE_CHECKING

from track_export import (
    CONTEXT_BP, POSITION, JsonObject, crop_indices, metadata_records,
    select_biosample, track_payload, validate_reference,
)

if TYPE_CHECKING:
    from alphagenome.data.track_data import TrackData

RESEARCH_COMMIT = "0db53bd4352c66d1e00a049a81da373a066e6670"
HF_REVISION = "a8f293a76ee73d5b57f3bf2ae146510589fcf187"


def serialize_track(track: TrackData, crop_start: int, crop_end: int) -> JsonObject:
    """Copy only the requested coordinate window into a validated JSON payload."""
    import numpy as np

    interval = track.interval
    if interval is None or interval.chromosome != "chr9" or interval.strand == "-":
        raise ValueError("Expected a forward-coordinate chr9 prediction interval.")
    first, last = crop_indices(interval.start, interval.end, track.resolution,
                               len(track.values), crop_start, crop_end)
    records = metadata_records(track.metadata.to_json(orient="records"))
    values = np.asarray(track.values[first:last], dtype=np.float64).tolist()
    return track_payload(values, records, start=crop_start, end=crop_end,
                         resolution=track.resolution)


def predict(checkpoint: Path, fasta_path: Path, output_path: Path,
            biosample: str, crop_bp: int) -> None:
    """Validate local inputs, run the official full model, and write one result."""
    if output_path.exists():
        raise ValueError("Output exists; choose a new output path.")
    for name in ("_CHECKPOINT_METADATA", "_METADATA", "manifest.ocdbt"):
        if not (checkpoint / name).is_file():
            raise ValueError(f"Not an official Orbax checkpoint root: missing {name}.")
    if not fasta_path.is_file() or not Path(str(fasta_path) + ".fai").is_file():
        raise ValueError("Provide a local GRCh38 FASTA and its existing .fai index.")
    if not 64 <= crop_bp <= 32768 or crop_bp % 2:
        raise ValueError("--crop-bp must be an even integer from 64 through 32768.")

    # Runtime imports keep --help and pure validation tests free of model dependencies.
    import jax
    from alphagenome.data import genome
    from alphagenome.io import fasta
    from alphagenome_research.model import dna_model

    devices = [device for device in jax.devices() if device.platform == "gpu"]
    if not devices:
        raise ValueError("No JAX GPU device found; verify the Linux CUDA/JAX installation.")
    extractor = fasta.FastaExtractor(str(fasta_path))
    reference = validate_reference(extractor.extract(genome.Interval("chr9", POSITION - 21, POSITION + 20)))
    variant = genome.Variant("chr9", POSITION, "G", "A")
    interval = variant.reference_interval.resize(CONTEXT_BP)
    full_reference = extractor.extract(interval)
    if len(full_reference) != CONTEXT_BP or full_reference[variant.start - interval.start] != "G":
        raise ValueError("Full-context reference length or DNM1 reference allele is invalid.")

    # Preserve both species' checkpoint shapes. Only human sequence extraction is needed.
    settings = {
        dna_model.Organism.HOMO_SAPIENS: dna_model.OrganismSettings(fasta_path=str(fasta_path)),
        dna_model.Organism.MUS_MUSCULUS: dna_model.OrganismSettings(),
    }
    started = time.monotonic()
    model = dna_model.create(str(checkpoint), organism_settings=settings, device=devices[0])
    rna_metadata = model.output_metadata().rna_seq
    if rna_metadata is None:
        raise ValueError("The checkpoint provides no RNA-seq metadata.")
    curies = select_biosample(metadata_records(rna_metadata.to_json(orient="records")), biosample)
    result = model.predict_variant(
        interval=interval, variant=variant, ontology_terms=curies,
        requested_outputs=[dna_model.OutputType.RNA_SEQ],
    )
    if result.reference.rna_seq is None or result.alternate.rna_seq is None:
        raise ValueError("Model returned no REF/ALT RNA-seq result.")
    crop_start = variant.start - crop_bp // 2
    crop_end = crop_start + crop_bp
    reference_tracks = serialize_track(result.reference.rna_seq, crop_start, crop_end)
    alternate_tracks = serialize_track(result.alternate.rna_seq, crop_start, crop_end)
    if reference_tracks["metadata"] != alternate_tracks["metadata"]:
        raise ValueError("REF/ALT track metadata differ; do not compare mismatched tracks.")
    payload: JsonObject = {
        "schemaVersion": 1, "sourceKind": "model_inference", "provider": "alphagenome_research",
        "assembly": "GRCh38.p13", "variant": "chr9:128225994:G>A",
        "variantPositionConvention": "1-based", "biosample": biosample,
        "ontologyCuries": list(curies), "modality": "RNA_SEQ",
        "inputInterval": {"chromosome": "chr9", "start": interval.start, "end": interval.end},
        "reference": reference_tracks, "alternate": alternate_tracks,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "durationSeconds": round(time.monotonic() - started, 3),
        "provenance": {
            "checkpointSource": "https://huggingface.co/google/alphagenome-all-folds",
            "expectedCheckpointRevision": HF_REVISION,
            "expectedResearchCommit": RESEARCH_COMMIT,
            "revisionVerification": "Expected pins; operator must verify the local checkout and checkpoint origin.",
            "checkpointMetadataSha256": hashlib.sha256((checkpoint / "_METADATA").read_bytes()).hexdigest(),
            "referenceWindowSha256": hashlib.sha256(reference.encode()).hexdigest(),
            "inputSequenceSha256": hashlib.sha256(full_reference.encode()).hexdigest(),
            "referenceSource": "https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa",
            "researchPackageVersion": version("alphagenome_research"),
            "clientPackageVersion": version("alphagenome"), "jaxVersion": version("jax"),
            "gpu": devices[0].device_kind,
        },
        "limitations": [
            "New local model inference, not an Atlas AVI lookup or independent lab validation.",
            "RNA-seq values alone do not establish a 13-amino-acid extension or clinical outcome.",
            "No GTF, reference splice-site annotation, or calibration tables are used in this RNA-only smoke test.",
            "Cropping only; no normalization, invented signal, or confidence conversion.",
            "Any 3D animation remains illustrative, not measured molecular motion.",
        ],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("x", encoding="utf-8") as handle:
        json.dump(payload, handle, allow_nan=False, separators=(",", ":"))
        handle.write("\n")
    print(f"Wrote verified REF/ALT RNA track payload to {output_path}")


def main() -> int:
    """Parse local file arguments; return zero only after a real result is saved."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True, help="Previously authorized HF all-folds Orbax snapshot root")
    parser.add_argument("--fasta", type=Path, required=True, help="Local GRCh38.p13.genome.fa with .fai")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--biosample", default="glutamatergic neuron")
    parser.add_argument("--crop-bp", type=int, default=4096)
    args = parser.parse_args()
    try:
        predict(args.checkpoint.resolve(), args.fasta.resolve(), args.output.resolve(), args.biosample, args.crop_bp)
    except (ValueError, OSError, ImportError) as error:
        print(f"No result produced: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
