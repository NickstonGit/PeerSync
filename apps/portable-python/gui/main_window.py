"""Responsive portable PeerSync shell: file transfer first, chat secondary."""

import collections
import json
import os
import queue
import re
import threading
import time
import sys
import traceback
import tkinter as tk
from tkinter import messagebox
from gui.finalize_recovery import show_finalize_recovery

from windows.tray import Tray
from windows import paths, single_instance
from windows.chrome import (
    apply_saved_maximized,
    capture_window_state,
    enable_custom_chrome,
    is_maximized,
    minimize_window,
    move_window,
    toggle_maximize,
)
from gui.i18n import t, error_text, error_code, is_offline_error
from gui.bridge import CoreBridge
from gui.peer_refresh import PeerListRefresher
from gui.panel import FilePanel, match_operation_token
from gui.operation_controller import OperationBatchController, operation_ids_of
from gui.chat import ChatPanel
from gui.sync_paths import resolve_sync_pair, format_selection, pick_sync_source_entries, dir_entry
from gui.peer_alias import (
    PeerAliasDataError,
    load_peer_aliases,
    peer_device_name,
    peer_display_name,
    save_peer_aliases,
    set_peer_alias,
)
from gui.pair_dialog import (
    show_pair_code, show_pair_join, show_pair_request, show_update_request,
    show_root_access, show_add_folder, show_copy_collision,
)
from gui.copy_collision import (
    apply_copy_decision,
    copy_items_for_panel,
    dest_stat_target,
    entry_basename,
    entry_kind,
    shift_is_down,
)
from gui.layout import MIN_PANE, even_ratios, restored_ratios
from gui.workspace import WorkspaceLayout
from gui.theme import apply_contrast, apply_window_chrome
from gui.components import (
    AppButton, AppFrame, AppLabel, AppStatus, AppComboBox, AppCard,
    ToolTip, load_icon,
)
from runtime.assets import ensure_wordmark
from runtime.updater import (
    best_available_update,
    comparable_app_version,
    parse_release_revision,
    release_label,
    update_check_summary,
)

LAYOUT_NAME = "ui-layout.json"
LAYOUT_VERSION = 2
NARROW_WIDTH = 1040
CHAT_WIDTH = 360
MAX_COALESCED_PROGRESS = 512
MAX_CHAT_EVENT_QUEUE = 2048
MAX_CONTROL_EVENT_QUEUE = 8192
PEER_STATUS_REFRESH_SECONDS = 5.0
PEER_RECONNECT_POKE_SECONDS = 15.0
BRAND_IMAGE_SUBSAMPLE = 2
BRAND_IMAGE_HEIGHT = 70
BRAND_IMAGE_WIDTH = 280
COMPACT_BATCH_TRACKING_THRESHOLD = 256
STAT_BATCH_CHUNK_SIZE = 64
COPY_MANIFEST_TIMEOUT = 20 * 60
COPY_ADMISSION_TIMEOUT = 20 * 60
COPY_MAX_FILES = 100_000
REMOTE_ROOTS_RETRY_MS = (400, 1200, 3000)


def should_reload_remote_roots(prev_id, prev_online, peer):
    """Reload remote folders on peer change or offline→online, not on duplicate presence."""
    if not peer:
        return bool(prev_id)
    peer_id = str(peer.get("id") or "").lower()
    if not peer_id:
        return bool(prev_id)
    if peer_id != (prev_id or ""):
        return True
    return bool(peer.get("online")) and not prev_online


def peer_row_label(peer, aliases=None):
    flag = t("online") if (peer or {}).get("online") else t("offline")
    name = peer_display_name(peer, aliases)
    return "%s · %s" % (name, flag)


def apply_presence_to_peers(peers, peer_id, online, connection_type=None):
    """Update a remembered peer's live flag in-place. Returns True if found."""
    needle = str(peer_id or "").lower()
    if not needle:
        return False
    for peer in peers or []:
        if str(peer.get("id") or "").lower() != needle:
            continue
        peer["online"] = bool(online)
        if connection_type is not None:
            peer["connectionType"] = connection_type
        return True
    return False


def _resource_path(name):
    """Return a source/PyInstaller-safe path for bundled UI assets."""
    base = getattr(sys, "_MEIPASS", None)
    if not base:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "assets", name)


def _load_brand_image(asset):
    path = ensure_wordmark(paths.data_root(), asset) or _resource_path(asset)
    return tk.PhotoImage(file=path).subsample(BRAND_IMAGE_SUBSAMPLE, BRAND_IMAGE_SUBSAMPLE)


class MainWindow:
    def __init__(self, root, core_client, on_exit, app_version, build_label, icon_path=None, release_revision=0):
        self.root = root
        self.core = core_client
        self.on_exit = on_exit
        self.on_restart = None
        self.on_update_ready = None
        self.app_version = app_version
        self.build_label = build_label
        self.release_revision = parse_release_revision(release_revision)
        self.icon_path = icon_path
        self._control_events = queue.Queue(maxsize=MAX_CONTROL_EVENT_QUEUE)
        self._chat_events = queue.Queue(maxsize=MAX_CHAT_EVENT_QUEUE)
        # The Tk interpreter belongs exclusively to the thread that created
        # MainWindow. Background workers enqueue continuations here; _tick(),
        # which always runs on the Tk owner thread, is the only dispatcher.
        # SimpleQueue is intentionally unbounded: lifecycle continuations are
        # low-volume and must never be dropped like coalescible telemetry.
        self._ui_tasks = queue.SimpleQueue()
        self._control_queue_overflow = False
        self._chat_queue_overflow = False
        self._progress_events = collections.OrderedDict()
        self._progress_lock = threading.Lock()
        self._tick_idle_cycles = 0
        self._really_quit = False
        self._core_ready = False
        self._core_generation = 0
        self.tray = None
        self.peers = []
        self._peer_id = None
        self._peer_alias_load_error = None
        try:
            self._peer_aliases = load_peer_aliases()
        except PeerAliasDataError as exc:
            self._peer_aliases = {}
            self._peer_alias_load_error = str(exc)
        self._peers_stamp = 0
        self._next_peer_refresh_at = 0.0
        self._peer_refresher = PeerListRefresher(self._issue_peer_list)
        self._remote_roots_generation = 0
        self._remote_roots_retry_after = None
        self._restart_busy = False
        self._update_busy = False
        self._cancel_requested_ids = set()
        self._cancel_requested_batches = set()
        self._update_source_peer_id = None
        self._announce_update_after_peers = False
        self._pair_prompt_pending_id = None
        self._sync_busy = False
        self._copy_busy = False
        self._sync_batch_id = None
        self._chat_preference = True
        self._narrow_mode = False
        self._narrow_chat_open = False
        self._layout_ready = False
        self._last_root_width = 0
        self._refresh_after = None
        self._activation_refresh_after = None
        self._app_inactive = False
        self._recovery_prompting = set()
        self._recovery_deferred = {}
        self._recovery_queue = collections.deque()
        self._recovery_queued = set()
        self._recovery_prompt_active = False
        self._recovery_scan_generation = 0
        self._layout_after = None
        # Batch state is owned by the controller; these stay as read/write views
        # so the Tk and RPC code keeps its existing dict idiom.
        self._batches = OperationBatchController(core_generation=self._core_generation)
        self._sash_ratios = {2: even_ratios(2)}
        self._title_drag_pointer = None
        self._title_drag_window = None
        self._title_drag_maximized = False
        self._want_maximized = False
        # File-panel session state is loaded with the layout before Core is ready,
        # then applied only after the matching local/remote roots are available.
        self._saved_left_panel_state = None
        self._saved_right_panel_state = None
        # Set when the user picks a peer, so an automatic fallback selection can
        # never discard a pending remote restore the user still expects.
        self._peer_id_explicitly_selected = False

        self._dark_mode = self._load_dark_preference()
        apply_contrast(root, dark=self._dark_mode)
        self.app_title = "PeerSync by Nickston %s" % build_label
        self.version_text = "PSN ver: %s" % build_label
        root.title(self.app_title)
        root.geometry("1100x640")
        root.minsize(820, 480)
        root.protocol("WM_DELETE_WINDOW", self._on_close)
        if icon_path:
            try:
                root.iconbitmap(default=icon_path)
            except tk.TclError:
                pass

        self.bridge = CoreBridge(root, lambda: self.core)

        # Browser-style custom header.  Windows keeps the real resizable top
        # level (taskbar / Alt+Tab / Snap), but its native caption is removed by
        # windows.chrome so there is only one coherent application header.
        header = AppFrame(root, surface="header", padding=(12, 3, 8, 4))
        header.pack(fill="x")
        header.columnconfigure(0, weight=1, uniform="header_side")
        header.columnconfigure(2, weight=1, uniform="header_side")
        header.rowconfigure(0, weight=0)
        header.rowconfigure(1, weight=0)
        self._header = header

        # Use the same two grid rows on both sides of the wordmark.  This keeps
        # the version text vertically aligned with the three window controls
        # and keeps Restart aligned with Theme + Exit regardless of font metrics.
        # Keep the left block pinned to the window edge, but center the version
        # over Restart.  The frame width is set by the wider Restart button, so
        # the label gets the same width without moving the whole block inward.
        left_controls = AppFrame(header, surface="header")
        left_controls.grid(row=0, column=0, rowspan=2, sticky="w")
        left_controls.columnconfigure(0, weight=1)
        self._version_label = AppLabel(
            left_controls,
            text=self.version_text,
            variant="header_meta",
            anchor="center",
        )
        self._version_label.grid(row=0, column=0, sticky="ew", pady=(0, 3))
        self._restart_btn = AppButton(
            left_controls,
            text=t("restart"),
            variant="header",
            command=self._restart,
        )
        self._restart_btn.grid(row=1, column=0, sticky="ew")

        # Real wordmark.  Both light/dark assets are bundled; the current light
        # theme uses the dark-ink image.  Keep a text fallback so a missing asset
        # can never prevent the application from starting.
        brand = AppFrame(
            header,
            surface="header",
            width=BRAND_IMAGE_WIDTH,
            height=BRAND_IMAGE_HEIGHT,
        )
        self._brand_frame = brand
        brand.grid(row=0, column=1, rowspan=2, sticky="nsew", padx=16)
        brand.columnconfigure(0, weight=1)
        brand.rowconfigure(0, weight=1)
        brand.grid_propagate(False)
        self._brand_image = None
        self._brand_widgets = []
        try:
            brand_asset = "peersync-wordmark-dark.png" if self._dark_mode else "peersync-wordmark-light.png"
            self._brand_image = _load_brand_image(brand_asset)
        except (tk.TclError, OSError):
            self._brand_image = None

        if self._brand_image is not None:
            self._brand_logo = AppLabel(
                brand,
                image=self._brand_image,
                variant="header",
                anchor="center",
            )
            self._brand_logo.grid(row=0, column=0, sticky="nsew", pady=(3, 0))
            self._brand_widgets.append(self._brand_logo)
        else:
            fallback = AppFrame(brand, surface="header")
            fallback.grid(row=0, column=0, sticky="nsew")
            fallback.columnconfigure(0, weight=1)
            self._brand_title = AppLabel(
                fallback,
                text="PeerSync by Nickston",
                variant="title",
                anchor="center",
            )
            self._brand_title.pack(anchor="center")
            self._brand_byline = AppLabel(
                fallback,
                text="by nickston",
                variant="brand_byline",
                anchor="center",
            )
            self._brand_byline.pack(anchor="center", pady=(0, 1))
            self._brand_widgets.extend((fallback, self._brand_title, self._brand_byline))

        # Both right-side rows occupy the exact same grid column width.  The
        # lower row stretches Exit into the space left by the theme button, so
        # Theme + Exit is exactly as wide as Minimize + Restore + Close.
        window_controls = AppFrame(header, surface="header")
        window_controls.grid(row=0, column=2, sticky="e", pady=(0, 3))
        for column in range(3):
            window_controls.columnconfigure(column, weight=1, uniform="window_control")
        self._minimize_btn = AppButton(
            window_controls,
            text="",
            width=3,
            variant="window",
            command=self._minimize_window,
            takefocus=False,
        )
        self._minimize_btn.grid(row=0, column=0, sticky="ew")
        self._maximize_btn = AppButton(
            window_controls,
            text="",
            width=3,
            variant="window",
            command=self._toggle_maximize,
            takefocus=False,
        )
        self._maximize_btn.grid(row=0, column=1, sticky="ew", padx=(2, 0))
        self._close_btn = AppButton(
            window_controls,
            text="",
            width=3,
            variant="close",
            command=self._on_close,
            takefocus=False,
        )
        self._close_btn.grid(row=0, column=2, sticky="ew", padx=(2, 0))

        app_controls = AppFrame(header, surface="header")
        app_controls.grid(row=1, column=2, sticky="e")
        app_controls.columnconfigure(0, weight=0)
        app_controls.columnconfigure(1, weight=1)
        self._theme_btn = AppButton(
            app_controls, text="", width=3, variant="icon", surface="header",
            command=self._toggle_theme, takefocus=False,
        )
        self._theme_btn.grid(row=0, column=0, sticky="w", padx=(0, 5))
        exit_btn = AppButton(
            app_controls,
            text=t("exit"),
            width=8,
            variant="header",
            command=self.request_exit,
        )
        exit_btn.grid(row=0, column=1, sticky="ew")
        self._header_icon_images = {}

        drag_widgets = [
            header,
            left_controls,
            brand,
            window_controls,
            app_controls,
            self._version_label,
            *self._brand_widgets,
        ]
        for drag_widget in drag_widgets:
            drag_widget.bind("<ButtonPress-1>", self._begin_title_drag)
            drag_widget.bind("<B1-Motion>", self._continue_title_drag)
            drag_widget.bind("<ButtonRelease-1>", self._end_title_drag)
            drag_widget.bind("<Double-Button-1>", self._toggle_maximize_event)

        ToolTip(exit_btn, t("tip_exit"))
        ToolTip(self._restart_btn, t("tip_restart"))
        self._theme_tip = ToolTip(self._theme_btn, "Тёмная тема" if not self._dark_mode else "Светлая тема")
        # The root starts withdrawn in app.py, so strip the native caption now
        # before the first user-visible deiconify.  Repeat once on idle because
        # Tk may finalize the wrapper HWND during the first event-loop turn.
        self._enable_custom_chrome()
        self.root.after_idle(self._enable_custom_chrome)

        devices = AppCard(root, title="  " + t("devices"))
        devices.pack(fill="x", padx=12, pady=(5, 6))
        pair_row = AppFrame(devices, surface="surface")
        pair_row.pack(fill="x")
        pair_row.columnconfigure(3, weight=1)
        self._pair_btn = AppButton(
            pair_row,
            text=t("pair"),
            variant="primary",
            command=self._create_code,
            state="disabled",
        )
        self._pair_btn.grid(row=0, column=0, sticky="w")
        self._join_btn = AppButton(pair_row, text=t("join"), command=self._join_code, state="disabled")
        self._join_btn.grid(row=0, column=1, sticky="w", padx=(6, 12))
        AppLabel(pair_row, text=t("linked_devices") + ":", variant="surface_muted").grid(
            row=0, column=2, sticky="e", padx=(0, 7)
        )
        self.peer_var = tk.StringVar()
        self.peer_box = AppComboBox(pair_row, textvariable=self.peer_var, state="disabled", width=24)
        self.peer_box.grid(row=0, column=3, sticky="ew")
        self.peer_box.bind("<<ComboboxSelected>>", self._on_peer)
        self._forget_btn = AppButton(
            pair_row,
            text=t("forget"),
            variant="danger",
            command=self._forget_peer,
            state="disabled",
        )
        self._forget_btn.grid(row=0, column=4, sticky="e", padx=(7, 0))
        self._update_btn = AppButton(
            pair_row,
            text="Есть обновление",
            variant="primary",
            command=self._request_update,
            state="disabled",
        )
        self._update_btn.grid(row=0, column=5, sticky="e", padx=(7, 0))
        self._update_btn.grid_remove()
        self._pair_hint_label = AppLabel(devices, text=t("pair_hint"), variant="surface_muted")
        self._pair_hint_label.pack(anchor="w", pady=(5, 0))
        ToolTip(self._pair_btn, t("tip_pair"))
        ToolTip(self._join_btn, t("tip_join"))
        ToolTip(self._forget_btn, t("tip_forget"))
        ToolTip(self._update_btn, t("tip_update"))

        # Stable workspace: file cards, the sash, the chat rule and the chat
        # column are all placed by one geometry function (gui.workspace).  Chat
        # showing/hiding therefore never re-grids the file cards and never moves
        # the sash in a separate idle frame, which was the source of the previous
        # "stretched then jumped" flicker.
        self.workspace = AppFrame(root)
        self.workspace.pack(fill="both", expand=True, padx=12, pady=(0, 4))

        self.left = FilePanel(
            self.workspace,
            self.bridge,
            True,
            self._note,
            on_add_folder=self._add_root,
            on_remove_folder=self._remove_root,
            on_permissions=self._edit_root_access,
            on_state_change=self._update_controls,
            on_refresh_roots=self._reload_roots,
        )
        self.right = FilePanel(
            self.workspace,
            self.bridge,
            False,
            self._note,
            on_show_chat=self._toggle_chat,
            on_state_change=self._update_controls,
            on_rename_peer=self._rename_connected_peer,
            on_refresh_roots=self._reload_remote_roots,
        )
        self.chat = ChatPanel(self.workspace, self.bridge, self._note, on_hide=self._toggle_chat)
        self.workspace_layout = WorkspaceLayout(
            self.workspace, self.left, self.right, self.chat, CHAT_WIDTH
        )
        # A manual sash drag changes the ratio; persist it with the rest of the
        # layout instead of leaving a stale value in ui-layout.json.
        self.workspace_layout.on_sash_changed = self._save_layout
        # Row progress overlays are measured against real Treeview cells, so they
        # are laid out once the cards know their new geometry, after the frozen
        # batch has committed.
        self.workspace_layout.on_after_layout = self._layout_overlays
        self.workspace_layout.set_min_pane(self._min_pane_width())

        self._copy_ltr_btn = AppButton(
            self.left.footer,
            text=t("copy_to"),
            variant="primary",
            command=self._copy_ltr,
            state="disabled",
            takefocus=False,
        )
        self._copy_ltr_btn.pack(side="left")
        self._sync_ltr_btn = AppButton(
            self.left.footer,
            text=t("sync_to"),
            command=self._sync_ltr,
            state="disabled",
            takefocus=False,
        )
        self._sync_ltr_btn.pack(side="left", padx=(6, 0))
        self._copy_rtl_btn = AppButton(
            self.right.footer,
            text=t("copy_from"),
            variant="primary",
            command=self._copy_rtl,
            state="disabled",
            takefocus=False,
        )
        self._copy_rtl_btn.pack(side="right")
        self._sync_rtl_btn = AppButton(
            self.right.footer,
            text=t("sync_from"),
            command=self._sync_rtl,
            state="disabled",
            takefocus=False,
        )
        self._sync_rtl_btn.pack(side="right", padx=(0, 6))
        ToolTip(self._copy_ltr_btn, t("tip_copy_to"))
        ToolTip(self._sync_ltr_btn, t("tip_sync_to"))
        ToolTip(self._copy_rtl_btn, t("tip_copy_from"))
        ToolTip(self._sync_rtl_btn, t("tip_sync_from"))

        status_frame = AppFrame(root, surface="surface")
        status_frame.pack(fill="x", side="bottom", padx=12, pady=(0, 4), before=self.workspace)
        self.status_var = tk.StringVar(value=t("core_starting"))
        self._stop_btn = AppButton(
            status_frame,
            text=t("stop"),
            variant="danger",
            compact=True,
            command=self._stop_active_operations,
            state="disabled",
            takefocus=False,
        )
        self._stop_btn.pack(side="right", padx=(8, 0))
        ToolTip(self._stop_btn, t("tip_stop"))
        self.status_label = AppStatus(status_frame, textvariable=self.status_var, severity="info", anchor="w")
        self.status_label.pack(side="left", fill="x", expand=True)
        if self._peer_alias_load_error:
            self.root.after_idle(lambda message=self._peer_alias_load_error: self._set_status(message, "warning"))

        self._apply_theme_assets()

        # The workspace widget receives its new size only after the root's
        # Configure has gone through the pack manager, so the sash ratio has to
        # be re-applied from *its* Configure, not the root's, or the drag reads a
        # stale width and the columns land a frame late.
        self.workspace.bind("<Configure>", self._on_workspace_configure)
        self.root.bind("<Configure>", self._on_root_configure)
        self.root.bind("<Control-r>", self._refresh_shortcut, add="+")
        self.root.bind("<FocusOut>", self._on_app_focus_out, add="+")
        self.root.bind("<FocusIn>", self._on_app_focus_in, add="+")

        self.install_tray()
        self._restore_layout()
        if self.tray:
            self.root.withdraw()
        else:
            self.root.deiconify()
            self.root.after_idle(self._apply_saved_maximized)
        self.root.after_idle(self._apply_layout_mode)
        self.root.after_idle(self._apply_splits)
        self._tick()
        single_instance.start_show_watcher(self._on_running_instance_activated)

    def get_client(self):
        return self.core

    def post_ui(self, callback, *args, **kwargs):
        """Thread-safe handoff to the Tk owner thread.

        Background threads must not call root.after(), widget methods or Tcl
        directly. The existing UI tick drains this queue with <=250 ms idle
        latency, keeping all Tcl/Tk interaction on the creating thread.
        """
        if callback is None:
            return False
        self._ui_tasks.put((callback, args, kwargs))
        return True

    def _drain_ui_tasks(self, limit=128):
        drained = 0
        while drained < limit:
            try:
                callback, args, kwargs = self._ui_tasks.get_nowait()
            except queue.Empty:
                break
            drained += 1
            try:
                callback(*args, **kwargs)
            except Exception:  # noqa: BLE001 - one continuation must not kill the Tk pump
                traceback.print_exc()
        return drained

    def _set_status(self, text, severity="info"):
        text = str(text or "").strip()
        self.status_var.set(text or t("status_ready"))
        try:
            self.status_label.set_severity(severity)
            self.root.title(self.app_title)
        except tk.TclError:
            pass

    def _invalidate_core_lifecycle(self, reason="Core lifecycle changed"):
        """Fail UI-owned work atomically when its Core owner disappears."""
        self._core_generation += 1
        self._recovery_scan_generation += 1
        for batch in list(self._operation_batches.values()):
            panel = batch.get("panel")
            for group in batch.get("groups") or []:
                if panel:
                    panel.fail_row_operation(group.get("token"), reason)
            self._release_batch_guard(batch)
        self._batches.invalidate(core_generation=self._core_generation)
        self._peer_refresher.reset()
        self._next_peer_refresh_at = 0.0
        self._cancel_requested_ids.clear()
        self._cancel_requested_batches.clear()
        self._sync_batch_id = None
        self._set_sync_busy(False)
        self._set_copy_busy(False)

    # ---------- batch state (owned by OperationBatchController) ----------

    @property
    def _operation_batches(self):
        return self._batches.batches

    @property
    def _operation_batch_by_id(self):
        return self._batches.route_by_op

    @property
    def _ui_batch_by_core_id(self):
        return self._batches.ui_by_core

    @property
    def _unrouted_operation_events(self):
        return self._batches.unrouted

    def _set_peers_offline(self):
        self._peers_stamp += 1
        self._peer_refresher.reset()
        self._next_peer_refresh_at = 0.0
        self._next_peer_poke_at = 0.0
        for peer in self.peers:
            peer["online"] = False
            peer["connectionType"] = None
        self._cancel_remote_roots_retry()
        self._remote_roots_generation += 1
        try:
            self.right.set_roots([])
        except (AttributeError, tk.TclError):
            pass
        if self.peers:
            self._refresh_peer_box()

    def on_core_ready(self):
        self._core_ready = True
        self._peer_refresher.reset()
        self._next_peer_refresh_at = time.monotonic() + PEER_STATUS_REFRESH_SECONDS
        self._next_peer_poke_at = 0.0
        self._set_status(t("core_ready"), "success")
        self._reload_roots()
        self._reload_peers()
        self._check_recovery_conflicts()
        self._update_controls()

    def install_tray(self):
        self.tray = Tray(self.app_title, self.icon_path, self.show_window, self.request_exit)
        try:
            self.tray.install()
        except Exception as exc:  # noqa: BLE001
            self.tray = None
            try:
                os.makedirs(paths.logs_dir(), exist_ok=True)
                tray_log = os.path.join(paths.logs_dir(), "tray-runtime.log")
                paths.rotate_log_files(tray_log)
                with open(tray_log, "a", encoding="utf-8") as fh:
                    fh.write("tray install failed in MainWindow: %s\n" % exc)
            except OSError:
                pass

    def show_window(self):
        if not self.root.winfo_exists():
            return
        self.root.deiconify()
        self.root.update_idletasks()
        self._enable_custom_chrome()
        self._apply_saved_maximized()
        self.root.lift()
        self._apply_layout_mode()
        self._layout_ready = True
        try:
            self.root.focus_force()
        except tk.TclError:
            pass

    def _on_running_instance_activated(self):
        self.post_ui(self._show_from_second_instance)

    def _show_from_second_instance(self):
        if self._really_quit:
            return
        self.show_window()

    def _enable_custom_chrome(self):
        enable_custom_chrome(self.root)
        # Frame-style changes can make DWM recompute the captionless border.
        # Re-apply corner preference + "no native border" afterwards so the
        # top edge never flickers between grey/native and client colors.
        apply_window_chrome(self.root)
        self._sync_maximize_button()

    def _begin_title_drag(self, event=None):
        # Do not enter the Win32 non-client move loop from inside Tk's mouse
        # callback.  With a Python-subclassed WndProc that can re-enter Tk and
        # terminate the process on some Windows builds.  Track the pointer and
        # move the real top-level window from B1-Motion instead.
        if event is None:
            return
        try:
            self._title_drag_pointer = (int(event.x_root), int(event.y_root))
            self._title_drag_window = (int(self.root.winfo_x()), int(self.root.winfo_y()))
            self._title_drag_maximized = is_maximized(self.root)
        except (AttributeError, TypeError, ValueError, tk.TclError):
            self._title_drag_pointer = None
            self._title_drag_window = None
            self._title_drag_maximized = False

    def _continue_title_drag(self, event=None):
        if event is None or self._title_drag_pointer is None or self._title_drag_window is None:
            return
        try:
            pointer_x = int(event.x_root)
            pointer_y = int(event.y_root)
            start_x, start_y = self._title_drag_pointer
            delta_x = pointer_x - start_x
            delta_y = pointer_y - start_y
            if abs(delta_x) < 2 and abs(delta_y) < 2:
                return

            if self._title_drag_maximized:
                # Match normal title-bar behaviour closely enough: only restore
                # after the user actually starts dragging and keep the pointer
                # over roughly the same horizontal place in the restored window.
                root_left = int(self.root.winfo_rootx())
                root_width = max(1, int(self.root.winfo_width()))
                pointer_ratio = min(1.0, max(0.0, (pointer_x - root_left) / root_width))
                toggle_maximize(self.root)
                self.root.update_idletasks()
                restored_width = max(1, int(self.root.winfo_width()))
                new_x = int(pointer_x - restored_width * pointer_ratio)
                new_y = int(pointer_y - 14)
                move_window(self.root, new_x, new_y)
                self._title_drag_pointer = (pointer_x, pointer_y)
                self._title_drag_window = (new_x, new_y)
                self._title_drag_maximized = False
                self.root.after_idle(self._sync_maximize_button)
                return

            window_x, window_y = self._title_drag_window
            move_window(self.root, window_x + delta_x, window_y + delta_y)
        except (AttributeError, TypeError, ValueError, tk.TclError):
            self._end_title_drag()

    def _end_title_drag(self, _event=None):
        self._title_drag_pointer = None
        self._title_drag_window = None
        self._title_drag_maximized = False

    def _minimize_window(self):
        minimize_window(self.root)

    def _toggle_maximize(self):
        toggle_maximize(self.root)
        self._want_maximized = is_maximized(self.root)
        self.root.after_idle(self._sync_maximize_button)
        self.root.after_idle(self._save_layout)

    def _toggle_maximize_event(self, _event=None):
        self._toggle_maximize()
        return "break"

    def _sync_maximize_button(self):
        try:
            asset = "restore" if is_maximized(self.root) else "maximize"
            image = load_icon(self.root, asset, dark=self._dark_mode)
            self._header_icon_images["maximize"] = image
            self._maximize_btn.configure(image=image, text="")
        except (tk.TclError, OSError):
            pass

    def _load_dark_preference(self):
        try:
            with open(os.path.join(paths.data_root(), LAYOUT_NAME), encoding="utf-8") as fh:
                doc = json.load(fh)
            return str(doc.get("theme") or "light").lower() == "dark"
        except (OSError, ValueError, TypeError):
            return False

    def _apply_theme_assets(self):
        try:
            asset = "peersync-wordmark-dark.png" if self._dark_mode else "peersync-wordmark-light.png"
            self._brand_image = _load_brand_image(asset)
            if hasattr(self, "_brand_logo"):
                self._brand_logo.configure(image=self._brand_image)
            elif hasattr(self, "_brand_frame"):
                for widget in self._brand_widgets:
                    widget.destroy()
                self._brand_widgets = []
                self._brand_logo = AppLabel(
                    self._brand_frame,
                    image=self._brand_image,
                    variant="header",
                    anchor="center",
                )
                self._brand_logo.grid(row=0, column=0, sticky="nsew", pady=(3, 0))
                self._brand_widgets.append(self._brand_logo)
            for key, button, icon_name in (
                ("minimize", self._minimize_btn, "minimize"),
                ("close", self._close_btn, "close"),
                ("theme", self._theme_btn, "sun" if self._dark_mode else "moon"),
            ):
                image = load_icon(self.root, icon_name, dark=self._dark_mode)
                self._header_icon_images[key] = image
                button.configure(image=image, text="")
            self._sync_maximize_button()
            if hasattr(self, "left"):
                self.left.apply_theme(self._dark_mode)
            if hasattr(self, "right"):
                self.right.apply_theme(self._dark_mode)
            if hasattr(self, "chat"):
                self.chat.apply_theme(self._dark_mode)
            if hasattr(self, "_theme_tip"):
                self._theme_tip.text = "Светлая тема" if self._dark_mode else "Тёмная тема"
        except (tk.TclError, OSError):
            pass

    def _toggle_theme(self):
        self._dark_mode = not self._dark_mode
        apply_contrast(self.root, dark=self._dark_mode)
        self._apply_theme_assets()
        self._save_layout()

    def _on_close(self):
        if self.tray:
            self._save_layout()
            self.root.withdraw()
        else:
            self.request_exit()

    def request_exit(self):
        self._really_quit = True
        self._save_layout()
        self._recovery_scan_generation += 1
        self.bridge.close()
        self.on_exit()

    # ---------- event ingress: lossless control + coalesced telemetry ----------
    def _put_bounded_event(self, target, frame, *, chat=False):
        try:
            target.put_nowait(frame)
            return
        except queue.Full:
            if chat:
                self._chat_queue_overflow = True
            else:
                self._control_queue_overflow = True
        # The Core remains the source of truth. Under a pathological event flood,
        # discard the oldest UI notification instead of allowing unbounded RAM.
        try:
            target.get_nowait()
        except queue.Empty:
            pass
        try:
            target.put_nowait(frame)
        except queue.Full:
            pass

    def post_event(self, frame, owner=None):
        # Core events are lifecycle-owner scoped. Keep the owner with the queued
        # frame as well as checking it at ingress: an old owner can enqueue a
        # frame just before restart publishes the replacement, and that stale
        # frame must still be rejected when Tk eventually drains the queue.
        if owner is not None and owner is not self.core:
            return
        if not isinstance(frame, dict):
            return
        queued = (owner, frame)
        event = frame.get("event")
        if event in ("operation.progress", "sync.progress", "update.progress"):
            payload = frame.get("payload") or {}
            key = (
                event,
                payload.get("operationId")
                or payload.get("previewId")
                or payload.get("peerId")
                or payload.get("relativePath")
                or "_"
            )
            with self._progress_lock:
                self._progress_events[key] = queued
                self._progress_events.move_to_end(key)
                while len(self._progress_events) > MAX_COALESCED_PROGRESS:
                    self._progress_events.popitem(last=False)
            return
        if event == "chat.message":
            self._put_bounded_event(self._chat_events, queued, chat=True)
            return
        self._put_bounded_event(self._control_events, queued)

    def _handle_owned_event(self, queued):
        if isinstance(queued, tuple) and len(queued) == 2:
            owner, frame = queued
        else:
            owner, frame = None, queued
        if owner is not None and owner is not self.core:
            return
        if isinstance(frame, dict):
            self._handle_event(frame)

    def _drain_control_events(self):
        control_overflowed = self._control_queue_overflow
        chat_overflowed = self._chat_queue_overflow
        self._control_queue_overflow = False
        self._chat_queue_overflow = False
        for _ in range(32):
            try:
                event = self._chat_events.get_nowait()
            except queue.Empty:
                break
            self._handle_owned_event(event)
        for _ in range(128):
            try:
                event = self._control_events.get_nowait()
            except queue.Empty:
                break
            self._handle_owned_event(event)
        if control_overflowed and self._core_ready:
            # Converge visible peer/root/file state after deliberately dropping
            # stale notifications from an extreme backlog.
            self._reload_peers()
            self._schedule_panel_refresh()
            self._reload_operation_state()
            self._reconcile_batch_statuses()
        if chat_overflowed and self._core_ready:
            # Chat history is durable in Core, so recover any dropped live
            # notifications from the source of truth instead of leaking RAM.
            self.chat.reload_history()

    def _tick(self):
        had_work = (not self._chat_events.empty()) or (not self._control_events.empty()) or (not self._ui_tasks.empty())
        try:
            had_work = bool(self._drain_ui_tasks()) or had_work
            self._drain_control_events()
            self._poll_peer_status()
            telemetry = []
            with self._progress_lock:
                for _ in range(min(64, len(self._progress_events))):
                    _key, frame = self._progress_events.popitem(last=False)
                    telemetry.append(frame)
            had_work = had_work or bool(telemetry)
            for frame in telemetry:
                self._handle_owned_event(frame)
            if self.tray:
                self.tray.pump()
        except Exception:  # noqa: BLE001 - one payload must not kill the Tk pump
            traceback.print_exc()
        finally:
            if had_work:
                self._tick_idle_cycles = 0
                delay = 50
            else:
                self._tick_idle_cycles = min(self._tick_idle_cycles + 1, 6)
                delay = min(250, 50 * (1 + self._tick_idle_cycles))
            try:
                self.root.after(delay, self._tick)
            except tk.TclError:
                pass

    def _handle_event(self, ev):
        et = ev.get("event")
        payload = ev.get("payload") or {}
        if et == "core.swarmReady":
            swarm = payload.get("swarm")
            if swarm == "degraded":
                self._set_status(t("core_degraded"), "warning")
            elif swarm == "booting":
                self._set_status(t("core_booting"))
            else:
                self._set_status(t("core_online"), "success")
        elif et == "core.ready":
            self.on_core_ready()
        elif et == "core.starting":
            self._core_ready = False
            self._invalidate_core_lifecycle(t("core_starting"))
            self._set_peers_offline()
            self._set_status(t("core_starting"))
            self._update_controls()
        elif et == "core.warning":
            self._set_status(payload.get("message") or t("core_warning"), "warning")
        elif et == "core.fatal":
            self._core_ready = False
            self._invalidate_core_lifecycle(payload.get("message") or "Core fatal")
            self._set_peers_offline()
            self._set_status("%s: %s" % (t("error"), payload.get("code") or "CORE_FATAL"), "error")
            self._update_controls()
        elif et == "core.stopped":
            self._core_ready = False
            self._invalidate_core_lifecycle(t("core_stopped"))
            self._set_peers_offline()
            self._set_status(t("core_stopped"), "warning")
            self._update_controls()
        elif et == "peer.presence":
            self._on_peer_presence(payload)
        elif et == "peer.updateInfo":
            self._announce_update_after_peers = bool((payload or {}).get("update"))
            self._reload_peers()
        elif et == "update.progress":
            peer_id = str(payload.get("peerId") or "").lower()
            if self._update_busy and peer_id == (self._update_source_peer_id or ""):
                try:
                    done = int(payload.get("receivedBytes") or 0)
                    total = int(payload.get("totalBytes") or 0)
                except (TypeError, ValueError):
                    done, total = 0, 0
                if total > 0:
                    pct = max(0, min(100, int(done * 100 / total)))
                    self._update_btn.configure(text="Обновление %d%%" % pct)
                    self._set_status("Получение обновления: %d%%" % pct)
        elif et == "pairing.changed":
            self._on_pairing(payload)
        elif et == "fs.rootsChanged":
            self.left.set_roots(payload.get("roots") or [])
            self._restore_local_panel_if_pending()
        elif et == "chat.message":
            self._on_chat_message(payload)
        elif et == "operation.state":
            self._route_operation_event(payload)
            if str(payload.get("state") or "") == "stale" and str(payload.get("reason") or payload.get("error") or "") == "FINALIZE_RECOVERY_CONFLICT":
                self._offer_finalize_recovery(str(payload.get("operationId") or ""))
            if (
                str(payload.get("state") or "") in ("done", "failed", "cancelled", "stale")
                and self._terminal_operation_should_refresh_panels(payload)
            ):
                self._schedule_panel_refresh()
        elif et == "operation.progress":
            self._route_operation_event(payload)
        elif et == "sync.progress":
            self._on_sync_progress(payload)

    def _on_chat_message(self, payload):
        incoming = str((payload or {}).get("direction") or "in") != "out"
        if incoming and not self._chat_is_visible() and self.chat.would_draw(payload):
            self.right.set_chat_unread(True)
        # Reconnect delivery updates an already-rendered queued message. The
        # chat panel de-duplicates by messageId, so reconcile that state from
        # durable history instead of silently leaving the bubble as queued.
        peer_id = str((payload or {}).get("peerId") or "").lower()
        current_peer = str(self.chat.peer_id or "").lower()
        delivered_outgoing = (
            not incoming and str((payload or {}).get("state") or "") == "delivered"
        )
        if delivered_outgoing and peer_id and peer_id == current_peer and not self.chat.would_draw(payload):
            self.chat.reload_history()
            return
        self.chat.append(payload)

    def _on_sync_progress(self, payload):
        phase = str((payload or {}).get("phase") or "")
        files_done = payload.get("filesDone")
        if files_done is None:
            files_done = payload.get("files")
        try:
            files_done = int(files_done or 0)
        except (TypeError, ValueError):
            files_done = 0
        kind = str((payload or {}).get("kind") or "")
        if phase in ("compare-source", "compare-dest") or kind == "manifest-remote":
            batch = self._operation_batches.get(self._sync_batch_id or "")
            if batch:
                panel = batch.get("panel")
                for item in batch.get("groups") or []:
                    if panel:
                        panel.set_compare_progress(item.get("token"), files_done, phase or kind)
                # A preview has no operations yet, so the phase cannot be
                # derived from operation states; the controller is told directly.
                self._batches.set_group_phase(batch, "comparing")
            if phase == "compare-dest":
                self._set_status(t("sync_compare_dest", count=files_done))
            elif phase == "compare-source":
                self._set_status(t("sync_compare_source", count=files_done))
            else:
                self._set_status("%s %s" % (t("sync_preparing"), files_done))
            return
        done = payload.get("done") or payload.get("filesDone")
        total = payload.get("total") or payload.get("filesTotal")
        if total and not self._sync_busy and self._active_batches():
            self._set_status("Синхронизация: %s из %s" % (done or 0, total))

    def _note(self, msg, severity="info"):
        if msg:
            self._set_status(str(msg)[:260], severity)

    # ---------- row-bound background operations ----------
    def _begin_operation_batch(self, panel, entries, label, expected_bytes=0, expected_files=0):
        return self._batches.create(
            panel,
            entries,
            label,
            expected_bytes=expected_bytes,
            expected_files=expected_files,
        )

    def _register_operation_batch(self, batch_id, operation_ids, accepted_count=None, core_batch_id=None):
        batch = self._batches.register(batch_id, operation_ids, accepted_count, core_batch_id)
        if not batch:
            return
        panel = batch["panel"]
        self._update_controls()
        if batch["core_batch_id"]:
            # Individual operation events can reach a terminal state before the
            # durable batch journal has converged. Keep their row overlays alive
            # until operation.batchStatus confirms the whole accepted batch.
            for group in batch["groups"]:
                panel.set_operation_cleanup_hold(group["token"], True)
        if batch["aggregate_core"]:
            self._batches.mark_ids_final(batch)
            for group in batch["groups"]:
                panel.mark_operations_final(group["token"])
            self._release_batch_guard(batch)
            self.root.after(0, self._poll_operation_batch, batch_id)
            return
        if batch["expected_operations"] == 0:
            self._batches.mark_ids_final(batch)
            for group in batch["groups"]:
                panel.mark_operations_final(group["token"])
                panel.complete_row_operation(group["token"])
            self._release_batch_overlay_holds(batch)
            self._release_batch_guard(batch)
            self.root.after(2500, self._cleanup_operation_batch, batch_id)
            return
        single = batch.get("single_token")
        if single:
            for op_id in list(batch["operation_ids"]):
                panel.bind_operation_id(single, op_id)
        for _op_id, cached in self._batches.replayable(batch_id, batch.get("core_batch_id")):
            if cached:
                self._route_operation_event(cached)
        self._batches.mark_ids_final(batch)
        for group in batch["groups"]:
            panel.mark_operations_final(group["token"])
        if self._batch_finished(batch) and not batch.get("core_batch_id"):
            self._finish_operation_batch_ui(batch_id, batch)
            return
        # Per-operation notifications are best-effort UI hints. Always poll the
        # durable Core batch as an independent source of truth so one dropped
        # terminal event cannot leave a small batch at 2/3 = 67% forever.
        elif batch.get("core_batch_id"):
            self.root.after(0, self._poll_operation_batch, batch_id)

    def _release_batch_overlay_holds(self, batch):
        if not batch:
            return
        panel = batch.get("panel")
        if not panel:
            return
        release = getattr(panel, "set_operation_cleanup_hold", None)
        if not callable(release):
            return
        for group in batch.get("groups") or []:
            release(group.get("token"), False)

    def _finish_operation_batch_ui(self, batch_id, batch=None):
        batch = batch or self._operation_batches.get(batch_id or "")
        if not batch or batch.get("ui_finished"):
            return
        last_error = str(batch.get("last_error") or "").strip()
        if last_error:
            self._fail_operation_batch(
                batch_id,
                {"code": "BATCH_PARTIAL_FAILURE", "message": last_error},
            )
            return
        batch["ui_finished"] = True
        panel = batch.get("panel")
        for group in batch.get("groups") or []:
            if not panel:
                continue
            if batch.get("aggregate_core"):
                total = max(1, int(batch.get("expected_operations") or 1))
                panel.update_batch_progress(group.get("token"), total, total, done=True)
            else:
                panel.complete_row_operation(group.get("token"))
        self._publish_batch_progress(batch)
        self._release_batch_overlay_holds(batch)
        self._release_batch_guard(batch)
        core_batch_id = str(batch.get("core_batch_id") or "")
        if core_batch_id:
            for key in list(self._cancel_requested_batches):
                if key.startswith(core_batch_id + "|"):
                    self._cancel_requested_batches.discard(key)
        self._set_batch_terminal_status(batch)
        # Refresh both panes only after durable batchStatus says done. The panel
        # reconciles the existing Treeview rows in place, so this does not blank
        # the file list or destroy selection while the RPC is in flight.
        self._schedule_panel_refresh()
        self.root.after(6000, self._cleanup_operation_batch, batch_id)

    def _release_batch_guard(self, batch):
        """Drop the Copy guard for a batch. Returns True if one was held."""
        if not batch:
            return False
        guard = batch.get("guard")
        batch["guard"] = None
        if guard == "copy":
            self._set_copy_busy(False)
        return guard is not None

    def _poll_operation_batch(self, ui_batch_id):
        batch = self._operation_batches.get(ui_batch_id or "")
        if not batch or batch.get("batch_poll_inflight"):
            return
        if batch.get("ui_finished"):
            return
        if batch.get("core_generation") != self._core_generation:
            self._fail_operation_batch(ui_batch_id, {"code": "CORE_RESTARTED", "message": "Core lifecycle changed"})
            return
        core_batch_id = str(batch.get("core_batch_id") or "")
        if not core_batch_id or not self._core_ready:
            return
        batch["batch_poll_inflight"] = True
        generation = self._core_generation

        def ok(status):
            live = self._operation_batches.get(ui_batch_id or "")
            if not live or generation != self._core_generation or live.get("core_generation") != generation:
                return
            live["batch_poll_inflight"] = False
            live["poll_failures"] = 0
            status = status or {}
            try:
                total = int(status.get("total") or live.get("expected_operations") or 0)
                completed = int(status.get("completed") or 0)
            except (TypeError, ValueError, AttributeError):
                err({"code": "INVALID_RESPONSE", "message": "Некорректный operation.batchStatus"})
                return
            done = bool(status.get("done"))
            # batchStatus is persisted by JournalStore, so it is the durable
            # source of truth when one or more best-effort UI events were lost.
            previous_completed = int(live.get("last_completed") or 0)
            if completed > previous_completed:
                live["idle_polls"] = 0
            else:
                live["idle_polls"] = min(16, int(live.get("idle_polls") or 0) + 1)
            live["last_completed"] = completed
            if live.get("aggregate_core"):
                panel = live.get("panel")
                for group in live.get("groups") or []:
                    if panel:
                        panel.update_batch_progress(group.get("token"), completed, total, done=done)
            if done:
                last_error = str(live.get("last_error") or "").strip()
                if last_error:
                    self._fail_operation_batch(
                        ui_batch_id,
                        {"code": "BATCH_PARTIAL_FAILURE", "message": last_error},
                    )
                else:
                    # If a terminal operation.state event was dropped, durable
                    # completion still has to converge the row to 100% before
                    # the overlay hold is released.
                    if not self._batch_finished(batch):
                        panel = live.get("panel")
                        for group in live.get("groups") or []:
                            if panel:
                                panel.complete_row_operation(group.get("token"))
                    self._finish_operation_batch_ui(ui_batch_id, live)
            else:
                idle = int(live.get("idle_polls") or 0)
                delay = min(5000, 350 * (2 ** min(idle, 4)))
                self.root.after(delay, self._poll_operation_batch, ui_batch_id)

        def err(error):
            live = self._operation_batches.get(ui_batch_id or "")
            if not live or generation != self._core_generation or live.get("core_generation") != generation:
                return
            live["batch_poll_inflight"] = False
            failures = int(live.get("poll_failures") or 0) + 1
            live["poll_failures"] = failures
            if failures >= 10:
                self._fail_operation_batch(ui_batch_id, error or {"code": "POLL_FAILED", "message": "Batch status unavailable"})
                return
            self.root.after(1000, self._poll_operation_batch, ui_batch_id)

        self.bridge.call(
            "operation.batchStatus",
            {"batchId": core_batch_id},
            on_ok=ok,
            on_err=err,
            timeout=10,
        )

    def _batch_finished(self, batch):
        return self._batches.is_finished(batch)

    def _fail_operation_batch(self, batch_id, error):
        batch = self._operation_batches.get(batch_id or "")
        if not batch:
            return
        text = self._err_text(error)
        for group in batch["groups"]:
            batch["panel"].fail_row_operation(group["token"], text)
        self._release_batch_overlay_holds(batch)
        self._release_batch_guard(batch)
        self.root.after(5500, self._cleanup_operation_batch, batch_id)

    @staticmethod
    def _batch_token_for_path(batch, relative_path):
        return match_operation_token(batch.get("groups") or [], relative_path)

    def _publish_batch_progress(self, batch):
        percent = self._batches.aggregate_percent(batch)
        if not self._batches.should_publish((batch or {}).get("ui_batch_id"), percent):
            return
        label = str(batch.get("label") or "")
        if label == t("syncing"):
            self._set_status(t("sync_progress", pct=percent))
        elif label == t("copying"):
            self._set_status(t("copy_progress", pct=percent))

    def _route_operation_event(self, payload):
        op_id = str((payload or {}).get("operationId") or "")
        if not op_id:
            return
        resolved = self._batches.resolve(payload)
        if resolved is None:
            # Either unattributable (cached by the controller for later replay)
            # or a compact-aggregate batch that drops per-file events on purpose.
            return
        batch, token, incoming = resolved
        batch_id = batch.get("ui_batch_id")
        self._batches.take_unrouted(op_id)
        self._batches.ingest(batch, token, op_id, incoming)
        batch["panel"].update_operation(op_id, incoming)
        self._publish_batch_progress(batch)

        state = str(incoming.get("state") or "")
        if state in ("done", "failed", "cancelled", "stale", "recovery-blocked"):
            self._cancel_requested_ids.discard(op_id)
        if state in ("failed", "stale") and incoming.get("error"):
            batch["last_error"] = self._err_text(incoming.get("error"))[:260]
        settled_before = len(batch.get("settled_ids") or ())
        self._batches.record_state(batch, op_id, state)

        guard_released = False
        if self._batches.guard_is_releasable(batch):
            guard_released = self._release_batch_guard(batch)

        if self._batch_finished(batch) and not batch.get("core_batch_id"):
            self._finish_operation_batch_ui(batch_id, batch)
            return
        # Progress events are the common case and must not re-evaluate the whole
        # control surface; only a settle transition or a real change matters.
        if guard_released or settled_before != len(batch.get("settled_ids") or ()):
            self._update_controls()

    def _terminal_operation_should_refresh_panels(self, payload):
        """Return False when a tracked UI batch owns the terminal refresh."""
        payload = payload or {}
        op_id = str(payload.get("operationId") or "")
        route = self._operation_batch_by_id.get(op_id) if op_id else None
        if route and self._operation_batches.get(route[0]):
            # Refresh a tracked multi-file copy once, when the batch converges,
            # instead of refreshing both panes once for every completed file.
            return False
        core_batch_id = str(payload.get("batchId") or "")
        ui_batch_id = self._ui_batch_by_core_id.get(core_batch_id) if core_batch_id else None
        if ui_batch_id and self._operation_batches.get(ui_batch_id):
            return False
        return True

    def _cleanup_operation_batch(self, batch_id):
        batch = self._operation_batches.pop(batch_id or "", None)
        if not batch:
            return
        self._release_batch_guard(batch)
        core_batch_id = str(batch.get("core_batch_id") or "")
        if core_batch_id:
            for key in list(self._cancel_requested_batches):
                if key == core_batch_id or key.startswith(core_batch_id + "|"):
                    self._cancel_requested_batches.discard(key)
        if core_batch_id and self._ui_batch_by_core_id.get(core_batch_id) == batch_id:
            self._ui_batch_by_core_id.pop(core_batch_id, None)
        for op_id in list(batch.get("operation_ids") or ()):
            route = self._operation_batch_by_id.get(op_id)
            if route and route[0] == batch_id:
                self._operation_batch_by_id.pop(op_id, None)
            self._unrouted_operation_events.pop(op_id, None)
        self._update_controls()

    def _check_recovery_conflicts(self):
        if not self._core_ready:
            return
        self._recovery_scan_generation += 1
        generation = self._recovery_scan_generation

        def fetch(cursor=None):
            if generation != self._recovery_scan_generation or not self._core_ready:
                return
            payload = {"limit": 128}
            if cursor:
                payload["cursor"] = cursor

            def ok(result):
                if generation != self._recovery_scan_generation:
                    return
                for row in (result or {}).get("operations") or []:
                    if row.get("recoveryConflict"):
                        self._offer_finalize_recovery(str(row.get("operationId") or ""))
                next_cursor = (result or {}).get("nextCursor")
                if next_cursor:
                    # Yield to Tk between journal pages; a crash with hundreds of
                    # conflicts must not monopolize the UI thread.
                    self.root.after_idle(fetch, next_cursor)

            self.bridge.call("operation.list", payload, on_ok=ok, on_err=lambda _e: None, timeout=30)

        fetch()

    def _reload_operation_state(self):
        """Reconcile dropped operation notifications from Core in bounded pages."""
        if not self._core_ready:
            return

        def fetch(cursor=None):
            payload = {"limit": 128}
            if cursor:
                payload["cursor"] = cursor

            def ok(result):
                for row in (result or {}).get("operations") or []:
                    self._route_operation_event(row)
                next_cursor = (result or {}).get("nextCursor")
                if next_cursor:
                    self.root.after_idle(fetch, next_cursor)

            self.bridge.call("operation.list", payload, on_ok=ok, on_err=lambda _e: None, timeout=30)

        fetch()

    def _reconcile_batch_statuses(self):
        """Recover compact batch completion when terminal events were dropped."""
        if not self._core_ready:
            return
        for ui_batch_id, batch in list(self._operation_batches.items()):
            core_batch_id = str(batch.get("core_batch_id") or "")
            if not core_batch_id:
                continue

            def ok(status, ui_batch_id=ui_batch_id):
                live = self._operation_batches.get(ui_batch_id)
                if not live or not (status or {}).get("done"):
                    return
                panel = live.get("panel")
                for group in live.get("groups") or []:
                    if panel:
                        panel.complete_row_operation(group.get("token"))
                self._release_batch_guard(live)
                self.root.after(6000, self._cleanup_operation_batch, ui_batch_id)

            self.bridge.call(
                "operation.batchStatus",
                {"batchId": core_batch_id},
                on_ok=ok,
                on_err=lambda _e: None,
                timeout=10,
            )

    def _offer_finalize_recovery(self, operation_id):
        operation_id = str(operation_id or "")
        if not operation_id:
            return
        deferred_until = float(self._recovery_deferred.get(operation_id) or 0.0)
        if deferred_until > time.monotonic():
            return
        if deferred_until:
            self._recovery_deferred.pop(operation_id, None)
        if operation_id in self._recovery_prompting or operation_id in self._recovery_queued:
            return
        self._recovery_queue.append(operation_id)
        self._recovery_queued.add(operation_id)
        self.root.after_idle(self._drain_finalize_recovery_queue)

    def _drain_finalize_recovery_queue(self):
        if self._recovery_prompt_active or not self._core_ready:
            return
        while self._recovery_queue:
            operation_id = self._recovery_queue.popleft()
            self._recovery_queued.discard(operation_id)
            deferred_until = float(self._recovery_deferred.get(operation_id) or 0.0)
            if deferred_until > time.monotonic():
                continue
            self._recovery_deferred.pop(operation_id, None)
            break
        else:
            return

        self._recovery_prompt_active = True
        self._recovery_prompting.add(operation_id)

        def clear_and_continue():
            self._recovery_prompting.discard(operation_id)
            self._recovery_prompt_active = False
            self.root.after_idle(self._drain_finalize_recovery_queue)

        def info_ok(info):
            def show_dialog():
                try:
                    action = show_finalize_recovery(self.root, info or {})
                except (tk.TclError, RuntimeError):
                    action = None
                if not action:
                    # A dismissal is not permanent. Re-offer later in a long-lived
                    # tray session instead of hiding a recovery conflict forever.
                    self._recovery_deferred[operation_id] = time.monotonic() + 600.0
                    clear_and_continue()
                    return

                def resolved(result):
                    self._recovery_deferred.pop(operation_id, None)
                    preserved = str((result or {}).get("preservedPath") or "")
                    if preserved:
                        self._set_status(t("recovery_done_extra", path=preserved), "success")
                    else:
                        self._set_status(t("recovery_done"), "success")
                    self._schedule_panel_refresh()
                    clear_and_continue()

                def resolve_error(error):
                    self._note(self._err_text(error), "error")
                    clear_and_continue()

                self.bridge.call(
                    "operation.resolveFinalizeConflict",
                    {"operationId": operation_id, "action": action},
                    on_ok=resolved,
                    on_err=resolve_error,
                    timeout=60,
                )

            # Never enter a modal Tk loop while CoreBridge is draining results.
            self.root.after_idle(show_dialog)

        def info_error(_error):
            clear_and_continue()

        self.bridge.call(
            "operation.recoveryInfo",
            {"operationId": operation_id},
            on_ok=info_ok,
            on_err=info_error,
            timeout=30,
        )

    # ---------- roots / peers ----------
    def _reload_roots(self):
        def local_ok(result):
            self.left.set_roots((result or {}).get("roots") or [])
            self._restore_local_panel_if_pending()

        self.bridge.call(
            "roots.listLocal",
            {},
            on_ok=local_ok,
            on_err=lambda e: self._note("Не удалось загрузить локальные папки: %s" % self._err_text(e), "error"),
        )
        self._reload_remote_roots()

    def _restore_local_panel_if_pending(self):
        state = self._saved_left_panel_state
        if state is None:
            return
        self._saved_left_panel_state = None
        self.left.restore_location(state)

    def _restore_remote_panel_if_pending(self):
        state = self._saved_right_panel_state
        if state is None:
            return
        saved_peer_id = str(state.get("peerId") or "").lower()
        if not saved_peer_id or saved_peer_id != (self._peer_id or ""):
            return
        self._saved_right_panel_state = None
        self.right.restore_location(state)

    def _peer_by_id(self, peer_id):
        if not peer_id:
            return None
        needle = str(peer_id).lower()
        for peer in self.peers:
            if str(peer.get("id", "")).lower() == needle:
                return peer
        return None

    def _peer_online(self, peer_id):
        peer = self._peer_by_id(peer_id)
        return bool(peer and peer.get("online"))

    def _require_selected_peer_online(self):
        if self._peer_online(self._peer_id):
            return True
        self._note(t("device_offline"), "warning")
        self._poke_selected_peer()
        return False

    def _poke_selected_peer(self):
        if not self._peer_id:
            return
        now = time.monotonic()
        if now < self._next_peer_poke_at:
            return
        self._next_peer_poke_at = now + PEER_RECONNECT_POKE_SECONDS
        self.bridge.call("peer.poke", {"id": self._peer_id})

    def _refresh_peer_box(self):
        labels = [peer_row_label(peer, self._peer_aliases) for peer in self.peers]
        try:
            self.peer_box["values"] = labels
            self.peer_box.configure(state="readonly" if labels and self._core_ready else "disabled")
        except tk.TclError:
            return
        if not labels:
            self.peer_var.set("")
            return
        selected_idx = -1
        if self._peer_id:
            for idx, peer in enumerate(self.peers):
                if str(peer.get("id", "")).lower() == self._peer_id:
                    selected_idx = idx
                    break
        if selected_idx < 0:
            selected_idx = 0
        self.peer_var.set(labels[selected_idx])
        try:
            self.peer_box.current(selected_idx)
        except tk.TclError:
            pass

    def _on_peer_presence(self, payload):
        if not self._core_ready:
            return
        peer_id = str((payload or {}).get("id") or "").lower()
        online = bool((payload or {}).get("online"))
        connection_type = (payload or {}).get("connectionType")
        prev_online = self._peer_online(peer_id)
        if apply_presence_to_peers(self.peers, peer_id, online, connection_type):
            self._refresh_peer_box()
            if peer_id == (self._peer_id or ""):
                if online and not prev_online:
                    self._clear_transient_peer_status()
                    self._reload_remote_roots()
                elif prev_online and not online:
                    self._cancel_remote_roots_retry()
                    self._remote_roots_generation += 1
                    self._set_status(t("device_offline"), "warning")
                    self._poke_selected_peer()
            self._update_controls()
        self._request_peers()

    def _cancel_remote_roots_retry(self):
        handle = self._remote_roots_retry_after
        self._remote_roots_retry_after = None
        if handle is None:
            return
        try:
            self.root.after_cancel(handle)
        except tk.TclError:
            pass

    def _clear_transient_peer_status(self):
        current = str(self.status_var.get() or "")
        prefixes = (t("remote_folders_failed"), t("device_offline"), t("load_failed"))
        if any(current == prefix or current.startswith(prefix) for prefix in prefixes):
            self._set_status(t("status_ready"), "success")

    def _reload_remote_roots(self, retry_index=0):
        self._cancel_remote_roots_retry()
        self._remote_roots_generation += 1
        generation = self._remote_roots_generation
        peer_id = self._peer_id
        if not peer_id:
            self.right.set_roots([])
            return
        if not self._peer_online(peer_id):
            if not self.right.roots:
                self.right.set_roots([])
            return

        def ok(result):
            if generation != self._remote_roots_generation or self._peer_id != peer_id:
                return
            self._cancel_remote_roots_retry()
            self.right.set_roots((result or {}).get("roots") or [])
            self._restore_remote_panel_if_pending()
            self._clear_transient_peer_status()

        def err(error):
            if generation != self._remote_roots_generation or self._peer_id != peer_id:
                return
            if is_offline_error(error) and retry_index < len(REMOTE_ROOTS_RETRY_MS):
                delay = REMOTE_ROOTS_RETRY_MS[retry_index]
                self._remote_roots_retry_after = self.root.after(
                    delay,
                    lambda idx=retry_index + 1: self._reload_remote_roots(idx),
                )
                return
            if self.right.roots:
                self._note(
                    t("device_offline") if is_offline_error(error) else "%s: %s" % (t("remote_folders_failed"), self._err_text(error)),
                    "warning",
                )
                return
            self.right.set_roots([])
            if is_offline_error(error):
                self._note(t("device_offline"), "warning")
            else:
                self._note("%s: %s" % (t("remote_folders_failed"), self._err_text(error)), "error")

        self.bridge.call("roots.browse", {"peerId": peer_id}, on_ok=ok, on_err=err)

    def _issue_peer_list(self, _stamp, _settle, on_ok, on_err):
        self.bridge.call("peer.list", {}, on_ok=on_ok, on_err=on_err, timeout=15.0)

    def _poll_peer_status(self):
        if not self._core_ready:
            return
        now = time.monotonic()
        if now < self._next_peer_refresh_at:
            return
        self._next_peer_refresh_at = now + PEER_STATUS_REFRESH_SECONDS
        self._request_peers(poke_selected=True)

    def _reload_peers(self):
        self._request_peers(poke_selected=True)

    def _request_peers(self, poke_selected=False):
        """Fetch the peer list, coalescing bursts of refresh requests.

        Every `peer.presence` event used to issue its own `peer.list` RPC; the
        stamp guard only discarded stale *responses*, so a flapping peer could
        drive one round trip per event. `PeerListRefresher` collapses the burst
        into at most one follow-up.
        """
        if not self._core_ready:
            return

        def on_ok(result):
            self._apply_peers(result)
            if poke_selected and self._peer_id and not self._peer_online(self._peer_id):
                self._poke_selected_peer()

        def on_err(error):
            # A poll or poke failure is already surfaced by its own status; only
            # report the plain user-triggered reload.
            if not poke_selected:
                self._note(self._err_text(error), "error")

        self._peer_refresher.request(on_ok=on_ok, on_err=on_err)

    def _apply_peers(self, result):
        if not self._core_ready:
            return
        prev_id = self._peer_id
        prev_online = self._peer_online(prev_id)
        self.peers = (result or {}).get("peers") or []
        if not self.peers:
            self._announce_update_after_peers = False
            self._refresh_peer_box()
            self._select_peer(None)
            return

        selected = None
        selected_idx = -1
        if self._peer_id:
            for idx, peer in enumerate(self.peers):
                if str(peer.get("id", "")).lower() == self._peer_id:
                    selected = peer
                    selected_idx = idx
                    break
        if selected is None:
            selected = self.peers[0]
            selected_idx = 0

        self._refresh_peer_box()
        if selected_idx >= 0:
            try:
                self.peer_box.current(selected_idx)
            except tk.TclError:
                pass
        peer_id = str(selected.get("id", "")).lower()
        saved_remote = self._saved_right_panel_state
        if saved_remote is not None:
            saved_peer_id = str(saved_remote.get("peerId") or "").lower()
            if saved_peer_id and saved_peer_id != peer_id:
                # Only a real selection change may discard the pending restore.
                # An automatically chosen fallback (no saved peer matched) must
                # keep it, otherwise the remembered folder is lost on a poll
                # that merely ran before the saved peer was in the list.
                explicit = prev_id is not None and prev_id != peer_id
                if explicit or self._peer_id_explicitly_selected:
                    self._saved_right_panel_state = None
        went_offline = bool(prev_online) and peer_id == (prev_id or "") and not selected.get("online")
        if went_offline:
            self._cancel_remote_roots_retry()
            self._remote_roots_generation += 1
            self._set_status(t("device_offline"), "warning")
            self._poke_selected_peer()
        self._select_peer(selected, reload_roots=should_reload_remote_roots(prev_id, prev_online, selected))
        if self._announce_update_after_peers:
            self._announce_update_after_peers = False
            self._announce_update_check()

    def _on_peer(self, _evt=None):
        idx = self.peer_box.current()
        if 0 <= idx < len(self.peers):
            peer = self.peers[idx]
            self._peer_id_explicitly_selected = True
            saved_remote = self._saved_right_panel_state
            if saved_remote is not None:
                saved_peer_id = str(saved_remote.get("peerId") or "").lower()
                selected_peer_id = str(peer.get("id") or "").lower()
                if saved_peer_id and selected_peer_id != saved_peer_id:
                    self._saved_right_panel_state = None
            self._select_peer(peer)

    def _select_peer(self, peer, reload_roots=True):
        self._peer_id = str(peer.get("id")).lower() if peer else None
        name = peer_display_name(peer, self._peer_aliases) if peer else None
        device_name = peer_device_name(peer) if peer else None
        self.left.set_access_peer(self._peer_id, name)
        self.right.set_peer(self._peer_id, name, device_name=device_name)
        self.chat.set_peer(self._peer_id, name)
        if reload_roots:
            self._reload_remote_roots()
        self._update_controls()

    def _rename_connected_peer(self, peer_id, text):
        peer = self._peer_by_id(peer_id)
        if not peer:
            return
        self._peer_aliases = set_peer_alias(
            self._peer_aliases,
            peer_id,
            text,
            device_name=peer_device_name(peer),
        )
        try:
            save_peer_aliases(self._peer_aliases)
        except OSError as exc:
            self._note(str(exc), "error")
            return
        self._refresh_peer_box()
        self._select_peer(peer, reload_roots=False)

    def _best_update(self):
        return best_available_update(
            self.peers,
            comparable_app_version(self.app_version, self.build_label),
            self.build_label,
            preferred_peer_id=self._peer_id,
            current_revision=self.release_revision,
        )

    def _announce_update_check(self):
        if self._update_busy:
            return
        kind, info = update_check_summary(
            self.peers,
            comparable_app_version(self.app_version, self.build_label),
            self.build_label,
            current_revision=self.release_revision,
        )
        if not kind:
            return
        label = release_label((info or {}).get("appVersion"), (info or {}).get("buildLabel"))
        if kind == "offer":
            self._set_status(t("update_offer", version=label), "success")
            return
        if kind == "none":
            if label:
                self._set_status(t("update_none", version=label))
            else:
                self._set_status(t("update_none_plain"))
            return
        if kind == "no_info":
            self._set_status(t("update_no_info"), "warning")
            return
        if kind == "newer_unavailable":
            self._set_status(t("update_newer_unavailable", version=label), "warning")
            return
        if kind == "incompatible":
            self._set_status(t("update_incompatible", version=label), "warning")
            return
        if kind == "unverified":
            self._set_status(t("update_unverified", version=label), "warning")
            return
        if kind == "untrusted_source":
            self._set_status(t("update_untrusted_source", version=label), "warning")

    def _refresh_update_button(self):
        if self._update_busy:
            try:
                self._update_btn.grid()
                self._update_btn.configure(state="disabled")
            except tk.TclError:
                pass
            return
        update = self._best_update()
        try:
            if update and self._core_ready:
                self._update_btn.configure(text="Есть обновление", state="normal")
                self._update_btn.grid()
            else:
                self._update_btn.configure(text="Есть обновление", state="disabled")
                self._update_btn.grid_remove()
        except tk.TclError:
            pass

    def _request_update(self):
        update = self._best_update()
        if self._update_busy or not update:
            return
        # Keep the ordinary click unchanged: it still shows the update-source
        # confirmation.  Shift+click is the deliberate fast path requested for
        # trusted peers: download, verify, install and restart without the
        # extra confirmation dialog.  The installer callback below performs
        # the same version/trust/signature/hash checks in both modes.
        quick_restart = shift_is_down()
        peer_id = update.get("peerId")
        if not peer_id:
            return
        peer = self._peer_by_id(peer_id) or {}
        peer_name = peer_display_name(peer, self._peer_aliases) if peer else peer_id[:12]
        if not quick_restart and not show_update_request(
            self.root,
            peer_name,
            release_label(update.get("appVersion"), update.get("buildLabel")),
            str(update.get("sha256") or ""),
            signature_verified=update.get("signatureVerified") is True,
            signature_required=update.get("signatureRequired") is True,
        ):
            return
        self._update_busy = True
        self._update_source_peer_id = peer_id
        self._update_btn.configure(text="Получение обновления…", state="disabled")
        self._update_btn.grid()
        if quick_restart:
            self._set_status("Получение обновления… После установки PeerSync перезапустится.")
        else:
            self._set_status("Получение обновления…")

        def ok(result):
            try:
                if not callable(self.on_update_ready):
                    raise RuntimeError("Установщик обновления недоступен")
                self._update_btn.configure(text="Установка…", state="disabled")
                self._set_status("Проверка и установка обновления…")
                started = self.on_update_ready(result or {})
                if started is False:
                    raise RuntimeError("Не удалось запустить установщик обновления")
            except Exception as exc:  # noqa: BLE001
                self._update_busy = False
                self._update_source_peer_id = None
                self._refresh_update_button()
                self._note(str(exc), "error")

        def err(error):
            self._update_busy = False
            self._update_source_peer_id = None
            self._refresh_update_button()
            self._note(self._err_text(error), "error")

        self.bridge.call(
            "update.request",
            {"peerId": peer_id},
            on_ok=ok,
            on_err=err,
            timeout=1800,
        )

    def update_install_failed(self, error):
        """Return a background installer failure to the Tk-owned UI state."""
        self._update_busy = False
        self._update_source_peer_id = None
        self._refresh_update_button()
        self._note(str(error), "error")

    def _selected_peer_name(self):
        peer = self._peer_by_id(self._peer_id)
        if peer:
            return peer_display_name(peer, self._peer_aliases)
        return self._peer_id[:12] if self._peer_id else None

    def _forget_peer(self):
        if not self._peer_id:
            return
        if not messagebox.askyesno("PeerSync by Nickston", t("confirm_forget"), parent=self.root):
            return
        peer_id = self._peer_id

        def ok(_result):
            if self._peer_id == peer_id:
                self._peer_id = None
            self._peer_aliases = set_peer_alias(self._peer_aliases, peer_id, "")
            try:
                save_peer_aliases(self._peer_aliases)
            except OSError:
                pass
            self._reload_roots()
            self._reload_peers()
            self._set_status("Устройство забыто; его разрешения отозваны", "success")

        self.bridge.call("peer.forget", {"id": peer_id}, on_ok=ok, on_err=lambda e: self._note(self._err_text(e), "error"))

    # ---------- pairing ----------
    def _create_code(self):
        def ok(result):
            code = (result or {}).get("code") or ""
            self._set_status(t("pair_searching_host"), "success")
            show_pair_code(self.root, code)

        self.bridge.call("pairing.createCode", {}, on_ok=ok, on_err=lambda e: self._note(self._err_text(e), "error"), timeout=90.0)

    def _join_code(self):
        code = show_pair_join(self.root)
        if not code:
            return
        self.bridge.call(
            "pairing.joinCode",
            {"code": code},
            on_ok=lambda _r: self._set_status(t("join_started"), "success"),
            on_err=lambda e: self._note(self._err_text(e), "error"),
            timeout=90.0,
        )

    def _on_pairing(self, payload):
        event = payload.get("event")
        role = payload.get("role")
        if event == "searching":
            self._set_status(t("pair_searching_host" if role == "host" else "pair_searching_join"), "success")
        elif event == "connected":
            self._set_status(t("pair_connected"), "success")
        elif event == "waiting-confirmation":
            self._set_status(t("pair_waiting_host" if role == "host" else "pair_waiting_join"), "warning")
        elif event == "request" and role == "host":
            pending_id = str(payload.get("pendingId") or "").lower()
            if not pending_id or self._pair_prompt_pending_id:
                return
            self._pair_prompt_pending_id = pending_id
            self._set_status(t("pair_waiting_host"), "warning")

            def prompt_pair_request():
                try:
                    accepted, mine = show_pair_request(
                        self.root,
                        payload.get("name") or "—",
                        payload.get("deviceType") or "unknown",
                        payload.get("fingerprint") or pending_id,
                        timeout_ms=60_000,
                    )
                finally:
                    self._pair_prompt_pending_id = None

                if accepted:
                    self._set_status(t("pair_finishing"), "success")
                    self.bridge.call(
                        "pairing.accept",
                        {"pendingId": pending_id, "mine": bool(mine)},
                        on_ok=lambda _r: self._set_status(t("pair_finishing"), "success"),
                        on_err=lambda e: self._note(self._err_text(e), "error"),
                    )
                else:
                    self.bridge.call(
                        "pairing.decline",
                        {"pendingId": pending_id},
                        on_ok=lambda _r: self._set_status("Связывание отклонено", "warning"),
                        on_err=lambda e: self._note(self._err_text(e), "error"),
                    )

            # _on_pairing itself is called by the event drain; return first.
            self.root.after_idle(prompt_pair_request)
        elif event == "confirmed":
            self._reload_peers()
            self._set_status(t("pair_confirmed"), "success")
        elif event == "declined":
            self._set_status("Связывание не завершено", "warning")
        elif event == "expired":
            self._set_status(t("pair_timeout"), "warning")

    # ---------- shared folders / ACL ----------
    def _add_root(self):
        choice = show_add_folder(self.root)
        if not choice:
            return
        path = choice["path"]
        name = choice["name"]

        def added(result):
            root_info = (result or {}).get("root") or {}
            root_id = root_info.get("rootId")
            self._reload_roots()
            if not root_id or not self._peer_id:
                self._set_status(t("folder_added_readonly"), "success")
                return
            peer_name = self._selected_peer_name()
            decision = show_root_access(self.root, peer_name, current_write=False)
            if decision is None or decision is False:
                self._set_status(t("folder_added_readonly"), "success")
                return
            self._set_peer_write(root_id, self._peer_id, True, added=True)

        self.bridge.call(
            "roots.addLocal",
            {"path": path.replace("/", "\\"), "name": name, "perms": {"read": True, "write": False}},
            on_ok=added,
            on_err=lambda e: self._note(self._err_text(e), "error"),
        )

    def _remove_root(self):
        root = self.left.action_root()
        root_id = str((root or {}).get("rootId") or "")
        if not root_id:
            self._note(t("no_folder"), "warning")
            return
        if not messagebox.askyesno("PeerSync by Nickston", t("confirm_remove_folder"), parent=self.root):
            return
        self.bridge.call(
            "roots.removeLocal",
            {"rootId": root_id},
            on_ok=lambda _r: self._reload_roots(),
            on_err=lambda e: self._note(self._err_text(e), "error"),
        )

    def _edit_root_access(self):
        root = self.left.action_root()
        if not root or not self._peer_id:
            self._note(t("no_peer") if not self._peer_id else t("no_folder"), "warning")
            return
        allowed = self._peer_id in {str(x).lower() for x in (root.get("peerWritePeers") or [])}
        decision = show_root_access(self.root, self._selected_peer_name(), current_write=allowed)
        if decision is None or decision == allowed:
            return
        self._set_peer_write(root.get("rootId"), self._peer_id, decision)

    def _set_peer_write(self, root_id, peer_id, allowed, added=False):
        def ok(_result):
            self._reload_roots()
            if added and allowed:
                self._set_status(t("folder_added_write", peer=self._selected_peer_name()), "success")
            else:
                self._set_status(t("permission_saved"), "success")

        self.bridge.call(
            "roots.setPeerPerms",
            {"rootId": root_id, "peerId": peer_id, "perms": {"write": bool(allowed)}},
            on_ok=ok,
            on_err=lambda e: self._note("Не удалось сохранить разрешение: %s" % self._err_text(e), "error"),
        )

    # ---------- copy / sync ----------
    def _copy_ltr(self):
        self._copy(self.left, self.right)

    def _copy_rtl(self):
        self._copy(self.right, self.left)

    def _set_copy_busy(self, busy):
        self._copy_busy = bool(busy)
        self._update_controls()

    def _copy(self, src_panel, dest_panel):
        if self._copy_busy or self._sync_busy:
            return
        entries = list(src_panel.selected_entries() or [])
        if not entries:
            self._note(t("no_selection"), "warning")
            return
        # Rows in the synthetic "All folders" view identify exported roots,
        # not copyable filesystem entries. Enter a root before copying files;
        # whole-root transfer is available through Sync.
        if src_panel.is_virtual_root_view():
            self._note(t("open_folder_for_copy"), "warning")
            return
        dest = dest_panel.effective_target()
        source_target = src_panel.effective_target()
        if dest.get("peerId") or source_target.get("peerId"):
            if not self._require_selected_peer_online():
                return
        if not dest.get("rootId"):
            self._note(t("pick_one_folder") if dest_panel.is_virtual_root_view() else t("no_folder"), "warning")
            return
        if dest.get("peerId") and not dest_panel.remote_write_allowed():
            self._note(t("remote_read_only"), "warning")
            return

        # The guard covers local preflight/collision handling and Core admission.
        # After fs.copy is accepted, Core owns the durable transfer lifecycle and
        # the UI tracks it independently by batch/operation IDs. Keeping this
        # transient guard until terminal transfer state would make an offline or
        # parked operation disable every new Copy/Sync action indefinitely.
        self._set_copy_busy(True)
        if shift_is_down():
            self._start_copy(src_panel, entries, dest, "overwrite")
            return
        # The panel is a sliding presentation window, not the destination
        # namespace. Always ask Core for the selected basenames so collision
        # semantics are independent of which directory rows happen to be visible.
        self._copy_stat_then_start(src_panel, dest_panel, entries, dest)

    def _copy_stat_then_start(self, src_panel, dest_panel, entries, dest):
        """Preflight collisions in bounded batches instead of N fs.stat RPCs."""
        self._set_status(t("copy_checking"), "info")
        state = {"offset": 0, "hits": [], "error": None}
        chunk_size = STAT_BATCH_CHUNK_SIZE

        def finish():
            if state["error"] is not None:
                self._set_copy_busy(False)
                if is_offline_error(state["error"]):
                    self._poke_selected_peer()
                self._note(self._err_text(state["error"]), "error")
                return
            self._copy_after_collisions(src_panel, dest_panel, entries, dest, state["hits"])

        def launch_next():
            if state["error"] is not None or state["offset"] >= len(entries):
                finish()
                return
            batch_entries = entries[state["offset"]:state["offset"] + chunk_size]
            state["offset"] += len(batch_entries)
            targets = [dest_stat_target(dest, entry_basename(entry)) for entry in batch_entries]

            def ok(result, sources=batch_entries):
                rows = (result or {}).get("results") if isinstance(result, dict) else None
                if not isinstance(rows, list) or len(rows) != len(sources):
                    state["error"] = {"code": "INVALID_RESPONSE", "message": "Некорректный ответ fs.statBatch"}
                    finish()
                    return
                for source, row in zip(sources, rows):
                    row = row if isinstance(row, dict) else {}
                    item_error = row.get("error")
                    if isinstance(item_error, dict):
                        if str(item_error.get("code") or "").upper() != "NOT_FOUND":
                            state["error"] = item_error
                            break
                        continue
                    dest_entry = row.get("entry")
                    if dest_entry:
                        state["hits"].append({
                            "source": source,
                            "dest": dest_entry,
                            "name": entry_basename(source),
                        })
                launch_next()

            def stat_one_by_one(index=0):
                # Compatibility path for an older Core that does not implement
                # fs.statBatch. Keep every selected source in the copy plan; the
                # fallback only changes how destination collisions are checked.
                if index >= len(targets):
                    launch_next()
                    return
                source = batch_entries[index]
                target = targets[index]

                def one_ok(result):
                    dest_entry = (result or {}).get("entry") if isinstance(result, dict) else None
                    if dest_entry:
                        state["hits"].append({
                            "source": source,
                            "dest": dest_entry,
                            "name": entry_basename(source),
                        })
                    stat_one_by_one(index + 1)

                def one_err(error):
                    if error_code(error) == "NOT_FOUND":
                        stat_one_by_one(index + 1)
                        return
                    state["error"] = error
                    finish()

                self.bridge.call("fs.stat", {"target": target}, on_ok=one_ok, on_err=one_err, timeout=30)

            def err(error):
                if error_code(error) in ("UNSUPPORTED", "INVALID_REQUEST"):
                    stat_one_by_one()
                    return
                state["error"] = error
                finish()

            self.bridge.call("fs.statBatch", {"targets": targets}, on_ok=ok, on_err=err, timeout=30)

        if not entries:
            finish()
            return
        launch_next()

    def _copy_after_collisions(self, src_panel, dest_panel, entries, dest, collisions):
        def continue_copy():
            collision = "rename"
            next_entries = entries
            if collisions:
                try:
                    decision = show_copy_collision(self.root, collisions)
                except (tk.TclError, RuntimeError):
                    self._set_copy_busy(False)
                    return
                plan = apply_copy_decision(entries, collisions, decision)
                if plan is None:
                    self._set_copy_busy(False)
                    return
                if plan["empty"]:
                    self._set_copy_busy(False)
                    self._note(t("copy_all_skipped"), "warning")
                    return
                next_entries = plan["entries"]
                collision = plan["collision"]
            self._start_copy(src_panel, next_entries, dest, collision)

        if collisions:
            # Collision dialogs may be reached from a CoreBridge result drain.
            # Leave that drain before entering Tk's nested modal event loop.
            self.root.after_idle(continue_copy)
        else:
            continue_copy()

    def _start_copy(self, src_panel, entries, dest, collision):
        items = copy_items_for_panel(
            src_panel.is_local,
            src_panel.peer_id,
            src_panel.root_id,
            entries,
        )
        # A directory copy can legitimately spend up to ten minutes freezing
        # its 100k-file manifest inside Core. Do that as an explicit phase so
        # fs.copy admission itself never owns one short 120 s RPC deadline.
        directories = [
            (item, entry)
            for item, entry in zip(items, entries)
            if entry_kind(entry) == "dir"
        ]
        if not directories:
            self._submit_copy(src_panel, entries, dest, collision, items)
            return

        self._set_status(t("copy_checking"), "info")
        state = {"index": 0, "scan_ids": [], "prepared_files": 0}

        def cleanup_prepared():
            for scan_id in list(state["scan_ids"]):
                self.bridge.call(
                    "fs.manifest",
                    {"action": "cancel", "scanId": scan_id},
                    timeout=10,
                )
            state["scan_ids"].clear()

        def fail(error):
            cleanup_prepared()
            self._set_copy_busy(False)
            if is_offline_error(error):
                self._poke_selected_peer()
            self._note(self._err_text(error), "error")

        def launch_next():
            if state["index"] >= len(directories):
                self._submit_copy(src_panel, entries, dest, collision, items)
                return
            item, _entry = directories[state["index"]]
            state["index"] += 1

            def ok(result, prepared_item=item):
                scan_id = str((result or {}).get("scanId") or "") if isinstance(result, dict) else ""
                if not scan_id:
                    fail({"code": "INVALID_RESPONSE", "message": "Некорректный ответ fs.manifest"})
                    return
                try:
                    file_count = max(0, int((result or {}).get("fileCount") or 0))
                except (TypeError, ValueError):
                    fail({"code": "INVALID_RESPONSE", "message": "Некорректный размер fs.manifest"})
                    return
                if state["prepared_files"] + file_count > COPY_MAX_FILES:
                    self.bridge.call(
                        "fs.manifest",
                        {"action": "cancel", "scanId": scan_id},
                        timeout=10,
                    )
                    fail({"code": "LIMIT_EXCEEDED", "message": "Слишком много файлов для одной операции копирования"})
                    return
                prepared_item["preScanId"] = scan_id
                state["scan_ids"].append(scan_id)
                state["prepared_files"] += file_count
                launch_next()

            self.bridge.call(
                "fs.manifest",
                {
                    "action": "start",
                    "target": dict(item.get("source") or {}),
                    "purpose": "copy",
                    "maxEntries": max(1, COPY_MAX_FILES - state["prepared_files"]),
                },
                on_ok=ok,
                on_err=fail,
                timeout=COPY_MANIFEST_TIMEOUT,
            )

        launch_next()

    def _submit_copy(self, src_panel, entries, dest, collision, items):
        def cleanup_pre_scans():
            for item in items:
                scan_id = str((item or {}).get("preScanId") or "")
                if not scan_id:
                    continue
                self.bridge.call(
                    "fs.manifest",
                    {"action": "cancel", "scanId": scan_id},
                    timeout=10,
                )

        batch_id = self._begin_operation_batch(src_panel, entries, t("copying"))
        batch = self._operation_batches.get(batch_id or "")
        if not batch:
            cleanup_pre_scans()
            self._set_copy_busy(False)
            self._note(t("error"), "error")
            return
        batch["guard"] = "copy"

        def ok(result):
            result = result or {}
            op_ids = result.get("operationIds") or []
            accepted = result.get("acceptedCount")
            self._register_operation_batch(batch_id, op_ids, accepted, result.get("batchId"))
            self._release_batch_guard(batch)
            try:
                count = int(accepted) if accepted is not None else len(op_ids)
            except (TypeError, ValueError):
                count = len(op_ids)
            self._set_status(t("started_transfers", count=count), "success")

        def err(error):
            cleanup_pre_scans()
            self._fail_operation_batch(batch_id, error)
            if is_offline_error(error):
                self._poke_selected_peer()
            self._note(self._err_text(error), "error")

        self.bridge.call(
            "fs.copy",
            {"destination": dest, "items": items, "collision": collision},
            on_ok=ok,
            on_err=err,
            timeout=COPY_ADMISSION_TIMEOUT,
        )
        src_panel.focus_file_list()

    def _sync_ltr(self):
        self._sync(self.left, self.right)

    def _sync_rtl(self):
        self._sync(self.right, self.left)

    def _set_sync_busy(self, busy):
        self._sync_busy = bool(busy)
        self._update_controls()

    def _clear_sync_compare(self, batch_id=None):
        token = batch_id if batch_id is not None else self._sync_batch_id
        batch = self._operation_batches.get(token or "")
        if batch:
            preview_id = str(batch.get("preview_id") or "")
            if preview_id:
                self._cancel_requested_ids.discard("preview:" + preview_id)
            panel = batch.get("panel")
            for group in batch.get("groups") or []:
                if panel:
                    panel.clear_row_operation(group.get("token"))
            self._cleanup_operation_batch(token)
        if self._sync_batch_id == token:
            self._sync_batch_id = None

    def _sync(self, src_panel, dest_panel):
        if self._sync_busy:
            return
        skip_confirm = shift_is_down()
        src = dict(src_panel.effective_target())
        dst = dict(dest_panel.effective_target())
        raw_selected = list(src_panel.selected_entries() or [])
        sync_entries = list(src_panel.sync_source_entries() or [])
        selected_source = pick_sync_source_entries(
            sync_entries,
            overlay_entry=None if src_panel.is_virtual_root_view() else src_panel.active_folder_operation_entry(),
            cwd=src_panel.rel or "",
        )
        if dst.get("peerId") or src.get("peerId"):
            if not self._require_selected_peer_online():
                return
        if not dst.get("peerId") and not src.get("peerId"):
            self._note(t("no_peer"), "warning")
            return
        if not src.get("rootId"):
            self._note(t("pick_one_folder") if src_panel.is_virtual_root_view() else t("no_folder"), "warning")
            return
        if not dst.get("rootId"):
            self._note(t("pick_one_folder") if dest_panel.is_virtual_root_view() else t("no_folder"), "warning")
            return
        if dst.get("peerId") and not dest_panel.remote_write_allowed():
            self._note(t("remote_read_only"), "warning")
            return
        # A selected synthetic destination row only chooses the destination
        # endpoint. It must not be interpreted as a subdirectory inside it.
        dest_entries = [] if dest_panel.is_virtual_root_view() else dest_panel.selected_entries()
        src_rel, dest_rel, err = resolve_sync_pair(
            selected_source,
            dst.get("relativePath") or "",
            dest_entries,
        )
        if err:
            side = t("sync_side_left") if src_panel is self.left else t("sync_side_right")
            self._note(t(err, side=side, selected=format_selection(raw_selected)), "warning")
            return
        src["relativePath"] = src_rel
        dst["relativePath"] = dest_rel
        sync_entry = dir_entry(src_rel, (selected_source[0].get("name") if selected_source else None))

        self._set_sync_busy(True)
        self._set_status(t("sync_compare_source", count=0))
        batch_id = self._begin_operation_batch(
            src_panel,
            [sync_entry],
            t("sync_comparing"),
        )
        self._sync_batch_id = batch_id
        if batch_id:
            batch = self._operation_batches.get(batch_id)
            panel = (batch or {}).get("panel")
            for item in (batch or {}).get("groups") or []:
                if panel:
                    panel.set_compare_progress(item.get("token"), 0, "compare-source")

        def handle_preview(result):
            payload = result if isinstance(result, dict) else {}
            batch = self._operation_batches.get(batch_id or "")
            if batch:
                batch["preview_id"] = str(payload.get("previewId") or "") or None
                self._update_controls()
            totals = payload.get("totals")
            if not isinstance(totals, dict):
                self._clear_sync_compare(batch_id)
                self._set_sync_busy(False)
                self._note("Некорректные данные предварительного расчёта синхронизации", "error")
                return
            try:
                expected_bytes = max(0, int(totals.get("bytes") or 0))
                expected_files = max(0, int(totals.get("new") or 0)) + max(0, int(totals.get("changed") or 0))
            except (TypeError, ValueError):
                self._clear_sync_compare(batch_id)
                self._set_sync_busy(False)
                self._note("Некорректные данные предварительного расчёта синхронизации", "error")
                return
            if not skip_confirm:
                msg = (
                    "%s\n\n%s → %s\n\n%s: %s\n%s: %s\n%s: %s\n%s: %s"
                    % (
                        t("confirm_sync"),
                        src_rel or "/",
                        dest_rel or "/",
                        t("new_files"), totals.get("new", 0),
                        t("changed_files"), totals.get("changed", 0),
                        t("skipped_files"), totals.get("skipped", 0),
                        t("remote_only_files"), totals.get("remote-only", 0),
                    )
                )
                try:
                    accepted = bool(messagebox.askyesno(t("preview"), msg, parent=self.root))
                except tk.TclError:
                    accepted = False
                if not accepted:
                    preview_id = payload.get("previewId")
                    if preview_id:
                        self.bridge.call("fs.syncCancel", {"previewId": preview_id}, on_ok=lambda _r: None, on_err=lambda _e: None, timeout=10)
                    self._clear_sync_compare(batch_id)
                    self._set_sync_busy(False)
                    self._set_status(t("status_ready"), "success")
                    return

            batch = self._operation_batches.get(batch_id or "")
            if batch:
                batch["label"] = t("syncing")
                panel = batch.get("panel")
                for item in batch.get("groups") or []:
                    if panel:
                        panel.prepare_copy_progress(
                            item.get("token"),
                            expected_bytes=expected_bytes,
                            expected_files=expected_files,
                        )

            def started(res):
                res = res or {}
                op_ids = res.get("operationIds") or []
                self._register_operation_batch(batch_id, op_ids, res.get("acceptedCount"), res.get("batchId"))
                self._sync_batch_id = None
                self._set_sync_busy(False)
                live = self._operation_batches.get(batch_id)
                if live:
                    self._publish_batch_progress(live)
                else:
                    count = res.get("acceptedCount")
                    self._set_status(t("sync_started", count=int(count) if count is not None else len(op_ids)), "success")

            def start_error(error):
                self._fail_operation_batch(batch_id, error)
                self._sync_batch_id = None
                self._set_sync_busy(False)
                if is_offline_error(error):
                    self._poke_selected_peer()
                self._note(self._err_text(error), "error")

            self.bridge.call(
                "fs.syncStart",
                {"previewId": payload.get("previewId")},
                on_ok=started,
                on_err=start_error,
                timeout=180,
            )

        def on_preview(result):
            # Return from the bridge result drain before entering the modal
            # confirmation path. This keeps RPC/event draining responsive even
            # when the user leaves the preview confirmation open.
            self.root.after_idle(lambda value=result: handle_preview(value))

        def on_preview_error(error):
            self._clear_sync_compare(batch_id)
            self._set_sync_busy(False)
            if is_offline_error(error):
                self._poke_selected_peer()
            self._note(self._err_text(error), "error")

        self.bridge.call(
            "fs.syncPreview",
            {"source": src, "destination": dst},
            on_ok=on_preview,
            on_err=on_preview_error,
            timeout=180,
        )
        src_panel.focus_file_list()

    @staticmethod
    def _batch_operation_ids(batch):
        return operation_ids_of(batch)

    def _batch_is_active(self, batch):
        return self._batches.is_active(batch)

    def _active_batches(self):
        return self._batches.active_batches()

    def _selected_operation_groups(self):
        selected_tokens = set(self.left.selected_operation_tokens())
        selected_tokens.update(self.right.selected_operation_tokens())
        if not selected_tokens:
            return []
        terminal_states = {"done", "failed", "cancelled", "stale"}
        groups = []
        for batch in self._active_batches():
            core_batch_id = str(batch.get("core_batch_id") or "")
            for group in batch.get("groups") or []:
                if group.get("token") not in selected_tokens:
                    continue
                if str(group.get("state") or "") in terminal_states:
                    continue
                relative_path = str(group.get("path") or "").replace("\\", "/")
                cancel_key = core_batch_id + "|" + relative_path if core_batch_id else ""
                if cancel_key and cancel_key in self._cancel_requested_batches:
                    continue
                groups.append((batch, group))
        return groups

    def _stop_active_operations(self):
        selected_groups = self._selected_operation_groups()
        if not selected_groups:
            return
        self._set_status(t("stopping"))
        requested = 0
        for batch, group in selected_groups:
            ui_batch_id = next(
                (candidate_id for candidate_id, candidate in self._operation_batches.items() if candidate is batch),
                "",
            )
            core_batch_id = str(batch.get("core_batch_id") or "")
            if core_batch_id:
                relative_path = str(group.get("path") or "").replace("\\", "/")
                cancel_key = core_batch_id + "|" + relative_path
                if cancel_key in self._cancel_requested_batches:
                    continue
                self._cancel_requested_batches.add(cancel_key)
                self.bridge.call(
                    "operation.cancelBatch",
                    {
                        "batchId": core_batch_id,
                        "relativePath": relative_path,
                    },
                    on_ok=lambda _result: self._set_status(t("stop_requested"), "success"),
                    on_err=lambda error, key=cancel_key: self._cancel_failed(key, error),
                )
                requested += 1
                continue
            preview_id = str(batch.get("preview_id") or "")
            if preview_id:
                preview_key = "preview:" + preview_id
                self._cancel_requested_ids.add(preview_key)
                self.bridge.call(
                    "fs.syncCancel",
                    {"previewId": preview_id},
                    on_ok=lambda _result, batch_id=ui_batch_id: self._preview_cancelled(batch_id),
                    on_err=lambda error, key=preview_key: self._cancel_failed(key, error),
                )
                requested += 1
            for operation_id in (group.get("ops") or {}):
                if operation_id == "__batch__" or operation_id in self._cancel_requested_ids:
                    continue
                self._cancel_requested_ids.add(operation_id)
                self._cancel_operation(operation_id, announce=False)
                requested += 1
        if requested:
            self._update_controls()

    def _cancel_failed(self, key, error):
        key = str(key)
        if key.startswith("preview:") or key in self._cancel_requested_ids:
            self._cancel_requested_ids.discard(key)
        else:
            self._cancel_requested_batches.discard(key)
        self._note(self._err_text(error), "error")
        self._update_controls()

    def _preview_cancelled(self, ui_batch_id):
        self._cancel_requested_ids.discard("preview:" + str((self._operation_batches.get(ui_batch_id) or {}).get("preview_id") or ""))
        self._clear_sync_compare(ui_batch_id)
        if not self._active_batches():
            self._set_status(t("status_ready"), "success")
        self._update_controls()

    def _set_batch_terminal_status(self, batch):
        active = self._active_batches()
        if active:
            if self._cancel_requested_ids or self._cancel_requested_batches:
                self._set_status(t("stopping"))
            else:
                self._publish_batch_progress(active[-1])
            return
        label = str((batch or {}).get("label") or "")
        if label == t("syncing"):
            text = t("sync_done")
        elif label == t("copying"):
            text = t("copy_done")
        else:
            text = t("status_ready")
        self._set_status(text, "success")

    def _cancel_operation(self, operation_id, announce=True):
        def ok(result):
            if not bool((result or {}).get("pending")):
                self._cancel_requested_ids.discard(operation_id)
            if announce:
                self._set_status(t("stop_requested"), "success")
            self._update_controls()

        def err(error):
            self._cancel_requested_ids.discard(operation_id)
            if announce:
                self._note(self._err_text(error), "error")
            self._update_controls()

        self.bridge.call(
            "operation.cancel",
            {"operationId": operation_id},
            on_ok=ok,
            on_err=err,
        )

    def _schedule_panel_refresh(self):
        if self._refresh_after is not None:
            try:
                self.root.after_cancel(self._refresh_after)
            except tk.TclError:
                pass
        self._refresh_after = self.root.after(700, self._refresh_panels_after_batch)

    def _refresh_panels_after_batch(self):
        self._refresh_after = None
        self.left.refresh(preserve_view=True)
        self.right.refresh(preserve_view=True)

    def _refresh_visible_panels(self):
        """Refresh local and reachable remote panes while preserving the current view."""
        if not self._core_ready:
            return False
        refreshed = False
        if self.left.root_id:
            refreshed = self.left.request_refresh() or refreshed
        if (
            self.right.root_id
            and self._peer_id
            and self._peer_online(self._peer_id)
        ):
            refreshed = self.right.request_refresh() or refreshed
        return refreshed

    def _refresh_shortcut(self, _event=None):
        """Ctrl+R refreshes the focused file pane; elsewhere it refreshes both panes."""
        if not self._core_ready:
            return "break"
        if self.left.owns_focus():
            self.left.request_refresh()
        elif self.right.owns_focus():
            self.right.request_refresh()
        else:
            self._refresh_visible_panels()
        return "break"

    def _on_app_focus_out(self, _event=None):
        # FocusOut also happens while moving between widgets inside PeerSync.
        # Check on idle: only a real switch to another application leaves Tk
        # with no focused child.
        try:
            self.root.after_idle(self._mark_app_inactive_if_needed)
        except tk.TclError:
            pass

    def _mark_app_inactive_if_needed(self):
        try:
            if self.root.focus_get() is None:
                self._app_inactive = True
        except tk.TclError:
            pass

    def _on_app_focus_in(self, _event=None):
        if not self._app_inactive:
            return
        self._app_inactive = False
        if self._activation_refresh_after is not None:
            try:
                self.root.after_cancel(self._activation_refresh_after)
            except tk.TclError:
                pass
        try:
            # Explorer changes are therefore visible as soon as the user comes
            # back to PeerSync, without permanent polling or a Windows-only
            # watcher thread.  The manual button/Ctrl+R remains the fallback.
            self._activation_refresh_after = self.root.after(120, self._refresh_after_activation)
        except tk.TclError:
            self._activation_refresh_after = None

    def _refresh_after_activation(self):
        self._activation_refresh_after = None
        self._refresh_visible_panels()

    # ---------- responsive workspace ----------
    def _chat_is_visible(self):
        if self._narrow_mode:
            return bool(self._narrow_chat_open)
        return bool(self._chat_preference)

    def _toggle_chat(self):
        if self._narrow_mode:
            self._narrow_chat_open = not self._narrow_chat_open
        else:
            self._chat_preference = not self._chat_preference
        self._apply_layout_mode(force=True)

    def _widget_mapped(self, widget):
        try:
            return bool(widget.winfo_ismapped())
        except tk.TclError:
            return False

    def _apply_layout_mode(self, force=False):
        """Sync the workspace state with the place-based geometry manager.

        Narrow/wide is still derived from the root width, but every rectangle is
        now computed by ``WorkspaceLayout.layout()`` from a single state, so a
        chat toggle or a mode change lands as one frame instead of a grid change
        followed by a deferred sash correction.
        """
        try:
            width = int(self.root.winfo_width())
        except tk.TclError:
            return
        narrow = width < NARROW_WIDTH
        changed = narrow != self._narrow_mode
        if changed:
            self._narrow_mode = narrow
            if narrow:
                self._narrow_chat_open = False
        if not (force or changed or self._layout_ready is False):
            return
        try:
            if self._narrow_mode:
                self._pair_hint_label.pack_forget()
            elif not self._pair_hint_label.winfo_ismapped():
                self._pair_hint_label.pack(anchor="w", pady=(5, 0))
        except tk.TclError:
            pass

        self.chat.set_compact_mode(self._narrow_mode)
        chat_visible = self._chat_is_visible()

        layout = self.workspace_layout
        # Write every state field first so a single layout() commits all of it;
        # the setters each relayout on their own, which would cost a pass per
        # state change and reintroduce intermediate frames.
        layout.min_pane = self._min_pane_width()
        layout.narrow_mode = self._narrow_mode
        # A chat change has to go through the anchoring setter, otherwise the
        # ratio keeps its share of the new (wider or narrower) file area and the
        # divider visibly slides across the cards.
        if layout.chat_visible != chat_visible:
            layout.set_chat_visible(chat_visible)
        else:
            layout.chat_visible = chat_visible
            layout.layout()

        self.right.set_chat_active(chat_visible)
        self.right.set_show_chat_visible(not (self._narrow_mode and self._narrow_chat_open))
        self._layout_ready = True

    def _layout_overlays(self):
        """Reposition row progress overlays for both panels, right now.

        Called once the workspace has committed its geometry and painting is on
        again, so an overlay never spends a frame at its pre-resize position.
        """
        for panel in (self.left, self.right):
            try:
                panel._overlay_after = None
                panel._layout_operation_overlays()
            except (AttributeError, tk.TclError):
                continue

    def _update_controls(self):
        ready = self._core_ready
        self._pair_btn.configure(state="normal" if ready else "disabled")
        self._join_btn.configure(state="normal" if ready else "disabled")
        self._forget_btn.configure(state="normal" if ready and self._peer_id else "disabled")
        if not ready:
            self.peer_box.configure(state="disabled")
        elif self.peers:
            self.peer_box.configure(state="readonly")

        ltarget = self.left.effective_target()
        rtarget = self.right.effective_target()
        lcopy = self.left.can_copy_source()
        rcopy = self.right.can_copy_source()
        lroot = bool(ltarget.get("rootId"))
        rroot = bool(rtarget.get("rootId") and self._peer_id)
        remote_writable = self.right.remote_write_allowed()
        peer_online = self._peer_online(self._peer_id)
        transfer_ok = ready and not self._sync_busy and not self._copy_busy and peer_online
        self._copy_ltr_btn.configure(state="normal" if transfer_ok and lcopy and rroot and remote_writable else "disabled")
        self._sync_ltr_btn.configure(state="normal" if transfer_ok and lroot and rroot and remote_writable else "disabled")
        self._copy_rtl_btn.configure(state="normal" if transfer_ok and rcopy and lroot and self._peer_id else "disabled")
        self._sync_rtl_btn.configure(state="normal" if transfer_ok and lroot and rroot else "disabled")
        self._stop_btn.configure(state="normal" if ready and self._selected_operation_groups() else "disabled")
        self._refresh_update_button()

    # ---------- restart + saved layout ----------
    def set_restart_busy(self, busy):
        self._restart_busy = bool(busy)
        try:
            self._restart_btn.configure(state="disabled" if self._restart_busy else "normal")
        except tk.TclError:
            pass

    def _restart(self):
        if self._restart_busy or not callable(self.on_restart):
            return
        try:
            started = self.on_restart()
            if started is False:
                return
            self._core_ready = False
            self._invalidate_core_lifecycle(t("core_starting"))
            self.set_restart_busy(True)
            self._set_status(t("core_starting"))
            self._update_controls()
        except Exception as exc:  # noqa: BLE001
            self.set_restart_busy(False)
            self._note(str(exc), "error")

    def _layout_path(self):
        return os.path.join(paths.data_root(), LAYOUT_NAME)

    def _on_root_configure(self, evt):
        if evt.widget is not self.root or evt.width < 200:
            return
        try:
            if str(self.root.state()) == "withdrawn":
                return
        except tk.TclError:
            return
        self._sync_maximize_button()
        width = int(evt.width)
        if abs(width - self._last_root_width) < 4:
            return
        self._last_root_width = width

        # The workspace derives every rectangle from the sash ratio, so it can be
        # relaid out on every Configure without a deferred correction: the
        # divider tracks its ratio for the whole drag instead of jumping to it
        # once the burst ends.  The narrow/wide switch still needs the debounce,
        # because Windows emits a burst while maximizing/restoring and a mode
        # flip on every intermediate frame looks like jitter.
        if self._layout_after is not None:
            try:
                self.root.after_cancel(self._layout_after)
            except tk.TclError:
                pass
        self._layout_after = self.root.after(140, self._finish_resize)

    def _on_workspace_configure(self, evt):
        """Re-apply the sash ratio the instant the workspace knows its new size.

        The root's <Configure> arrives before the pack manager resizes the
        workspace, so reading the width there yields the previous frame's value.
        This handler runs after that, which is what makes the divider follow the
        resize instead of catching up to it.
        """
        if evt.widget is not self.workspace or evt.width < 80:
            return
        try:
            if str(self.root.state()) == "withdrawn":
                return
        except tk.TclError:
            return
        try:
            self.workspace_layout.layout()
        except tk.TclError:
            pass

    def _finish_resize(self):
        self._layout_after = None
        self._apply_layout_mode()
        # Persist the final geometry. Ratio and chat state are read straight off
        # the workspace, so there is no separate sash-capture pass any more.
        self._save_layout()

    def _min_pane_width(self):
        """Smallest pane that still shows a complete folder row.

        ``grid`` keeps every toolbar control at its requested width, so a pane
        narrower than that pushed the combo and the action buttons past the card
        border and across the sash.  Clamp the sash to whatever the two panels
        actually need instead of the old fixed guess.
        """
        need = MIN_PANE
        for panel in (getattr(self, "left", None), getattr(self, "right", None)):
            try:
                need = max(need, int(panel.minimum_content_width()))
            except (AttributeError, tk.TclError, TypeError, ValueError):
                continue
        # The grab band around the painted rule is what used to be the card padx.
        return need

    def _apply_splits(self):
        """Apply the saved sash ratio to the place-based workspace.

        Kept as the single entry point callers already use (startup, show_window
        and the old resize path); it no longer touches a Panedwindow.
        """
        try:
            if str(self.root.state()) == "withdrawn":
                return False
        except tk.TclError:
            return False
        try:
            if not self._widget_mapped(self.workspace):
                return False
        except tk.TclError:
            return False
        ratios = self._sash_ratios.get(2) or even_ratios(2)
        if len(ratios) != 1:
            ratios = even_ratios(2)
        layout = self.workspace_layout
        layout.min_pane = self._min_pane_width()
        layout.sash_ratio = max(0.0, min(1.0, float(ratios[0])))
        layout.layout()
        return True

    def _capture_ratios(self, _evt=None):
        """Read the live divider position back into the saved ratio."""
        layout = getattr(self, "workspace_layout", None)
        if layout is None:
            return
        try:
            total = int(self.workspace.winfo_width())
        except tk.TclError:
            return
        if total <= 40:
            return
        self._sash_ratios[2] = [max(0.0, min(1.0, layout.sash_ratio))]

    def _save_layout(self):
        try:
            if str(self.root.state()) == "withdrawn":
                return
        except tk.TclError:
            return
        try:
            self._capture_ratios()
            state = capture_window_state(self.root) or {}
            geometry = state.get("geometry") or self.root.geometry()
            maximized = bool(state.get("maximized")) if "maximized" in state else is_maximized(self.root)
            self._want_maximized = maximized
            with open(self._layout_path(), "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "layoutVersion": LAYOUT_VERSION,
                        "sashRatiosByCount": {"2": self._sash_ratios.get(2, even_ratios(2))},
                        "chat": self._chat_preference,
                        "theme": "dark" if self._dark_mode else "light",
                        "geometry": geometry,
                        "maximized": maximized,
                        "panels": {
                            "left": self._location_to_persist(self.left, self._saved_left_panel_state),
                            "right": {
                                **self._location_to_persist(
                                    self.right, self._saved_right_panel_state
                                ),
                                "peerId": self._location_peer_id_to_persist(),
                            },
                        },
                    },
                    fh,
                )
        except (OSError, tk.TclError):
            pass

    def _location_to_persist(self, panel, pending):
        """Location to write to disk, preferring a not-yet-applied restore.

        A panel that has not been restored yet still reports the empty root
        overview, because its roots are only known after the Core answers. A
        save that races that window (startup resize, theme toggle, closing to
        tray) would overwrite the remembered folder with the empty state, so
        the pending restore is persisted verbatim until it is applied.
        """
        if pending is not None:
            return {
                "rootId": str(pending.get("rootId") or ""),
                "relativePath": str(pending.get("relativePath") or ""),
            }
        location = panel.persistent_location()
        return {
            "rootId": str(location.get("rootId") or ""),
            "relativePath": str(location.get("relativePath") or ""),
        }

    def _location_peer_id_to_persist(self):
        if self._saved_right_panel_state is not None:
            return str(self._saved_right_panel_state.get("peerId") or "")
        return self._peer_id or ""

    def _apply_saved_maximized(self):
        try:
            if str(self.root.state()) == "withdrawn":
                return
        except tk.TclError:
            return
        apply_saved_maximized(self.root, self._want_maximized)
        self._sync_maximize_button()

    def _restore_layout(self):
        try:
            with open(self._layout_path(), encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            return
        geo = doc.get("geometry")
        if isinstance(geo, str):
            clamped = self._clamp_geometry(geo)
            if clamped:
                try:
                    self.root.geometry(clamped)
                except tk.TclError:
                    pass
        self._want_maximized = doc.get("maximized") is True
        self._chat_preference = doc.get("chat") is not False
        panels = doc.get("panels") if isinstance(doc.get("panels"), dict) else {}
        self._saved_left_panel_state = self._normalize_panel_state(panels.get("left"), remote=False)
        self._saved_right_panel_state = self._normalize_panel_state(panels.get("right"), remote=True)
        if self._saved_right_panel_state:
            saved_peer_id = str(self._saved_right_panel_state.get("peerId") or "").lower()
            if saved_peer_id:
                self._peer_id = saved_peer_id
        # Layout schema 2 is the first version where chat is not a third sash.
        # Ratios saved by older builds therefore do not describe this workspace
        # and must not make the two file panels start at 60/40 or 63/37.
        # A legacy/missing schema deliberately migrates to exactly 50/50 once;
        # subsequent manual sash changes are saved and restored normally.
        self._sash_ratios[2] = restored_ratios(doc, 2, LAYOUT_VERSION)

    @staticmethod
    def _normalize_panel_state(value, remote=False):
        if not isinstance(value, dict):
            return None
        root_id = str(value.get("rootId") or "")
        relative_path = str(value.get("relativePath") or "").replace("\\", "/").strip("/")
        state = {"rootId": root_id, "relativePath": relative_path}
        if remote:
            peer_id = str(value.get("peerId") or "").lower()
            if not peer_id:
                return None
            state["peerId"] = peer_id
        return state

    def _clamp_geometry(self, geometry):
        match = re.match(r"^(\d+)x(\d+)([+-]\d+)([+-]\d+)$", geometry or "")
        if not match:
            return None
        width, height, x, y = (int(value) for value in match.groups())
        try:
            vx = int(self.root.winfo_vrootx())
            vy = int(self.root.winfo_vrooty())
            vw = max(820, int(self.root.winfo_vrootwidth()))
            vh = max(480, int(self.root.winfo_vrootheight()))
        except tk.TclError:
            return None
        width = min(max(820, width), vw)
        height = min(max(480, height), vh)
        max_x = vx + max(0, vw - width)
        max_y = vy + max(0, vh - height)
        if x < vx or x > vx + vw - 120 or y < vy or y > vy + vh - 80:
            x = vx + max(0, (vw - width) // 2)
            y = vy + max(0, (vh - height) // 2)
        else:
            x = min(max(vx, x), max_x)
            y = min(max(vy, y), max_y)
        return "%dx%d%+d%+d" % (width, height, x, y)

    @staticmethod
    def _err_text(error):
        return error_text(error)
