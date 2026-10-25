"""The single-file offline copy: nothing outside the page, scripts allowed by hash, every data file inside.

Run: python -m unittest discover -s tests
"""
import base64
import gzip
import hashlib
import json
import os
import re
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
from build_offline import build  # noqa: E402

WEB = os.path.join(ROOT, "web")


@unittest.skipUnless(os.path.exists(os.path.join(WEB, "data", "files.json")), "run export_web.py first")
class OfflineCopy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        out = os.path.join(cls.tmp.name, "interop-mapper.html")
        build(WEB, out)
        with open(out, encoding="utf-8") as f:
            cls.page = f.read()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_nothing_is_loaded_from_outside_the_page(self):
        refs = re.findall(r'(?:src|href)="([^"#][^"]*)"', self.page)
        self.assertEqual([r for r in refs if not r.startswith("data:")], [])
        self.assertNotIn("url(\"fonts/", self.page)

    def test_scripts_and_styles_are_allowed_by_hash_only(self):
        csp = re.search(r'Content-Security-Policy" content="([^"]*)"', self.page).group(1)
        self.assertNotIn("unsafe-inline", csp)
        inline = re.findall(r'<script(?: type="module")?>(.*?)</script>', self.page, re.S)
        inline += re.findall(r"<style>(.*?)</style>", self.page, re.S)
        self.assertEqual(len(inline), 4)
        for code in inline:
            digest = base64.b64encode(hashlib.sha256(code.encode()).digest()).decode()
            self.assertIn(f"'sha256-{digest}'", csp)

    def test_modules_are_combined(self):
        app = re.search(r'<script type="module">(.*?)</script>', self.page, re.S).group(1)
        self.assertIsNone(re.search(r"^\s*(import|export)\b", app, re.M))
        self.assertIn("const __lib = ", app)
        self.assertIn("} = __codegen;", app)

    def test_every_data_file_is_inside(self):
        packed = json.loads(re.search(r'id="interop-data">(.*?)</script>', self.page, re.S).group(1))
        with open(os.path.join(WEB, "data", "files.json"), encoding="utf-8") as f:
            listed = {p.removeprefix("data/") for p in json.load(f)["files"]}
        self.assertEqual(set(packed), listed)
        patient = json.loads(gzip.decompress(base64.b64decode(packed["R4/res/Patient.json"])))
        self.assertEqual(patient["name"], "Patient")


if __name__ == "__main__":
    unittest.main()
