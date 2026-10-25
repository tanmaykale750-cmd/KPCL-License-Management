# Licence Requirement + Cost Forecast Dataset - v3 (context-rich, ML-ready, SYNTHETIC)

102,368 rows x 63 columns (31.6 MB). 1,500 synthetic projects in 75 portfolios, 8 software tools, deadlines 2-12 months,
start dates Dec-2024 to Mar-2027. Data and prices are synthetic planning assumptions (calibrated on member1_data_package),
not real telemetry or vendor quotes. Savings are "Possible", not "Confirmed".

## One row = one prediction
(project, software, cut-off month c, forecast horizon h). Features use only information known at the cut-off.
Example: deadline_months = 5, forecast_after_months = 3 -> "5-month project, predict 3 months ahead".

## What is new in v3 (17 features + 5 targets)
Licences are a SHARED POOL: what matters for cost is the demand of all concurrent projects against the licences owned.
- Portfolio context: other projects' planned load, portfolio peak in the last 30/90 days, headroom, planned pressure on the pool.
- Plan-vs-reality features: how hard the team used the tool vs plan, planned ramp, quick estimate of the target peak.
- Decision context: months to the next renewal.
- New targets: portfolio peak demand, shortage (licences + flag), cost of covering the shortage, cost of idle (unneeded) licences.

## Targets (see ml_config.json)
| Goal | Column |
|---|---|
| Project licences needed | `target_licences_required`, `target_requirement_class` |
| Project cost | `target_monthly_licence_cost_inr`, `target_cost_optimal_inr` |
| Shared-pool demand | `target_portfolio_peak_demand` |
| Shortage | `target_portfolio_shortfall_licences`, `target_portfolio_shortfall_flag` |
| Cost of shortage / waste | `target_shortfall_cost_optimal_inr`, `target_idle_licence_cost_month_inr` |

## Quick start
    pip install pandas scikit-learn
    python code/train_baseline.py      # trains with and without the new columns on the test portfolios
Always take the feature list from `ml_config.json` (the 44 features; note a few columns starting with `target_` such as
`target_month_index` describe the predicted month and ARE features). The builder asserts no target-derived column is a feature.

## Baseline (test portfolios, gradient boosting, sample-weighted) - MAE, lower is better
| Target | Mean-baseline | v2 features | + v3 columns |
|---|---|---|---|
| Project licences needed | 1.98 | 0.83 | 0.81 |
| Portfolio peak demand | 3.45 | 2.58 | 1.17 |
| Shortage (licences) | 1.09 | 0.86 | 0.44 |
| Shortage cost (INR) | 149,271 | 111,866 | 59,220 |
| Idle licence cost (INR) | 56,202 | 34,782 | 14,386 |
| Shortage flag (AUC) | 0.50 | 0.857 | 0.972 |
The new columns barely change the single-project licence count; their value is in the shared-pool, shortage and waste targets.

## Training notes
- Split by the `split` column / `portfolio_id` only (all projects of a portfolio share a split; same project appears in many rows). v2's project-level split is replaced, so v2 and v3 numbers are not directly comparable.
- `obs_*`, `plan_load_last_observed_month`, `obs_peak_per_plan_load_last`, `plan_load_change_vs_last_month`, `est_target_peak_from_last_ratio` are blank when months_elapsed_at_cutoff = 0 (~21% of rows). Portfolio history columns are never blank, but read 0 for the first months of the simulated timeline (no data existed yet).
- Cost rule (lookups/software_lookup.csv): buy annual if the need lasts >= 7.5 months, else temporary (1.6x monthly price). Cost columns are deterministic in licences x price x months; best pipeline = predict licences, then apply the rule.
- Portfolio grouping is a random assumption (20 projects per pool, chosen so ~15% of rows show a shortage); coincidence factor 0.85 is an assumption.

## Limits
Synthetic: a model learns this generator's pattern, and the portfolio features are derived from the same simulation, so the large gains above are partly by construction. Re-validate on real project, usage and licence-server data before real decisions.

## Files
data/ dataset + data_dictionary.csv - lookups/software_lookup.csv - source_inputs/ original inventory + assumptions
code/ step1_generate_v1_dataset.py (simulation incl. portfolios, fixed seed) -> make_efficient_dataset.py -> train_baseline.py - ml_config.json
