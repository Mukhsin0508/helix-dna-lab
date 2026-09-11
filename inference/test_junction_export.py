"""Synthetic junction QA only: no experimental data, checkpoint or GPU inference."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from junction_export import (
    DEFAULT_JUNCTION_CROP_BP, JUNCTION_OUTPUT, SOURCE_FORMAT, junction_payload,
    normalized_junction_analysis, serialize_junctions,
)
from run_dnm1 import main, selected_metadata, validate_output_selection, write_result_files
from track_export import CONTEXT_BP, OUTPUT_TYPES, VARIANTS, centered_window, encoded_json, load_descriptor

ROOT = Path(__file__).resolve().parents[1]
NOTICE = "SYNTHETIC QA ONLY; NOT A MODEL PREDICTION"


def synthetic_source(variant_id: str = VARIANTS[1]) -> dict:
    """Use real coordinate descriptors with clearly synthetic matrices and metadata."""
    descriptor = load_descriptor(variant_id)
    start, end = centered_window(descriptor.position, DEFAULT_JUNCTION_CROP_BP)
    position = descriptor.position - 1
    def junction(left, right, strand):
        return {"chromosome": "chr9", "start": left, "end": right, "strand": strand,
            "name": "SYNTHETIC", "info": {"fixture": NOTICE}, "k": None}
    shared = junction(position - 10, position + 200, "-")
    spanning = junction(start - 500, end + 500, "+")
    ref_only = junction(position - 30, position + 100, "+")
    alt_only = junction(position - 50, position + 75, "+")
    metadata = [{"name": f"SYNTHETIC track {name}", "strand": None, "unit": None,
        "ontology_curie": "CL:TEST", "biosample_name": "Synthetic test cells",
        "extra_metadata": {"preserve": [True, 17, None]}} for name in ("A", "B")]
    ref = junction_payload([spanning, shared, ref_only],
        [[0.12345678901234568, 0.0], [2.5, 8.5], [1e-9, 6.5]], metadata,
        descriptor, start, end, source_indices=[1, 3, 7], returned_count=10, uns={"notice": NOTICE}, value_dtype="float64")
    # Allele row and metadata column orders deliberately differ.
    alt = junction_payload([alt_only, shared, spanning],
        [[3.5, 4.5], [18.5, 12.5], [0.0, 0.23456789012345678]], list(reversed(metadata)),
        descriptor, start, end, source_indices=[0, 2, 9], returned_count=12, uns={"notice": NOTICE}, value_dtype="float64")
    return {"sourceKind": "model_inference", "variant": variant_id, "fixtureNotice": NOTICE,
        "biosample": "Synthetic test cells", "ontologyCuries": ["CL:TEST"],
        "inputInterval": {"chromosome": "chr9", "start": descriptor.input_start, "end": descriptor.input_end, "coordinateSystem": "0-based-half-open"},
        "outputInterval": {"chromosome": "chr9", "start": start, "end": end, "coordinateSystem": "0-based-half-open"},
        "outputs": [{"outputType": JUNCTION_OUTPUT, "reference": ref, "alternate": alt}],
        "createdAt": "2026-09-11T00:00:00+00:00", "junctionSourceFormat": SOURCE_FORMAT,
        "provenance": {"inputSequenceSha256": descriptor.context_sha256,
            "researchRevision": "Not reported", "clientRevision": "Not reported",
            "expectedCheckpointRevision": "a" * 40, "expectedResearchCommit": "b" * 40}}


def normalized(source: dict) -> dict:
    return normalized_junction_analysis(source, load_descriptor(source["variant"]), "synthetic.source-result.json", "c" * 64)


class JunctionExportTests(unittest.TestCase):
    def test_alignment_uses_complete_coordinates_strand_and_track_identity(self) -> None:
        source = synthetic_source()
        analysis = normalized(source)
        self.assertEqual(analysis["kind"], "junctions")
        self.assertEqual(len(analysis["rows"]), 8)
        names = {row["track"]: row["sourceName"] for row in analysis["trackMetadata"]}
        by_key = {(row["start"], row["end"], row["strand"], names[row["track"]]): row for row in analysis["rows"]}
        d = load_descriptor(VARIANTS[1]); p = d.position - 1
        shared_a = by_key[(p - 10, p + 200, "-", "SYNTHETIC track A")]
        self.assertEqual((shared_a["reference"], shared_a["alternate"]), (2.5, 12.5))
        shared_b = by_key[(p - 10, p + 200, "-", "SYNTHETIC track B")]
        self.assertEqual((shared_b["reference"], shared_b["alternate"]), (8.5, 18.5))
        self.assertIsNone(by_key[(p - 30, p + 100, "+", "SYNTHETIC track A")]["alternate"])
        self.assertIsNone(by_key[(p - 50, p + 75, "+", "SYNTHETIC track B")]["reference"])
        spanning = [row for row in analysis["rows"] if row["start"] < analysis["interval"]["start"]]
        self.assertEqual(len(spanning), 2)
        self.assertTrue(all(row["end"] > analysis["interval"]["end"] for row in spanning))
        self.assertEqual(spanning[0]["reference"], 0.12345678901234568)
        self.assertEqual(spanning[1]["reference"], 0.0)
        self.assertEqual(spanning[1]["alternate"], 0.0)
        self.assertTrue(all(row["reference"] is not None or row["alternate"] is not None for row in analysis["rows"]))
        self.assertEqual([(row["start"], row["end"], row["strand"]) for row in analysis["rows"][:4]],
            [(row["start"], row["end"], row["strand"]) for row in source["outputs"][0]["reference"]["junctions"]]
            + [(p - 50, p + 75, "+")])

    def test_one_empty_allele_remains_missing_and_empty_both_fail(self) -> None:
        source = synthetic_source()
        alt = source["outputs"][0]["alternate"]
        alt.update(junctions=[], values=[], sourceJunctionIndices=[], returnedJunctionCount=0)
        analysis = normalized(source)
        self.assertEqual(len(analysis["rows"]), 6)
        self.assertTrue(all(row["alternate"] is None for row in analysis["rows"]))
        source["outputs"][0]["reference"].update(junctions=[], values=[], sourceJunctionIndices=[], returnedJunctionCount=0)
        with self.assertRaisesRegex(ValueError, "No junction overlaps"):
            normalized(source)

    def test_same_endpoints_on_opposite_strands_are_separate(self) -> None:
        source = synthetic_source()
        for side in ("reference", "alternate"):
            raw = source["outputs"][0][side]
            raw["junctions"][2] = dict(raw["junctions"][1], strand="+")
        analysis = normalized(source)
        p = load_descriptor(VARIANTS[1]).position - 1
        shared = [row for row in analysis["rows"] if row["start"] == p - 10 and row["end"] == p + 200]
        self.assertEqual(len(shared), 4)
        self.assertEqual({row["strand"] for row in shared}, {"+", "-"})

    def test_unmatched_track_identity_has_null_counterpart(self) -> None:
        source = synthetic_source()
        source["outputs"][0]["alternate"]["metadata"][0]["name"] = "SYNTHETIC ALT-only track"
        analysis = normalized(source)
        self.assertEqual(len(analysis["trackMetadata"]), 3)
        new_key = next(row["track"] for row in analysis["trackMetadata"] if row["sourceName"] == "SYNTHETIC ALT-only track")
        self.assertTrue(all(row["reference"] is None for row in analysis["rows"] if row["track"] == new_key))

    def test_raw_metadata_and_source_provenance_are_preserved(self) -> None:
        source = synthetic_source()
        analysis = normalized(source)
        self.assertEqual(source["outputs"][0]["reference"]["sourceJunctionIndices"], [1, 3, 7])
        self.assertEqual(source["outputs"][0]["reference"]["returnedJunctionCount"], 10)
        self.assertEqual(source["outputs"][0]["alternate"]["metadata"][0]["name"], "SYNTHETIC track B")
        self.assertEqual(source["outputs"][0]["reference"]["uns"], {"notice": NOTICE})
        self.assertEqual(analysis["variant"], source["variant"])
        self.assertEqual(analysis["interval"], source["outputInterval"])
        inference = analysis["provenance"]["inference"]
        self.assertEqual(inference["checkpointRevision"], "Not reported")
        self.assertEqual(inference["inputSequenceSha256"], load_descriptor(VARIANTS[1]).context_sha256)
        self.assertIsNone(inference["referenceSha256"])
        for track in analysis["trackMetadata"]:
            self.assertEqual(track["scope"], "biosample_specific")
            self.assertEqual(track["biosampleName"], "Synthetic test cells")
            self.assertIsNone(track["unit"])
            self.assertIsNone(track["strand"])
            self.assertNotIn("binSize", track)

    def test_relabeling_hash_coordinate_and_metadata_contradictions_fail(self) -> None:
        changes = [
            lambda source: source.update(variant=VARIANTS[0]),
            lambda source: source["provenance"].update(inputSequenceSha256="f" * 64),
            lambda source: source.update(ontologyCuries=None),
            lambda source: source["outputs"][0]["reference"].update(coordinateConvention="1-based"),
            lambda source: source["outputs"][0]["reference"]["selection"].update(endpointsClipped=True),
            lambda source: source["outputs"][0]["reference"]["junctions"][0].update(start=0),
            lambda source: source["outputs"][0]["reference"]["junctions"][0].update(strand="."),
            lambda source: source["outputs"][0]["reference"]["metadata"][0].update(biosample_name="Different cells"),
            lambda source: source["outputs"][0]["alternate"]["metadata"][1].update(unit="Changed unit"),
            lambda source: source["outputs"][0]["reference"]["sourceJunctionIndices"].reverse(),
            lambda source: source["outputs"][0]["reference"]["junctions"].__setitem__(1, deepcopy(source["outputs"][0]["reference"]["junctions"][0])),
        ]
        for change in changes:
            source = synthetic_source(); change(source)
            with self.assertRaises(ValueError):
                normalized(source)
        source = synthetic_source()
        source["outputs"].append({"outputType": "SPLICE_SITE_USAGE"})
        with self.assertRaisesRegex(ValueError, "exclusive"):
            normalized(source)

    def test_invalid_numeric_values_shapes_and_touching_only_arcs_fail(self) -> None:
        for invalid in (None, True, "0.5", float("nan"), float("inf"), -0.01):
            source = synthetic_source()
            source["outputs"][0]["reference"]["values"][0][0] = invalid
            with self.assertRaises(ValueError):
                normalized(source)
        source = synthetic_source(); source["outputs"][0]["reference"]["values"].pop()
        with self.assertRaises(ValueError): normalized(source)
        source = synthetic_source()
        source["outputs"][0]["reference"]["junctions"][0].update(
            start=source["outputInterval"]["start"] - 50, end=source["outputInterval"]["start"])
        with self.assertRaisesRegex(ValueError, "overlap"):
            normalized(source)

    def test_limits_count_aligned_arcs_times_tracks_instead_of_display_bases(self) -> None:
        source = synthetic_source()
        records = source["outputs"][0]["reference"]["metadata"]
        self.assertEqual(selected_metadata({JUNCTION_OUTPUT: records}, "Synthetic test cells", 32768), (["CL:TEST"], 2))
        self.assertEqual(len(normalized(source)["rows"]), 8)
        # Each allele fits alone (2501 rows); the disjoint union does not (5002).
        descriptor = load_descriptor(VARIANTS[1])
        p = descriptor.position - 1
        for side, offset in (("reference", 0), ("alternate", 3000)):
            raw = source["outputs"][0][side]
            raw["metadata"] = [deepcopy(records[0])]
            raw["junctions"] = [{"chromosome": "chr9", "start": p - 10000 + offset + i, "end": p + 1000, "strand": "+"} for i in range(2501)]
            raw["values"] = [[0.1] for _ in range(2501)]
            raw["sourceJunctionIndices"] = list(range(2501)); raw["returnedJunctionCount"] = 2501
        with self.assertRaisesRegex(ValueError, "Aligned junctions.*5000"):
            normalized(source)
        source = synthetic_source(); source["largeMetadata"] = "x" * (2 * 1024 * 1024)
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, "2 MiB"):
                write_result_files(source, descriptor, Path(temp) / "synthetic.json")
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_sidecar_and_analysis_round_trip_through_real_typescript_importer(self) -> None:
        for variant in VARIANTS:
            source = synthetic_source(variant)
            with tempfile.TemporaryDirectory() as temp:
                output = Path(temp) / "synthetic-junctions.json"
                raw_path, count = write_result_files(source, load_descriptor(variant), output)
                self.assertEqual(count, 8)
                self.assertEqual(raw_path.read_bytes(), encoded_json(source))
                analysis = json.loads(output.read_bytes())
                self.assertEqual(analysis["provenance"]["artifact"]["sha256"], hashlib.sha256(raw_path.read_bytes()).hexdigest())
                script = "import {readFileSync} from 'node:fs';import {parseDatasetJSON} from './shared/analysis-import.ts';const d=parseDatasetJSON(readFileSync(process.argv[1],'utf8'));if(d.kind!=='junctions'||d.rows.length!==8||d.variant!==process.argv[2]||!d.rows.some(r=>r.reference===null)||!d.rows.some(r=>r.alternate===null))throw Error('Junction import mismatch');"
                subprocess.run([str(ROOT / "node_modules/.bin/tsx"), "-e", script, str(output), variant], cwd=ROOT, check=True, capture_output=True, text=True)

    def test_cli_keeps_positional_defaults_and_selects_exclusive_wide_junction_mode(self) -> None:
        self.assertFalse(validate_output_selection(OUTPUT_TYPES, 41))
        self.assertTrue(validate_output_selection((JUNCTION_OUTPUT,), CONTEXT_BP))
        for outputs in ((JUNCTION_OUTPUT, "RNA_SEQ"), (JUNCTION_OUTPUT, JUNCTION_OUTPUT)):
            with self.assertRaises(ValueError): validate_output_selection(outputs, 32768)
        with self.assertRaises(ValueError): validate_output_selection(OUTPUT_TYPES, 32768)
        for outputs, expected_width, explicit_width in (([], 41, []), (["--outputs", JUNCTION_OUTPUT], 32768, []), (["--outputs", JUNCTION_OUTPUT], 100001, ["--crop-bp", "100001"])):
            args = ["run_dnm1.py", "--variant", VARIANTS[1], "--checkpoint", "absent", "--fasta", "absent", "--gtf", "absent", "--splice-site-starts", "absent", "--splice-site-ends", "absent", "--output", "absent", *outputs, *explicit_width]
            with patch.object(sys, "argv", args), patch("run_dnm1.predict") as prediction:
                self.assertEqual(main(), 0)
                self.assertEqual(prediction.call_args.args[4], expected_width)
                self.assertEqual(prediction.call_args.args[5], VARIANTS[1])
        help_result = subprocess.run([sys.executable, str(ROOT / "inference/run_dnm1.py"), "--help"], capture_output=True, text=True)
        self.assertEqual(help_result.returncode, 0)
        self.assertIn("SPLICE_JUNCTIONS", help_result.stdout)

    def test_numpy_boundary_preserves_returned_coordinates_arrays_and_crop_overlap(self) -> None:
        try:
            import numpy as np
            import pandas as pd
        except ImportError:
            self.skipTest("Optional NumPy/pandas boundary test; all alignment/import checks use only the standard library")
        descriptor = load_descriptor(VARIANTS[1])
        start, end = centered_window(descriptor.position, 32768)
        metadata = [{"name": "SYNTHETIC", "ontology_curie": "CL:TEST", "biosample_name": "Synthetic test cells", "sourceNumber": 0.12345678901234568}]
        frame = pd.DataFrame(metadata, index=pd.Index([42], name="source_track_index"))
        # Optional proto fields become sparse DataFrame cells in the real client.
        frame["gtex_tissue"] = np.nan
        frame["biosample_life_stage"] = pd.NA
        def junction(left, right, strand):
            return SimpleNamespace(chromosome="chr9", start=np.int64(left), end=np.int64(right), strand=strand, name="", info={"fixture": NOTICE}, k=None)
        data = SimpleNamespace(interval=SimpleNamespace(chromosome="chr9", start=descriptor.input_start, end=descriptor.input_end, strand="."),
            junctions=np.asarray([junction(start - 1000, end + 1000, "-"), junction(start - 100, start, "+"), junction(end, end + 100, "-"), junction(start + 10, start + 90, "+")]),
            values=np.asarray([[0.12345678901234568], [2.0], [3.0], [0.0]], dtype=np.float64),
            metadata=frame, uns={"source": NOTICE})
        raw = serialize_junctions(data, descriptor, start, end)
        self.assertEqual(raw["sourceJunctionIndices"], [0, 3])
        self.assertEqual(raw["returnedJunctionCount"], 4)
        self.assertEqual(raw["values"], [[0.12345678901234568], [0.0]])
        self.assertEqual((raw["junctions"][0]["start"], raw["junctions"][0]["end"]), (start - 1000, end + 1000))
        self.assertEqual(raw["junctions"][0]["strand"], "-")
        self.assertEqual(raw["uns"], {"source": NOTICE})
        self.assertEqual(raw["metadata"], [dict(metadata[0], gtex_tissue=None, biosample_life_stage=None)])
        self.assertEqual(raw["metadataIndex"], [42])
        self.assertEqual(raw["metadataIndexName"], "source_track_index")
        data.values[1, 0] = np.nan  # Even excluded rows must come from a valid returned matrix.
        with self.assertRaises(ValueError): serialize_junctions(data, descriptor, start, end)


if __name__ == "__main__":
    unittest.main()
