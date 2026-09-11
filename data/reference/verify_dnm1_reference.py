#!/usr/bin/env python3
"""Verify two exact DNM1 SNVs with bounded reads of the official reference."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TypeAlias
from urllib.request import Request, urlopen


FASTA_URL = (
    "https://storage.googleapis.com/alphagenome/reference/gencode/hg38/"
    "GRCh38.p13.genome.fa"
)
INDEX_URL = FASTA_URL + ".fai"
INDEX_SHA256 = "9293fb33f63b7f09d8fadc055d78e401d07c76de0211243fba778780ff836ff9"
CLIENT_REVISION = "aa6fc8f6faadcb8c910fa2b85b57386fbd5c7b5d"
CLIENT_URL = (
    "https://raw.githubusercontent.com/google-deepmind/alphagenome/"
    f"{CLIENT_REVISION}/src/alphagenome/data/genome.py"
)
CLIENT_SHA256 = "4c297b2dde8f751c62211a1295ec243280eff412255b915cdf13c411b5168b61"
CLIENT_COMMITTED_AT = "2026-09-08T10:35:56Z"
INPUT_WIDTH = 1_048_576
DISPLAY_WIDTH = 41
POSITIONS = (128_225_994, 128_226_027)

Json: TypeAlias = str | int | float | bool | None | list["Json"] | dict[str, "Json"]


@dataclass(frozen=True)
class Interval:
    """A zero-based, half-open genomic interval on the forward reference."""

    start: int
    end: int

    @property
    def width(self) -> int:
        return self.end - self.start


@dataclass(frozen=True)
class FastaIndex:
    chromosome: str
    length: int
    offset: int
    line_bases: int
    line_bytes: int

    def byte_offset(self, base_offset: int) -> int:
        """Return the FASTA byte offset for a zero-based chromosome position."""
        return (
            self.offset
            + base_offset // self.line_bases * self.line_bytes
            + base_offset % self.line_bases
        )


@dataclass(frozen=True)
class Retrieved:
    body: bytes
    etag: str
    generation: str
    last_modified: str
    content_range: str

    def metadata(self) -> dict[str, Json]:
        """Return nonsensitive HTTP provenance without the response body."""
        return {
            "etag": self.etag,
            "generation": self.generation,
            "lastModified": self.last_modified,
            "contentRange": self.content_range or None,
            "retrievedBytes": len(self.body),
            "retrievedBytesSha256": sha256(self.body),
        }


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def retrieve(
    url: str,
    limit: int,
    byte_range: tuple[int, int] | None = None,
    etag: str | None = None,
) -> Retrieved:
    """Read at most limit+1 bytes; reject ignored Range before reading a body."""
    headers = {"Accept-Encoding": "identity", "User-Agent": "Helix-reference-verifier/1"}
    if byte_range is not None:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
    if etag is not None:
        headers["If-Match"] = etag
    with urlopen(Request(url, headers=headers), timeout=60) as response:
        expected_status = 206 if byte_range is not None else 200
        if response.status != expected_status:
            raise RuntimeError(f"Expected HTTP {expected_status}; received {response.status}: {url}")
        content_range = response.headers.get("Content-Range", "")
        if byte_range is not None:
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
            if match is None or (int(match[1]), int(match[2])) != byte_range:
                raise RuntimeError(f"Unexpected Content-Range: {content_range}")
        content_length = response.headers.get("Content-Length")
        if content_length is not None and int(content_length) > limit:
            raise RuntimeError(f"Response exceeds the {limit}-byte limit; body not read")
        body = response.read(limit + 1)
        if len(body) > limit:
            raise RuntimeError(f"Response exceeds the {limit}-byte limit")
        if byte_range is not None and len(body) != byte_range[1] - byte_range[0] + 1:
            raise RuntimeError("Truncated FASTA byte range")
        return Retrieved(
            body=body,
            etag=response.headers.get("ETag", ""),
            generation=response.headers.get("x-goog-generation", ""),
            last_modified=response.headers.get("Last-Modified", ""),
            content_range=content_range,
        )


def parse_index(data: bytes) -> FastaIndex:
    """Read the unique chr9 entry from the official five-column FASTA index."""
    entries = [line.split("\t") for line in data.decode("ascii").splitlines()]
    matches = [entry for entry in entries if entry[0] == "chr9"]
    if len(matches) != 1 or len(matches[0]) != 5:
        raise ValueError("Expected exactly one five-column chr9 FASTA index entry")
    chromosome, length, offset, line_bases, line_bytes = matches[0]
    index = FastaIndex(chromosome, int(length), int(offset), int(line_bases), int(line_bytes))
    if not (index.length > 0 and index.offset > 0 and 0 < index.line_bases < index.line_bytes):
        raise ValueError("Invalid FASTA index geometry")
    return index


def resized_reference_interval(position: int, reference: str, width: int) -> Interval:
    """Independently reproduce the pinned client's unstranded Variant resize."""
    start = position - 1
    end = start + len(reference)
    # genome.py: Variant.start/end/reference_interval, lines 712-723;
    # Interval.center, lines 335-339; resize_inplace, lines 438-444.
    center = (start + end) // 2 + (end - start) % 2
    return Interval(center - (width + 1) // 2, center + width // 2)


def retrieve_sequence(
    index: FastaIndex, interval: Interval, etag: str | None
) -> tuple[bytes, Retrieved]:
    """Fetch only interval bytes, preserving forward-reference orientation."""
    if not (0 <= interval.start < interval.end <= index.length):
        raise ValueError("Interval is outside chr9; this verifier does not pad")
    first = index.byte_offset(interval.start)
    last = index.byte_offset(interval.end - 1)
    retrieved = retrieve(FASTA_URL, last - first + 1, (first, last), etag)
    sequence = retrieved.body.replace(b"\r", b"").replace(b"\n", b"").upper()
    if len(sequence) != interval.width or not set(sequence).issubset(b"ACGTN"):
        raise ValueError("FASTA interval has an unexpected length or alphabet")
    if not retrieved.etag or (etag is not None and retrieved.etag != etag):
        raise ValueError("FASTA object identity missing or changed between reads")
    return sequence, retrieved


def verify() -> dict[str, Json]:
    """Return verified descriptors; do not retain or execute downloaded source."""
    source = retrieve(CLIENT_URL, 100_000)
    if sha256(source.body) != CLIENT_SHA256:
        raise ValueError("Pinned official client source checksum mismatch")
    index_response = retrieve(INDEX_URL, 100_000)
    if sha256(index_response.body) != INDEX_SHA256:
        raise ValueError("Official reference index changed; review before updating the pin")
    index = parse_index(index_response.body)
    variants: list[Json] = []
    contexts: list[bytes] = []
    fasta_etag: str | None = None
    fasta_generation: str | None = None
    for position in POSITIONS:
        input_interval = resized_reference_interval(position, "G", INPUT_WIDTH)
        display_interval = resized_reference_interval(position, "G", DISPLAY_WIDTH)
        context, full_response = retrieve_sequence(index, input_interval, fasta_etag)
        fasta_etag = full_response.etag
        if fasta_generation is None:
            fasta_generation = full_response.generation
        if full_response.generation != fasta_generation:
            raise ValueError("FASTA generation changed between variant reads")
        display, display_response = retrieve_sequence(index, display_interval, fasta_etag)
        reference_offset = position - 1 - input_interval.start
        display_offset = position - 1 - display_interval.start
        crop_start = display_interval.start - input_interval.start
        if context[reference_offset : reference_offset + 1] != b"G" or display[display_offset : display_offset + 1] != b"G":
            raise ValueError(f"Declared REF G does not match GRCh38.p13 at chr9:{position}")
        if display != context[crop_start : crop_start + DISPLAY_WIDTH]:
            raise ValueError("Independent display range does not match the full context crop")
        contexts.append(context)
        variants.append({
            "id": f"chr9:{position}:G>A",
            "chromosome": "chr9",
            "position": position,
            "reference": "G",
            "alternate": "A",
            "inputInterval": {"start": input_interval.start, "end": input_interval.end},
            "displayInterval": {"start": display_interval.start, "end": display_interval.end},
            "displayReference": display.decode("ascii"),
            "contextSha256": sha256(context),
            "displaySha256": sha256(display),
            "verifiedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "verification": {
                "referenceMatches": True,
                "inputLength": len(context),
                "displayLength": len(display),
                "referenceOffset0Based": reference_offset,
                "displayReferenceOffset0Based": display_offset,
                "contextNCount": context.count(b"N"),
                "displayNCount": display.count(b"N"),
                "paddingBases": 0,
                "displayMatchesIndependentFullContextCrop": True,
                "fullContextRequest": full_response.metadata(),
                "displayRequest": display_response.metadata(),
            },
        })
    distance = POSITIONS[1] - POSITIONS[0]
    if contexts[0][distance:] != contexts[1][:-distance]:
        raise ValueError("The two independently retrieved full contexts disagree in their overlap")
    return {
        "schemaVersion": 1,
        "reference": {
            "url": FASTA_URL,
            "indexUrl": INDEX_URL,
            "indexSha256": INDEX_SHA256,
            "assembly": "GRCh38",
            "version": "GRCh38.p13",
            "source": "Official AlphaGenome GENCODE reference distribution",
            "indexEntry": {
                "chromosome": index.chromosome,
                "length": index.length,
                "offset": index.offset,
                "line_bases": index.line_bases,
                "line_bytes": index.line_bytes,
            },
            "indexRequest": index_response.metadata(),
            "fastaEtag": fasta_etag,
            "fastaGeneration": fasta_generation,
        },
        "coordinateSystem": {
            "variant": "1-based",
            "interval": "0-based half-open",
            "orientation": "forward reference (unstranded); not gene-oriented reverse complement",
        },
        "clientSource": {
            "revision": CLIENT_REVISION,
            "url": CLIENT_URL,
            "sha256": CLIENT_SHA256,
            "committedAt": CLIENT_COMMITTED_AT,
            "sourceBytes": len(source.body),
            "variantSemanticsLines": "712-723",
            "centerSemanticsLines": "335-339",
            "resizeSemanticsLines": "438-444",
            "method": "Source inspected and checksummed; formulas independently implemented; source never executed",
        },
        "sequenceChecksumEncoding": "SHA-256 of uppercase ASCII bases with FASTA line breaks removed; no trailing newline",
        "inputLength": INPUT_WIDTH,
        "displayLength": DISPLAY_WIDTH,
        "crossVariantVerification": {
            "distanceBases": distance,
            "overlapLength": INPUT_WIDTH - distance,
            "independentlyRetrievedContextsAgree": True,
        },
        "scope": "Reference-sequence verification only. No model predictions, Atlas scores, GPU calls, or biological validation.",
        "variants": variants,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("dnm1-variants.json"))
    args = parser.parse_args()
    result = verify()
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"Verified both DNM1 references; wrote {args.output}")


if __name__ == "__main__":
    main()
