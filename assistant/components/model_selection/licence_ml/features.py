"""
Model inputs, mapped to the requested feature list (numbers 1-43).

Feature sets compared in the improvement experiments:
  core         dataset columns for the priority features
  engineered   core + derived features (27, 28, 36, 38 and ratios)
  +capacity    engineered + licence availability/cost features (13-16). Measured, but never used
               for the demand model: supply must not change predicted demand in a what-if.

Columns that the dataset does not have yet (requests, denials, sessions, idle time, hour/day
patterns) are listed in OPTIONAL and are picked up automatically when a future dataset has them.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as C

CATEGORICAL = ["software_id", "department", "project_priority", "plan_phase_at_cutoff", "plan_phase_in_target_month"]

CORE_NUMERIC = [
    # 5, 6  usage history of this project and of the whole pool
    "obs_peak_last_month", "obs_peak_max_so_far", "obs_peak_mean_so_far", "obs_peak_trend",
    "obs_actual_vs_plan_ratio", "obs_peak_per_plan_load_last", "portfolio_peak_last_30d", "portfolio_peak_last_90d",
    # 22-26, 29  project plan
    "team_size", "n_software_in_project", "software_need_weight", "has_design_review_sprint", "deadline_months",
    "plan_phase_intensity_target", "plan_load_index_target", "plan_expected_users_target", "plan_peak_load_target",
    "plan_max_phase_intensity_target", "plan_n_phases_target", "plan_load_last_observed_month",
    "plan_load_change_vs_last_month", "est_target_peak_from_last_ratio",
    # 27, 29  other projects on the same pool
    "portfolio_other_active_projects_target", "portfolio_planned_load_target", "portfolio_other_planned_load_target",
    # 34, 35, 37  time and planned periods
    "months_elapsed_at_cutoff", "months_remaining_to_deadline", "forecast_after_months", "target_month_index",
    "target_calendar_month", "target_working_days", "target_pct_of_project_elapsed", "is_final_planned_month",
    "months_need_from_target_to_deadline",
]
ENGINEERED_NUMERIC = [
    "ongoing_projects_at_cutoff", "ongoing_same_software_at_cutoff",          # 27 (derived from plans)
    "planned_future_projects_6m", "future_same_software_by_target",           # 28
    "hist_month_peak_index",                                                  # 36 learned on training rows
    "phase_demand_ratio", "phase_est_own_peak", "phase_est_pool_peak",        # 38 learned on training rows
    "pool_load_per_active_project", "pool_load_change_vs_recent_peak", "cold_start",
]
CAPACITY_NUMERIC = [   # 13-16 (+ renewal timing)
    C.OWNED, "portfolio_headroom_last_30d", "portfolio_planned_load_to_owned_ratio",
    "months_to_next_renewal", "target_month_after_next_renewal",
]
OPTIONAL = {   # requested features the dataset does not contain yet -> used automatically when present
    4: "active_licences_last_month", 7: "successful_requests_last_month", 8: "denied_requests_last_month",
    9: "sessions_last_month", 10: "avg_session_hours_last_month", 11: "idle_session_hours_last_month",
    12: "utilisation_pct_last_month", 32: "peak_hour_share_last_month", 33: "weekday_peak_share_last_month",
}

FEATURE_GROUPS = {
    "Pool and project usage history": ["obs_peak_last_month", "obs_peak_max_so_far", "obs_peak_mean_so_far",
        "obs_peak_trend", "obs_actual_vs_plan_ratio", "obs_peak_per_plan_load_last", "portfolio_peak_last_30d",
        "portfolio_peak_last_90d", "plan_phase_at_cutoff", "plan_load_last_observed_month",
        "est_target_peak_from_last_ratio", "pool_load_change_vs_recent_peak", "cold_start",
        "hist_month_peak_index"] + list(OPTIONAL.values()),
    "Planned workload on the pool": ["portfolio_other_active_projects_target", "portfolio_planned_load_target",
        "portfolio_other_planned_load_target", "ongoing_projects_at_cutoff", "ongoing_same_software_at_cutoff",
        "planned_future_projects_6m", "future_same_software_by_target", "pool_load_per_active_project",
        "phase_est_pool_peak"],
    "This project's plan": ["plan_phase_in_target_month", "plan_phase_intensity_target", "plan_load_index_target",
        "plan_expected_users_target", "plan_peak_load_target", "plan_max_phase_intensity_target",
        "plan_n_phases_target", "plan_load_change_vs_last_month", "phase_demand_ratio", "phase_est_own_peak",
        "team_size", "n_software_in_project", "software_need_weight", "has_design_review_sprint", "project_priority",
        "department"],
    "Software": ["software_id"] + CAPACITY_NUMERIC,
    "Timing": ["deadline_months", "months_elapsed_at_cutoff", "months_remaining_to_deadline", "forecast_after_months",
               "target_month_index", "target_calendar_month", "target_working_days", "target_pct_of_project_elapsed",
               "is_final_planned_month", "months_need_from_target_to_deadline"],
}

# requested feature list -> what the dataset provides (reported in reports/feature_map.csv)
FEATURE_MAP = [
    (1, "Timestamp / date and time", "partial", "cutoff_date, target_month_start (monthly, not timestamped)"),
    (2, "Software name", "used", "software_id (+ name from lookup)"),
    (3, "Licence feature / pool ID", "used", "pool = portfolio_id x software_id (split/CV group)"),
    (4, "Number of active licences", "missing", "optional column active_licences_last_month"),
    (5, "Peak concurrent licence usage", "used", "obs_peak_*, portfolio_peak_last_30d/90d"),
    (6, "Average concurrent licence usage", "partial", "obs_peak_mean_so_far (mean of monthly peaks)"),
    (7, "Successful licence requests", "missing", "optional column successful_requests_last_month"),
    (8, "Denied licence requests", "missing", "optional column denied_requests_last_month"),
    (9, "Software sessions", "missing", "optional (not in prototype priority)"),
    (10, "Average session duration", "missing", "optional (not in prototype priority)"),
    (11, "Idle session duration", "missing", "optional (not in prototype priority)"),
    (12, "Historical utilisation %", "missing", "optional (not in prototype priority)"),
    (13, "Total licences owned", "used (supply)", "licences_owned_for_software, lookup: shortage/cost, not demand input"),
    (14, "Licences available", "derived (supply)", "portfolio_headroom_last_30d = owned - recent pool peak"),
    (15, "Licence type", "used (supply)", "licence_inventory.license_type (all Concurrent)"),
    (16, "Licence expiry date", "used (supply)", "licence_inventory renewal/support_end, months_to_next_renewal"),
    (17, "Licence renewal date", "used (simulation)", "licence_inventory.renewal_date"),
    (18, "Cost per licence", "used (simulation)", "software_lookup annual / monthly / temporary price"),
    (19, "Total licence expenditure", "used (simulation)", "licences owned x annual price"),
    (20, "Licence pool capacity", "used (supply)", "licences_owned_for_software"),
    (21, "Project ID", "used", "project_id (grouping only, never an input)"),
    (22, "Project start date", "used", "months_elapsed_at_cutoff, target_pct_of_project_elapsed"),
    (23, "Project end date", "used", "deadline_months, months_remaining_to_deadline, is_final_planned_month"),
    (24, "Project phase", "used", "plan_phase_at_cutoff, plan_phase_in_target_month, phase intensities"),
    (25, "Engineers assigned", "used", "team_size"),
    (26, "Software required per project", "used", "software_id, n_software_in_project, software_need_weight"),
    (27, "Ongoing projects", "used + derived", "portfolio_other_active_projects_target, ongoing_*_at_cutoff"),
    (28, "Planned future projects", "derived", "planned_future_projects_6m, future_same_software_by_target"),
    (29, "Expected project workload", "used", "plan_load_index_target, plan_peak_load_target, portfolio_planned_load_target"),
    (30, "Planned simulation jobs / tasks", "partial", "plan_phase_in_target_month = Analysis & Simulation, intensity"),
    (31, "Project priority", "used", "project_priority"),
    (32, "Hour of day", "missing", "monthly data; optional peak_hour_share_last_month"),
    (33, "Day of week", "missing", "monthly data; optional weekday_peak_share_last_month"),
    (34, "Month", "used", "target_calendar_month"),
    (35, "Working day / holiday", "used", "target_working_days"),
    (36, "Historical peak-demand periods", "used + derived", "portfolio_peak_last_30d/90d, hist_month_peak_index"),
    (37, "Planned project start/end periods", "used", "months_remaining_to_deadline, months_need_from_target_to_deadline"),
    (38, "Demand in similar project phases", "derived", "phase_demand_ratio (learned on training rows only)"),
    (39, "TARGET future peak demand", "target", C.TARGET),
    (40, "TARGET future average demand", "missing", "no pool-level average in the dataset"),
    (41, "TARGET future utilisation %", "derived", "forecast peak / licences owned"),
    (42, "TARGET future shortage indicator", "derived", f"P(forecast > owned); checked against {C.SHORTFALL_FLAG}"),
    (43, "TARGET future shortage quantity", "derived", f"E[max(0, forecast - owned)]; checked against {C.SHORTFALL_QTY}"),
]


class FeatureBuilder:
    def __init__(self, feature_set: str = "engineered"):
        assert feature_set in ("core", "engineered", "capacity")
        self.feature_set = feature_set
        self.month_index: dict = {}
        self.phase_ratio: dict = {}
        self.sw_ratio: dict = {}
        self.global_ratio = 1.0
        self.levels: dict = {}
        self.optional: list[str] = []

    @property
    def columns(self) -> list[str]:
        cols = CATEGORICAL + CORE_NUMERIC + self.optional
        if self.feature_set in ("engineered", "capacity"):
            cols += ENGINEERED_NUMERIC
        if self.feature_set == "capacity":
            cols += CAPACITY_NUMERIC
        return cols

    def fit(self, df: pd.DataFrame) -> "FeatureBuilder":
        """Learn the two history-based encodings from TRAINING rows only (36 and 38)."""
        self.optional = [c for c in OPTIONAL.values() if c in df.columns]
        hist_month = (df["cutoff_date"] - pd.Timedelta(days=15)).dt.month
        g = df.assign(m=hist_month).groupby(["software_id", "m"])["portfolio_peak_last_30d"].mean()
        sw_mean = df.groupby("software_id")["portfolio_peak_last_30d"].mean()
        self.month_index = {k: float(v / max(sw_mean[k[0]], 1e-6)) for k, v in g.items()}
        # licences actually needed per unit of planned load, by software and phase (shrunk to software level)
        d = df[df["plan_load_index_target"] > 0]
        sw = d.groupby("software_id").agg(n=("target_licences_required", "sum"), l=("plan_load_index_target", "sum"))
        self.sw_ratio = (sw["n"] / sw["l"]).to_dict()
        self.global_ratio = float(d["target_licences_required"].sum() / d["plan_load_index_target"].sum())
        ph = d.groupby(["software_id", "plan_phase_in_target_month"]).agg(
            n=("target_licences_required", "sum"), l=("plan_load_index_target", "sum"), k=("plan_load_index_target", "size"))
        prior = 50.0
        self.phase_ratio = {key: float((r.n + prior * self.sw_ratio[key[0]] * (r.l / r.k)) / (r.l + prior * (r.l / r.k)))
                            for key, r in ph.iterrows()}
        X = self._derive(df)
        self.levels = {c: sorted(X[c].dropna().astype(str).unique()) for c in CATEGORICAL}
        return self

    def transform(self, df: pd.DataFrame) -> pd.DataFrame:
        X = self._derive(df)
        for c in self.columns:
            if c not in X:
                X[c] = np.nan
        X = X[self.columns].copy()
        for c in CATEGORICAL:
            X[c] = pd.Categorical(X[c].astype(str), categories=self.levels[c])
        for c in X.columns:
            if c not in CATEGORICAL:
                X[c] = pd.to_numeric(X[c], errors="coerce").astype(float)
        return X

    def _derive(self, df: pd.DataFrame) -> pd.DataFrame:
        X = df.copy()
        if self.feature_set == "core":
            return X
        m = (X["cutoff_date"] - pd.Timedelta(days=15)).dt.month
        X["hist_month_peak_index"] = [self.month_index.get((s, mm), 1.0) for s, mm in zip(X["software_id"], m)]
        X["phase_demand_ratio"] = [self.phase_ratio.get((s, p), self.sw_ratio.get(s, self.global_ratio))
                                   for s, p in zip(X["software_id"], X["plan_phase_in_target_month"])]
        X["phase_est_own_peak"] = X["phase_demand_ratio"] * X["plan_load_index_target"]
        swr = X["software_id"].map(self.sw_ratio).fillna(self.global_ratio)
        X["phase_est_pool_peak"] = swr * X["portfolio_planned_load_target"]
        X["pool_load_per_active_project"] = X["portfolio_planned_load_target"] / (X["portfolio_other_active_projects_target"] + 1)
        X["pool_load_change_vs_recent_peak"] = X["phase_est_pool_peak"] - X["portfolio_peak_last_30d"]
        X["cold_start"] = (X["months_elapsed_at_cutoff"] == 0).astype(float)
        return X

    def group_of(self, feature: str) -> str:
        for g, feats in FEATURE_GROUPS.items():
            if feature in feats:
                return g
        return "Timing"
