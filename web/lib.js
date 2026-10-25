// Pure helpers shared by the app and its tests: tokenizing, search scoring, links.

export const VERSIONS = ["R4", "R4B", "R5"];
const HL7 = "https://hl7.org/fhir";

const STOPWORDS = new Set(
  ("a an and are as at be by can do does for from go goes have how i in into is it its my of on or " +
    "put should store stored the this to what where which with").split(" "),
);

// Everyday words mapped to the words FHIR uses. Each is an alternative, not a requirement.
export const SYNONYMS = {
  dob: ["birth"], birthday: ["birth"],
  sex: ["gender", "sex"],
  phone: ["telecom", "phone"], mobile: ["telecom", "phone"], email: ["telecom", "email"], fax: ["telecom", "fax"],
  zip: ["postal"], postcode: ["postal"],
  doctor: ["practitioner"], physician: ["practitioner"], nurse: ["practitioner"], clinician: ["practitioner"],
  visit: ["encounter"],
  diagnosis: ["condition", "diagnosis"], problem: ["condition", "problem"],
  med: ["medication"], drug: ["medication"], prescription: ["medication", "prescription"],
  lab: ["observation", "laboratory"], vital: ["observation", "vital"], result: ["observation", "result"],
  insurance: ["coverage", "insurance"], insurer: ["coverage", "insurer"], payer: ["coverage", "payor"],
  normal: ["reference", "normal"],
  death: ["deceased", "death"], died: ["deceased"],
};

// Data with no home in the core specification, where the usual answer is well known.
export const HINTS = [
  { words: ["race", "ethnicity"],
    text: "Race and ethnicity have no core FHIR element. In the US, use the US Core Race and US Core Ethnicity extensions (US Core isn't part of this dictionary)." },
  { words: ["ssn"],
    text: "Store a US Social Security Number in Patient.identifier with system http://hl7.org/fhir/sid/us-ssn." },
];

export function stem(word) {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

// "Patient.birthDate" -> ["patient", "birth", "date", "birthdate"]
export function pathTokens(path) {
  const out = new Set();
  for (const seg of path.replace(/\[x\]/g, "").split(".")) {
    if (!seg) continue;
    out.add(stem(seg.toLowerCase()));
    for (const part of seg.split(/(?<=[a-z])(?=[A-Z])/)) out.add(stem(part.toLowerCase()));
  }
  return out;
}

export function textTokens(text) {
  return new Set((text || "").toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !STOPWORDS.has(w)).map(stem) ?? []);
}

// Each query word becomes a group of acceptable alternatives (the word plus its synonyms).
export function queryGroups(query) {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOPWORDS.has(w));
  return words.map((w) => [...new Set([stem(w), ...(SYNONYMS[w] || []).map(stem)])]);
}

function bestMatch(group, primary, secondary) {
  let best = 0;
  for (const alt of group) {
    if (primary.has(alt)) best = Math.max(best, 6);
    else if (alt.length >= 3 && [...primary].some((t) => t.startsWith(alt))) best = Math.max(best, 4);
    if (secondary.has(alt)) best = Math.max(best, 3);
    else if (alt.length >= 4 && [...secondary].some((t) => t.startsWith(alt))) best = Math.max(best, 2);
  }
  return best;
}

// Normative and mature resources (e.g. Patient) are what most people mean, so they rank a bit higher.
function maturityBoost(info) {
  if (!info) return 0;
  if (info.status === "normative") return 1;
  return Number.parseInt(info.maturity, 10) >= 3 ? 0.5 : 0;
}

// rows: [path, cardinality, types, short, isResource]; resources: that version's resources.json.
export function prepareIndex(rows, resources = []) {
  const info = new Map(resources.map((r) => [r.name, r]));
  return rows.map(([path, card, types, short, isResource]) => {
    const root = path.split(".")[0];
    const lastSeg = path.replace(/\[x\]/g, "").split(".").pop();
    return {
      path, card, types, short, isResource: !!isResource, root,
      depth: path.split(".").length - 1,
      pt: pathTokens(path),
      st: textTokens(short),
      last: [...new Set(lastSeg.split(/(?<=[a-z])(?=[A-Z])/).map((p) => stem(p.toLowerCase())))],
      boost: maturityBoost(info.get(root)),
    };
  });
}

export function searchElements(index, query, limit = 50) {
  const q = query.trim();
  if (!q) return [];
  if (q.includes(".")) {
    const lower = q.toLowerCase();
    const hits = index.filter((r) => r.path.toLowerCase().startsWith(lower));
    if (hits.length) return hits.slice(0, limit);
  }
  const groups = queryGroups(q);
  if (!groups.length) return [];
  const scored = [];
  for (const r of index) {
    let sum = 0;
    let matched = 0;
    for (const g of groups) {
      const s = bestMatch(g, r.pt, r.st);
      sum += s;
      if (s) matched++;
    }
    if (!matched) continue;
    // How much of the element's own name the query explains: birthDate beats internationalBirthDate.
    const covered = r.last.filter((t) => groups.some((g) => g.includes(t))).length / r.last.length;
    const shortHits = groups.filter((g) => g.some((a) => r.st.has(a))).length;
    const score = sum + (matched === groups.length ? 3 * groups.length : 0) + 2 * covered + 0.4 * shortHits
      + r.boost + (r.isResource ? 0.5 : 0)
      // Shallower fields win ties: Patient.telecom is usually meant over Patient.contact.telecom.
      - 0.15 * r.depth - 0.3 * Math.max(0, r.depth - 2);
    scored.push([score, r]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].path.localeCompare(b[1].path));
  return scored.slice(0, limit).map(([, r]) => r);
}

export function searchResources(resources, query, limit = 6) {
  const groups = queryGroups(query);
  if (!groups.length) return [];
  const scored = [];
  for (const r of resources) {
    if (r.kind !== "resource") continue;
    const nt = pathTokens(r.name);
    const st = textTokens(r.summary);
    let sum = 0;
    let matched = 0;
    for (const g of groups) {
      const s = bestMatch(g, nt, st);
      sum += s;
      if (s >= 4) matched++;
    }
    // Only when every word fits: "lab normal range" shouldn't suggest SubstanceReferenceInformation.
    if (matched === groups.length) scored.push([sum, r]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, limit).map(([, r]) => r);
}

export function extensionAvailable(ext, version) {
  if (version === "R5") return ext.in.includes("Pack R5") || ext.in.includes("R5 core");
  if (version === "R4B") return ext.in.includes("R4B core") || ext.in.includes("Pack R4");
  return ext.in.includes("R4 core") || ext.in.includes("Pack R4");
}

export function prepareExtensions(list) {
  return list.map((x) => ({
    ...x,
    tt: textTokens(x.title),
    it: new Set(x.id.split("-").flatMap((p) => [...pathTokens(p)])),
    ut: pathTokens(x.use_on.replace(/,\s*/g, ".")),
    dt: textTokens(x.description.slice(0, 400)),
  }));
}

export function searchExtensions(exts, query, version, useOn = "", limit = 40) {
  const groups = queryGroups(query);
  const on = useOn.trim().toLowerCase();
  const scored = [];
  for (const x of exts) {
    if (!extensionAvailable(x, version)) continue;
    if (on && !(x.use_on.toLowerCase().includes(on) || /(^|, )Element($|,)/.test(x.use_on))) continue;
    let sum = 0;
    let matched = 0;
    for (const g of groups) {
      const s = Math.max(bestMatch(g, x.tt, x.dt), bestMatch(g, x.it, x.ut) * 0.9);
      sum += s;
      if (s) matched++;
    }
    if (groups.length && !matched) continue;
    const pref = x.status === "deprecated" ? -4 : 0;
    scored.push([sum + (matched === groups.length ? 3 * groups.length : 0) + pref, x]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].title.localeCompare(b[1].title));
  return scored.slice(0, limit).map(([, x]) => x);
}

// ---------- dictionary conventions ----------

// "MedicationRequest" -> ["Medication", "Request"]: a headword's parts, set apart like syllables.
export function nameParts(name) {
  const parts = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g);
  return parts && parts.join("") === name ? parts : [name];
}

// One well-established resource per calendar day, the same for everyone that day.
// Stepping by a large prime visits every candidate before repeating, out of A-Z order.
export function entryOfTheDay(resources, date = new Date()) {
  const pool = resources.filter((r) => r.kind === "resource" && !r.abstract
    && (r.status === "normative" || Number.parseInt(r.maturity, 10) >= 3));
  if (!pool.length) return null;
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 864e5);
  return pool[(day * 7919) % pool.length];
}

// A name's path through the versions, from data/history.json ({ in: [...], steps: { "R4-R4B": 0 } }):
// [{ version, kind, from?, count? }] where kind is "baseline" (the first version covered),
// "new", "same", "changed", "later" (not in FHIR yet) or "removed".
export function historySteps(entry) {
  const present = new Set(entry?.in ?? []);
  let prev = null;
  return VERSIONS.map((v) => {
    if (!present.has(v)) return prev ? { version: v, kind: "removed", from: prev } : { version: v, kind: "later" };
    const from = prev;
    prev = v;
    if (!from) return { version: v, kind: v === VERSIONS[0] ? "baseline" : "new" };
    const count = entry.steps?.[`${from}-${v}`] ?? 0;
    return { version: v, kind: count ? "changed" : "same", from, count };
  });
}

export function hintsFor(query) {
  const words = new Set((query.toLowerCase().match(/[a-z]+/g) || []));
  return HINTS.filter((h) => h.words.some((w) => words.has(w))).map((h) => h.text);
}

export function elementUrl(version, path, isResource) {
  const root = path.split(".")[0];
  const page = isResource ? `${root.toLowerCase()}-definitions.html` : "datatypes-definitions.html";
  return `${HL7}/${version}/${page}#${path}`;
}

export function resourceUrl(version, name, kind) {
  return kind === "resource" ? `${HL7}/${version}/${name.toLowerCase()}.html` : `${HL7}/${version}/datatypes.html#${name}`;
}

export function extensionUrl(ext, version) {
  if (ext.in.some((s) => s.startsWith("Pack"))) return `${HL7}/extensions/StructureDefinition-${ext.id}.html`;
  const v = version === "R5" ? "R4" : version;
  return `${HL7}/${v}/extension-${ext.id.toLowerCase()}.html`;
}
