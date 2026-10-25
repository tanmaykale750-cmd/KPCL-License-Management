"""
Adapter around the forecasting component (components/forecasting, package `licence_ml`).

It uses the REAL objects of that project:
  * licence_ml.train.Forecaster      - the trained model (artifacts/forecaster.pkl)
  * licence_ml.simulate.PoolSimulator - the Monte Carlo pool simulation + options
  * reports/...                       - the outputs that project wrote (accuracy, pool forecasts, ...)

Nothing here invents numbers: every value comes from the model, the simulation or the files
the forecasting component's code produced. Heavy objects (dataset, model, per-portfolio simulators) are cached.
"""
from __future__ import annotations

import json
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


class MLUnavailable(RuntimeError):
    """Raised when a live model feature is requested but the trained model cannot be used."""


@dataclass
class WhatIfRequest:
    portfolio_id: str
    software_id: str
    licence_change: int = 0                    # +/- permanent licences for this software
    temp_licences: int = 0                     # max temporary licences per month
    delay_projects: dict = field(default_factory=dict)   # project_id -> months
    cancel_projects: list = field(default_factory=list)
    team_size: dict = field(default_factory=dict)        # project_id -> new team size
    name: str = "What-if"

    def is_empty(self) -> bool:
        return not (self.licence_change or self.temp_licences or self.delay_projects
                    or self.cancel_projects or self.team_size)

    def describe(self) -> str:
        parts = []
        if self.licence_change:
            parts.append(f"{self.licence_change:+d} permanent {self.software_id} licence(s)")
        if self.temp_licences:
            parts.append(f"up to {self.temp_licences} temporary {self.software_id} licence(s) per month")
        parts += [f"delay {p} by {k} month(s)" for p, k in self.delay_projects.items()]
        parts += [f"cancel {p}" for p in self.cancel_projects]
        parts += [f"team size of {p} -> {n}" for p, n in self.team_size.items()]
        return ", ".join(parts) or "no change"


MODELS = ("ensemble", "single")


class MLService:
    """model="ensemble": the selected model from components/model_selection (default);
    model="single": the single gradient-boosted Forecaster. Both run through the PoolSimulator."""

    def __init__(self, forecast_dir: Path, model: str = "single", ensemble_dir: Path | None = None):
        if model not in MODELS:
            raise ValueError(f"FORECAST_MODEL must be one of {MODELS}, got {model!r}")
        self.model = model
        self.ensemble_dir = Path(ensemble_dir).resolve() if ensemble_dir else None
        if model == "ensemble" and (self.ensemble_dir is None or not (self.ensemble_dir / "licence_ml").is_dir()):
            raise FileNotFoundError(f"Ensemble project not found at {self.ensemble_dir}")
        self.dir = Path(forecast_dir).resolve()
        if not (self.dir / "licence_ml").is_dir():
            raise FileNotFoundError(f"Forecasting component not found at {self.dir} (expected a licence_ml/ package)")
        if str(self.dir) not in sys.path:
            sys.path.insert(0, str(self.dir))
        from licence_ml import config as C          # noqa: WPS433 (import after sys.path set-up)
        from licence_ml import data as D
        self.C, self.D = C, D
        self._lock = threading.RLock()
        self._fc = None
        self._fc_error: str | None = None
        self._df = None
        self._sims: dict[str, Any] = {}

    # ------------------------------------------------------------------ paths
    @property
    def artifact_path(self) -> Path:
        if self.model == "ensemble":
            return self.ensemble_dir / "artifacts" / "ensemble" / "ensemble_forecaster.pkl"
        return self.C.ARTIFACTS / "forecaster.pkl"

    @property
    def reports_dir(self) -> Path:
        return self.ensemble_dir / "reports" if self.model == "ensemble" else self.C.REPORTS

    @property
    def sim_dir(self) -> Path:
        return self.reports_dir / "simulation"

    @property
    def model_label(self) -> str:
        if self.model == "ensemble":
            try:
                return "selected model from the light-model comparison: " + self.ensemble_report()["model"]["selected_label"]
            except Exception:
                return "selected ensemble model"
        return "the single gradient-boosted model"

    def ensemble_report(self) -> dict:
        return json.loads((self.ensemble_dir / "reports" / "ensemble" / "ml_report.json").read_text(encoding="utf-8"))

    def _residual_structure(self) -> dict:
        """Month-to-month and cross-software error correlation for the Monte Carlo. Measured on the forecasting component's out-of-fold
        errors (same dataset and features); the simulator's own defaults are used if that model is absent."""
        try:
            from licence_ml.train import Forecaster
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                return dict(Forecaster.load(self.C.ARTIFACTS).meta.get("residual_structure", {}))
        except Exception:
            return {}

    # ------------------------------------------------------------------ model
    def forecaster(self):
        """The trained Forecaster; raises MLUnavailable with a clear reason if it cannot be loaded."""
        with self._lock:
            if self._fc is not None:
                return self._fc
            if not self.artifact_path.exists():
                self._fc_error = (f"No trained model at {self.artifact_path}. Run "
                                  "`python scripts/build_pipeline.py --retrain` to train the model.")
                raise MLUnavailable(self._fc_error)
            try:
                import warnings
                if self.model == "ensemble":
                    from . import ensemble_adapter
                    self._fc = ensemble_adapter.load(self.ensemble_dir, self.dir, self.dataset(), self._residual_structure())
                else:
                    from licence_ml.train import Forecaster
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore")
                        self._fc = Forecaster.load(self.C.ARTIFACTS)
                self._fc_error = None
                return self._fc
            except Exception as e:  # unpickling can fail on a different scikit-learn/xgboost version
                self._fc_error = (f"The trained model could not be loaded ({type(e).__name__}: {e}). This usually "
                                  "means a different scikit-learn/xgboost version than the one it was trained with. "
                                  "Install the pinned versions from requirements.txt or retrain with "
                                  "`python scripts/build_pipeline.py --retrain`.")
                raise MLUnavailable(self._fc_error) from e

    def model_available(self) -> bool:
        try:
            self.forecaster()
            return True
        except MLUnavailable:
            return False

    def model_status(self) -> dict:
        ok = self.model_available()
        out = {"available": ok, "error": self._fc_error, "artifact": str(self.artifact_path), "model": self.model,
               "label": self.model_label}
        if ok:
            m = self._fc.meta
            out.update(backend=m.get("backend"), objective=m.get("objective"), feature_set=m.get("feature_set"),
                       cv_mae=m.get("cv_mae"), training_rows=m.get("training_rows"),
                       training_portfolios=m.get("training_portfolios"), sklearn=m.get("sklearn"),
                       xgboost=m.get("xgboost"), python=m.get("python"))
        return out

    def dataset(self) -> pd.DataFrame:
        with self._lock:
            if self._df is None:
                if not self.C.DATA_FILE.exists():
                    raise MLUnavailable(f"Dataset missing: {self.C.DATA_FILE}")
                self._df = self.D.load()
            return self._df

    def simulator(self, portfolio_id: str):
        """the PoolSimulator restricted to one portfolio (same results as the all-pool run, much faster)."""
        with self._lock:
            if portfolio_id not in self._sims:
                from licence_ml.simulate import PoolSimulator
                df = self.dataset()
                if portfolio_id not in set(df[self.C.GROUP].unique()):
                    raise ValueError(f"Unknown portfolio {portfolio_id}")
                self._sims[portfolio_id] = PoolSimulator(self.forecaster(), df, [portfolio_id])
            return self._sims[portfolio_id]

    # ------------------------------------------------------------------ files written by forecasting component
    def _read_csv(self, path: Path) -> pd.DataFrame:
        if not path.exists():
            raise FileNotFoundError(f"Missing forecast output: {path}")
        return pd.read_csv(path)

    def pool_forecast(self) -> pd.DataFrame:
        """reports/simulation/pool_forecast_by_month.csv (one row per portfolio x software x month)."""
        df = self._read_csv(self.sim_dir / "pool_forecast_by_month.csv")
        df["at_risk"] = df["at_risk"].astype(str).str.lower().isin(["true", "1"])
        df["main_projects"] = df["main_projects"].fillna("")
        return df

    def sim_recommendations(self) -> dict:
        p = self.sim_dir / "recommendations.json"
        if not p.exists():
            raise FileNotFoundError(f"Missing forecast output: {p}")
        return json.loads(p.read_text(encoding="utf-8"))

    def software_summary(self) -> pd.DataFrame:
        return self._read_csv(self.sim_dir / "software_summary.csv")

    def whatif_examples(self) -> dict:
        p = self.sim_dir / "whatif_examples.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}

    def holdout_report(self) -> dict:
        if self.model == "ensemble":
            return ensemble_holdout_view(self.ensemble_report())
        return json.loads((self.reports_dir / "holdout_report.json").read_text(encoding="utf-8"))

    def accuracy_markdown(self) -> str:
        if self.model == "ensemble":
            return (self.ensemble_dir / "reports" / "ensemble" / "ensemble_report.md").read_text(encoding="utf-8")
        return (self.reports_dir / "accuracy_report.md").read_text(encoding="utf-8")

    def feature_map(self) -> pd.DataFrame:
        return self._read_csv(self.C.REPORTS / "feature_map.csv")      # same feature set in both models

    def experiments(self) -> pd.DataFrame:
        if self.model == "ensemble":
            lb = self._read_csv(self.ensemble_dir / "reports" / "ensemble" / "leaderboard.csv")
            sel = self.ensemble_report()["model"]["selected"]
            return pd.DataFrame({"step": "rank " + lb["rank_cv"].astype(str), "experiment": lb["label"],
                                 "cv_mae": lb["cv_mae"], "cv_mae_std": lb["cv_mae_fold_std"], "cv_within_2": lb["cv_within_2"],
                                 "kept": lb["model"] == sel,
                                 "note": np.where(lb["model"] == sel, "selected (lowest walk-forward CV MAE)", "")})
        return self._read_csv(self.reports_dir / "experiments.csv")

    def model_comparison(self) -> pd.DataFrame | None:
        """Ensemble mode: every candidate's CV and test MAE (None for the single model)."""
        if self.model != "ensemble":
            return None
        lb = self._read_csv(self.ensemble_dir / "reports" / "ensemble" / "leaderboard.csv")
        tb = self._read_csv(self.ensemble_dir / "reports" / "ensemble" / "test_scores.csv")
        piv = tb.pivot(index="model", columns="test", values="mae")
        out = lb[["rank_cv", "model", "label", "family", "cv_mae", "cv_mae_fold_std", "cv_within_2"]].merge(
            piv, left_on="model", right_index=True, how="left")
        return out

    def holdout_explanations(self) -> pd.DataFrame:
        if self.model == "ensemble":
            raise FileNotFoundError("hold-out explanation samples exist only for the single gradient-boosted model")
        return self._read_csv(self.reports_dir / "holdout_sample_explanations.csv")

    def chart_paths(self) -> list[Path]:
        if self.model == "ensemble":
            return sorted((self.ensemble_dir / "reports" / "ensemble").glob("*.png")) + sorted(self.sim_dir.glob("*.png"))
        return sorted((self.reports_dir / "charts").glob("*.png")) + sorted(self.sim_dir.glob("*.png"))

    def readme(self) -> str:
        p = (self.ensemble_dir if self.model == "ensemble" else self.dir) / "README.md"
        return p.read_text(encoding="utf-8") if p.exists() else ""

    def lookup(self) -> pd.DataFrame:
        return self.D.lookup().reset_index()

    def assumptions_table(self) -> pd.DataFrame:
        return pd.read_csv(self.C.ASSUMPTIONS_FILE)

    # ------------------------------------------------------------------ live model features
    def live_pool_forecast(self, portfolio_id: str, software_id: str) -> pd.DataFrame:
        sim = self.simulator(portfolio_id)
        return sim.simulate(pools=[(portfolio_id, software_id)])["monthly"]

    def pool_rows(self, portfolio_id: str, software_id: str) -> pd.DataFrame:
        """The model input rows (as of the planning date) feeding this pool's simulation, with predictions."""
        sim = self.simulator(portfolio_id)
        b = sim._base
        if not len(b):
            return b
        return b[(b[self.C.GROUP] == portfolio_id) & (b["software_id"] == software_id)].copy()

    def explain_pool(self, portfolio_id: str, software_id: str) -> dict:
        """
        Run the model's own explanation (Forecaster.explain: TreeSHAP for XGBoost, occlusion by feature
        group for the scikit-learn backend) on the rows that drive this pool's forecast, and summarise
        the driver contributions per month.
        """
        from licence_ml.features import FEATURE_GROUPS
        rows = self.pool_rows(portfolio_id, software_id)
        if rows.empty:
            return {"portfolio_id": portfolio_id, "software_id": software_id, "months": [],
                    "note": "No project forecast rows fall in the planning window for this pool."}
        fc = self.forecaster()
        t0 = time.time()
        ex = fc.explain(rows)
        groups = list(FEATURE_GROUPS)
        ex["month"] = rows["month"].astype(str).to_numpy()
        ex["project_id"] = rows[self.C.PROJECT].to_numpy()
        ex["phase"] = rows["plan_phase_in_target_month"].to_numpy()
        months = []
        for m, g in ex.groupby("month", sort=True):
            drivers = {k: float(g[k].mean()) for k in groups}
            top = sorted(drivers.items(), key=lambda kv: -abs(kv[1]))
            months.append(dict(
                month=m, forecast_rows=int(len(g)),
                projects=sorted(set(g["project_id"])),
                peak_expected_mean=float(g["peak_expected"].mean()),
                typical_baseline=float(g["typical"].mean()),
                drivers={k: round(v, 2) for k, v in top},
                example=str(g.sort_values("peak_expected").iloc[-1]["text"])))
        b = fc.meta.get("backend")
        return {"portfolio_id": portfolio_id, "software_id": software_id,
                "backend": b,
                "method": ("XGBoost TreeSHAP" if b == "xgboost" else
                           f"occlusion by feature group on the selected model ({fc.meta.get('objective')})"
                           if b == "ensemble" else "occlusion by feature group (scikit-learn backend)"),
                "months": months, "seconds": round(time.time() - t0, 2)}

    def pool_projects(self, portfolio_id: str, software_id: str) -> pd.DataFrame:
        """Projects contributing to this pool in the window (for what-if pickers)."""
        rows = self.pool_rows(portfolio_id, software_id)
        if rows.empty:
            return pd.DataFrame(columns=["project_id", "priority", "team_size", "start", "deadline", "not_started"])
        g = rows.groupby(self.C.PROJECT).agg(priority=("project_priority", "first"), team_size=("team_size", "first"),
                                             start=("project_start_date", "first"),
                                             deadline=("project_deadline_date", "first"),
                                             not_started=("not_started", "first"),
                                             planned_load=("plan_load_index_target", "sum")).reset_index()
        g = g.rename(columns={self.C.PROJECT: "project_id"})
        g["start"] = pd.to_datetime(g["start"]).dt.date.astype(str)
        g["deadline"] = pd.to_datetime(g["deadline"]).dt.date.astype(str)
        return g.sort_values("planned_load", ascending=False).reset_index(drop=True)

    def what_if(self, req: WhatIfRequest) -> dict:
        """Run the forecasting component's Scenario through the PoolSimulator and compare with the current plan."""
        from licence_ml.simulate import Scenario
        pf, sw = req.portfolio_id, req.software_id
        sim = self.simulator(pf)
        sc = Scenario(name=req.name or req.describe(),
                      licence_changes={sw: int(req.licence_change)} if req.licence_change else {},
                      temp_licences={sw: int(req.temp_licences)} if req.temp_licences else {},
                      delay_projects={k: int(v) for k, v in req.delay_projects.items()},
                      cancel_projects=list(req.cancel_projects),
                      team_size={k: int(v) for k, v in req.team_size.items()})
        base = sim.simulate(pools=[(pf, sw)])["monthly"]
        res = sim.simulate(sc, pools=[(pf, sw)])
        new = res["monthly"]
        cols = ["month", "peak_p50", "peak_p90", "licences_owned", "temp_cap", "shortage_probability",
                "expected_shortage", "licences_needed", "at_risk"]
        cmp_ = base[cols].merge(new[cols], on="month", suffixes=("_before", "_after"))
        summary = dict(
            months_at_risk_before=int(base["at_risk"].sum()), months_at_risk_after=int(new["at_risk"].sum()),
            max_shortage_probability_before=float(base["shortage_probability"].max()),
            max_shortage_probability_after=float(new["shortage_probability"].max()),
            expected_shortage_licence_months_before=float(base["expected_shortage"].sum()),
            expected_shortage_licence_months_after=float(new["expected_shortage"].sum()),
            idle_cost_inr_before=float(base["idle_cost_inr"].sum()),
            idle_cost_inr_after=float(new["idle_cost_inr"].sum()))
        cost, residual = (sim._cost(sw, sc, res, pf) if res["valid"] else (0.0, 0.0))
        summary.update(added_cost_inr=float(cost), residual_shortage_cost_inr=float(residual))
        return {"request": req, "description": req.describe(), "valid": bool(res["valid"]), "errors": res["errors"],
                "comparison": cmp_, "monthly_after": new, "monthly_before": base, "summary": summary}

    def options(self, portfolio_id: str, software_id: str) -> pd.DataFrame:
        """the forecasting component's own option comparison (keep / temporary / buy / delay) re-run live."""
        o = self.simulator(portfolio_id).options(portfolio_id, software_id)
        return o.drop(columns=["scenario"], errors="ignore")

    def project_info(self, project_id: str) -> dict | None:
        """Portfolio and software of a project (projects belong to exactly one portfolio; data check in forecasting component)."""
        with self._lock:
            if not hasattr(self, "_proj"):
                pt = self.D.project_table(self.dataset())
                self._proj = {pid: {"portfolio_id": g[self.C.GROUP].iat[0], "software": sorted(g["software_id"]),
                                    "start": str(pd.Timestamp(g["start"].iat[0]).date()),
                                    "priority": g["priority"].iat[0]}
                              for pid, g in pt.groupby(self.C.PROJECT)}
        return self._proj.get(project_id)

    def portfolios(self) -> list[str]:
        try:
            return sorted(self.pool_forecast()["portfolio_id"].unique())
        except FileNotFoundError:
            return sorted(self.dataset()[self.C.GROUP].unique())


def to_jsonable(obj):
    """Small helper so tool results can be logged / shown as JSON."""
    if isinstance(obj, pd.DataFrame):
        return obj.to_dict("records")
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    return obj


def ensemble_holdout_view(r: dict) -> dict:
    """The ensemble's ml_report.json in the shape of the forecasting component's holdout_report.json (test A = known pools, future
    months, is the headline test; B and C are reported alongside)."""
    sel = r["model"]["selected"]
    sc = {(x["test"], x["model"]): x for x in r["tests"]["scores"]}
    a = sc[("A_out_of_time", sel)]
    d = r["tests"]["derived"]["A_out_of_time"]
    keys = ("mae", "rmse", "wape", "bias", "r2", "exact", "within_1", "within_2", "n")
    rules = {x["label"]: {k: x[k] for k in keys} for (t, m), x in sc.items() if t == "A_out_of_time" and m.startswith("rule_")}
    other = {t: {k: sc[(t, sel)][k] for k in keys} for t in ("B_unseen_pools", "C_unseen_pools_out_of_time")}
    return dict(
        verdict=r["acceptance"]["verdict"], backend=f"ensemble ({r['model']['selected_label']})",
        model={k: a[k] for k in keys}, baselines=rules,
        interval_coverage=dict(p90=d["p90_coverage"], p10_p90=d["p10_p90_coverage"], mean_width=d["mean_interval_width"]),
        derived_targets={"41_utilisation_pct": dict(mae_points=d["utilisation_mae_points"]),
                         "42_shortage_indicator": dict(auc=d["shortage_auc"], simple_rule_auc=d["shortage_rule_auc"])},
        checks=r["acceptance"]["checks"], by_horizon=r["tests"]["by_horizon"], by_software=r["tests"]["by_software"],
        by_history=r["tests"]["by_history"], other_tests=other, test_definitions=r["tests"]["definitions"],
        cv_mae=a.get("cv_mae"), selection_reason=r["model"]["selection_reason"])
