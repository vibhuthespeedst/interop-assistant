// Turns definitions into things developers use: example JSON, code snippets, search
// queries, FHIRPath, and a short "story" of a resource. Pure functions, no DOM.

const UCUM = "http://unitsofmeasure.org";
const qty = (value, unit) => ({ value, unit, system: UCUM, code: unit });
const PLACEHOLDER_SYSTEM = "http://example.org/fhir/CodeSystem/example";

const PRIMITIVES = {
  boolean: true, integer: 1, integer64: "1", positiveInt: 1, unsignedInt: 0, decimal: 1.5,
  string: "example", markdown: "Example text", code: "example", id: "example",
  uri: "http://example.org/fhir/example", url: "https://example.org/example",
  canonical: "http://example.org/fhir/StructureDefinition/example",
  oid: "urn:oid:1.2.3.4.5", uuid: "urn:uuid:6f0b4a2e-1d5c-4c6e-9b3a-2a1f6e8d9c10",
  date: "2024-01-31", dateTime: "2024-01-31T09:30:00Z", instant: "2024-01-31T09:30:00.000Z", time: "09:30:00",
  base64Binary: "SGVsbG8=",
  xhtml: '<div xmlns="http://www.w3.org/1999/xhtml">Example</div>',
};

const COMPLEX = {
  Identifier: () => ({ system: "http://example.org/identifiers/mrn", value: "12345" }),
  HumanName: () => ({ family: "Doe", given: ["Jane"] }),
  Address: () => ({ line: ["123 Main St"], city: "Springfield", postalCode: "12345", country: "US" }),
  ContactPoint: () => ({ system: "phone", value: "+1 555 0100", use: "home" }),
  CodeableConcept: () => ({ coding: [{ system: PLACEHOLDER_SYSTEM, code: "example", display: "Example" }], text: "Example" }),
  Coding: () => ({ system: PLACEHOLDER_SYSTEM, code: "example", display: "Example" }),
  Quantity: () => qty(5.4, "mmol/L"),
  SimpleQuantity: () => qty(5.4, "mmol/L"),
  Age: () => ({ value: 42, unit: "years", system: UCUM, code: "a" }),
  Duration: () => ({ value: 30, unit: "minutes", system: UCUM, code: "min" }),
  Distance: () => ({ value: 5, unit: "km", system: UCUM, code: "km" }),
  Count: () => ({ value: 3, system: UCUM, code: "1" }),
  Money: () => ({ value: 100, currency: "USD" }),
  Period: () => ({ start: "2024-01-31T09:00:00Z", end: "2024-01-31T10:00:00Z" }),
  Range: () => ({ low: qty(3.5, "mmol/L"), high: qty(5.5, "mmol/L") }),
  Ratio: () => ({ numerator: qty(5, "mg"), denominator: qty(1, "mL") }),
  Attachment: () => ({ contentType: "application/pdf", url: "https://example.org/files/report.pdf", title: "Report" }),
  Annotation: () => ({ text: "Example note", time: "2024-01-31T09:30:00Z" }),
  Timing: () => ({ repeat: { frequency: 2, period: 1, periodUnit: "d" } }),
  Dosage: () => ({ text: "1 tablet twice a day", timing: { repeat: { frequency: 2, period: 1, periodUnit: "d" } } }),
  Narrative: () => ({ status: "generated", div: PRIMITIVES.xhtml }),
  Meta: () => ({ lastUpdated: PRIMITIVES.instant }),
};

// Direct children of each datatype for the FHIR version in use (data/<version>/datatypes.json),
// so datatypes without a hand-written sample still get their required parts.
let DATATYPES = {};
export function useDatatypes(map) {
  DATATYPES = map || {};
}

const INHERITED_ANY = /\.(id|extension|modifierExtension)$/;
const INHERITED_TOP = /\.(meta|implicitRules|language|text|contained)$/;

export function inherited(path, kind) {
  if (INHERITED_ANY.test(path)) return true;
  return kind === "resource" && path.split(".").length === 2 && INHERITED_TOP.test(path);
}

// "Reference(Patient|Group), CodeableConcept" -> [{code: "Reference", targets: [...]}, {code: "CodeableConcept", targets: []}]
export function parseTypes(types) {
  return (types || "").split(", ").filter(Boolean).map((t) => {
    const m = t.match(/^([^(]+)(?:\(([^)]*)\))?$/);
    return { code: m ? m[1] : t, targets: m?.[2] ? m[2].split("|") : [] };
  });
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lastSeg = (path) => path.split(".").pop();
export const isRepeating = (card) => {
  const max = (card || "").split("..")[1];
  return max === "*" || Number(max) > 1;
};
const isBackbone = (types) => /^(BackboneElement|Element)$/.test(types || "");

// First option of a code list as HL7 writes it in the short text: "male | female | other | unknown".
function codeFromShort(short) {
  if (!short || !short.includes("|")) return null;
  const first = short.split("|")[0].trim().replace(/\+$/, "").trim();
  return /^[A-Za-z0-9._-]+$/.test(first) ? first : null;
}

// Flags whose realistic example value is false (a sample patient shouldn't be deceased).
const FALSE_FLAGS = new Set(["deceased", "multipleBirth", "doNotPerform", "experimental"]);

function sampleFor(type, short, name = "", depth = 0) {
  if (type.code === "boolean" && FALSE_FLAGS.has(name)) return false;
  if (type.code === "Reference") return { reference: `${type.targets[0] === "Resource" || !type.targets[0] ? "Patient" : type.targets[0]}/example` };
  if (type.code === "CodeableReference") return { reference: { reference: `${type.targets[0] || "Condition"}/example` } };
  if (type.code === "canonical") return `http://example.org/fhir/${type.targets[0] || "StructureDefinition"}/example`;
  if (type.code === "code") return codeFromShort(short) || "example";
  if (type.code === "Resource") return { resourceType: "Patient" };
  if (type.code in PRIMITIVES) return PRIMITIVES[type.code];
  if (type.code in COMPLEX) return COMPLEX[type.code]();
  if (type.code in DATATYPES) return datatypeSample(type.code, depth);
  return {};
}

// Builds a datatype from its definition: its required parts, or its first part when none is
// required (FHIR JSON can't hold an empty object).
function datatypeSample(code, depth) {
  const kids = DATATYPES[code] || [];
  if (depth > 4 || !kids.length) return {};
  const required = kids.filter((k) => /^[1-9]/.test(k.card));
  const out = {};
  for (const k of required.length ? required : kids.slice(0, 1)) {
    const types = parseTypes(k.types);
    const choice = k.name.endsWith("[x]");
    const t = (choice && types.find((x) => x.code === "Quantity")) || types[0];
    if (!t) continue;
    const stem = k.name.replace(/\[x\]$/, "");
    const v = sampleFor(t, k.short, stem, depth + 1);
    out[choice ? stem + cap(t.code) : k.name] = isRepeating(k.card) ? [v] : v;
  }
  return out;
}

// Picks the type to show for an element; for choice elements prefers Quantity, else the first.
function chooseType(element) {
  const types = parseTypes(element.types);
  if (element.path.endsWith("[x]")) return types.find((t) => t.code === "Quantity") || types[0];
  return types[0];
}

// JSON property name and example value for one element (choice types become e.g. valueQuantity).
function leaf(element, file, depth) {
  const type = chooseType(element);
  const base = lastSeg(element.path);
  if (!type && element.contentRef) {
    // "Same as" another element (e.g. Questionnaire.item.item): reuse that element's structure.
    const value = {};
    fillChildren(value, file, element.contentRef, depth + 1, 3);
    return { name: base, value };
  }
  if (!type) return { name: base, value: {} };
  if (base.endsWith("[x]")) {
    const stem = base.slice(0, -3);
    return { name: stem + cap(type.code), value: sampleFor(type, element.short, stem, depth) };
  }
  if (isBackbone(element.types)) {
    const value = {};
    fillChildren(value, file, element.path, depth + 1, 3);
    return { name: base, value };
  }
  return { name: base, value: sampleFor(type, element.short, base, depth) };
}

function directChildren(file, parentPath) {
  const prefix = `${parentPath}.`;
  return file.elements.filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes(".")
    && !inherited(e.path, file.kind));
}

// Adds children of a backbone element: all required ones, then optional ones up to `max` in total.
function fillChildren(target, file, parentPath, depth, max) {
  if (depth > 6) return;
  const kids = directChildren(file, parentPath);
  const required = kids.filter((e) => /^[1-9]/.test(e.card));
  const optional = kids.filter((e) => !/^[1-9]/.test(e.card));
  for (const e of [...required, ...optional.slice(0, Math.max(0, max - required.length))]) {
    const { name, value } = leaf(e, file, depth);
    target[name] = isRepeating(e.card) ? [value] : value;
  }
}

// Example JSON showing one element in place, e.g. Observation.referenceRange.low.
// Groups on the way get their required parts too, so the snippet stays valid.
// Returns null for abstract resources, which are never created directly.
export function elementExample(file, path) {
  if (file.abstract) return null;
  const byPath = new Map(file.elements.map((e) => [e.path, e]));
  const segs = path.split(".");
  const root = file.kind === "resource" ? { resourceType: segs[0] } : {};
  let cur = root;
  for (let i = 1; i < segs.length; i++) {
    const def = byPath.get(segs.slice(0, i + 1).join("."));
    if (!def) return null;
    const isLast = i === segs.length - 1;
    const { name, value } = isLast ? leaf(def, file, i) : { name: lastSeg(def.path), value: requiredOnly(file, def.path, i + 1) };
    cur[name] = isRepeating(def.card) ? [value] : value;
    cur = value;
  }
  return root;
}

// Example of a whole resource: required, modifier and summary fields, in definition order.
// Returns null for abstract resources, which are never created directly.
export function resourceExample(file) {
  if (file.abstract) return null;
  const out = file.kind === "resource" ? { resourceType: file.name } : {};
  for (const e of directChildren(file, file.name)) {
    const required = /^[1-9]/.test(e.card);
    if (!(required || e.summary || e.modifier)) continue;
    const { name, value } = isBackbone(e.types)
      ? { name: lastSeg(e.path), value: requiredOnly(file, e.path) }
      : leaf(e, file, 1);
    const empty = value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length;
    if (empty && !required) continue;
    out[name] = isRepeating(e.card) ? [value] : value;
  }
  return out;
}

// A group's required parts (all the way down); its first part when none is required,
// because FHIR JSON can't hold an empty object.
function requiredOnly(file, parentPath, depth = 2) {
  const value = {};
  if (depth > 6) return value;
  const kids = directChildren(file, parentPath);
  const required = kids.filter((e) => /^[1-9]/.test(e.card));
  for (const e of required.length ? required : kids.slice(0, 1)) {
    const { name, value: v } = isBackbone(e.types)
      ? { name: lastSeg(e.path), value: requiredOnly(file, e.path, depth + 1) }
      : leaf(e, file, depth);
    value[name] = isRepeating(e.card) ? [v] : v;
  }
  return value;
}

// Python literal for a JSON value (True/False/None, 4-space indent).
export function toPython(value, indent = 0) {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 4);
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((v) => inner + toPython(v, indent + 4)).join(",\n")}\n${pad}]`;
  }
  const keys = Object.keys(value);
  if (!keys.length) return "{}";
  return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${toPython(value[k], indent + 4)}`).join(",\n")}\n${pad}}`;
}

const camelVar = (name) => name.charAt(0).toLowerCase() + name.slice(1);
const snakeVar = (name) => name.replace(/(?<=[a-z0-9])([A-Z])/g, "_$1").toLowerCase();

// Ready-to-run snippets that create the resource on a FHIR server.
export function createSnippets(resourceType, example) {
  const json = JSON.stringify(example, null, 2);
  const js = camelVar(resourceType);
  const py = snakeVar(resourceType);
  return {
    json,
    python: `import requests

${py} = ${toPython(example)}

response = requests.post(
    "https://your-fhir-server/fhir/${resourceType}",
    json=${py},
    headers={"Content-Type": "application/fhir+json"},
)
print(response.status_code, response.headers.get("Location"))`,
    javascript: `const ${js} = ${json};

const response = await fetch("https://your-fhir-server/fhir/${resourceType}", {
  method: "POST",
  headers: { "Content-Type": "application/fhir+json" },
  body: JSON.stringify(${js}),
});
console.log(response.status, response.headers.get("Location"));`,
    curl: `curl -X POST "https://your-fhir-server/fhir/${resourceType}" \\
  -H "Content-Type: application/fhir+json" \\
  -d @${js}.json`,
  };
}

// How to read the element from parsed JSON: observation["referenceRange"][0]["low"]
export function accessors(file, path) {
  const byPath = new Map(file.elements.map((e) => [e.path, e]));
  const segs = path.split(".");
  const varName = segs[0];
  const py = [snakeVar(varName)];
  const js = [camelVar(varName)];
  for (let i = 1; i < segs.length; i++) {
    const def = byPath.get(segs.slice(0, i + 1).join("."));
    if (!def) return null;
    const name = def.path.endsWith("[x]") ? leaf(def, file, i).name : lastSeg(def.path);
    py.push(`["${name}"]`);
    js.push(i === 1 ? `.${name}` : `?.${name}`);
    if (isRepeating(def.card) && i < segs.length - 1) { py.push("[0]"); js.push("?.[0]"); }
  }
  return { python: py.join(""), javascript: js.join("") };
}

export function fhirpath(element) {
  if (!element.path.endsWith("[x]")) return element.path;
  return `${element.path.slice(0, -3)}.ofType(${chooseType(element).code})`;
}

// Example query for one official search parameter of a field.
export function searchExample(resourceType, param, element) {
  const types = parseTypes(element?.types);
  const ref = types.find((t) => t.code === "Reference" || t.code === "CodeableReference");
  const samples = {
    date: "2024-01-31",
    string: "example",
    number: "5",
    quantity: `5.4|${UCUM}|mmol/L`,
    uri: "http://example.org/fhir/example",
    reference: `${ref?.targets.find((t) => t !== "Resource") || "Patient"}/123`,
    token: (() => {
      if (types.some((t) => t.code === "code")) return codeFromShort(element.short) || "example";
      if (types.some((t) => t.code === "boolean")) return "true";
      if (types.some((t) => t.code === "Identifier")) return "http://example.org/identifiers/mrn|12345";
      return `${PLACEHOLDER_SYSTEM}|example`;
    })(),
  };
  const value = samples[param.type];
  return value ? `GET [base]/${resourceType}?${param.code}=${value}` : null;
}

// ---------- reading aids ----------

// Cardinality in words: "0..1" -> "optional", "1..*" -> "required, one or more".
export function plainCardinality(card) {
  const [min, max] = (card || "").split("..");
  const required = Number(min) > 0;
  if (max === "0") return "not allowed";
  if (max === "1") return required ? "required" : "optional";
  if (max === "*") return required ? "required, one or more" : "optional, any number";
  return required ? `required, ${min} to ${max}` : `optional, up to ${max}`;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// One line, spaced the way people write it: { "a": 1, "b": [2] }
function inlineJSON(value) {
  if (Array.isArray(value)) return `[${value.map(inlineJSON).join(", ")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    return keys.length ? `{ ${keys.map((k) => `${JSON.stringify(k)}: ${inlineJSON(value[k])}`).join(", ")} }` : "{}";
  }
  return JSON.stringify(value);
}

// Lines for prefix + value + suffix: a value stays on one line when it fits in `width` columns,
// and a list holding one object wraps around it ("name": [{ ... }]) instead of adding two lines.
function jsonLines(value, indent, prefix, suffix, width) {
  const pad = " ".repeat(indent);
  const flat = `${pad}${prefix}${inlineJSON(value)}${suffix}`;
  if (flat.length <= width || value === null || typeof value !== "object") return [flat];
  if (Array.isArray(value) && value.length === 1 && isPlainObject(value[0]) && Object.keys(value[0]).length) {
    return jsonLines(value[0], indent, `${prefix}[`, `]${suffix}`, width);
  }
  const entries = Array.isArray(value)
    ? value.map((v) => ["", v])
    : Object.entries(value).map(([k, v]) => [`${JSON.stringify(k)}: `, v]);
  if (!entries.length) return [flat];
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return [
    `${pad}${prefix}${open}`,
    ...entries.flatMap(([p, v], i) => jsonLines(v, indent + 2, p, i < entries.length - 1 ? "," : "", width)),
    `${pad}${close}${suffix}`,
  ];
}

// Compact JSON of an example, one chunk per top-level property so each can be annotated:
// [{ key: null, lines: ["{"] }, { key: "resourceType", lines: [...] }, ..., { key: null, lines: ["}"] }]
export function exampleChunks(example, width = 60) {
  const keys = Object.keys(example);
  return [
    { key: null, lines: ["{"] },
    ...keys.map((k, i) => ({
      key: k,
      lines: jsonLines(example[k], 2, `${JSON.stringify(k)}: `, i < keys.length - 1 ? "," : "", width),
    })),
    { key: null, lines: ["}"] },
  ];
}

// The top-level element a JSON property belongs to: "deceasedBoolean" -> Patient.deceased[x].
export function elementForKey(file, key) {
  for (const e of directChildren(file, file.name)) {
    const name = lastSeg(e.path);
    if (name === key) return e;
    if (name.endsWith("[x]")) {
      const stem = name.slice(0, -3);
      if (parseTypes(e.types).some((t) => stem + cap(t.code) === key)) return e;
    }
  }
  return null;
}

// ---------- story ----------

const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
// HL7 datatype descriptions start with boilerplate: "Base StructureDefinition for HumanName Type: ..."
const sentence = (s) => (s || "").trim().replace(/^Base StructureDefinition for \w+ Type:\s*/i, "")
  .replace(/\s+/g, " ").replace(/([^.!?])$/, "$1.");

// Groups a resource's top-level fields and connections into the parts of its story.
export function storyParts(file, infoByName = new Map()) {
  const top = directChildren(file, file.name);
  const must = top.filter((e) => /^[1-9]/.test(e.card));
  const modifiers = top.filter((e) => e.modifier); // may overlap with must: status is often both
  const key = top.filter((e) => e.summary && !must.includes(e) && !modifiers.includes(e));

  const pointsTo = new Map();
  for (const o of file.links?.out ?? []) {
    for (const t of o.targets) {
      if (!pointsTo.has(t)) pointsTo.set(t, []);
      pointsTo.get(t).push(o.path);
    }
  }
  const incoming = new Map();
  for (const i of file.links?.in ?? []) {
    if (i.from === file.name) continue; // self-references are shown in pointsTo
    if (!incoming.has(i.from)) incoming.set(i.from, []);
    incoming.get(i.from).push(i.path);
  }
  const rank = (name) => {
    const info = infoByName.get(name);
    if (!info) return 0;
    if (info.status === "normative") return 2;
    return Number.parseInt(info.maturity, 10) >= 3 ? 1 : 0;
  };
  const pointedBy = [...incoming.entries()]
    .map(([name, paths]) => ({ name, paths }))
    .sort((a, b) => rank(b.name) - rank(a.name) || b.paths.length - a.paths.length || a.name.localeCompare(b.name));

  return {
    what: sentence(file.description),
    must, modifiers, key, top,
    pointsTo: [...pointsTo.entries()].map(([name, paths]) => ({ name, paths })),
    pointedBy,
    usedBy: file.links?.usedBy ?? [],
    usedByCount: file.links?.usedByCount ?? 0,
    summary: storySummary(file, must, modifiers, [...pointsTo.keys()], pointedBy),
  };
}

const names = (list) => {
  const items = list.map((x) => (typeof x === "string" ? x : x.name));
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
};

function storySummary(file, must, modifiers, pointsTo, pointedBy) {
  const n = file.name;
  const lines = [];
  if (file.kind !== "resource") {
    lines.push(`${n} is a building block, not a record on its own: ${lowerFirst(sentence(file.description))}`);
    return lines;
  }
  lines.push(must.length
    ? `Every ${n} must have ${names(must.map((e) => lastSeg(e.path)))}; everything else is optional.`
    : `No field is mandatory in a ${n}; you fill in what you know.`);
  if (modifiers.length) {
    lines.push(`Read ${names(modifiers.map((e) => lastSeg(e.path)))} first: ${modifiers.length > 1 ? "they change" : "it changes"} how the rest of the record should be understood.`);
  }
  const others = pointsTo.filter((t) => t !== "Resource" && t !== n);
  if (others.length) lines.push(`It points to ${names(others.slice(0, 5))}${others.length > 5 ? " and more" : ""}.`);
  if (pointedBy.length) {
    lines.push(`${pointedBy.length} other kind${pointedBy.length > 1 ? "s" : ""} of record point to it, such as ${names(pointedBy.slice(0, 4))}.`);
  }
  return lines;
}
