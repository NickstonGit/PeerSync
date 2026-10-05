"""One-commit workspace geometry for the portable UI.

The old shell mixed three geometry systems: a ``ttk.Panedwindow`` for the two
file cards, ``grid`` columns for the chat dock, and ``columnspan`` switches plus
``grid_remove`` to show or hide chat.  A chat toggle therefore had to repaint the
file cards at the new column span *first* and move the sash *afterwards* (in an
idle callback), which produced a visible intermediate frame where the cards had
already stretched but the divider still sat at its old pixel position.  Window
resize had the mirror-image defect: the Panedwindow keeps its sash at a fixed
pixel offset, so the saved ratio was only restored by a debounced callback after
the user stopped dragging, i.e. the columns jumped once at the end.

This module replaces all of that with a single geometry function.  State is
expressed in ratios (what the user means) and every frame is derived from it:

* ``layout()`` computes every rectangle from ``(sash_ratio, chat_visible,
  narrow_mode)`` and issues all ``place()`` calls in one pass, wrapped in a
  Win32 redraw lock so the whole workspace lands on screen as one frame.
* The sash is a plain draggable canvas.  Dragging it writes the ratio and calls
  ``layout()``, so the file cards follow the pointer exactly as the divider does.
* Window resize calls ``layout()`` directly: the sash stays at its ratio for the
  whole drag, with no deferred correction and no end-of-drag jump.

Per-widget redraw cost is still bounded by the callers themselves (``PathBar``
and ``AppButton`` skip work when their visual inputs are unchanged); this module
only guarantees that geometry is committed atomically.
"""

import ctypes
import tkinter as tk

from gui import theme as ui_theme

# Visual constants, kept identical to the previous grid-based layout so the
# workspace looks the same before and after the rearchitecture.
SASH_THICKNESS = 5
# The grab band is wider than the painted rule: the extra pixels are the
# "breathing room" the old layout took from the card padx, so the divider still
# reads as a handle rather than a seam pinched between two card borders.
SASH_HANDLE = 17
CHAT_RULE_THICKNESS = SASH_THICKNESS
CHAT_RULE_HANDLE = SASH_HANDLE
CHAT_GAP = 6      # gutter on both sides of the chat rule


def _begin_defer(window):
    """Stop Win32 repainting the window tree while geometry is being rebuilt."""
    if str(window.tk.call("tk", "windowingsystem")) != "win32":
        return False
    try:
        user32 = ctypes.windll.user32
    except (AttributeError, OSError):
        return False
    try:
        hwnd = int(window.winfo_id())
        root = int(window.winfo_toplevel().winfo_id())
    except tk.TclError:
        return False
    # WM_SETREDRAW, sent to the real top level: children inherit the freeze.
    if not root:
        return False
    try:
        user32.SendMessageW(ctypes.c_void_p(root), 11, 0, 0)
        return (user32, root, hwnd)
    except Exception:  # noqa: BLE001 - a missing freeze must not break layout
        return False


def _end_defer(token):
    """Re-enable painting and invalidate the whole tree in one shot."""
    if not token:
        return
    user32, root, _hwnd = token
    try:
        user32.SendMessageW(ctypes.c_void_p(root), 11, 1, 0)
    except Exception:  # noqa: BLE001
        return
    # RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN: repaint the window and
    # every descendant now, so the frozen batch becomes one visible frame.
    flags = 0x0001 | 0x0100 | 0x0080
    try:
        user32.RedrawWindow(ctypes.c_void_p(root), None, None, flags)
    except Exception:  # noqa: BLE001
        pass


class Sash(tk.Canvas):
    """Draggable ratio-driven divider between the two file cards.

    A plain ``ttk.Panedwindow`` sash stores an absolute pixel offset.  On window
    resize that offset is what makes one pane swallow all the extra width until a
    deferred callback corrects it.  Keeping the ratio here instead means resize,
    drag and chat toggle all read and write the same quantity.
    """

    def __init__(self, master, on_ratio, on_drag_end=None, **kwargs):
        super().__init__(
            master,
            width=SASH_HANDLE,
            bd=0,
            highlightthickness=0,
            relief="flat",
            takefocus=0,
            cursor="sb_h_double_arrow",
            **kwargs,
        )
        self._on_ratio = on_ratio
        self._on_drag_end = on_drag_end
        self._dragging = False
        self.bind("<ButtonPress-1>", self._press)
        self.bind("<B1-Motion>", self._motion)
        self.bind("<ButtonRelease-1>", self._release)
        # Repaint after geometry changes.  After the resize optimization the
        # canvas can receive its new rectangle while Tk keeps the old backing
        # pixels.  The first mouse hover used to trigger the missing paint.
        self.bind("<Configure>", lambda _e: self._paint(self._hover))
        self.bind("<Enter>", self._enter)
        self.bind("<Leave>", self._leave)
        self._hover = False
        self._paint(False)

    def _enter(self, _event):
        self._hover = True
        self._paint(True)

    def _leave(self, _event):
        self._hover = False
        self._paint(False)

    def _paint(self, hover):
        try:
            self.configure(background=ui_theme.color("SURFACE"))
            self.delete("all")
            width = max(1, int(self.winfo_width()))
            height = max(1, int(self.winfo_height()))
        except tk.TclError:
            return
        # Centre the visible rule inside the wider invisible grab margin so a
        # 5px divider stays easy to grab, matching the old Sash geometry.
        x0 = max(0, (width - SASH_THICKNESS) // 2)
        self.create_rectangle(
            x0, 0, x0 + SASH_THICKNESS, height,
            fill=ui_theme.color("BORDER_STRONG"), outline="",
        )

    def _press(self, event):
        self._dragging = True

    def _motion(self, event):
        if not self._dragging:
            return
        self._report(event)

    def _release(self, event):
        if not self._dragging:
            return
        self._dragging = False
        self._report(event)
        if callable(self._on_drag_end):
            self._on_drag_end()

    def _report(self, event):
        """Hand the pointer position to the owner as a workspace-relative x."""
        try:
            # Coordinates must be relative to the workspace, not to the sash
            # itself. The sash moves during drag; using its current x as the
            # origin creates feedback where moving right makes the next event
            # appear to move left.
            origin = int(self.master.winfo_rootx())
            total = int(self.master.winfo_width())
        except tk.TclError:
            return
        if total <= 0:
            return
        x = int(event.x_root) - origin
        self._on_ratio(x, total)

class ChatRule(tk.Canvas):
    """Draggable separator between file area and chat.

    It is intentionally a real sash, not only a visual line. The previous
    optimization removed this handle and left chat width fixed.
    """

    def __init__(self, master, on_drag):
        super().__init__(
            master, width=CHAT_RULE_HANDLE, bd=0, highlightthickness=0,
            relief="flat", cursor="sb_h_double_arrow"
        )
        self._on_drag = on_drag
        self._dragging = False
        self.bind("<ButtonPress-1>", lambda e: self._start(e))
        self.bind("<B1-Motion>", self._move)
        self.bind("<ButtonRelease-1>", lambda e: self._stop())
        self.bind("<Configure>", lambda e: self._paint())
        self._paint()

    def _paint(self):
        self.delete("all")
        w=max(1, self.winfo_width())
        h=max(1, self.winfo_height())
        x=(w-CHAT_RULE_THICKNESS)//2
        self.create_rectangle(x,0,x+CHAT_RULE_THICKNESS,h,fill=ui_theme.color("BORDER_STRONG"),outline="")

    def _start(self, _event):
        self._dragging=True

    def _move(self, event):
        if self._dragging:
            self._on_drag(event.x_root)

    def _stop(self):
        self._dragging=False


class WorkspaceLayout:
    """Owner of the two file cards, the sash, the chat rule and the chat column.

    Geometry is a pure function of state; there is no incremental bookkeeping to
    get out of sync.  ``layout()`` is the only entry point that moves widgets.
    """

    def __init__(self, parent, left, right, chat, chat_width, min_pane=180):
        self.parent = parent
        self.left = left
        self.right = right
        self.chat = chat
        self.chat_width = int(chat_width)
        self.min_pane = int(min_pane)
        self.sash_ratio = 0.5
        self._sash_px = None
        self.chat_visible = True
        self.narrow_mode = False
        # Re-entrancy guard: update_idletasks() inside the frozen batch can
        # deliver the Configure events the place() calls just generated, which
        # would re-enter layout() and re-enable painting before the outer batch
        # is committed.
        self._layoutting = False
        self._chat_rule = ChatRule(parent, self._set_chat_width_from_mouse)
        self.sash = Sash(parent, self._set_ratio_from_x, self._on_drag_end)
        # Start unmapped; layout() decides what is visible.
        self._chat_rule.place_forget()
        self.sash.place_forget()

    # ---------- state ----------

    def _set_chat_width_from_mouse(self, x_root):
        try:
            total = int(self.parent.winfo_width())
            old_files = self._files_width(total)
            keep_left = self._sash_x(old_files)
        except tk.TclError:
            return
        chat = int(self.parent.winfo_rootx() + total - x_root)
        self.chat_width = max(self.min_pane, chat)
        # The chat divider changes only the chat width. The file divider keeps
        # its pixel position; it must not slide just because the right column
        # changed size.
        self._sash_px = keep_left
        self.layout()

    def set_sash_ratio(self, ratio):
        """Clamp and remember the divider position, then relayout."""
        self.sash_ratio = self._clamp_ratio(float(ratio))
        self.layout()

    def _set_ratio_from_x(self, x, total):
        """Pointer drag: convert a workspace x into a clamped ratio.

        The pointer sits at the centre of the visible rule, so subtract half the
        grab band to get the band origin, then divide by the usable file width.
        """
        files_width = self._files_width(total)
        usable = max(1, files_width - SASH_HANDLE)
        self.sash_ratio = self._clamp_ratio((float(x) - SASH_HANDLE / 2.0) / float(usable))
        self._sash_px = None
        self.layout()

    def _on_drag_end(self):
        # Persisting happens through the owner's after-idle hook, if any.
        hook = getattr(self, "on_sash_changed", None)
        if callable(hook):
            hook()

    def _clamp_ratio(self, ratio):
        ratio = 0.5 if ratio != ratio else ratio  # NaN guard
        return max(0.0, min(1.0, ratio))

    def set_chat_visible(self, visible):
        """Show or hide chat without sliding the divider across the cards.

        Hiding chat widens the file area.  A ratio-driven sash would keep its
        share of that wider area and visibly jump right, when what the user
        expects is the neighbouring card absorbing the freed space: the divider
        stays put and only the right card grows.  Anchor the ratio to the
        divider's current pixel position instead.
        """
        visible = bool(visible)
        if visible == self.chat_visible:
            self.layout()
            return
        # Keep the divider proportional when the chat column disappears or
        # returns. The old implementation anchored the left card in pixels, so
        # hiding chat only enlarged the right card and moved the visual centre.
        # The ratio is the user's intent: both file panes should share the freed
        # width proportionally.
        self.chat_visible = visible
        self.layout()

    def set_narrow_mode(self, narrow):
        self.narrow_mode = bool(narrow)
        self.layout()

    def set_min_pane(self, min_pane):
        self.min_pane = max(1, int(min_pane or 0))
        self.layout()

    # ---------- geometry ----------
    def _files_width(self, total):
        """Width available to the two file cards once chat has taken its share."""
        if self.narrow_mode or not self.chat_visible:
            return total
        return max(0, total - self.chat_width - 2 * CHAT_GAP - SASH_THICKNESS)

    def _sash_x(self, files_width):
        """Pixel position of the divider band inside the file area.

        ``sash_ratio`` is the share of the *usable* width, where usable means
        what is left after the grab band itself.  Clamping to ``min_pane`` on
        both sides keeps a pane from shrinking below its own toolbar.
        """
        if files_width <= 0:
            return 0
        if self._sash_px is not None:
            return max(self.min_pane, min(files_width - SASH_HANDLE - self.min_pane, self._sash_px))
        usable = max(0, files_width - SASH_HANDLE)
        pos = int(round(usable * self.sash_ratio))
        limit = max(0, usable - self.min_pane)
        return max(self.min_pane, min(limit, pos))

    def layout(self):
        """Apply every widget rectangle in one deferred, atomic pass."""
        if self._layoutting:
            # A nested layout() would re-enable painting (WM_SETREDRAW=1) while
            # the outer batch is still building the frame.  The outer pass
            # already commits the current state, so the nested call is redundant.
            return
        try:
            total = int(self.parent.winfo_width())
            height = int(self.parent.winfo_height())
        except tk.TclError:
            return
        if total <= 0 or height <= 0:
            return

        self._layoutting = True
        token = _begin_defer(self.parent)
        try:
            if self.narrow_mode:
                self._layout_narrow(total, height)
            else:
                self._layout_wide(total, height)
        except tk.TclError:
            pass
        finally:
            # Re-enable painting first.  Calling update_idletasks() while
            # WM_SETREDRAW is off makes Tk drop the real paint and leaves
            # buttons and canvases at their pre-layout content, so the batch has
            # to end before any dependent geometry is resolved.
            _end_defer(token)
            self._layoutting = False

        # Now that painting is on again, let widgets settle at their new
        # rectangles and reposition what is measured against real geometry — the
        # progress row overlays read Treeview cell boxes, so they need the
        # Configure events the place() calls produced.
        try:
            self.parent.update_idletasks()
        except tk.TclError:
            pass
        hook = getattr(self, "on_after_layout", None)
        if callable(hook):
            try:
                hook()
            except tk.TclError:
                pass

    def _layout_wide(self, total, height):
        files_width = self._files_width(total)
        self._layout_files(files_width, height)

        if self.chat_visible:
            # The file area already stops at the chat column; the rule and the
            # chat panel fill the remainder.
            rule_x = files_width + CHAT_GAP
            chat_x = rule_x + CHAT_RULE_HANDLE + CHAT_GAP
            chat_w = max(0, total - chat_x)
            self._chat_rule.place(x=rule_x, y=0, width=CHAT_RULE_HANDLE, height=height)
            self.chat.place(x=chat_x, y=0, width=chat_w, height=height)
        else:
            self._chat_rule.place_forget()
            self.chat.place_forget()

    def _layout_files(self, files_width, height):
        """Place both file cards and the sash inside the given file area."""
        sash_x = self._sash_x(files_width)
        left_w = max(0, sash_x)
        right_x = sash_x + SASH_HANDLE
        right_w = max(0, files_width - right_x)

        self.left.place(x=0, y=0, width=left_w, height=height)
        self.right.place(x=right_x, y=0, width=right_w, height=height)
        self.sash.place(x=sash_x, y=0, width=SASH_HANDLE, height=height)

    def _layout_narrow(self, total, height):
        # Narrow mode replaces the file area with chat rather than splitting it:
        # the cards stay mapped so their session state survives, but only the
        # file pair or the chat is on screen at a time.  The file pair keeps its
        # own sash, exactly as it does in wide mode.
        if self.chat_visible:
            self.chat.place(x=0, y=0, width=total, height=height)
            self.left.place_forget()
            self.right.place_forget()
            self.sash.place_forget()
            self._chat_rule.place_forget()
        else:
            self.chat.place_forget()
            self._layout_files(total, height)
