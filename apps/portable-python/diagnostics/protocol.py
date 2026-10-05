from __future__ import annotations

import base64
import json
from typing import Any

from ipc.framing import FrameError, encode_frame, read_frame

MAX_LIMIT = 500
DEFAULT_LIMIT = 256


def decode_cursor(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, int) and not isinstance(value, bool):
        return value if value >= 0 else None
    if not isinstance(value, str) or len(value) > 256:
        return None
    try:
        padded = value + "=" * ((4 - len(value) % 4) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        if (
            not isinstance(decoded, dict)
            or decoded.get("v") != 1
            or decoded.get("source") != "diagnostics.jsonl"
            or not isinstance(decoded.get("index"), int)
            or decoded["index"] < 0
        ):
            return None
        return int(decoded["index"])
    except (ValueError, TypeError, UnicodeError, json.JSONDecodeError):
        return None


def parse_snapshot_request(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise FrameError("diagnostics payload must be an object")
    limit = payload.get("limit", DEFAULT_LIMIT)
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > MAX_LIMIT:
        raise FrameError("diagnostics limit out of range")
    cursor = payload.get("cursor")
    decoded_cursor = decode_cursor(cursor)
    if cursor is not None and decoded_cursor is None:
        raise FrameError("diagnostics cursor out of range")
    levels = payload.get("levels")
    components = payload.get("components")
    if levels is not None and (not isinstance(levels, list) or any(not isinstance(item, str) for item in levels)):
        raise FrameError("diagnostics levels invalid")
    if components is not None and (not isinstance(components, list) or any(not isinstance(item, str) for item in components)):
        raise FrameError("diagnostics components invalid")
    return {
        "limit": limit,
        "cursor": decoded_cursor,
        "levels": levels,
        "components": components,
    }


def encode_request(request_id: str, token: str, **payload: Any) -> bytes:
    return encode_frame({
        "type": "request",
        "requestId": request_id,
        "method": "diagnostics.snapshot",
        "payload": {"token": token, **payload},
    })


def encode_response(request_id: str, result: Any) -> bytes:
    return encode_frame({"type": "response", "requestId": request_id, "ok": True, "result": result})


def encode_error(request_id: str, code: str, message: str) -> bytes:
    return encode_frame({"type": "response", "requestId": request_id, "ok": False, "error": {"code": code, "message": message}})


def read_request(file: Any) -> dict[str, Any] | None:
    return read_frame(file)
