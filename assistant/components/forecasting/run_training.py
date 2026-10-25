"""
Train, improve and test the future peak-licence-demand model (target 39).

    python run_training.py                      # full run
    python run_training.py --quick              # 3 folds, 6 tuning trials
    python run_training.py --use-dataset-split  # use the dataset's own split column instead of 80/20

Steps
  1. data checks (stops on errors)  2. hold out 20% of PORTFOLIOS
  3. improvement experiments with 5-fold cross-validation grouped by portfolio (training pools only)
  4. final model + P10/P50/P90 + calibration  5. ONE test on the held-out pools, PASS/FAIL
"""
from __future__ import annotations

import argparse
import time

import numpy as np
import pandas as pd

from licence_ml import config as C
from licence_ml import data as D
from licence_ml.evaluate import charts, holdout_report, write_json
from licence_ml.features import FEATURE_MAP, FeatureBuilder, OPTIONAL
from licence_ml.train import fit_final, residual_structure, run_experiments


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(C.DATA_FILE))
    ap.add_argument("--backend", default="auto", choices=["auto", "xgboost", "sklearn"])
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--use-dataset-split", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    C.REPORTS.mkdir(exist_ok=True); C.ARTIFACTS.mkdir(exist_ok=True)

    print("1/5 Loading and checking the dataset")
    df = D.load(a.data)
    dq = D.quality_report(df)
    write_json(dq, C.REPORTS / "data_quality.json")
    for c in dq["checks"]:
        if not c["passed"]:
            print(f"    {c['severity'].upper()}: {c['check']} - {c['detail']}")
    if not dq["passed"]:
        raise SystemExit("Data errors found; see reports/data_quality.json")
    fm = pd.DataFrame(FEATURE_MAP, columns=["feature_no", "requested_feature", "status", "dataset_columns"])
    found = [n for n, c in OPTIONAL.items() if c in df.columns]
    fm.loc[fm["feature_no"].isin(found), "status"] = "used (optional column found)"
    fm.to_csv(C.REPORTS / "feature_map.csv", index=False)
    s = dq["summary"]
    print(f"    {s['rows']:,} rows, {s['portfolios']} licence pools (portfolios), {s['projects']} projects; checks passed")
    print(f"    requested features: {(fm['status'].str.startswith(('used', 'derived'))).sum()} used/derived, "
          f"{(fm['status'] == 'partial').sum()} partial, {(fm['status'] == 'missing').sum()} not in this dataset "
          "(see reports/feature_map.csv)")

    print("2/5 Holding out portfolios for the final test")
    train, test = D.portfolio_split(df, use_dataset_split=a.use_dataset_split)
    pd.DataFrame({C.GROUP: sorted(test[C.GROUP].unique())}).to_csv(C.REPORTS / "holdout_portfolios.csv", index=False)
    print(f"    training: {train[C.GROUP].nunique()} pools / {len(train):,} rows;  hold-out: "
          f"{test[C.GROUP].nunique()} pools / {len(test):,} rows")

    print("3/5 Improvement experiments (grouped by portfolio)")
    folds, trials = (3, 6) if a.quick else (C.CV_FOLDS, C.N_TUNING_TRIALS)
    exp, best = run_experiments(train, a.backend, n_trials=trials, n_folds=folds)
    exp.to_csv(C.REPORTS / "experiments.csv", index=False)
    print(f"    best: {best['feature_set']} features, objective={best['objective']}, weighted={best['weighted']}, "
          f"CV MAE {best['mae']:.4f} (backend {best['backend']})")

    print("4/5 Final fit on all training pools")
    fc = fit_final(train, best)
    fc.meta["residual_structure"] = residual_structure(train, best)
    fc.meta["cv_metrics"] = {k: best[k] for k in ("mae", "rmse", "wape", "r2", "within_1", "within_2", "mae_std")}
    fc.save(C.ARTIFACTS)

    print("5/5 Final test on the held-out pools (first and only use)")
    out = fc.predict(test)
    rep = holdout_report(test, out, best)
    rep["backend"] = best["backend"]
    write_json(rep, C.REPORTS / "holdout_report.json")
    keep = [C.ROW_ID, C.GROUP, C.PROJECT, "software_id", "software_name", "months_elapsed_at_cutoff",
            "forecast_after_months", "target_month_start", C.OWNED, C.TARGET, C.SHORTFALL_FLAG, C.SHORTFALL_QTY]
    pred = test[keep].join(out)
    pred["error"] = pred["peak_expected"] - pred[C.TARGET]
    pred["within_2"] = (pred["peak_licences"] - pred[C.TARGET]).abs() <= 2
    pred.to_csv(C.REPORTS / "holdout_predictions.csv", index=False)
    fc.explain(test.sample(min(300, len(test)), random_state=C.SEED)).to_csv(
        C.REPORTS / "holdout_sample_explanations.csv", index=False)
    charts(test, out, rep, C.REPORTS / "charts")
    write_markdown(rep, exp, best, fm)

    m, d = rep["model"], rep["derived_targets"]
    print(f"\n    Target 39 (pool peak): MAE {m['mae']:.3f} | WAPE {m['wape']:.1%} | R2 {m['r2']:.3f} | within +/-1 "
          f"{m['within_1']:.1%} | within +/-2 {m['within_2']:.1%} | P90 coverage {rep['interval_coverage']['p90']:.1%}")
    print(f"    41 utilisation error {d['41_utilisation_pct']['mae_points']:.1f} points | 42 shortage AUC "
          f"{d['42_shortage_indicator']['auc']:.3f} | 43 shortage qty MAE {d['43_shortage_quantity']['mae']:.3f}")
    for c in rep["checks"]:
        print(f"    [{'PASS' if c['passed'] else 'FAIL'}] {c['check']}: {c['detail']}")
    print(f"\n    VERDICT: {rep['verdict']}   ({time.time() - t0:.0f}s)")


def write_markdown(rep, exp, best, fm):
    m, d, cov = rep["model"], rep["derived_targets"], rep["interval_coverage"]
    L = ["# Future peak licence demand (target 39) - accuracy report", "",
         f"Backend **{rep['backend']}**, features **{best['feature_set']}**, loss **{best['objective']}**, "
         f"sample weights **{best['weighted']}**", "", f"## Verdict on the held-out licence pools: **{rep['verdict']}**", ""]
    L += [f"- {'PASS' if c['passed'] else 'FAIL'} - {c['check']}: {c['detail']}" for c in rep["checks"]]
    L += ["", "## Target 39: pool peak demand", "", "| Metric | Model | " + " | ".join(rep["baselines"]) + " |",
          "|---|---|" + "---|" * len(rep["baselines"])]
    for k, lab in [("mae", "MAE (licences)"), ("rmse", "RMSE"), ("wape", "WAPE"), ("r2", "R2"), ("exact", "Exact"),
                   ("within_1", "Within +/-1"), ("within_2", "Within +/-2"), ("bias", "Bias")]:
        f = (lambda v: f"{v:.1%}") if k in ("wape", "exact", "within_1", "within_2") else (lambda v: f"{v:.3f}")
        L.append(f"| {lab} | {f(m[k])} | " + " | ".join(f(b[k]) for b in rep["baselines"].values()) + " |")
    s42 = d["42_shortage_indicator"]
    L += ["", f"P90 coverage {cov['p90']:.1%}, P10-P90 coverage {cov['p10_p90']:.1%}.", "",
          "## Derived targets 41-43 (from the forecast vs licences owned)", "",
          "| Target | Model | Simple rule (last 30 days) |", "|---|---|---|",
          f"| 41 utilisation, mean error (percentage points) | {d['41_utilisation_pct']['mae_points']:.1f} | "
          f"{d['41_utilisation_pct']['simple_rule_mae_points']:.1f} |",
          f"| 42 shortage indicator, AUC | {s42['auc']:.3f} | {s42['simple_rule_auc']:.3f} |",
          f"| 42 precision / recall (P >= 50%) | {s42['at_50pct']['precision']:.1%} / {s42['at_50pct']['recall']:.1%} | "
          f"{s42['simple_rule']['precision']:.1%} / {s42['simple_rule']['recall']:.1%} |",
          f"| 42 recall using the high case (P90) | {s42['at_high_case']['recall']:.1%} (precision "
          f"{s42['at_high_case']['precision']:.1%}) | |",
          f"| 43 shortage quantity, MAE (licences) | {d['43_shortage_quantity']['mae']:.3f} | "
          f"{d['43_shortage_quantity']['simple_rule_mae']:.3f} |", ""]
    for title, key in [("By months ahead", "by_horizon"), ("By usage history", "by_history"),
                       ("By software", "by_software"), ("By actual pool peak", "by_size")]:
        L += [f"### {title}", "", "| Group | Rows | MAE | WAPE | Within +/-2 | P90 coverage |", "|---|---|---|---|---|---|"]
        L += [f"| {r['group']} | {r['rows']} | {r['mae']:.3f} | {r['wape']:.1%} | {r['within_2']:.1%} | {r['p90_coverage']:.1%} |"
              for r in rep[key]]
        L.append("")
    L += ["## Improvement experiments (cross-validation on training pools)", "",
          "| Step | Experiment | CV MAE | +/- | Within +/-2 | Kept | Note |", "|---|---|---|---|---|---|---|"]
    for r in exp.itertuples():
        std = f"{r.cv_mae_std:.4f}" if pd.notna(getattr(r, "cv_mae_std", np.nan)) else ""
        L.append(f"| {r.step} | {r.experiment} | {r.cv_mae:.4f} | {std} | {r.cv_within_2:.1%} | "
                 f"{'yes' if r.kept else ''} | {r.note if isinstance(r.note, str) else ''} |")
    L += ["", "## Requested features vs this dataset", "", "| # | Feature | Status | Columns |", "|---|---|---|---|"]
    L += [f"| {r.feature_no} | {r.requested_feature} | {r.status} | {r.dataset_columns} |" for r in fm.itertuples()]
    (C.REPORTS / "accuracy_report.md").write_text("\n".join(L))


if __name__ == "__main__":
    main()
