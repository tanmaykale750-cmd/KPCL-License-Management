"""
Train, compare and select light forecasting models for future pool peak demand (target 39).

    python run_ensemble.py                # full run (about 5-10 minutes on 2 cores)
    python run_ensemble.py --quick        # 3 folds, skips the slowest candidates (random forest, extra trees, knn)

LightGBM and XGBoost candidates run only if those packages are installed; otherwise they are skipped and the
skip is recorded in the report.

Steps
  1  Load the v3 dataset, run the existing data checks.
  2  Development set = portfolios not in the dataset's test split, rows whose label month CLOSED
     by the dataset's as_of_date (2026-09-30). Nothing after that date is used for training.
  3  Walk-forward cross-validation (quarterly cut-off windows, purged) for every candidate.
  4  Select by CV MAE only (rule fixed in licence_ml/ensemble.py). Refit on the development set.
  5  Score ONCE on three tests the selection never saw:
       A  out-of-time      known pools, forecasts made on/before as_of for months after it
       B  unseen pools     test portfolios, months up to as_of
       C  both             test portfolios, months after as_of (strictest)
  6  Acceptance checks fixed before testing; per-pool dashboard output; reports.
"""
from __future__ import annotations

import argparse
import json
import pickle
import platform
import shutil
import time
from pathlib import Path

import numpy as np
import pandas as pd

from licence_ml import config as C
from licence_ml import data as D
from licence_ml import ensemble as E
from licence_ml import pool_outputs as PO
from licence_ml.evaluate import auc, classification, metrics

OUT = C.REPORTS / "ensemble"
ART = C.ARTIFACTS / "ensemble"
FRONTEND = C.ROOT.parent / "src" / "data" / "ml"
FOLD_STARTS = ["2025-10-01", "2026-01-01", "2026-04-01", "2026-07-01"]

ACCEPTANCE = {   # fixed before any test is scored
    "min_improvement_vs_best_rule": 0.10,
    "max_cv_to_test_gap": 0.15,
    "p90_coverage_range": (0.85, 0.95),
    "min_within_2": 0.70,
    "min_shortage_auc": 0.85,
}


def jsonable(o):
    if isinstance(o, dict):
        return {str(k): jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(v) for v in o]
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else float(o)
    if isinstance(o, float) and np.isnan(o):
        return None
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, pd.Timestamp):
        return str(o.date())
    return o


def _version(pkg: str) -> str | None:
    try:
        return __import__(pkg).__version__
    except ImportError:
        return None


def comparison_chart(lb: pd.DataFrame, tb: pd.DataFrame, selected: str, path: Path) -> None:
    """CV MAE vs out-of-time test MAE for every candidate: shows ranking and any overfitting gap at a glance."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    order = lb.sort_values("cv_mae", ascending=False)
    a = tb[tb.test == "A_out_of_time"].set_index("model")["mae"]
    c = tb[tb.test == "C_unseen_pools_out_of_time"].set_index("model")["mae"]
    yy = np.arange(len(order))
    fig, ax = plt.subplots(figsize=(9, 0.42 * len(order) + 1.6))
    ax.barh(yy - 0.27, order["cv_mae"], 0.27, color="#2a78d6", label="Walk-forward CV (used for selection)")
    ax.barh(yy, [a.get(m, np.nan) for m in order["model"]], 0.27, color="#e8a33c", label="Test A: known pools, future months")
    ax.barh(yy + 0.27, [c.get(m, np.nan) for m in order["model"]], 0.27, color="#9b9b9b", label="Test C: unseen pools, future months")
    ax.set_yticks(yy, [E.LABELS[m] + ("  ← selected" if m == selected else "") for m in order["model"]], fontsize=8)
    ax.set_xlabel("MAE (licences, lower is better)")
    ax.legend(fontsize=7, loc="lower right", frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    ax.set_title("Model comparison: selection on CV, tests scored once afterwards", loc="left", fontsize=10)
    fig.tight_layout()
    fig.savefig(path, dpi=140)
    plt.close(fig)


def score_tests(fc: E.EnsembleForecaster, tests: dict[str, pd.DataFrame], cv_mae: dict[str, float]) -> tuple[pd.DataFrame, dict]:
    rows, preds = [], {}
    for tname, t in tests.items():
        P = fc.predict_all(t)
        preds[tname] = P
        y = t[C.TARGET].to_numpy(float)
        for m, p in P.items():
            mm = metrics(y, p)
            rows.append(dict(test=tname, model=m, label=E.LABELS[m], **mm, cv_mae=cv_mae.get(m),
                             gap_vs_cv=(mm["mae"] / cv_mae[m] - 1) if cv_mae.get(m) else None))
    tb = pd.DataFrame(rows)
    tb["rank_in_test"] = tb.groupby("test")["mae"].rank(method="min").astype(int)
    return tb, preds


def derived(fc: E.EnsembleForecaster, t: pd.DataFrame) -> dict:
    out = fc.predict(t)
    y = t[C.TARGET].to_numpy(float)
    owned = t[C.OWNED].to_numpy(float)
    raw = np.array([PO.shortage_stats(a, b, c, o)[0] for a, b, c, o in zip(out["peak_p10"], out["peak_p50"], out["peak_p90"], owned)])
    prob = fc.calibrate_probability(raw)
    flag = t[C.SHORTFALL_FLAG].to_numpy()
    bins_raw = pd.cut(raw, [-0.001, 0.05, 0.2, 0.5, 1.0], labels=["<5%", "5–20%", "20–50%", "≥50%"])
    rel_raw = [dict(bin=str(b), rows=int((bins_raw == b).sum()), predicted=float(raw[bins_raw == b].mean()) if (bins_raw == b).any() else None,
                    observed=float(flag[bins_raw == b].mean()) if (bins_raw == b).any() else None) for b in bins_raw.categories]
    bins = pd.cut(prob, [-0.001, 0.05, 0.2, 0.5, 1.0], labels=["<5%", "5–20%", "20–50%", "≥50%"])
    rel = [dict(bin=str(b), rows=int((bins == b).sum()), predicted=float(prob[bins == b].mean()) if (bins == b).any() else None,
                observed=float(flag[bins == b].mean()) if (bins == b).any() else None) for b in bins.categories]
    last30 = t["portfolio_peak_last_30d"].to_numpy(float)
    return dict(
        p90_coverage=float(np.mean(y <= out["peak_p90"].to_numpy() + 1e-9)),
        p10_p90_coverage=float(np.mean((y >= out["peak_p10"].to_numpy() - 1e-9) & (y <= out["peak_p90"].to_numpy() + 1e-9))),
        mean_interval_width=float(np.mean(out["peak_p90"] - out["peak_p10"])),
        utilisation_mae_points=float(np.mean(np.abs(100 * out["peak_p50"].to_numpy() / owned - 100 * y / owned))),
        shortage_auc=auc(flag, prob), shortage_rule_auc=auc(flag, last30 - owned),
        shortage_at_50pct=classification(flag, prob >= 0.5), shortage_at_high_case=classification(flag, out["peak_p90"].to_numpy() > owned),
        shortage_brier=float(np.mean((prob - flag) ** 2)), shortage_brier_uncalibrated=float(np.mean((raw - flag) ** 2)),
        shortage_base_rate=float(flag.mean()), reliability=rel, reliability_uncalibrated=rel_raw,
    )


def by_group(t: pd.DataFrame, p: np.ndarray, p90: np.ndarray, col: str, labels=None) -> list[dict]:
    out = []
    for k, g in t.assign(_p=p, _p90=p90).groupby(col):
        m = metrics(g[C.TARGET], g["_p"])
        out.append(dict(group=(labels or {}).get(k, str(k)), rows=m["n"], mae=m["mae"], wape=m["wape"], within_2=m["within_2"],
                        p90_coverage=float(np.mean(g[C.TARGET] <= g["_p90"] + 1e-9))))
    return out


def pool_month_accuracy(df: pd.DataFrame, fc: E.EnsembleForecaster, as_of, pools: set | None) -> dict:
    """Decision-level accuracy: the combined pool-month forecast as of as_of vs what the simulator later produced."""
    rows = PO.deployment_rows(df if pools is None else df[df[C.GROUP].isin(pools)], as_of)
    pr = fc.predict(rows)
    rows = rows.join(pr)
    agg = rows.groupby([C.GROUP, "software_id", "month"]).agg(p50=("peak_p50", "median"), p90=("peak_p90", "median"),
                                                            y=(C.TARGET, "median"), owned=(C.OWNED, "first")).reset_index()
    m = metrics(agg["y"], agg["p50"])
    short = (agg["y"] > agg["owned"]).to_numpy()
    flagged = (agg["p90"] > agg["owned"]).to_numpy()
    return dict(pool_months=int(len(agg)), mae=m["mae"], wape=m["wape"], within_2=m["within_2"],
                p90_coverage=float(np.mean(agg["y"] <= agg["p90"] + 1e-9)),
                shortage_months=int(short.sum()), shortage_months_caught_by_p90=int((short & flagged).sum()),
                false_alarms_p90=int((~short & flagged).sum()))


def main(quick: bool = False):
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    ART.mkdir(parents=True, exist_ok=True)
    print("1  Loading the v3 dataset and running data checks")
    df = D.load()
    q = D.quality_report(df)
    assert q["passed"], "data checks failed"
    A = D.assumptions()
    as_of = A["as_of_date"]
    te = E.target_end(df)
    closed = te <= as_of + pd.Timedelta(days=1)
    is_test_pool = df["split"] == "test"
    dev = df[~is_test_pool & closed].reset_index(drop=True)
    tests = {
        "A_out_of_time": df[~is_test_pool & (df["cutoff_date"] <= as_of) & ~closed].reset_index(drop=True),
        "B_unseen_pools": df[is_test_pool & closed].reset_index(drop=True),
        "C_unseen_pools_out_of_time": df[is_test_pool & (df["cutoff_date"] <= as_of) & ~closed].reset_index(drop=True),
    }
    print(f"   development {len(dev):,} rows / {dev[C.GROUP].nunique()} pools, labels closed by {as_of.date()}")
    for k, v in tests.items():
        print(f"   test {k:<28} {len(v):,} rows / {v[C.GROUP].nunique()} pools")
    assert not set(dev[C.GROUP]) & set(tests["B_unseen_pools"][C.GROUP]), "pool leakage"
    assert (E.target_end(dev) <= as_of + pd.Timedelta(days=1)).all(), "training label after as_of"

    print("2  Walk-forward cross-validation (purged, expanding window)")
    starts = FOLD_STARTS[1:] if quick else FOLD_STARTS
    folds = E.walk_forward_folds(dev, starts, str((as_of + pd.Timedelta(days=1)).date()))
    models, skipped = E.available_models()
    if quick:
        for m in ("random_forest", "extra_trees", "knn"):
            if m in models:
                models.remove(m)
                skipped[m] = "skipped in --quick mode"
    print(f"   candidates: {', '.join(models)}")
    for m, why_skip in skipped.items():
        print(f"   not run: {m} ({why_skip})")
    cv = E.cross_validate(dev, folds, models=models)
    lb = E.leaderboard(dev, cv)
    selected, why, ties = E.select(lb)
    print("\n   Leaderboard (CV MAE, licences):")
    for _, r in lb.iterrows():
        print(f"   {r['rank_cv']:>2}. {r['label']:<46} {r['cv_mae']:.3f} ± {r['cv_mae_fold_std']:.3f}   WAPE {r['cv_wape']:.1%}")
    print(f"\n   Selected: {E.LABELS[selected]}. {why}")

    print("3  Final refit on the development set")
    fc = E.fit_final(dev, cv, selected, models)
    lr = dev["portfolio_planned_load_to_owned_ratio"]
    fc.meta.update(selected=selected, selected_label=E.LABELS[selected], selection_reason=why, as_of=str(as_of.date()),
                   trained_on=time.strftime("%Y-%m-%d"), python=platform.python_version())
    with open(ART / "ensemble_forecaster.pkl", "wb") as f:
        pickle.dump(fc, f)

    print("4  Scoring the tests once")
    cv_mae = dict(zip(lb["model"], lb["cv_mae"]))
    tb, preds = score_tests(fc, tests, cv_mae)
    for tname in tests:
        s = tb[(tb.test == tname) & (tb.model == selected)].iloc[0]
        print(f"   {tname:<28} selected MAE {s['mae']:.3f} (rank {int(s['rank_in_test'])} of {tb[tb.test == tname].shape[0]}), gap vs CV {s['gap_vs_cv']:+.1%}")
    der = {k: derived(fc, v) for k, v in tests.items()}

    A_t = tests["A_out_of_time"]
    sel_A = tb[(tb.test == "A_out_of_time") & (tb.model == selected)].iloc[0]
    rules_A = tb[(tb.test == "A_out_of_time") & tb.model.str.startswith("rule_")].sort_values("mae").iloc[0]
    sel_C = tb[(tb.test == "C_unseen_pools_out_of_time") & (tb.model == selected)].iloc[0]
    checks = [
        dict(check="Beats the best simple rule out of time", passed=bool(sel_A["mae"] <= rules_A["mae"] * (1 - ACCEPTANCE["min_improvement_vs_best_rule"])),
             detail=f"MAE {sel_A['mae']:.3f} vs {rules_A['mae']:.3f} ({rules_A['label']}), {1 - sel_A['mae'] / rules_A['mae']:.1%} better (need ≥ 10%)"),
        dict(check="No overfitting: out-of-time error close to CV", passed=bool(abs(sel_A["gap_vs_cv"]) <= ACCEPTANCE["max_cv_to_test_gap"]),
             detail=f"test A MAE {sel_A['mae']:.3f} vs CV {sel_A['cv_mae']:.3f} ({sel_A['gap_vs_cv']:+.1%}; allowed ±15%)"),
        dict(check="Generalises to unseen pools and months", passed=bool(abs(sel_C["gap_vs_cv"]) <= ACCEPTANCE["max_cv_to_test_gap"]),
             detail=f"test C MAE {sel_C['mae']:.3f} vs CV {sel_C['cv_mae']:.3f} ({sel_C['gap_vs_cv']:+.1%}; allowed ±15%)"),
        dict(check="P90 is calibrated out of time", passed=bool(ACCEPTANCE["p90_coverage_range"][0] <= der["A_out_of_time"]["p90_coverage"] <= ACCEPTANCE["p90_coverage_range"][1]),
             detail=f"actual ≤ P90 in {der['A_out_of_time']['p90_coverage']:.1%} of rows (target 85–95%)"),
        dict(check="Licence counts are usable", passed=bool(sel_A["within_2"] >= ACCEPTANCE["min_within_2"]),
             detail=f"within ±2 licences for {sel_A['within_2']:.1%} (need ≥ 70%)"),
        dict(check="Shortages are detected", passed=bool(der["A_out_of_time"]["shortage_auc"] >= ACCEPTANCE["min_shortage_auc"]),
             detail=f"AUC {der['A_out_of_time']['shortage_auc']:.3f} (need ≥ 0.85); last-30-day rule {der['A_out_of_time']['shortage_rule_auc']:.3f}"),
    ]
    verdict = all(c["passed"] for c in checks)
    for c in checks:
        print(f"   {'PASS' if c['passed'] else 'FAIL'}  {c['check']}: {c['detail']}")

    pA = preds["A_out_of_time"][selected]
    p90A = fc.predict(A_t)["peak_p90"].to_numpy()
    lk = D.lookup()
    by_sw = by_group(A_t, pA, p90A, "software_id", lk["software_name"].to_dict())
    test_by_software = {sw: dict(mae=r["mae"], within_2=r["within_2"], p90_coverage=r["p90_coverage"])
                        for sw, r in zip(sorted(A_t["software_id"].unique()), by_sw)}

    print("5  Per-pool dashboard output as of", as_of.date())
    pools = PO.build(df, fc, dict(selected_label=E.LABELS[selected]), test_by_software,
                     dict(load_ratio_p99=float(lr.quantile(0.99))))
    pm_known = pool_month_accuracy(df[~is_test_pool], fc, as_of, None)
    pm_unseen = pool_month_accuracy(df[is_test_pool], fc, as_of, None)

    report = dict(
        model=dict(name="KPCL licence demand ensemble", version="ens-1.0", selected=selected, selected_label=E.LABELS[selected],
                   selection_rule="Lowest row-weighted walk-forward CV MAE. Ensembles compete on equal terms (composition learned from earlier folds only). Tests never used for selection.",
                   selection_reason=why, statistical_ties=ties, trained_on=fc.meta["trained_on"], as_of=str(as_of.date()),
                   training_rows=int(len(dev)), training_pools=int(dev[C.GROUP].nunique()),
                   training_cutoffs=[str(dev["cutoff_date"].min().date()), str(dev["cutoff_date"].max().date())],
                   training_label_months=[str(dev["target_month_start"].min().date()), str(dev["target_month_start"].max().date())],
                   horizon_months=[1, 6], target=C.TARGET, features=len(fc.builder.columns),
                   probability_calibration=fc.meta.get("probability_calibration"),
                   ensemble_top3=fc.top3, ensemble_stacked_weights=fc.stacked, interval_method="Split-conformal P10/P90 from out-of-fold errors, by horizon, history and demand level",
                   candidates_run=models, candidates_not_run=skipped,
                   final_boosting_rounds=fc.meta.get("final_boosting_rounds"),
                   versions=dict(python=platform.python_version(), sklearn=_version("sklearn"), lightgbm=_version("lightgbm"),
                                 xgboost=_version("xgboost"), pandas=pd.__version__)),
        folds=[dict(name=f.name, train_rows=int(f.train.sum()), valid_rows=int(f.valid.sum()), ensemble=cv.weights.get(f.name)) for f in folds],
        leaderboard=lb.to_dict("records"),
        tests=dict(
            definitions={
                "A_out_of_time": "Known pools; forecasts made on or before 30 Sep 2026 for months after it",
                "B_unseen_pools": "Pools held out of training (dataset test split); months up to 30 Sep 2026",
                "C_unseen_pools_out_of_time": "Held-out pools AND months after 30 Sep 2026 (strictest)",
            },
            rows={k: int(len(v)) for k, v in tests.items()},
            scores=tb.to_dict("records"), derived=der,
            by_horizon=by_group(A_t, pA, p90A, "forecast_after_months"),
            by_software=by_sw,
            by_history=by_group(A_t.assign(hist=np.select([A_t.months_elapsed_at_cutoff == 0, A_t.months_elapsed_at_cutoff <= 2, A_t.months_elapsed_at_cutoff <= 5], ["plan only", "1–2 months seen", "3–5 months seen"], "6+ months seen")), pA, p90A, "hist"),
            pool_month=dict(known_pools=pm_known, unseen_pools=pm_unseen),
        ),
        acceptance=dict(criteria=ACCEPTANCE, checks=checks, verdict="PASS" if verdict else "FAIL"),
        data_quality=dict(passed=q["passed"], summary=q["summary"], checks=q["checks"],
                          missing_features=[dict(number=n, name=nm, status=st, detail=dt) for n, nm, st, dt in __import__("licence_ml.features", fromlist=["FEATURE_MAP"]).FEATURE_MAP if st == "missing"]),
        seconds=round(time.time() - t0, 1),
    )
    (OUT / "ml_report.json").write_text(json.dumps(jsonable(report), indent=1, ensure_ascii=False))
    (OUT / "pool_forecasts.json").write_text(json.dumps(jsonable(pools), ensure_ascii=False))
    lb.to_csv(OUT / "leaderboard.csv", index=False)
    pd.DataFrame(cv.fold_rows).to_csv(OUT / "fold_scores.csv", index=False)
    tb.to_csv(OUT / "test_scores.csv", index=False)
    comparison_chart(lb, tb, selected, OUT / "model_comparison.png")
    write_markdown(report, pools)
    if FRONTEND.parent.exists():
        FRONTEND.mkdir(parents=True, exist_ok=True)
        shutil.copy(OUT / "ml_report.json", FRONTEND / "ml_report.json")
        shutil.copy(OUT / "pool_forecasts.json", FRONTEND / "pool_forecasts.json")
        print(f"   copied JSON to {FRONTEND}")
    print(f"\nVerdict: {'PASS' if verdict else 'FAIL'}  ({report['seconds']} s). Reports in {OUT}")


def write_markdown(r: dict, pools: dict):
    sel = r["model"]["selected"]
    L = [f"# Licence demand ensemble: model comparison and selection\n",
         f"Target: future peak demand on a shared licence pool (`{C.TARGET}`), 1–6 months ahead. Dataset as of {r['model']['as_of']}.\n",
         f"**Selected: {r['model']['selected_label']}.** {r['model']['selection_reason']}\n",
         f"Selection rule (fixed in advance): {r['model']['selection_rule']}\n",
         f"## Verdict on tests the selection never saw: **{r['acceptance']['verdict']}**\n"]
    L += [f"- {'PASS' if c['passed'] else 'FAIL'} - {c['check']}: {c['detail']}" for c in r["acceptance"]["checks"]]
    L += ["\n## Walk-forward cross-validation (development pools, labels closed by as_of)\n",
          "| Rank | Model | CV MAE | Fold std | WAPE | Within ±2 | Fold MAEs |", "|---|---|---|---|---|---|---|"]
    for x in r["leaderboard"]:
        L.append(f"| {x['rank_cv']} | {x['label']}{' (selected)' if x['model'] == sel else ''} | {x['cv_mae']:.3f} | {x['cv_mae_fold_std']:.3f} | {x['cv_wape']:.1%} | {x['cv_within_2']:.1%} | {', '.join(f'{v:.3f}' for v in x['fold_mae'])} |")
    L += ["\n## Tests (scored once, after selection)\n"]
    for t, d in r["tests"]["definitions"].items():
        L += [f"### {t}: {d} ({r['tests']['rows'][t]:,} rows)\n", "| Model | MAE | WAPE | Within ±2 | Gap vs CV | Rank |", "|---|---|---|---|---|---|"]
        for x in sorted([s for s in r["tests"]["scores"] if s["test"] == t], key=lambda s: s["mae"]):
            gap = f"{x['gap_vs_cv']:+.1%}" if x["gap_vs_cv"] is not None else "—"
            L.append(f"| {x['label']}{' (selected)' if x['model'] == sel else ''} | {x['mae']:.3f} | {x['wape']:.1%} | {x['within_2']:.1%} | {gap} | {x['rank_in_test']} |")
        dd = r["tests"]["derived"][t]
        L.append(f"\nP90 coverage {dd['p90_coverage']:.1%}; shortage AUC {dd['shortage_auc']:.3f} (rule {dd['shortage_rule_auc']:.3f}); Brier {dd['shortage_brier']:.3f}.\n")
    L += ["## Ensemble composition\n", f"- Top-3 mean: {', '.join(r['model']['ensemble_top3'])}",
          f"- Stacked weights: {', '.join(f'{k} {v:.2f}' for k, v in r['model']['ensemble_stacked_weights'].items())}\n",
          "## Pool output\n", f"{len(pools['pools'])} pools forecast for {pools['months'][0]} to {pools['months'][-1]}. Risk rules:\n"]
    L += [f"- **{x['level']}**: {x['rule']}" for x in pools["risk_rules"]]
    L += ["\nAll data and prices are synthetic (dataset v3). Savings are *possible*, not confirmed."]
    (OUT / "ensemble_report.md").write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    main(ap.parse_args().quick)
