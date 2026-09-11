"""Extract the published Table S4 measurements from the verified Atlas PDF.

Run with a local copy of the official PDF; this script makes no network or model
requests. Requires pypdf. The source-page PNG is rendered separately with Poppler.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from pypdf import PdfReader

SOURCE_URL = (
    "https://storage.googleapis.com/deepmind-media/DeepMind.com/Blog/"
    "alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-"
    "in-the-human-genome/alphagenome-atlas.pdf"
)
SOURCE_SHA256 = "07011853872613cb7bd3ce8ca62cd2621ad50b0a16e6f5dec3e480b3d190af2c"
PAGE = 73
ROW = re.compile(
    r"(chr9:(\d+):([ACGT])>([ACGT]))\s+(\d+\.\d+)\s+"
    r"(\d+) bp\s+([A-Z\s]+?)\s+(\d+) AA\s+"
    r"(Prospective|\(\s*\d+(?:,\s*\d+)*\))"
)


def extract(pdf: Path, output: Path) -> None:
    """Write faithful table text, measured rows, CSV and provenance; return None."""
    digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        raise ValueError("PDF hash differs from the visually verified source version")
    reader = PdfReader(pdf)
    text = reader.pages[PAGE - 1].extract_text()
    rows: list[dict[str, str | int | float | None]] = []
    for ordinal, match in enumerate(ROW.finditer(text), start=1):
        variant, position, ref, alt, rate, bases, residues, amino_acids, status = match.groups()
        sequence = re.sub(r"\s+", "", residues)
        if len(sequence) != int(amino_acids) or int(bases) != 3 * int(amino_acids):
            raise ValueError(f"Source sequence/length inconsistency for {variant}")
        rows.append({
            "sourceRow": ordinal,
            "variant": variant,
            "assembly": "GRCh38",
            "chromosome": "chr9",
            "position1Based": int(position),
            "reference": ref,
            "alternate": alt,
            "gene": "DNM1",
            "alt3ssRate": float(rate),
            "alt3ssRateReportedText": rate,
            "measurementStatistic": "mean_of_condition_means",
            "retainedConditionCountReported": 5,
            "extraExonBp": int(bases),
            "addedAminoAcids": sequence,
            "extraAminoAcids": int(amino_acids),
            "statusReported": re.sub(r"\s+", " ", status).replace("( ", "("),
            "validReplicateCount": None,
            "perConditionReplicateCounts": None,
            "standardDeviation": None,
            "standardError": None,
            "prediction": None,
        })
    if len(rows) != 12 or len({row["variant"] for row in rows}) != 12:
        raise ValueError("Expected all 12 unique Table S4 rows")
    if rows[0]["variant"] != "chr9:128226027:G>A" or rows[0]["alt3ssRate"] != 0.94:
        raise ValueError("Requested-variant binding does not match the verified table")

    output.mkdir(parents=True, exist_ok=True)
    text_path = output / "dnm1-table-s4.source.txt"
    json_path = output / "dnm1-table-s4.measurements.json"
    csv_path = output / "dnm1-table-s4.measurements.csv"
    text_path.write_text(text, encoding="utf-8")
    dataset = {
        "schemaVersion": 1,
        "id": "dnm1-table-s4-measurements",
        "title": "DNM1 exon 10a: published Table S4 splicing measurements",
        "sourceKind": "experimental_measurement",
        "sourceUrl": SOURCE_URL,
        "sourceTable": "Table S4",
        "sourcePage": PAGE,
        "assembly": "GRCh38",
        "positionConvention": "1-based variant coordinates",
        "assay": "Minigene reporter splicing screen",
        "measurement": "Mean alternative 3-prime splice-site selection rate",
        "unit": "fraction",
        "range": [0, 1],
        "aggregation": "Average valid replicates within each retained condition, then average across five retained cell-line/promoter combinations.",
        "sourcePrecision": "Two decimal places as printed; trailing zero retained in alt3ssRateReportedText.",
        "replicates": {
            "plannedBiologicalReplicatesPerCondition": 3,
            "minimumValidReplicatesPerElement": 2,
            "retainedConditions": 5,
            "actualPerRowCountsAvailable": False,
            "replicateValuesAvailable": False,
            "uncertaintyAvailable": False,
        },
        "selection": "Twelve selected in-frame exon-extension variants; not the complete experimental screen or a representative variant sample.",
        "predictionsAvailable": False,
        "rows": rows,
    }
    json_path.write_text(json.dumps(dataset, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    csv_stream = io.StringIO(newline="")
    writer = csv.DictWriter(csv_stream, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    csv_path.write_text(csv_stream.getvalue(), encoding="utf-8")
    files = [text_path, json_path, csv_path]
    page_image = output / "dnm1-table-s4.source-page.png"
    if page_image.exists():
        files.append(page_image)
    provenance = {
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "sourceUrl": SOURCE_URL,
        "sourceSha256": digest,
        "sourceBytes": pdf.stat().st_size,
        "sourceTotalPages": len(reader.pages),
        "sourcePage1Based": PAGE,
        "sourceLaunchDate": "2026-09-08",
        "sourceLaunchUrl": "https://deepmind.google/blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/",
        "extraction": "pypdf text extraction; wrapped residue sequences concatenated; table rows visually compared with a Poppler-rendered page. No plotted values digitized or model outputs computed.",
        "coordinateBasis": "Paper uses hg38/GRCh38; exact chr:position:REF>ALT identifiers copied from Table S4. Reference alleles not independently re-fetched for this transcription.",
        "measurementBasis": "Table S4 p73, Figure 3D caption p9, and alternative-splicing quantification methods p44.",
        "measurementAggregation": "Each row is a published mean: valid biological replicates averaged within each retained condition, then condition means averaged across five retained cell-line/promoter combinations. This is not one pooled read-count fraction or a single-neuron measurement.",
        "replicateUncertainty": "Three biological replicates per condition were planned and at least two valid replicates per retained element were required. Actual per-row and per-condition n, replicate values and uncertainty are not reported in Table S4; null means unavailable, not zero.",
        "licenseStatus": "Source attribution retained. A dataset-specific license for this experimental table was not established; the separate static AVI artifact license is not assigned to these measurements.",
        "missing": ["Data S1 raw replicate values", "Per-row valid replicate counts", "Per-row uncertainty", "Matched numerical model predictions"],
        "files": {p.name: {"bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in files},
    }
    (output / "dnm1-table-s4.provenance.json").write_text(
        json.dumps(provenance, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Verified and extracted {len(rows)} measured Table S4 rows; zero predictions.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).parent)
    arguments = parser.parse_args()
    extract(arguments.pdf, arguments.output)
