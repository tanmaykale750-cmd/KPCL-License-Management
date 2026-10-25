"""
Settings. No data or prices live here: they are read from the dataset folder
(data/, lookups/software_lookup.csv, source_inputs/licence_inventory.csv, source_inputs/assumptions.csv).
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET_DIR = ROOT / "dataset" / "licence_cost_forecast_v3"
DATA_FILE = DATASET_DIR / "data" / "licence_cost_forecast_dataset_v3.csv"
LOOKUP_FILE = DATASET_DIR / "lookups" / "software_lookup.csv"
INVENTORY_FILE = DATASET_DIR / "source_inputs" / "licence_inventory.csv"
ASSUMPTIONS_FILE = DATASET_DIR / "source_inputs" / "assumptions.csv"
ARTIFACTS = ROOT / "artifacts"
REPORTS = ROOT / "reports"

# ------------------------------------------------------------------ target (feature 39)
TARGET = "target_portfolio_peak_demand"          # licences the shared pool needs at the same time
GROUP = "portfolio_id"                           # licence pool group: split and CV folds by portfolio
PROJECT = "project_id"
ROW_ID = "row_id"
WEIGHT = "sample_weight"
# actual future observations used only to evaluate the derived targets 41-43
SHORTFALL_QTY = "target_portfolio_shortfall_licences"    # feature 43
SHORTFALL_FLAG = "target_portfolio_shortfall_flag"       # feature 42
OWNED = "licences_owned_for_software"                    # feature 13

# columns that describe the predicted month but start with "target_" (they ARE inputs)
TARGET_MONTH_DESCRIPTORS = {"target_month_index", "target_calendar_month", "target_working_days",
                            "target_pct_of_project_elapsed", "target_month_after_next_renewal"}
DATES = ["project_start_date", "project_deadline_date", "cutoff_date", "target_month_start"]
NEVER_FEATURES = [ROW_ID, PROJECT, GROUP, "split", WEIGHT] + DATES   # + every real target_* column

# ------------------------------------------------------------------ split / validation
SEED = 2026
TEST_SIZE = 0.20             # share of PORTFOLIOS held out for the final test
CV_FOLDS = 5
EARLY_STOP_SHARE = 0.12      # portfolios carved out of each training fold for early stopping
N_TUNING_TRIALS = 16
QUANTILES = (0.1, 0.5, 0.9)

# ------------------------------------------------------------------ acceptance criteria (fixed before testing)
ACCEPTANCE = {
    "min_improvement_vs_best_baseline": 0.10,
    "max_cv_to_holdout_gap": 0.15,          # 15 test portfolios: allow a bit more noise than per-project tests
    "p90_coverage_range": (0.85, 0.95),
    "min_within_2_licences": 0.70,
    "min_shortage_auc": 0.85,               # feature 42 from the forecast vs licences owned
}

# ------------------------------------------------------------------ simulation
N_PATHS = 4000
WINDOW_MONTHS = 6
