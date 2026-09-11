"""Synthetic export and preflight QA only. No checkpoint, GPU or inference is used."""

from copy import deepcopy
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from run_dnm1 import annotation_provenance, installed_revision, predict, selected_metadata, write_result_files
from track_export import (
    CONTEXT_BP, DESCRIPTOR_PATH, OUTPUT_TYPES, VARIANTS, centered_window, encoded_json,
    load_descriptor, normalized_analysis, track_payload, validate_context,
)

ROOT = Path(__file__).resolve().parents[1]


def synthetic_source(variant_id: str = VARIANTS[1]) -> dict:
    """Build explicitly synthetic numeric fixtures under a real coordinate descriptor."""
    descriptor = load_descriptor(variant_id)
    outputs = []
    for output_type in OUTPUT_TYPES:
        tissue_specific = output_type != "SPLICE_SITES"
        metadata = [{"name": f"SYNTHETIC QA {output_type}", "strand": strand,
            "ontology_curie": "CL:TEST" if tissue_specific else None,
            "biosample_name": "Synthetic test cells" if tissue_specific else None,
            "unit": None, "unmapped_test_metadata": {"preserved": True}} for strand in ("+", None)]
        reference = [[float(index) / 100, 1e-9] for index in range(41)]
        alternate = [[float(index) / 200, -1e-9] for index in range(41)]
        outputs.append({"outputType": output_type,
            "reference": track_payload(reference, metadata, start=descriptor.display_start, end=descriptor.display_end, resolution=1),
            "alternate": track_payload(alternate, metadata, start=descriptor.display_start, end=descriptor.display_end, resolution=1)})
    return {"sourceKind": "model_inference", "variant": variant_id,
        "fixtureNotice": "Synthetic validation data only; NOT A MODEL PREDICTION",
        "biosample": "Synthetic test cells", "ontologyCuries": ["CL:TEST"],
        "inputInterval": {"chromosome": "chr9", "start": descriptor.input_start, "end": descriptor.input_end, "coordinateSystem": "0-based-half-open"},
        "outputInterval": {"chromosome": "chr9", "start": descriptor.display_start, "end": descriptor.display_end, "coordinateSystem": "0-based-half-open"},
        "createdAt": "2026-09-11T00:00:00+00:00", "outputs": outputs,
        "provenance": {"inputSequenceSha256": descriptor.context_sha256, "researchRevision": "Not reported", "clientRevision": "Not reported",
            "expectedResearchCommit": "a" * 40, "expectedCheckpointRevision": "b" * 40}}


def normalized(source: dict) -> dict:
    return normalized_analysis(source, load_descriptor(source["variant"]), "synthetic.source-result.json", "c" * 64)


class ExactVariantRunnerTests(unittest.TestCase):
    def test_descriptors_keep_both_exact_variants_separate(self) -> None:
        old, new = [load_descriptor(variant) for variant in VARIANTS]
        self.assertEqual(new.position - old.position, 33)
        self.assertEqual((new.input_start, new.input_end), (127701739, 128750315))
        self.assertEqual((new.display_start, new.display_end), (128226006, 128226047))
        self.assertNotEqual(old.context_sha256, new.context_sha256)
        self.assertNotEqual(old.display_reference, new.display_reference)
        for descriptor in (old, new):
            self.assertEqual(descriptor.display_reference[20], "G")
            self.assertEqual(centered_window(descriptor.position, CONTEXT_BP), (descriptor.input_start, descriptor.input_end))
            self.assertEqual(centered_window(descriptor.position, 41), (descriptor.display_start, descriptor.display_end))
            analysis = normalized(synthetic_source(descriptor.id))
            self.assertEqual(analysis["provenance"]["inference"]["variant"], descriptor.id)
            self.assertEqual(analysis["rows"][0]["position"], descriptor.display_start)
        with self.assertRaises(ValueError):
            load_descriptor("chr9:128226027:G>T")

    def test_descriptor_tampering_and_substitution_are_rejected(self) -> None:
        document = json.loads(DESCRIPTOR_PATH.read_text())
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "descriptors.json"
            for field, value in (("position", 128225994), ("contextSha256", "unknown"), ("displayReference", "G" * 41)):
                changed = deepcopy(document)
                changed["variants"][1][field] = value
                path.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    load_descriptor(VARIANTS[1], path)
        source = synthetic_source()
        with self.assertRaises(ValueError):
            normalized_analysis(source, load_descriptor(VARIANTS[0]), "source.json", "c" * 64)
        source["provenance"]["inputSequenceSha256"] = load_descriptor(VARIANTS[0]).context_sha256
        with self.assertRaises(ValueError):
            normalized(source)

    def test_context_validation_checks_full_hash_allele_and_embedded_display(self) -> None:
        descriptor = load_descriptor(VARIANTS[1])
        # Full context here is SYNTHETIC, not a copied research/model result.
        start = descriptor.display_start - descriptor.input_start
        context = "A" * start + descriptor.display_reference + "A" * (CONTEXT_BP - start - 41)
        synthetic = replace(descriptor, context_sha256=hashlib.sha256(context.encode()).hexdigest())
        validate_context(synthetic, context, descriptor.display_reference)
        for changed in (context[:-1], "C" + context[1:]):
            with self.assertRaises(ValueError):
                validate_context(synthetic, changed, descriptor.display_reference)
        with self.assertRaises(ValueError):
            validate_context(synthetic, context, load_descriptor(VARIANTS[0]).display_reference)

    def test_precise_values_original_metadata_and_unknowns_are_preserved(self) -> None:
        source = synthetic_source()
        analysis = normalized(source)
        self.assertEqual(len(analysis["rows"]), 246)
        self.assertEqual(analysis["rows"][41]["reference"], 1e-9)
        self.assertEqual(analysis["rows"][41]["alternate"], -1e-9)
        self.assertEqual(analysis["rows"][1]["reference"], 0.01)
        metadata = analysis["trackMetadata"]
        self.assertEqual(len({row["track"] for row in metadata}), 6)
        self.assertEqual(metadata[1]["strand"], None)
        self.assertEqual(metadata[0]["unit"], None)
        self.assertEqual(metadata[2]["scope"], "tissue_agnostic")
        self.assertIsNone(metadata[2]["biosampleId"])
        self.assertEqual(metadata[4]["scope"], "biosample_specific")
        inference = analysis["provenance"]["inference"]
        self.assertEqual(inference["modelRevision"], "Not reported")
        self.assertEqual(inference["checkpointRevision"], "Not reported")
        self.assertIsNone(inference["referenceSha256"])

    def test_misalignment_nonfinite_and_tissue_scope_fail_instead_of_being_repaired(self) -> None:
        variants = []
        wrong = synthetic_source(); wrong["outputs"][0]["alternate"]["start"] += 1; variants.append(wrong)
        wrong = synthetic_source(); wrong["outputs"][0]["alternate"]["values"].pop(); variants.append(wrong)
        wrong = synthetic_source(); wrong["outputs"][0]["reference"]["values"][0][0] = float("nan"); variants.append(wrong)
        wrong = synthetic_source(); wrong["outputs"][0]["reference"]["values"][0][0] = True; variants.append(wrong)
        wrong = synthetic_source(); wrong["outputs"][1]["reference"]["metadata"][0]["ontology_curie"] = "CL:TEST"; variants.append(wrong)
        wrong = synthetic_source(); wrong["outputs"][1]["reference"]["metadata"][0]["biosample_name"] = "Another tissue"; variants.append(wrong)
        wrong = synthetic_source(); wrong["outputs"][0]["reference"]["metadata"][0]["biosample_name"] = "Different cells"; variants.append(wrong)
        wrong = synthetic_source(); wrong["outputs"][0]["reference"]["metadata"][0]["name"] = "Padding"; variants.append(wrong)
        wrong = synthetic_source(); wrong["outputs"].append(deepcopy(wrong["outputs"][0])); variants.append(wrong)
        for source in variants:
            with self.assertRaises(ValueError):
                normalized(source)

    def test_exact_metadata_selection_and_complete_row_limit(self) -> None:
        records = {output["outputType"]: output["reference"]["metadata"] for output in synthetic_source()["outputs"]}
        self.assertEqual(selected_metadata(records, "Synthetic test cells", 41), (["CL:TEST"], 6))
        with self.assertRaises(ValueError):
            selected_metadata(records, "test cells", 41)
        with self.assertRaises(ValueError):
            selected_metadata(records, "Synthetic test cells", 1000)
        source = synthetic_source()
        output = source["outputs"][0]
        source["outputs"] = [output]
        for side in ("reference", "alternate"):
            output[side]["metadata"] = [dict(output[side]["metadata"][0], name=f"SYNTHETIC {i}") for i in range(122)]
            output[side]["values"] = [[0.125] * 122 for _ in range(41)]
        with self.assertRaisesRegex(ValueError, "5000"):
            normalized(source)
        with self.assertRaisesRegex(ValueError, "2 MiB"):
            encoded_json({"synthetic": "🙂" * 524288})

    def test_raw_sidecar_and_ready_analysis_round_trip_through_real_typescript_import(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "synthetic-analysis.json"
            source = synthetic_source()
            raw_path, count = write_result_files(source, load_descriptor(VARIANTS[1]), path)
            analysis = json.loads(path.read_bytes())
            self.assertEqual(count, 246)
            self.assertEqual(raw_path.read_bytes(), encoded_json(source))
            self.assertEqual(analysis["provenance"]["artifact"]["sha256"], hashlib.sha256(raw_path.read_bytes()).hexdigest())
            self.assertEqual(analysis["provenance"]["artifact"]["filename"], raw_path.name)
            self.assertEqual(json.loads(raw_path.read_bytes())["outputs"][0]["reference"]["metadata"][0]["unmapped_test_metadata"], {"preserved": True})
            script = "import {readFileSync} from 'node:fs'; import {parseDatasetJSON} from './shared/analysis-import.ts'; const d=parseDatasetJSON(readFileSync(process.argv[1],'utf8')); if(d.kind!=='tracks'||d.rows.length!==246||d.provenance.inference?.variant!=='chr9:128226027:G>A') throw new Error('Import mismatch');"
            subprocess.run([str(ROOT / "node_modules/.bin/tsx"), "-e", script, str(path)], cwd=ROOT, check=True, capture_output=True, text=True)

    def test_output_errors_never_overwrite_or_leave_partial_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "synthetic-analysis.json"
            descriptor, source = load_descriptor(VARIANTS[1]), synthetic_source()
            path.write_text("existing")
            with self.assertRaises(ValueError):
                write_result_files(source, descriptor, path)
            self.assertEqual(path.read_text(), "existing")
            path.unlink()
            original_open = Path.open
            def failing_open(target, mode="r", *args, **kwargs):
                if target == path and mode == "xb":
                    raise OSError("Injected write failure")
                return original_open(target, mode, *args, **kwargs)
            with patch.object(Path, "open", failing_open):
                with self.assertRaises(OSError):
                    write_result_files(source, descriptor, path)
            self.assertEqual(list(Path(temp).iterdir()), [])
            source["outputs"][0]["reference"]["values"][0][0] = float("inf")
            with self.assertRaises(ValueError):
                write_result_files(source, descriptor, path)
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_annotation_inputs_and_installed_revision_are_explicit(self) -> None:
        with self.assertRaises(ValueError):
            annotation_provenance({})
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "synthetic-annotation-not-a-model-input"
            path.write_bytes(b"SYNTHETIC HASH TEST ONLY")
            records = annotation_provenance({"gtf": path, "spliceSiteStarts": path, "spliceSiteEnds": path})
            self.assertTrue(all(record["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest() for record in records))
            self.assertTrue(all("not independently authenticated" in record["sourceVerification"] for record in records))
        self.assertEqual(installed_revision("deliberately-absent-helix-test-package"), "Not reported")

    def test_help_has_no_model_dependencies_and_requires_explicit_variant_and_annotations(self) -> None:
        help_result = subprocess.run([sys.executable, str(ROOT / "inference/run_dnm1.py"), "--help"], capture_output=True, text=True)
        self.assertEqual(help_result.returncode, 0)
        for text in (*VARIANTS, "--gtf", "--splice-site-starts", "--splice-site-ends"):
            self.assertIn(text, help_result.stdout)
        missing = subprocess.run([sys.executable, str(ROOT / "inference/run_dnm1.py"), "--checkpoint", "absent", "--fasta", "absent", "--output", "absent"], capture_output=True, text=True)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("--variant", missing.stderr)

    def test_each_requested_identity_reaches_the_model_with_its_own_verified_context(self) -> None:
        """A boundary spy records call identity, then deliberately returns no prediction."""
        for variant_id in VARIANTS:
            descriptor = load_descriptor(variant_id)
            observed = {}
            class ReferenceInterval:
                def resize(self, width):
                    start, end = centered_window(descriptor.position, width)
                    return SimpleNamespace(chromosome="chr9", start=start, end=end, strand=".")
            def make_variant(**kwargs):
                observed["variant"] = kwargs
                return SimpleNamespace(**kwargs, reference_interval=ReferenceInterval())
            def record_prediction(**kwargs):
                observed["call"] = kwargs
                # No numerical result is invented; the runtime fails immediately after this boundary.
                return SimpleNamespace(reference=SimpleNamespace(get=lambda _: None), alternate=SimpleNamespace(get=lambda _: None))
            frame = SimpleNamespace(to_json=lambda **_: json.dumps([{"name": "Synthetic QA", "biosample_name": "Synthetic test cells", "ontology_curie": "CL:TEST"}]))
            def create_model(*args, **kwargs):
                observed["settings"] = kwargs["organism_settings"]
                return SimpleNamespace(output_metadata=lambda: SimpleNamespace(get=lambda _: frame), predict_variant=record_prediction)
            model_module = SimpleNamespace(Organism=SimpleNamespace(HOMO_SAPIENS="human", MUS_MUSCULUS="mouse"),
                OrganismSettings=lambda **kwargs: kwargs, OutputType={"RNA_SEQ": "RNA_SEQ"}, create=create_model)
            genome_module = SimpleNamespace(Variant=make_variant)
            fasta_module = SimpleNamespace(FastaExtractor=lambda _: SimpleNamespace(extract=lambda interval: descriptor.display_reference if interval.end-interval.start == 41 else "SYNTHETIC boundary test"))
            modules = {"jax": SimpleNamespace(devices=lambda: [SimpleNamespace(platform="gpu", device_kind="SYNTHETIC TEST")]),
                "alphagenome": SimpleNamespace(), "alphagenome.data": SimpleNamespace(genome=genome_module),
                "alphagenome.io": SimpleNamespace(fasta=fasta_module), "alphagenome_research": SimpleNamespace(),
                "alphagenome_research.model": SimpleNamespace(dna_model=model_module)}
            with tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                for filename in ("_CHECKPOINT_METADATA", "_METADATA", "manifest.ocdbt", "reference.fa", "reference.fa.fai", "annotation.feather"):
                    (directory / filename).write_bytes(b"SYNTHETIC boundary test only")
                with patch.dict(sys.modules, modules), patch("run_dnm1.validate_context") as context_check:
                    with self.assertRaisesRegex(ValueError, "no REF/ALT"):
                        predict(directory, directory / "reference.fa", directory / "analysis.json", "Synthetic test cells", 41, variant_id, ("RNA_SEQ",),
                            gtf=directory / "annotation.feather", splice_site_starts=directory / "annotation.feather", splice_site_ends=directory / "annotation.feather")
                    self.assertEqual(context_check.call_args.args[0], descriptor)
                self.assertEqual(observed["variant"]["position"], descriptor.position)
                self.assertEqual(observed["call"]["variant"].position, descriptor.position)
                self.assertEqual((observed["call"]["interval"].start, observed["call"]["interval"].end), (descriptor.input_start, descriptor.input_end))
                self.assertIn("splice_site_starts_feather_path", observed["settings"]["human"])
                self.assertIn("splice_site_ends_feather_path", observed["settings"]["human"])
                self.assertFalse((directory / "analysis.json").exists())


if __name__ == "__main__":
    unittest.main()
