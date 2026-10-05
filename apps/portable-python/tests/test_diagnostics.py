import json
import msvcrt
import os
import sys
import tempfile
import time
import unittest
import ctypes

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from diagnostics import DiagnosticsEndpoint, DiagnosticsRecorder
from diagnostics.protocol import decode_cursor, encode_request
from ipc import framing
from windows import pipes
from unittest import mock


class DiagnosticsTests(unittest.TestCase):
    def test_rotates_before_incoming_record_crosses_limit(self):
        with tempfile.TemporaryDirectory() as root:
            recorder = DiagnosticsRecorder(root)
            recorder.log_path.write_text("old records\n", encoding="utf-8")
            with mock.patch("diagnostics.recorder.MAX_FILE_BYTES", 100):
                recorder.log("error", "shell", "test", "rotation", "new record")
            self.assertEqual((recorder.log_path.parent / "diagnostics.jsonl.1").read_text(), "old records\n")
            self.assertIn("new record", recorder.log_path.read_text())

    def test_default_level_only_records_error_and_critical(self):
        with tempfile.TemporaryDirectory() as root:
            recorder = DiagnosticsRecorder(root)
            self.assertIsNone(recorder.log("warn", "shell", "test", "warning"))
            self.assertIsNone(recorder.log("info", "shell", "test", "info"))
            recorder.log("error", "shell", "test", "error")
            recorder.log("critical", "shell", "test", "critical")
            snapshot = recorder.snapshot()
            self.assertEqual([item["level"] for item in snapshot["events"]], ["error", "critical"])

    def test_debug_level_records_all_levels_and_redacts(self):
        with tempfile.TemporaryDirectory() as root:
            recorder = DiagnosticsRecorder(root, debug=True)
            recorder.log("debug", "shell", "test", "debug")
            recorder.log("info", "shell", "test", "info", identitySeedHex="secret", path=os.path.join(root, "file"))
            record = recorder.snapshot()["events"][-1]
            self.assertEqual(record["level"], "info")
            self.assertNotIn("secret", json.dumps(record))
            self.assertNotIn(root, json.dumps(record))

    def test_count_only_advances_counters_without_consuming_the_ring(self):
        """High-frequency telemetry must not evict the events an operator reads.

        A debug build polls `peer.list` every few seconds. Logging each completed
        request filled the 2000-entry ring and the log tail, so the failures and
        state changes recorded around them were lost within the hour.
        """
        with tempfile.TemporaryDirectory() as root:
            recorder = DiagnosticsRecorder(root, debug=True)
            recorder.count_only("debug", "request.completed")
            recorder.count_only("debug", "request.completed")
            recorder.log("error", "shell", "wire", "peer.transport.error", "reset")

            snapshot = recorder.snapshot()
            counters = snapshot["counters"]["levels"]
            self.assertEqual(counters["event:request.completed"], 2)
            self.assertEqual(counters["debug"], 2)
            # The counted event is not retained, but the real one still is.
            events = snapshot["events"]
            self.assertEqual([e["event"] for e in events], ["peer.transport.error"])

            # Counters survive a snapshot round trip for the live endpoint.
            self.assertIn("event:request.completed", counters)

    def test_count_only_is_cheap_and_never_raises_on_unknown_level(self):
        with tempfile.TemporaryDirectory() as root:
            recorder = DiagnosticsRecorder(root, debug=True)
            recorder.count_only("not-a-level", "unknown.event")
            self.assertEqual(recorder.snapshot()["counters"]["levels"]["event:unknown.event"], 1)

    def test_core_jsonl_and_malformed_stderr_are_normalized(self):
        with tempfile.TemporaryDirectory() as root:
            recorder = DiagnosticsRecorder(root, debug=True)
            recorder.ingest_core_line(json.dumps({"schemaVersion": 1, "level": "info", "component": "wire", "event": "frame", "message": "ok"}))
            recorder.ingest_core_line("unhandled failure C:\\private\\file.txt")
            events = recorder.snapshot()["events"]
            self.assertEqual(events[0]["source"], "core")
            self.assertEqual(events[0]["event"], "frame")
            self.assertEqual(events[1]["level"], "error")
            self.assertNotIn("private", events[1]["message"])

    def test_cursor_contract(self):
        self.assertEqual(decode_cursor(None), None)
        self.assertEqual(decode_cursor(4), 4)
        encoded = __import__("base64").urlsafe_b64encode(json.dumps({"v": 1, "source": "diagnostics.jsonl", "index": 7}, separators=(",", ":")).encode()).decode().rstrip("=")
        self.assertEqual(decode_cursor(encoded), 7)
        self.assertIsNone(decode_cursor("not-a-cursor"))

    @unittest.skipUnless(os.name == "nt", "Windows named pipe")
    def test_live_endpoint_requires_token_and_returns_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            recorder = DiagnosticsRecorder(root, debug=True)
            recorder.log("error", "shell", "test", "endpoint", "ready")
            endpoint = DiagnosticsEndpoint(root, recorder)
            endpoint.start()
            try:
                descriptor_path = os.path.join(root, "runtime", "diagnostics-endpoint.json")
                with open(descriptor_path, encoding="utf-8") as descriptor_file:
                    descriptor = json.load(descriptor_file)

                def request(request_id, token):
                    handle = pipes._INVALID[0]
                    deadline = time.monotonic() + 2.0
                    while time.monotonic() < deadline:
                        handle = pipes.kernel32.CreateFileW(
                            "\\\\.\\pipe\\" + descriptor["pipeName"],
                            pipes.GENERIC_READ | pipes.GENERIC_WRITE,
                            0,
                            None,
                            pipes.OPEN_EXISTING,
                            pipes.FILE_ATTRIBUTE_NORMAL,
                            None,
                        )
                        if ctypes.c_void_p(handle).value not in (-1, 0xFFFFFFFFFFFFFFFF):
                            break
                        time.sleep(0.01)
                    self.assertNotEqual(ctypes.c_void_p(handle).value, 0xFFFFFFFFFFFFFFFF)
                    fd = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
                    stream = os.fdopen(fd, "r+b", buffering=0)
                    try:
                        stream.write(encode_request(request_id, token, limit=10))
                        try:
                            return framing.read_frame(stream)
                        except Exception as err:
                            self.fail("pipe read failed: %s; server=%s" % (err, endpoint._server.last_error))
                    finally:
                        stream.close()

                response = request("req-1", "wrong")
                self.assertIsNone(endpoint._server.last_error, endpoint._server.last_error)
                self.assertFalse(response["ok"])
                response = request("req-2", descriptor["token"])
                self.assertTrue(response["ok"])
                self.assertEqual(response["result"]["events"][0]["event"], "endpoint")
            finally:
                endpoint.stop()


if __name__ == "__main__":
    unittest.main()
