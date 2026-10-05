"""Windows notification-area icon implemented with ctypes only.

The native tray window owns its own Win32 message-loop thread.  Tk never
DispatchMessage()s Win32 tray messages and the WndProc never calls Tk.  Native
callbacks only enqueue high-level actions; ``pump()`` is called by the Tk loop
and executes the Python callbacks on the Tk thread.

This separation is deliberate: mixing a manually pumped Win32 WndProc into the
Tk message loop is fragile in frozen/windowed builds and can terminate or lose
the tray window during mouse notifications.
"""

import atexit
import ctypes
from ctypes import wintypes
import os
import queue
import threading
import time
import traceback

from . import paths

_IS_WINDOWS = os.name == "nt" and hasattr(ctypes, "WinDLL")
user32 = ctypes.WinDLL("user32", use_last_error=True) if _IS_WINDOWS else None
shell32 = ctypes.WinDLL("shell32", use_last_error=True) if _IS_WINDOWS else None
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True) if _IS_WINDOWS else None

TRAY_RUNTIME = "threaded-v2"

WM_NULL = 0x0000
WM_DESTROY = 0x0002
WM_CLOSE = 0x0010
WM_QUIT = 0x0012
WM_CONTEXTMENU = 0x007B
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONUP = 0x0205
WM_USER = 0x0400
WM_APP = 0x8000
WM_TRAY = WM_APP + 1
WM_TRAY_DESTROY = WM_APP + 2

NIN_SELECT = WM_USER + 0
NIN_KEYSELECT = NIN_SELECT | 0x1

NIM_ADD, NIM_MODIFY, NIM_DELETE = 0, 1, 2
NIF_MESSAGE, NIF_ICON, NIF_TIP = 1, 2, 4
LR_LOADFROMFILE = 0x0010
IMAGE_ICON = 1
MF_STRING, MF_SEPARATOR = 0x0000, 0x0001
TPM_RIGHTBUTTON = 0x0002
TPM_RETURNCMD = 0x0100
IDC_ARROW = 32512
WS_EX_TOOLWINDOW = 0x00000080
WS_POPUP = 0x80000000

CM_OPEN, CM_EXIT = 1, 2
SHOW_EVENTS = {WM_LBUTTONDBLCLK, NIN_KEYSELECT}
MENU_EVENTS = {WM_RBUTTONUP, WM_CONTEXTMENU}

u32 = ctypes.c_uint32
i32 = ctypes.c_int32
LRESULT = ctypes.c_ssize_t


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", u32),
        ("style", u32),
        ("lpfnWndProc", ctypes.c_void_p),
        ("cbClsExtra", i32),
        ("cbWndExtra", i32),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
        ("hIconSm", wintypes.HICON),
    ]


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", ctypes.c_ubyte * 8),
    ]


class NOTIFYICONDATAW(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("uTimeout", wintypes.UINT), ("uVersion", wintypes.UINT)]

    _anonymous_ = ("_u",)
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("hWnd", wintypes.HWND),
        ("uID", wintypes.UINT),
        ("uFlags", wintypes.UINT),
        ("uCallbackMessage", wintypes.UINT),
        ("hIcon", wintypes.HICON),
        ("szTip", wintypes.WCHAR * 128),
        ("dwState", wintypes.DWORD),
        ("dwStateMask", wintypes.DWORD),
        ("szInfo", wintypes.WCHAR * 256),
        ("_u", _U),
        ("szInfoTitle", wintypes.WCHAR * 64),
        ("dwInfoFlags", wintypes.DWORD),
        ("guidItem", GUID),
        ("hBalloonIcon", wintypes.HICON),
    ]


class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("message", wintypes.UINT),
        ("wParam", wintypes.WPARAM),
        ("lParam", wintypes.LPARAM),
        ("time", wintypes.DWORD),
        ("pt", POINT),
    ]


WNDPROC = getattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE)(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

if _IS_WINDOWS:
    user32.RegisterClassExW.restype = wintypes.ATOM
    user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]
    user32.UnregisterClassW.restype = wintypes.BOOL
    user32.UnregisterClassW.argtypes = [wintypes.LPCWSTR, wintypes.HINSTANCE]
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        i32,
        i32,
        i32,
        i32,
        wintypes.HWND,
        wintypes.HMENU,
        wintypes.HINSTANCE,
        ctypes.c_void_p,
    ]
    user32.DefWindowProcW.restype = LRESULT
    user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.LoadImageW.restype = wintypes.HANDLE
    user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT, i32, i32, wintypes.UINT]
    user32.DestroyIcon.restype = wintypes.BOOL
    user32.DestroyIcon.argtypes = [wintypes.HICON]
    user32.LoadCursorW.restype = wintypes.HANDLE
    user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.TrackPopupMenu.restype = wintypes.UINT
    user32.TrackPopupMenu.argtypes = [
        wintypes.HMENU,
        wintypes.UINT,
        i32,
        i32,
        i32,
        wintypes.HWND,
        ctypes.c_void_p,
    ]
    user32.GetCursorPos.restype = wintypes.BOOL
    user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
    user32.CreatePopupMenu.restype = wintypes.HMENU
    user32.AppendMenuW.restype = wintypes.BOOL
    user32.AppendMenuW.argtypes = [wintypes.HMENU, wintypes.UINT, wintypes.UINT, wintypes.LPCWSTR]
    user32.DestroyMenu.restype = wintypes.BOOL
    user32.DestroyMenu.argtypes = [wintypes.HMENU]
    user32.PostMessageW.restype = wintypes.BOOL
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.GetMessageW.restype = wintypes.BOOL
    user32.GetMessageW.argtypes = [ctypes.POINTER(MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
    user32.TranslateMessage.restype = wintypes.BOOL
    user32.TranslateMessage.argtypes = [ctypes.POINTER(MSG)]
    user32.DispatchMessageW.restype = LRESULT
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(MSG)]
    user32.DestroyWindow.restype = wintypes.BOOL
    user32.DestroyWindow.argtypes = [wintypes.HWND]
    user32.PostQuitMessage.argtypes = [i32]
    user32.RegisterWindowMessageW.restype = wintypes.UINT
    user32.RegisterWindowMessageW.argtypes = [wintypes.LPCWSTR]
    shell32.Shell_NotifyIconW.restype = wintypes.BOOL
    shell32.Shell_NotifyIconW.argtypes = [wintypes.DWORD, ctypes.POINTER(NOTIFYICONDATAW)]
    kernel32.GetModuleHandleW.restype = wintypes.HINSTANCE
    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]


def notify_event(lparam):
    """Return the notification code for classic and version-4 tray messages."""
    return int(lparam) & 0xFFFF


def _diag(line, reset=False):
    """Best-effort tray diagnostics; never allowed to affect the application."""
    try:
        os.makedirs(paths.logs_dir(), exist_ok=True)
        mode = "w" if reset else "a"
        log_path = os.path.join(paths.logs_dir(), "tray-runtime.log")
        if not reset:
            paths.rotate_log_files(log_path)
        with open(log_path, mode, encoding="utf-8") as fh:
            fh.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), line))
    except Exception:
        pass


class Tray:
    """Notification-area icon with a dedicated native message-loop thread.

    ``install`` starts the native loop and waits until Shell_NotifyIconW has
    succeeded.  ``pump`` must be called periodically by Tk; it drains queued
    actions and invokes ``on_show``/``on_exit`` on the Tk thread.
    """

    def __init__(self, title, icon_path, on_show, on_exit):
        self.title = title
        self.icon_path = icon_path
        self.on_show = on_show
        self.on_exit = on_exit
        self.hwnd = None
        self.icon = None
        self.destroyed = False
        self._icon_added = False
        self._hinst = None
        self._actions = queue.Queue()
        self._ready = threading.Event()
        self._thread = None
        self._install_error = None
        self._taskbar_created = user32.RegisterWindowMessageW("TaskbarCreated") if _IS_WINDOWS else 0
        self._class_name = "PeerSyncTray_%s_%x" % (os.getpid(), id(self))
        self._wndproc = WNDPROC(self._handle_message) if _IS_WINDOWS else None

    def install(self):
        if not _IS_WINDOWS:
            raise RuntimeError("Windows tray is available only on Windows")
        if self._thread and self._thread.is_alive():
            return
        self.destroyed = False
        _diag("runtime=%s install requested pid=%s" % (TRAY_RUNTIME, os.getpid()), reset=True)
        self._thread = threading.Thread(target=self._thread_main, name="peersync-tray", daemon=True)
        self._thread.start()
        if not self._ready.wait(5.0):
            # Timeout is a cancellation, not a transfer of ownership.  The
            # native thread may still finish initialization later, so mark it
            # destroyed now; _thread_main will immediately unwind through its
            # finally block and remove any late-created icon/window itself.
            self.destroy()
            raise RuntimeError("tray native thread did not initialize")
        if self._install_error is not None:
            self.destroy()
            raise RuntimeError("tray install failed: %s" % self._install_error)
        if not self.hwnd or not self._icon_added:
            self.destroy()
            raise RuntimeError("tray install incomplete")
        atexit.register(self.destroy)
        _diag("install complete hwnd=%s" % int(self.hwnd))

    def _thread_main(self):
        try:
            self._install_native()
            self._ready.set()
            if self.destroyed:
                return
            msg = MSG()
            while True:
                rc = int(user32.GetMessageW(ctypes.byref(msg), None, 0, 0))
                if rc == 0:
                    break
                if rc == -1:
                    raise ctypes.WinError(ctypes.get_last_error())
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        except BaseException as exc:  # never let a native-thread error vanish
            self._install_error = self._install_error or exc
            _diag("native thread failure: %s\n%s" % (exc, traceback.format_exc()))
            self._ready.set()
        finally:
            self._cleanup_native()
            _diag("native thread stopped")

    def _install_native(self):
        self._hinst = kernel32.GetModuleHandleW(None)
        wc = WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
        wc.lpfnWndProc = ctypes.cast(self._wndproc, ctypes.c_void_p)
        wc.hInstance = self._hinst
        wc.hCursor = user32.LoadCursorW(None, ctypes.c_void_p(IDC_ARROW))
        wc.lpszClassName = self._class_name
        ctypes.set_last_error(0)
        atom = user32.RegisterClassExW(ctypes.byref(wc))
        if not atom:
            raise ctypes.WinError(ctypes.get_last_error())

        # A hidden top-level tool window is intentional.  Unlike HWND_MESSAGE,
        # it receives the TaskbarCreated broadcast after Explorer restarts.
        self.hwnd = user32.CreateWindowExW(
            WS_EX_TOOLWINDOW,
            self._class_name,
            "PeerSyncTray",
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            self._hinst,
            None,
        )
        if not self.hwnd:
            raise ctypes.WinError(ctypes.get_last_error())

        if self.icon_path:
            self.icon = user32.LoadImageW(None, self.icon_path, IMAGE_ICON, 0, 0, LR_LOADFROMFILE)
        self._add_icon_native()

    def _nid(self, flags=NIF_MESSAGE | NIF_ICON | NIF_TIP):
        nid = NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
        nid.hWnd = self.hwnd
        nid.uID = 1
        nid.uFlags = flags
        nid.uCallbackMessage = WM_TRAY
        nid.hIcon = self.icon or None
        nid.szTip = self.title[:127]
        return nid

    def _add_icon_native(self):
        if self.destroyed or not self.hwnd:
            return
        if not shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(self._nid())):
            raise RuntimeError("Shell_NotifyIconW(NIM_ADD) failed: %s" % ctypes.get_last_error())
        self._icon_added = True

    def _delete_icon_native(self):
        if self._icon_added and self.hwnd:
            try:
                shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(self._nid(flags=0)))
            finally:
                self._icon_added = False

    def ensure_visible(self):
        """Re-add the icon after Explorer restarts."""
        if self.destroyed or not self.hwnd:
            return
        try:
            self._delete_icon_native()
            self._add_icon_native()
            _diag("icon re-added after TaskbarCreated")
        except Exception as exc:
            _diag("icon re-add failed: %s" % exc)

    def set_tip(self, text):
        self.title = text
        if not self.destroyed and self.hwnd and self._icon_added:
            if not shell32.Shell_NotifyIconW(NIM_MODIFY, ctypes.byref(self._nid())):
                _diag("NIM_MODIFY failed: %s" % ctypes.get_last_error())

    def pump(self):
        """Drain actions on the Tk thread.  Kept as pump() for GUI compatibility."""
        if self.destroyed:
            return
        for _ in range(32):
            try:
                action = self._actions.get_nowait()
            except queue.Empty:
                break
            try:
                if action == "show":
                    _diag("dispatch show on Tk thread")
                    self.on_show()
                elif action == "exit":
                    _diag("dispatch exit on Tk thread")
                    self.on_exit()
            except Exception as exc:
                _diag("Tk tray callback failed: %s\n%s" % (exc, traceback.format_exc()))

    def destroy(self):
        if self.destroyed:
            return
        self.destroyed = True
        _diag("destroy requested")
        hwnd = self.hwnd
        if hwnd:
            user32.PostMessageW(hwnd, WM_TRAY_DESTROY, 0, 0)
        # Native UI cleanup belongs to the tray thread.  Never join it from
        # Tk: TrackPopupMenu/GetMessage may legitimately be inside a native
        # modal loop and blocking Tk here freezes application shutdown.

    def _cleanup_native(self):
        try:
            self._delete_icon_native()
        except Exception as exc:
            _diag("NIM_DELETE cleanup failed: %s" % exc)
        hwnd = self.hwnd
        self.hwnd = None
        if hwnd:
            try:
                user32.DestroyWindow(hwnd)
            except Exception:
                pass
        if self.icon:
            try:
                user32.DestroyIcon(self.icon)
            except Exception:
                pass
            self.icon = None
        if self._hinst:
            try:
                user32.UnregisterClassW(self._class_name, self._hinst)
            except Exception:
                pass

    def _handle_message(self, hwnd, message, wparam, lparam):
        try:
            return self._handle_message_inner(hwnd, message, wparam, lparam)
        except BaseException as exc:  # never unwind through the native callback
            _diag("WndProc failure message=%s: %s\n%s" % (message, exc, traceback.format_exc()))
            return user32.DefWindowProcW(hwnd, message, wparam, lparam)

    def _handle_message_inner(self, hwnd, message, wparam, lparam):
        if message == WM_TRAY:
            code = notify_event(lparam)
            if code in SHOW_EVENTS:
                _diag("native show event code=%s" % code)
                self._actions.put("show")
                return 0
            if code in MENU_EVENTS:
                self._popup_native()
                return 0
            return 0
        if self._taskbar_created and message == self._taskbar_created:
            self.ensure_visible()
            return 0
        if message in (WM_CLOSE, WM_TRAY_DESTROY):
            self._delete_icon_native()
            user32.DestroyWindow(hwnd)
            return 0
        if message == WM_DESTROY:
            self.hwnd = None
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, message, wparam, lparam)

    def _popup_native(self):
        menu = user32.CreatePopupMenu()
        if not menu:
            return
        try:
            user32.AppendMenuW(menu, MF_STRING, CM_OPEN, "Open PeerSync")
            user32.AppendMenuW(menu, MF_SEPARATOR, 0, None)
            user32.AppendMenuW(menu, MF_STRING, CM_EXIT, "Exit")
            pt = POINT()
            user32.GetCursorPos(ctypes.byref(pt))
            user32.SetForegroundWindow(self.hwnd)
            cmd = int(
                user32.TrackPopupMenu(
                    menu,
                    TPM_RIGHTBUTTON | TPM_RETURNCMD,
                    pt.x,
                    pt.y,
                    0,
                    self.hwnd,
                    None,
                )
            )
        finally:
            user32.DestroyMenu(menu)
            user32.PostMessageW(self.hwnd, WM_NULL, 0, 0)
        if cmd == CM_OPEN:
            self._actions.put("show")
        elif cmd == CM_EXIT:
            self._actions.put("exit")
