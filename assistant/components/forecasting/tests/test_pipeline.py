"""
Checks. Run `pytest -q` or `python tests/test_pipeline.py`.
Model and simulation checks need `python run_training.py` to have been run.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pandas as pd

from licence_ml import config as C
from licence_ml import data as D
from licence_ml.features import CAPACITY_NUMERIC, FeatureBuilder

_DF = None


def df():
    global _DF
    if _DF is None:
        _DF = D.load()
    return _DF


def trained():
    from licence_ml.train import Forecaster
    return Forecaster.load(C.ARTIFACTS) if (C.ARTIFACTS / "forecaster.pkl").exists() else None


def test_quality_checks_pass():
    assert D.quality_report(df())["passed"]


def test_split_by_portfolio_20_percent():
    tr, te = D.portfolio_split(df())
    assert not set(tr[C.GROUP]) & set(te[C.GROUP]) and not set(tr[C.PROJECT]) & set(te[C.PROJECT])
    assert abs(te[C.GROUP].nunique() / df()[C.GROUP].nunique() - C.TEST_SIZE) < 0.01


def test_folds_keep_pools_together():
    tr, _ = D.portfolio_split(df())
    f = D.group_folds(tr[C.GROUP])
    assert (pd.Series(f).groupby(tr[C.GROUP].to_numpy()).nunique() == 1).all()


def test_no_future_observation_is_a_feature():
    fb = FeatureBuilder("engineered").fit(df().head(20000))
    cols = set(fb.transform(df().head(50)).columns)
    banned = set(D.target_columns(df())) | set(C.NEVER_FEATURES)
    assert not cols & banned, cols & banned


def test_capacity_not_in_demand_model():
    fb = FeatureBuilder("engineered").fit(df().head(20000))
    assert not set(fb.columns) & set(CAPACITY_NUMERIC)


def test_features_ignore_this_rows_target():
    d = df().head(3000).copy()
    fb = FeatureBuilder("engineered").fit(df().head(20000))
    a = fb.transform(d)
    for c in D.target_columns(d):
        d[c] = 0
    pd.testing.assert_frame_equal(a, fb.transform(d))


def test_forecast_outputs_consistent():
    fc = trained()
    if fc is None:
        print("skip: train first"); return
    out = fc.predict(df().sample(3000, random_state=1))
    assert (out["peak_p10"] <= out["peak_expected"] + 1e-9).all() and (out["peak_expected"] <= out["peak_p90"] + 1e-9).all()
    assert out["shortage_probability"].between(0, 1).all() and (out["shortage_licences_expected"] >= 0).all()


def test_holdout_never_trained_on():
    fc = trained()
    if fc is None:
        return
    hold = set(pd.read_csv(C.REPORTS / "holdout_portfolios.csv")[C.GROUP])
    assert hold == set(D.portfolio_split(df())[1][C.GROUP])
    assert fc.meta["training_portfolios"] == df()[C.GROUP].nunique() - len(hold)


def test_simulation_rules():
    fc = trained()
    if fc is None:
        return
    from licence_ml.simulate import PoolSimulator, Scenario
    pf = sorted(df()[C.GROUP].unique())[0]
    sim = PoolSimulator(fc, df(), [pf], n_paths=500)
    sw = sim.rows["software_id"].value_counts().index[0]
    a = sim.simulate(pools=[(pf, sw)])["monthly"]["expected_shortage"].sum()
    assert a == sim.simulate(pools=[(pf, sw)])["monthly"]["expected_shortage"].sum()        # common random numbers
    more = sim.simulate(Scenario(licence_changes={sw: 3}), pools=[(pf, sw)])["monthly"]["expected_shortage"].sum()
    assert more <= a
    running = sim.rows.loc[~sim.rows["not_started"], C.PROJECT]
    if len(running):
        assert not sim.simulate(Scenario(delay_projects={running.iat[0]: 1}), pools=[(pf, sw)])["valid"]
    upcoming = sim.rows.loc[sim.rows["not_started"], C.PROJECT]
    if len(upcoming):
        r = sim.simulate(Scenario(cancel_projects=[upcoming.iat[0]]))
        assert r["valid"] and upcoming.iat[0] not in set(r["rows"][C.PROJECT])


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn(); print(f"PASS {name}")
            except AssertionError as e:
                fails += 1; print(f"FAIL {name} {e}")
    sys.exit(1 if fails else 0)
