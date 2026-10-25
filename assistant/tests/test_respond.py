"""
Question-specific structured answers (rag_chatbot/respond.py).

The original problem: two different questions about the same pool returned the same answer, because the chat
returned one pre-built pool brief for every pool question. These tests pin the fix:
  * different questions about one pool get different answers, each with the sections that answer that question;
  * yes/no, "how many" and month questions are answered directly in the first sentence;
  * "why?" follow-ups are resolved against the previous answer's type;
  * the answer is tailored to the asker's profile (costs, recommendations, what-ifs, next steps);
  * every recommendation type can be explained, compared and turned into next steps without errors.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import unittest

from _shared import FakeLLM, services

from rag_chatbot.respond import classify
from rag_chatbot.viewer import Viewer

SVC = services()
POOL = "PF001 ANSYS"

ADMIN = Viewer()
DEPT = Viewer(role="deptHead", label="Department Head",
              scopes=frozenset({"forecast", "recommend", "simulate", "simulate_plan", "chat", "costs", "team"}),
              department="Analysis & CAE", ml_departments=("CAE & Simulation",))
PROJ = Viewer(role="projectLead", label="Project Head",
              scopes=frozenset({"forecast", "recommend", "simulate_plan", "chat", "team"}))
ENG = Viewer(role="engineer", label="Engineer", scopes=frozenset({"forecast", "chat"}))
MONEY = re.compile(r"₹|\bINR\s?\d")


def ask(q, viewer=ADMIN, history=None, engine=None):
    return (engine or SVC.engine).answer(q, history or [], None, viewer=viewer)


class DistinctAnswers(unittest.TestCase):
    QUESTIONS = {
        f"Why is {POOL} at risk?": ("drivers", ["What pushes demand up in", "Projects active in"]),
        f"What is the forecast for {POOL}?": ("forecast", ["Forecast by month", "Trend and peak", "How reliable this is"]),
        f"What should we do about {POOL}?": ("recommendation", ["Recommendation", "Why this recommendation",
                                                                 "Approval route"]),
        f"Why does the engine recommend this for {POOL}?": ("rec_why", ["Decision path",
                                                                         "What would change the recommendation"]),
        f"What options do we have for {POOL} and what do they cost?": ("options", ["Options compared", "Trade-offs"]),
        f"What are the next steps for {POOL}?": ("next_steps", ["Action plan", "Before committing money"]),
        f"When is the ANSYS renewal deadline for PF001?": ("renewal", ["Contract timeline"]),
        f"What if we add 2 licences to {POOL}?": ("whatif", ["Scenario result", "Month by month"]),
        f"Tell me about {POOL}": ("overview", ["Forecast by month"]),
    }

    @classmethod
    def setUpClass(cls):
        cls.res = {q: ask(q) for q in cls.QUESTIONS}

    def test_every_question_gets_its_own_answer(self):
        answers = [r.answer for r in self.res.values()]
        summaries = [r.structured["summary"] for r in self.res.values()]
        self.assertEqual(len(set(answers)), len(answers), "two questions returned the same answer")
        self.assertEqual(len(set(summaries)), len(summaries), "two questions returned the same summary")

    def test_question_types_and_sections(self):
        for q, (qtype, secs) in self.QUESTIONS.items():
            r = self.res[q]
            self.assertEqual(r.question_type, qtype, q)
            titles = [s["title"] for s in r.structured["sections"]]
            for want in secs:
                self.assertTrue(any(t.startswith(want) for t in titles), f"{q}: missing section {want!r} in {titles}")
            self.assertTrue(r.structured["next_steps"], q)
            self.assertTrue(r.structured["sources"], q)
            self.assertIn("### Summary", r.answer)
            json.dumps(r.structured)                      # the API sends it as JSON

    def test_answers_use_the_three_systems(self):
        rec = SVC.rec.pool_recommendations()
        row = rec[(rec.portfolio_id == "PF001") & (rec.software_id == "SW003")].iloc[0]
        pfc = SVC.ml.pool_forecast()
        peak = pfc[(pfc.portfolio_id == "PF001") & (pfc.software_id == "SW003")]["peak_p90"].max()
        why = self.res[f"Why is {POOL} at risk?"].answer
        self.assertIn(f"**{peak:.0f}** licences", why)                        # ML forecast
        self.assertIn("Planned workload on the pool", why)                   # live model explanation
        rw = self.res[f"Why does the engine recommend this for {POOL}?"].answer
        self.assertIn(f"{row['max_forecast_shortage_probability_pct']:.1f}%", rw)   # recommendation engine
        opt = self.res[f"What options do we have for {POOL} and what do they cost?"].answer
        self.assertIn("Temporary licences", opt)                             # simulation options

    def test_follow_up_questions_lead_somewhere_new(self):
        for q, (qtype, _) in self.QUESTIONS.items():
            for f in self.res[q].structured["follow_ups"]:
                r = ask(f)
                self.assertNotEqual(r.answer, self.res[q].answer, f"follow-up {f!r} repeated the answer to {q!r}")


class DirectAnswers(unittest.TestCase):
    def test_yes_no_about_an_action(self):
        r = ask(f"Should we use temporary licences for {POOL}?")       # engine: permanent increase (Critical)
        self.assertTrue(r.structured["summary"].startswith("**No"), r.structured["summary"])
        rec = SVC.rec.pool_recommendations()
        t = rec[rec.action == "INVESTIGATE_TEMPORARY_ACCESS"].iloc[0]
        name = SVC.ml.lookup().set_index("software_id").loc[t.software_id, "software_name"]
        r = ask(f"Should we use temporary licences for {t.portfolio_id} {name}?")
        self.assertTrue(r.structured["summary"].startswith("**Yes"), r.structured["summary"])

    def test_how_many_in_a_month(self):
        pfc = SVC.ml.pool_forecast()
        need = int(pfc[(pfc.portfolio_id == "PF001") & (pfc.software_id == "SW003") & (pfc.month == "2026-12")]
                   ["licences_needed"].iat[0])
        r = ask(f"How many licences do we need for {POOL} in December?")
        self.assertTrue(r.structured["summary"].startswith(f"**{need} licences**"), r.structured["summary"])

    def test_bare_why_follows_the_previous_answer(self):
        r1 = ask(f"What should we do about {POOL}?")
        hist = [{"role": "user", "content": "q", "meta": {}},
                {"role": "assistant", "content": r1.answer, "meta": {"entities": r1.entities.to_dict(),
                                                                     "qtype": r1.question_type}}]
        self.assertEqual(ask("Why?", history=hist).question_type, "rec_why")
        r2 = ask(f"What is the forecast for {POOL}?")
        hist[1]["meta"] = {"entities": r2.entities.to_dict(), "qtype": r2.question_type}
        self.assertEqual(ask("why?", history=hist).question_type, "drivers")

    def test_general_questions_are_composed_not_dumped(self):
        cases = {"How accurate is the ML model?": "accuracy", "How does the engine decide?": "method",
                 "What does P90 mean?": "glossary", "Which pools are riskiest for ANSYS?": "ranking",
                 "Tell me about PF002": "portfolio", "Tell me about MATLAB": "software"}
        for q, t in cases.items():
            r = ask(q)
            self.assertEqual(r.question_type, t, q)
            self.assertNotIn("Run (Windows PowerShell)", r.answer, q)          # no raw README dumps
        acc = ask("How accurate is the ML model?").answer
        mae = SVC.ml.holdout_report()["model"]["mae"]
        self.assertIn(f"{mae:.2f} licences", acc)

    def test_classifier_does_not_confuse_close_questions(self):
        pool = ("PF001", "SW003")
        c = lambda q: classify(q, pool, True, True, False).qtype   # noqa: E731
        self.assertEqual(c("Why is PF001 ANSYS forecast this way? Explain the drivers simply."), "drivers")
        self.assertEqual(c("Why is PF001 ANSYS at risk?"), "drivers")
        self.assertEqual(c("Why should we buy more ANSYS licences for PF001?"), "rec_why")
        self.assertEqual(c("What should we do about PF001 ANSYS and why?"), "recommendation")
        self.assertEqual(c("What would it cost to use temporary licences for PF001 ANSYS?"), "options")
        self.assertEqual(c("How do we proceed with PF001 ANSYS?"), "next_steps")
        self.assertEqual(c("Will we run short of PF001 ANSYS in December?"), "forecast")


class ProfileTailoring(unittest.TestCase):
    def test_costs_are_hidden_from_profiles_without_the_costs_scope(self):
        for v in (PROJ, ENG):
            for q in (f"What should we do about {POOL}?", f"What options do we have for {POOL}?",
                      f"Why does the engine recommend this for {POOL}?", f"What are the next steps for {POOL}?",
                      "Which pools are candidates for reduction at renewal?"):
                r = ask(q, v)
                self.assertIsNone(MONEY.search(r.answer), f"{v.label}: {q}")
                self.assertIsNone(MONEY.search(json.dumps(r.structured, ensure_ascii=False)), f"{v.label}: {q}")
                for b in r.blocks:
                    self.assertIsNone(MONEY.search(b.text), f"{v.label}: {q}: block {b.title}")
        self.assertIsNotNone(MONEY.search(ask(f"What should we do about {POOL}?", DEPT).answer))

    def test_engineers_get_availability_not_the_purchase_decision(self):
        r = ask(f"What should we do about {POOL}?", ENG)
        self.assertEqual(r.question_type, "availability")
        self.assertNotIn("Why this recommendation", r.answer)
        self.assertIn("What this means for you", r.answer)
        self.assertFalse(any(b.kind == "brief" for b in r.blocks))
        self.assertTrue(all(s["owner"] in ("You", "Department head") for s in r.structured["next_steps"]))

    def test_next_steps_differ_by_profile(self):
        q = f"What are the next steps for {POOL}?"
        owners = {v.role: {s["owner"] for s in ask(q, v).structured["next_steps"]} for v in (ADMIN, DEPT, PROJ)}
        self.assertIn("Licence administrator", owners["admin"])
        self.assertIn("Department head", owners["deptHead"])
        self.assertIn("Project head", owners["projectLead"])
        texts = {v.role: ask(q, v).structured["next_steps"][0]["text"] for v in (ADMIN, DEPT, PROJ)}
        self.assertEqual(len(set(texts.values())), 3)

    def test_department_heads_see_their_department_projects_marked(self):
        r = ask(f"Why is {POOL} at risk?", DEPT)
        self.assertIn("your department", r.answer)

    def test_what_if_permissions(self):
        r = ask(f"What if we add 2 licences to {POOL}?", PROJ)
        self.assertIsNone(r.whatif)
        self.assertEqual(r.structured["question_type"], "whatif_blocked")
        self.assertIn("was not run", r.structured["summary"])
        ns = SVC.engine._not_started(r.entities)
        r = ask(f"What if we delay {ns[0]} by 1 month in {POOL}?", PROJ)       # schedule what-ifs are allowed
        self.assertTrue(r.whatif and r.whatif["valid"])
        r = ask(f"What if we delay {ns[0]} by 1 month in {POOL}?", ENG)        # engineers run none
        self.assertIsNone(r.whatif)

    def test_follow_ups_respect_the_profile(self):
        for f in ask(f"Why is {POOL} at risk?", ENG).structured["follow_ups"]:
            self.assertNotRegex(f, r"(?i)what if|should we do|options")
        for f in ask(f"Why is {POOL} at risk?", PROJ).structured["follow_ups"]:
            self.assertNotRegex(f, r"(?i)temporary licences to")


class EveryActionType(unittest.TestCase):
    def test_each_engine_action_can_be_explained_compared_and_planned(self):
        pr = SVC.rec.pool_recommendations()
        lk = SVC.ml.lookup().set_index("software_id")["software_name"]
        for action, g in pr.groupby("action"):
            r = g.iloc[0]
            pool = f"{r.portfolio_id} {lk[r.software_id]}"
            for q in (f"What should we do about {pool}?", f"Why does the engine recommend this for {pool}?",
                      f"What options do we have for {pool}?", f"What are the next steps for {pool}?",
                      f"Why is {pool} at risk?"):
                res = ask(q)
                self.assertEqual(tuple(res.structured["pool"]), (r.portfolio_id, r.software_id), q)
                self.assertGreater(len(res.structured["sections"]), 0, q)
                self.assertNotIn("n/a licences", res.answer, q)


class LLMPrompt(unittest.TestCase):
    def test_llm_gets_question_type_profile_and_a_question_specific_draft(self):
        llm = FakeLLM()
        eng = services(llm)
        ask(f"Why is {POOL} at risk?", DEPT, engine=eng)
        p1 = llm.calls[-1]["messages"][-1].content
        ask(f"What options do we have for {POOL}?", DEPT, engine=eng)
        p2 = llm.calls[-1]["messages"][-1].content
        self.assertIn("QUESTION TYPE: drivers", p1)
        self.assertIn("QUESTION TYPE: options", p2)
        self.assertIn("ASKER: Department Head", p1)
        self.assertIn("STRUCTURED DRAFT", p1)
        self.assertIn("### What pushes demand up in", p1)
        self.assertIn("### Options compared", p2)
        self.assertNotEqual(p1, p2)
        self.assertIn("answer what was asked", llm.calls[-1]["system"])

    def test_llm_answer_is_redacted_for_profiles_without_costs(self):
        eng = services(FakeLLM("It costs ₹12.80 lakh [S1]."))
        self.assertNotIn("₹", ask(f"What should we do about {POOL}?", PROJ, engine=eng).answer)


if __name__ == "__main__":
    unittest.main()
