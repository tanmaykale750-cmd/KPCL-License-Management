"""
Structured retrieval for questions that span many pools ("which pools are riskiest?", "how many ANSYS pools
need more licences?"). These are computed directly from the components' output tables, then handed to
the LLM as one more cited context block - so rankings and counts are exact, not guessed from text chunks.
"""
from __future__ import annotations

import re

import pandas as pd

from .entities import Entities

RANKING = re.compile(r"\b(top|most|riskiest|highest|lowest|largest|biggest|worst|best|rank|ranking|which pools|"
                     r"which portfolios|list|how many|count|overview|summary|summarise|summarize|across|all pools|"
                     r"compare|portfolio-wide|organisation|organization|company)\b", re.I)


def wants_analytics(q: str, ents: Entities) -> bool:
    return bool(RANKING.search(q or "")) or (bool(ents.portfolios) and not ents.software)


def _n(q: str, default: int = 10) -> int:
    m = re.search(r"\btop\s+(\d{1,2})\b", q or "", re.I)
    return max(1, min(25, int(m.group(1)))) if m else default


def build(question: str, ents: Entities, pool_recs: pd.DataFrame, pool_forecast: pd.DataFrame | None,
          inventory: pd.DataFrame | None) -> list[dict]:
    """Return a list of {title, text, source} blocks relevant to the question."""
    q = (question or "").lower()
    out = []
    pr = pool_recs.copy()
    if ents.software:
        pr = pr[pr["software_id"].isin(ents.software)]
    src = "computed from components/recommendation_engine/output/portfolio_pool_recommendations.csv"

    if ents.portfolios and not ents.software:
        for pf in ents.portfolios[:2]:
            g = pool_recs[pool_recs["portfolio_id"] == pf].sort_values("max_forecast_shortage_probability_pct",
                                                                      ascending=False)
            if g.empty:
                continue
            lines = [f"- {r.software_id} {r.software_name}: {r.action}; max shortage probability "
                     f"{r.max_forecast_shortage_probability_pct:.1f}%; months over tolerance {r.months_over_risk_tolerance}; "
                     f"licences needed (max) {r.modelled_licences_needed_max} vs {r.current_licences_assumed_for_pool} "
                     f"assumed for the pool; forecast coverage {r.forecast_coverage_pct:.0f}%" for r in g.itertuples()]
            out.append(dict(title=f"Portfolio overview {pf} (all software pools)",
                            text=f"All {len(g)} software pools of portfolio {pf}, riskiest first:\n" + "\n".join(lines),
                            source=src))

    if pr.empty:
        return out
    n = _n(q)
    if re.search(r"reduc|saving|save|spare|idle|over-?licen|cut", q):
        c = pr[pr["action"] == "CONSIDER_REDUCTION_AT_RENEWAL"].sort_values("estimated_annual_saving_at_renewal_inr",
                                                                           ascending=False)
        lines = [f"- {r.portfolio_id} / {r.software_id} {r.software_name}: reduce from {r.current_licences_assumed_for_pool} "
                 f"to {r.recommended_permanent_licences}; possible saving INR {r.estimated_annual_saving_at_renewal_inr:,.0f}/yr "
                 f"(renewal {r.renewal_date}, notice deadline {r.renewal_notice_deadline})" for r in c.head(n).itertuples()]
        out.append(dict(title="Reduction candidates (recommendation engine)",
                        text=(f"{len(c)} pool(s) are CONSIDER_REDUCTION_AT_RENEWAL"
                              + (f" for {', '.join(ents.software)}" if ents.software else "")
                              + ". Savings are per pool and NOT additive across pools (each pool is modelled with the full "
                                "software licence count).\n" + ("\n".join(lines) if lines else "(none)")),
                        source=src))
        if pool_forecast is not None and re.search(r"idle", q):
            pfc = pool_forecast if not ents.software else pool_forecast[pool_forecast["software_id"].isin(ents.software)]
            ic = (pfc.groupby(["portfolio_id", "software_id", "software"])["idle_cost_inr"].sum()
                  .sort_values(ascending=False).head(n))
            out.append(dict(title="Highest expected idle cost in the 6-month window (Monte Carlo simulation)",
                            text="\n".join(f"- {a} / {b} {c}: INR {v:,.0f}" for (a, b, c), v in ic.items()),
                            source="computed from components/forecasting/reports/simulation/pool_forecast_by_month.csv"))

    risk = pr.sort_values(["max_forecast_shortage_probability_pct", "months_over_risk_tolerance"], ascending=False)
    lines = [f"- {r.portfolio_id} / {r.software_id} {r.software_name}: max shortage probability "
             f"{r.max_forecast_shortage_probability_pct:.1f}%, {r.months_over_risk_tolerance} month(s) over tolerance, "
             f"needs up to {r.modelled_licences_needed_max} vs {r.current_licences_assumed_for_pool}; action {r.action}"
             for r in risk.head(n).itertuples()]
    out.append(dict(title=f"Riskiest pools{' for ' + ', '.join(ents.software) if ents.software else ''} (top {n})",
                    text="\n".join(lines), source=src))

    counts = pr.groupby(["software_id", "software_name", "action"]).size().rename("pools").reset_index()
    lines = []
    for (sid, nm), g in counts.groupby(["software_id", "software_name"]):
        lines.append(f"- {sid} {nm}: " + ", ".join(f"{r.action} {r.pools}" for r in g.itertuples()))
    tot = pr["action"].value_counts()
    out.append(dict(title="Recommendation counts by software and action (recommendation engine)",
                    text=(f"{len(pr)} pool recommendations in scope. Totals: "
                          + ", ".join(f"{a} {c}" for a, c in tot.items()) + ".\n" + "\n".join(lines)
                          + "\nThese are counts of pools, not additive licence or money totals."),
                    source=src))

    if inventory is not None and re.search(r"renew|deadline|notice|contract|expir", q):
        inv = inventory.sort_values("renewal_notice_deadline")
        if ents.software:
            inv = inv[inv["software_id"].isin(ents.software)]
        out.append(dict(title="Renewal and notice deadlines",
                        text="\n".join(f"- {r.software_id} {r.software_name}: notice deadline {r.renewal_notice_deadline}, "
                                       f"renewal {r.renewal_date}, {r.usable_licenses} usable licences, criticality "
                                       f"{r.criticality}" for r in inv.itertuples()),
                        source="components/recommendation_engine/data/licence_inventory.csv"))
    return out
