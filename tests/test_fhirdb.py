"""Checks against known FHIR facts. Run: python -m unittest discover tests"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
from fhirdb import FhirDB  # noqa: E402

DB = ROOT / "data" / "fhir.db"


@unittest.skipUnless(DB.exists(), "build the index first (see README)")
class FhirDBTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = FhirDB(str(DB))

    def test_search_finds_birth_date(self):
        paths = [r["path"] for r in self.db.search_elements("date of birth", "R4")]
        self.assertIn("Patient.birthDate", paths)

    def test_encounter_class_changed_in_r5(self):
        changed = {c["path"]: c for c in self.db.compare_versions("Encounter", "R4", "R5")["changed"]}
        self.assertEqual(changed["Encounter.class"]["types"], ["Coding", "CodeableConcept"])
        self.assertEqual(changed["Encounter.class"]["cardinality"], ["1..1", "0..*"])

    def test_known_renames_detected(self):
        renames = {(r["from"], r["to"]) for r in self.db.compare_versions("Encounter", "R4", "R5")["possible_renames"]}
        self.assertIn(("Encounter.hospitalization", "Encounter.admission"), renames)
        self.assertIn(("Encounter.period", "Encounter.actualPeriod"), renames)

    def test_removed_resource_points_to_replacement(self):
        result = self.db.compare_versions("DeviceUseStatement", "R4", "R5")
        self.assertIn("DeviceUsage", result["closest_in_R5"])

    def test_extension_search_finds_birth_place(self):
        urls = [x["url"] for x in self.db.search_extensions("birth place", "R5", "Patient")]
        self.assertIn("http://hl7.org/fhir/StructureDefinition/patient-birthPlace", urls)

    def test_datatype_text_fields_not_hidden(self):
        # CodeableConcept.text is real content, unlike the inherited Patient.text narrative
        paths = [r["path"] for r in self.db.search_elements("plain text", "R4", "CodeableConcept")]
        self.assertIn("CodeableConcept.text", paths)
        top = [e["path"] for e in self.db.get_resource("Patient", "R4")["elements"]]
        self.assertNotIn("Patient.text", top)

    def test_typo_gets_suggestion(self):
        self.assertIn("Patient.birthDate", self.db.get_element("Patient.birthdate", "R4")["did_you_mean"])

    def test_bad_version_rejected(self):
        with self.assertRaises(ValueError):
            self.db.search_elements("birth", "R6")


if __name__ == "__main__":
    unittest.main()
