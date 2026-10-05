"""Tk-safe bounded Core RPC worker pool.

A fixed number of daemon workers prevents large folder operations from creating
one Python thread per RPC. Workers never call Tk: results are placed on a
thread-safe queue that the Tk thread drains on a short timer.
"""

import queue
import threading
import traceback


class CoreBridge:
    def __init__(self, root, get_client, workers=4, max_pending=256, max_results=512):
        self._root = root
        self._get_client = get_client
        self._jobs = queue.Queue(maxsize=max_pending)
        self._results = queue.Queue(maxsize=max(64, int(max_results)))
        self._closed = False
        self._state_lock = threading.Lock()
        self._idle_drains = 0
        self._workers = []
        for idx in range(max(1, int(workers))):
            thread = threading.Thread(
                target=self._worker,
                name="core-rpc-%d" % (idx + 1),
                daemon=True,
            )
            thread.start()
            self._workers.append(thread)
        self._root.after(25, self._drain_results)

    def call(self, method, payload=None, on_ok=None, on_err=None, timeout=60.0):
        immediate_error = None
        accepted = False
        owner = None
        try:
            owner = self._get_client()
        except Exception as exc:  # noqa: BLE001
            immediate_error = exc
        job = (owner, method, payload or {}, on_ok, on_err, timeout)
        with self._state_lock:
            if immediate_error is not None:
                pass
            elif self._closed:
                immediate_error = RuntimeError("bridge closed")
            else:
                try:
                    self._jobs.put_nowait(job)
                    accepted = True
                except queue.Full:
                    immediate_error = RuntimeError("Слишком много операций; дождитесь завершения текущих")
        # Never invoke user/Tk callbacks while holding the bridge state lock.
        if immediate_error is not None and on_err:
            on_err(immediate_error)
        return accepted

    def close(self):
        # Serialize close against call(): once _closed is published no caller can
        # enqueue a job after the pending queue has been drained.
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
        # Drop work that has not started. The old sentinel approach could fail
        # when the bounded queue was full, leaving workers to execute queued RPCs
        # after the UI had already begun shutdown.
        while True:
            try:
                self._jobs.get_nowait()
            except queue.Empty:
                break
            else:
                self._jobs.task_done()

    def _publish_result(self, item):
        while not self._closed:
            try:
                self._results.put(item, timeout=0.1)
                return True
            except queue.Full:
                continue
        return False

    def _worker(self):
        while not self._closed:
            try:
                job = self._jobs.get(timeout=0.1)
            except queue.Empty:
                continue
            except Exception:  # pragma: no cover - defensive runtime guard
                return
            if self._closed:
                self._jobs.task_done()
                return
            if job is None:
                self._jobs.task_done()
                return
            owner, method, payload, on_ok, on_err, timeout = job
            try:
                frame = owner.request(method, payload, timeout=timeout)
            except Exception as exc:  # noqa: BLE001
                self._publish_result((owner, None, exc, on_ok, on_err))
            else:
                self._publish_result((owner, frame, None, on_ok, on_err))
            finally:
                self._jobs.task_done()

    def _drain_results(self):
        if self._closed:
            return
        drained = 0
        try:
            for _ in range(96):
                try:
                    result = self._results.get_nowait()
                except queue.Empty:
                    break
                drained += 1
                try:
                    # New bridge workers publish the Core owner together with the
                    # result so a callback from an old generation cannot mutate
                    # replacement UI state. Keep accepting the historical 4-tuple
                    # shape as well: tests and any already-queued local result use
                    # that internal contract and have no owner identity to verify.
                    if len(result) == 5:
                        owner, frame, err, on_ok, on_err = result
                        owner_bound = True
                    elif len(result) == 4:
                        frame, err, on_ok, on_err = result
                        owner = None
                        owner_bound = False
                    else:
                        raise ValueError(
                            "invalid CoreBridge result tuple length: %d" % len(result)
                        )

                    if owner_bound:
                        try:
                            current_owner = self._get_client()
                        except Exception:  # noqa: BLE001
                            current_owner = None
                        # Results are meaningful only for the Core generation that
                        # accepted the RPC. A restart must not let an old callback
                        # mutate the replacement Core's UI state.
                        if owner is not current_owner:
                            continue
                    if err is not None:
                        if on_err:
                            on_err(err)
                        continue
                    if not frame or not frame.get("ok"):
                        if on_err:
                            on_err(frame.get("error") if isinstance(frame, dict) else frame)
                        continue
                    if on_ok:
                        on_ok(frame.get("result"))
                except Exception:  # noqa: BLE001 - a UI callback must not kill the pump
                    traceback.print_exc()
        finally:
            if not self._closed:
                if drained or not self._jobs.empty():
                    self._idle_drains = 0
                    delay = 25
                else:
                    self._idle_drains = min(self._idle_drains + 1, 8)
                    delay = min(200, 25 * (2 ** min(self._idle_drains, 3)))
                try:
                    self._root.after(delay, self._drain_results)
                except Exception:  # noqa: BLE001
                    pass
