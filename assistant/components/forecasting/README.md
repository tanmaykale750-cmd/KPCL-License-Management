# KPCL licence intelligence — future peak demand (XGBoost) + Monte Carlo

This project trains an XGBoost model on the v3 dataset (`dataset/licence_cost_forecast_v3/`).
The model predicts **target 39, future peak licence demand**: how many licences a shared pool
needs at the same time, 1–6 months ahead. It then derives three more targets:

- **41**: utilisation
- **42**: shortage indicator
- **43**: shortage quantity

A Monte Carlo simulation of every licence pool uses the dataset's own prices, renewal dates and
assumptions to recommend actions. No sample or invented data is used.

## Commands

```bash
pip install -r requirements.txt

python run_training.py          # train + improve + test on 20% of pools, prints PASS/FAIL  (~10-20 min)
python run_training.py --quick  # faster: 3 folds, 6 tuning trials
python tests/test_pipeline.py   # 9 checks (run after training)
python run_simulation.py        # Monte Carlo for every pool, as of 2026-09-30 (dataset as_of_date)
python run_simulation.py --portfolios PF001,PF007 --date 2026-12-01
uvicorn api:app --reload        # optional API: http://127.0.0.1:8000/docs
```

**Where to look for accuracy:** `reports/accuracy_report.md` (readable summary and verdict),
`reports/holdout_predictions.csv` (every test row with actual vs forecast) and `reports/charts/`.

## Requested features vs this dataset

The full table is in `reports/feature_map.csv`. In summary:

| Status | Features |
|---|---|
| Used directly | 2, 3, 5, 13, 15, 16, 21–27, 29, 31, 34–37 |
| Derived by the code | 14 (owned − recent pool peak), 27/28 (ongoing and planned projects from plan dates), 36 (historical peak by calendar month), 38 (licences per unit of planned load in each phase; learned on training rows only) |
| Partial | 1 (monthly dates, not timestamps), 6 (mean of monthly peaks), 30 (simulation phase) |
| Not in this dataset | 4, 7, 8, 9–12, 32, 33, 40 |

Missing features are read automatically when a future dataset adds them. The column names are
in `licence_ml/features.py` → `OPTIONAL`, for example `denied_requests_last_month`.

**Rules the code enforces:**

- **No future observations as inputs.** Every `target_*` column holding an actual future
  observation is excluded, and a test checks this. Columns that only *describe* the predicted
  month, such as `target_calendar_month`, are allowed as inputs.
- **Capacity (13–16) is not a demand input.** These features are used for 41–43, shortage and
  cost. As a model input they made no material difference (CV MAE 1.187 vs 1.189). They are also
  kept out so that a what-if like "add 2 licences" cannot change predicted demand.

## How it is trained and tested

1. **Data checks.** Keys, target, shortfall consistency, history blank only at cold start,
   prediction date before the predicted month, owned licences match the lookup.
2. **Hold out 20% of portfolios (15 of 75 licence pools).** A shared pool never appears in both
   training and test.
3. **Improvement experiments** on the other 60 pools, using 5-fold cross-validation grouped by
   pool. A step is kept only if CV error drops:
   - simple rules (pool peak of the last 30/90 days)
   - core features
   - engineered features
   - capacity features (measured only)
   - sample weights
   - loss function
   - 16 tuning trials
4. **Final model, P10/P50/P90 model and conformal calibration.**
5. **One test on the held-out pools.** It must pass all six checks, which were fixed before
   testing.

## Results (built with the scikit-learn fallback)

XGBoost could not be installed in the build environment. `run_training.py` with XGBoost repeats
everything and overwrites these numbers.

**Verdict: PASS** on 15 unseen pools (20,066 rows).

| Target 39: pool peak | Model | Pool peak of last 30 days |
|---|---|---|
| MAE (licences) | **1.16** | 3.26 |
| WAPE | 17% | 48% |
| R² | 0.83 | −0.17 |
| Within ±1 / ±2 licences | 74% / **89%** | 35% / 52% |

- **No overfitting:** hold-out MAE 1.159 vs cross-validation 1.155.
- **P90 calibration:** P90 covers 88.9% of rows (target 85–95%).

| Derived target | Model | Simple rule |
|---|---|---|
| 41 utilisation error | 10.7 points | 30.3 |
| 42 shortage AUC | **0.970** | 0.801 |
| 42 precision / recall | 81% / 70% | 46% / 36% |
| 42 recall with the P90 high case | 98% | |
| 43 shortage quantity MAE | 0.39 licences | 0.76 |

Improvement ladder (CV MAE):

- core 1.192
- engineered 1.189
- weights 1.188
- absolute-error loss 1.161
- tuned **1.155**

## Simulation

- **Rows used.** For each pool, as of the planning date, the simulation takes forecasts from
  each project's latest cut-off, or plan-only rows for projects not yet started. Rows in the
  same calendar month are combined, since each one forecasts the pool's peak.
- **Futures drawn.** It draws 4,000 futures from the calibrated P10/P50/P90. These are
  correlated month to month and across software, with both correlations measured from
  out-of-fold errors.
- **Per pool, software and month it reports:**
  - utilisation (41)
  - shortage probability (42)
  - expected shortage (43)
  - licences needed at the 5% risk tolerance + 1 buffer
  - expected idle licences and their monthly cost
- **Options for pools at risk:**
  - temporary licences
  - annual purchase
  - delaying a not-yet-started, non-high-priority project by 1–2 months. This re-computes the
    pool's planned load and re-runs the model.
- **Choosing.** The cheapest option that keeps every month within tolerance wins. Pools with no
  risk and spare licences before their renewal are flagged as candidates to reduce.

All prices, renewal dates and thresholds come from `lookups/software_lookup.csv`,
`source_inputs/licence_inventory.csv` and `source_inputs/assumptions.csv`. The dataset marks
these as synthetic, so savings are labelled **"Possible"**, not "Confirmed". The dataset treats
each portfolio as its own pool with the full licence count, and the code follows that convention.
