"""Claude-powered assistant that answers FHIR mapping and version questions.

Every answer is grounded in tool calls against the local index of official HL7
definitions (see fhirdb.py). Conversation history is append-only: each turn's
assistant content and tool results are stored exactly as received and sent back
unchanged, which keeps the model's earlier reasoning valid across turns.
"""
import json
from pathlib import Path
from typing import Literal

import anthropic
from anthropic import beta_tool

from fhirdb import FhirDB

MODEL = "claude-opus-5-5"
DB_PATH = Path(__file__).resolve().parent.parent / "data" / "fhir.db"

Version = Literal["R4", "R4B", "R5"]

SYSTEM_PROMPT = """You help developers map their data to HL7 FHIR and understand differences between FHIR versions.

Your tools search the official definitions: the FHIR R4, R4B and R5 core specifications and the HL7 FHIR Extensions Pack. Base every element, cardinality, type, binding and extension you mention on what the tools return, and link to it using the url or page the tools give you.

How to work:
- Look things up before answering. For "where does this data go" questions, search for candidate elements and check the best ones with get_fhir_element or get_fhir_resource. For version questions, use compare_fhir_versions. Recommend an extension only if search_fhir_extensions returned it, and only when no core element fits.
- Each user message states a default FHIR version; use it unless the user names another.
- compare_fhir_versions reports renames as "possible": they are matched by similar descriptions or child elements, so present them as likely, not certain.
- Some things are outside your tools: national guides such as US Core, and terminology content such as specific LOINC or SNOMED codes. Say so plainly. You may add general knowledge there, labelled as not coming from the indexed specification.
- If a user pastes what looks like real patient data, remind them not to share patient information here and work only with the field names.

Answer format for mapping questions: the best element (path, type, cardinality, link), one line on why, close alternatives if any, then any extension or terminology note. Keep answers short and easy to scan."""

db = FhirDB(str(DB_PATH))
_client = None


def get_client():
    """Create the API client on first use, so the app can start without a key and explain setup."""
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


def _run(fn, *args):
    try:
        return json.dumps(fn(*args), sort_keys=True)
    except ValueError as e:
        return json.dumps({"error": str(e)})


@beta_tool
def search_fhir_elements(query: str, version: Version = "R4", resource: str = "") -> str:
    """Find FHIR elements whose name, short description or definition match the query.

    Use this to find where a piece of data could be stored. Results include path,
    cardinality, types, terminology binding and a link to the official definition.

    Args:
        query: Plain words describing the data, e.g. "date of birth" or "lab reference range".
        version: FHIR version to search.
        resource: Optional resource or datatype name to limit the search, e.g. "Observation".
    """
    return _run(db.search_elements, query, version, resource or None)


@beta_tool
def get_fhir_element(path: str, version: Version = "R4") -> str:
    """Get the full official definition of one element, e.g. "Patient.birthDate".

    Args:
        path: Dotted element path, case-sensitive.
        version: FHIR version.
    """
    return _run(db.get_element, path, version)


@beta_tool
def get_fhir_resource(name: str, version: Version = "R4") -> str:
    """Get a resource's or datatype's description and its top-level elements.

    Args:
        name: Resource or datatype name, e.g. "Encounter" or "HumanName".
        version: FHIR version.
    """
    return _run(db.get_resource, name, version)


@beta_tool
def compare_fhir_versions(resource: str, from_version: Version = "R4", to_version: Version = "R5") -> str:
    """Compute the exact element-level differences of one resource between two FHIR versions.

    Returns removed, added and changed elements (cardinality, types, bindings) and
    likely renames. If the resource does not exist in one version, returns the
    closest resources in that version.

    Args:
        resource: Resource name, e.g. "MedicationRequest".
        from_version: The older version.
        to_version: The newer version.
    """
    return _run(db.compare_versions, resource, from_version, to_version)


@beta_tool
def search_fhir_extensions(query: str, version: Version = "R4", context: str = "") -> str:
    """Search official HL7 extensions (core extensions and the Extensions Pack).

    Results include the extension URL, where it can be used, its value type,
    status, maturity and a link to its page.

    Args:
        query: Plain words describing the data, e.g. "birth place" or "preferred pharmacy".
        version: FHIR version the extension will be used with.
        context: Optional resource or element the extension must apply to, e.g. "Patient".
    """
    return _run(db.search_extensions, query, version, context or None)


TOOLS = [search_fhir_elements, get_fhir_element, get_fhir_resource,
         compare_fhir_versions, search_fhir_extensions]


def ask(history, question, default_version="R4"):
    """Run one user turn.

    `history` is the conversation so far and is extended in place (append-only).
    Returns (answer_text, tool_calls) where tool_calls lists each lookup made.
    """
    history.append({"role": "user",
                    "content": f"{question}\n\n(Default FHIR version for this question: {default_version})"})
    runner = get_client().beta.messages.tool_runner(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        tools=TOOLS,
        messages=list(history),
        cache_control={"type": "ephemeral"},
        output_config={"effort": "medium"},
        # If a safety classifier declines, the API retries on a fallback model.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        max_iterations=12,
    )

    tool_calls = []
    last = None
    for message in runner:
        last = message
        # Mirror the runner's history exactly; never edit earlier turns.
        history.append({"role": "assistant", "content": message.content})
        tool_calls += [{"name": b.name, "input": b.input} for b in message.content if b.type == "tool_use"]
        tool_response = runner.generate_tool_call_response()
        if tool_response is not None:
            history.append(tool_response)

    if last is None:
        return "No response was returned. Please try again.", tool_calls
    if last.stop_reason == "refusal":
        return "This question was declined by the model's safety checks. Try rephrasing it.", tool_calls
    answer = "".join(b.text for b in last.content if b.type == "text").strip()
    if last.stop_reason == "max_tokens":
        answer += "\n\n_(Answer was cut off at the length limit.)_"
    return answer or "I couldn't finish the lookup within the step limit. Try a narrower question.", tool_calls
