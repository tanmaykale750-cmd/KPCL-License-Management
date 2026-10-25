"""
generate_licence_forecast_dataset.py
Builds a project-level dataset for predicting FUTURE licence requirements (SYNTHETIC).

One row = (project, software, prediction cut-off month c, forecast horizon h)
  * Features: only information available at the cut-off (project plan + usage observed in months 1..c)
  * Target  : peak concurrent licences the project needs for that software in project-month c+h

Demand mechanics are calibrated on member1_data_package (phase intensity x affinity x need weight x team size,
per-software scale fitted from daily_demand.csv), then varied across many synthetic projects:
different start dates, deadlines (2-12 months), team sizes, priorities, phase mixes, schedule slippage
and team usage-intensity.  Fixed seed -> reproducible.
"""
import sys, json
import numpy as np, pandas as pd
from pathlib import Path

PKG = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("member1_data_package/data")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(".")
N_PROJECTS = int(sys.argv[3]) if len(sys.argv) > 3 else 1500
PORT_SIZE = int(sys.argv[4]) if len(sys.argv) > 4 else 20      # projects sharing one licence pool ("portfolio")
rng = np.random.default_rng(2026)

PHASES = ["Requirements & Planning", "Design", "Design Review Sprint", "Analysis & Simulation",
          "Testing & Validation", "Release & Documentation"]
INTENS = dict(zip(PHASES, [0.10, 0.55, 0.95, 0.75, 0.50, 0.30]))
GROUP_AFF = {"CAD":[.25,1,.9,.45,.35,.6], "DRAFT":[.25,.8,.7,.2,.3,1], "CAE":[.1,.35,.5,1,.8,.2],
             "EDA":[.2,1,1.4,.5,.7,.3], "COMP":[.3,.45,.6,.9,1,.4]}
SWG = {"SW001":"CAD","SW002":"CAD","SW003":"CAE","SW004":"CAE","SW005":"DRAFT","SW006":"EDA","SW007":"COMP","SW008":"CAD"}
# base phase shares (fraction of project duration) taken from the 11 real projects' weeks
BASE_SHARE = {"Requirements & Planning":.11,"Design":.28,"Design Review Sprint":.08,
              "Analysis & Simulation":.25,"Testing & Validation":.20,"Release & Documentation":.10}
DEPTS = {  # department -> (team size range, candidate software)
    "Mechanical Design":        ((5,10), ["SW001","SW002","SW003","SW005","SW008"]),
    "CAE & Simulation":         ((6,12), ["SW003","SW004","SW007"]),
    "Electrical Design":        ((6,14), ["SW006","SW007","SW005"]),
    "Product Engineering":      ((5,10), ["SW001","SW002","SW005","SW008"]),
    "R&D":                      ((6,12), ["SW003","SW004","SW007","SW006"]),
    "Manufacturing Engineering":((6,12), ["SW001","SW005","SW008"]),
}
FIXED_HOL = {(1,1),(1,26),(8,15),(10,2),(12,25),(5,1)}

inv = pd.read_csv(PKG/"licence_inventory.csv").set_index("software_id")
SWNAME = inv.software_name.to_dict(); CAP = inv.usable_licenses.to_dict(); ANNUAL = inv.annual_cost_per_license_inr.to_dict(); CAT = inv.category.to_dict()

# ---------- 1. calibrate per-software demand scale from the real package ----------
ps = pd.read_csv(PKG/"project_schedule.csv", parse_dates=["phase_start_date","phase_end_date"])
dd = pd.read_csv(PKG/"daily_demand.csv", parse_dates=["date"])
dd = dd[(dd.is_working_day==1)]
rows=[]
for r in ps.itertuples():
    aff = GROUP_AFF[SWG[r.software_id]][PHASES.index(r.phase_name)]
    load = r.planned_team_size*r.phase_intensity_factor*aff*r.software_need_weight
    for d in pd.date_range(r.phase_start_date, r.phase_end_date):
        rows.append((d, r.software_id, load))
L = pd.DataFrame(rows, columns=["date","software_id","load"]).groupby(["date","software_id"]).load.sum().reset_index()
m = dd.merge(L, on=["date","software_id"])
m = m[m.load>0]
# through-origin least squares on peak demand incl. denials
CAL = {s: float((g.load*g.peak_demand_incl_denials).sum()/(g.load**2).sum()) for s,g in m.groupby("software_id")}
print("calibrated demand scale per software:", {k: round(v,2) for k,v in CAL.items()})

# ---------- 2. synthetic projects ----------
def month_edges(start, D, stretch=1.0):
    return [start + pd.DateOffset(months=i) for i in range(D+2)]

projects, pairs = [], []
for i in range(1, N_PROJECTS+1):
    dept = rng.choice(list(DEPTS), p=[.25,.2,.15,.15,.15,.10])
    (lo,hi), cands = DEPTS[dept]
    team = int(rng.integers(lo, hi+1))
    prio = rng.choice(["Low","Medium","High"], p=[.2,.5,.3])
    D = int(np.clip(np.round(rng.gamma(5.5, 1.2)), 2, 12))             # planned deadline, months
    start = pd.Timestamp("2025-01-01") + pd.Timedelta(days=int(rng.integers(0, 820)))
    start = start - pd.Timedelta(days=start.weekday())                   # start on a Monday
    n_sw = int(rng.choice([2,3,4], p=[.35,.45,.2])); n_sw = min(n_sw, len(cands))
    sws = list(rng.choice(cands, n_sw, replace=False))
    weights = {s: (1.0 if k==0 else float(np.round(rng.uniform(.4,.9),1))) for k,s in enumerate(sws)}
    has_sprint = (("SW006" in sws) and rng.random()<.7) or rng.random()<.12
    shares = {p: BASE_SHARE[p]*rng.uniform(.75,1.3) for p in PHASES if has_sprint or p!="Design Review Sprint"}
    tot = sum(shares.values()); shares = {p: v/tot for p,v in shares.items()}
    slip = float(max(0.0, rng.normal(0.06, 0.14))) if rng.random()<.6 else 0.0   # schedule overrun (actual vs plan)
    team_mult = float(rng.lognormal(0,0.2))                              # how heavily this team really uses tools
    end_plan = start + pd.DateOffset(months=D)
    projects.append(dict(project_id=f"P{i:04d}", dept=dept, team=team, prio=prio, D=D, start=start, end_plan=end_plan,
                         sws=sws, w=weights, shares=shares, slip=slip, mult=team_mult))

def phase_of(p, day, actual):
    """phase name active on a day (plan if actual=False, slipped timeline if actual=True)"""
    span = (p["end_plan"]-p["start"]).days * ((1+p["slip"]) if actual else 1.0)
    f = (day - p["start"]).days / span
    if f < 0 or f >= 1: return None
    acc = 0
    for ph, sh in p["shares"].items():
        acc += sh
        if f < acc: return ph
    return list(p["shares"])[-1]

def workday(d): return d.weekday()<5 and (d.month,d.day) not in FIXED_HOL

# ---------- 3. simulate daily demand -> project-month peaks ----------
out = []
DAY = {}      # (project, software) -> list of (working days, planned load per day, actual peak per day)
MON = {}
for p in projects:
    D = p["D"]; edges = month_edges(p["start"], D)
    # "actual" run can last longer than D months: simulate through D+ (slip) months, only predict months 1..D
    for sw in p["sws"]:
        g = SWG[sw]; w = p["w"][sw]
        mon = []   # per project-month: dict(plan_load_mean, plan_users_max, actual_peak, actual_avg, workdays, phase_mode_plan, phase_mode_act)
        for k in range(D):
            days = pd.date_range(edges[k], edges[k+1]-pd.Timedelta(days=1))
            wd = [d for d in days if workday(d)]
            plan_load, act_peak, plan_ph, act_ph, plan_users = [],[],[],[],[]
            for d in wd:
                pp = phase_of(p,d,False); pa = phase_of(p,d,True)
                lp = p["team"]*INTENS[pp]*GROUP_AFF[g][PHASES.index(pp)]*w if pp else 0.0
                la = p["team"]*INTENS[pa]*GROUP_AFF[g][PHASES.index(pa)]*w if pa else 0.0
                plan_load.append(lp); plan_ph.append(pp); act_ph.append(pa)
                plan_users.append(max(1, int(round(lp*0.55))) if pp else 0)   # same rule as project_schedule.expected_concurrent_users
                mu = CAL[sw]*la*p["mult"]
                act_peak.append(0 if la==0 else max(0, int(round(mu*rng.lognormal(0,0.25) + rng.normal(0,0.4)))))
            mode = lambda L: (pd.Series([x for x in L if x]).mode().iloc[0] if any(L) else "None")
            mon.append(dict(plan_load=float(np.mean(plan_load)) if plan_load else 0.0,
                            plan_users=int(max(plan_users)) if plan_users else 0,
                            peak=int(max(act_peak)) if act_peak else 0,
                            avgpeak=float(np.mean(act_peak)) if act_peak else 0.0,
                            wd=len(wd), pph=mode(plan_ph), aph=mode(act_ph), s=edges[k], e=edges[k+1],
                            plan_peak_load=float(max(plan_load)) if plan_load else 0.0,
                            plan_max_int=max([INTENS[x] for x in plan_ph if x], default=0.0),
                            plan_nph=len(set(x for x in plan_ph if x))))
            DAY.setdefault((p["project_id"],sw),[]).append((wd, plan_load, act_peak))
        MON[(p["project_id"],sw)] = mon
        # ---------- 4. snapshot rows ----------
        for c in range(0, D):                       # cut-off: months 1..c already observed
            hist = [mon[j]["peak"] for j in range(c)]
            hist_plan = [mon[j]["plan_load"] for j in range(c)]
            cutoff_date = edges[c]
            for h in range(1, min(6, D-c)+1):       # forecast horizon (months ahead of the cut-off)
                t = c+h-1; mt = mon[t]
                row = dict(
                    project_id=p["project_id"], software_id=sw, software_name=SWNAME[sw], software_category=CAT[sw],
                    department=p["dept"], project_priority=p["prio"], team_size=p["team"],
                    n_software_in_project=len(p["sws"]), software_need_weight=w, has_design_review_sprint=int("Design Review Sprint" in p["shares"]),
                    project_start_date=p["start"].date(), project_deadline_date=p["end_plan"].date(), deadline_months=D,
                    cutoff_date=cutoff_date.date(), months_elapsed_at_cutoff=c, months_remaining_to_deadline=D-c,
                    forecast_after_months=h, target_month_index=c+h, target_month_start=mt["s"].date(),
                    target_calendar_month=mt["s"].month, target_working_days=mt["wd"],
                    target_pct_of_project_elapsed=round((c+h-0.5)/D,3), is_final_planned_month=int(c+h==D),
                    plan_phase_at_cutoff=(mon[c-1]["pph"] if c>0 else "Not started"),
                    plan_phase_in_target_month=mt["pph"],
                    plan_phase_intensity_target=INTENS.get(mt["pph"],0.0),
                    plan_load_index_target=round(mt["plan_load"],3),
                    plan_expected_users_target=mt["plan_users"],
                    licences_owned_for_software=CAP[sw],
                    obs_months_observed=c,
                    obs_peak_last_month=(hist[-1] if c>0 else np.nan),
                    obs_peak_max_so_far=(max(hist) if c>0 else np.nan),
                    obs_peak_mean_so_far=(round(float(np.mean(hist)),2) if c>0 else np.nan),
                    obs_peak_trend=((hist[-1]-hist[-2]) if c>1 else (np.nan if c==0 else 0)),
                    obs_actual_vs_plan_ratio=(round(float(np.sum(hist)/max(np.sum(hist_plan),1e-6)),3) if c>0 else np.nan),
                    target_licences_required=mt["peak"],
                    target_avg_daily_peak=round(mt["avgpeak"],2),
                    plan_peak_load_target=round(mt["plan_peak_load"],3),
                    plan_max_phase_intensity_target=mt["plan_max_int"],
                    plan_n_phases_target=mt["plan_nph"],
                    plan_load_last_observed_month=(round(mon[c-1]["plan_load"],3) if c>0 else np.nan),
                    obs_peak_per_plan_load_last=(round(hist[-1]/mon[c-1]["plan_load"],3) if c>0 and mon[c-1]["plan_load"]>0 else np.nan),
                    plan_load_change_vs_last_month=(round(mt["plan_load"]-mon[c-1]["plan_load"],3) if c>0 else np.nan),
                    est_target_peak_from_last_ratio=(round(hist[-1]/mon[c-1]["plan_load"]*mt["plan_load"],2) if c>0 and mon[c-1]["plan_load"]>0 else np.nan),
                )
                out.append(row)

df = pd.DataFrame(out)

# ---------- 4b. CONTEXT features: portfolio (shared licence pool), renewal timing ----------
# Licences are a shared pool: demand on a software is the sum over concurrent projects, not one project alone.
# Projects are randomly grouped into portfolios (business units). Separate RNG -> earlier columns are unchanged.
rng2 = np.random.default_rng(777)
order = rng2.permutation(len(projects))
PORT = {projects[i]["project_id"]: f"PF{k//PORT_SIZE+1:03d}" for k,i in enumerate(order)}
BASE = pd.Timestamp("2024-09-01"); G = (pd.Timestamp("2028-07-01")-BASE).days
dn = lambda t: (pd.Timestamp(t)-BASE).days
COIN = 0.85    # coincidence factor: peaks of different teams do not all hit in the same minute (assumption)
PS, PC, PPL, PPC, OWNPL = {}, {}, {}, {}, {}
for (pid, sw), months in DAY.items():
    a = np.zeros(G); pl = np.zeros(G)
    for wd, plan_l, act_p in months:
        ix = np.array([dn(d) for d in wd], dtype=int)
        if len(ix): a[ix] = act_p; pl[ix] = plan_l
    k = (PORT[pid], sw)
    for D_, arr in ((PS,a),(PPL,pl)): D_[k] = D_.get(k, 0)+arr
    PC[k] = PC.get(k, 0)+(a>0); PPC[k] = PPC.get(k, 0)+(pl>0); OWNPL[(pid,sw)] = pl
PDEM = {k: np.where(PC[k]>1, np.rint(COIN*PS[k]), PS[k]) for k in PS}      # portfolio demand per day (licences)
EDGE = {p["project_id"]: [dn(p["start"]+pd.DateOffset(months=i)) for i in range(p["D"]+2)] for p in projects}
ren = pd.to_datetime(inv.renewal_date)
def months_to_renewal(sw, day):
    r = ren[sw]; r = r.replace(year=day.year)
    if r <= day: r = r.replace(year=day.year+1)
    return (r-day).days/30.44
pf = {c: [] for c in ["portfolio_id","portfolio_other_active_projects_target","portfolio_planned_load_target","portfolio_other_planned_load_target",
                      "portfolio_peak_last_30d","portfolio_peak_last_90d","target_portfolio_peak_demand","months_to_next_renewal","target_month_after_next_renewal"]}
PLAN_MEAN = {}
for r in df[["project_id","software_id","target_month_index","months_elapsed_at_cutoff","target_working_days","plan_load_index_target","cutoff_date","target_month_start"]].itertuples(index=False):
    pid, sw, ti, c, wdn, own_plan, cd, ts = r
    k = (PORT[pid], sw); e = EDGE[pid]; ws, we, cut = e[ti-1], e[ti], e[c]
    tot_plan = PPL[k][ws:we].sum()/max(wdn,1)
    own_act = (OWNPL[(pid,sw)][ws:we] > 0)
    others = (PPC[k][ws:we]-own_act).max() if we>ws else 0
    pf["portfolio_id"].append(PORT[pid]); pf["portfolio_other_active_projects_target"].append(int(others))
    pf["portfolio_planned_load_target"].append(round(tot_plan,3)); pf["portfolio_other_planned_load_target"].append(round(tot_plan-own_plan,3))
    pf["portfolio_peak_last_30d"].append(int(PDEM[k][cut-30:cut].max())); pf["portfolio_peak_last_90d"].append(int(PDEM[k][cut-90:cut].max()))
    pf["target_portfolio_peak_demand"].append(int(PDEM[k][ws:we].max()))
    cdt = pd.Timestamp(cd); pf["months_to_next_renewal"].append(round(months_to_renewal(sw, cdt),1))
    nxt = cdt + pd.Timedelta(days=int(round(months_to_renewal(sw, cdt)*30.44)))
    pf["target_month_after_next_renewal"].append(int(pd.Timestamp(ts) >= nxt))
for c_, v in pf.items(): df[c_] = v
owned = df.software_id.map(CAP)
df["portfolio_headroom_last_30d"] = owned-df.portfolio_peak_last_30d
df["portfolio_planned_load_to_owned_ratio"] = (df.portfolio_planned_load_target/owned).round(3)
df["target_portfolio_shortfall_licences"] = (df.target_portfolio_peak_demand-owned).clip(lower=0)
df["target_portfolio_shortfall_flag"] = (df.target_portfolio_shortfall_licences>0).astype(int)

# ---------- 5. COST columns (INR) - inputs come from licence_inventory.csv + assumptions.csv ----------
asm = pd.read_csv(PKG/"assumptions.csv").set_index("assumption_key").value
TEMP_MULT = float(asm["temporary_licence_monthly_multiplier"])           # 1.6 x monthly equivalent (illustrative, not a vendor quote)
annual = inv.annual_cost_per_license_inr
df["annual_cost_per_licence_inr"]        = df.software_id.map(annual).astype(int)
df["monthly_cost_per_licence_inr"]       = (df.annual_cost_per_licence_inr/12).round(2)
df["temporary_monthly_cost_per_licence_inr"] = (df.monthly_cost_per_licence_inr*TEMP_MULT).round(2)
df["breakeven_months_temp_vs_annual"]    = round(12/TEMP_MULT, 2)         # temporary is cheaper only if the need lasts fewer months than this
# cost of the predicted requirement
df["target_cost_temporary_month_inr"]    = df.target_licences_required*df.temporary_monthly_cost_per_licence_inr
# buy-vs-temporary decision for the licences needed from the target month to the deadline
months_need = (df.deadline_months - (df.target_month_index-1)).clip(lower=1)    # months from target month to deadline
df["months_need_from_target_to_deadline"] = months_need
df["cost_buy_annual_inr"]                = df.target_licences_required*df.annual_cost_per_licence_inr
df["cost_temporary_until_deadline_inr"]  = df.target_licences_required*df.temporary_monthly_cost_per_licence_inr*months_need
df["cost_optimal_option"]                = np.where(df.target_licences_required==0,"NoLicenceNeeded",
                                           np.where(df.cost_temporary_until_deadline_inr<df.cost_buy_annual_inr,"Temporary","BuyAnnual"))
df["target_cost_optimal_inr"]            = np.minimum(df.cost_buy_annual_inr, df.cost_temporary_until_deadline_inr)
df["saving_vs_other_option_inr"]         = (df.cost_buy_annual_inr-df.cost_temporary_until_deadline_inr).abs()
df["cost_data_status"]                   = "Synthetic planning assumption (savings = Possible, not Confirmed)"
sf = df.target_portfolio_shortfall_licences
df["target_shortfall_cost_optimal_inr"]  = np.minimum(sf*df.annual_cost_per_licence_inr, sf*df.temporary_monthly_cost_per_licence_inr*months_need).round(0)   # cheapest way to cover the shortage
df["target_idle_licence_cost_month_inr"] = ((owned-df.target_portfolio_peak_demand).clip(lower=0)*df.monthly_cost_per_licence_inr).round(0)   # waste: owned but never needed

# requirement class (for classification experiments)
df["target_requirement_class"] = pd.cut(df.target_licences_required, [-1,0,2,5,100], labels=["Zero","Low(1-2)","Medium(3-5)","High(6+)"]).astype(str)
df["target_exceeds_owned_licences"] = (df.target_licences_required > df.licences_owned_for_software).astype(int)
# split BY PROJECT (never leak a project across train/test)
ids = np.array(sorted(df.portfolio_id.unique())); np.random.default_rng(99).shuffle(ids)
n=len(ids); split = {pid:("train" if k<.70*n else "validation" if k<.85*n else "test") for k,pid in enumerate(ids)}
df["split"] = df.portfolio_id.map(split)

# ---------- costing columns (prices from licence_inventory.csv - SYNTHETIC planning assumptions) ----------
df["owned_licences_monthly_cost_inr"] = (df.licences_owned_for_software*df.monthly_cost_per_licence_inr).round(2)
df["target_monthly_licence_cost_inr"] = (df.target_licences_required*df.monthly_cost_per_licence_inr).round(2)   # COST TARGET
df["target_avg_monthly_licence_cost_inr"] = (df.target_avg_daily_peak*df.monthly_cost_per_licence_inr).round(2)
cols = list(df.columns)
for c in ["annual_cost_per_licence_inr","monthly_cost_per_licence_inr","owned_licences_monthly_cost_inr"]:
    cols.remove(c); cols.insert(cols.index("licences_owned_for_software")+1, c)
for c in ["target_monthly_licence_cost_inr","target_avg_monthly_licence_cost_inr"]:
    cols.remove(c); cols.insert(cols.index("target_licences_required")+1, c)
df = df[cols]
df.insert(0,"row_id",[f"R{i:06d}" for i in range(1,len(df)+1)])
df.to_csv(OUT/"licence_requirement_forecast_dataset.csv", index=False)
print(df.shape); print(df.split.value_counts().to_dict())
