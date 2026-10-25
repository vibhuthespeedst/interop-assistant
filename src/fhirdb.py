"""Query layer over the FHIR definitions index built by build_index.py.

Every function returns plain dicts/lists so the results can be handed to the
model as tool output, and every element or extension carries a link to the
official hl7.org page so answers can be checked.
"""
import difflib
import re
import sqlite3

VERSIONS = ("R4", "R4B", "R5")
BASE_URL = {v: f"https://hl7.org/fhir/{v}" for v in VERSIONS}

# Elements inherited from Element/BackboneElement (at any depth) and from
# Resource/DomainResource (top level of resources only). They add noise to
# search results; datatype fields with the same names (CodeableConcept.text,
# Attachment.language) are real content and stay.
ALWAYS_INHERITED = (".id", ".extension", ".modifierExtension")
RESOURCE_INHERITED = (".meta", ".implicitRules", ".language", ".text", ".contained")


def is_inherited(path, kind):
    if path.endswith(ALWAYS_INHERITED):
        return True
    return kind == "resource" and path.count(".") == 1 and path.endswith(RESOURCE_INHERITED)


class FhirDB:
    def __init__(self, db_path):
        self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row

    # ---------- helpers ----------

    @staticmethod
    def _check_version(version):
        v = version.upper()
        if v not in VERSIONS:
            raise ValueError(f"version must be one of {VERSIONS}, got {version!r}")
        return v

    @staticmethod
    def _fts_query(text):
        words = re.findall(r"[A-Za-z0-9]+", text)
        if not words:
            raise ValueError("query has no searchable words")
        # OR keeps recall high; bm25 still ranks rows that match more words first.
        return " OR ".join(f'"{w}"' for w in words)

    @staticmethod
    def element_url(version, resource, kind, path):
        page = f"{resource.lower()}-definitions.html" if kind == "resource" else "datatypes-definitions.html"
        return f"{BASE_URL[version]}/{page}#{path}"

    @staticmethod
    def extension_url(version, source, ext_id):
        if source.startswith("Extensions Pack"):
            return f"https://hl7.org/fhir/extensions/StructureDefinition-{ext_id}.html"
        return f"{BASE_URL[version]}/extension-{ext_id.lower()}.html"

    def _element_dict(self, row, full=False):
        d = {
            "path": row["path"],
            "cardinality": f"{row['min']}..{row['max']}",
            "types": row["types"],
            "short": row["short"],
            "url": self.element_url(row["version"], row["resource"], row["kind"], row["path"]),
        }
        if row["binding_strength"]:
            d["binding"] = f"{row['binding_strength']}: {row['binding_valueset']}"
        if row["is_modifier"]:
            d["is_modifier"] = True
        if full:
            d["definition"] = row["definition"]
            if row["comment"]:
                d["comment"] = row["comment"]
            if row["requirements"]:
                d["why_needed"] = row["requirements"]
            if row["content_ref"]:
                d["same_structure_as"] = row["content_ref"]
            d["is_summary"] = bool(row["is_summary"])
        return d

    # ---------- tools ----------

    def search_elements(self, query, version="R4", resource=None, limit=10):
        """Full-text search over element paths, short descriptions and definitions."""
        v = self._check_version(version)
        sql = """
            SELECT e.*, bm25(elements_fts, 10.0, 5.0, 1.0, 0.5) AS score
            FROM elements_fts JOIN elements e ON e.rowid = elements_fts.rowid
            WHERE elements_fts MATCH ? AND e.version = ?
        """
        args = [self._fts_query(query), v]
        if resource:
            sql += " AND e.resource = ?"
            args.append(resource)
        sql += " ORDER BY score LIMIT ?"
        args.append(limit * 3)  # over-fetch, then drop inherited noise
        rows = [r for r in self.db.execute(sql, args) if not is_inherited(r["path"], r["kind"])]
        return [self._element_dict(r) for r in rows[:limit]]

    def get_element(self, path, version="R4"):
        """Full definition of one element, e.g. 'Patient.birthDate'."""
        v = self._check_version(version)
        row = self.db.execute("SELECT * FROM elements WHERE version = ? AND path = ?", (v, path)).fetchone()
        if row:
            return self._element_dict(row, full=True)
        close = [r[0] for r in self.db.execute(
            "SELECT path FROM elements WHERE version = ? AND resource = ?", (v, path.split(".")[0]))]
        return {"error": f"{path} does not exist in {v}",
                "did_you_mean": difflib.get_close_matches(path, close, n=5, cutoff=0.6)}

    def get_resource(self, name, version="R4"):
        """Top-level elements of a resource or datatype, plus its description."""
        v = self._check_version(version)
        res = self.db.execute("SELECT * FROM resources WHERE version = ? AND name = ?", (v, name)).fetchone()
        if not res:
            names = [r[0] for r in self.db.execute("SELECT name FROM resources WHERE version = ?", (v,))]
            return {"error": f"{name} does not exist in {v}",
                    "did_you_mean": difflib.get_close_matches(name, names, n=5, cutoff=0.5)}
        rows = self.db.execute(
            "SELECT * FROM elements WHERE version = ? AND resource = ? AND path LIKE ? ORDER BY rowid",
            (v, name, f"{name}.%"))
        elements = [self._element_dict(r) for r in rows
                    if r["path"].count(".") == 1 and not is_inherited(r["path"], r["kind"])]
        return {"name": name, "version": v, "kind": res["kind"], "maturity": res["maturity"],
                "status": res["status"], "description": res["description"], "elements": elements}

    def compare_versions(self, resource, from_version="R4", to_version="R5"):
        """Exact element-level differences of one resource between two versions."""
        a, b = self._check_version(from_version), self._check_version(to_version)

        def load(v):
            return {r["path"]: r for r in self.db.execute(
                "SELECT * FROM elements WHERE version = ? AND resource = ?", (v, resource))}

        old, new = load(a), load(b)
        if not old or not new:
            missing = a if not old else b
            present = b if not old else a
            return {"error": f"{resource} does not exist in {missing}",
                    "closest_in_" + missing: self._closest_resource(resource, present, missing)}

        def norm_path(p):
            return p.split(".", 1)[1] if "." in p else ""

        removed = sorted(set(old) - set(new))
        added = sorted(set(new) - set(old))
        changed = []
        for path in sorted(set(old) & set(new)):
            o, n = old[path], new[path]
            diffs = {}
            if (o["min"], o["max"]) != (n["min"], n["max"]):
                diffs["cardinality"] = [f"{o['min']}..{o['max']}", f"{n['min']}..{n['max']}"]
            if o["types"] != n["types"]:
                diffs["types"] = [o["types"], n["types"]]
            if (o["binding_strength"], o["binding_valueset"]) != (n["binding_strength"], n["binding_valueset"]):
                diffs["binding"] = [f"{o['binding_strength']}: {o['binding_valueset']}".strip(": "),
                                    f"{n['binding_strength']}: {n['binding_valueset']}".strip(": ")]
            if o["is_modifier"] != n["is_modifier"]:
                diffs["is_modifier"] = [bool(o["is_modifier"]), bool(n["is_modifier"])]
            if diffs:
                changed.append({"path": path, **diffs,
                                "url": self.element_url(b, resource, n["kind"], path)})

        # Heuristic: a removed and an added element under the same parent with
        # similar descriptions were probably renamed. Flagged as "possible" only.
        renames = []
        for r in removed:
            parent = r.rsplit(".", 1)[0]
            text_r = f"{old[r]['short']} {old[r]['definition']}"
            best, best_score = None, 0.0
            for ad in added:
                if ad.rsplit(".", 1)[0] != parent:
                    continue
                score = difflib.SequenceMatcher(None, text_r, f"{new[ad]['short']} {new[ad]['definition']}").ratio()
                if score > best_score:
                    best, best_score = ad, score
            if best and best_score >= 0.55:
                renames.append({"from": r, "to": best, "similarity": round(best_score, 2)})

        # Renamed groups (backbone elements) keep most of their child names, e.g.
        # R4 Encounter.hospitalization.* -> R5 Encounter.admission.*
        def child_names(rows, parent):
            # id/extension/modifierExtension exist under every group; counting them would fake overlap
            prefix = parent + "."
            return {p[len(prefix):] for p in rows
                    if p.startswith(prefix) and "." not in p[len(prefix):]
                    and p[len(prefix):] not in ("id", "extension", "modifierExtension")}

        already = {x["from"] for x in renames}
        for r in removed:
            kids_r = child_names(old, r)
            if r in already or len(kids_r) < 2:
                continue
            for ad in added:
                kids_a = child_names(new, ad)
                if not kids_a or ad.rsplit(".", 1)[0] != r.rsplit(".", 1)[0]:
                    continue
                overlap = len(kids_r & kids_a) / len(kids_r | kids_a)
                if overlap >= 0.5:
                    renames.append({"from": r, "to": ad, "similarity": round(overlap, 2),
                                    "reason": f"{len(kids_r & kids_a)} child elements kept their names"})
                    break

        def brief(rows, paths, v):
            return [{"path": p, "cardinality": f"{rows[p]['min']}..{rows[p]['max']}",
                     "types": rows[p]["types"], "short": rows[p]["short"],
                     "url": self.element_url(v, resource, rows[p]["kind"], p)}
                    for p in paths if norm_path(p) and not is_inherited(p, rows[p]["kind"])]

        return {
            "resource": resource, "from": a, "to": b,
            "summary": {"removed": len(removed), "added": len(added), "changed": len(changed),
                        "possible_renames": len(renames)},
            "removed": brief(old, removed, a),
            "added": brief(new, added, b),
            "changed": changed,
            "possible_renames": renames,
        }

    def _closest_resource(self, name, present_version, missing_version):
        """Find the resource in missing_version most like `name` in present_version."""
        src = self.db.execute("SELECT description FROM resources WHERE version = ? AND name = ?",
                              (present_version, name)).fetchone()
        candidates = self.db.execute("SELECT name, description FROM resources WHERE version = ? AND kind = 'resource'",
                                     (missing_version,)).fetchall()
        if not src:
            return difflib.get_close_matches(name, [c["name"] for c in candidates], n=3, cutoff=0.4)
        scored = sorted(
            ((difflib.SequenceMatcher(None, src["description"], c["description"]).ratio()
              + 0.5 * difflib.SequenceMatcher(None, name, c["name"]).ratio(), c["name"])
             for c in candidates), reverse=True)
        return [n for _, n in scored[:3]]

    def search_extensions(self, query, version="R4", context=None, limit=10):
        """Search official extensions; optionally only those usable on a resource/element."""
        v = self._check_version(version)
        source_version = "R4" if v == "R4B" else v  # the R4 Extensions Pack also serves R4B
        sql = """
            SELECT x.*, bm25(extensions_fts, 5.0, 8.0, 2.0, 1.0) AS score
            FROM extensions_fts JOIN extensions x ON x.rowid = extensions_fts.rowid
            WHERE extensions_fts MATCH ? AND (x.version = ? OR x.version = ?)
        """
        args = [self._fts_query(query), v, source_version]
        if context:
            sql += " AND (x.contexts LIKE ? OR x.contexts = '' OR x.contexts LIKE '%Element%')"
            args.append(f"%{context}%")
        # Ties go to the Extensions Pack copy, which is the maintained one.
        sql += " ORDER BY score, x.source NOT LIKE 'Extensions Pack%' LIMIT ?"
        args.append(limit * 2)
        out, seen = [], set()
        for x in self.db.execute(sql, args):
            # The same extension can appear in core and in the pack; prefer the pack.
            key = x["url"]
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "url": x["url"], "title": x["title"], "description": x["description"][:400],
                "use_on": x["contexts"], "value_types": x["value_types"] or "(complex)",
                "sub_extensions": x["sub_extensions"], "status": x["status"],
                "maturity": x["maturity"], "source": x["source"],
                "page": self.extension_url(x["version"], x["source"], x["id"]),
            })
            if len(out) == limit:
                break
        return out
