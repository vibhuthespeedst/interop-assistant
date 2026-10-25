# Interop Mapper

An offline FHIR dictionary. Find where your data goes, see exactly what changed between R4, R4B and R5, and find official extensions. Install it like an app; after the first load it works with no internet, no account and no AI.

**Try**

- "date of birth" → `Patient.birthDate`, plus how it looks in every version
- "lab normal range" → `Observation.referenceRange`
- Compare `Encounter` R4 → R5 → `hospitalization` became `admission`, `class` became a list of `CodeableConcept`, and more
- Extensions: "preferred pharmacy" → `patient-preferredPharmacy`

**Resource stories.** Every resource gets a short explanation: what it is, which fields are required, which ones change the meaning of the record, *why* each field exists (HL7's own "requirements" notes), and a diagram of what it points to and what points to it.

**Use it in code.** For any resource or field:

- example JSON you can copy or download, following the FHIR JSON rules
- Python, JavaScript and curl that create the resource on a FHIR server
- how to read the field back (`observation["referenceRange"][0]["low"]`) and its FHIRPath
- the official search parameter, as a ready query (`GET [base]/Patient?birthdate=2024-01-31`)

Every result links to the official HL7 page.

## How it works

1. `src/fetch_packages.py` downloads the official packages from the FHIR package registry: R4, R4B and R5 core, plus the HL7 Extensions Pack.
2. `src/build_index.py` loads every element and extension definition into a SQLite database.
3. `src/export_web.py` turns it into static files for the app, including every version comparison, **computed** element by element: added, removed and changed elements, cardinality, types and bindings. Renames are detected from matching descriptions or child elements and shown as "likely". It also links each field to the official search parameters that read it, and every resource to the resources it references.
4. The app in `web/` searches those files in the browser; `web/codegen.js` builds the examples and stories. A service worker saves everything, so it keeps working offline; a new version takes over only once it has saved every file.

The generated examples were checked against the independent [`fhir.resources`](https://pypi.org/project/fhir.resources/) models: an example for every resource and every field, 4,681 for R4B and 5,805 for R5, all valid. That checks structure, types and required fields; it doesn't check terminology (whether a code is in a value set) or FHIRPath invariants.

## Build and run

Requires Python 3.10+.

```bash
python src/fetch_packages.py data/packages
python src/build_index.py data/packages data/fhir.db
python src/export_web.py data/fhir.db web/data
python -m http.server 8765 --bind 127.0.0.1 --directory web
```

Open http://127.0.0.1:8765 and use "Install app" (Chrome or Edge) to add it to your desktop. Run `export_web.py` again after changing anything in `web/`, so installed copies pick up the new version.

### Offline copy (one file)

```bash
python src/build_offline.py web dist/interop-mapper.html
```

This writes a single HTML file of about 5 MB, holding the whole app: code, styles, fonts and every definition. Double-click it to open it in any current browser, with no server, install or internet. You can copy it, email it or put it on a USB stick. Rebuild it after running `export_web.py` or changing anything in `web/`.

## Design

The look is a printed medical dictionary set like an anatomy atlas: warm paper, navy ink, display-size headwords, a thumb index, and colour only where it means something. Every colour, font, size and timing is a token in `web/tokens.css`, so re-theming is usually a one-line change. Light and dark themes come from the same tokens. [DESIGN.md](DESIGN.md) explains the system and how to change it.

## Optional: AI chat

`app.py` is a separate chat version that uses Claude to explain mappings in plain English, using the same data as tools. It needs an [Anthropic API key](https://platform.claude.com/) set as `ANTHROPIC_API_KEY`:

```bash
pip install -r requirements.txt
streamlit run app.py
```

## Tests

```bash
python -m unittest discover -s tests
node --test "tests/*.test.mjs"
```

## Limits

- Covers R4, R4B and R5 core and the HL7 Extensions Pack. National guides such as US Core aren't included yet.
- No terminology lookups (LOINC, SNOMED CT); bindings show the value set only.
- Renames are a best guess from the definitions, not an official mapping.

---

HL7® and FHIR® are registered trademarks of Health Level Seven International. This project is not affiliated with or endorsed by HL7.
