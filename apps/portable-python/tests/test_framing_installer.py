import unittest
import io
import os
import sys
import tempfile
import hashlib
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))

from ipc import framing  # noqa: E402


class FramingTests(unittest.TestCase):
    def test_roundtrip(self):
        payload = {"type": "request", "requestId": "a", "method": "ping", "payload": {"seq": 1}}
        raw = framing.encode_frame(payload)
        parsed = framing.read_frame(io.BytesIO(raw))
        self.assertEqual(parsed, payload)

    def test_rejects_oversize(self):
        with self.assertRaises(framing.FrameError):
            framing.encode_frame({"x": "a" * (framing.MAX_FRAME + 10)})

    def test_bad_length(self):
        buf = io.BytesIO((framing.MAX_FRAME + 1).to_bytes(4, "little") + b"x")
        with self.assertRaises(framing.FrameError):
            framing.read_frame(buf)

    def test_invalid_json_is_a_transport_frame_error(self):
        body = b"{not-json}"
        buf = io.BytesIO(len(body).to_bytes(4, "little") + body)
        with self.assertRaises(framing.FrameError):
            framing.read_frame(buf)

    def test_invalid_utf8_is_a_transport_frame_error(self):
        body = b"\xff\xfe"
        buf = io.BytesIO(len(body).to_bytes(4, "little") + body)
        with self.assertRaises(framing.FrameError):
            framing.read_frame(buf)

    def test_non_object_json_is_a_transport_frame_error(self):
        body = b"[]"
        buf = io.BytesIO(len(body).to_bytes(4, "little") + body)
        with self.assertRaises(framing.FrameError):
            framing.read_frame(buf)

    def test_10000_roundtrips(self):
        for i in range(10000):
            payload = {"type": "request", "requestId": str(i), "method": "ping", "payload": {"seq": i}}
            raw = framing.encode_frame(payload)
            parsed = framing.read_frame(io.BytesIO(raw))
            self.assertEqual(parsed["payload"]["seq"], i)


class InstallerCleanupLogicTests(unittest.TestCase):
    def test_matching_core_cleans_stale_old_backup_on_fast_path(self):
        blob = b"MZ-fake-core"
        mod = types.ModuleType("core_payload")
        mod.CORE = blob
        mod.CORE_SIZE = len(blob)
        mod.CORE_SHA256 = hashlib.sha256(blob).hexdigest()
        sys.modules["core_payload"] = mod
        from runtime import core_installer

        with tempfile.TemporaryDirectory() as tmp:
            dest = os.path.join(tmp, "PSNCore.exe")
            with open(dest, "wb") as fh:
                fh.write(blob)
            old = dest + ".old"
            with open(old, "wb") as fh:
                fh.write(b"stale-backup")

            _path, _digest, changed = core_installer.install_core(dest)

            self.assertFalse(changed)
            self.assertFalse(os.path.exists(old))

    def test_matching_core_cleans_stale_new_file_on_fast_path(self):
        blob = b"MZ-fake-core"
        mod = types.ModuleType("core_payload")
        mod.CORE = blob
        mod.CORE_SIZE = len(blob)
        mod.CORE_SHA256 = hashlib.sha256(blob).hexdigest()
        sys.modules["core_payload"] = mod
        from runtime import core_installer

        with tempfile.TemporaryDirectory() as tmp:
            dest = os.path.join(tmp, "PSNCore.exe")
            with open(dest, "wb") as fh:
                fh.write(blob)
            stale_new = dest + ".new"
            with open(stale_new, "wb") as fh:
                fh.write(b"interrupted-transaction")

            _path, _digest, changed = core_installer.install_core(dest)

            self.assertFalse(changed)
            self.assertFalse(os.path.exists(stale_new))

    def test_remove_stale_retries_transient_permission_error(self):
        from unittest import mock
        from runtime import core_installer

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "PSNCore.new")
            with open(path, "wb") as fh:
                fh.write(b"stale")

            real_remove = os.remove
            calls = {"n": 0}

            def flaky_remove(candidate):
                if candidate == path and calls["n"] < 2:
                    calls["n"] += 1
                    raise PermissionError("held by scanner")
                return real_remove(candidate)

            with mock.patch.object(core_installer.os, "remove", side_effect=flaky_remove), \
                    mock.patch.object(core_installer.time, "sleep", return_value=None):
                self.assertTrue(core_installer._remove_stale(path, attempts=4))

            self.assertFalse(os.path.exists(path))
            self.assertEqual(calls["n"], 2)



@unittest.skipUnless(sys.platform == "win32", "Windows portable installer")
class InstallerTests(unittest.TestCase):
    def setUp(self):
        blob = b"MZ-fake-core"
        mod = types.ModuleType("core_payload")
        mod.CORE = blob
        mod.CORE_SIZE = len(blob)
        mod.CORE_SHA256 = hashlib.sha256(blob).hexdigest()
        sys.modules["core_payload"] = mod
        from runtime import core_installer

        self.installer = core_installer
        self.tmp = tempfile.mkdtemp()

    def test_install_then_no_rewrite(self):
        dest = os.path.join(self.tmp, "PSNCore.exe")
        p1, h1, changed = self.installer.install_core(dest)
        self.assertTrue(changed)
        self.assertTrue(os.path.isfile(p1))
        self.assertEqual(h1, hashlib.sha256(b"MZ-fake-core").hexdigest())
        _p2, h2, changed2 = self.installer.install_core(dest)
        self.assertFalse(changed2)
        self.assertEqual(h1, h2)


class DpapiTests(unittest.TestCase):
    def test_roundtrip(self):
        if sys.platform != "win32":
            self.skipTest("DPAPI is Windows-only")
        from windows import dpapi

        d = os.path.join(tempfile.mkdtemp(), "sec")
        s1 = dpapi.load_or_create_identity_seed(d)
        s2 = dpapi.load_or_create_identity_seed(d)
        self.assertEqual(len(s1), 64)
        self.assertEqual(s1, s2)

    def test_oversized_identity_blob_is_bounded_and_preserved(self):
        if sys.platform != "win32":
            self.skipTest("DPAPI is Windows-only")
        from windows import dpapi

        d = os.path.join(tempfile.mkdtemp(), "sec")
        os.makedirs(d, exist_ok=True)
        identity_path = os.path.join(d, "identity.dpapi")
        with open(identity_path, "wb") as fh:
            fh.write(b"A" * (dpapi.IDENTITY_BLOB_MAX_BYTES + 1))

        with self.assertRaisesRegex(RuntimeError, "refusing automatic identity rotation"):
            dpapi.load_or_create_identity_seed(d)
        self.assertEqual(
            os.path.getsize(identity_path),
            dpapi.IDENTITY_BLOB_MAX_BYTES + 1,
        )


@unittest.skipUnless(sys.platform == "win32", "Windows tray API")
class TrayNotifyTests(unittest.TestCase):
    def test_notify_event_loword(self):
        from windows.tray import notify_event, NIN_SELECT, WM_LBUTTONDBLCLK, SHOW_EVENTS, TRAY_RUNTIME

        self.assertEqual(notify_event(0x0203), WM_LBUTTONDBLCLK)
        self.assertEqual(notify_event(0x00010203), WM_LBUTTONDBLCLK)
        self.assertEqual(notify_event(0x00010400), NIN_SELECT)
        self.assertIn(WM_LBUTTONDBLCLK, SHOW_EVENTS)
        self.assertNotIn(0x0202, SHOW_EVENTS)  # single left-button up must not open
        self.assertEqual(TRAY_RUNTIME, "threaded-v2")


@unittest.skipUnless(sys.platform == "win32", "Windows CoreClient pipes")
class ClientStopTests(unittest.TestCase):
    def test_stop_kills_hung_process(self):
        import time
        import threading
        from ipc.core_client import CoreClient

        class FakeProc:
            def __init__(self):
                self.killed = False
                self._done = threading.Event()

            def poll(self):
                return 0 if self.killed else None

            def wait(self, timeout=None):
                if self._done.wait(timeout):
                    return 0
                raise TimeoutError("timeout")

            def kill(self):
                self.killed = True
                self._done.set()

        client = CoreClient("missing.exe", "d", "l")
        client.proc = FakeProc()
        started = time.monotonic()
        client.stop(graceful=True, timeout=0.25)
        elapsed = time.monotonic() - started
        self.assertTrue(client.proc.killed)
        self.assertLess(elapsed, 1.2)

    def test_request_admitted_during_shutdown_returns_dead_without_waiting_for_rpc_timeout(self):
        import queue
        import time
        from ipc.core_client import CoreClient

        client = CoreClient("missing.exe", "d", "l")

        class ShutdownAfterPut(queue.Queue):
            def put(self, item, block=True, timeout=None):
                super().put(item, block=block, timeout=timeout)
                with client._pending_lock:
                    client._closed = True
                client._stop.set()

        client._write_queue = ShutdownAfterPut(maxsize=4)
        started = time.monotonic()
        frame = client.request("ping", {}, timeout=5.0)
        elapsed = time.monotonic() - started

        self.assertFalse(frame.get("ok"))
        self.assertLess(elapsed, 0.5)

    def test_stop_reports_process_that_could_not_be_terminated(self):
        from ipc.core_client import CoreClient

        class UnkillableProc:
            def poll(self):
                return None

            def wait(self, timeout=None):
                raise RuntimeError("still alive")

            def kill(self):
                raise RuntimeError("kill denied")

        client = CoreClient("missing.exe", "d", "l")
        client.proc = UnkillableProc()
        with self.assertRaisesRegex(RuntimeError, "Core process is still running"):
            client.stop(graceful=False, timeout=0.01)


@unittest.skipUnless(sys.platform == "win32", "Windows CoreClient pipes")
class PendingAdmissionTests(unittest.TestCase):
    """A request that never reaches the pipe must never leave a waiter behind."""

    def _client(self):
        from ipc.core_client import CoreClient

        return CoreClient("missing.exe", "d", "l")

    def test_encode_failure_leaves_no_pending_waiter(self):
        from ipc import framing

        client = self._client()
        oversized = "x" * (framing.MAX_FRAME + 1024)
        for _attempt in range(100):
            with self.assertRaises(framing.FrameError):
                client.request("fs.copy", {"paths": [oversized]})
        self.assertEqual(client._pending, {})
        self.assertEqual(client._write_queue.qsize(), 0)

    def test_unserializable_payload_leaves_no_pending_waiter(self):
        client = self._client()
        for _attempt in range(10):
            with self.assertRaises(TypeError):
                client.request("fs.copy", {"path": object()})
        self.assertEqual(client._pending, {})
        self.assertEqual(client._write_queue.qsize(), 0)

    def test_pending_requests_are_capped(self):
        from ipc import core_client

        client = self._client()
        with client._pending_lock:
            for index in range(core_client._MAX_PENDING_REQUESTS):
                client._pending["filler-%d" % index] = {"ev": None, "result": None}
        try:
            with self.assertRaisesRegex(RuntimeError, "too many unanswered IPC requests"):
                client.request("ping", {}, timeout=0.05)
        finally:
            with client._pending_lock:
                client._pending.clear()
        self.assertEqual(client._pending, {})


class StderrRelayHardeningTests(unittest.TestCase):
    """A newline-free Core stderr stream must not buffer without bound."""

    def _client(self, chunks, diagnostics):
        import ipc.core_client as core_client

        class FakePipe:
            def __init__(self, data):
                self._data = data

            def read(self, _size):
                if not self._data:
                    return b""
                chunk, self._data = self._data[0], self._data[1:]
                return chunk

        channel = type("Channel", (), {})()
        channel.parent_file = FakePipe(chunks)
        client = core_client.CoreClient("core.exe", "d", "l", diagnostics=diagnostics)
        client._stderr_channel = channel
        return client, core_client

    def test_unfinished_line_is_capped_and_drain_continues(self):
        from ipc.core_client import _STDERR_MAX_LINE_CHARS

        lines = []

        class Diagnostics:
            def ingest_core_line(self, line):
                lines.append(line)

        oversize = (b"x" * (_STDERR_MAX_LINE_CHARS + 4096))
        client, core_client = self._client([oversize, b"tail\n", b'{"a":1}\n'], Diagnostics())
        client._stderr_loop()

        self.assertEqual(len(lines), 3)
        self.assertTrue(lines[0].endswith("[truncated after %d chars]" % _STDERR_MAX_LINE_CHARS))
        self.assertEqual(lines[1], "tail")
        self.assertEqual(lines[2], '{"a":1}')

    def test_a_failing_sink_never_stops_the_drain(self):
        class Diagnostics:
            def __init__(self):
                self.seen = []

            def ingest_core_line(self, line):
                self.seen.append(line)
                if len(self.seen) == 1:
                    raise RuntimeError("sink failure")

        diagnostics = Diagnostics()
        client, _core_client = self._client([b"first\nsecond\nthird\n"], diagnostics)
        client._stderr_loop()
        self.assertEqual(diagnostics.seen, ["first", "second", "third"])


class ArtifactSmokeGateTests(unittest.TestCase):
    def _read(self, *parts):
        app = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
        with open(os.path.join(app, *parts), encoding="utf-8") as fh:
            return fh.read()

    def test_last_smoke_metric_retries_and_report_is_enough_to_pass(self):
        app_py = self._read("apps", "portable-python", "app.py")
        smoke = self._read("scripts", "artifact-smoke.py")
        self.assertIn("for attempt in range(12):", app_py)
        self.assertIn("os.replace(tmp, path)", app_py)
        self.assertIn("note: smoke-metrics write failed:", app_py)
        self.assertIn('passed = proc.returncode == 0 and "M0 SMOKE PASS" in text', smoke)
        self.assertNotIn(
            'passed = proc.returncode == 0 and "M0 SMOKE PASS" in text and metrics.get("smokePass") is True',
            smoke,
        )


if __name__ == "__main__":
    unittest.main()
