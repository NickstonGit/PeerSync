"""Post-PyInstaller artifact smoke.

Copies the frozen EXE to an isolated folder, runs --smoke twice,
records first-run extraction vs second-run (no Core rewrite), peak working set.

    python scripts/artifact-smoke.py <frozen.exe> [out.json]
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import tempfile

CREATE_NO_WINDOW = 0x08000000


def _memory_counters(pid):
    """Return (current working set, peak working set) for one Windows process."""
    try:
        import ctypes
        from ctypes import wintypes

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("QuotaPeakPagefileUsage", ctypes.c_size_t),
            ]

        GetProcessMemoryInfo = ctypes.windll.psapi.GetProcessMemoryInfo
        OpenProcess = ctypes.windll.kernel32.OpenProcess
        CloseHandle = ctypes.windll.kernel32.CloseHandle
        OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        OpenProcess.restype = wintypes.HANDLE
        CloseHandle.argtypes = [wintypes.HANDLE]
        CloseHandle.restype = wintypes.BOOL
        GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
        GetProcessMemoryInfo.restype = wintypes.BOOL
        PROCESS_QUERY_INFORMATION = 0x0400
        PROCESS_VM_READ = 0x0010
        h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
        if not h:
            return 0, 0
        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        ok = GetProcessMemoryInfo(h, ctypes.byref(counters), counters.cb)
        CloseHandle(h)
        if not ok:
            return 0, 0
        return int(counters.WorkingSetSize), int(counters.PeakWorkingSetSize)
    except Exception:
        return 0, 0


def _process_tree_pids(root_pid):
    """Snapshot descendants using Toolhelp; includes the frozen shell root PID."""
    try:
        import ctypes
        from ctypes import wintypes

        TH32CS_SNAPPROCESS = 0x00000002
        INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.WCHAR * 260),
            ]

        k32 = ctypes.windll.kernel32
        k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        k32.Process32FirstW.restype = wintypes.BOOL
        k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        k32.Process32NextW.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        k32.CloseHandle.restype = wintypes.BOOL
        snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snap == INVALID_HANDLE_VALUE:
            return [root_pid]
        children = {}
        try:
            ent = PROCESSENTRY32W()
            ent.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            ok = k32.Process32FirstW(snap, ctypes.byref(ent))
            while ok:
                children.setdefault(int(ent.th32ParentProcessID), []).append(int(ent.th32ProcessID))
                ok = k32.Process32NextW(snap, ctypes.byref(ent))
        finally:
            k32.CloseHandle(snap)
        out = []
        stack = [int(root_pid)]
        seen = set()
        while stack:
            pid = stack.pop()
            if pid in seen:
                continue
            seen.add(pid)
            out.append(pid)
            stack.extend(children.get(pid, ()))
        return out
    except Exception:
        return [root_pid]


def _tree_working_set(root_pid):
    current = 0
    peak = 0
    for pid in _process_tree_pids(root_pid):
        ws, pk = _memory_counters(pid)
        current += ws
        peak += pk
    return current, peak


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def run_smoke(exe, cwd):
    launch_epoch = time.time()
    t0 = time.perf_counter()
    proc = subprocess.Popen(
        [exe, "--smoke"],
        cwd=cwd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW,
    )
    peak_tree = 0
    idle_ws = 0
    metrics_path = os.path.join(cwd, "data", "logs", "smoke-metrics.json")
    metrics = {}
    while proc.poll() is None:
        current, _sum_process_peaks = _tree_working_set(proc.pid)
        # True process-tree peak: maximum simultaneous working set sampled for
        # the frozen shell + extracted Python child + Core, not a sum of each
        # process's historical peak at unrelated times.
        peak_tree = max(peak_tree, current)
        metrics = _read_json(metrics_path)
        if metrics.get("readyEpoch") and current >= 8_000_000:
            idle_ws = max(idle_ws, current)
        if time.perf_counter() - t0 > 180:
            proc.kill()
            break
        time.sleep(0.1)
    elapsed = time.perf_counter() - t0
    # Last metric (smokePass) is written just before the process exits. Give
    # the atomic replace a moment if the poller or Defender still held the file.
    deadline = time.perf_counter() + 1.0
    while time.perf_counter() < deadline:
        metrics = _read_json(metrics_path) or metrics
        if metrics.get("smokePass") is True:
            break
        time.sleep(0.05)
    if idle_ws < 8_000_000:
        idle_ws, _ = _tree_working_set(proc.pid)
        idle_ws = max(idle_ws, peak_tree)
    report_path = os.path.join(cwd, "data", "logs", "smoke-report.txt")
    text = ""
    if os.path.isfile(report_path):
        with open(report_path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    man_path = os.path.join(cwd, "data", "runtime", "runtime-manifest.json")
    man = _read_json(man_path)
    core_path = os.path.join(cwd, "data", "runtime", "PSNCore.exe")
    # Trust the smoke report + exit code. smokePass in JSON is best-effort:
    # a Windows replace can still lose the last write even after retries.
    passed = proc.returncode == 0 and "M0 SMOKE PASS" in text

    def since_launch(key):
        value = metrics.get(key)
        if not isinstance(value, (int, float)):
            return None
        return round(max(0.0, float(value) - launch_epoch), 3)

    return {
        "exitCode": proc.returncode,
        "elapsedSec": round(elapsed, 3),
        "launcherStartSec": since_launch("shellStartedEpoch"),
        "coreInstallSec": since_launch("coreInstalledEpoch"),
        "readySec": since_launch("readyEpoch"),
        "idleWorkingSetBytes": idle_ws,
        "peakProcessTreeWorkingSetBytes": peak_tree,
        "coreInstallChanged": man.get("changed"),
        "coreSha256": man.get("coreSha256"),
        "coreExists": os.path.isfile(core_path),
        "coreBytes": os.path.getsize(core_path) if os.path.isfile(core_path) else 0,
        "pass": passed,
        "milestones": metrics,
        "smokeReportTail": text[-800:],
    }


def main():
    exe = os.path.abspath(sys.argv[1])
    out = sys.argv[2] if len(sys.argv) > 2 else ""
    if not os.path.isfile(exe):
        raise SystemExit("missing artifact " + exe)
    tmp = tempfile.mkdtemp(prefix="as-artifact-smoke-")
    try:
        local = os.path.join(tmp, os.path.basename(exe))
        shutil.copy2(exe, local)
        first = run_smoke(local, tmp)
        second = run_smoke(local, tmp)
        ok = first["pass"] and second["pass"] and first["coreExists"] and second["coreInstallChanged"] is False
        report = {
            "ok": ok,
            "artifact": exe,
            "firstRun": first,
            "secondRun": second,
            "corePathStable": first.get("coreSha256") == second.get("coreSha256") and first["coreExists"],
        }
        text = json.dumps(report, indent=2)
        if out:
            os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
            with open(out, "w", encoding="utf-8") as fh:
                fh.write(text)
        print(text)
        if not ok:
            sys.exit(2)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
