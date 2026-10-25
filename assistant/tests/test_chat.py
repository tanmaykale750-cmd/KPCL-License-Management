"""Chat orchestration: grounding, follow-ups, what-if parsing, fallbacks (LLM replaced by a recording fake)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import unittest

from _shared import FakeLLM, services

from rag_chatbot.chat import parse_whatif
from rag_chatbot.entities import extract
from rag_chatbot.llm import LLMError


def turn(role, content, ents=None):
    return {"role": role, "content": content, "meta": {"entities": ents} if ents else {}}


class WhatIfParsingTests(unittest.TestCase):
    def p(self, q):
        return parse_whatif(q, extract(q))

    def test_licences(self):
        r = self.p("What if we add 2 licences to PF001 ANSYS?")
        self.assertEqual((r.licence_change, r.temp_licences), (2, 0))
        r = self.p("PF001 SW003 with 3 temporary licences")
        self.assertEqual((r.licence_change, r.temp_licences), (0, 3))
        r = self.p("remove 4 licences from PF002 AutoCAD")
        self.assertEqual(r.licence_change, -4)

    def test_projects(self):
        r = self.p("PF001 SW003: delay P1254 by 2 months and cancel P0817")
        self.assertEqual(r.delay_projects, {"P1254": 2})
        self.assertEqual(r.cancel_projects, ["P0817"])
        r = self.p("PF001 ANSYS what if the team size of P1254 is 20")
        self.assertEqual(r.team_size, {"P1254": 20})

    def test_no_pool_or_no_change(self):
        self.assertIsNone(self.p("What if we add 2 licences?"))          # no pool named
        self.assertIsNone(self.p("Tell me about PF001 ANSYS"))           # no scenario


class ChatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc = services()

    def test_prompt_is_grounded_in_real_outputs(self):
        llm = FakeLLM()
        eng = services(llm)
        res = eng.answer("What should we do about PF001 ANSYS?", [])
        self.assertEqual(res.llm_used, "fake-llm")
        prompt = llm.calls[-1]["messages"][-1].content
        rec = self.svc.rec.pool_recommendations()
        row = rec[(rec.portfolio_id == "PF001") & (rec.software_id == "SW003")].iloc[0]
        self.assertIn(row["action"], prompt)                     # recommendation engine output
        self.assertIn("RECOMMENDATION EXPLANATION", prompt)
        self.assertIn("Why this recommendation", prompt)
        self.assertIn("[S1]", prompt)
        self.assertIn("Never invent numbers", llm.calls[-1]["system"])

    def test_followup_inherits_pool_and_history_is_sent(self):
        llm = FakeLLM()
        eng = services(llm)
        r1 = eng.answer("What is the forecast for PF001 ANSYS?", [])
        hist = [turn("user", "What is the forecast for PF001 ANSYS?", r1.entities.to_dict()),
                turn("assistant", "It is at risk in Nov and Dec.", r1.entities.to_dict())]
        r2 = eng.answer("Why?", hist)
        self.assertEqual(r2.entities.pool(), ("PF001", "SW003"))
        roles = [m.role for m in llm.calls[-1]["messages"]]
        self.assertEqual(roles, ["user", "assistant", "user"])
        self.assertIn("It is at risk in Nov and Dec.", llm.calls[-1]["messages"][1].content)
        # follow-up switching software keeps the portfolio
        r3 = eng.answer("What about MATLAB?", hist)
        self.assertEqual(r3.entities.pool(), ("PF001", "SW007"))
        # a fresh cross-pool question does not inherit the pool
        r4 = eng.answer("Which pools are riskiest for SOLIDWORKS?", hist)
        self.assertEqual(r4.entities.portfolios, [])
        self.assertTrue(any(b.kind == "analytics" for b in r4.blocks))

    def test_focus_pool_used_only_when_question_names_none(self):
        eng = services(FakeLLM())
        self.assertEqual(eng.answer("Should we buy more licences?", [], focus=("PF002", "SW004")).entities.pool(),
                         ("PF002", "SW004"))
        self.assertEqual(eng.answer("How accurate is the model?", [], focus=("PF002", "SW004")).entities.pool(), None)

    def test_analytics_counts_are_exact(self):
        res = services().engine.answer("How many ANSYS pools need a permanent increase?", [])
        rec = self.svc.rec.pool_recommendations()
        n = int(((rec.software_id == "SW003") & (rec.action == "CONSIDER_PERMANENT_INCREASE")).sum())
        txt = "\n".join(b.text for b in res.blocks if b.kind == "analytics")
        self.assertIn(f"CONSIDER_PERMANENT_INCREASE {n}", txt)

    def test_no_llm_mode_returns_grounded_facts(self):
        res = services().engine.answer("Why is PF001 ANSYS at risk?", [])
        self.assertIsNone(res.llm_used)
        self.assertIn("no AI summary", res.answer)
        self.assertIn("PF001 · ANSYS Mechanical (SW003)", res.answer)
        self.assertTrue(any("No LLM configured" in n for n in res.notes))

    def test_llm_failure_falls_back(self):
        class Broken(FakeLLM):
            def generate(self, *a, **k):
                raise LLMError("quota exceeded")
        res = services(Broken()).answer("PF001 ANSYS recommendation", [])
        self.assertIn("no AI summary", res.answer)
        self.assertTrue(any("quota exceeded" in n for n in res.notes))

    def test_unknown_pool_is_reported_not_invented(self):
        res = services(FakeLLM()).answer("What is the forecast for PF999 ANSYS?", [])
        self.assertTrue(any("No saved forecast" in n for n in res.notes))


if __name__ == "__main__":
    unittest.main()
