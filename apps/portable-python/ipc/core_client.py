"""Spawn PSNCore.exe and speak framed JSON over named-pipe stdio.

Design: the Python shell is the parent,
owns stdin/stdout as the framed RPC boundary and stderr as a rotating log.
Named pipes are used because Bare/`bare-pipe` async handles (what PSNCore
sees as inherited stdio) require overlapped (async) ends on the child side and
blocking ends on the parent side; anonymous pipes deadlock under
subprocess.PIPE on Windows for full-duplex framing.
"""

import os
import queue
import subprocess
import threading
import time

from windows import pipes, process_tree
from ipc import framing


_DEAD = {
    "type": "response",
    "ok": False,
    "error": {"code": "IO", "message": "core stopped"},
}

# Requests with no filesystem/user-data side effects. If one of these exceeds
# its response deadline after the cancel frame was written, the caller may time
# out without killing an otherwise healthy Core process.
_READ_ONLY_METHODS = {
    "fs.list", "fs.stat", "fs.statBatch", "fs.manifest", "fs.syncPreview",
    "operation.list", "operation.batchStatus", "operation.recoveryInfo",
    "roots.listLocal", "roots.browse", "chat.history", "peer.list",
    "getStatus", "core.getStatus", "ping",
}

# Hard cap for one unfinished Core stderr record. Normal records are
# newline-delimited and field-bounded; this only bounds a malfunctioning child
# that writes a newline-free stream, so diagnostics cannot buffer to EOF.
_STDERR_MAX_LINE_CHARS = 1024 * 1024

# Hard cap on admitted-but-unanswered RPC waiters. The write queue is already
# bounded; this bounds the matching pending map so a caller bug or a Core that
# never answers cannot grow _pending without limit.
_MAX_PENDING_REQUESTS = 512


class CoreClient:
    def __init__(self, core_path, data_root, log_path, app_version="0.0.0", build_label="dev", release_revision=0, extra_args=(), pass_data_arg=True, diagnostics=None, debug=False):
        self.core_path = core_path
        self.data_root = data_root
        self.log_path = log_path
        self.app_version = app_version
        self.build_label = build_label
        self.release_revision = release_revision
        self.extra_args = list(extra_args or ())
        self.pass_data_arg = pass_data_arg
        self.diagnostics = diagnostics
        self.debug = bool(debug)
        self.proc = None
        self._process_job = None
        self._to_child = None
        self._from_child = None
        self._stderr_channel = None
        self._stderr_thread = None
        self._reader_thread = None
        self._writer_thread = None
        self._write_queue = queue.Queue(maxsize=128)
        self._stop = threading.Event()
        self._event_cb = None
        # Pending RPC state and potentially blocking pipe writes must never use
        # the same lock. Shutdown has to be able to fail waiters even while a
        # writer is blocked by pipe backpressure.
        self._pending_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._stop_lock = threading.Lock()
        self._pending = {}
        self._seq = 0
        self._closed = False
        self._transport_abort_started = threading.Event()

    def start(self, event_cb):
        """event_cb(dict) is invoked from a reader thread for every non-response frame."""
        self._closed = False
        self._stop.clear()
        self._transport_abort_started.clear()
        self._event_cb = event_cb
        self._write_queue = queue.Queue(maxsize=128)

        to_child = None
        from_child = None
        stderr_channel = None
        proc = None
        process_job = None
        try:
            to_child, from_child = pipes.create_ipc_pairs("core")
            stderr_channel = pipes.create_child_output_pipe("core-stderr")
            process_job = process_tree.create_kill_on_close_job()
            args = [
                self.core_path,
                f"--app-version={self.app_version}",
                f"--build-label={self.build_label}",
                f"--release-revision={int(self.release_revision)}",
            ]
            if self.pass_data_arg:
                args.append(f"--data={self.data_root}")
            if self.debug:
                args.append("--debug")
            args += self.extra_args
            env = os.environ.copy()
            if not self.pass_data_arg:
                env.pop("PEERSYNC_DATA", None)

            proc = subprocess.Popen(  # noqa: S603
                args,
                stdin=to_child.child_handle_for_spawn(),
                stdout=from_child.child_handle_for_spawn(),
                stderr=stderr_channel.child_handle_for_spawn(),
                cwd=None,
                env=env,
                # A per-Core Job Object owns the whole process tree. Start the
                # Core suspended so it cannot spawn an I/O worker before Job
                # assignment; only then resume its primary thread.
                creationflags=subprocess.CREATE_NO_WINDOW | process_tree.CREATE_SUSPENDED,
            )
            process_tree.assign_process(process_job, proc.pid)
            process_tree.resume_suspended_process(proc.pid)
            to_child.release_child_end()
            from_child.release_child_end()
            stderr_channel.release_child_end()

            # Publish ownership only after the whole acquisition sequence has
            # succeeded. Any exception before this point is rolled back below.
            self._to_child = to_child
            self._from_child = from_child
            self._stderr_channel = stderr_channel
            self.proc = proc
            self._process_job = process_job
            process_job = None
            self._stderr_thread = threading.Thread(target=self._stderr_loop, name="core-stderr-relay", daemon=True)
            self._stderr_thread.start()
            self._writer_thread = threading.Thread(target=self._write_loop, name="core-ipc-writer", daemon=True)
            self._writer_thread.start()
            self._reader_thread = threading.Thread(target=self._read_loop, name="core-ipc-reader", daemon=True)
            self._reader_thread.start()
        except Exception:
            self._stop.set()
            rollback_job = process_job if process_job is not None else self._process_job
            rollback_job_empty = rollback_job is None
            if proc is not None:
                try:
                    if rollback_job is not None:
                        rollback_job_empty = process_tree.terminate_job_and_wait(rollback_job, timeout=5.0)
                    # Assignment itself can fail, leaving a CREATE_SUSPENDED
                    # process outside the job. Always retain the direct-PID
                    # fallback during acquisition rollback.
                    if proc.poll() is None:
                        proc.kill()
                    proc.wait(timeout=1.0)
                except Exception:  # noqa: BLE001 - best effort rollback
                    pass
            if rollback_job is not None and rollback_job_empty:
                try:
                    process_tree.close_job(rollback_job)
                except Exception:  # noqa: BLE001
                    pass
            for channel in (to_child, from_child, stderr_channel):
                try:
                    if channel is not None:
                        channel.close()
                except Exception:  # noqa: BLE001
                    pass
            self._to_child = None
            self._from_child = None
            self._stderr_channel = None
            self.proc = None
            self._process_job = None
            raise

    def _ingest_truncated_stderr(self, dropped):
        """Record that an unfinished stderr line exceeded the hard cap."""
        try:
            self.diagnostics.ingest_core_line(
                "%s [truncated after %d chars]" % (dropped[:_STDERR_MAX_LINE_CHARS], _STDERR_MAX_LINE_CHARS)
            )
        except Exception:  # Drain stderr even if the optional log sink fails.
            pass

    def _stderr_loop(self):
        channel = self._stderr_channel
        if channel is None or channel.parent_file is None:
            return
        pipe = channel.parent_file
        if self.diagnostics is not None:
            pending = ""
            try:
                while True:
                    chunk = pipe.read(65536)
                    if not chunk:
                        break
                    pending += chunk.decode("utf-8", "replace")
                    while "\n" in pending:
                        line, pending = pending.split("\n", 1)
                        try:
                            self.diagnostics.ingest_core_line(line)
                        except Exception:  # Drain stderr even if the optional log sink fails.
                            pass
                    # A malfunctioning Core can emit a record without a newline.
                    # Cap the unfinished line so the buffer cannot grow to EOF,
                    # ingest a synthetic truncated record and continue draining.
                    if len(pending) > _STDERR_MAX_LINE_CHARS:
                        self._ingest_truncated_stderr(pending)
                        pending = ""
                if pending:
                    try:
                        self.diagnostics.ingest_core_line(pending)
                    except Exception:
                        pass
            except Exception:
                pass
            return
        max_bytes = 5 * 1024 * 1024
        backups = 3
        out = None
        size = 0
        next_rotate_retry = 0.0
        try:
            parent = os.path.dirname(os.path.abspath(self.log_path))
            if parent:
                os.makedirs(parent, exist_ok=True)
            pipes.rotate_log_files(self.log_path, max_bytes=max_bytes, backups=backups)
            try:
                size = os.path.getsize(self.log_path)
            except OSError:
                size = 0
            while True:
                try:
                    chunk = pipe.read(65536)
                except (OSError, ValueError):
                    break
                if not chunk:
                    break
                if size + len(chunk) > max_bytes:
                    now = time.monotonic()
                    if now >= next_rotate_retry:
                        if out is not None:
                            try:
                                out.close()
                            finally:
                                out = None
                        if pipes.rotate_log_files(self.log_path, max_bytes=max_bytes, backups=backups, force=True):
                            size = 0
                            next_rotate_retry = 0.0
                        else:
                            try:
                                size = os.path.getsize(self.log_path)
                            except OSError:
                                size = max_bytes
                            next_rotate_retry = now + 1.0
                    if size + len(chunk) > max_bytes:
                        continue
                if out is None:
                    out = open(self.log_path, "ab", buffering=0)
                out.write(chunk)
                size += len(chunk)
        except Exception:
            pass
        finally:
            try:
                if out is not None:
                    out.close()
            except Exception:
                pass

    def _fail_pending(self):
        with self._pending_lock:
            waiters = list(self._pending.values())
            self._pending.clear()
        for waiter in waiters:
            waiter["result"] = dict(_DEAD)
            waiter["ev"].set()

    def _read_loop(self):
        pipe = self._from_child.parent_file
        unexpected_disconnect = False
        try:
            while not self._stop.is_set():
                try:
                    frame = framing.read_frame(pipe)
                except (framing.FrameError, EOFError, OSError):
                    unexpected_disconnect = not self._closed
                    break
                if frame is None:
                    unexpected_disconnect = not self._closed and not self._stop.is_set()
                    break
                ftype = frame.get("type")
                if ftype == "response":
                    rid = frame.get("requestId")
                    with self._pending_lock:
                        waiter = self._pending.pop(rid, None)
                    if waiter is not None:
                        waiter["result"] = frame
                        waiter["ev"].set()
                else:
                    if self.diagnostics is not None and ftype == "event":
                        self.diagnostics.log(
                            "debug",
                            "ipc",
                            "event",
                            str(frame.get("event") or "core.event"),
                            "Core event",
                            payload=frame.get("payload"),
                        )
                    try:
                        self._event_cb(frame)
                    except Exception:  # noqa: BLE001 - UI must not kill reader
                        pass
        finally:
            self._stop.set()
            self._fail_pending()
            if unexpected_disconnect:
                self._fail_queued_writes("core ipc reader stopped")
            if not self._closed and self._event_cb is not None:
                code = None
                try:
                    if self.proc is not None:
                        code = self.proc.poll()
                except Exception:  # noqa: BLE001
                    pass
                try:
                    self._event_cb({"type": "event", "event": "core.stopped", "payload": {"exitCode": code}})
                except Exception:  # noqa: BLE001
                    pass
            if unexpected_disconnect and not self._closed:
                self._schedule_forced_transport_stop()

    def _schedule_forced_transport_stop(self):
        """Retire a Core whose read side died while the process may still be alive.

        A corrupt frame or unexpected pipe EOF is a terminal transport failure.
        Teardown runs on a separate worker so the reader thread can return before
        stop() joins IPC owners. The stop lock makes this safe against concurrent
        Restart/Exit calls.
        """
        if self._transport_abort_started.is_set():
            return
        self._transport_abort_started.set()

        def _abort():
            try:
                self.stop(graceful=False)
            except Exception:  # noqa: BLE001 - normal exit/restart will retry cleanup
                pass

        threading.Thread(target=_abort, name="core-transport-abort", daemon=True).start()

    def _fail_queued_writes(self, reason="core stopped"):
        while True:
            try:
                item = self._write_queue.get_nowait()
            except queue.Empty:
                return
            if item is None:
                continue
            item["error"] = OSError(reason)
            item["done"].set()

    def _write_loop(self):
        while not self._stop.is_set():
            try:
                item = self._write_queue.get(timeout=0.1)
            except queue.Empty:
                continue
            if item is None:
                return
            if item["cancelled"].is_set() or time.monotonic() >= item["deadline"]:
                item["error"] = TimeoutError("core ipc write timed out")
                item["done"].set()
                continue
            try:
                with self._write_lock:
                    if self._closed or self._stop.is_set():
                        raise OSError("core stopped")
                    channel = self._to_child
                    if channel is None:
                        raise OSError("core ipc channel is not available")
                    channel.parent_file.write(item["frame"])
            except Exception as exc:  # noqa: BLE001 - propagated to the request owner
                item["error"] = exc
            finally:
                item["done"].set()

    def _break_stalled_writer(self):
        """Break a blocking Windows WriteFile and wake every affected RPC caller."""
        self._stop.set()
        self._fail_pending()
        self._fail_queued_writes("core ipc write stalled")
        self._kill_if_alive(0.0)
        try:
            if self._to_child is not None:
                self._to_child.close()
        except Exception:  # noqa: BLE001 - forced teardown
            pass

    def request(self, method, payload=None, timeout=30.0):
        from uuid import uuid4

        timeout = max(0.001, float(timeout))
        deadline = time.monotonic() + timeout
        rid = uuid4().hex
        ev = threading.Event()
        entry = {"ev": ev, "result": None}
        with self._pending_lock:
            if self._closed or self._stop.is_set():
                return dict(_DEAD)

        # Encode before admission.  An oversized or unserializable payload must
        # never be able to leave a waiter in _pending that no frame can answer:
        # previously FrameError escaped past every cleanup path.
        msg = {"type": "request", "requestId": rid, "method": method, "payload": payload or {}}
        frame = framing.encode_frame(msg)

        with self._pending_lock:
            if self._closed or self._stop.is_set():
                return dict(_DEAD)
            if len(self._pending) >= _MAX_PENDING_REQUESTS:
                raise RuntimeError(f"request {method} rejected: too many unanswered IPC requests")
            self._pending[rid] = entry

        write_done = threading.Event()
        cancelled = threading.Event()
        write_item = {
            "frame": frame,
            "done": write_done,
            "cancelled": cancelled,
            "deadline": deadline,
            "error": None,
        }

        try:
            return self._await_response(rid, method, entry, ev, write_item, write_done, cancelled, deadline)
        finally:
            # Backstop for every exit path, including an unexpected exception in
            # the write/await sequence.  The explicit pops below keep the normal
            # lifecycle readable; this guarantees no admission can ever leak.
            with self._pending_lock:
                if self._pending.get(rid) is entry:
                    self._pending.pop(rid, None)

    def _await_response(self, rid, method, entry, ev, write_item, write_done, cancelled, deadline):
        remaining = max(0.0, deadline - time.monotonic())
        try:
            self._write_queue.put(write_item, timeout=remaining)
        except queue.Full as exc:
            with self._pending_lock:
                self._pending.pop(rid, None)
                stopped = self._closed or self._stop.is_set()
            if stopped:
                return entry["result"] or dict(_DEAD)
            raise TimeoutError(f"request {method} timed out waiting for IPC writer") from exc

        # Shutdown can publish _closed and drain the queue after this request was
        # admitted to _pending but before its write item reached the queue.  In
        # that interleaving _fail_queued_writes() has already returned and the
        # writer may already be exiting.  Re-check the lifecycle *after* enqueue
        # so a late item completes immediately instead of waiting its full RPC
        # timeout behind a stopped writer.  The cancelled bit also makes the item
        # harmless if a writer happens to dequeue it concurrently.
        with self._pending_lock:
            stopped_after_enqueue = self._closed or self._stop.is_set()
            if stopped_after_enqueue:
                self._pending.pop(rid, None)
        if stopped_after_enqueue:
            cancelled.set()
            write_item["error"] = OSError("core stopped")
            write_done.set()
            return entry["result"] or dict(_DEAD)

        remaining = max(0.0, deadline - time.monotonic())
        if not write_done.wait(remaining):
            cancelled.set()
            with self._pending_lock:
                self._pending.pop(rid, None)
            self._break_stalled_writer()
            raise TimeoutError(f"request {method} timed out writing to core")

        write_error = write_item["error"]
        if write_error is not None:
            with self._pending_lock:
                self._pending.pop(rid, None)
                stopped = self._closed or self._stop.is_set()
            if stopped:
                return entry["result"] or dict(_DEAD)
            if isinstance(write_error, TimeoutError):
                raise write_error
            raise OSError("core ipc write failed: %s" % write_error) from write_error

        remaining = max(0.0, deadline - time.monotonic())
        if not ev.wait(remaining):
            # The request is already inside Core. Never just abandon the waiter:
            # fs.copy could finish its preflight later and start a ghost transfer.
            # Send an out-of-band cancellation frame and require Core to ACK that
            # it observed the shared cancellation token before reporting timeout.
            cancel_deadline = time.monotonic() + 0.75
            cancel_done = threading.Event()
            cancel_item = {
                "frame": framing.encode_frame({"type": "cancel", "requestId": rid}),
                "done": cancel_done,
                "cancelled": threading.Event(),
                "deadline": cancel_deadline,
                "error": None,
            }
            try:
                self._write_queue.put(cancel_item, timeout=max(0.0, cancel_deadline - time.monotonic()))
            except queue.Full:
                self._break_stalled_writer()
            else:
                if not cancel_done.wait(max(0.0, cancel_deadline - time.monotonic())) or cancel_item["error"] is not None:
                    self._break_stalled_writer()
                elif ev.wait(max(0.0, cancel_deadline - time.monotonic())):
                    return entry["result"]
                else:
                    # A mutating request that ignores cancellation cannot be left
                    # alive behind a timeout (ghost copy). Read-only scans/lists,
                    # however, may safely finish in the background; restarting Core
                    # for one slow directory is a larger failure than the timeout.
                    if method not in _READ_ONLY_METHODS:
                        self._break_stalled_writer()
            with self._pending_lock:
                self._pending.pop(rid, None)
            raise TimeoutError(f"request {method} timed out and was cancelled")
        result = entry["result"]
        if self.diagnostics is not None:
            if method in {"getStatus", "core.getStatus"} and isinstance(result, dict) and result.get("ok"):
                self.diagnostics.update_core_status(result.get("result"))
            if method == "operation.list" and isinstance(result, dict) and result.get("ok"):
                self.diagnostics.update_core(operations=(result.get("result") or {}).get("operations", [])[:128])
            if method != "ping":
                # A successful RPC is telemetry, not an event. The UI polls
                # peer.list every few seconds, so logging each completion fills
                # the ring and the log tail that a live observer reads from.
                # Keep the aggregate counter, keep the failure detail, and only
                # spend a log line when the request actually failed.
                ok = bool(result.get("ok")) if isinstance(result, dict) else False
                if ok:
                    self.diagnostics.count_only("debug", "request.completed")
                else:
                    self.diagnostics.log(
                        "debug",
                        "ipc",
                        "request",
                        "request.completed",
                        method,
                        requestId=rid,
                        ok=False,
                    )
        return result

    def stop(self, graceful=True, timeout=1.5):
        with self._stop_lock:
            return self._stop_impl(graceful=graceful, timeout=timeout)

    def _stop_impl(self, graceful=True, timeout=1.5):
        if self._closed:
            stopped = self._kill_if_alive(0.4)
            if stopped:
                self._close_process_job()
            if not stopped:
                raise RuntimeError("Core process tree did not terminate")
            return

        # app.shutdown is best-effort. Run it outside the caller so a blocked
        # pipe write cannot prevent us from reaching the forced teardown path.
        graceful = graceful and self.proc is not None and self.proc.poll() is None
        if graceful:
            # Respect an explicitly tighter stop deadline while keeping the
            # normal 1.2 s admission/drain window used by the application.
            # This keeps stop() bounded for callers such as restart/error paths
            # without weakening the default graceful shutdown contract.
            graceful_timeout = min(1.2, max(0.0, float(timeout)))
            done = threading.Event()

            def _graceful_shutdown():
                try:
                    # Core ACKs app.shutdown only after request admission is
                    # closed and active handlers have unwound. Give that
                    # lifecycle barrier enough time to cancel a large preflight
                    # instead of immediately converting every restart to a hard
                    # process kill.
                    self.request("app.shutdown", {}, timeout=graceful_timeout)
                except Exception:  # noqa: BLE001 - best effort
                    pass
                finally:
                    done.set()

            threading.Thread(target=_graceful_shutdown, name="core-ipc-shutdown", daemon=True).start()
            done.wait(graceful_timeout + 0.05)

        with self._pending_lock:
            self._closed = True
        self._stop.set()
        # Wake RPC callers immediately; this no longer waits for a writer lock.
        self._fail_pending()
        self._fail_queued_writes()
        try:
            self._write_queue.put_nowait(None)
        except queue.Full:
            pass

        # If a writer is blocked because Core stopped consuming stdin, killing
        # Core breaks the pipe and releases that writer. Teardown remains
        # bounded even when the graceful RPC never made it onto the pipe.
        tree_stopped = self._kill_if_alive(timeout if graceful else 0.4)
        # A dead Core PID is not enough: only close the Job handle after the
        # Job itself reports ActiveProcesses == 0.  restart_core and normal
        # exit therefore cannot publish/release the data-root while an old
        # I/O-worker can still mutate it.
        if tree_stopped:
            self._close_process_job()

        for c in (self._to_child, self._from_child, self._stderr_channel):
            try:
                if c is not None:
                    c.close()
            except Exception:  # noqa: BLE001
                pass

        # The IPC threads own blocking synchronous named-pipe I/O. Killing Core
        # and closing our pipe ends should normally retire them immediately, but
        # make that a verified lifecycle invariant rather than an assumption:
        # if a Windows synchronous ReadFile/WriteFile is still pending, cancel it
        # explicitly and require the thread to terminate before stop() succeeds.
        lingering = []
        for attr in ("_reader_thread", "_writer_thread", "_stderr_thread"):
            thread = getattr(self, attr)
            if thread is None or thread is threading.current_thread():
                setattr(self, attr, None)
                continue
            try:
                thread.join(timeout=1.0)
            except RuntimeError:
                pass
            if thread.is_alive():
                try:
                    pipes.cancel_synchronous_thread_io(thread.native_id)
                except Exception:  # noqa: BLE001 - final verification below decides success
                    pass
                try:
                    thread.join(timeout=0.75)
                except RuntimeError:
                    pass
            if thread.is_alive():
                lingering.append(thread.name)
                # Keep the reference for diagnostics; never pretend a live owner
                # was retired. A subsequent start on this object is forbidden.
                setattr(self, attr, thread)
            else:
                setattr(self, attr, None)

        self._to_child = None
        self._from_child = None
        self._stderr_channel = None

        process_stopped = self.proc is None or self.proc.poll() is not None
        if not tree_stopped or not process_stopped or lingering:
            details = []
            if not tree_stopped:
                details.append("Core Job still has active processes")
            if not process_stopped:
                details.append("Core process is still running")
            if lingering:
                details.append("IPC threads still running: %s" % ", ".join(lingering))
            raise RuntimeError("; ".join(details))

    def _kill_if_alive(self, timeout):
        """Retire the complete Core Job and prove that no descendant survives.

        The old implementation only waited for the Core PID and relied on
        CloseHandle(KILL_ON_JOB_CLOSE) for descendants.  CloseHandle requests
        their termination but is not a completion barrier, so restart could
        race an old I/O-worker still mutating the same data-root.
        """
        proc = self.proc
        job = self._process_job

        # Preserve a short graceful window for the parent Core itself.  Even if
        # it exits naturally, descendants are checked through the Job below.
        if proc is not None and proc.poll() is None and timeout > 0:
            try:
                proc.wait(timeout=max(0.0, float(timeout)))
            except Exception:  # noqa: BLE001 - forced tree retirement follows
                pass

        if job is not None:
            try:
                # TerminateJobObject is required even when the parent Core PID
                # is already dead: a child I/O-worker may still be associated
                # with the Job and completing a filesystem syscall.
                if not process_tree.terminate_job_and_wait(job, timeout=max(5.0, float(timeout))):
                    return False
            except Exception:  # noqa: BLE001 - caller must fail closed
                return False

            if proc is not None and proc.poll() is None:
                try:
                    proc.wait(timeout=0.5)
                except Exception:  # noqa: BLE001
                    return False
            try:
                return process_tree.active_process_count(job) == 0 and (proc is None or proc.poll() is not None)
            except Exception:  # noqa: BLE001
                return False

        if proc is None:
            return True
        try:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=1.0)
            return proc.poll() is not None
        except Exception:  # noqa: BLE001
            return False

    def _close_process_job(self):
        job = self._process_job
        if job is None:
            return
        # Never turn KILL_ON_JOB_CLOSE into an asynchronous ownership handoff.
        # The Job may be closed only after QueryInformationJobObject proves
        # there are no active descendants.
        if process_tree.active_process_count(job) != 0:
            raise RuntimeError("refusing to close non-empty Core Job")
        process_tree.close_job(job)
        self._process_job = None
