import os
import shutil
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, ROOT)

from windows import single_instance  # noqa: E402


class SingleInstanceSourceTests(unittest.TestCase):
    def _read(self, *parts):
        with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
            return fh.read()

    def test_second_launch_shows_running_window_instead_of_warning(self):
        app = self._read("app.py")
        main = self._read("gui", "main_window.py")
        gate = self._read("windows", "single_instance.py")
        self.assertIn("signal_running_instance", app)
        self.assertNotIn("PeerSync уже запущен", app)
        self.assertNotIn("смотрите трей", app)
        self.assertNotIn("messagebox.showwarning", app)
        self.assertIn("start_show_watcher", main)
        self.assertIn("_show_from_second_instance", main)
        self.assertIn("self.show_window()", main)
        self.assertNotIn("consume_show_request", main)
        self.assertIn("AllowSetForegroundWindow", gate)
        self.assertIn("INSTANCE_EVENT_PREFIX", gate)
        self.assertIn("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)", gate)
        self.assertIn("INSTANCE_LOCK_NAME", gate)
        self.assertIn("CreateFileW", gate)
        self.assertIn("FILE_SHARE_READ", gate)


@unittest.skipUnless(os.name == "nt", "Windows named mutex/event")
class SingleInstanceActivationTests(unittest.TestCase):
    def setUp(self):
        self.data_root = tempfile.mkdtemp(prefix="asn-si-")
        single_instance.release_single_instance()

    def tearDown(self):
        single_instance.release_single_instance()
        shutil.rmtree(self.data_root, ignore_errors=True)

    def test_second_instance_wakes_first_show_request(self):
        self.assertTrue(single_instance.acquire_single_instance(self.data_root))
        self.assertFalse(single_instance.acquire_single_instance(self.data_root))
        self.assertFalse(single_instance.consume_show_request())
        self.assertTrue(single_instance.signal_running_instance(self.data_root, attempts=8, delay=0.01))
        self.assertTrue(single_instance.consume_show_request())
        self.assertFalse(single_instance.consume_show_request())

    def test_show_watcher_invokes_callback(self):
        seen = threading.Event()
        self.assertTrue(single_instance.acquire_single_instance(self.data_root))
        single_instance.start_show_watcher(seen.set)
        self.assertTrue(single_instance.signal_running_instance(self.data_root, attempts=8, delay=0.01))
        self.assertTrue(seen.wait(1.0))


if __name__ == "__main__":
    unittest.main()
