import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from gui.operation_controller import (
    COMPACT_BATCH_TRACKING_THRESHOLD,
    OperationBatchController,
    is_batch_active,
    is_batch_finished,
    operation_ids_of,
)


class FakeRowView:
    """Minimal stand-in for FilePanel: records binds and exposes groups."""

    def __init__(self, rel=""):
        self.rel = rel
        self.bound = []
        self.updates = []
        self.final = []
        self.holds = []
        self._seq = 0
        self._groups = {}

    def begin_row_operation(self, entry, label, expected_bytes=0, expected_files=0):
        self._seq += 1
        token = "t%d" % self._seq
        self._groups[token] = {
            "token": token,
            "path": str(entry.get("relativePath") or self.rel or ""),
            "state": "active",
            "ids_final": False,
            "ops": {},
        }
        return token

    def operation_group(self, token):
        return self._groups.get(token)

    def bind_operation_id(self, token, op_id):
        self.bound.append((token, op_id))
        group = self._groups.get(token)
        if group is not None:
            group["ops"].setdefault(op_id, {"state": "queued", "bytesDone": 0, "bytesTotal": 0})
        return True

    def update_operation(self, op_id, payload):
        self.updates.append((op_id, payload))

    def mark_operations_final(self, token):
        group = self._groups.get(token)
        if group is not None:
            group["ids_final"] = True
        self.final.append(token)

    def set_operation_cleanup_hold(self, token, hold):
        self.holds.append((token, hold))


def set_op(ctrl, batch, row_view, op_id, state, **extra):
    """Drive the controller mirror the way a real operation event would."""
    token = batch["groups"][0]["token"]
    payload = {"state": state, "bytesDone": 0, "bytesTotal": 0}
    payload.update(extra)
    ctrl.ingest(batch, token, op_id, payload)
    group = row_view.operation_group(token)
    if group is not None:
        group["ops"][op_id] = dict(payload)
    return token


class BatchCreationTests(unittest.TestCase):
    def test_create_registers_batch_and_returns_id(self):
        panel = FakeRowView("docs")
        c = OperationBatchController()
        batch_id = c.create(panel, [{"relativePath": "docs/a.txt"}], "Copying")
        self.assertIsNotNone(batch_id)
        self.assertIn(batch_id, c.batches)
        self.assertEqual(c.batches[batch_id]["label"], "Copying")

    def test_large_multi_select_draws_one_aggregate_row(self):
        panel = FakeRowView("")
        c = OperationBatchController()
        entries = [{"relativePath": "f%d" % i} for i in range(64)]
        batch_id = c.create(panel, entries, "Copying")
        # One overlay, not 64: per-row Canvas overlays cost more than the copy.
        self.assertEqual(len(c.batches[batch_id]["groups"]), 1)

    def test_small_multi_select_draws_one_row_per_entry(self):
        panel = FakeRowView("")
        c = OperationBatchController()
        entries = [{"relativePath": "f%d" % i} for i in range(3)]
        batch_id = c.create(panel, entries, "Copying")
        self.assertEqual(len(c.batches[batch_id]["groups"]), 3)

    def test_ids_are_unique_across_batches(self):
        panel = FakeRowView("")
        c = OperationBatchController()
        first = c.create(panel, [{"relativePath": "a"}], "Copying")
        second = c.create(panel, [{"relativePath": "b"}], "Syncing")
        self.assertNotEqual(first, second)


class RegisterTests(unittest.TestCase):
    def setUp(self):
        self.panel = FakeRowView("docs")
        self.c = OperationBatchController()
        self.batch_id = self.c.create(self.panel, [{"relativePath": "docs/a.txt"}], "Copying")
        self.batch = self.c.get(self.batch_id)

    def test_register_records_expected_and_core_ids(self):
        self.c.register(self.batch_id, ["o1", "o2"], 2, "core-1")
        self.assertEqual(self.batch["expected_operations"], 2)
        self.assertEqual(self.batch["core_batch_id"], "core-1")
        self.assertEqual(self.c.ui_by_core["core-1"], self.batch_id)

    def test_register_makes_the_id_set_final(self):
        self.c.register(self.batch_id, ["o1"], 1, None)
        self.assertTrue(self.batch["ids_final"])

    def test_register_falls_back_to_id_count_when_accept_count_is_garbage(self):
        self.c.register(self.batch_id, ["o1", "o2"], "not-a-number", None)
        self.assertEqual(self.batch["expected_operations"], 2)

    def test_large_batch_switches_to_compact_aggregate_tracking(self):
        ids = ["o%d" % i for i in range(COMPACT_BATCH_TRACKING_THRESHOLD + 1)]
        self.c.register(self.batch_id, ids, len(ids), "core-big")
        self.assertTrue(self.batch["aggregate_core"])
        # Per-op state is dropped so a 100k-file batch never rebuilds 100k dicts.
        self.assertEqual(self.batch["operation_ids"], set())
        self.assertEqual(self.batch["terminal_ids"], set())

    def test_batch_at_the_threshold_still_tracks_per_operation(self):
        ids = ["o%d" % i for i in range(COMPACT_BATCH_TRACKING_THRESHOLD)]
        self.c.register(self.batch_id, ids, len(ids), "core-edge")
        self.assertFalse(self.batch["aggregate_core"])


class FinishedPredicateTests(unittest.TestCase):
    """One definition of 'finished', so the guard and the status cannot disagree."""

    def test_expected_count_drives_finish_before_ids_arrive(self):
        batch = {"expected_operations": 2, "terminal_ids": {"a"}}
        self.assertFalse(is_batch_finished(batch))
        batch["terminal_ids"].add("b")
        self.assertTrue(is_batch_finished(batch))

    def test_zero_expected_is_never_finished(self):
        self.assertFalse(is_batch_finished({"expected_operations": 0, "terminal_ids": set()}))

    def test_without_expected_count_uses_a_final_superset(self):
        batch = {
            "expected_operations": None,
            "ids_final": True,
            "operation_ids": {"a", "b"},
            "terminal_ids": {"a"},
        }
        self.assertFalse(is_batch_finished(batch))
        batch["terminal_ids"].add("b")
        self.assertTrue(is_batch_finished(batch))

    def test_not_final_id_set_is_never_finished(self):
        batch = {
            "expected_operations": None,
            "ids_final": False,
            "operation_ids": {"a"},
            "terminal_ids": {"a"},
        }
        self.assertFalse(is_batch_finished(batch))

    def test_dropped_terminal_event_does_not_finish_the_batch(self):
        """Core's per-op notifications are best-effort hints that can be lost."""
        panel = FakeRowView("docs")
        c = OperationBatchController()
        batch_id = c.create(panel, [{"relativePath": "docs/a"}], "Copying")
        batch = c.get(batch_id)
        c.register(batch_id, ["o1", "o2", "o3"], 3, None)
        c.record_state(batch, "o1", "done")
        c.record_state(batch, "o2", "done")
        self.assertFalse(is_batch_finished(batch))
        c.record_state(batch, "o3", "done")
        self.assertTrue(is_batch_finished(batch))


class GuardReleaseTests(unittest.TestCase):
    def setUp(self):
        self.panel = FakeRowView("docs")
        self.c = OperationBatchController()
        self.batch_id = self.c.create(self.panel, [{"relativePath": "docs/a"}], "Copying")
        self.batch = self.c.get(self.batch_id)
        self.c.register(self.batch_id, ["o1", "o2"], 2, "core-1")

    def test_waiting_peer_settles_without_terminating(self):
        c = OperationBatchController()
        batch = {"expected_operations": 1, "settled_ids": set(), "terminal_ids": set()}
        c.record_state(batch, "o1", "waiting-peer")
        # Settled so the Copy/Sync guard is released...
        self.assertTrue(c.guard_is_releasable(batch))
        # ...but not terminal, so the batch is not finished.
        self.assertFalse(is_batch_finished(batch))

    def test_active_operation_is_not_settled(self):
        c = OperationBatchController()
        batch = {"expected_operations": 1, "settled_ids": set(), "terminal_ids": set()}
        c.record_state(batch, "o1", "running")
        self.assertFalse(c.guard_is_releasable(batch))

    def test_re_activating_an_operation_unsets_settled(self):
        c = OperationBatchController()
        batch = {"expected_operations": 1, "settled_ids": {"o1"}, "terminal_ids": set()}
        c.record_state(batch, "o1", "running")
        self.assertEqual(batch["settled_ids"], set())

    def test_partial_settlement_does_not_release(self):
        c = OperationBatchController()
        batch = {"expected_operations": 3, "settled_ids": set(), "terminal_ids": set()}
        c.record_state(batch, "o1", "done")
        self.assertFalse(c.guard_is_releasable(batch))


class ActivePredicateTests(unittest.TestCase):
    def test_core_tracked_batch_stays_active_after_rows_go_terminal(self):
        batch = {"core_batch_id": "core-1", "ui_finished": False, "groups": []}
        self.assertTrue(is_batch_active(batch))

    def test_finished_ui_batch_is_inactive(self):
        self.assertFalse(is_batch_active({"ui_finished": True}))

    def test_comparing_preview_is_active(self):
        batch = {
            "ui_finished": False,
            "preview_id": "p1",
            "mirror": {"t1": {"state": "comparing", "ops": {}}},
        }
        self.assertTrue(is_batch_active(batch))

    def test_all_terminal_rows_without_core_are_inactive(self):
        batch = {
            "ui_finished": False,
            "core_batch_id": None,
            "mirror": {"t1": {"state": "done", "ops": {"a": {"state": "done"}}}},
        }
        self.assertFalse(is_batch_active(batch))

    def test_operation_ids_excludes_the_synthetic_batch_marker(self):
        batch = {"operation_ids": {"a"}, "groups": [{"ops": {"b": {}, "__batch__": {}}}]}
        self.assertEqual(operation_ids_of(batch), {"a", "b"})


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.panel = FakeRowView("docs")
        self.c = OperationBatchController()
        self.batch_id = self.c.create(self.panel, [{"relativePath": "docs/a.txt"}], "Copying")
        self.batch = self.c.get(self.batch_id)
        self.c.register(self.batch_id, ["o1"], 1, "core-1")

    def test_registered_operation_routes_to_its_row(self):
        resolved = self.c.resolve({"operationId": "o1", "state": "running", "batchId": "core-1"})
        self.assertIsNotNone(resolved)
        batch, token, incoming = resolved
        self.assertEqual(batch["ui_batch_id"], self.batch_id)
        self.assertEqual(incoming["state"], "running")

    def test_unknown_operation_without_a_path_is_cached(self):
        self.assertIsNone(self.c.resolve({"operationId": "ghost", "state": "running"}))
        self.assertIn("ghost", self.c.unrouted)

    def test_cached_event_is_merged_and_replayable(self):
        # No batch row covers this path, so the event stays buffered.
        self.assertIsNone(self.c.resolve({"operationId": "ghost", "state": "running", "relativePath": "elsewhere/x", "bytesTotal": 10}))
        self.assertIn("ghost", self.c.unrouted)
        self.assertIsNone(self.c.resolve({"operationId": "ghost", "state": "running", "bytesDone": 5}))
        merged = self.c.unrouted["ghost"]
        # A later event that omits fields must not erase earlier knowledge.
        self.assertEqual(merged["bytesTotal"], 10)
        self.assertEqual(merged["bytesDone"], 5)
        self.assertEqual(merged["relativePath"], "elsewhere/x")

    def test_registered_batch_replays_its_buffered_events(self):
        panel = FakeRowView("late")
        c = OperationBatchController()
        # Events can beat the copy admission, so they arrive before any batch
        # exists to attribute them to.
        c.resolve({"operationId": "o1", "state": "running", "batchId": "core-late", "relativePath": "late/a"})
        c.resolve({"operationId": "o2", "state": "running", "batchId": "core-late", "relativePath": "late/a"})
        self.assertEqual(len(c.unrouted), 2)

        batch_id = c.create(panel, [{"relativePath": "late/a"}], "Copying")
        c.register(batch_id, ["o1", "o2"], 2, "core-late")

        replayed = c.replayable(batch_id, "core-late")
        self.assertEqual(sorted(op for op, _ in replayed), ["o1", "o2"])

    def test_aggregate_batch_events_are_dropped_not_buffered(self):
        panel = FakeRowView("big")
        c = OperationBatchController()
        batch_id = c.create(panel, [{"relativePath": "big/a"}], "Copying")
        ids = ["o%d" % i for i in range(COMPACT_BATCH_TRACKING_THRESHOLD + 1)]
        c.register(batch_id, ids, len(ids), "core-big")

        # A per-file event for a compact batch must not be buffered: caching
        # every file of a 100k-file batch would thrash the buffer.
        self.assertIsNone(c.resolve({"operationId": "o1", "state": "running", "batchId": "core-big"}))
        self.assertEqual(c.unrouted, {})

    def test_unrouted_cache_is_bounded(self):
        from gui.operation_controller import MAX_UNROUTED_EVENTS

        for i in range(MAX_UNROUTED_EVENTS + 50):
            self.c.cache_unrouted("op%d" % i, {"state": "running"})
        self.assertEqual(len(self.c.unrouted), MAX_UNROUTED_EVENTS)

    def test_event_without_an_id_is_ignored(self):
        self.assertIsNone(self.c.resolve({"state": "running"}))

    def test_deepest_matching_batch_wins(self):
        shallow_panel = FakeRowView("docs")
        other = self.c.create(shallow_panel, [{"relativePath": "docs"}], "Copying")
        deep_panel = FakeRowView("docs/sub")
        deeper = self.c.create(deep_panel, [{"relativePath": "docs/sub"}], "Copying")
        # The operation is unknown, so it attaches by longest path prefix.
        self.assertTrue(self.c.attach_to_batch("o9", {"relativePath": "docs/sub/file.txt"}))
        batch_id, _token = self.c.route_by_op["o9"]
        self.assertEqual(batch_id, deeper)
        self.assertNotEqual(batch_id, other)


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.panel = FakeRowView("docs")
        self.c = OperationBatchController()
        self.batch_id = self.c.create(self.panel, [{"relativePath": "docs/a"}], "Copying")
        self.batch = self.c.get(self.batch_id)
        self.c.register(self.batch_id, ["o1"], 1, None)

    def test_percent_is_none_when_every_row_is_terminal(self):
        set_op(self.c, self.batch, self.panel, "o1", "done", bytesDone=10, bytesTotal=10)
        self.assertIsNone(self.c.aggregate_percent(self.batch))

    def test_percent_reflects_partial_progress(self):
        set_op(self.c, self.batch, self.panel, "o1", "active", bytesDone=5, bytesTotal=10)
        self.assertEqual(self.c.aggregate_percent(self.batch), 50)

    def test_percent_does_not_read_the_row_view(self):
        """The controller owns the state, so progress survives a dead view."""
        set_op(self.c, self.batch, self.panel, "o1", "active", bytesDone=5, bytesTotal=10)
        self.panel._groups = {}
        self.assertEqual(self.c.aggregate_percent(self.batch), 50)

    def test_marking_ids_final_re_derives_the_row_state(self):
        set_op(self.c, self.batch, self.panel, "o1", "done", bytesDone=10, bytesTotal=10)
        mirror = self.batch["mirror"][self.batch["groups"][0]["token"]]
        # Terminal bytes with an open id set: the row is not publishable yet.
        self.assertEqual(mirror["state"], "active")

        self.c.mark_ids_final(self.batch)
        self.assertEqual(mirror["state"], "done")

    def test_row_state_is_derived_from_operation_states(self):
        token = self.batch["groups"][0]["token"]
        set_op(self.c, self.batch, self.panel, "o1", "active", bytesDone=1, bytesTotal=10)
        self.assertEqual(self.batch["mirror"][token]["state"], "active")

        set_op(self.c, self.batch, self.panel, "o1", "waiting-peer")
        self.assertEqual(self.batch["mirror"][token]["state"], "waiting-peer")

        set_op(self.c, self.batch, self.panel, "o1", "finalizing")
        self.assertEqual(self.batch["mirror"][token]["state"], "finalizing")

    def test_derived_state_matches_the_row_view_exactly(self):
        """The mirror must not invent a different state than the panel would."""
        from gui.panel import operation_group_copy_complete

        token = self.batch["groups"][0]["token"]
        set_op(self.c, self.batch, self.panel, "o1", "failed", bytesDone=1, bytesTotal=10)
        mirror = self.batch["mirror"][token]
        group = self.panel.operation_group(token)

        # A terminal operation with an open id set is not yet publishable, so
        # both views report "active". The controller must not disagree.
        self.assertEqual(mirror["state"], "active")
        self.assertFalse(operation_group_copy_complete(mirror))
        self.assertFalse(operation_group_copy_complete(group))

        # Once the ids are final the row becomes publishable, and the controller
        # says exactly what the row view's own predicate now says.
        self.c.mark_ids_final(self.batch)
        self.assertTrue(operation_group_copy_complete(mirror))
        self.assertEqual(mirror["state"], "failed")

    def test_ingest_is_ignored_for_an_unknown_token(self):
        self.assertFalse(self.c.ingest(self.batch, "nope", "o1", {"state": "active"}))

    def test_unchanged_percent_is_not_republished(self):
        self.assertTrue(self.c.should_publish(self.batch_id, 50))
        self.assertFalse(self.c.should_publish(self.batch_id, 50))
        self.assertTrue(self.c.should_publish(self.batch_id, 51))

    def test_terminal_batch_is_never_published(self):
        self.assertFalse(self.c.should_publish(self.batch_id, None))


class TerminalStateAgreementTests(unittest.TestCase):
    """The row and the batch must never disagree about 'terminal'."""

    def test_controller_reuses_the_panels_terminal_set(self):
        from gui import operation_controller, panel

        self.assertIs(operation_controller.TERMINAL_STATES, panel.TERMINAL_STATES)

    def test_every_terminal_state_finishes_a_single_operation_batch(self):
        from gui.operation_controller import TERMINAL_STATES

        c = OperationBatchController()
        for state in TERMINAL_STATES:
            batch = {"expected_operations": 1, "terminal_ids": set(), "settled_ids": set()}
            c.record_state(batch, "o1", state)
            self.assertTrue(
                is_batch_finished(batch),
                "%s must finish the batch" % state,
            )

    def test_non_terminal_states_do_not_finish_a_batch(self):
        c = OperationBatchController()
        for state in ("running", "queued", "waiting-peer", "recovery-blocked"):
            batch = {"expected_operations": 1, "terminal_ids": set(), "settled_ids": set()}
            c.record_state(batch, "o1", state)
            self.assertFalse(
                is_batch_finished(batch),
                "%s must not finish the batch" % state,
            )


class InvalidationTests(unittest.TestCase):
    def test_invalidate_clears_every_index(self):
        panel = FakeRowView("docs")
        c = OperationBatchController()
        batch_id = c.create(panel, [{"relativePath": "docs/a"}], "Copying")
        c.register(batch_id, ["o1"], 1, "core-1")
        c.cache_unrouted("oX", {"state": "running"})
        c.should_publish(batch_id, 10)

        c.invalidate(core_generation=7)

        self.assertEqual(c.batches, {})
        self.assertEqual(c.route_by_op, {})
        self.assertEqual(c.ui_by_core, {})
        self.assertEqual(c.unrouted, {})
        self.assertEqual(c.core_generation, 7)
        # A stale percent must not suppress the next status after a restart.
        self.assertTrue(c.should_publish(batch_id, 10))

    def test_cleanup_removes_routes_pointing_at_the_batch(self):
        panel = FakeRowView("docs")
        c = OperationBatchController()
        batch_id = c.create(panel, [{"relativePath": "docs/a"}], "Copying")
        c.register(batch_id, ["o1"], 1, "core-1")
        c.resolve({"operationId": "o1", "state": "running", "batchId": "core-1"})
        self.assertIn("o1", c.route_by_op)

        c.cleanup(batch_id)

        self.assertNotIn(batch_id, c.batches)
        self.assertNotIn("o1", c.route_by_op)
        self.assertNotIn("core-1", c.ui_by_core)

    def test_cleanup_of_an_unknown_batch_is_harmless(self):
        self.assertIsNone(OperationBatchController().cleanup("nope"))


if __name__ == "__main__":
    unittest.main()
