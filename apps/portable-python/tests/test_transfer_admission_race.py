import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


class TransferAdmissionRaceTests(unittest.TestCase):
    def test_completed_slot_is_released_and_transient_admission_is_retried(self):
        path = os.path.join(
            REPO_ROOT, "packages", "core", "src", "portable", "fs-engine.ts"
        )
        with open(path, encoding="utf-8") as fh:
            core = fh.read()

        # A settled sender/receiver releases the live-transfer permit before
        # slower journal/result cleanup, so file N+1 cannot race that cleanup.
        self.assertGreaterEqual(core.count("releaseInboundNow()"), 4)
        self.assertIn(
            "private _scheduleLaunchRetry(operationId: string, peerId: string): void",
            core,
        )
        self.assertIn(
            "const transientAdmission = code === 'LIMIT_EXCEEDED' || code === 'BUSY'",
            core,
        )
        self.assertIn("Transient peer admission failed: ${code}", core)
        self.assertIn(
            "if (!stale && this._isRetryableLiveTransferError(code) && this._sessionOf(session.peerId))",
            core,
        )

        # Early admission failures must still identify the exact source row so
        # the GUI cannot leave it painted as an anonymous 0% copy forever.
        self.assertIn("relativePath: descriptor.source.relativePath", core)
        self.assertIn(
            "direction: descriptor.source.deviceId === this.myId ? 'out' : 'in'", core
        )


if __name__ == "__main__":
    unittest.main()
