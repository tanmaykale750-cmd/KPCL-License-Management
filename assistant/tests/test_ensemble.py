"""The selected ensemble model is the one the chatbot actually uses, end to end."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import unittest

import numpy as np
import pandas as pd
from _shared import services

from rag_chatbot.config import ENSEMBLE_DIR, FORECAST_DIR, load_settings
from rag_chatbot.integration import ensemble_adapter

SVC = services()
ENS = SVC.ml.model == "ensemble"


@unittest.skipUnless(ENS, "FORECAST_MODEL is not 'ensemble'")
class EnsembleIntegrationTests(unittest.TestCase):
    def test_shared_modules_are_identical(self):
        self.assertEqual(ensemble_adapter.check_shared_modules(FORECAST_DIR, ENSEMBLE_DIR), [])

    def test_selected_model_is_lowest_cv_mae(self):
        lb = pd.read_csv(ENSEMBLE_DIR / "reports" / "ensemble" / "leaderboard.csv")
        rep = SVC.ml.ensemble_report()
        self.assertEqual(lb.sort_values("cv_mae").iloc[0]["model"], rep["model"]["selected"])
        self.assertEqual(SVC.ml.forecaster().meta["selected"], rep["model"]["selected"])

    def test_no_training_label_after_as_of(self):
        r = SVC.ml.ensemble_report()["model"]
        self.assertLessEqual(pd.Timestamp(r["training_label_months"][1]), pd.Timestamp(r["as_of"]))

    def test_adapter_matches_the_ensembles_own_prediction(self):
        fc = SVC.ml.forecaster()
        rows = SVC.ml.dataset().sample(300, random_state=0)
        own = fc.ens.predict(rows)
        mine = fc.predict(rows)
        for c in ("peak_p10", "peak_p50", "peak_p90"):
            np.testing.assert_allclose(mine[c].to_numpy(), own[c].to_numpy(), atol=1e-9)

    def test_explanation_adds_up(self):
        fc = SVC.ml.forecaster()
        rows = SVC.ml.dataset().sample(50, random_state=1)
        ex = fc.explain(rows)
        from licence_ml.features import FEATURE_GROUPS
        np.testing.assert_allclose(ex["typical"] + ex[list(FEATURE_GROUPS)].sum(axis=1), ex["peak_expected"], atol=1e-6)

    def test_pipeline_uses_ensemble_forecast(self):
        saved = pd.read_csv(SVC.ml.sim_dir / "pool_forecast_by_month.csv")
        self.assertTrue(str(SVC.ml.sim_dir).startswith(str(ENSEMBLE_DIR)))
        live = SVC.ml.live_pool_forecast("PF001", "SW003").reset_index(drop=True)
        s = saved[(saved.portfolio_id == "PF001") & (saved.software_id == "SW003")].sort_values("month").reset_index(drop=True)
        np.testing.assert_allclose(live["peak_p90"], s["peak_p90"], atol=1e-3)
        self.assertTrue(SVC.rec.handoff_in_sync()["all_in_sync"])

    def test_chatbot_knows_which_model_is_used(self):
        hits = [h.doc.id for h in SVC.retriever.search("Which model is used for the forecast and why?", k=4)]
        self.assertIn("model:comparison", hits)
        self.assertIn(SVC.ml.ensemble_report()["model"]["selected_label"], SVC.retriever.get("model:comparison").text)


class SingleModelFallbackTests(unittest.TestCase):
    def test_single_model_mode_still_loads(self):
        from rag_chatbot.integration.ml_adapter import MLService
        ml = MLService(FORECAST_DIR, "single", ENSEMBLE_DIR)
        if not ml.model_available():
            self.skipTest(ml.model_status()["error"])
        self.assertEqual(ml.forecaster().meta["backend"], "sklearn")
        self.assertFalse(ml.live_pool_forecast("PF001", "SW003").empty)


if __name__ == "__main__":
    unittest.main()
