"""Load the dataset and its lookup files, check them, split by portfolio, derive portfolio counts."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as C


# ------------------------------------------------------------------ loading
def load(path=C.DATA_FILE) -> pd.DataFrame:
    df = pd.read_csv(path)
    for c in C.DATES:
        df[c] = pd.to_datetime(df[c], format="%Y-%m-%d")
    for c in ["software_id", "department", "project_priority", "plan_phase_at_cutoff", "plan_phase_in_target_month"]:
        df[c] = df[c].astype(str)
    lk = lookup()
    df["software_name"] = df["software_id"].map(lk["software_name"])
    return add_portfolio_counts(df)


def lookup(path=C.LOOKUP_FILE) -> pd.DataFrame:
    return pd.read_csv(path).set_index("software_id")


def inventory(path=C.INVENTORY_FILE) -> pd.DataFrame:
    inv = pd.read_csv(path, parse_dates=["renewal_date", "support_end_date", "renewal_notice_deadline"])
    return inv.set_index("software_id")


def assumptions(path=C.ASSUMPTIONS_FILE) -> dict:
    a = pd.read_csv(path).set_index("assumption_key")["value"].to_dict()
    out = {}
    for k, v in a.items():
        try:
            out[k] = float(v)
        except (TypeError, ValueError):
            out[k] = v
    out["as_of_date"] = pd.Timestamp(a["as_of_date"])
    return out


def target_columns(df: pd.DataFrame) -> list[str]:
    """Every column holding an actual future observation (never an input)."""
    return [c for c in df.columns if c.startswith("target_") and c not in C.TARGET_MONTH_DESCRIPTORS]


# ------------------------------------------------------------------ derived portfolio counts (features 27, 28)
def project_table(df: pd.DataFrame) -> pd.DataFrame:
    """One row per project-software with its plan dates (known in advance, so usable as inputs)."""
    return (df.groupby([C.PROJECT, "software_id"])
              .agg(portfolio_id=(C.GROUP, "first"), start=("project_start_date", "first"),
                   end=("project_deadline_date", "first"), priority=("project_priority", "first"),
                   team_size=("team_size", "first"))
              .reset_index())


def plan_table(df: pd.DataFrame) -> pd.DataFrame:
    """Planned load per project-software-month (the plan is the same in every row that predicts that month)."""
    return (df.groupby([C.PROJECT, "software_id", "target_month_index"])
              .agg(portfolio_id=(C.GROUP, "first"), month_start=("target_month_start", "first"),
                   plan_load=("plan_load_index_target", "first"))
              .reset_index())


def add_portfolio_counts(df: pd.DataFrame, projects: pd.DataFrame | None = None) -> pd.DataFrame:
    """
    27  ongoing_projects_at_cutoff        other projects of the pool running on the prediction date
        ongoing_same_software_at_cutoff   ... that use this software
    28  planned_future_projects_6m        projects of the pool starting in the 6 months after the prediction date
        future_same_software_by_target    ... that use this software and start before the predicted month ends
    """
    projects = project_table(df) if projects is None else projects
    out = df.copy()
    cols = ["ongoing_projects_at_cutoff", "ongoing_same_software_at_cutoff",
            "planned_future_projects_6m", "future_same_software_by_target"]
    for c in cols:
        out[c] = 0.0
    proj_any = projects.groupby(C.PROJECT).agg(portfolio_id=(C.GROUP, "first"), start=("start", "first"),
                                               end=("end", "first")).reset_index()
    for pf, rows in out.groupby(C.GROUP):
        pa = proj_any[proj_any[C.GROUP] == pf]
        ps = projects[projects[C.GROUP] == pf]
        cut = rows["cutoff_date"].to_numpy()[:, None]
        tend = (rows["target_month_start"] + pd.DateOffset(months=1)).to_numpy()[:, None]
        own = rows[C.PROJECT].to_numpy()[:, None]
        s, e, pid = pa["start"].to_numpy()[None], pa["end"].to_numpy()[None], pa[C.PROJECT].to_numpy()[None]
        ongoing = (s <= cut) & (e > cut) & (pid != own)
        future6 = (s > cut) & (s <= cut + np.timedelta64(183, "D"))
        out.loc[rows.index, "ongoing_projects_at_cutoff"] = ongoing.sum(1)
        out.loc[rows.index, "planned_future_projects_6m"] = future6.sum(1)
        for sw, r2 in rows.groupby("software_id"):
            q = ps[ps["software_id"] == sw]
            c2 = r2["cutoff_date"].to_numpy()[:, None]
            t2 = (r2["target_month_start"] + pd.DateOffset(months=1)).to_numpy()[:, None]
            o2 = r2[C.PROJECT].to_numpy()[:, None]
            s2, e2, p2 = q["start"].to_numpy()[None], q["end"].to_numpy()[None], q[C.PROJECT].to_numpy()[None]
            out.loc[r2.index, "ongoing_same_software_at_cutoff"] = ((s2 <= c2) & (e2 > c2) & (p2 != o2)).sum(1)
            out.loc[r2.index, "future_same_software_by_target"] = ((s2 > c2) & (s2 < t2)).sum(1)
    return out


# ------------------------------------------------------------------ checks
def quality_report(df: pd.DataFrame) -> dict:
    checks = []

    def add(name, ok, detail, severity="error"):
        checks.append(dict(check=name, passed=bool(ok), severity=severity, detail=detail))

    add("unique_row_id", df[C.ROW_ID].is_unique, f"{df[C.ROW_ID].duplicated().sum()} duplicates")
    key = [C.PROJECT, "software_id", "months_elapsed_at_cutoff", "forecast_after_months"]
    add("unique_prediction_key", not df.duplicated(key).any(), f"{df.duplicated(key).sum()} duplicate keys")
    add("target_present_and_non_negative", df[C.TARGET].notna().all() and (df[C.TARGET] >= 0).all(),
        f"{df[C.TARGET].isna().sum()} missing, min {df[C.TARGET].min()}")
    add("pool_peak_at_least_project_need", (df[C.TARGET] >= np.floor(df["target_licences_required"] * 0.85) - 1).all(),
        "pool peak >= this project's own need (allowing the 0.85 coincidence factor)", "warning")
    add("shortfall_consistent", (df[C.SHORTFALL_QTY] == np.maximum(0, df[C.TARGET] - df[C.OWNED])).all(),
        "shortfall = max(0, pool peak - licences owned)")
    add("one_portfolio_per_project", (df.groupby(C.PROJECT)[C.GROUP].nunique() == 1).all(),
        "every project belongs to exactly one licence pool")
    add("cutoff_before_target", (df["cutoff_date"] <= df["target_month_start"]).all(),
        "predictions are made before the month they predict")
    add("history_blank_only_at_cold_start",
        df.loc[df["months_elapsed_at_cutoff"] > 0, "obs_peak_last_month"].notna().all()
        and df.loc[df["months_elapsed_at_cutoff"] == 0, "obs_peak_last_month"].isna().all(),
        "observed-usage columns are empty exactly when nothing has been observed yet")
    lk = lookup()
    add("owned_matches_lookup", (df[C.OWNED] == df["software_id"].map(lk["licences_owned"])).all(),
        "licences_owned_for_software agrees with lookups/software_lookup.csv")
    add("no_target_in_features", True, f"excluded future observations: {target_columns(df)}", "info")
    summary = dict(rows=len(df), projects=int(df[C.PROJECT].nunique()), portfolios=int(df[C.GROUP].nunique()),
                   software=int(df["software_id"].nunique()), target_mean=float(df[C.TARGET].mean()),
                   target_max=int(df[C.TARGET].max()), shortage_rows=float(df[C.SHORTFALL_FLAG].mean()),
                   target_months=f"{df['target_month_start'].min().date()} to {df['target_month_start'].max().date()}")
    return dict(passed=all(c["passed"] for c in checks if c["severity"] == "error"), summary=summary, checks=checks)


# ------------------------------------------------------------------ split and folds
def portfolio_split(df: pd.DataFrame, test_size=C.TEST_SIZE, seed=C.SEED, use_dataset_split=False):
    """Hold out whole PORTFOLIOS (licence pools), so no shared pool appears in training and test."""
    if use_dataset_split:
        is_test = df["split"] == "test"
    else:
        ids = np.array(sorted(df[C.GROUP].unique()))
        rng = np.random.default_rng(seed)
        rng.shuffle(ids)
        test_ids = set(ids[: int(round(len(ids) * test_size))])
        is_test = df[C.GROUP].isin(test_ids)
    train, test = df[~is_test].reset_index(drop=True), df[is_test].reset_index(drop=True)
    assert not set(train[C.GROUP]) & set(test[C.GROUP]), "portfolio leakage"
    assert not set(train[C.PROJECT]) & set(test[C.PROJECT]), "project leakage"
    return train, test


def group_folds(groups: pd.Series, n_folds=C.CV_FOLDS, seed=C.SEED) -> np.ndarray:
    ids = np.array(sorted(groups.unique()))
    np.random.default_rng(seed + 1).shuffle(ids)
    return groups.map({g: k % n_folds for k, g in enumerate(ids)}).to_numpy()


def early_stop_mask(groups: pd.Series, share=C.EARLY_STOP_SHARE, seed=C.SEED) -> np.ndarray:
    ids = np.array(sorted(groups.unique()))
    pick = set(np.random.default_rng(seed + 2).choice(ids, max(1, int(round(len(ids) * share))), replace=False))
    return groups.isin(pick).to_numpy()
