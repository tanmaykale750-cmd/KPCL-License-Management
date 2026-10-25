"""
Run the Monte Carlo simulation (licence_ml.simulate.PoolSimulator) for every pool with the ACTIVE forecasting
model and write the same output files the forecasting component's run_simulation.py writes, into the active model's reports folder:

    pool_forecast_by_month.csv, recommendations.json/.csv, software_summary.csv, whatif_examples.json, riskiest_pools.png

This mirrors run_simulation.main() (which is hard-wired to the forecasting component's own model and folders).
"""
from __future__ import annotations

import importlib.util
import json
import time

import numpy as np
import pandas as pd


def _write_json(obj, path):
    from licence_ml.evaluate import write_json
    write_json(obj, path)


def run(ml, n_paths: int | None = None, log=print) -> dict:
    from licence_ml import config as C
    from licence_ml.simulate import PoolSimulator, Scenario
    t0 = time.time()
    out = ml.sim_dir
    out.mkdir(parents=True, exist_ok=True)
    fc = ml.forecaster()
    df = ml.dataset()
    sim = PoolSimulator(fc, df, None, None, n_paths=n_paths or C.N_PATHS)
    log(f"   model: {ml.model_label}")
    log(f"   planning date {sim.date.date()}, window {sim.months[0]} to {sim.months[-1]}, {len(sim.portfolios)} portfolios, "
        f"{sim.n} paths, correlation month-to-month {sim.rho:.2f}, across software {sim.cross:.2f}")
    base = sim.simulate()
    m = base["monthly"]
    m.round(3).to_csv(out / "pool_forecast_by_month.csv", index=False)
    log(f"   pool forecasts written ({len(m)} pool-months, {time.time() - t0:.0f}s); costing options for at-risk pools ...")
    recs = sim.recommendations()
    _write_json(dict(planning_date=str(sim.date.date()), months=[str(x) for x in sim.months], model=ml.model_label,
                     recommendations=recs), out / "recommendations.json")
    rec_tab = pd.DataFrame([{k: v for k, v in r.items() if k != "options"} for r in recs])
    rec_tab.to_csv(out / "recommendations.csv", index=False)
    summary = (m.groupby("software").agg(pools=(C.GROUP, "nunique"), pool_months_at_risk=("at_risk", "sum"),
                                         expected_shortage_licence_months=("expected_shortage", "sum"),
                                         idle_cost_inr=("idle_cost_inr", "sum"),
                                         median_utilisation_pct=("utilisation_pct", "median")).reset_index())
    summary.round(2).to_csv(out / "software_summary.csv", index=False)

    # what-if examples on the riskiest pool (same scenarios as run_simulation.py)
    worst = rec_tab.sort_values(["months_at_risk", "max_shortage_probability"]).iloc[-1]
    pf, sw = worst[C.GROUP], worst["software_id"]
    up = base["rows"][(base["rows"][C.GROUP] == pf) & base["rows"]["not_started"]]
    whatifs = [Scenario(f"+2 {sw} licences", licence_changes={sw: 2}),
               Scenario(f"Up to 2 temporary {sw} licences", temp_licences={sw: 2})]
    if len(up):
        pid = up.groupby(C.PROJECT)["plan_load_index_target"].sum().idxmax()
        team = int(up.loc[up[C.PROJECT] == pid, "team_size"].iat[0])
        whatifs += [Scenario(f"Delay {pid} by 2 months", delay_projects={pid: 2}), Scenario(f"Cancel {pid}", cancel_projects=[pid]),
                    Scenario(f"{pid} team {team} -> {team + 4}", team_size={pid: team + 4})]
    b = m[(m[C.GROUP] == pf) & (m["software_id"] == sw)]
    wi = []
    for sc in whatifs:
        r = sim.simulate(sc, pools=[(pf, sw)])
        mm = r["monthly"]
        wi.append(dict(pool=f"{pf}/{sw}", scenario=sc.name, valid=r["valid"], errors=r["errors"],
                       peak_p50_by_month=mm["peak_p50"].tolist(), months_at_risk=int(mm["at_risk"].sum()),
                       change_months_at_risk=int(mm["at_risk"].sum() - b["at_risk"].sum()),
                       expected_shortage_licence_months=float(mm["expected_shortage"].sum()),
                       change_expected_shortage=float(mm["expected_shortage"].sum() - b["expected_shortage"].sum())))
    _write_json(dict(baseline_peak_p50_by_month=b["peak_p50"].tolist(), whatifs=wi), out / "whatif_examples.json")
    try:   # reuse the forecasting component's chart function
        spec = importlib.util.spec_from_file_location("_m2_run_simulation", ml.dir / "run_simulation.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.chart(m, sim, out)
    except Exception as e:  # chart is cosmetic
        log(f"   chart skipped: {e}")
    secs = time.time() - t0
    log(f"   simulation finished in {secs:.0f}s -> {out}")
    return dict(pool_months=int(len(m)), pools=int(m.groupby([C.GROUP, "software_id"]).ngroups),
                pool_months_at_risk=int(m["at_risk"].sum()), seconds=round(secs, 1))
