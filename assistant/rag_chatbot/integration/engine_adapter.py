"""
Adapter around the recommendation engine (components/recommendation_engine).

Uses the engine's real functions:
  * decision_engine.run_engine              - software-level grid search + newsvendor + business rules
  * portfolio_decision_engine.build_recommendations - forecast-aware pool recommendations from
                                              the forecasting component's pool_forecast_by_month.csv

The handoff the recommendation engine expects is the file data/member2/pool_forecast_by_month.csv. `sync_forecast_outputs`
copies the forecasting component's latest simulation outputs there, so the engine always runs on the model's real output.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

import pandas as pd

# forecasting component output file -> recommendation engine input file
HANDOFF = {
    "reports/simulation/pool_forecast_by_month.csv": "data/member2/pool_forecast_by_month.csv",
    "reports/simulation/recommendations.csv": "data/member2/member2_simulation_recommendations.csv",
    "reports/accuracy_report.md": "data/member2/accuracy_report.md",
    "reports/holdout_report.json": "data/member2/holdout_report.json",
}

ACTION_MEANING = {
    # pool-level (portfolio_decision_engine)
    "CONSIDER_PERMANENT_INCREASE": "Forecast shortage risk is above tolerance for more months than temporary access covers "
                                   "cheaply (or the software is Critical); consider buying more permanent licences.",
    "INVESTIGATE_TEMPORARY_ACCESS": "Risk is concentrated in a few months; temporary/short-term licences look cheaper "
                                    "than a full-year purchase. Get a vendor quote.",
    "INVESTIGATE_FORECAST_RISK": "Shortage probability is above tolerance even though the rounded licence requirement "
                                 "does not exceed current capacity; review the forecast before acting.",
    "CONSIDER_REDUCTION_AT_RENEWAL": "No forecast month exceeds the risk tolerance and usage history is low; a reduction "
                                     "could be negotiated at the next renewal (possible saving, needs approval).",
    "RETAIN_AND_MONITOR": "Demand is within tolerance; keep the current licence count and keep monitoring.",
    "RETAIN_AND_MONITOR_GLOBAL_DEMAND": "Pool forecast shows spare capacity, but software-wide history (denials, rising "
                                        "demand, high utilisation or Critical status) argues against reducing.",
    "RETAIN_AND_REVIEW_PARTIAL_FORECAST": "Some months have no usable forecast, so no permanent reduction is recommended "
                                          "until those months are reviewed.",
    "RETAIN_AND_REVIEW_NO_FORECAST": "No forecast exists for this pool; nothing is reduced on missing data.",
    # software-level (decision_engine)
    "CONSIDER_INCREASE": "Historical cost-risk simulation favours more licences than currently owned.",
    "INVESTIGATE_RISK": "The selected licence count still exceeds the shortage-risk tolerance; investigate before approval.",
    "INVESTIGATE_MISSING_DATA": "No demand records were available; no optimisation was attempted.",
}


def handoff_files(ml) -> dict:
    """{absolute source file: recommendation engine destination (relative)} for the active forecasting model."""
    if ml.model == "ensemble":
        rep = ml.ensemble_dir / "reports" / "ensemble"
        src = {ml.sim_dir / "pool_forecast_by_month.csv": "data/member2/pool_forecast_by_month.csv",
               ml.sim_dir / "recommendations.csv": "data/member2/member2_simulation_recommendations.csv",
               rep / "ensemble_report.md": "data/member2/accuracy_report.md",
               rep / "ml_report.json": "data/member2/holdout_report.json"}
    else:
        src = {ml.dir / k: v for k, v in HANDOFF.items()}
    return src


class RecommendationService:
    def __init__(self, engine_dir: Path, forecast_dir: Path | None = None, handoff: dict | None = None):
        self.dir = Path(engine_dir).resolve()
        self.forecast_dir = Path(forecast_dir).resolve() if forecast_dir else None
        self.handoff = handoff or ({self.forecast_dir / k: v for k, v in HANDOFF.items()} if self.forecast_dir else {})
        src = self.dir / "src"
        if not (src / "portfolio_decision_engine.py").exists():
            raise FileNotFoundError(f"recommendation engine not found at {self.dir} (expected src/portfolio_decision_engine.py)")
        if str(src) not in sys.path:
            sys.path.insert(0, str(src))
        import decision_engine            # noqa: E402
        import portfolio_decision_engine  # noqa: E402
        self.de, self.pde = decision_engine, portfolio_decision_engine

    # ------------------------------------------------------------------ paths
    @property
    def data_dir(self) -> Path:
        return self.dir / "data"

    @property
    def output_dir(self) -> Path:
        return self.dir / "output"

    @property
    def config_path(self) -> Path:
        return self.dir / "config.json"

    # ------------------------------------------------------------------ pipeline
    def sync_forecast_outputs(self) -> list[str]:
        """Copy the forecasting component's latest outputs into the recommendation engine's input folder (the documented handoff)."""
        if not self.handoff:
            raise ValueError("no handoff files configured")
        copied = []
        for src, dst_rel in self.handoff.items():
            dst = self.dir / dst_rel
            if not src.exists():
                raise FileNotFoundError(f"Forecast output missing: {src}. Run `python scripts/build_pipeline.py --simulate`.")
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            copied.append(dst_rel)
        return copied

    def run_all(self) -> dict:
        """Run both recommendation engine layers exactly as run_all.py does, writing to components/recommendation_engine/output/."""
        out1 = self.de.run_engine(self.data_dir, self.output_dir, self.config_path, None)
        out2 = self.pde.run(self.output_dir, self.dir)
        return {**{k: str(v) for k, v in out1.items()}, **{k: str(v) for k, v in out2.items()}}

    def evaluate_forecast(self, monthly: pd.DataFrame, licence_change: int = 0) -> pd.DataFrame:
        """
        Apply the recommendation engine's forecast-aware rules to an in-memory forecast table (e.g. a what-if result from
        the forecasting component's simulator). If the scenario changes the permanent licence count, the inventory copy
        given to the engine reflects that change, so the rules compare against the scenario's capacity.
        """
        need = set(self.pde.FORECAST_REQUIRED)
        missing = need - set(monthly.columns)
        if missing:
            raise ValueError(f"Forecast table missing columns: {sorted(missing)}")
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            monthly.to_csv(td / "forecast.csv", index=False)
            inv = pd.read_csv(self.data_dir / "licence_inventory.csv")
            if licence_change:
                sws = monthly["software_id"].astype(str).unique()
                m = inv["software_id"].astype(str).isin(sws)
                inv.loc[m, "usable_licenses"] = inv.loc[m, "usable_licenses"] + int(licence_change)
            inv.to_csv(td / "inventory.csv", index=False)
            recs, _, _ = self.pde.build_recommendations(td / "forecast.csv", td / "inventory.csv",
                                                        self.data_dir / "usage_metrics.csv", self.config_path,
                                                        self.data_dir / "assumptions.csv")
        return recs

    # ------------------------------------------------------------------ outputs
    def _csv(self, name: str) -> pd.DataFrame:
        p = self.output_dir / name
        if not p.exists():
            raise FileNotFoundError(f"Missing recommendation engine output {p}. Run `python scripts/build_pipeline.py`.")
        return pd.read_csv(p)

    def pool_recommendations(self) -> pd.DataFrame:
        return self._csv("portfolio_pool_recommendations.csv")

    def pool_summary(self) -> pd.DataFrame:
        return self._csv("portfolio_pool_summary.csv")

    def software_recommendations(self) -> pd.DataFrame:
        return self._csv("recommendations.csv")

    def run_summary(self) -> dict:
        p = self.output_dir / "run_summary.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}

    def integration_summary(self) -> dict:
        p = self.output_dir / "forecast_integration_summary.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}

    def inventory(self) -> pd.DataFrame:
        return pd.read_csv(self.data_dir / "licence_inventory.csv")

    def usage_metrics(self) -> pd.DataFrame:
        return pd.read_csv(self.data_dir / "usage_metrics.csv")

    def readme(self) -> str:
        p = self.dir / "README.md"
        return p.read_text(encoding="utf-8") if p.exists() else ""

    def handoff_in_sync(self) -> dict:
        """Whether the recommendation engine's copy of the forecasting component's forecast equals the forecasting component's latest output (byte-for-byte)."""
        if not self.handoff:
            return {"checked": False}
        res = {}
        for a, dst_rel in self.handoff.items():
            b = self.dir / dst_rel
            res[dst_rel] = a.exists() and b.exists() and a.read_bytes() == b.read_bytes()
        return {"checked": True, "files": res, "all_in_sync": all(res.values())}
