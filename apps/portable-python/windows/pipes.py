"""Windows named-pipe pair helpers for shell <-> core stdio.

The Bare runtime (`bare-stdio`) drives inherited stdio handles that are named
pipes through `bare-pipe` (async, overlapped). Anonymous pipes (plain
subprocess defaults) do not work there, so the shell creates a real named
pipe per direction: the child inherits an overlapped CLIENT handle wired to
its stdin/stdout, the shell does blocking I/O on the SERVER handle.
"""

import ctypes
import msvcrt
import os
import secrets
import threading
import time
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

PIPE_ACCESS_INBOUND = 0x00000001
PIPE_ACCESS_OUTBOUND = 0x00000002
PIPE_ACCESS_DUPLEX = 0x00000003
PIPE_TYPE_BYTE = 0x00000000
PIPE_READMODE_BYTE = 0x00000000
PIPE_WAIT = 0x00000000
PIPE_REJECT_REMOTE_CLIENTS = 0x00000008
FILE_FLAG_OVERLAPPED = 0x40000000
FILE_ATTRIBUTE_NORMAL = 0x00000080
OPEN_EXISTING = 3
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
HANDLE_FLAG_INHERIT = 0x00000001
SDDL_REVISION_1 = 1
THREAD_TERMINATE = 0x0001
ERROR_NOT_FOUND = 1168
ERROR_PIPE_NOT_CONNECTED = 233
ERROR_OPERATION_ABORTED = 995

kernel32.CreateNamedPipeW.restype = wintypes.HANDLE
kernel32.CreateNamedPipeW.argtypes = [
    wintypes.LPCWSTR,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.DWORD,
    ctypes.c_void_p,
]
kernel32.CreateFileW.restype = wintypes.HANDLE
kernel32.CreateFileW.argtypes = [
    wintypes.LPCWSTR,
    wintypes.DWORD,
    wintypes.DWORD,
    ctypes.c_void_p,
    wintypes.DWORD,
    wintypes.DWORD,
    wintypes.HANDLE,
]
kernel32.ConnectNamedPipe.restype = wintypes.BOOL
kernel32.ConnectNamedPipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
kernel32.DisconnectNamedPipe.restype = wintypes.BOOL
kernel32.DisconnectNamedPipe.argtypes = [wintypes.HANDLE]
kernel32.SetHandleInformation.restype = wintypes.BOOL
kernel32.SetHandleInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.OpenThread.restype = wintypes.HANDLE
kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.CancelSynchronousIo.restype = wintypes.BOOL
kernel32.CancelSynchronousIo.argtypes = [wintypes.HANDLE]
kernel32.LocalFree.restype = ctypes.c_void_p
kernel32.LocalFree.argtypes = [ctypes.c_void_p]
advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
    wintypes.LPCWSTR,
    wintypes.DWORD,
    ctypes.POINTER(ctypes.c_void_p),
    ctypes.POINTER(wintypes.DWORD),
]


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ("nLength", wintypes.DWORD),
        ("lpSecurityDescriptor", ctypes.c_void_p),
        ("bInheritHandle", wintypes.BOOL),
    ]


# Default named-pipe ACLs grant read access to Everyone. That is not suitable
# for shell <-> Core IPC because the first frame contains identity material.
# Owner Rights resolves to the creating user's owner SID; SYSTEM/admins retain
# full access for expected Windows administration/debugging.
_PIPE_SDDL = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)"


def _private_pipe_security():
    descriptor = ctypes.c_void_p()
    if not advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        _PIPE_SDDL, SDDL_REVISION_1, ctypes.byref(descriptor), None
    ):
        raise ctypes.WinError(
            ctypes.get_last_error(),
            "ConvertStringSecurityDescriptorToSecurityDescriptorW(pipe)",
        )
    attrs = SECURITY_ATTRIBUTES(
        ctypes.sizeof(SECURITY_ATTRIBUTES),
        descriptor,
        False,
    )
    return attrs, descriptor


ERROR_PIPE_CONNECTED = 535
_INVALID = (-1, None, 0)


def _check_handle(value, func, name):
    if value in _INVALID or (value is not None and ctypes.c_void_p(value).value == -1):
        raise ctypes.WinError(ctypes.get_last_error(), f"{func}({name})")
    return value


def cancel_synchronous_thread_io(native_thread_id):
    """Best-effort cancellation for a Python thread blocked in Win32 synchronous I/O.

    CloseHandle on a file object owned by another thread is not used as the sole
    teardown guarantee. CancelSynchronousIo targets the exact OS thread and wakes
    an in-flight ReadFile/WriteFile so CoreClient can verify that its IPC threads
    really retired before a replacement Core is started.
    """
    if not native_thread_id:
        return False
    handle = kernel32.OpenThread(THREAD_TERMINATE, False, int(native_thread_id))
    if handle in _INVALID or (handle is not None and ctypes.c_void_p(handle).value == -1):
        return False
    try:
        if kernel32.CancelSynchronousIo(handle):
            return True
        # ERROR_NOT_FOUND means the thread simply has no cancellable synchronous
        # request at this instant; that is not a teardown failure by itself.
        return ctypes.get_last_error() == ERROR_NOT_FOUND
    finally:
        kernel32.CloseHandle(handle)


def _close_raw_handle(handle):
    if handle in _INVALID:
        return
    try:
        if ctypes.c_void_p(handle).value != -1:
            kernel32.CloseHandle(handle)
    except Exception:  # noqa: BLE001 - best effort constructor rollback
        pass


class PipeChannel:
    """One IPC direction: parent server end <-> child inherited client end."""

    def __init__(self, name, parent_reads):
        self.name = name
        self.server = None
        self.client = None
        self.parent_file = None
        self.child_fd = None
        self._client_file = None

        access = PIPE_ACCESS_INBOUND if parent_reads else PIPE_ACCESS_OUTBOUND
        security, security_descriptor = _private_pipe_security()
        try:
            try:
                self.server = _check_handle(
                    kernel32.CreateNamedPipeW(
                        name,
                        access,
                        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                        1,
                        65536,
                        65536,
                        0,
                        ctypes.byref(security),
                    ),
                    "CreateNamedPipeW",
                    name,
                )
            finally:
                # CreateNamedPipe copies the security descriptor.
                kernel32.LocalFree(security_descriptor)
            client_access = GENERIC_WRITE if parent_reads else GENERIC_READ
            # Child handle must be: overlapped (for bare-pipe), inheritable.
            self.client = _check_handle(
                kernel32.CreateFileW(
                    name,
                    client_access,
                    0,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | FILE_ATTRIBUTE_NORMAL,
                    None,
                ),
                "CreateFileW",
                name,
            )
            if not kernel32.ConnectNamedPipe(self.server, None):
                err = ctypes.get_last_error()
                if err != ERROR_PIPE_CONNECTED:
                    raise ctypes.WinError(err, f"ConnectNamedPipe({name})")
            if not kernel32.SetHandleInformation(self.client, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT):
                raise ctypes.WinError(ctypes.get_last_error(), f"SetHandleInformation({name})")

            server_flags = os.O_RDONLY if parent_reads else os.O_WRONLY
            server_fd = msvcrt.open_osfhandle(self.server, server_flags | os.O_BINARY)
            # open_osfhandle transfers ownership of the HANDLE to the fd.
            self.server = None
            try:
                self.parent_file = os.fdopen(server_fd, "rb" if parent_reads else "wb", buffering=0)
            except Exception:
                os.close(server_fd)
                raise

            client_flags = os.O_WRONLY if parent_reads else os.O_RDONLY
            self.child_fd = msvcrt.open_osfhandle(self.client, client_flags | os.O_BINARY)
            self.client = None
            # Parent must not keep a duplicate of the child end open: writes would
            # never reach EOF and the child handle refs would leak. Give the fd to
            # subprocess and immediately drop our copy.
            try:
                self._client_file = os.fdopen(self.child_fd, "wb" if parent_reads else "rb", buffering=0)
                self.child_fd = None
            except Exception:
                os.close(self.child_fd)
                self.child_fd = None
                raise
        except Exception:
            self.close()
            _close_raw_handle(self.server)
            _close_raw_handle(self.client)
            self.server = None
            self.client = None
            raise

    def child_handle_for_spawn(self):
        """Object with .fileno() to pass as Popen stdin/stdout."""
        if self._client_file is None:
            raise OSError("child pipe end is closed")
        return self._client_file

    def release_child_end(self):
        """After Popen: close parent's copy so EOF works."""
        if self._client_file is None:
            return
        try:
            self._client_file.close()
        finally:
            self._client_file = None

    def close(self):
        for attr in ("_client_file", "parent_file"):
            file_obj = getattr(self, attr, None)
            if file_obj is None:
                continue
            try:
                file_obj.close()
            except Exception:  # noqa: BLE001 - best effort teardown
                pass
            finally:
                setattr(self, attr, None)
        if self.child_fd is not None:
            try:
                os.close(self.child_fd)
            except Exception:  # noqa: BLE001
                pass
            self.child_fd = None


class NamedPipeServer:
    def __init__(self, name, handler, max_instances=4, on_error=None):
        self.name = name
        self.handler = handler
        self.max_instances = max_instances
        self.on_error = on_error
        self._stop = threading.Event()
        self._thread = None
        self._thread_id = None
        self.last_error = None

    def start(self):
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="diagnostics-pipe", daemon=True)
        self._thread.start()

    def stop(self, timeout=2.0):
        self._stop.set()
        if self._thread_id:
            cancel_synchronous_thread_io(self._thread_id)
        if self._thread is not None:
            self._thread.join(timeout=max(0.0, float(timeout)))
        self._thread = None
        self._thread_id = None

    def _record_error(self, error):
        self.last_error = repr(error)
        if self.on_error is not None:
            try:
                self.on_error(self.last_error)
            except Exception:
                pass

    def _create(self):
        security, security_descriptor = _private_pipe_security()
        try:
            try:
                handle = _check_handle(
                    kernel32.CreateNamedPipeW(
                        self.name,
                        PIPE_ACCESS_DUPLEX,
                        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                        self.max_instances,
                        65536,
                        65536,
                        0,
                        ctypes.byref(security),
                    ),
                    "CreateNamedPipeW",
                    self.name,
                )
            finally:
                kernel32.LocalFree(security_descriptor)
        except Exception as err:
            self._record_error(err)
            return None
        return handle

    def _run(self):
        self._thread_id = threading.get_native_id()
        while not self._stop.is_set():
            handle = self._create()
            if handle is None:
                if self._stop.is_set():
                    return
                time.sleep(0.01)
                continue
            pipe_handle = handle
            file = None
            try:
                if not kernel32.ConnectNamedPipe(pipe_handle, None):
                    error = ctypes.get_last_error()
                    if error == ERROR_PIPE_CONNECTED:
                        pass
                    elif error == ERROR_OPERATION_ABORTED and self._stop.is_set():
                        return
                    else:
                        raise ctypes.WinError(error, f"ConnectNamedPipe({self.name})")
                if self._stop.is_set():
                    return
                fd = msvcrt.open_osfhandle(pipe_handle, os.O_RDWR | os.O_BINARY)
                file = os.fdopen(fd, "r+b", buffering=0)
                self.handler(file)
            except Exception as err:
                self._record_error(err)
            finally:
                if file is not None:
                    try:
                        file.close()
                    except Exception:
                        pass
                if file is None:
                    _close_raw_handle(pipe_handle)
            time.sleep(0.005)
        self._thread_id = None


_pair_seq = [0]


def _next_pipe_base(tag):
    _pair_seq[0] += 1
    nonce = secrets.token_hex(16)
    return r"\\.\pipe\peersync.ipc.%s.%d.%d.%s" % (tag, os.getpid(), _pair_seq[0], nonce)


def create_ipc_pairs(tag):
    """Return (to_child, from_child) PipeChannels for child stdin/stdout."""
    base = _next_pipe_base(tag)
    to_child = PipeChannel(base + ".in", parent_reads=False)
    try:
        from_child = PipeChannel(base + ".out", parent_reads=True)
    except Exception:
        to_child.close()
        raise
    return to_child, from_child


def create_child_output_pipe(tag):
    """Return a parent-readable named pipe suitable for child stdout/stderr."""
    return PipeChannel(_next_pipe_base(tag) + ".out", parent_reads=True)


def rotate_log_files(log_path, max_bytes=5 * 1024 * 1024, backups=3, force=False):
    """Best-effort rotation; safe to call repeatedly from the log relay."""
    try:
        if not os.path.exists(log_path) or (not force and os.path.getsize(log_path) < max_bytes):
            return False
        oldest = f"{log_path}.{backups}"
        try:
            os.remove(oldest)
        except FileNotFoundError:
            pass
        for index in range(backups - 1, 0, -1):
            src = f"{log_path}.{index}"
            dst = f"{log_path}.{index + 1}"
            if os.path.exists(src):
                os.replace(src, dst)
        os.replace(log_path, f"{log_path}.1")
        return True
    except OSError:
        # AV scanners may transiently hold a rotated file. Logging must never
        # block the application; the relay retries rotation on a later chunk.
        return False


def open_inheritable_log(log_path):
    """File object that the child can inherit as stderr (with AV/reaper retries)."""
    import time as _time

    rotate_log_files(log_path)

    last = None
    for _attempt in range(10):
        handle = kernel32.CreateFileW(
            log_path,
            GENERIC_WRITE,
            3,  # FILE_SHARE_READ | FILE_SHARE_WRITE (log survives prior holder)
            None,
            4,  # OPEN_ALWAYS
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
        if handle in _INVALID or (handle is not None and ctypes.c_void_p(handle).value == -1):
            last = ctypes.WinError(ctypes.get_last_error(), "CreateFileW(log)")
            _time.sleep(0.5)
            continue

        raw_handle = handle
        fd = None
        try:
            if not kernel32.SetHandleInformation(raw_handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT):
                raise ctypes.WinError(ctypes.get_last_error(), "SetHandleInformation(log)")
            fd = msvcrt.open_osfhandle(raw_handle, os.O_WRONLY | os.O_APPEND | os.O_BINARY)
            raw_handle = None  # fd owns it now
            try:
                out = os.fdopen(fd, "ab", buffering=0)
                fd = None
                return out
            except Exception:
                if fd is not None:
                    os.close(fd)
                    fd = None
                raise
        except OSError as exc:
            last = exc
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            _close_raw_handle(raw_handle)
            _time.sleep(0.5)
        except Exception:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            _close_raw_handle(raw_handle)
            raise
    raise last
