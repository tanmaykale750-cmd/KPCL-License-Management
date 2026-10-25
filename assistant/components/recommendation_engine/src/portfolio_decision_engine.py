"""Forecast-aware portfolio recommendation layer for Member 3.

Consumes Member 2's monthly portfolio/software forecast simulation and combines it
with Member 1's software-level inventory and observed usage metrics. Because the
two datasets have different grains, global historical metrics are used as safety
guardrails, not joined as if they were portfolio-level facts.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pandas as pd


FORECAST_REQUIRED = {
    "portfolio_id", "software_id", "month", "forecasts", "peak_expected",
    "peak_p90", "licences_owned", "shortage_probability", "licences_needed",
    "gap_vs_owned", "at_risk",
}
INVENTORY_REQUIRED = {
    "software_id", "software_name", "usable_licenses",
    "annual_cost_per_license_inr", "renewal_date", "renewal_notice_deadline",
    "criticality", "cost_source",
}
METRICS_REQUIRED = {
    "software_id", "software_name", "peak_demand_incl_denials",
    "denied_checkout_requests", "peak_utilisation_pct",
    "avg_utilisation_business_hours_pct", "demand_trend_last90_vs_prev90_pct",
}


def _read_csv(path: Path, required: set[str], label: str) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"Missing {label}: {path}")
    df = pd.read_csv(path)
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"{label} missing required columns: {', '.join(sorted(missing))}")
    return df


def _number(value: Any, default: float = 0.0) -> float:
    try:
        n = float(value)
        return n if math.isfinite(n) else default
    except (TypeError, ValueError):
        return default


def load_settings(config_path: Path, assumptions_path: Path) -> dict[str, Any]:
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    cfg.setdefault("target_shortage_risk_pct", 5.0)
    cfg.setdefault("safety_buffer_licences", 1)
    cfg.setdefault("temporary_licence_monthly_multiplier", 1.6)
    cfg.setdefault("low_utilisation_peak_pct", 50.0)
    cfg.setdefault("target_peak_utilisation_pct", 85.0)
    cfg.setdefault("temporary_max_risk_months", 2)
    cfg.setdefault("as_of_date", "2026-09-30")
    if assumptions_path.exists():
        assumptions = pd.read_csv(assumptions_path)
        if {"assumption_key", "value"}.issubset(assumptions.columns):
            for row in assumptions.itertuples(index=False):
                key = str(row.assumption_key)
                val = row.value
                if key == "as_of_date":
                    cfg["as_of_date"] = str(val)
                elif key == "shortage_risk_tolerance_pct":
                    cfg["target_shortage_risk_pct"] = _number(val, cfg["target_shortage_risk_pct"])
                elif key == "safety_buffer_licences":
                    cfg["safety_buffer_licences"] = int(_number(val, cfg["safety_buffer_licences"]))
                elif key == "temporary_licence_monthly_multiplier":
                    cfg["temporary_licence_monthly_multiplier"] = _number(val, cfg["temporary_licence_monthly_multiplier"])
                elif key == "low_utilisation_peak_pct":
                    cfg["low_utilisation_peak_pct"] = _number(val, cfg["low_utilisation_peak_pct"])
                elif key == "target_peak_utilisation_pct":
                    cfg["target_peak_utilisation_pct"] = _number(val, cfg["target_peak_utilisation_pct"])
    return cfg


def build_recommendations(
    forecast_path: Path,
    inventory_path: Path,
    metrics_path: Path,
    config_path: Path,
    assumptions_path: Path,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    forecast = _read_csv(forecast_path, FORECAST_REQUIRED, "Member 2 monthly pool forecast")
    inventory = _read_csv(inventory_path, INVENTORY_REQUIRED, "Member 1 licence inventory")
    metrics = _read_csv(metrics_path, METRICS_REQUIRED, "Member 1 usage metrics")
    cfg = load_settings(config_path, assumptions_path)

    for col in ["forecasts", "peak_expected", "peak_p90", "licences_owned",
                "shortage_probability", "licences_needed", "gap_vs_owned"]:
        forecast[col] = pd.to_numeric(forecast[col], errors="coerce").fillna(0)
    forecast["month"] = forecast["month"].astype(str)
    forecast["portfolio_id"] = forecast["portfolio_id"].astype(str)
    forecast["software_id"] = forecast["software_id"].astype(str)
    forecast["at_risk"] = forecast["at_risk"].astype(str).str.lower().isin(["true", "1", "yes"])

    for col in ["usable_licenses", "annual_cost_per_license_inr"]:
        inventory[col] = pd.to_numeric(inventory[col], errors="coerce")
    for col in ["peak_demand_incl_denials", "denied_checkout_requests", "peak_utilisation_pct",
                "avg_utilisation_business_hours_pct", "demand_trend_last90_vs_prev90_pct"]:
        metrics[col] = pd.to_numeric(metrics[col], errors="coerce").fillna(0)

    inv_map = inventory.set_index("software_id").to_dict("index")
    metric_map = metrics.set_index("software_id").to_dict("index")
    risk_limit = _number(cfg.get("target_shortage_risk_pct"), 5.0)
    safety = max(0, int(_number(cfg.get("safety_buffer_licences"), 1)))
    temp_multiplier = max(0.0, _number(cfg.get("temporary_licence_monthly_multiplier"), 1.6))
    temp_max_months = max(1, int(_number(cfg.get("temporary_max_risk_months"), 2)))
    low_peak = _number(cfg.get("low_utilisation_peak_pct"), 50.0)
    high_peak = _number(cfg.get("target_peak_utilisation_pct"), 85.0)
    as_of = pd.to_datetime(cfg.get("as_of_date", "2026-09-30"), errors="coerce")

    rows: list[dict[str, Any]] = []
    for (portfolio_id, software_id), grp0 in forecast.groupby(["portfolio_id", "software_id"], sort=True):
        grp = grp0.sort_values("month").copy()
        inv = inv_map.get(software_id)
        met = metric_map.get(software_id)
        if inv is None:
            continue
        if met is None:
            met = {}

        # A zero-forecast row is not treated as evidence of zero demand.
        # Compare each pool against the complete horizon present in Member 2's file,
        # so missing pool-month rows are also reflected in coverage.
        active = grp[grp["forecasts"] > 0].copy()
        expected_forecast_months = int(forecast["month"].nunique())
        months_with_forecast = int(active["month"].nunique())
        zero_forecast_months = max(0, expected_forecast_months - months_with_forecast)
        forecast_coverage_pct = (
            100.0 * months_with_forecast / expected_forecast_months
            if expected_forecast_months else 0.0
        )
        current = int(round(_number(inv.get("usable_licenses"), _number(grp["licences_owned"].iloc[0]))))
        cost = max(0.0, _number(inv.get("annual_cost_per_license_inr")))
        peak_need = int(math.ceil(active["licences_needed"].max())) if not active.empty else 0
        p90_peak = float(active["peak_p90"].max()) if not active.empty else 0.0
        expected_peak = float(active["peak_expected"].max()) if not active.empty else 0.0
        max_risk = float(active["shortage_probability"].max()) if not active.empty else 0.0
        risk_months = int((active["shortage_probability"] * 100 > risk_limit).sum()) if not active.empty else 0
        additional = max(0, peak_need - current)
        reduction = max(0, current - peak_need)
        global_peak_demand = _number(met.get("peak_demand_incl_denials"))
        global_denials = int(_number(met.get("denied_checkout_requests")))
        global_peak_util = _number(met.get("peak_utilisation_pct"))
        global_avg_util = _number(met.get("avg_utilisation_business_hours_pct"))
        trend = _number(met.get("demand_trend_last90_vs_prev90_pct"))
        criticality = str(inv.get("criticality", "Medium"))
        renewal = str(inv.get("renewal_date", ""))
        notice_deadline = str(inv.get("renewal_notice_deadline", ""))
        cost_source = str(inv.get("cost_source", "Unknown"))
        days_to_notice = None
        notice_status = "UNKNOWN"
        notice_dt = pd.to_datetime(notice_deadline, errors="coerce")
        if pd.notna(as_of) and pd.notna(notice_dt):
            days_to_notice = int((notice_dt - as_of).days)
            notice_status = "PAST_DEADLINE" if days_to_notice < 0 else ("WITHIN_60_DAYS" if days_to_notice <= 60 else "ON_TRACK")

        # Member 1 metrics are software-wide; use only as guardrails, not as
        # portfolio-specific demand measurements.
        global_shortage_signal = (
            global_denials >= 10
            or global_peak_demand > current
            or (trend >= 20.0 and global_peak_util >= high_peak)
        )
        rising_demand = trend >= 20.0
        reason_parts: list[str] = []
        action = ""
        recommended = current
        temp_count = 0
        temp_cost = 0.0
        annual_cost_delta = 0.0
        savings = 0.0

        if months_with_forecast == 0:
            action = "RETAIN_AND_REVIEW_NO_FORECAST"
            reason_parts.append("No forecast-bearing months for this portfolio/software pool; do not reduce on missing forecasts.")
        elif risk_months > 0 or max_risk * 100 > risk_limit:
            if additional <= 0:
                # Forecast's risk metric says there is risk even if the rounded
                # required count does not exceed current; keep and investigate.
                action = "INVESTIGATE_FORECAST_RISK"
                reason_parts.append(f"Forecast shortage probability reaches {max_risk*100:.1f}%, above the {risk_limit:.1f}% tolerance.")
            else:
                temp_cost = additional * cost / 12.0 * temp_multiplier * max(1, risk_months)
                permanent_cost = additional * cost
                if risk_months <= temp_max_months and temp_cost < permanent_cost and criticality.lower() != "critical":
                    action = "INVESTIGATE_TEMPORARY_ACCESS"
                    temp_count = additional
                    reason_parts.append(f"Risk is concentrated in {risk_months} forecast month(s); temporary access is estimated cheaper than a full-year purchase.")
                else:
                    action = "CONSIDER_PERMANENT_INCREASE"
                    recommended = current + additional
                    annual_cost_delta = permanent_cost
                    reason_parts.append(f"{risk_months} forecast month(s) exceed the {risk_limit:.1f}% risk tolerance; permanent capacity covers the highest modelled requirement.")
                reason_parts.append(f"Maximum modelled shortage probability is {max_risk*100:.1f}%.")
        elif reduction >= 2 and months_with_forecast < expected_forecast_months:
            action = "RETAIN_AND_REVIEW_PARTIAL_FORECAST"
            reason_parts.append(
                f"Only {months_with_forecast} of {expected_forecast_months} forecast months "
                f"have usable forecasts ({forecast_coverage_pct:.1f}% coverage); "
                "do not recommend a permanent licence reduction until missing forecast months are reviewed."
            )
        elif reduction >= 2:
            if global_shortage_signal or criticality.lower() == "critical":
                action = "RETAIN_AND_MONITOR_GLOBAL_DEMAND"
                reason_parts.append("Pool forecast suggests spare capacity, but software-wide history shows denials, peak demand above inventory, rising high utilisation, or Critical business criticality.")
            elif (global_peak_util <= low_peak) or (global_avg_util < 20 and trend < 0):
                action = "CONSIDER_REDUCTION_AT_RENEWAL"
                recommended = max(1, peak_need)
                savings = reduction * cost
                reason_parts.append(f"No forecast month exceeds risk tolerance; proposed reduction follows maximum forecast licence need ({peak_need}) plus the buffer already included in Member 2's licences_needed.")
                reason_parts.append(f"Observed software-wide peak utilisation is {global_peak_util:.1f}% and average business-hours utilisation is {global_avg_util:.1f}%.")
            else:
                action = "RETAIN_AND_MONITOR"
                reason_parts.append("Forecast shows spare capacity, but software-wide utilisation does not meet the configured low-use condition for a reduction.")
        else:
            action = "RETAIN_AND_MONITOR"
            reason_parts.append("Forecast demand is within risk tolerance and does not justify a material licence-count change.")

        if rising_demand:
            reason_parts.append(f"Software-wide demand trend is rising ({trend:.1f}%); monitor before reducing.")
        if notice_status == "WITHIN_60_DAYS":
            reason_parts.append(f"Renewal notice deadline is in {days_to_notice} days; confirm contract terms promptly.")
        elif notice_status == "PAST_DEADLINE":
            reason_parts.append("Renewal notice deadline has passed; confirm contractual options before any change.")
        if cost_source.lower().startswith("synthetic"):
            savings_label = "Possible (synthetic cost; human approval required)"
        else:
            savings_label = "Possible (approval and contract verification required)"

        rows.append({
            "portfolio_id": portfolio_id,
            "software_id": software_id,
            "software_name": inv.get("software_name", grp["software"].iloc[0] if "software" in grp else software_id),
            "months_with_forecast": months_with_forecast,
            "expected_forecast_months": expected_forecast_months,
            "zero_forecast_months": zero_forecast_months,
            "forecast_coverage_pct": round(forecast_coverage_pct, 2),
            "forecast_months": ";".join(active["month"].astype(str).tolist()),
            "current_licences_assumed_for_pool": current,
            "max_expected_peak": round(expected_peak, 2),
            "max_p90_peak": round(p90_peak, 2),
            "max_forecast_shortage_probability_pct": round(max_risk * 100, 2),
            "months_over_risk_tolerance": risk_months,
            "modelled_licences_needed_max": peak_need,
            "recommended_permanent_licences": recommended,
            "temporary_licences_to_consider": temp_count,
            "estimated_temporary_cost_inr": round(temp_cost, 2),
            "estimated_annual_permanent_cost_delta_inr": round(annual_cost_delta, 2),
            "estimated_annual_saving_at_renewal_inr": round(savings, 2),
            "renewal_date": renewal,
            "renewal_notice_deadline": notice_deadline,
            "days_to_notice_deadline": days_to_notice,
            "notice_status": notice_status,
            "criticality": criticality,
            "global_observed_denials_software": global_denials,
            "global_observed_peak_demand_software": global_peak_demand,
            "global_peak_utilisation_pct_software": global_peak_util,
            "global_avg_utilisation_pct_software": global_avg_util,
            "global_demand_trend_pct_software": trend,
            "action": action,
            "savings_label": savings_label,
            "approval_status": "PENDING_HUMAN_REVIEW",
            "reason": " ".join(reason_parts),
            "data_grain_warning": "Forecast is portfolio/software-level; Member 1 history and inventory are software-level. Do not sum this row's savings across portfolios without confirming actual pool architecture.",
        })

    pool_recs = pd.DataFrame(rows)
    if pool_recs.empty:
        raise ValueError("No recommendations generated. Check that Member 2 forecasts and Member 1 inventory share software IDs.")

    # Summary deliberately avoids summing pool-level costs/savings, because the
    # packages currently disagree about whether portfolios have separate pools.
    summary_rows = []
    for software_id, grp in pool_recs.groupby("software_id", sort=True):
        actions = grp["action"].value_counts()
        summary_rows.append({
            "software_id": software_id,
            "software_name": grp["software_name"].iloc[0],
            "portfolio_software_pools": int(len(grp)),
            "pools_with_forecasts": int((grp["months_with_forecast"] > 0).sum()),
            "pools_with_full_forecast_coverage": int((grp["forecast_coverage_pct"] == 100).sum()),
            "pools_with_partial_forecast_coverage": int(((grp["forecast_coverage_pct"] > 0) & (grp["forecast_coverage_pct"] < 100)).sum()),
            "pools_with_no_forecast_coverage": int((grp["forecast_coverage_pct"] == 0).sum()),
            "pools_over_risk_tolerance": int((grp["months_over_risk_tolerance"] > 0).sum()),
            "pools_recommended_temporary_access": int((grp["action"] == "INVESTIGATE_TEMPORARY_ACCESS").sum()),
            "pools_recommended_permanent_increase": int((grp["action"] == "CONSIDER_PERMANENT_INCREASE").sum()),
            "pools_candidate_reduction": int((grp["action"] == "CONSIDER_REDUCTION_AT_RENEWAL").sum()),
            "pools_retained_or_investigated": int(grp["action"].isin(["RETAIN_AND_MONITOR", "RETAIN_AND_MONITOR_GLOBAL_DEMAND", "RETAIN_AND_REVIEW_NO_FORECAST", "RETAIN_AND_REVIEW_PARTIAL_FORECAST", "INVESTIGATE_FORECAST_RISK"]).sum()),
            "maximum_forecast_risk_pct": round(float(grp["max_forecast_shortage_probability_pct"].max()), 2),
            "note": "Counts of pool recommendations, not additive licence or financial totals.",
        })
    summary = pd.DataFrame(summary_rows)
    metadata = {
        "forecast_rows": int(len(forecast)),
        "portfolio_software_pools": int(len(pool_recs)),
        "software_count": int(pool_recs["software_id"].nunique()),
        "forecast_months": sorted(forecast["month"].unique().tolist()),
        "forecast_horizon_month_count": int(forecast["month"].nunique()),
        "pools_with_full_forecast_coverage": int((pool_recs["forecast_coverage_pct"] == 100).sum()),
        "pools_with_partial_forecast_coverage": int(((pool_recs["forecast_coverage_pct"] > 0) & (pool_recs["forecast_coverage_pct"] < 100)).sum()),
        "pools_with_no_forecast_coverage": int((pool_recs["forecast_coverage_pct"] == 0).sum()),
        "risk_tolerance_pct": risk_limit,
        "safety_buffer_licences": safety,
        "savings_are_possible_not_confirmed": True,
        "pool_grain_warning": "Member 2 models portfolio_id x software_id pools with a full software licence count in each pool, while Member 1 provides one software-level inventory. Confirm this assumption with the team before interpreting pool-level financial totals.",
    }
    return pool_recs, summary, metadata


def run(output_dir: Path, root: Path) -> dict[str, Path]:
    data_dir = root / "data"
    pool_recs, summary, metadata = build_recommendations(
        data_dir / "member2" / "pool_forecast_by_month.csv",
        data_dir / "licence_inventory.csv",
        data_dir / "usage_metrics.csv",
        root / "config.json",
        data_dir / "assumptions.csv",
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    rec_path = output_dir / "portfolio_pool_recommendations.csv"
    summary_path = output_dir / "portfolio_pool_summary.csv"
    metadata_path = output_dir / "forecast_integration_summary.json"
    pool_recs.to_csv(rec_path, index=False)
    summary.to_csv(summary_path, index=False)
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return {"portfolio_recommendations": rec_path, "portfolio_summary": summary_path, "forecast_summary": metadata_path}
