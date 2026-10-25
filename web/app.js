// Interop Mapper: offline FHIR dictionary UI.
import {
  VERSIONS, prepareIndex, searchElements, searchResources, prepareExtensions, searchExtensions,
  hintsFor, elementUrl, resourceUrl, extensionUrl, nameParts, entryOfTheDay, historySteps,
} from "./lib.js";
import {
  useDatatypes, elementExample, resourceExample, createSnippets, accessors, fhirpath, searchExample,
  storyParts, parseTypes, plainCardinality, exampleChunks, elementForKey,
} from "./codegen.js";

// ---------- small helpers ----------

const $ = (sel) => document.querySelector(sel);

// Flattens nested children and drops empty ones (false, null, ""), so optional
// sections can be written as `condition && [...]`. Text is always inserted as text.
function nodes(kids) {
  return kids.flat(Infinity)
    .filter((k) => k !== undefined && k !== null && k !== false && k !== "")
    .map((k) => (k instanceof Node ? k : document.createTextNode(String(k))));
}

// Replaces a container's contents; use instead of replaceChildren for the reason above.
const fill = (target, ...kids) => target.replaceChildren(...nodes(kids));

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...nodes(kids));
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...nodes(kids));
  return node;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: settings just won't persist */ } },
};

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const cleanText = (s) => (s || "")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/\*\*([^*]+)\*\*/g, "$1");

const paragraphs = (s) => cleanText(s).split(/\n+/).map((p) => p.trim()).filter(Boolean).map((p) => el("p", {}, p));
const firstSentence = (s) => {
  // HL7 text sometimes continues into a markdown list: "There are multiple use cases: * Duplicate…"
  const text = cleanText(s).replace(/\s+/g, " ").trim().split(/:\s*\*\s/)[0].replace(/\s\*\s/g, " ");
  const one = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? `${text.replace(/[,;:]$/, "")}.`;
  return one.length > 170 ? `${one.slice(0, 169)}…` : one;
};
// A code list as HL7 writes it, minus the trailing "+" that marks it as open to more codes.
const shortText = (s) => cleanText(s).replace(/\s*\+$/, "");

// One resource's own line from a shared search parameter description:
// "Multiple Resources: * [Patient](patient.html): A postalCode specified in an address * [Person]…"
function searchDescription(desc, name) {
  const own = (desc || "").match(new RegExp(`\\* \\[${name}\\]\\([^)]*\\): ([^\\n*]*)`));
  return cleanText(own ? own[1] : desc).replace(/^Multiple Resources:\s*/i, "").replace(/\s\*\s/g, " ").trim();
}
const mono = (text) => el("span", { class: "mono" }, text);
const tag = (text, cls = "tag", title) => (text ? el("span", { class: cls, title }, text) : null);
const extLink = (href, text = "Open on hl7.org ↗") => el("a", { class: "btn small quiet", href, target: "_blank", rel: "noopener" }, text);
const storyHref = (name, v) => `#story?r=${encodeURIComponent(name)}${v ? `&v=${v}` : ""}`;
const typeText = (e) => e.types || (e.contentRef ? `same as ${e.contentRef}` : "");
const lastSeg = (path) => path.split(".").pop();
const joinNames = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const withArticle = (name) => `${/^[AEIOU]/.test(name) ? "an" : "a"} ${name}`;
const byName = (a, b) => a.name.localeCompare(b.name);

// A name set like a dictionary headword, its parts divided by --syllable-mark (Medication·Request).
// The marks are drawn by CSS, so copying the word copies the real name; it may wrap at a mark.
function syllables(name) {
  const parts = nameParts(name);
  return parts.map((p, i) => [el("span", { class: "syl" }, p), i < parts.length - 1 && el("wbr")]);
}

// A long name that may wrap between its parts (CoverageEligibility|Response), never inside one.
const breakable = (name) => nameParts(name).map((p, i) => [i > 0 && el("wbr"), p]);

function section(title, note, ...kids) {
  return el("section", { class: "section" },
    el("div", { class: "section-head" }, el("h2", { class: "section-title" }, title), note && el("p", { class: "section-note" }, note)),
    kids);
}

// "Try date of birth, lab normal range or …" with each example clickable.
function tryLine(examples, pick) {
  return el("p", { class: "try" }, "Try ", examples.map((x, i) => [
    i === 0 ? "" : i === examples.length - 1 ? " or " : ", ",
    el("button", { class: "linklike", type: "button", onclick: () => pick(x) }, x)]), ".");
}

function copyButton(text, caption = "Copy") {
  return el("button", {
    class: "btn small",
    type: "button",
    onclick: (ev) => {
      const b = ev.currentTarget;
      navigator.clipboard?.writeText(text).then(() => {
        b.textContent = "Copied";
        setTimeout(() => { b.textContent = caption; }, 1200);
      }).catch(() => {});
    },
  }, caption);
}

function downloadButton(filename, text) {
  return el("button", {
    class: "btn small",
    type: "button",
    onclick: () => {
      const url = URL.createObjectURL(new Blob([text], { type: "application/fhir+json" }));
      const a = el("a", { href: url, download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  }, "Download");
}

function codeBlock(text, { caption, filename } = {}) {
  return el("div", { class: "code" },
    el("div", { class: "code-bar" }, el("span", {}, caption || ""), el("span", { class: "spacer" }),
      copyButton(text), filename && downloadButton(filename, text)),
    el("pre", {}, el("code", {}, text)));
}

// JSON / Python / JavaScript / curl tabs over one example.
function codeTabs(snippets, filename) {
  const langs = [["json", "JSON"], ["python", "Python"], ["javascript", "JavaScript"], ["curl", "curl"]]
    .filter(([k]) => snippets[k]);
  const holder = el("div");
  const bar = el("div", { class: "segmented small", role: "tablist", "aria-label": "Language" });
  const show = (key) => {
    for (const b of bar.children) b.setAttribute("aria-selected", String(b.dataset.k === key));
    fill(holder, codeBlock(snippets[key], {
      caption: key === "curl" ? `Save the JSON as ${filename} first` : "",
      filename: key === "json" ? filename : null,
    }));
  };
  for (const [k, text] of langs) bar.append(el("button", { role: "tab", type: "button", "data-k": k, onclick: () => show(k) }, text));
  show(langs[0][0]);
  return el("div", { class: "code-tabs" }, bar, holder);
}

function table(headers, rows) {
  return el("div", { class: "table-wrap" }, el("table", {},
    headers && el("thead", {}, el("tr", {}, headers.map((h) => el("th", {}, h)))),
    el("tbody", {}, rows.map((cells) => el("tr", {}, cells.map((c) => el("td", {}, c)))))));
}

// ---------- data: fetched once, then served from the offline cache ----------

const memo = new Map();
const once = (key, make) => { if (!memo.has(key)) memo.set(key, make()); return memo.get(key); };
// The single-file offline copy (src/build_offline.py) carries its data inside the page.
const loadData = (path) => (window.interopData ? window.interopData.load(path) : fetch(`data/${path}`).then((r) => {
  if (!r.ok) throw new Error(`Couldn't load ${path} (${r.status})`);
  return r.json();
}));
const getJSON = (path) => once(path, () => loadData(path));
const indexOf = (v) => once(`idx:${v}`, async () => {
  const [rows, resources] = await Promise.all([getJSON(`${v}/index.json`), getJSON(`${v}/resources.json`)]);
  return prepareIndex(rows, resources);
});
const pathMapOf = (v) => once(`map:${v}`, () => indexOf(v).then((rows) => new Map(rows.map((r) => [r.path, r]))));
const resourcesOf = (v) => getJSON(`${v}/resources.json`);
const kindsOf = (v) => once(`kinds:${v}`, () => resourcesOf(v).then((list) => new Map(list.map((r) => [r.name, r.kind]))));
const datatypesOf = (v) => getJSON(`${v}/datatypes.json`);
const extensions = () => once("ext", () => getJSON("extensions.json").then(prepareExtensions));
const historyOf = () => getJSON("history.json");
const resourceFile = (v, name) => getJSON(`${v}/res/${name}.json`);

const FORWARD = ["R4-R4B", "R4B-R5", "R4-R5"];

function invertDiffs(diffs) {
  const out = {};
  for (const [name, d] of Object.entries(diffs)) {
    if (d.missing_in) { out[name] = d; continue; }
    out[name] = {
      added: d.removed,
      removed: d.added,
      changed: d.changed.map((c) => Object.fromEntries(
        Object.entries(c).map(([k, v]) => [k, Array.isArray(v) ? [...v].reverse() : v]))),
      renames: d.renames.map((r) => ({ ...r, from: r.to, to: r.from })),
    };
  }
  return out;
}

const diffsBetween = (a, b) => (FORWARD.includes(`${a}-${b}`)
  ? getJSON(`diffs/${a}-${b}.json`)
  : once(`inv:${a}-${b}`, () => getJSON(`diffs/${b}-${a}.json`).then(invertDiffs)));

// ---------- state, version picker and routing ----------

const TABS = ["find", "story", "compare", "extensions"];
const OUT = { find: "find-out", story: "story-out", compare: "compare-out", extensions: "ext-out" };

const state = {
  version: VERSIONS.includes(store.get("version")) ? store.get("version") : "R4",
  tab: "find",
  detail: null,
};

function readHash() {
  const [tab, query] = location.hash.slice(1).split("?");
  return { tab: TABS.includes(tab) ? tab : "find", params: new URLSearchParams(query || "") };
}

function writeHash(tab, params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v && v.trim())).toString();
  history.replaceState(null, "", `#${tab}${qs ? `?${qs}` : ""}`);
}

function renderVersionPicker() {
  $("#version").replaceChildren(...VERSIONS.map((v) => el("button", {
    role: "radio", type: "button", "aria-checked": String(v === state.version), onclick: () => setVersion(v),
  }, v)));
}

function setVersion(v) {
  state.version = v;
  store.set("version", v);
  renderVersionPicker();
  renderTab();
  if (state.detail?.type === "element") openElement(v, state.detail.path);
}

function renderTab() {
  const run = { find: renderFind, story: renderStory, compare: renderCompare, extensions: renderExtensions }[state.tab];
  run().catch((err) => {
    fill($(`#${OUT[state.tab]}`), el("p", { class: "note" }, err.message,
      ". If you're offline, open the app once while online to save its data."));
  });
}

function route() {
  let { tab, params } = readHash();
  if (tab === "story" && !params.get("r")) {
    tab = "find";
    history.replaceState(null, "", "#find");
  }
  state.tab = tab;
  document.body.dataset.tab = tab;
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== tab;
  const navTab = tab === "story" ? "find" : tab; // a resource page belongs to Look up
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === navTab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const v = params.get("v");
  if (VERSIONS.includes(v) && v !== state.version) {
    state.version = v;
    store.set("version", v);
    renderVersionPicker();
  }
  if (tab === "find") findInput.value = params.get("q") || "";
  if (tab === "story") storyName.value = "";
  if (tab === "compare") {
    if (params.has("r")) cmpName.value = params.get("r");
    if (VERSIONS.includes(params.get("from"))) cmpFrom.value = params.get("from");
    if (VERSIONS.includes(params.get("to"))) cmpTo.value = params.get("to");
  }
  if (tab === "extensions") {
    if (params.has("q")) extQ.value = params.get("q");
    if (params.has("on")) extOn.value = params.get("on");
  }
  if (tab === "story" && state.detail) closeDetail();
  renderTab();
  window.scrollTo(0, 0);
}

// The sticky header's height, so the drawer and jump targets sit just below it.
function trackHeaderHeight() {
  const header = $("#top");
  // On phones the header scrolls away (it isn't sticky there), so nothing needs to clear it.
  const apply = () => document.documentElement.style.setProperty("--header-h",
    `${getComputedStyle(header).position === "sticky" ? header.offsetHeight : 0}px`);
  new ResizeObserver(apply).observe(header);
  window.addEventListener("resize", apply);
  apply();
}

// ---------- detail panel (one field) ----------

const detail = $("#detail");
const detailBody = $("#detail-body");
const layout = $(".layout");

function showDetail(...content) {
  fill(detailBody, content);
  detail.hidden = false;
  layout.classList.add("with-detail");
  detail.scrollTop = 0;
  if (window.matchMedia("(max-width: 999px)").matches) $("#detail-close").focus({ preventScroll: true });
}

function closeDetail() {
  detail.hidden = true;
  layout.classList.remove("with-detail");
  state.detail = null;
  markActive(null);
}

function markActive(path) {
  for (const b of document.querySelectorAll("main [data-path]")) b.classList.toggle("active", b.dataset.path === path);
}

const detailSection = (title, ...kids) => el("section", { class: "d-sec" }, el("h4", {}, title), kids);

function resultButton(f, v) {
  const dot = f.path.lastIndexOf(".");
  return el("button", { class: "result", type: "button", "data-path": f.path, onclick: () => openElement(v, f.path) },
    el("span", { class: "r-head" },
      el("span", { class: "r-path" }, dot > 0 && el("span", { class: "r-root" }, f.path.slice(0, dot + 1)),
        el("b", {}, f.path.slice(dot + 1))),
      el("span", { class: "r-pos" }, `${f.card} ${f.types}`),
      !f.isResource && el("span", { class: "r-kind" }, "inside a datatype")),
    f.short && el("span", { class: "r-short" }, f.short));
}

async function versionTable(path, current) {
  const root = path.split(".")[0];
  const rows = await Promise.all(VERSIONS.map(async (ver) => {
    const hit = (await pathMapOf(ver)).get(path);
    if (hit) return [el("b", {}, ver), mono(hit.card), mono(hit.types)];
    let note = "";
    if (ver !== current) {
      const d = (await diffsBetween(current, ver))[root];
      const r = d?.renames?.find((x) => x.from === path);
      if (r) note = `likely renamed to ${r.to}`;
      else if (d?.missing_in === ver) note = `${root} isn't in ${ver}`;
    }
    return [el("b", {}, ver), tag("not present", "tag bad"), note];
  }));
  return table(["Version", "Cardinality", "Type"], rows);
}

// The field's path, which may wrap after a dot but never inside a name.
function fieldHeading(path) {
  const segs = path.split(".");
  return el("h3", { class: "d-word" },
    el("span", { class: "d-root" }, segs.slice(0, -1).map((s) => [s, ".", el("wbr")])), segs.at(-1));
}

async function openElement(v, path) {
  state.detail = { type: "element", path };
  markActive(path);
  const root = path.split(".")[0];
  let file;
  try { file = await resourceFile(v, root); } catch {
    showDetail(fieldHeading(path), el("p", {}, `${root} isn't part of ${v}.`), await versionTable(path, v));
    return;
  }
  const e = file.elements.find((x) => x.path === path);
  if (!e) {
    showDetail(fieldHeading(path), el("p", {}, `Not part of ${root} in ${v}.`),
      detailSection("In other versions", await versionTable(path, v)));
    return;
  }
  useDatatypes(await datatypesOf(v));
  const example = elementExample(file, path);
  const access = accessors(file, path);
  const searches = (e.search || []).map((p) => searchExample(root, p, e)).filter(Boolean);
  const fieldName = lastSeg(path).replace("[x]", "");
  const parents = path.split(".").slice(1, -1);
  const short = cleanText(e.short);

  showDetail(
    el("p", { class: "d-crumb" }, el("a", { href: storyHref(root, v) }, root), parents.map((p) => ` / ${p}`)),
    fieldHeading(path),
    el("p", { class: "d-pos" }, el("i", {}, typeText(e) || "element"), "  ", mono(e.card), ", ", plainCardinality(e.card)),
    e.modifier && el("p", { class: "d-flag" }, el("mark", {}, "Read first"),
      " It changes what the rest of the record means, so systems must understand it."),
    e.summary && el("p", { class: "d-flag quiet" }, "Included in summary views."),
    short && short !== cleanText(e.definition) && el("p", { class: "d-short" }, short),
    el("div", { class: "d-def" }, paragraphs(e.definition)),
    e.requirements && detailSection("Why it exists", el("blockquote", { class: "why" }, paragraphs(e.requirements))),
    e.contentRef && el("p", { class: "note" }, "Same structure as ",
      el("button", { class: "linklike", type: "button", onclick: () => openElement(v, e.contentRef) }, e.contentRef),
      " (it nests inside itself)."),
    e.comment && detailSection("Notes", el("div", { class: "d-notes" }, paragraphs(e.comment))),
    e.binding && detailSection("Codes", el("p", { class: "mono d-binding" }, e.binding)),
    detailSection("Use it in code",
      example
        ? codeBlock(JSON.stringify(example, null, 2), {
          caption: file.kind === "resource" ? "JSON (example values)" : `JSON inside any ${root} field`,
          filename: `${root}-${fieldName}.json`,
        })
        : el("p", { class: "note" }, file.abstract
          ? `${root} is abstract: other resources follow its pattern, so you never create it directly.`
          : "No example for this field."),
      table(null, [
        ["FHIRPath", mono(fhirpath(e))],
        access && ["Python", mono(access.python)],
        access && ["JavaScript", mono(access.javascript)],
      ].filter(Boolean)),
      searches.length > 0 && [el("p", { class: "d-sub" }, "Search by it"),
        searches.map((s) => codeBlock(s, { caption: "FHIR search query" }))]),
    detailSection("In other versions", await versionTable(path, v)),
    el("div", { class: "actions" },
      extLink(elementUrl(v, path, file.kind === "resource")),
      copyButton(path, "Copy path"),
      el("a", { class: "btn small quiet", href: storyHref(root, v) }, `All of ${root}`)),
  );
}

// ---------- Look up ----------

const findInput = $("#find-q");
const FIND_EXAMPLES = ["date of birth", "lab normal range", "preferred language", "insurance member id", "Encounter.class"];

function dictionaryEntry(r, v) {
  return el("li", {},
    el("a", { class: "az-name", href: storyHref(r.name, v) }, r.name),
    r.abstract && el("span", { class: "az-flag" }, " abstract"),
    r.summary && el("span", { class: "az-sum" }, cleanText(r.summary)));
}

function jumpTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

// Running heads, as printed at the top of a dictionary page: the first and last entry on it.
function guideWords(items) {
  const first = items[0].name;
  const last = items.at(-1).name;
  return el("p", { class: "guide", "aria-label": items.length > 1 ? `${first} to ${last}` : first },
    el("span", {}, breakable(first)), items.length > 1 && el("span", {}, "– ", breakable(last)));
}

// Every resource and datatype, A to Z, with a thumb index like a printed dictionary.
async function azIndex(v) {
  const list = await resourcesOf(v);
  const resources = list.filter((r) => r.kind === "resource").sort(byName);
  const datatypes = list.filter((r) => r.kind !== "resource").sort(byName);
  const groups = new Map();
  for (const r of resources) {
    const letter = r.name[0].toUpperCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(r);
  }
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  return el("section", { class: "az", "aria-labelledby": "az-title" },
    el("div", { class: "section-head az-head" },
      el("h2", { class: "section-title", id: "az-title" }, `Every resource in ${v}`),
      el("p", { class: "section-note" }, `${resources.length} resources and ${datatypes.length} datatypes. `,
        "Open one to see what it is for, why its fields exist and how to create it in code.")),
    el("div", { class: "az-body" },
      el("nav", { class: "thumbs", "aria-label": "Jump to a letter" },
        letters.map((L) => (groups.has(L)
          ? el("button", { type: "button", "data-letter": L, onclick: () => jumpTo(`az-${L}`), "aria-label": `Resources starting with ${L}` }, L)
          : el("span", { class: "off", "aria-hidden": "true" }, L))),
        el("button", { type: "button", class: "wide", "data-letter": "datatypes", onclick: () => jumpTo("az-datatypes") }, "Datatypes")),
      el("div", { class: "az-groups" },
        [...groups].map(([L, items]) => el("div", { class: "az-group", id: `az-${L}`, "data-letter": L },
          el("div", { class: "az-side" }, el("h3", { class: "az-letter" }, L), guideWords(items)),
          el("ul", { class: "az-list" }, items.map((r) => dictionaryEntry(r, v))))),
        el("div", { class: "az-group", id: "az-datatypes", "data-letter": "datatypes" },
          el("div", { class: "az-side" }, el("h3", { class: "az-letter small" }, "Datatypes"), guideWords(datatypes)),
          el("div", {},
            el("p", { class: "section-note az-note" }, "Building blocks used inside resources, such as a name, an address or a quantity."),
            el("ul", { class: "az-list" }, datatypes.map((r) => dictionaryEntry(r, v))))))));
}

// Marks the thumb-index letter of the section being read, like a finger in a printed dictionary.
let thumbQueued = false;
function markThumb() {
  thumbQueued = false;
  const groups = document.querySelectorAll("#find-out .az-group");
  if (!groups.length) return;
  const line = (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 0) + 90;
  let current = null;
  for (const g of groups) {
    if (g.getBoundingClientRect().top <= line) current = g.dataset.letter;
    else break;
  }
  for (const b of document.querySelectorAll(".thumbs [data-letter]")) {
    if (b.dataset.letter === current) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  }
}
window.addEventListener("scroll", () => {
  if (state.tab !== "find" || thumbQueued) return;
  thumbQueued = true;
  requestAnimationFrame(markThumb);
}, { passive: true });

// One well-established resource a day, set as a dictionary slip beside the search.
async function renderEntryOfTheDay(v) {
  const box = $("#eotd");
  const r = entryOfTheDay(await resourcesOf(v));
  if (state.version !== v || !r) return;
  const href = storyHref(r.name, v);
  fill(box,
    el("p", { class: "eotd-label" }, "Entry of the day"),
    el("a", { class: "eotd-word", href, "aria-label": r.name }, syllables(r.name)),
    el("p", { class: "eotd-pos" }, el("i", {}, "resource"),
      r.status === "normative" ? ", normative" : `, maturity ${r.maturity} of 5`),
    el("p", { class: "eotd-def" }, cleanText(r.summary)),
    el("a", { class: "eotd-more", href }, `Read the ${r.name} entry`));
}

async function renderFind() {
  const q = findInput.value;
  const out = $("#find-out");
  writeHash("find", { q });
  const v = state.version;
  const pick = (x) => { findInput.value = x; renderTab(); findInput.focus(); };
  $("#tab-find").classList.toggle("searching", !!q.trim());
  fill($("#find-try"), !q.trim() && tryLine(FIND_EXAMPLES, pick));
  if (!q.trim()) {
    const [index] = await Promise.all([azIndex(v), renderEntryOfTheDay(v)]);
    if (findInput.value.trim() || state.version !== v) return;
    fill(out, index);
    markThumb();
    return;
  }
  const [idx, res] = await Promise.all([indexOf(v), resourcesOf(v)]);
  if (findInput.value !== q || state.version !== v) return; // a newer search has started
  const fields = searchElements(idx, q, 40);
  const resources = searchResources(res, q);
  fill(out,
    hintsFor(q).map((h) => el("p", { class: "hint" }, h)),
    resources.length > 0 && [
      el("h2", { class: "results-head" }, `Resources in ${v}`),
      el("ul", { class: "az-list matches" }, resources.map((r) => dictionaryEntry(r, v)))],
    el("h2", { class: "results-head" }, fields.length ? `Fields in ${v}` : `No fields in ${v} match “${q}”`),
    fields.length > 0
      ? el("div", { class: "list" }, fields.map((f) => resultButton(f, v)))
      : el("p", { class: "empty" }, "Try other words, or ",
        el("a", { href: `#extensions?q=${encodeURIComponent(q)}` }, "search the official extensions"), "."),
  );
  if (state.detail?.type === "element") markActive(state.detail.path);
}

// ---------- Resource page ----------

const storyName = $("#story-name");

function fieldRow(e, v) {
  return el("button", { class: "result compact", type: "button", "data-path": e.path, onclick: () => openElement(v, e.path) },
    el("span", { class: "r-head" },
      el("span", { class: "r-path" }, el("b", {}, e.path.split(".").slice(1).join("."))),
      el("span", { class: "r-pos" }, `${e.card} ${typeText(e)}`),
      e.modifier && el("mark", { class: "r-mark" }, "read first")),
    e.short && el("span", { class: "r-short" }, shortText(e.short)),
    e.requirements && el("span", { class: "why-line" }, `Why: ${firstSentence(e.requirements)}`));
}

// --- anatomy plate: the example record, with each top-level field labelled ---

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const REFERENCE_VALUE = /^"[A-Z][A-Za-z]+\/[^"\s]+"$/; // "Organization/example"

function highlightLine(line, isTopLine) {
  const out = [];
  let last = 0;
  let firstKey = isTopLine;
  for (const m of line.matchAll(JSON_TOKEN)) {
    if (m.index > last) out.push(line.slice(last, m.index));
    if (m[1] && m[2]) {
      out.push(el("span", { class: firstKey ? "j-key j-top" : "j-key" }, m[1]), m[2]);
      firstKey = false;
    } else if (m[1]) {
      out.push(el("span", { class: REFERENCE_VALUE.test(m[1]) ? "j-ref" : "j-str" }, m[1]));
    } else {
      out.push(el("span", { class: "j-lit" }, m[0]));
    }
    last = m.index + m[0].length;
  }
  out.push(line.slice(last));
  return out;
}

function plateNote(key, e, file, v) {
  if (!e) {
    return el("div", { class: "pn fixed" },
      el("span", { class: "pn-name" }, key),
      el("span", { class: "pn-meta" }, `always "${file.name}"`),
      el("span", { class: "pn-short" }, "Tells a server which kind of record this is."));
  }
  const types = parseTypes(e.types);
  const choice = e.path.endsWith("[x]");
  const targets = [...new Set(types.flatMap((t) => (t.code === "Reference" || t.code === "CodeableReference" ? t.targets : [])))]
    .filter((t) => t !== "Resource");
  const meta = [plainCardinality(e.card)];
  if (choice) meta.push(types.length > 4 ? `one of ${types.length} types` : `one of ${joinNames(types.map((t) => t.code))}`);
  else if (targets.length) meta.push(`points to ${joinNames(targets.length > 3 ? [...targets.slice(0, 3), "more"] : targets)}`);
  const kinds = ["pn", e.modifier && "mod", !choice && targets.length && "ref", /^[1-9]/.test(e.card) && "req"];
  return el("button", {
    class: kinds.filter(Boolean).join(" "), type: "button", "data-path": e.path,
    onclick: () => openElement(v, e.path),
  },
  el("span", { class: "pn-name" }, key),
  el("span", { class: "pn-meta" }, meta.join(", ")),
  e.modifier && el("span", { class: "pn-flag" }, "Read first: it changes what the record means."),
  e.short && el("span", { class: "pn-short" }, shortText(e.short)),
  e.requirements && el("span", { class: "pn-why" }, firstSentence(e.requirements)));
}

function anatomyPlate(file, example, v) {
  const rows = exampleChunks(example, 58).map((chunk) => {
    const e = chunk.key && chunk.key !== "resourceType" ? elementForKey(file, chunk.key) : null;
    const pre = el("pre", { class: "chunk" },
      chunk.lines.map((line, i) => [el("span", { class: "ln" }, highlightLine(line, i === 0 && !!chunk.key)), "\n"]));
    if (!chunk.key) return el("div", { class: "plate-row edge" }, pre);
    const kinds = ["plate-row", e?.modifier && "mod"].filter(Boolean).join(" ");
    return el("div", { class: kinds, "data-key": chunk.key }, pre, plateNote(chunk.key, e, file, v));
  });
  return el("figure", { class: "plate" },
    el("div", { class: "plate-body" }, rows, svg("svg", { class: "leaders", "aria-hidden": "true" })),
    el("figcaption", { class: "legend" },
      el("span", { class: "lg req" }, "Bold label: required"),
      el("span", { class: "lg mod" }, "Highlighted: read first"),
      el("span", { class: "lg ref" }, "Red: points to another record"),
      el("span", {}, "Example values; select a field for its full definition.")));
}

const PLATE_GAP = 56;
const NOTE_MIN = 200;
const NOTE_MAX = 300;

// Wide screens: the example sits in the middle and labels go to both sides with leader lines,
// like an anatomy plate. Narrow screens: each label follows its lines of JSON.
function layoutPlate(plate) {
  if (!plate.isConnected) return;
  const body = plate.querySelector(".plate-body");
  const leaders = plate.querySelector(".leaders");
  const notes = [...body.querySelectorAll(".pn")];
  const pres = [...body.querySelectorAll(".chunk")];

  const probe = el("span", {}, "0".repeat(40));
  pres[0].append(probe);
  const charW = probe.getBoundingClientRect().width / 40;
  probe.remove();
  const maxChars = Math.max(...pres.flatMap((p) => p.textContent.split("\n").map((l) => l.length)));
  const specW = Math.ceil(maxChars * charW + 40);
  const width = body.clientWidth;
  const noteW = Math.min(NOTE_MAX, Math.floor((width - specW - 2 * PLATE_GAP) / 2));

  if (noteW < NOTE_MIN || notes.length === 0) {
    plate.classList.remove("is-wide");
    for (const n of notes) { n.classList.remove("left", "right"); n.style.top = ""; n.style.left = ""; n.style.width = ""; }
    body.style.minHeight = "";
    leaders.replaceChildren();
    return;
  }

  const offset = Math.floor((width - (specW + 2 * PLATE_GAP + 2 * noteW)) / 2);
  const leftX = offset;
  const specX = offset + noteW + PLATE_GAP;
  const rightX = specX + specW + PLATE_GAP;
  plate.classList.add("is-wide");
  plate.style.setProperty("--spec-w", `${specW}px`);
  plate.style.setProperty("--spec-x", `${specX}px`);
  for (const n of notes) n.style.width = `${noteW}px`;

  const box = body.getBoundingClientRect();
  const items = notes.map((n) => {
    const row = n.closest(".plate-row");
    const line = row.querySelector(".ln").getBoundingClientRect();
    const key = (row.querySelector(".j-top") ?? row.querySelector(".ln")).getBoundingClientRect();
    return {
      n,
      y: line.top - box.top + line.height / 2,
      lineEnd: line.right - box.left,
      keyStart: key.left - box.left,
      nameH: n.querySelector(".pn-name").offsetHeight,
      h: n.offsetHeight,
    };
  });
  // Each label goes to the side where it can sit closest to its line; ties alternate.
  const floor = { left: 0, right: 0 };
  let last = "right";
  let bottom = 0;
  for (const it of items) {
    const want = Math.round(it.y - it.nameH / 2);
    const top = { left: Math.max(want, floor.left), right: Math.max(want, floor.right) };
    const side = top.left === top.right ? (last === "left" ? "right" : "left") : top.left < top.right ? "left" : "right";
    last = side;
    it.left = side === "left";
    it.n.classList.toggle("left", it.left);
    it.n.classList.toggle("right", !it.left);
    it.n.style.left = `${it.left ? leftX : rightX}px`;
    it.n.style.top = `${top[side]}px`;
    it.labelY = top[side] + it.nameH / 2;
    floor[side] = top[side] + it.h + 16;
    bottom = Math.max(bottom, top[side] + it.h);
  }
  body.style.minHeight = `${bottom}px`;

  const draw = plate.dataset.drawn !== "1" && !reducedMotion();
  const H = Math.max(bottom, body.offsetHeight);
  leaders.setAttribute("viewBox", `0 0 ${width} ${H}`);
  leaders.classList.toggle("draw", draw);
  leaders.replaceChildren(...items.flatMap((it, i) => {
    const kind = ["ref", "mod", "req"].find((k) => it.n.classList.contains(k)) || "";
    const x0 = it.left ? it.keyStart - 5 : it.lineEnd + 5;
    const edge = it.left ? specX - 12 : specX + specW + 12;
    const xLabel = it.left ? leftX + noteW + 8 : rightX - 8;
    const bend = it.left ? xLabel + 18 : xLabel - 18;
    const path = svg("path", {
      class: `leader ${kind}`,
      d: `M${x0},${it.y} H${edge} L${bend},${it.labelY} H${xLabel}`,
    });
    path.style.setProperty("--i", i);
    const dot = svg("circle", { class: `leader-dot ${kind}`, cx: x0, cy: it.y, r: 2.6 });
    dot.style.setProperty("--i", i);
    return [path, dot];
  }));
  if (draw) {
    for (const p of leaders.querySelectorAll("path")) p.style.setProperty("--len", Math.ceil(p.getTotalLength()));
    plate.dataset.drawn = "1";
  }
}

let plateObserver = null;
function watchPlate(plate) {
  plateObserver?.disconnect();
  let queued = false;
  plateObserver = new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; layoutPlate(plate); });
  });
  plateObserver.observe(plate);
  document.fonts?.ready.then(() => layoutPlate(plate));
}

// --- connections diagram: veins in (blue), arteries out (red) ---

const viaText = (paths) => {
  const names = [...new Set(paths.map((p) => p.split(".").slice(1).join(".")))];
  const text = `via ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}`;
  return text.length > 30 ? `${text.slice(0, 29)}…` : text;
};
const shorten = (s, n = 26) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const DIAGRAM_ROWS = 8; // per side; the rest are listed under the diagram
// Rows a side shows: all of them when one more row would take the place of a "+1 more" row anyway.
const shownRows = (list) => (list.length <= DIAGRAM_ROWS + 1 ? list.length : DIAGRAM_ROWS);

// Left: what points to this resource. Right: what it points to. Select a name to open it.
function connectionsDiagram(name, parts, v) {
  const left = parts.pointedBy.slice(0, shownRows(parts.pointedBy)).map((x) => ({ name: x.name, target: x.name, via: viaText(x.paths) }));
  if (parts.pointedBy.length > left.length) {
    left.push({ name: `+${parts.pointedBy.length - left.length} more`, via: "listed below", target: null });
  }
  const right = parts.pointsTo.slice(0, shownRows(parts.pointsTo)).map((x) => ({
    name: x.name === "Resource" ? "Any resource" : x.name === name ? `${name} (itself)` : x.name,
    target: x.name === "Resource" ? null : x.name,
    via: viaText(x.paths),
  }));
  if (parts.pointsTo.length > right.length) {
    right.push({ name: `+${parts.pointsTo.length - right.length} more`, via: "listed below", target: null });
  }
  const W = 760; const rowH = 46; const top = 40;
  const rows = Math.max(left.length, right.length, 1);
  const H = top + rows * rowH;
  const cw = Math.min(230, Math.max(130, name.length * 10.5 + 44));
  const cx = (W - cw) / 2;
  const cy = top + (rows * rowH) / 2 - 24;
  const colY = (i, count) => top + i * rowH + ((rows - count) * rowH) / 2;

  const node = (item, x, y, anchor) => {
    const clickable = !!item.target;
    const go = () => { location.hash = storyHref(item.target, v); };
    const tx = anchor === "end" ? x + 236 : x + 4;
    return svg("g", {
      class: clickable ? "dg-node dg-link" : "dg-node",
      ...(clickable ? { tabindex: "0", role: "link", "aria-label": `${item.name}, ${item.via}`, onclick: go,
        onkeydown: (e) => { if (e.key === "Enter") go(); } } : {}),
    },
    svg("rect", { class: "dg-hit", x, y: y + 2, width: 240, height: rowH - 4, rx: 6 }),
    svg("text", { x: tx, y: y + 20, "text-anchor": anchor, class: "dg-name" }, shorten(item.name)),
    svg("text", { x: tx, y: y + 36, "text-anchor": anchor, class: "dg-via" }, item.via));
  };
  const curve = (x1, y1, x2, y2, dir) => svg("path", {
    d: `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`,
    class: `dg-edge ${dir}`, "marker-end": `url(#dg-arrow-${dir})`,
  });
  const marker = (dir) => svg("marker", {
    id: `dg-arrow-${dir}`, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto",
  }, svg("path", { d: "M0,1 L9,5 L0,9 z", class: `dg-arrow ${dir}` }));

  return svg("svg", {
    viewBox: `0 0 ${W} ${H}`, class: "diagram", role: "group",
    "aria-label": `${name}: ${parts.pointedBy.length} kinds of records point to it; it points to ${parts.pointsTo.length}.`,
  },
  svg("defs", {}, marker("in"), marker("out")),
  left.length > 0 && svg("text", { x: 240, y: 18, "text-anchor": "end", class: "dg-head in" }, "Point to it"),
  right.length > 0 && svg("text", { x: W - 240, y: 18, class: "dg-head out" }, "It points to"),
  left.map((item, i) => {
    const y = colY(i, left.length);
    return [curve(246, y + rowH / 2, cx - 4, cy + 24, "in"), node(item, 0, y, "end")];
  }),
  right.map((item, i) => {
    const y = colY(i, right.length);
    return [curve(cx + cw, cy + 24, W - 250, y + rowH / 2, "out"), node(item, W - 240, y, "start")];
  }),
  svg("g", { class: "dg-center" },
    svg("rect", { x: cx, y: cy, width: cw, height: 48, rx: 24 }),
    svg("text", { x: cx + cw / 2, y: cy + 30, "text-anchor": "middle" }, shorten(name, 22))));
}

function connectionList(title, items, v) {
  return el("details", {}, el("summary", {}, title),
    el("ul", { class: "az-list matches" }, items.map((x) => el("li", {},
      x.name === "Resource"
        ? el("span", { class: "az-name" }, "Any resource")
        : el("a", { class: "az-name", href: storyHref(x.name, v) }, x.name),
      el("span", { class: "az-sum" }, viaText(x.paths))))));
}

// Part of speech, as a dictionary prints it, and where a pronunciation would go, how a server
// addresses one of these.
function entryLine(file) {
  const isRes = file.kind === "resource";
  const bits = [];
  if (file.status === "normative") bits.push("normative, stable across versions");
  else if (file.maturity) bits.push(`maturity ${file.maturity} of 5`);
  if (file.abstract) bits.push("abstract");
  return el("p", { class: "pos" }, el("span", {}, el("i", {}, isRes ? "resource" : "datatype"), bits.length ? `, ${bits.join(", ")}` : ""),
    isRes && !file.abstract && el("span", { class: "say", title: "How a FHIR server addresses one" }, `[base]/${file.name}/[id]`));
}

// Where the entry comes from and what each version did to it, like a dictionary's etymology.
// Steps that changed something link to the full comparison.
function historyLine(name, entry) {
  if (!entry) return null;
  const compare = (from, to) => `#compare?r=${encodeURIComponent(name)}&from=${from}&to=${to}`;
  const note = (s) => {
    if (s.kind === "changed") return el("a", { href: compare(s.from, s.version) }, `${s.count} change${s.count === 1 ? "" : "s"}`);
    if (s.kind === "removed") return el("a", { href: compare(s.from, s.version) }, "removed");
    return { baseline: "baseline", new: "new", same: "unchanged", later: "not yet" }[s.kind];
  };
  return el("div", { class: "history" },
    el("h3", { class: "history-label" }, "History"),
    el("ol", { class: "history-steps" }, historySteps(entry).map((s) => el("li", { class: `hs ${s.kind}` },
      el("span", { class: "hs-v" }, s.version), el("span", { class: "hs-note" }, note(s))))));
}

async function renderStory() {
  const name = readHash().params.get("r") || "";
  const v = state.version;
  const out = $("#story-out");
  $("#crumb-name").textContent = name;
  const [list, dts, history] = await Promise.all([resourcesOf(v), datatypesOf(v), historyOf().catch(() => ({}))]);
  if (readHash().params.get("r") !== name || state.version !== v) return;
  const info = list.find((r) => r.name === name);
  if (!info) {
    const close = list.filter((r) => r.name.toLowerCase().includes(name.toLowerCase())).slice(0, 8);
    fill(out, el("p", { class: "note" }, `“${name}” isn't a resource or datatype in ${v}. Names are case-sensitive.`),
      close.length > 0 && el("ul", { class: "az-list matches" }, close.map((r) => dictionaryEntry(r, v))));
    return;
  }
  const file = await resourceFile(v, name);
  if (readHash().params.get("r") !== name || state.version !== v) return;
  useDatatypes(dts);
  const parts = storyParts(file, new Map(list.map((r) => [r.name, r])));
  const isRes = file.kind === "resource";
  const example = resourceExample(file);
  const fileBase = name.charAt(0).toLowerCase() + name.slice(1);
  const plate = example && anatomyPlate(file, example, v);

  const searchRows = (file.search || []).map((p) => {
    const e = file.elements.find((x) => x.search?.some((s) => s.code === p.code));
    return { p, example: e ? searchExample(name, p, e) : null };
  });

  fill(out,
    el("header", { class: "entry-head" },
      el("h2", { class: "headword story-title", "aria-label": name }, syllables(name)),
      entryLine(file),
      el("p", { class: "story-lead" }, parts.what),
      el("div", { class: "story" }, parts.summary.map((line) => el("p", {}, line))),
      historyLine(name, history[name])),

    plate
      ? section(`Anatomy of ${withArticle(name)}`,
        isRes ? "Its required, read-first and most-used fields on an example record, with why each one exists."
          : `What ${withArticle(name)} value looks like, with its parts labelled.`,
        plate)
      : section("Anatomy", null, el("p", { class: "note" },
        `${name} is abstract: other resources follow its pattern, so you never create one directly.`)),

    isRes
      ? section("How it connects",
        (parts.pointedBy.length || parts.pointsTo.length)
          ? `Blue: kinds of records that point to ${name}. Red: what ${name} points to. Select one to open it.`
          : null,
        (parts.pointedBy.length || parts.pointsTo.length)
          ? connectionsDiagram(name, parts, v)
          : el("p", { class: "empty" }, `${name} has no references to or from other resources.`),
        parts.pointedBy.length > shownRows(parts.pointedBy) && connectionList(
          `All ${parts.pointedBy.length} kinds of records that point to ${name}`, parts.pointedBy, v),
        parts.pointsTo.length > shownRows(parts.pointsTo) && connectionList(
          `All ${parts.pointsTo.length} kinds of records ${name} points to`, parts.pointsTo, v))
      : section("Where it's used",
        `Used in ${parts.usedByCount} place${parts.usedByCount === 1 ? "" : "s"}${parts.usedByCount > parts.usedBy.length ? ", including these" : ""}.`,
        el("ul", { class: "paths" }, parts.usedBy.slice(0, 48).map((p) => el("li", {},
          el("button", { class: "linklike mono", type: "button", onclick: () => openElement(v, p) }, p))))),

    example && section("Use it in code",
      isRes ? "Create one on a FHIR server. Example values: replace them with your own." : "Example values: replace them with your own.",
      isRes
        ? codeTabs(createSnippets(name, example), `${fileBase}.json`)
        : codeBlock(JSON.stringify(example, null, 2), { caption: `${withArticle(name)} value`, filename: `${fileBase}.json` })),

    isRes && searchRows.length > 0 && section("Search it", "The official search parameters, as ready-made queries.",
      table(["Parameter", "Type", "What it finds", "Example"], searchRows.slice(0, 8).map(({ p, example: ex }) => [
        mono(p.code), tag(p.type), searchDescription(p.description, name), ex ? mono(ex) : "—"])),
      searchRows.length > 8 && el("details", {}, el("summary", {}, `All ${searchRows.length} search parameters`),
        table(["Parameter", "Type", "What it finds"], searchRows.map(({ p }) => [
          mono(p.code), tag(p.type), searchDescription(p.description, name)])))),

    section("Every field", null,
      el("details", {}, el("summary", {}, `All ${parts.top.length} top-level fields`),
        el("div", { class: "list" }, parts.top.map((e) => fieldRow(e, v))))),

    el("div", { class: "actions" },
      extLink(resourceUrl(v, name, file.kind)),
      el("a", { class: "btn small quiet", href: `#compare?r=${encodeURIComponent(name)}` }, "Compare versions")),
  );
  if (plate) watchPlate(plate);
  if (state.detail?.type === "element") markActive(state.detail.path);
}

// ---------- Compare versions ----------

const cmpName = $("#cmp-name");
const cmpFrom = $("#cmp-from");
const cmpTo = $("#cmp-to");
const COMPARE_PICKS = ["Patient", "Encounter", "Observation", "MedicationRequest", "DeviceUseStatement"];

function changeList(c) {
  const labels = { cardinality: "Cardinality", types: "Type", binding: "Binding", is_modifier: "Modifier" };
  return Object.entries(labels).filter(([k]) => c[k]).map(([k, text]) => el("div", {},
    `${text}: `, el("span", { class: "old mono" }, String(c[k][0] || "none")), " → ",
    el("span", { class: "new mono" }, String(c[k][1] || "none"))));
}

async function renderCompare() {
  const name = cmpName.value.trim();
  const a = cmpFrom.value;
  const b = cmpTo.value;
  const out = $("#compare-out");
  writeHash("compare", { r: name, from: a, to: b });
  if (!name) {
    fill(out, tryLine(COMPARE_PICKS, (x) => { cmpName.value = x; renderTab(); }));
    return;
  }
  if (a === b) { fill(out, el("p", { class: "note" }, "Choose two different versions.")); return; }
  const [diffs, kindsA, kindsB] = await Promise.all([diffsBetween(a, b), kindsOf(a), kindsOf(b)]);
  if (cmpName.value.trim() !== name || cmpFrom.value !== a || cmpTo.value !== b) return;

  if (!kindsA.has(name) && !kindsB.has(name)) {
    fill(out, el("p", { class: "note" },
      `“${name}” isn't a resource or datatype in ${a} or ${b}. Names are case-sensitive, like MedicationRequest.`));
    return;
  }
  const d = diffs[name];
  const head = el("header", { class: "entry-head compact" },
    el("h2", { class: "headword small", "aria-label": name }, syllables(name)),
    el("p", { class: "pos" }, el("i", {}, (kindsB.get(name) || kindsA.get(name)) === "resource" ? "resource" : "datatype"),
      `, ${a} compared with ${b}`));
  if (d?.missing_in) {
    const present = d.missing_in === a ? b : a;
    fill(out, head,
      el("p", { class: "verdict" }, `${name} exists in ${present} but not in ${d.missing_in}. The closest in ${d.missing_in}:`),
      el("ul", { class: "az-list matches" }, d.closest.map((n) => el("li", {},
        el("a", { class: "az-name", href: storyHref(n, d.missing_in) }, n)))),
      el("p", { class: "empty" }, "Matched by name and description. Confirm with the official version notes."));
    return;
  }
  if (!d) {
    fill(out, head, el("p", { class: "verdict" }, `No element changes in ${name} between ${a} and ${b}.`));
    return;
  }

  // Children that moved along with a renamed parent are shown once, as part of the rename.
  const addedPaths = new Set(d.added.map((x) => x.path));
  const movedFrom = new Set();
  const movedTo = new Set(d.renames.map((r) => r.to));
  for (const r of d.renames) {
    movedFrom.add(r.from);
    for (const x of d.removed) {
      if (!x.path.startsWith(`${r.from}.`)) continue;
      const target = r.to + x.path.slice(r.from.length);
      if (addedPaths.has(target)) { movedFrom.add(x.path); movedTo.add(target); }
    }
  }
  const removed = d.removed.filter((x) => !movedFrom.has(x.path));
  const added = d.added.filter((x) => !movedTo.has(x.path));
  const isRes = (kindsB.get(name) || kindsA.get(name)) === "resource";
  const link = (ver, p) => el("a", { href: elementUrl(ver, p, isRes), target: "_blank", rel: "noopener", class: "mono" }, p);
  const count = (n, cls, text) => [el("b", { class: cls }, String(n)), ` ${text}`];

  fill(out, head,
    el("p", { class: "verdict" }, `From ${a} to ${b}: `,
      count(d.renames.length, "chg", "likely renamed"), ", ", count(d.changed.length, "chg", "changed"), ", ",
      count(added.length, "add", "added"), " and ", count(removed.length, "del", "removed"), "."),
    d.renames.length > 0 && section("Likely renamed", "Matched by their descriptions or by the child elements they kept.",
      table([`In ${a}`, `In ${b}`, "Why we think so"], d.renames.map((r) => [
        link(a, r.from), link(b, r.to), r.reason || `${Math.round(r.similarity * 100)}% similar description`]))),
    d.changed.length > 0 && section("Changed", null,
      table(["Element", "What changed"], d.changed.map((c) => [link(b, c.path), changeList(c)]))),
    added.length > 0 && section(`Added in ${b}`, null,
      table(["Element", "Cardinality", "Type", "Description"],
        added.map((x) => [link(b, x.path), mono(x.cardinality), mono(x.types), x.short]))),
    removed.length > 0 && section(`Removed from ${a}`, null,
      table(["Element", "Cardinality", "Type", "Description"],
        removed.map((x) => [link(a, x.path), mono(x.cardinality), mono(x.types), x.short]))),
    el("p", { class: "empty" }, "See ", el("a", { href: storyHref(name, b) }, `${name} in ${b}`), ", explained field by field."),
  );
}

async function fillCompareNames() {
  const lists = await Promise.all(VERSIONS.map(resourcesOf));
  const names = [...new Set(lists.flat().map((r) => r.name))].sort();
  $("#cmp-names").replaceChildren(...names.map((n) => el("option", { value: n })));
}

// ---------- Extensions ----------

const extQ = $("#ext-q");
const extOn = $("#ext-on");
const EXT_EXAMPLES = ["birth place", "preferred pharmacy", "nationality", "interpreter required", "translation"];

function extensionCard(x, v) {
  const desc = cleanText(x.description);
  return el("article", { class: "ext" },
    el("h3", { class: "ext-title" }, x.title, x.status === "deprecated" && el("span", { class: "ext-dep" }, " deprecated")),
    el("p", { class: "ext-url mono" }, x.url),
    desc && el("p", { class: "ext-desc" }, desc.length > 300 ? `${desc.slice(0, 299)}…` : desc),
    el("p", { class: "ext-meta" },
      el("b", {}, "Value: "), x.value,
      x.use_on && [el("span", { class: "sep" }, "  "), el("b", {}, "Use on: "), x.use_on],
      x.maturity && [el("span", { class: "sep" }, "  "), el("b", {}, "Maturity: "), `${x.maturity} of 5`]),
    el("div", { class: "actions" }, copyButton(x.url, "Copy URL"), extLink(extensionUrl(x, v))));
}

async function renderExtensions() {
  const q = extQ.value;
  const on = extOn.value;
  const v = state.version;
  const out = $("#ext-out");
  writeHash("extensions", { q, on });
  if (!q.trim() && !on.trim()) {
    fill(out, tryLine(EXT_EXAMPLES, (x) => { extQ.value = x; renderTab(); }));
    return;
  }
  const exts = await extensions();
  if (extQ.value !== q || extOn.value !== on || state.version !== v) return;
  const hits = searchExtensions(exts, q, v, on);
  fill(out,
    el("h2", { class: "results-head" }, hits.length ? `Extensions for ${v}` : `No extensions for ${v} match`),
    el("div", { class: "ext-list" }, hits.map((x) => extensionCard(x, v))));
}

// ---------- offline + install ----------

function setStatus(text, kind = "") {
  const s = $("#status");
  s.textContent = text;
  s.className = `status ${kind}`;
}

// True only when every data file of the version being served is in the offline cache.
async function offlineComplete() {
  try {
    const { version, files } = await (await fetch("data/files.json")).json();
    const name = `interop-mapper-${version}`;
    if (!(await caches.has(name))) return false;
    return (await (await caches.open(name)).keys()).length >= files.length;
  } catch {
    return false;
  }
}

function watchInstall(worker) {
  worker?.addEventListener("statechange", () => {
    if (worker.state === "redundant") setStatus("Couldn't save for offline; will retry next visit", "warn");
  });
}

async function setupOffline() {
  if (window.interopData) {
    setStatus("Offline copy: everything is in this file", "ok");
    return;
  }
  if (!("serviceWorker" in navigator) || !("caches" in window) || location.protocol === "file:") {
    setStatus("Online only (open from a web address to save offline)", "warn");
    return;
  }
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "progress") setStatus(`Saving for offline ${Math.round((e.data.done / e.data.total) * 100)}%`);
  });
  // The service worker takes over only after saving everything: on a first visit that means
  // offline is ready; on later visits it means a newer version was installed.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) setStatus("New version ready: reload the page", "warn");
    else setStatus("Available offline", "ok");
  });
  let reg;
  try {
    // "none": update checks always ask the network for sw.js and sw-version.js; with the browser
    // default, a cached sw-version.js can hide a new version until the HTTP cache expires.
    reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
  } catch {
    setStatus("Offline mode unavailable", "warn");
    return;
  }
  watchInstall(reg.installing);
  reg.addEventListener("updatefound", () => watchInstall(reg.installing));
  reg.update().catch(() => {}); // offline: nothing to check, keep the saved version
  if (!hadController) { setStatus("Saving for offline…"); return; }
  if (await offlineComplete()) setStatus("Available offline", "ok");
  else setStatus("Saving for offline…");
}

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("#install").hidden = false;
});
$("#install").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("#install").hidden = true;
});

// ---------- theme: follows the system until the reader picks one (theme.js applies it on load) ----------

const THEMES = ["auto", "light", "dark"];
const THEME_NAMES = { auto: "Auto", light: "Light", dark: "Dark" };

function showTheme(theme) {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const b = $("#theme");
  b.textContent = THEME_NAMES[theme];
  b.dataset.theme = theme;
  b.setAttribute("aria-label", `Theme: ${THEME_NAMES[theme]}. Change theme`);
}

$("#theme").addEventListener("click", () => {
  const next = THEMES[(THEMES.indexOf($("#theme").dataset.theme) + 1) % THEMES.length];
  store.set("theme", next);
  showTheme(next);
});
showTheme(THEMES.includes(store.get("theme")) ? store.get("theme") : "auto");

// ---------- wire up ----------

for (const s of [cmpFrom, cmpTo]) s.replaceChildren(...VERSIONS.map((v) => el("option", { value: v }, v)));
cmpFrom.value = "R4";
cmpTo.value = "R5";

findInput.addEventListener("input", debounce(renderTab, 120));
// Jump box on a resource page: exact names open (any case); anything else becomes a search.
storyName.addEventListener("change", async () => {
  const typed = storyName.value.trim();
  if (!typed) return;
  const list = await resourcesOf(state.version);
  const hit = list.find((r) => r.name.toLowerCase() === typed.toLowerCase());
  location.hash = hit ? storyHref(hit.name) : `#find?q=${encodeURIComponent(typed)}`;
});
cmpName.addEventListener("input", debounce(renderTab, 150));
cmpFrom.addEventListener("change", renderTab);
cmpTo.addEventListener("change", renderTab);
extQ.addEventListener("input", debounce(renderTab, 120));
extOn.addEventListener("input", debounce(renderTab, 120));
$("#detail-close").addEventListener("click", closeDetail);
$("#brand").addEventListener("click", () => { findInput.value = ""; });
window.addEventListener("hashchange", route);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !detail.hidden) closeDetail();
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
  if (e.key === "/" && !typing) {
    e.preventDefault();
    ({ find: findInput, story: storyName, compare: cmpName, extensions: extQ })[state.tab].focus();
  }
});

trackHeaderHeight();
renderVersionPicker();
route();
fillCompareNames().catch(() => {});
setupOffline();
