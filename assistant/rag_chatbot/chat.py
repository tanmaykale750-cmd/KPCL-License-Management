"""
Chat orchestrator:

    question -> entities (pool, project, month; follow-ups inherit them)
             -> question type (respond.classify: why at risk / forecast / what to do / why this recommendation /
                options / next steps / what-if / renewal / ranking / accuracy / method / definition ...)
             -> the live tools that type needs (model explanation, simulation options, what-if, analytics)
             -> context blocks, ordered for the question, plus hybrid retrieval
             -> a structured answer composed for THAT question (respond.py), tailored to the asker's profile
             -> optionally rewritten by an LLM that is given the answer plan and the structured draft

    engine = ChatEngine(retriever, ml_service, rec_service, llm_client_or_None, settings)
    result = engine.answer("Why is PF001 ANSYS at risk?", history=[...], viewer=Viewer(...))
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import pandas as pd

from . import analytics
from .config import Settings
from .entities import FOLLOWUP_HINTS, Entities, extract, looks_like_followup
from .integration.engine_adapter import ACTION_MEANING, RecommendationService
from .integration.ml_adapter import MLService, MLUnavailable, WhatIfRequest
from .llm import LLMError, Message
from .explain import decision_trace, pool_brief
from .prompts import QTYPE_GOAL, REWRITE_PROMPT, SYSTEM_PROMPT
from .respond import (GeneralComposer, PoolComposer, PoolFacts, Structured, adapt_to_viewer, classify, to_markdown)
from .terminology import neutralize
from .retriever import HybridRetriever, detect_intents
from .viewer import FULL_ACCESS, Viewer, redact_money

MAX_BLOCK_CHARS = 2600
MAX_BRIEF_CHARS = 7000
POOL_INTENTS = {"forecast", "recommendation", "explain", "whatif"}


@dataclass
class ContextBlock:
    label: str            # S1, S2, ...
    title: str
    text: str
    source: str
    kind: str             # "document" | "live_model" | "live_engine" | "analytics"
    doc_id: str | None = None
    score: float | None = None


@dataclass
class ChatResult:
    answer: str
    blocks: list[ContextBlock]
    entities: Entities
    standalone_query: str
    intents: list[str]
    llm_used: str | None
    notes: list[str] = field(default_factory=list)       # tool / fallback notices shown to the user
    whatif: dict | None = None
    suggestions: list[str] = field(default_factory=list)
    question_type: str = "unknown"
    structured: dict | None = None        # the structured answer (respond.Structured.to_dict())


# ---------------------------------------------------------------------------- what-if parsing
_NUM = r"(\d{1,3})"


def parse_whatif(q: str, ents: Entities) -> WhatIfRequest | None:
    """Recognise simple what-if requests in plain English. Returns None if nothing scenario-like is found."""
    if not ents.pool():
        return None
    t = q.lower()
    pf, sw = ents.pool()
    req = WhatIfRequest(pf, sw)
    m = re.search(_NUM + r"\s*(?:extra\s+|more\s+)?(?:temporary|temp|short[- ]term)\s+licen", t) or \
        re.search(r"(?:temporary|temp|short[- ]term)\s+licen[cs]es?\s*(?:of|=|:)?\s*" + _NUM, t)
    if m:
        req.temp_licences = int(m.group(1))
    m = re.search(r"(?:add|adding|buy|buying|purchase|purchasing|increase by|plus|\+)\s*" + _NUM +
                  r"\s*(?:more\s+|extra\s+|additional\s+)?(?:permanent\s+|annual\s+|new\s+)?licen", t)
    if m and not re.search(r"(?:add|adding|buy|buying|purchase|purchasing|increase by|plus|\+)\s*" + _NUM +
                           r"\s*(?:more\s+|extra\s+)?(?:temporary|temp|short)", t):
        req.licence_change = int(m.group(1))
    m = re.search(r"(?:remove|removing|reduce by|cut|cutting|drop|dropping|minus|fewer)\s*" + _NUM + r"\s*licen", t) or \
        re.search(_NUM + r"\s*fewer\s+licen", t)
    if m:
        req.licence_change = -int(m.group(1))
    for pid, k in re.findall(r"delay(?:ing|ed)?\s+(p\d{4})\s*(?:by\s+)?(\d{1,2})?\s*(?:month)?", t):
        req.delay_projects[pid.upper()] = int(k) if k else 1
    for pid in re.findall(r"cancel(?:ling|led|ing)?\s+(p\d{4})", t):
        req.cancel_projects.append(pid.upper())
    for pid, n in re.findall(r"(p\d{4})(?:'s)?\s+team(?:\s+size)?\s*(?:to|=|of|becomes|is)?\s*(\d{1,3})", t) + \
            re.findall(r"team(?:\s+size)?\s+(?:of\s+)?(p\d{4})\s*(?:to|=|becomes|is)\s*(\d{1,3})", t):
        req.team_size[pid.upper()] = int(n)
    if req.is_empty():
        return None
    req.name = req.describe()
    return req


# ---------------------------------------------------------------------------- formatting tool outputs
def _fmt_explain(ex: dict) -> str:
    if not ex.get("months"):
        return ex.get("note", "No forecast rows for this pool in the planning window.")
    lines = [f"Model explanation for pool {ex['portfolio_id']} / {ex['software_id']} (method: {ex['method']}). For each "
             "month, the model's predicted pool peak (average over the project forecasts feeding that month) is split "
             "into contributions by feature group, relative to a typical prediction. Positive = pushes demand up."]
    for m in ex["months"]:
        drv = "; ".join(f"{k} {v:+.2f}" for k, v in m["drivers"].items() if abs(v) >= 0.05) or "no significant drivers"
        lines.append(f"- {m['month']}: predicted peak {m['peak_expected_mean']:.2f} licences vs typical "
                     f"{m['typical_baseline']:.2f}; drivers: {drv}; projects: {', '.join(m['projects'][:6])}"
                     f"{' ...' if len(m['projects']) > 6 else ''}. Example: {m['example']}")
    return "\n".join(lines)


def _inr(v: float) -> str:
    return f"₹{v / 1e5:,.2f} lakh" if abs(v) >= 1e5 else f"₹{v:,.0f}"


def _fmt_whatif(res: dict, m3: pd.DataFrame | None) -> str:
    if not res["valid"]:
        return (f"**Scenario:** {res['description']}\n\n**Not run:** the simulator rejected it: " + "; ".join(res["errors"]))
    s = res["summary"]
    b, a = s["months_at_risk_before"], s["months_at_risk_after"]
    pb, pa = 100 * s["max_shortage_probability_before"], 100 * s["max_shortage_probability_after"]
    if a == 0 and b > 0:
        verdict = "removes every at-risk month"
    elif a == 0:
        verdict = "keeps every month within the 5% tolerance"
    elif pa < pb - 0.05:
        verdict = f"lowers the risk, but {a} month(s) stay above the 5% tolerance"
    else:
        verdict = "does not reduce the shortage risk"
    lines = [f"**Scenario:** {res['description']} (re-simulated with the forecasting model and the Monte Carlo "
             "simulation; plan changes re-run the model, licence changes only change supply).", "",
             "| Measure | Before | After |", "|---|---|---|",
             f"| Months at risk | {b} | {a} |",
             f"| Highest shortage chance | {pb:.1f}% | {pa:.1f}% |",
             f"| Expected shortage (licence-months) | {s['expected_shortage_licence_months_before']:.2f} | "
             f"{s['expected_shortage_licence_months_after']:.2f} |",
             f"| Idle-licence cost (6 months) | {_inr(s['idle_cost_inr_before'])} | {_inr(s['idle_cost_inr_after'])} |",
             f"| Added cost of the change | — | {_inr(s['added_cost_inr'])} |", "",
             "| Month | High case (P90) | Licences | Shortage chance | At risk |", "|---|---|---|---|---|"]
    for r in res["comparison"].itertuples(index=False):
        lic = f"{r.licences_owned_after:.0f}" + (f" + {r.temp_cap_after:.0f} temp" if r.temp_cap_after else "")
        lines.append(f"| {r.month} | {r.peak_p90_before:.0f} → {r.peak_p90_after:.0f} | {r.licences_owned_before:.0f} → {lic} | "
                     f"{100 * r.shortage_probability_before:.1f}% → {100 * r.shortage_probability_after:.1f}% | "
                     f"{'yes' if r.at_risk_before else 'no'} → {'yes' if r.at_risk_after else 'no'} |")
    lines += ["", f"**Verdict:** this change {verdict}."]
    if m3 is not None and len(m3):
        r = m3.iloc[0]
        lines.append(f"**Recommendation engine on the scenario:** `{r['action']}` – {ACTION_MEANING.get(r['action'], '')} "
                     f"Reason: {r['reason']}")
    return "\n".join(lines)


def _fmt_options(o: pd.DataFrame) -> str:
    lines = ["Options compared live by the Monte Carlo simulator (sorted: valid, meets risk tolerance, cheapest):"]
    for r in o.head(8).itertuples(index=False):
        lines.append(f"- {r.option}: months at risk {r.months_at_risk}, max shortage probability "
                     f"{100 * r.max_shortage_probability:.1f}%, added cost INR {r.added_cost_inr:,.0f}, total INR "
                     f"{r.total_cost_inr:,.0f}, meets risk {r.meets_risk}" + (f", errors: {r.errors}" if r.errors else ""))
    return "\n".join(lines)


# ---------------------------------------------------------------------------- engine
# which context blocks go first for each question type (the LLM reads them in this order)
BLOCK_ORDER = {
    "recommendation": ["decision", "forecast", "explain", "options", "engine_record"],
    "rec_why": ["decision", "forecast", "explain", "engine_record", "options"],
    "next_steps": ["decision", "options", "forecast", "engine_record"],
    "options": ["options", "decision", "forecast", "engine_record"],
    "drivers": ["forecast", "explain", "decision", "accuracy"],
    "forecast": ["forecast", "explain", "accuracy", "decision"],
    "availability": ["forecast", "explain", "accuracy"],
    "overview": ["forecast", "decision", "explain", "options"],
    "renewal": ["decision", "engine_record", "forecast"],
    "whatif": ["whatif", "forecast", "decision", "options"],
}
POOL_TYPES = set(BLOCK_ORDER)


class ChatEngine:
    def __init__(self, retriever: HybridRetriever, ml: MLService, rec: RecommendationService, llm, settings: Settings):
        self.r, self.ml, self.rec, self.llm, self.s = retriever, ml, rec, llm, settings
        self._pool_recs = None
        self._pool_fc = None
        self._inv = None
        self._sim = None
        self._cfg = None
        self._proj_dept = None

    # ---------------- structured explanation of a pool's recommendation (Streamlit Recommendations page)
    def brief(self, pf: str, sw: str, drivers: dict | None = None) -> dict | None:
        pr, pfc, inv = self._tables()
        if pfc is None:
            return None
        fc = pfc[(pfc["portfolio_id"] == pf) & (pfc["software_id"] == sw)]
        if fc.empty:
            return None
        self._load_sim()
        row = pr[(pr["portfolio_id"] == pf) & (pr["software_id"] == sw)]
        cost = float(inv.set_index("software_id").loc[sw, "annual_cost_per_license_inr"])
        return pool_brief(pf, sw, row.iloc[0].to_dict() if len(row) else None, fc, self._sim.get((pf, sw)), self._cfg,
                          cost, self.ml.model_label, drivers)

    def _load_sim(self):
        if self._sim is None:
            try:
                self._sim = {(r["portfolio_id"], r["software_id"]): r
                             for r in self.ml.sim_recommendations()["recommendations"]}
            except FileNotFoundError:
                self._sim = {}
            self._cfg = self.rec.pde.load_settings(self.rec.config_path, self.rec.data_dir / "assumptions.csv")

    # ---------------- cached tables for analytics
    def _tables(self):
        if self._pool_recs is None:
            self._pool_recs = self.rec.pool_recommendations()
            try:
                self._pool_fc = self.ml.pool_forecast()
            except FileNotFoundError:
                self._pool_fc = None
            self._inv = self.rec.inventory()
        return self._pool_recs, self._pool_fc, self._inv

    def _project_departments(self) -> dict:
        if self._proj_dept is None:
            try:
                d = self.ml.dataset()
                self._proj_dept = d.drop_duplicates(self.ml.C.PROJECT).set_index(self.ml.C.PROJECT)["department"].to_dict()
            except Exception:
                self._proj_dept = {}
        return self._proj_dept

    # ---------------- follow-up handling
    @staticmethod
    def _last_meta(history: list[dict]) -> dict:
        for turn in reversed(history or []):
            meta = turn.get("meta") or {}
            if meta.get("entities") or meta.get("qtype"):
                return meta
        return {}

    @classmethod
    def _last_entities(cls, history: list[dict]) -> Entities:
        ents = cls._last_meta(history).get("entities")
        return Entities.from_dict(ents) if ents else Entities()

    def resolve_entities(self, question: str, history: list[dict], focus: tuple[str, str] | None) -> Entities:
        ents = extract(question)
        prior = self._last_entities(history)
        intents = set(detect_intents(question))
        pool_intent = bool(intents & POOL_INTENTS)
        explicit_followup = bool(FOLLOWUP_HINTS.search(question))
        ranking = bool(analytics.RANKING.search(question))
        no_pool_named = not ents.portfolios and not ents.software
        if not prior.empty():
            if ranking and not explicit_followup:
                pass                                   # a fresh cross-pool question: do not inherit
            elif no_pool_named and (explicit_followup or pool_intent or re.search(r"\bnext steps?\b|\boptions?\b", question,
                                                                                 re.I)):
                ents = Entities(prior.portfolios, prior.software, ents.projects or prior.projects, ents.months)
            elif bool(ents.software) != bool(ents.portfolios) and prior.pool():
                # "what about MATLAB?" keeps the previous portfolio; "and PF012?" keeps the previous software
                ents = ents.merged_with(Entities(prior.portfolios, prior.software, [], []))
        # a project ID alone identifies its portfolio (and its software if it uses only one, or the one in context)
        if ents.projects:
            try:
                info = self.ml.project_info(ents.projects[0])
            except Exception:
                info = None
            if info and not ents.portfolios:
                ents = Entities([info["portfolio_id"]], ents.software, ents.projects, ents.months)
            if info and not ents.software and ents.portfolios == [info["portfolio_id"]]:
                cand = [s for s in (prior.software + ([focus[1]] if focus else [])) if s in info["software"]]
                if cand:
                    ents = Entities(ents.portfolios, [cand[0]], ents.projects, ents.months)
                elif len(info["software"]) == 1:
                    ents = Entities(ents.portfolios, info["software"], ents.projects, ents.months)
        if focus and ents.empty() and (pool_intent or re.search(r"\bnext steps?\b|\boptions?\b|\bshould\b", question, re.I)) \
                and not ranking:
            ents = Entities([focus[0]], [focus[1]], [], [])
        return ents

    def standalone_query(self, question: str, history: list[dict], ents: Entities) -> str:
        if not history or not looks_like_followup(question):
            base = question
        elif self.llm is not None and self.s.rewrite_followups_with_llm:
            convo = "\n".join(f"{t['role']}: {t['content'][:400]}" for t in history[-4:])
            try:
                base = self.llm.generate("You rewrite queries.", [Message("user", REWRITE_PROMPT.format(
                    history=convo, question=question))], max_tokens=120).strip().splitlines()[0]
            except (LLMError, IndexError):
                base = question
        else:
            prev = next((t["content"] for t in reversed(history) if t["role"] == "user"), "")
            base = f"{question} {prev}"
        extra = " ".join(ents.portfolios + ents.software + ents.projects)
        return f"{base} {extra}".strip()

    # ---------------- main entry
    def answer(self, question: str, history: list[dict] | None = None,
               focus: tuple[str, str] | None = None, viewer: Viewer | None = None) -> ChatResult:
        question = (question or "").strip()
        history = history or []
        viewer = viewer or FULL_ACCESS
        if not question:
            raise ValueError("Empty question")
        ents = self.resolve_entities(question, history, focus)
        intents = detect_intents(question)
        query = self.standalone_query(question, history, ents)
        prior_qtype = self._last_meta(history).get("qtype")
        notes: list[str] = []
        pool = ents.pool()

        # ---- what-if: parse, then check the profile may run it
        wreq = parse_whatif(question, ents)
        wkind = None if wreq is None else ("supply" if (wreq.licence_change or wreq.temp_licences) else "plan")
        permitted = wreq is None or viewer.can("simulate") or (wkind == "plan" and viewer.can("simulate_plan"))
        plan = classify(question, pool, bool(ents.portfolios), bool(ents.software), wreq is not None and permitted,
                        ents.months, prior_qtype)
        if wreq is not None and not permitted:
            what = ("licence-supply what-ifs (adding, removing or temporary licences)" if wkind == "supply"
                    else "schedule what-ifs")
            plan.blocked = {"description": wreq.describe(), "kind": wkind}
            notes.append(f"What-if not run: your profile ({viewer.label}) cannot run {what}.")
            if plan.qtype == "unknown":
                plan.qtype = "overview"
        plan = adapt_to_viewer(plan, viewer)

        cand: dict[str, tuple] = {}          # key -> (title, text, source, kind)
        whatif_out = None
        if pool and plan.qtype == "whatif":
            try:
                res = self.ml.what_if(wreq)
                m3 = None
                if res["valid"]:
                    try:
                        m3 = self.rec.evaluate_forecast(res["monthly_after"], licence_change=wreq.licence_change)
                    except Exception as e:  # engine re-evaluation is a bonus; keep the ML result
                        notes.append(f"recommendation engine re-evaluation failed: {e}")
                whatif_out = {**res, "engine": m3}
                cand["whatif"] = (f"LIVE what-if: {wreq.describe()} on {wreq.portfolio_id}/{wreq.software_id}",
                                  _fmt_whatif(res, m3), "live run: licence_ml.simulate.PoolSimulator + "
                                  "portfolio_decision_engine", "live_model")
            except MLUnavailable as e:
                notes.append(f"What-if not run: {e}")
            except Exception as e:
                notes.append(f"What-if failed: {type(e).__name__}: {e}")

        facts = None
        if pool:
            facts = self._pool_facts(pool, plan, cand, notes, viewer, whatif_out, wreq)
        elif plan.qtype in ("ranking", "portfolio", "software") or analytics.wants_analytics(question, ents):
            try:
                pr, pfc, inv = self._tables()
                for i, b in enumerate(analytics.build(question, ents, pr, pfc, inv)):
                    cand[f"analytics{'' if i == 0 else i}"] = (b["title"], b["text"], b["source"], "analytics")
            except Exception as e:
                notes.append(f"Analytics failed: {type(e).__name__}: {e}")

        # ---- context blocks: the question's own facts first, then retrieved documents
        blocks: list[ContextBlock] = []
        labels: dict[str, str] = {}

        def add(key, title, text, source, kind, doc_id=None, score=None):
            limit = MAX_BRIEF_CHARS if kind == "brief" else MAX_BLOCK_CHARS
            text = neutralize(text)[:limit]
            if not viewer.sees_costs:
                text = redact_money(text)
            label = f"S{len(blocks) + 1}"
            blocks.append(ContextBlock(label, neutralize(title), text, source, kind, doc_id, score))
            if key:
                labels.setdefault(key, label)

        for key in BLOCK_ORDER.get(plan.qtype, []):
            if key in cand:
                add(key, *cand.pop(key))
        for key, v in list(cand.items()):
            add(key.rstrip("0123456789") if key.startswith("analytics") else key, *v)

        seen = {b.doc_id for b in blocks if b.doc_id}
        general_keys = {"model_accuracy": "accuracy", "glossary": "glossary", "assumption": "assumption",
                        "engine_method": "engine", "model_method": "model"}
        for h in self.r.search(query, k=self.s.top_k, entities=ents):
            if h.doc.id in seen:
                continue
            m = h.doc.meta or {}
            if pool and m.get("portfolio_id") and m.get("software_id") and (m["portfolio_id"], m["software_id"]) != pool:
                continue          # another pool's record: noise when the user asked about one specific pool
            if not viewer.sees_recommendations and h.doc.doc_type in ("pool_rec_m3", "pool_rec_m2", "software_rec_m3"):
                continue          # recommendation records are outside this profile
            seen.add(h.doc.id)
            key = "comparison" if h.doc.id == "model:comparison" else general_keys.get(h.doc.doc_type)
            if h.doc.doc_type == "software_overview" and plan.qtype in ("renewal_all", "software"):
                key = "renewal"
            add(key, h.doc.title, h.doc.text, h.doc.source, "document", h.doc.id, h.score)
            if len(blocks) >= self.s.top_k + 5:
                break

        # ---- compose the answer for this question
        def cite(key):
            return labels.get(key)

        st = self._compose(plan, facts, ents, viewer, cite, blocks)
        st.sources = [{"label": b.label, "title": b.title} for b in blocks]
        draft = to_markdown(st)

        llm_used = None
        if self.llm is None:
            answer = to_markdown(st, preface="*Answer assembled from the system's outputs (no AI summary: no LLM "
                                             "configured).*")
            notes.append("No LLM configured: the answer is composed directly from the forecast, the simulation and the "
                         "recommendation engine. Add an API key in .env to get conversational wording.")
        else:
            try:
                answer = self.llm.generate(SYSTEM_PROMPT, self._messages(question, history, blocks, ents, plan, viewer,
                                                                         draft))
                llm_used = self.llm.label
                if not viewer.sees_costs:
                    answer = redact_money(answer)
            except LLMError as e:
                notes.append(f"LLM call failed, showing the composed answer instead: {e}")
                answer = to_markdown(st, preface="*Answer assembled from the system's outputs (no AI summary: the LLM "
                                                 "call failed).*")
        return ChatResult(neutralize(answer), blocks, ents, query, intents, llm_used, [neutralize(n) for n in notes],
                          whatif_out, st.follow_ups, plan.qtype, st.to_dict())

    # ---------------- facts for one pool
    def _pool_facts(self, pool, plan, cand, notes, viewer: Viewer, whatif_out, wreq) -> PoolFacts | None:
        pf, sw = pool
        pr, pfc, inv = self._tables()
        self._load_sim()
        fc = pfc[(pfc["portfolio_id"] == pf) & (pfc["software_id"] == sw)] if pfc is not None else pd.DataFrame()
        docs = {d.id.split(":")[0]: d for d in self.r.pool_documents(pf, sw)}
        if fc.empty and not docs:
            notes.append(f"No saved forecast/recommendation exists for pool {pf}/{sw} "
                         "(that portfolio may not use this software).")
        if "forecast" in docs:
            d = docs["forecast"]
            cand["forecast"] = (d.title, d.text, d.source, "document")
        ex = None
        if plan.qtype != "whatif" and not fc.empty:
            try:
                ex = self.ml.explain_pool(pf, sw)
                cand["explain"] = (f"LIVE model explanation for {pf}/{sw}", _fmt_explain(ex),
                                   "live run: forecasting model explain()", "live_model")
            except MLUnavailable as e:
                notes.append(f"Live model explanation unavailable: {e}")
            except Exception as e:
                notes.append(f"Live model explanation failed: {type(e).__name__}: {e}")
        row = pr[(pr["portfolio_id"] == pf) & (pr["software_id"] == sw)]
        rec_row = row.iloc[0].to_dict() if len(row) else None
        inv_row = inv.set_index("software_id").loc[sw].to_dict() if sw in set(inv["software_id"]) else {}
        cost = float(inv_row.get("annual_cost_per_license_inr", 0) or 0)
        trace = decision_trace(rec_row, self._cfg, cost) if rec_row is not None else None
        sim = self._sim.get(pool)
        if viewer.sees_recommendations:
            if rec_row is not None:
                cand["decision"] = (f"RECOMMENDATION EXPLANATION — the recommendation engine's decision for {pf}/{sw}, "
                                    "replayed step by step", self._fmt_decision(rec_row, trace, cost),
                                    "computed from the recommendation engine's rules and inputs (rag_chatbot/explain.py)",
                                    "brief")
            if "m3pool" in docs:
                d = docs["m3pool"]
                cand["engine_record"] = (d.title, d.text, d.source, "document")
            if "m2rec" in docs:
                d = docs["m2rec"]
                cand["options"] = (d.title, d.text, d.source, "document")
        live_opts = None
        if plan.qtype == "options" and viewer.sees_recommendations and not fc.empty:
            try:
                live_opts = self.ml.options(pf, sw)
                cand["options"] = (f"LIVE options for {pf}/{sw}", _fmt_options(live_opts),
                                   "live run: licence_ml.simulate.PoolSimulator.options", "live_model")
            except MLUnavailable as e:
                notes.append(f"Live options unavailable (using the saved simulation options instead): {e}")
            except Exception as e:
                notes.append(f"Live options failed: {type(e).__name__}: {e}")
        acc = None
        try:
            name = inv_row.get("software_name") or (fc["software"].iat[0] if len(fc) else sw)
            acc = next((r for r in self.ml.holdout_report().get("by_software", []) if r["group"] == name), None)
            if acc and plan.qtype in ("forecast", "drivers", "availability", "overview"):
                d = self.r.get("model:by_software")
                if d is not None:
                    cand["accuracy"] = (d.title, d.text, d.source, "document")
        except Exception:
            name = sw
        projects = None
        try:
            projects = self.ml.pool_projects(pf, sw).copy()
            dep = self._project_departments()
            projects["department"] = projects["project_id"].map(dep)
        except Exception:
            projects = None
        return PoolFacts(pf, sw, name, fc.sort_values("month") if len(fc) else fc, rec_row, trace, sim, ex, projects,
                         self._cfg or {}, cost, inv_row, live_opts, whatif_out,
                         whatif_out.get("engine") if whatif_out else None, acc, self.ml.model_label)

    def _fmt_decision(self, r: dict, trace, cost: float) -> str:
        lines = [f"Action: {r['action']} — {ACTION_MEANING.get(r['action'], '')}",
                 "Why this recommendation (the engine's own rules, in its order):"]
        lines += [f"{i}. {s}" for i, s in enumerate(trace.steps, 1)]
        lines.append(f"Key numbers: licences assumed for the pool {r['current_licences_assumed_for_pool']}; licences needed "
                     f"(max) {r['modelled_licences_needed_max']}; recommended permanent {r['recommended_permanent_licences']}; "
                     f"temporary to consider {r['temporary_licences_to_consider']}; max shortage probability "
                     f"{float(r['max_forecast_shortage_probability_pct']):.1f}%; months over tolerance "
                     f"{r['months_over_risk_tolerance']}; criticality {r['criticality']}.")
        lines.append(f"Money (planning prices): added permanent cost INR {float(r['estimated_annual_permanent_cost_delta_inr']):,.0f}"
                     f"/yr; temporary cover INR {float(r['estimated_temporary_cost_inr']):,.0f}; possible saving at renewal "
                     f"INR {float(r['estimated_annual_saving_at_renewal_inr']):,.0f}/yr; annual price per licence "
                     f"INR {cost:,.0f}.")
        lines.append(f"Contract: renewal {r['renewal_date']}, notice deadline {r['renewal_notice_deadline']} "
                     f"({r['days_to_notice_deadline']} days, {r['notice_status']}). Approval: {r['approval_status']}.")
        return "\n".join(lines)

    def _compose(self, plan, facts: PoolFacts | None, ents: Entities, viewer: Viewer, cite, blocks) -> Structured:
        if facts is not None and plan.qtype in POOL_TYPES:
            return PoolComposer(facts, plan, viewer, cite).compose()
        if facts is not None and plan.qtype not in POOL_TYPES and plan.qtype not in (
                "accuracy", "method", "glossary", "assumption"):
            plan.qtype = "overview"
            return PoolComposer(facts, plan, viewer, cite).compose()
        pr, pfc, inv = self._tables()
        self._load_sim()
        gloss = {}
        for d in self.r.docs:
            if d.doc_type == "glossary" and ": " in d.text:
                k, v = d.text.split(": ", 1)
                gloss[k] = v
        try:
            assumptions = self.ml.assumptions_table()
        except Exception:
            assumptions = None
        docs = [{"label": b.label, "title": b.title, "text": b.text} for b in blocks if b.kind == "document"]
        return GeneralComposer(plan, viewer, cite, ml=self.ml, rec=self.rec, ents=ents, pool_recs=pr, pool_fc=pfc,
                               inventory=inv, glossary=gloss, assumptions=assumptions, docs=docs,
                               cfg=self._cfg).compose()

    def _not_started(self, ents: Entities) -> list[str]:
        """Not-started projects of the pool, largest planned load first (only these can be delayed)."""
        if not ents.pool():
            return []
        try:
            p = self.ml.pool_projects(*ents.pool())
            return p[p["not_started"]]["project_id"].tolist()
        except Exception:
            return []

    def _messages(self, question: str, history: list[dict], blocks: list[ContextBlock], ents: Entities, plan=None,
                  viewer: Viewer | None = None, draft: str | None = None) -> list[Message]:
        msgs: list[Message] = []
        for t in (history or [])[-2 * self.s.history_turns:]:
            role = "assistant" if t["role"] == "assistant" else "user"
            content = t["content"]
            if msgs and msgs[-1].role == role:          # APIs require alternating roles
                msgs[-1] = Message(role, msgs[-1].content + "\n\n" + content)
            else:
                msgs.append(Message(role, content))
        if msgs and msgs[0].role == "assistant":
            msgs.insert(0, Message("user", "(conversation start)"))
        ctx = "\n\n".join(f"[{b.label}] {b.title}\n(source: {b.source})\n{b.text}" for b in blocks) or "(no context found)"
        scope = []
        if ents.pool():
            scope.append(f"pool {ents.pool()[0]} / {ents.pool()[1]}")
        elif ents.portfolios or ents.software:
            scope.append("entities " + ", ".join(ents.portfolios + ents.software))
        if ents.projects:
            scope.append("projects " + ", ".join(ents.projects))
        v = viewer or FULL_ACCESS
        parts = [f"CONTEXT:\n{ctx}", ""]
        if scope:
            parts.append(f"(Resolved from the conversation: {'; '.join(scope)})")
        parts.append(f"ASKER: {v.label}" + (f", {v.department}" if v.department else "")
                     + f". May see costs: {'yes' if v.sees_costs else 'NO - do not state any rupee amount'}. "
                     f"May see recommendations: {'yes' if v.sees_recommendations else 'NO - explain availability instead'}.")
        if plan is not None:
            parts.append(f"QUESTION TYPE: {plan.qtype} — {QTYPE_GOAL.get(plan.qtype, 'answer the question asked')}")
        if draft:
            parts.append("STRUCTURED DRAFT (computed from the context for THIS question; keep its numbers, order and "
                         "citations, answer the question in the first sentence, improve the wording, drop what the "
                         "question does not need):\n" + draft)
        parts.append(f"QUESTION: {question}")
        user = "\n".join(parts)
        if msgs and msgs[-1].role == "user":
            msgs[-1] = Message("user", msgs[-1].content + "\n\n" + user)
        else:
            msgs.append(Message("user", user))
        return msgs

    @staticmethod
    def suggestions(ents: Entities, blocks: list[ContextBlock], not_started: list[str] | None = None) -> list[str]:
        if ents.pool():
            pf, sw = ents.pool()
            s = [f"Why is {pf} / {sw} at risk?",
                 f"What options do we have for {pf} / {sw} and what do they cost?",
                 f"What should we do about {pf} / {sw}?",
                 f"What if we add 2 licences to {pf} {sw}?"]
            if not_started:
                s.append(f"What if we delay {not_started[0]} by 1 month in {pf} {sw}?")
            return s
        return ["Which pools are riskiest for ANSYS?", "How accurate is the ML model?",
                "Which pools are candidates for reduction at renewal?"]
