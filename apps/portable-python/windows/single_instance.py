"""Cross-session single-instance gate for the portable data root.

Ownership is held by an exclusive Windows file handle inside the data root,
not by a guessable Global mutex name. A separate owner-only Global event is
used only to surface the existing window.
"""

import ctypes
import hashlib
import os

from runtime.compat import INSTANCE_EVENT_PREFIX, INSTANCE_LOCK_NAME, INSTANCE_MUTEX_PREFIX
import threading
import time
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)

kernel32.CreateMutexW.restype = wintypes.HANDLE
kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
kernel32.CreateFileW.restype = wintypes.HANDLE
kernel32.CreateFileW.argtypes = [
    wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
    wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
]
kernel32.CreateEventW.restype = wintypes.HANDLE
kernel32.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
kernel32.OpenEventW.restype = wintypes.HANDLE
kernel32.OpenEventW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
kernel32.SetEvent.restype = wintypes.BOOL
kernel32.SetEvent.argtypes = [wintypes.HANDLE]
kernel32.WaitForSingleObject.restype = wintypes.DWORD
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.WaitForMultipleObjects.restype = wintypes.DWORD
kernel32.WaitForMultipleObjects.argtypes = [
    wintypes.DWORD,
    ctypes.POINTER(wintypes.HANDLE),
    wintypes.BOOL,
    wintypes.DWORD,
]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.LocalFree.restype = ctypes.c_void_p
kernel32.LocalFree.argtypes = [ctypes.c_void_p]
advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
    wintypes.LPCWSTR,
    wintypes.DWORD,
    ctypes.POINTER(ctypes.c_void_p),
    ctypes.POINTER(wintypes.DWORD),
]
user32.AllowSetForegroundWindow.restype = wintypes.BOOL
user32.AllowSetForegroundWindow.argtypes = [wintypes.DWORD]

ERROR_ALREADY_EXISTS = 183
ERROR_SHARING_VIOLATION = 32
ERROR_LOCK_VIOLATION = 33
WAIT_OBJECT_0 = 0
INFINITE = 0xFFFFFFFF
EVENT_MODIFY_STATE = 0x0002
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_SHARE_READ = 0x00000001
OPEN_ALWAYS = 4
FILE_ATTRIBUTE_HIDDEN = 0x00000002
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
SDDL_REVISION_1 = 1
ASFW_ANY = 0xFFFFFFFF
# Same owner-only DACL as the Core IPC pipes: other users must not be able to
# pop this process's window via the activation event.
_EVENT_SDDL = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)"

_MUTEX = None  # legacy/fallback when no data root is supplied
_LOCK_FILE = None  # primary production gate; keep handle for process lifetime
_SHOW_EVENT = None
_SHOW_STOP = None
_SHOW_THREAD = None
_SHOW_CALLBACK = None


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ("nLength", wintypes.DWORD),
        ("lpSecurityDescriptor", ctypes.c_void_p),
        ("bInheritHandle", wintypes.BOOL),
    ]


def _digest(data_root):
    normalized = os.path.normcase(os.path.realpath(os.path.abspath(str(data_root))))
    return hashlib.sha256(normalized.encode("utf-8", "surrogatepass")).hexdigest()[:32]


def _mutex_name(data_root=None):
    if data_root:
        return INSTANCE_MUTEX_PREFIX + _digest(data_root)
    return INSTANCE_MUTEX_PREFIX + "SingleInstance"


def _show_event_name(data_root=None):
    if data_root:
        return INSTANCE_EVENT_PREFIX + _digest(data_root)
    return INSTANCE_EVENT_PREFIX + "SingleInstance"


def _private_event_security():
    descriptor = ctypes.c_void_p()
    if not advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        _EVENT_SDDL, SDDL_REVISION_1, ctypes.byref(descriptor), None
    ):
        raise ctypes.WinError(
            ctypes.get_last_error(),
            "ConvertStringSecurityDescriptorToSecurityDescriptorW(show event)",
        )
    attrs = SECURITY_ATTRIBUTES(
        ctypes.sizeof(SECURITY_ATTRIBUTES),
        descriptor,
        False,
    )
    return attrs, descriptor


def _close_handle(handle):
    if not handle:
        return
    try:
        kernel32.CloseHandle(handle)
    except Exception:  # noqa: BLE001 - best-effort teardown
        pass


def _create_show_event(data_root=None):
    global _SHOW_EVENT
    attrs, descriptor = _private_event_security()
    try:
        ctypes.set_last_error(0)
        handle = kernel32.CreateEventW(ctypes.byref(attrs), False, False, _show_event_name(data_root))
        already = ctypes.get_last_error() == ERROR_ALREADY_EXISTS
    finally:
        if descriptor:
            kernel32.LocalFree(descriptor)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if already:
        # Never attach to a Global event created before we owned the data root.
        kernel32.CloseHandle(handle)
        raise RuntimeError("PeerSync activation event already existed before instance startup")
    _SHOW_EVENT = handle


def _acquire_data_root_lock(data_root):
    global _LOCK_FILE
    root = os.path.realpath(os.path.abspath(str(data_root)))
    os.makedirs(root, exist_ok=True)
    lock_path = os.path.join(root, INSTANCE_LOCK_NAME)
    ctypes.set_last_error(0)
    handle = kernel32.CreateFileW(
        lock_path,
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ,
        None,
        OPEN_ALWAYS,
        FILE_ATTRIBUTE_HIDDEN,
        None,
    )
    if handle == INVALID_HANDLE_VALUE:
        err = ctypes.get_last_error()
        if err in (ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION):
            return False
        raise ctypes.WinError(err, "Не удалось открыть single-instance lock PeerSync")
    _LOCK_FILE = handle
    return True


def acquire_single_instance(data_root=None, name=None):
    """Return True for the first process using this data root on the machine.

    A file handle in the real data root is the production ownership primitive.
    It remains cross-session but cannot be squatted by an unrelated user who
    has no access to that directory.  ``name`` keeps a secured named-mutex
    fallback for compatibility callers that do not supply a data root.
    """
    global _MUTEX, _SHOW_EVENT
    if data_root is not None and name is None:
        if not _acquire_data_root_lock(data_root):
            return False
    else:
        attrs, descriptor = _private_event_security()
        try:
            ctypes.set_last_error(0)
            handle = kernel32.CreateMutexW(ctypes.byref(attrs), False, str(name or _mutex_name(data_root)))
            already = ctypes.get_last_error() == ERROR_ALREADY_EXISTS
        finally:
            if descriptor:
                kernel32.LocalFree(descriptor)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if already:
            kernel32.CloseHandle(handle)
            return False
        _MUTEX = handle
    try:
        _create_show_event(data_root)
    except Exception:  # noqa: BLE001 - window can still be opened from the tray
        _close_handle(_SHOW_EVENT)
        _SHOW_EVENT = None
    return True

def consume_show_request():
    """True when a later launch asked this process to surface its window."""
    if not _SHOW_EVENT:
        return False
    return kernel32.WaitForSingleObject(_SHOW_EVENT, 0) == WAIT_OBJECT_0


def _show_watch_loop():
    show = _SHOW_EVENT
    stop = _SHOW_STOP
    if not show or not stop:
        return
    handles = (wintypes.HANDLE * 2)(show, stop)
    while True:
        rc = kernel32.WaitForMultipleObjects(2, handles, False, INFINITE)
        if rc != WAIT_OBJECT_0:
            return
        callback = _SHOW_CALLBACK
        if callback is not None:
            try:
                callback()
            except Exception:  # noqa: BLE001 - watcher must keep listening
                pass


def start_show_watcher(on_show):
    """Wake `on_show` on a background thread when a second launch signals."""
    global _SHOW_STOP, _SHOW_THREAD, _SHOW_CALLBACK
    stop_show_watcher()
    if not _SHOW_EVENT:
        return
    _SHOW_CALLBACK = on_show
    stop = kernel32.CreateEventW(None, True, False, None)
    if not stop:
        _SHOW_CALLBACK = None
        return
    _SHOW_STOP = stop
    thread = threading.Thread(target=_show_watch_loop, name="peersync-show", daemon=True)
    _SHOW_THREAD = thread
    thread.start()


def stop_show_watcher():
    global _SHOW_STOP, _SHOW_THREAD, _SHOW_CALLBACK
    _SHOW_CALLBACK = None
    stop = _SHOW_STOP
    _SHOW_STOP = None
    if stop:
        try:
            kernel32.SetEvent(stop)
        except Exception:  # noqa: BLE001
            pass
    thread = _SHOW_THREAD
    _SHOW_THREAD = None
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=1.0)
    _close_handle(stop)


def signal_running_instance(data_root=None, attempts=25, delay=0.04):
    """Ask the process that owns this data root to show its window.

    The caller is the foreground process (the user just started it), so it
    grants the owner a brief AllowSetForegroundWindow so focus can move.
    """
    try:
        user32.AllowSetForegroundWindow(ASFW_ANY)
    except Exception:  # noqa: BLE001 - showing still works without focus steal
        pass
    event_name = _show_event_name(data_root)
    for _ in range(max(1, int(attempts))):
        handle = kernel32.OpenEventW(EVENT_MODIFY_STATE, False, event_name)
        if handle:
            try:
                return bool(kernel32.SetEvent(handle))
            finally:
                kernel32.CloseHandle(handle)
        time.sleep(max(0.0, float(delay)))
    return False


def release_single_instance():
    global _MUTEX, _LOCK_FILE, _SHOW_EVENT
    stop_show_watcher()
    show = _SHOW_EVENT
    _SHOW_EVENT = None
    _close_handle(show)
    mutex = _MUTEX
    _MUTEX = None
    _close_handle(mutex)
    lock_file = _LOCK_FILE
    _LOCK_FILE = None
    _close_handle(lock_file)

