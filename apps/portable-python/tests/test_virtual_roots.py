import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, ROOT)

from gui.panel import _entry_root_id, _virtual_root_entry  # noqa: E402
from gui.i18n import t  # noqa: E402


class VirtualRootTests(unittest.TestCase):
    def _read(self, *parts):
        with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
            return fh.read()

    def test_root_row_keeps_stable_root_identity(self):
        entry = _virtual_root_entry({"rootId": "root-42", "name": "Projects", "path": r"X:\Projects"})
        self.assertEqual(entry["type"], "dir")
        self.assertEqual(entry["name"], "Projects")
        self.assertEqual(_entry_root_id(entry), "root-42")
        self.assertTrue(entry["relativePath"].startswith("@root/"))

    def test_panel_has_navigable_all_folders_overview(self):
        panel = self._read("gui", "panel.py")
        self.assertEqual(t("all_folders"), "Все папки")
        self.assertIn('self.root_box["values"] = ([t("all_folders")] + labels) if self.roots else []', panel)
        self.assertIn("self.entries = [_virtual_root_entry(root) for root in self.roots]", panel)
        self.assertIn("if virtual_root_id:", panel)
        self.assertIn('self.root_id = ""', panel)
        self.assertIn("self.root_box.current(0)", panel)
        self.assertIn("def effective_target(self):", panel)
        self.assertIn("def sync_source_entries(self):", panel)

    def test_main_window_can_refresh_and_sync_selected_roots(self):
        main = self._read("gui", "main_window.py")
        self.assertIn("on_refresh_roots=self._reload_roots", main)
        self.assertIn("on_refresh_roots=self._reload_remote_roots", main)
        self.assertIn("src = dict(src_panel.effective_target())", main)
        self.assertIn("dst = dict(dest_panel.effective_target())", main)
        self.assertIn("sync_entries = list(src_panel.sync_source_entries() or [])", main)
        self.assertIn("dest_entries = [] if dest_panel.is_virtual_root_view()", main)

    def test_stat_batch_is_read_only_rpc(self):
        core_client = self._read("ipc", "core_client.py")
        self.assertIn('"fs.list", "fs.stat", "fs.statBatch", "fs.manifest", "fs.syncPreview"', core_client)


if __name__ == "__main__":
    unittest.main()
