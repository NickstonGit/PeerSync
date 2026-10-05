import os
import re
import unittest
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, ROOT)

from gui.i18n import t  # noqa: E402


class PairDialogTests(unittest.TestCase):
    def test_i18n_has_copy_button(self):
        self.assertEqual(t("copy_code"), "Скопировать код")
        self.assertEqual(t("copied"), "Скопировано")
        self.assertEqual(t("close"), "Закрыть")

    def test_create_code_opens_pair_dialog(self):
        path = os.path.join(ROOT, "gui", "main_window.py")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("show_pair_code(self.root, code)", src)
        self.assertNotIn("messagebox.showinfo", src)

    def test_pair_dialog_uses_shared_ui_components_and_design_tokens(self):
        dialog_path = os.path.join(ROOT, "gui", "pair_dialog.py")
        design_path = os.path.join(ROOT, "gui", "design.py")
        with open(dialog_path, encoding="utf-8") as fh:
            dialog = fh.read()
        with open(design_path, encoding="utf-8") as fh:
            design = fh.read()
        self.assertIn('from gui.components import', dialog)
        self.assertIn('AppDialogFrame(dlg)', dialog)
        self.assertIn('variant="dialog_title"', dialog)
        self.assertIn('variant="code"', dialog)
        self.assertIn('FRAME_PADDING = (12, 8)', design)
        self.assertIn('CODE_FONT = ("Consolas", 11)', design)
        self.assertIn('CODE_ENTRY_PADDING = (10, 2)', design)
        self.assertNotIn('ttk.Entry(', dialog)
        self.assertNotIn('ttk.Frame(', dialog)
        self.assertNotIn('ttk.Label(', dialog)
        self.assertNotIn('ipady=3', dialog)

    def test_pair_dialog_has_copy_button_and_selectable_entry(self):
        path = os.path.join(ROOT, "gui", "pair_dialog.py")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("copy_text(parent, code)", src)
        self.assertIn('text=t("copy_code")', src)
        self.assertIn('state="readonly"', src)
        self.assertIn("selection_range(0, tk.END)", src)
        self.assertIn('variant="dialog_hint_success"', src)
        self.assertIn('variant="dialog_hint_error"', src)

    def test_ctrl_v_works_with_cyrillic_keyboard_layout(self):
        from types import SimpleNamespace
        from gui.pair_dialog import _is_ctrl_paste

        self.assertTrue(_is_ctrl_paste(SimpleNamespace(state=0x0004, keycode=86, keysym="Cyrillic_em")))
        self.assertTrue(_is_ctrl_paste(SimpleNamespace(state=0x0004, keycode=0, keysym="v")))
        self.assertFalse(_is_ctrl_paste(SimpleNamespace(state=0, keycode=86, keysym="Cyrillic_em")))
        self.assertFalse(_is_ctrl_paste(SimpleNamespace(state=0x0004, keycode=67, keysym="c")))

    def test_join_dialog_binds_layout_independent_ctrl_paste(self):
        path = os.path.join(ROOT, "gui", "pair_dialog.py")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn('entry.bind("<Control-KeyPress>", keyboard_paste)', src)
        self.assertIn('keycode == 86', src)
        self.assertIn('"cyrillic_em"', src)

    def test_dialogs_stay_withdrawn_until_placed(self):
        path = os.path.join(ROOT, "gui", "pair_dialog.py")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("def _new_toplevel", src)
        self.assertIn("dlg.withdraw()", src)
        self.assertIn("dlg.deiconify()", src)
        self.assertLess(src.find("dlg.withdraw()"), src.find("dlg.deiconify()"))
        self.assertLess(src.find("_center(parent, dlg)"), src.find("dlg.deiconify()"))
        self.assertEqual(src.count("tk.Toplevel(parent)"), 1)
        self.assertIn("_new_toplevel(", src)
        self.assertIn('show_pair_join', src)

    def test_copy_collision_dialog_uses_replace_and_skip(self):
        path = os.path.join(ROOT, "gui", "pair_dialog.py")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("def show_copy_collision", src)
        self.assertIn('t("copy_replace")', src)
        self.assertIn('t("copy_skip")', src)
        self.assertIn('t("cancel")', src)
        self.assertIn("collision_prompt", src)
        self.assertNotIn("ttk.Button(", src)

    def test_dialog_geometry_is_set_while_hidden(self):
        try:
            import tkinter as tk
            from tkinter import ttk
        except ImportError:
            self.skipTest("tkinter missing")
        try:
            root = tk.Tk()
        except tk.TclError:
            self.skipTest("no Tk display")
        try:
            root.geometry("720x440+260+140")
            root.deiconify()
            root.update()
            from gui.pair_dialog import _center, _new_toplevel

            dlg = _new_toplevel(root, "geometry-test", minsize=(320, 0))
            ttk.Frame(dlg, padding=16).pack()
            ttk.Label(dlg, text="x").pack()
            self.assertEqual(str(dlg.state()), "withdrawn")
            _center(root, dlg)
            self.assertEqual(str(dlg.state()), "withdrawn")
            match = re.search(r"([+-]\d+)([+-]\d+)$", dlg.wm_geometry())
            self.assertIsNotNone(match)
            x, y = int(match.group(1)), int(match.group(2))
            self.assertGreater(x, 40)
            self.assertGreater(y, 40)
        finally:
            try:
                root.destroy()
            except Exception:
                pass

    def test_add_folder_dialog_asks_for_mount_name(self):
        from gui.pair_dialog import _folder_basename

        self.assertEqual(_folder_basename(r"X:\ws\Photos"), "Photos")
        self.assertEqual(_folder_basename("C:/temp/music/"), "music")
        path = os.path.join(ROOT, "gui", "pair_dialog.py")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("def show_add_folder", src)
        self.assertIn('t("mount_name")', src)
        self.assertIn('t("folder_path")', src)
        self.assertIn("filedialog.askdirectory(parent=dlg)", src)
        main = os.path.join(ROOT, "gui", "main_window.py")
        with open(main, encoding="utf-8") as fh:
            gui = fh.read()
        self.assertIn("show_add_folder(self.root)", gui)
        self.assertIn('"name": name', gui)


if __name__ == "__main__":
    unittest.main()
