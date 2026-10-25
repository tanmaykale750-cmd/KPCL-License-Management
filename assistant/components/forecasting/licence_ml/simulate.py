"""
Monte Carlo simulation of each licence pool (portfolio x software) on top of the trained model.

As of the planning date (assumptions.csv: as_of_date) every project of a pool contributes the
forecast rows made at its latest cut-off (plan-only rows for projects not started yet). Each
row is a forecast of the POOL peak in that project-month; rows falling in the same calendar
month are combined (median of their quantiles). The simulator then draws thousands of futures:

  peak path      two-piece normal from calibrated P10/P50/P90, whole licences, linked month to
                 month (AR(1)) and across software of the same pool, with correlations measured
                 from out-of-fold errors
  supply         licences owned (lookup) + what-if changes + temporary licences
  outputs        41 utilisation, 42 shortage probability, 43 expected shortage, licences needed
                 at the risk tolerance + safety buffer, idle licences and their monthly cost

What-ifs that change the plan (delay / cancel a project, change a team size) recompute the
pool's planned-load features and re-run the model, so the forecast itself responds.
Costs, renewal dates and decision thresholds all come from the dataset folder.
"""
from __future__ import annotations

import zlib
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from . import config as C
from . import data as D
from .train import Forecaster

Z90 = 1.2815515655446004


@dataclass
class Scenario:
    name: str = "Current plan"
    licence_changes: dict = field(default_factory=dict)   # software_id -> +/- licences (all pools in the run)
    temp_licences: dict = field(default_factory=dict)     # software_id -> max temporary licences per month
    delay_projects: dict = field(default_factory=dict)    # project_id -> months later (not started only)
    cancel_projects: list = field(default_factory=list)   # project_id (not started only)
    team_size: dict = field(default_factory=dict)         # project_id -> new team size

    def to_dict(self):
        return asdict(self)


def _normal(*key, n):
    return np.random.default_rng(zlib.crc32("|".join(map(str, key)).encode())).standard_normal(n)


def _overlap(starts: np.ndarray, a: pd.Timestamp) -> np.ndarray:
    """Share of the month window [a, a+1 month) covered by project-months starting at `starts`."""
    a = pd.Timestamp(a)
    b = a + pd.DateOffset(months=1)
    s = pd.DatetimeIndex(pd.to_datetime(starts))
    if len(s) == 0:
        return np.zeros(0)
    e = s + pd.DateOffset(months=1)
    s_ns, e_ns = s.to_numpy().astype("datetime64[ns]"), e.to_numpy().astype("datetime64[ns]")
    a_ns, b_ns = np.datetime64(a, "ns"), np.datetime64(b, "ns")
    ov = (np.minimum(e_ns, b_ns) - np.maximum(s_ns, a_ns)) / np.timedelta64(1, "D")
    return np.clip(ov, 0, None) / max((b - a).days, 1)


class PoolSimulator:
    def __init__(self, fc: Forecaster, df: pd.DataFrame, portfolios: list[str] | None = None,
                 planning_date=None, window_months: int = C.WINDOW_MONTHS, n_paths: int = C.N_PATHS):
        self.fc = fc
        self.A = D.assumptions()
        self.lk = D.lookup()
        self.inv = D.inventory()
        if portfolios:
            unknown = sorted(set(portfolios) - set(df[C.GROUP]))
            if unknown:
                raise ValueError(f"Portfolios not in the dataset: {unknown}")
            df = df[df[C.GROUP].isin(portfolios)]
        self.df = df
        self.portfolios = sorted(df[C.GROUP].unique())
        self.date = pd.Timestamp(planning_date) if planning_date is not None else self.A["as_of_date"]
        self.months = pd.period_range((self.date + pd.Timedelta(days=15)).to_period("M"), periods=window_months, freq="M")
        self.n = n_paths
        self.risk = self.A["shortage_risk_tolerance_pct"] / 100
        self.buffer = int(self.A["safety_buffer_licences"])
        rs = fc.meta.get("residual_structure", {})
        self.rho = float(rs.get("across_months", 0.5))
        self.cross = float(rs.get("cross_software", 0.3))
        self.projects = D.project_table(df)
        self.plan = D.plan_table(df)
        self.rows = self._rows_as_of()
        self._base = self._predict(self.rows)          # predictions for the current plan, reused by every scenario

    # ------------------------------------------------------------------ rows that apply on the planning date
    def _rows_as_of(self) -> pd.DataFrame:
        d = self.df[self.df["project_deadline_date"] > self.date]
        past = d[d["cutoff_date"] <= self.date]
        cur = past[past["cutoff_date"] == past.groupby([C.PROJECT, "software_id"])["cutoff_date"].transform("max")]
        started = pd.MultiIndex.from_frame(cur[[C.PROJECT, "software_id"]].drop_duplicates())
        key = pd.MultiIndex.from_frame(d[[C.PROJECT, "software_id"]])
        future = d[(d["months_elapsed_at_cutoff"] == 0) & ~key.isin(started)]
        rows = pd.concat([cur, future])
        rows = rows[rows["target_month_start"] + pd.DateOffset(months=1) > self.date].copy()
        rows["not_started"] = rows["project_start_date"] > self.date
        return rows.reset_index(drop=True)

    # ------------------------------------------------------------------ scenario edits
    def validate(self, sc: Scenario) -> list[str]:
        errs = []
        pt = self.projects.drop_duplicates(C.PROJECT).set_index(C.PROJECT)
        for pid in list(sc.delay_projects) + list(sc.cancel_projects) + list(sc.team_size):
            if pid not in pt.index:
                errs.append(f"{pid}: not in the selected portfolios.")
        for pid, k in sc.delay_projects.items():
            if pid in pt.index and pt.loc[pid, "start"] <= self.date:
                errs.append(f"{pid} started on {pt.loc[pid, 'start'].date()}; only projects not yet started can be delayed.")
            if int(k) < 0:
                errs.append(f"{pid}: delay must be >= 0 months.")
        for pid in sc.cancel_projects:
            if pid in pt.index and pt.loc[pid, "start"] <= self.date:
                errs.append(f"{pid} is already running; cancel only projects not yet started.")
        for pid, n in sc.team_size.items():
            if int(n) < 1:
                errs.append(f"{pid}: team size must be >= 1.")
        for sw, k in {**sc.licence_changes, **sc.temp_licences}.items():
            if sw not in self.lk.index:
                errs.append(f"{sw}: unknown software.")
        for sw, k in sc.licence_changes.items():
            if sw in self.lk.index and self.lk.loc[sw, "licences_owned"] + k < 0:
                errs.append(f"{sw}: cannot own fewer than 0 licences.")
        return errs

    def _predict(self, rows: pd.DataFrame) -> pd.DataFrame:
        rows = rows.assign(month=(rows["target_month_start"] + pd.Timedelta(days=15)).dt.to_period("M"))
        rows = rows[rows["month"].isin(self.months)]
        return rows.join(self.fc.predict(rows)) if len(rows) else rows

    def _apply(self, sc: Scenario, errs: list[str]) -> pd.DataFrame:
        """Rows of the pools touched by a plan change, edited and with the pool features recomputed."""
        changed = set(sc.delay_projects) | set(sc.cancel_projects) | set(sc.team_size)
        affected = set(self.projects.loc[self.projects[C.PROJECT].isin(changed), C.GROUP])
        rows = self.rows[self.rows[C.GROUP].isin(affected)].copy()
        plan = self.plan[self.plan[C.GROUP].isin(affected)].copy()
        proj = self.projects[self.projects[C.GROUP].isin(affected)].copy()
        old_plan = plan.copy()
        for pid, k in sc.delay_projects.items():
            m = plan[C.PROJECT] == pid
            plan.loc[m, "month_start"] = plan.loc[m, "month_start"] + pd.DateOffset(months=int(k))
            proj.loc[proj[C.PROJECT] == pid, "start"] += pd.DateOffset(months=int(k))
            proj.loc[proj[C.PROJECT] == pid, "end"] += pd.DateOffset(months=int(k))
            r = rows[C.PROJECT] == pid
            for c in ["target_month_start", "cutoff_date", "project_start_date", "project_deadline_date"]:
                rows.loc[r, c] = rows.loc[r, c] + pd.DateOffset(months=int(k))
            rows.loc[r, "target_calendar_month"] = rows.loc[r, "target_month_start"].dt.month
            rows.loc[r, "target_working_days"] = [int(np.busday_count(s.date(), (s + pd.DateOffset(months=1)).date()))
                                                  for s in rows.loc[r, "target_month_start"]]
        for pid in sc.cancel_projects:
            plan.loc[plan[C.PROJECT] == pid, "plan_load"] = 0.0
            rows = rows[rows[C.PROJECT] != pid]
        for pid, n in sc.team_size.items():
            ratio = n / proj.loc[proj[C.PROJECT] == pid, "team_size"].iat[0]
            plan.loc[plan[C.PROJECT] == pid, "plan_load"] *= ratio
            r = rows[C.PROJECT] == pid
            for c in ["plan_load_index_target", "plan_peak_load_target", "plan_load_last_observed_month"]:
                rows.loc[r, c] = rows.loc[r, c] * ratio
            rows.loc[r, "plan_expected_users_target"] = np.where(
                rows.loc[r, "plan_expected_users_target"] > 0,
                np.maximum(1, np.rint(rows.loc[r, "plan_expected_users_target"] * ratio)), 0)
            rows.loc[r, "team_size"] = n
        # recompute the pool's planned-load features for every affected row
        orig = self.rows.set_index(C.ROW_ID)
        for i in rows.index:
            r = rows.loc[i]
            sw, a_new = r["software_id"], r["target_month_start"]
            a_old = orig.loc[r[C.ROW_ID], "target_month_start"]
            same = (plan["software_id"] == sw) & (plan[C.GROUP] == r[C.GROUP])
            others = same & (plan[C.PROJECT] != r[C.PROJECT])
            if r[C.PROJECT] in changed:            # its own window may have moved: re-sum the others
                o_new = plan.loc[others, "plan_load"].to_numpy() * _overlap(plan.loc[others, "month_start"].to_numpy(), a_new)
                o_old = old_plan.loc[others, "plan_load"].to_numpy() * _overlap(old_plan.loc[others, "month_start"].to_numpy(), a_old)
                d_load = o_new.sum() - o_old.sum()
                d_active = 0
                for pid in plan.loc[others, C.PROJECT].unique():
                    mk = (plan.loc[others, C.PROJECT] == pid).to_numpy()
                    d_active += int(o_new[mk].sum() > 0.05) - int(o_old[mk].sum() > 0.05)
                own_delta = float(r["plan_load_index_target"] - orig.loc[r[C.ROW_ID], "plan_load_index_target"])
                rows.loc[i, "portfolio_other_planned_load_target"] = max(0.0, r["portfolio_other_planned_load_target"] + d_load)
                rows.loc[i, "portfolio_planned_load_target"] = max(0.0, r["portfolio_planned_load_target"] + d_load + own_delta)
                rows.loc[i, "portfolio_other_active_projects_target"] = max(0, r["portfolio_other_active_projects_target"] + d_active)
            else:
                d_load, d_active = 0.0, 0
                for pid in changed:
                    mp = same & (plan[C.PROJECT] == pid)
                    if not mp.any():
                        continue
                    new = (plan.loc[mp, "plan_load"].to_numpy() * _overlap(plan.loc[mp, "month_start"].to_numpy(), a_new)).sum()
                    old = (old_plan.loc[mp, "plan_load"].to_numpy() * _overlap(old_plan.loc[mp, "month_start"].to_numpy(), a_new)).sum()
                    d_load += new - old
                    d_active += int(new > 0.05) - int(old > 0.05)
                if d_load or d_active:
                    rows.loc[i, "portfolio_planned_load_target"] = max(0.0, r["portfolio_planned_load_target"] + d_load)
                    rows.loc[i, "portfolio_other_planned_load_target"] = max(0.0, r["portfolio_other_planned_load_target"] + d_load)
                    rows.loc[i, "portfolio_other_active_projects_target"] = max(0, r["portfolio_other_active_projects_target"] + d_active)
        return D.add_portfolio_counts(rows, proj)

    # ------------------------------------------------------------------ simulation
    def simulate(self, sc: Scenario | None = None, pools: list[tuple[str, str]] | None = None) -> dict:
        sc = sc or Scenario()
        errs = self.validate(sc)
        rows = self._base
        if not errs and (sc.delay_projects or sc.cancel_projects or sc.team_size):
            edited = self._predict(self._apply(sc, errs))
            touched = set(self.projects.loc[self.projects[C.PROJECT].isin(
                set(sc.delay_projects) | set(sc.cancel_projects) | set(sc.team_size)), C.GROUP])
            rows = pd.concat([rows[~rows[C.GROUP].isin(touched)], edited])
        if pools:
            keys = pd.MultiIndex.from_frame(rows[[C.GROUP, "software_id"]])
            rows = rows[keys.isin(pd.MultiIndex.from_tuples(pools))]
        rows = rows.reset_index(drop=True)
        agg = (rows.groupby([C.GROUP, "software_id", "month"])
                   .agg(p10=("peak_p10", "median"), p50=("peak_p50", "median"), p90=("peak_p90", "median"),
                        expected=("peak_expected", "median"), forecasts=(C.ROW_ID, "size"),
                        projects=(C.PROJECT, "nunique"))
                   .reset_index())
        t = (rows.sort_values("plan_load_index_target", ascending=False)
                 .drop_duplicates([C.GROUP, "software_id", "month", C.PROJECT]))
        t = t.assign(lbl=t[C.PROJECT] + " (" + t["plan_phase_in_target_month"] + ")")
        top = t.groupby([C.GROUP, "software_id", "month"])["lbl"].agg(lambda x: "; ".join(x.head(3)))
        agg["main_projects"] = [top.get((a, b, c), "") for a, b, c in zip(agg[C.GROUP], agg["software_id"], agg["month"])]

        out, paths = [], {}
        keys = list(pools) if pools else sorted(set(zip(agg[C.GROUP], agg["software_id"])))
        for pf, sw in keys:
            g = agg[(agg[C.GROUP] == pf) & (agg["software_id"] == sw)]
            g = g.set_index("month").reindex(self.months)   # months with no project forecast -> zero demand
            q = g[["p10", "p50", "p90"]].fillna(0.0).to_numpy()
            T = len(self.months)
            common = np.stack([_normal("pool", pf, m, n=self.n) for m in range(T)], 1)
            own = np.stack([_normal("pool-sw", pf, sw, m, n=self.n) for m in range(T)], 1)
            eps = np.sqrt(self.cross) * common + np.sqrt(1 - self.cross) * own
            z = np.empty_like(eps); z[:, 0] = eps[:, 0]
            for t in range(1, T):
                z[:, t] = self.rho * z[:, t - 1] + np.sqrt(1 - self.rho ** 2) * eps[:, t]
            lo, hi = (q[:, 1] - q[:, 0]) / Z90, (q[:, 2] - q[:, 1]) / Z90
            peak = np.clip(np.rint(q[None, :, 1] + np.where(z < 0, lo[None], hi[None]) * z), 0, None)
            owned = float(self.lk.loc[sw, "licences_owned"] + sc.licence_changes.get(sw, 0))
            cap = float(sc.temp_licences.get(sw, 0))
            gap = np.clip(peak - owned, 0, None)
            temp_used = np.minimum(gap, cap)
            short = gap - temp_used
            idle = np.clip(owned - peak, 0, None)
            price = self.lk.loc[sw]
            need = np.ceil(np.quantile(peak, 1 - self.risk, axis=0) - 1e-9) + self.buffer
            paths[(pf, sw)] = short
            for t, m in enumerate(self.months):
                out.append(dict(
                    portfolio_id=pf, software_id=sw, software=price["software_name"], month=str(m),
                    forecasts=int(g["forecasts"].fillna(0).iat[t]),
                    peak_expected=float(g["expected"].fillna(0).iat[t]), peak_p50=float(np.median(peak[:, t])),
                    peak_p90=float(np.quantile(peak[:, t], 0.9)), licences_owned=owned, temp_cap=cap,
                    utilisation_pct=float(100 * np.median(peak[:, t]) / max(owned, 1)),            # 41
                    shortage_probability=float(np.mean(short[:, t] > 0)),                          # 42
                    expected_shortage=float(short[:, t].mean()),                                    # 43
                    licences_needed=float(need[t]), gap_vs_owned=float(need[t] - owned - cap),
                    temp_used_expected=float(temp_used[:, t].mean()),
                    idle_licences_expected=float(idle[:, t].mean()),
                    idle_cost_inr=float(idle[:, t].mean() * price["monthly_cost_per_licence_inr"]),
                    main_projects=g["main_projects"].iat[t] if isinstance(g["main_projects"].iat[t], str) else ""))
        monthly = pd.DataFrame(out)
        if len(monthly):
            monthly["at_risk"] = monthly["shortage_probability"] > self.risk
        return dict(scenario=sc.to_dict(), valid=not errs, errors=errs, monthly=monthly, rows=rows, paths=paths)

    # ------------------------------------------------------------------ options and recommendations
    def _cost(self, sw, sc: Scenario, res, pf) -> tuple[float, float]:
        p = self.lk.loc[sw]
        m = res["monthly"]
        mm = m[(m[C.GROUP] == pf) & (m["software_id"] == sw)]
        buy = max(0, sc.licence_changes.get(sw, 0)) * p["annual_cost_per_licence_inr"]
        temp_months = int((mm["gap_vs_owned"] + mm["temp_cap"] > 0).sum()) if sc.temp_licences.get(sw) else 0
        temp = sc.temp_licences.get(sw, 0) * p["temporary_monthly_cost_per_licence_inr"] * temp_months
        residual = float(mm["expected_shortage"].sum() * p["temporary_monthly_cost_per_licence_inr"])
        return buy + temp, residual

    def options(self, pf: str, sw: str) -> pd.DataFrame:
        base = self.simulate(pools=[(pf, sw)])
        m = base["monthly"]
        risky = m[m["at_risk"]]
        opts = [Scenario("Keep current licences")]
        if len(risky):
            k = int(np.ceil(risky["gap_vs_owned"].max()))
            if k > 0:
                opts += [Scenario(f"Temporary licences: up to {k} in at-risk months", temp_licences={sw: k}),
                         Scenario(f"Buy {k} annual licence(s)", licence_changes={sw: k})]
            months = set(risky["month"])
            cand = base["rows"]
            cand = cand[(cand["software_id"] == sw) & cand["not_started"] & (cand["project_priority"] != "High")
                        & cand["month"].astype(str).isin(months)]
            for pid in cand[C.PROJECT].unique()[:5]:
                for d in (1, 2):
                    opts.append(Scenario(f"Delay {pid} by {d} month(s)", delay_projects={pid: d}))
        rows = []
        for sc in opts:
            res = self.simulate(sc, pools=[(pf, sw)])
            mm = res["monthly"]
            cost, residual = self._cost(sw, sc, res, pf)
            rows.append(dict(option=sc.name, valid=res["valid"], errors="; ".join(res["errors"]),
                             months_at_risk=int(mm["at_risk"].sum()), max_shortage_probability=float(mm["shortage_probability"].max()),
                             expected_shortage_licence_months=float(mm["expected_shortage"].sum()),
                             added_cost_inr=float(cost), residual_shortage_cost_inr=residual,
                             total_cost_inr=float(cost + residual), meets_risk=bool(res["valid"] and mm["at_risk"].sum() == 0),
                             scenario=sc.to_dict()))
        o = pd.DataFrame(rows)
        return o.sort_values(["valid", "meets_risk", "total_cost_inr", "months_at_risk"],
                             ascending=[False, False, True, True]).reset_index(drop=True)

    def recommendations(self) -> list[dict]:
        base = self.simulate()
        m = base["monthly"]
        recs = []
        bk = self.A["temporary_licence_monthly_multiplier"]
        for (pf, sw), g in m.groupby([C.GROUP, "software_id"]):
            p = self.lk.loc[sw]
            inv = self.inv.loc[sw]
            owned = g["licences_owned"].iat[0]
            peak_util = float(100 * g["peak_p90"].max() / max(owned, 1))
            rec = dict(portfolio_id=pf, software_id=sw, software=p["software_name"], licences_owned=owned,
                       peak_need=float(g["licences_needed"].max()), max_shortage_probability=float(g["shortage_probability"].max()),
                       months_at_risk=int(g["at_risk"].sum()), idle_cost_window_inr=float(g["idle_cost_inr"].sum()),
                       renewal_date=str(inv["renewal_date"].date()), status="PENDING_APPROVAL",
                       savings_label="Possible (synthetic prices, decision not approved)")
            if rec["months_at_risk"]:
                o = self.options(pf, sw)
                best = o.iloc[0]
                need_months = int((g["gap_vs_owned"] > 0).sum())
                rule = ("buy annual" if need_months >= p["breakeven_months_temp_vs_annual"] else "temporary licences")
                rec.update(action=best["option"], action_cost_inr=best["added_cost_inr"], meets_risk=bool(best["meets_risk"]),
                           why=(f"{rec['months_at_risk']} month(s) above the {self.risk:.0%} shortage tolerance "
                                f"({', '.join(g.loc[g['at_risk'], 'month'])}); need up to {rec['peak_need']:.0f} licences "
                                f"(P{100 - 100 * self.risk:.0f} + {self.buffer} buffer) vs {owned:.0f} owned. "
                                f"Gap lasts {need_months} month(s): dataset rule says {rule} "
                                f"(break-even {p['breakeven_months_temp_vs_annual']} months, temporary = {bk}x monthly). "
                                f"Main projects: {g.loc[g['at_risk'], 'main_projects'].iat[0]}."),
                           options=o.drop(columns="scenario").to_dict("records"))
            else:
                spare = int(max(0, owned - g["licences_needed"].max()))
                renew_soon = inv["renewal_date"] <= self.date + pd.DateOffset(months=12)
                low = peak_util < self.A["low_utilisation_peak_pct"]
                if spare > 0 and renew_soon:
                    act = (f"Candidate to reduce by {spare} licence(s) at the {inv['renewal_date'].date()} renewal "
                           f"(possible saving INR {spare * p['annual_cost_per_licence_inr']:,.0f}/year)"
                           + (" - peak use below the low-utilisation threshold" if low else ""))
                else:
                    act = "Keep current licences"
                rec.update(action=act, action_cost_inr=0.0, meets_risk=True,
                           why=f"No month above {self.risk:.0%} shortage risk; high-case peak uses {peak_util:.0f}% of owned.",
                           options=[])
            recs.append(rec)
        return recs
