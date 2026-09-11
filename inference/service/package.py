"""Create an allowlisted source bundle, excluding credentials, weights and generated results."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[2]
PREFIX = "helix-alphagenome-service-corrected/"
FILES = (
    "inference/run_dnm1.py", "inference/track_export.py", "inference/junction_export.py",
    "inference/README.md", "inference/service/__init__.py", "inference/service/app.py",
    "inference/service/contract.py", "inference/service/engine.py", "inference/service/client.py",
    "inference/service/requirements.txt", "inference/service/README.md", "inference/service/openapi.json",
    "data/reference/dnm1-variants.json", "data/reference/README.md", "docs/higgsfield-gpu-execute.txt",
)


def build(output: Path) -> tuple[int, str]:
    """Package a clean committed source tree exclusively; return file count and archive SHA-256."""
    dirty = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True)
    if dirty.strip():
        raise ValueError("Commit the reviewed source before packaging; the repository must be clean.")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    entries = {name: (ROOT / name).read_bytes() for name in FILES}
    entries["README.md"] = (
        "# Corrected Helix AlphaGenome service\n\n"
        "Start with inference/service/README.md and docs/higgsfield-gpu-execute.txt.\n\n"
        "This archive contains the reviewed runtime source and exact-variant descriptors. "
        "It contains no weights, credentials, generated predictions or website frontend. "
        "Offline tests run in the full repository; this source bundle does not include that test harness.\n\n"
        f"Source: https://github.com/Mukhsin0508/helix-dna-lab/tree/{revision}\n\n"
        "No real GPU run or live endpoint was verified in this task. "
        "Do not treat packaged source as a successful model deployment.\n"
    ).encode()
    entries["DELIVERY-STATUS.json"] = (json.dumps({
        "schemaVersion": 1, "sourceCommit": revision, "status": "source_prepared_offline_tested",
        "executionEvidence": "Offline validation only. No GPU inference performed in this task.",
        "liveEndpoint": None, "weightsIncluded": False, "credentialsIncluded": False,
        "supersedesServiceSourceZipSha256": "2b4d1ce4c5f90f0674a4d49ac7574ad03e56caabea296415141c99f1c3cc551c",
    }, indent=2) + "\n").encode()
    manifest = {name: {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                for name, content in entries.items()}
    entries["SHA256SUMS.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    created = False
    try:
        with output.open("xb") as handle:
            created = True
            with ZipFile(handle, "w", compression=ZIP_DEFLATED) as archive:
                for name, content in sorted(entries.items()):
                    info = ZipInfo(PREFIX + name, date_time=(2026, 9, 11, 0, 0, 0))
                    info.compress_type = ZIP_DEFLATED
                    info.external_attr = 0o100644 << 16
                    archive.writestr(info, content)
        with ZipFile(output) as archive:
            if archive.testzip() is not None or len(archive.namelist()) != len(entries):
                raise ValueError("Archive integrity check failed.")
            for name, expected in manifest.items():
                actual = archive.read(PREFIX + name)
                if len(actual) != expected["bytes"] or hashlib.sha256(actual).hexdigest() != expected["sha256"]:
                    raise ValueError("Archive checksum mismatch.")
    except BaseException:
        if created:
            output.unlink(missing_ok=True)
        raise
    return len(entries), hashlib.sha256(output.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    count, digest = build(args.output.resolve())
    print(f"Verified {count} archive files. SHA-256: {digest}\n{args.output.resolve()}")


if __name__ == "__main__":
    main()
