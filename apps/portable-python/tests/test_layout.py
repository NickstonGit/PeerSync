import os
import unittest
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
REPO_ROOT = os.path.abspath(os.path.join(ROOT, "..", ".."))
sys.path.insert(0, ROOT)

from gui.layout import even_ratios, restored_ratios, sashes_from_ratios  # noqa: E402
from windows.chrome import maximized_placement, maximized_screen_rect, resize_hit_test, HTCLIENT, HTTOPLEFT, HTRIGHT  # noqa: E402


class LayoutTests(unittest.TestCase):
    def _read(self, *parts):
        with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
            return fh.read()

    def test_three_columns_are_even(self):
        self.assertEqual(even_ratios(3), [1 / 3, 2 / 3])
        self.assertEqual(sashes_from_ratios(900, even_ratios(3)), [300, 600])

    def test_two_columns_are_half(self):
        self.assertEqual(even_ratios(2), [0.5])
        self.assertEqual(sashes_from_ratios(800, even_ratios(2)), [400])

    def test_legacy_two_pane_ratio_is_migrated_to_half(self):
        legacy = {"sashRatiosByCount": {"2": [0.63]}}
        self.assertEqual(restored_ratios(legacy, 2, 2), [0.5])

    def test_current_two_pane_manual_ratio_is_preserved(self):
        current = {"layoutVersion": 2, "sashRatiosByCount": {"2": [0.61]}}
        self.assertEqual(restored_ratios(current, 2, 2), [0.61])

    def test_main_window_persists_layout_schema_for_half_split_migration(self):
        src = self._read("gui", "main_window.py")
        self.assertIn('LAYOUT_VERSION = 2', src)
        self.assertIn('"layoutVersion": LAYOUT_VERSION', src)
        self.assertIn('self._sash_ratios[2] = restored_ratios(doc, 2, LAYOUT_VERSION)', src)

    def test_file_panel_locations_are_persisted_in_layout(self):
        main = self._read("gui", "main_window.py")
        panel = self._read("gui", "panel.py")
        self.assertIn('"panels": {', main)
        self.assertIn("persistent_location()", main)
        self.assertIn("def _location_peer_id_to_persist", main)
        self.assertIn("def persistent_location(self):", panel)
        self.assertIn("def restore_location(self, state):", panel)

    def test_saved_panel_locations_wait_for_roots_and_fallback_safely(self):
        main = self._read("gui", "main_window.py")
        panel = self._read("gui", "panel.py")
        self.assertIn("self._saved_left_panel_state", main)
        self.assertIn("self._saved_right_panel_state", main)
        self.assertIn("self._restore_local_panel_if_pending()", main)
        self.assertIn("self._restore_remote_panel_if_pending()", main)
        self.assertIn("self._restore_fallback_stage = 2 if self.rel else (1 if self.root_id else 0)", panel)
        self.assertIn("if self._restore_fallback_stage:", panel)

    def test_layout_save_keeps_a_panel_location_that_is_not_restored_yet(self):
        # A panel only learns its roots after the Core answers, so before the
        # pending restore is applied it still reports the empty root overview.
        # Saving that empty state (startup resize, theme toggle, close to tray)
        # used to overwrite the remembered folder, so the next start opened the
        # root instead of the folder the user had open.
        main = self._read("gui", "main_window.py")
        self.assertIn("def _location_to_persist(self, panel, pending):", main)
        self.assertIn("if pending is not None:", main)
        self.assertIn(
            '"left": self._location_to_persist(self.left, self._saved_left_panel_state)',
            main,
        )
        self.assertIn(
            "**self._location_to_persist(\n                                    self.right, self._saved_right_panel_state\n                                )",
            main,
        )

    def test_layout_save_keeps_the_remembered_peer_for_an_unrestored_right_panel(self):
        main = self._read("gui", "main_window.py")
        self.assertIn("def _location_peer_id_to_persist(self):", main)
        self.assertIn('return str(self._saved_right_panel_state.get("peerId") or "")', main)
        self.assertNotIn('"peerId": self._peer_id or "",', main)

    def test_automatic_peer_fallback_does_not_discard_a_pending_remote_restore(self):
        # peer.list can briefly return an empty list right after startup. The
        # fallback selection that follows must not be treated as the user
        # switching peers, or the remembered remote folder is lost.
        main = self._read("gui", "main_window.py")
        self.assertIn("self._peer_id_explicitly_selected = False", main)
        self.assertIn("if explicit or self._peer_id_explicitly_selected:", main)
        on_peer = main[main.index("    def _on_peer(self"):main.index("    def _select_peer(self")]
        self.assertIn("self._peer_id_explicitly_selected = True", on_peer)

    def test_window_size_and_maximized_state_are_persisted(self):
        main = self._read("gui", "main_window.py")
        chrome = self._read("windows", "chrome.py")
        self.assertIn('capture_window_state', main)
        self.assertIn('"maximized": maximized', main)
        self.assertIn('self._want_maximized', main)
        self.assertIn('self._apply_saved_maximized', main)
        self.assertIn('def capture_window_state', chrome)
        self.assertIn('GetWindowPlacement', chrome)
        self.assertIn('def apply_saved_maximized', chrome)

    def test_custom_header_has_two_rows_and_geometrically_centered_brand(self):
        src = self._read("gui", "main_window.py")
        self.assertIn('header.columnconfigure(0, weight=1, uniform="header_side")', src)
        self.assertIn('header.columnconfigure(2, weight=1, uniform="header_side")', src)
        self.assertIn('width=BRAND_IMAGE_WIDTH', src)
        self.assertIn('grid_propagate(False)', src)
        self.assertIn('self.version_text = "PSN ver: %s" % build_label', src)
        self.assertIn('left_controls.grid(row=0, column=0, rowspan=2, sticky="w")', src)
        self.assertIn('self._version_label.grid(row=0, column=0, sticky="ew", pady=(0, 3))', src)
        self.assertIn('self._restart_btn.grid(row=1, column=0, sticky="ew")', src)
        self.assertIn('window_controls.grid(row=0, column=2, sticky="e", pady=(0, 3))', src)
        self.assertIn('app_controls.grid(row=1, column=2, sticky="e")', src)
        self.assertIn('exit_btn.grid(row=0, column=1, sticky="ew")', src)
        self.assertIn('width=8', src)
        self.assertIn('anchor="center"', src)
        self.assertIn('text="PeerSync by Nickston"', src)
        self.assertIn('variant="title"', src)
        self.assertIn('text="by nickston"', src)
        self.assertIn('command=self._minimize_window', src)
        self.assertIn('command=self._toggle_maximize', src)
        self.assertIn('command=self._on_close', src)
        self.assertNotIn('text="Передача файлов"', src)

    def test_design_tokens_keep_readable_type_and_compact_controls(self):
        design = self._read("gui", "design.py")
        theme = self._read("gui", "theme.py")
        button = self._read("gui", "button.py")
        self.assertIn('CONTROL_HEIGHT = 30', design)
        self.assertIn('CONTROL_HEIGHT_COMPACT = 28', design)
        self.assertIn('CONTROL_RADIUS = 8', design)
        self.assertIn('UI_FONT = ("Segoe UI", 11)', design)
        self.assertIn('TITLE_FONT = ("Segoe UI Semibold", 23)', design)
        self.assertIn('ENTRY_PADDING = (9, 1)', design)
        self.assertIn('UI_FONT = design.UI_FONT', theme)
        self.assertIn('padding=design.ENTRY_PADDING', theme)
        self.assertIn('_DEFAULT_HEIGHT = design.CONTROL_HEIGHT', button)
        self.assertIn('_RADIUS = design.CONTROL_RADIUS', button)
        self.assertIn('rowheight=25', theme)

    def test_enabled_buttons_have_visible_hover(self):
        theme = self._read("gui", "theme.py")
        button = self._read("gui", "button.py")
        self.assertIn('BUTTON_HOVER = "#dceaf8"', theme)
        self.assertIn('class AppButton(tk.Canvas):', button)
        self.assertIn('bind_class("ASNButton", "<Enter>"', button)
        self.assertIn('bind_class("ASNButton", "<Leave>"', button)
        self.assertIn('widget._hover = widget._state != "disabled"', button)
        self.assertIn('cursor="" if disabled else self._cursor_normal', button)
        self.assertIn('from gui.button import refresh_buttons', theme)
        self.assertIn('refresh_buttons(root)', theme)

    def test_surfaces_are_neither_white_on_grey_nor_grey_on_grey(self):
        src = self._read("gui", "theme.py")
        self.assertIn('APP_BG = "#d4dde5"', src)
        self.assertIn('SURFACE = "#e2e8ed"', src)
        self.assertIn('FIELD = "#eef2f5"', src)
        self.assertIn('BUTTON_BG = "#edf1f4"', src)
        self.assertNotIn('FIELD = "#ffffff"', src)
        self.assertNotIn('FIELD = APP_BG', src)

    def test_main_window_uses_custom_chrome_without_override_redirect(self):
        main = self._read("gui", "main_window.py")
        chrome = self._read("windows", "chrome.py")
        self.assertIn('enable_custom_chrome(self.root)', main)
        self.assertIn('drag_widget.bind("<B1-Motion>", self._continue_title_drag)', main)
        self.assertIn('move_window(self.root', main)
        self.assertNotIn('begin_window_drag(self.root)', main)
        self.assertIn('WS_CAPTION', chrome)
        self.assertIn('WS_THICKFRAME', chrome)
        self.assertIn('SWP_FRAMECHANGED', chrome)
        self.assertIn('WM_NCLBUTTONDOWN', chrome)
        self.assertIn('PostMessageW', chrome)
        self.assertNotIn('SendMessageW(ctypes.c_void_p(hwnd), WM_NCLBUTTONDOWN', chrome)
        self.assertIn('WM_GETMINMAXINFO', chrome)
        self.assertIn('rcWork', chrome)
        self.assertIn('MonitorFromWindow', chrome)
        self.assertIn('GWLP_WNDPROC', chrome)
        self.assertIn('fit_maximized_to_work_area', chrome)
        self.assertIn('WM_NCCALCSIZE', chrome)
        self.assertIn('WM_NCHITTEST', chrome)
        self.assertIn('resize_hit_test', chrome)
        self.assertNotIn('ChromeBorder.TFrame', main)
        self.assertNotIn('overrideredirect', main)
        self.assertNotIn('overrideredirect(', chrome)

    def test_maximized_window_uses_work_area_not_full_monitor(self):
        monitor = (0, 0, 1920, 1080)
        work = (0, 0, 1920, 1040)
        self.assertEqual(maximized_placement(monitor, work), (0, 0, 1920, 1040))
        self.assertEqual(maximized_screen_rect(work), (0, 0, 1920, 1040))
        self.assertLess(maximized_placement(monitor, work)[3], 1080)

        left_taskbar = (80, 0, 1920, 1080)
        self.assertEqual(maximized_placement(monitor, left_taskbar), (80, 0, 1840, 1080))
        self.assertEqual(maximized_screen_rect(left_taskbar), (80, 0, 1840, 1080))

    def test_panel_path_bar_is_full_width_left_aligned_and_rounded(self):
        theme = self._read("gui", "theme.py")
        panel = self._read("gui", "panel.py")
        self.assertIn('class PathBar(tk.Canvas):', panel)
        self.assertIn('self.path_bar.pack(fill="x", pady=(1, 5))', panel)
        self.assertIn('text=path, anchor="w"', panel)
        self.assertNotIn('Путь:', panel)
        # The access label keeps its right-aligned slot, but both labels are now
        # measured so a long path cannot run through it (Canvas never clips).
        self.assertIn('text=access, anchor="e"', panel)
        self.assertIn("fit_canvas_text(self, path, design.UI_FONT", panel)
        self.assertNotIn('style="Path.TLabel", anchor="e"', panel)
        design = self._read("gui", "design.py")
        self.assertIn('LABELFRAME_CAPTION_PADDING = (9, 0, 4, 2)', design)
        self.assertIn('padding=design.LABELFRAME_CAPTION_PADDING', theme)
        self.assertIn('relief="raised"', theme)
        self.assertIn('borderwidth=1', theme)
        self.assertIn('variant="icon"', panel)
        self.assertIn('load_button_icon(self, asset, dark=bool(dark))', panel)

    def test_file_panels_have_manual_and_focus_return_refresh(self):
        panel = self._read("gui", "panel.py")
        main = self._read("gui", "main_window.py")
        i18n = self._read("gui", "i18n.py")
        self.assertIn('command=self.request_refresh', panel)
        self.assertIn('def request_refresh(self):', panel)
        self.assertIn('self.refresh(preserve_view=True)', panel)
        self.assertIn('self.root.bind("<Control-r>", self._refresh_shortcut, add="+")', main)
        self.assertIn('self.root.bind("<FocusOut>", self._on_app_focus_out, add="+")', main)
        self.assertIn('self.root.bind("<FocusIn>", self._on_app_focus_in, add="+")', main)
        self.assertIn('self._refresh_visible_panels()', main)
        self.assertIn('"tip_refresh": "Обновить содержимое (Ctrl+R)"', i18n)

    def test_chat_is_a_real_docked_panel_not_a_third_sash(self):
        panel = self._read("gui", "panel.py")
        main = self._read("gui", "main_window.py")
        workspace = self._read("gui", "workspace.py")
        self.assertIn('variant="toggle_off"', panel)
        self.assertIn('variant="toggle_on" if self._chat_active else "toggle_off"', panel)
        self.assertIn('self.chat = ChatPanel(self.workspace', main)
        self.assertNotIn('self.panes.add(self.chat', main)
        # The chat gets its own dark rule, matching the sash between the cards,
        # so it no longer butts straight against the right card.  The rule is a
        # canvas-driven sash: a visible line inside a wider invisible grab band.
        self.assertIn('class ChatRule(tk.Canvas):', workspace)
        # The workspace owns every rectangle: cards, sash, chat rule and chat.
        self.assertIn('class WorkspaceLayout:', workspace)
        self.assertIn('self.workspace_layout = WorkspaceLayout(', main)
        self.assertNotIn('AppPanedWindow(', main)
        self.assertNotIn('self.chat_divider = AppFrame(', main)
        # One geometry function replaces grid/columnspan + a deferred sash apply.
        self.assertNotIn('columnspan=', main)
        self.assertNotIn('self.chat.grid_remove()', main)
        self.assertNotIn('_set_right_chat_gutter', main)
        self.assertNotIn('self.panes', main)
        self.assertIn('def layout(self):', workspace)
        # The sash is ratio-driven, so resize and drag read the same quantity.
        self.assertIn('self.sash_ratio', workspace)
        self.assertIn('class Sash(tk.Canvas):', workspace)
        # A chat toggle is one state change plus one layout pass, never a grid
        # rebuild followed by an idle sash correction.
        self.assertIn('layout.chat_visible = chat_visible', main)
        self.assertIn('layout.layout()', main)
        apply_layout = main[main.index('    def _apply_layout_mode'):main.index('    def _update_controls')]
        self.assertNotIn('after_idle(self._apply_splits)', apply_layout)
        self.assertIn('self.right.set_chat_active(chat_visible)', main)
        self.assertIn('def set_chat_unread(self, unread):', panel)
        self.assertNotIn('_animate_chat', main)

    def test_workspace_commits_geometry_as_one_frame(self):
        main = self._read("gui", "main_window.py")
        workspace = self._read("gui", "workspace.py")
        # Win32 WM_SETREDRAW brackets the whole batch so an intermediate grid
        # state can never be the frame the user sees.
        self.assertIn('def _begin_defer', workspace)
        self.assertIn('def _end_defer', workspace)
        self.assertIn('SendMessageW(ctypes.c_void_p(root), 11, 0, 0)', workspace)
        self.assertIn('SendMessageW(ctypes.c_void_p(root), 11, 1, 0)', workspace)
        self.assertIn('RedrawWindow', workspace)
        # Row progress overlays are laid out inside that same frozen batch
        # because they are measured against real Treeview cell geometry.
        self.assertIn('on_after_layout = self._layout_overlays', main)
        self.assertIn('def _layout_overlays(self):', main)
        # Resize keeps the sash at its ratio for the whole drag instead of
        # restoring it from a debounce after the user lets go.
        configure = main[main.index('    def _on_root_configure'):main.index('    def _finish_resize')]
        self.assertIn('self.workspace_layout.layout()', configure)
        self.assertIn('self.root.after(140, self._finish_resize)', configure)

    def test_resize_keeps_ratio_and_only_the_mode_switch_is_debounced(self):
        main = self._read("gui", "main_window.py")
        workspace = self._read("gui", "workspace.py")
        finish = main[main.index('    def _finish_resize'):main.index('    def _min_pane_width')]
        self.assertIn('self._apply_layout_mode()', finish)
        self.assertIn('self._save_layout()', finish)
        apply_split = main[main.index('    def _apply_splits'):main.index('    def _capture_ratios')]
        # The saved ratio feeds the workspace directly; no pixel sash remains.
        self.assertIn('layout.sash_ratio', apply_split)
        self.assertNotIn('self.panes.sashpos(0, pos)', apply_split)
        self.assertNotIn('for idx, pos', apply_split)
        # A manual drag cannot leave a pane narrower than its own toolbar: the
        # minimum is enforced while converting the pointer to a ratio.
        geometry = workspace[workspace.index('    def _sash_x'):workspace.index('    def layout')]
        self.assertIn('self.min_pane', geometry)
        self.assertIn('limit = max(0, usable - self.min_pane)', geometry)
        self.assertIn('return max(self.min_pane, min(limit, pos))', geometry)

    def test_active_transfer_has_stop_control_and_terminal_status(self):
        main = self._read("gui", "main_window.py")
        panel = self._read("gui", "panel.py")
        i18n = self._read("gui", "i18n.py")
        self.assertIn('self._stop_btn = AppButton(', main)
        self.assertIn('command=self._stop_active_operations', main)
        self.assertIn('"operation.cancelBatch"', main)
        self.assertIn('def selected_operation_tokens(self):', panel)
        self.assertIn('selected_tokens = set(self.left.selected_operation_tokens())', main)
        self.assertIn('"relativePath": relative_path', main)
        self.assertIn('self._set_batch_terminal_status(batch)', main)
        self.assertIn('"stop": "Остановить"', i18n)
        self.assertIn('"copy_done": "Копирование завершено"', i18n)
        self.assertIn('"sync_done": "Синхронизация завершена"', i18n)

    def test_row_progress_replaces_standalone_transfer_center(self):
        main = self._read("gui", "main_window.py")
        panel = self._read("gui", "panel.py")
        self.assertNotIn('TransferCenter(', main)
        self.assertNotIn('self.transfer_center', main)
        self.assertIn('def _begin_operation_batch', main)
        self.assertIn('def _route_operation_event', main)
        self.assertIn('def begin_row_operation', panel)
        self.assertIn('def update_operation', panel)
        self.assertIn('def _overlay_row_geometry(self, iid):', panel)
        self.assertIn('self.tree.bbox(iid, _OVERLAY_COLUMNS[0])', panel)
        self.assertIn('self.tree.bbox(iid, _OVERLAY_COLUMNS[-1])', panel)
        self.assertIn('canvas.create_rectangle(0, 0, fill_width, height', panel)

    def test_controls_allow_starting_another_operation_while_one_runs(self):
        main = self._read("gui", "main_window.py")
        update = main[main.index('    def _update_controls'):main.index('    # ---------- restart')]
        self.assertNotIn('_operation_batches', update)
        self.assertNotIn('_loading', update)
        self.assertIn('transfer_ok and lcopy and rroot', update)
        self.assertIn('not self._sync_busy and not self._copy_busy and peer_online', update)

        limits = os.path.join(REPO_ROOT, "packages", "core", "src", "portable", "limits.ts")
        with open(limits, encoding="utf-8") as fh:
            core_limits = fh.read()
        self.assertIn('CONCURRENT_TRANSFERS_PER_PEER = 2', core_limits)

    def test_small_copy_batches_poll_durable_status_and_hold_row_cleanup(self):
        main = self._read("gui", "main_window.py")
        panel = self._read("gui", "panel.py")
        register = main[main.index("    def _register_operation_batch"):main.index("    def _release_batch_guard")]
        poll = main[main.index("    def _poll_operation_batch"):main.index("    def _batch_finished")]
        self.assertIn('if batch.get("core_batch_id"):', register)
        self.assertIn('self.root.after(0, self._poll_operation_batch, batch_id)', register)
        self.assertIn('if batch["aggregate_core"]:', register)
        self.assertIn('self._finish_operation_batch_ui(ui_batch_id, live)', poll)
        self.assertIn('"hold_cleanup": False', panel)
        self.assertIn('def set_operation_cleanup_hold(self, token, hold):', panel)
        self.assertIn('if group.get("hold_cleanup"):', panel)

    def test_chat_input_has_inner_horizontal_inset_and_visible_disabled_send(self):
        theme = self._read("gui", "theme.py")
        chat = self._read("gui", "chat.py")
        design = self._read("gui", "design.py")
        self.assertIn('ENTRY_PADDING = (9, 1)', design)
        self.assertIn('padding=design.ENTRY_PADDING', theme)
        self.assertIn('DISABLED_BG = "#d1d9e0"', theme)
        self.assertIn('DISABLED_FG = "#697784"', theme)
        self.assertIn('self.send_btn.pack(side="right", padx=(6, 0))', chat)
        self.assertIn('font=design.UI_FONT', chat)
        self.assertIn('SMALL_FONT_SEMIBOLD = ("Segoe UI Semibold", 10)', design)

    def test_captionless_frame_keeps_resize_hit_zones_without_white_nonclient_frame(self):
        rect = (100, 100, 900, 700)
        self.assertEqual(resize_hit_test(rect, 102, 102, border=8), HTTOPLEFT)
        self.assertEqual(resize_hit_test(rect, 898, 400, border=8), HTRIGHT)
        self.assertEqual(resize_hit_test(rect, 500, 400, border=8), HTCLIENT)
        self.assertEqual(resize_hit_test(rect, 102, 102, border=8, maximized=True), HTCLIENT)

    def test_theme_toggle_persists_and_switches_wordmark_and_icons(self):
        main = self._read("gui", "main_window.py")
        theme = self._read("gui", "theme.py")
        spec = self._read("PSN.spec")
        button = self._read("gui", "button.py")
        self.assertIn('self._theme_btn = AppButton(', main)
        self.assertIn('command=self._toggle_theme', main)
        self.assertIn('"theme": "dark" if self._dark_mode else "light"', main)
        self.assertIn('peersync-wordmark-dark.png', main)
        self.assertIn('peersync-wordmark-light.png', main)
        self.assertIn('apply_contrast(self.root, dark=self._dark_mode)', main)
        self.assertIn('_DARK_PALETTE = {', theme)
        self.assertIn('class AppButton(tk.Canvas):', button)
        self.assertIn('_RADIUS = design.CONTROL_RADIUS', button)
        self.assertIn('def _rounded_box(', button)
        self.assertIn('def _palette(self):', button)
        self.assertIn('border = ctypes.c_uint(0xFFFFFFFE)', theme)
        self.assertNotIn('ChromeBorder.TFrame', theme)
        self.assertNotIn('_install_rounded_button_layout', theme)
        self.assertNotIn('button-bg', theme)
        self.assertIn('if build and build < 22000:', theme)
        self.assertIn('corners = ctypes.c_int(2)', theme)
        self.assertIn('for attr, value in ((33, corners), (34, border), (35, caption), (36, text)):', theme)
        self.assertIn('ui_icons_dir', spec)
        self.assertIn('name="PSN"', spec)
        self.assertNotIn('name="AS"', spec)

    def test_all_reusable_controls_flow_through_one_component_entrypoint(self):
        components = self._read("gui", "components.py")
        self.assertIn('from gui.button import AppButton', components)
        for cls in (
            "AppFrame", "AppLabel", "AppStatus", "AppEntry", "AppComboBox",
            "AppCard", "AppCheckBox", "AppTree", "AppScrollbar", "AppProgress",
            "AppPanedWindow", "AppDialogFrame",
        ):
            self.assertIn("class %s" % cls, components)

        for name in ("main_window.py", "panel.py", "chat.py", "pair_dialog.py", "transfer_center.py"):
            src = self._read("gui", name)
            self.assertIn("from gui.components import", src, name)
            for raw in (
                "ttk.Button(", "ttk.Entry(", "ttk.Combobox(", "ttk.LabelFrame(",
                "ttk.Label(", "ttk.Frame(", "ttk.Checkbutton(", "ttk.Progressbar(",
                "ttk.Scrollbar(", "ttk.Treeview(", "ttk.Panedwindow(",
            ):
                self.assertNotIn(raw, src, "%s still constructs %s directly" % (name, raw))

    def test_all_portable_buttons_still_use_one_appbutton_renderer(self):
        button_src = self._read("gui", "button.py")
        self.assertIn('class AppButton(tk.Canvas):', button_src)
        self.assertIn('def _palette(self):', button_src)
        self.assertIn('def _draw(self):', button_src)
        self.assertIn('def _sync_badge(self):', button_src)
        self.assertIn('def refresh_buttons(root):', button_src)
        for name in ("main_window.py", "panel.py", "chat.py", "pair_dialog.py", "transfer_center.py"):
            src = self._read("gui", name)
            self.assertNotIn("ttk.Button(", src, name)
            self.assertIn("AppButton", src, name)

    def test_button_draw_uses_antialiased_surface_for_clean_rounded_corners(self):
        button = self._read("gui", "button.py")
        draw = button[button.index("    def _draw(self):"):button.index("    def _sync_badge(self):")]
        self.assertIn("self._button_surface_image(", draw)
        self.assertIn('self.create_image(0, 0, image=surface_image, anchor="nw", tags="button")', draw)
        self.assertNotIn("self._rounded_box(0, 0", draw)

    def test_peersync_partial_names_and_online_retry_are_wired(self):
        core_path = os.path.join(REPO_ROOT, "packages", "core", "src", "portable", "fs-engine.ts")
        drive_path = os.path.join(REPO_ROOT, "packages", "drive", "src", "adapters", "disk-writer.ts")
        with open(core_path, encoding="utf-8") as fh:
            core = fh.read()
        with open(drive_path, encoding="utf-8") as fh:
            drive = fh.read()
        # Full name shapes, not bare substrings: a part name must end in `.part`,
        # and the collision suffix must start at (1) with no gap.
        self.assertIn('.peersync-part-${uuidv4()}.part', core)
        self.assertIn('${target}.peersync-prev-', core)
        self.assertIn('.peersync-conflict-', core)
        self.assertIn('.peersync-recovered-', core)
        # Both writers must take candidate names from the one shared loop, so
        # the suffix sequence cannot drift between the portable and package paths.
        self.assertIn('claimFreeName', core)
        self.assertIn('claimFreeName', drive)
        self.assertNotIn('${base} (${i + 1})${ext}', core)
        self.assertIn('PART_MARKER', drive)
        self.assertIn('LEGACY_PART_MARKER', drive)
        self.assertIn('if (row.initiatedLocally) {', core)
        self.assertIn('this.resumeOperation(operationId)', core)
        self.assertIn('attempt >= 12', core)

    def test_waiting_peer_batch_releases_copy_guard(self):
        controller = self._read("gui", "operation_controller.py")
        main = self._read("gui", "main_window.py")
        # The state machine moved into the Tk-free controller: a parked
        # transfer counts as settled for the guard, so Copy/Sync never stays
        # disabled forever while the durable journal owns resume.
        self.assertIn('elif state == "waiting-peer":', controller)
        self.assertIn("batch[\"settled_ids\"].add(op_id)", controller)
        self.assertIn("def guard_is_releasable", controller)
        self.assertIn("if self._batches.guard_is_releasable(batch):", main)
        self.assertIn("self._release_batch_guard(batch)", main)


    def test_status_bar_explains_readiness_without_internal_port(self):
        main = self._read("gui", "main_window.py")
        i18n = self._read("gui", "i18n.py")
        self.assertIn('self._set_status(t("core_online"), "success")', main)
        self.assertNotIn("localPort", main)
        self.assertNotIn("порт %s", main)
        self.assertIn('"core_online": "Готово к работе"', i18n)

    def test_unexpected_core_stop_restarts_and_clears_peer_online_state(self):
        main = self._read("gui", "main_window.py")
        app = self._read("app.py")
        i18n = self._read("gui", "i18n.py")
        offline = main[main.index("    def _set_peers_offline"):main.index("    def on_core_ready")]
        self.assertIn('peer["online"] = False', offline)
        self.assertIn("self._set_peers_offline()", main)
        self.assertIn("restart_core(automatic=True", app)
        self.assertIn('if holder.get("stopping")', app)
        self.assertIn("CORE_RESTART_MAX_ATTEMPTS", app)
        self.assertIn('"core_restarting"', i18n)

    def test_peer_poll_is_read_only_before_core_teardown(self):
        client = self._read("ipc", "core_client.py")
        self.assertIn('"peer.list"', client)
        self.assertIn('"getStatus"', client)
        self.assertIn('"ping"', client)


if __name__ == "__main__":
    unittest.main()
