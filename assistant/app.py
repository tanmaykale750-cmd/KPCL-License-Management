"""
KPCL Licence Intelligence Assistant - Streamlit UI.

    streamlit run app.py

Pages: Assistant (RAG chat) | Predictions (selected ML model) | Recommendations (recommendation engine + simulation options)
       | What-if (live simulation) | Model evidence (accuracy, pipeline status)
"""
from __future__ import annotations

import traceback

import pandas as pd
import streamlit as st

from rag_chatbot.integration.engine_adapter import ACTION_MEANING
from rag_chatbot.terminology import neutralize
from rag_chatbot.integration.ml_adapter import MLUnavailable, WhatIfRequest
from rag_chatbot.services import build_services

st.set_page_config(page_title="KPCL Licence Assistant", page_icon="📊", layout="wide")

PAGES = ["💬 Assistant", "📈 Predictions", "✅ Recommendations", "🧪 What-if", "📊 Model evidence"]
ACTION_STYLE = {
    "CONSIDER_PERMANENT_INCREASE": ("🔴", "error"), "INVESTIGATE_TEMPORARY_ACCESS": ("🟠", "warning"),
    "INVESTIGATE_FORECAST_RISK": ("🟠", "warning"), "CONSIDER_REDUCTION_AT_RENEWAL": ("🟢", "success"),
    "RETAIN_AND_MONITOR": ("🔵", "info"), "RETAIN_AND_MONITOR_GLOBAL_DEMAND": ("🔵", "info"),
    "RETAIN_AND_REVIEW_PARTIAL_FORECAST": ("⚪", "info"), "RETAIN_AND_REVIEW_NO_FORECAST": ("⚪", "info"),
}

st.markdown("""<style>
.block-container {padding-top: 1.6rem;}
.src-title {font-weight: 600;}
.small-note {color: #6b6b6b; font-size: 0.85rem;}
</style>""", unsafe_allow_html=True)


# ----------------------------------------------------------------------------- loading
@st.cache_resource(show_spinner="Loading the ML outputs, the recommendation engine and the knowledge base ...")
def get_services():
    return build_services()


try:
    svc = get_services()
except Exception as e:  # show a useful message instead of a stack trace
    st.error(f"Could not start the assistant: {type(e).__name__}: {e}")
    st.info("Run `python scripts/build_pipeline.py --check` in the project folder to see what is missing.")
    with st.expander("Technical details"):
        st.code(traceback.format_exc())
    st.stop()


@st.cache_data(show_spinner=False)
def pool_forecast() -> pd.DataFrame:
    return svc.ml.pool_forecast()


@st.cache_data(show_spinner=False)
def pool_recs() -> pd.DataFrame:
    return svc.rec.pool_recommendations()


@st.cache_data(show_spinner=False)
def software_recs() -> pd.DataFrame:
    return svc.rec.software_recommendations()


@st.cache_data(show_spinner=False)
def sim_recs() -> dict:
    d = svc.ml.sim_recommendations()
    return {(r["portfolio_id"], r["software_id"]): r for r in d["recommendations"]}


@st.cache_data(show_spinner=False)
def planning_date() -> str:
    return str(svc.ml.sim_recommendations().get("planning_date"))


@st.cache_data(show_spinner=False)
def model_status() -> dict:
    return svc.ml.model_status()


# ----------------------------------------------------------------------------- session state
ss = st.session_state
ss.setdefault("messages", [])          # [{role, content, meta}]
ss.setdefault("pending", None)
ss.setdefault("page", PAGES[0])


def ask(question: str):
    """Button callback: queue a question and jump to the chat."""
    ss.pending = question
    ss.page = PAGES[0]


# ----------------------------------------------------------------------------- sidebar
pf_all = pool_forecast()
with st.sidebar:
    st.title("📊 Licence Assistant")
    st.caption("KPCL engineering-software licence forecasts and recommendations")
    st.radio("View", PAGES, key="page")
    st.divider()
    st.subheader("Selected pool")
    portfolios = sorted(pf_all["portfolio_id"].unique())
    pf = st.selectbox("Portfolio", portfolios, key="pf")
    sw_opts = (pf_all[pf_all["portfolio_id"] == pf][["software_id", "software"]].drop_duplicates()
               .sort_values("software_id"))
    sw_labels = {r.software_id: f"{r.software_id} · {r.software}" for r in sw_opts.itertuples()}
    if ss.get("sw") not in sw_labels:          # portfolio changed: reset a software that it does not use
        ss["sw"] = next(iter(sw_labels))
    sw = st.selectbox("Software", list(sw_labels), format_func=sw_labels.get, key="sw")
    use_focus = st.checkbox("Use this pool as chat context when a question names no pool", value=True)
    st.divider()
    mst = model_status()
    pub = svc.settings.public_summary()
    with st.expander("System status", expanded=False):
        st.markdown(f"**Forecasting model:** {'✅ loaded' if mst['available'] else '⚠️ not available'}")
        st.caption(mst.get("label", ""))
        if mst["available"]:
            st.caption(f"CV MAE {mst['cv_mae']:.3f} licences · {mst['training_portfolios']} training pools · "
                       f"setting FORECAST_MODEL={mst.get('model')}")
        else:
            st.caption(mst["error"])
        st.markdown(f"**Recommendation engine (recommendation engine):** ✅ {len(pool_recs())} pool recommendations")
        st.markdown(f"**Knowledge base:** {len(svc.docs)} documents")
        st.markdown(f"**LLM:** {pub['provider']} · {pub['model']}"
                    + ("" if pub['provider'] != "none" else " (retrieval-only mode)"))
        for w in svc.warnings:
            st.warning(w)
    if st.button("🗑️ Clear chat"):
        ss.messages = []
        st.rerun()

focus = (pf, sw) if use_focus else None
pool_df = pf_all[(pf_all["portfolio_id"] == pf) & (pf_all["software_id"] == sw)].sort_values("month")
engine_row = pool_recs()[(pool_recs()["portfolio_id"] == pf) & (pool_recs()["software_id"] == sw)]
sim_rec = sim_recs().get((pf, sw))


def action_badge(action: str) -> str:
    return f"{ACTION_STYLE.get(action, ('•', 'info'))[0]} **{action}**"


def model_unavailable_box(err: Exception | str):
    st.warning(f"The live ML model is not available: {err}")
    st.caption("Saved outputs of the model are still shown. To enable live features run "
               "`python scripts/build_pipeline.py --check` and follow the hint.")


# ----------------------------------------------------------------------------- pages
def page_assistant():
    st.header("💬 Ask about forecasts and recommendations")
    st.caption("Answers are grounded in the ML model's outputs and the recommendation engine. Every answer lists its "
               "sources. Try: *Why is PF001 ANSYS at risk?*, *What if we add 2 licences?*, *Which MATLAB pools are "
               "riskiest?*, *How accurate is the model?*")
    if not ss.messages:
        st.info(f"Selected pool: **{pf} / {sw_labels[sw]}**. Questions that don't name a pool use it "
                f"{'(enabled)' if use_focus else '(disabled in the sidebar)'}.")
    for i, msg in enumerate(ss.messages):
        with st.chat_message(msg["role"]):
            st.markdown(msg["content"])
            if msg["role"] == "assistant":
                render_meta(msg.get("meta", {}), i)

    last_sugg = next((m["meta"].get("suggestions") for m in reversed(ss.messages)
                      if m["role"] == "assistant" and m.get("meta", {}).get("suggestions")), None)
    sugg = last_sugg or svc.engine.suggestions(svc.engine.resolve_entities("forecast", [], focus), [])
    cols = st.columns(max(1, len(sugg[:4])))
    for c, q in zip(cols, sugg[:4]):
        c.button(q, key=f"sugg_{hash(q)}_{len(ss.messages)}", on_click=ask, args=(q,))

    prompt = st.chat_input("Ask a question, a follow-up, or a what-if (e.g. 'what if we delay P1254 by 2 months?')")
    q = prompt or ss.pending
    ss.pending = None
    if q:
        history = [{"role": m["role"], "content": m["content"], "meta": {"entities": m.get("meta", {}).get("entities")}}
                   for m in ss.messages]
        ss.messages.append({"role": "user", "content": q, "meta": {}})
        with st.chat_message("user"):
            st.markdown(q)
        with st.chat_message("assistant"):
            with st.spinner("Retrieving facts and running the model ..."):
                try:
                    res = svc.engine.answer(q, history, focus)
                except Exception as e:
                    st.error(f"Something went wrong while answering: {type(e).__name__}: {e}")
                    with st.expander("Technical details"):
                        st.code(traceback.format_exc())
                    ss.messages.pop()
                    return
            st.markdown(res.answer)
            meta = {"entities": res.entities.to_dict(), "notes": res.notes, "llm": res.llm_used,
                    "query": res.standalone_query, "suggestions": res.suggestions,
                    "blocks": [dict(label=b.label, title=b.title, source=b.source, kind=b.kind, text=b.text)
                               for b in res.blocks]}
            ss.messages[-1]["meta"] = {"entities": res.entities.to_dict()}
            ss.messages.append({"role": "assistant", "content": res.answer, "meta": meta})
            render_meta(meta, len(ss.messages) - 1)
        st.rerun()


def render_meta(meta: dict, idx: int):
    for n in meta.get("notes", []):
        st.caption(f"ℹ️ {n}")
    blocks = meta.get("blocks", [])
    if blocks:
        ents = meta.get("entities") or {}
        scope = ", ".join((ents.get("portfolios") or []) + (ents.get("software") or []) + (ents.get("projects") or []))
        with st.expander(f"Sources ({len(blocks)})" + (f" · context: {scope}" if scope else "")
                         + (f" · {meta['llm']}" if meta.get("llm") else " · no LLM")):
            for b in blocks:
                icon = {"live_model": "⚡", "live_engine": "⚡", "analytics": "🧮"}.get(b["kind"], "📄")
                st.markdown(f"{icon} <span class='src-title'>[{b['label']}] {b['title']}</span>  \n"
                            f"<span class='small-note'>{b['source']}</span>", unsafe_allow_html=True)
                st.text(b["text"][:1500] + (" ..." if len(b["text"]) > 1500 else ""))


def page_predictions():
    st.header(f"📈 ML forecast · {pf} / {sw_labels[sw]}")
    st.caption(f"Forecasting model: {svc.ml.model_label}. It predicts the pool's peak demand from each project's plan "
               "and usage; the Monte Carlo simulation (4,000 futures) turns that into P50/P90, shortage probability "
               "and licences needed. "
               f"Planning date {planning_date()}.")
    if pool_df.empty:
        st.warning("No forecast for this pool.")
        return
    owned = float(pool_df["licences_owned"].iat[0])
    c = st.columns(5)
    c[0].metric("Licences owned", f"{owned:.0f}")
    c[1].metric("Highest P90 peak", f"{pool_df['peak_p90'].max():.1f}")
    c[2].metric("Max shortage probability", f"{100 * pool_df['shortage_probability'].max():.1f}%")
    c[3].metric("Months at risk (>5%)", int(pool_df["at_risk"].sum()))
    c[4].metric("Licences needed (max)", f"{pool_df['licences_needed'].max():.0f}",
                help="95th percentile of simulated peak + 1 safety buffer licence")
    chart = pool_df.set_index("month")[["peak_p50", "peak_p90", "licences_owned", "licences_needed"]].rename(
        columns={"peak_p50": "Peak demand P50", "peak_p90": "Peak demand P90 (high case)",
                 "licences_owned": "Licences owned", "licences_needed": "Licences needed (P95+buffer)"})
    st.line_chart(chart)
    show = pool_df[["month", "forecasts", "peak_expected", "peak_p50", "peak_p90", "licences_owned", "utilisation_pct",
                    "shortage_probability", "expected_shortage", "licences_needed", "at_risk", "idle_cost_inr",
                    "main_projects"]].copy()
    show["shortage_probability"] = (100 * show["shortage_probability"]).round(1)
    st.dataframe(show.rename(columns={"shortage_probability": "shortage_probability_%"}), hide_index=True)
    with st.expander("What do these columns mean?"):
        st.markdown("- **forecasts**: project forecasts falling in that month (0 = no project forecast; recommendation engine treats "
                    "that as missing coverage, not zero demand)\n- **P50 / P90**: middle / high-case simulated peak of "
                    "simultaneous users\n- **shortage probability**: share of simulated futures where demand exceeds "
                    "licences owned\n- **licences needed**: P95 of simulated peak + 1 buffer\n- **idle cost**: expected "
                    "unused licences x monthly price (synthetic prices)")

    st.subheader("⚡ Run the trained model live")
    st.caption("Re-runs the forecasting model and the PoolSimulator for this pool and asks the model which feature groups "
               "drive the prediction.")
    if st.button("Run live forecast + explanation", type="primary"):
        try:
            with st.spinner("Loading the dataset and running the model (first run can take ~30-60 s) ..."):
                live = svc.ml.live_pool_forecast(pf, sw)
                ex = svc.ml.explain_pool(pf, sw)
            ss[f"live_{pf}_{sw}"] = (live, ex)
        except MLUnavailable as e:
            model_unavailable_box(e)
        except Exception as e:
            st.error(f"Live run failed: {type(e).__name__}: {e}")
    if f"live_{pf}_{sw}" in ss:
        live, ex = ss[f"live_{pf}_{sw}"]
        cmpcols = ["month", "peak_p50", "peak_p90", "shortage_probability", "licences_needed"]
        a = live[cmpcols].reset_index(drop=True)
        b = pool_df[cmpcols].reset_index(drop=True)
        same = a.shape == b.shape and ((a.drop(columns="month") - b.drop(columns="month")).abs().max().max() < 1e-3)
        st.success("Live model output matches the saved simulation output for this pool." if same else
                   "Live output differs from the saved file - run `python scripts/build_pipeline.py --simulate`.")
        if ex.get("months"):
            drv = pd.DataFrame([{"month": m["month"], "predicted peak": round(m["peak_expected_mean"], 2),
                                 "typical": round(m["typical_baseline"], 2), **m["drivers"]} for m in ex["months"]])
            st.markdown(f"**Drivers of the prediction** ({ex['method']}): licences added (+) or removed (−) versus a "
                        "typical prediction")
            st.dataframe(drv, hide_index=True)
            st.bar_chart(drv.set_index("month")[[k for k in ex["months"][0]["drivers"]]])
            with st.expander("Plain-language examples from the model"):
                for m in ex["months"]:
                    st.markdown(f"- {m['example']}")
        else:
            st.info(ex.get("note", "No forecast rows."))
        st.button("Ask the assistant to explain this forecast", on_click=ask,
                  args=(f"Explain the forecast for {pf} {sw} in simple terms: what drives it and is it a problem?",))


def page_recommendations():
    st.header(f"✅ Recommendations · {pf} / {sw_labels[sw]}")
    if engine_row.empty:
        st.info("No recommendation-engine result for this pool.")
    else:
        r = engine_row.iloc[0]
        c = st.columns(4)
        c[0].metric("Licences now", int(r["current_licences_assumed_for_pool"]))
        c[1].metric("Recommended permanent", int(r["recommended_permanent_licences"]))
        c[2].metric("Highest shortage chance", f"{r['max_forecast_shortage_probability_pct']:.1f}%")
        c[3].metric("Notice deadline", str(r["renewal_notice_deadline"]),
                    help=f"{r['days_to_notice_deadline']} days from the planning date ({r['notice_status']})")
    try:
        b = svc.engine.brief(pf, sw)
    except Exception as e:
        b = None
        st.error(f"Could not build the explanation: {type(e).__name__}: {e}")
    if b is not None:
        # the brief already carries summary, forecast, the step-by-step reasoning, options, caveats and next steps
        st.markdown(b["markdown"].split("\n", 1)[1])
    st.button("💬 Ask the assistant about this recommendation", on_click=ask,
              args=(f"Explain the recommendation for {pf} {sw}: why was it made and what should we do next?",))
    if not engine_row.empty:
        with st.expander("Engine record (raw)"):
            st.write(neutralize(engine_row.iloc[0]["reason"]))
            st.caption(neutralize(engine_row.iloc[0]["data_grain_warning"]))

    st.subheader(f"Software-level view · {sw_labels[sw]}")
    srec = software_recs()[software_recs()["software_id"] == sw]
    if not srec.empty:
        r = srec.iloc[0]
        st.markdown(f"{action_badge(r['action'])} — {r['recommendation_title']} "
                    f"({r['current_licences']} → {r['recommended_licences']} licences, historical replay)")
        st.caption(neutralize(r["evidence_and_reason"]))

    with st.expander("All pool recommendations (filterable)"):
        allr = pool_recs()
        f1, f2 = st.columns(2)
        sws = f1.multiselect("Software", sorted(allr["software_name"].unique()))
        acts = f2.multiselect("Action", sorted(allr["action"].unique()))
        v = allr
        if sws:
            v = v[v["software_name"].isin(sws)]
        if acts:
            v = v[v["action"].isin(acts)]
        cols = ["portfolio_id", "software_id", "software_name", "action", "max_forecast_shortage_probability_pct",
                "months_over_risk_tolerance", "current_licences_assumed_for_pool", "modelled_licences_needed_max",
                "recommended_permanent_licences", "temporary_licences_to_consider", "forecast_coverage_pct"]
        st.dataframe(v[cols].sort_values("max_forecast_shortage_probability_pct", ascending=False), hide_index=True)
        st.download_button("Download CSV", v.to_csv(index=False).encode("utf-8"), "pool_recommendations.csv",
                           "text/csv")
        st.caption("Counts and money are per pool and not additive across portfolios (each pool is modelled with the full licence count).")


def page_whatif():
    st.header(f"🧪 What-if · {pf} / {sw_labels[sw]}")
    st.caption("Runs the scenario through the forecasting model and the Monte Carlo simulation, then re-applies the "
               "recommendation engine's rules to the new forecast. Plan changes (delay / cancel / team size) re-run the model; licence "
               "changes change supply only. Only projects that have not started can be delayed or cancelled.")
    try:
        projects = svc.ml.pool_projects(pf, sw)
    except MLUnavailable as e:
        model_unavailable_box(e)
        return
    except Exception as e:
        st.error(f"Could not load the pool's projects: {type(e).__name__}: {e}")
        return
    not_started = projects[projects["not_started"]]["project_id"].tolist() if len(projects) else []
    with st.expander(f"Projects feeding this pool in the window ({len(projects)})"):
        st.dataframe(projects, hide_index=True)
    with st.form("whatif"):
        c = st.columns(2)
        lic = c[0].number_input("Change permanent licences by", min_value=-20, max_value=30, value=0, step=1)
        tmp = c[1].number_input("Temporary licences available per month", min_value=0, max_value=30, value=0, step=1)
        c = st.columns(3)
        dproj = c[0].selectbox("Delay a not-started project", ["(none)"] + not_started)
        dmon = c[1].number_input("Delay by (months)", min_value=1, max_value=6, value=1)
        cancel = c[2].multiselect("Cancel not-started projects", not_started)
        c = st.columns(2)
        tproj = c[0].selectbox("Change team size of", ["(none)"] + projects["project_id"].tolist())
        tsize = c[1].number_input("New team size", min_value=1, max_value=200, value=10)
        go = st.form_submit_button("Run what-if", type="primary")
    if go:
        req = WhatIfRequest(pf, sw, licence_change=int(lic), temp_licences=int(tmp),
                            delay_projects={dproj: int(dmon)} if dproj != "(none)" else {},
                            cancel_projects=list(cancel), team_size={tproj: int(tsize)} if tproj != "(none)" else {})
        if req.is_empty():
            st.info("Choose at least one change.")
        else:
            try:
                with st.spinner("Re-running the model and 4,000 simulated futures ..."):
                    res = svc.ml.what_if(req)
                    m3 = svc.rec.evaluate_forecast(res["monthly_after"], req.licence_change) if res["valid"] else None
                ss["whatif_result"] = (req, res, m3)
            except Exception as e:
                st.error(f"What-if failed: {type(e).__name__}: {e}")
    if "whatif_result" in ss and ss["whatif_result"][0].portfolio_id == pf and ss["whatif_result"][0].software_id == sw:
        req, res, m3 = ss["whatif_result"]
        st.subheader(f"Result: {res['description']}")
        if not res["valid"]:
            st.error("Scenario rejected: " + "; ".join(res["errors"]))
            return
        s = res["summary"]
        c = st.columns(4)
        c[0].metric("Months at risk", s["months_at_risk_after"], s["months_at_risk_after"] - s["months_at_risk_before"],
                    delta_color="inverse")
        c[1].metric("Max shortage prob.", f"{100 * s['max_shortage_probability_after']:.1f}%",
                    f"{100 * (s['max_shortage_probability_after'] - s['max_shortage_probability_before']):+.1f} pts",
                    delta_color="inverse")
        c[2].metric("Expected shortage (lic-months)", f"{s['expected_shortage_licence_months_after']:.2f}",
                    f"{s['expected_shortage_licence_months_after'] - s['expected_shortage_licence_months_before']:+.2f}",
                    delta_color="inverse")
        c[3].metric("Added cost", f"INR {s['added_cost_inr']:,.0f}")
        cmp_ = res["comparison"]
        st.line_chart(cmp_.set_index("month")[["peak_p90_before", "peak_p90_after", "licences_owned_after"]].rename(
            columns={"peak_p90_before": "P90 before", "peak_p90_after": "P90 after",
                     "licences_owned_after": "Licences owned (scenario)"}))
        st.dataframe(cmp_, hide_index=True)
        if m3 is not None and len(m3):
            r = m3.iloc[0]
            st.markdown(f"**Recommendation engine on the scenario:** {action_badge(r['action'])}")
            st.caption(neutralize(r["reason"]))
        parts = []
        if req.licence_change:
            parts.append(f"{'add' if req.licence_change > 0 else 'remove'} {abs(req.licence_change)} licences")
        if req.temp_licences:
            parts.append(f"use {req.temp_licences} temporary licences")
        parts += [f"delay {p} by {k} months" for p, k in req.delay_projects.items()]
        parts += [f"cancel {p}" for p in req.cancel_projects]
        parts += [f"set {p} team size to {n}" for p, n in req.team_size.items()]
        st.button("💬 Ask the assistant about this result", on_click=ask,
                  args=(f"What if we {' and '.join(parts)} for {pf} {sw}? Explain the result simply and whether "
                        "it is worth it.",))


def page_evidence():
    st.header("📊 Model evidence and pipeline status")
    try:
        rep = svc.ml.holdout_report()
    except FileNotFoundError as e:
        st.warning(str(e))
        return
    m = rep["model"]
    held = ("test A: known pools, months after the as-of date" if svc.ml.model == "ensemble" else "15 unseen licence pools")
    st.markdown(f"**Verdict on held-out data: {rep['verdict']}** ({rep.get('backend')}; {held})")
    c = st.columns(5)
    c[0].metric("MAE (licences)", f"{m['mae']:.2f}")
    c[1].metric("WAPE", f"{100 * m['wape']:.0f}%")
    c[2].metric("R²", f"{m['r2']:.2f}")
    c[3].metric("Within ±2 licences", f"{100 * m['within_2']:.0f}%")
    c[4].metric("P90 coverage", f"{100 * rep['interval_coverage']['p90']:.1f}%")
    for chk in rep["checks"]:
        st.markdown(f"{'✅' if chk['passed'] else '❌'} {chk['check']} — {chk['detail']}")
    mc = svc.ml.model_comparison()
    if mc is not None:
        st.subheader("Model comparison (most accurate on cross-validation is used)")
        st.caption(svc.ml.ensemble_report()["model"]["selection_reason"])
        st.dataframe(mc.rename(columns={"cv_mae": "CV MAE", "cv_mae_fold_std": "fold std", "cv_within_2": "CV within ±2",
                                        "A_out_of_time": "test A MAE", "B_unseen_pools": "test B MAE",
                                        "C_unseen_pools_out_of_time": "test C MAE"}).drop(columns=["model"]),
                     hide_index=True)
    st.subheader("Accuracy by software")
    st.dataframe(pd.DataFrame(rep["by_software"]), hide_index=True)
    imgs = svc.ml.chart_paths()
    if imgs:
        st.subheader("Charts written by the model pipeline")
        for p in imgs:
            st.image(str(p), caption=p.name)
    st.subheader("Pipeline status")
    sync = svc.rec.handoff_in_sync()
    st.markdown(f"{'✅' if sync.get('all_in_sync') else '⚠️'} recommendation engine reads the active model's latest forecast: "
                f"{sync.get('all_in_sync')}")
    st.json({k: neutralize(v) for k, v in svc.rec.integration_summary().items()})
    with st.expander("Feature map (what the model uses)"):
        st.dataframe(svc.ml.feature_map(), hide_index=True)
    with st.expander("Improvement experiments"):
        st.dataframe(svc.ml.experiments(), hide_index=True)


{PAGES[0]: page_assistant, PAGES[1]: page_predictions, PAGES[2]: page_recommendations, PAGES[3]: page_whatif,
 PAGES[4]: page_evidence}[ss.page]()
