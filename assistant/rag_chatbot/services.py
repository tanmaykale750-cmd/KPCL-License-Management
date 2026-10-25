"""Wire everything together (used by the Streamlit app, the CLI and the tests)."""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from .chat import ChatEngine
from .config import PROJECT_ROOT, Settings, load_settings
from .integration.engine_adapter import RecommendationService, handoff_files
from .integration.ml_adapter import MLService
from .knowledge_base import Document, KnowledgeBaseBuilder, save_documents
from .llm import LLMError, build_client
from .retriever import HybridRetriever

INDEX_FILE = PROJECT_ROOT / "data" / "index" / "knowledge_base.jsonl"


@dataclass
class Services:
    settings: Settings
    ml: MLService
    rec: RecommendationService
    docs: list[Document]
    retriever: HybridRetriever
    llm: object | None
    engine: ChatEngine
    warnings: list[str] = field(default_factory=list)
    build_seconds: float = 0.0


def build_services(settings: Settings | None = None, llm=..., save_index: bool = True) -> Services:
    """
    llm=...  (default) build the client from settings; pass None to force no-LLM mode, or pass any object with
    .generate(system, messages) and .label (used by the tests).
    """
    t0 = time.time()
    s = settings or load_settings()
    ml = MLService(s.forecast_dir, s.forecast_model, s.ensemble_dir)
    rec = RecommendationService(s.engine_dir, s.forecast_dir, handoff_files(ml))
    warnings: list[str] = []
    sync = rec.handoff_in_sync()
    if sync.get("checked") and not sync.get("all_in_sync"):
        warnings.append("the recommendation engine's input forecast differs from the active model's latest simulation output. Run "
                        "`python scripts/build_pipeline.py` to re-sync and re-run the recommendation engine.")
    kb = KnowledgeBaseBuilder(ml, rec, PROJECT_ROOT)
    docs = kb.build()
    warnings += kb.warnings
    if not docs:
        raise RuntimeError("Knowledge base is empty - component outputs are missing. Run scripts/build_pipeline.py.")
    if save_index:
        try:
            save_documents(docs, INDEX_FILE)
        except OSError as e:
            warnings.append(f"Could not write {INDEX_FILE}: {e}")
    retriever = HybridRetriever(docs)
    if llm is ...:
        try:
            client = build_client(s)
        except LLMError as e:
            warnings.append(str(e))
            client = None
    else:
        client = llm
    engine = ChatEngine(retriever, ml, rec, client, s)
    return Services(s, ml, rec, docs, retriever, client, engine, warnings, round(time.time() - t0, 2))
