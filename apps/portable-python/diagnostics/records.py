from __future__ import annotations

import hashlib
import re
import time
from typing import Any

LEVELS = ("debug", "info", "warn", "error", "critical")
LEVEL_RANK = {level: index for index, level in enumerate(LEVELS)}
SENSITIVE_KEYS = {
    "identityseedhex",
    "identityseed",
    "dpapi",
    "privatekey",
    "secretkey",
    "signingseed",
    "credential",
    "password",
    "token",
    "joinc code",
    "joincode",
    "chattext",
    "text",
    "content",
}
PATH_KEYS = {"path", "absolutepath", "physicalpath", "partpath", "backuppath", "targetpath", "savedto", "relativepath", "filename", "name"}
PEER_KEYS = {"peerid", "deviceid", "remotehost", "host", "ip", "ipaddress"}
ABSOLUTE_PATH_RE = re.compile(r"(?:[A-Za-z]:[\\/]|\\\\)[^\r\n\t\"']+")
IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
HEX_ID_RE = re.compile(r"\b[0-9a-fA-F]{64}\b")


def stable_ref(value: Any) -> str:
    text = str(value or "")
    return hashlib.sha256(text.encode("utf-8", "ignore")).hexdigest()[:16] if text else ""


def _truncate(value: Any, limit: int) -> Any:
    if isinstance(value, str):
        return value if len(value) <= limit else value[: limit - 1] + "…"
    return value


def redact(value: Any, key: str | None = None, depth: int = 0) -> Any:
    if depth > 5:
        return "[TRUNCATED]"
    normalized = (key or "").lower().replace(" ", "")
    if normalized in SENSITIVE_KEYS:
        return "[REDACTED]"
    if normalized in PATH_KEYS:
        return "[PATH]"
    if normalized in PEER_KEYS:
        return stable_ref(value) or "[REDACTED]"
    if isinstance(value, dict):
        return {str(k): redact(v, str(k), depth + 1) for k, v in list(value.items())[:64]}
    if isinstance(value, (list, tuple)):
        return [redact(item, key, depth + 1) for item in list(value)[:64]]
    if isinstance(value, str):
        text = ABSOLUTE_PATH_RE.sub("[PATH]", value)
        text = IP_RE.sub("[IP]", text)
        text = HEX_ID_RE.sub(lambda match: stable_ref(match.group(0)), text)
        return _truncate(text, 2048)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return _truncate(str(value), 512)


def make_record(
    level: str,
    source: str,
    component: str,
    event: str,
    message: str = "",
    **fields: Any,
) -> dict[str, Any]:
    normalized_level = str(level or "error").lower()
    if normalized_level not in LEVEL_RANK:
        normalized_level = "error"
    record: dict[str, Any] = {
        "schemaVersion": 1,
        "sessionId": "",
        "tsMs": int(time.time() * 1000),
        "level": normalized_level,
        "source": _truncate(str(source or "shell"), 64),
        "component": _truncate(str(component or "shell"), 64),
        "event": _truncate(str(event or "event"), 128),
        "message": redact(str(message or ""), "message"),
    }
    for key, value in fields.items():
        if value is None:
            continue
        record[key] = redact(value, key)
    return record


def record_from_mapping(value: Any, source: str = "core") -> dict[str, Any]:
    if not isinstance(value, dict):
        return make_record("error", source, "core", "stderr.invalid", str(value))
    level = str(value.get("level") or "error").lower()
    return make_record(
        level,
        str(value.get("source") or source),
        str(value.get("component") or "core"),
        str(value.get("event") or "core.event"),
        str(value.get("message") or ""),
        **{str(k): v for k, v in value.items() if k not in {"schemaVersion", "tsMs", "level", "source", "component", "event", "message"}},
    )


def classify_raw_line(line: str) -> str:
    lowered = line.lower()
    if any(token in lowered for token in ("fatal", "critical", "error", "exception", "unhandled", "failed", "timeout")):
        return "error"
    return "debug"
