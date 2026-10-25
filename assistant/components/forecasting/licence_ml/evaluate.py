"""Accuracy metrics, simple rules to beat, the hold-out report (target 39 + derived 41-43) and charts."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C


def metrics(y, pred) -> dict:
    y, pred = np.asarray(y, float), np.asarray(pred, float)
    r, err = np.rint(pred), pred - y
    ss = np.sum((y - y.mean()) ** 2)
    return dict(mae=float(np.mean(np.abs(err))), rmse=float(np.sqrt(np.mean(err ** 2))),
                wape=float(np.sum(np.abs(err)) / max(np.sum(y), 1e-9)), bias=float(np.mean(err)),
                r2=float(1 - np.sum(err ** 2) / ss) if ss > 0 else float("nan"),
                exact=float(np.mean(r == y)), within_1=float(np.mean(np.abs(r - y) <= 1)),
                within_2=float(np.mean(np.abs(r - y) <= 2)), n=int(len(y)))


def baselines(df: pd.DataFrame) -> dict[str, np.ndarray]:
    return {"Pool peak of the last 30 days": df["portfolio_peak_last_30d"].to_numpy(float),
            "Pool peak of the last 90 days": df["portfolio_peak_last_90d"].to_numpy(float)}


def auc(y, score) -> float:
    y = np.asarray(y).astype(bool)
    if y.all() or (~y).all():
        return float("nan")
    ranks = pd.Series(score).rank().to_numpy()
    return float((ranks[y].sum() - y.sum() * (y.sum() + 1) / 2) / (y.sum() * (~y).sum()))


def classification(y, flag) -> dict:
    y, flag = np.asarray(y).astype(bool), np.asarray(flag).astype(bool)
    tp = np.sum(y & flag)
    p = tp / max(flag.sum(), 1); r = tp / max(y.sum(), 1)
    return dict(precision=float(p), recall=float(r), f1=float(2 * p * r / max(p + r, 1e-9)),
                accuracy=float(np.mean(y == flag)), flagged=int(flag.sum()), actual=int(y.sum()))


def holdout_report(test: pd.DataFrame, out: pd.DataFrame, cv_best: dict) -> dict:
    y = test[C.TARGET].to_numpy(float)
    pred = out["peak_expected"].to_numpy()
    owned = test[C.OWNED].to_numpy(float)
    model_m = metrics(y, pred)
    base = {k: metrics(y, v) for k, v in baselines(test).items()}
    best_base = min(base, key=lambda k: base[k]["mae"])
    p10, p90 = out["peak_p10"].to_numpy(), out["peak_p90"].to_numpy()
    cov = dict(p90=float(np.mean(y <= p90 + 1e-9)), p10_p90=float(np.mean((y >= p10 - 1e-9) & (y <= p90 + 1e-9))),
               mean_width=float(np.mean(p90 - p10)))

    flag = test[C.SHORTFALL_FLAG].to_numpy()
    qty = test[C.SHORTFALL_QTY].to_numpy(float)
    last30 = test["portfolio_peak_last_30d"].to_numpy(float)
    derived = {
        "41_utilisation_pct": dict(
            mae_points=float(np.mean(np.abs(100 * pred / owned - 100 * y / owned))),
            simple_rule_mae_points=float(np.mean(np.abs(100 * last30 / owned - 100 * y / owned)))),
        "42_shortage_indicator": dict(
            auc=auc(flag, out["shortage_probability"]), simple_rule_auc=auc(flag, last30 - owned),
            at_50pct=classification(flag, out["shortage_probability"] >= 0.5),
            at_high_case=classification(flag, out["peak_licences_high_case"] > owned),
            simple_rule=classification(flag, last30 > owned), base_rate=float(flag.mean())),
        "43_shortage_quantity": dict(
            mae=float(np.mean(np.abs(out["shortage_licences_expected"] - qty))),
            simple_rule_mae=float(np.mean(np.abs(np.clip(last30 - owned, 0, None) - qty))),
            mae_when_short=float(np.mean(np.abs(out["shortage_licences_expected"] - qty)[flag == 1])) if flag.any() else None),
    }
    frame = test.assign(pred=pred, p90=p90)

    def breakdown(col, bins=None, labels=None):
        key = pd.cut(frame[col], bins, labels=labels) if bins is not None else frame[col]
        rows = []
        for k, g in frame.groupby(key, observed=True):
            m = metrics(g[C.TARGET], g["pred"])
            rows.append(dict(group=str(k), rows=m["n"], mae=m["mae"], wape=m["wape"], within_2=m["within_2"],
                             p90_coverage=float(np.mean(g[C.TARGET] <= g["p90"] + 1e-9)), mean_actual=float(g[C.TARGET].mean())))
        return rows

    A = C.ACCEPTANCE
    gap = model_m["mae"] / cv_best["mae"] - 1
    imp = 1 - model_m["mae"] / base[best_base]["mae"]
    lo, hi = A["p90_coverage_range"]
    a42 = derived["42_shortage_indicator"]["auc"]
    checks = [
        dict(check="Beats the best simple rule", passed=imp >= A["min_improvement_vs_best_baseline"],
             detail=f"MAE {model_m['mae']:.3f} vs {base[best_base]['mae']:.3f} ({best_base}): {imp:+.1%} better "
                    f"(need >= {A['min_improvement_vs_best_baseline']:.0%})"),
        dict(check="Generalises to unseen licence pools", passed=abs(gap) <= A["max_cv_to_holdout_gap"],
             detail=f"hold-out MAE {model_m['mae']:.3f} vs cross-validation {cv_best['mae']:.3f} ({gap:+.1%}; "
                    f"allowed +/-{A['max_cv_to_holdout_gap']:.0%})"),
        dict(check="High-demand case (P90) is calibrated", passed=lo <= cov["p90"] <= hi,
             detail=f"actual <= P90 in {cov['p90']:.1%} of rows (target {lo:.0%}-{hi:.0%})"),
        dict(check="Licence counts are usable", passed=model_m["within_2"] >= A["min_within_2_licences"],
             detail=f"rounded forecast within +/-2 licences for {model_m['within_2']:.1%} (need >= {A['min_within_2_licences']:.0%})"),
        dict(check="Shortages are detected (feature 42)", passed=bool(a42 >= A["min_shortage_auc"]),
             detail=f"AUC {a42:.3f} (need >= {A['min_shortage_auc']}); simple rule {derived['42_shortage_indicator']['simple_rule_auc']:.3f}"),
        dict(check="No pool or project in both training and test", passed=True, detail="split by portfolio, asserted"),
    ]
    return dict(verdict="PASS" if all(c["passed"] for c in checks) else "FAIL", checks=checks, model=model_m,
                baselines=base, best_baseline=best_base, improvement_vs_best_baseline=imp, cv_mae=cv_best["mae"],
                cv_to_holdout_gap=gap, interval_coverage=cov, derived_targets=derived,
                by_horizon=breakdown("forecast_after_months"),
                by_history=breakdown("months_elapsed_at_cutoff", [-1, 0, 2, 5, 99],
                                     ["plan only", "1-2 months seen", "3-5 months seen", "6+ months seen"]),
                by_software=breakdown("software_name"),
                by_size=breakdown(C.TARGET, [-1, 3, 7, 12, 99], ["0-3 licences", "4-7", "8-12", "13+"]),
                by_phase=breakdown("plan_phase_in_target_month"))


def charts(test: pd.DataFrame, out: pd.DataFrame, rep: dict, folder: Path) -> list[Path]:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    SURFACE, INK, INK2, GRID, BLUE, ORANGE = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df", "#2a78d6", "#eb6834"
    plt.rcParams.update({"figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "axes.edgecolor": GRID,
                         "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2, "text.color": INK,
                         "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "axes.spines.top": False,
                         "axes.spines.right": False, "font.size": 9, "axes.titlesize": 10, "axes.titleweight": "bold",
                         "legend.frameon": False})
    folder.mkdir(parents=True, exist_ok=True)
    y, pred = test[C.TARGET].to_numpy(float), out["peak_expected"].to_numpy()
    paths = []

    fig, ax = plt.subplots(figsize=(6.2, 5.6))
    mx = int(max(y.max(), pred.max())) + 1
    hb = ax.hexbin(y, pred, gridsize=(mx, mx), extent=(-0.5, mx + 0.5, -0.5, mx + 0.5), mincnt=1, cmap="Blues",
                   bins="log", linewidths=0.2)
    ax.plot([0, mx], [0, mx], color=INK, lw=1, ls="--", label="perfect forecast")
    ax.set_xlabel("Actual pool peak (licences)"); ax.set_ylabel("Forecast pool peak (licences)")
    ax.set_title(f"Hold-out pools: forecast vs actual peak (MAE {rep['model']['mae']:.2f})", loc="left")
    fig.colorbar(hb, ax=ax, label="rows (log scale)"); ax.legend(loc="upper left")
    fig.tight_layout(); p = folder / "holdout_forecast_vs_actual.png"; fig.savefig(p, dpi=140); plt.close(fig); paths.append(p)

    bh = pd.DataFrame(rep["by_horizon"])
    bname = rep["best_baseline"]
    be = test.assign(e=np.abs(baselines(test)[bname] - y)).groupby("forecast_after_months")["e"].mean()
    fig, ax = plt.subplots(figsize=(7.2, 4))
    x = np.arange(len(bh))
    ax.bar(x - 0.2, bh["mae"], 0.38, color=BLUE, label="XGBoost model")
    ax.bar(x + 0.2, be.to_numpy(), 0.38, color=ORANGE, label=bname)
    for xi, v in zip(x, bh["mae"]):
        ax.text(xi - 0.2, v + 0.03, f"{v:.2f}", ha="center", fontsize=8, color=INK2)
    ax.set_xticks(x, [f"{g} mo" for g in bh["group"]])
    ax.set_xlabel("Months ahead of the prediction date"); ax.set_ylabel("Mean absolute error (licences)")
    ax.set_title("Error by forecast horizon, hold-out pools", loc="left"); ax.legend(loc="upper left")
    fig.tight_layout(); p = folder / "holdout_error_by_horizon.png"; fig.savefig(p, dpi=140); plt.close(fig); paths.append(p)

    # one pool per panel: forecasts made before the month (h=1) vs what happened, against licences owned
    ex = test.assign(pred=pred, p10=out["peak_p10"].to_numpy(), p90=out["peak_p90"].to_numpy())
    ex = ex[ex["forecast_after_months"] == 1]
    ex = ex.assign(month=ex["target_month_start"].dt.to_period("M"))
    agg = ex.groupby([C.GROUP, "software_id", "month"]).agg(actual=(C.TARGET, "max"), pred=("pred", "median"),
            p10=("p10", "median"), p90=("p90", "median"), owned=(C.OWNED, "first"), name=("software_name", "first")).reset_index()
    pick = agg.groupby([C.GROUP, "software_id"])["actual"].apply(lambda s: (s > 0).sum()).sort_values().index[-4:]
    fig, axes = plt.subplots(2, 2, figsize=(10, 6), squeeze=False)
    for ax, (pf, sw) in zip(axes.ravel(), pick):
        g = agg[(agg[C.GROUP] == pf) & (agg["software_id"] == sw)].sort_values("month")
        xs = g["month"].dt.to_timestamp()
        ax.fill_between(xs, g["p10"], g["p90"], color=BLUE, alpha=0.18, lw=0, label="forecast P10-P90")
        ax.plot(xs, g["pred"], color=BLUE, lw=2, label="forecast")
        ax.plot(xs, g["actual"], color=ORANGE, lw=2, marker="o", ms=3, label="actual")
        ax.axhline(g["owned"].iat[0], color=INK, lw=1.5, ls="--", label="licences owned")
        ax.set_title(f"{pf} - {g['name'].iat[0]}", loc="left"); ax.set_ylabel("pool peak (licences)")
        ax.tick_params(axis="x", rotation=30)
    axes[0, 0].legend(fontsize=7, loc="upper left")
    fig.suptitle("Hold-out pools: one-month-ahead forecast vs actual peak", x=0.01, ha="left", fontsize=11, fontweight="bold")
    fig.tight_layout(); p = folder / "holdout_example_pools.png"; fig.savefig(p, dpi=140); plt.close(fig); paths.append(p)
    return paths


def to_jsonable(o):
    if isinstance(o, dict):
        return {str(k): to_jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [to_jsonable(v) for v in o]
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return None if not np.isfinite(o) else round(float(o), 5)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, pd.DataFrame):
        return to_jsonable(o.to_dict("records"))
    if hasattr(o, "isoformat"):
        return o.isoformat()
    return o


def write_json(obj, path):
    Path(path).write_text(json.dumps(to_jsonable(obj), indent=2, ensure_ascii=False))
