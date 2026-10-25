"""Export the definitions index to static JSON files for the offline web app.

Usage: python -I src/export_web.py data/fhir.db web/data
"""
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fhirdb import VERSIONS, FhirDB, is_inherited  # noqa: E402

PAIRS = [("R4", "R4B"), ("R4B", "R5"), ("R4", "R5")]
ABSTRACT = {"Resource", "DomainResource", "Element", "BackboneElement", "BackboneType", "DataType", "PrimitiveType"}


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def brief(rows):
    return [{k: x[k] for k in ("path", "cardinality", "types", "short")} for x in rows]


def first_sentence(text, limit=160):
    s = (text or "").split(". ")[0].strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


REF_RE = re.compile(r"\b(Reference|CodeableReference)\(([^)]*)\)")


def search_maps(con, version, paths_by_resource):
    """Link official search parameters to the elements their expressions read."""
    by_resource = defaultdict(list)
    by_path = defaultdict(list)
    for sp in con.execute("SELECT * FROM search_params WHERE version = ? ORDER BY code", (version,)):
        expr = sp["expression"] or ""
        for base in filter(None, sp["base"].split(",")):
            if base in ABSTRACT:
                continue  # _id, _lastUpdated and friends apply everywhere; not useful per field
            by_resource[base].append({"code": sp["code"], "type": sp["type"],
                                      "description": first_sentence(sp["description"], 140)})
            for path in paths_by_resource.get(base, ()):
                if "." not in path:
                    continue  # the root ("Patient") would match every parameter of the resource
                # "Patient.name" also matches "Patient.name.family"; "Observation.value"
                # matches "(Observation.value as Quantity)" - but never "Patient.names".
                if re.search(re.escape(path.replace("[x]", "")) + r"(?![A-Za-z0-9])", expr):
                    by_path[path].append({"code": sp["code"], "type": sp["type"]})
    return by_resource, by_path


def link_maps(rows, complex_types):
    """Who points to whom (references) and where each datatype is used."""
    out_refs = defaultdict(list)
    in_refs = defaultdict(list)
    used_by = defaultdict(list)
    for e in rows:
        if e["resource"] in ABSTRACT or is_inherited(e["path"], e["kind"]) or "." not in e["path"]:
            continue
        for m in REF_RE.finditer(e["types"]):
            targets = m.group(2).split("|")
            if e["kind"] == "resource":
                out_refs[e["resource"]].append({"path": e["path"], "targets": targets})
                for t in targets:
                    in_refs[t].append({"from": e["resource"], "path": e["path"]})
        type_codes = [t.split("(")[0] for t in e["types"].split(", ")]
        if len(type_codes) > 15:
            continue  # open "any type" fields such as ElementDefinition.fixed[x] aren't real uses
        for code in type_codes:
            if code in complex_types and code != e["resource"]:
                used_by[code].append(e["path"])
    return out_refs, in_refs, used_by


def change_count(d):
    """Differences as the Compare view counts them: children that moved with a renamed parent count once."""
    added = {x["path"] for x in d["added"]}
    moved_from, moved_to = set(), {r["to"] for r in d["renames"]}
    for r in d["renames"]:
        moved_from.add(r["from"])
        for x in d["removed"]:
            if x["path"].startswith(r["from"] + "."):
                target = r["to"] + x["path"][len(r["from"]):]
                if target in added:
                    moved_from.add(x["path"])
                    moved_to.add(target)
    return (len(d["renames"]) + len(d["changed"])
            + sum(1 for x in d["added"] if x["path"] not in moved_to)
            + sum(1 for x in d["removed"] if x["path"] not in moved_from))


def export(db_path, out_dir):
    fdb = FhirDB(db_path)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)

    for v in VERSIONS:
        resources = con.execute(
            "SELECT * FROM resources WHERE version = ? ORDER BY name", (v,)).fetchall()
        dump(f"{out_dir}/{v}/resources.json", [
            {"name": r["name"], "kind": r["kind"], "summary": first_sentence(r["description"]),
             "maturity": r["maturity"], "status": r["status"], "abstract": bool(r["abstract"])}
            for r in resources if r["name"] not in ABSTRACT])

        # Direct children of every datatype, so code examples can build any datatype
        # with its required parts (UsageContext needs code and value[x], and so on).
        datatypes = {}
        for r in resources:
            if r["kind"] != "complex-type" or r["name"] in ABSTRACT or r["abstract"]:
                continue
            kids = con.execute(
                "SELECT * FROM elements WHERE version = ? AND resource = ? ORDER BY rowid", (v, r["name"])).fetchall()
            datatypes[r["name"]] = [
                {"name": k["path"].split(".", 1)[1], "card": f"{k['min']}..{k['max']}", "types": k["types"],
                 "short": k["short"]}
                for k in kids if k["path"].count(".") == 1 and not is_inherited(k["path"], k["kind"])]
        dump(f"{out_dir}/{v}/datatypes.json", datatypes)

        # Search index: one compact row per element.
        index = []
        for e in con.execute("SELECT * FROM elements WHERE version = ? ORDER BY resource, rowid", (v,)):
            if e["resource"] in ABSTRACT or "." not in e["path"] or is_inherited(e["path"], e["kind"]):
                continue
            types = e["types"] or (f"same as {e['content_ref']}" if e["content_ref"] else "")
            index.append([e["path"], f"{e['min']}..{e['max']}", types, e["short"],
                          1 if e["kind"] == "resource" else 0])
        dump(f"{out_dir}/{v}/index.json", index)

        # Full definitions, one file per resource/datatype, loaded when a field is opened,
        # with search parameters and connections (references, datatype usage) attached.
        all_rows = con.execute("SELECT * FROM elements WHERE version = ? ORDER BY rowid", (v,)).fetchall()
        paths_by_resource = defaultdict(list)
        for e in all_rows:
            paths_by_resource[e["resource"]].append(e["path"])
        sp_by_resource, sp_by_path = search_maps(con, v, paths_by_resource)
        complex_types = {r["name"] for r in resources if r["kind"] == "complex-type"} - ABSTRACT
        out_refs, in_refs, used_by = link_maps(all_rows, complex_types)

        for r in resources:
            if r["name"] in ABSTRACT:
                continue
            name = r["name"]
            rows = [e for e in all_rows if e["resource"] == name]
            dump(f"{out_dir}/{v}/res/{name}.json", {
                "name": name, "kind": r["kind"], "description": r["description"],
                "maturity": r["maturity"], "status": r["status"], "abstract": bool(r["abstract"]),
                "search": sp_by_resource.get(name, []),
                "links": {
                    "out": out_refs.get(name, []),
                    "in": in_refs.get(name, []),
                    "usedBy": used_by.get(name, [])[:60],
                    "usedByCount": len(used_by.get(name, [])),
                },
                "elements": [{
                    "path": e["path"], "card": f"{e['min']}..{e['max']}", "types": e["types"],
                    "short": e["short"], "definition": e["definition"], "comment": e["comment"],
                    "requirements": e["requirements"], "contentRef": e["content_ref"],
                    "binding": f"{e['binding_strength']}: {e['binding_valueset']}" if e["binding_strength"] else "",
                    "modifier": bool(e["is_modifier"]), "summary": bool(e["is_summary"]),
                    "search": sp_by_path.get(e["path"], []),
                } for e in rows]})

    # Version comparisons, computed once for every resource and datatype.
    all_diffs = {}
    for a, b in PAIRS:
        names = {r[0] for r in con.execute(
            "SELECT name FROM resources WHERE version IN (?, ?)", (a, b))} - ABSTRACT
        diffs = {}
        for name in sorted(names):
            d = fdb.compare_versions(name, a, b)
            if "error" in d:
                missing = d["error"].rsplit(" ", 1)[-1]  # "... does not exist in R5"
                diffs[name] = {"missing_in": missing, "closest": d[f"closest_in_{missing}"]}
                continue
            changed = [{k: c[k] for k in c if k != "url"} for c in d["changed"]]
            if not (d["added"] or d["removed"] or changed or d["possible_renames"]):
                continue  # unchanged resources are implied by absence
            diffs[name] = {"added": brief(d["added"]), "removed": brief(d["removed"]),
                           "changed": changed, "renames": d["possible_renames"]}
        dump(f"{out_dir}/diffs/{a}-{b}.json", diffs)
        all_diffs[(a, b)] = diffs

    # Each name's path through the versions, for the History line on its page:
    # the versions it is in, and how many differences each step between them made.
    present = defaultdict(list)
    for name, version in con.execute("SELECT name, version FROM resources"):
        if name not in ABSTRACT:
            present[name].append(version)
    history = {}
    for name, versions in present.items():
        versions = [v for v in VERSIONS if v in versions]
        steps = {}
        for a, b in zip(versions, versions[1:]):
            d = all_diffs[(a, b)].get(name)
            steps[f"{a}-{b}"] = change_count(d) if d and "missing_in" not in d else 0
        history[name] = {"in": versions, "steps": steps}
    dump(f"{out_dir}/history.json", history)

    # Extensions, merged across core and the Extensions Pack.
    merged = {}
    for x in con.execute("SELECT * FROM extensions ORDER BY source"):
        m = merged.setdefault(x["url"], {
            "url": x["url"], "id": x["id"], "title": x["title"], "description": x["description"],
            "use_on": x["contexts"], "value": x["value_types"] or "(complex)", "parts": x["sub_extensions"],
            "status": x["status"], "maturity": x["maturity"], "in": []})
        label = {"R4 core": "R4 core", "R4B core": "R4B core", "R5 core": "R5 core",
                 "Extensions Pack (R4)": "Pack R4", "Extensions Pack (R5)": "Pack R5"}[x["source"]]
        m["in"].append(label)
        if x["source"].startswith("Extensions Pack"):  # the Pack copy is the maintained one
            m.update(description=x["description"], use_on=x["contexts"], status=x["status"],
                     maturity=x["maturity"], value=x["value_types"] or "(complex)", parts=x["sub_extensions"])
    dump(f"{out_dir}/extensions.json", sorted(merged.values(), key=lambda m: m["title"].lower()))

    # File list + content hash: the service worker caches these for offline use.
    web_dir = os.path.dirname(out_dir)
    files, digest = [], hashlib.sha256()
    for root, _, names in os.walk(out_dir):
        for n in sorted(names):
            p = os.path.join(root, n)
            files.append(os.path.relpath(p, web_dir).replace(os.sep, "/"))
    files.sort()
    # The hash covers the app's own code too, so installed copies update when either changes.
    shell = ["index.html", "app.js", "lib.js", "codegen.js", "theme.js", "tokens.css", "style.css", "sw.js",
             "manifest.webmanifest",
             "icons/icon-192.png", "icons/icon-512.png",
             "fonts/literata-roman.woff2", "fonts/literata-italic.woff2", "fonts/atkinson-next.woff2",
             "fonts/atkinson-mono.woff2", "fonts/OFL.txt"]
    for rel in files + shell:
        digest.update(rel.encode())
        with open(os.path.join(web_dir, rel), "rb") as f:
            digest.update(f.read())
    dump(f"{out_dir}/files.json", {"version": digest.hexdigest()[:12], "files": files})
    # The service worker imports this file; a new value makes installed copies refresh their data.
    with open(os.path.join(web_dir, "sw-version.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write(f'self.DATA_VERSION = "{digest.hexdigest()[:12]}";\n')
    total = sum(os.path.getsize(os.path.join(web_dir, f)) for f in files)
    print(f"{len(files)} files, {total / 1048576:.1f} MB, data version {digest.hexdigest()[:12]}")


if __name__ == "__main__":
    export(sys.argv[1], sys.argv[2])
