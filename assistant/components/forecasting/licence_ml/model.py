"""
XGBoost models.

  PointModel     one number per row (peak licences needed on the pool). The loss function is chosen by
                 cross-validation: squared error, Poisson (count data), Tweedie or absolute error.
  QuantileModel  P10 / P50 / P90 in one XGBoost model (objective "reg:quantileerror").

Both use XGBoost's native categorical support and early stopping on a separate set of
projects. If XGBoost is not installed, scikit-learn's HistGradientBoostingRegressor is used
with equivalent settings so the pipeline still runs (results will differ slightly).
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

try:
    import xgboost as xgb
    HAS_XGBOOST = True
except ImportError:  # pragma: no cover
    xgb = None
    HAS_XGBOOST = False

DEFAULT_PARAMS = dict(eta=0.05, max_depth=6, min_child_weight=5, subsample=0.85, colsample_bytree=0.8,
                      reg_lambda=1.0, reg_alpha=0.0, gamma=0.0)
SEARCH_SPACE = dict(eta=[0.02, 0.03, 0.05, 0.08], max_depth=[4, 5, 6, 8, 10], min_child_weight=[1, 3, 5, 10, 20],
                    subsample=[0.7, 0.8, 0.9, 1.0], colsample_bytree=[0.5, 0.7, 0.85, 1.0],
                    reg_lambda=[0.5, 1, 3, 10], reg_alpha=[0, 0.1, 1], gamma=[0, 0.05, 0.2])
OBJECTIVES = {   # name -> (xgboost objective, scikit-learn loss)
    "squared_error": ("reg:squarederror", "squared_error"),
    "poisson": ("count:poisson", "poisson"),
    "tweedie": ("reg:tweedie", "poisson"),          # sklearn has no tweedie; poisson is the closest
    "absolute_error": ("reg:absoluteerror", "absolute_error"),
}
LOG_LINK = {"poisson", "tweedie"}
MAX_ROUNDS, EARLY_STOP = 4000, 150


def backend_name(prefer: str = "auto") -> str:
    if prefer == "sklearn" or (prefer == "auto" and not HAS_XGBOOST):
        return "sklearn"
    if not HAS_XGBOOST:
        raise ImportError("xgboost is not installed: pip install 'xgboost>=2.0'")
    return "xgboost"


def sample_params(rng: np.random.Generator) -> dict:
    return {k: v[rng.integers(len(v))] for k, v in SEARCH_SPACE.items()}


def _xgb_params(p: dict, seed: int) -> dict:
    return dict(tree_method="hist", eta=p["eta"], max_depth=int(p["max_depth"]),
                min_child_weight=p["min_child_weight"], subsample=p["subsample"],
                colsample_bytree=p["colsample_bytree"], reg_lambda=p["reg_lambda"], reg_alpha=p["reg_alpha"],
                gamma=p["gamma"], max_cat_to_onehot=8, seed=seed, nthread=-1)


def _sk_params(p: dict, seed: int) -> dict:
    return dict(learning_rate=min(0.2, p["eta"] * 2), max_depth=int(p["max_depth"]),
                min_samples_leaf=max(5, int(p["min_child_weight"] * 4)), l2_regularization=p["reg_lambda"],
                max_features=p["colsample_bytree"], categorical_features="from_dtype", max_iter=1500,
                early_stopping=True, n_iter_no_change=40, random_state=seed)


class _Base:
    def __init__(self, params: dict | None = None, backend: str = "auto", seed: int = 2026):
        self.params = dict(DEFAULT_PARAMS, **(params or {}))
        self.backend = backend_name(backend)
        self.seed = seed
        self.best_rounds: int | None = None
        self.features: list[str] = []

    def _dm(self, X, y=None, w=None):
        return xgb.DMatrix(X, label=y, weight=w, enable_categorical=True)


class PointModel(_Base):
    def __init__(self, objective: str = "squared_error", **kw):
        super().__init__(**kw)
        self.objective = objective

    def fit(self, X, y, X_es=None, y_es=None, rounds: int | None = None, w=None, w_es=None):
        self.features = list(X.columns)
        xo, sko = OBJECTIVES[self.objective]
        if self.backend == "xgboost":
            prm = dict(_xgb_params(self.params, self.seed), objective=xo, eval_metric="mae")
            if self.objective == "tweedie":
                prm["tweedie_variance_power"] = 1.2
            evals = [(self._dm(X_es, y_es, w_es), "es")] if X_es is not None else []
            self.booster = xgb.train(prm, self._dm(X, y, w), num_boost_round=rounds or MAX_ROUNDS, evals=evals,
                                     early_stopping_rounds=EARLY_STOP if evals and not rounds else None,
                                     verbose_eval=False)
            self.best_rounds = (self.booster.best_iteration + 1) if evals and not rounds else (rounds or MAX_ROUNDS)
        else:
            from sklearn.ensemble import HistGradientBoostingRegressor
            prm = _sk_params(self.params, self.seed)
            if rounds:
                prm.update(max_iter=rounds, early_stopping=False)
            self.model = HistGradientBoostingRegressor(loss=sko, **prm)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                if X_es is not None and not rounds:
                    self.model.fit(X, y, sample_weight=w, X_val=X_es, y_val=y_es, sample_weight_val=w_es)
                else:
                    self.model.fit(X, y, sample_weight=w)
            self.best_rounds = int(self.model.n_iter_)
        return self

    def predict(self, X) -> np.ndarray:
        X = X[self.features]
        if self.backend == "xgboost":
            p = self.booster.predict(self._dm(X), iteration_range=(0, self.best_rounds))
        else:
            p = self.model.predict(X)
        return np.clip(np.asarray(p, float), 0, None)

    def contributions(self, X) -> np.ndarray | None:
        """Per-feature contribution to each prediction, in licences (last column = average).
        XGBoost TreeSHAP; for log-link losses the log-scale values are rescaled so they add up
        to the prediction."""
        if self.backend != "xgboost":
            return None
        X = X[self.features]
        c = np.asarray(self.booster.predict(self._dm(X), pred_contribs=True, iteration_range=(0, self.best_rounds)))
        if self.objective in LOG_LINK:
            pred = self.predict(X)
            base = np.exp(c[:, -1])
            phi = c[:, :-1]
            tot = phi.sum(1, keepdims=True)
            scale = np.divide((pred - base)[:, None], tot, out=np.zeros_like(tot), where=np.abs(tot) > 1e-9)
            return np.column_stack([phi * scale, base])
        return c


class QuantileModel(_Base):
    def __init__(self, quantiles=(0.1, 0.5, 0.9), **kw):
        super().__init__(**kw)
        self.quantiles = tuple(quantiles)

    def fit(self, X, y, X_es=None, y_es=None, w=None, w_es=None):
        self.features = list(X.columns)
        if self.backend == "xgboost":
            prm = dict(_xgb_params(self.params, self.seed), objective="reg:quantileerror",
                       quantile_alpha=np.array(self.quantiles))
            evals = [(self._dm(X_es, y_es, w_es), "es")] if X_es is not None else []
            self.booster = xgb.train(prm, self._dm(X, y, w), num_boost_round=MAX_ROUNDS, evals=evals,
                                     early_stopping_rounds=EARLY_STOP if evals else None, verbose_eval=False)
            self.best_rounds = (self.booster.best_iteration + 1) if evals else MAX_ROUNDS
        else:
            from sklearn.ensemble import HistGradientBoostingRegressor
            self.models = []
            for q in self.quantiles:
                m = HistGradientBoostingRegressor(loss="quantile", quantile=q, **_sk_params(self.params, self.seed))
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    if X_es is not None:
                        m.fit(X, y, sample_weight=w, X_val=X_es, y_val=y_es, sample_weight_val=w_es)
                    else:
                        m.fit(X, y, sample_weight=w)
                self.models.append(m)
            self.best_rounds = int(max(m.n_iter_ for m in self.models))
        return self

    def predict(self, X) -> np.ndarray:
        X = X[self.features]
        if self.backend == "xgboost":
            q = np.asarray(self.booster.predict(self._dm(X), iteration_range=(0, self.best_rounds))).reshape(len(X), -1)
        else:
            q = np.column_stack([m.predict(X) for m in self.models])
        return np.clip(np.sort(q, axis=1), 0, None)


def save_xgboost_json(model: _Base, path) -> bool:
    """Portable copy of the booster (loadable from any XGBoost language binding)."""
    if model.backend == "xgboost":
        model.booster.save_model(str(path))
        return True
    return False
