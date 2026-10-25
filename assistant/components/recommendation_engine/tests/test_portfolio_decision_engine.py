from __future__ import annotations
import sys
import unittest
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from portfolio_decision_engine import build_recommendations


class PortfolioDecisionEngineTests(unittest.TestCase):
    def setUp(self):
        self.data = ROOT / "data"

    def test_generates_pool_recommendations_for_member2_pools(self):
        recs, summary, meta = build_recommendations(
            self.data / "member2" / "pool_forecast_by_month.csv",
            self.data / "licence_inventory.csv",
            self.data / "usage_metrics.csv",
            ROOT / "config.json",
            self.data / "assumptions.csv",
        )
        self.assertEqual(len(recs), 573)
        self.assertEqual(recs[["portfolio_id", "software_id"]].drop_duplicates().shape[0], 573)
        self.assertEqual(recs["software_id"].nunique(), 8)
        self.assertIn("reason", recs.columns)
        self.assertIn("data_grain_warning", recs.columns)
        self.assertEqual(meta["risk_tolerance_pct"], 5.0)

    def test_partial_forecast_coverage_blocks_permanent_reduction(self):
        recs, _, meta = build_recommendations(
            self.data / "member2" / "pool_forecast_by_month.csv",
            self.data / "licence_inventory.csv",
            self.data / "usage_metrics.csv",
            ROOT / "config.json",
            self.data / "assumptions.csv",
        )
        row = recs.loc[
            (recs["portfolio_id"] == "PF001") & (recs["software_id"] == "SW001")
        ].iloc[0]
        self.assertEqual(row["months_with_forecast"], 3)
        self.assertEqual(row["expected_forecast_months"], 6)
        self.assertEqual(row["zero_forecast_months"], 3)
        self.assertEqual(row["forecast_coverage_pct"], 50.0)
        self.assertEqual(row["action"], "RETAIN_AND_REVIEW_PARTIAL_FORECAST")
        self.assertNotEqual(row["action"], "CONSIDER_REDUCTION_AT_RENEWAL")
        self.assertEqual(meta["forecast_horizon_month_count"], 6)

    def test_possible_savings_are_not_confirmed(self):
        recs, _, _ = build_recommendations(
            self.data / "member2" / "pool_forecast_by_month.csv",
            self.data / "licence_inventory.csv",
            self.data / "usage_metrics.csv",
            ROOT / "config.json",
            self.data / "assumptions.csv",
        )
        self.assertTrue(recs["approval_status"].eq("PENDING_HUMAN_REVIEW").all())
        self.assertTrue(recs["savings_label"].str.contains("Possible").all())

    def test_summary_does_not_add_pool_financials(self):
        _, summary, _ = build_recommendations(
            self.data / "member2" / "pool_forecast_by_month.csv",
            self.data / "licence_inventory.csv",
            self.data / "usage_metrics.csv",
            ROOT / "config.json",
            self.data / "assumptions.csv",
        )
        self.assertIn("note", summary.columns)
        self.assertTrue(summary["note"].str.contains("not additive").all())


if __name__ == "__main__":
    unittest.main()
