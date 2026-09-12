"""Read one bounded JSON request on stdin; emit a result envelope on stdout."""
from __future__ import annotations

import argparse
import contextlib
import os
from pathlib import Path
import sys
import tempfile

from .contract import INPUT_LIMIT, PAYLOAD_LIMIT, HostedError, HostedRequest, JsonObject, encoded, strict_json
from .runner import run_prediction

class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # Do not echo unknown command-line arguments into logs.
        raise HostedError('invalid_request')


def _write_new(path: Path, text: str) -> None:
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
            temporary = stream.name
            stream.write(text + '\n'); stream.flush(); os.fsync(stream.fileno())
        os.link(temporary, path)  # Atomic, refuses an existing destination.
    except Exception as cause:
        raise HostedError('output_unavailable') from cause
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    try:
        parser = _Parser(description='Read a human GRCh38 SNV request from JSON stdin. Uses ALPHAGENOME_API_KEY from the environment; no GPU required locally. An outer 180-second process deadline is required.')
        parser.add_argument('--output', type=Path, help='Optional new file for the same result envelope; never overwrites.')
        options = parser.parse_args(argv)
        if options.output and (options.output.exists() or not options.output.parent.is_dir()):
            raise HostedError('output_unavailable')
        raw = sys.stdin.buffer.read(INPUT_LIMIT + 1)
        if not raw or len(raw) > INPUT_LIMIT:
            raise HostedError('invalid_request')
        try:
            request = HostedRequest.parse(strict_json(raw.decode('utf-8')))
        except UnicodeError as cause:
            raise HostedError('invalid_request') from cause
        # Keep dependency diagnostics out of both the JSON protocol and application logs.
        with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = run_prediction(request)
        text = encoded(result, PAYLOAD_LIMIT * 3)
        if options.output:
            _write_new(options.output, text)
        sys.stdout.write(text + '\n')
        return 0
    except HostedError as cause:
        error: JsonObject = {'error': {'code': cause.code, 'message': str(cause)}}
    except Exception:
        error = {'error': {'code': 'service_unavailable', 'message': 'The hosted prediction could not be completed. No analysis was created.'}}
    sys.stdout.write(encoded(error) + '\n')
    return 1

if __name__ == '__main__':
    raise SystemExit(main())
