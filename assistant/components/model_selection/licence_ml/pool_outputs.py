"""
Per-pool prediction output (the dashboard contract), built from the selected model.

As of the dataset's as_of_date every project-software contributes the forecast rows made at its
latest cut-off on or before that date. Rows predicting the same pool-month are combined with the
median (each row is a forecast of the same pool peak). Pool-months with no active project rows are
reported as unavailable, never filled in.

Everything that is a model prediction is kept apart from rule-based calculations:
  prediction      peak P10/P50/P90 per month
  rule-based      utilisation, shortage probability (two-piece normal through P10/P50/P90),
                  risk level, costs, savings, recommendations (thresholds from assumptions.csv)
"""
from __future__ import annotations

from statistics import NormalDist

import numpy as np
import pandas as pd

from . import config as C


def inr(v: float) -> str:
    """Indian-rupee label in lakh (L) or crore (Cr)."""
    a = abs(v)
    s = f"₹{a / 1e7:.2f} Cr" if a >= 1e7 else f"₹{a / 1e5:.1f} L" if a >= 1e5 else f"₹{a:,.0f}"
    return ("−" if v < 0 else "") + s
from . import data as D

Z90 = 1.2815515655446004
_GRID = np.array([NormalDist().inv_cdf((i + 0.5) / 400) for i in range(400)])

RISK_RULES = [
    ("High", 0.50, "probability that peak demand exceeds licences owned is 50% or more"),
    ("Medium", 0.20, "probability between 20% and 50%"),
    ("Low", 0.05, "probability between 5% (the dataset's risk tolerance) and 20%"),
    ("None", 0.0, "probability below 5%"),
]


def risk_level(p: float) -> str:
    for name, thr, _ in RISK_RULES:
        if p >= thr:
            return name
    return "None"


def shortage_stats(p10: float, p50: float, p90: float, owned: float) -> tuple[float, float]:
    """P(peak > owned) and E[max(0, peak - owned)] under a two-piece normal through P10/P50/P90, whole licences."""
    lo = max((p50 - p10) / Z90, 1e-6)
    hi = max((p90 - p50) / Z90, 1e-6)
    x = np.clip(np.rint(p50 + np.where(_GRID < 0, lo, hi) * _GRID), 0, None)
    over = x - owned
    return float((over > 0).mean()), float(np.clip(over, 0, None).mean())


def licences_for_tolerance(p10, p50, p90, tol: float) -> int:
    lo = max((p50 - p10) / Z90, 1e-6)
    hi = max((p90 - p50) / Z90, 1e-6)
    z = NormalDist().inv_cdf(1 - tol)
    return int(np.ceil(p50 + (hi if z > 0 else lo) * z - 1e-9))


def calendar_month(s: pd.Series) -> pd.Series:
    """Project-month windows start on each project's own day; map a window to the calendar month holding most of it."""
    return (s + pd.Timedelta(days=15)).dt.to_period("M").dt.to_timestamp()


def window_months(as_of: pd.Timestamp, n: int = C.WINDOW_MONTHS) -> pd.DatetimeIndex:
    return pd.period_range((as_of + pd.Timedelta(days=1)).to_period("M"), periods=n, freq="M").to_timestamp()


def deployment_rows(df: pd.DataFrame, as_of: pd.Timestamp, months: int = C.WINDOW_MONTHS) -> pd.DataFrame:
    """Latest cut-off on or before as_of for every project-software, predicting windows that start after as_of."""
    d = df[(df["cutoff_date"] <= as_of) & (df["project_deadline_date"] > as_of)]
    d = d[d["cutoff_date"] == d.groupby([C.PROJECT, "software_id"])["cutoff_date"].transform("max")]
    d = d[d["target_month_start"] > as_of].copy()
    d["month"] = calendar_month(d["target_month_start"])
    return d[d["month"].isin(window_months(as_of, months))]


def observed_history(df: pd.DataFrame, as_of: pd.Timestamp, months: int = 12) -> pd.DataFrame:
    """Observed pool peaks: windows that closed by as_of, combined per calendar month (median)."""
    h = df[df["target_month_start"] + pd.DateOffset(months=1) <= as_of + pd.Timedelta(days=1)].copy()
    h["month"] = calendar_month(h["target_month_start"])
    first = (as_of - pd.DateOffset(months=months - 1)).to_period("M").to_timestamp()
    h = h[h["month"] >= first]
    w = h.groupby([C.GROUP, "software_id", "month", "target_month_start"])[C.TARGET].first().reset_index()
    return w.groupby([C.GROUP, "software_id", "month"])[C.TARGET].median().rename("observed").reset_index()


def build(df: pd.DataFrame, fc, model_info: dict, test_by_software: dict, train_stats: dict) -> dict:
    A = D.assumptions()
    as_of = A["as_of_date"]
    lk = D.lookup()
    inv = D.inventory()
    tol = A["shortage_risk_tolerance_pct"] / 100
    buffer = int(A["safety_buffer_licences"])
    low_util = A["low_utilisation_peak_pct"] / 100
    breakeven = float(lk["breakeven_months_temp_vs_annual"].iloc[0])

    rows = deployment_rows(df, as_of)
    pred = fc.predict(rows)
    rows = rows.join(pred)
    agg = rows.groupby([C.GROUP, "software_id", "month"]).agg(
        p10=("peak_p10", "median"), p50=("peak_p50", "median"), p90=("peak_p90", "median"), n_rows=(C.ROW_ID, "size"),
        cold_share=("months_elapsed_at_cutoff", lambda s: float((s == 0).mean())),
        load_ratio=("portfolio_planned_load_to_owned_ratio", "max")).reset_index()
    # pool peak the dataset's simulator later produced (backtest view only; never an input)
    fut = df[df["target_month_start"] > as_of].assign(month=lambda x: calendar_month(x["target_month_start"]))
    fut = fut.groupby([C.GROUP, "software_id", "month", "target_month_start"])[C.TARGET].first().reset_index()
    actual = fut.groupby([C.GROUP, "software_id", "month"])[C.TARGET].median()
    projects = rows.groupby([C.GROUP, "software_id", "month"]).apply(
        lambda g: [dict(project_id=r[C.PROJECT], phase=r["plan_phase_in_target_month"], priority=r["project_priority"],
                        planned_load=round(float(r["plan_load_index_target"]), 2))
                   for _, r in g.sort_values("plan_load_index_target", ascending=False).head(4).iterrows()],
        include_groups=False)
    hist = observed_history(df, as_of)
    months = window_months(as_of)

    pools = []
    for (pf, sw), g in agg.groupby([C.GROUP, "software_id"]):
        owned = int(lk.loc[sw, "licences_owned"])
        price_y = float(lk.loc[sw, "annual_cost_per_licence_inr"])
        price_m = float(lk.loc[sw, "monthly_cost_per_licence_inr"])
        price_t = float(lk.loc[sw, "temporary_monthly_cost_per_licence_inr"])
        renewal = pd.Timestamp(inv.loc[sw, "renewal_date"])
        notice = pd.Timestamp(inv.loc[sw, "renewal_notice_deadline"])
        g = g.set_index("month")
        fc_rows = []
        for m in months:
            if m not in g.index:
                fc_rows.append(dict(month=m.strftime("%Y-%m"), available=False))
                continue
            r = g.loc[m]
            raw_prob, exp_short = shortage_stats(r.p10, r.p50, r.p90, owned)
            prob = float(fc.calibrate_probability(np.array([raw_prob]))[0]) if hasattr(fc, "calibrate_probability") else raw_prob
            fc_rows.append(dict(
                month=m.strftime("%Y-%m"), available=True, p10=round(float(r.p10), 2), p50=round(float(r.p50), 2), p90=round(float(r.p90), 2),
                owned=owned, utilisation_pct=round(100 * float(r.p50) / owned, 1), utilisation_high_pct=round(100 * float(r.p90) / owned, 1),
                shortage_probability=round(prob, 3), expected_shortage=round(exp_short, 2), risk=risk_level(prob),
                licences_needed_at_tolerance=licences_for_tolerance(r.p10, r.p50, r.p90, tol) + buffer,
                spare_licences_high_case=max(0, owned - int(np.ceil(r.p90 - 1e-9))), rows=int(r.n_rows),
                cold_start_share=round(float(r.cold_share), 2),
                projects=projects.get((pf, sw, m), []),
                realised=(float(actual[(pf, sw, m)]) if (pf, sw, m) in actual.index else None)))
        avail = [f for f in fc_rows if f["available"]]
        if not avail:
            continue
        h = hist[(hist[C.GROUP] == pf) & (hist["software_id"] == sw)]
        history = [dict(month=t.strftime("%Y-%m"), observed=float(v)) for t, v in zip(h["month"], h["observed"])]

        # ---------------- shortage events: consecutive months with risk Medium or High
        events, cur = [], None
        for f in fc_rows:
            hot = f["available"] and f["risk"] in ("High", "Medium")
            if hot:
                if cur is None:
                    cur = dict(start=f["month"], end=f["month"], months=0, max_p50=0.0, max_p90=0.0, max_probability=0.0, extra_needed=0, projects=set())
                cur["end"] = f["month"]
                cur["months"] += 1
                cur["max_p50"] = max(cur["max_p50"], f["p50"])
                cur["max_p90"] = max(cur["max_p90"], f["p90"])
                cur["max_probability"] = max(cur["max_probability"], f["shortage_probability"])
                cur["extra_needed"] = max(cur["extra_needed"], f["licences_needed_at_tolerance"] - owned)
                cur["projects"] |= {p["project_id"] for p in f["projects"]}
            elif cur is not None:
                events.append(cur)
                cur = None
        if cur is not None:
            events.append(cur)
        for e in events:
            e["projects"] = sorted(e["projects"])
            e["risk"] = risk_level(e["max_probability"])
            e["owned"] = owned
            e["max_p50"] = round(e["max_p50"], 2)
            e["max_p90"] = round(e["max_p90"], 2)
            e["temporary_cover_cost_inr"] = round(max(0, e["extra_needed"]) * price_t * e["months"])
            e["annual_purchase_cost_inr"] = round(max(0, e["extra_needed"]) * price_y)
            e["cheaper_option"] = "temporary" if e["months"] < breakeven else "annual purchase"

        # ---------------- utilisation
        p50s = np.array([f["p50"] for f in avail])
        p90s = np.array([f["p90"] for f in avail])
        util = p50s / owned
        recent_obs = [x["observed"] for x in history[-3:]]
        consistently_low = bool(np.all(p90s / owned < low_util) and len(recent_obs) == 3 and np.all(np.array(recent_obs) / owned < low_util))
        under = [f["month"] for f in avail if f["p90"] / owned < low_util]
        status = "consistently underutilised" if consistently_low else ("temporarily underutilised" if under else "not underutilised")

        # ---------------- cost (all prices are the dataset's synthetic assumptions)
        window_spend = owned * price_m * len(months)
        shortage_cost = sum(min(e["temporary_cover_cost_inr"], e["annual_purchase_cost_inr"]) for e in events if e["extra_needed"] > 0)
        idle_cost = sum(max(0, owned - int(np.ceil(f["p90"] - 1e-9)) - buffer) * price_m for f in avail)
        in_window_renewal = renewal <= months[-1] + pd.offsets.MonthEnd(0)
        reducible = max(0, owned - (int(np.ceil(p90s.max() - 1e-9)) + buffer)) if consistently_low and not events else 0
        saving = reducible * price_y if in_window_renewal else 0.0

        # ---------------- recommendations (rules documented in the report)
        recs = []
        first_month = pd.Timestamp(months[0])

        def urgency(start: str) -> str:
            gap = (pd.Timestamp(start + "-01").to_period("M") - first_month.to_period("M")).n
            return "High" if gap <= 1 else "Medium" if gap <= 3 else "Low"

        for e in events:
            if e["extra_needed"] <= 0:
                continue
            option = e["cheaper_option"]
            cost = e["temporary_cover_cost_inr"] if option == "temporary" else e["annual_purchase_cost_inr"]
            recs.append(dict(
                issue=f"{e['risk']} shortage risk {e['start']} to {e['end']} ({e['months']} month{'s' if e['months'] > 1 else ''})",
                evidence=f"Peak forecast up to {e['max_p50']:.1f} (P50) and {e['max_p90']:.1f} (P90) against {owned} licences; shortage probability up to {e['max_probability']:.0%}.",
                action=(f"Arrange {e['extra_needed']} temporary licence{'s' if e['extra_needed'] > 1 else ''} for the affected months, or move batch simulation work out of the peak"
                        if option == "temporary" else f"Assess an annual purchase of {e['extra_needed']} licence{'s' if e['extra_needed'] > 1 else ''}; the need lasts {e['months']} months, beyond the {breakeven:g}-month break-even"),
                benefit="Keeps the probability of a shortage within the 5% tolerance (plus 1 buffer licence).",
                financial_impact_inr=-cost, impact_label=f"Added cost about {inr(cost)} (estimate)", urgency=urgency(e["start"]),
                basis="model prediction + rule"))
        if status == "temporarily underutilised" and not events:
            spare = min(f["spare_licences_high_case"] for f in avail if f["month"] in under)
            if spare > 0:
                recs.append(dict(
                    issue=f"Spare capacity in {len(under)} of {len(avail)} forecast months",
                    evidence=f"High-case (P90) peak below {low_util:.0%} of {owned} licences in {', '.join(under[:3])}{'…' if len(under) > 3 else ''}.",
                    action=f"Reallocate up to {spare} licence{'s' if spare > 1 else ''} to pools with forecast shortages for those months; do not cancel on this evidence alone.",
                    benefit="Avoids buying temporary licences elsewhere.", financial_impact_inr=None, impact_label="Not calculable without a matching shortage",
                    urgency="Low", basis="model prediction + rule"))
        if consistently_low and reducible > 0:
            recs.append(dict(
                issue="Consistently underutilised pool",
                evidence=f"Last 3 observed months and all {len(avail)} forecast months peak below {low_util:.0%} of {owned} licences (P90 at most {p90s.max():.1f}).",
                action=(f"Review the contract before the renewal notice deadline ({notice.date()}); consider renewing {owned - reducible} instead of {owned}."
                        if in_window_renewal else f"Review at the next renewal ({renewal.date()}); evidence supports up to {reducible} fewer licences if the pattern holds."),
                benefit="Lower renewal cost without breaching the 5% shortage tolerance on the forecast.",
                financial_impact_inr=saving if saving else None, impact_label=(f"Possible saving {inr(saving)} a year" if saving else "Saving realised only at renewal"),
                urgency="High" if (notice - as_of).days <= 60 else "Medium", basis="model prediction + rule"))
        if not recs:
            recs.append(dict(issue="No action needed", evidence=f"Forecast peak stays between {p50s.min():.1f} and {p90s.max():.1f} against {owned} licences.",
                             action="Keep monitoring; re-forecast monthly.", benefit="—", financial_impact_inr=None, impact_label="—", urgency="Low", basis="rule"))

        warnings = []
        if len(history) < 3:
            warnings.append("Fewer than 3 observed months for this pool: forecast relies mostly on project plans.")
        if np.mean([f["cold_start_share"] for f in avail]) > 0.5:
            warnings.append("Most rows come from projects with no observed usage yet (plan-only).")
        if g["load_ratio"].max() > train_stats["load_ratio_p99"]:
            warnings.append("Planned load relative to owned licences is beyond the 99th percentile seen in training: conditions unlike the training data.")
        if any(not f["available"] for f in fc_rows):
            warnings.append("Some forecast months have no active project rows; those months are reported as unavailable.")

        peak = max(avail, key=lambda f: f["p50"])
        sw_test = test_by_software.get(sw, {})
        pools.append(dict(
            pool_id=f"{pf}·{sw}", portfolio_id=pf, software_id=sw, software=str(lk.loc[sw, "software_name"]), vendor=str(lk.loc[sw, "vendor"]),
            summary=dict(
                prediction_date=str(as_of.date()), forecast_period=f"{months[0].strftime('%b %Y')} to {months[-1].strftime('%b %Y')}",
                horizon_months=len(months), predicted_peak=round(peak["p50"], 2), predicted_peak_month=peak["month"],
                predicted_peak_range=[peak["p10"], peak["p90"]], mean_monthly_peak=round(float(p50s.mean()), 2),
                average_concurrent_demand=None, owned=owned, expected_available_at_peak=round(owned - peak["p50"], 2),
                peak_utilisation_pct=round(100 * peak["p50"] / owned, 1), max_shortage_probability=round(max(f["shortage_probability"] for f in avail), 3),
                risk=risk_level(max(f["shortage_probability"] for f in avail))),
            forecast=fc_rows, history=history, shortages=events,
            utilisation=dict(average_pct=round(100 * float(util.mean()), 1), peak_pct=round(100 * float(util.max()), 1),
                             unused_licences_high_case=[f["spare_licences_high_case"] for f in avail], underutilised_months=under, status=status),
            cost=dict(current_annual_inr=round(owned * price_y), window_contract_spend_inr=round(window_spend), shortage_cover_cost_inr=round(shortage_cost),
                      idle_capacity_cost_inr=round(idle_cost), possible_saving_at_renewal_inr=round(saving), reducible_licences=reducible,
                      net_estimate_inr=round(saving - shortage_cost), renewal_date=str(renewal.date()), renewal_notice_deadline=str(notice.date()),
                      delay_cost="Unavailable: the dataset has no overtime or delay-cost data"),
            recommendations=recs,
            reliability=dict(model=model_info["selected_label"], test_mae_this_software=sw_test.get("mae"), test_within_2_this_software=sw_test.get("within_2"),
                             p90_coverage_this_software=sw_test.get("p90_coverage"), warnings=warnings),
        ))
    pools.sort(key=lambda p: (-p["summary"]["max_shortage_probability"], p["pool_id"]))
    return dict(as_of=str(as_of.date()), months=[m.strftime("%Y-%m") for m in months], risk_rules=[dict(level=n, min_probability=t, rule=r) for n, t, r in RISK_RULES],
                pools=pools)
