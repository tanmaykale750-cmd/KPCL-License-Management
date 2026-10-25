"""
make_efficient_dataset.py  -  turns the v1 forecast dataset into the lean ML-ready v2 (SYNTHETIC data).
Usage: python make_efficient_dataset.py <v1_dataset.csv> <licence_inventory.csv> <assumptions.csv> <out_dir>
Changes vs v1: removed constants / exact duplicates / deterministic multiples of the target, per-software prices
moved to lookups/software_lookup.csv, zero-need class merged, binary cost label, per-project sample weights, compact dtypes.
"""
import sys, json
from pathlib import Path
import numpy as np, pandas as pd

v1, inv_p, asm_p, out = sys.argv[1], sys.argv[2], sys.argv[3], Path(sys.argv[4])
df = pd.read_csv(v1)
inv = pd.read_csv(inv_p); asm = pd.read_csv(asm_p).set_index("assumption_key").value
mult = float(asm["temporary_licence_monthly_multiplier"])

# ---- lookup table: everything that depends only on software_id ----
lk = inv[["software_id","software_name","category","vendor","usable_licenses","annual_cost_per_license_inr"]].copy()
lk.columns = ["software_id","software_name","software_category","vendor","licences_owned","annual_cost_per_licence_inr"]
lk["monthly_cost_per_licence_inr"] = (lk.annual_cost_per_licence_inr/12).round(2)
lk["temporary_monthly_cost_per_licence_inr"] = (lk.monthly_cost_per_licence_inr*mult).round(2)
lk["temporary_multiplier"] = mult
lk["breakeven_months_temp_vs_annual"] = round(12/mult, 2)
lk["cost_data_status"] = "Synthetic planning assumption (savings = Possible, not Confirmed)"
(out/"lookups").mkdir(parents=True, exist_ok=True); (out/"data").mkdir(parents=True, exist_ok=True)
lk.to_csv(out/"lookups"/"software_lookup.csv", index=False)

# ---- cost targets (computed once, from the lookup) ----
price = df.software_id.map(lk.set_index("software_id").annual_cost_per_licence_inr)
n = df.target_licences_required
monthly = price/12
buy = n*price
temp = n*monthly*mult*df.months_need_from_target_to_deadline
df["target_monthly_licence_cost_inr"]  = (n*monthly).round(0).astype("int32")
df["target_cost_optimal_inr"]          = np.minimum(buy, temp).round(0).astype("int32")
# NOTE: buy-vs-temporary is NOT stored as a label: it is a deterministic rule of months_need (>= 7.5 months -> buy annual), so a model would only rediscover the rule.
# requirement class: zero merged into Low (only 0.04% of rows were zero)
df["target_requirement_class"] = pd.cut(n, [-1,2,5,100], labels=["Low(0-2)","Medium(3-5)","High(6+)"]).astype(str)
# sample weight: every project carries equal total weight (long projects have up to 228 rows, short ones 6)
w = 1.0/df.groupby("project_id").project_id.transform("size")
df["sample_weight"] = (w/w.mean()).round(4)

drop = ["software_name","software_category",                       # in lookup
        "annual_cost_per_licence_inr","monthly_cost_per_licence_inr","temporary_monthly_cost_per_licence_inr",
        "owned_licences_monthly_cost_inr","target_exceeds_owned_licences",
        "breakeven_months_temp_vs_annual","cost_data_status",       # constants
        "obs_months_observed",                                     # exact duplicate of months_elapsed_at_cutoff
        "cost_buy_annual_inr","cost_temporary_until_deadline_inr","target_cost_temporary_month_inr",
        "saving_vs_other_option_inr","target_avg_monthly_licence_cost_inr","cost_optimal_option"]  # multiples / derived from target
df = df.drop(columns=drop)

# ---- tidy new context features ----
df["obs_peak_per_plan_load_last"]   = df.obs_peak_per_plan_load_last.clip(upper=10)        # tiny plan loads give huge ratios -> winsorise
df["est_target_peak_from_last_ratio"] = df.est_target_peak_from_last_ratio.clip(upper=30)
df["portfolio_other_planned_load_target"] = df.portfolio_other_planned_load_target.clip(lower=0)
for c in ["target_shortfall_cost_optimal_inr","target_idle_licence_cost_month_inr"]: df[c] = df[c].round(0).astype("int32")
# ---- compact dtypes ----
for c in df.select_dtypes("float64"): df[c] = df[c].astype("float32")
for c in df.select_dtypes("int64"):
    if c not in ("target_monthly_licence_cost_inr","target_cost_optimal_inr","target_shortfall_cost_optimal_inr","target_idle_licence_cost_month_inr"): df[c] = pd.to_numeric(df[c], downcast="integer")
front = ["row_id","project_id","portfolio_id","split","sample_weight"]
df = df[front + [c for c in df.columns if c not in front]]
df.to_csv(out/"data"/"licence_cost_forecast_dataset_v3.csv", index=False, float_format="%.4g")

NEW = ["plan_peak_load_target","plan_max_phase_intensity_target","plan_n_phases_target","plan_load_last_observed_month","obs_peak_per_plan_load_last",
       "plan_load_change_vs_last_month","est_target_peak_from_last_ratio","portfolio_other_active_projects_target","portfolio_planned_load_target",
       "portfolio_other_planned_load_target","portfolio_peak_last_30d","portfolio_peak_last_90d","months_to_next_renewal","target_month_after_next_renewal",
       "portfolio_headroom_last_30d","portfolio_planned_load_to_owned_ratio","licences_owned_for_software"]
# ---- ML config: what to feed / predict / never feed ----
targets = ["target_licences_required","target_monthly_licence_cost_inr","target_cost_optimal_inr",
           "target_requirement_class","target_avg_daily_peak",
           "target_portfolio_peak_demand","target_portfolio_shortfall_licences","target_portfolio_shortfall_flag",
           "target_shortfall_cost_optimal_inr","target_idle_licence_cost_month_inr"]
ids_dates = ["row_id","project_id","portfolio_id","split","sample_weight","project_start_date","project_deadline_date","cutoff_date","target_month_start"]
features = [c for c in df.columns if c not in targets + ids_dates]
DESCRIPTORS = {"target_month_index","target_calendar_month","target_working_days","target_pct_of_project_elapsed","target_month_start","target_month_after_next_renewal"}
leaky = [c for c in features if c.startswith("target_") and c not in DESCRIPTORS] + [c for c in features if c.startswith("cost_")]
assert not leaky, f"target-derived columns in feature list: {leaky}"
cfg = dict(features=features,
           categorical_features=[c for c in features if pd.api.types.is_string_dtype(df[c])],
           targets=dict(licence_count="target_licences_required (regression)", licence_class="target_requirement_class (classification)",
                        monthly_cost="target_monthly_licence_cost_inr (regression)", optimal_cost="target_cost_optimal_inr (regression)",
                        portfolio_peak="target_portfolio_peak_demand (regression, licences needed on the shared pool)",
                        shortfall="target_portfolio_shortfall_licences (regression) / target_portfolio_shortfall_flag (binary)",
                        shortfall_cost="target_shortfall_cost_optimal_inr (regression)", idle_cost="target_idle_licence_cost_month_inr (regression)"),
           cost_rule=dict(buy_annual_cost="licences x annual_cost_per_licence_inr", temporary_cost="licences x temporary_monthly_cost_per_licence_inr x months_need_from_target_to_deadline",
                          choose="buy annual if months_need_from_target_to_deadline >= breakeven_months_temp_vs_annual (7.5), else temporary; prices in lookups/software_lookup.csv"),
           never_use_as_features=targets + ids_dates,
           group_column="portfolio_id", split_column="split", weight_column="sample_weight",
           note="Split by portfolio (all projects of a portfolio share a split). Software prices/owned licences live in lookups/software_lookup.csv (join on software_id).")
cfg["new_in_v3_features"] = [c for c in features if c in set(NEW)]
(out/"ml_config.json").write_text(json.dumps(cfg, indent=2))
print(df.shape, "features:", len(features))
