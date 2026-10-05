from __future__ import annotations

import json
import os
import threading
import time
import uuid
from collections import Counter, deque
from pathlib import Path
from typing import Any, Callable, Iterable

from .records import LEVEL_RANK, classify_raw_line, make_record, record_from_mapping, redact

MAX_RING = 2000
MAX_FILE_BYTES = 10 * 1024 * 1024
FILE_BACKUPS = 5
MAX_SNAPSHOT_RECORDS = 500
MAX_SNAPSHOT_BYTES = 900 * 1024


class DiagnosticsRecorder:
    def __init__(
        self,
        logs_dir: str | os.PathLike[str],
        debug: bool = False,
        legacy_core_path: str | os.PathLike[str] | None = None,
        app_info: dict[str, Any] | None = None,
    ) -> None:
        self.logs_dir = Path(logs_dir)
        self.log_path = self.logs_dir / "diagnostics.jsonl"
        self.snapshot_path = self.logs_dir / "last-snapshot.json"
        self.legacy_core_path = Path(legacy_core_path) if legacy_core_path else None
        self.debug = bool(debug)
        self.threshold = "debug" if self.debug else "error"
        self.session_id = uuid.uuid4().hex
        self.started_at_ms = int(time.time() * 1000)
        self._lock = threading.RLock()
        self._ring: deque[dict[str, Any]] = deque(maxlen=MAX_RING)
        self._counters: Counter[str] = Counter()
        self._dropped = 0
        self._app = dict(app_info or {})
        self._core: dict[str, Any] = {}
        self._status_provider: Callable[[], dict[str, Any]] | None = None
        self._snapshot_stop = threading.Event()
        self._snapshot_thread: threading.Thread | None = None

    def set_status_provider(self, provider: Callable[[], dict[str, Any]] | None) -> None:
        with self._lock:
            self._status_provider = provider

    def update_app(self, **values: Any) -> None:
        with self._lock:
            self._app.update(redact(values))

    def update_core(self, **values: Any) -> None:
        with self._lock:
            self._core.update(redact(values))

    def update_core_status(self, value: Any) -> None:
        if isinstance(value, dict):
            self.update_core(status=redact(value), statusAtMs=int(time.time() * 1000))

    def should_log(self, level: str) -> bool:
        return LEVEL_RANK.get(level, 0) >= LEVEL_RANK[self.threshold]

    def count_only(self, level: str, event: str) -> None:
        """Counts an event without keeping a record of it.

        High-frequency, low-information events (a successful RPC completing, a
        status poll) would otherwise evict the ring and the log tail, which is
        where the events an operator actually needs live. The aggregate counters
        still advance, so nothing is lost - only the per-event line is dropped.
        """
        with self._lock:
            self._counters[str(level).lower()] += 1
            self._counters["event:" + str(event)] += 1

    def log(self, level: str, source: str, component: str, event: str, message: str = "", **fields: Any) -> dict[str, Any] | None:
        if not self.should_log(str(level).lower()):
            return None
        record = make_record(level, source, component, event, message, **fields)
        return self._write_record(record)

    def _write_record(self, record: dict[str, Any]) -> dict[str, Any] | None:
        if not self.should_log(str(record.get("level") or "error").lower()):
            return None
        record["sessionId"] = self.session_id
        with self._lock:
            self._ring.append(record)
            self._counters[record["level"]] += 1
            self._counters["event:" + record["event"]] += 1
        self._append_jsonl(record)
        if record.get("source") == "core" and self.legacy_core_path is not None:
            self._append_legacy(record)
        return record

    def _append_jsonl(self, record: dict[str, Any]) -> None:
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        try:
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            self._rotate_if_needed(self.log_path, len(line.encode("utf-8")))
            with self.log_path.open("a", encoding="utf-8", newline="") as handle:
                handle.write(line)
        except OSError:
            with self._lock:
                self._dropped += 1

    def _append_legacy(self, record: dict[str, Any]) -> None:
        try:
            self.legacy_core_path.parent.mkdir(parents=True, exist_ok=True)
            line = "%s %s %s %s %s\n" % (
                record.get("tsMs"),
                record.get("level"),
                record.get("component"),
                record.get("event"),
                record.get("message"),
            )
            self._rotate_if_needed(self.legacy_core_path, len(line.encode("utf-8")))
            with self.legacy_core_path.open("a", encoding="utf-8", newline="") as handle:
                handle.write(line)
        except OSError:
            with self._lock:
                self._dropped += 1

    def _rotate_if_needed(self, path: Path, incoming: int) -> None:
        try:
            if path.exists() and path.stat().st_size + incoming > MAX_FILE_BYTES:
                from windows import paths

                paths.rotate_log_files(str(path), max_bytes=MAX_FILE_BYTES, backups=FILE_BACKUPS, force=True)
        except (OSError, ImportError):
            return

    def ingest_core_line(self, line: str) -> dict[str, Any] | None:
        text = line.strip()
        if not text:
            return None
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError):
            parsed = None
        if isinstance(parsed, dict) and parsed.get("schemaVersion") == 1:
            record = record_from_mapping(parsed, "core")
        else:
            record = make_record(classify_raw_line(text), "core", "core.stderr", "stderr.line", text)
        return self._write_record(record)

    def query(
        self,
        limit: int = 256,
        cursor: int | None = None,
        levels: Iterable[str] | None = None,
        components: Iterable[str] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            records = list(self._ring)
        allowed_levels = {str(level).lower() for level in levels} if levels else None
        allowed_components = {str(component) for component in components} if components else None
        start = max(0, int(cursor or 0))
        filtered = [
            record
            for record in records
            if (allowed_levels is None or record.get("level") in allowed_levels)
            and (allowed_components is None or record.get("component") in allowed_components)
        ]
        page = filtered[start : start + max(1, min(MAX_SNAPSHOT_RECORDS, int(limit)))]
        return {
            "events": page,
            "nextCursor": start + len(page) if start + len(page) < len(filtered) else None,
            "truncated": start + len(page) < len(filtered),
        }

    def snapshot(self, limit: int = 256, cursor: int | None = None, levels: Iterable[str] | None = None, components: Iterable[str] | None = None) -> dict[str, Any]:
        with self._lock:
            app = dict(self._app)
            core = dict(self._core)
            provider = self._status_provider
        if provider is not None:
            try:
                supplied = provider()
                if isinstance(supplied, dict):
                    core.update(redact(supplied))
            except Exception:
                core["statusError"] = "provider failed"
        query = self.query(limit=limit, cursor=cursor, levels=levels, components=components)
        return {
            "schemaVersion": 1,
            "generatedAtMs": int(time.time() * 1000),
            "sessionId": self.session_id,
            "level": self.threshold,
            "runtime": {
                **app,
                "pid": os.getpid(),
                "uptimeMs": max(0, int(time.time() * 1000) - self.started_at_ms),
            },
            "core": core,
            "counters": {"levels": dict(self._counters), "dropped": self._dropped},
            **query,
        }

    def write_snapshot(self, value: dict[str, Any] | None = None) -> None:
        payload = value or self.snapshot()
        try:
            encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            if len(encoded.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
                payload = self.snapshot(limit=128)
                encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            temporary = self.snapshot_path.with_suffix(".json.tmp")
            with temporary.open("w", encoding="utf-8", newline="") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.snapshot_path)
        except OSError:
            with self._lock:
                self._dropped += 1

    def start_periodic(self, interval_seconds: float = 5.0) -> None:
        if self._snapshot_thread is not None:
            return
        self._snapshot_stop.clear()
        interval = max(0.5, float(interval_seconds))
        self._snapshot_thread = threading.Thread(target=self._periodic_snapshot, args=(interval,), name="diagnostics-snapshot", daemon=True)
        self._snapshot_thread.start()

    def _periodic_snapshot(self, interval: float) -> None:
        while not self._snapshot_stop.wait(interval):
            self.write_snapshot()

    def close(self) -> None:
        self._snapshot_stop.set()
        if self._snapshot_thread is not None:
            self._snapshot_thread.join(timeout=2.0)
            self._snapshot_thread = None
        self.write_snapshot()
