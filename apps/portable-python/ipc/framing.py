"""Framed IPC codec: uint32_le length + UTF-8 JSON, cap 1 MiB."""

import json
import struct

MAX_FRAME = 1024 * 1024
_HEADER = struct.Struct("<I")


class FrameError(Exception):
    pass


def encode_frame(payload) -> bytes:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_FRAME:
        raise FrameError("frame too large")
    return _HEADER.pack(len(body)) + body


def read_exactly(file, n: int):
    """Exact-count read on a blocking binary pipe file. b'' on clean EOF."""
    chunks = []
    got = 0
    while got < n:
        part = file.read(n - got)
        if not part:
            if got == 0:
                return b""
            raise EOFError("unexpected eof inside frame")
        chunks.append(part)
        got += len(part)
    return b"".join(chunks)


def read_frame(file):
    header = read_exactly(file, 4)
    if not header:
        return None
    (length,) = _HEADER.unpack(header)
    if length == 0 or length > MAX_FRAME:
        raise FrameError(f"bad frame length {length}")
    body = read_exactly(file, length)
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        # Framing is a stream contract: once a length-prefixed payload cannot
        # be decoded, the connection is no longer trustworthy. Normalize decode
        # failures into FrameError so the transport lifecycle can tear down the
        # Core instead of silently losing only the reader thread.
        raise FrameError("invalid UTF-8/JSON frame") from exc
    if not isinstance(payload, dict):
        # Every protocol frame is an object. Valid JSON with a scalar/array body
        # would otherwise fail later in CoreClient (frame.get) outside the
        # transport-error path and could again strand the child process.
        raise FrameError("frame payload must be a JSON object")
    return payload
