"""Win32 process-tree lifetime helpers for PSNCore.

The portable shell must own the Core *and* every process Core spawns. Windows
TerminateProcess/Popen.kill only targets one PID, so Core is launched suspended,
assigned to a per-Core Job Object, and resumed only after assignment succeeds.
The job uses JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: hard-stop and shell death both
retire the entire Core/I/O-worker tree.
"""

import ctypes
import time
from ctypes import wintypes


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS = 1
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
CREATE_SUSPENDED = 0x00000004
PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100
THREAD_SUSPEND_RESUME = 0x0002
TH32CS_SNAPTHREAD = 0x00000004
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JOBOBJECT_BASIC_ACCOUNTING_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", ctypes.c_longlong),
        ("TotalKernelTime", ctypes.c_longlong),
        ("ThisPeriodTotalUserTime", ctypes.c_longlong),
        ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
        ("TotalPageFaultCount", wintypes.DWORD),
        ("TotalProcesses", wintypes.DWORD),
        ("ActiveProcesses", wintypes.DWORD),
        ("TotalTerminatedProcesses", wintypes.DWORD),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class THREADENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ThreadID", wintypes.DWORD),
        ("th32OwnerProcessID", wintypes.DWORD),
        ("tpBasePri", ctypes.c_long),
        ("tpDeltaPri", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
    ]


kernel32.CreateJobObjectW.restype = wintypes.HANDLE
kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
kernel32.SetInformationJobObject.restype = wintypes.BOOL
kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
kernel32.TerminateJobObject.restype = wintypes.BOOL
kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel32.QueryInformationJobObject.restype = wintypes.BOOL
kernel32.QueryInformationJobObject.argtypes = [
    wintypes.HANDLE,
    ctypes.c_int,
    ctypes.c_void_p,
    wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD),
]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
kernel32.Thread32First.restype = wintypes.BOOL
kernel32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(THREADENTRY32)]
kernel32.Thread32Next.restype = wintypes.BOOL
kernel32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(THREADENTRY32)]
kernel32.OpenThread.restype = wintypes.HANDLE
kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.ResumeThread.restype = wintypes.DWORD
kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]


def _invalid(handle):
    return handle in (None, 0, INVALID_HANDLE_VALUE)


def _winerror(name):
    return ctypes.WinError(ctypes.get_last_error(), name)


def create_kill_on_close_job():
    handle = kernel32.CreateJobObjectW(None, None)
    if _invalid(handle):
        raise _winerror("CreateJobObjectW")
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel32.SetInformationJobObject(
        handle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
        ctypes.byref(info),
        ctypes.sizeof(info),
    ):
        err = _winerror("SetInformationJobObject")
        kernel32.CloseHandle(handle)
        raise err
    return handle


def assign_process(job_handle, pid):
    process = kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, int(pid))
    if _invalid(process):
        raise _winerror("OpenProcess(job assignment)")
    try:
        if not kernel32.AssignProcessToJobObject(job_handle, process):
            raise _winerror("AssignProcessToJobObject")
    finally:
        kernel32.CloseHandle(process)


def resume_suspended_process(pid):
    """Resume every thread currently owned by a CREATE_SUSPENDED child.

    Popen intentionally closes CreateProcess' primary-thread handle before it
    returns. While the child is still suspended it cannot create user threads,
    so Toolhelp gives us a race-free way to reopen and resume that primary
    thread after Job assignment.
    """
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
    if _invalid(snapshot):
        raise _winerror("CreateToolhelp32Snapshot")
    resumed = 0
    try:
        entry = THREADENTRY32()
        entry.dwSize = ctypes.sizeof(THREADENTRY32)
        ok = kernel32.Thread32First(snapshot, ctypes.byref(entry))
        while ok:
            if int(entry.th32OwnerProcessID) == int(pid):
                thread = kernel32.OpenThread(THREAD_SUSPEND_RESUME, False, entry.th32ThreadID)
                if _invalid(thread):
                    raise _winerror("OpenThread(resume)")
                try:
                    previous = kernel32.ResumeThread(thread)
                    if previous == 0xFFFFFFFF:
                        raise _winerror("ResumeThread")
                    resumed += 1
                finally:
                    kernel32.CloseHandle(thread)
            entry.dwSize = ctypes.sizeof(THREADENTRY32)
            ok = kernel32.Thread32Next(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    if resumed == 0:
        raise RuntimeError("suspended Core has no resumable thread")


def active_process_count(job_handle):
    """Return the number of processes that are still associated with the Job.

    A dead Core PID is not a lifecycle barrier: descendants can still be
    completing filesystem I/O.  Query the Job itself so callers can prove that
    the whole generation has retired before reusing the data-root.
    """
    if _invalid(job_handle):
        return 0
    info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION()
    returned = wintypes.DWORD(0)
    if not kernel32.QueryInformationJobObject(
        job_handle,
        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS,
        ctypes.byref(info),
        ctypes.sizeof(info),
        ctypes.byref(returned),
    ):
        raise _winerror("QueryInformationJobObject")
    return int(info.ActiveProcesses)


def wait_job_empty(job_handle, timeout=5.0, poll_interval=0.01):
    """Wait until the Job has no active processes.

    This is the ownership fence used by restart/shutdown.  Closing a
    KILL_ON_JOB_CLOSE handle requests termination but does not itself prove that
    descendants have exited.
    """
    if _invalid(job_handle):
        return True
    deadline = time.monotonic() + max(0.0, float(timeout))
    while True:
        if active_process_count(job_handle) == 0:
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(max(0.001, float(poll_interval)), remaining))


def terminate_job(job_handle, exit_code=1):
    if _invalid(job_handle):
        return False
    if kernel32.TerminateJobObject(job_handle, int(exit_code)):
        return True
    return False


def terminate_job_and_wait(job_handle, timeout=5.0, exit_code=1):
    """Terminate every process in the Job and verify the Job is empty."""
    if _invalid(job_handle):
        return True
    if active_process_count(job_handle) == 0:
        return True
    if not terminate_job(job_handle, exit_code=exit_code):
        # A process can leave between the accounting query and termination.
        # Treat that race as success only if the Job is now demonstrably empty.
        return active_process_count(job_handle) == 0
    return wait_job_empty(job_handle, timeout=timeout)


def close_job(job_handle):
    if _invalid(job_handle):
        return
    if not kernel32.CloseHandle(job_handle):
        raise _winerror("CloseHandle(job)")


def release_job(job_handle):
    """Let a verified update candidate survive the updater helper's exit."""
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    if not kernel32.SetInformationJobObject(
        job_handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
        ctypes.byref(info), ctypes.sizeof(info),
    ):
        raise _winerror("SetInformationJobObject(release update)")
