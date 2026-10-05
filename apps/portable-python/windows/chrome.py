"""Windows custom window chrome helpers for the portable Tk shell.

The shell keeps a normal top-level Windows window (taskbar, Alt+Tab, resize,
Snap, maximize work-area semantics), but removes only the native caption so the
application can draw one coherent header instead of stacking a white Windows
caption above it.

Removing WS_CAPTION makes Windows treat maximize as "fill the whole monitor",
which hides the taskbar.  WM_GETMINMAXINFO plus a post-maximize clamp keep the
window on the monitor work area instead.
"""

from __future__ import annotations

import ctypes
import sys
import tkinter as tk
from ctypes import wintypes

GWL_STYLE = -16
GWLP_WNDPROC = -4
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_SYSMENU = 0x00080000

SW_SHOWNORMAL = 1
SW_SHOWMINIMIZED = 2
SW_SHOWMAXIMIZED = 3
SW_MINIMIZE = 6
SW_MAXIMIZE = 3
SW_RESTORE = 9
WPF_RESTORETOMAXIMIZED = 0x0002

SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020

WM_GETMINMAXINFO = 0x0024
WM_NCDESTROY = 0x0082
WM_NCCALCSIZE = 0x0083
WM_NCHITTEST = 0x0084
WM_NCPAINT = 0x0085
WM_NCACTIVATE = 0x0086
WM_NCLBUTTONDOWN = 0x00A1
HTCLIENT = 1
HTCAPTION = 2
HTLEFT = 10
HTRIGHT = 11
HTTOP = 12
HTTOPLEFT = 13
HTTOPRIGHT = 14
HTBOTTOM = 15
HTBOTTOMLEFT = 16
HTBOTTOMRIGHT = 17
SM_CXSIZEFRAME = 32
SM_CYSIZEFRAME = 33
SM_CXPADDEDBORDER = 92
MONITOR_DEFAULTTONEAREST = 2

LRESULT = ctypes.c_ssize_t
WNDPROC_FACTORY = getattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE)
WNDPROC = WNDPROC_FACTORY(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

# hwnd -> (callback, previous wndproc).  The callback must stay alive.
_WORK_AREA_HOOKS = {}


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class MINMAXINFO(ctypes.Structure):
    _fields_ = [
        ("ptReserved", POINT),
        ("ptMaxSize", POINT),
        ("ptMaxPosition", POINT),
        ("ptMinTrackSize", POINT),
        ("ptMaxTrackSize", POINT),
    ]


class WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [
        ("length", wintypes.UINT),
        ("flags", wintypes.UINT),
        ("showCmd", wintypes.UINT),
        ("ptMinPosition", POINT),
        ("ptMaxPosition", POINT),
        ("rcNormalPosition", wintypes.RECT),
    ]


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


def _user32():
    if sys.platform != "win32":
        return None
    return ctypes.windll.user32


def window_handle(window):
    """Return the real top-level HWND used by Tk on Windows."""
    user32 = _user32()
    if user32 is None:
        return 0
    try:
        window.update_idletasks()
        child = int(window.winfo_id())
        parent = int(user32.GetParent(ctypes.c_void_p(child)) or 0)
        return parent or child
    except (tk.TclError, TypeError, ValueError):
        return 0


def maximized_placement(monitor, work):
    """Return (x, y, cx, cy) for a captionless maximize.

    ``x``/``y`` are relative to the monitor origin (WM_GETMINMAXINFO).
    Size is the work area, so the taskbar stays visible.
    """
    ml, mt, _mr, _mb = monitor
    wl, wt, wr, wb = work
    return (int(wl - ml), int(wt - mt), int(wr - wl), int(wb - wt))


def maximized_screen_rect(work):
    """Return (x, y, cx, cy) in screen coordinates for the work area."""
    wl, wt, wr, wb = work
    return (int(wl), int(wt), int(wr - wl), int(wb - wt))


def _rect_tuple(rect):
    return (int(rect.left), int(rect.top), int(rect.right), int(rect.bottom))


def _monitor_rects(hwnd, user32):
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(MONITORINFO)
    monitor = user32.MonitorFromWindow(ctypes.c_void_p(hwnd), MONITOR_DEFAULTTONEAREST)
    if not monitor:
        return None
    if not user32.GetMonitorInfoW(ctypes.c_void_p(monitor), ctypes.byref(info)):
        return None
    return _rect_tuple(info.rcMonitor), _rect_tuple(info.rcWork)


def _covers_monitor(window_rect, monitor, slop=2):
    wl, wt, wr, wb = window_rect
    ml, mt, mr, mb = monitor
    return wl <= ml + slop and wt <= mt + slop and wr >= mr - slop and wb >= mb - slop


def resize_hit_test(window_rect, x, y, border=7, maximized=False):
    """Return the Win32 resize hit code for a borderless client frame."""
    if maximized:
        return HTCLIENT
    left, top, right, bottom = window_rect
    b = max(4, int(border or 0))
    on_left = left <= x < left + b
    on_right = right - b <= x < right
    on_top = top <= y < top + b
    on_bottom = bottom - b <= y < bottom
    if on_top and on_left:
        return HTTOPLEFT
    if on_top and on_right:
        return HTTOPRIGHT
    if on_bottom and on_left:
        return HTBOTTOMLEFT
    if on_bottom and on_right:
        return HTBOTTOMRIGHT
    if on_left:
        return HTLEFT
    if on_right:
        return HTRIGHT
    if on_top:
        return HTTOP
    if on_bottom:
        return HTBOTTOM
    return HTCLIENT


def _hit_test_resize(hwnd, lparam, user32):
    rect = wintypes.RECT()
    if not user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(rect)):
        return HTCLIENT
    x = ctypes.c_short(int(lparam) & 0xFFFF).value
    y = ctypes.c_short((int(lparam) >> 16) & 0xFFFF).value
    border = max(6, int(user32.GetSystemMetrics(SM_CXSIZEFRAME)) + int(user32.GetSystemMetrics(SM_CXPADDEDBORDER)))
    maximized = bool(user32.IsZoomed(ctypes.c_void_p(hwnd)))
    return resize_hit_test(_rect_tuple(rect), x, y, border=border, maximized=maximized)


def _apply_minmax_work_area(hwnd, lparam, user32):
    rects = _monitor_rects(hwnd, user32)
    if not rects or not lparam:
        return
    monitor, work = rects
    x, y, cx, cy = maximized_placement(monitor, work)
    if cx <= 0 or cy <= 0:
        return
    mmi = MINMAXINFO.from_address(int(lparam))
    mmi.ptMaxPosition.x = x
    mmi.ptMaxPosition.y = y
    mmi.ptMaxSize.x = cx
    mmi.ptMaxSize.y = cy


def _style_accessors(user32):
    get_style = getattr(user32, "GetWindowLongPtrW", user32.GetWindowLongW)
    set_style = getattr(user32, "SetWindowLongPtrW", user32.SetWindowLongW)
    get_style.restype = ctypes.c_ssize_t
    get_style.argtypes = [ctypes.c_void_p, ctypes.c_int]
    set_style.restype = ctypes.c_ssize_t
    set_style.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_ssize_t]
    return get_style, set_style


def _call_old_wndproc(user32, old, hwnd, msg, wparam, lparam):
    user32.CallWindowProcW.restype = LRESULT
    user32.CallWindowProcW.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    return int(user32.CallWindowProcW(ctypes.c_void_p(old), hwnd, msg, wparam, lparam) or 0)


def _install_work_area_hook(hwnd, user32):
    """Subclass the Tk wrapper so maximize/Snap stay on the work area."""
    if hwnd in _WORK_AREA_HOOKS:
        return
    get_style, set_style = _style_accessors(user32)
    old = int(get_style(ctypes.c_void_p(hwnd), GWLP_WNDPROC) or 0)
    if not old:
        return

    def _proc(hook_hwnd, msg, wparam, lparam):
        try:
            code = int(msg)
            if code == WM_NCDESTROY:
                # Restore the original proc before the HWND leaves existence,
                # then release the Python callback keeper.  A recycled HWND can
                # therefore be subclassed normally instead of hitting a stale
                # registry guard.
                try:
                    set_style(
                        ctypes.c_void_p(int(hook_hwnd or 0)),
                        GWLP_WNDPROC,
                        ctypes.c_ssize_t(old),
                    )
                except Exception:  # noqa: BLE001 - destruction must continue
                    pass
                _WORK_AREA_HOOKS.pop(int(hook_hwnd or 0), None)
                return _call_old_wndproc(user32, old, hook_hwnd, msg, wparam, lparam)
            if code == WM_GETMINMAXINFO:
                result = _call_old_wndproc(user32, old, hook_hwnd, msg, wparam, lparam)
                _apply_minmax_work_area(int(hook_hwnd or 0), int(lparam or 0), user32)
                return result
            if code == WM_NCCALCSIZE:
                # Make the client area cover the thick-frame pixels.  Keeping
                # WS_THICKFRAME retains normal Windows resize/Snap semantics.
                return 0
            if code == WM_NCPAINT:
                # Do not let DefWindowProc repaint the native grey resize frame
                # over our custom header.  On Win10 this repaint is otherwise
                # focus/hover-sensitive and appears/disappears in fragments.
                return 0
            if code == WM_NCACTIVATE:
                # We draw the complete caption ourselves; acknowledge the
                # activation change without repainting non-client pixels.
                return 1
            if code == WM_NCHITTEST:
                return _hit_test_resize(int(hook_hwnd or 0), int(lparam or 0), user32)
        except Exception:  # noqa: BLE001 - never break Tk's WndProc
            pass
        try:
            return _call_old_wndproc(user32, old, hook_hwnd, msg, wparam, lparam)
        except Exception:  # noqa: BLE001
            return 0

    callback = WNDPROC(_proc)
    # Keep the ctypes callback alive *before* publishing its pointer to Win32.
    # If SetWindowLongPtr partially succeeds and then raises, dropping the last
    # Python reference would leave Windows calling freed memory.
    _WORK_AREA_HOOKS[hwnd] = (callback, old)
    try:
        set_style(
            ctypes.c_void_p(hwnd),
            GWLP_WNDPROC,
            ctypes.c_ssize_t(ctypes.cast(callback, ctypes.c_void_p).value or 0),
        )
    except Exception:
        # No hook was successfully published through this call; do not leave a
        # stale registry guard if ctypes rejects the installation itself.
        _WORK_AREA_HOOKS.pop(hwnd, None)
        raise


def fit_maximized_to_work_area(window):
    """If a zoomed window still covers the whole monitor, clamp it to rcWork."""
    user32 = _user32()
    hwnd = window_handle(window)
    if user32 is None or not hwnd:
        return False
    try:
        if not user32.IsZoomed(ctypes.c_void_p(hwnd)):
            return False
        rects = _monitor_rects(hwnd, user32)
        if not rects:
            return False
        monitor, work = rects
        current = wintypes.RECT()
        if not user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(current)):
            return False
        if not _covers_monitor(_rect_tuple(current), monitor):
            return False
        x, y, cx, cy = maximized_screen_rect(work)
        if cx <= 0 or cy <= 0:
            return False
        user32.SetWindowPos(
            ctypes.c_void_p(hwnd),
            None,
            x,
            y,
            cx,
            cy,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
        return True
    except Exception:  # noqa: BLE001
        return False


def move_window(window, x, y):
    """Move the top-level window without entering a Win32 modal move loop."""
    user32 = _user32()
    hwnd = window_handle(window)
    if user32 is not None and hwnd:
        try:
            return bool(
                user32.SetWindowPos(
                    ctypes.c_void_p(hwnd),
                    None,
                    int(x),
                    int(y),
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                )
            )
        except Exception:  # noqa: BLE001
            pass
    try:
        # Developer fallback for non-Windows environments.  The production
        # portable build uses SetWindowPos above, including on multi-monitor
        # desktops where coordinates may be negative.
        window.geometry("+%d+%d" % (int(x), int(y)))
        return True
    except (tk.TclError, TypeError, ValueError):
        return False


def enable_custom_chrome(window):
    """Remove the native caption while preserving the real resizable window.

    This deliberately does *not* use Tk ``overrideredirect``.  Keeping the
    standard thick-frame/system styles means Windows still owns resize, Snap,
    taskbar, Alt+Tab and maximize-to-work-area behavior.
    """
    user32 = _user32()
    hwnd = window_handle(window)
    if user32 is None or not hwnd:
        return False

    try:
        get_style, set_style = _style_accessors(user32)
        style = int(get_style(ctypes.c_void_p(hwnd), GWL_STYLE))
        wanted = (
            (style & ~WS_CAPTION)
            | WS_THICKFRAME
            | WS_MINIMIZEBOX
            | WS_MAXIMIZEBOX
            | WS_SYSMENU
        )
        if wanted != style:
            set_style(ctypes.c_void_p(hwnd), GWL_STYLE, ctypes.c_ssize_t(wanted))
        user32.SetWindowPos(
            ctypes.c_void_p(hwnd),
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        # SWP_FRAMECHANGED makes Windows recompute the non-client area, and the
        # caption removal can leave a stale grey strip that repaints in fragments
        # while the client catches up.  Invalidate the whole window tree now so
        # the refreshed frame and the client area land in the same paint.
        _redraw_all(user32, hwnd)
        _install_work_area_hook(hwnd, user32)
        return True
    except Exception:  # noqa: BLE001 - custom chrome must never block startup
        return False


def _redraw_all(user32, hwnd):
    """Invalidate the window and every descendant, then repaint immediately."""
    # RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN.
    flags = 0x0001 | 0x0100 | 0x0080
    try:
        user32.RedrawWindow(ctypes.c_void_p(int(hwnd)), None, None, flags)
    except Exception:  # noqa: BLE001
        pass


def begin_window_drag(window):
    """Compatibility helper: queue, never synchronously enter, native dragging.

    The portable GUI now uses :func:`move_window` for title dragging.  Keep this
    helper for callers outside MainWindow, but avoid SendMessageW because a
    synchronous WM_NCLBUTTONDOWN can re-enter a Python WndProc while Tk is still
    dispatching the original button event.
    """
    user32 = _user32()
    hwnd = window_handle(window)
    if user32 is None or not hwnd:
        return False
    try:
        point = POINT()
        lparam = 0
        if user32.GetCursorPos(ctypes.byref(point)):
            lparam = ((int(point.y) & 0xFFFF) << 16) | (int(point.x) & 0xFFFF)
        user32.ReleaseCapture()
        post_message = user32.PostMessageW
        post_message.restype = wintypes.BOOL
        post_message.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        return bool(post_message(ctypes.c_void_p(hwnd), WM_NCLBUTTONDOWN, HTCAPTION, lparam))
    except Exception:  # noqa: BLE001
        return False


def minimize_window(window):
    user32 = _user32()
    hwnd = window_handle(window)
    if user32 is not None and hwnd:
        try:
            user32.ShowWindow(ctypes.c_void_p(hwnd), SW_MINIMIZE)
            return
        except Exception:  # noqa: BLE001
            pass
    try:
        window.iconify()
    except tk.TclError:
        pass


def capture_window_state(window):
    """Return restored WxH+X+Y plus whether the window is (or will restore) maximized."""
    user32 = _user32()
    hwnd = window_handle(window)
    if user32 is not None and hwnd:
        try:
            placement = WINDOWPLACEMENT()
            placement.length = ctypes.sizeof(WINDOWPLACEMENT)
            getter = user32.GetWindowPlacement
            getter.restype = wintypes.BOOL
            getter.argtypes = [ctypes.c_void_p, ctypes.POINTER(WINDOWPLACEMENT)]
            if getter(ctypes.c_void_p(hwnd), ctypes.byref(placement)):
                rc = placement.rcNormalPosition
                width = int(rc.right) - int(rc.left)
                height = int(rc.bottom) - int(rc.top)
                maximized = placement.showCmd == SW_SHOWMAXIMIZED or (
                    placement.showCmd == SW_SHOWMINIMIZED
                    and bool(placement.flags & WPF_RESTORETOMAXIMIZED)
                )
                if width >= 200 and height >= 160:
                    return {
                        "maximized": bool(maximized),
                        "geometry": "%dx%d%+d%+d"
                        % (width, height, int(rc.left), int(rc.top)),
                    }
        except Exception:  # noqa: BLE001
            pass
    try:
        return {
            "maximized": is_maximized(window),
            "geometry": str(window.geometry()),
        }
    except tk.TclError:
        return None


def apply_saved_maximized(window, maximized):
    if not maximized or is_maximized(window):
        return bool(maximized) and is_maximized(window)
    toggle_maximize(window)
    return is_maximized(window)


def is_maximized(window):
    user32 = _user32()
    hwnd = window_handle(window)
    if user32 is not None and hwnd:
        try:
            return bool(user32.IsZoomed(ctypes.c_void_p(hwnd)))
        except Exception:  # noqa: BLE001
            pass
    try:
        return str(window.state()) == "zoomed"
    except tk.TclError:
        return False


def toggle_maximize(window):
    user32 = _user32()
    hwnd = window_handle(window)
    maximized = is_maximized(window)
    if user32 is not None and hwnd:
        try:
            user32.ShowWindow(ctypes.c_void_p(hwnd), SW_RESTORE if maximized else SW_MAXIMIZE)
            if not maximized:
                fit_maximized_to_work_area(window)
                try:
                    window.after_idle(lambda: fit_maximized_to_work_area(window))
                except tk.TclError:
                    pass
            return not maximized
        except Exception:  # noqa: BLE001
            pass
    try:
        window.state("normal" if maximized else "zoomed")
    except tk.TclError:
        pass
    return not maximized
