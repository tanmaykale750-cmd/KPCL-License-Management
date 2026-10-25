# Member 3 — Licence Optimisation & Recommendation Engine

**Purpose:** turn Member 1's operational usage data and Member 2's monthly forecast simulation into explainable licence recommendations.

> **All supplied data and costs are synthetic prototype data.** Recommendations are decision support only. They are not actual KPCL telemetry, vendor quotations, or procurement instructions. All savings are labelled **Possible** and require human and contract review.

## 1. Run the complete Member 3 part

Requirements: Python 3.10+ and pandas.

### Windows / VS Code
1. Extract this ZIP to a new folder.
2. Open that folder in VS Code.
3. Open Terminal → New Terminal.
4. Run:

```powershell
python -m pip install -r requirements.txt
python run_all.py
```

The script runs both decision layers and regenerates all output files.

To run the layers separately:

```powershell
python run_decision_engine.py
python run_portfolio_decision_engine.py
```

Run tests:

```powershell
python -m unittest discover -s tests -v
```

## 2. Architecture and inputs

### Member 1 — operational / software-level inputs
- `data/licence_inventory.csv`: usable and purchased licence counts, annual cost assumptions, criticality, renewal and notice deadlines.
- `data/usage_metrics.csv`: historical peak demand including denied requests, denied checkout count, utilisation, demand trend, idle telemetry and contract context.
- `data/daily_demand.csv`: daily historical demand used by the historical cost-risk simulation.
- `data/monthly_metrics.csv`, `data/licence_denials.csv`, `data/user_metrics.csv`: supporting evidence for analysis.
- `data/assumptions.csv`: risk tolerance, utilisation thresholds, temporary-cost multiplier, and as-of date.

### Member 2 — monthly ML simulation inputs
- `data/member2/pool_forecast_by_month.csv`: forecast simulation by `portfolio_id × software_id × month`, including expected peak, P90 peak, shortage probability, expected shortage, licences needed and risk flag.
- `data/member2/accuracy_report.md` and `holdout_report.json`: model evaluation evidence.
- `data/member2/member2_simulation_recommendations.csv`: Member 2's own simulation recommendations, included for traceability; Member 3 independently applies its decision rules.

## 3. Important integration limitation — read before interpreting totals

The two input packages currently describe different data grains:

- Member 1 provides **one software-level inventory / shared pool** and software-wide observed usage.
- Member 2's simulation treats each **portfolio × software combination as a separate pool with the full software licence count**.

Member 3 therefore produces two complementary outputs rather than silently combining incompatible quantities:

1. **Software-level historical recommendations** (`output/recommendations.csv`) from Member 1's observed daily demand.
2. **Portfolio/software forecast-aware recommendations** (`output/portfolio_pool_recommendations.csv`) from Member 2's monthly simulation. Member 1's software-wide history is used as a safety guardrail, not misrepresented as portfolio-specific usage.

Do **not** sum licence costs or savings across portfolio rows. The same software inventory cost is repeated by the Member 2 pool convention. Before presenting portfolio-level financial totals as organisation-wide savings, the team must confirm whether each portfolio truly has a separate licence pool or whether all projects share one pool per software. If the latter, Member 2's forecasts must be aggregated/retrained at the shared software-pool grain first.

## 4. How the recommendation system works

### A. Historical software-level layer

`run_decision_engine.py` uses `src/decision_engine.py`.

1. **Measure demand:** uses `peak_demand_incl_denials`, not only occupied licences, so denied checkout requests contribute to unmet demand.
2. **Grid Search:** tests candidate permanent licence counts and estimates:
   - annual permanent licence cost = candidate count × annual cost per licence;
   - shortage risk = share of observed working-day observations where demand exceeds the candidate;
   - annualised shortage cost = shortfall licence-days annualised to the configured working-day horizon × assumed shortage cost per licence-day;
   - total estimated cost = licence cost + shortage cost.
3. **Select candidate:** chooses the lowest estimated total-cost candidate that satisfies the configured shortage-risk tolerance where possible.
4. **Newsvendor cross-check:** calculates a cost-based demand quantile and safety-buffer target as a second decision signal.
5. **Business rules / guardrails:** may override the raw candidate:
   - short-lived bursts with sufficient denial evidence can trigger temporary-access investigation rather than a permanent increase;
   - rising demand can block a proposed reduction;
   - high peak utilisation with no denials can block a reduction;
   - if the chosen permanent count still exceeds the risk tolerance, the output flags risk for investigation.
6. **Contract context:** recommendations to reduce are framed for renewal; renewal and notice deadlines are shown.
7. **Human approval:** savings remain `Possible` unless real contract costs are verified and the decision is approved.

The key configurable assumptions are in `config.json` and `data/assumptions.csv`. Values such as 5% shortage risk, 85% peak utilisation, the temporary-access price multiplier and shortage penalty are **project assumptions**, not universal industry benchmarks.

### B. Forecast-aware portfolio/software layer

`run_portfolio_decision_engine.py` uses `src/portfolio_decision_engine.py`.

1. Groups Member 2's monthly forecast rows by `portfolio_id` and `software_id`.
2. Finds forecast-bearing months, the maximum expected peak, maximum P90 peak, maximum shortage probability, months above the risk tolerance, and the largest modelled licence requirement.
3. If shortage risk exceeds the configured 5% tolerance:
   - if extra capacity is required and risk is limited to at most two months, temporary access is suggested when its illustrative cost is lower than a full-year permanent purchase and the software is not marked Critical;
   - otherwise, the layer recommends considering a permanent increase;
   - if risk is high but the rounded modelled requirement does not exceed current capacity, it flags the pool for investigation.
4. If no forecast month is above tolerance and a material reduction appears possible, the layer checks Member 1's software-wide guardrails: denials, observed demand above inventory, rising demand with high utilisation, Critical status, and low-utilisation evidence.
5. If no forecast exists for a pool, it does **not** recommend a reduction based on missing data.
6. It includes the renewal notice deadline and a reason string for every recommendation.

The Member 2 simulation's `licences_needed` field already includes its configured 5% risk tolerance and one-licence buffer; Member 3 does not add the buffer a second time.

## 5. Output files

### Historical layer
- `output/recommendations.csv` — one row per software (8 rows), with action, recommended permanent count, estimated costs/savings, risk, evidence and approval requirement.
- `output/grid_search_results.csv` — candidate licence counts and cost/risk comparisons.
- `output/simulation_diagnostics.csv` — candidate-level diagnostics.
- `output/recommendation_explanations.csv` — expanded explanations.
- `output/run_summary.json` — run-level summary.

### Forecast-aware layer
- `output/portfolio_pool_recommendations.csv` — one row per forecasted portfolio/software pool (573 rows in the included run).
- `output/portfolio_pool_summary.csv` — counts of actions by software; does not sum duplicated pool-level money.
- `output/forecast_integration_summary.json` — row counts, forecast horizon, risk tolerance and grain warning.

## 6. Model performance evidence from Member 2

The included Member 2 report states the holdout evaluation passed its pre-set checks, including:
- target peak-demand MAE approximately 1.16 licences;
- WAPE approximately 17.1%;
- P90 coverage approximately 88.9%;
- predictions within ±2 licences approximately 89.1%.

These are Member 2's reported holdout metrics on their synthetic data, not a guarantee of real-world accuracy. The report also notes weaker accuracy for the highest-demand pools; review high-risk / critical recommendations manually.

## 7. Known limitations and safe interpretation

- Prices, costs, inventory, users, projects and usage are synthetic.
- A forecast of a pool's peak is not the same as average monthly demand or total monthly checkouts.
- Member 1 and Member 2's pool definitions differ; this is why the two layers are kept separate.
- Forecast uncertainty and cost assumptions can materially change actions.
- Temporary access estimates are illustrative and do not represent a vendor quote.
- A reduction recommendation is not an automatic entitlement revocation or contract change.
- Review high-criticality tools, denials, contract minimums, notice deadlines and future project schedules with the team before acting.

## 8. Project structure

```text
member3_complete_working/
├── data/
│   ├── licence_inventory.csv
│   ├── assumptions.csv
│   ├── usage_metrics.csv
│   ├── daily_demand.csv
│   ├── monthly_metrics.csv
│   └── member2/
│       ├── pool_forecast_by_month.csv
│       ├── member2_simulation_recommendations.csv
│       └── accuracy_report.md
├── src/
│   ├── decision_engine.py
│   └── portfolio_decision_engine.py
├── output/
├── tests/
├── run_decision_engine.py
├── run_portfolio_decision_engine.py
└── run_all.py
```

## Forecast coverage safeguard (updated)

The forecast-aware portfolio engine now reports `expected_forecast_months`,
`zero_forecast_months`, and `forecast_coverage_pct` for each portfolio/software
pool. A month with `forecasts = 0` is not treated as evidence of zero demand.
When a pool has incomplete forecast coverage and would otherwise qualify for a
permanent reduction, the engine keeps the current licence count and returns
`RETAIN_AND_REVIEW_PARTIAL_FORECAST`. Forecast-risk-based increase or investigation
logic still takes precedence where applicable. These safeguards are decision
support only; confirm zero-forecast semantics with Member 2 and require human
approval and contract verification before acting on financial estimates.
