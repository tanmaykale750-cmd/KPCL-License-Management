# Future peak licence demand (target 39) - accuracy report

Backend **sklearn**, features **engineered**, loss **absolute_error**, sample weights **True**

## Verdict on the held-out licence pools: **PASS**

- PASS - Beats the best simple rule: MAE 1.159 vs 3.263 (Pool peak of the last 30 days): +64.5% better (need >= 10%)
- PASS - Generalises to unseen licence pools: hold-out MAE 1.159 vs cross-validation 1.155 (+0.3%; allowed +/-15%)
- PASS - High-demand case (P90) is calibrated: actual <= P90 in 88.9% of rows (target 85%-95%)
- PASS - Licence counts are usable: rounded forecast within +/-2 licences for 89.1% (need >= 70%)
- PASS - Shortages are detected (feature 42): AUC 0.970 (need >= 0.85); simple rule 0.801
- PASS - No pool or project in both training and test: split by portfolio, asserted

## Target 39: pool peak demand

| Metric | Model | Pool peak of the last 30 days | Pool peak of the last 90 days |
|---|---|---|---|
| MAE (licences) | 1.159 | 3.263 | 3.718 |
| RMSE | 1.729 | 4.553 | 5.008 |
| WAPE | 17.1% | 48.3% | 55.0% |
| R2 | 0.831 | -0.173 | -0.419 |
| Exact | 35.1% | 13.5% | 9.9% |
| Within +/-1 | 74.2% | 34.8% | 28.3% |
| Within +/-2 | 89.1% | 52.3% | 44.9% |
| Bias | -0.310 | -0.702 | 0.440 |

P90 coverage 88.9%, P10-P90 coverage 79.8%.

## Derived targets 41-43 (from the forecast vs licences owned)

| Target | Model | Simple rule (last 30 days) |
|---|---|---|
| 41 utilisation, mean error (percentage points) | 10.7 | 30.3 |
| 42 shortage indicator, AUC | 0.970 | 0.801 |
| 42 precision / recall (P >= 50%) | 81.1% / 70.1% | 45.5% / 36.3% |
| 42 recall using the high case (P90) | 97.9% (precision 47.4%) | |
| 43 shortage quantity, MAE (licences) | 0.389 | 0.760 |

### By months ahead

| Group | Rows | MAE | WAPE | Within +/-2 | P90 coverage |
|---|---|---|---|---|---|
| 1 | 5318 | 1.097 | 16.4% | 90.5% | 89.0% |
| 2 | 4500 | 1.152 | 16.8% | 89.4% | 89.2% |
| 3 | 3682 | 1.184 | 17.3% | 88.5% | 89.1% |
| 4 | 2883 | 1.190 | 17.5% | 88.5% | 88.8% |
| 5 | 2151 | 1.214 | 18.2% | 87.9% | 88.2% |
| 6 | 1532 | 1.198 | 18.3% | 87.9% | 88.2% |

### By usage history

| Group | Rows | MAE | WAPE | Within +/-2 | P90 coverage |
|---|---|---|---|---|---|
| plan only | 4285 | 1.158 | 17.2% | 89.1% | 89.3% |
| 1-2 months seen | 7129 | 1.182 | 17.0% | 88.8% | 89.7% |
| 3-5 months seen | 6183 | 1.173 | 17.3% | 88.7% | 88.2% |
| 6+ months seen | 2469 | 1.060 | 17.4% | 91.0% | 87.4% |

### By software

| Group | Rows | MAE | WAPE | Within +/-2 | P90 coverage |
|---|---|---|---|---|---|
| ANSYS Mechanical | 3427 | 1.504 | 16.7% | 82.3% | 89.9% |
| Altair HyperWorks | 2117 | 1.507 | 18.8% | 82.4% | 87.2% |
| AutoCAD | 3128 | 0.767 | 16.9% | 95.8% | 88.7% |
| Autodesk Inventor | 2303 | 0.917 | 16.8% | 94.7% | 86.2% |
| Cadence OrCAD | 1776 | 1.704 | 23.0% | 79.5% | 86.9% |
| MATLAB | 3366 | 1.256 | 14.9% | 86.4% | 90.7% |
| SOLIDWORKS | 1773 | 0.811 | 15.9% | 97.2% | 90.6% |
| Siemens NX | 2176 | 0.784 | 16.4% | 96.2% | 89.3% |

### By actual pool peak

| Group | Rows | MAE | WAPE | Within +/-2 | P90 coverage |
|---|---|---|---|---|---|
| 0-3 licences | 5143 | 0.491 | 19.9% | 99.0% | 95.4% |
| 4-7 | 7525 | 0.986 | 18.2% | 95.1% | 89.8% |
| 8-12 | 5443 | 1.431 | 15.2% | 83.1% | 87.6% |
| 13+ | 1955 | 2.822 | 17.8% | 56.8% | 72.1% |

## Improvement experiments (cross-validation on training pools)

| Step | Experiment | CV MAE | +/- | Within +/-2 | Kept | Note |
|---|---|---|---|---|---|---|
| 0 simple rule | Pool peak of the last 30 days | 3.2979 |  | 52.1% |  |  |
| 0 simple rule | Pool peak of the last 90 days | 3.7425 |  | 45.1% |  |  |
| 1 core features | sklearn, default settings | 1.1915 | 0.0772 | 88.4% | yes |  |
| 2 engineered features | + derived features 27, 28, 36, 38 | 1.1886 | 0.0813 | 88.5% | yes |  |
| 3 capacity features | + licences owned / headroom / renewal (13-16) | 1.1868 | 0.0773 | 88.6% |  | not used: supply must not change predicted demand |
| 4 sample weights | each project weighted equally | 1.1884 | 0.0749 | 88.5% | yes |  |
| 5 loss function | objective = poisson | 1.1820 | 0.0778 | 88.6% | yes |  |
| 5 loss function | objective = absolute_error | 1.1610 | 0.0757 | 88.8% | yes |  |
| 6 hyperparameter search | trial 1: depth 4, eta 0.08, mcw 1 | 1.1613 | 0.0724 | 88.8% |  |  |
| 6 hyperparameter search | trial 2: depth 5, eta 0.05, mcw 20 | 1.1638 | 0.0710 | 88.8% |  |  |
| 6 hyperparameter search | trial 3: depth 8, eta 0.08, mcw 1 | 1.1713 | 0.0743 | 88.5% |  |  |
| 6 hyperparameter search | trial 4: depth 8, eta 0.03, mcw 10 | 1.1589 | 0.0727 | 88.7% | yes |  |
| 6 hyperparameter search | trial 5: depth 6, eta 0.05, mcw 5 | 1.1608 | 0.0726 | 88.8% |  |  |
| 6 hyperparameter search | trial 6: depth 6, eta 0.08, mcw 1 | 1.1673 | 0.0694 | 88.8% |  |  |
| 6 hyperparameter search | trial 7: depth 6, eta 0.03, mcw 20 | 1.1596 | 0.0753 | 88.7% |  |  |
| 6 hyperparameter search | trial 8: depth 6, eta 0.03, mcw 10 | 1.1568 | 0.0729 | 88.9% | yes |  |
| 6 hyperparameter search | trial 9: depth 8, eta 0.08, mcw 5 | 1.1699 | 0.0696 | 88.5% |  |  |
| 6 hyperparameter search | trial 10: depth 6, eta 0.08, mcw 5 | 1.1687 | 0.0740 | 88.6% |  |  |
| 6 hyperparameter search | trial 11: depth 8, eta 0.03, mcw 5 | 1.1560 | 0.0723 | 88.8% | yes |  |
| 6 hyperparameter search | trial 12: depth 5, eta 0.03, mcw 5 | 1.1581 | 0.0743 | 88.9% |  |  |
| 6 hyperparameter search | trial 13: depth 8, eta 0.02, mcw 20 | 1.1550 | 0.0733 | 88.8% | yes |  |
| 6 hyperparameter search | trial 14: depth 6, eta 0.03, mcw 10 | 1.1571 | 0.0755 | 88.8% |  |  |
| 6 hyperparameter search | trial 15: depth 6, eta 0.08, mcw 20 | 1.1654 | 0.0759 | 88.7% |  |  |
| 6 hyperparameter search | trial 16: depth 6, eta 0.08, mcw 10 | 1.1661 | 0.0752 | 88.6% |  |  |

## Requested features vs this dataset

| # | Feature | Status | Columns |
|---|---|---|---|
| 1 | Timestamp / date and time | partial | cutoff_date, target_month_start (monthly, not timestamped) |
| 2 | Software name | used | software_id (+ name from lookup) |
| 3 | Licence feature / pool ID | used | pool = portfolio_id x software_id (split/CV group) |
| 4 | Number of active licences | missing | optional column active_licences_last_month |
| 5 | Peak concurrent licence usage | used | obs_peak_*, portfolio_peak_last_30d/90d |
| 6 | Average concurrent licence usage | partial | obs_peak_mean_so_far (mean of monthly peaks) |
| 7 | Successful licence requests | missing | optional column successful_requests_last_month |
| 8 | Denied licence requests | missing | optional column denied_requests_last_month |
| 9 | Software sessions | missing | optional (not in prototype priority) |
| 10 | Average session duration | missing | optional (not in prototype priority) |
| 11 | Idle session duration | missing | optional (not in prototype priority) |
| 12 | Historical utilisation % | missing | optional (not in prototype priority) |
| 13 | Total licences owned | used (supply) | licences_owned_for_software, lookup: shortage/cost, not demand input |
| 14 | Licences available | derived (supply) | portfolio_headroom_last_30d = owned - recent pool peak |
| 15 | Licence type | used (supply) | licence_inventory.license_type (all Concurrent) |
| 16 | Licence expiry date | used (supply) | licence_inventory renewal/support_end, months_to_next_renewal |
| 17 | Licence renewal date | used (simulation) | licence_inventory.renewal_date |
| 18 | Cost per licence | used (simulation) | software_lookup annual / monthly / temporary price |
| 19 | Total licence expenditure | used (simulation) | licences owned x annual price |
| 20 | Licence pool capacity | used (supply) | licences_owned_for_software |
| 21 | Project ID | used | project_id (grouping only, never an input) |
| 22 | Project start date | used | months_elapsed_at_cutoff, target_pct_of_project_elapsed |
| 23 | Project end date | used | deadline_months, months_remaining_to_deadline, is_final_planned_month |
| 24 | Project phase | used | plan_phase_at_cutoff, plan_phase_in_target_month, phase intensities |
| 25 | Engineers assigned | used | team_size |
| 26 | Software required per project | used | software_id, n_software_in_project, software_need_weight |
| 27 | Ongoing projects | used + derived | portfolio_other_active_projects_target, ongoing_*_at_cutoff |
| 28 | Planned future projects | derived | planned_future_projects_6m, future_same_software_by_target |
| 29 | Expected project workload | used | plan_load_index_target, plan_peak_load_target, portfolio_planned_load_target |
| 30 | Planned simulation jobs / tasks | partial | plan_phase_in_target_month = Analysis & Simulation, intensity |
| 31 | Project priority | used | project_priority |
| 32 | Hour of day | missing | monthly data; optional peak_hour_share_last_month |
| 33 | Day of week | missing | monthly data; optional weekday_peak_share_last_month |
| 34 | Month | used | target_calendar_month |
| 35 | Working day / holiday | used | target_working_days |
| 36 | Historical peak-demand periods | used + derived | portfolio_peak_last_30d/90d, hist_month_peak_index |
| 37 | Planned project start/end periods | used | months_remaining_to_deadline, months_need_from_target_to_deadline |
| 38 | Demand in similar project phases | derived | phase_demand_ratio (learned on training rows only) |
| 39 | TARGET future peak demand | target | target_portfolio_peak_demand |
| 40 | TARGET future average demand | missing | no pool-level average in the dataset |
| 41 | TARGET future utilisation % | derived | forecast peak / licences owned |
| 42 | TARGET future shortage indicator | derived | P(forecast > owned); checked against target_portfolio_shortfall_flag |
| 43 | TARGET future shortage quantity | derived | E[max(0, forecast - owned)]; checked against target_portfolio_shortfall_licences |