from __future__ import annotations

import base64
import hmac
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from windows import pipes

from .protocol import encode_error, encode_response, parse_snapshot_request, read_request
from .recorder import DiagnosticsRecorder

REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def encode_cursor(index: int) -> str:
    payload = json.dumps({"v": 1, "source": "diagnostics.jsonl", "index": int(index)}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")


class DiagnosticsEndpoint:
    def __init__(self, data_root: str | os.PathLike[str], recorder: DiagnosticsRecorder) -> None:
        self.data_root = Path(data_root)
        self.recorder = recorder
        self.pipe_name = "PeerSync.Diagnostics.%d.%s" % (os.getpid(), secrets.token_hex(16))
        self.pipe_path = r"\\.\pipe\%s" % self.pipe_name
        self.descriptor_path = self.data_root / "runtime" / "diagnostics-endpoint.json"
        self._server = pipes.NamedPipeServer(
            self.pipe_path,
            self._handle_client,
            on_error=lambda error: recorder.log("error", "shell", "diagnostics", "endpoint.pipe.error", str(error)),
        )
        self._lock = threading.RLock()
        self._started_at_ms = int(time.time() * 1000)
        self._core_epoch = 0
        self._closed = False

    def start(self) -> None:
        with self._lock:
            if self._closed:
                raise RuntimeError("diagnostics endpoint is closed")
            self.descriptor_path.parent.mkdir(parents=True, exist_ok=True)
            token = secrets.token_urlsafe(48)
            descriptor = {
                "schemaVersion": 1,
                "pipeName": self.pipe_name,
                "token": token,
                "pid": os.getpid(),
                "startedAtMs": self._started_at_ms,
                "coreEpoch": self._core_epoch,
            }
            temporary = self.descriptor_path.with_suffix(".json.tmp")
            with temporary.open("w", encoding="utf-8", newline="") as handle:
                json.dump(descriptor, handle, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.descriptor_path)
            try:
                os.chmod(self.descriptor_path, 0o600)
            except OSError:
                pass
            self._server.start()
            self.recorder.start_periodic()

    def set_core_epoch(self, epoch: int) -> None:
        with self._lock:
            self._core_epoch = max(0, int(epoch))
            self._rewrite_descriptor()

    def _rewrite_descriptor(self) -> None:
        try:
            with self.descriptor_path.open("r", encoding="utf-8") as handle:
                descriptor = json.load(handle)
            descriptor["coreEpoch"] = self._core_epoch
            temporary = self.descriptor_path.with_suffix(".json.tmp")
            with temporary.open("w", encoding="utf-8", newline="") as handle:
                json.dump(descriptor, handle, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.descriptor_path)
        except (OSError, ValueError, TypeError):
            return

    def stop(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._server.stop()
        self.recorder.close()
        try:
            self.descriptor_path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass

    def _handle_client(self, file: Any) -> None:
        try:
            request = read_request(file)
            if not isinstance(request, dict):
                return
            request_id = request.get("requestId")
            method = request.get("method")
            payload = request.get("payload")
            if not isinstance(request_id, str) or not REQUEST_ID_RE.match(request_id):
                return
            if method != "diagnostics.snapshot" or not isinstance(payload, dict):
                file.write(encode_error(request_id, "INVALID_REQUEST", "unsupported diagnostics method"))
                return
            token = payload.get("token")
            if not isinstance(token, str) or not hmac.compare_digest(token, self._read_token()):
                file.write(encode_error(request_id, "UNAUTHORIZED", "diagnostics authentication failed"))
                return
            try:
                parsed = parse_snapshot_request({key: value for key, value in payload.items() if key != "token"})
                snapshot = self.recorder.snapshot(**parsed)
                next_cursor = snapshot.get("nextCursor")
                if isinstance(next_cursor, int):
                    snapshot["nextCursor"] = encode_cursor(next_cursor)
                self.recorder.write_snapshot(snapshot)
                file.write(encode_response(request_id, snapshot))
            except Exception:
                file.write(encode_error(request_id, "INVALID_REQUEST", "invalid diagnostics request"))
        except (OSError, ValueError, EOFError):
            return

    def _read_token(self) -> str:
        try:
            with self.descriptor_path.open("r", encoding="utf-8") as handle:
                value = json.load(handle)
            token = value.get("token")
            return token if isinstance(token, str) else ""
        except (OSError, ValueError, TypeError):
            return ""
