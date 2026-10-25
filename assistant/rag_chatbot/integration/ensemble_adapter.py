"""
Make the selected ensemble model (components/model_selection) usable everywhere the Forecaster is used:
the forecasting component's Monte Carlo PoolSimulator, what-ifs, option costing and the chatbot's explanations.

Both projects name their package `licence_ml`, and the ensemble project's config/data/evaluate/features/model
modules are byte-identical to the forecasting component's. So instead of importing two different `licence_ml` packages, the
ensemble's extra modules (ensemble.py, pool_outputs.py) are added to the one already imported from forecasting component by
extending the package search path. The pickled EnsembleForecaster then loads with its real classes.
"""
from __future__ import annotations

import pickle
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

IDENTICAL_MODULES = ("config.py", "data.py", "evaluate.py", "features.py", "model.py")


def attach_ensemble_modules(ensemble_dir: Path) -> None:
    import licence_ml
    extra = str((Path(ensemble_dir) / "licence_ml").resolve())
    if extra not in list(licence_ml.__path__):
        licence_ml.__path__.append(extra)


def check_shared_modules(forecast_dir: Path, ensemble_dir: Path) -> list[str]:
    """Names of shared modules that are NOT identical (should be empty)."""
    a, b = Path(forecast_dir) / "licence_ml", Path(ensemble_dir) / "licence_ml"
    return [m for m in IDENTICAL_MODULES if (a / m).read_bytes() != (b / m).read_bytes()]


class EnsembleAsForecaster:
    """Wraps licence_ml.ensemble.EnsembleForecaster with the methods/attributes the simulator and the chatbot use:
    predict(df) -> peak_expected/p10/p50/p90 (+ derived columns), explain(df), meta, builder."""

    def __init__(self, ens, reference_df: pd.DataFrame, residual_structure: dict, report: dict):
        self.ens = ens
        self.builder = ens.builder
        sel = ens.selected
        if sel == "ens_stacked":
            self.members = dict(ens.stacked)
        elif sel == "ens_top3_mean":
            self.members = {m: 1 / len(ens.top3) for m in ens.top3}
        else:
            self.members = {sel: 1.0}
        lb = {r["model"]: r for r in report.get("leaderboard", [])}
        import sklearn
        self.meta = dict(
            backend="ensemble", objective=report.get("model", {}).get("selected_label", sel), feature_set="engineered",
            cv_mae=float(lb.get(sel, {}).get("cv_mae", np.nan)), training_rows=ens.meta.get("training_rows"),
            training_portfolios=ens.meta.get("training_pools"), sklearn=sklearn.__version__, xgboost=None,
            python=ens.meta.get("python"), selected=sel, members=self.members,
            residual_structure=residual_structure)
        X = self.builder.transform(reference_df)
        self.reference = {c: (X[c].mode().iloc[0] if str(X[c].dtype) == "category" else float(X[c].median()))
                          for c in X.columns}

    # ---------------- predictions
    def _point_X(self, X: pd.DataFrame) -> np.ndarray:
        out = np.zeros(len(X))
        for m, w in self.members.items():
            out += w * self.ens.models[m].predict(X)
        return np.clip(out, 0, None)

    def predict(self, df: pd.DataFrame, owned=None) -> pd.DataFrame:
        from licence_ml import config as C
        from licence_ml.ensemble import conformal_offsets
        X = self.builder.transform(df)
        p = self._point_X(X)
        lo, hi = conformal_offsets(self.ens.conformal, df, p)
        p10 = np.minimum(np.clip(p + lo, 0, None), p)
        p90 = np.maximum(p + hi, p)
        own = (df[C.OWNED] if owned is None else pd.Series(owned, index=df.index)).to_numpy(float)
        from licence_ml.pool_outputs import shortage_stats
        st = np.array([shortage_stats(a, b, c, o) for a, b, c, o in zip(p10, p, p90, own)]) if len(df) else np.zeros((0, 2))
        prob = self.ens.calibrate_probability(st[:, 0]) if len(df) else st[:, 0]
        return pd.DataFrame({
            "peak_expected": p, "peak_p10": p10, "peak_p50": p, "peak_p90": p90,
            "peak_licences": np.rint(p).astype(int), "peak_licences_high_case": np.ceil(p90 - 1e-9).astype(int),
            "utilisation_pct": 100 * p / np.maximum(own, 1), "shortage_probability": prob,
            "shortage_flag": (prob >= 0.5).astype(int), "shortage_licences_expected": st[:, 1] if len(df) else st[:, 0],
            "shortage_licences_high_case": np.clip(np.ceil(p90 - 1e-9) - own, 0, None)}, index=df.index)

    # ---------------- explanation (occlusion by feature group, the same method forecasting component uses without TreeSHAP)
    def explain(self, df: pd.DataFrame, top: int = 3) -> pd.DataFrame:
        from licence_ml import config as C
        from licence_ml.features import FEATURE_GROUPS
        X = self.builder.transform(df)
        pred = self._point_X(X)
        ref = pd.DataFrame([self.reference])[X.columns]
        for c in X.columns:
            ref[c] = ref[c].astype(X[c].dtype)
        base = float(self._point_X(ref)[0])
        groups = list(FEATURE_GROUPS)
        eff = np.zeros((len(X), len(groups)))
        for k, g in enumerate(groups):
            cols = [c for c in X.columns if self.builder.group_of(c) == g]
            if not cols:
                continue
            Xo = X.copy()
            for c in cols:
                Xo[c] = pd.Series([self.reference[c]] * len(X), index=X.index).astype(X[c].dtype)
            eff[:, k] = pred - self._point_X(Xo)
        tot = eff.sum(1, keepdims=True)
        eff *= np.divide((pred - base)[:, None], tot, out=np.ones_like(tot), where=np.abs(tot) > 1e-9)
        rows = []
        for i in range(len(X)):
            drv = {g: float(eff[i, k]) for k, g in enumerate(groups)}
            parts = [f"{v:+.1f} {k.lower()}" for k, v in sorted(drv.items(), key=lambda kv: -abs(kv[1]))[:top] if abs(v) >= 0.1]
            r = df.iloc[i]
            rows.append(dict(row_id=r.get(C.ROW_ID), peak_expected=float(pred[i]), typical=base, **drv,
                             text=(f"Pool {r[C.GROUP]} / {r.get('software_name', r['software_id'])}, month starting "
                                   f"{pd.Timestamp(r['target_month_start']).date()}: {pred[i]:.1f} licences at peak vs a "
                                   f"typical {base:.1f}. Drivers: {'; '.join(parts) or 'none significant'}.")))
        return pd.DataFrame(rows, index=df.index)


def load(ensemble_dir: Path, forecast_dir: Path, dataset: pd.DataFrame, residual_structure: dict) -> EnsembleAsForecaster:
    import json
    ensemble_dir = Path(ensemble_dir)
    diff = check_shared_modules(forecast_dir, ensemble_dir)
    if diff:
        raise RuntimeError(f"Ensemble project's {diff} differ from the forecasting component's; cannot share the licence_ml package.")
    attach_ensemble_modules(ensemble_dir)
    art = ensemble_dir / "artifacts" / "ensemble" / "ensemble_forecaster.pkl"
    if not art.exists():
        raise FileNotFoundError(f"No trained ensemble at {art}. Run `python scripts/build_pipeline.py --retrain`.")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with open(art, "rb") as f:
            ens = pickle.load(f)
    rp = ensemble_dir / "reports" / "ensemble" / "ml_report.json"
    report = json.loads(rp.read_text(encoding="utf-8")) if rp.exists() else {}
    as_of = pd.Timestamp(report.get("model", {}).get("as_of", "2026-09-30"))
    ref = dataset[(dataset["split"] != "test") & (dataset["target_month_start"] + pd.DateOffset(months=1)
                                                   <= as_of + pd.Timedelta(days=1))]
    return EnsembleAsForecaster(ens, ref, residual_structure, report)
