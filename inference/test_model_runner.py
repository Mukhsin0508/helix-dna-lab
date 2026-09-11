"""Synthetic lifecycle spies only; no model dependencies, checkpoint or GPU are used."""

from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from run_dnm1 import ModelRunner, SUPPORTED_OUTPUT_TYPES, predict
from junction_export import JUNCTION_OUTPUT, SOURCE_FORMAT
from track_export import CONTEXT_BP, OUTPUT_TYPES, VARIANTS, centered_window, load_descriptor


class ModelRunnerLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        for name in ("_CHECKPOINT_METADATA", "_METADATA", "manifest.ocdbt", "reference.fa", "reference.fa.fai", "gtf.feather", "starts.feather", "ends.feather"):
            (self.directory / name).write_bytes(b"SYNTHETIC lifecycle test input, not biological data")
        self.annotations = {"gtf": self.directory / "gtf.feather", "splice_site_starts": self.directory / "starts.feather", "splice_site_ends": self.directory / "ends.feather"}
        self.metadata = {
            name: [{"name": f"SYNTHETIC {name}", "strand": None, "unit": None,
                    "biosample_name": None if name == "SPLICE_SITES" else "Synthetic cells",
                    "ontology_curie": None if name == "SPLICE_SITES" else "CL:TEST"}]
            for name in (*OUTPUT_TYPES, JUNCTION_OUTPUT)
        }

        def variant(**kwargs):
            position = kwargs["position"]
            def resize(width):
                start, end = centered_window(position, width)
                return SimpleNamespace(chromosome=kwargs["chromosome"], start=start, end=end, strand=".")
            return SimpleNamespace(**kwargs, reference_interval=SimpleNamespace(resize=resize))

        def extract(interval):
            for variant_id in VARIANTS:
                descriptor = load_descriptor(variant_id)
                if (interval.start, interval.end) == (descriptor.display_start, descriptor.display_end):
                    return descriptor.display_reference
            return f"SYNTHETIC CONTEXT {interval.start}:{interval.end}"

        self.extractor = SimpleNamespace(extract=Mock(side_effect=extract))
        self.extractor_factory = Mock(return_value=self.extractor)
        self.reference, self.alternate = object(), object()
        self.model = SimpleNamespace(
            output_metadata=Mock(side_effect=lambda: SimpleNamespace(get=lambda output: SimpleNamespace(to_json=lambda **_: json.dumps(self.metadata[output])))),
            predict_variant=Mock(return_value=SimpleNamespace(reference=SimpleNamespace(get=lambda _: self.reference), alternate=SimpleNamespace(get=lambda _: self.alternate))),
        )
        self.create_model = Mock(return_value=self.model)
        self.device = SimpleNamespace(platform="gpu", device_kind="SYNTHETIC TEST DEVICE")
        self.devices = Mock(return_value=[self.device])
        self.modules = {
            "jax": SimpleNamespace(devices=self.devices),
            "alphagenome": SimpleNamespace(),
            "alphagenome.data": SimpleNamespace(genome=SimpleNamespace(Variant=variant)),
            "alphagenome.io": SimpleNamespace(fasta=SimpleNamespace(FastaExtractor=self.extractor_factory)),
            "alphagenome_research": SimpleNamespace(),
            "alphagenome_research.model": SimpleNamespace(dna_model=SimpleNamespace(
                Organism=SimpleNamespace(HOMO_SAPIENS="human", MUS_MUSCULUS="mouse"),
                OrganismSettings=lambda **kwargs: kwargs,
                OutputType={name: name for name in (*OUTPUT_TYPES, JUNCTION_OUTPUT)}, create=self.create_model)),
        }
        self.stack.enter_context(patch.dict(sys.modules, self.modules))
        self.check_context = self.stack.enter_context(patch("run_dnm1.validate_context"))
        self.stack.enter_context(patch("run_dnm1.installed_revision", return_value="Not reported"))
        self.stack.enter_context(patch("run_dnm1.version", return_value="Synthetic test version"))
        # Serialization is independently exercised by the existing numerical-exporter tests.
        self.serialize_tracks = self.stack.enter_context(patch("run_dnm1.serialize_track", side_effect=lambda track, descriptor, start, end: {
            "fixtureNotice": "Synthetic serialization spy only", "metadata": [{"name": "SYNTHETIC"}],
            "chromosome": descriptor.chromosome, "start": start, "end": end, "resolutionBp": 1,
            "values": [[0.125 if track is self.reference else 0.25]],
        }))
        self.serialize_junctions = self.stack.enter_context(patch("run_dnm1.serialize_junctions", side_effect=lambda track, descriptor, start, end: {
            "fixtureNotice": "Synthetic junction dispatch spy only", "metadata": [{"name": "SYNTHETIC"}],
            "chromosome": descriptor.chromosome, "start": start, "end": end,
        }))

    def runner(self) -> ModelRunner:
        return ModelRunner(self.directory, self.directory / "reference.fa", **self.annotations)

    def test_one_model_and_extractor_are_loaded_with_explicit_annotation_paths(self) -> None:
        runner = self.runner()
        self.create_model.assert_called_once()
        self.extractor_factory.assert_called_once_with(str(self.directory / "reference.fa"))
        settings = self.create_model.call_args.kwargs["organism_settings"]
        self.assertEqual(settings, {
            "human": {"fasta_path": str(self.directory / "reference.fa"), "gtf_feather_path": str(self.annotations["gtf"]),
                      "splice_site_starts_feather_path": str(self.annotations["splice_site_starts"]),
                      "splice_site_ends_feather_path": str(self.annotations["splice_site_ends"])},
            "mouse": {},
        })
        self.assertIs(self.create_model.call_args.kwargs["device"], self.device)
        self.assertIs(runner.model, self.model)
        self.assertEqual(len(runner.provenance["annotations"]), 3)
        self.assertGreaterEqual(runner.model_load_seconds, 0)
        self.check_context.assert_not_called()
        self.model.predict_variant.assert_not_called()

    def test_alternating_variants_rebuild_exact_inputs_and_revalidate_context_every_time(self) -> None:
        runner = self.runner()
        sequence = (VARIANTS[0], VARIANTS[1], VARIANTS[0], VARIANTS[1])
        payloads = [runner.predict("Synthetic cells", 41, variant, ("RNA_SEQ",)) for variant in sequence]
        self.create_model.assert_called_once()
        self.assertEqual(self.model.predict_variant.call_count, 4)
        self.assertEqual(self.check_context.call_count, 4)
        self.assertEqual(self.extractor.extract.call_count, 8)
        for variant_id, payload, actual, checked in zip(sequence, payloads, self.model.predict_variant.call_args_list, self.check_context.call_args_list, strict=True):
            descriptor = load_descriptor(variant_id)
            self.assertEqual(actual.kwargs["variant"].position, descriptor.position)
            self.assertEqual((actual.kwargs["interval"].start, actual.kwargs["interval"].end), (descriptor.input_start, descriptor.input_end))
            self.assertEqual(actual.kwargs["variant"].reference_bases, descriptor.reference)
            self.assertEqual(actual.kwargs["variant"].alternate_bases, descriptor.alternate)
            self.assertEqual(actual.kwargs["ontology_terms"], ["CL:TEST"])
            self.assertEqual(checked.args, (descriptor, f"SYNTHETIC CONTEXT {descriptor.input_start}:{descriptor.input_end}", descriptor.display_reference))
            self.assertEqual(payload["variant"], descriptor.id)
            self.assertEqual(payload["outputInterval"]["start"], descriptor.display_start)
            self.assertEqual(payload["verifiedReferenceExcerpt"], descriptor.display_reference)
            self.assertEqual(payload["inputInterval"]["end"] - payload["inputInterval"]["start"], CONTEXT_BP)
            self.assertEqual(payload["provenance"]["referenceWindowSha256"], descriptor.display_sha256)
        self.assertIsNot(self.model.predict_variant.call_args_list[0].kwargs["variant"], self.model.predict_variant.call_args_list[2].kwargs["variant"])

    def test_bad_reference_blocks_that_request_without_corrupting_the_next_variant(self) -> None:
        runner = self.runner()
        runner.predict("Synthetic cells", 41, VARIANTS[0], ("RNA_SEQ",))
        self.check_context.side_effect = ValueError("Synthetic reference mismatch")
        with self.assertRaisesRegex(ValueError, "reference mismatch"):
            runner.predict("Synthetic cells", 41, VARIANTS[1], ("RNA_SEQ",))
        self.assertEqual(self.model.predict_variant.call_count, 1)
        self.check_context.side_effect = None
        payload = runner.predict("Synthetic cells", 41, VARIANTS[1], ("RNA_SEQ",))
        self.assertEqual(payload["variant"], VARIANTS[1])
        self.assertEqual(self.model.predict_variant.call_count, 2)
        self.create_model.assert_called_once()

    def test_metadata_can_be_inspected_without_inference_and_is_detached_from_model_state(self) -> None:
        runner = self.runner()
        records = runner.output_metadata_records(OUTPUT_TYPES)
        self.assertEqual(records, {name: self.metadata[name] for name in OUTPUT_TYPES})
        records["RNA_SEQ"][0]["name"] = "MUTATED TEST COPY"
        self.assertEqual(runner.output_metadata_records(("RNA_SEQ",))["RNA_SEQ"][0]["name"], "SYNTHETIC RNA_SEQ")
        self.assertEqual(runner.output_metadata_records((JUNCTION_OUTPUT,)), {JUNCTION_OUTPUT: self.metadata[JUNCTION_OUTPUT]})
        self.model.predict_variant.assert_not_called()
        for selection in ((), ("NOT_SUPPORTED",), ("RNA_SEQ", "RNA_SEQ")):
            with self.assertRaises(ValueError):
                runner.output_metadata_records(selection)
        self.model.output_metadata.return_value = SimpleNamespace(get=lambda _: None)
        self.model.output_metadata.side_effect = None
        with self.assertRaisesRegex(ValueError, "no RNA_SEQ metadata"):
            runner.output_metadata_records(("RNA_SEQ",))

    def test_metadata_discovers_all_four_outputs_together_without_prediction(self) -> None:
        runner = self.runner()
        records = runner.output_metadata_records(tuple(SUPPORTED_OUTPUT_TYPES))
        self.assertEqual(records, self.metadata)
        self.assertEqual(len(records), 4)
        self.model.predict_variant.assert_not_called()
        with self.assertRaisesRegex(ValueError, "exclusive"):
            runner.predict("Synthetic cells", 41, VARIANTS[0], tuple(SUPPORTED_OUTPUT_TYPES))
        self.model.predict_variant.assert_not_called()

    def test_junction_and_positional_requests_dispatch_without_reloading_or_mixing_shapes(self) -> None:
        runner = self.runner()
        positional = runner.predict("Synthetic cells", 41, VARIANTS[0])
        self.assertEqual(positional["outputRepresentation"], "positional_tracks")
        self.assertEqual(self.serialize_tracks.call_count, 6)
        self.serialize_junctions.assert_not_called()
        junction = runner.predict("Synthetic cells", 32768, VARIANTS[1], (JUNCTION_OUTPUT,))
        self.assertEqual(junction["outputRepresentation"], "junctions")
        self.assertEqual(junction["junctionSourceFormat"], SOURCE_FORMAT)
        self.assertEqual(junction["outputInterval"]["end"] - junction["outputInterval"]["start"], 32768)
        self.assertEqual(self.serialize_junctions.call_count, 2)
        self.assertEqual(self.serialize_tracks.call_count, 6)
        self.assertEqual(self.model.predict_variant.call_args.kwargs["requested_outputs"], [JUNCTION_OUTPUT])
        self.create_model.assert_called_once()

    def test_request_rejections_do_not_submit_to_the_model(self) -> None:
        runner = self.runner()
        for kwargs in (
            {"variant_id": "chr9:128226027:G>T"}, {"biosample": ""}, {"biosample": None},
            {"biosample": "Unavailable cells"}, {"crop_bp": True}, {"crop_bp": 5001},
            {"requested_outputs": ("RNA_SEQ", JUNCTION_OUTPUT)},
        ):
            request = {"biosample": "Synthetic cells", "crop_bp": 41, "variant_id": VARIANTS[1], "requested_outputs": ("RNA_SEQ",), **kwargs}
            with self.assertRaises(ValueError):
                runner.predict(**request)
        self.model.predict_variant.assert_not_called()
        self.create_model.assert_called_once()

    def test_payload_keeps_honest_static_provenance_and_separates_load_from_request_time(self) -> None:
        with patch("run_dnm1.time.monotonic", side_effect=[10.0, 14.0, 20.0, 21.5, 30.0, 30.5]):
            runner = self.runner()
            first = runner.predict("Synthetic cells", 41, VARIANTS[0], ("RNA_SEQ",))
            first["provenance"]["annotations"][0]["kind"] = "MUTATED TEST COPY"
            second = runner.predict("Synthetic cells", 41, VARIANTS[1], ("RNA_SEQ",))
        self.assertEqual(first["modelLoadSeconds"], 4.0)
        self.assertEqual(second["modelLoadSeconds"], 4.0)
        self.assertEqual(first["durationSeconds"], 1.5)
        self.assertEqual(second["durationSeconds"], 0.5)
        self.assertIn("separate one-time model load", second["timingMeaning"])
        self.assertEqual(second["provenance"]["annotations"][0]["kind"], "gtf")
        self.assertEqual(second["provenance"]["researchRevision"], "Not reported")
        self.assertIn("expectedCheckpointRevision", second["provenance"])
        self.assertNotIn("checkpointRevision", second["provenance"])
        self.assertEqual(second["provenance"]["checkpointMetadataSha256"], hashlib.sha256((self.directory / "_METADATA").read_bytes()).hexdigest())

    def test_static_failures_and_absent_gpu_prevent_model_loading(self) -> None:
        (self.directory / "manifest.ocdbt").unlink()
        with self.assertRaisesRegex(ValueError, "manifest.ocdbt"):
            self.runner()
        (self.directory / "manifest.ocdbt").write_bytes(b"SYNTHETIC TEST")
        self.annotations["gtf"].write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "annotation"):
            self.runner()
        self.annotations["gtf"].write_bytes(b"SYNTHETIC TEST")
        self.devices.return_value = [SimpleNamespace(platform="cpu")]
        with self.assertRaisesRegex(ValueError, "No JAX GPU"):
            self.runner()
        self.create_model.assert_not_called()

    def test_cli_wrapper_uses_the_runner_and_existing_writer_without_changing_file_contract(self) -> None:
        source = {"fixtureNotice": "Synthetic wrapper spy only"}
        runner = Mock(); runner.predict.return_value = source
        output = self.directory / "analysis.json"
        with patch("run_dnm1.ModelRunner", return_value=runner) as constructor, patch("run_dnm1.write_result_files", return_value=(self.directory / "analysis.source-result.json", 2)) as writer, patch("builtins.print"):
            predict(self.directory, self.directory / "reference.fa", output, "Synthetic cells", 32768, VARIANTS[1], (JUNCTION_OUTPUT,), **self.annotations)
        constructor.assert_called_once_with(self.directory, self.directory / "reference.fa", **self.annotations)
        runner.predict.assert_called_once_with("Synthetic cells", 32768, VARIANTS[1], (JUNCTION_OUTPUT,))
        writer.assert_called_once_with(source, load_descriptor(VARIANTS[1]), output)


if __name__ == "__main__":
    unittest.main()
