import os
import unittest
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, ROOT)

from gui.i18n import T, t  # noqa: E402
from gui.sync_paths import format_selection, pick_sync_source_entries, resolve_sync_pair  # noqa: E402


class SyncUiTests(unittest.TestCase):
    def test_i18n_has_both_sync_directions(self):
        self.assertEqual(t("sync_to"), "Синхронизировать →")
        self.assertEqual(t("sync_from"), "← Синхронизировать")
        self.assertIn("tip_sync_to", T)
        self.assertIn("tip_sync_from", T)
        self.assertIn("Shift", t("tip_sync_to"))
        self.assertIn("Shift", t("tip_sync_from"))
        self.assertEqual(
            t("sync_need_folder", side="Слева", selected="папка ref"),
            "Для синхронизации нужна одна папка. Слева выбрано: папка ref",
        )
        self.assertNotIn("sync", T)
        self.assertNotIn("tip_sync", T)
        self.assertNotIn("sync_preparing_hint", T)

    def test_main_window_wires_both_one_way_syncs(self):
        path = os.path.join(ROOT, "gui", "main_window.py")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("command=self._sync_ltr", src)
        self.assertIn("command=self._sync_rtl", src)
        self.assertIn("self._sync(self.left, self.right)", src)
        self.assertIn("self._sync(self.right, self.left)", src)
        self.assertIn("resolve_sync_pair", src)
        self.assertIn("pick_sync_source_entries", src)
        self.assertNotIn("command=self._sync)", src)

    def test_sync_compare_then_copy_without_blocking_wait(self):
        main_path = os.path.join(ROOT, "gui", "main_window.py")
        dialog_path = os.path.join(ROOT, "gui", "pair_dialog.py")
        with open(main_path, encoding="utf-8") as fh:
            main = fh.read()
        with open(dialog_path, encoding="utf-8") as fh:
            dialog = fh.read()
        self.assertIn("if self._sync_busy:", main)
        self.assertIn("self._set_sync_busy(True)", main)
        self.assertIn("set_compare_progress", main)
        self.assertIn("prepare_copy_progress", main)
        self.assertIn("compare-source", main)
        self.assertIn("compare-dest", main)
        self.assertIn("messagebox.askyesno", main)
        self.assertNotIn("show_wait_dialog", main)
        self.assertNotIn("close_wait_dialog", main)
        self.assertNotIn("def show_wait_dialog", dialog)
        self.assertEqual(t("sync_preparing"), "Сравнение папок…")
        self.assertIn("sync_comparing", T)
        self.assertIn("sync_compare_source", T)
        self.assertIn("sync_compare_dest", T)
        self.assertIn("skip_confirm = shift_is_down()", main)
        self.assertIn("if not skip_confirm:", main)


class SyncPathTests(unittest.TestCase):
    def test_selected_folder_maps_into_dest_cwd_like_copy(self):
        src, dest, err = resolve_sync_pair(
            [{"type": "dir", "relativePath": "ProjectA"}],
            "incoming",
            [],
        )
        self.assertIsNone(err)
        self.assertEqual(src, "ProjectA")
        self.assertEqual(dest, "incoming/ProjectA")

    def test_selected_folders_on_both_sides(self):
        src, dest, err = resolve_sync_pair(
            [{"type": "dir", "relativePath": "dev/ProjectA"}],
            "prod",
            [{"type": "dir", "relativePath": "prod/Backup"}],
        )
        self.assertIsNone(err)
        self.assertEqual(src, "dev/ProjectA")
        self.assertEqual(dest, "prod/Backup")

    def test_nested_source_uses_basename_on_dest(self):
        src, dest, err = resolve_sync_pair(
            [{"type": "dir", "relativePath": "work/nested/Foo"}],
            "",
            [],
        )
        self.assertIsNone(err)
        self.assertEqual(src, "work/nested/Foo")
        self.assertEqual(dest, "Foo")

    def test_file_or_multi_selection_is_rejected(self):
        _, _, err_file = resolve_sync_pair([{"type": "file", "relativePath": "a.txt"}], "", [])
        self.assertEqual(err_file, "sync_need_folder")
        _, _, err_multi = resolve_sync_pair(
            [
                {"type": "dir", "relativePath": "a"},
                {"type": "dir", "relativePath": "b"},
            ],
            "",
            [],
        )
        self.assertEqual(err_multi, "sync_need_folder")
        _, _, err_empty = resolve_sync_pair([], "incoming", [])
        self.assertEqual(err_empty, "sync_need_folder")

    def test_dir_plus_file_uses_the_folder(self):
        src, dest, err = resolve_sync_pair(
            [
                {"type": "dir", "relativePath": "ref", "name": "ref"},
                {"type": "file", "relativePath": "PSN.exe", "name": "PSN.exe"},
            ],
            "",
            [],
        )
        self.assertIsNone(err)
        self.assertEqual(src, "ref")
        self.assertEqual(dest, "ref")

    def test_dest_file_selection_falls_back_to_same_name(self):
        src, dest, err = resolve_sync_pair(
            [{"type": "dir", "relativePath": "ProjectA"}],
            "incoming",
            [{"type": "file", "relativePath": "incoming/readme.txt"}],
        )
        self.assertIsNone(err)
        self.assertEqual(src, "ProjectA")
        self.assertEqual(dest, "incoming/ProjectA")

    def test_format_selection_describes_what_is_checked(self):
        self.assertEqual(format_selection([]), "ничего")
        self.assertEqual(
            format_selection([{"type": "dir", "name": "ref", "relativePath": "ref"}]),
            "папка ref",
        )
        self.assertEqual(
            format_selection(
                [
                    {"type": "dir", "name": "ref", "relativePath": "ref"},
                    {"type": "file", "name": "PSN.exe", "relativePath": "PSN.exe"},
                ]
            ),
            "папка ref и файл PSN.exe",
        )

    def test_overlay_or_cwd_fills_empty_selection(self):
        picked = pick_sync_source_entries(
            [],
            overlay_entry={"relativePath": "ref", "name": "ref"},
            cwd="",
        )
        self.assertEqual(picked[0]["relativePath"], "ref")
        self.assertEqual(picked[0]["type"], "dir")
        cwd_picked = pick_sync_source_entries([], overlay_entry=None, cwd="work/Foo")
        self.assertEqual(cwd_picked[0]["relativePath"], "work/Foo")


if __name__ == "__main__":
    unittest.main()
