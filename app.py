"""Web chat for the FHIR mapping assistant. Run: streamlit run app.py"""
import os
import sys
from pathlib import Path

import anthropic
import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
from assistant import ask  # noqa: E402

EXAMPLES = [
    "I have a patient's preferred pharmacy. Where does it go?",
    "What changed in Encounter between R4 and R5?",
    "Where do I store a lab result's normal range?",
    "Is there an official extension for a patient's place of birth?",
]

st.set_page_config(page_title="Interop Mapper", page_icon="🛡️", layout="centered")
st.title("Interop Mapper")
st.caption("Ask where your data fits in FHIR, how versions differ, and which extensions to use. "
           "Answers come only from the official HL7 definitions (R4, R4B, R5 and the Extensions Pack).")

with st.sidebar:
    version = st.selectbox("Default FHIR version", ["R4", "R4B", "R5"], index=0)
    if st.button("New conversation"):
        st.session_state.history = []
        st.session_state.display = []
        st.rerun()
    st.divider()
    st.caption("Don't paste real patient data. Describe the fields instead.")
    st.caption("Built by InteropSec")

if "history" not in st.session_state:
    st.session_state.history = []   # exact API messages, append-only
    st.session_state.display = []   # what the page shows

if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
    st.error("No Anthropic API key found. Set the ANTHROPIC_API_KEY environment variable, "
             "then restart the app. Never paste the key into the chat.")
    st.stop()

for item in st.session_state.display:
    with st.chat_message(item["role"]):
        st.markdown(item["text"])
        if item.get("tool_calls"):
            with st.expander(f"Looked up ({len(item['tool_calls'])})"):
                for call in item["tool_calls"]:
                    args = ", ".join(f"{k}={v!r}" for k, v in call["input"].items())
                    st.code(f"{call['name']}({args})", language="python")

if not st.session_state.display:
    st.write("Try one:")
    for example in EXAMPLES:
        if st.button(example):
            st.session_state.pending = example
            st.rerun()

question = st.chat_input("Describe your data or ask about a FHIR version...") or st.session_state.pop("pending", None)

if question:
    st.session_state.display.append({"role": "user", "text": question})
    with st.chat_message("user"):
        st.markdown(question)
    with st.chat_message("assistant"):
        with st.spinner("Checking the official definitions..."):
            try:
                answer, tool_calls = ask(st.session_state.history, question, version)
            except anthropic.AuthenticationError:
                answer, tool_calls = "The API key was rejected. Check ANTHROPIC_API_KEY and restart.", []
            except anthropic.RateLimitError:
                answer, tool_calls = "Rate limit reached. Wait a minute and try again.", []
            except anthropic.APIConnectionError:
                answer, tool_calls = "Couldn't reach the API. Check your internet connection.", []
            except anthropic.APIStatusError as e:
                answer, tool_calls = f"The API returned an error ({e.status_code}). Try again shortly.", []
        st.session_state.display.append({"role": "assistant", "text": answer, "tool_calls": tool_calls})
        st.rerun()
