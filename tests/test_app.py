"""Runs the Streamlit page headless with the model call stubbed out (no API key or cost)."""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).resolve().parent.parent
APP = str(ROOT / "app.py")
sys.path.insert(0, str(ROOT / "src"))
import assistant  # noqa: E402


@unittest.skipUnless((ROOT / "data" / "fhir.db").exists(), "build the index first (see README)")
class AppPageTest(unittest.TestCase):
    def test_without_key_shows_setup_message(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": ""}):
            at = AppTest.from_file(APP).run()
        self.assertFalse(at.exception)
        self.assertIn("ANTHROPIC_API_KEY", at.error[0].value)

    def test_example_question_shows_answer_and_lookups(self):
        calls = [{"name": "search_fhir_extensions", "input": {"query": "preferred pharmacy", "version": "R4"}}]
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-placeholder"}), \
                mock.patch.object(assistant, "ask", return_value=("Use the patient-preferredPharmacy extension.", calls)):
            at = AppTest.from_file(APP).run()
            next(b for b in at.button if b.label.startswith("I have a patient")).click().run()
        self.assertFalse(at.exception)
        texts = [m.value for m in at.markdown]
        self.assertIn("Use the patient-preferredPharmacy extension.", texts)
        self.assertEqual(at.expander[0].label, "Looked up (1)")


if __name__ == "__main__":
    unittest.main()
