"""Batch bookkeeping for transfer operations, free of Tk.

Core owns the durable transfer state. The UI only needs to answer three
questions while a batch runs:

* which row does this operation belong to,
* is the batch finished (so the copy/sync guard can be released and the
  terminal status shown),
* what is the aggregate progress shown in the status line.

This module owns the state behind those questions so there is exactly one
definition of each. The window keeps the Tk and RPC work; everything here is a
plain dict, which is what makes it testable without a display.
"""

from gui.panel import (
    TERMINAL_STATES,
    match_operation_token,
    merge_operation_payload,
    operation_group_copy_complete,
    operation_group_display_percent,
)

#: Terminal states plus the parked states that must not hold the workflow
#: hostage. ``waiting-peer`` is settled for the guard: the durable Core journal
#: owns retry/resume, so a parked transfer must not disable Copy/Sync forever.
SETTLED_STATES = frozenset({"done", "failed", "cancelled", "stale", "recovery-blocked", "waiting-peer"})

#: States that surface as a user-visible failure on a row or a batch.
FAILED_STATES = frozenset({"failed", "stale", "recovery-blocked"})

#: Batches above this size are tracked by compact `batchStatus` polling instead
#: of per-operation ids, so the UI never rebuilds 100k op dictionaries.
COMPACT_BATCH_TRACKING_THRESHOLD = 256

#: A large multi-select draws one aggregate row indicator rather than hundreds
#: of per-row Canvas overlays, which cost more than the transfer itself.
MAX_ROW_OVERLAYS = 32

#: Bound on events held for a batch that has not registered its ids yet. An
#: event that never finds a row must not grow without limit.
MAX_UNROUTED_EVENTS = 512


def _int_bytes(value, default=0):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return default


def is_batch_finished(batch):
    """Has every accepted operation of this batch reached a terminal state?

    ``expected_operations`` is the authority once Core has confirmed the
    accepted count, because per-operation notifications are best-effort hints
    that can be dropped. Before that, the batch is finished only when the id
    set is final and every known id is terminal.
    """
    batch = batch or {}
    expected = batch.get("expected_operations")
    if expected is not None:
        return int(expected or 0) > 0 and len(batch.get("terminal_ids") or ()) >= int(expected or 0)
    ids = batch.get("operation_ids") or set()
    return bool(batch.get("ids_final") and ids and (batch.get("terminal_ids") or set()).issuperset(ids))


def is_batch_active(batch):
    """Should this batch still hold the Copy/Sync guard?"""
    if not batch or batch.get("ui_finished"):
        return False
    # A Core-tracked batch stays active until the durable batch converges, even
    # if its rows have already gone terminal.
    if batch.get("core_batch_id"):
        return True
    mirrors = (batch.get("mirror") or {}).values()
    if batch.get("preview_id") and any(str(m.get("state") or "") == "comparing" for m in mirrors):
        return True
    return any(
        str(row.get("state") or "") not in TERMINAL_STATES
        for mirror in mirrors
        for row in (mirror.get("ops") or {}).values()
    )


def operation_ids_of(batch):
    ids = set((batch or {}).get("operation_ids") or ())
    for group in (batch or {}).get("groups") or []:
        ids.update((group.get("ops") or {}).keys())
    ids.discard("__batch__")
    return ids


def derive_group_state(mirror):
    """Row state implied by the operation states a mirror has seen.

    Mirrors `FilePanel._recalculate_group`, so the controller can answer "is
    this row done" and "how far along is it" from data it owns, rather than
    reading the widget's group back out of the view.
    """
    ops = (mirror or {}).get("ops") or {}
    if not ops:
        # A preview still comparing has no operations yet but is not queued.
        return "comparing" if str((mirror or {}).get("state") or "") == "comparing" else "queued"
    states = [str((row or {}).get("state") or "queued") for row in ops.values()]
    all_terminal = all(state in TERMINAL_STATES for state in states)
    if all_terminal and not operation_group_copy_complete(mirror):
        return "active"
    if all_terminal:
        if any(state in ("failed", "stale") for state in states):
            return "failed"
        if any(state == "cancelled" for state in states):
            return "cancelled"
        return "done"
    if "active" in states:
        return "active"
    if any(state in ("waiting-peer", "cancel-pending") for state in states):
        return "waiting-peer"
    if "finalizing" in states:
        return "finalizing"
    return "queued"


class OperationBatchController:
    """Single owner of UI-side batch state."""

    def __init__(self, core_generation=0):
        self.batches = {}
        self.route_by_op = {}
        self.ui_by_core = {}
        self.unrouted = {}
        self.core_generation = core_generation
        self._seq = 0
        # batch_id -> last published status, so a repaint that would not change
        # the status line does not re-run Tk work.
        self._published = {}

    # ---------- lifecycle ----------

    def invalidate(self, core_generation=None):
        """Drop all state when the Core owner changes underneath us."""
        if core_generation is not None:
            self.core_generation = core_generation
        self.batches.clear()
        self.route_by_op.clear()
        self.ui_by_core.clear()
        self.unrouted.clear()
        self._published.clear()

    def get(self, batch_id):
        return self.batches.get(batch_id or "")

    def create(self, panel, entries, label, expected_bytes=0, expected_files=0, row_view=None):
        """Start a batch and open its row overlays. Returns the batch id."""
        row_view = row_view or panel
        groups = []
        entries = list(entries or [])
        overlay_entries = entries if len(entries) <= MAX_ROW_OVERLAYS else entries[:1]
        for entry in overlay_entries:
            token = row_view.begin_row_operation(
                entry,
                label,
                expected_bytes=expected_bytes,
                expected_files=expected_files,
            )
            if token:
                groups.append({"token": token, "path": str(entry.get("relativePath") or getattr(panel, "rel", "") or "")})
        if not groups:
            token = row_view.begin_row_operation(
                {"relativePath": getattr(panel, "rel", "") or "", "name": getattr(panel, "rel", "") or "/"},
                label,
                expected_bytes=expected_bytes,
                expected_files=expected_files,
            )
            if token:
                groups.append({"token": token, "path": str(getattr(panel, "rel", "") or "")})
        if not groups:
            return None

        self._seq += 1
        batch_id = "ui:%d" % self._seq
        self.batches[batch_id] = {
            "ui_batch_id": batch_id,
            "panel": panel,
            "groups": groups,
            "operation_ids": set(),
            "terminal_ids": set(),
            "settled_ids": set(),
            "ids_final": False,
            "expected_operations": None,
            "core_batch_id": None,
            "aggregate_core": False,
            "batch_poll_inflight": False,
            "poll_failures": 0,
            "last_completed": -1,
            "idle_polls": 0,
            "last_error": None,
            "core_generation": self.core_generation,
            "guard": None,
            "label": str(label or ""),
            # token -> the operation state this controller owns. Kept in step
            # with the row view, but the controller never reads the view back:
            # batch semantics and the status line are answered from this mirror.
            "mirror": {
                group["token"]: {
                    "state": "queued",
                    "ids_final": False,
                    "expected_bytes": expected_bytes,
                    "expected_files": expected_files,
                    "ops": {},
                }
                for group in groups
            },
        }
        return batch_id

    def register(self, batch_id, operation_ids, accepted_count=None, core_batch_id=None):
        """Bind accepted operation ids to a pending batch."""
        batch = self.get(batch_id)
        if not batch:
            return None
        op_ids = [str(x) for x in (operation_ids or []) if x]
        batch["operation_ids"].update(op_ids)
        batch["ids_final"] = True
        try:
            expected = int(accepted_count) if accepted_count is not None else len(op_ids)
        except (TypeError, ValueError):
            expected = len(op_ids)
        batch["expected_operations"] = max(0, expected)
        batch["core_batch_id"] = str(core_batch_id or "") or None
        if batch["core_batch_id"]:
            self.ui_by_core[batch["core_batch_id"]] = batch_id

        if batch["core_batch_id"] and batch["expected_operations"] > COMPACT_BATCH_TRACKING_THRESHOLD:
            batch["aggregate_core"] = True
            # Core intentionally omits large operation-id arrays. Do not rebuild
            # the same O(N) state in Python from per-file events; poll compact
            # batch status and render one aggregate progress row instead.
            batch["operation_ids"].clear()
            batch["terminal_ids"].clear()
            batch["settled_ids"].clear()
            return batch

        # A single-row batch can route every operation straight to that row;
        # a multi-row batch resolves each operation by path at event time.
        single = batch["groups"][0]["token"] if len(batch["groups"]) == 1 else None
        batch["single_token"] = single
        for op_id in batch["operation_ids"]:
            self.route_by_op[op_id] = (batch_id, single)
        return batch

    def replayable(self, batch_id, core_batch_id=None):
        """Cached events that this registration can now attribute, in order.

        Events can arrive before Core answers the copy admission, so they are
        buffered. Once the ids are known they are replayed to preserve ordering.
        """
        batch_id = batch_id or ""
        core_batch_id = str(core_batch_id or "")
        ready = [op_id for op_id in list(self.unrouted) if self.route_by_op.get(op_id, ("", None))[0] == batch_id]
        if core_batch_id:
            ready.extend(
                op_id
                for op_id, payload in list(self.unrouted.items())
                if op_id not in ready and str((payload or {}).get("batchId") or "") == core_batch_id
            )
        return [(op_id, self.unrouted.get(op_id)) for op_id in ready]

    def cleanup(self, batch_id):
        batch = self.batches.pop(batch_id or "", None)
        if not batch:
            return None
        self._published.pop(batch_id, None)
        core_batch_id = str(batch.get("core_batch_id") or "")
        if core_batch_id and self.ui_by_core.get(core_batch_id) == batch_id:
            self.ui_by_core.pop(core_batch_id, None)
        for op_id, (owner, _token) in list(self.route_by_op.items()):
            if owner == batch_id:
                self.route_by_op.pop(op_id, None)
        return batch

    # ---------- routing ----------

    def cache_unrouted(self, op_id, payload):
        self.unrouted[op_id] = merge_operation_payload(self.unrouted.get(op_id) or {}, payload)
        while len(self.unrouted) > MAX_UNROUTED_EVENTS:
            self.unrouted.pop(next(iter(self.unrouted)), None)

    def take_unrouted(self, op_id):
        return self.unrouted.pop(op_id, None)

    def bind(self, batch_id, token, op_id):
        self.route_by_op[op_id] = (batch_id, token)
        batch = self.get(batch_id)
        if batch is not None:
            batch["operation_ids"].add(op_id)

    def token_for_path(self, batch, relative_path):
        return match_operation_token((batch or {}).get("groups") or [], relative_path)

    def attach_to_batch(self, op_id, payload):
        """Attribute an event to the batch owning the longest matching path.

        Several batches can contain the same directory (a sync preview and a
        copy, say). The deepest path wins, because it is the more specific row
        the event actually describes.
        """
        token = None
        batch_id = None
        best_len = -1
        for bid, batch in self.batches.items():
            found = self.token_for_path(batch, (payload or {}).get("relativePath"))
            if not found:
                continue
            path = ""
            for group in batch.get("groups") or []:
                if group.get("token") == found:
                    path = str(group.get("path") or "")
                    break
            prefix = len(path.strip("/"))
            if prefix > best_len:
                best_len = prefix
                token = found
                batch_id = bid
        if not token or not batch_id:
            return False
        self.bind(batch_id, token, op_id)
        return True

    def resolve(self, payload):
        """Resolve an event to ``(batch, token, merged_payload)``.

        Returns ``None`` when there is nothing to paint. An event that cannot be
        attributed to a row yet is cached here, so a later batch registration can
        replay it in order. An event belonging to a compact-aggregate batch is
        deliberately dropped instead: caching those would churn the buffer once
        per file of a 100k-file batch.
        """
        payload = payload or {}
        op_id = str(payload.get("operationId") or "")
        if not op_id:
            return None
        incoming = merge_operation_payload(self.unrouted.get(op_id) or {}, payload)
        core_batch_id = str(incoming.get("batchId") or "")

        aggregate_ui_id = self.ui_by_core.get(core_batch_id) if core_batch_id else None
        aggregate_batch = self.get(aggregate_ui_id) if aggregate_ui_id else None
        if aggregate_batch and aggregate_batch.get("aggregate_core"):
            # Large batches are represented by compact batchStatus polling. A
            # per-file event may still carry an error, but must not recreate
            # 100k operation-id dictionaries in Python.
            state = str(incoming.get("state") or "")
            if state in FAILED_STATES and incoming.get("error"):
                aggregate_batch["last_error"] = incoming.get("error")
            return None

        route = self.route_by_op.get(op_id)
        if route is None and core_batch_id:
            for candidate_id, candidate in self.batches.items():
                if str(candidate.get("core_batch_id") or "") != core_batch_id:
                    continue
                token = self.token_for_path(candidate, incoming.get("relativePath"))
                if token:
                    self.bind(candidate_id, token, op_id)
                    route = (candidate_id, token)
                break

        if route is None and not self.attach_to_batch(op_id, incoming):
            self.cache_unrouted(op_id, incoming)
            return None
        if route is None:
            route = self.route_by_op.get(op_id)
            if route is None:
                return None

        batch_id, token = route
        batch = self.get(batch_id)
        if not batch:
            return None
        if not token:
            token = self.token_for_path(batch, incoming.get("relativePath"))
            if token:
                self.bind(batch_id, token, op_id)
        if not token:
            self.cache_unrouted(op_id, incoming)
            return None
        return batch, token, incoming

    def record_state(self, batch, op_id, state):
        """Fold an operation's new state into the batch counters and mirror."""
        if state in TERMINAL_STATES:
            batch["terminal_ids"].add(op_id)
            batch["settled_ids"].add(op_id)
        elif state == "waiting-peer":
            # Settled for the guard, but not terminal: the transfer resumes
            # rather than finishing.
            batch["settled_ids"].add(op_id)
        elif state:
            batch["settled_ids"].discard(op_id)

    def ingest(self, batch, token, op_id, payload):
        """Record one operation event into the controller-owned mirror."""
        payload = payload or {}
        mirror = (batch.get("mirror") or {}).get(token)
        if mirror is None:
            return False
        row = mirror["ops"].setdefault(op_id, {})
        row.update(
            {
                "state": str(payload.get("state") or "queued"),
                "bytesDone": _int_bytes(payload.get("bytesDone"), 0),
                "bytesTotal": _int_bytes(payload.get("bytesTotal") or payload.get("size"), 0),
            }
        )
        mirror["state"] = derive_group_state(mirror)
        return True

    def mark_ids_final(self, batch):
        """The accepted id set is known, so a row may stop accepting new ops."""
        for mirror in (batch.get("mirror") or {}).values():
            mirror["ids_final"] = True
            # A row that was holding at "active" because its ids were still
            # open becomes publishable now, so the state is re-derived.
            mirror["state"] = derive_group_state(mirror)

    def set_group_phase(self, batch, state):
        """Record a row-level phase that is not derived from operations.

        A sync preview is `comparing` before any operation exists, which the
        operation states alone cannot express.
        """
        for mirror in (batch.get("mirror") or {}).values():
            if not (mirror.get("ops") or {}):
                mirror["state"] = state

    def guard_is_releasable(self, batch):
        expected = int(batch.get("expected_operations") or 0)
        return expected > 0 and len(batch.get("settled_ids") or ()) >= expected

    # ---------- queries ----------

    def is_finished(self, batch):
        return is_batch_finished(batch)

    def is_active(self, batch):
        return is_batch_active(batch)

    def operation_ids(self, batch):
        return operation_ids_of(batch)

    def active_batches(self):
        return [b for b in self.batches.values() if is_batch_active(b)]

    # ---------- progress ----------

    def aggregate_percent(self, batch):
        """Mean of the per-row display percents, or None when nothing is live.

        Computed from the controller-owned mirror: the row view is a renderer,
        not a source of truth, so batch progress does not depend on it.
        """
        mirrors = [m for m in ((batch or {}).get("mirror") or {}).values() if m]
        if not mirrors:
            return None
        if all(
            str(row.get("state") or "") in TERMINAL_STATES
            for mirror in mirrors
            for row in (mirror.get("ops") or {}).values()
        ):
            return None
        percents = [operation_group_display_percent(mirror) for mirror in mirrors]
        return int(round(sum(percents) / max(1, len(percents))))

    def should_publish(self, batch_id, percent):
        """True when the status line would actually change.

        Without this, every progress event of every operation in a batch
        recomputes and re-renders an identical status string.
        """
        if percent is None:
            return False
        if self._published.get(batch_id) == percent:
            return False
        self._published[batch_id] = percent
        return True
