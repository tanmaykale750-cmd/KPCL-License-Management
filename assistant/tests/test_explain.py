"""Recommendation explanations, structured answers and neutral wording."""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import unittest

from _shared import FakeLLM, services

from rag_chatbot.explain import decision_trace

SVC = services()
MEMBER = re.compile(r"\bmember\s*[123]\b", re.I)
SECTIONS = ["### Summary", "### Forecast", "### Recommendation", "**Why this recommendation**", "### Risks and caveats",
            "### Next steps"]


class DecisionTraceTests(unittest.TestCase):
    def test_replay_matches_engine_action_for_every_pool(self):
        rec = SVC.rec
        cfg = rec.pde.load_settings(rec.config_path, rec.data_dir / "assumptions.csv")
        cost = rec.inventory().set_index("software_id")["annual_cost_per_license_inr"]
        pr = rec.pool_recommendations()
        bad = [(r["portfolio_id"], r["software_id"], r["action"]) for r in pr.to_dict("records")
               if decision_trace(r, cfg, float(cost[r["software_id"]])).action != r["action"]]
        self.assertEqual(bad, [], f"{len(bad)} of {len(pr)} explanations disagree with the engine")

    def test_every_action_type_has_a_brief_with_all_sections(self):
        pr = SVC.rec.pool_recommendations()
        for action, g in pr.groupby("action"):
            r = g.iloc[0]
            b = SVC.engine.brief(r["portfolio_id"], r["software_id"])
            self.assertEqual(b["action"], action)
            for sec in SECTIONS:
                self.assertIn(sec, b["markdown"], f"{action}: missing {sec}")
            self.assertGreaterEqual(len(b["trace"].steps), 2)
            self.assertIsNone(MEMBER.search(b["markdown"]))

    def test_brief_numbers_come_from_the_outputs(self):
        pr = SVC.rec.pool_recommendations()
        r = pr[(pr.portfolio_id == "PF001") & (pr.software_id == "SW003")].iloc[0]
        md = SVC.engine.brief("PF001", "SW003")["markdown"]
        self.assertIn(f"{r['max_forecast_shortage_probability_pct']:.1f}%", md)
        self.assertIn(f"needs {int(r['modelled_licences_needed_max'])} licences", md)


class StructuredAnswerTests(unittest.TestCase):
    QUESTIONS = ["Why is PF001 ANSYS recommended this action?", "What if we add 2 licences to PF001 ANSYS?",
                 "Which pools are riskiest for MATLAB?", "How accurate is the model?", "How does the engine decide?"]

    def test_no_llm_answers_are_structured_and_neutral(self):
        for q in self.QUESTIONS:
            res = SVC.engine.answer(q, [])
            self.assertIn("### ", res.answer, q)
            self.assertIsNone(MEMBER.search(res.answer), q)
            for b in res.blocks:
                self.assertIsNone(MEMBER.search(b.title + b.text), f"{q}: {b.title}")
            for n in res.notes:
                self.assertIsNone(MEMBER.search(n), n)
        # a "why this recommendation" question gets the decision path, the evidence and what would change it
        res = SVC.engine.answer(self.QUESTIONS[0], [])
        self.assertEqual(res.question_type, "rec_why")
        for sec in ["### Summary", "### Decision path", "### Evidence used", "### What would change the recommendation",
                    "### Next steps", "### Risks and caveats"]:
            self.assertIn(sec, res.answer)
        # "what should we do" keeps the full recommendation explanation
        res = SVC.engine.answer("What should we do about PF001 ANSYS?", [])
        for sec in ["### Summary", "### Recommendation", "### Why this recommendation", "### Next steps",
                    "### Risks and caveats"]:
            self.assertIn(sec, res.answer)

    def test_llm_gets_explanation_template_and_no_member_names(self):
        llm = FakeLLM()
        SVC_llm = services(llm)
        res = SVC_llm.answer("What should we do about PF001 ANSYS and why?", [])
        prompt = llm.calls[-1]["messages"][-1].content
        system = llm.calls[-1]["system"]
        self.assertIn("RECOMMENDATION EXPLANATION", prompt)
        self.assertIn("Why this recommendation", prompt)
        self.assertEqual(res.blocks[0].kind, "brief")
        for h in ("### Summary", "### Forecast", "### Recommendation", "### Next steps"):
            self.assertIn(h, system)
        self.assertIsNone(MEMBER.search(prompt))

    def test_llm_output_is_neutralised(self):
        res = services(FakeLLM("Member 2's model says so; Member 3 agrees.")).answer("PF001 ANSYS?", [])
        self.assertIsNone(MEMBER.search(res.answer))


if __name__ == "__main__":
    unittest.main()
