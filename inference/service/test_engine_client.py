"""Offline integration with explicitly synthetic results; no network, GPU or checkpoint."""

from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.request import Request

if importlib.util.find_spec("pydantic") is None:
    raise unittest.SkipTest("Install inference/service/requirements.txt for service adapter tests.")

from service.client import Client, NoRedirects, checked_base_url, run, save_completed_job, strict_json
from service.contract import PredictionRequest
from service.engine import Engine, input_paths
from test_runner import synthetic_source as positional_source
from test_junction_export import synthetic_source as junction_source
from track_export import VARIANTS


ROOT = Path(__file__).resolve().parents[2]
TEST_BIOSAMPLE = "Synthetic test cells"


def request(variant: str = VARIANTS[1], junctions: bool = False) -> dict:
    return PredictionRequest.model_validate({"requestId": "synthetic-offline-only", "variantId": variant,
        "biosample": TEST_BIOSAMPLE, "outputs": ["SPLICE_JUNCTIONS"] if junctions else ["RNA_SEQ"]}).model_dump()


def source_for_call(*, biosample: str, crop_bp: int, variant_id: str, requested_outputs: tuple[str, ...]) -> dict:
    source = junction_source(variant_id) if requested_outputs == ("SPLICE_JUNCTIONS",) else positional_source(variant_id)
    source["schemaVersion"] = 2
    source["outputs"] = [next(value for value in source["outputs"] if value["outputType"] == name) for name in requested_outputs]
    if source["biosample"] != biosample or source["outputInterval"]["end"] - source["outputInterval"]["start"] != crop_bp:
        raise ValueError("Synthetic test request mismatch.")
    return source


def prepared_engine() -> Engine:
    engine = Engine()
    engine._runner = Mock(predict=Mock(side_effect=source_for_call))
    engine._metadata = {"biosample": TEST_BIOSAMPLE}
    return engine


class EngineClientTests(unittest.TestCase):
    def test_adapter_alternates_exact_variants_and_keeps_raw_bytes(self) -> None:
        engine = prepared_engine()
        for variant in (VARIANTS[1], VARIANTS[0], VARIANTS[1]):
            payload = request(variant)
            result = engine.predict(payload)
            source = json.loads(result["sourceResultJson"])
            self.assertEqual(source["variant"], variant)
            self.assertEqual(source["serviceRequestId"], payload["requestId"])
            self.assertEqual(result["analysis"]["provenance"]["inference"]["variant"], variant)
            self.assertEqual(hashlib.sha256(result["sourceResultJson"].encode()).hexdigest(), result["sourceResultSha256"])
            engine._runner.predict.assert_called_with(biosample=TEST_BIOSAMPLE, crop_bp=41,
                variant_id=variant, requested_outputs=("RNA_SEQ",))
        self.assertEqual(engine._runner.predict.call_count, 3)

    def test_adapter_refuses_uninitialized_wrong_biosample_and_mislabeled_result(self) -> None:
        with self.assertRaises(RuntimeError):
            Engine().predict(request())
        engine = prepared_engine()
        wrong = request(); wrong["biosample"] = "Different test cells"
        with self.assertRaises(ValueError):
            engine.predict(wrong)
        engine._runner.predict.assert_not_called()
        engine._runner.predict.side_effect = None
        engine._runner.predict.return_value = source_for_call(biosample=TEST_BIOSAMPLE, crop_bp=41,
            variant_id=VARIANTS[0], requested_outputs=("RNA_SEQ",))
        with self.assertRaises(ValueError):
            engine.predict(request(VARIANTS[1]))

    def test_boot_loads_once_and_uses_real_metadata_boundary(self) -> None:
        records = {item["outputType"]: item["reference"]["metadata"] for item in positional_source()["outputs"]}
        records["SPLICE_JUNCTIONS"] = junction_source()["outputs"][0]["reference"]["metadata"]
        runner = Mock(output_metadata_records=Mock(return_value=records))
        with patch.dict("os.environ", {"HELIX_BIOSAMPLE": TEST_BIOSAMPLE}), \
             patch("service.engine.input_paths", return_value={}), \
             patch("service.engine.ModelRunner", return_value=runner) as factory:
            engine = Engine()
            first = engine.boot()
            first["biosample"] = "External mutation"
            second = engine.boot()
            self.assertEqual(second["biosample"], TEST_BIOSAMPLE)
            self.assertEqual(second["supportedVariants"], list(VARIANTS))
            self.assertEqual(second["trackMetadata"]["RNA_SEQ"], records["RNA_SEQ"])
            factory.assert_called_once()
            runner.predict.assert_not_called()

    def test_missing_paths_never_start_model(self) -> None:
        with patch.dict("os.environ", {}, clear=True), patch("service.engine.ModelRunner") as factory:
            with self.assertRaisesRegex(ValueError, "HELIX_CHECKPOINT_DIR"):
                input_paths()
            with self.assertRaises(ValueError):
                Engine().boot()
            factory.assert_not_called()

    def test_downloaded_artifacts_import_into_the_actual_lab_for_both_modes(self) -> None:
        engine = prepared_engine()
        with tempfile.TemporaryDirectory() as temporary:
            for index, junctions in enumerate((False, True)):
                payload = request(junctions=junctions)
                result = engine.predict(payload)
                target = Path(temporary) / str(index)
                analysis, source = save_completed_job({"status": "completed", "result": result}, payload, target)
                self.assertEqual(source.read_bytes(), result["sourceResultJson"].encode())
                self.assertEqual(json.loads(analysis.read_bytes())["provenance"]["artifact"]["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
                self.assertEqual(analysis.stat().st_mode & 0o777, 0o600)
                expected = "junctions" if junctions else "tracks"
                script = "import{readFileSync}from'node:fs';import{parseDatasetJSON}from'./shared/analysis-import.ts';const d=parseDatasetJSON(readFileSync(process.argv[1],'utf8'));if(d.kind!==process.argv[2]||!d.rows.length)throw Error('Import failed');"
                subprocess.run([str(ROOT / "node_modules/.bin/tsx"), "-e", script, str(analysis), expected], cwd=ROOT, check=True, capture_output=True)

    def test_rejected_or_partial_output_never_leaves_artifacts(self) -> None:
        payload = request(); result = prepared_engine().predict(payload)
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "result"
            forged = deepcopy(result); forged["analysis"]["rows"][0]["alternate"] = 9999
            with self.assertRaises(ValueError):
                save_completed_job({"status": "completed", "result": forged}, payload, target)
            self.assertFalse(target.exists())
            with self.assertRaises(ValueError):
                save_completed_job({"status": "queued"}, payload, target)
            original = Path.open
            def injected(path, mode="r", *args, **kwargs):
                if path.name == "source-result.json" and mode == "xb":
                    raise OSError("Injected failure")
                return original(path, mode, *args, **kwargs)
            with patch.object(Path, "open", injected), self.assertRaises(OSError):
                save_completed_job({"status": "completed", "result": result}, payload, target)
            self.assertFalse(target.exists())
            target.mkdir(); (target / "existing").write_text("untouched")
            with self.assertRaises(FileExistsError):
                save_completed_job({"status": "completed", "result": result}, payload, target)
            self.assertEqual((target / "existing").read_text(), "untouched")

    def test_client_requires_https_and_never_redirects_credentials(self) -> None:
        for url in ("http://example.test", "https://user:pass@example.test", "https://example.test/?token=secret",
                    "https://example.test/#secret", "https://example.test:invalid", "https://example.test/ space"):
            with self.assertRaises(ValueError):
                checked_base_url(url)
        self.assertEqual(checked_base_url("https://example.test/gpu/"), "https://example.test/gpu")
        req = Request("https://example.test", headers={"Authorization": "Bearer synthetic-test-only"})
        self.assertIsNone(NoRedirects().redirect_request(req, None, 302, "Found", {}, "https://elsewhere.test"))
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'[]'):
            with self.assertRaises(ValueError):
                strict_json(raw)

    def test_poll_checks_job_identity_before_saving(self) -> None:
        client = Mock(spec=Client)
        job = "00000000-0000-0000-0000-000000000001"
        client.request.side_effect = [{"jobId": job, "status": "queued"},
            {"jobId": "00000000-0000-0000-0000-000000000002", "status": "completed"}]
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "result"
            with self.assertRaisesRegex(ValueError, "different job"):
                run(client, request(), target, 1)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
