import os
import sys
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))

from gui.bridge import CoreBridge  # noqa: E402


class _Root:
    def __init__(self):
        self.after_calls = []

    def after(self, delay, fn):
        # Tests drive the worker lifecycle directly; no Tk loop is required.
        self.after_calls.append((delay, fn))
        return None


class _BlockingClient:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = []

    def request(self, method, payload, timeout=60.0):
        self.calls.append(method)
        if method == "first":
            self.started.set()
            self.release.wait(2.0)
        return {"ok": True, "result": {}}


class CoreBridgeLifecycleTests(unittest.TestCase):
    def test_close_drops_queued_rpcs_instead_of_running_them(self):
        client = _BlockingClient()
        bridge = CoreBridge(_Root(), lambda: client, workers=1, max_pending=2)
        self.assertTrue(bridge.call("first"))
        self.assertTrue(client.started.wait(1.0))
        self.assertTrue(bridge.call("second"))

        bridge.close()
        client.release.set()
        time.sleep(0.2)

        self.assertEqual(client.calls, ["first"])

    def test_callback_exception_does_not_kill_result_pump(self):
        root = _Root()
        bridge = CoreBridge(root, lambda: _BlockingClient(), workers=1, max_pending=2)
        root.after_calls.clear()
        bridge._results.put(({"ok": True, "result": {"x": 1}}, None, lambda _value: 1 / 0, None))

        with mock.patch("gui.bridge.traceback.print_exc") as print_exc:
            bridge._drain_results()

        print_exc.assert_called_once()
        self.assertEqual(len(root.after_calls), 1)
        self.assertEqual(root.after_calls[0][0], 25)
        self.assertIs(root.after_calls[0][1].__self__, bridge)
        bridge.close()


if __name__ == "__main__":
    unittest.main()
