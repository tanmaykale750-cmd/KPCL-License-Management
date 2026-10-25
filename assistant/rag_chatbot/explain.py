"""
Explanation of a pool's recommendation, reconstructed from the recommendation engine's OWN rules and inputs
(components/recommendation_engine/src/portfolio_decision_engine.py) plus the forecast and the simulation's costed
options. Every number is read from the component outputs; thresholds come from the engine's config.json and the
dataset's assumptions.csv via the engine's own load_settings().

`decision_trace()` replays the engine's decision branches in the same order the engine evaluates them, and returns
the branch that fired. A test checks that the replayed branch equals the engine's action for every pool.

`pool_brief()` assembles the structured answer used by the chat (as context for the LLM, and verbatim when no LLM
is configured) and by the Recommendations page.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import pandas as pd

from .integration.engine_adapter import ACTION_MEANING
from .terminology import neutralize

ACTION_TITLE = {
    "CONSIDER_PERMANENT_INCREASE": "Consider buying more permanent licences",
    "INVESTIGATE_TEMPORARY_ACCESS": "Arrange temporary licences for the peak months",
    "INVESTIGATE_FORECAST_RISK": "Review the forecast before acting",
    "CONSIDER_REDUCTION_AT_RENEWAL": "Consider reducing licences at renewal",
    "RETAIN_AND_MONITOR": "Keep the current licences and monitor",
    "RETAIN_AND_MONITOR_GLOBAL_DEMAND": "Keep the current licences (company-wide demand is high)",
    "RETAIN_AND_REVIEW_PARTIAL_FORECAST": "Keep the current licences until missing forecast months are reviewed",
    "RETAIN_AND_REVIEW_NO_FORECAST": "Keep the current licences (no forecast available)",
}


def _inr(v) -> str:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "n/a"
    return f"₹{v / 1e5:,.2f} lakh" if abs(v) >= 1e5 else f"₹{v:,.0f}"


def _f(v, nd=1) -> str:
    try:
        return f"{float(v):,.{nd}f}"
    except (TypeError, ValueError):
        return "n/a"


@dataclass
class Trace:
    action: str                       # the branch the replay reached
    steps: list[str] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    numbers: dict = field(default_factory=dict)


def decision_trace(row: pd.Series | dict, cfg: dict, annual_cost: float) -> Trace:
    """Replay of portfolio_decision_engine's decision for one pool, in the engine's order, with plain-language steps."""
    r = dict(row)
    risk_limit = float(cfg.get("target_shortage_risk_pct", 5.0))
    temp_mult = float(cfg.get("temporary_licence_monthly_multiplier", 1.6))
    temp_max = max(1, int(cfg.get("temporary_max_risk_months", 2)))
    low_peak = float(cfg.get("low_utilisation_peak_pct", 50.0))
    high_peak = float(cfg.get("target_peak_utilisation_pct", 85.0))

    current = int(r["current_licences_assumed_for_pool"])
    needed = int(r["modelled_licences_needed_max"])
    months = int(r["months_with_forecast"])
    expected = int(r["expected_forecast_months"])
    max_risk = float(r["max_forecast_shortage_probability_pct"])
    risk_months = int(r["months_over_risk_tolerance"])
    additional, reduction = max(0, needed - current), max(0, current - needed)
    crit = str(r.get("criticality", ""))
    denials = int(float(r.get("global_observed_denials_software", 0) or 0))
    g_peak = float(r.get("global_observed_peak_demand_software", 0) or 0)
    g_util = float(r.get("global_peak_utilisation_pct_software", 0) or 0)
    g_avg = float(r.get("global_avg_utilisation_pct_software", 0) or 0)
    trend = float(r.get("global_demand_trend_pct_software", 0) or 0)
    t = Trace(action="", numbers=dict(current=current, needed=needed, additional=additional, reduction=reduction,
                                      max_risk_pct=max_risk, risk_months=risk_months, risk_limit=risk_limit,
                                      months_with_forecast=months, expected_months=expected))

    t.steps.append(f"**Forecast coverage:** {months} of {expected} months in the planning window have a forecast.")
    if months == 0:
        t.action = "RETAIN_AND_REVIEW_NO_FORECAST"
        t.steps.append("With no forecast at all, the engine never changes licences on missing data, so it keeps the count.")
        return t
    risky = risk_months > 0 or max_risk > risk_limit
    t.steps.append(f"**Shortage risk test:** the highest monthly shortage probability is {_f(max_risk)}% against a "
                   f"tolerance of {_f(risk_limit, 0)}%, so {risk_months} month(s) are over the limit"
                   + (" → **the pool is at risk.**" if risky else " → **within tolerance.**"))
    if risky:
        t.steps.append(f"**Capacity gap:** covering the riskiest month needs {needed} licences (95th-percentile "
                       f"demand + 1 safety buffer) vs {current} available → gap of **{additional}**.")
        if additional <= 0:
            t.action = "INVESTIGATE_FORECAST_RISK"
            t.steps.append("Risk is above tolerance but the rounded requirement fits current capacity, so the engine flags "
                           "the forecast for review rather than buying.")
            return t
        temp_cost = additional * annual_cost / 12.0 * temp_mult * max(1, risk_months)
        perm_cost = additional * annual_cost
        t.numbers.update(temp_cost=temp_cost, perm_cost=perm_cost)
        t.steps.append(f"**Cost comparison:** temporary cover = {additional} licence(s) × {_inr(annual_cost)}/12 × "
                       f"{temp_mult:g} (temporary premium) × {max(1, risk_months)} month(s) = **{_inr(temp_cost)}**; "
                       f"buying permanently = {additional} × {_inr(annual_cost)} = **{_inr(perm_cost)}** a year.")
        conds = [(risk_months <= temp_max, f"risk lasts {risk_months} month(s) (temporary allowed up to {temp_max})"),
                 (temp_cost < perm_cost, "temporary is cheaper" if temp_cost < perm_cost else "temporary is not cheaper"),
                 (crit.lower() != "critical", f"criticality is {crit}" + (" (Critical tools are not left on temporary "
                                                                            "access)" if crit.lower() == "critical" else ""))]
        if all(c for c, _ in conds):
            t.action = "INVESTIGATE_TEMPORARY_ACCESS"
            t.steps.append("**Decision rule:** temporary access is chosen because " + "; ".join(d for _, d in conds) + ".")
        else:
            t.action = "CONSIDER_PERMANENT_INCREASE"
            failed = [d for c, d in conds if not c]
            t.steps.append("**Decision rule:** temporary access is ruled out because " + "; ".join(failed)
                           + f" → buy **{additional}** permanent licence(s) (from {current} to {current + additional}).")
        return t
    t.steps.append(f"**Spare capacity:** the forecast needs at most {needed} vs {current} available → "
                   f"{reduction} spare licence(s)" + (" (a reduction needs at least 2 spare)." if reduction < 2 else "."))
    if reduction >= 2 and months < expected:
        t.action = "RETAIN_AND_REVIEW_PARTIAL_FORECAST"
        t.steps.append(f"**Guardrail – incomplete forecast:** only {months} of {expected} months are forecast, so no "
                       "permanent reduction is recommended until the missing months are reviewed.")
        return t
    if reduction >= 2:
        signals = []
        if denials >= 10:
            signals.append(f"{denials} denied checkouts company-wide")
        if g_peak > current:
            signals.append(f"company-wide peak demand {g_peak:g} exceeds {current}")
        if trend >= 20 and g_util >= high_peak:
            signals.append(f"demand rising {trend:+.1f}% with {g_util:.0f}% peak utilisation")
        if crit.lower() == "critical":
            signals.append("the software is Critical")
        if signals:
            t.action = "RETAIN_AND_MONITOR_GLOBAL_DEMAND"
            t.steps.append("**Guardrail – company-wide usage history:** " + "; ".join(signals)
                           + " → keep the licences despite the pool's spare capacity.")
            return t
        if g_util <= low_peak or (g_avg < 20 and trend < 0):
            t.action = "CONSIDER_REDUCTION_AT_RENEWAL"
            t.steps.append(f"**Low-use test:** company-wide peak utilisation {g_util:.0f}% (limit {low_peak:.0f}%), "
                           f"average {g_avg:.1f}%, trend {trend:+.1f}% → low enough to **reduce to {max(1, needed)}** at the "
                           "next renewal.")
            return t
        t.action = "RETAIN_AND_MONITOR"
        t.steps.append(f"**Low-use test not met:** company-wide peak utilisation {g_util:.0f}% is above the {low_peak:.0f}% "
                       "threshold, so the spare capacity is not treated as reducible.")
        return t
    t.action = "RETAIN_AND_MONITOR"
    t.steps.append("Demand is within tolerance and there is no material spare capacity → keep the current count.")
    return t


def _flags(r: dict) -> list[str]:
    out = []
    trend = float(r.get("global_demand_trend_pct_software", 0) or 0)
    if trend >= 20:
        out.append(f"Company-wide demand for this software is rising ({trend:+.1f}% over the last 90 days).")
    if r.get("notice_status") == "WITHIN_60_DAYS":
        out.append(f"The renewal notice deadline is {r.get('renewal_notice_deadline')} "
                   f"({int(r.get('days_to_notice_deadline'))} days from the planning date): act before it.")
    elif r.get("notice_status") == "PAST_DEADLINE":
        out.append("The renewal notice deadline has passed: check contractual options before any change.")
    if float(r.get("forecast_coverage_pct", 100)) < 100:
        out.append(f"Forecast coverage is {float(r['forecast_coverage_pct']):.0f}%: months without a project forecast are "
                   "unknowns, not zero demand.")
    return out


def next_steps(action: str, r: dict, sim: dict | None, at_risk_months: list[str], projects: list[str]) -> list[str]:
    n_add = max(0, int(r["modelled_licences_needed_max"]) - int(r["current_licences_assumed_for_pool"]))
    n_red = max(0, int(r["current_licences_assumed_for_pool"]) - int(r["recommended_permanent_licences"]))
    deadline = r.get("renewal_notice_deadline")
    months = ", ".join(at_risk_months) or "the at-risk months"
    who = ", ".join(projects[:3])
    s = []
    if action == "CONSIDER_PERMANENT_INCREASE":
        s += [f"Get a vendor quote for {n_add} additional licence(s) before the notice deadline ({deadline}).",
              "Compare it with the temporary option in the What-if page (add temporary licences) before deciding."]
    elif action == "INVESTIGATE_TEMPORARY_ACCESS":
        s += [f"Ask the vendor for {n_add} temporary licence(s) covering {months}, and confirm the price.",
              "If temporary access is not offered, re-run the What-if with a permanent purchase."]
    elif action == "INVESTIGATE_FORECAST_RISK":
        s += [f"Review the forecast for {months} with the project leads" + (f" ({who})" if who else "") + ".",
              "Re-forecast after the next month of usage data before committing money."]
    elif action == "CONSIDER_REDUCTION_AT_RENEWAL":
        s += [f"Confirm with the users that {n_red} licence(s) can go, then negotiate the reduction before {deadline}.",
              "Check contract minimums and notice terms."]
    else:
        s += ["Keep the current licence count and re-forecast monthly."]
        if action == "RETAIN_AND_REVIEW_PARTIAL_FORECAST":
            s.append("Find out why some months have no project forecast (plans missing or projects ending).")
    if sim and sim.get("options") and str(sim.get("action", "")).startswith("Delay"):
        s.append(f"The simulation's cheapest option is to **{sim['action'].lower()}**: check with the project owner "
                 "whether the schedule can move.")
    if who and action in ("CONSIDER_PERMANENT_INCREASE", "INVESTIGATE_TEMPORARY_ACCESS"):
        s.append(f"Confirm the peak with the main projects driving it ({who}).")
    s.append("Get human approval: prices are planning assumptions, so any saving or cost is *Possible*, not confirmed.")
    return s


def pool_brief(pf: str, sw: str, rec_row: dict | None, forecast: pd.DataFrame, sim: dict | None, cfg: dict,
               annual_cost: float, model_label: str, live_drivers: dict | None = None) -> dict:
    """Structured explanation of one pool. Returns {markdown, trace, action, ...}."""
    f = forecast.sort_values("month")
    name = f["software"].iat[0] if len(f) else sw
    owned = int(f["licences_owned"].iat[0]) if len(f) else None
    risk = f[f["at_risk"]]
    risk_months = risk["month"].astype(str).tolist()
    projects = []
    for s in f["main_projects"].fillna(""):
        for p in [x.split(" (")[0].strip() for x in s.split(";") if x.strip()]:
            if p and p not in projects:
                projects.append(p)
    md = [f"## {pf} · {name} ({sw})", "", "### Summary"]
    trace = None
    if rec_row is not None:
        trace = decision_trace(rec_row, cfg, annual_cost)
        act = rec_row["action"]
        peak = f.loc[f["peak_p90"].idxmax()] if len(f) else None
        md.append(f"**{ACTION_TITLE.get(act, act)}.** "
                  + (f"Demand is forecast to exceed the {owned} licences in **{len(risk_months)} month(s)** "
                     f"({', '.join(risk_months)}), with up to a **{100 * f['shortage_probability'].max():.0f}%** chance of a "
                     "shortage." if risk_months else
                     f"Forecast demand stays within the {owned} licences (highest shortage chance "
                     f"{100 * f['shortage_probability'].max():.1f}%).")
                  + (f" The busiest month is {peak['month']} (high case {peak['peak_p90']:.0f} licences)." if peak is not None else ""))
    md += ["", "### Forecast", f"*Model: {model_label}. P50 = most likely peak of simultaneous users; P90 = high case "
           "(only 1 in 10 simulated futures is higher).*", "",
           "| Month | Most likely (P50) | High case (P90) | Licences owned | Shortage chance | Status |",
           "|---|---|---|---|---|---|"]
    for r in f.itertuples(index=False):
        status = "⚠️ at risk" if r.at_risk else ("no forecast" if int(r.forecasts) == 0 else "ok")
        md.append(f"| {r.month} | {r.peak_p50:.0f} | {r.peak_p90:.0f} | {r.licences_owned:.0f} | "
                  f"{100 * r.shortage_probability:.1f}% | {status} |")
    if live_drivers:
        top = sorted(live_drivers.items(), key=lambda kv: -abs(kv[1]))[:3]
        md += ["", "**What drives the forecast** (model explanation, licences added vs a typical pool): "
               + ", ".join(f"{k.lower()} {v:+.1f}" for k, v in top) + "."]
    if rec_row is not None:
        act = rec_row["action"]
        md += ["", "### Recommendation", f"**Action:** {ACTION_TITLE.get(act, act)} (`{act}`)", "",
               f"*{ACTION_MEANING.get(act, '')}*", "", "**Why this recommendation** (the engine's decision, step by step):"]
        md += [f"{i}. {s}" for i, s in enumerate(trace.steps, 1)]
        cost_line = []
        if float(rec_row.get("estimated_annual_permanent_cost_delta_inr", 0) or 0):
            cost_line.append(f"added cost {_inr(rec_row['estimated_annual_permanent_cost_delta_inr'])} a year")
        if float(rec_row.get("estimated_temporary_cost_inr", 0) or 0):
            cost_line.append(f"temporary cover {_inr(rec_row['estimated_temporary_cost_inr'])}")
        if float(rec_row.get("estimated_annual_saving_at_renewal_inr", 0) or 0):
            cost_line.append(f"possible saving {_inr(rec_row['estimated_annual_saving_at_renewal_inr'])} a year")
        if cost_line:
            md += ["", "**Money:** " + "; ".join(cost_line) + " (planning prices, not vendor quotes)."]
    if sim:
        md += ["", "### Options compared (Monte Carlo costing)",
               f"The simulation costs each option over the 6-month window and picks the cheapest one that brings "
               f"every month within the 5% tolerance: **{sim['action']}**.", ""]
        if sim.get("options"):
            md += ["| Option | Months at risk after | Added cost | Total incl. shortage cost | Meets tolerance |",
                   "|---|---|---|---|---|"]
            for o in sim["options"][:5]:
                md.append(f"| {o['option']} | {o['months_at_risk']} | {_inr(o['added_cost_inr'])} | "
                          f"{_inr(o['total_cost_inr'])} | {'yes' if o['meets_risk'] else 'no'} |")
        if rec_row is not None and _differs(rec_row["action"], sim["action"]):
            md += ["", "*Why the two can differ:* the recommendation engine applies fixed decision rules (temporary "
                   "access only for ≤2 risk months, cheaper than a year's purchase, and non-Critical software), while the "
                   "simulation prices temporary licences only in the months that need them. Treat the simulation's "
                   "option as the cost-optimal choice and the engine's as the policy view."]
    caveats = (_flags(rec_row) if rec_row is not None else [])
    caveats.append("Each portfolio is modelled with the full software licence count, so costs and savings are per pool "
                   "and must not be added across portfolios.")
    md += ["", "### Risks and caveats"] + [f"- {c}" for c in caveats]
    steps = next_steps(rec_row["action"], rec_row, sim, risk_months, projects) if rec_row is not None else [
        "No recommendation exists for this pool."]
    md += ["", "### Next steps"] + [f"{i}. {s}" for i, s in enumerate(steps, 1)]
    return dict(markdown=neutralize("\n".join(md)), trace=trace, action=rec_row["action"] if rec_row is not None else None,
                at_risk_months=risk_months, projects=projects, next_steps=steps)


def _differs(engine_action: str, sim_action: str) -> bool:
    e, s = engine_action, (sim_action or "").lower()
    if e == "INVESTIGATE_TEMPORARY_ACCESS":
        return not s.startswith("temporary")
    if e == "CONSIDER_PERMANENT_INCREASE":
        return not s.startswith("buy")
    if e == "CONSIDER_REDUCTION_AT_RENEWAL":
        return not s.startswith("candidate to reduce")
    return s.startswith(("temporary", "buy", "delay"))
