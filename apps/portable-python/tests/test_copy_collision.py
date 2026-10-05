import os
import unittest
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, ROOT)

from gui.copy_collision import (  # noqa: E402
    apply_copy_decision,
    collision_prompt,
    copy_items_for_panel,
    dest_stat_target,
    find_copy_collisions,
)
from gui.i18n import t  # noqa: E402


class CopyCollisionTests(unittest.TestCase):
    def test_finds_same_name_case_insensitively(self):
        selected = [{"name": "Report.TXT", "type": "file", "relativePath": "src/Report.TXT"}]
        dest = [{"name": "report.txt", "type": "file", "relativePath": "incoming/report.txt"}]
        hits = find_copy_collisions(selected, dest)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["name"], "Report.TXT")

    def test_ignores_names_that_are_free(self):
        selected = [{"name": "a.txt", "type": "file", "relativePath": "a.txt"}]
        dest = [{"name": "b.txt", "type": "file", "relativePath": "incoming/b.txt"}]
        self.assertEqual(find_copy_collisions(selected, dest), [])

    def test_skip_copies_only_free_names_without_overwrite(self):
        selected = [
            {"name": "a.txt", "type": "file", "relativePath": "a.txt"},
            {"name": "b.txt", "type": "file", "relativePath": "b.txt"},
        ]
        collisions = [{
            "name": "a.txt",
            "source": selected[0],
            "dest": {"name": "a.txt", "type": "file"},
        }]
        plan = apply_copy_decision(selected, collisions, "skip")
        self.assertEqual([e["name"] for e in plan["entries"]], ["b.txt"])
        self.assertEqual(plan["collision"], "rename")
        self.assertFalse(plan["empty"])

    def test_overwrite_keeps_matching_files(self):
        selected = [{"name": "a.txt", "type": "file", "relativePath": "a.txt"}]
        collisions = [{
            "name": "a.txt",
            "source": selected[0],
            "dest": {"name": "a.txt", "type": "file"},
        }]
        plan = apply_copy_decision(selected, collisions, "overwrite")
        self.assertEqual(plan["collision"], "overwrite")
        self.assertEqual(len(plan["entries"]), 1)

    def test_cannot_replace_file_with_folder(self):
        selected = [{"name": "data", "type": "file", "relativePath": "data"}]
        collisions = [{
            "name": "data",
            "source": selected[0],
            "dest": {"name": "data", "type": "dir"},
        }]
        prompt = collision_prompt(collisions)
        self.assertFalse(prompt["can_replace"])
        plan = apply_copy_decision(selected, collisions, "overwrite")
        self.assertTrue(plan["empty"])

    def test_cancel_returns_none(self):
        self.assertIsNone(apply_copy_decision([{"name": "a"}], [], None))

    def test_dest_stat_joins_cwd(self):
        target = dest_stat_target({"peerId": None, "rootId": "r1", "relativePath": "incoming"}, "a.txt")
        self.assertEqual(target["relativePath"], "incoming/a.txt")
        self.assertEqual(target["rootId"], "r1")

    def test_copy_items_keep_source_paths(self):
        items = copy_items_for_panel(True, "peer", "root", [{"relativePath": "src/a.txt"}])
        self.assertEqual(items[0]["source"]["peerId"], None)
        self.assertEqual(items[0]["source"]["relativePath"], "src/a.txt")

    def test_copy_items_preserve_every_selected_entry(self):
        selected = [
            {"relativePath": "src/a.txt"},
            {"relativePath": "src/b.txt"},
            {"relativePath": "src/folder", "type": "dir"},
        ]
        items = copy_items_for_panel(False, "peer", "root", selected)
        self.assertEqual(len(items), 3)
        self.assertEqual(
            [row["source"]["relativePath"] for row in items],
            ["src/a.txt", "src/b.txt", "src/folder"],
        )
        self.assertTrue(all(row["source"]["rootId"] == "root" for row in items))

    def test_dialog_strings_exist(self):
        self.assertEqual(t("copy_replace"), "Заменить")
        self.assertEqual(t("copy_skip"), "Пропустить")
        self.assertIn("копия с другим именем не создаётся", t("copy_exists_hint").lower())
        self.assertIn("Shift", t("tip_copy_to"))
        self.assertIn("Shift", t("tip_copy_from"))

    def test_shift_is_down_returns_bool(self):
        from gui.copy_collision import shift_is_down
        self.assertIsInstance(shift_is_down(), bool)


class CopyCollisionWiringTests(unittest.TestCase):
    def test_copy_asks_before_overwrite(self):
        path = os.path.join(ROOT, "gui", "main_window.py")
        with open(path, encoding="utf-8") as fh:
            main = fh.read()
        self.assertIn("show_copy_collision(self.root, collisions)", main)
        self.assertIn("apply_copy_decision", main)
        self.assertIn('"collision": collision', main)
        copy_fn = main[main.find("def _copy("):main.find("def _sync_ltr")]
        self.assertNotIn('"collision": "overwrite"', copy_fn)
        self.assertNotIn("find_copy_collisions", main)
        self.assertIn("self._copy_stat_then_start(src_panel, dest_panel, entries, dest)", copy_fn)
        self.assertIn("STAT_BATCH_CHUNK_SIZE = 64", main)
        self.assertIn("chunk_size = STAT_BATCH_CHUNK_SIZE", main)
        self.assertIn('if error_code(error) in ("UNSUPPORTED", "INVALID_REQUEST"):', main)
        self.assertIn('self.bridge.call("fs.stat", {"target": target}', main)
        self.assertIn("if shift_is_down():", main)
        self.assertIn('self._start_copy(src_panel, entries, dest, "overwrite")', main)


if __name__ == "__main__":
    unittest.main()
