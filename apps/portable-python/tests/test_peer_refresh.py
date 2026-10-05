import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from gui.peer_refresh import PeerListRefresher


class FakeBridge:
    """Records each issued request and lets the test settle it explicitly."""

    def __init__(self):
        self.calls = []

    def issue(self, stamp, settle, on_ok, on_err):
        self.calls.append({"stamp": stamp, "settle": settle, "on_ok": on_ok, "on_err": on_err})

    def __len__(self):
        return len(self.calls)


def make(bridge):
    return PeerListRefresher(bridge.issue)


class PeerListRefreshCoalescingTests(unittest.TestCase):
    def test_first_request_issues_immediately(self):
        bridge = FakeBridge()
        refresher = make(bridge)
        self.assertTrue(refresher.request())
        self.assertEqual(len(bridge), 1)
        self.assertTrue(refresher.inflight)

    def test_burst_during_one_request_issues_a_single_follow_up(self):
        bridge = FakeBridge()
        refresher = make(bridge)
        refresher.request()
        for _ in range(20):
            self.assertFalse(refresher.request())
        self.assertEqual(len(bridge), 1, "burst must not issue a request per event")

        bridge.calls[0]["on_ok"]({"peers": []})
        self.assertEqual(len(bridge), 2, "exactly one follow-up after the burst")

    def test_follow_up_uses_a_newer_stamp(self):
        bridge = FakeBridge()
        refresher = make(bridge)
        refresher.request()
        refresher.request()
        bridge.calls[0]["on_ok"]({})
        self.assertGreater(bridge.calls[1]["stamp"], bridge.calls[0]["stamp"])

    def test_response_from_the_current_in_flight_request_is_applied(self):
        bridge = FakeBridge()
        refresher = make(bridge)
        seen = []
        refresher.request(on_ok=lambda r: seen.append(r))
        refresher.request()
        # The in-flight response is still the current one, so its payload is
        # applied; coalescing must not discard data it has already paid for.
        bridge.calls[0]["on_ok"]({"peers": ["current"]})
        self.assertEqual(seen, [{"peers": ["current"]}])

    def test_late_response_from_a_superseded_stamp_is_ignored(self):
        bridge = FakeBridge()
        refresher = make(bridge)
        seen = []
        refresher.request(on_ok=lambda r: seen.append(r))
        refresher.request()
        # The follow-up supersedes the first stamp; a duplicate response that
        # arrives afterwards must not overwrite newer state.
        first = bridge.calls[0]
        bridge.calls[0]["on_ok"]({"peers": ["fresh"]})
        first["on_ok"]({"peers": ["duplicate"]})
        self.assertEqual(seen, [{"peers": ["fresh"]}])

    def test_a_failed_request_still_releases_the_inflight_slot(self):
        bridge = FakeBridge()
        refresher = make(bridge)
        errors = []
        refresher.request(on_err=lambda e: errors.append(e))
        refresher.request()
        bridge.calls[0]["on_err"](RuntimeError("pipe closed"))
        self.assertEqual(len(errors), 1, "the failure is reported to the caller")
        # The slot was released and immediately refilled by the queued request,
        # so the refresher keeps making progress instead of wedging.
        self.assertEqual(len(bridge), 2)
        self.assertTrue(refresher.inflight)
        bridge.calls[1]["on_err"](RuntimeError("pipe closed"))
        self.assertFalse(refresher.inflight, "a failure with nothing queued leaves it idle")

    def test_error_callback_runs_for_the_current_stamp(self):
        bridge = FakeBridge()
        refresher = make(bridge)
        errors = []
        refresher.request(on_err=lambda e: errors.append(e))
        bridge.calls[0]["on_err"](RuntimeError("boom"))
        self.assertEqual(len(errors), 1)

    def test_pending_options_survive_into_the_follow_up(self):
        bridge = FakeBridge()
        refresher = make(bridge)
        poked = []
        refresher.request(on_ok=lambda r: None)
        # A poke arrives while a plain refresh is in flight.
        refresher.request(on_ok=lambda r: poked.append(r))
        bridge.calls[0]["on_ok"]({})
        bridge.calls[1]["on_ok"]({"peers": []})
        # The follow-up must carry the later request's callback.
        self.assertEqual(len(poked), 1)

    def test_reset_abandons_state_and_invalidates_in_flight_responses(self):
        bridge = FakeBridge()
        refresher = make(bridge)
        seen = []
        refresher.request(on_ok=lambda r: seen.append(r))
        refresher.reset()
        bridge.calls[0]["on_ok"]({"peers": ["after-restart"]})
        self.assertEqual(seen, [], "a response from a retired owner must be dropped")
        self.assertFalse(refresher.inflight)

    def test_request_after_reset_issues_again(self):
        bridge = FakeBridge()
        refresher = make(bridge)
        refresher.request()
        refresher.reset()
        self.assertTrue(refresher.request())
        self.assertEqual(len(bridge), 2)

    def test_pending_is_false_when_fully_settled(self):
        bridge = FakeBridge()
        refresher = make(bridge)
        refresher.request()
        self.assertTrue(refresher.pending)
        bridge.calls[0]["on_ok"]({})
        self.assertFalse(refresher.pending)


if __name__ == "__main__":
    unittest.main()
