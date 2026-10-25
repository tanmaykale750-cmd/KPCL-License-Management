"""
Training with measured improvement steps, all decided by 5-fold cross-validation grouped by
PORTFOLIO (licence pool) on the 80% training portfolios. The 20% hold-out is never used here.

  0  simple rules (pool peak of the last 30 / 90 days)
  1  core features (dataset columns for the priority features)
  2  + engineered features (27, 28, 36, 38, ratios)
  3  + capacity features (13-16): measured and reported, never kept (supply must not drive demand)
  4  per-project sample weights
  5  loss function: squared error / Poisson / Tweedie / absolute error
  6  hyperparameter search
  then P10/P50/P90 quantile model, conformal calibration on out-of-fold errors, final refit.
"""
from __future__ import annotations

import pickle
import platform
import time
from dataclasses import dataclass, field
from pathlib import Path
from statistics import NormalDist

import numpy as np
import pandas as pd

from . import config as C
from .data import early_stop_mask, group_folds
from .evaluate import baselines, metrics
from .features import FEATURE_GROUPS, FeatureBuilder
from .model import OBJECTIVES, PointModel, QuantileModel, backend_name, sample_params, save_xgboost_json

H_BUCKETS = [(1, 2), (3, 4), (5, 6)]
LEVEL_EDGES = [4, 8]
Z90 = 1.2815515655446004
_GRID_Z = np.array([NormalDist().inv_cdf((i + 0.5) / 400) for i in range(400)])


def shortage_from_quantiles(q: np.ndarray, owned: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Features 42 and 43 from the forecast distribution: P(pool peak > owned) and E[max(0, peak - owned)]."""
    lo = (q[:, 1] - q[:, 0]) / Z90
    hi = (q[:, 2] - q[:, 1]) / Z90
    x = q[:, 1:2] + np.where(_GRID_Z[None] < 0, lo[:, None], hi[:, None]) * _GRID_Z[None]
    x = np.clip(np.rint(x), 0, None)
    over = x - owned[:, None]
    return (over > 0).mean(1), np.clip(over, 0, None).mean(1)


@dataclass
class Forecaster:
    builder: FeatureBuilder
    point: PointModel
    quantile: QuantileModel
    calibration: dict
    meta: dict = field(default_factory=dict)

    def predict(self, df: pd.DataFrame, owned: pd.Series | np.ndarray | None = None) -> pd.DataFrame:
        X = self.builder.transform(df)
        exp_ = self.point.predict(X)
        q = calibrate(self.quantile.predict(X), df, self.calibration)
        q[:, 0] = np.minimum(q[:, 0], exp_)
        q[:, 2] = np.maximum(q[:, 2], exp_)
        out = pd.DataFrame({"peak_expected": exp_, "peak_p10": q[:, 0], "peak_p50": q[:, 1], "peak_p90": q[:, 2],
                            "peak_licences": np.rint(exp_).astype(int),
                            "peak_licences_high_case": np.ceil(q[:, 2] - 1e-9).astype(int)}, index=df.index)
        own = (df[C.OWNED] if owned is None else pd.Series(owned, index=df.index)).to_numpy(float)
        prob, qty = shortage_from_quantiles(q, own)
        out["utilisation_pct"] = 100 * exp_ / np.maximum(own, 1)          # 41
        out["shortage_probability"] = prob                                 # 42
        out["shortage_flag"] = (prob >= 0.5).astype(int)
        out["shortage_licences_expected"] = qty                            # 43
        out["shortage_licences_high_case"] = np.clip(out["peak_licences_high_case"] - own, 0, None)
        return out

    def explain(self, df: pd.DataFrame, top: int = 3) -> pd.DataFrame:
        X = self.builder.transform(df)
        contrib = self.point.contributions(X)
        if contrib is None:
            contrib = self._occlusion(X)
        groups = list(FEATURE_GROUPS)
        G = np.zeros((len(X), len(groups)))
        for j, f in enumerate(X.columns):
            G[:, groups.index(self.builder.group_of(f))] += contrib[:, j]
        pred = self.point.predict(X)
        rows = []
        for i in range(len(X)):
            drv = {g: float(G[i, k]) for k, g in enumerate(groups)}
            parts = [f"{v:+.1f} {k.lower()}" for k, v in sorted(drv.items(), key=lambda kv: -abs(kv[1]))[:top] if abs(v) >= 0.1]
            r = df.iloc[i]
            rows.append(dict(row_id=r.get(C.ROW_ID), peak_expected=float(pred[i]), typical=float(contrib[i, -1]), **drv,
                             text=(f"Pool {r[C.GROUP]} / {r.get('software_name', r['software_id'])}, month starting "
                                   f"{pd.Timestamp(r['target_month_start']).date()}: {pred[i]:.1f} licences at peak vs a "
                                   f"typical {contrib[i, -1]:.1f}. Drivers: {'; '.join(parts) or 'none significant'}.")))
        return pd.DataFrame(rows, index=df.index)

    def _occlusion(self, X: pd.DataFrame) -> np.ndarray:
        ref = self.meta["reference_row"]
        pred = self.point.predict(X)
        base = float(self.point.predict(pd.DataFrame([ref])[X.columns].astype(X.dtypes.to_dict()))[0])
        groups = list(FEATURE_GROUPS)
        eff = np.zeros((len(X), len(groups)))
        for k, g in enumerate(groups):
            Xo = X.copy()
            for c in [c for c in X.columns if self.builder.group_of(c) == g]:
                Xo[c] = pd.Series([ref[c]] * len(X), index=X.index).astype(X[c].dtype)
            eff[:, k] = pred - self.point.predict(Xo)
        tot = eff.sum(1, keepdims=True)
        eff *= np.divide((pred - base)[:, None], tot, out=np.ones_like(tot), where=np.abs(tot) > 1e-9)
        out = np.zeros((len(X), X.shape[1] + 1))
        out[:, -1] = base
        for k, g in enumerate(groups):
            idx = [j for j, c in enumerate(X.columns) if self.builder.group_of(c) == g]
            if idx:
                out[:, idx[0]] = eff[:, k]
        return out

    def save(self, folder: Path):
        folder.mkdir(parents=True, exist_ok=True)
        with open(folder / "forecaster.pkl", "wb") as f:
            pickle.dump(self, f)
        save_xgboost_json(self.point, folder / "xgb_peak_model.json")
        save_xgboost_json(self.quantile, folder / "xgb_peak_quantile_model.json")

    @staticmethod
    def load(folder: Path) -> "Forecaster":
        with open(Path(folder) / "forecaster.pkl", "rb") as f:
            return pickle.load(f)


# ------------------------------------------------------------------ calibration
def _buckets(df: pd.DataFrame, q50: np.ndarray) -> list[str]:
    cold = df["months_elapsed_at_cutoff"].to_numpy() == 0
    h = df["forecast_after_months"].to_numpy()
    hb = np.select([(h >= a) & (h <= b) for a, b in H_BUCKETS], range(len(H_BUCKETS)), 0)
    lvl = np.digitize(q50, LEVEL_EDGES)
    return [f"{'cold' if c else 'seen'}|h{x}|L{l}" for c, x, l in zip(cold, hb, lvl)]


def fit_calibration(df, q, y) -> dict:
    b = np.array(_buckets(df, q[:, 1]))
    out = {}
    for key in list(np.unique(b)) + ["__all__"]:
        m = (b == key) if key != "__all__" else np.ones(len(b), bool)
        n = int(m.sum())
        if n < 200 and key != "__all__":
            continue
        hi = min(1.0, np.ceil((n + 1) * 0.9) / n)
        out[key] = dict(c10=float(np.quantile(y[m] - q[m, 0], 1 - hi)), c90=float(np.quantile(y[m] - q[m, 2], hi)), n=n)
    return out


def calibrate(q, df, cal) -> np.ndarray:
    if not cal:
        return q
    q = q.copy()
    for i, key in enumerate(_buckets(df, q[:, 1])):
        c = cal.get(key, cal["__all__"])
        q[i, 0] += c["c10"]; q[i, 2] += c["c90"]
    return np.clip(np.sort(q, axis=1), 0, None)


# ------------------------------------------------------------------ cross-validation
def cross_validate(train, feature_set, objective, params, backend, folds, weighted=False, quantile=False) -> dict:
    y = train[C.TARGET].to_numpy(float)
    w_all = train[C.WEIGHT].to_numpy(float) if weighted else None
    oof = np.zeros((len(train), 3)) if quantile else np.zeros(len(train))
    rounds, fold_mae, t0 = [], [], time.time()
    for k in np.unique(folds):
        tr, va = folds != k, folds == k
        trd = train[tr]
        es = early_stop_mask(trd[C.GROUP])
        fb = FeatureBuilder(feature_set).fit(trd[~es])
        Xtr, Xes, Xva = fb.transform(trd[~es]), fb.transform(trd[es]), fb.transform(train[va])
        wtr = w_all[tr][~es] if weighted else None
        wes = w_all[tr][es] if weighted else None
        if quantile:
            m = QuantileModel(C.QUANTILES, params=params, backend=backend, seed=C.SEED)
            m.fit(Xtr, y[tr][~es], Xes, y[tr][es], w=wtr, w_es=wes)
        else:
            m = PointModel(objective, params=params, backend=backend, seed=C.SEED)
            m.fit(Xtr, y[tr][~es], Xes, y[tr][es], w=wtr, w_es=wes)
        oof[va] = m.predict(Xva)
        if not quantile:
            fold_mae.append(metrics(y[va], oof[va])["mae"])
        rounds.append(m.best_rounds)
    res = dict(feature_set=feature_set, objective=objective, params=params, weighted=weighted,
               rounds=int(np.median(rounds)), seconds=round(time.time() - t0, 1), oof=oof)
    if not quantile:
        res.update(metrics(y, oof), mae_std=float(np.std(fold_mae)))
    return res


def run_experiments(train, backend="auto", n_trials=C.N_TUNING_TRIALS, n_folds=C.CV_FOLDS, log=print):
    backend = backend_name(backend)
    folds = group_folds(train[C.GROUP], n_folds)
    y = train[C.TARGET].to_numpy(float)
    rows = []

    def record(step, name, res, kept, note=""):
        rows.append(dict(step=step, experiment=name, feature_set=res["feature_set"], objective=res["objective"],
                         weighted=res["weighted"], cv_mae=res["mae"], cv_mae_std=res["mae_std"], cv_rmse=res["rmse"],
                         cv_wape=res["wape"], cv_r2=res["r2"], cv_within_1=res["within_1"], cv_within_2=res["within_2"],
                         rounds=res["rounds"], seconds=res["seconds"], kept=kept, note=note,
                         params={k: (float(v) if isinstance(v, (float, np.floating)) else v) for k, v in res["params"].items()}))
        log(f"  {step:<26} {name:<46} CV MAE {res['mae']:.4f} +/- {res['mae_std']:.4f}{'  <- kept' if kept else ''}"
            f"{'  (' + note + ')' if note else ''}")

    for name, v in baselines(train).items():
        m = metrics(y, v)
        rows.append(dict(step="0 simple rule", experiment=name, cv_mae=m["mae"], cv_rmse=m["rmse"], cv_wape=m["wape"],
                         cv_r2=m["r2"], cv_within_1=m["within_1"], cv_within_2=m["within_2"], kept=False))
        log(f"  {'0 simple rule':<26} {name:<46} MAE    {m['mae']:.4f}")

    best = cross_validate(train, "core", "squared_error", {}, backend, folds)
    record("1 core features", f"{backend}, default settings", best, True)

    res = cross_validate(train, "engineered", "squared_error", {}, backend, folds)
    kept = res["mae"] < best["mae"]
    best = res if kept else best
    record("2 engineered features", "+ derived features 27, 28, 36, 38", res, kept)

    res = cross_validate(train, "capacity", best["objective"], best["params"], backend, folds)
    record("3 capacity features", "+ licences owned / headroom / renewal (13-16)", res, False,
           "not used: supply must not change predicted demand")

    res = cross_validate(train, best["feature_set"], best["objective"], best["params"], backend, folds, weighted=True)
    kept = res["mae"] < best["mae"]
    best = res if kept else best
    record("4 sample weights", "each project weighted equally", res, kept)

    for obj in [o for o in OBJECTIVES if o != "squared_error"]:
        if backend == "sklearn" and obj == "tweedie":
            continue
        res = cross_validate(train, best["feature_set"], obj, best["params"], backend, folds, best["weighted"])
        kept = res["mae"] < best["mae"]
        best = res if kept else best
        record("5 loss function", f"objective = {obj}", res, kept)

    rng = np.random.default_rng(C.SEED)
    for t in range(n_trials):
        p = sample_params(rng)
        res = cross_validate(train, best["feature_set"], best["objective"], p, backend, folds, best["weighted"])
        kept = res["mae"] < best["mae"]
        best = res if kept else best
        record("6 hyperparameter search", f"trial {t + 1}: depth {p['max_depth']}, eta {p['eta']}, mcw {p['min_child_weight']}",
               res, kept)

    log("  quantile model (P10/P50/P90): out-of-fold run for calibration ...")
    q = cross_validate(train, best["feature_set"], "quantile", best["params"], backend, folds, best["weighted"], quantile=True)
    best.update(oof_quantiles=q["oof"], folds=folds, backend=backend)
    return pd.DataFrame(rows), best


def fit_final(train, best) -> Forecaster:
    y = train[C.TARGET].to_numpy(float)
    w = train[C.WEIGHT].to_numpy(float) if best["weighted"] else None
    fb = FeatureBuilder(best["feature_set"]).fit(train)
    X = fb.transform(train)
    point = PointModel(best["objective"], params=best["params"], backend=best["backend"], seed=C.SEED)
    point.fit(X, y, rounds=max(50, int(best["rounds"] * 1.1)), w=w)
    es = early_stop_mask(train[C.GROUP])
    quant = QuantileModel(C.QUANTILES, params=best["params"], backend=best["backend"], seed=C.SEED)
    quant.fit(X[~es], y[~es], X[es], y[es], w=None if w is None else w[~es], w_es=None if w is None else w[es])
    cal = fit_calibration(train, best["oof_quantiles"], y)
    ref = {c: (X[c].mode().iloc[0] if str(X[c].dtype) == "category" else float(X[c].median())) for c in X.columns}
    import sklearn
    meta = dict(backend=best["backend"], feature_set=best["feature_set"], objective=best["objective"],
                weighted=best["weighted"], params=best["params"], rounds=point.best_rounds, features=list(X.columns),
                optional_features_found=fb.optional, training_rows=len(train),
                training_portfolios=int(train[C.GROUP].nunique()), training_projects=int(train[C.PROJECT].nunique()),
                cv_mae=best["mae"], reference_row=ref, python=platform.python_version(), sklearn=sklearn.__version__)
    try:
        import xgboost
        meta["xgboost"] = xgboost.__version__
    except ImportError:
        meta["xgboost"] = None
    return Forecaster(fb, point, quant, cal, meta)


def residual_structure(train, best) -> dict:
    """Correlations of standardised out-of-fold errors, reused by the Monte Carlo simulation."""
    q = best["oof_quantiles"]
    z = (train[C.TARGET].to_numpy() - best["oof"]) / np.maximum((q[:, 2] - q[:, 0]) / (2 * Z90), 0.5)
    d = train.assign(z=z)
    d = d.sort_values([C.PROJECT, "software_id", "months_elapsed_at_cutoff", "forecast_after_months"])
    lag = d.groupby([C.PROJECT, "software_id", "months_elapsed_at_cutoff"])["z"].shift(1)
    both = pd.concat([d["z"], lag], axis=1).dropna()
    piv = d[d["months_elapsed_at_cutoff"] == 0].pivot_table(index=[C.PROJECT, "forecast_after_months"],
                                                             columns="software_id", values="z")
    cross = []
    for i, a in enumerate(piv.columns):
        for b in piv.columns[i + 1:]:
            pair = piv[[a, b]].dropna()
            if len(pair) > 50:
                cross.append(pair.corr().iloc[0, 1])
    return dict(across_months=float(np.clip(both.corr().iloc[0, 1], 0, 0.95)) if len(both) > 50 else 0.5,
                cross_software=float(np.clip(np.nanmean(cross), 0, 0.9)) if cross else 0.3)
