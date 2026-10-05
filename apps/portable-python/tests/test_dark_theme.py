import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


class DarkThemeRegressionTests(unittest.TestCase):
    def _read(self, rel):
        with open(os.path.join(APP, rel), encoding="utf-8") as fh:
            return fh.read()

    def test_paned_window_and_scrollbars_have_explicit_styles(self):
        theme = self._read("apps/portable-python/gui/theme.py")
        components = self._read("apps/portable-python/gui/components.py")
        self.assertIn('"App.TPanedwindow"', theme)
        self.assertIn('("Sash", "Horizontal.Sash", "Vertical.Sash")', theme)
        self.assertIn('gripcount=0', theme)
        self.assertIn('"Horizontal.TScrollbar"', theme)
        self.assertIn('"Vertical.TScrollbar"', theme)
        self.assertIn('kwargs.setdefault("style", "App.TPanedwindow")', components)

    def test_tooltip_uses_active_theme_palette(self):
        tooltip = self._read("apps/portable-python/gui/tooltip.py")
        self.assertIn('ui_theme.color("FIELD")', tooltip)
        self.assertIn('ui_theme.color("INK")', tooltip)
        self.assertNotIn('#ffffe0', tooltip.lower())


if __name__ == "__main__":
    unittest.main()
