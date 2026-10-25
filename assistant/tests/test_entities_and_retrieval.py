import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unittest

from _shared import services

from rag_chatbot.entities import extract
from rag_chatbot.knowledge_base import split_markdown


class EntityTests(unittest.TestCase):
    def test_ids_and_aliases(self):
        e = extract("Why is pf1 ANSYS short in Nov? Compare with SW007 and project P1254, 2027-02")
        self.assertEqual(e.portfolios, ["PF001"])
        self.assertEqual(e.software, ["SW007", "SW003"])
        self.assertEqual(e.projects, ["P1254"])
        self.assertIn("2026-11", e.months)
        self.assertIn("2027-02", e.months)

    def test_nx_and_may_not_false_positive(self):
        self.assertEqual(extract("Which licences may run out?").months, [])
        self.assertEqual(extract("Siemens NX in portfolio 12").software, ["SW008"])
        self.assertEqual(extract("Siemens NX in portfolio 12").portfolios, ["PF012"])

    def test_markdown_split(self):
        parts = split_markdown("# A\n" + "x" * 100 + "\n## B\n" + "y" * 100)
        self.assertEqual([p[0] for p in parts], ["A", "B"])


class KnowledgeBaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = services()

    def test_documents_cover_every_pool_from_both_components(self):
        types = [d.doc_type for d in self.svc.docs]
        n_pools = self.svc.rec.pool_recommendations().shape[0]
        self.assertEqual(types.count("pool_rec_m3"), n_pools)
        self.assertEqual(types.count("pool_forecast"), n_pools)
        self.assertEqual(types.count("pool_rec_m2"), n_pools)
        self.assertGreaterEqual(types.count("model_accuracy"), 5)

    def test_documents_carry_the_real_numbers(self):
        # values read straight from the component output files
        recs = self.svc.rec.pool_recommendations()
        r = recs[(recs.portfolio_id == "PF001") & (recs.software_id == "SW003")].iloc[0]
        doc = self.svc.retriever.get("m3pool:PF001:SW003")
        self.assertIn(r["action"], doc.text)
        self.assertIn(r["reason"][:60], doc.text)
        m2 = {(x["portfolio_id"], x["software_id"]): x for x in self.svc.ml.sim_recommendations()["recommendations"]}
        self.assertIn(m2[("PF001", "SW003")]["why"][:80], self.svc.retriever.get("m2rec:PF001:SW003").text)
        rep = self.svc.ml.holdout_report()
        self.assertIn(f"{rep['model']['mae']:,.3f}", self.svc.retriever.get("model:accuracy").text)


class RetrievalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.r = services().retriever

    def top(self, q, k=3):
        return [h.doc.id for h in self.r.search(q, k=k)]

    def test_pool_question_hits_that_pool(self):
        ids = self.top("Why is PF001 ANSYS at risk?")
        self.assertEqual(set(ids), {"m3pool:PF001:SW003", "forecast:PF001:SW003", "m2rec:PF001:SW003"})

    def test_accuracy_question(self):
        self.assertIn("model:accuracy", self.top("How accurate is the model?", 4))

    def test_software_accuracy_question(self):
        self.assertEqual(self.top("How reliable is the forecast for ANSYS?", 1), ["model:by_software"])

    def test_assumption_question(self):
        self.assertEqual(self.top("What is the shortage risk tolerance?", 1),
                         ["data:assumption:shortage_risk_tolerance_pct"])

    def test_glossary_question(self):
        self.assertIn("glossary:0", self.top("What does P90 mean?", 4))

    def test_method_question(self):
        ids = self.top("How does the recommendation engine decide on temporary access?", 3)
        self.assertTrue(any(i.startswith("engine_method") for i in ids), ids)


if __name__ == "__main__":
    unittest.main()
