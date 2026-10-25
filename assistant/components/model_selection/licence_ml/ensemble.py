"""
Ensemble of light forecasting models for target 39 (future peak demand on a shared licence pool),
compared on time-ordered data and selected by cross-validated accuracy.

Why time-based: a forecast is only useful if it works on months the model has not seen. Every
evaluation here trains on rows whose label month had *closed* before the validation period
starts (a purge: a 5-month-ahead training row whose label falls inside the validation window
is excluded), and validates on later cut-offs.

Candidates (all light; fixed, sensible settings, no large search, to avoid overfitting the
selection to this dataset):
  rule_last30      pool peak of the last 30 days (what people do today)
  rule_plan        planned pool load x licences-per-load ratio learned on training rows
  ridge            regularised linear model (one-hot categories, scaled numerics)
  poisson_glm      Poisson GLM (count data, log link)
  random_forest    bagged trees, shallow leaves capped, half-sample bootstrap
  extra_trees      randomised trees
  hist_gbm         scikit-learn histogram gradient boosting, absolute-error loss
  lightgbm         LightGBM, L1 loss
  xgboost          XGBoost via the existing licence_ml.model.PointModel (absolute-error loss)
  ens_top3_mean    mean of the three best single models (chosen on earlier folds only)
  ens_stacked      non-negative weights summing to 1, fitted on earlier folds' out-of-fold errors

Selection rule (fixed before any test): the candidate with the lowest row-weighted MAE across the
walk-forward folds is selected. Ensembles compete on equal terms because their composition is
learned only from earlier folds. Candidates within one fold standard deviation are reported as
statistical ties (information only). Test sets are scored once, after selection, and never feed
back into the choice.
"""
from __future__ import annotations

import time
import warnings
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.optimize import minimize

from . import config as C
from .data import early_stop_mask
from .evaluate import metrics
from .features import CATEGORICAL, FeatureBuilder

SINGLE = ["rule_last30", "rule_plan", "ridge", "poisson_glm", "knn", "decision_tree", "random_forest", "extra_trees",
          "hist_gbm", "lightgbm", "xgboost"]
OPTIONAL_PACKAGES = {"lightgbm": "lightgbm", "xgboost": "xgboost"}   # candidate -> pip package it needs


def available_models(candidates: list[str] | None = None) -> tuple[list[str], dict[str, str]]:
    """Candidates whose packages are installed, plus {skipped candidate: reason}. Missing optional engines are
    skipped (and reported) instead of crashing the run."""
    import importlib.util
    keep, skipped = [], {}
    for m in (candidates or SINGLE):
        pkg = OPTIONAL_PACKAGES.get(m)
        if pkg and importlib.util.find_spec(pkg) is None:
            skipped[m] = f"package '{pkg}' not installed (pip install {pkg})"
        else:
            keep.append(m)
    return keep, skipped
ENSEMBLES = ["ens_top3_mean", "ens_stacked"]
LABELS = {
    "rule_last30": "Rule: pool peak of the last 30 days",
    "rule_plan": "Rule: planned load × learned licences-per-load",
    "ridge": "Ridge regression",
    "poisson_glm": "Poisson GLM",
    "knn": "k-nearest neighbours (k=30)",
    "decision_tree": "Single decision tree (depth 10)",
    "random_forest": "Random forest",
    "extra_trees": "Extra trees",
    "hist_gbm": "Histogram gradient boosting",
    "lightgbm": "LightGBM",
    "xgboost": "XGBoost (existing pipeline settings)",
    "ens_top3_mean": "Ensemble: mean of top 3",
    "ens_stacked": "Ensemble: stacked weights",
}
FAMILY = {
    "rule_last30": "rule", "rule_plan": "rule", "ridge": "linear", "poisson_glm": "linear", "knn": "instance-based",
    "decision_tree": "single tree", "random_forest": "bagged trees",
    "extra_trees": "bagged trees", "hist_gbm": "boosted trees", "lightgbm": "boosted trees", "xgboost": "boosted trees",
    "ens_top3_mean": "ensemble", "ens_stacked": "ensemble",
}
COMPLEXITY = {"rule_last30": 0, "rule_plan": 0, "ridge": 1, "poisson_glm": 1, "knn": 1, "decision_tree": 1,
              "random_forest": 2, "extra_trees": 2,
              "hist_gbm": 2, "lightgbm": 2, "xgboost": 2, "ens_top3_mean": 3, "ens_stacked": 3}


# ------------------------------------------------------------------ single models
class Model:
    name: str = ""

    def fit(self, X: pd.DataFrame, y: np.ndarray, w: np.ndarray | None, X_es=None, y_es=None, w_es=None) -> "Model":
        raise NotImplementedError

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        raise NotImplementedError


class RuleLast30(Model):
    name = "rule_last30"

    def fit(self, X, y, w, *a, **k):
        return self

    def predict(self, X):
        return X["portfolio_peak_last_30d"].fillna(0).to_numpy(float)


class RulePlan(Model):
    """Planned pool load × software licences-per-load (FeatureBuilder learns the ratio on training rows)."""
    name = "rule_plan"

    def fit(self, X, y, w, *a, **k):
        return self

    def predict(self, X):
        return np.clip(X["phase_est_pool_peak"].fillna(0).to_numpy(float), 0, None)


def _linear_prep():
    from sklearn.compose import ColumnTransformer, make_column_selector
    from sklearn.impute import SimpleImputer
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler
    return ColumnTransformer(
        [("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), CATEGORICAL),
         ("num", make_pipeline(SimpleImputer(strategy="median", add_indicator=True), StandardScaler()),
          make_column_selector(dtype_include=np.number))],
        remainder="drop")


def _as_str(X: pd.DataFrame) -> pd.DataFrame:
    X = X.copy()
    for c in CATEGORICAL:
        X[c] = X[c].astype(str)
    return X


class Ridge(Model):
    name = "ridge"

    def fit(self, X, y, w, *a, **k):
        from sklearn.linear_model import Ridge as R
        from sklearn.pipeline import make_pipeline
        self.m = make_pipeline(_linear_prep(), R(alpha=3.0))
        self.m.fit(_as_str(X), y, ridge__sample_weight=w)
        return self

    def predict(self, X):
        return np.clip(self.m.predict(_as_str(X)), 0, None)


class PoissonGLM(Model):
    name = "poisson_glm"

    def fit(self, X, y, w, *a, **k):
        from sklearn.linear_model import PoissonRegressor
        from sklearn.pipeline import make_pipeline
        self.m = make_pipeline(_linear_prep(), PoissonRegressor(alpha=1e-3, max_iter=400, solver="newton-cholesky"))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.m.fit(_as_str(X), y, poissonregressor__sample_weight=w)
        return self

    def predict(self, X):
        return np.clip(self.m.predict(_as_str(X)), 0, None)


class KNN(Model):
    """k-nearest neighbours on one-hot categories + standardised numerics. Uniform weights (distance weights would
    memorise training rows)."""
    name = "knn"

    def fit(self, X, y, w, *a, **k):
        from sklearn.neighbors import KNeighborsRegressor
        from sklearn.pipeline import make_pipeline
        self.m = make_pipeline(_linear_prep(), KNeighborsRegressor(n_neighbors=30, weights="uniform", n_jobs=-1))
        self.m.fit(_as_str(X), y)          # KNN has no sample weights
        return self

    def predict(self, X):
        return np.clip(self.m.predict(_as_str(X)), 0, None)


class DecisionTree(Model):
    """One shallow tree: the most interpretable tree model; large leaves keep it from memorising."""
    name = "decision_tree"

    def fit(self, X, y, w, *a, **k):
        from sklearn.tree import DecisionTreeRegressor
        self.m = DecisionTreeRegressor(max_depth=10, min_samples_leaf=50, random_state=C.SEED)
        self.m.fit(_tree_matrix(X), y, sample_weight=w)
        return self

    def predict(self, X):
        return np.clip(self.m.predict(_tree_matrix(X)), 0, None)


def _tree_matrix(X: pd.DataFrame) -> np.ndarray:
    X = X.copy()
    for c in CATEGORICAL:
        X[c] = X[c].cat.codes.astype(float)
    return X.fillna(-1.0).to_numpy(float)


class Forest(Model):
    def __init__(self, extra: bool):
        self.extra = extra
        self.name = "extra_trees" if extra else "random_forest"

    def fit(self, X, y, w, *a, **k):
        from sklearn.ensemble import ExtraTreesRegressor, RandomForestRegressor
        cls = ExtraTreesRegressor if self.extra else RandomForestRegressor
        self.m = cls(n_estimators=150, max_depth=18, min_samples_leaf=12, max_features=0.4,
                     bootstrap=True, max_samples=0.5, n_jobs=-1, random_state=C.SEED)
        self.m.fit(_tree_matrix(X), y, sample_weight=w)
        return self

    def predict(self, X):
        return np.clip(self.m.predict(_tree_matrix(X)), 0, None)


class HistGBM(Model):
    name = "hist_gbm"

    def fit(self, X, y, w, X_es=None, y_es=None, w_es=None, rounds=None):
        from sklearn.ensemble import HistGradientBoostingRegressor
        fixed = rounds is not None or X_es is None
        self.m = HistGradientBoostingRegressor(loss="absolute_error", learning_rate=0.06, max_depth=6, min_samples_leaf=40,
                                               l2_regularization=1.0, max_features=0.8, max_iter=int(rounds or 300),
                                               categorical_features="from_dtype", early_stopping=not fixed,
                                               n_iter_no_change=50, random_state=C.SEED)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if fixed:
                self.m.fit(X, y, sample_weight=w)
            else:
                self.m.set_params(max_iter=2000)
                self.m.fit(X, y, sample_weight=w, X_val=X_es, y_val=y_es, sample_weight_val=w_es)
        self.rounds = int(self.m.n_iter_)
        return self

    def predict(self, X):
        return np.clip(self.m.predict(X), 0, None)


class LightGBM(Model):
    name = "lightgbm"

    def fit(self, X, y, w, X_es=None, y_es=None, w_es=None, rounds=None):
        import lightgbm as lgb
        fixed = rounds is not None or X_es is None
        self.m = lgb.LGBMRegressor(objective="l1", learning_rate=0.05, num_leaves=31, min_child_samples=40,
                                   feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0,
                                   n_estimators=int(rounds or 300) if fixed else 3000, random_state=C.SEED,
                                   verbose=-1, n_jobs=-1)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")   # eval_set is deprecated in LightGBM 4.7 but still the portable API
            if fixed:
                self.m.fit(X, y, sample_weight=w)
            else:
                self.m.fit(X, y, sample_weight=w, eval_set=[(X_es, y_es)], eval_sample_weight=[w_es],
                           callbacks=[lgb.early_stopping(100, verbose=False)])
        self.rounds = int(self.m.n_estimators if fixed else (self.m.best_iteration_ or self.m.n_estimators))
        return self

    def predict(self, X):
        return np.clip(self.m.predict(X, num_iteration=self.rounds), 0, None)


class XGB(Model):
    """Re-uses the existing project's PointModel so this candidate matches the original pipeline."""
    name = "xgboost"

    def fit(self, X, y, w, X_es=None, y_es=None, w_es=None, rounds=None):
        from .model import PointModel
        self.m = PointModel("absolute_error", backend="xgboost", seed=C.SEED)
        if rounds is not None or X_es is None:
            self.m.fit(X, y, rounds=int(rounds or 300), w=w)
        else:
            self.m.fit(X, y, X_es, y_es, w=w, w_es=w_es)
        self.rounds = self.m.best_rounds
        return self

    def predict(self, X):
        return self.m.predict(X)


def make(name: str) -> Model:
    return {
        "rule_last30": RuleLast30, "rule_plan": RulePlan, "ridge": Ridge, "poisson_glm": PoissonGLM, "knn": KNN,
        "decision_tree": DecisionTree,
        "random_forest": lambda: Forest(False), "extra_trees": lambda: Forest(True), "hist_gbm": HistGBM,
        "lightgbm": LightGBM, "xgboost": XGB,
    }[name]()


# ------------------------------------------------------------------ ensemble weights
def stack_weights(P: np.ndarray, y: np.ndarray, w: np.ndarray | None = None) -> np.ndarray:
    """Non-negative weights summing to 1 that minimise weighted MAE of the blend (smoothed L1)."""
    k = P.shape[1]
    w = np.ones(len(y)) if w is None else w
    eps = 1e-3

    def loss(a):
        r = P @ a - y
        return float(np.sum(w * np.sqrt(r * r + eps)) / w.sum())

    res = minimize(loss, np.full(k, 1 / k), method="SLSQP", bounds=[(0, 1)] * k,
                   constraints=[{"type": "eq", "fun": lambda a: a.sum() - 1}], options={"maxiter": 300})
    a = np.clip(res.x, 0, None)
    a[a < 0.02] = 0  # drop negligible members so the blend stays explainable
    return a / a.sum()


# ------------------------------------------------------------------ temporal cross-validation
@dataclass
class Fold:
    name: str
    start: pd.Timestamp
    end: pd.Timestamp
    train: np.ndarray
    valid: np.ndarray


def target_end(df: pd.DataFrame) -> pd.Series:
    return df["target_month_start"] + pd.DateOffset(months=1)


def walk_forward_folds(dev: pd.DataFrame, starts: list[str], end: str) -> list[Fold]:
    """Expanding-window folds on cut-off date. Train rows must have a CLOSED label month before the
    validation window opens (purge), so no training label comes from the validation period."""
    te = target_end(dev)
    edges = [pd.Timestamp(s) for s in starts] + [pd.Timestamp(end)]
    folds = []
    for a, b in zip(edges[:-1], edges[1:]):
        train = (te <= a).to_numpy()
        valid = ((dev["cutoff_date"] >= a) & (dev["cutoff_date"] < b)).to_numpy()
        folds.append(Fold(f"{a.date()} to {(b - pd.Timedelta(days=1)).date()}", a, b, train, valid))
    return folds


@dataclass
class CVResult:
    oof: dict[str, np.ndarray] = field(default_factory=dict)        # model -> predictions on validation rows (NaN elsewhere)
    fold_rows: list[dict] = field(default_factory=list)             # per model per fold metrics
    seconds: dict[str, float] = field(default_factory=dict)
    weights: dict[str, dict] = field(default_factory=dict)          # fold -> ensemble composition used
    folds: list[Fold] = field(default_factory=list)


def _fit_predict(name, fb, dtr, des, dva, y, w):
    Xtr, Xes, Xva = fb.transform(dtr), fb.transform(des), fb.transform(dva)
    m = make(name)
    m.fit(Xtr, y(dtr), w(dtr), Xes, y(des), w(des))
    return m.predict(Xva), getattr(m, "rounds", None)


def cross_validate(dev: pd.DataFrame, folds: list[Fold], log=print, models=SINGLE) -> CVResult:
    y = lambda d: d[C.TARGET].to_numpy(float)                      # noqa: E731
    w = lambda d: d[C.WEIGHT].to_numpy(float)                      # noqa: E731
    res = CVResult(folds=folds)
    n = len(dev)
    for m in models + ENSEMBLES:
        res.oof[m] = np.full(n, np.nan)
        res.seconds[m] = 0.0
    yall = y(dev)
    for k, f in enumerate(folds):
        dtr_all = dev[f.train]
        es = early_stop_mask(dtr_all[C.GROUP])
        dtr, des, dva = dtr_all[~es], dtr_all[es], dev[f.valid]
        fb = FeatureBuilder("engineered").fit(dtr)          # encodings learned on this fold's training rows only
        log(f"  fold {k + 1}/{len(folds)} [{f.name}] train {len(dtr):,} rows (+{len(des):,} early-stop), validate {len(dva):,}")
        for m in models:
            t0 = time.time()
            p, rounds = _fit_predict(m, fb, dtr, des, dva, y, w)
            res.oof[m][f.valid] = p
            res.seconds[m] += time.time() - t0
            mm = metrics(y(dva), p)
            res.fold_rows.append(dict(model=m, fold=k + 1, window=f.name, rows=len(dva), rounds=rounds, **mm))
            log(f"     {m:<14} MAE {mm['mae']:.3f}  WAPE {mm['wape']:.1%}  ({time.time() - t0:.1f}s)")

        # ensembles: composition decided ONLY from earlier folds (forward-chained), equal blend for fold 1
        earlier = np.zeros(n, bool)
        for g in folds[:k]:
            earlier |= g.valid
        learn = [m for m in models if not m.startswith("rule_")]
        if k == 0:  # no earlier fold to learn from: both ensembles are the plain mean of all learned models
            top3 = list(learn)
            wts = {m: 1 / len(learn) for m in learn}
        else:
            score = {m: np.nanmean(np.abs(res.oof[m][earlier] - yall[earlier])) for m in learn}
            top3 = sorted(score, key=score.get)[:3]
            P = np.column_stack([res.oof[m][earlier] for m in learn])
            a = stack_weights(P, yall[earlier], dev.loc[earlier, C.WEIGHT].to_numpy(float))
            wts = {m: float(v) for m, v in zip(learn, a) if v > 0}
        res.weights[f.name] = dict(top3=top3, stacked=wts)
        Pv = {m: res.oof[m][f.valid] for m in learn}
        res.oof["ens_top3_mean"][f.valid] = np.mean([Pv[m] for m in top3], axis=0)
        res.oof["ens_stacked"][f.valid] = np.sum([Pv[m] * v for m, v in wts.items()], axis=0)
        for m in ENSEMBLES:
            mm = metrics(y(dva), res.oof[m][f.valid])
            res.fold_rows.append(dict(model=m, fold=k + 1, window=f.name, rows=len(dva), rounds=None, **mm))
            log(f"     {m:<14} MAE {mm['mae']:.3f}  WAPE {mm['wape']:.1%}")
    return res


def leaderboard(dev: pd.DataFrame, res: CVResult) -> pd.DataFrame:
    fr = pd.DataFrame(res.fold_rows)
    y = dev[C.TARGET].to_numpy(float)
    rows = []
    for m, g in fr.groupby("model", sort=False):
        mask = ~np.isnan(res.oof[m])
        overall = metrics(y[mask], res.oof[m][mask])
        rows.append(dict(model=m, label=LABELS[m], family=FAMILY[m], cv_mae=overall["mae"], cv_mae_fold_std=float(g["mae"].std()),
                         cv_rmse=overall["rmse"], cv_wape=overall["wape"], cv_bias=overall["bias"], cv_r2=overall["r2"],
                         cv_within_1=overall["within_1"], cv_within_2=overall["within_2"], cv_rows=overall["n"],
                         fold_mae=[round(v, 4) for v in g.sort_values("fold")["mae"]], seconds=round(res.seconds.get(m, 0.0), 1)))
    lb = pd.DataFrame(rows).sort_values("cv_mae").reset_index(drop=True)
    lb["rank_cv"] = np.arange(1, len(lb) + 1)
    return lb


def select(lb: pd.DataFrame) -> tuple[str, str, list[str]]:
    """Most accurate on walk-forward CV. Near-ties (within one fold std of the winner) are reported."""
    best = lb.iloc[0]
    ties = lb[(lb["model"] != best["model"]) & (lb["cv_mae"] <= best["cv_mae"] + best["cv_mae_fold_std"])]["model"].tolist()
    second = lb.iloc[1]
    why = (f"Lowest walk-forward CV MAE: {best['cv_mae']:.3f} licences, {1 - best['cv_mae'] / second['cv_mae']:.1%} below "
           f"the next candidate ({LABELS[second['model']]}, {second['cv_mae']:.3f}).")
    if ties:
        why += f" {len(ties)} candidate{'s are' if len(ties) > 1 else ' is'} within one fold standard deviation, so the margin is small."
    return str(best["model"]), why, ties


# ------------------------------------------------------------------ final model
@dataclass
class EnsembleForecaster:
    builder: FeatureBuilder
    models: dict[str, Model]
    selected: str
    top3: list[str]
    stacked: dict[str, float]
    conformal: dict
    meta: dict = field(default_factory=dict)
    prob_calibrator: object | None = None   # isotonic map raw shortage probability -> observed frequency (fitted on OOF rows)

    def calibrate_probability(self, raw: np.ndarray) -> np.ndarray:
        raw = np.asarray(raw, float)
        return raw if self.prob_calibrator is None else np.clip(self.prob_calibrator.predict(raw), 0, 1)

    def predict_all(self, df: pd.DataFrame) -> dict[str, np.ndarray]:
        X = self.builder.transform(df)
        out = {m: mdl.predict(X) for m, mdl in self.models.items()}
        out["ens_top3_mean"] = np.mean([out[m] for m in self.top3], axis=0)
        out["ens_stacked"] = np.sum([out[m] * v for m, v in self.stacked.items()], axis=0)
        return out

    def predict(self, df: pd.DataFrame) -> pd.DataFrame:
        """Point forecast from the selected model plus conformal P10/P90 from its out-of-fold errors."""
        p = self.predict_all(df)[self.selected]
        lo, hi = conformal_offsets(self.conformal, df, p)
        q10 = np.clip(p + lo, 0, None)
        q90 = np.maximum(p + hi, p)
        return pd.DataFrame({"peak_expected": p, "peak_p10": np.minimum(q10, p), "peak_p50": p, "peak_p90": q90}, index=df.index)


BOOSTED = {"hist_gbm", "lightgbm", "xgboost"}


def final_rounds(cv: CVResult, model: str) -> int | None:
    """Boosting rounds for the final refit: median early-stopped rounds across CV folds, +10% because the final model
    trains on more rows. Decided from CV only."""
    r = [f["rounds"] for f in cv.fold_rows if f["model"] == model and f.get("rounds")]
    return max(50, int(np.median(r) * 1.1)) if r else None


def fit_final(dev: pd.DataFrame, cv: CVResult, selected: str, models_to_fit: list[str] | None = None,
              log=print) -> EnsembleForecaster:
    """Refit every candidate on ALL development rows. (The previous version kept 12% of development pools aside
    for early stopping, so the final models never saw them; boosted models now use the round count learned in CV.)"""
    names = list(models_to_fit or SINGLE)
    y = dev[C.TARGET].to_numpy(float)
    wts = dev[C.WEIGHT].to_numpy(float)
    fb = FeatureBuilder("engineered").fit(dev)
    Xtr = fb.transform(dev)
    models, rounds_used = {}, {}
    for m in names:
        t0 = time.time()
        if m in BOOSTED:
            rounds_used[m] = final_rounds(cv, m)
            models[m] = make(m).fit(Xtr, y, wts, rounds=rounds_used[m])
        else:
            models[m] = make(m).fit(Xtr, y, wts)
        log(f"  final {m:<14} fitted in {time.time() - t0:.1f}s" + (f" ({rounds_used[m]} rounds)" if m in rounds_used else ""))
    # final ensemble composition from ALL out-of-fold predictions (still no test data involved)
    learn = [m for m in names if not m.startswith("rule_")]
    mask = ~np.isnan(cv.oof[learn[0]])
    score = {m: float(np.mean(np.abs(cv.oof[m][mask] - y[mask]))) for m in learn}
    top3 = sorted(score, key=score.get)[:3]
    a = stack_weights(np.column_stack([cv.oof[m][mask] for m in learn]), y[mask], wts[mask])
    stacked = {m: float(v) for m, v in zip(learn, a) if v > 0}
    conformal = fit_conformal(dev[mask], cv.oof[selected][mask], y[mask])
    fc = EnsembleForecaster(fb, models, selected, top3, stacked, conformal,
                            meta=dict(training_rows=int(len(dev)), training_pools=int(dev[C.GROUP].nunique()),
                                      final_boosting_rounds=rounds_used, candidates=names))
    decision = calibration_decision(dev, cv, selected)
    fc.meta["probability_calibration"] = decision
    if decision["use"]:
        fc.prob_calibrator = fit_probability_calibration(dev[mask], cv.oof[selected][mask], conformal)
    return fc


def calibration_decision(dev: pd.DataFrame, cv: "CVResult", selected: str) -> dict:
    """Forward-chained check (no test data): fit isotonic calibration on earlier folds, score Brier on the
    next fold. Calibration is used only if it lowers the average Brier score across those folds."""
    from sklearn.isotonic import IsotonicRegression
    flag = dev[C.SHORTFALL_FLAG].to_numpy(float)
    raw_b, cal_b = [], []
    for k in range(1, len(cv.folds)):
        tr = np.zeros(len(dev), bool)
        for f in cv.folds[:k]:
            tr |= f.valid
        va = cv.folds[k].valid
        conf = fit_conformal(dev[tr], cv.oof[selected][tr], dev.loc[tr, C.TARGET].to_numpy(float))
        r_tr = raw_shortage_probability(dev[tr], cv.oof[selected][tr], conf)
        r_va = raw_shortage_probability(dev[va], cv.oof[selected][va], conf)
        iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(r_tr, flag[tr])
        raw_b.append(float(np.mean((r_va - flag[va]) ** 2)))
        cal_b.append(float(np.mean((iso.predict(r_va) - flag[va]) ** 2)))
    use = bool(np.mean(cal_b) < np.mean(raw_b))
    return dict(use=use, brier_raw=raw_b, brier_calibrated=cal_b,
                note=("Isotonic calibration lowered the forward-chained Brier score, so it is applied."
                      if use else "Isotonic calibration did not lower the forward-chained Brier score, so raw probabilities are kept; read them as risk bands."))


def raw_shortage_probability(df: pd.DataFrame, p: np.ndarray, conformal: dict) -> np.ndarray:
    from .pool_outputs import shortage_stats
    lo, hi = conformal_offsets(conformal, df, p)
    q10, q90 = np.minimum(np.clip(p + lo, 0, None), p), np.maximum(p + hi, p)
    owned = df[C.OWNED].to_numpy(float)
    return np.array([shortage_stats(a, b, c, o)[0] for a, b, c, o in zip(q10, p, q90, owned)])


def fit_probability_calibration(df: pd.DataFrame, oof: np.ndarray, conformal: dict):
    """Isotonic regression of the observed shortage flag on the raw probability, using out-of-fold
    predictions only. Monotone, so risk rankings are unchanged; only the probability scale moves."""
    from sklearn.isotonic import IsotonicRegression
    raw = raw_shortage_probability(df, oof, conformal)
    iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip", increasing=True)
    iso.fit(raw, df[C.SHORTFALL_FLAG].to_numpy(float))
    return iso


# ------------------------------------------------------------------ conformal intervals
H_BUCKETS = [(1, 2), (3, 4), (5, 6)]
LEVEL_EDGES = [4, 8, 13]


def _bucket(df: pd.DataFrame, p: np.ndarray) -> np.ndarray:
    cold = (df["months_elapsed_at_cutoff"].to_numpy() == 0)
    h = df["forecast_after_months"].to_numpy()
    hb = np.select([(h >= a) & (h <= b) for a, b in H_BUCKETS], range(len(H_BUCKETS)), 0)
    lvl = np.digitize(p, LEVEL_EDGES)
    return np.array([f"{'cold' if c else 'seen'}|h{x}|L{l}" for c, x, l in zip(cold, hb, lvl)])


def fit_conformal(df: pd.DataFrame, pred: np.ndarray, y: np.ndarray, min_rows: int = 200) -> dict:
    """Split-conformal offsets for P10 / P90 from out-of-fold residuals, by horizon, history and level."""
    r = y - pred
    b = _bucket(df, pred)
    out = {}
    for key in list(np.unique(b)) + ["__all__"]:
        m = (b == key) if key != "__all__" else np.ones(len(b), bool)
        n = int(m.sum())
        if n < min_rows and key != "__all__":
            continue
        q_hi = min(1.0, np.ceil((n + 1) * 0.9) / n)
        q_lo = max(0.0, np.floor((n + 1) * 0.1) / n)
        out[key] = dict(lo=float(np.quantile(r[m], q_lo)), hi=float(np.quantile(r[m], q_hi)), n=n)
    return out


def conformal_offsets(cal: dict, df: pd.DataFrame, p: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    keys = _bucket(df, p)
    lo = np.array([cal.get(k, cal["__all__"])["lo"] for k in keys])
    hi = np.array([cal.get(k, cal["__all__"])["hi"] for k in keys])
    return lo, hi
