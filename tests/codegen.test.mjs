// Code generation and story checks on the real exported data. Run: node --test "tests/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  elementExample, resourceExample, createSnippets, accessors, fhirpath, searchExample,
  storyParts, toPython, parseTypes, plainCardinality, exampleChunks, elementForKey, useDatatypes,
} from "../web/codegen.js";

const data = new URL("../web/data/", import.meta.url);
const ready = existsSync(new URL("files.json", data));
const res = (v, name) => JSON.parse(readFileSync(new URL(`${v}/res/${name}.json`, data), "utf8"));
const el = (file, path) => file.elements.find((e) => e.path === path);

test("parseTypes", () => {
  assert.deepEqual(parseTypes("Reference(Patient|Group), CodeableConcept"),
    [{ code: "Reference", targets: ["Patient", "Group"] }, { code: "CodeableConcept", targets: [] }]);
});

test("cardinality in words", () => {
  assert.equal(plainCardinality("0..1"), "optional");
  assert.equal(plainCardinality("1..1"), "required");
  assert.equal(plainCardinality("0..*"), "optional, any number");
  assert.equal(plainCardinality("1..*"), "required, one or more");
  assert.equal(plainCardinality("0..2"), "optional, up to 2");
  assert.equal(plainCardinality("0..0"), "not allowed");
});

test("compact example JSON is the same JSON, split by top-level property", { skip: !ready }, () => {
  useDatatypes(JSON.parse(readFileSync(new URL("R4/datatypes.json", data), "utf8")));
  const list = JSON.parse(readFileSync(new URL("R4/resources.json", data), "utf8"));
  for (const info of list) {
    const example = resourceExample(res("R4", info.name));
    if (!example) continue;
    const chunks = exampleChunks(example, 58);
    assert.deepEqual(JSON.parse(chunks.flatMap((c) => c.lines).join("\n")), example, info.name);
    assert.deepEqual(chunks.map((c) => c.key).filter(Boolean), Object.keys(example), info.name);
  }
  const patient = exampleChunks(resourceExample(res("R4", "Patient")), 58);
  const name = patient.find((c) => c.key === "name");
  assert.deepEqual(name.lines, ['  "name": [{ "family": "Doe", "given": ["Jane"] }],'], "short values stay on one line");
  const identifier = patient.find((c) => c.key === "identifier");
  assert.equal(identifier.lines[0], '  "identifier": [{', "a list of one object wraps around it");
});

test("JSON property to element", { skip: !ready }, () => {
  const patient = res("R4", "Patient");
  assert.equal(elementForKey(patient, "deceasedBoolean").path, "Patient.deceased[x]");
  assert.equal(elementForKey(patient, "birthDate").path, "Patient.birthDate");
  assert.equal(elementForKey(patient, "resourceType"), null);
});

test("element examples follow FHIR JSON rules", { skip: !ready }, () => {
  const patient = res("R4", "Patient");
  assert.deepEqual(elementExample(patient, "Patient.birthDate"), { resourceType: "Patient", birthDate: "2024-01-31" });
  assert.equal(elementExample(patient, "Patient.gender").gender, "male");
  assert.deepEqual(elementExample(patient, "Patient.deceased[x]"), { resourceType: "Patient", deceasedBoolean: false });

  const obs = res("R4", "Observation");
  const rr = elementExample(obs, "Observation.referenceRange.low");
  assert.ok(Array.isArray(rr.referenceRange), "repeating backbone becomes an array");
  assert.equal(rr.referenceRange[0].low.system, "http://unitsofmeasure.org");
  assert.ok("valueQuantity" in elementExample(obs, "Observation.value[x]"));
  assert.deepEqual(elementExample(obs, "Observation.subject").subject, { reference: "Patient/example" });
});

test("resource example has required and summary fields only", { skip: !ready }, () => {
  const obs = resourceExample(res("R4", "Observation"));
  assert.equal(obs.resourceType, "Observation");
  assert.equal(obs.status, "registered");
  assert.ok(obs.code.coding);
  assert.ok(!("meta" in obs) && !("text" in obs));
  const link = resourceExample(res("R4", "Patient")).link[0];
  assert.deepEqual(Object.keys(link).sort(), ["other", "type"], "backbone keeps only its required children");
});

test("snippets and accessors", { skip: !ready }, () => {
  const obs = res("R4", "Observation");
  const s = createSnippets("MedicationRequest", { resourceType: "MedicationRequest", doNotPerform: false });
  assert.match(s.python, /medication_request = \{\n    "resourceType": "MedicationRequest",\n    "doNotPerform": False\n\}/);
  assert.match(s.javascript, /const medicationRequest = \{/);
  assert.match(s.curl, /application\/fhir\+json/);
  assert.deepEqual(accessors(obs, "Observation.referenceRange.low"), {
    python: 'observation["referenceRange"][0]["low"]',
    javascript: "observation.referenceRange?.[0]?.low",
  });
  assert.equal(accessors(obs, "Observation.value[x]").python, 'observation["valueQuantity"]');
  assert.equal(fhirpath(el(obs, "Observation.value[x]")), "Observation.value.ofType(Quantity)");
  assert.equal(toPython([true, null, 1.5, "a\"b"]), '[\n    True,\n    None,\n    1.5,\n    "a\\"b"\n]');
});

test("search examples use the official parameter", { skip: !ready }, () => {
  const patient = res("R4", "Patient");
  const birth = el(patient, "Patient.birthDate");
  assert.equal(searchExample("Patient", birth.search[0], birth), "GET [base]/Patient?birthdate=2024-01-31");
  const gender = el(patient, "Patient.gender");
  assert.equal(searchExample("Patient", gender.search[0], gender), "GET [base]/Patient?gender=male");
  // The root element must not claim the resource's search parameters.
  assert.equal(el(patient, "Patient").search.length, 0);
  const active = el(patient, "Patient.active");
  assert.equal(searchExample("Patient", active.search[0], active), "GET [base]/Patient?active=true");
  const obs = res("R4", "Observation");
  const subject = el(obs, "Observation.subject");
  const sp = subject.search.find((p) => p.code === "subject");
  assert.equal(searchExample("Observation", sp, subject), "GET [base]/Observation?subject=Patient/123");
});

test("story parts", { skip: !ready }, () => {
  const infos = new Map(JSON.parse(readFileSync(new URL("R4/resources.json", data), "utf8")).map((r) => [r.name, r]));
  const obs = storyParts(res("R4", "Observation"), infos);
  assert.deepEqual(obs.must.map((e) => e.path), ["Observation.status", "Observation.code"]);
  assert.ok(obs.modifiers.some((e) => e.path === "Observation.status"));
  assert.match(obs.summary[0], /^Every Observation must have status and code/);
  const patient = storyParts(res("R4", "Patient"), infos);
  assert.ok(patient.pointedBy.length > 40);
  assert.ok(patient.pointsTo.some((p) => p.name === "Organization"));
  assert.match(patient.summary[0], /No field is mandatory/);
  const name = storyParts(res("R4", "HumanName"), infos);
  assert.match(name.summary[0], /building block/);
  assert.doesNotMatch(name.summary[0], /StructureDefinition/);
  assert.ok(name.usedBy.includes("Patient.name"));
});
