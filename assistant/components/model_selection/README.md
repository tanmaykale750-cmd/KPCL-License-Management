# KPCL licence demand: light-model comparison and ensemble (fixed)

This project trains several light models to forecast **future peak licence demand per pool** (target 39), 1–6
months ahead. It compares them fairly on the v3 dataset and **uses the forecast of whichever is most accurate**.

## Run (Windows PowerShell)

```powershell
cd ENSEMBLE_ML
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m pip install lightgbm xgboost      # optional: adds 2 more candidates
python run_ensemble.py                      # full run, about 2 minutes
python run_ensemble.py --quick              # 3 folds, skips RF / extra trees / kNN, about 40 s
```

The dataset is included in `dataset/licence_cost_forecast_v3/`; it is the file from `licence_cost_forecast_v3_final.zip`.

Outputs:

- `reports/ensemble/` holds `ensemble_report.md` (read this first), `leaderboard.csv`, `test_scores.csv`,
  `fold_scores.csv`, `model_comparison.png`, `ml_report.json` and `pool_forecasts.json`.
- `artifacts/ensemble/ensemble_forecaster.pkl` is the saved model.

## Candidates

| Family | Models |
|---|---|
| Rules (baselines to beat) | Last 30-day pool peak; planned load × learned licences-per-load |
| Linear | Ridge regression, Poisson GLM |
| Instance-based | k-nearest neighbours (k = 30) *(new)* |
| Trees | Single decision tree, depth 10 *(new)*; random forest; extra trees |
| Boosting | Histogram gradient boosting; LightGBM and XGBoost (when installed) |
| Ensembles | Mean of the top 3; stacked non-negative weights |

## How overfitting is prevented

1. **Training uses only the past.** It uses labels that closed by the dataset's as-of date (30 Sep 2026).
   Nothing later is trained on.
2. **Walk-forward, purged cross-validation.** There are 4 quarterly folds. Each one trains only on rows whose
   label month closed before the validation window opens.
3. **Fixed, moderate hyperparameters.** There is no search, so the comparison can't be tuned to this dataset.
4. **Fair ensembles.** Ensemble weights are learned only from earlier folds' out-of-fold predictions.
5. **Selection on CV error only.** The model with the lowest CV MAE is chosen. Near-ties within one fold
   standard deviation are reported.
6. **Three tests, each scored once, after selection.**
   - A: known pools, future months.
   - B: unseen pools.
   - C: unseen pools and future months, the strictest.
   - An acceptance check fails if the test error drifts more than 15% from CV.

## Results (full run on this dataset)

| Rank | Model | CV MAE | Test A | Test C |
|---|---|---|---|---|
| 1 | **Ensemble: stacked weights (selected)** | **1.222** | 1.263 | **1.064** |
| 2 | Histogram gradient boosting | 1.227 | 1.279 | 1.073 |
| 3 | Ensemble: mean of top 3 | 1.228 | 1.258 | 1.083 |
| 4 | Ridge regression | 1.245 | 1.284 | 1.097 |
| 5 | Random forest | 1.281 | 1.277 | 1.144 |
| 6 | Extra trees | 1.285 | 1.277 | 1.145 |
| 7 | Decision tree | 1.435 | 1.417 | 1.225 |
| 8 | Poisson GLM | 1.467 | 1.484 | 1.299 |
| 9 | k-nearest neighbours | 1.502 | 1.499 | 1.199 |
| 10 | Rule: planned load | 3.135 | 2.958 | 3.369 |
| 11 | Rule: last 30 days | 3.212 | 3.495 | 3.488 |

MAE is in licences. The selected stacked ensemble weights its members as follows: histogram gradient boosting
0.49, ridge 0.38, Poisson GLM 0.07, kNN 0.06.

**Verdict: PASS (6/6)**

- 57% better than the best simple rule.
- Test A is +3.3% vs CV; test C is −12.9% vs CV.
- P90 coverage is 85.8%.
- 87.7% of forecasts are within ±2 licences.
- Shortage AUC is 0.949.

The top three are within one fold standard deviation of each other, so treat them as near-equal.
