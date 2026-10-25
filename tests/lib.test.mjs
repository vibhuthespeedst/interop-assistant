// Search behaviour checks on the real exported data. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  prepareIndex, searchElements, searchResources, prepareExtensions, searchExtensions,
  hintsFor, elementUrl, extensionUrl, pathTokens, nameParts, entryOfTheDay, historySteps,
} from "../web/lib.js";

const data = new URL("../web/data/", import.meta.url);
const load = (p) => JSON.parse(readFileSync(new URL(p, data), "utf8"));
const ready = existsSync(new URL("files.json", data));

const top = (results, n = 5) => results.slice(0, n).map((r) => r.path ?? r.name ?? r.id);

test("path tokens split camelCase and choice types", () => {
  assert.deepEqual([...pathTokens("Patient.birthDate")].sort(), ["birth", "birthdate", "date", "patient"]);
  assert.ok(pathTokens("Observation.value[x]").has("value"));
});

test("plain-English searches find the right fields", { skip: !ready }, () => {
  const r4 = prepareIndex(load("R4/index.json"), load("R4/resources.json"));
  assert.equal(searchElements(r4, "date of birth")[0].path, "Patient.birthDate");
  assert.equal(searchElements(r4, "patient phone number")[0].path, "Patient.telecom");
  assert.equal(searchElements(r4, "lab normal range")[0].path, "Observation.referenceRange");
  assert.equal(searchElements(r4, "insurance member id")[0].path, "Coverage.subscriberId");
  assert.ok(top(searchElements(r4, "dob")).includes("Patient.birthDate"));
});

test("dotted input finds the exact path", { skip: !ready }, () => {
  const r5 = prepareIndex(load("R5/index.json"));
  assert.equal(searchElements(r5, "Encounter.admission")[0].path, "Encounter.admission");
});

test("resource search", { skip: !ready }, () => {
  const res = load("R4/resources.json");
  assert.equal(searchResources(res, "allergy")[0].name, "AllergyIntolerance");
  assert.equal(searchResources(res, "insurance")[0].name, "Coverage");
  assert.ok(!searchResources(res, "lab normal range").some((r) => r.name === "SubstanceReferenceInformation"));
});

test("extension search respects version and context", { skip: !ready }, () => {
  const ext = prepareExtensions(load("extensions.json"));
  assert.equal(searchExtensions(ext, "birth place", "R5", "Patient")[0].id, "patient-birthPlace");
  assert.equal(searchExtensions(ext, "preferred pharmacy", "R4")[0].id, "patient-preferredPharmacy");
});

test("headword parts", () => {
  assert.deepEqual(nameParts("MedicationRequest"), ["Medication", "Request"]);
  assert.deepEqual(nameParts("Patient"), ["Patient"]);
  assert.deepEqual(nameParts("base64Binary"), ["base64", "Binary"]);
  assert.deepEqual(nameParts("CDSHooks"), ["CDS", "Hooks"]);
});

test("entry of the day is stable for a day and well established", { skip: !ready }, () => {
  const res = load("R4/resources.json");
  const a = entryOfTheDay(res, new Date(2026, 9, 25, 8));
  assert.equal(entryOfTheDay(res, new Date(2026, 9, 25, 23)).name, a.name);
  assert.notEqual(entryOfTheDay(res, new Date(2026, 9, 26)).name, a.name);
  assert.equal(a.kind, "resource");
  assert.ok(a.status === "normative" || Number(a.maturity) >= 3);
});

test("history steps", { skip: !ready }, () => {
  const history = load("history.json");
  assert.deepEqual(historySteps(history.Patient).map((s) => s.kind), ["baseline", "same", "changed"]);
  assert.equal(historySteps(history.Patient)[2].count, 2, "same count as the Compare view");
  assert.deepEqual(historySteps(history.Citation).map((s) => s.kind), ["later", "new", "changed"]);
  assert.deepEqual(historySteps(history.DeviceUseStatement).map((s) => s.kind), ["baseline", "same", "removed"]);
  assert.equal(historySteps(history.DeviceUseStatement)[2].from, "R4B");
});

test("hints and links", () => {
  assert.equal(hintsFor("patient race").length, 1);
  assert.equal(elementUrl("R5", "Patient.birthDate", true),
    "https://hl7.org/fhir/R5/patient-definitions.html#Patient.birthDate");
  assert.equal(elementUrl("R4", "HumanName.family", false),
    "https://hl7.org/fhir/R4/datatypes-definitions.html#HumanName.family");
  assert.equal(extensionUrl({ id: "patient-birthPlace", in: ["Pack R5"] }, "R5"),
    "https://hl7.org/fhir/extensions/StructureDefinition-patient-birthPlace.html");
});
