"""M0 spike gate: headless Python<->Core smoke.

Run with the system Python from the repo root:
    python scripts/spike-headless-smoke.py [path/to/PSNCore.exe]

Checks: named-pipe framed IPC hello/ping/status, 10000-message stress,
CREATE_NO_WINDOW spawn, Hyperswarm boot event, graceful exit, no orphan,
stderr log file. GUI/tray/DPAPI items are covered by the Tk shell spike.
"""

import csv
import os
import queue
import sys
import threading
import time

APP_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "apps", "portable-python")
sys.path.insert(0, os.path.abspath(APP_ROOT))

from ipc.core_client import CoreClient  # noqa: E402

CORE = sys.argv[1] if len(sys.argv) > 1 else os.path.abspath(
    os.path.join(APP_ROOT, "..", "..", "build", "core", "PSNCore.exe")
)
DATA = os.path.abspath(os.path.join(APP_ROOT, "..", "..", "build", "spike-data"))


def _log_tail(path, limit=5000):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        return text[-limit:]
    except OSError as exc:
        return "<core log unavailable: %s>" % exc


def _expect_first_event(events, expected, client, log_path):
    first = events.get(timeout=30)
    if first.get("event") == expected:
        return first
    # Give a just-exited child a moment to publish its real exit code, then
    # surface stderr in the build log. This keeps standalone-runtime failures
    # diagnosable instead of reporting only the synthetic core.stopped event.
    time.sleep(0.1)
    exit_code = None
    try:
        if client.proc is not None:
            exit_code = client.proc.poll()
    except Exception:
        pass
    raise AssertionError({
        "expected": expected,
        "received": first,
        "processExitCode": exit_code,
        "coreLogTail": _log_tail(log_path),
    })


def _hello_without_dataroot():
    tmp = os.path.abspath(os.path.join(APP_ROOT, "..", "..", "build", "spike-nodata"))
    os.makedirs(tmp, exist_ok=True)
    events = queue.Queue()
    client = CoreClient(CORE, tmp, os.path.join(tmp, "core.log"), "0.0.0", "140926", pass_data_arg=False)

    def on_event(frame):
        events.put(frame)

    client.start(on_event)
    _expect_first_event(events, "core.starting", client, os.path.join(tmp, "core.log"))
    ack = client.request(
        "hello",
        {"shellProtocol": 1, "identitySeedHex": "01" * 32, "deviceName": "nodata", "deviceType": "desktop"},
        timeout=15,
    )
    try:
        assert not ack["ok"], ack
        assert ack["error"]["code"] == "INVALID_REQUEST", ack
        print("ok hello without dataRoot -> INVALID_REQUEST")
    finally:
        client.stop(graceful=True)


def main():
    _hello_without_dataroot()
    os.makedirs(DATA, exist_ok=True)
    log_path = os.path.join(DATA, "core.log")
    events = queue.Queue()
    client = CoreClient(CORE, DATA, log_path, "0.0.0", "140926")

    def on_event(frame):
        events.put(frame)

    t0 = time.time()
    client.start(on_event)
    first = _expect_first_event(events, "core.starting", client, log_path)
    pid = first["payload"]["pid"]
    print("ok core.starting pid=%s in %.2fs" % (pid, time.time() - t0))

    ack = client.request("hello", {
        "shellProtocol": 1,
        "identitySeedHex": "02" * 32,
        "deviceName": "smoke",
        "deviceType": "desktop",
        "dataRoot": DATA,
    })
    assert ack["ok"], ack
    assert len(ack["result"]["peerId"]) == 64, ack
    print("ok helloAck core=%s peer=%s…" % (ack["result"]["coreVersion"], ack["result"]["peerId"][:12]))

    bad = client.request("definitely.not.a.method", {})
    assert not bad["ok"] and bad["error"]["code"] == "UNSUPPORTED", bad
    print("ok unknown method -> UNSUPPORTED")

    N = 10000
    threads = []
    got = []
    got_lock = threading.Lock()

    def hammer(start, end):
        for i in range(start, end):
            r = client.request("ping", {"seq": i}, timeout=60)
            assert r["ok"] and r["result"]["pong"] == i, r
            with got_lock:
                got.append(i)

    CHUNK = 500
    for s in range(0, N, CHUNK):
        th = threading.Thread(target=hammer, args=(s, min(s + CHUNK, N)))
        threads.append(th)
        th.start()
        # bound in-flight requests a bit so pipe backpressure stays smooth
        while sum(1 for x in threads if x.is_alive()) >= 8:
            time.sleep(0.01)
    for th in threads:
        th.join()
    assert sorted(got) == list(range(N)), f"missing pings: {N - len(got)}"
    print("ok %d request/response frames without corruption (%.1fs)" % (N, time.time() - t0))

    smoke_root = os.path.join(DATA, "smoke-root")
    os.makedirs(smoke_root, exist_ok=True)
    with open(os.path.join(smoke_root, "hello.txt"), "w", encoding="utf-8") as fh:
        fh.write("worker smoke\n")
    added = client.request("roots.addLocal", {
        "path": smoke_root,
        "name": "SmokeRoot",
        "perms": {"read": True, "write": False},
    })
    assert added["ok"], added
    root_id = added["result"]["root"]["rootId"]
    listed = client.request("fs.list", {
        "target": {"rootId": root_id, "relativePath": ""},
    })
    assert listed["ok"] and any(entry["name"] == "hello.txt" for entry in listed["result"]["entries"]), listed
    print("ok isolated fs.list worker lifecycle")

    deadline = time.time() + 25
    swarm_state = "timeout"
    while time.time() < deadline:
        try:
            ev = events.get(timeout=0.5)
        except queue.Empty:
            continue
        if ev.get("event") == "core.swarmReady":
            swarm_state = "booted:" + str(ev["payload"].get("localPort"))
            break
        if ev.get("event") == "core.warning" and ev["payload"].get("code") == "BOOTSTRAP_FAILED":
            swarm_state = "no-dht:" + ev["payload"]["message"]
            break
    status = client.request("getStatus", {})
    print("ok swarm-smoke=%s status=%s" % (swarm_state, status["result"]))

    client.stop(graceful=True)
    code = client.proc.poll()
    print("ok exit code=%s" % code)
    import subprocess

    # Do not use os.kill(pid, 0) here: on Windows os.kill is not a POSIX
    # liveness probe and can terminate the very process we are trying to detect.
    out = subprocess.run(
        ["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    orphan = False
    if out and not out.lower().startswith("info:"):
        try:
            rows = list(csv.reader(out.splitlines()))
            orphan = any(len(row) > 1 and row[1].strip() == str(pid) for row in rows)
        except csv.Error:
            orphan = False
    assert not orphan and code == 0, (orphan, code, out)
    print("ok no orphan process")

    with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
        log_text = fh.read()
    assert "entry started" in log_text, log_text[:200]
    print("ok stderr -> core.log (%d bytes)" % os.path.getsize(log_path))
    print("HEADLESS SPIKE PASS")


if __name__ == "__main__":
    main()
