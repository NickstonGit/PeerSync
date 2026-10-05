"""The debug-only diagnostics endpoint must behave correctly when enabled.

The live endpoint is intentionally gated behind ``--debug`` in ``app.py``: a
release build must not publish a live diagnostic surface, and external clients
(for example the ``psn-mcp-diagnostics`` MCP server) fall back to the bounded
offline logs by design. These tests cover the endpoint's own contract - descriptor
publication, teardown and credential rotation across a restart.
"""

import json
import os
import sys
import tempfile
import unittest

APP_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, APP_ROOT)

from diagnostics import DiagnosticsEndpoint, DiagnosticsRecorder  # noqa: E402


class DiagnosticsEndpointPublicationTests(unittest.TestCase):
    """The debug-only diagnostics endpoint must behave correctly when enabled.

    The endpoint is intentionally gated behind ``--debug``: a release build must
    not publish a live diagnostic surface, and external clients fall back to the
    bounded offline logs. These tests cover the endpoint itself, not that gate.
    """
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        os.makedirs(os.path.join(self.root, "runtime"), exist_ok=True)
        os.makedirs(os.path.join(self.root, "logs"), exist_ok=True)
        self.recorder = DiagnosticsRecorder(os.path.join(self.root, "logs"))
        self.endpoint = None

    def tearDown(self):
        if self.endpoint is not None:
            self.endpoint.stop()
        self.recorder.close()
        self._tmp.cleanup()

    def _descriptor(self):
        path = os.path.join(self.root, "runtime", "diagnostics-endpoint.json")
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)

    def test_start_publishes_a_valid_descriptor(self):
        self.endpoint = DiagnosticsEndpoint(self.root, self.recorder)
        self.endpoint.start()
        try:
            descriptor = self._descriptor()
            self.assertEqual(descriptor["schemaVersion"], 1)
            self.assertTrue(descriptor["pipeName"])
            self.assertTrue(descriptor["token"])
            self.assertEqual(descriptor["pid"], os.getpid())
            self.assertIsInstance(descriptor["startedAtMs"], int)
            self.assertIsInstance(descriptor["coreEpoch"], int)
            # The pipe name must be usable as a pipe path component.
            for bad in ("\\", "/", ":", "*", "?", '"', "<", ">", "|"):
                self.assertNotIn(bad, descriptor["pipeName"])
        finally:
            self.endpoint.stop()
            self.endpoint = None

    def test_stop_removes_the_descriptor(self):
        self.endpoint = DiagnosticsEndpoint(self.root, self.recorder)
        self.endpoint.start()
        self.endpoint.stop()
        self.endpoint = None
        self.assertFalse(
            os.path.exists(os.path.join(self.root, "runtime", "diagnostics-endpoint.json"))
        )

    def test_descriptor_is_not_left_behind_by_a_restart(self):
        first = DiagnosticsEndpoint(self.root, self.recorder)
        first.start()
        first_pipe = first.pipe_name
        # Capture the live token before stopping: after the restart the file on
        # disk already holds the *new* token, so reading it later would compare
        # the new value against itself.
        first_token = self._descriptor()["token"]
        first.stop()

        second = DiagnosticsEndpoint(self.root, self.recorder)
        second.start()
        try:
            descriptor = self._descriptor()
            # A restart must rotate both the pipe and the token, so a stale
            # descriptor can never address a previous instance.
            self.assertNotEqual(descriptor["pipeName"], first_pipe)
            self.assertNotEqual(descriptor["token"], first_token)
        finally:
            second.stop()
            self.endpoint = None


if __name__ == "__main__":
    unittest.main()
