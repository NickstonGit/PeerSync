import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PORTABLE = os.path.abspath(os.path.join(HERE, ".."))
APP = os.path.abspath(os.path.join(PORTABLE, "..", ".."))


class WordmarkAssetTests(unittest.TestCase):
    def test_both_theme_wordmarks_are_small_pngs(self):
        for name in ("peersync-wordmark-light.png", "peersync-wordmark-dark.png"):
            path = os.path.join(PORTABLE, "assets", name)
            self.assertTrue(os.path.isfile(path), name)
            self.assertLess(os.path.getsize(path), 50_000, name)
            with open(path, "rb") as fh:
                self.assertEqual(fh.read(8), b"\x89PNG\r\n\x1a\n")

    def test_wordmarks_are_bundled_and_used(self):
        with open(os.path.join(PORTABLE, "PSN.spec"), encoding="utf-8") as fh:
            spec = fh.read()
        with open(
            os.path.join(PORTABLE, "gui", "main_window.py"), encoding="utf-8"
        ) as fh:
            gui = fh.read()
        with open(
            os.path.join(APP, "scripts", "gen-core-payload.py"), encoding="utf-8"
        ) as fh:
            generator = fh.read()
        self.assertIn("peersync-wordmark-light.png", spec)
        self.assertIn("peersync-wordmark-dark.png", spec)
        self.assertIn("datas=wordmark_datas", spec)
        self.assertIn(
            'brand_asset = "peersync-wordmark-dark.png" if self._dark_mode else "peersync-wordmark-light.png"',
            gui,
        )
        self.assertIn("def _load_brand_image(asset):", gui)
        self.assertIn("BRAND_IMAGE_SUBSAMPLE = 2", gui)
        self.assertIn("BRAND_IMAGE_HEIGHT = 70", gui)
        self.assertIn("BRAND_IMAGE_WIDTH = 280", gui)
        self.assertIn("subsample(BRAND_IMAGE_SUBSAMPLE, BRAND_IMAGE_SUBSAMPLE)", gui)
        self.assertIn("WORDMARKS = %r", generator)


if __name__ == "__main__":
    unittest.main()
