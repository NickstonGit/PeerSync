"""One responsive file panel over the Core fs.list contract."""

import tkinter as tk
import tkinter.font as tkfont
from datetime import datetime

from gui.i18n import t, error_text, error_code
from gui import theme as ui_theme
from gui import design
from gui.components import (
    AppButton, AppFrame, AppLabel, AppComboBox, AppCard, AppTree, AppScrollbar,
    AppEntry, ToolTip, load_button_icon,
)


#: One definition of "terminal", shared with the batch controller. A row and its
#: batch must never disagree about whether an operation has finished, so the set
#: lives in this lower-level module and the controller imports it.
TERMINAL_STATES = frozenset({"done", "failed", "cancelled", "stale"})
_TERMINAL = set(TERMINAL_STATES)
_DONE_HOLD_MS = 800
_FAIL_HOLD_MS = 5000
_CANCEL_HOLD_MS = 3500
_LIST_WINDOW_PAGES = 6
# Progress overlays repaint these Treeview cells; the order defines the row
# layout, so it must stay aligned with FilePanel's column setup.
_OVERLAY_COLUMNS = ("name", "type", "size", "date")
# Horizontal room the folder row needs before it may start dropping controls.
# Below this the sash clamp gives up rather than let a pane overlap its sibling.
SELECTOR_MIN_WIDTH = 430
# Horizontal breathing room kept on both sides of the card caption.
_CAPTION_INSET = 12
# Keyed by the owning Tk interpreter: a tkfont.Font belongs to its root and is
# dead once that interpreter is destroyed, so a process-wide cache would hand
# out stale objects.
_FONT_CACHES = {}


def _measured_font(root, spec):
    """Cached real font, so canvas text is measured instead of guessed."""
    try:
        cache = _FONT_CACHES.setdefault(str(root), {})
        font = cache.get(spec)
        if font is None:
            font = tkfont.Font(root=root, font=spec)
            cache[spec] = font
        return font
    except (tk.TclError, RuntimeError, AttributeError, TypeError):
        # No usable Tk root (headless, already destroyed): fall back to the
        # caller instead of letting a font lookup break the whole redraw.
        return None


def _font_width(font, text, fallback_px=7):
    """Measure text, tolerating a font whose Tk interpreter is gone.

    StringVar traces and <Configure> can still fire while the window is being
    torn down, and a dead font would otherwise raise out of the redraw.
    """
    if font is None:
        return len(str(text or "")) * fallback_px
    try:
        return int(font.measure(str(text or "")))
    except (tk.TclError, RuntimeError, AttributeError, TypeError):
        return len(str(text or "")) * fallback_px


def fit_canvas_text(root, text, spec, max_px):
    """Shorten text until its real glyphs fit inside max_px.

    Canvas never clips a text item to its own box, so an untruncated string
    paints straight over whatever sits next to it.
    """
    text = str(text or "")
    if max_px <= 4:
        return ""
    font = _measured_font(root, spec)
    if font is None:
        return text
    try:
        if font.measure(text) <= max_px:
            return text
    except (tk.TclError, RuntimeError, AttributeError, TypeError):
        return text
    ellipsis = "…"
    ellipsis_px = _font_width(font, ellipsis)
    if ellipsis_px > max_px:
        return ""
    low, high = 0, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if _font_width(font, text[:mid]) + ellipsis_px <= max_px:
            low = mid
        else:
            high = mid - 1
    return (text[:low] + ellipsis) if low else ""


def _int_bytes(value, default=0):
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


def match_operation_token(groups, relative_path):
    """Return the longest source-row token whose path prefixes relative_path."""
    rel = str(relative_path or "").strip("/")
    matches = []
    for group in list(groups or []):
        token = group.get("token")
        base = str(group.get("path") or "").strip("/")
        if not token:
            continue
        if not base:
            matches.append((0, token))
            continue
        if not rel:
            continue
        if rel == base or rel.startswith(base + "/"):
            matches.append((len(base), token))
    if not matches:
        return None
    matches.sort(reverse=True)
    return matches[0][1]


def merge_operation_payload(previous, incoming):
    """Keep path/bytes from an earlier event when a later one omits them."""
    merged = dict(previous or {})
    merged.update(incoming or {})
    prev = previous or {}
    new = incoming or {}
    if not new.get("relativePath") and prev.get("relativePath"):
        merged["relativePath"] = prev.get("relativePath")
    if _int_bytes(new.get("bytesDone"), 0) == 0 and _int_bytes(prev.get("bytesDone"), 0):
        merged["bytesDone"] = prev.get("bytesDone")
    if _int_bytes(new.get("bytesTotal") or new.get("size"), 0) == 0:
        prev_total = prev.get("bytesTotal") or prev.get("size")
        if _int_bytes(prev_total, 0):
            merged["bytesTotal"] = prev_total
    return merged


def operation_group_copy_complete(group):
    """True when every known copy op is terminal and the folder is finished."""
    if str((group or {}).get("state") or "") == "comparing":
        return False
    ops = list(((group or {}).get("ops") or {}).values())
    if not ops:
        return bool((group or {}).get("ids_final"))
    states = [str(row.get("state") or "queued") for row in ops]
    if not all(state in _TERMINAL for state in states):
        return False
    if (group or {}).get("ids_final"):
        return True
    expected = _int_bytes((group or {}).get("expected_bytes"), 0)
    if not expected:
        return False
    probe = dict(group or {})
    probe["state"] = "active"
    return operation_group_percent(probe) >= 100


def operation_group_percent(group):
    state = str((group or {}).get("state") or "queued")
    if state == "done":
        return 100
    if state == "comparing":
        return 0
    ops = list(((group or {}).get("ops") or {}).values())
    total_done = 0
    known_bytes = 0
    fallback_ratios = []
    for row in ops:
        op_state = str(row.get("state") or "queued")
        done = _int_bytes(row.get("bytesDone"), 0)
        total = _int_bytes(row.get("bytesTotal") or row.get("size"), 0)
        if total:
            known_bytes += total
            total_done += total if op_state in _TERMINAL else min(done, total)
            continue
        fallback_ratios.append(1.0 if op_state in _TERMINAL else 0.0)
        total_done += done
    expected = _int_bytes((group or {}).get("expected_bytes"), 0)
    if expected:
        return int(round(100.0 * min(total_done, expected) / expected))
    if known_bytes:
        return int(round(100.0 * min(total_done, known_bytes) / known_bytes))
    if not fallback_ratios:
        return 0
    return int(round(100.0 * sum(fallback_ratios) / max(1, len(fallback_ratios))))


def operation_group_display_percent(group):
    """UI percent: 100 means bytes + terminal publication, not only payload bytes."""
    pct = operation_group_percent(group)
    state = str((group or {}).get("state") or "queued")
    if pct >= 100 and state in ("queued", "active", "waiting-peer", "cancel-pending"):
        return 99
    return pct


def _fmt_size(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return ""
    if n < 1024:
        return "%d B" % n
    if n < 1024 * 1024:
        return "%.1f КБ" % (n / 1024)
    if n < 1024 * 1024 * 1024:
        return "%.1f МБ" % (n / (1024 * 1024))
    return "%.2f ГБ" % (n / (1024 * 1024 * 1024))


def _fmt_mtime_ms(value):
    try:
        mtime_ms = float(value)
        if mtime_ms <= 0:
            return ""
        return datetime.fromtimestamp(mtime_ms / 1000.0).strftime("%d.%m.%y %H:%M")
    except (TypeError, ValueError, OverflowError, OSError):
        return ""


def sort_panel_entries(entries, column, descending=False):
    """Return panel entries sorted by a visible column."""
    rows = list(entries or [])

    def name_key(entry):
        return str((entry or {}).get("name") or "").casefold()

    if column == "name":
        key = lambda entry: name_key(entry)
    elif column == "type":
        type_order = {"dir": 0, "file": 1, "link": 2}
        key = lambda entry: (type_order.get(str((entry or {}).get("type") or "file"), 3), name_key(entry))
    elif column == "size":
        key = lambda entry: (_int_bytes((entry or {}).get("size"), 0), name_key(entry))
    elif column == "date":
        def date_key(entry):
            try:
                mtime = float((entry or {}).get("mtimeMs") or 0)
            except (TypeError, ValueError):
                mtime = 0.0
            return (mtime, name_key(entry))
        key = date_key
    else:
        return rows
    return sorted(rows, key=key, reverse=bool(descending))


_UP_PATH = ".."
_VIRTUAL_ROOT_PREFIX = "@root/"


def _virtual_root_entry(root):
    """Represent an exported root as a synthetic directory row in the UI only."""
    root = dict(root or {})
    root_id = str(root.get("rootId") or "")
    return {
        "type": "dir",
        "name": root.get("name") or root.get("path") or root_id,
        "relativePath": _VIRTUAL_ROOT_PREFIX + root_id,
        "mtimeMs": root.get("addedAtMs") or 0,
        "_virtualRoot": True,
        "_rootId": root_id,
    }


def _entry_root_id(entry):
    if not isinstance(entry, dict) or not entry.get("_virtualRoot"):
        return ""
    return str(entry.get("_rootId") or "")


def _iid_to_path(entries, iid):
    if iid in (None, ""):
        return None
    if str(iid) == "up":
        return _UP_PATH
    try:
        idx = int(iid)
    except (TypeError, ValueError):
        return None
    if 0 <= idx < len(entries or []):
        return str((entries[idx] or {}).get("relativePath") or "")
    return None


def capture_panel_view(entries, selected_iids, focus_iid="", yview=None, tree_has_focus=False):
    """Snapshot list selection by relative path so a reload can restore it."""
    selected = []
    seen = set()
    for iid in selected_iids or []:
        path = _iid_to_path(entries, iid)
        if path is None or path in seen:
            continue
        selected.append(path)
        seen.add(path)
    first = last = None
    if yview:
        try:
            first = float(yview[0])
            last = float(yview[1]) if len(yview) > 1 else first
        except (TypeError, ValueError, IndexError):
            first = last = None
    return {
        "selected": selected,
        "focus": _iid_to_path(entries, focus_iid),
        "had_focus": bool(tree_has_focus),
        "yview": (first, last) if first is not None else None,
    }


def resolve_panel_view(entries, snapshot):
    """Map a captured view back onto the current listing (indices may shift)."""
    if not snapshot:
        return None
    path_to_iid = {_UP_PATH: "up"}
    for idx, entry in enumerate(entries or []):
        path_to_iid[str((entry or {}).get("relativePath") or "")] = str(idx)
    selected = []
    seen = set()
    for path in snapshot.get("selected") or []:
        iid = path_to_iid.get(_UP_PATH if path == _UP_PATH else str(path))
        if iid is None or iid in seen:
            continue
        selected.append(iid)
        seen.add(iid)
    focus_path = snapshot.get("focus")
    focus_iid = None
    if focus_path is not None:
        focus_iid = path_to_iid.get(_UP_PATH if focus_path == _UP_PATH else str(focus_path))
    if focus_iid is None and selected:
        focus_iid = selected[0]
    return {
        "selected": selected,
        "focus": focus_iid,
        "had_focus": bool(snapshot.get("had_focus")),
        "yview": snapshot.get("yview"),
    }


class PathBar(tk.Canvas):
    """Full-width rounded path surface with access status on the right."""

    def __init__(self, parent, path_var, access_var):
        super().__init__(parent, height=30, bd=0, highlightthickness=0, takefocus=0)
        self.path_var = path_var
        self.access_var = access_var
        self.path_var.trace_add("write", lambda *_: self._redraw())
        self.access_var.trace_add("write", lambda *_: self._redraw())
        self.bind("<Configure>", lambda _e: self._redraw())
        self._draw_signature = None
        self.apply_theme()

    def apply_theme(self):
        self.configure(background=ui_theme.color("SURFACE"))
        # Colors are part of the skip-redraw signature, so a theme switch has to
        # invalidate it or the bar keeps its old palette until it is resized.
        self._draw_signature = None
        self._redraw()

    def _rounded_polygon(self, x1, y1, x2, y2, radius):
        r = max(2, min(radius, (y2 - y1) // 2))
        return [
            x1+r, y1, x2-r, y1, x2, y1, x2, y1+r,
            x2, y2-r, x2, y2, x2-r, y2, x1+r, y2,
            x1, y2, x1, y2-r, x1, y1+r, x1, y1,
        ]

    def _redraw(self):
        try:
            if not self.winfo_exists():
                return
            width = max(20, int(self.winfo_width()))
            height = max(26, int(self.winfo_height()))
        except tk.TclError:
            return
        # A sash or window drag delivers <Configure> on every pointer move even
        # when this bar only translated.  Rebuilding the rounded polygon and
        # re-measuring both labels for nothing is what made the path bar shimmer.
        signature = (width, height, str(self.path_var.get()), str(self.access_var.get()))
        if signature == self._draw_signature:
            return
        self._draw_signature = signature
        self.delete("all")
        self.create_polygon(
            self._rounded_polygon(1, 1, width-2, height-2, 5),
            smooth=True, splinesteps=24,
            fill=ui_theme.color("FIELD"),
            outline=ui_theme.color("BORDER"),
            width=1,
        )
        path = str(self.path_var.get() or "/")
        access = str(self.access_var.get() or "")
        pad = 10
        inner = max(0, width - pad * 2)
        # Both labels share the bar.  Canvas text is not clipped, so a long path
        # used to run straight through the access label and past the rounded
        # edge; measure the access side first, then fit the path into the rest.
        access_px = 0
        if access:
            font = _measured_font(self, design.UI_FONT)
            access_px = _font_width(font, access)
            access = fit_canvas_text(self, access, design.UI_FONT, max(0, inner // 2))
        gap = 8 if access else 0
        path = fit_canvas_text(self, path, design.UI_FONT, max(0, inner - access_px - gap))
        if path:
            self.create_text(pad, height//2, text=path, anchor="w",
                             fill=ui_theme.color("INK"), font=design.UI_FONT)
        if access:
            self.create_text(width-pad, height//2, text=access, anchor="e",
                             fill=ui_theme.color("MUTED"), font=design.UI_FONT)


class FilePanel(AppCard):
    def __init__(
        self,
        parent,
        bridge,
        is_local,
        on_status=None,
        on_add_folder=None,
        on_remove_folder=None,
        on_permissions=None,
        on_show_chat=None,
        on_state_change=None,
        on_rename_peer=None,
        on_refresh_roots=None,
    ):
        super().__init__(parent)
        self.bridge = bridge
        self.is_local = is_local
        self.on_status = on_status
        self.on_state_change = on_state_change
        self.on_rename_peer = on_rename_peer
        self.on_refresh_roots = on_refresh_roots
        self.peer_id = None
        self.peer_name = None
        self._device_name = None
        self._name_entry = None
        self.access_peer_id = None
        self.access_peer_name = None
        self.roots = []
        self.root_id = ""
        self.rel = ""
        self.entries = []
        self._entry_iid_by_path = {}
        self._loading = False
        self._generation = 0
        self._list_error_shown = False
        self._pending_view = None
        self._incoming_entries = None  # legacy compatibility
        self._list_pages = []
        self._previous_cursor = None
        self._next_cursor = None
        self._list_target = None
        self._list_total_entries = 0
        self._page_request_in_flight = False
        self._page_request_direction = None
        self._chat_active = False
        self._chat_unread = False
        self._sort_column = None
        self._sort_desc = False
        # Non-zero only while reopening a persisted location. Listing errors
        # then degrade from subdirectory -> root -> overview exactly once.
        self._restore_fallback_stage = 0

        self._caption = AppFrame(self, surface="surface")
        self._caption_label = AppLabel(self._caption, variant="surface_section")
        self._caption_label.pack(side="left")
        self._caption_full_text = ""
        self.configure(text="", labelwidget=self._caption)
        self._set_caption_text(t("this_pc") if is_local else t("pick_peer"))
        if not is_local:
            self._caption_label.configure(cursor="hand2")
            self._caption_label.bind("<Button-1>", self._begin_rename)
            ToolTip(self._caption_label, t("tip_rename_peer"))

        # Per-source-row operation state. The transfer itself remains in Core;
        # this only paints its progress over the source row.
        self._operation_seq = 0
        self._operation_groups = {}
        self._operation_by_id = {}
        self._active_operation_by_path = {}
        self._operation_overlays = {}
        self._overlay_after = None

        selector = AppFrame(self, surface="surface")
        selector.pack(fill="x", pady=(2, 6))
        selector.columnconfigure(1, weight=1)
        AppLabel(selector, text=t("folder") + ":", variant="surface_muted").grid(
            row=0, column=0, sticky="w", padx=(0, 6)
        )
        self.root_var = tk.StringVar()
        self.root_box = AppComboBox(selector, textvariable=self.root_var, state="readonly", width=12)
        self.root_box.grid(row=0, column=1, sticky="ew")
        self.root_box.bind("<<ComboboxSelected>>", self._on_root)
        self.root_box.bind("<Button-1>", self._block_empty_combo)
        self.root_box.bind("<Down>", self._block_empty_combo)
        ToolTip(self.root_box, t("tip_folder_box"))

        actions = AppFrame(selector, surface="surface")
        actions.grid(row=0, column=2, sticky="e", padx=(6, 0))
        self._icon_images = {}
        self._add_btn = None
        self._remove_btn = None
        self._access_btn = None
        self._refresh_btn = AppButton(
            actions,
            text="↻",
            variant="icon",
            width=3,
            command=self.request_refresh,
            takefocus=False,
        )
        self._refresh_btn.pack(side="left")
        ToolTip(self._refresh_btn, t("tip_refresh"))
        if is_local and on_add_folder:
            self._add_btn = AppButton(
                actions,
                text="",
                variant="icon",
                width=3,
                command=on_add_folder,
            )
            self._add_btn.pack(side="left", padx=(4, 0))
            ToolTip(self._add_btn, t("tip_add_folder"))
        if is_local and on_remove_folder:
            self._remove_btn = AppButton(
                actions,
                text="",
                variant="icon",
                width=3,
                command=on_remove_folder,
            )
            self._remove_btn.pack(side="left", padx=(4, 0))
            ToolTip(self._remove_btn, t("tip_remove_folder"))
        if is_local and on_permissions:
            self._access_btn = AppButton(
                actions,
                text="",
                variant="icon",
                width=3,
                command=on_permissions,
            )
            self._access_btn.pack(side="left", padx=(4, 0))
            ToolTip(self._access_btn, t("tip_folder_access"))

        self._show_chat_btn = None
        self._show_chat_tip = None
        if on_show_chat:
            self._show_chat_btn = AppButton(
                actions,
                text="",
                variant="toggle_off",
                width=3,
                command=on_show_chat,
            )
            self._show_chat_btn.pack(side="right", padx=(4, 0))
            self._show_chat_tip = ToolTip(self._show_chat_btn, t("tip_chat"))

        # The folder row cannot compress on its own: grid keeps every control at
        # its requested width, so a narrow pane pushed the combo and the action
        # buttons straight through the sash into the neighbouring panel.  Track
        # the optional buttons in drop order and hide the least important first.
        self._optional_action_buttons = [
            btn for btn in (self._access_btn, self._remove_btn, self._add_btn) if btn is not None
        ]
        self._actions_frame = actions
        self._folder_label = selector.grid_slaves(row=0, column=0)[0]
        self._hidden_action_buttons = 0
        self.bind("<Configure>", self._schedule_selector_fit)
        self._selector_after = None

        self.path_var = tk.StringVar(value="/")
        self.access_var = tk.StringVar(value="")
        self.path_bar = PathBar(self, self.path_var, self.access_var)
        self.path_bar.pack(fill="x", pady=(1, 5))

        self.footer = AppFrame(self, surface="surface")
        self.footer.pack(side="bottom", fill="x", pady=(7, 2))

        cols = ("name", "type", "size", "date")
        body = AppFrame(self, surface="surface")
        body.pack(fill="both", expand=True)
        self.tree = AppTree(body, columns=cols, show="headings", selectmode="extended")
        self._refresh_sort_headings()
        self.tree.column("name", width=190, minwidth=110, stretch=True)
        self.tree.column("type", width=72, minwidth=64, stretch=False)
        self.tree.column("size", width=96, minwidth=82, stretch=False, anchor="e")
        self.tree.column("date", width=118, minwidth=112, stretch=False, anchor="e")
        self._vsb = AppScrollbar(body, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=self._tree_scroll_changed)
        self.tree.pack(side="left", fill="both", expand=True)
        self._vsb.pack(side="right", fill="y")
        self.tree.bind("<Double-1>", self._on_open)
        self.tree.bind("<Return>", self._on_open)
        self.tree.bind("<<TreeviewSelect>>", self._on_tree_selection)
        self.tree.bind("<Configure>", lambda _e: self._schedule_overlay_layout())
        self.tree.bind("<Expose>", lambda _e: self._schedule_overlay_layout())
        self.tree.tag_configure("hint", foreground=ui_theme.color("MUTED"))
        self.tree.tag_configure("error", foreground=ui_theme.color("DANGER"))

        self._show_root_placeholder()
        self._update_access_text()
        self._update_toolbar_state()
        self.apply_theme(ui_theme.is_dark_theme(self.winfo_toplevel()))

    def _schedule_selector_fit(self, _evt=None):
        """Re-fit the folder row after a resize, coalescing bursts."""
        if self._selector_after is not None:
            return
        try:
            self._selector_after = self.after_idle(self._fit_selector_row)
        except tk.TclError:
            self._selector_after = None

    def _fit_selector_row(self):
        """Drop optional folder controls before the row can overlap a neighbour.

        ``grid`` never shrinks a child below its requested width, so a pane
        narrower than the folder row pushed the combo and the action buttons
        past the card border and across the sash.  Hide the optional buttons in
        reverse importance order, then the caption, and restore everything as
        soon as there is room again.
        """
        self._selector_after = None
        available = int(self.winfo_width())
        if available <= 0:
            return
        try:
            base = int(self._folder_label.winfo_reqwidth()) + int(self.root_box.winfo_reqwidth())
            # The refresh button and the chat toggle always stay.
            always = int(self._refresh_btn.winfo_reqwidth())
            if self._show_chat_btn is not None:
                always += int(self._show_chat_btn.winfo_reqwidth()) + 4
        except tk.TclError:
            return

        hidden = 0
        budget = available - base - always - 12
        for button in reversed(self._optional_action_buttons):
            try:
                need = int(button.winfo_reqwidth()) + 4
            except tk.TclError:
                break
            if budget >= need:
                break
            hidden += 1
            budget += need
        total = len(self._optional_action_buttons)
        for index, button in enumerate(self._optional_action_buttons):
            should_hide = index >= total - hidden
            try:
                if should_hide and button.winfo_manager():
                    button.pack_forget()
                elif not should_hide and not button.winfo_manager():
                    button.pack(side="left", padx=(4, 0))
            except tk.TclError:
                continue
        self._hidden_action_buttons = hidden

        # Last resort: the "Папка:" caption gives up so the combo stays usable.
        try:
            show_caption = available - int(self._folder_label.winfo_reqwidth()) - always - 12 >= 0
            caption = self._folder_label
            if not show_caption and caption.winfo_manager():
                caption.grid_remove()
            elif show_caption and not caption.winfo_manager():
                caption.grid()
        except tk.TclError:
            pass

        # The card caption is re-measured on every resize for the same reason:
        # a long peer name would otherwise paint over the neighbouring pane.
        self._apply_caption_text()

    def minimum_content_width(self):
        """Width below which the folder row can no longer show every control."""
        try:
            required = int(self._folder_label.winfo_reqwidth()) + int(self.root_box.winfo_reqwidth())
            required += sum(int(b.winfo_reqwidth()) + 4 for b in self._optional_action_buttons)
            required += int(self._refresh_btn.winfo_reqwidth())
            if self._show_chat_btn is not None:
                required += int(self._show_chat_btn.winfo_reqwidth()) + 4
            return required + 12
        except tk.TclError:
            return SELECTOR_MIN_WIDTH

    def apply_theme(self, dark=False):
        try:
            self.path_bar.apply_theme()
            self.tree.tag_configure("hint", foreground=ui_theme.color("MUTED"))
            self.tree.tag_configure("error", foreground=ui_theme.color("DANGER"))
            specs = [
                ("add", self._add_btn, "folder_add"),
                ("remove", self._remove_btn, "folder_remove"),
                ("access", self._access_btn, "sliders"),
                ("chat", self._show_chat_btn, "chat"),
            ]
            for key, button, asset in specs:
                if button is None:
                    continue
                normal, disabled, spec = load_button_icon(self, asset, dark=bool(dark))
                self._icon_images[key] = (normal, disabled)
                button.configure(image=spec, text="")
            self._schedule_overlay_layout()
        except (tk.TclError, OSError):
            pass

    # ---------- table sorting ----------
    def _refresh_sort_headings(self):
        labels = {"name": "Имя", "type": "Тип", "size": "Размер", "date": "Дата"}
        for column, label in labels.items():
            marker = ""
            if self._sort_column == column:
                marker = " ▼" if self._sort_desc else " ▲"
            self.tree.heading(
                column,
                text=label + marker,
                command=lambda col=column: self._sort_by_column(col),
            )

    def _sort_by_column(self, column):
        if self._sort_column == column:
            self._sort_desc = not self._sort_desc
        else:
            self._sort_column = column
            self._sort_desc = False
        self._refresh_sort_headings()
        # Sorting is part of the Core LIST snapshot contract. Re-open the
        # directory with the requested order instead of loading tens of
        # thousands of rows into Tk just to sort them client-side.
        self.refresh(preserve_view=True)

    def _apply_active_sort(self):
        if self._sort_column:
            self.entries = sort_panel_entries(self.entries, self._sort_column, self._sort_desc)

    # ---------- chat toggle ----------
    def set_chat_active(self, active):
        self._chat_active = bool(active)
        if self._chat_active:
            self._chat_unread = False
        if self._show_chat_btn is None:
            return
        try:
            self._show_chat_btn.configure(
                variant="toggle_on" if self._chat_active else "toggle_off",
                badge=self._chat_unread,
            )
            if self._show_chat_tip is not None:
                self._show_chat_tip.text = "Скрыть чат" if self._chat_active else "Открыть чат"
        except tk.TclError:
            pass

    def set_chat_unread(self, unread):
        if self._show_chat_btn is None:
            return
        self._chat_unread = bool(unread) and not self._chat_active
        try:
            self._show_chat_btn.configure(badge=self._chat_unread)
            if self._chat_unread:
                self._show_chat_btn.update_idletasks()
        except tk.TclError:
            pass

    def set_show_chat_visible(self, visible):
        """Used only by narrow mode; wide mode keeps the toggle visible."""
        if self._show_chat_btn is None:
            return
        try:
            mapped = bool(self._show_chat_btn.winfo_manager())
            if visible and not mapped:
                self._show_chat_btn.pack(side="right", padx=(4, 0) if self.is_local else 0)
            elif not visible and mapped:
                self._show_chat_btn.pack_forget()
        except tk.TclError:
            pass

    # ---------- row progress ----------
    def begin_row_operation(self, entry, label, expected_bytes=0, expected_files=0):
        path = str((entry or {}).get("relativePath") or self.rel or "")
        self._operation_seq += 1
        token = "%s:%d" % ("L" if self.is_local else "R", self._operation_seq)
        group = {
            "token": token,
            "path": path,
            "entry": dict(entry or {}),
            "label": str(label or ""),
            "ops": {},
            "state": "queued",
            "ids_final": False,
            "expected_bytes": _int_bytes(expected_bytes, 0),
            "expected_files": _int_bytes(expected_files, 0),
            "compare_files": 0,
            "compare_phase": "",
            "cleanup_after": None,
            "hold_cleanup": False,
        }
        old = self._active_operation_by_path.get(path)
        if old and old in self._operation_groups:
            self._clear_row_operation(old)
        self._operation_groups[token] = group
        self._active_operation_by_path[path] = token
        self._schedule_overlay_layout()
        return token

    def set_compare_progress(self, token, files_done=0, phase=""):
        group = self._operation_groups.get(token or "")
        if not group:
            return
        self._cancel_group_cleanup(group)
        group["state"] = "comparing"
        group["label"] = t("sync_comparing")
        group["compare_files"] = _int_bytes(files_done, 0)
        group["compare_phase"] = str(phase or "")
        self._schedule_overlay_layout()

    def prepare_copy_progress(self, token, expected_bytes=0, expected_files=0):
        group = self._operation_groups.get(token or "")
        if not group:
            return
        self._cancel_group_cleanup(group)
        group["label"] = t("syncing")
        group["state"] = "queued"
        group["ids_final"] = False
        group["expected_bytes"] = _int_bytes(expected_bytes, 0)
        group["expected_files"] = _int_bytes(expected_files, 0)
        group["compare_files"] = 0
        group["compare_phase"] = ""
        self._schedule_overlay_layout()

    def clear_row_operation(self, token):
        self._clear_row_operation(token)

    def active_folder_operation_entry(self):
        for path, token in list(self._active_operation_by_path.items()):
            group = self._operation_groups.get(token)
            if not group:
                continue
            entry = dict(group.get("entry") or {})
            rel = str(entry.get("relativePath") or path or "").replace("\\", "/").strip("/")
            if not rel:
                continue
            entry["type"] = "dir"
            entry["relativePath"] = rel
            if not entry.get("name"):
                entry["name"] = rel.rsplit("/", 1)[-1]
            return entry
        return None

    def bind_operation_id(self, token, operation_id):
        group = self._operation_groups.get(token)
        op_id = str(operation_id or "")
        if not group or not op_id:
            return False
        self._cancel_group_cleanup(group)
        self._operation_by_id[op_id] = token
        group["ops"].setdefault(op_id, {"state": "queued", "bytesDone": 0, "bytesTotal": 0})
        self._schedule_overlay_layout()
        return True

    def operation_group(self, token):
        return self._operation_groups.get(token or "")

    def mark_operations_final(self, token):
        group = self._operation_groups.get(token or "")
        if not group:
            return
        group["ids_final"] = True
        self._recalculate_group(group)
        self._schedule_overlay_layout()

    def operation_token_for_path(self, relative_path):
        return match_operation_token(
            [{"token": token, "path": path} for path, token in self._active_operation_by_path.items()],
            relative_path,
        )

    def selected_operation_tokens(self):
        tokens = []
        for entry in self.selected_entries():
            token = self.operation_token_for_path((entry or {}).get("relativePath") or "")
            if token and token not in tokens:
                tokens.append(token)
        return tokens

    def update_operation(self, operation_id, payload):
        op_id = str(operation_id or "")
        token = self._operation_by_id.get(op_id)
        group = self._operation_groups.get(token or "")
        if not group:
            return False
        row = group["ops"].setdefault(op_id, {})
        row.update(payload or {})
        self._recalculate_group(group)
        self._schedule_overlay_layout()
        return True

    def update_batch_progress(self, token, completed, total, done=False):
        group = self._operation_groups.get(token or "")
        if not group:
            return
        self._cancel_group_cleanup(group)
        completed = max(0, _int_bytes(completed, 0))
        total = max(1, _int_bytes(total, 1))
        group["ids_final"] = bool(done)
        # Compact-mode rendering replaces per-operation rows with one synthetic
        # row. Remove the reverse routes first; otherwise real operation IDs
        # remain forever mapped to a group that no longer owns them.
        for op_id in list(group.get("ops") or {}):
            if op_id != "__batch__" and self._operation_by_id.get(op_id) == token:
                self._operation_by_id.pop(op_id, None)
        group["ops"] = {
            "__batch__": {
                "state": "done" if done else "active",
                "bytesDone": min(completed, total),
                "bytesTotal": total,
            }
        }
        group["state"] = "done" if done else "active"
        if done:
            self._schedule_group_cleanup(group, _DONE_HOLD_MS)
        self._schedule_overlay_layout()

    def complete_row_operation(self, token):
        group = self._operation_groups.get(token or "")
        if not group:
            return
        group["state"] = "done"
        self._schedule_group_cleanup(group, _DONE_HOLD_MS)
        self._schedule_overlay_layout()

    def set_operation_cleanup_hold(self, token, hold):
        """Keep a terminal row visible until its durable Core batch converges."""
        group = self._operation_groups.get(token or "")
        if not group:
            return
        group["hold_cleanup"] = bool(hold)
        if group.get("hold_cleanup"):
            self._cancel_group_cleanup(group)
            return
        state = str(group.get("state") or "")
        if state == "done":
            self._schedule_group_cleanup(group, _DONE_HOLD_MS)
        elif state == "failed":
            self._schedule_group_cleanup(group, _FAIL_HOLD_MS)
        elif state == "cancelled":
            self._schedule_group_cleanup(group, _CANCEL_HOLD_MS)

    def fail_row_operation(self, token, message=""):
        group = self._operation_groups.get(token or "")
        if not group:
            return
        group["state"] = "failed"
        group["error"] = str(message or "")
        self._schedule_group_cleanup(group, _FAIL_HOLD_MS)
        self._schedule_overlay_layout()

    def _cancel_group_cleanup(self, group):
        after_id = group.get("cleanup_after")
        if after_id is None:
            return
        try:
            self.after_cancel(after_id)
        except tk.TclError:
            pass
        group["cleanup_after"] = None

    def _schedule_group_cleanup(self, group, delay_ms):
        if group.get("hold_cleanup"):
            return
        if group.get("cleanup_after") is not None:
            return
        token = group.get("token")
        try:
            group["cleanup_after"] = self.after(delay_ms, self._clear_row_operation, token)
        except tk.TclError:
            pass

    def _clear_row_operation(self, token):
        group = self._operation_groups.pop(token or "", None)
        if not group:
            return
        self._cancel_group_cleanup(group)
        path = group.get("path")
        if self._active_operation_by_path.get(path) == token:
            self._active_operation_by_path.pop(path, None)
        for op_id in list(group.get("ops") or {}):
            if self._operation_by_id.get(op_id) == token:
                self._operation_by_id.pop(op_id, None)
        canvas = self._operation_overlays.pop(token, None)
        if canvas is not None:
            try:
                canvas.destroy()
            except tk.TclError:
                pass
        self._schedule_overlay_layout()

    def _recalculate_group(self, group):
        if str(group.get("state") or "") == "comparing" and not (group.get("ops") or {}):
            return
        ops = list((group.get("ops") or {}).values())
        if not ops:
            if str(group.get("state") or "") == "comparing":
                return
            group["state"] = "queued"
            return
        states = [str(row.get("state") or "queued") for row in ops]
        all_terminal = all(state in _TERMINAL for state in states)
        if all_terminal and not operation_group_copy_complete(group):
            group["state"] = "active"
            self._cancel_group_cleanup(group)
            return
        if all_terminal:
            if any(state in ("failed", "stale") for state in states):
                state = "failed"
                delay = _FAIL_HOLD_MS
            elif any(state == "cancelled" for state in states):
                state = "cancelled"
                delay = _CANCEL_HOLD_MS
            else:
                state = "done"
                delay = _DONE_HOLD_MS
            group["state"] = state
            self._schedule_group_cleanup(group, delay)
            return
        self._cancel_group_cleanup(group)
        if any(state == "active" for state in states):
            group["state"] = "active"
        elif any(state in ("waiting-peer", "cancel-pending") for state in states):
            group["state"] = "waiting-peer"
        elif any(state == "finalizing" for state in states):
            group["state"] = "finalizing"
        else:
            group["state"] = "queued"

    def _group_percent(self, group):
        return operation_group_display_percent(group)

    def _operation_status_text(self, group):
        state = str(group.get("state") or "queued")
        if state == "done":
            return "Готово"
        if state == "failed":
            return "Ошибка"
        if state == "cancelled":
            return "Отменено"
        if state == "waiting-peer":
            return "Ожидание"
        if state == "finalizing":
            return "Завершение"
        if state == "comparing":
            return t("sync_comparing")
        if state == "queued":
            return "В очереди"
        return str(group.get("label") or "Операция")

    def _tree_scroll_changed(self, first, last):
        try:
            self._vsb.set(first, last)
            try:
                first_f = float(first)
                last_f = float(last)
            except (TypeError, ValueError):
                first_f, last_f = 0.0, 1.0
            if last_f >= 0.86 and self._next_cursor and not self._page_request_in_flight:
                self.after_idle(self._load_next_page)
            elif first_f <= 0.14 and self._previous_cursor and not self._page_request_in_flight:
                self.after_idle(self._load_previous_page)
        finally:
            self._schedule_overlay_layout()

    def _schedule_overlay_layout(self):
        if self._overlay_after is not None:
            return
        try:
            self._overlay_after = self.after_idle(self._layout_operation_overlays)
        except tk.TclError:
            self._overlay_after = None

    def _iid_for_path(self, path):
        iid = self._entry_iid_by_path.get(str(path or ""))
        if iid and self.tree.exists(iid):
            return iid
        return None

    def _fit_overlay_text(self, text, spec, max_px):
        """Shorten text until the real glyphs fit inside max_px."""
        return fit_canvas_text(self, text, spec, max_px)

    def _row_column_boxes(self, iid, width, origin_x=0):
        """Real on-screen x/width per column, in overlay-canvas coordinates.

        ``column -width`` reports the *requested* width, not what Treeview
        actually drew: the name column stretches and every cell is inset by the
        widget border.  Deriving the overlay layout from those numbers shifts
        the whole row a few pixels and, in a narrow window, pushes the date
        text past the canvas edge where it paints over the neighbouring
        column.  Ask the widget instead and clamp every box to the row.
        """
        boxes = []
        for column in _OVERLAY_COLUMNS:
            try:
                cell = self.tree.bbox(iid, column)
            except tk.TclError:
                cell = ()
            if cell and len(cell) >= 4:
                x = int(cell[0]) - origin_x
                cell_width = int(cell[2])
            else:
                x = sum(b[0] + b[1] for b in boxes)
                cell_width = int(self.tree.column(column, "width"))
            x = max(0, min(x, width))
            boxes.append((x, max(0, min(cell_width, width - x))))
        return boxes

    def _overlay_row_geometry(self, iid):
        """Keep the progress canvas inside the painted cells, not the card frame.

        ttk.Treeview does not clip child widgets.  A canvas as wide as
        ``winfo_width()`` therefore paints over the 1px inner border and onto
        the surrounding card.  Real cell boxes already sit inside that border.
        """
        try:
            first = self.tree.bbox(iid, _OVERLAY_COLUMNS[0])
            last = self.tree.bbox(iid, _OVERLAY_COLUMNS[-1])
            row = self.tree.bbox(iid) or first
        except tk.TclError:
            return None
        if not first or not last or not row:
            return None
        tree_width = int(self.tree.winfo_width())
        tree_height = int(self.tree.winfo_height())
        x = max(1, int(first[0]))
        right = min(tree_width - 1, int(last[0]) + int(last[2]))
        y = int(row[1])
        height = int(row[3])
        width = right - x
        top = max(0, y)
        bottom = min(y + height, tree_height)
        visible_height = bottom - top
        if width <= 2 or visible_height <= 2:
            return None
        return x, top, width, visible_height

    def _hide_operation_overlay(self, token):
        """Drop a stale overlay so it cannot keep painting over its old row."""
        canvas = self._operation_overlays.get(token)
        if canvas is None:
            return
        try:
            canvas.place_forget()
        except tk.TclError:
            pass

    def _layout_operation_overlays(self):
        self._overlay_after = None
        live = set()
        for path, token in list(self._active_operation_by_path.items()):
            group = self._operation_groups.get(token)
            iid = self._iid_for_path(path)
            if not group or not iid:
                self._hide_operation_overlay(token)
                continue
            geometry = self._overlay_row_geometry(iid)
            if geometry is None:
                self._hide_operation_overlay(token)
                continue
            x, top, width, visible_height = geometry
            canvas = self._operation_overlays.get(token)
            if canvas is None:
                canvas = tk.Canvas(
                    self.tree,
                    bd=0,
                    highlightthickness=0,
                    relief="flat",
                    takefocus=0,
                    background=ui_theme.color("FIELD"),
                )
                canvas.bind("<Button-1>", lambda event, tok=token: self._select_operation_row(tok, event))
                canvas.bind("<Double-1>", lambda _e, tok=token: self._open_operation_row(tok))
                canvas.bind("<MouseWheel>", self._overlay_mousewheel)
                canvas.bind("<Button-4>", self._overlay_mousewheel)
                canvas.bind("<Button-5>", self._overlay_mousewheel)
                self._operation_overlays[token] = canvas
            canvas.place(x=x, y=top, width=width, height=visible_height)
            canvas.tk.call("raise", str(canvas))
            self._draw_operation_overlay(canvas, group, iid, x, width, visible_height)
            live.add(token)
        for token, canvas in list(self._operation_overlays.items()):
            if token not in live:
                try:
                    canvas.place_forget()
                except tk.TclError:
                    pass

    def _draw_operation_overlay(self, canvas, group, iid, origin_x, width, height):
        canvas.delete("all")
        selected = iid in set(self.tree.selection())
        base = ui_theme.color("ACCENT_SOFT") if selected else ui_theme.color("FIELD")
        state = str(group.get("state") or "queued")
        if state == "done":
            fill = ui_theme.color("PROGRESS_DONE")
        elif state in ("failed", "cancelled"):
            fill = ui_theme.color("PROGRESS_FAILED")
        elif state == "waiting-peer":
            fill = ui_theme.color("PROGRESS_WAITING")
        else:
            fill = ui_theme.color("PROGRESS_FILL")
        pct = self._group_percent(group)
        canvas.configure(background=base)
        canvas.create_rectangle(0, 0, width, height, fill=base, outline="")
        fill_width = int(round(width * max(0, min(100, pct)) / 100.0))
        if fill_width > 0:
            canvas.create_rectangle(0, 0, fill_width, height, fill=fill, outline="")
        canvas.create_line(0, height - 1, width, height - 1, fill=ui_theme.color("BORDER"))

        # Column separators follow the real Treeview cells, so the progress row
        # lines up with the headings and the rows above and below it.
        boxes = self._row_column_boxes(iid, width, origin_x)
        (name_x, name_w), (type_x, type_w), (size_x, size_w), (date_x, date_w) = boxes
        for edge_x in (type_x, size_x, date_x):
            if 0 < edge_x < width:
                canvas.create_line(edge_x, 0, edge_x, height, fill=ui_theme.color("BORDER"))

        entry = group.get("entry") or {}
        # Canvas text is never clipped to a cell, so every label is measured
        # against its own column and shortened to fit.  A fixed pixels-per-char
        # guess overflowed on wide glyphs and painted over the next column.
        name = self._fit_overlay_text(
            str(entry.get("name") or group.get("path") or ""),
            design.UI_FONT,
            max(0, name_w - 16),
        )
        label = str(group.get("label") or "Операция")
        status = self._operation_status_text(group)
        if state == "comparing":
            middle = "Сравн."
            files_done = _int_bytes(group.get("compare_files"), 0)
            right = str(files_done) if files_done else "…"
        elif state in ("active", "queued"):
            lower = label.lower()
            if lower.startswith("коп"):
                middle = "Копир."
            elif lower.startswith("син"):
                middle = "Синхр."
            else:
                middle = "Опер."
            right = "%d%%" % pct
        else:
            middle = {"Ожидание": "Ожид.", "Завершение": "Финиш"}.get(status, status)
            right = "%d%%" % pct if state not in ("failed", "cancelled") else status

        pad = 8
        mid_y = height // 2
        middle = self._fit_overlay_text(middle, design.TINY_FONT, max(0, type_w - pad))
        right = self._fit_overlay_text(right, design.UI_FONT_SEMIBOLD, max(0, size_w - pad * 2))
        date_text = self._fit_overlay_text(
            _fmt_mtime_ms(entry.get("mtimeMs")), design.TINY_FONT, max(0, date_w - pad * 2)
        )

        if name:
            canvas.create_text(name_x + pad, mid_y, text=name, anchor="w",
                               fill=ui_theme.color("INK"), font=design.UI_FONT)
        if middle:
            canvas.create_text(type_x + type_w // 2, mid_y, text=middle, anchor="center",
                               fill=ui_theme.color("INK"), font=design.TINY_FONT)
        if right:
            canvas.create_text(size_x + size_w - pad, mid_y, text=right, anchor="e",
                               fill=ui_theme.color("INK"), font=design.UI_FONT_SEMIBOLD)
        if date_text:
            canvas.create_text(date_x + date_w - pad, mid_y, text=date_text, anchor="e",
                               fill=ui_theme.color("INK"), font=design.TINY_FONT)

    def _select_operation_row(self, token, event=None):
        group = self._operation_groups.get(token)
        iid = self._iid_for_path((group or {}).get("path"))
        if not iid:
            return "break"
        try:
            state = int(getattr(event, "state", 0) or 0) if event is not None else 0
            selected = set(self.tree.selection())
            if state & 0x0004:
                if iid in selected:
                    selected.discard(iid)
                else:
                    selected.add(iid)
                self.tree.selection_set(*selected)
            else:
                self.tree.selection_set(iid)
            self.tree.focus(iid)
            self.tree.focus_set()
            self._notify_state()
            self._schedule_overlay_layout()
        except tk.TclError:
            pass
        return "break"

    def _open_operation_row(self, token):
        self._select_operation_row(token)
        self._on_open()
        return "break"

    def _overlay_mousewheel(self, event):
        try:
            if getattr(event, "num", None) == 4:
                self.tree.yview_scroll(-1, "units")
            elif getattr(event, "num", None) == 5:
                self.tree.yview_scroll(1, "units")
            else:
                delta = int(getattr(event, "delta", 0) or 0)
                if delta:
                    self.tree.yview_scroll(-1 if delta > 0 else 1, "units")
        except tk.TclError:
            pass
        self._schedule_overlay_layout()
        return "break"

    # ---------- roots / browsing ----------
    def set_access_peer(self, peer_id, name=None):
        self.access_peer_id = str(peer_id or "").lower() or None
        self.access_peer_name = name or (self.access_peer_id[:12] if self.access_peer_id else None)
        self._update_access_text()
        self._update_toolbar_state()
        self._notify_state()

    def current_root(self):
        for root in self.roots:
            if root.get("rootId") == self.root_id:
                return root
        return None

    def is_virtual_root_view(self):
        return bool(self.roots) and not self.root_id

    def selected_virtual_root(self):
        if not self.is_virtual_root_view():
            return None
        selected = self.selected_entries()
        if len(selected) != 1:
            return None
        root_id = _entry_root_id(selected[0])
        if not root_id:
            return None
        for root in self.roots:
            if str(root.get("rootId") or "") == root_id:
                return root
        return None

    def action_root(self):
        """Concrete root used by ACL/remove/destination actions.

        In the synthetic overview there is no current root, so a single selected
        root row becomes the action target without navigating into it first.
        """
        return self.current_root() or self.selected_virtual_root()

    def effective_target(self):
        root = self.action_root()
        return {
            "peerId": None if self.is_local else self.peer_id,
            "rootId": str((root or {}).get("rootId") or ""),
            "relativePath": self.rel if self.root_id else "",
        }

    def can_copy_source(self):
        # A synthetic root row is an endpoint selector, not a filesystem path.
        # Whole-root transfer is exposed through Sync, which has root-to-root
        # semantics and does not accidentally flatten the directory name.
        return bool(self.selected_entries()) and not self.is_virtual_root_view()

    def sync_source_entries(self):
        if not self.is_virtual_root_view():
            return list(self.selected_entries() or [])
        root = self.selected_virtual_root()
        if not root:
            return list(self.selected_entries() or [])
        return [{
            "type": "dir",
            "relativePath": "",
            "name": root.get("name") or root.get("rootId") or "/",
            "_rootId": root.get("rootId"),
        }]

    def remote_write_allowed(self):
        if self.is_local:
            return bool(self.action_root())
        root = self.action_root() or {}
        return bool((root.get("perms") or {}).get("write"))

    def is_loading(self):
        return self._loading

    def _invalidate(self):
        self._generation += 1
        self._loading = False
        # A response from the previous generation may never reach the normal
        # callback path (peer/root switch, refresh, disconnect). Never let its
        # in-flight marker block paging in the new generation.
        self._page_request_in_flight = False
        self._page_request_direction = None
        return self._generation

    def set_peer(self, peer_id, name=None, device_name=None):
        changed = peer_id != self.peer_id
        self.peer_id = peer_id
        self.peer_name = name
        self._device_name = device_name if device_name is not None else name
        if self.is_local:
            self._set_caption_text(t("this_pc"))
        else:
            self._set_caption_text(name or ((peer_id[:12] + "…") if peer_id else t("pick_peer")))
        if not changed:
            return
        self.rel = ""
        self._invalidate()
        if self.is_local:
            self.refresh()
        else:
            self.roots = []
            self.root_id = ""
            self.root_var.set("")
            self.root_box["values"] = []
            self._show_root_placeholder()
            self.entries = []
            self._render_initial(False)
        self._update_access_text()
        self._update_toolbar_state()
        self._notify_state()

    def _set_caption_text(self, text):
        self._cancel_rename()
        self._caption_full_text = str(text or "")
        self._apply_caption_text()

    def _apply_caption_text(self):
        """Keep the card caption inside the card.

        The caption is the LabelFrame ``labelwidget``.  ttk sizes that window to
        the card but never clips the text to it, so a long peer or root name
        painted straight over the neighbouring pane.  Shorten the string to the
        width actually available instead.
        """
        text = getattr(self, "_caption_full_text", "")
        prefix = "  "
        try:
            available = int(self.winfo_width()) - 2 * _CAPTION_INSET
            if available <= 8:
                available = 0
            # The leading spaces are painted too, so they have to be part of the
            # measurement.  Fitting the bare name and prefixing afterwards let the
            # text overrun the right inset and reach the divider gutter.
            shown = (fit_canvas_text(self, prefix + text, design.SECTION_FONT, available)
                     if available else prefix + text)
            self._caption_label.configure(text=shown)
        except tk.TclError:
            pass

    def _begin_rename(self, _evt=None):
        if self.is_local or not self.peer_id or not callable(self.on_rename_peer) or self._name_entry is not None:
            return "break"
        self._caption_label.pack_forget()
        self._name_entry = AppEntry(self._caption)
        self._name_entry.insert(0, self.peer_name or self._device_name or "")
        self._name_entry.pack(side="left", fill="x", expand=True, padx=(0, 4))
        self._name_entry.focus_set()
        self._name_entry.select_range(0, "end")
        self._name_entry.bind("<Return>", self._commit_rename)
        self._name_entry.bind("<Escape>", self._cancel_rename)
        self._name_entry.bind("<FocusOut>", self._commit_rename)
        return "break"

    def _commit_rename(self, _evt=None):
        entry = self._name_entry
        if entry is None:
            return "break"
        text = entry.get()
        self._cancel_rename()
        if callable(self.on_rename_peer):
            self.on_rename_peer(self.peer_id, text)
        return "break"

    def _cancel_rename(self, _evt=None):
        entry = self._name_entry
        self._name_entry = None
        if entry is not None:
            try:
                entry.destroy()
            except tk.TclError:
                pass
        try:
            if not self._caption_label.winfo_manager():
                self._caption_label.pack(side="left")
        except tk.TclError:
            pass
        return "break"

    def set_roots(self, roots):
        self._invalidate()
        self.roots = list(roots or [])
        labels = [r.get("name") or r.get("path") or r.get("rootId") for r in self.roots]
        self.root_box["values"] = ([t("all_folders")] + labels) if self.roots else []
        ids = [r.get("rootId") for r in self.roots]
        if self.root_id in ids:
            for index, (r, lab) in enumerate(zip(self.roots, labels)):
                if r.get("rootId") == self.root_id:
                    self.root_var.set(lab)
                    try:
                        self.root_box.current(index + 1)
                    except tk.TclError:
                        pass
                    break
            self.root_box.configure(state="readonly")
        elif self.roots:
            # The overview is a real navigable UI root. Do not silently jump
            # into the first exported folder when several roots exist.
            self.root_id = ""
            self.root_var.set(t("all_folders"))
            try:
                self.root_box.current(0)
            except tk.TclError:
                pass
            self.root_box.configure(state="readonly")
            self.rel = ""
        else:
            self.root_id = ""
            self.rel = ""
            self._show_root_placeholder()
        self._update_access_text()
        self._update_toolbar_state()
        self.refresh()
        self._notify_state()

    def _show_root_placeholder(self):
        self.root_id = ""
        if self.roots:
            labels = [r.get("name") or r.get("path") or r.get("rootId") for r in self.roots]
            self.root_box["values"] = [t("all_folders")] + labels
            self.root_var.set(t("all_folders"))
            try:
                self.root_box.current(0)
            except tk.TclError:
                pass
            self.root_box.configure(state="readonly")
        else:
            self.root_box["values"] = []
            self.root_var.set(t("folder_placeholder_local") if self.is_local else t("folder_placeholder_remote"))
            self.root_box.configure(state="disabled")

    def target(self):
        return {
            "peerId": None if self.is_local else self.peer_id,
            "rootId": self.root_id,
            "relativePath": self.rel,
        }

    def persistent_location(self):
        return {
            "rootId": str(self.root_id or ""),
            "relativePath": str(self.rel or "") if self.root_id else "",
        }

    def restore_location(self, state):
        """Reopen a persisted root/path after the current root list is known.

        Root ids are authoritative. A vanished root falls back to the overview;
        a vanished subdirectory is detected by fs.list and falls back to the root.
        """
        state = state if isinstance(state, dict) else {}
        root_id = str(state.get("rootId") or "")
        rel = str(state.get("relativePath") or "").replace("\\", "/").strip("/")
        ids = [str(root.get("rootId") or "") for root in self.roots]
        if root_id not in ids:
            root_id = ""
            rel = ""
        self.root_id = root_id
        self.rel = rel if root_id else ""
        self._restore_fallback_stage = 2 if self.rel else (1 if self.root_id else 0)
        if self.root_id:
            try:
                root_index = ids.index(self.root_id)
                root = self.roots[root_index]
                label = root.get("name") or root.get("path") or self.root_id
                self.root_var.set(label)
                self.root_box.current(root_index + 1)
                self.root_box.configure(state="readonly")
            except (ValueError, tk.TclError):
                self.root_id = ""
                self.rel = ""
                self._restore_fallback_stage = 0
                self._show_root_placeholder()
        else:
            self._show_root_placeholder()
        self._update_access_text()
        self._update_toolbar_state()
        self.refresh()

    def selected_entries(self):
        out = []
        for iid in self.tree.selection():
            try:
                idx = int(iid)
            except ValueError:
                continue
            if 0 <= idx < len(self.entries):
                out.append(self.entries[idx])
        return out

    def selected_sources(self):
        return [
            {
                "source": {
                    "peerId": None if self.is_local else self.peer_id,
                    "rootId": self.root_id,
                    "relativePath": e.get("relativePath") or "",
                }
            }
            for e in self.selected_entries()
        ]

    def _capture_view(self):
        try:
            selected = list(self.tree.selection())
            focus_iid = self.tree.focus()
            yview = self.tree.yview()
            current = self.focus_get()
            tree_has_focus = current is self.tree
        except tk.TclError:
            return None
        return capture_panel_view(self.entries, selected, focus_iid, yview, tree_has_focus)

    def _restore_view(self, snapshot):
        resolved = resolve_panel_view(self.entries, snapshot)
        if not resolved:
            return
        try:
            selected = [iid for iid in resolved["selected"] if self.tree.exists(iid)]
            if selected:
                self.tree.selection_set(*selected)
            focus_iid = resolved.get("focus")
            if focus_iid and self.tree.exists(focus_iid):
                self.tree.focus(focus_iid)
            elif selected:
                focus_iid = selected[0]
                self.tree.focus(focus_iid)
            yview = resolved.get("yview")
            if yview:
                self.tree.yview_moveto(yview[0])
            elif focus_iid and self.tree.exists(focus_iid):
                self.tree.see(focus_iid)
            if resolved.get("had_focus"):
                self.tree.focus_set()
        except tk.TclError:
            pass

    def owns_focus(self):
        """True when the current keyboard focus belongs to this file panel."""
        try:
            widget = self.focus_get()
        except tk.TclError:
            return False
        while widget is not None:
            if widget is self:
                return True
            widget = getattr(widget, "master", None)
        return False

    def request_refresh(self):
        """Reload the current directory without losing selection/scroll position."""
        if not self.root_id:
            if self.roots:
                if callable(self.on_refresh_roots):
                    self.on_refresh_roots()
                else:
                    self.refresh(preserve_view=True)
                return True
            return False
        if not self.is_local and not self.peer_id:
            return False
        self.refresh(preserve_view=True)
        return True

    def focus_file_list(self):
        """Keep keyboard cursor on the current file after toolbar actions."""
        try:
            self.tree.focus_set()
            iid = self.tree.focus()
            if not iid:
                sel = self.tree.selection()
                iid = sel[0] if sel else ""
            if iid:
                self.tree.focus(iid)
                self.tree.see(iid)
        except tk.TclError:
            pass

    def refresh(self, preserve_view=False):
        snapshot = self._capture_view() if preserve_view else None
        generation = self._invalidate()
        self._pending_view = snapshot
        self._incoming_entries = None
        self._list_pages = []
        self._previous_cursor = None
        self._next_cursor = None
        self._list_target = None
        self._list_total_entries = 0
        self._page_request_in_flight = False
        self._page_request_direction = None
        if not self.is_local and not self.peer_id:
            self.entries = []
            self._pending_view = None
            self._incoming_entries = None
            self._render_initial(False)
            self._notify_state()
            return
        if not self.root_id:
            self.entries = [_virtual_root_entry(root) for root in self.roots]
            self._apply_active_sort()
            self._pending_view = None
            self._incoming_entries = None
            self._render_initial(False)
            if snapshot is not None:
                self._restore_view(snapshot)
            self._notify_state()
            return
        self._loading = True
        target = dict(self.target())
        self._list_target = target
        if preserve_view and self.entries:
            # Keep the last complete snapshot visible until the replacement page arrives.
            # _load_page -> _replace_tree_entries reconciles it in place, which
            # avoids blanking/flicker and preserves transfer overlays/selection.
            self._set_loading_hint(True)
        else:
            self.entries = []
            self._render_initial(True)
        self._notify_state()
        self._load_page(None, generation, target)

    def _finish_listing(self):
        self._loading = False
        self._page_request_in_flight = False
        self._page_request_direction = None
        self._set_loading_hint(False)
        if self._list_error_shown and self.on_status:
            self._list_error_shown = False
            self.on_status(t("status_ready"), "success")
        if self._pending_view is not None:
            self._restore_view(self._pending_view)
            self._pending_view = None
        if not self.entries and not self.rel:
            self._render_empty()
        self._notify_state()
        self._schedule_overlay_layout()

    def _display_path(self):
        if not self.root_id:
            return "/"
        root = self.current_root() or {}
        root_name = str(root.get("name") or root.get("path") or root.get("rootId") or "").strip("/\\")
        rel = str(self.rel or "").replace("\\", "/").strip("/")
        parts = [part for part in (root_name, rel) if part]
        return "/" + "/".join(parts) if parts else "/"

    def _replace_tree_entries(self):
        """Refresh the sliding LIST window without recreating every Tk item.

        Treeview rows are deliberately reused by numeric iid.  Page shifts can
        happen rapidly while the user scrolls a large directory; deleting and
        reinserting ~768 rows on every shift caused avoidable Tcl allocations,
        selection churn and overlay relayout work.
        """
        was_loading = self._loading
        self._set_loading_hint(False)
        for hint_iid in ("empty", "error"):
            if self.tree.exists(hint_iid):
                self.tree.delete(hint_iid)

        self.path_var.set(self._display_path())
        if self.root_id:
            if not self.tree.exists("up"):
                self.tree.insert("", 0, iid="up", values=(t("up"), "Папка", "", ""))
            else:
                self.tree.move("up", "", 0)
        elif self.tree.exists("up"):
            self.tree.delete("up")

        desired = set()
        self._entry_iid_by_path.clear()
        for index, entry in enumerate(self.entries):
            iid = str(index)
            desired.add(iid)
            kind = entry.get("type") or "file"
            type_label = "Папка" if kind == "dir" else "Файл"
            values = (
                entry.get("name") or "",
                type_label,
                _fmt_size(entry.get("size")),
                _fmt_mtime_ms(entry.get("mtimeMs")),
            )
            if self.tree.exists(iid):
                self.tree.item(iid, values=values, tags=())
            else:
                self.tree.insert("", "end", iid=iid, values=values)
            rel_path = str(entry.get("relativePath") or "")
            if rel_path:
                self._entry_iid_by_path[rel_path] = iid

        for iid in self.tree.get_children(""):
            if iid in ("up", "loading", "empty", "error"):
                continue
            if iid not in desired:
                self.tree.delete(iid)

        if not self.entries and not self.rel and not was_loading:
            self._render_empty()
        if was_loading:
            self._set_loading_hint(True)
        self._schedule_overlay_layout()

    def _load_next_page(self):
        if self._page_request_in_flight or not self._next_cursor or not self._list_target:
            return
        self._load_page(self._next_cursor, self._generation, dict(self._list_target), direction="next")

    def _load_previous_page(self):
        if self._page_request_in_flight or not self._previous_cursor or not self._list_target:
            return
        self._load_page(self._previous_cursor, self._generation, dict(self._list_target), direction="previous")

    def _flatten_list_pages(self):
        self.entries = [entry for page in self._list_pages for entry in page.get("entries") or []]
        if self._list_pages:
            self._previous_cursor = self._list_pages[0].get("previousCursor") or None
            self._next_cursor = self._list_pages[-1].get("nextCursor") or None
        else:
            self._previous_cursor = None
            self._next_cursor = None

    def _load_page(self, cursor, generation, target, direction="replace"):
        if self._page_request_in_flight:
            return
        self._page_request_in_flight = True
        self._page_request_direction = direction
        self._loading = True
        self._set_loading_hint(True)

        def ok(result):
            if generation != self._generation:
                return
            view = self._capture_view()
            self._page_request_in_flight = False
            self._page_request_direction = None
            result = result or {}
            page = {
                "entries": list(result.get("entries") or []),
                "previousCursor": result.get("previousCursor") or None,
                "nextCursor": result.get("nextCursor") or None,
                "offset": int(result.get("offset") or 0),
            }
            try:
                self._list_total_entries = max(0, int(result.get("totalEntries") or len(page["entries"])))
            except (TypeError, ValueError):
                self._list_total_entries = len(page["entries"])

            if direction == "next":
                self._list_pages.append(page)
                if len(self._list_pages) > _LIST_WINDOW_PAGES:
                    self._list_pages.pop(0)
            elif direction == "previous":
                self._list_pages.insert(0, page)
                if len(self._list_pages) > _LIST_WINDOW_PAGES:
                    self._list_pages.pop()
            else:
                self._list_pages = [page]

            self._flatten_list_pages()
            self._restore_fallback_stage = 0
            self._replace_tree_entries()
            # Prefer the view captured immediately before a sliding-window
            # update. On refresh, the caller-provided pending view carries the
            # original selection/path and wins when it can be resolved.
            restore = self._pending_view or view
            if restore is not None:
                self._restore_view(restore)
            self._pending_view = None
            self._finish_listing()

        def err(err):
            if generation != self._generation:
                return
            self._page_request_in_flight = False
            self._page_request_direction = None
            self._loading = False
            self._set_loading_hint(False)
            if error_code(err) == "STALE_SCAN" and cursor:
                # The server snapshot expired while the user was idle. Reopen
                # the directory automatically instead of leaving dead cursors
                # until the user presses Refresh manually.
                self.refresh(preserve_view=True)
                return
            if self._restore_fallback_stage:
                stage = self._restore_fallback_stage
                self._restore_fallback_stage = 0
                if stage >= 2 and self.rel:
                    self.rel = ""
                    self._restore_fallback_stage = 1
                    self.refresh()
                    return
                if stage >= 1 and self.root_id:
                    self.root_id = ""
                    self.rel = ""
                    self._show_root_placeholder()
                    self.refresh()
                    return
            self._list_error_shown = True
            self._pending_view = None
            self._incoming_entries = None
            if not self.entries:
                self._render_error()
            if self.on_status:
                self.on_status("%s: %s" % (t("load_failed"), error_text(err)), "error")
            self._notify_state()

        sort = None
        if self._sort_column:
            sort = {"column": self._sort_column, "desc": bool(self._sort_desc)}
        self.bridge.call(
            "fs.list",
            {"target": target, "cursor": cursor, "sort": sort},
            on_ok=ok,
            on_err=err,
            timeout=60,
        )

    def _render_initial(self, loading):
        self.tree.delete(*self.tree.get_children())
        self._entry_iid_by_path.clear()
        self.path_var.set(self._display_path())
        if self.root_id:
            self.tree.insert("", "end", iid="up", values=(t("up"), "Папка", "", ""))
        if not self.root_id and self.entries:
            self._append_entries(self.entries, 0)
            return
        if loading:
            self._set_loading_hint(True)
        elif not self.root_id:
            self._render_empty()
        elif not self.entries:
            self._render_empty()
        self._schedule_overlay_layout()

    def _append_entries(self, items, start):
        self._set_loading_hint(False)
        for offset, entry in enumerate(items):
            kind = entry.get("type") or "file"
            type_label = "Папка" if kind == "dir" else "Файл"
            iid = str(start + offset)
            rel_path = str(entry.get("relativePath") or "")
            self.tree.insert(
                "",
                "end",
                iid=iid,
                values=(
                    entry.get("name") or "",
                    type_label,
                    _fmt_size(entry.get("size")),
                    _fmt_mtime_ms(entry.get("mtimeMs")),
                ),
            )
            if rel_path:
                self._entry_iid_by_path[rel_path] = iid
        self._schedule_overlay_layout()

    def _set_loading_hint(self, visible):
        if self.tree.exists("loading"):
            self.tree.delete("loading")
        if visible:
            self.tree.insert("", "end", iid="loading", values=(t("loading"), "", "", ""), tags=("hint",))

    def _render_empty(self):
        if self.tree.exists("empty"):
            self.tree.delete("empty")
        if self.entries or self.rel:
            return
        msg = t("empty")
        if not self.root_id and not self.roots:
            msg = t("folder_placeholder_local") if self.is_local else t("folder_placeholder_remote")
        self.tree.insert("", "end", iid="empty", values=(msg, "", "", ""), tags=("hint",))

    def _render_error(self):
        if self.tree.exists("error"):
            self.tree.delete("error")
        self.tree.insert("", "end", iid="error", values=(t("load_failed"), "", "", ""), tags=("error",))

    def _block_empty_combo(self, _evt=None):
        if not self.roots:
            return "break"
        return None

    def _on_root(self, _evt=None):
        # Display labels are not identities: two exported roots may legitimately
        # have the same name/path.  ttk.Combobox preserves the selected index,
        # so resolve that index back to the root object and its stable rootId.
        index = self.root_box.current()
        if index < 0:
            return
        if index == 0:
            self.root_id = ""
            self.rel = ""
            self.root_var.set(t("all_folders"))
            self._update_access_text()
            self._update_toolbar_state()
            self.refresh()
            self._notify_state()
            return
        root_index = index - 1
        if root_index >= len(self.roots):
            return
        root = self.roots[root_index]
        self.root_id = root.get("rootId", "")
        self.rel = ""
        self._update_access_text()
        self._update_toolbar_state()
        self.refresh()
        self._notify_state()

    def _on_tree_selection(self, _evt=None):
        self._update_access_text()
        self._update_toolbar_state()
        self._notify_state()
        self._schedule_overlay_layout()

    def _on_open(self, _evt=None):
        sel = self.tree.selection()
        if not sel:
            return
        iid = sel[0]
        if iid == "up":
            if self.rel:
                self.rel = self.rel.rsplit("/", 1)[0] if "/" in self.rel else ""
            else:
                self.root_id = ""
                self.root_var.set(t("all_folders"))
                try:
                    self.root_box.current(0)
                except tk.TclError:
                    pass
            self.refresh()
            return
        try:
            entry = self.entries[int(iid)]
        except (ValueError, IndexError):
            return
        virtual_root_id = _entry_root_id(entry)
        if virtual_root_id:
            self.root_id = virtual_root_id
            self.rel = ""
            root = self.current_root() or {}
            self.root_var.set(root.get("name") or root.get("path") or virtual_root_id)
            try:
                root_index = next(
                    idx for idx, item in enumerate(self.roots)
                    if str(item.get("rootId") or "") == virtual_root_id
                )
                self.root_box.current(root_index + 1)
            except (StopIteration, tk.TclError):
                pass
            self._update_access_text()
            self._update_toolbar_state()
            self.refresh()
            self._notify_state()
            return
        if entry.get("type") == "dir":
            self.rel = entry.get("relativePath") or ""
            self.refresh()

    def _update_access_text(self):
        root = self.action_root() or {}
        if self.is_local:
            if not self.access_peer_id:
                self.access_var.set(t("root_no_peer"))
                return
            if not root:
                self.access_var.set(t("all_folders_hint"))
                return
            peers = {str(x).lower() for x in (root.get("peerWritePeers") or [])}
            key = "root_read_write" if self.access_peer_id in peers else "root_read_only"
            self.access_var.set(t(key, peer=self.access_peer_name or self.access_peer_id[:12]))
        else:
            if not root:
                self.access_var.set(t("all_folders_hint") if self.roots else "")
            elif bool((root.get("perms") or {}).get("write")):
                self.access_var.set(t("remote_can_write"))
            else:
                self.access_var.set(t("remote_readonly_badge"))

    def _update_toolbar_state(self):
        if self._refresh_btn is not None:
            can_refresh = bool((self.root_id or self.roots) and (self.is_local or self.peer_id))
            self._refresh_btn.configure(state="normal" if can_refresh else "disabled")
        if self._remove_btn is not None:
            self._remove_btn.configure(state="normal" if self.action_root() else "disabled")
        if self._access_btn is not None:
            enabled = bool(self.action_root() and self.access_peer_id)
            self._access_btn.configure(state="normal" if enabled else "disabled")

    def _notify_state(self):
        if self.on_state_change:
            try:
                self.on_state_change()
            except Exception:  # noqa: BLE001
                pass
