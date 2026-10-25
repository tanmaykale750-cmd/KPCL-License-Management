"""
Knowledge base for retrieval, built ONLY from the real outputs of the two components:

  forecasting (ML)             reports/simulation/pool_forecast_by_month.csv, recommendations.json, software_summary.csv,
                     whatif_examples.json, reports/holdout_report.json, accuracy_report.md, feature_map.csv,
                     holdout_sample_explanations.csv, README.md, dataset assumptions
  recommendation engine         output/portfolio_pool_recommendations.csv, recommendations.csv, portfolio_pool_summary.csv,
                     forecast_integration_summary.json, run_summary.json, data/licence_inventory.csv,
                     data/usage_metrics.csv, README.md

Each document keeps the file it came from, so every answer can cite its sources.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

import pandas as pd

from .integration.engine_adapter import ACTION_MEANING, RecommendationService
from .integration.ml_adapter import MLService
from .terminology import neutralize


@dataclass
class Document:
    id: str
    doc_type: str
    title: str
    text: str
    source: str
    meta: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def _f(x, nd=1) -> str:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return str(x)
    if v != v:  # NaN
        return "n/a"
    return f"{v:,.{nd}f}"


def _pct(x, nd=1) -> str:
    try:
        return f"{100 * float(x):.{nd}f}%"
    except (TypeError, ValueError):
        return str(x)


def _inr(x) -> str:
    try:
        return f"INR {float(x):,.0f}"
    except (TypeError, ValueError):
        return str(x)


def _rel(p: Path, root: Path) -> str:
    try:
        return str(Path(p).resolve().relative_to(root.resolve())).replace("\\", "/")
    except ValueError:
        return str(p)


def split_markdown(md: str, min_len: int = 80) -> list[tuple[str, str]]:
    """Split markdown into (heading, body) sections on #/##/### headings."""
    parts, title, buf = [], "Introduction", []
    for line in md.splitlines():
        m = re.match(r"^(#{1,3})\s+(.*)", line)
        if m:
            if buf and len("\n".join(buf).strip()) >= min_len:
                parts.append((title, "\n".join(buf).strip()))
            title, buf = m.group(2).strip(), []
        else:
            buf.append(line)
    if buf and len("\n".join(buf).strip()) >= min_len:
        parts.append((title, "\n".join(buf).strip()))
    return parts


class KnowledgeBaseBuilder:
    def __init__(self, ml: MLService, rec: RecommendationService, project_root: Path):
        self.ml, self.rec, self.root = ml, rec, Path(project_root)
        self.warnings: list[str] = []

    def src(self, p: Path) -> str:
        return _rel(p, self.root)

    def build(self) -> list[Document]:
        docs: list[Document] = []
        for fn in (self._pool_forecasts, self._m2_pool_recs, self._m3_pool_recs, self._software_docs,
                   self._m3_software_recs, self._accuracy, self._model_comparison, self._feature_map, self._experiments,
                   self._assumptions, self._whatifs, self._explanations, self._methodology, self._glossary):
            try:
                docs.extend(fn())
            except FileNotFoundError as e:
                self.warnings.append(f"{fn.__name__}: {e}")
        for d in docs:                      # neutral wording for everything the user can see
            d.title, d.text = neutralize(d.title), neutralize(d.text)
        ids = [d.id for d in docs]
        assert len(ids) == len(set(ids)), "duplicate document ids"
        return docs

    # ------------------------------------------------------------------ forecasting component: forecasts per pool
    def _pool_forecasts(self) -> list[Document]:
        pf = self.ml.pool_forecast()
        src = self.src(self.ml.sim_dir / "pool_forecast_by_month.csv")
        docs = []
        for (p, s), g in pf.groupby(["portfolio_id", "software_id"], sort=True):
            g = g.sort_values("month")
            name = g["software"].iat[0]
            owned = g["licences_owned"].iat[0]
            lines = []
            for r in g.itertuples(index=False):
                lines.append(
                    f"- {r.month}: {int(r.forecasts)} project forecast row(s); expected peak {_f(r.peak_expected)}, "
                    f"P50 {_f(r.peak_p50)}, P90 (high case) {_f(r.peak_p90)} licences vs {_f(owned, 0)} owned; "
                    f"utilisation {_f(r.utilisation_pct)}%; shortage probability {_pct(r.shortage_probability)}; "
                    f"expected shortage {_f(r.expected_shortage, 2)} licences; licences needed (P95 + buffer) "
                    f"{_f(r.licences_needed, 0)}; {'AT RISK' if r.at_risk else 'within tolerance'}"
                    + (f"; main projects: {r.main_projects}" if r.main_projects else ""))
            risk_months = g.loc[g["at_risk"], "month"].tolist()
            projects = sorted(set(re.findall(r"P\d{4}", " ".join(g["main_projects"]))))
            head = (f"ML forecast ({self.ml.model_label}, run through the Monte Carlo simulation) for licence pool "
                    f"{p} / {s} {name}. Licences owned: {_f(owned, 0)}. Months at risk (shortage probability above the "
                    f"5% tolerance): {', '.join(risk_months) if risk_months else 'none'}. "
                    f"Maximum shortage probability {_pct(g['shortage_probability'].max())}; highest P90 peak "
                    f"{_f(g['peak_p90'].max())}; highest licences needed {_f(g['licences_needed'].max(), 0)}; "
                    f"idle cost over the window {_inr(g['idle_cost_inr'].sum())}. Months with 0 forecast rows have no "
                    f"project forecast in that month (recommendation engine treats them as missing coverage, not as zero demand).")
            docs.append(Document(f"forecast:{p}:{s}", "pool_forecast", f"ML forecast {p} / {s} {name}",
                                 head + "\nMonthly forecast:\n" + "\n".join(lines), src,
                                 {"portfolio_id": p, "software_id": s, "software_name": name,
                                  "projects": projects, "months": g["month"].tolist()}))
        return docs

    # ------------------------------------------------------------------ forecasting component: simulation recommendations
    def _m2_pool_recs(self) -> list[Document]:
        d = self.ml.sim_recommendations()
        src = self.src(self.ml.sim_dir / "recommendations.json")
        docs = []
        for r in d["recommendations"]:
            p, s = r["portfolio_id"], r["software_id"]
            txt = [f"Monte Carlo simulation recommendation for pool {p} / {s} {r['software']} (planning date "
                   f"{d.get('planning_date')}, window {', '.join(d.get('months', []))}).",
                   f"Action: {r['action']}. Status: {r['status']}. Savings label: {r['savings_label']}.",
                   f"Why: {r['why']}",
                   f"Licences owned {_f(r['licences_owned'], 0)}; peak need {_f(r['peak_need'], 0)}; months at risk "
                   f"{r['months_at_risk']}; max shortage probability {_pct(r['max_shortage_probability'])}; action cost "
                   f"{_inr(r['action_cost_inr'])}; meets risk tolerance after action: {r['meets_risk']}; idle cost in "
                   f"window {_inr(r['idle_cost_window_inr'])}; renewal date {r['renewal_date']}."]
            if r.get("options"):
                txt.append("Options compared by the simulation (cheapest option that meets the risk tolerance first):")
                for o in r["options"][:6]:
                    txt.append(f"- {o['option']}: months at risk {o['months_at_risk']}, max shortage probability "
                               f"{_pct(o['max_shortage_probability'])}, added cost {_inr(o['added_cost_inr'])}, residual "
                               f"shortage cost {_inr(o['residual_shortage_cost_inr'])}, total {_inr(o['total_cost_inr'])}, "
                               f"meets risk: {o['meets_risk']}" + (f", errors: {o['errors']}" if o.get("errors") else ""))
            docs.append(Document(f"m2rec:{p}:{s}", "pool_rec_m2", f"Simulation recommendation {p} / {s} {r['software']}",
                                 "\n".join(txt), src,
                                 {"portfolio_id": p, "software_id": s, "software_name": r["software"],
                                  "projects": sorted(set(re.findall(r"P\d{4}", r["why"] + json.dumps(r.get("options", []))))),
                                  "action": r["action"]}))
        return docs

    # ------------------------------------------------------------------ recommendation engine: pool recommendations
    def _m3_pool_recs(self) -> list[Document]:
        df = self.rec.pool_recommendations()
        src = self.src(self.rec.output_dir / "portfolio_pool_recommendations.csv")
        docs = []
        for r in df.itertuples(index=False):
            meaning = ACTION_MEANING.get(r.action, "")
            txt = (f"Recommendation engine (forecast-aware layer) for pool {r.portfolio_id} / {r.software_id} "
                   f"{r.software_name}. Action: {r.action}. Meaning: {meaning}\n"
                   f"Reason: {r.reason}\n"
                   f"Key numbers: current licences assumed for pool {r.current_licences_assumed_for_pool}; recommended "
                   f"permanent licences {r.recommended_permanent_licences}; temporary licences to consider "
                   f"{r.temporary_licences_to_consider}; estimated temporary cost {_inr(r.estimated_temporary_cost_inr)}; "
                   f"annual permanent cost change {_inr(r.estimated_annual_permanent_cost_delta_inr)}; possible annual "
                   f"saving at renewal {_inr(r.estimated_annual_saving_at_renewal_inr)}; max expected peak "
                   f"{_f(r.max_expected_peak)}; max P90 peak {_f(r.max_p90_peak)}; max forecast shortage probability "
                   f"{_f(r.max_forecast_shortage_probability_pct)}%; months over risk tolerance "
                   f"{r.months_over_risk_tolerance}; modelled licences needed (max) {r.modelled_licences_needed_max}; "
                   f"forecast coverage {_f(r.forecast_coverage_pct)}% ({r.months_with_forecast} of "
                   f"{r.expected_forecast_months} months).\n"
                   f"Contract: renewal date {r.renewal_date}; renewal notice deadline {r.renewal_notice_deadline} "
                   f"({r.days_to_notice_deadline} days from the as-of date, {r.notice_status}); criticality "
                   f"{r.criticality}. Software-wide history (usage history data used as a guardrail): denials "
                   f"{r.global_observed_denials_software}, observed peak demand {r.global_observed_peak_demand_software}, "
                   f"peak utilisation {r.global_peak_utilisation_pct_software}%, demand trend "
                   f"{r.global_demand_trend_pct_software}%.\n"
                   f"Savings label: {r.savings_label}. Approval: {r.approval_status}. Warning: {r.data_grain_warning}")
            docs.append(Document(f"m3pool:{r.portfolio_id}:{r.software_id}", "pool_rec_m3",
                                 f"Engine recommendation {r.portfolio_id} / {r.software_id} {r.software_name}: {r.action}",
                                 txt, src, {"portfolio_id": r.portfolio_id, "software_id": r.software_id,
                                            "software_name": r.software_name, "action": r.action}))
        return docs

    # ------------------------------------------------------------------ software-level docs
    def _software_docs(self) -> list[Document]:
        inv = self.rec.inventory().set_index("software_id")
        met = self.rec.usage_metrics().set_index("software_id")
        try:
            ss = self.ml.software_summary().set_index("software")
        except FileNotFoundError:
            ss = pd.DataFrame()
        try:
            ps = self.rec.pool_summary().set_index("software_id")
        except FileNotFoundError:
            ps = pd.DataFrame()
        docs = []
        for sid, r in inv.iterrows():
            name = r["software_name"]
            t = [f"Software overview {sid} {name} ({r['vendor']}, {r['category']}, {r['license_type']} licences). "
                 f"Usable licences {r['usable_licenses']} (purchased {r['purchased_licenses']}); annual cost per licence "
                 f"{_inr(r['annual_cost_per_license_inr'])}; annual contract value {_inr(r['annual_contract_value_inr'])}; "
                 f"renewal date {r['renewal_date']}; renewal notice deadline {r['renewal_notice_deadline']}; criticality "
                 f"{r['criticality']}; cost source: {r['cost_source']}."]
            if sid in met.index:
                m = met.loc[sid]
                t.append(f"Observed usage {m['metric_period_start']} to {m['metric_period_end']} (usage history data): peak "
                         f"occupied {m['peak_occupied_licences']}, peak demand incl. denials {m['peak_demand_incl_denials']}, "
                         f"denied checkouts {m['denied_checkout_requests']}, peak utilisation {m['peak_utilisation_pct']}%, "
                         f"average business-hours utilisation {m['avg_utilisation_business_hours_pct']}%, idle share "
                         f"{m['idle_pct_of_observed_time']}%, demand trend last 90 vs previous 90 days "
                         f"{m['demand_trend_last90_vs_prev90_pct']}%, entitled users {m['entitled_users']}, unique users "
                         f"{m['unique_users']}.")
            if name in ss.index:
                s = ss.loc[name]
                t.append(f"Monte Carlo simulation across pools: {s['pools']} pools, {s['pool_months_at_risk']} pool-months at "
                         f"risk, expected shortage {s['expected_shortage_licence_months']} licence-months, idle cost "
                         f"{_inr(s['idle_cost_inr'])} (not additive across pools), median utilisation "
                         f"{s['median_utilisation_pct']}%.")
            if sid in ps.index:
                s = ps.loc[sid]
                t.append(f"Recommendation engine pool recommendations: {s['portfolio_software_pools']} pools; over risk tolerance "
                         f"{s['pools_over_risk_tolerance']}; temporary access {s['pools_recommended_temporary_access']}; "
                         f"permanent increase {s['pools_recommended_permanent_increase']}; reduction candidates "
                         f"{s['pools_candidate_reduction']}; retained or investigated {s['pools_retained_or_investigated']}; "
                         f"maximum forecast risk {s['maximum_forecast_risk_pct']}%. {s['note']}")
            docs.append(Document(f"software:{sid}", "software_overview", f"Software overview {sid} {name}",
                                 "\n".join(t), "components/recommendation_engine/data/licence_inventory.csv; usage_metrics.csv; "
                                 "simulation software_summary.csv; recommendation engine portfolio_pool_summary.csv",
                                 {"software_id": sid, "software_name": name}))
        return docs

    def _m3_software_recs(self) -> list[Document]:
        df = self.rec.software_recommendations()
        src = self.src(self.rec.output_dir / "recommendations.csv")
        docs = []
        for r in df.to_dict("records"):
            txt = (f"Recommendation engine software-level (historical) recommendation for {r['software_id']} {r['software_name']}: "
                   f"{r.get('action')} - {r.get('recommendation_title', '')}. Current licences {r.get('current_licences')}; "
                   f"grid-search candidate {r.get('grid_search_candidate_licences')}; recommended {r.get('recommended_licences')}; "
                   f"estimated annual savings {_inr(r.get('estimated_annual_savings_inr'))} ({r.get('savings_status')}); "
                   f"selected shortage risk {r.get('selected_shortage_risk_pct')}% vs tolerance "
                   f"{r.get('target_shortage_risk_pct')}%; newsvendor target incl. buffer "
                   f"{r.get('newsvendor_target_licences_including_buffer')}; historical peak demand "
                   f"{r.get('historical_peak_demand')}; denials {r.get('denied_checkout_requests')}; demand source "
                   f"{r.get('demand_source')}.\nEvidence and reason: {r.get('evidence_and_reason')}")
            docs.append(Document(f"m3sw:{r['software_id']}", "software_rec_m3",
                                 f"Software-level recommendation {r['software_id']} {r['software_name']}: {r.get('action')}",
                                 txt, src, {"software_id": r["software_id"], "software_name": r["software_name"],
                                            "action": r.get("action")}))
        summ = self.rec.integration_summary()
        if summ:
            docs.append(Document("m3:integration_summary", "engine_method", "Forecast integration summary (recommendation engine)",
                                 "Recommendation engine forecast integration summary: " + json.dumps(summ, default=str),
                                 self.src(self.rec.output_dir / "forecast_integration_summary.json"), {}))
        rs = self.rec.run_summary()
        if rs:
            docs.append(Document("m3:run_summary", "engine_method", "Software-level engine run summary (recommendation engine)",
                                 "Recommendation engine software-level run summary: " + json.dumps(rs, default=str),
                                 self.src(self.rec.output_dir / "run_summary.json"), {}))
        return docs

    # ------------------------------------------------------------------ model evidence
    def _accuracy(self) -> list[Document]:
        rep = self.ml.holdout_report()
        src = self.src(self.ml.reports_dir / "holdout_report.json")
        m = rep["model"]
        d = rep.get("derived_targets", {})
        cov = rep.get("interval_coverage", {})
        checks = "; ".join(f"{'PASS' if c['passed'] else 'FAIL'} {c['check']}: {c['detail']}" for c in rep.get("checks", []))
        base = "; ".join(f"{k}: MAE {_f(v['mae'], 3)}, within +/-2 {_pct(v['within_2'])}"
                         for k, v in rep.get("baselines", {}).items())
        s42 = d.get("42_shortage_indicator", {})
        scope = ("Accuracy of the forecasting model in use on test A (known pools, months after the 30 Sep 2026 "
                 "as-of date; never used for training or for choosing the model)" if self.ml.model == "ensemble"
                 else "Single-model accuracy on held-out licence pools (never used in training)")
        extra = ""
        for t, v in (rep.get("other_tests") or {}).items():
            extra += (f" {t} ({(rep.get('test_definitions') or {}).get(t, '')}): MAE {_f(v['mae'], 3)}, within +/-2 "
                      f"{_pct(v['within_2'])}.")
        txt = (f"{scope}. Verdict: {rep.get('verdict')}. "
               f"Backend: {rep.get('backend')}. Target 39 (pool peak demand): MAE {_f(m['mae'], 3)} licences, RMSE "
               f"{_f(m['rmse'], 3)}, WAPE {_pct(m['wape'])}, R2 {_f(m['r2'], 3)}, exact {_pct(m['exact'])}, within +/-1 "
               f"{_pct(m['within_1'])}, within +/-2 {_pct(m['within_2'])}, bias {_f(m['bias'], 3)}. P90 coverage "
               f"{_pct(cov.get('p90'))}, P10-P90 coverage {_pct(cov.get('p10_p90'))}. Simple-rule baselines: {base}. "
               f"Shortage indicator (42): AUC {_f(s42.get('auc'), 3)} vs simple rule {_f(s42.get('simple_rule_auc'), 3)}. "
               f"Checks: {checks}.{extra}")
        if self.ml.model == "ensemble":
            src = self.src(self.ml.ensemble_dir / "reports" / "ensemble" / "ml_report.json")
        docs = [Document("model:accuracy", "model_accuracy", "Model accuracy on held-out pools", txt, src, {})]
        for key, title in [("by_horizon", "Accuracy by months ahead"), ("by_history", "Accuracy by usage history"),
                           ("by_software", "Accuracy by software"), ("by_size", "Accuracy by actual pool peak size"),
                           ("by_phase", "Accuracy by project phase")]:
            rows = rep.get(key, [])
            if rows:
                body = "\n".join(f"- {r['group']}: rows {r['rows']}, MAE {_f(r['mae'], 3)}, WAPE {_pct(r['wape'])}, within "
                                 f"+/-2 {_pct(r['within_2'])}, P90 coverage {_pct(r['p90_coverage'])}" for r in rows)
                docs.append(Document(f"model:{key}", "model_accuracy", title, f"{title} (hold-out test):\n{body}",
                                     src, {}))
        return docs

    def _model_comparison(self) -> list[Document]:
        mc = self.ml.model_comparison()
        if mc is None:
            return []
        rep = self.ml.ensemble_report()["model"]
        lines = []
        for r in mc.itertuples():
            lines.append(f"- rank {r.rank_cv}: {r.label} ({r.family}){' <- SELECTED' if r.model == rep['selected'] else ''}: "
                         f"walk-forward CV MAE {_f(r.cv_mae, 3)} (+/- {_f(r.cv_mae_fold_std, 3)} across folds), within +/-2 "
                         f"{_pct(r.cv_within_2)}; test A MAE {_f(getattr(r, 'A_out_of_time', float('nan')), 3)}, test B "
                         f"{_f(getattr(r, 'B_unseen_pools', float('nan')), 3)}, test C "
                         f"{_f(getattr(r, 'C_unseen_pools_out_of_time', float('nan')), 3)}")
        w = ", ".join(f"{k} {v:.2f}" for k, v in (rep.get("ensemble_stacked_weights") or {}).items())
        nr = "; ".join(f"{k}: {v}" for k, v in (rep.get("candidates_not_run") or {}).items()) or "none"
        txt = (f"Which forecasting model is used and why. Several light models were compared on the v3 dataset with "
               f"walk-forward (time-ordered, purged) cross-validation; the one with the lowest CV MAE is used for all "
               f"forecasts: {rep['selected_label']}. {rep['selection_reason']} Selection rule: {rep['selection_rule']} "
               f"Stacked-ensemble weights: {w}. Candidates not run: {nr}. Tests (scored once after selection): A = known "
               f"pools, future months; B = unseen pools; C = unseen pools and future months. Hyperparameters were fixed "
               f"(no search) to avoid overfitting the comparison to this dataset.\nLeaderboard (MAE in licences, lower is "
               f"better):\n" + "\n".join(lines))
        return [Document("model:comparison", "model_accuracy", "Model comparison: which model is used and why", txt,
                         self.src(self.ml.ensemble_dir / "reports" / "ensemble" / "leaderboard.csv"), {})]

    def _feature_map(self) -> list[Document]:
        fm = self.ml.feature_map()
        body = "\n".join(f"- #{r.feature_no} {r.requested_feature}: {r.status} ({r.dataset_columns})" for r in fm.itertuples())
        return [Document("model:feature_map", "model_method", "Model input features (feature map)",
                         "Which requested features the ML model uses, derives or lacks:\n" + body,
                         self.src(self.ml.reports_dir / "feature_map.csv"), {})]

    def _experiments(self) -> list[Document]:
        ex = self.ml.experiments()
        body = "\n".join(f"- {r.step} | {r.experiment} | CV MAE {_f(r.cv_mae, 4)} | kept: {r.kept}"
                         + (f" | {r.note}" if isinstance(r.note, str) and r.note else "") for r in ex.itertuples())
        if self.ml.model == "ensemble":
            return []          # the leaderboard is in the model-comparison document
        return [Document("model:experiments", "model_method", "Model improvement experiments (cross-validation)",
                         "Improvement ladder decided by 5-fold cross-validation grouped by portfolio:\n" + body,
                         self.src(self.ml.reports_dir / "experiments.csv"), {})]

    def _assumptions(self) -> list[Document]:
        a = self.ml.assumptions_table()
        src = self.src(self.ml.C.ASSUMPTIONS_FILE)
        body = "\n".join(f"- {r.assumption_key} = {r.value} {r.unit}: {r.description} [{r.status}]" for r in a.itertuples())
        docs = [Document("data:assumptions", "assumption", "Planning assumptions (risk tolerance, buffer, prices)",
                         "Assumptions used by both the simulation and the recommendation engine:\n" + body, src, {})]
        for r in a.itertuples():
            label = str(r.assumption_key).replace("_", " ")
            docs.append(Document(f"data:assumption:{r.assumption_key}", "assumption", f"Assumption: {label}",
                                 f"Planning assumption '{label}' ({r.assumption_key}) = {r.value} {r.unit}. "
                                 f"{r.description}. Status: {r.status}.", src, {}))
        return docs

    def _whatifs(self) -> list[Document]:
        w = self.ml.whatif_examples()
        if not w:
            return []
        body = "\n".join(f"- {x['pool']} | {x['scenario']} | valid {x['valid']} | months at risk {x['months_at_risk']} "
                         f"({x['change_months_at_risk']:+d}) | expected shortage {_f(x['expected_shortage_licence_months'], 2)} "
                         f"licence-months ({x['change_expected_shortage']:+.2f})"
                         + (f" | errors: {'; '.join(x['errors'])}" if x["errors"] else "") for x in w.get("whatifs", []))
        pools = sorted({x["pool"] for x in w.get("whatifs", [])})
        meta = {}
        if pools:
            p, s = pools[0].split("/")
            meta = {"portfolio_id": p, "software_id": s}
        return [Document("model:whatif_examples", "whatif_example", "What-if examples from the simulation",
                         f"What-if scenarios run by the simulation on the riskiest pool (baseline P50 by month "
                         f"{w.get('baseline_peak_p50_by_month')}):\n{body}",
                         self.src(self.ml.sim_dir / "whatif_examples.json"), meta)]

    def _explanations(self) -> list[Document]:
        if self.ml.model == "ensemble":
            return []          # these samples come from the single gradient-boosted model; live explanations cover the ensemble
        ex = self.ml.holdout_explanations()
        ex["pool"] = ex["text"].str.extract(r"Pool (PF\d{3}) / ([^,]+),").apply(lambda r: f"{r[0]} / {r[1]}", axis=1)
        name_to_id = {v: k for k, v in self.ml.lookup().set_index("software_id")["software_name"].items()}
        docs = []
        for pool, g in ex.groupby("pool"):
            pfid = pool.split(" / ")[0]
            body = "\n".join(f"- {t}" for t in g["text"].head(12))
            docs.append(Document(f"explain:{pool}", "explanation_sample", f"Model explanation samples {pool}",
                                 f"Per-prediction driver explanations from the model on held-out rows for {pool}. "
                                 f"Each driver is the change in predicted licences caused by that feature group "
                                 f"compared with a typical row:\n{body}",
                                 self.src(self.ml.reports_dir / "holdout_sample_explanations.csv"),
                                 {"portfolio_id": pfid, "software_name": pool.split(" / ")[1],
                                  "software_id": name_to_id.get(pool.split(" / ")[1])}))
        return docs

    def _methodology(self) -> list[Document]:
        docs = []
        m2_readme = (self.ml.dir / "README.md").read_text(encoding="utf-8") if (self.ml.dir / "README.md").exists() else ""
        sources = [("Forecasting model and Monte Carlo simulation", m2_readme, "components/forecasting/README.md", "model_method"),
                   ("Recommendation engine", self.rec.readme(), "components/recommendation_engine/README.md",
                    "engine_method")]
        if self.ml.model == "ensemble":
            sources.insert(0, ("Light-model comparison (forecasting model in use)", self.ml.readme(),
                               "components/model_selection/README.md", "model_method"))
        for j, (who, text, src, dtype) in enumerate(sources):
            for i, (h, body) in enumerate(split_markdown(text)):
                docs.append(Document(f"{dtype}:readme{j}:{i}", dtype, f"{who}: {h}", f"{who} documentation - {h}:\n{body}",
                                     src, {}))
        return docs

    def _glossary(self) -> list[Document]:
        # Definitions are taken from how the two codebases compute each field (licence_ml/simulate.py,
        # licence_ml/train.py, portfolio_decision_engine.py). No numbers here.
        g = {
            "P50 / P90 peak": "P50 is the middle forecast of the pool's peak simultaneous licence use in a month (half "
                              "of the simulated futures are above it). P90 is the 'high case': only 10% of simulated "
                              "futures are higher.",
            "Shortage probability": "Share of the 4,000 Monte Carlo futures in which peak demand exceeds the licences "
                                    "owned (plus any temporary licences) in that month. Above 5% = at risk.",
            "Licences needed": "The 95th percentile of simulated peak demand, rounded up, plus a 1-licence safety buffer "
                               "(from assumptions.csv).",
            "Expected shortage": "Average number of licences missing at peak across the simulated futures.",
            "Utilisation": "Median simulated peak divided by licences owned, in percent.",
            "Idle cost": "Expected unused licences at peak times the monthly cost per licence.",
            "Forecast rows": "How many project forecasts fall in that pool-month; 0 means no project forecast exists for "
                             "that month.",
            "Pool": "A licence pool is one portfolio x one software. The simulation's convention gives every pool the full "
                    "software licence count, so money is NOT additive across pools.",
            "Possible vs Confirmed savings": "Savings stay 'Possible' while prices are synthetic or the decision is not "
                                             "approved; 'Confirmed' needs verified contract prices AND an approved decision.",
        }
        g.update({f"Action {k}": v for k, v in ACTION_MEANING.items()})
        return [Document(f"glossary:{i}", "glossary", f"Glossary: {k}", f"{k}: {v}",
                         "definitions from licence_ml/simulate.py, licence_ml/train.py, portfolio_decision_engine.py", {})
                for i, (k, v) in enumerate(g.items())]


def save_documents(docs: list[Document], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for d in docs:
            f.write(json.dumps(d.to_dict(), ensure_ascii=False, default=str) + "\n")


def load_documents(path: Path) -> list[Document]:
    with open(path, encoding="utf-8") as f:
        return [Document(**json.loads(line)) for line in f if line.strip()]
