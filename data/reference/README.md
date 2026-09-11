# Verified DNM1 reference contexts

`dnm1-variants.json` keeps two distinct variants: the earlier delivery's `chr9:128225994:G>A` and the requested `chr9:128226027:G>A`. Both were independently verified on 11 September 2026 UTC against the official AlphaGenome distribution of GRCh38.p13. This is reference-sequence provenance, not a model result or an experimentally observed variant.

| Exact variant | 1,048,576-base input interval | 41-base display interval |
| --- | --- | --- |
| chr9:128225994:G>A | [127701706, 128750282) | [128225973, 128226014) |
| chr9:128226027:G>A | [127701739, 128750315) | [128226006, 128226047) |

Variant positions are **1-based**. Intervals are **0-based and half-open** on the forward reference strand. The intervals independently reproduce `genome.Variant(...).reference_interval.resize(width)` from the [pinned official client source](https://github.com/google-deepmind/alphagenome/blob/aa6fc8f6faadcb8c910fa2b85b57386fbd5c7b5d/src/alphagenome/data/genome.py). For an unstranded interval, `center = (start + end) // 2 + (end - start) % 2`, then the resized bounds are `center - (width + 1) // 2` and `center + width // 2`. The declared reference G is at zero-based offset **524287** in each full context and **20** in each display. Do not assume the even-width input puts it at offset 524288.

The verifier fetches the small official [FASTA index](https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa.fai), then four exact byte ranges from its [FASTA](https://storage.googleapis.com/alphagenome/reference/gencode/hg38/GRCh38.p13.genome.fa). It requires HTTP 206 and matching ranges before reading a FASTA response body. An ignored Range cannot trigger a full-genome download. Subsequent reads require the same ETag. The four FASTA response bodies total 2,132,188 bytes; full contexts are verified in memory and are not stored.

Each independent 41-base fetch matches its full-context crop. Both reference alleles match G, with no Ns or padding. The two separately fetched full contexts also agree across their 1,048,543-base overlap. DNA hashes use uppercase ASCII bases without FASTA line breaks or a trailing newline; raw HTTP-body hashes are recorded separately. The JSON also records the index checksum, client revision and source checksum, intervals, HTTP object generation, and verification time.

Reproduce with Python 3.10+ and its standard library:

```sh
python3 data/reference/verify_dnm1_reference.py
```

Use `--output /tmp/dnm1-variants.json` to preserve the checked-in verification timestamps. The script checksums the pinned official client source without executing it. It requires no credentials, GPU, model package, or attachment execution. A changed index/source checksum fails for review instead of silently changing the reference provenance.
