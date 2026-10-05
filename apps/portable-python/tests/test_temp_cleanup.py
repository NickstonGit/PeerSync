import os
import shutil
import tempfile
import time
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
APP_ROOT = os.path.dirname(HERE)
import sys
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)

from runtime import temp_cleanup


class TempCleanupTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="psn-temp-cleanup-")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _cache(self, hex_digit, age_seconds):
        name = "PSNCore.exe-" + (hex_digit * 64)
        path = os.path.join(self.root, name)
        os.makedirs(path)
        with open(os.path.join(path, "native.dll"), "wb") as fh:
            fh.write(b"x" * 128)
        stamp = time.time() - age_seconds
        os.utime(path, (stamp, stamp))
        return path

    def test_removes_old_exact_caches_and_keeps_newest(self):
        newest = self._cache("a", 1)
        old1 = self._cache("b", 100)
        old2 = self._cache("c", 200)
        unrelated = os.path.join(self.root, "PSNCore.exe-not-a-bundle-id")
        os.makedirs(unrelated)

        result = temp_cleanup.cleanup_psncore_temp(
            temp_root=self.root,
            keep=1,
            core_running=lambda: False,
        )

        self.assertEqual(result["found"], 3)
        self.assertEqual(result["removed"], 2)
        self.assertGreaterEqual(result["freedBytes"], 256)
        self.assertTrue(os.path.isdir(newest))
        self.assertFalse(os.path.exists(old1))
        self.assertFalse(os.path.exists(old2))
        self.assertTrue(os.path.isdir(unrelated))

    def test_active_core_is_fail_closed(self):
        old = self._cache("d", 100)
        result = temp_cleanup.cleanup_psncore_temp(
            temp_root=self.root,
            keep=0,
            core_running=lambda: True,
        )
        self.assertTrue(result["skippedActiveCore"])
        self.assertTrue(os.path.isdir(old))

    def test_core_starting_after_scan_stops_cleanup(self):
        newest = self._cache("f", 1)
        old = self._cache("1", 100)
        calls = {"n": 0}

        def probe():
            calls["n"] += 1
            return calls["n"] >= 2

        result = temp_cleanup.cleanup_psncore_temp(
            temp_root=self.root,
            keep=1,
            core_running=probe,
        )
        self.assertTrue(result["skippedActiveCore"])
        self.assertEqual(result["removed"], 0)
        self.assertTrue(os.path.isdir(newest))
        self.assertTrue(os.path.isdir(old))

    def test_process_probe_failure_is_fail_closed(self):
        old = self._cache("e", 100)

        def broken_probe():
            raise RuntimeError("snapshot denied")

        result = temp_cleanup.cleanup_psncore_temp(
            temp_root=self.root,
            keep=0,
            core_running=broken_probe,
        )
        self.assertTrue(result["skippedActiveCore"])
        self.assertTrue(os.path.isdir(old))


if __name__ == "__main__":
    unittest.main()
