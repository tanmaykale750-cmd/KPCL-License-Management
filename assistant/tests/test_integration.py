"""
Integration with the REAL components:
  * the trained forecasting component model + simulation, run live, must reproduce the forecasting component's saved simulation output
  * the recommendation engine, fed the forecasting component's output, must reproduce the recommendation engine's saved recommendations
  * what-ifs run end to end through both components
Model tests are skipped (with the reason) if the trained model cannot be loaded on this machine.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import unittest

import numpy as np
import pandas as pd
from _shared import services

from rag_chatbot.chat import parse_whatif
from rag_chatbot.entities import extract
from rag_chatbot.integration.ml_adapter import WhatIfRequest

SVC = services()
MODEL_OK = SVC.ml.model_available()
WHY = SVC.ml.model_status().get("error") or ""


class EngineIntegrationTests(unittest.TestCase):
    def test_handoff_files_match(self):
        self.assertTrue(SVC.rec.handoff_in_sync()["all_in_sync"])

    def test_engine_reproduces_saved_recommendations_from_forecast_output(self):
        pde = SVC.rec.pde
        d = SVC.rec.data_dir
        recs, _, meta = pde.build_recommendations(SVC.ml.sim_dir / "pool_forecast_by_month.csv",
                                                  d / "licence_inventory.csv", d / "usage_metrics.csv",
                                                  SVC.rec.config_path, d / "assumptions.csv")
        saved = SVC.rec.pool_recommendations()
        self.assertEqual(len(recs), len(saved))
        a = recs.set_index(["portfolio_id", "software_id"])["action"].sort_index()
        b = saved.set_index(["portfolio_id", "software_id"])["action"].sort_index()
        self.assertTrue((a == b).all())

    def test_evaluate_forecast_single_pool(self):
        pf = SVC.ml.pool_forecast()
        g = pf[(pf.portfolio_id == "PF001") & (pf.software_id == "SW003")]
        out = SVC.rec.evaluate_forecast(g)
        saved = SVC.rec.pool_recommendations()
        s = saved[(saved.portfolio_id == "PF001") & (saved.software_id == "SW003")].iloc[0]
        self.assertEqual(out.iloc[0]["action"], s["action"])


@unittest.skipUnless(MODEL_OK, f"trained model not loadable here: {WHY}")
class ModelIntegrationTests(unittest.TestCase):
    def test_live_simulation_matches_saved_output(self):
        saved = SVC.ml.pool_forecast()
        for pf, sw in [("PF001", "SW003"), ("PF073", "SW006"), ("PF010", "SW005")]:
            live = SVC.ml.live_pool_forecast(pf, sw).reset_index(drop=True)
            s = saved[(saved.portfolio_id == pf) & (saved.software_id == sw)].sort_values("month").reset_index(drop=True)
            for c in ["peak_p50", "peak_p90", "shortage_probability", "licences_needed", "expected_shortage"]:
                np.testing.assert_allclose(live[c].to_numpy(float), s[c].to_numpy(float), atol=1e-3,
                                           err_msg=f"{pf}/{sw} {c}")

    def test_explanation_contributions_add_up(self):
        ex = SVC.ml.explain_pool("PF001", "SW003")
        self.assertTrue(ex["months"])
        for m in ex["months"]:
            total = m["typical_baseline"] + sum(m["drivers"].values())
            self.assertAlmostEqual(total, m["peak_expected_mean"], delta=0.05)

    def test_adding_licences_cannot_increase_risk(self):
        res = SVC.ml.what_if(WhatIfRequest("PF001", "SW003", licence_change=3))
        self.assertTrue(res["valid"])
        s = res["summary"]
        self.assertLessEqual(s["months_at_risk_after"], s["months_at_risk_before"])
        self.assertLessEqual(s["max_shortage_probability_after"], s["max_shortage_probability_before"])
        # supply change must not change predicted demand
        c = res["comparison"]
        np.testing.assert_allclose(c["peak_p50_before"], c["peak_p50_after"])

    def test_delaying_a_running_project_is_rejected(self):
        rows = SVC.ml.pool_projects("PF001", "SW003")
        running = rows[~rows["not_started"]]["project_id"].tolist()
        self.assertTrue(running)
        res = SVC.ml.what_if(WhatIfRequest("PF001", "SW003", delay_projects={running[0]: 1}))
        self.assertFalse(res["valid"])
        self.assertTrue(any("only projects not yet started" in e for e in res["errors"]))

    def test_plan_change_reruns_the_model(self):
        rows = SVC.ml.pool_projects("PF073", "SW006")
        ns = rows[rows["not_started"]]["project_id"].tolist()
        if not ns:
            self.skipTest("no not-started project in PF073/SW006")
        res = SVC.ml.what_if(WhatIfRequest("PF073", "SW006", cancel_projects=[ns[0]]))
        self.assertTrue(res["valid"])
        c = res["comparison"]
        self.assertLessEqual(c["peak_p50_after"].sum(), c["peak_p50_before"].sum())

    def test_chat_whatif_end_to_end(self):
        q = "What if we add 2 licences to PF001 ANSYS?"
        self.assertIsNotNone(parse_whatif(q, extract(q)))
        res = SVC.engine.answer(q, [])
        live = [b for b in res.blocks if b.kind == "live_model"]
        self.assertTrue(live and "**Verdict:**" in live[0].text and "Recommendation engine on the scenario" in live[0].text)

    def test_options_live_match_saved(self):
        live = SVC.ml.options("PF001", "SW003")
        saved = {(r["portfolio_id"], r["software_id"]): r for r in SVC.ml.sim_recommendations()["recommendations"]}
        s = pd.DataFrame(saved[("PF001", "SW003")]["options"])
        self.assertEqual(live["option"].tolist(), s["option"].tolist())
        np.testing.assert_allclose(live["total_cost_inr"], s["total_cost_inr"], rtol=1e-6)


if __name__ == "__main__":
    unittest.main()
