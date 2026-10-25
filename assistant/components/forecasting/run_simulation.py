"""
Monte Carlo simulation of every licence pool with the trained model.

    python run_simulation.py                          # all portfolios, as of the dataset's as_of_date
    python run_simulation.py --portfolios PF001,PF007 # selected pools
    python run_simulation.py --date 2026-12-01 --paths 8000

Run `python run_training.py` first. Outputs: reports/simulation/.
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from licence_ml import config as C
from licence_ml import data as D
from licence_ml.evaluate import write_json
from licence_ml.simulate import PoolSimulator, Scenario
from licence_ml.train import Forecaster


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(C.DATA_FILE))
    ap.add_argument("--portfolios", default=None, help="comma-separated portfolio ids (default: all)")
    ap.add_argument("--date", default=None, help="planning date (default: as_of_date in assumptions.csv)")
    ap.add_argument("--paths", type=int, default=C.N_PATHS)
    a = ap.parse_args()
    out = C.REPORTS / "simulation"; out.mkdir(parents=True, exist_ok=True)

    fc = Forecaster.load(C.ARTIFACTS)
    df = D.load(a.data)
    pfs = [p.strip() for p in a.portfolios.split(",")] if a.portfolios else None
    sim = PoolSimulator(fc, df, pfs, a.date, n_paths=a.paths)
    print(f"Planning date {sim.date.date()}, window {sim.months[0]} to {sim.months[-1]}, {len(sim.portfolios)} pools, "
          f"{a.paths} paths; risk tolerance {sim.risk:.0%}, safety buffer {sim.buffer}, "
          f"correlation month-to-month {sim.rho:.2f}, across software {sim.cross:.2f}")

    base = sim.simulate()
    m = base["monthly"]
    m.round(3).to_csv(out / "pool_forecast_by_month.csv", index=False)
    recs = sim.recommendations()
    write_json(dict(planning_date=str(sim.date.date()), months=[str(x) for x in sim.months], recommendations=recs),
               out / "recommendations.json")
    rec_tab = pd.DataFrame([{k: v for k, v in r.items() if k != "options"} for r in recs])
    rec_tab.to_csv(out / "recommendations.csv", index=False)

    # company view: pools x software summary
    summary = (m.groupby("software").agg(pools=(C.GROUP, "nunique"), pool_months_at_risk=("at_risk", "sum"),
                                         expected_shortage_licence_months=("expected_shortage", "sum"),
                                         idle_cost_inr=("idle_cost_inr", "sum"),
                                         median_utilisation_pct=("utilisation_pct", "median")).reset_index())
    summary.round(2).to_csv(out / "software_summary.csv", index=False)

    # what-if examples on real projects of the riskiest pool
    worst = rec_tab.sort_values(["months_at_risk", "max_shortage_probability"]).iloc[-1]
    pf, sw = worst[C.GROUP], worst["software_id"]
    up = base["rows"][(base["rows"][C.GROUP] == pf) & base["rows"]["not_started"]]
    whatifs = [Scenario(f"+2 {sw} licences", licence_changes={sw: 2}),
               Scenario(f"Up to 2 temporary {sw} licences", temp_licences={sw: 2})]
    if len(up):
        pid = up.groupby(C.PROJECT)["plan_load_index_target"].sum().idxmax()
        team = int(up.loc[up[C.PROJECT] == pid, "team_size"].iat[0])
        whatifs += [Scenario(f"Delay {pid} by 2 months", delay_projects={pid: 2}),
                    Scenario(f"Cancel {pid}", cancel_projects=[pid]),
                    Scenario(f"{pid} team {team} -> {team + 4}", team_size={pid: team + 4})]
    running = base["rows"][(base["rows"][C.GROUP] == pf) & ~base["rows"]["not_started"]]
    if len(running):
        whatifs.append(Scenario(f"Delay {running[C.PROJECT].iat[0]} (already running: invalid)",
                                delay_projects={running[C.PROJECT].iat[0]: 1}))
    b = base["monthly"][(base["monthly"][C.GROUP] == pf) & (base["monthly"]["software_id"] == sw)]
    wi = []
    for sc in whatifs:
        r = sim.simulate(sc, pools=[(pf, sw)])
        mm = r["monthly"]
        wi.append(dict(pool=f"{pf}/{sw}", scenario=sc.name, valid=r["valid"], errors=r["errors"],
                       peak_p50_by_month=mm["peak_p50"].tolist(), months_at_risk=int(mm["at_risk"].sum()),
                       change_months_at_risk=int(mm["at_risk"].sum() - b["at_risk"].sum()),
                       expected_shortage_licence_months=float(mm["expected_shortage"].sum()),
                       change_expected_shortage=float(mm["expected_shortage"].sum() - b["expected_shortage"].sum())))
    write_json(dict(baseline_peak_p50_by_month=b["peak_p50"].tolist(), whatifs=wi), out / "whatif_examples.json")
    chart(m, sim, out)

    print("\nBy software (all pools):")
    print(summary.round(1).to_string(index=False))
    act = rec_tab["action"].map(lambda a: "Temporary licences" if a.startswith("Temporary") else
                                "Buy annual licences" if a.startswith("Buy") else
                                "Delay a not-started project" if a.startswith("Delay") else
                                "Reduce at next renewal (possible saving)" if a.startswith("Candidate") else
                                "Keep current licences").value_counts()
    print("\nRecommended actions (pending approval):")
    print(act.to_string())
    print(f"\nWhat-ifs for the riskiest pool {pf} / {sw} (baseline: {int(b['at_risk'].sum())} months at risk, "
          f"expected shortage {b['expected_shortage'].sum():.1f} licence-months):")
    for w in wi:
        print(f"  {w['scenario']:<44} valid={w['valid']!s:<5} months at risk {w['months_at_risk']} "
              f"({w['change_months_at_risk']:+d}), shortage {w['expected_shortage_licence_months']:.1f} "
              f"({w['change_expected_shortage']:+.1f}) {' '.join(w['errors'])}")


def chart(m: pd.DataFrame, sim: PoolSimulator, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    SURFACE, INK, INK2, GRID, BLUE, RED = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df", "#2a78d6", "#e34948"
    plt.rcParams.update({"figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "axes.edgecolor": GRID,
                         "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2, "text.color": INK,
                         "axes.grid": True, "grid.color": GRID, "axes.spines.top": False, "axes.spines.right": False,
                         "font.size": 8, "axes.titlesize": 9, "axes.titleweight": "bold", "legend.frameon": False})
    # riskiest pool per software
    pick = (m.groupby(["software_id", C.GROUP])["expected_shortage"].sum().reset_index()
              .sort_values("expected_shortage").groupby("software_id").tail(1))
    fig, axes = plt.subplots(2, 4, figsize=(13, 6), squeeze=False)
    for ax, (_, r) in zip(axes.ravel(), pick.sort_values("software_id").iterrows()):
        g = m[(m["software_id"] == r["software_id"]) & (m[C.GROUP] == r[C.GROUP])]
        x = np.arange(len(g))
        for xi, risk in zip(x, g["at_risk"]):
            if risk:
                ax.axvspan(xi - 0.5, xi + 0.5, color=RED, alpha=0.12, lw=0)
        ax.fill_between(x, g["peak_p50"], g["peak_p90"], color=BLUE, alpha=0.2, lw=0, label="peak P50-P90")
        ax.plot(x, g["peak_p90"], color=BLUE, lw=2, label="high case (P90)")
        ax.step(x, g["licences_owned"], where="mid", color=INK, lw=2, label="licences owned")
        ax.set_title(f"{g['software'].iat[0]} - {r[C.GROUP]}", loc="left")
        ax.set_xticks(x, [pd.Period(v).strftime("%b %y") for v in g["month"]], rotation=45)
        ax.set_ylim(bottom=0)
    axes[0, 0].legend(loc="upper left", fontsize=7)
    fig.suptitle(f"Riskiest licence pool per software: peak demand vs licences owned (red: shortage chance > "
                 f"{sim.risk:.0%}), planning date {sim.date.date()}", x=0.01, ha="left", fontsize=11, fontweight="bold")
    fig.tight_layout()
    fig.savefig(out / "riskiest_pools.png", dpi=140)
    plt.close(fig)


if __name__ == "__main__":
    main()
