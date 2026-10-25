"""
Thin adapters over the existing modules (nothing here re-implements them):

  forecast / explanation  assistant MLService with the trained ensemble (components/model_selection)
  simulation              components/forecasting licence_ml.simulate.PoolSimulator, fed the ensemble
  recommendation          components/recommendation_engine (portfolio_decision_engine via RecommendationService)
  optimisation            the engine's software-level cost-risk optimiser output (recommendations.csv)
  chatbot                 rag_chatbot ChatEngine (retrieval + live tools + question-specific structured answers,
                          tailored to the signed-in profile)
"""
from __future__ import annotations

import sys
import threading
from pathlib import Path

from . import sim_guard

ASSISTANT_DIR = Path(__file__).resolve().parent.parent / "assistant"

sim_guard.install()                       # before anything can import licence_ml.simulate
if str(ASSISTANT_DIR) not in sys.path:
    sys.path.insert(0, str(ASSISTANT_DIR))

_lock = threading.Lock()
_services = None
_error: str | None = None


def services():
    """Build once (knowledge base, retriever, ensemble). The ensemble is the only forecasting model allowed."""
    global _services, _error
    with _lock:
        if _services is None:
            from rag_chatbot.config import load_settings
            from rag_chatbot.services import build_services
            s = load_settings()
            s.forecast_model = "ensemble"
            try:
                _services = build_services(s, save_index=False)
                _error = None
            except Exception as e:  # keep the API up and report the reason
                _error = f"{type(e).__name__}: {e}"
                raise
        return _services


def status() -> dict:
    out = {"ready": _services is not None, "error": _error, "simulation_ml_module_excluded": sim_guard.is_active()}
    if _services is not None:
        out["model"] = _services.ml.model_status()
        out["llm"] = getattr(_services.llm, "label", None)
        out["warnings"] = _services.warnings
    return out


def jsonable(obj):
    from rag_chatbot.integration.ml_adapter import to_jsonable
    return to_jsonable(obj)


# ------------------------------------------------------------------ module calls
def pools() -> dict:
    s = services()
    rec = s.rec.pool_recommendations()
    return {"portfolios": s.ml.portfolios(),
            "software": rec[["software_id", "software_name"]].drop_duplicates().sort_values("software_id").to_dict("records")}


def forecast(pf: str, sw: str) -> dict:
    s = services()
    m = s.ml.live_pool_forecast(pf, sw)
    return {"portfolio_id": pf, "software_id": sw, "model": s.ml.model_label, "monthly": m}


def explain(pf: str, sw: str) -> dict:
    return services().ml.explain_pool(pf, sw)


COST_FIELDS = ("estimated_temporary_cost_inr", "estimated_annual_permanent_cost_delta_inr",
               "estimated_annual_saving_at_renewal_inr", "added_cost_inr", "total_cost_inr", "residual_shortage_cost_inr",
               "idle_cost_inr_before", "idle_cost_inr_after", "action_cost_inr")


def _strip_costs(d: dict) -> dict:
    return {k: (None if k in COST_FIELDS else v) for k, v in d.items()}


def recommendation(pf: str, sw: str, costs: bool = True) -> dict:
    s = services()
    r = s.rec.pool_recommendations()
    row = r[(r["portfolio_id"] == pf) & (r["software_id"] == sw)]
    rec = row.iloc[0].to_dict() if len(row) else None
    opts = s.ml.options(pf, sw)
    if not costs:
        from rag_chatbot.viewer import redact_money
        if rec:
            rec = _strip_costs(rec)
            rec["reason"] = redact_money(str(rec.get("reason", "")))
        opts = opts.drop(columns=[c for c in COST_FIELDS if c in opts.columns])
    return {"portfolio_id": pf, "software_id": sw, "recommendation": rec, "options": opts, "costs_visible": costs}


def optimisation() -> dict:
    s = services()
    return {"software": s.rec.software_recommendations(), "summary": s.rec.run_summary()}


def what_if(body: dict, costs: bool = True) -> dict:
    from rag_chatbot.integration.ml_adapter import WhatIfRequest
    s = services()
    req = WhatIfRequest(portfolio_id=str(body["portfolio_id"]), software_id=str(body["software_id"]),
                        licence_change=int(body.get("licence_change") or 0), temp_licences=int(body.get("temp_licences") or 0),
                        delay_projects={str(k): int(v) for k, v in (body.get("delay_projects") or {}).items()},
                        cancel_projects=[str(p) for p in body.get("cancel_projects") or []],
                        team_size={str(k): int(v) for k, v in (body.get("team_size") or {}).items()},
                        name=str(body.get("name") or "What-if"))
    res = s.ml.what_if(req)
    engine = s.rec.evaluate_forecast(res["monthly_after"], licence_change=req.licence_change) if res["valid"] else None
    res["request"] = req.__dict__
    res["engine_recommendation"] = engine
    if not costs:
        res["summary"] = _strip_costs(res["summary"])
        for k in ("monthly_after", "monthly_before"):
            res[k] = res[k].drop(columns=[c for c in ("idle_cost_inr",) if c in res[k].columns])
        if engine is not None:
            res["engine_recommendation"] = engine.drop(columns=[c for c in COST_FIELDS if c in engine.columns])
    return res


def chat(question: str, history: list, focus, viewer: dict | None = None) -> dict:
    """RAG answer for the signed-in employee. `viewer` is backend.auth's verified user record."""
    from rag_chatbot.viewer import Viewer
    s = services()
    v = Viewer.from_user(viewer)
    r = s.engine.answer(question, history, focus, viewer=v)
    wi = None
    if r.whatif is not None:
        wi = {k: r.whatif[k] for k in ("description", "valid", "errors", "summary") if k in r.whatif}
        if not v.sees_costs and isinstance(wi.get("summary"), dict):
            wi["summary"] = _strip_costs(wi["summary"])
    return {"answer": r.answer, "llm_used": r.llm_used, "notes": r.notes, "suggestions": r.suggestions,
            "intents": r.intents, "question_type": r.question_type, "structured": r.structured,
            "entities": r.entities.to_dict(), "focus": r.entities.pool(),
            "sources": [{"label": b.label, "title": b.title, "source": b.source, "kind": b.kind} for b in r.blocks],
            "whatif": wi}
