"""
Question-specific, structured answers.

Before this module the chat built ONE brief per pool and returned it for every question about that pool, so
"why is PF001 ANSYS at risk?", "what options do we have?" and "what should we do?" got the same text. Now:

  1. `classify()` decides what the question is asking (its question type) and picks out its focus: a month,
     an action the user asked about ("should we buy?"), a yes/no form, "how many", a ranking, a term.
  2. The chat engine gathers the facts that type needs from the three systems:
       ML forecast (ensemble + Monte Carlo)  forecast table, shortage chances, live driver explanation
       recommendation engine                  action, decision replay (explain.decision_trace), guardrails
       simulation                             costed options, what-if re-runs
  3. `compose_pool()` / `compose_general()` write the answer for THAT question: a direct answer first, key figures,
     the sections that answer it (drivers for "why", the options table for "options", the decision path and what
     would change it for "why this recommendation", an action plan with owners for "next steps" ...), next steps for
     the asker's profile, caveats, follow-up questions and the sources used.

Every answer has the same skeleton (`Structured`), so the web app renders it consistently, and `to_markdown()` turns
it into Markdown for the Streamlit app, the terminal chat and the LLM's draft.
"""
from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field

import pandas as pd

from .explain import ACTION_TITLE, Trace
from .integration.engine_adapter import ACTION_MEANING
from .terminology import neutralize
from .viewer import Viewer, redact_money

# Default delegation-of-authority limits (the web app's Spending limits tab holds the live values).
DEFAULT_LIMITS = {"tier1": 10_00_000, "tier2": 30_00_000}

DRIVER_MEANING = {
    "Planned workload on the pool": "the work all projects in this portfolio have planned on this software that month "
                                    "(team sizes × phase intensity, and how many projects overlap)",
    "This project's plan": "the individual projects' phase, planned users and team size in that month",
    "Pool and project usage history": "how many licences the pool and its projects actually used in recent months",
    "Software": "this software's typical demand level and licence count",
    "Timing": "calendar effects: month of year, working days, how far into the project and how far ahead",
}

AT_RISK_ACTIONS = {"CONSIDER_PERMANENT_INCREASE", "INVESTIGATE_TEMPORARY_ACCESS", "INVESTIGATE_FORECAST_RISK"}


# ============================================================================================ data structures
@dataclass
class Plan:
    qtype: str
    month: str | None = None              # YYYY-MM the user asked about
    asked_action: str | None = None       # buy | temporary | reduce | keep | delay
    yes_no: bool = False
    how_many: bool = False
    ranking: str | None = None            # risk | reduction | count | idle | renewal | overview
    topic: str | None = None              # method sub-topic / glossary query
    note: str | None = None               # e.g. why a what-if was not run
    original_qtype: str | None = None     # set when the type was changed for the asker's profile
    blocked: dict | None = None           # a what-if the profile may not run: {description, kind}


@dataclass
class Section:
    id: str
    title: str
    kind: str = "text"                    # text | bullets | steps | table
    text: str = ""
    items: list = field(default_factory=list)
    columns: list = field(default_factory=list)
    rows: list = field(default_factory=list)
    note: str = ""


@dataclass
class Structured:
    question_type: str
    title: str
    summary: str
    highlights: list = field(default_factory=list)       # [{label, value, tone}]
    sections: list = field(default_factory=list)         # [Section]
    next_steps: list = field(default_factory=list)       # [{text, owner}]
    caveats: list = field(default_factory=list)
    follow_ups: list = field(default_factory=list)
    sources: list = field(default_factory=list)          # [{label, title}]
    viewer: dict = field(default_factory=dict)
    pool: list | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        return _neutral(d)


def _neutral(x):
    if isinstance(x, str):
        return neutralize(x)
    if isinstance(x, list):
        return [_neutral(v) for v in x]
    if isinstance(x, dict):
        return {k: _neutral(v) for k, v in x.items()}
    return x


@dataclass
class PoolFacts:
    pf: str
    sw: str
    name: str
    forecast: pd.DataFrame                      # pool_forecast rows, sorted by month
    rec: dict | None = None                     # recommendation engine row
    trace: Trace | None = None                  # replay of the engine's decision
    sim: dict | None = None                     # simulation recommendation incl. costed options
    explain: dict | None = None                 # live model explanation (per month drivers)
    projects: pd.DataFrame | None = None        # projects feeding the pool (+ department)
    cfg: dict = field(default_factory=dict)
    annual_cost: float = 0.0
    inventory: dict | None = None
    live_options: pd.DataFrame | None = None
    whatif: dict | None = None
    whatif_engine: pd.DataFrame | None = None
    accuracy: dict | None = None                # hold-out accuracy for this software
    model_label: str = ""


# ============================================================================================ formatting helpers
_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def mlabel(m: str) -> str:
    try:
        y, mo = str(m)[:7].split("-")
        return f"{_MON[int(mo) - 1]} {y}"
    except (ValueError, IndexError):
        return str(m)


def mlist(ms) -> str:
    ms = [mlabel(m) for m in ms]
    if not ms:
        return "none"
    return ms[0] if len(ms) == 1 else ", ".join(ms[:-1]) + " and " + ms[-1]


def inr(v) -> str:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "n/a"
    if abs(v) >= 1e7:
        return f"₹{v / 1e7:,.2f} crore"
    return f"₹{v / 1e5:,.2f} lakh" if abs(v) >= 1e5 else f"₹{v:,.0f}"


def pct(p, nd=1) -> str:
    try:
        return f"{100 * float(p):.{nd}f}%"
    except (TypeError, ValueError):
        return "n/a"


def num(v, nd=0) -> str:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "n/a"
    if math.isnan(v):
        return "n/a"
    return f"{v:,.{nd}f}"


def plural(n, word) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _plain(s: str) -> str:
    return re.sub(r"\*\*|`", "", s or "").strip()


# ============================================================================================ classification
_RX = {
    "next_steps": re.compile(r"\bnext steps?\b|\bwhat next\b|\bwhat (?:do|should) (?:we|i) do next\b|\bhow (?:do|should|can) "
                             r"(?:we|i) (?:proceed|go about|implement|act|start)\b|\baction plan\b|\bhow to (?:proceed|"
                             r"implement|act)\b|\bwho (?:needs to|should) (?:approve|act)\b|\bguide me\b|\bsteps? to take\b",
                             re.I),
    "options": re.compile(r"\boptions?\b|\balternatives?\b|\bcheap(?:est|er)?\b|\bcost of\b|\bhow much (?:would|will|does|do)"
                          r"\b|\bwhat (?:would|will|does) (?:it|that|this) cost\b|\bcompare\b|\bcomparison\b|\bprice of\b|"
                          r"\btrade-?offs?\b|\bpros and cons\b", re.I),
    "rec_why": re.compile(r"\bwhy\b.*\b(?:recommend\w*|suggest\w*|decision|decide\w*|action|engine|buy\w*|purchas\w*|reduc\w*|"
                          r"temporar\w*|keep\w*|retain\w*)\b|\bjustif\w*\b|\breasoning\b|\brationale\b|"
                          r"\bexplain\b.*\b(?:recommendation|decision|action)\b|\bhow did\b.*\bdecide\b|"
                          r"\bwhat would change\b", re.I),
    "recommendation": re.compile(r"\brecommend\w*\b|\bshould (?:we|i)\b|\bwhat (?:to|should we|should i|do we|do i|can we) do\b|"
                                 r"\bwhat do you suggest\b|\bactions?\b|\badvi[cs]e\b|\bsuggest\w*\b|\bdecision\b|\bbuy\b|"
                                 r"\bpurchas\w*\b|\breduc\w*\b|\btemporar\w*\b|\bkeep\b|\bretain\b|\bdo about\b", re.I),
    "renewal": re.compile(r"\brenew\w*\b|\bdeadline\b|\bnotice\b|\bcontract\b|\bexpir\w*\b", re.I),
    "drivers": re.compile(r"\bwhy\b|\bdrivers?\b|\bdriv\w+\b|\bcauses?\b|\bcaus\w+\b|\breasons?\b|\bexplain\b|\bhow come\b|"
                          r"\bwhat makes\b", re.I),
    "availability": re.compile(r"\bat risk\b|\brisk\w*\b|\bshort\w*\b|\benough\b|\brun out\b|\bavailab\w*\b|\bcapacity\b|"
                               r"\bwill (?:i|we) get\b|\bcan (?:i|we) get\b", re.I),
    "forecast": re.compile(r"\bforecast\w*\b|\bpredict\w*\b|\bpeak\b|\bdemand\b|\bneed\w*\b|\bhow many\b|\bp50\b|\bp90\b|"
                           r"\butili[sz]\w*\b|\bnext month\b|\bmonths?\b|\boutlook\b|\btrend\b", re.I),
    "accuracy": re.compile(r"\baccura\w*\b|\breliab\w*\b|\btrust\w*\b|\bmae\b|\berror\b|\bwape\b|\bhow good\b|\boverfit\w*\b|"
                           r"\bwhich model\b|\bwhat model\b|\bbest model\b|\bleaderboard\b|\bvalidat\w*\b|\bhold-?out\b|"
                           r"\bselected model\b|\bmodel (?:comparison|selection)\b|\bensemble\b", re.I),
    "method": re.compile(r"\bhow (?:does|do|is|are)\b.*\b(?:work|decide|calculat\w*|comput\w*|made|trained|built|forecast\w*|"
                         r"simulat\w*|chosen|select\w*|explain\w*|retriev\w*)\b|\bmethod\w*\b|\balgorithm\b|\bmonte carlo\b|"
                         r"\bdecision rules?\b|\bthe rules\b|\bhow it works\b|\bpipeline\b|\barchitecture\b", re.I),
    "glossary": re.compile(r"\bwhat (?:is|are|does)\b.*\b(?:mean|means|meaning)\b|\bdefin\w*\b|\bmeaning of\b|\bstand for\b|"
                           r"^\s*what (?:is|are) (?:a |an |the )?(?:p50|p90|p10|shortage (?:chance|probability)|licences? needed|"
                           r"expected shortage|utili[sz]ation|idle cost|pool|tolerance|possible saving|confirmed saving|"
                           r"forecast rows?)\b", re.I),
    "assumption": re.compile(r"\bassum\w*\b|\btolerance\b|\bbuffer\b|\bthreshold\w*\b|\bmultiplier\b|\bsynthetic\b|"
                             r"\bprice assumption", re.I),
    "ranking": re.compile(r"\b(?:top|most|riskiest|highest|lowest|largest|biggest|worst|best|rank\w*|which pools|which portfolios|"
                          r"list|how many|count|overview|summary|summari[sz]e|across|all pools|portfolio-wide|organi[sz]ation|"
                          r"company)\b", re.I),
}
_ASK_ACTION = [("temporary", re.compile(r"\btemporar\w*|\bshort[- ]term\b|\btemp\b", re.I)),
               ("reduce", re.compile(r"\breduc\w*|\bcut\b|\bfewer\b|\bdrop\b|\bremove\b|\bgive back\b", re.I)),
               ("buy", re.compile(r"\bbuy\w*|\bpurchas\w*|\bmore licen|\badd(?:ing)? licen|\bincrease\b", re.I)),
               ("keep", re.compile(r"\bkeep\b|\bretain\b|\bdo nothing\b|\bstay\b", re.I)),
               ("delay", re.compile(r"\bdelay\w*|\bpostpone\w*|\bshift\w*|\bmove\b", re.I))]
_YES_NO = re.compile(r"^\s*(?:is|are|will|would|should|do|does|did|can|could|shall|has|have)\b", re.I)
_BARE_WHY = re.compile(r"^\s*(?:and\s+|but\s+|so\s+|ok\s+)?(?:why|how come|explain|reason|because)(?:\s+(?:is|was))?"
                       r"(?:\s+(?:that|this|so|it))?(?:\s+(?:please|again))?\s*[?.!]*\s*$", re.I)
_METHOD_SUBJECT = re.compile(r"engine|model|simulat|monte carlo|algorithm|rules?\b|pipeline|assistant|retriev|explanation",
                             re.I)
_GLOSSARY_TERMS = {
    "P50 / P90 peak": r"\bp50\b|\bp90\b|\bp10\b|most likely|high case|percentile",
    "Shortage probability": r"shortage (?:chance|probability)|chance of (?:a )?shortage",
    "Licences needed": r"licen[cs]es? needed|safety buffer",
    "Expected shortage": r"expected shortage|licence-months",
    "Utilisation": r"utili[sz]ation",
    "Idle cost": r"idle",
    "Forecast rows": r"forecast rows?|no forecast|coverage",
    "Pool": r"\bpool\b|portfolio",
    "Possible vs Confirmed savings": r"possible|confirmed|saving",
}


def classify(question: str, pool: tuple | None, has_portfolio: bool, has_software: bool, whatif_parsed: bool,
             months: list[str] | None = None, prior_qtype: str | None = None) -> Plan:
    q = question or ""
    hit = {k: bool(rx.search(q)) for k, rx in _RX.items()}
    asked = next((a for a, rx in _ASK_ACTION if rx.search(q)), None)
    plan = Plan("unknown", month=(months or [None])[0], asked_action=asked, yes_no=bool(_YES_NO.search(q)),
                how_many=bool(re.search(r"\bhow many\b", q, re.I)), topic=q)
    if whatif_parsed:
        plan.qtype = "whatif"
        return plan
    # questions about definitions, the model or the method are answered as such, even with a pool in focus
    if hit["glossary"] and not (pool and (hit["recommendation"] or hit["options"])):
        plan.qtype, plan.topic = "glossary", q
        return plan
    if hit["accuracy"] and not hit["recommendation"]:
        plan.qtype = "accuracy"
        return plan
    if hit["method"] and (not pool or (_METHOD_SUBJECT.search(q) and not (hit["drivers"] or hit["rec_why"]))):
        plan.qtype, plan.topic = "method", q
        return plan
    if hit["assumption"] and not pool:
        plan.qtype = "assumption"
        return plan
    if pool:
        if _BARE_WHY.search(q) and prior_qtype:
            plan.qtype = "rec_why" if prior_qtype in ("recommendation", "options", "next_steps", "rec_why") else "drivers"
        elif hit["next_steps"]:
            plan.qtype = "next_steps"
        elif hit["options"]:
            plan.qtype = "options"
        elif hit["rec_why"] and not (hit["availability"] and not hit["recommendation"]):
            plan.qtype = "rec_why"
        elif hit["recommendation"]:
            plan.qtype = "recommendation"
        elif hit["renewal"]:
            plan.qtype = "renewal"
        elif hit["drivers"]:
            plan.qtype = "drivers"
        elif hit["availability"] or hit["forecast"]:
            plan.qtype = "forecast"
        else:
            plan.qtype = "overview"
        return plan
    if has_portfolio and not has_software:
        plan.qtype = "portfolio"
        return plan
    if hit["renewal"] and not hit["ranking"]:
        plan.qtype = "renewal_all"
        return plan
    if hit["ranking"] or (has_software and (hit["availability"] or hit["forecast"] or hit["recommendation"])):
        plan.qtype = "ranking"
        ql = q.lower()
        plan.ranking = ("reduction" if re.search(r"reduc|saving|save|spare|over-?licen|cut", ql) else
                        "idle" if re.search(r"idle", ql) else
                        "count" if re.search(r"how many|count|number of", ql) else
                        "renewal" if re.search(r"renew|deadline|notice|contract", ql) else
                        "overview" if re.search(r"overview|summary|summari|across|company|organi", ql) else "risk")
        return plan
    if has_software:
        plan.qtype = "software"
        return plan
    if hit["assumption"]:
        plan.qtype = "assumption"
        return plan
    return plan


def adapt_to_viewer(plan: Plan, viewer: Viewer) -> Plan:
    """Profiles without the recommendation scope get an availability answer instead of the decision detail."""
    if not viewer.sees_recommendations and plan.qtype in ("recommendation", "rec_why", "options", "next_steps"):
        plan.original_qtype, plan.qtype = plan.qtype, "availability"
    if not viewer.sees_recommendations and plan.qtype == "ranking" and plan.ranking in ("reduction", "count"):
        plan.original_qtype, plan.ranking = plan.qtype, "risk"
    return plan


# ============================================================================================ the pool composer
class PoolComposer:
    """Builds the answer for one pool question. `cite(key)` returns the [S#] label of a context block."""

    def __init__(self, f: PoolFacts, plan: Plan, viewer: Viewer, cite, limits: dict | None = None):
        self.f, self.plan, self.v, self.cite = f, plan, viewer, cite
        self.limits = limits or DEFAULT_LIMITS
        fc = f.forecast.sort_values("month").reset_index(drop=True)
        self.fc = fc
        self.owned = int(fc["licences_owned"].iat[0]) if len(fc) else 0
        self.tol = float(f.cfg.get("target_shortage_risk_pct", 5.0))
        self.risk = fc[fc["at_risk"]]
        self.risk_months = self.risk["month"].astype(str).tolist()
        with_fc = fc[fc["forecasts"] > 0]
        self.with_fc = with_fc if len(with_fc) else fc
        self.peak = fc.loc[fc["peak_p90"].idxmax()] if len(fc) else None
        self.worst = fc.loc[fc["shortage_probability"].idxmax()] if len(fc) else None
        self.no_fc = fc[fc["forecasts"] == 0]["month"].astype(str).tolist()
        self.r = f.rec or {}
        self.action = self.r.get("action")
        self.pool = f"{f.pf} · {f.name}"
        self.focus_row = None
        if plan.month and len(fc) and plan.month in set(fc["month"].astype(str)):
            self.focus_row = fc[fc["month"].astype(str) == plan.month].iloc[0]

    # ------------------------------------------------------------------ small helpers
    def m(self, v) -> str:
        return inr(v) if self.v.sees_costs else "hidden for your profile"

    def c(self, *keys) -> str:
        labels = [self.cite(k) for k in keys]
        labels = [x for x in labels if x]
        return (" " + "".join(f"[{x}]" for x in labels)) if labels else ""

    @property
    def add(self) -> int:
        return max(0, int(self.r.get("modelled_licences_needed_max", 0)) - int(self.r.get("current_licences_assumed_for_pool", 0)))

    @property
    def current(self) -> int:
        return int(self.r.get("current_licences_assumed_for_pool", self.owned) or self.owned)

    def action_cost(self) -> tuple[float, str]:
        a = self.action
        if a == "CONSIDER_PERMANENT_INCREASE":
            return float(self.r.get("estimated_annual_permanent_cost_delta_inr") or 0), "added cost a year"
        if a == "INVESTIGATE_TEMPORARY_ACCESS":
            return float(self.r.get("estimated_temporary_cost_inr") or 0), "temporary cover"
        if a == "CONSIDER_REDUCTION_AT_RENEWAL":
            return float(self.r.get("estimated_annual_saving_at_renewal_inr") or 0), "possible saving a year"
        return 0.0, ""

    def action_phrase(self) -> str:
        a, r = self.action, self.r
        if a == "CONSIDER_PERMANENT_INCREASE":
            return f"buy {plural(self.add, 'more permanent licence')} ({self.current} → {self.current + self.add})"
        if a == "INVESTIGATE_TEMPORARY_ACCESS":
            n = int(r.get("temporary_licences_to_consider") or self.add)
            return f"arrange {plural(n, 'temporary licence')} for {mlist(self.risk_months) if self.risk_months else 'the peak months'}"
        if a == "INVESTIGATE_FORECAST_RISK":
            return "review the forecast with the project heads before spending anything"
        if a == "CONSIDER_REDUCTION_AT_RENEWAL":
            return (f"reduce from {self.current} to {int(r.get('recommended_permanent_licences', self.current))} licences "
                    f"at the {r.get('renewal_date')} renewal")
        if a == "RETAIN_AND_MONITOR_GLOBAL_DEMAND":
            return f"keep the current {self.current} licences (company-wide demand argues against reducing)"
        if a == "RETAIN_AND_REVIEW_PARTIAL_FORECAST":
            return f"keep the current {self.current} licences until the months without a forecast are reviewed"
        if a == "RETAIN_AND_REVIEW_NO_FORECAST":
            return f"keep the current {self.current} licences (no forecast exists for this pool)"
        if a == "RETAIN_AND_MONITOR":
            return f"keep the current {self.current} licences and monitor"
        return "no recommendation is available"

    def tier(self) -> tuple[int, str]:
        v, _ = self.action_cost()
        v = abs(v)
        if v <= self.limits["tier1"]:
            return 1, "the licence administrator approves"
        if v <= self.limits["tier2"]:
            return 2, "the owning department head approves, then the licence administrator"
        return 3, "the department head, then the licence administrator, then a second administrator gives the final sign-off"

    def steps(self) -> list[str]:
        """The engine's decision steps; the rupee comparison is summarised for profiles without costs."""
        out = []
        for st in (self.f.trace.steps if self.f.trace else []):
            if not self.v.sees_costs and _plain(st).startswith("Cost comparison"):
                st = ("**Cost comparison:** temporary cover for the at-risk months was compared with buying permanently "
                      "(amounts are visible to department heads and administrators).")
            out.append(st)
        return out

    def rule_reason(self) -> str:
        """The deciding rule without its '→ buy N ...' tail (the action is stated separately)."""
        r = re.sub(r"\s*→.*$", "", self.deciding_rule()).strip()
        return (r.rstrip(".") + ".") if r else ""

    def deciding_rule(self) -> str:
        t = self.f.trace
        if t is None or not t.steps:
            return ""
        last = _plain(t.steps[-1])
        return re.sub(r"^Decision rule:\s*", "", last)

    def month_drivers(self, month: str | None) -> tuple[list[tuple[str, float]], dict | None]:
        ex = self.f.explain
        if not ex or not ex.get("months"):
            return [], None
        ms = ex["months"]
        row = next((x for x in ms if x["month"] == month), None) if month else None
        if row is None:
            keys = list(ms[0]["drivers"])
            avg = {k: sum(x["drivers"].get(k, 0) for x in ms) / len(ms) for k in keys}
            return sorted(avg.items(), key=lambda kv: -abs(kv[1])), None
        return sorted(row["drivers"].items(), key=lambda kv: -abs(kv[1])), row

    def projects_in_month(self, month: str) -> list[str]:
        if not len(self.fc):
            return []
        row = self.fc[self.fc["month"].astype(str) == month]
        if row.empty:
            return []
        out = []
        for p in str(row["main_projects"].iat[0] or "").split(";"):
            p = p.strip()
            if p:
                out.append(p)
        return out

    def project_line(self, pid: str, phase: str | None = None) -> str:
        p = self.f.projects
        info = None
        if p is not None and len(p):
            hit = p[p["project_id"] == pid]
            if len(hit):
                info = hit.iloc[0]
        bits = [f"**{pid}**"]
        if phase:
            bits.append(f"— {phase} phase")
        if info is not None:
            extra = [f"team of {int(info['team_size'])}", f"{info['priority']} priority"]
            if info.get("department"):
                dep = str(info["department"])
                mine = dep in self.v.ml_departments
                extra.append(f"{dep}{' — your department' if mine else ''}")
            extra.append("not started yet (can be delayed)" if bool(info["not_started"]) else
                         f"running {info['start']} → {info['deadline']}")
            bits.append("(" + ", ".join(extra) + ")")
        return " ".join(bits)

    def not_started(self) -> list[str]:
        p = self.f.projects
        if p is None or not len(p):
            return []
        return p[p["not_started"].astype(bool)]["project_id"].tolist()

    def forecast_table(self, only: list[str] | None = None, compact=False) -> Section:
        cols = ["Month", "Most likely (P50)", "High case (P90)", "Owned", "Needed (P95 + buffer)", "Shortage chance", "Status"]
        rows = []
        for r in self.fc.itertuples(index=False):
            if only and str(r.month) not in only:
                continue
            status = "⚠ at risk" if r.at_risk else ("no forecast" if int(r.forecasts) == 0 else "ok")
            rows.append([mlabel(r.month), num(r.peak_p50), num(r.peak_p90), num(r.licences_owned), num(r.licences_needed),
                         pct(r.shortage_probability), status])
        if compact:
            cols = [c for i, c in enumerate(cols) if i != 4]
            rows = [[c for i, c in enumerate(rw) if i != 4] for rw in rows]
        return Section("forecast", "Forecast by month", "table", columns=cols, rows=rows,
                       note=f"P50 = most likely peak of simultaneous users; P90 = high case (1 in 10 simulated futures is "
                            f"higher). Shortage chance above {self.tol:g}% marks a month at risk.{self.c('forecast')}")

    def highlights_core(self) -> list[dict]:
        h = []
        if self.peak is not None:
            h.append(dict(label="Busiest month", value=f"{mlabel(self.peak['month'])} · P90 {num(self.peak['peak_p90'])} vs "
                                                       f"{self.owned} owned", tone="warn" if self.risk_months else "info"))
        if self.worst is not None:
            h.append(dict(label="Highest shortage chance", value=f"{pct(self.worst['shortage_probability'])} "
                                                                 f"(limit {self.tol:g}%)",
                          tone="crit" if float(self.worst["shortage_probability"]) * 100 > self.tol else "ok"))
        h.append(dict(label="Months at risk", value=f"{len(self.risk_months)} of {len(self.fc)}"
                      + (f" ({mlist(self.risk_months)})" if self.risk_months else ""),
                      tone="warn" if self.risk_months else "ok"))
        return h

    def rec_highlights(self) -> list[dict]:
        h = []
        if self.action:
            h.append(dict(label="Recommended action", value=ACTION_TITLE.get(self.action, self.action), tone="info"))
            v, lab = self.action_cost()
            if v and lab:
                h.append(dict(label=lab[0].upper() + lab[1:], value=self.m(v), tone="info"))
            h.append(dict(label="Approval", value=str(self.r.get("approval_status", "")).replace("_", " ").lower()
                          or "needed", tone="info"))
            if self.r.get("renewal_notice_deadline"):
                d = self.r.get("days_to_notice_deadline")
                h.append(dict(label="Renewal notice deadline", value=f"{self.r['renewal_notice_deadline']}"
                              + (f" ({int(d)} days)" if d is not None and str(d) != "nan" else ""),
                              tone="warn" if self.r.get("notice_status") == "WITHIN_60_DAYS" else "info"))
        return h

    def caveats(self, extra: list[str] | None = None) -> list[str]:
        out = list(extra or [])
        if self.no_fc:
            out.append(f"{plural(len(self.no_fc), 'month')} ({mlist(self.no_fc)}) have no project forecast: that is "
                       "missing coverage, not zero demand.")
        trend = float(self.r.get("global_demand_trend_pct_software", 0) or 0)
        if trend >= 20:
            out.append(f"Company-wide demand for {self.f.name} is rising ({trend:+.1f}% over the last 90 days).")
        if self.r.get("notice_status") == "PAST_DEADLINE":
            out.append("The renewal notice deadline has passed: check contractual options before any change.")
        acc = self.f.accuracy
        if acc:
            out.append(f"For {self.f.name} the model is within ±2 licences {pct(acc.get('within_2'), 0)} of the time "
                       f"(hold-out MAE {num(acc.get('mae'), 2)}); its P90 covered the actual peak "
                       f"{pct(acc.get('p90_coverage'), 0)} of the time.{self.c('accuracy')}")
        if self.v.sees_costs:
            out.append("Prices are planning assumptions, so costs and savings are *possible*, not confirmed; pool figures "
                       "are not additive across portfolios; every action needs human approval.")
        else:
            out.append("Forecasts are estimates: plan critical work on the P90 high case. Every capacity change needs "
                       "human approval.")
        return out

    # ------------------------------------------------------------------ next steps per profile
    def next_steps(self, focus: str = "general") -> list[dict]:
        a, v, r = self.action, self.v, self.r
        months = mlist(self.risk_months) if self.risk_months else "the peak months"
        deadline = r.get("renewal_notice_deadline")
        ns = self.not_started()
        main = []
        for mth in (self.risk_months or ([str(self.peak["month"])] if self.peak is not None else [])):
            for p in self.projects_in_month(mth):
                pid = p.split(" (")[0]
                if pid not in main:
                    main.append(pid)
        who = ", ".join(main[:3])
        s: list[dict] = []
        at_risk = bool(self.risk_months)
        tier, route = self.tier()

        if v.role == "engineer":
            if at_risk:
                s.append(dict(text=f"If you need {self.f.name} in {months}, raise an access request now (Access Requests → "
                                   "New request) and mark it *blocking* if your work stops without it.", owner="You"))
                s.append(dict(text=f"Plan heavy runs outside {months} where you can, and close the tool when idle so a "
                                   "licence frees up.", owner="You"))
                s.append(dict(text="Your department head decides access requests; the licence administrator fulfils them by "
                                   "the cheapest route that works.", owner="Department head"))
            else:
                s.append(dict(text=f"Capacity looks sufficient for {self.f.name}; request access as usual if you need it.",
                              owner="You"))
                s.append(dict(text="Release licences you no longer use so the pool stays healthy.", owner="You"))
            return s

        if v.role == "projectLead":
            if at_risk or a in AT_RISK_ACTIONS:
                if ns:
                    s.append(dict(text=f"Check whether a not-started project can move out of the peak — ask *What if we delay "
                                       f"{ns[0]} by 1 month in {self.f.pf} {self.f.name}?*", owner="Project head"))
                s.append(dict(text=f"Confirm the planned team size and phase dates for {months}"
                                   + (f" (the peak comes from {who})" if who else "") + ".", owner="Project head"))
                s.append(dict(text="If dates or team size change, propose a project change (Projects page) so the "
                                   "forecast uses it; the department head and the administrator confirm it.",
                              owner="Project head"))
                s.append(dict(text=f"Ask your team to raise access requests early for {months}.", owner="Project head"))
            elif a == "CONSIDER_REDUCTION_AT_RENEWAL":
                s.append(dict(text=f"Confirm your projects will not need the licences being reduced after "
                                   f"{r.get('renewal_date')}; tell the licence administrator before {deadline}.",
                              owner="Project head"))
            else:
                s.append(dict(text="No change needed for your projects; keep the project plan up to date so the forecast "
                                   "stays right.", owner="Project head"))
            return s

        if v.role == "deptHead":
            if a in ("CONSIDER_PERMANENT_INCREASE", "INVESTIGATE_TEMPORARY_ACCESS"):
                s.append(dict(text=f"Confirm your department's share of the {months} peak with your project heads"
                                   + (f" (projects driving it: {who})" if who else "") + ".", owner="Department head"))
                s.append(dict(text=f"Approve or object in Licence & Project → Approvals: at {self.m(self.action_cost()[0])} "
                                   f"this is Tier {tier}, so {route}.", owner="Department head"))
                s.append(dict(text=f"Prioritise blocking access requests for {self.f.name} in {months}, and ask holders of "
                                   "idle seats to release them first.", owner="Department head"))
            elif a == "INVESTIGATE_FORECAST_RISK":
                s.append(dict(text=f"Review the {months} plan with the project heads before any spend.", owner="Department head"))
            elif a == "CONSIDER_REDUCTION_AT_RENEWAL":
                s.append(dict(text=f"Check which of your department's holders can release licences, and confirm before "
                                   f"{deadline}.", owner="Department head"))
                s.append(dict(text="Endorse the reduction in Licence & Project → Approvals.", owner="Department head"))
            else:
                s.append(dict(text="No change needed; keep deciding access requests against the forecast.",
                              owner="Department head"))
            if ns and a in AT_RISK_ACTIONS:
                s.append(dict(text=f"Ask the project head whether {ns[0]} (not started) can move by a month, then compare "
                                   "with *What if we delay …* before spending.", owner="Department head"))
            return s

        # administrator (and full-access tools)
        if a == "CONSIDER_PERMANENT_INCREASE":
            s += [dict(text=f"Raise the recommendation for approval: {self.action_phrase()}, "
                            f"{self.m(self.action_cost()[0])} a year → Tier {tier}: {route}.", owner="Licence administrator"),
                  dict(text=f"Get a vendor quote for {plural(self.add, 'licence')} before the notice deadline ({deadline}).",
                       owner="Licence administrator"),
                  dict(text=f"Compare with temporary cover ({self.m(self.r.get('estimated_temporary_cost_inr'))}) — ask "
                            f"*What if we add {self.add} temporary licences to {self.f.pf} {self.f.name}?*",
                       owner="Licence administrator")]
        elif a == "INVESTIGATE_TEMPORARY_ACCESS":
            n = int(r.get("temporary_licences_to_consider") or self.add)
            s += [dict(text=f"Ask the vendor for {plural(n, 'temporary licence')} covering {months}; the planning price is "
                            f"{self.m(r.get('estimated_temporary_cost_inr'))}.", owner="Licence administrator"),
                  dict(text=f"Submit it for approval (Tier {tier}: {route}).", owner="Licence administrator"),
                  dict(text="If temporary access is not offered, re-run the what-if with a permanent purchase.",
                       owner="Licence administrator")]
        elif a == "INVESTIGATE_FORECAST_RISK":
            s += [dict(text=f"Review the forecast for {months} with the project heads"
                            + (f" ({who})" if who else "") + " before committing money.", owner="Licence administrator"),
                  dict(text="Re-forecast after the next month of usage data.", owner="Licence administrator")]
        elif a == "CONSIDER_REDUCTION_AT_RENEWAL":
            n_red = max(0, self.current - int(r.get("recommended_permanent_licences", self.current)))
            s += [dict(text=f"Confirm with the department heads that {plural(n_red, 'licence')} can go, then negotiate the "
                            f"reduction before {deadline}.", owner="Licence administrator"),
                  dict(text="Check contract minimums and notice terms; release idle named seats first.",
                       owner="Licence administrator"),
                  dict(text=f"Submit it for approval (Tier {tier}: {route}); track the saving in Review & Savings once "
                            "invoiced.", owner="Licence administrator")]
        else:
            s.append(dict(text="Keep the current licence count and re-forecast monthly.", owner="Licence administrator"))
            if a == "RETAIN_AND_REVIEW_PARTIAL_FORECAST":
                s.append(dict(text=f"Ask the project heads why {mlist(self.no_fc)} have no project forecast (plans missing "
                                   "or projects ending).", owner="Licence administrator"))
        if self.f.sim and str(self.f.sim.get("action", "")).startswith("Delay") and a in AT_RISK_ACTIONS:
            s.append(dict(text=f"The simulation's cheapest option is to {self.f.sim['action'].lower()}: check with the "
                               "project head whether the schedule can move.", owner="Project head"))
        if who and a in ("CONSIDER_PERMANENT_INCREASE", "INVESTIGATE_TEMPORARY_ACCESS"):
            s.append(dict(text=f"Confirm the peak with the projects driving it ({who}).", owner="Project heads"))
        return s

    # ------------------------------------------------------------------ question types
    def compose(self) -> Structured:
        if not len(self.fc):
            st = self._no_forecast()
        elif self.plan.blocked:
            st = self._q_blocked()
        else:
            fn = getattr(self, f"_q_{self.plan.qtype}", None) or self._q_overview
            st = fn()
        st.pool = [self.f.pf, self.f.sw]
        st.viewer = self.v.to_dict()
        if self.plan.note and not self.plan.blocked:
            st.caveats.insert(0, self.plan.note)
        return finish(st, self.v)

    def _title(self, what: str) -> str:
        return f"{self.f.pf} · {self.f.name} ({self.f.sw}) — {what}"

    # ---- why is it at risk / what drives the forecast
    def _q_drivers(self) -> Structured:
        f = self.f
        focus = self.plan.month if self.focus_row is not None else (
            str(self.worst["month"]) if self.risk_months else (str(self.peak["month"]) if self.peak is not None else None))
        drivers, mrow = self.month_drivers(focus)
        at_risk = bool(self.risk_months)
        fr = self.fc[self.fc["month"].astype(str) == focus].iloc[0] if focus else None
        top = drivers[:3]
        top_txt = ", ".join(f"{k.lower()} ({v:+.1f})" for k, v in top) if top else "no single dominant factor"
        projs = self.projects_in_month(focus) if focus else []
        if at_risk:
            summary = (f"**{self.pool} is at risk in {mlist(self.risk_months)}.** In {mlabel(focus)} the high case (P90) "
                       f"reaches **{num(fr['peak_p90'])}** licences against **{self.owned}** owned — a "
                       f"**{pct(fr['shortage_probability'])}** chance of a shortage versus the {self.tol:g}% tolerance."
                       f"{self.c('forecast')} The forecast is pushed up mainly by {top_txt} licences above a typical pool"
                       f"{self.c('explain')}" + (f", with {', '.join(p.split(' (')[0] for p in projs[:3])} active that month."
                                                  if projs else "."))
            title = self._title(f"why it is at risk in {mlabel(focus)}")
        else:
            worst_txt = (f"The highest shortage chance is **{pct(self.worst['shortage_probability'])}** "
                         f"({mlabel(self.worst['month'])}), below the {self.tol:g}% tolerance"
                         if float(self.worst["shortage_probability"]) > 0 else "No month shows any shortage chance")
            summary = (f"**{self.pool} is not at risk.** {worst_txt}; the busiest month, {mlabel(self.peak['month'])}, peaks at "
                       f"{num(self.peak['peak_p90'])} (P90) against {self.owned} owned.{self.c('forecast')} "
                       f"Demand in {mlabel(focus)} is shaped mostly by {top_txt}{self.c('explain')}.")
            title = self._title("what drives the forecast")
        secs = []
        if at_risk:
            secs.append(self.forecast_table(only=self.risk_months))
            secs[-1].title, secs[-1].id = "Where the risk is", "risk_months"
        if drivers:
            items = []
            base = f" (typical pool {num(mrow['typical_baseline'], 1)}, this month {num(mrow['peak_expected_mean'], 1)})" if mrow else ""
            for k, val in top:
                items.append(f"**{k}** {val:+.1f} licences — {DRIVER_MEANING.get(k, k.lower())}.")
            secs.append(Section("drivers", (f"What pushes demand up in {mlabel(focus)}" if at_risk else
                                            f"What shapes demand in {mlabel(focus)}"), "bullets", items=items,
                                note=f"Model explanation (occlusion by feature group on the {f.model_label}): licences "
                                     f"added or removed versus a typical prediction{base}.{self.c('explain')}"))
        if projs:
            secs.append(Section("projects", f"Projects active in {mlabel(focus)}", "bullets",
                                items=[self.project_line(p.split(" (")[0], p.split(" (")[1].rstrip(")") if " (" in p else None)
                                       for p in projs[:6]],
                                note="Only not-started projects can be delayed or cancelled in a what-if."))
        secs.append(Section("method", "How the risk is measured", "bullets", items=[
            "The ensemble forecasts each project's peak licence use 1–6 months ahead; the Monte Carlo simulation combines "
            "the projects into 4,000 possible futures for the pool.",
            f"Shortage chance = share of those futures where peak demand exceeds the {self.owned} licences owned; above "
            f"{self.tol:g}% the month is *at risk*.",
            "Licences needed = 95th percentile of simulated demand, rounded up, plus 1 safety licence."]))
        if self.v.sees_recommendations and self.action:
            secs.append(Section("consequence", "What the recommendation engine does with this", "text",
                                text=f"**{ACTION_TITLE.get(self.action, self.action)}** — {self.action_phrase()}. "
                                     f"{_cap(self.rule_reason())}{self.c('decision')}"))
        elif not self.v.sees_recommendations:
            secs.append(self._for_you_section())
        st = Structured("drivers", title, summary, self.highlights_core(), secs, self.next_steps(),
                        self.caveats(), self.follow_ups("drivers"))
        return st

    # ---- forecast / availability (yes-no, month-specific, how many)
    def _q_forecast(self) -> Structured:
        fc = self.with_fc
        fr = self.focus_row
        lo, hi = num(fc["peak_p50"].min()), num(fc["peak_p50"].max())
        need = int(self.fc["licences_needed"].max()) if len(self.fc) else 0
        if fr is not None:
            short = bool(fr["at_risk"])
            lead = ("Yes — there is a real risk of running short." if short else "No — capacity should be enough.") \
                if self.plan.yes_no or re.search(r"short|enough|run out", self.plan.topic or "", re.I) else ""
            summary = (f"{lead + ' ' if lead else ''}In **{mlabel(fr['month'])}**, {self.pool} is forecast at "
                       f"**{num(fr['peak_p50'])}** licences most likely (P50) and **{num(fr['peak_p90'])}** in the high case "
                       f"(P90), against **{self.owned}** owned — a {pct(fr['shortage_probability'])} chance of a shortage"
                       f"{' (at risk)' if short else ''}.{self.c('forecast')}")
            if self.plan.how_many:
                summary = (f"**{int(fr['licences_needed'])} licences** are needed in {mlabel(fr['month'])} to keep the "
                           f"shortage chance within {self.tol:g}% (P95 of simulated demand + 1 safety licence); "
                           f"{self.owned} are owned. " + summary)
            title = self._title(f"forecast for {mlabel(fr['month'])}")
        else:
            if self.plan.how_many:
                summary = (f"**Up to {need} licences** are needed in the busiest month ({mlabel(self.peak['month'])}) to "
                           f"stay within the {self.tol:g}% shortage tolerance; {self.owned} are owned"
                           f"{' — a gap of ' + str(need - self.owned) if need > self.owned else ''}.{self.c('forecast')} ")
            else:
                summary = ""
            yes = bool(self.risk_months)
            lead = (("Yes — " if yes else "No — ") if self.plan.yes_no else "")
            summary += (f"{lead}Over {mlabel(self.fc['month'].iat[0])}–{mlabel(self.fc['month'].iat[-1])}, the most likely "
                        f"peak for {self.pool} ranges **{lo}–{hi}** licences (P50) and the high case reaches "
                        f"**{num(self.peak['peak_p90'])}** in {mlabel(self.peak['month'])}, against **{self.owned}** owned. "
                        + (f"**{plural(len(self.risk_months), 'month')} at risk:** {mlist(self.risk_months)}."
                           if self.risk_months else "No month exceeds the shortage tolerance.") + self.c("forecast"))
            title = self._title("6-month forecast")
        secs = [self.forecast_table()]
        # trend
        p50 = fc["peak_p50"].tolist()
        trend = []
        if len(p50) >= 2:
            first, last = p50[0], p50[-1]
            direction = "rises" if last > first + 0.5 else "falls" if last < first - 0.5 else "stays broadly flat"
            trend.append(f"Most likely demand {direction} from {num(first)} to {num(last)} across the window.")
        trend.append(f"Busiest: {mlabel(self.peak['month'])} (P90 {num(self.peak['peak_p90'])}); quietest: "
                     f"{mlabel(fc.loc[fc['peak_p50'].idxmin(), 'month'])} (P50 {num(fc['peak_p50'].min())}).")
        idle = self.fc["idle_licences_expected"].mean() if "idle_licences_expected" in self.fc else None
        if idle is not None and not math.isnan(idle):
            trend.append(f"On average about {num(idle, 1)} licences sit idle at peak"
                         + (f" (idle cost {self.m(self.fc['idle_cost_inr'].sum())} over the window)." if self.v.sees_costs else "."))
        secs.append(Section("trend", "Trend and peak", "bullets", items=trend))
        drivers, _ = self.month_drivers(None)
        if drivers:
            secs.append(Section("drivers", "What drives the forecast", "bullets",
                                items=[f"**{k}** {v:+.1f} licences on average — {DRIVER_MEANING.get(k, k.lower())}."
                                       for k, v in drivers[:3]], note=self.c("explain").strip()))
        acc = self.f.accuracy
        if acc:
            secs.append(Section("reliability", "How reliable this is", "bullets", items=[
                f"For {self.f.name}, hold-out MAE is {num(acc.get('mae'), 2)} licences and {pct(acc.get('within_2'), 0)} of "
                "forecasts land within ±2 licences.",
                f"The P90 high case covered the actual peak {pct(acc.get('p90_coverage'), 0)} of the time, so plan on P90 "
                "for Critical work."], note=self.c("accuracy").strip()))
        if not self.v.sees_recommendations:
            secs.append(self._for_you_section())
        hl = self.highlights_core()
        hl.insert(1, dict(label="Licences needed (max)", value=f"{need} vs {self.owned} owned",
                          tone="warn" if need > self.owned else "ok"))
        return Structured("forecast", title, summary, hl, secs, self.next_steps(), self.caveats(), self.follow_ups("forecast"))

    # ---- what should we do
    def _q_recommendation(self) -> Structured:
        if not self.action:
            return self._no_rec()
        aa = self.plan.asked_action
        lead = ""
        if aa and (self.plan.yes_no or re.search(r"\bshould\b", self.plan.topic or "", re.I)):
            lead = self._yes_no_for(aa)
        v, lab = self.action_cost()
        summary = (f"{lead + ' ' if lead else ''}**Recommendation: {self.action_phrase()}.**"
                   + (f" {lab[0].upper() + lab[1:]}: {self.m(v)}." if v and lab else "")
                   + f" {self._why_short()}{self.c('decision')}")
        secs = [Section("recommendation", "Recommendation", "text",
                        text=f"**{ACTION_TITLE.get(self.action, self.action)}** (`{self.action}`). "
                             f"{ACTION_MEANING.get(self.action, '')}"),
                Section("why", "Why this recommendation", "steps", items=self.steps(),
                        note=f"Replay of the recommendation engine's own rules, in its order, with its thresholds."
                             f"{self.c('decision')}"),
                Section("inputs", "What the ML forecast contributed", "bullets", items=self._forecast_inputs())]
        cmp_ = self._policy_vs_cheapest()
        if cmp_:
            secs.append(cmp_)
        tier, route = self.tier()
        if self.action not in ("RETAIN_AND_MONITOR", "RETAIN_AND_MONITOR_GLOBAL_DEMAND", "RETAIN_AND_REVIEW_NO_FORECAST",
                               "RETAIN_AND_REVIEW_PARTIAL_FORECAST", "INVESTIGATE_FORECAST_RISK"):
            secs.append(Section("approval", "Approval route", "text",
                                text=f"At {self.m(v)} this is **Tier {tier}**: {route}. Nobody approves their own "
                                     "submission; nothing changes until it is approved."))
        hl = self.rec_highlights() + self.highlights_core()[:2]
        return Structured("recommendation", self._title("what to do"), summary, hl, secs, self.next_steps(),
                          self.caveats(), self.follow_ups("recommendation"))

    # ---- why this recommendation
    def _q_rec_why(self) -> Structured:
        if not self.action:
            return self._no_rec()
        reason = self.rule_reason()
        summary = (f"The recommendation engine's answer is to **{self.action_phrase()}**. "
                   f"Deciding rule: {reason[0].lower() + reason[1:] if reason else 'see the decision path below.'}"
                   f"{self.c('decision')}")
        steps = []
        for s in self.steps():
            p = _plain(s)
            ok = not re.search(r"at risk|ruled out|gap of [1-9]|not met|incomplete|guardrail", p, re.I)
            steps.append(("✓ " if ok else "→ ") + _strip_bold_label(s))
        secs = [Section("path", "Decision path", "steps", items=steps,
                        note=f"Each step is the engine's own test, in its order (thresholds from config.json and "
                             f"assumptions.csv).{self.c('decision')}"),
                Section("evidence", "Evidence used", "bullets", items=self._forecast_inputs() + self._history_inputs()),
                Section("counterfactual", "What would change the recommendation", "bullets", items=self._counterfactuals())]
        cmp_ = self._policy_vs_cheapest()
        if cmp_:
            secs.append(cmp_)
        return Structured("rec_why", self._title("why this recommendation"), summary,
                          self.rec_highlights()[:2] + self.highlights_core()[1:], secs, self.next_steps(),
                          self.caveats(), self.follow_ups("rec_why"))

    # ---- options and costs
    def _q_options(self) -> Structured:
        opts = self._options_list()
        if not opts:
            st = self._q_recommendation()
            st.caveats.insert(0, "The simulation has no costed options for this pool.")
            return st
        valid = [o for o in opts if o["valid"] and o["meets_risk"]]
        best = min(valid, key=lambda o: o["added_cost_inr"]) if valid else None
        keep = next((o for o in opts if o["option"].lower().startswith("keep")), None)
        if best:
            summary = (f"The simulation costed **{plural(len(opts), 'option')}**; the cheapest that brings every month within "
                       f"the {self.tol:g}% tolerance is **{best['option']}**"
                       + (f" at {self.m(best['added_cost_inr'])}" if self.v.sees_costs else "") + ".")
        else:
            summary = f"None of the {len(opts)} costed options brings every month within the {self.tol:g}% tolerance."
        if keep and keep["months_at_risk"]:
            summary += (f" Doing nothing leaves {plural(int(keep['months_at_risk']), 'month')} at risk (up to "
                        f"{pct(keep['max_shortage_probability'])} shortage chance).")
        if self.action and self.v.sees_recommendations:
            summary += f" The recommendation engine's policy view: **{ACTION_TITLE.get(self.action, self.action)}**."
        summary += self.c("options")
        cols = ["Option", "Months at risk after", "Highest shortage chance after", "Meets tolerance"]
        if self.v.sees_costs:
            cols[1:1] = ["Added cost", "Total incl. shortage cost"]
        rows = []
        for o in opts:
            row = [o["option"], str(o["months_at_risk"]), pct(o["max_shortage_probability"]),
                   "yes" if o["meets_risk"] else ("invalid" if not o["valid"] else "no")]
            if self.v.sees_costs:
                row[1:1] = [inr(o["added_cost_inr"]), inr(o["total_cost_inr"])]
            rows.append(row)
        secs = [Section("options", "Options compared", "table", columns=cols, rows=rows,
                        note="Monte Carlo costing over the 6-month window; total adds the expected cost of remaining "
                             "shortages." + ("" if self.v.sees_costs else " Costs are hidden for your profile.")
                             + self.c("options")),
                Section("tradeoffs", "Trade-offs", "bullets", items=[self._tradeoff(o) for o in opts[:5]])]
        cmp_ = self._policy_vs_cheapest()
        if cmp_:
            secs.append(cmp_)
        hl = []
        if best:
            hl.append(dict(label="Cheapest option within tolerance", value=best["option"], tone="ok"))
            if self.v.sees_costs:
                hl.append(dict(label="Its cost", value=inr(best["added_cost_inr"]), tone="info"))
        if self.action:
            hl.append(dict(label="Engine policy", value=ACTION_TITLE.get(self.action, self.action), tone="info"))
        hl += self.highlights_core()[1:2]
        return Structured("options", self._title("options and costs"), summary, hl, secs, self.next_steps(),
                          self.caveats(), self.follow_ups("options"))

    # ---- next steps
    def _q_next_steps(self) -> Structured:
        if not self.action:
            return self._no_rec()
        steps = self.next_steps()
        deadline = self.r.get("renewal_notice_deadline")
        days = self.r.get("days_to_notice_deadline")
        summary = (f"Goal: **{self.action_phrase()}**. "
                   + (f"Act before the renewal notice deadline, **{deadline}**" + (f" ({int(days)} days away)"
                                                                                     if days is not None else "") + ". "
                      if deadline and self.action != "RETAIN_AND_MONITOR" else "")
                   + f"Here is the plan for you as {self.v.label}.{self.c('decision')}")
        tier, route = self.tier()
        secs = [Section("plan", "Action plan", "steps",
                        items=[f"{s['text']} — *{s['owner']}*" for s in steps])]
        if self.action in ("CONSIDER_PERMANENT_INCREASE", "INVESTIGATE_TEMPORARY_ACCESS", "CONSIDER_REDUCTION_AT_RENEWAL"):
            secs.append(Section("approval", "Approval route", "steps", items={
                1: ["Licence administrator approves."],
                2: ["Owning department head approves (blocking).", "Licence administrator approves."],
                3: ["Owning department head approves (blocking).", "Licence administrator approves.",
                    "A second administrator gives the final sign-off."]}[tier],
                note=f"Tier {tier} at {self.m(self.action_cost()[0])} (default limits: Tier 1 ≤ ₹10 lakh, Tier 2 ≤ ₹30 lakh)."
                if self.v.sees_costs else f"Tier {tier} by the default delegation limits."))
        checks = ["Re-run the forecast if the project plans changed since the last data cut (30 Sep 2026).",
                  "Use verified vendor prices, not the planning assumptions, before committing."]
        if self.risk_months:
            checks.insert(0, f"Confirm the {mlist(self.risk_months)} peak with the project heads — the P90 is a high case, "
                             "not a certainty.")
        if self.action == "CONSIDER_REDUCTION_AT_RENEWAL":
            checks.insert(0, "Check the contract minimum and notice period before reducing.")
        secs.append(Section("checks", "Before committing money", "bullets", items=checks))
        return Structured("next_steps", self._title("next steps"), summary,
                          self.rec_highlights(), secs, steps, self.caveats(), self.follow_ups("next_steps"))

    # ---- renewal
    def _q_renewal(self) -> Structured:
        inv = self.f.inventory or {}
        deadline = self.r.get("renewal_notice_deadline") or inv.get("renewal_notice_deadline")
        renewal = self.r.get("renewal_date") or inv.get("renewal_date")
        days = self.r.get("days_to_notice_deadline")
        rel = ("This pool's recommendation changes the licence count, so it must be notified by then."
               if self.action in ("CONSIDER_REDUCTION_AT_RENEWAL", "CONSIDER_PERMANENT_INCREASE")
               else "No change is recommended, so the renewal can go ahead at the current count.")
        summary = (f"{self.f.name} renews on **{renewal}**; the notice deadline is **{deadline}**"
                   + (f" ({int(days)} days from the 30 Sep 2026 planning date)" if days is not None else "") + f". {rel}"
                   + self.c("decision"))
        items = [f"Renewal date: {renewal}", f"Notice deadline: {deadline} ({inv.get('renewal_notice_days', 'n/a')} days' "
                                                                         "notice)",
                 f"Licences: {inv.get('usable_licenses', self.owned)} usable; criticality {inv.get('criticality', 'n/a')}"]
        if self.v.sees_costs and inv.get("annual_cost_per_license_inr"):
            items.append(f"Planning price: {inr(inv['annual_cost_per_license_inr'])} per licence a year")
        secs = [Section("timeline", "Contract timeline", "bullets", items=items)]
        if self.v.sees_recommendations and self.action:
            secs.append(Section("decision", "Decision for this renewal", "text",
                                text=f"**{ACTION_TITLE.get(self.action, self.action)}** — {self.action_phrase()}."))
        return Structured("renewal", self._title("renewal"), summary, self.rec_highlights()[-1:] + self.highlights_core()[2:],
                          secs, self.next_steps(), self.caveats(), self.follow_ups("renewal"))

    # ---- what-if
    def _q_whatif(self) -> Structured:
        res = self.f.whatif
        if res is None:
            return self._q_overview()
        if not res["valid"]:
            return Structured("whatif", self._title(f"what-if: {res['description']}"),
                              f"**The scenario was not run:** the simulator rejected it — {'; '.join(res['errors'])}.",
                              [], [Section("fix", "How to fix it", "bullets", items=[
                                  "Only not-started projects can be delayed or cancelled.",
                                  "Name a project that feeds this pool (ask *what projects drive this pool?*)."])],
                              self.next_steps(), self.caveats(), self.follow_ups("whatif"))
        s = res["summary"]
        b, a = s["months_at_risk_before"], s["months_at_risk_after"]
        pb, pa = 100 * s["max_shortage_probability_before"], 100 * s["max_shortage_probability_after"]
        if a == 0 and b > 0:
            verdict = "removes every at-risk month"
        elif a == 0:
            verdict = f"keeps every month within the {self.tol:g}% tolerance"
        elif pa < pb - 0.05:
            verdict = f"lowers the risk, but {plural(a, 'month')} {'stays' if a == 1 else 'stay'} above the {self.tol:g}% tolerance"
        else:
            verdict = "does not reduce the shortage risk"
        summary = (f"**{_cap(res['description'])}** {verdict}: months at risk {b} → {a}, highest shortage chance {pb:.1f}% → "
                   f"{pa:.1f}%" + (f", added cost {inr(s['added_cost_inr'])}" if self.v.sees_costs else "") + "."
                   + self.c("whatif"))
        rows = [["Months at risk", str(b), str(a)],
                ["Highest shortage chance", f"{pb:.1f}%", f"{pa:.1f}%"],
                ["Expected shortage (licence-months)", num(s["expected_shortage_licence_months_before"], 2),
                 num(s["expected_shortage_licence_months_after"], 2)]]
        if self.v.sees_costs:
            rows += [["Idle-licence cost (6 months)", inr(s["idle_cost_inr_before"]), inr(s["idle_cost_inr_after"])],
                     ["Added cost of the change", "—", inr(s["added_cost_inr"])]]
        secs = [Section("result", "Scenario result", "table", columns=["Measure", "Before", "After"], rows=rows,
                        note="Plan changes re-run the forecasting model; licence changes only change supply."
                             + self.c("whatif"))]
        mrows = []
        for r in res["comparison"].itertuples(index=False):
            lic = f"{r.licences_owned_after:.0f}" + (f" + {r.temp_cap_after:.0f} temp" if r.temp_cap_after else "")
            mrows.append([mlabel(r.month), f"{r.peak_p90_before:.0f} → {r.peak_p90_after:.0f}",
                          f"{r.licences_owned_before:.0f} → {lic}",
                          f"{100 * r.shortage_probability_before:.1f}% → {100 * r.shortage_probability_after:.1f}%",
                          f"{'yes' if r.at_risk_before else 'no'} → {'yes' if r.at_risk_after else 'no'}"])
        secs.append(Section("months", "Month by month", "table",
                            columns=["Month", "High case (P90)", "Licences", "Shortage chance", "At risk"], rows=mrows))
        m3 = self.f.whatif_engine
        meaning = []
        if m3 is not None and len(m3) and self.v.sees_recommendations:
            r0 = m3.iloc[0]
            meaning.append(f"The recommendation engine, re-run on the scenario, would say **{ACTION_TITLE.get(r0['action'], r0['action'])}** "
                           f"(`{r0['action']}`) — {r0['reason']}")
            if self.action and r0["action"] != self.action:
                meaning.append(f"That differs from today's recommendation ({ACTION_TITLE.get(self.action, self.action)}), "
                               "so this change would alter the decision.")
            elif self.action:
                meaning.append("Same action as today's recommendation, so this change alone does not alter the decision.")
        best = None
        opts = self._options_list()
        if opts:
            valid = [o for o in opts if o["valid"] and o["meets_risk"]]
            best = min(valid, key=lambda o: o["added_cost_inr"]) if valid else None
        if best and self.v.sees_costs:
            meaning.append(f"For comparison, the cheapest costed option within tolerance is {best['option']} "
                           f"({inr(best['added_cost_inr'])}).")
        if meaning:
            secs.append(Section("meaning", "What it means", "bullets", items=meaning))
        steps = []
        if a == 0 and self.v.role in ("admin", "deptHead"):
            steps.append(dict(text="If this is the preferred plan, save it as a scenario and submit it as a recommendation "
                                   "(Planning Studio → What-if).", owner=self.v.label))
        if a > 0:
            steps.append(dict(text="Try a larger change, or combine it with temporary licences, and compare again.",
                              owner=self.v.label))
        steps += self.next_steps()[:2]
        hl = [dict(label="Months at risk", value=f"{b} → {a}", tone="ok" if a == 0 else "warn"),
              dict(label="Highest shortage chance", value=f"{pb:.1f}% → {pa:.1f}%", tone="ok" if pa <= self.tol else "warn")]
        if self.v.sees_costs:
            hl.append(dict(label="Added cost", value=inr(s["added_cost_inr"]), tone="info"))
        return Structured("whatif", self._title(f"what-if: {res['description']}"), summary, hl, secs, steps,
                          self.caveats(["A what-if is a simulation only: nothing in the registry or the licence server "
                                        "changes."]), self.follow_ups("whatif"))

    # ---- general pool question
    def _q_overview(self) -> Structured:
        summary = (f"{self.pool}: " + (f"**at risk in {mlist(self.risk_months)}** (up to "
                                       f"{pct(self.worst['shortage_probability'])} shortage chance)." if self.risk_months else
                                       f"**within capacity** (highest shortage chance {pct(self.worst['shortage_probability'])}).")
                   + f" {self.owned} licences owned; the high case peaks at {num(self.peak['peak_p90'])} in "
                     f"{mlabel(self.peak['month'])}.{self.c('forecast')}")
        if self.v.sees_recommendations and self.action:
            summary += f" Recommendation: **{self.action_phrase()}**.{self.c('decision')}"
        secs = [self.forecast_table(compact=True)]
        if self.v.sees_recommendations and self.action:
            secs.append(Section("why", "Why this recommendation", "steps", items=self.steps()))
        else:
            secs.append(self._for_you_section())
        return Structured("overview", self._title("overview"), summary,
                          self.highlights_core() + (self.rec_highlights()[:1] if self.v.sees_recommendations else []),
                          secs, self.next_steps(), self.caveats(), self.follow_ups("overview"))

    # ---- engineers: what this means for you
    def _q_availability(self) -> Structured:
        st = self._q_forecast()
        st.question_type = "availability"
        st.title = self._title("availability for you")
        if self.plan.original_qtype and self.focus_row is None:
            lead = (f"**For you: {self.f.name} will be tight in {mlist(self.risk_months)}** — raise access requests for "
                    "those months early." if self.risk_months else
                    f"**For you: {self.f.name} should be available as usual** across the next six months.")
            st.summary = lead + " " + st.summary
        why = {"recommendation": "what to do about capacity", "rec_why": "why a capacity decision was made",
               "options": "the costed options", "next_steps": "the purchase plan"}.get(self.plan.original_qtype or "", "")
        if why:
            st.caveats.insert(0, f"Your profile ({self.v.label}) does not include {why}; capacity decisions are made by "
                                 "your department head and the licence administrator. Here is what the forecast means "
                                 "for you.")
        return st

    def _for_you_section(self) -> Section:
        if self.risk_months:
            txt = (f"Licences for {self.f.name} will be tight in {mlist(self.risk_months)}. Raise access requests early "
                   "for those months, schedule heavy runs outside them where possible, and release the tool when idle.")
        else:
            txt = f"{self.f.name} should be available as usual across the window; request access the normal way."
        return Section("for_you", "What this means for you", "text", text=txt)

    def _q_blocked(self) -> Structured:
        b = self.plan.blocked
        base = self._q_overview()
        ns = self.not_started()
        what = ("licence-supply what-ifs (adding, removing or temporary licences)" if b["kind"] == "supply"
                else "schedule what-ifs")
        alt = (f" You can run schedule what-ifs instead — e.g. *What if we delay {ns[0]} by 1 month in {self.f.pf} "
               f"{self.f.name}?*" if self.v.can("simulate_plan") and ns else "")
        base.summary = (f"**The what-if “{b['description']}” was not run:** your profile ({self.v.label}) cannot run "
                        f"{what}.{alt} Your department head or the licence administrator can run it. "
                        f"Current position: " + base.summary)
        base.question_type = "whatif_blocked"
        base.title = self._title("what-if not run")
        return base

    def _no_forecast(self) -> Structured:
        return Structured(self.plan.qtype, self._title("no data"),
                          f"There is no saved forecast or recommendation for {self.f.pf} / {self.f.sw} — that portfolio may "
                          "not use this software. Nothing was estimated.", [], [], [],
                          [], [f"What is the portfolio overview for {self.f.pf}?", "Which pools are riskiest?"])

    def _no_rec(self) -> Structured:
        return Structured(self.plan.qtype, self._title("no recommendation"),
                          f"The recommendation engine has no record for {self.pool} — that portfolio may not use this "
                          "software.", [], [self.forecast_table(compact=True)] if len(self.fc) else [], [], self.caveats(),
                          self.follow_ups("overview"))

    # ------------------------------------------------------------------ shared section builders
    def _why_short(self) -> str:
        a = self.action
        if a in ("CONSIDER_PERMANENT_INCREASE", "INVESTIGATE_TEMPORARY_ACCESS"):
            return (f"The pool is at risk in {mlist(self.risk_months)} (up to {pct(self.worst['shortage_probability'])} "
                    f"shortage chance vs {self.tol:g}%) and covering it needs {int(self.r['modelled_licences_needed_max'])} "
                    f"licences vs {self.current}. {_cap(self.rule_reason())}")
        if a == "INVESTIGATE_FORECAST_RISK":
            return ("The shortage chance is above tolerance, but the rounded requirement fits the current count, so the "
                    "forecast is reviewed before buying.")
        if a == "CONSIDER_REDUCTION_AT_RENEWAL":
            return (f"No month is at risk and the forecast needs at most {int(self.r['modelled_licences_needed_max'])} of "
                    f"{self.current}; company-wide use is low enough to reduce.")
        return _plain(self.f.trace.steps[-1]) if self.f.trace and self.f.trace.steps else ""

    def _yes_no_for(self, aa: str) -> str:
        a = self.action
        rule = _plain(self.deciding_rule())
        if aa == "buy":
            return ("**Yes.**" if a == "CONSIDER_PERMANENT_INCREASE" else
                    "**Not permanently** — temporary cover for the peak is cheaper." if a == "INVESTIGATE_TEMPORARY_ACCESS"
                    else "**No.**")
        if aa == "temporary":
            if a == "INVESTIGATE_TEMPORARY_ACCESS":
                return "**Yes.**"
            if a == "CONSIDER_PERMANENT_INCREASE":
                why = re.sub(r"^.*ruled out because\s*", "", rule)
                why = re.sub(r"\s*→.*$", "", why)
                return f"**No — temporary access is ruled out** ({why})."
            return "**No** — there is no shortage that needs temporary cover."
        if aa == "reduce":
            if a == "CONSIDER_REDUCTION_AT_RENEWAL":
                return "**Yes, at renewal.**"
            if a == "RETAIN_AND_MONITOR_GLOBAL_DEMAND":
                return "**No** — the pool has spare capacity, but company-wide demand argues against reducing."
            if a == "RETAIN_AND_REVIEW_PARTIAL_FORECAST":
                return "**Not yet** — some months have no forecast."
            if self.risk_months:
                return "**No** — the pool is at risk, not over-licensed."
            return "**No.**"
        if aa == "keep":
            return "**Yes.**" if str(a).startswith("RETAIN") else "**No.**"
        return ""

    def _forecast_inputs(self) -> list[str]:
        r = self.r
        out = [f"Highest shortage chance {num(r.get('max_forecast_shortage_probability_pct'), 1)}% vs the {self.tol:g}% "
               f"tolerance; {plural(int(r.get('months_over_risk_tolerance', 0)), 'month')} over it.{self.c('forecast')}",
               f"Licences needed at the riskiest month: {int(r.get('modelled_licences_needed_max', 0))} "
               f"(P95 + 1 buffer) vs {self.current} assumed for the pool.",
               f"Forecast coverage: {int(r.get('months_with_forecast', 0))} of {int(r.get('expected_forecast_months', 0))} "
               "months."]
        drivers, _ = self.month_drivers(str(self.worst["month"]) if self.risk_months else None)
        if drivers:
            out.append("Main drivers: " + ", ".join(f"{k.lower()} {v:+.1f}" for k, v in drivers[:3])
                       + f" licences vs a typical pool.{self.c('explain')}")
        return out

    def _history_inputs(self) -> list[str]:
        r = self.r
        return [f"Company-wide usage history for {self.f.name}: {int(float(r.get('global_observed_denials_software', 0) or 0))} "
                f"denied checkouts, peak demand {num(r.get('global_observed_peak_demand_software'))}, peak utilisation "
                f"{num(r.get('global_peak_utilisation_pct_software'))}%, trend "
                f"{float(r.get('global_demand_trend_pct_software', 0) or 0):+.1f}%.",
                f"Criticality: {r.get('criticality', 'n/a')}."]

    def _counterfactuals(self) -> list[str]:
        a, r, n = self.action, self.r, self.f.trace.numbers if self.f.trace else {}
        cfg = self.f.cfg
        tmax = int(cfg.get("temporary_max_risk_months", 2))
        out = []
        ns = self.not_started()
        if a == "CONSIDER_PERMANENT_INCREASE":
            if str(r.get("criticality", "")).lower() == "critical":
                out.append(f"If {self.f.name} were not Critical, temporary cover ({self.m(n.get('temp_cost'))}) would be "
                           f"chosen instead of buying ({self.m(n.get('perm_cost'))} a year).")
            if int(r.get("months_over_risk_tolerance", 0)) > tmax:
                out.append(f"If the risk lasted {tmax} month(s) or less instead of {r.get('months_over_risk_tolerance')}, "
                           "temporary access would be considered.")
            if n.get("temp_cost", 0) >= n.get("perm_cost", 1):
                out.append("If temporary cover cost less than a year of permanent licences, it would be considered.")
        if a == "INVESTIGATE_TEMPORARY_ACCESS":
            out.append(f"If the risk spread over more than {tmax} months, or the software were Critical, the engine would "
                       f"recommend buying {plural(self.add, 'permanent licence')} instead.")
        if a in AT_RISK_ACTIONS:
            out.append(f"If the highest shortage chance fell to {self.tol:g}% or less"
                       + (f" — for example by delaying {ns[0]} (not started)" if ns else "")
                       + ", the pool would be within tolerance and the engine would test for spare capacity instead.")
        if a == "CONSIDER_REDUCTION_AT_RENEWAL":
            out += ["If company-wide denials reached 10 or more, peak demand exceeded the owned count, demand rose 20%+ "
                    "with high utilisation, or the software were Critical, the engine would keep the licences.",
                    "If any month's shortage chance rose above the tolerance, there would be no reduction."]
        if a == "RETAIN_AND_MONITOR_GLOBAL_DEMAND":
            out.append(f"Without the company-wide signals, the pool's {n.get('reduction', 0)} spare licence(s) would make "
                       "it a reduction candidate.")
        if a == "RETAIN_AND_REVIEW_PARTIAL_FORECAST":
            out.append(f"Once all months have a forecast, the {n.get('reduction', 0)} spare licence(s) would be tested for "
                       "a reduction.")
        if a == "RETAIN_AND_MONITOR":
            if n.get("reduction", 0) >= 2:
                out.append(f"If company-wide peak utilisation fell to {cfg.get('low_utilisation_peak_pct', 50):g}% or less, a "
                           f"reduction to {max(1, n.get('needed', 1))} would be suggested.")
            out.append(f"If any month's shortage chance rose above {self.tol:g}%, the engine would compare temporary and "
                       "permanent cover.")
        if a == "INVESTIGATE_FORECAST_RISK":
            out.append("If the rounded requirement exceeded the current count, the engine would compare temporary and "
                       "permanent cover.")
        return out or ["No single input change would alter this recommendation."]

    def _options_list(self) -> list[dict]:
        if self.f.live_options is not None and len(self.f.live_options):
            o = self.f.live_options
            return [dict(option=r.option, valid=bool(r.valid), errors=r.errors, months_at_risk=int(r.months_at_risk),
                         max_shortage_probability=float(r.max_shortage_probability), added_cost_inr=float(r.added_cost_inr),
                         total_cost_inr=float(r.total_cost_inr), meets_risk=bool(r.meets_risk))
                    for r in o.itertuples(index=False)]
        return list((self.f.sim or {}).get("options") or [])

    def _policy_vs_cheapest(self) -> Section | None:
        if not (self.f.sim and self.action and self.v.sees_recommendations):
            return None
        sim_a = self.f.sim.get("action", "")
        if not _differs(self.action, sim_a):
            return Section("agree", "Policy and cost agree", "text",
                           text=f"The simulation's cheapest option ({sim_a}) matches the engine's policy view."
                                + self.c("options"))
        return Section("differ", "Policy view vs cheapest option", "text",
                       text=f"The simulation's cheapest option is **{sim_a}**"
                            + (f" ({inr(self.f.sim.get('action_cost_inr'))})" if self.v.sees_costs else "")
                            + f", while the engine recommends **{ACTION_TITLE.get(self.action, self.action)}**. The engine "
                              "applies fixed policy rules (temporary access only for short risks, when cheaper than a "
                              "year's purchase, and never for Critical software); the simulation prices temporary licences "
                              "only in the months that need them. Treat the simulation's option as cost-optimal and the "
                              "engine's as the policy view; the approver decides." + self.c("options", "decision"))

    def _tradeoff(self, o: dict) -> str:
        name = o["option"]
        low = name.lower()
        cost = f" ({inr(o['added_cost_inr'])})" if self.v.sees_costs else ""
        if low.startswith("temporary"):
            return (f"**{name}**{cost}: pays only for the at-risk months; needs the vendor to offer short-term licences, "
                    "and adds no capacity after the window.")
        if low.startswith("buy"):
            return (f"**{name}**{cost}: permanent capacity for the whole year and beyond the window; the most expensive if "
                    "the peak is short-lived.")
        if low.startswith("keep"):
            return (f"**{name}**: no spend; leaves {plural(int(o['months_at_risk']), 'month')} at risk (up to "
                    f"{pct(o['max_shortage_probability'])} shortage chance) — engineers may be blocked.")
        if low.startswith("delay"):
            return (f"**{name}**{cost}: no licence spend; moves a not-started project's schedule, so it needs the project "
                    "head's agreement.")
        if "reduce" in low:
            return f"**{name}**{cost}: lowers the licence count at renewal; check no future project needs them."
        return f"**{name}**{cost}: {plural(int(o['months_at_risk']), 'month')} at risk after the change."

    # ------------------------------------------------------------------ follow-ups
    def follow_ups(self, current: str) -> list[str]:
        p = f"{self.f.pf} {self.f.name}"
        ns = self.not_started()
        out = {
            "drivers": [f"What should we do about {p}?", f"What options do we have for {p} and what do they cost?"],
            "forecast": [(f"Why is {p} at risk?" if self.risk_months else f"What drives the forecast for {p}?"),
                         f"What should we do about {p}?", "How accurate is the forecast model?"],
            "recommendation": [f"Why does the engine recommend this for {p}?", f"What options do we have for {p}?",
                               f"What are the next steps for {p}?"],
            "rec_why": [f"What options do we have for {p} and what do they cost?", f"What are the next steps for {p}?"],
            "options": [f"Why does the engine recommend this for {p}?", f"What are the next steps for {p}?"],
            "next_steps": [f"What options do we have for {p}?", f"When is the {self.f.name} renewal deadline for {self.f.pf}?"],
            "renewal": [f"What should we do about {p}?", f"What is the forecast for {p}?"],
            "whatif": [f"What should we do about {p}?", f"What options do we have for {p}?"],
            "overview": [f"Why is {p} at risk?" if self.risk_months else f"What drives the forecast for {p}?",
                         f"What should we do about {p}?", f"What options do we have for {p}?"],
        }.get(current, [])
        if self.v.can("simulate") and self.risk_months and current in ("drivers", "options", "rec_why", "recommendation"):
            out.append(f"What if we add {max(1, self.add)} temporary licences to {p}?")
        if self.v.can("simulate_plan") and ns and current in ("drivers", "forecast", "options", "whatif", "next_steps"):
            out.append(f"What if we delay {ns[0]} by 1 month in {p}?")
        if not self.v.sees_recommendations:
            out = [x for x in out if not re.search(r"should we do|recommend|options|next steps", x, re.I)]
            out += [f"Will {self.f.name} be available for {p.split()[0]} in {mlabel(self.peak['month'])}?"
                    if self.peak is not None else "", "What does P90 mean?"]
        return [x for x in dict.fromkeys(out) if x][:4]


def finish(st: Structured, viewer: Viewer) -> Structured:
    """Last pass: no rupee amount reaches a profile without the 'costs' scope."""
    if viewer.sees_costs:
        return st
    st.summary = redact_money(st.summary)
    st.highlights = [{**h, "value": redact_money(h["value"])} for h in st.highlights]
    for sec in st.sections:
        sec.text, sec.note = redact_money(sec.text), redact_money(sec.note)
        sec.items = [redact_money(x) for x in sec.items]
        sec.rows = [[redact_money(str(c)) for c in r] for r in sec.rows]
    st.next_steps = [{**x, "text": redact_money(x["text"])} for x in st.next_steps]
    st.caveats = [redact_money(c) for c in st.caveats]
    return st


def _strip_bold_label(s: str) -> str:
    return s.strip()


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def _differs(engine_action: str, sim_action: str) -> bool:
    e, s = engine_action, (sim_action or "").lower()
    if e == "INVESTIGATE_TEMPORARY_ACCESS":
        return not s.startswith("temporary")
    if e == "CONSIDER_PERMANENT_INCREASE":
        return not s.startswith("buy")
    if e == "CONSIDER_REDUCTION_AT_RENEWAL":
        return not s.startswith("candidate to reduce")
    return s.startswith(("temporary", "buy", "delay"))


# ============================================================================================ general questions
class GeneralComposer:
    """Answers that are not about one pool: accuracy, method, glossary, assumptions, rankings, portfolio and software
    overviews, renewals, and questions the system cannot place."""

    def __init__(self, plan: Plan, viewer: Viewer, cite, *, ml=None, rec=None, ents=None, pool_recs=None,
                 pool_fc=None, inventory=None, glossary=None, assumptions=None, docs=None, cfg=None):
        self.plan, self.v, self.cite = plan, viewer, cite
        self.ml, self.rec, self.ents = ml, rec, ents
        self.pr, self.pfc, self.inv = pool_recs, pool_fc, inventory
        self.glossary = glossary or {}
        self.assumptions = assumptions
        self.docs = docs or []
        self.cfg = cfg or {}

    def c(self, *keys) -> str:
        labels = [x for x in (self.cite(k) for k in keys) if x]
        return (" " + "".join(f"[{x}]" for x in labels)) if labels else ""

    def m(self, v) -> str:
        return inr(v) if self.v.sees_costs else "hidden for your profile"

    def compose(self) -> Structured:
        fn = getattr(self, f"_q_{self.plan.qtype}", None) or self._q_unknown
        st = fn()
        st.viewer = self.v.to_dict()
        if self.plan.note:
            st.caveats.insert(0, self.plan.note)
        return finish(st, self.v)

    # ---- accuracy
    def _q_accuracy(self) -> Structured:
        rep = self.ml.holdout_report()
        m = rep["model"]
        cov = rep.get("interval_coverage", {})
        auc = (rep.get("derived_targets", {}).get("42_shortage_indicator") or {}).get("auc")
        checks = rep.get("checks", [])
        passed = sum(1 for c in checks if c["passed"])
        er = (self.ml.ensemble_report() or {}).get("model", {}) if self.ml.model == "ensemble" else {}
        label = er.get("selected_label") or self.ml.model_label
        summary = (f"Forecasts come from the **{label}**, the most accurate of the light models compared"
                   + (f" (lowest walk-forward cross-validation error, MAE {num(rep.get('cv_mae'), 3)} licences)"
                      if rep.get("cv_mae") else "") + ". "
                   f"On forecasts it never saw it is off by **{num(m['mae'], 2)} licences** on average, lands within ±2 "
                   f"licences **{pct(m['within_2'], 1)}** of the time, its P90 covers the actual peak "
                   f"**{pct(cov.get('p90'), 1)}** of the time, and it detects shortages with AUC **{num(auc, 3)}**. "
                   f"**{passed}/{len(checks)}** acceptance checks pass.{self.c('accuracy')}")
        rows = [["Test A — known pools, future months", num(m["mae"], 3), pct(m["within_2"]), pct(cov.get("p90"))]]
        defs = rep.get("test_definitions") or {}
        for k, t in (rep.get("other_tests") or {}).items():
            rows.append([f"{k.split('_')[0]} — {defs.get(k, k)}", num(t["mae"], 3), pct(t["within_2"]), "—"])
        for k, b in (rep.get("baselines") or {}).items():
            rows.append([f"Simple rule: {k.replace('Rule: ', '')}", num(b["mae"], 3), pct(b["within_2"]), "—"])
        secs = [Section("tests", "Accuracy on data the model never saw", "table",
                        columns=["Test", "MAE (licences)", "Within ±2", "P90 coverage"], rows=rows,
                        note="MAE = average absolute error in licences (lower is better)." + self.c("accuracy")),
                Section("checks", "Acceptance checks", "bullets",
                        items=[f"{'✓' if c['passed'] else '✗'} {c['check']}: {c['detail']}" for c in checks])]
        mc = self.ml.model_comparison() if hasattr(self.ml, "model_comparison") else None
        if mc is not None and len(mc):
            secs.append(Section("leaderboard", "How the model was chosen", "table",
                                columns=["Rank", "Model", "CV MAE", "Test A MAE"],
                                rows=[[str(r.rank_cv), r.label, num(r.cv_mae, 3), num(getattr(r, "A_out_of_time", float("nan")), 3)]
                                      for r in mc.head(6).itertuples()],
                                note=(er.get("selection_rule") or "") + self.c("comparison")))
        sw = self.ents.software if self.ents else []
        by_sw = rep.get("by_software") or []
        if sw and by_sw:
            name = None
            try:
                name = self.ml.lookup().set_index("software_id").loc[sw[0], "software_name"]
            except Exception:
                pass
            row = next((r for r in by_sw if r["group"] == name), None)
            if row:
                secs.append(Section("software", f"For {name}", "text",
                                    text=f"MAE {num(row['mae'], 2)} licences, within ±2 {pct(row['within_2'], 0)}, P90 coverage "
                                         f"{pct(row['p90_coverage'], 0)} ({row['rows']} hold-out rows)."))
        elif by_sw:
            secs.append(Section("by_software", "By software", "table", columns=["Software", "MAE", "Within ±2", "P90 coverage"],
                                rows=[[r["group"], num(r["mae"], 2), pct(r["within_2"], 0), pct(r["p90_coverage"], 0)]
                                      for r in by_sw]))
        means = ["Use P50 for typical planning and P90 for Critical work: the actual peak was at or below P90 about "
                 f"{pct(cov.get('p90'), 0)} of the time.",
                 f"An error of about {num(m['mae'], 1)} licences matters most for small pools; check the P10–P90 range "
                 "before acting on a 1–2 licence gap.",
                 "Shortage detection is strong, so 'at risk' months are worth acting on."]
        secs.append(Section("meaning", "What this means for planning", "bullets", items=means))
        return Structured("accuracy", "Forecast model accuracy", summary,
                          [dict(label="Model", value=label, tone="info"),
                           dict(label="Hold-out MAE", value=f"{num(m['mae'], 2)} licences", tone="ok"),
                           dict(label="Within ±2 licences", value=pct(m["within_2"]), tone="ok"),
                           dict(label="P90 coverage", value=pct(cov.get("p90")), tone="ok"),
                           dict(label="Checks", value=f"{passed}/{len(checks)} pass", tone="ok" if passed == len(checks) else "warn")],
                          secs, [dict(text="Ask about a specific pool, e.g. *What is the forecast for PF001 ANSYS?*",
                                      owner="You")],
                          ["The data are synthetic; accuracy on real telemetry must be re-measured after go-live."],
                          ["What is the forecast for PF001 ANSYS?", "How does the recommendation engine decide?",
                           "What does P90 mean?"])

    # ---- method
    def _q_method(self) -> Structured:
        q = (self.plan.topic or "").lower()
        cfg = self.cfg
        tol = cfg.get("target_shortage_risk_pct", 5)
        if re.search(r"engine|decide|decision|rule|recommend", q):
            summary = ("The recommendation engine turns each pool's forecast into one action with fixed rules, applied in "
                       f"order: coverage → shortage-risk test ({tol:g}% tolerance) → capacity gap → temporary-vs-permanent "
                       "cost → guardrails from company-wide usage history." + self.c("engine"))
            steps = [f"**Coverage:** no forecast at all → keep the licences (never change on missing data).",
                     f"**Risk test:** any month with shortage chance above {tol:g}% → the pool is at risk.",
                     "**Capacity gap:** licences needed = P95 of simulated demand + 1 safety licence; gap = needed − owned. "
                     "No gap despite the risk → review the forecast.",
                     f"**Temporary vs permanent:** temporary cover is chosen only if the risk lasts ≤ "
                     f"{cfg.get('temporary_max_risk_months', 2)} months, it is cheaper than a year's purchase (temporary = "
                     f"{cfg.get('temporary_licence_monthly_multiplier', 1.6)}× the monthly price), and the software is not "
                     "Critical; otherwise buy permanently.",
                     "**Spare capacity:** 2+ spare licences → check forecast completeness, then company-wide guardrails "
                     "(10+ denials, peak demand above owned, demand rising 20%+ with high utilisation, Critical software).",
                     f"**Low-use test:** company-wide peak utilisation ≤ {cfg.get('low_utilisation_peak_pct', 50):g}% (or "
                     "average < 20% and falling) → reduce at renewal; otherwise keep and monitor."]
            secs = [Section("rules", "Decision rules, in order", "steps", items=steps),
                    Section("check", "How you can check it", "text",
                            text="Ask *why does the engine recommend this for PF001 ANSYS?* — the assistant replays these "
                                 "rules with that pool's numbers. A test confirms the replay matches the engine for all "
                                 "573 pools.")]
            title = "How the recommendation engine decides"
        elif re.search(r"simulat|monte carlo|shortage chance|probab", q):
            summary = ("The Monte Carlo simulation takes the ensemble's per-project forecasts (with their P10–P90 ranges), "
                       "draws 4,000 possible futures for each pool and month, and counts how often demand exceeds the "
                       "licences owned. That share is the shortage chance; it also prices options like temporary licences, "
                       "buying or delaying a project." + self.c("model"))
            secs = [Section("steps", "Steps", "steps", items=[
                "Predict each project's peak licence use 1–6 months ahead (ensemble).",
                "Sample each project's demand from its forecast range; combine overlapping projects (coincidence factor).",
                "Repeat 4,000 times per pool-month → P50, P90, shortage chance, expected shortage.",
                "Licences needed = P95 + 1 buffer; idle cost = expected unused licences × monthly price.",
                "Cost each option over the 6-month window and pick the cheapest that meets the tolerance."])]
            title = "How the simulation works"
        else:
            er = (self.ml.ensemble_report() or {}).get("model", {}) if self.ml.model == "ensemble" else {}
            w = ", ".join(f"{k.replace('_', ' ')} {v:.2f}" for k, v in (er.get("ensemble_stacked_weights") or {}).items())
            summary = (f"Forecasts come from a **{er.get('selected_label', self.ml.model_label)}** trained on the v3 "
                       "dataset: it predicts each licence pool's peak simultaneous demand 1–6 months ahead from the "
                       "project plans, recent usage and timing. It was chosen by walk-forward cross-validation against "
                       "simpler models and baselines." + self.c("model"))
            secs = [Section("steps", "How a forecast is made", "steps", items=[
                "Features per project-month: planned workload, phase, team size, recent observed peaks, portfolio load, timing.",
                f"Model: {er.get('selected_label', self.ml.model_label)}" + (f" (weights: {w})" if w else "") + ".",
                "Intervals: split-conformal P10/P90 from out-of-fold errors.",
                "Projects are combined into pool forecasts by the Monte Carlo simulation.",
                "The recommendation engine turns the pool forecast into an action; this assistant explains both."]),
                    Section("explain", "How the drivers are explained", "text",
                            text="For a pool, the model is re-run with each feature group replaced by typical values; the "
                                 "change in predicted licences is that group's contribution (occlusion).")]
            title = "How the forecast is produced"
        return Structured("method", title, summary, [], secs, [], ["Prices and several thresholds are planning assumptions "
                                                                    "that the team must confirm."],
                          ["How accurate is the forecast model?", "Why is PF001 ANSYS at risk?",
                           "What does shortage chance mean?"])

    # ---- glossary
    def _q_glossary(self) -> Structured:
        q = self.plan.topic or ""
        hits = [(k, v) for k, v in self.glossary.items()
                if any(re.search(p, q, re.I) for p in [_GLOSSARY_TERMS.get(k, re.escape(k))])]
        if not hits:
            hits = [(k, v) for k, v in self.glossary.items() if k.lower() in q.lower()]
        if not hits:
            hits = list(self.glossary.items())[:3]
        k0, v0 = hits[0]
        summary = f"**{k0}:** {v0}" + self.c("glossary")
        example = []
        if self.pfc is not None and len(self.pfc):
            ex = self.pfc[(self.pfc["portfolio_id"] == "PF001") & (self.pfc["software_id"] == "SW003")]
            if len(ex):
                r = ex.loc[ex["peak_p90"].idxmax()]
                example.append(f"Example — PF001 · ANSYS Mechanical in {mlabel(r['month'])}: P50 {num(r['peak_p50'])}, P90 "
                               f"{num(r['peak_p90'])}, shortage chance {pct(r['shortage_probability'])}, licences needed "
                               f"{num(r['licences_needed'])} vs {num(r['licences_owned'])} owned.")
        secs = [Section("related", "Related terms", "bullets", items=[f"**{k}:** {v}" for k, v in hits[1:4]])] if len(hits) > 1 else []
        if example:
            secs.append(Section("example", "Example", "text", text=example[0]))
        return Structured("glossary", f"What “{k0}” means", summary, [], secs, [], [],
                          ["Why is PF001 ANSYS at risk?", "How is the shortage chance calculated?"])

    # ---- assumptions
    def _q_assumption(self) -> Structured:
        a = self.assumptions
        q = (self.plan.topic or "").lower()
        rows = []
        if a is not None:
            for r in a.itertuples():
                rows.append([str(r.assumption_key).replace("_", " "), f"{r.value} {r.unit}", r.description, r.status])
        key = next((r for r in rows if any(w in r[0] for w in re.findall(r"[a-z]{5,}", q))), None)
        summary = (f"**{key[0]}** = {key[1]}: {key[2]} ({key[3]})." if key else
                   "The simulation and the recommendation engine share one set of planning assumptions; most are proposed "
                   "defaults the team must confirm.") + self.c("assumption")
        return Structured("assumption", "Planning assumptions", summary, [],
                          [Section("table", "Assumptions in use", "table",
                                   columns=["Assumption", "Value", "Meaning", "Status"], rows=rows)], [],
                          ["Prices are synthetic: savings stay 'Possible' until verified contract prices and an approved "
                           "decision exist."], ["How does the recommendation engine decide?", "What does P90 mean?"])

    # ---- rankings across pools
    def _q_ranking(self) -> Structured:
        pr = self.pr.copy()
        sw = self.ents.software if self.ents else []
        if sw:
            pr = pr[pr["software_id"].isin(sw)]
        swname = ", ".join(pr["software_name"].unique()[:3]) if sw and len(pr) else ""
        scope = f" for {swname}" if swname else ""
        n = 10
        m = re.search(r"\btop\s+(\d{1,2})\b", self.plan.topic or "", re.I)
        if m:
            n = max(1, min(25, int(m.group(1))))
        kind = self.plan.ranking or "risk"
        secs, hl = [], []
        if kind == "count":
            q = (self.plan.topic or "").lower()
            target = next((a for a, rx in [("CONSIDER_PERMANENT_INCREASE", r"permanent|buy|increase|more licen"),
                                           ("INVESTIGATE_TEMPORARY_ACCESS", r"temporar"),
                                           ("CONSIDER_REDUCTION_AT_RENEWAL", r"reduc|cut|fewer"),
                                           ("INVESTIGATE_FORECAST_RISK", r"review|investigat"),
                                           ("RETAIN_AND_MONITOR", r"keep|retain|monitor")] if re.search(rx, q)), None)
            counts = pr["action"].value_counts()
            if target:
                k = int(counts.get(target, 0))
                summary = (f"**{k}** of {len(pr)} pools{scope} are **{ACTION_TITLE.get(target, target).lower()}** "
                           f"(`{target}`).{self.c('analytics')}")
                sub = pr[pr["action"] == target].sort_values("max_forecast_shortage_probability_pct", ascending=False)
                secs.append(self._pool_table(sub.head(n), f"Those pools (first {min(n, len(sub))})"))
            else:
                at = int((pr["months_over_risk_tolerance"] > 0).sum())
                summary = f"{len(pr)} pools{scope}; **{at}** have at least one month over the shortage tolerance.{self.c('analytics')}"
            secs.insert(0, Section("counts", "Pools by recommended action", "table", columns=["Action", "Pools"],
                                   rows=[[ACTION_TITLE.get(a, a), str(int(c))] for a, c in counts.items()],
                                   note="Counts of pools, not additive licence or money totals."))
        elif kind == "reduction":
            c = pr[pr["action"] == "CONSIDER_REDUCTION_AT_RENEWAL"].sort_values("estimated_annual_saving_at_renewal_inr",
                                                                               ascending=False)
            summary = (f"**{len(c)}** pools{scope} are candidates to reduce at renewal."
                       + (f" The largest possible saving is {self.m(c['estimated_annual_saving_at_renewal_inr'].iat[0])} a year "
                          f"({c['portfolio_id'].iat[0]} · {c['software_name'].iat[0]})." if len(c) else "")
                       + f" Savings are per pool and not additive.{self.c('analytics')}")
            cols = ["Pool", "Software", "Now → recommended", "Renewal notice by"]
            if self.v.sees_costs:
                cols.insert(3, "Possible saving / yr")
            rows = []
            for r in c.head(n).itertuples():
                row = [r.portfolio_id, r.software_name, f"{r.current_licences_assumed_for_pool} → {r.recommended_permanent_licences}",
                       str(r.renewal_notice_deadline)]
                if self.v.sees_costs:
                    row.insert(3, inr(r.estimated_annual_saving_at_renewal_inr))
                rows.append(row)
            secs.append(Section("candidates", "Reduction candidates", "table", columns=cols, rows=rows))
        elif kind == "idle" and self.pfc is not None:
            pfc = self.pfc if not sw else self.pfc[self.pfc["software_id"].isin(sw)]
            ic = (pfc.groupby(["portfolio_id", "software"])[["idle_licences_expected", "idle_cost_inr"]]
                  .agg({"idle_licences_expected": "mean", "idle_cost_inr": "sum"})
                  .sort_values("idle_cost_inr", ascending=False).head(n))
            summary = (f"The most idle pools{scope} over the 6-month window are led by "
                       f"{ic.index[0][0]} · {ic.index[0][1]} (about {num(ic.iloc[0]['idle_licences_expected'], 1)} idle "
                       f"licences at peak on average).{self.c('analytics')}")
            cols = ["Pool", "Software", "Idle licences at peak (avg)"] + (["Idle cost (6 months)"] if self.v.sees_costs else [])
            secs.append(Section("idle", "Highest expected idle capacity", "table", columns=cols,
                                rows=[[a, b, num(r['idle_licences_expected'], 1)] + ([inr(r['idle_cost_inr'])] if self.v.sees_costs else [])
                                      for (a, b), r in ic.iterrows()]))
        elif kind == "overview":
            counts = pr["action"].value_counts()
            at = int((pr["months_over_risk_tolerance"] > 0).sum())
            summary = (f"Across **{len(pr)}** pools{scope}, **{at}** have at least one month over the "
                       f"{self.cfg.get('target_shortage_risk_pct', 5):g}% shortage tolerance. Most common action: "
                       f"**{ACTION_TITLE.get(counts.index[0], counts.index[0]).lower()}** ({counts.iat[0]} pools)."
                       + self.c("analytics"))
            secs.append(Section("counts", "Pools by recommended action", "table", columns=["Action", "Pools"],
                                rows=[[ACTION_TITLE.get(a, a), str(int(c))] for a, c in counts.items()]))
            bysw = pr.groupby("software_name").agg(pools=("portfolio_id", "count"),
                                                    at_risk=("months_over_risk_tolerance", lambda s: int((s > 0).sum())))
            secs.append(Section("by_software", "By software", "table", columns=["Software", "Pools", "Pools at risk"],
                                rows=[[k, str(int(r.pools)), str(int(r.at_risk))] for k, r in bysw.iterrows()]))
            secs.append(self._pool_table(pr.sort_values("max_forecast_shortage_probability_pct", ascending=False).head(5),
                                         "Riskiest five pools"))
        else:
            risk = pr.sort_values(["max_forecast_shortage_probability_pct", "months_over_risk_tolerance"], ascending=False)
            top = risk.head(n)
            if len(top):
                r0 = top.iloc[0]
                summary = (f"The riskiest pool{scope} is **{r0['portfolio_id']} · {r0['software_name']}** with up to "
                           f"**{num(r0['max_forecast_shortage_probability_pct'], 1)}%** shortage chance and "
                           f"{plural(int(r0['months_over_risk_tolerance']), 'month')} over tolerance. "
                           f"{int((pr['months_over_risk_tolerance'] > 0).sum())} of {len(pr)} pools{scope} are at risk in at "
                           f"least one month.{self.c('analytics')}")
            else:
                summary = f"No pools found{scope}."
            secs.append(self._pool_table(top, f"Riskiest pools{scope} (top {len(top)})"))
            hl.append(dict(label="Pools at risk", value=f"{int((pr['months_over_risk_tolerance'] > 0).sum())} of {len(pr)}",
                           tone="warn"))
        steps = [dict(text="Open a pool for its explanation: ask *Why is <pool> <software> at risk?*", owner="You")]
        if self.v.role == "deptHead" and self.v.ml_departments:
            steps.append(dict(text=f"Focus on pools where {', '.join(self.v.ml_departments)} projects drive the peak — the "
                                   "pool answers mark your department's projects.", owner="Department head"))
        if self.v.role == "admin":
            steps.append(dict(text="Prioritise pools with renewal notice deadlines inside 60 days.", owner="Licence administrator"))
        fu = []
        if len(secs) and secs[-1].rows:
            p0 = secs[-1].rows[0]
            fu.append(f"Why is {p0[0]} {p0[1]} at risk?" if kind in ("risk", "count", "overview") else
                      f"What should we do about {p0[0]} {p0[1]}?")
        fu += ["Which pools are candidates for reduction at renewal?", "How accurate is the forecast model?"]
        if not self.v.sees_recommendations:
            fu = [x for x in fu if "reduction" not in x]
        return Structured("ranking", f"Pools ranked{scope}" if kind != "count" else f"Pool counts{scope}", summary, hl,
                          secs, steps, ["Each pool is modelled with the full software licence count, so licence and money "
                                        "figures must not be added across pools."], fu[:3])

    def _pool_table(self, df: pd.DataFrame, title: str) -> Section:
        cols = ["Pool", "Software", "Highest shortage chance", "Months over tolerance", "Needed vs owned"]
        if self.v.sees_recommendations:
            cols.append("Action")
        rows = []
        for r in df.itertuples():
            row = [r.portfolio_id, r.software_name, f"{num(r.max_forecast_shortage_probability_pct, 1)}%",
                   str(r.months_over_risk_tolerance), f"{r.modelled_licences_needed_max} vs {r.current_licences_assumed_for_pool}"]
            if self.v.sees_recommendations:
                row.append(ACTION_TITLE.get(r.action, r.action))
            rows.append(row)
        return Section("pools", title, "table", columns=cols, rows=rows, note=self.c("analytics").strip())

    # ---- one portfolio, all software
    def _q_portfolio(self) -> Structured:
        pf = self.ents.portfolios[0]
        g = self.pr[self.pr["portfolio_id"] == pf].sort_values("max_forecast_shortage_probability_pct", ascending=False)
        if g.empty:
            return Structured("portfolio", f"Portfolio {pf}", f"No recommendations exist for portfolio {pf}.", [], [], [],
                              [], ["Which pools are riskiest?"])
        risky = g[g["months_over_risk_tolerance"] > 0]
        summary = (f"Portfolio **{pf}** has {len(g)} software pools; **{len(risky)}** are at risk in at least one month"
                   + (f", led by **{risky['software_name'].iat[0]}** (up to "
                      f"{num(risky['max_forecast_shortage_probability_pct'].iat[0], 1)}% shortage chance)." if len(risky) else ".")
                   + self.c("analytics"))
        secs = [self._pool_table(g, f"All pools of {pf}, riskiest first")]
        fu = [f"Why is {pf} {risky['software_name'].iat[0]} at risk?" if len(risky) else f"What is the forecast for {pf} "
              f"{g['software_name'].iat[0]}?", "Which pools are riskiest overall?"]
        return Structured("portfolio", f"Portfolio {pf} overview", summary,
                          [dict(label="Pools", value=str(len(g)), tone="info"),
                           dict(label="At risk", value=str(len(risky)), tone="warn" if len(risky) else "ok")],
                          secs, [dict(text="Ask about one pool for its forecast, recommendation and next steps.", owner="You")],
                          [], fu)

    # ---- one software across portfolios
    def _q_software(self) -> Structured:
        sid = self.ents.software[0]
        inv = self.inv.set_index("software_id").loc[sid].to_dict() if self.inv is not None and sid in set(self.inv["software_id"]) else {}
        g = self.pr[self.pr["software_id"] == sid]
        name = inv.get("software_name") or (g["software_name"].iat[0] if len(g) else sid)
        at = int((g["months_over_risk_tolerance"] > 0).sum())
        counts = g["action"].value_counts()
        summary = (f"**{name}** ({inv.get('vendor', '')}, {inv.get('criticality', 'n/a')} criticality): "
                   f"{inv.get('usable_licenses', 'n/a')} usable licences, renewal {inv.get('renewal_date', 'n/a')} (notice by "
                   f"{inv.get('renewal_notice_deadline', 'n/a')}). Across {len(g)} portfolio pools, **{at}** are at risk in at "
                   "least one month." + self.c("analytics"))
        secs = []
        if self.v.sees_recommendations and len(counts):
            secs.append(Section("counts", "Recommended actions across pools", "table", columns=["Action", "Pools"],
                                rows=[[ACTION_TITLE.get(a, a), str(int(c))] for a, c in counts.items()]))
        secs.append(self._pool_table(g.sort_values("max_forecast_shortage_probability_pct", ascending=False).head(5),
                                     f"Riskiest {name} pools"))
        hl = [dict(label="Licences", value=str(inv.get("usable_licenses", "n/a")), tone="info"),
              dict(label="Pools at risk", value=f"{at} of {len(g)}", tone="warn" if at else "ok")]
        if self.v.sees_costs and inv.get("annual_cost_per_license_inr"):
            hl.append(dict(label="Planning price", value=f"{inr(inv['annual_cost_per_license_inr'])}/licence/yr", tone="info"))
        top = g.sort_values("max_forecast_shortage_probability_pct", ascending=False)
        fu = [f"Why is {top['portfolio_id'].iat[0]} {name} at risk?" if len(top) else "", f"Which pools are riskiest for {name}?",
              f"When is the {name} renewal deadline?"]
        return Structured("software", f"{name} across portfolios", summary, hl, secs,
                          [dict(text=f"Name a portfolio (e.g. {top['portfolio_id'].iat[0] if len(top) else 'PF001'}) to get "
                                     "that pool's forecast and recommendation.", owner="You")], [], [x for x in fu if x])

    # ---- renewals, all software
    def _q_renewal_all(self) -> Structured:
        inv = self.inv.sort_values("renewal_notice_deadline")
        sw = self.ents.software if self.ents else []
        if sw:
            inv = inv[inv["software_id"].isin(sw)]
        if inv.empty:
            return self._q_unknown()
        r0 = inv.iloc[0]
        summary = (f"The next renewal notice deadline is **{r0['renewal_notice_deadline']}** for **{r0['software_name']}** "
                   f"(renews {r0['renewal_date']}). Any reduction or increase must be notified by its deadline."
                   + self.c("renewal"))
        cols = ["Software", "Notice deadline", "Renewal", "Licences", "Criticality"]
        rows = [[r.software_name, str(r.renewal_notice_deadline), str(r.renewal_date), str(r.usable_licenses), r.criticality]
                for r in inv.itertuples()]
        return Structured("renewal_all", "Renewal and notice deadlines", summary, [], [
            Section("renewals", "Contracts by notice deadline", "table", columns=cols, rows=rows)],
            [dict(text="Review pools with reduction or increase recommendations before each deadline.", owner="Licence administrator")]
            if self.v.role == "admin" else [], ["Dates are from the synthetic licence inventory."],
            ["Which pools are candidates for reduction at renewal?", "Which pools are riskiest?"])

    # ---- cannot place the question
    def _q_unknown(self) -> Structured:
        items = []
        for d in self.docs[:3]:
            items.append(f"**{d['title']}** [{d['label']}]: {d['text'][:240].strip()}…")
        summary = ("I could not tie that question to a licence pool, a ranking or a topic I hold data on. The closest "
                   "documents are listed below; for a precise answer, name a portfolio and a software (e.g. *PF001 "
                   "ANSYS*) or ask about rankings, accuracy, renewals or definitions.")
        secs = [Section("closest", "Closest matches in the knowledge base", "bullets", items=items)] if items else []
        return Structured("unknown", "Not sure what you are asking", summary, [], secs, [],
                          [], ["Why is PF001 ANSYS at risk?", "Which pools are riskiest for ANSYS?",
                               "How accurate is the forecast model?"])


# ============================================================================================ rendering
def to_markdown(st: Structured, preface: str | None = None) -> str:
    out = []
    if preface:
        out += [preface, ""]
    out += [f"## {st.title}", "", "### Summary", st.summary, ""]
    if st.highlights:
        out.append("**Key figures:** " + " · ".join(f"{h['label']}: **{h['value']}**" for h in st.highlights))
        out.append("")
    for s in st.sections:
        out += [f"### {s.title}", ""]
        if s.kind == "table" and s.columns:
            out.append("| " + " | ".join(s.columns) + " |")
            out.append("|" + "---|" * len(s.columns))
            for r in s.rows:
                out.append("| " + " | ".join(str(x) for x in r) + " |")
        elif s.kind == "steps":
            out += [f"{i}. {x}" for i, x in enumerate(s.items, 1)]
        elif s.kind == "bullets":
            out += [f"- {x}" for x in s.items]
        if s.text:
            out.append(s.text)
        if s.note:
            out += ["", f"*{s.note}*"]
        out.append("")
    if st.next_steps:
        out += ["### Next steps", ""] + [f"{i}. {x['text']}" + (f" — *{x['owner']}*" if x.get("owner") else "")
                                         for i, x in enumerate(st.next_steps, 1)] + [""]
    if st.caveats:
        out += ["### Risks and caveats", ""] + [f"- {c}" for c in st.caveats] + [""]
    if st.follow_ups:
        out += ["**You could also ask:** " + " · ".join(f"*{q}*" for q in st.follow_ups)]
    return neutralize("\n".join(out).strip())
