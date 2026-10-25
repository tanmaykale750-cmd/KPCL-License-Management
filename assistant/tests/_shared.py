"""Shared fixtures for the test-suite (works with `python -m unittest` and with pytest)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from rag_chatbot.config import load_settings  # noqa: E402
from rag_chatbot.services import build_services  # noqa: E402

_SVC = None


class FakeLLM:
    """Records every call; returns a canned grounded-looking answer. Used to test prompt construction."""
    label = "fake-llm"

    def __init__(self, reply: str = "Direct answer [S1].\n\n**Suggested next steps**\n- step"):
        self.calls = []
        self.reply = reply

    def generate(self, system, messages, max_tokens=None):
        self.calls.append({"system": system, "messages": messages, "max_tokens": max_tokens})
        if max_tokens and max_tokens <= 150:          # query-rewrite call
            return "rewritten standalone query"
        return self.reply


def services(llm=None):
    """Services in retrieval-only mode (shared, built once). Pass llm to get an engine with that client."""
    global _SVC
    if _SVC is None:
        s = load_settings()
        s.llm_provider = "none"
        _SVC = build_services(s, llm=None, save_index=False)
    if llm is None:
        return _SVC
    from rag_chatbot.chat import ChatEngine
    return ChatEngine(_SVC.retriever, _SVC.ml, _SVC.rec, llm, _SVC.settings)
