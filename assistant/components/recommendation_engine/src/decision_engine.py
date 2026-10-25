"""Prototype licence optimisation and recommendation engine.

Uses historical daily peak demand by default. An optional forecast CSV can be
provided later with columns: software_id, forecast_date (or date),
predicted_demand. This module does not call an LLM or external service.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pandas as pd


REQUIRED_INVENTORY = {
    "software_id", "software_name", "usable_licenses",
    "annual_cost_per_license_inr", "renewal_date", "renewal_notice_deadline",
    "criticality", "cost_source", "renewal_decision_status"
}
REQUIRED_METRICS = {
    "software_id", "software_name", "peak_occupied_licences",
    "peak_demand_incl_denials", "denied_checkout_requests",
    "avg_utilisation_business_hours_pct", "peak_utilisation_pct",
    "demand_trend_last90_vs_prev90_pct", "capacity_constrained",
    "estimated_idle_licence_hours", "idle_pct_of_observed_time"
}
REQUIRED_DAILY = {"date", "software_id", "peak_demand_incl_denials", "is_working_day"}


def _read_csv(path: Path, required: set[str], label: str) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"Missing {label}: {path}")
    df = pd.read_csv(path)
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"{label} is missing required columns: {', '.join(sorted(missing))}")
    return df


def load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Missing config file: {path}")
    with path.open("r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("target_shortage_risk_pct", 5.0)
    cfg.setdefault("safety_buffer_licences", 1)
    cfg.setdefault("shortage_cost_per_shortfall_licence_day_inr", 15000)
    cfg.setdefault("annual_working_days", 252)
    cfg.setdefault("temporary_licence_monthly_multiplier", 1.6)
    cfg.setdefault("temporary_demand_max_weeks", 6)
    cfg.setdefault("max_extra_candidate_licences", 10)
    cfg.setdefault("candidate_min_licences", 1)
    cfg.setdefault("cost_source_verified", False)
    cfg.setdefault("decision_approved", False)
    return cfg


def load_inputs(data_dir: Path) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    inventory = _read_csv(data_dir / "licence_inventory.csv", REQUIRED_INVENTORY, "licence inventory")
    metrics = _read_csv(data_dir / "usage_metrics.csv", REQUIRED_METRICS, "usage metrics")
    daily = _read_csv(data_dir / "daily_demand.csv", REQUIRED_DAILY, "daily demand")
    assumptions_path = data_dir / "assumptions.csv"
    assumptions = pd.read_csv(assumptions_path) if assumptions_path.exists() else pd.DataFrame()

    for df, col in [(inventory, "software_id"), (metrics, "software_id"), (daily, "software_id")]:
        df[col] = df[col].astype(str)
    daily["date"] = pd.to_datetime(daily["date"], errors="coerce")
    daily["peak_demand_incl_denials"] = pd.to_numeric(daily["peak_demand_incl_denials"], errors="coerce").fillna(0).clip(lower=0)
    daily["is_working_day"] = pd.to_numeric(daily["is_working_day"], errors="coerce").fillna(0).astype(int)
    return inventory, metrics, daily, assumptions


def load_forecast(forecast_path: Path, inventory: pd.DataFrame) -> pd.DataFrame:
    """Normalise optional ML forecast file into date/software_id/demand/is_working_day."""
    if not forecast_path.exists():
        raise FileNotFoundError(f"Forecast file not found: {forecast_path}")
    forecast = pd.read_csv(forecast_path)
    date_col = "forecast_date" if "forecast_date" in forecast.columns else ("date" if "date" in forecast.columns else None)
    demand_col = "predicted_demand" if "predicted_demand" in forecast.columns else None
    missing = []
    if "software_id" not in forecast.columns:
        missing.append("software_id")
    if date_col is None:
        missing.append("forecast_date or date")
    if demand_col is None:
        missing.append("predicted_demand")
    if missing:
        raise ValueError("Forecast file needs columns: " + ", ".join(missing))
    forecast = forecast.rename(columns={date_col: "date", demand_col: "peak_demand_incl_denials"})
    forecast["software_id"] = forecast["software_id"].astype(str)
    forecast["date"] = pd.to_datetime(forecast["date"], errors="coerce")
    forecast["peak_demand_incl_denials"] = pd.to_numeric(forecast["peak_demand_incl_denials"], errors="coerce")
    forecast = forecast.dropna(subset=["date", "peak_demand_incl_denials"])
    forecast["peak_demand_incl_denials"] = forecast["peak_demand_incl_denials"].clip(lower=0)
    # Demand simulation is based on working-day demand. If Member 2 does not supply
    # this flag, weekdays are used as a pragmatic default; holidays must be handled later.
    if "is_working_day" in forecast.columns:
        forecast["is_working_day"] = pd.to_numeric(forecast["is_working_day"], errors="coerce").fillna(0).astype(int)
    else:
        forecast["is_working_day"] = (forecast["date"].dt.dayofweek < 5).astype(int)
    return forecast[["date", "software_id", "peak_demand_incl_denials", "is_working_day"]]


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
        return out if math.isfinite(out) else default
    except (TypeError, ValueError):
        return default


def _max_consecutive_demand_run(df: pd.DataFrame, current: int) -> int:
    """Maximum number of calendar days in a contiguous run above current capacity."""
    if df.empty:
        return 0
    temp = df.sort_values("date").copy()
    temp["over"] = temp["peak_demand_incl_denials"] > current
    best = run = 0
    previous_date = None
    for row in temp.itertuples(index=False):
        if not bool(row.over):
            run = 0
        else:
            if previous_date is not None and (row.date - previous_date).days > 1:
                run = 0
            run += 1
            best = max(best, run)
        previous_date = row.date
    return best


def _newsvendor_quantile(demand: pd.Series, annual_cost: float, shortage_cost_per_day: float,
                         annual_working_days: int, safety_buffer: int) -> tuple[float, float, int]:
    """Return critical fractile, empirical target quantile, and buffered licence target."""
    underage_cost = max(0.0, shortage_cost_per_day) * max(1, annual_working_days)
    overage_cost = max(0.0, annual_cost)
    if underage_cost + overage_cost <= 0:
        fractile = 0.95
    else:
        fractile = underage_cost / (underage_cost + overage_cost)
    fractile = min(0.999, max(0.001, fractile))
    valid = demand.dropna().clip(lower=0)
    quantile_demand = float(valid.quantile(fractile)) if not valid.empty else 0.0
    target = max(1, int(math.ceil(quantile_demand)) + max(0, int(safety_buffer)))
    return fractile, quantile_demand, target


def _candidate_metrics(demand: pd.Series, candidate: int, current: int, annual_cost_per_licence: float,
                       cfg: dict[str, Any], working_days_observed: int) -> dict[str, Any]:
    demand = demand.dropna().clip(lower=0)
    if demand.empty:
        demand = pd.Series([0.0])
    exceed = (demand > candidate)
    shortfall = (demand - candidate).clip(lower=0)
    risk_pct = float(exceed.mean() * 100)
    affected_days = int(exceed.sum())
    shortfall_licence_days = float(shortfall.sum())
    annual_working_days = max(1, int(cfg["annual_working_days"]))
    shortage_cost_day = max(0.0, _as_float(cfg["shortage_cost_per_shortfall_licence_day_inr"], 0.0))
    # Annualise shortage penalties because input history / forecast horizon may be shorter than one year.
    annualised_shortfall_licence_days = shortfall_licence_days / max(1, working_days_observed) * annual_working_days
    annualised_shortage_cost = annualised_shortfall_licence_days * shortage_cost_day
    annual_licence_cost = max(0, candidate) * max(0.0, annual_cost_per_licence)
    total_cost = annual_licence_cost + annualised_shortage_cost
    return {
        "candidate_licences": int(candidate),
        "annual_licence_cost_inr": round(annual_licence_cost, 2),
        "shortage_risk_pct": round(risk_pct, 2),
        "days_with_shortage": affected_days,
        "shortfall_licence_days_observed": round(shortfall_licence_days, 2),
        "annualised_shortage_cost_inr": round(annualised_shortage_cost, 2),
        "estimated_annual_total_cost_inr": round(total_cost, 2),
        "meets_risk_tolerance": risk_pct <= _as_float(cfg["target_shortage_risk_pct"], 5.0),
        "savings_vs_current_annual_cost_inr": round(current * annual_cost_per_licence - total_cost, 2),
    }


def _make_recommendation(row: pd.Series, metrics_row: pd.Series, selected: pd.Series,
                         newsvendor_target: int, cfg: dict[str, Any], demand_df: pd.DataFrame,
                         is_forecast: bool) -> dict[str, Any]:
    current = int(row["usable_licenses"])
    grid_choice = int(selected["candidate_licences"])
    chosen = grid_choice
    cost_per = _as_float(row["annual_cost_per_license_inr"])
    peak_demand = _as_float(metrics_row.get("peak_demand_incl_denials", 0))
    denials = int(_as_float(metrics_row.get("denied_checkout_requests", 0)))
    trend = _as_float(metrics_row.get("demand_trend_last90_vs_prev90_pct", 0))
    peak_util = _as_float(metrics_row.get("peak_utilisation_pct", 0))
    avg_util = _as_float(metrics_row.get("avg_utilisation_business_hours_pct", 0))
    idle_pct = _as_float(metrics_row.get("idle_pct_of_observed_time", 0))
    criticality = str(row.get("criticality", "Unknown"))
    renewal_deadline = str(row.get("renewal_notice_deadline", "Unknown"))
    renewal_date = str(row.get("renewal_date", "Unknown"))
    current_cost = current * cost_per
    risk_tolerance = _as_float(cfg.get("target_shortage_risk_pct", 5.0))
    temp_max_days = max(1, int(cfg.get("temporary_demand_max_weeks", 6)) * 7)
    max_run = _max_consecutive_demand_run(demand_df, current)
    demand_peak_in_simulation = _as_float(demand_df["peak_demand_incl_denials"].max() if not demand_df.empty else 0)
    temp_licenses = max(0, int(math.ceil(demand_peak_in_simulation - current)))
    temp_months = max(1, int(math.ceil(max_run / 30))) if max_run > 0 else 0
    temp_months = min(temp_months, max(1, int(math.ceil(temp_max_days / 30)))) if temp_months else 0
    temp_cost = (temp_licenses * cost_per / 12.0 * _as_float(cfg.get("temporary_licence_monthly_multiplier", 1.6)) * temp_months) if temp_licenses and temp_months else 0.0

    # Apply domain rules after optimisation. These prevent the numeric optimum from
    # contradicting obvious business evidence (e.g. rapidly rising demand or a tool
    # that already reaches near-capacity without denials).
    use_temporary = denials >= 10 and 0 < max_run <= temp_max_days and demand_peak_in_simulation > current and trend < 20.0
    protect_rising_demand = trend >= 20.0 and grid_choice < current
    protect_near_peak_no_denials = peak_util >= 85.0 and denials == 0 and grid_choice < current
    if use_temporary:
        chosen = current
        action = "INVESTIGATE_TEMPORARY_ACCESS"
        title = "Investigate temporary access for short-lived peaks"
    elif protect_rising_demand or protect_near_peak_no_denials:
        chosen = current
        action = "RETAIN_AND_MONITOR"
        title = "Retain current capacity and monitor"
    elif grid_choice > current:
        chosen = grid_choice
        action = "CONSIDER_INCREASE"
        title = "Consider increasing the licence pool"
    elif grid_choice < current:
        chosen = grid_choice
        action = "CONSIDER_REDUCTION_AT_RENEWAL"
        title = "Consider reducing licences at renewal"
    else:
        chosen = current
        action = "RETAIN_AND_MONITOR"
        title = "Retain current capacity and monitor"

    # Recompute metrics for the final rule-adjusted licence count, not just the raw
    # Grid Search winner. This keeps the recommendation and displayed risk aligned.
    final_metrics = _candidate_metrics(
        demand_df["peak_demand_incl_denials"].astype(float), chosen, current, cost_per,
        cfg, max(1, len(demand_df))
    )
    chosen_total = _as_float(final_metrics["estimated_annual_total_cost_inr"], current_cost)
    savings = current_cost - chosen_total
    risk = _as_float(final_metrics["shortage_risk_pct"], 0.0)

    if use_temporary:
        reason = (f"The data records {denials} denied checkout requests and a maximum observed run of {max_run} consecutive calendar days above current capacity. "
                  f"Keep the permanent pool at {current} for now and investigate temporary access for up to {temp_licenses} additional licence(s) over an estimated {temp_months} month(s).")
    elif protect_rising_demand:
        reason = (f"The raw Grid Search candidate was {grid_choice}, but recent demand is rising ({trend:+.1f}%). The rule engine retains the current {current}-licence pool rather than recommending a reduction until future demand is checked.")
    elif protect_near_peak_no_denials:
        reason = (f"The raw Grid Search candidate was {grid_choice}, but observed peak utilisation is {peak_util:.1f}% and no denials were recorded. The rule engine retains {current} licences to avoid reducing capacity based only on a daily risk approximation.")
    elif action == "CONSIDER_INCREASE":
        reason = (f"The cost-risk simulation favours {chosen} licences instead of the current {current}. Observed denials are {denials}, historical peak demand is {peak_demand:g}, and the selected scenario has estimated shortage risk {risk:.1f}%.")
    elif action == "CONSIDER_REDUCTION_AT_RENEWAL":
        reason = (f"The cost-risk simulation favours {chosen} licences instead of the current {current}. Historical peak demand was {peak_demand:g}; validate the forecast, user needs, and contract before reducing at renewal.")
    else:
        reason = (f"The current count of {current} licences is retained under the rule-adjusted cost-risk decision. Historical peak demand was {peak_demand:g}, with estimated shortage risk {risk:.1f}% for the selected count.")

    risk_after_temporary = None
    if use_temporary:
        temp_capacity = current + temp_licenses
        risk_after_temporary = float((demand_df["peak_demand_incl_denials"] > temp_capacity).mean() * 100) if not demand_df.empty else 0.0
        reason += f" At the observed peak, adding {temp_licenses} temporary licence(s) would cover the tested daily peak demand; simulated exceedance risk after that temporary capacity is {risk_after_temporary:.1f}%. This is a historical scenario, not a guarantee of future demand."
    elif risk > risk_tolerance:
        action = "INVESTIGATE_RISK"
        title = "Investigate shortage risk before approval"
        reason += f" The selected scenario exceeds the configured shortage-risk tolerance of {risk_tolerance:.1f}% and should not be treated as approved."
    if not use_temporary and not bool(final_metrics.get("meets_risk_tolerance", False)):
        reason += " No final rule-adjusted candidate met the configured risk tolerance; review the candidate range and shortage assumptions."

    cost_source = str(row.get("cost_source", "Unknown"))
    approval_status = str(row.get("renewal_decision_status", "Not yet assessed"))
    savings_status = "Confirmed" if bool(cfg.get("cost_source_verified", False)) and bool(cfg.get("decision_approved", False)) and "synthetic" not in cost_source.lower() else "Possible"
    if savings_status != "Confirmed":
        reason += " Any savings are labelled POSSIBLE because cost data is synthetic/unverified and/or the decision has not been approved."
    if is_forecast:
        reason += " The demand simulation uses the supplied forecast; forecast uncertainty and model error should be reviewed."
    else:
        reason += " This run uses historical demand only; connect Member 2's forecast before making a forward-looking decision."

    return {
        "software_id": row["software_id"],
        "software_name": row["software_name"],
        "current_licences": current,
        "grid_search_candidate_licences": grid_choice,
        "recommended_licences": chosen,
        "action": action,
        "recommendation_title": title,
        "estimated_annual_licence_cost_inr": round(chosen * cost_per, 2),
        "estimated_annual_total_cost_inr": round(chosen_total, 2),
        "estimated_annual_savings_inr": round(savings, 2),
        "savings_status": savings_status,
        "selected_shortage_risk_pct": round(risk, 2),
        "risk_after_temporary_access_scenario_pct": round(risk_after_temporary, 2) if risk_after_temporary is not None else None,
        "target_shortage_risk_pct": risk_tolerance,
        "historical_peak_demand": peak_demand,
        "denied_checkout_requests": denials,
        "peak_utilisation_pct": peak_util,
        "average_business_hours_utilisation_pct": avg_util,
        "idle_pct_observed_telemetry": idle_pct,
        "demand_trend_last90_vs_prev90_pct": trend,
        "newsvendor_critical_fractile_pct": round(_as_float(selected.get("newsvendor_critical_fractile_pct", 0)) * 100, 2),
        "newsvendor_demand_quantile": round(_as_float(selected.get("newsvendor_demand_quantile", 0)), 2),
        "newsvendor_target_licences_including_buffer": int(newsvendor_target),
        "temporary_licences_to_consider": int(temp_licenses if use_temporary else 0),
        "estimated_temporary_access_cost_inr": round(temp_cost if use_temporary else 0.0, 2),
        "temporary_access_estimated_months": int(temp_months if use_temporary else 0),
        "criticality": criticality,
        "renewal_notice_deadline": renewal_deadline,
        "renewal_date": renewal_date,
        "evidence_and_reason": reason,
        "cost_source": cost_source,
        "renewal_decision_status": approval_status,
        "demand_source": "ML forecast" if is_forecast else "Historical replay",
        "human_approval_required": True,
    }


def run_engine(data_dir: Path, output_dir: Path, config_path: Path,
               forecast_path: Path | None = None) -> dict[str, Path]:
    cfg = load_config(config_path)
    inventory, metrics, daily, _assumptions = load_inputs(data_dir)
    is_forecast = forecast_path is not None
    demand = load_forecast(forecast_path, inventory) if forecast_path else daily.copy()
    demand = demand[demand["is_working_day"].astype(int) == 1].copy()
    if demand.empty:
        raise ValueError("No working-day demand records available for simulation.")

    # Use historical daily demand for the default simulation; optional ML forecast
    # replaces the simulation demand source when supplied.
    output_dir.mkdir(parents=True, exist_ok=True)
    all_grid_rows: list[dict[str, Any]] = []
    recommendations: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    max_extra = max(0, int(cfg.get("max_extra_candidate_licences", 10)))
    min_licences = max(1, int(cfg.get("candidate_min_licences", 1)))
    safety_buffer = max(0, int(cfg.get("safety_buffer_licences", 1)))
    shortage_day_cost = _as_float(cfg.get("shortage_cost_per_shortfall_licence_day_inr", 15000))
    annual_working_days = max(1, int(cfg.get("annual_working_days", 252)))
    risk_tolerance = _as_float(cfg.get("target_shortage_risk_pct", 5.0))

    for row in inventory.to_dict(orient="records"):
        sid = str(row["software_id"])
        software_demand = demand[demand["software_id"] == sid].sort_values("date").copy()
        metric_matches = metrics[metrics["software_id"] == sid]
        if metric_matches.empty:
            metric_row = pd.Series({})
        else:
            metric_row = metric_matches.iloc[0]
        current = int(_as_float(row.get("usable_licenses", 0), 0))
        cost_per = _as_float(row.get("annual_cost_per_license_inr", 0), 0)
        if software_demand.empty:
            # Avoid silently recommending changes for a product without demand rows.
            recommendations.append({
                "software_id": sid, "software_name": row["software_name"], "current_licences": current,
                "recommended_licences": current, "action": "INVESTIGATE_MISSING_DATA",
                "recommendation_title": "Investigate missing demand data", "estimated_annual_licence_cost_inr": round(current * cost_per, 2),
                "estimated_annual_total_cost_inr": round(current * cost_per, 2), "estimated_annual_savings_inr": 0,
                "savings_status": "Possible", "selected_shortage_risk_pct": None, "target_shortage_risk_pct": risk_tolerance,
                "historical_peak_demand": None, "denied_checkout_requests": None, "evidence_and_reason": "No working-day demand records were available for this software. No optimisation was attempted.",
                "demand_source": "ML forecast" if is_forecast else "Historical replay", "human_approval_required": True
            })
            continue
        demand_values = software_demand["peak_demand_incl_denials"].astype(float)
        working_days_observed = int(len(demand_values))
        max_demand = int(math.ceil(float(demand_values.max()))) if len(demand_values) else current
        max_candidate = max(current + max_extra, max_demand + safety_buffer, current)
        max_candidate = max(min_licences, max_candidate)
        grid = []
        for candidate in range(min_licences, max_candidate + 1):
            result = _candidate_metrics(demand_values, candidate, current, cost_per, cfg, working_days_observed)
            result.update({"software_id": sid, "software_name": row["software_name"]})
            grid.append(result)
            all_grid_rows.append(result)
        grid_df = pd.DataFrame(grid)
        feasible = grid_df[grid_df["meets_risk_tolerance"]]
        if not feasible.empty:
            selected = feasible.sort_values(["estimated_annual_total_cost_inr", "candidate_licences"]).iloc[0].copy()
            selection_method = "Lowest estimated total cost among candidates meeting risk tolerance"
        else:
            selected = grid_df.sort_values(["shortage_risk_pct", "estimated_annual_total_cost_inr", "candidate_licences"]).iloc[0].copy()
            selection_method = "No candidate met risk tolerance; lowest-risk candidate selected for review"

        fractile, q_demand, nv_target = _newsvendor_quantile(
            demand_values, cost_per, shortage_day_cost, annual_working_days, safety_buffer
        )
        selected["newsvendor_critical_fractile_pct"] = fractile
        selected["newsvendor_demand_quantile"] = q_demand
        selected["newsvendor_target_licences_including_buffer"] = nv_target
        rec = _make_recommendation(row, metric_row, selected, nv_target, cfg, software_demand, is_forecast)
        rec["selection_method"] = selection_method
        rec["newsvendor_target_licences_including_buffer"] = nv_target
        rec["newsvendor_critical_fractile_pct"] = round(fractile * 100, 2)
        rec["newsvendor_demand_quantile"] = round(q_demand, 2)
        recommendations.append(rec)
        diagnostics.append({
            "software_id": sid,
            "software_name": row["software_name"],
            "demand_rows_used": working_days_observed,
            "demand_source": "ML forecast" if is_forecast else "Historical replay",
            "max_demand_in_input": max_demand,
            "candidate_min": min_licences,
            "candidate_max": max_candidate,
            "selected_licences": int(selected["candidate_licences"]),
            "selected_cost_inr": float(selected["estimated_annual_total_cost_inr"]),
            "selected_risk_pct": float(selected["shortage_risk_pct"]),
            "risk_tolerance_pct": risk_tolerance,
            "selection_method": selection_method,
            "newsvendor_target_licences": nv_target,
            "note": "Shortage penalty and cost assumptions are illustrative unless verified by the team."
        })

    recommendations_df = pd.DataFrame(recommendations)
    grid_df = pd.DataFrame(all_grid_rows)
    diagnostics_df = pd.DataFrame(diagnostics)
    rec_path = output_dir / "recommendations.csv"
    grid_path = output_dir / "grid_search_results.csv"
    diag_path = output_dir / "simulation_diagnostics.csv"
    recommendations_df.to_csv(rec_path, index=False)
    grid_df.to_csv(grid_path, index=False)
    diagnostics_df.to_csv(diag_path, index=False)

    explanation_rows = []
    for rec in recommendations:
        # Deterministic template works without an API key; the prompt is ready for
        # a future optional LLM call after the team chooses a provider.
        explanation_rows.append({
            "software_id": rec.get("software_id"),
            "software_name": rec.get("software_name"),
            "action": rec.get("action"),
            "template_explanation": rec.get("evidence_and_reason"),
            "llm_prompt": make_llm_prompt(rec),
            "llm_status": "Template generated; no external LLM called"
        })
    explanations_path = output_dir / "recommendation_explanations.csv"
    pd.DataFrame(explanation_rows).to_csv(explanations_path, index=False)

    summary = {
        "status": "completed",
        "demand_source": "ML forecast" if is_forecast else "Historical replay",
        "software_products_processed": int(len(recommendations_df)),
        "risk_tolerance_pct": risk_tolerance,
        "shortage_cost_per_shortfall_licence_day_inr": shortage_day_cost,
        "shortage_cost_is_illustrative": True,
        "cost_source_verified": bool(cfg.get("cost_source_verified", False)),
        "decision_approved": bool(cfg.get("decision_approved", False)),
        "savings_label": "Possible unless verified contract prices and approved decisions are supplied",
        "human_approval_required": True,
        "outputs": [rec_path.name, grid_path.name, diag_path.name, explanations_path.name],
        "limitations": [
            "Input package contains synthetic prototype data, not verified KPCL records or vendor quotes.",
            "Historical replay compares daily peak demand to candidate capacity; it is an approximation, not a minute-level session replay.",
            "The configured shortage penalty is illustrative and must be agreed with the team.",
            "Forecast integration should be evaluated using Member 2's reported model error and uncertainty.",
            "Recommendations are decision support only; do not automatically change licence entitlements."
        ]
    }
    summary_path = output_dir / "run_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return {"recommendations": rec_path, "grid_search": grid_path, "diagnostics": diag_path, "explanations": explanations_path, "summary": summary_path}


def make_llm_prompt(recommendation: dict[str, Any]) -> str:
    """Create a constrained prompt for a future LLM integration; does not call an API."""
    allowed = {
        key: recommendation.get(key) for key in [
            "software_name", "current_licences", "recommended_licences", "action",
            "estimated_annual_savings_inr", "savings_status", "selected_shortage_risk_pct",
            "target_shortage_risk_pct", "evidence_and_reason", "cost_source", "renewal_date",
            "renewal_notice_deadline", "demand_source"
        ]
    }
    return (
        "Write a concise admin-facing explanation using ONLY the supplied facts. "
        "Do not change the action, recalculate values, invent evidence, or call savings confirmed. "
        "Mention uncertainty and human approval where relevant. Input JSON: "
        + json.dumps(allowed, ensure_ascii=False)
    )
