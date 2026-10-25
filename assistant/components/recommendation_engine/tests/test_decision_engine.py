import json
import tempfile
import unittest
from pathlib import Path
import sys
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from decision_engine import _candidate_metrics, load_forecast, run_engine  # noqa: E402


class DecisionEngineTests(unittest.TestCase):
    def test_candidate_metrics_calculates_shortage(self):
        demand = pd.Series([2, 4, 6, 8])
        cfg = {
            "target_shortage_risk_pct": 30,
            "shortage_cost_per_shortfall_licence_day_inr": 100,
            "annual_working_days": 252,
        }
        result = _candidate_metrics(demand, 5, 8, 1000, cfg, 4)
        self.assertEqual(result["days_with_shortage"], 2)
        self.assertEqual(result["shortfall_licence_days_observed"], 4)
        self.assertEqual(result["shortage_risk_pct"], 50.0)
        self.assertGreater(result["estimated_annual_total_cost_inr"], result["annual_licence_cost_inr"])

    def test_engine_creates_all_outputs(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "output"
            outputs = run_engine(ROOT / "data", out, ROOT / "config.json")
            for path in outputs.values():
                self.assertTrue(path.exists(), f"Missing output: {path}")
            recs = pd.read_csv(outputs["recommendations"])
            self.assertEqual(len(recs), 8)
            self.assertTrue(recs["human_approval_required"].all())
            self.assertTrue((recs["savings_status"] == "Possible").all())

    def test_forecast_schema_is_accepted(self):
        sample = pd.DataFrame({
            "software_id": ["SW001", "SW001"],
            "forecast_date": ["2026-10-01", "2026-10-02"],
            "predicted_demand": [4, 6],
        })
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "forecast.csv"
            sample.to_csv(path, index=False)
            inventory = pd.read_csv(ROOT / "data" / "licence_inventory.csv")
            loaded = load_forecast(path, inventory)
            self.assertEqual(len(loaded), 2)
            self.assertEqual(loaded["is_working_day"].tolist(), [1, 1])


if __name__ == "__main__":
    unittest.main()
