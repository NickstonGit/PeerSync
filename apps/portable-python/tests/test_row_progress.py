import os
import unittest
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, ROOT)

from gui.panel import (  # noqa: E402
    _fmt_mtime_ms,
    capture_panel_view,
    match_operation_token,
    merge_operation_payload,
    operation_group_copy_complete,
    operation_group_percent,
    operation_group_display_percent,
    resolve_panel_view,
    sort_panel_entries,
)


class PanelColumnTests(unittest.TestCase):
    def test_mtime_uses_requested_short_local_format(self):
        stamp_ms = datetime(2026, 9, 16, 0, 59).timestamp() * 1000
        self.assertEqual(_fmt_mtime_ms(stamp_ms), "16.09.26 00:59")
        self.assertEqual(_fmt_mtime_ms(0), "")

    def test_entries_sort_by_name_size_and_date(self):
        rows = [
            {"name": "b.txt", "type": "file", "size": 20, "mtimeMs": 200},
            {"name": "Folder", "type": "dir", "size": 0, "mtimeMs": 300},
            {"name": "a.txt", "type": "file", "size": 10, "mtimeMs": 100},
        ]
        self.assertEqual([x["name"] for x in sort_panel_entries(rows, "name")], ["a.txt", "b.txt", "Folder"])
        self.assertEqual([x["name"] for x in sort_panel_entries(rows, "size")], ["Folder", "a.txt", "b.txt"])
        self.assertEqual([x["name"] for x in sort_panel_entries(rows, "date", True)], ["Folder", "b.txt", "a.txt"])
        self.assertEqual([x["name"] for x in sort_panel_entries(rows, "type")], ["Folder", "a.txt", "b.txt"])


class MatchTokenTests(unittest.TestCase):
    def test_file_under_selected_folder_matches(self):
        groups = [{"token": "t1", "path": "ProjectA"}]
        self.assertEqual(match_operation_token(groups, "ProjectA/readme.txt"), "t1")
        self.assertEqual(match_operation_token(groups, "ProjectA"), "t1")
        self.assertIsNone(match_operation_token(groups, "ProjectB/a.txt"))

    def test_longest_prefix_wins(self):
        groups = [
            {"token": "parent", "path": "src"},
            {"token": "child", "path": "src/app"},
        ]
        self.assertEqual(match_operation_token(groups, "src/app/main.py"), "child")

    def test_empty_source_row_matches_any_file(self):
        groups = [{"token": "root", "path": ""}]
        self.assertEqual(match_operation_token(groups, "PSN.exe"), "root")


class MergePayloadTests(unittest.TestCase):
    def test_state_event_does_not_drop_bytes(self):
        previous = {
            "operationId": "op1",
            "relativePath": "ProjectA/a.bin",
            "bytesDone": 4096,
            "bytesTotal": 8192,
            "state": "active",
        }
        incoming = {"operationId": "op1", "state": "active"}
        merged = merge_operation_payload(previous, incoming)
        self.assertEqual(merged["bytesDone"], 4096)
        self.assertEqual(merged["bytesTotal"], 8192)
        self.assertEqual(merged["relativePath"], "ProjectA/a.bin")

    def test_later_progress_overwrites_bytes(self):
        previous = {"bytesDone": 100, "bytesTotal": 1000}
        incoming = {"bytesDone": 400, "bytesTotal": 1000, "state": "active"}
        merged = merge_operation_payload(previous, incoming)
        self.assertEqual(merged["bytesDone"], 400)


class GroupPercentTests(unittest.TestCase):
    def test_expected_bytes_keep_folder_sync_from_looking_finished(self):
        group = {
            "state": "active",
            "expected_bytes": 1000,
            "ops": {
                "a": {"state": "active", "bytesDone": 100, "bytesTotal": 100},
            },
        }
        self.assertEqual(operation_group_percent(group), 10)

    def test_done_group_is_100(self):
        self.assertEqual(operation_group_percent({"state": "done", "ops": {}}), 100)

    def test_empty_active_group_is_zero(self):
        self.assertEqual(operation_group_percent({"state": "queued", "ops": {}}), 0)

    def test_comparing_group_is_zero(self):
        self.assertEqual(
            operation_group_percent({"state": "comparing", "compare_files": 40, "ops": {}}),
            0,
        )

    def test_display_percent_reserves_100_for_completion(self):
        active = {
            "state": "active",
            "expected_bytes": 10,
            "ops": {"a": {"state": "active", "bytesDone": 10, "bytesTotal": 10}},
        }
        waiting = dict(active)
        waiting["state"] = "waiting-peer"
        finalizing = dict(active)
        finalizing["state"] = "finalizing"
        done = dict(active)
        done["state"] = "done"
        self.assertEqual(operation_group_percent(active), 100)
        self.assertEqual(operation_group_display_percent(active), 99)
        self.assertEqual(operation_group_display_percent(waiting), 99)
        self.assertEqual(operation_group_display_percent(finalizing), 100)
        self.assertEqual(operation_group_display_percent(done), 100)

    def test_copy_complete_needs_ids_or_expected_bytes(self):
        unfinished = {
            "state": "active",
            "ids_final": False,
            "expected_bytes": 0,
            "ops": {"a": {"state": "done", "bytesDone": 10, "bytesTotal": 10}},
        }
        self.assertFalse(operation_group_copy_complete(unfinished))
        finished = {
            "state": "active",
            "ids_final": False,
            "expected_bytes": 10,
            "ops": {"a": {"state": "done", "bytesDone": 10, "bytesTotal": 10}},
        }
        self.assertTrue(operation_group_copy_complete(finished))
        self.assertFalse(operation_group_copy_complete({"state": "comparing", "ops": {}}))


class SyncProgressSourceTests(unittest.TestCase):
    def test_events_bind_before_sync_start_returns(self):
        path = os.path.join(ROOT, "gui", "main_window.py")
        controller_path = os.path.join(ROOT, "gui", "operation_controller.py")
        with open(path, encoding="utf-8") as fh:
            main = fh.read()
        with open(controller_path, encoding="utf-8") as fh:
            controller = fh.read()
        # The event-attribution step moved into the Tk-free controller.
        self.assertIn("def attach_to_batch", controller)
        self.assertIn("def resolve", controller)
        self.assertIn("ids_final", controller)
        self.assertIn("self._batches.resolve(payload)", main)
        self.assertIn("self._batches.create(", main)
        self.assertIn("sync_progress", main)
        self.assertIn("prepare_copy_progress", main)
        self.assertIn("expected_bytes=expected_bytes", main)

    def test_core_emits_compare_phases(self):
        path = os.path.join(ROOT, "..", "..", "packages", "core", "src", "portable", "fs-engine.ts")
        with open(os.path.normpath(path), encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("compare-source", src)
        self.assertIn("compare-dest", src)
        self.assertIn("emitCompare", src)


class OverlayGeometryTests(unittest.TestCase):
    """The progress overlay is a Canvas over a Treeview row.

    Canvas never clips text to a cell, so every label has to be measured and
    every column has to come from the real cell box.  These tests pin the
    geometry rules that keep the overlay inside its own row.
    """

    def _panel(self):
        with open(os.path.join(ROOT, "gui", "panel.py"), encoding="utf-8") as fh:
            return fh.read()

    def test_columns_come_from_real_cell_boxes_not_requested_widths(self):
        panel = self._panel()
        self.assertIn("def _row_column_boxes(self, iid, width, origin_x=0):", panel)
        self.assertIn("self.tree.bbox(iid, column)", panel)
        draw = panel[panel.index("    def _draw_operation_overlay"):panel.index("    def _select_operation_row")]
        # Requested -column widths ignore the widget border and the stretched
        # name column, which shifted every separator and label a few pixels.
        self.assertNotIn('self.tree.column("name", "width")', draw)
        self.assertNotIn('self.tree.column("type", "width")', draw)
        self.assertNotIn('self.tree.column("size", "width")', draw)
        self.assertIn("boxes = self._row_column_boxes(iid, width, origin_x)", draw)

    def test_overlay_text_is_measured_instead_of_guessed_per_character(self):
        panel = self._panel()
        draw = panel[panel.index("    def _draw_operation_overlay"):panel.index("    def _select_operation_row")]
        # A fixed pixels-per-char estimate overflowed on wide glyphs and painted
        # the name over the neighbouring column.
        self.assertNotIn("approx_char_px", panel)
        self.assertIn("def _fit_overlay_text(self, text, spec, max_px):", panel)
        self.assertIn("font.measure(", panel)
        for spec in ("design.UI_FONT", "design.TINY_FONT", "design.UI_FONT_SEMIBOLD"):
            self.assertIn("self._fit_overlay_text(", draw)
            self.assertIn(spec, draw)

    def test_overlay_is_clipped_to_the_display_area(self):
        panel = self._panel()
        geometry = panel[panel.index("    def _overlay_row_geometry"):panel.index("    def _hide_operation_overlay")]
        layout = panel[panel.index("    def _layout_operation_overlays"):panel.index("    def _draw_operation_overlay")]
        # Cell boxes sit inside the Treeview chrome.  A canvas as wide as
        # winfo_width() painted over the card frame; clip to first/last cells.
        self.assertIn("x = max(1, int(first[0]))", geometry)
        self.assertIn("right = min(tree_width - 1, int(last[0]) + int(last[2]))", geometry)
        self.assertIn("top = max(0, y)", geometry)
        self.assertIn("bottom = min(y + height, tree_height)", geometry)
        self.assertIn("canvas.place(x=x, y=top, width=width, height=visible_height)", layout)

    def test_every_skip_path_hides_the_stale_overlay(self):
        panel = self._panel()
        layout = panel[panel.index("    def _layout_operation_overlays"):panel.index("    def _draw_operation_overlay")]
        # Leaving a placed canvas behind repaints a progress bar over whatever
        # row now occupies that space.
        self.assertEqual(layout.count("continue"), layout.count("self._hide_operation_overlay(token)"))
        self.assertIn("def _hide_operation_overlay(self, token):", panel)


class CanvasTextFitTests(unittest.TestCase):
    """Canvas text is never clipped to a box, so it must be measured.

    Both the progress overlay and the path bar draw onto a Canvas; an
    untruncated label paints straight over whatever sits next to it.
    """

    def _panel(self):
        with open(os.path.join(ROOT, "gui", "panel.py"), encoding="utf-8") as fh:
            return fh.read()

    def test_shared_measure_helper_truncates_to_real_glyph_width(self):
        from gui.panel import fit_canvas_text  # noqa: PLC0415

        # Empty text and no room both mean "draw nothing", with or without Tk.
        self.assertEqual(fit_canvas_text(None, "", ("Segoe UI", 11), 100), "")
        self.assertEqual(fit_canvas_text(None, "abc", ("Segoe UI", 11), 0), "")
        # Without a usable Tk root the helper degrades instead of raising.
        self.assertEqual(fit_canvas_text(None, "abc", ("Segoe UI", 11), 2), "")

    def test_path_bar_divides_the_bar_between_path_and_access(self):
        panel = self._panel()
        bar = panel[panel.index("    def _redraw(self):"):panel.index("class FilePanel")]
        # Measuring the access side first keeps a long path from running
        # through it and past the rounded edge.
        self.assertIn("access_px", bar)
        self.assertIn("fit_canvas_text(self, path, design.UI_FONT", bar)
        self.assertIn("fit_canvas_text(self, access, design.UI_FONT", bar)
        self.assertIn("text=path, anchor=\"w\"", bar)
        self.assertIn("text=access, anchor=\"e\"", bar)

    def test_font_cache_is_scoped_per_tk_interpreter(self):
        panel = self._panel()
        # A tkfont.Font dies with its root; a process-wide cache would hand a
        # dead font to the next window and raise "application has been destroyed".
        self.assertIn("_FONT_CACHES = {}", panel)
        self.assertNotIn("_FONT_CACHE = {}", panel)
        self.assertIn("cache = _FONT_CACHES.setdefault(str(root), {})", panel)
        self.assertIn("except tk.TclError:", panel)


class FolderRowOverflowTests(unittest.TestCase):
    """grid never shrinks a child below its requested width.

    A pane narrower than the folder row used to push the combo and the action
    buttons past the card border and across the sash, so the row has to drop
    optional controls and the sash has to respect the real minimum.
    """

    def _read(self, *parts):
        with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
            return fh.read()

    def test_panel_drops_optional_controls_when_the_pane_is_narrow(self):
        panel = self._read("gui", "panel.py")
        self.assertIn("def _fit_selector_row(self):", panel)
        self.assertIn("def _schedule_selector_fit(self, _evt=None):", panel)
        self.assertIn('self.bind("<Configure>", self._schedule_selector_fit)', panel)
        fit = panel[panel.index("    def _fit_selector_row"):panel.index("    def minimum_content_width")]
        self.assertIn("button.pack_forget()", fit)
        self.assertIn("caption.grid_remove()", fit)
        # Restore on the way back up, otherwise a resized window loses controls.
        self.assertIn('button.pack(side="left", padx=(4, 0))', fit)
        self.assertIn("caption.grid()", fit)

    def test_panel_reports_its_real_minimum_width(self):
        panel = self._read("gui", "panel.py")
        self.assertIn("def minimum_content_width(self):", panel)
        minimum = panel[panel.index("    def minimum_content_width"):]
        self.assertIn("self._optional_action_buttons", minimum)
        self.assertIn("return SELECTOR_MIN_WIDTH", minimum)

    def test_sash_drag_is_clamped_to_the_panels_real_minimum(self):
        main = self._read("gui", "main_window.py")
        workspace = self._read("gui", "workspace.py")
        self.assertIn("def _min_pane_width(self):", main)
        self.assertIn("panel.minimum_content_width()", main)
        # The old code stored the raw sash position, so a manual drag could
        # leave a pane narrower than its own toolbar.  The place-based workspace
        # clamps the ratio it derives from the pointer instead.
        self.assertIn("def _set_ratio_from_x", workspace)
        set_ratio = workspace[workspace.index("    def _set_ratio_from_x"):workspace.index("    def _on_drag_end")]
        self.assertIn("self._clamp_ratio(", set_ratio)
        geometry = workspace[workspace.index("    def _sash_x"):workspace.index("    def layout")]
        self.assertIn("limit = max(0, usable - self.min_pane)", geometry)
        self.assertIn("return max(self.min_pane, min(limit, pos))", geometry)
        apply_split = main[main.index("    def _apply_splits"):main.index("    def _capture_ratios")]
        self.assertIn("layout.min_pane = self._min_pane_width()", apply_split)

    def test_card_caption_is_measured_to_the_card_width(self):
        panel = self._read("gui", "panel.py")
        self.assertIn("def _apply_caption_text(self):", panel)
        apply_caption = panel[panel.index("    def _apply_caption_text"):panel.index("    def _begin_rename")]
        # The caption is a LabelFrame labelwidget: ttk sizes that window to the
        # card but never clips the text, so a long peer name has to be shortened
        # against the real available width.
        self.assertIn("self._caption_full_text = str(text or \"\")", panel)
        self.assertIn("available = int(self.winfo_width()) - 2 * _CAPTION_INSET", apply_caption)
        self.assertIn("fit_canvas_text(self, prefix + text, design.SECTION_FONT, available)", apply_caption)
        # The painted prefix must be measured, not appended after fitting.
        self.assertIn('self._caption_label.configure(text=shown)', apply_caption)
        self.assertNotIn('text="  " + shown', apply_caption)
        # Re-measured on resize, otherwise a resized window keeps a stale length.
        fit = panel[panel.index("    def _fit_selector_row"):panel.index("    def minimum_content_width")]
        self.assertIn("self._apply_caption_text()", fit)

    def test_cards_keep_their_gutter_and_the_workspace_fills_them(self):
        main = self._read("gui", "main_window.py")
        workspace = self._read("gui", "workspace.py")
        setup = main[main.index("        self.workspace = AppFrame"):main.index("        self._copy_ltr_btn = AppButton")]
        # The workspace places the two cards directly; the old inset holders and
        # their padx gutters are gone because place() already owns every pixel.
        self.assertIn("WorkspaceLayout(", setup)
        self.assertNotIn("left_holder", setup)
        self.assertNotIn("right_holder", setup)
        # The breathing room around the divider is now part of the grab band.
        self.assertIn("SASH_HANDLE =", workspace)
        self.assertGreater(int(workspace.split("SASH_HANDLE = ")[1].split("\n")[0]), 5)
        self.assertIn("def _layout_files(self, files_width, height):", workspace)
        self.assertIn("self.left.place(x=0, y=0, width=left_w, height=height)", workspace)
        self.assertIn("self.right.place(x=right_x, y=0, width=right_w, height=height)", workspace)
        # An asymmetric gutter makes the sash itself read off-centre, so the two
        # sides of the file panes are kept equal.
        self.assertIn("CHAT_GAP = 6", workspace)
        self.assertNotIn("PANE_GAP_LEFT", main)
        self.assertNotIn("PANE_GAP_RIGHT", main)


class PanelViewRestoreTests(unittest.TestCase):
    def test_selection_follows_relative_path_after_insert(self):
        entries = [
            {"relativePath": "a.txt", "name": "a.txt"},
            {"relativePath": "b.txt", "name": "b.txt"},
        ]
        snapshot = capture_panel_view(entries, ["1"], "1", (0.2, 0.8), True)
        self.assertEqual(snapshot["selected"], ["b.txt"])
        self.assertEqual(snapshot["focus"], "b.txt")
        self.assertTrue(snapshot["had_focus"])
        reloaded = [
            {"relativePath": "copied.txt", "name": "copied.txt"},
            {"relativePath": "a.txt", "name": "a.txt"},
            {"relativePath": "b.txt", "name": "b.txt"},
        ]
        restored = resolve_panel_view(reloaded, snapshot)
        self.assertEqual(restored["selected"], ["2"])
        self.assertEqual(restored["focus"], "2")
        self.assertTrue(restored["had_focus"])
        self.assertEqual(restored["yview"], (0.2, 0.8))

    def test_missing_file_falls_back_to_remaining_selection(self):
        entries = [
            {"relativePath": "keep.txt"},
            {"relativePath": "gone.txt"},
        ]
        snapshot = capture_panel_view(entries, ["0", "1"], "1")
        restored = resolve_panel_view([{"relativePath": "keep.txt"}], snapshot)
        self.assertEqual(restored["selected"], ["0"])
        self.assertEqual(restored["focus"], "0")

    def test_up_row_is_restored(self):
        snapshot = capture_panel_view([], ["up"], "up")
        restored = resolve_panel_view([], snapshot)
        self.assertEqual(restored["selected"], ["up"])
        self.assertEqual(restored["focus"], "up")

    def test_copy_refresh_keeps_file_focus(self):
        path = os.path.join(ROOT, "gui", "main_window.py")
        with open(path, encoding="utf-8") as fh:
            main = fh.read()
        panel_path = os.path.join(ROOT, "gui", "panel.py")
        with open(panel_path, encoding="utf-8") as fh:
            panel = fh.read()
        copy_ltr = main[main.find("self._copy_ltr_btn = AppButton("):main.find("self._copy_ltr_btn.pack")]
        copy_rtl = main[main.find("self._copy_rtl_btn = AppButton("):main.find("self._copy_rtl_btn.pack")]
        self.assertIn("takefocus=False", copy_ltr)
        self.assertIn("takefocus=False", copy_rtl)
        self.assertIn("refresh(preserve_view=True)", main)
        self.assertIn("src_panel.focus_file_list()", main)
        self.assertIn("def refresh(self, preserve_view=False):", panel)
        self.assertIn("def focus_file_list(self):", panel)
        self.assertIn("self._restore_view(self._pending_view)", panel)

    def test_transfer_refresh_reconciles_tree_in_place(self):
        panel_path = os.path.join(ROOT, "gui", "panel.py")
        with open(panel_path, encoding="utf-8") as fh:
            panel = fh.read()
        refresh_start = panel.find("    def refresh(self, preserve_view=False):")
        refresh_end = panel.find("    def _finish_listing(self):", refresh_start)
        refresh = panel[refresh_start:refresh_end]
        self.assertIn("if preserve_view and self.entries:", refresh)
        self.assertIn("Keep the last complete snapshot visible", refresh)
        self.assertNotIn("self.entries = []\n            self._render_initial(True)\n            self._notify_state()\n        self._load_page", refresh.split("if preserve_view and self.entries:", 1)[1].split("else:", 1)[0])
        self.assertIn("self._replace_tree_entries()", panel)

    def test_small_batches_poll_durable_status_until_ui_converges(self):
        path = os.path.join(ROOT, "gui", "main_window.py")
        with open(path, encoding="utf-8") as fh:
            main = fh.read()
        register_start = main.find("    def _register_operation_batch")
        register_end = main.find("    def _release_batch_guard", register_start)
        register = main[register_start:register_end]
        poll_start = main.find("    def _poll_operation_batch")
        poll_end = main.find("    @staticmethod\n    def _batch_finished", poll_start)
        poll = main[poll_start:poll_end]
        self.assertIn("elif batch.get(\"core_batch_id\"):", register)
        self.assertIn("self.root.after(0, self._poll_operation_batch, batch_id)", register)
        self.assertIn("if not batch or batch.get(\"batch_poll_inflight\"):", poll)
        self.assertIn("self._batch_finished(batch)", poll)
        self.assertIn("batchStatus is persisted by JournalStore", poll)
        self.assertIn("panel.complete_row_operation", poll)
        self.assertIn("def _terminal_operation_should_refresh_panels", main)
        self.assertIn("Refresh a tracked multi-file copy once", main)


if __name__ == "__main__":
    unittest.main()
