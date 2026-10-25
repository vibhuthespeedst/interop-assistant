"""Build a SQLite index of FHIR element and extension definitions.

Reads the official HL7 packages (.tgz) directly, without extracting them, and
writes one database with full-text search over every element and extension.

Usage: python -I src/build_index.py <packages_dir> <output_db>
"""
import json
import os
import re
import sqlite3
import sys
import tarfile

# package file prefix -> (FHIR version label, source label)
CORE_PACKAGES = {
    "hl7.fhir.r4.core#": ("R4", "R4 core"),
    "hl7.fhir.r4b.core#": ("R4B", "R4B core"),
    "hl7.fhir.r5.core#": ("R5", "R5 core"),
}
EXTENSION_PACKS = {
    "hl7.fhir.uv.extensions.r4#": ("R4", "Extensions Pack (R4)"),
    "hl7.fhir.uv.extensions.r5#": ("R5", "Extensions Pack (R5)"),
}

FMM_URL = "http://hl7.org/fhir/StructureDefinition/structuredefinition-fmm"
STATUS_URL = "http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status"

SCHEMA = """
CREATE TABLE elements (
    version TEXT, resource TEXT, kind TEXT, path TEXT, path_words TEXT,
    min INTEGER, max TEXT, types TEXT, short TEXT, definition TEXT, comment TEXT,
    binding_strength TEXT, binding_valueset TEXT, is_modifier INTEGER, is_summary INTEGER,
    requirements TEXT, content_ref TEXT,
    PRIMARY KEY (version, path)
);
CREATE TABLE search_params (
    version TEXT, code TEXT, base TEXT, type TEXT, expression TEXT, description TEXT, url TEXT,
    PRIMARY KEY (version, url)
);
CREATE TABLE resources (
    version TEXT, name TEXT, kind TEXT, description TEXT, maturity TEXT, status TEXT,
    abstract INTEGER,
    PRIMARY KEY (version, name)
);
CREATE TABLE extensions (
    version TEXT, source TEXT, url TEXT, id TEXT, title TEXT, description TEXT,
    contexts TEXT, value_types TEXT, sub_extensions TEXT, status TEXT, maturity TEXT,
    PRIMARY KEY (version, source, url)
);
CREATE VIRTUAL TABLE elements_fts USING fts5(
    path_words, short, definition, comment,
    content='elements', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE VIRTUAL TABLE extensions_fts USING fts5(
    id, title, description, contexts,
    content='extensions', content_rowid='rowid', tokenize='porter unicode61'
);
"""


def path_to_words(path):
    """'Patient.birthDate' -> 'Patient birth Date' so search can match plain words."""
    spaced = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", path)
    return re.sub(r"[.\[\]]", " ", spaced)


def type_summary(element):
    out = []
    for t in element.get("type", []):
        code = t.get("code", "")
        targets = t.get("targetProfile", [])
        if targets:
            names = "|".join(p.rsplit("/", 1)[-1] for p in targets)
            out.append(f"{code}({names})")
        else:
            out.append(code)
    return ", ".join(out)


def ext_value(sd, url):
    for e in sd.get("extension", []):
        if e.get("url") == url:
            for k, v in e.items():
                if k.startswith("value"):
                    return str(v)
    return ""


def iter_json(path):
    with tarfile.open(path, "r:gz") as tar:
        for m in tar.getmembers():
            if not (m.isfile() and m.name.endswith(".json")):
                continue
            if m.name.endswith(("package.json", ".index.json")):
                continue
            try:
                yield json.load(tar.extractfile(m))
            except (ValueError, UnicodeDecodeError):
                continue


def add_structure(db, version, sd):
    kind = sd.get("kind")
    db.execute(
        "INSERT OR REPLACE INTO resources VALUES (?,?,?,?,?,?,?)",
        (version, sd["type"], kind, sd.get("description", ""),
         ext_value(sd, FMM_URL), ext_value(sd, STATUS_URL) or sd.get("status", ""),
         int(bool(sd.get("abstract")))),  # e.g. R5 CanonicalResource: a pattern, never created directly
    )
    for el in sd.get("snapshot", {}).get("element", []):
        path = el.get("path", "")
        binding = el.get("binding", {})
        # Recursive structures have no type, only "same as" another element,
        # e.g. Questionnaire.item.item -> #Questionnaire.item (R5 prefixes the canonical URL).
        content_ref = el.get("contentReference", "").rsplit("#", 1)[-1]
        db.execute(
            "INSERT OR REPLACE INTO elements VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (version, sd["type"], kind, path, path_to_words(path),
             el.get("min", 0), el.get("max", ""), type_summary(el),
             el.get("short", ""), el.get("definition", ""), el.get("comment", ""),
             binding.get("strength", ""), binding.get("valueSet", "").split("|")[0],
             int(bool(el.get("isModifier"))), int(bool(el.get("isSummary"))),
             el.get("requirements", ""), content_ref),
        )


def add_search_param(db, version, sp):
    db.execute(
        "INSERT OR REPLACE INTO search_params VALUES (?,?,?,?,?,?,?)",
        (version, sp.get("code", ""), ",".join(sp.get("base", [])), sp.get("type", ""),
         sp.get("expression", ""), sp.get("description", ""), sp.get("url", "")),
    )


def add_extension(db, version, source, sd):
    elements = sd.get("snapshot", {}).get("element", [])
    value_types = ""
    subs = []
    for el in elements:
        if el.get("path") == "Extension.value[x]" and el.get("max") != "0":
            value_types = type_summary(el)
        if el.get("path") == "Extension.extension" and el.get("sliceName") and el.get("max") != "0":
            subs.append(el["sliceName"])
    contexts = [c.get("expression", "") for c in sd.get("context", [])]
    db.execute(
        "INSERT OR REPLACE INTO extensions VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (version, source, sd.get("url", ""), sd.get("id", ""),
         sd.get("title") or sd.get("name", ""), sd.get("description", ""),
         ", ".join(contexts), value_types, ", ".join(subs),
         ext_value(sd, STATUS_URL) or sd.get("status", ""), ext_value(sd, FMM_URL)),
    )


def main(packages_dir, db_path):
    if os.path.exists(db_path):
        os.remove(db_path)
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)

    for fname in sorted(os.listdir(packages_dir)):
        full = os.path.join(packages_dir, fname)
        core = next((v for k, v in CORE_PACKAGES.items() if fname.startswith(k)), None)
        pack = next((v for k, v in EXTENSION_PACKS.items() if fname.startswith(k)), None)
        if not core and not pack:
            continue
        version, source = core or pack
        n_struct = n_ext = n_sp = 0
        for r in iter_json(full):
            if core and r.get("resourceType") == "SearchParameter":
                add_search_param(db, version, r)
                n_sp += 1
                continue
            if r.get("resourceType") != "StructureDefinition":
                continue
            if r.get("type") == "Extension" and r.get("derivation") == "constraint":
                add_extension(db, version, source, r)
                n_ext += 1
            elif core and r.get("derivation") == "specialization" and r.get("kind") in ("resource", "complex-type"):
                add_structure(db, version, r)
                n_struct += 1
        print(f"{fname}: {n_struct} resources/datatypes, {n_ext} extensions, {n_sp} search parameters")

    db.execute("INSERT INTO elements_fts(elements_fts) VALUES ('rebuild')")
    db.execute("INSERT INTO extensions_fts(extensions_fts) VALUES ('rebuild')")
    db.commit()
    for table in ("resources", "elements", "extensions", "search_params"):
        print(f"{table}: {db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]} rows")
    db.close()


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
