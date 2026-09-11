"""Submit an exact private GPU request and save its validated result for website import."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from run_dnm1 import SUPPORTED_OUTPUT_TYPES
from track_export import OUTPUT_TYPES, VARIANTS, encoded_json
from service.contract import PredictionRequest, validate_result


RESPONSE_LIMIT = 6 * 1024 * 1024


class NoRedirects(HTTPRedirectHandler):
    """Never send a service bearer credential to a redirected destination."""

    def redirect_request(self, req: Request, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> None:
        return None


def checked_base_url(value: str) -> str:
    """Accept an HTTPS service origin/path without embedded credentials, query or fragment."""
    url = urlsplit(value)
    if (url.scheme != "https" or not url.hostname or url.username is not None
            or url.password is not None or url.query or url.fragment
            or any(character.isspace() for character in value)):
        raise ValueError("HELIX_GPU_API_URL must be an HTTPS URL without credentials, query or fragment.")
    # Validate a malformed port here, before a request or credential is constructed.
    _ = url.port
    return value.rstrip("/")


def strict_json(content: bytes) -> dict:
    """Parse bounded finite JSON objects without allowing duplicate keys."""
    def unique_pairs(pairs: list[tuple[str, Any]]) -> dict:
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Service response contains duplicate JSON keys.")
            result[key] = value
        return result
    def invalid_constant(value: str) -> None:
        raise ValueError("Service response contains nonfinite JSON.")
    if len(content) > RESPONSE_LIMIT:
        raise ValueError("Service response exceeds the 6 MiB limit.")
    value = json.loads(content, parse_constant=invalid_constant, object_pairs_hook=unique_pairs)
    if not isinstance(value, dict):
        raise ValueError("Service response must be a JSON object.")
    return value


class Client:
    """Small synchronous operator client; token remains in memory and private environment."""

    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = checked_base_url(base_url)
        if not 32 <= len(token) <= 512 or any(ord(char) < 33 or ord(char) > 126 for char in token):
            raise ValueError("HELIX_GPU_SERVICE_TOKEN must contain 32–512 printable ASCII characters.")
        self.token = token
        self.opener = build_opener(NoRedirects())

    def request(self, path: str, payload: dict | None = None) -> dict:
        """Return one validated JSON response; do not expose remote error bodies or follow redirects."""
        body = encoded_json(payload) if payload is not None else None
        request = Request(self.base_url + path, data=body,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json",
                "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=30) as response:
                if response.headers.get_content_type() != "application/json":
                    raise ValueError("Service returned a non-JSON response.")
                return strict_json(response.read(RESPONSE_LIMIT + 1))
        except HTTPError as error:
            raise ValueError(f"Service request failed with HTTP {error.code}; no result saved.") from None
        except (URLError, TimeoutError):
            raise ValueError("Service connection failed; retry with the same request ID.") from None


def save_completed_job(status: dict, request: dict, output_dir: Path) -> tuple[Path, Path]:
    """Validate a completed result against the exact request, then exclusively write its two artifacts."""
    if status.get("status") != "completed" or not isinstance(status.get("result"), dict):
        raise ValueError("A completed service job with its actual result is required.")
    result = validate_result(status["result"], request)
    analysis_bytes = encoded_json(result["analysis"])
    raw_bytes = result["sourceResultJson"].encode("utf-8")
    # No partially validated or preexisting directory is ever modified.
    output_dir.mkdir(mode=0o700, parents=False, exist_ok=False)
    try:
        for filename, content in (("analysis.json", analysis_bytes), ("source-result.json", raw_bytes)):
            with (output_dir / filename).open("xb") as handle:
                handle.write(content)
            (output_dir / filename).chmod(0o600)
    except BaseException:
        shutil.rmtree(output_dir)
        raise
    return output_dir / "analysis.json", output_dir / "source-result.json"


def run(client: Client, request: dict, output_dir: Path, wait_seconds: int) -> tuple[Path, Path]:
    """Submit once with idempotency, poll within a deadline and save only a verified completion."""
    if output_dir.exists() or not output_dir.parent.is_dir():
        raise ValueError("Use a new output directory inside an existing parent directory.")
    validated = PredictionRequest.model_validate(request).model_dump()
    receipt = client.request("/v1/predictions", validated)
    job_id = receipt.get("jobId")
    if not isinstance(job_id, str) or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", job_id):
        raise ValueError("Service returned an invalid job ID.")
    print(f"Job {job_id}; request {validated['requestId']}.")
    deadline = time.monotonic() + wait_seconds
    while True:
        status = client.request(f"/v1/predictions/{job_id}")
        if status.get("jobId") != job_id:
            raise ValueError("Service returned a different job ID.")
        if status.get("status") == "completed":
            return save_completed_job(status, validated, output_dir)
        if status.get("status") == "failed":
            raise ValueError("GPU job failed; inspect the authenticated service status. No result saved.")
        if status.get("status") not in ("queued", "running"):
            raise ValueError("Service returned an unknown job status.")
        if time.monotonic() >= deadline:
            raise ValueError("Polling deadline reached. The remote job may still run; retry with the same request ID.")
        time.sleep(min(2, max(0, deadline - time.monotonic())))


def main() -> int:
    """Return zero only after a completed, validated job is saved; never imply a GPU is provisioned."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request-id", required=True, help="Reuse this ID to recover a request after interruption")
    parser.add_argument("--variant", choices=VARIANTS, required=True)
    parser.add_argument("--biosample", default="glutamatergic neuron")
    parser.add_argument("--outputs", nargs="+", choices=SUPPORTED_OUTPUT_TYPES, default=list(OUTPUT_TYPES))
    parser.add_argument("--crop-bp", type=int)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--wait-seconds", type=int, default=600)
    args = parser.parse_args()
    try:
        if not 1 <= args.wait_seconds <= 3600:
            raise ValueError("--wait-seconds must be between 1 and 3600.")
        client = Client(os.environ.get("HELIX_GPU_API_URL", ""), os.environ.get("HELIX_GPU_SERVICE_TOKEN", ""))
        request = {"requestId": args.request_id, "variantId": args.variant,
            "biosample": args.biosample, "outputs": args.outputs}
        if args.crop_bp is not None:
            request["cropBp"] = args.crop_bp
        analysis, source = run(client, request, args.output_dir.resolve(), args.wait_seconds)
        print(f"Analysis: {analysis}\nExact raw result: {source}")
    except (ValueError, OSError, RecursionError):
        # Validation libraries and OS errors may echo a payload or local setting value.
        print("No result saved. Check the request, service status and private configuration; retain the same request ID for a retry.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
