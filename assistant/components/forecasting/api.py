"""
REST API for the dashboard and the AI assistant.

    uvicorn api:app --reload        # after `python run_training.py`

Read-only: forecasts and simulations only; nothing is written to licence servers or vendor accounts.
"""
from __future__ import annotations

import json
from functools import lru_cache

import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from licence_ml import config as C
from licence_ml import data as D
from licence_ml.evaluate import to_jsonable
from licence_ml.simulate import PoolSimulator, Scenario
from licence_ml.train import Forecaster

app = FastAPI(title="KPCL future peak licence demand", version="3.0")


@lru_cache
def forecaster() -> Forecaster:
    if not (C.ARTIFACTS / "forecaster.pkl").exists():
        raise HTTPException(503, "No trained model. Run `python run_training.py` first.")
    return Forecaster.load(C.ARTIFACTS)


@lru_cache
def dataset() -> pd.DataFrame:
    return D.load()


@lru_cache
def simulator(portfolios: tuple[str, ...] | None, date: str | None) -> PoolSimulator:
    try:
        return PoolSimulator(forecaster(), dataset(), list(portfolios) if portfolios else None, date)
    except ValueError as e:
        raise HTTPException(400, str(e))


def _pf(q):
    return tuple(sorted(p.strip() for p in q.split(",") if p.strip())) if q else None


class Rows(BaseModel):
    rows: list[dict] = Field(..., description="Rows with the dataset columns (see dataset/.../data_dictionary.csv)")
    explain: bool = True


class ScenarioIn(BaseModel):
    portfolios: list[str] | None = None
    planning_date: str | None = None
    name: str = "What-if"
    licence_changes: dict[str, int] = {}
    temp_licences: dict[str, int] = {}
    delay_projects: dict[str, int] = {}
    cancel_projects: list[str] = []
    team_size: dict[str, int] = {}


@app.get("/health")
def health():
    m = forecaster().meta
    return dict(status="ok", target=C.TARGET, backend=m["backend"], objective=m["objective"],
                feature_set=m["feature_set"], cv_mae=m["cv_mae"], training_portfolios=m["training_portfolios"])


@app.get("/accuracy")
def accuracy():
    p = C.REPORTS / "holdout_report.json"
    if not p.exists():
        raise HTTPException(404, "Run run_training.py first.")
    return json.loads(p.read_text())


@app.get("/features")
def features():
    p = C.REPORTS / "feature_map.csv"
    return to_jsonable(pd.read_csv(p)) if p.exists() else []


@app.post("/predict")
def predict(body: Rows):
    """Pool peak demand (39) with P10/P50/P90, utilisation (41), shortage probability (42) and quantity (43)."""
    df = pd.DataFrame(body.rows)
    for c in C.DATES:
        if c in df:
            df[c] = pd.to_datetime(df[c])
    try:
        df = D.add_portfolio_counts(df) if C.GROUP in df else df
        out = forecaster().predict(df)
    except KeyError as e:
        raise HTTPException(400, f"Missing column: {e}")
    if body.explain and "target_month_start" in df:
        df["software_name"] = df["software_id"].map(D.lookup()["software_name"])
        out["explanation"] = forecaster().explain(df)["text"]
    return to_jsonable(df.join(out).to_dict("records"))


@app.get("/pools")
def pools(portfolios: str | None = None, planning_date: str | None = None):
    r = simulator(_pf(portfolios), planning_date).simulate()
    return to_jsonable(r["monthly"])


@app.post("/simulate")
def simulate(body: ScenarioIn):
    d = body.model_dump()
    sim = simulator(tuple(sorted(d.pop("portfolios"))) if d.get("portfolios") else None, d.pop("planning_date"))
    d.pop("portfolios", None)
    r = sim.simulate(Scenario(**d))
    return to_jsonable(dict(valid=r["valid"], errors=r["errors"], monthly=r["monthly"]))


@app.get("/recommendations")
def recommendations(portfolios: str | None = None, planning_date: str | None = None):
    return to_jsonable(simulator(_pf(portfolios), planning_date).recommendations())
