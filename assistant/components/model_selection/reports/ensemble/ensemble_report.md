# Licence demand ensemble: model comparison and selection

Target: future peak demand on a shared licence pool (`target_portfolio_peak_demand`), 1–6 months ahead. Dataset as of 2026-09-30.

**Selected: Ensemble: stacked weights.** Lowest walk-forward CV MAE: 1.222 licences, 0.4% below the next candidate (Histogram gradient boosting, 1.227). 3 candidates are within one fold standard deviation, so the margin is small.

Selection rule (fixed in advance): Lowest row-weighted walk-forward CV MAE. Ensembles compete on equal terms (composition learned from earlier folds only). Tests never used for selection.

## Verdict on tests the selection never saw: **PASS**

- PASS - Beats the best simple rule out of time: MAE 1.263 vs 2.958 (Rule: planned load × learned licences-per-load), 57.3% better (need ≥ 10%)
- PASS - No overfitting: out-of-time error close to CV: test A MAE 1.263 vs CV 1.222 (+3.3%; allowed ±15%)
- PASS - Generalises to unseen pools and months: test C MAE 1.064 vs CV 1.222 (-12.9%; allowed ±15%)
- PASS - P90 is calibrated out of time: actual ≤ P90 in 85.8% of rows (target 85–95%)
- PASS - Licence counts are usable: within ±2 licences for 87.7% (need ≥ 70%)
- PASS - Shortages are detected: AUC 0.949 (need ≥ 0.85); last-30-day rule 0.781

## Walk-forward cross-validation (development pools, labels closed by as_of)

| Rank | Model | CV MAE | Fold std | WAPE | Within ±2 | Fold MAEs |
|---|---|---|---|---|---|---|
| 1 | Ensemble: stacked weights (selected) | 1.222 | 0.044 | 17.3% | 88.6% | 1.263, 1.208, 1.214, 1.156 |
| 2 | Histogram gradient boosting | 1.227 | 0.037 | 17.4% | 88.3% | 1.253, 1.221, 1.223, 1.164 |
| 3 | Ensemble: mean of top 3 | 1.228 | 0.039 | 17.4% | 88.6% | 1.263, 1.219, 1.220, 1.167 |
| 4 | Ridge regression | 1.245 | 0.032 | 17.7% | 88.0% | 1.267, 1.245, 1.239, 1.191 |
| 5 | Random forest | 1.281 | 0.054 | 18.2% | 87.4% | 1.341, 1.268, 1.252, 1.211 |
| 6 | Extra trees | 1.285 | 0.054 | 18.2% | 87.6% | 1.349, 1.262, 1.259, 1.223 |
| 7 | Single decision tree (depth 10) | 1.435 | 0.052 | 20.4% | 82.7% | 1.493, 1.425, 1.405, 1.368 |
| 8 | Poisson GLM | 1.467 | 0.077 | 20.8% | 84.7% | 1.554, 1.438, 1.436, 1.368 |
| 9 | k-nearest neighbours (k=30) | 1.502 | 0.064 | 21.3% | 83.5% | 1.582, 1.466, 1.475, 1.434 |
| 10 | Rule: planned load × learned licences-per-load | 3.135 | 0.085 | 44.5% | 53.6% | 3.202, 3.035, 3.147, 3.227 |
| 11 | Rule: pool peak of the last 30 days | 3.212 | 0.495 | 45.6% | 53.2% | 3.457, 3.341, 3.067, 2.353 |

## Tests (scored once, after selection)

### A_out_of_time: Known pools; forecasts made on or before 30 Sep 2026 for months after it (9,676 rows)

| Model | MAE | WAPE | Within ±2 | Gap vs CV | Rank |
|---|---|---|---|---|---|
| Ensemble: mean of top 3 | 1.258 | 17.8% | 88.1% | +2.4% | 1 |
| Ensemble: stacked weights (selected) | 1.263 | 17.8% | 87.7% | +3.3% | 2 |
| Extra trees | 1.277 | 18.0% | 88.0% | -0.6% | 3 |
| Random forest | 1.277 | 18.0% | 88.2% | -0.4% | 4 |
| Histogram gradient boosting | 1.279 | 18.0% | 87.1% | +4.3% | 5 |
| Ridge regression | 1.284 | 18.1% | 87.6% | +3.1% | 6 |
| Single decision tree (depth 10) | 1.417 | 20.0% | 84.0% | -1.3% | 7 |
| Poisson GLM | 1.484 | 20.9% | 84.6% | +1.1% | 8 |
| k-nearest neighbours (k=30) | 1.499 | 21.1% | 83.7% | -0.2% | 9 |
| Rule: planned load × learned licences-per-load | 2.958 | 41.7% | 56.6% | -5.6% | 10 |
| Rule: pool peak of the last 30 days | 3.495 | 49.3% | 47.8% | +8.8% | 11 |

P90 coverage 85.8%; shortage AUC 0.949 (rule 0.781); Brier 0.062.

### B_unseen_pools: Pools held out of training (dataset test split); months up to 30 Sep 2026 (8,454 rows)

| Model | MAE | WAPE | Within ±2 | Gap vs CV | Rank |
|---|---|---|---|---|---|
| Ensemble: stacked weights (selected) | 1.191 | 16.7% | 88.5% | -2.5% | 1 |
| Ensemble: mean of top 3 | 1.202 | 16.8% | 88.3% | -2.2% | 2 |
| Histogram gradient boosting | 1.212 | 17.0% | 87.9% | -1.2% | 3 |
| Ridge regression | 1.216 | 17.0% | 88.3% | -2.3% | 4 |
| Random forest | 1.242 | 17.4% | 87.5% | -3.1% | 5 |
| Extra trees | 1.247 | 17.4% | 87.8% | -3.0% | 6 |
| Poisson GLM | 1.376 | 19.2% | 87.1% | -6.2% | 7 |
| Single decision tree (depth 10) | 1.380 | 19.3% | 85.2% | -3.8% | 8 |
| k-nearest neighbours (k=30) | 1.453 | 20.3% | 85.0% | -3.2% | 9 |
| Rule: planned load × learned licences-per-load | 3.015 | 42.2% | 55.4% | -3.8% | 10 |
| Rule: pool peak of the last 30 days | 3.603 | 50.4% | 50.5% | +12.2% | 11 |

P90 coverage 87.8%; shortage AUC 0.971 (rule 0.770); Brier 0.051.

### C_unseen_pools_out_of_time: Held-out pools AND months after 30 Sep 2026 (strictest) (1,485 rows)

| Model | MAE | WAPE | Within ±2 | Gap vs CV | Rank |
|---|---|---|---|---|---|
| Ensemble: stacked weights (selected) | 1.064 | 16.1% | 90.2% | -12.9% | 1 |
| Histogram gradient boosting | 1.073 | 16.2% | 90.1% | -12.5% | 2 |
| Ensemble: mean of top 3 | 1.083 | 16.4% | 89.7% | -11.8% | 3 |
| Ridge regression | 1.097 | 16.6% | 89.8% | -11.9% | 4 |
| Random forest | 1.144 | 17.3% | 89.4% | -10.7% | 5 |
| Extra trees | 1.145 | 17.3% | 89.4% | -10.9% | 6 |
| k-nearest neighbours (k=30) | 1.199 | 18.1% | 91.0% | -20.1% | 7 |
| Single decision tree (depth 10) | 1.225 | 18.5% | 88.9% | -14.6% | 8 |
| Poisson GLM | 1.299 | 19.6% | 89.2% | -11.5% | 9 |
| Rule: planned load × learned licences-per-load | 3.369 | 50.9% | 47.2% | +7.4% | 10 |
| Rule: pool peak of the last 30 days | 3.488 | 52.7% | 52.2% | +8.6% | 11 |

P90 coverage 94.5%; shortage AUC 0.982 (rule 0.734); Brier 0.043.

## Ensemble composition

- Top-3 mean: hist_gbm, ridge, random_forest
- Stacked weights: ridge 0.38, poisson_glm 0.07, knn 0.06, hist_gbm 0.49

## Pool output

466 pools forecast for 2026-10 to 2027-03. Risk rules:

- **High**: probability that peak demand exceeds licences owned is 50% or more
- **Medium**: probability between 20% and 50%
- **Low**: probability between 5% (the dataset's risk tolerance) and 20%
- **None**: probability below 5%

All data and prices are synthetic (dataset v3). Savings are *possible*, not confirmed.