"""
Integration checks for the KPCL app (run from the project root):

    python -m unittest backend.tests.test_integration -v
"""
from __future__ import annotations

import builtins
import hashlib
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

_opened: list[str] = []
_real_open = builtins.open


def _spy(f, *a, **k):
    _opened.append(str(f))
    return _real_open(f, *a, **k)


builtins.open = _spy                       # record every file opened during the tests

from backend import auth, sim_guard        # noqa: E402
from backend import app_services as svc    # noqa: E402
from backend.server import make_server     # noqa: E402

ENSEMBLE_PKL = ROOT / "assistant/components/model_selection/artifacts/ensemble/ensemble_forecaster.pkl"
ENSEMBLE_SHA256 = "4c68d51ef4efcd7d7078"   # prefix of the shipped artifact's SHA-256
STORED_SIM = ROOT / "assistant/components/model_selection/reports/simulation/pool_forecast_by_month.csv"

ADMIN = ("ADM102", "suresh.kulkarni.admin@kpcl.com", "IT SAM & License Admin")
HEAD_ADMIN = ("ADM101", "prakash.varma.admin@kpcl.com", "Head of IT & Software Assets")
DEPT_HEAD = ("DH202", "harish.kulkarni.depthead@kpcl.com", "Head, Analysis & CAE")
PROJECT_HEAD = ("PH301", "amit.gokhale.projecthead@kpcl.com", "Project Head, Compressor Redesign")
ENGINEER = ("EMP002", "ananya.patel@kpcl.com", "CAE Simulation Specialist")
WORKER = ("EMP003", "vikram.contractor@kpcl.com", "Contract CAD Drafter")


class Api:
    def __init__(self, base):
        self.base, self.token = base, None

    def call(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json",
                                              **({"Authorization": f"Bearer {self.token}"} if self.token else {})})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def login(self, who):
        s, d = self.call("POST", "/api/auth/login", dict(zip(("employee_id", "email", "designation"), who)))
        self.token = d.get("token")
        return s, d


class TestIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = make_server("127.0.0.1", 0)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        svc.services()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    # ---------------- model boundary
    def test_ensemble_artifact_unchanged(self):
        h = hashlib.sha256(ENSEMBLE_PKL.read_bytes()).hexdigest()
        self.assertTrue(h.startswith(ENSEMBLE_SHA256), h)

    def test_ensemble_is_the_only_forecaster(self):
        fc = svc.services().ml.forecaster()
        self.assertEqual(type(fc).__name__, "EnsembleAsForecaster")
        self.assertEqual(fc.meta["backend"], "ensemble")
        self.assertEqual(svc.services().ml.model, "ensemble")

    def test_ensemble_inference_matches_shipped_outputs(self):
        import pandas as pd
        stored = pd.read_csv(STORED_SIM)
        for pf, sw in [("PF001", "SW003"), ("PF010", "SW006"), ("PF040", "SW001")]:
            live = svc.forecast(pf, sw)["monthly"].set_index("month")
            ref = stored[(stored.portfolio_id == pf) & (stored.software_id == sw)].set_index("month")
            for c in ("peak_expected", "peak_p50", "peak_p90"):
                self.assertLess(float((live[c] - ref.loc[live.index, c]).abs().max()), 1e-3, f"{pf}/{sw} {c}")

    def test_simulation_ml_module_excluded(self):
        import licence_ml.simulate as sim
        self.assertTrue(sim_guard.is_active())
        self.assertTrue(getattr(sys.modules["licence_ml.train"], "__kpcl_guard__", False))
        self.assertIs(sim.Forecaster, sim_guard.BlockedForecaster)
        with self.assertRaises(RuntimeError):
            sys.modules["licence_ml.train"].Forecaster.load("anything")
        svc.what_if({"portfolio_id": "PF001", "software_id": "SW003", "temp_licences": 2})
        bad = [p for p in _opened if p.endswith("forecaster.pkl") and "ensemble" not in p]
        self.assertEqual(bad, [], "the simulation component's own model file was opened")
        self.assertFalse(any(p.endswith("licence_ml/train.py") for p in _opened))

    # ---------------- authentication
    def test_employee_match(self):
        a = Api(self.base)
        s, d = a.login(ADMIN)
        self.assertEqual(s, 200)
        self.assertEqual((d["user"]["role"], d["user"]["role_category"]), ("admin", "System Admin"))
        self.assertEqual(a.call("GET", "/api/auth/me")[1]["user"]["employee_id"], "ADM102")

    def test_unknown_employee(self):
        s, d = Api(self.base).login(("EMP999", "nobody@kpcl.com", "Engineer"))
        self.assertEqual((s, d["error"]), (401, "unknown_employee"))

    def test_designation_mismatch(self):
        # an engineer claiming an admin designation is refused; the role never comes from the client
        s, d = Api(self.base).login((ENGINEER[0], ENGINEER[1], "IT SAM & License Admin"))
        self.assertEqual((s, d["error"]), (403, "designation_mismatch"))

    def test_email_mismatch_and_tampered_token(self):
        s, d = Api(self.base).login((ENGINEER[0], ADMIN[1], ENGINEER[2]))
        self.assertEqual((s, d["error"]), (401, "credentials_mismatch"))
        a = Api(self.base)
        a.login(ENGINEER)
        body, sig = a.token.rsplit(".", 1)
        import base64
        payload = json.loads(auth._unb64(body))
        payload["role_category"] = "System Admin"
        a.token = auth._b64(json.dumps(payload).encode()) + "." + sig
        self.assertEqual(a.call("GET", "/api/auth/me")[0], 401)

    def test_permissions_follow_employee_record(self):
        e = Api(self.base)
        e.login(ENGINEER)
        self.assertEqual(e.call("GET", "/api/forecast?portfolio_id=PF001&software_id=SW003")[0], 200)
        self.assertEqual(e.call("POST", "/api/whatif", {"portfolio_id": "PF001", "software_id": "SW003", "licence_change": 2})[0], 403)
        # the chat answers, but does not run the what-if for a profile without the scope
        s, c = e.call("POST", "/api/chat", {"question": "What if we add 2 licences to PF001 ANSYS?"})
        self.assertEqual(s, 200)
        self.assertIsNone(c["whatif"])
        self.assertIn("was not run", c["structured"]["summary"])
        w = Api(self.base)
        w.login(WORKER)
        self.assertEqual(w.call("GET", "/api/recommendation?portfolio_id=PF001&software_id=SW003")[0], 403)
        self.assertEqual(Api(self.base).call("GET", "/api/forecast?portfolio_id=PF001&software_id=SW003")[0], 401)

    # ---------------- four profiles
    def test_four_profiles_from_the_roster(self):
        want = {HEAD_ADMIN: ("admin", "Admin (Head)", "all"), ADMIN: ("admin", "Admin (Head)", "all"),
                DEPT_HEAD: ("deptHead", "Department Head", "department"),
                PROJECT_HEAD: ("projectLead", "Project Head", "project"),
                ENGINEER: ("engineer", "Engineer", "self"), WORKER: ("engineer", "Engineer", "self")}
        for who, (role, label, level) in want.items():
            s, d = Api(self.base).login(who)
            self.assertEqual(s, 200, who)
            u = d["user"]
            self.assertEqual((u["role"], u["profile_label"], u["scope"]["level"]), (role, label, level), who)
        s, d = Api(self.base).login(DEPT_HEAD)
        self.assertEqual((d["user"]["scope"]["app_dept_id"], d["user"]["scope"]["ml_departments"]), ("sim", ["CAE & Simulation"]))
        s, d = Api(self.base).login(PROJECT_HEAD)
        self.assertEqual((d["user"]["scope"]["projects"], d["user"]["scope"]["app_project_ids"]), (["PRJ-KPCL-01"], ["PRJ-X"]))
        self.assertEqual(d["user"]["scope"]["app_user_id"], "u-amit")

    def test_scopes_per_profile(self):
        pool = "portfolio_id=PF001&software_id=SW003"
        expect = {  # recommendation, optimisation, supply what-if, schedule what-if
            HEAD_ADMIN: (200, 200, 200, 200),
            DEPT_HEAD: (200, 403, 200, 200),
            PROJECT_HEAD: (200, 403, 403, 200),
            ENGINEER: (403, 403, 403, 403),
        }
        for who, codes in expect.items():
            a = Api(self.base)
            a.login(who)
            got = (a.call("GET", f"/api/recommendation?{pool}")[0], a.call("GET", "/api/optimisation")[0],
                   a.call("POST", "/api/whatif", {"portfolio_id": "PF001", "software_id": "SW003", "temp_licences": 2})[0],
                   a.call("POST", "/api/whatif", {"portfolio_id": "PF001", "software_id": "SW003",
                                                  "delay_projects": {"P1419": 1}})[0])
            self.assertEqual(got, codes, who)

    def test_costs_hidden_from_project_heads(self):
        a = Api(self.base)
        a.login(PROJECT_HEAD)
        s, r = a.call("GET", "/api/recommendation?portfolio_id=PF001&software_id=SW003")
        self.assertEqual(s, 200)
        self.assertIsNone(r["recommendation"]["estimated_annual_permanent_cost_delta_inr"])
        self.assertFalse(any("added_cost_inr" in o for o in r["options"]))
        s, c = a.call("POST", "/api/chat", {"question": "What should we do about PF001 ANSYS?"})
        self.assertNotIn("₹", json.dumps(c, ensure_ascii=False))
        d = Api(self.base)
        d.login(DEPT_HEAD)
        s, c = d.call("POST", "/api/chat", {"question": "What should we do about PF001 ANSYS?"})
        self.assertIn("₹", c["answer"])

    def test_team_is_scoped(self):
        def team(who):
            a = Api(self.base)
            a.login(who)
            s, t = a.call("GET", "/api/team")
            self.assertEqual(s, 200)
            return t
        everyone = team(HEAD_ADMIN)["members"]
        self.assertEqual(len(everyone), len(auth.roster()))
        dept = team(DEPT_HEAD)
        self.assertTrue(dept["members"])
        self.assertTrue(all(m["department"] == "Analysis & CAE" for m in dept["members"]))
        proj = team(PROJECT_HEAD)
        self.assertTrue(all("PRJ-KPCL-01" in m["projects"] for m in proj["members"]))
        self.assertGreater(len(proj["members"]), 1)
        eng = team(ENGINEER)
        self.assertEqual([m["employee_id"] for m in eng["members"]], ["EMP002"])
        rel = {c["relation"] for c in eng["contacts"]}
        self.assertEqual(rel, {"Department head", "Project head", "Licence administrator"})

    def test_chat_gives_different_answers_to_different_questions(self):
        a = Api(self.base)
        a.login(HEAD_ADMIN)
        qs = ["Why is PF001 ANSYS at risk?", "What options do we have for PF001 ANSYS and what do they cost?",
              "What is the forecast for PF001 ANSYS?", "What should we do about PF001 ANSYS?",
              "What are the next steps for PF001 ANSYS?"]
        out = [a.call("POST", "/api/chat", {"question": q})[1] for q in qs]
        self.assertEqual(len({o["answer"] for o in out}), len(qs))
        self.assertEqual([o["question_type"] for o in out], ["drivers", "options", "forecast", "recommendation", "next_steps"])
        for o in out:
            st = o["structured"]
            self.assertTrue(st["summary"] and st["sections"] and st["next_steps"] and st["follow_ups"])

    def test_demo_accounts_cover_every_profile(self):
        s, d = Api(self.base).call("GET", "/api/auth/demo-accounts")
        self.assertEqual(s, 200)
        self.assertEqual({x["profile_label"] for x in d["accounts"]}, {"Admin (Head)", "Department Head", "Project Head", "Engineer"})
        for x in d["accounts"]:
            self.assertEqual(Api(self.base).login((x["employee_id"], x["email"], x["designation"]))[0], 200)

    # ---------------- business modules + end-to-end through the API
    def test_admin_end_to_end(self):
        a = Api(self.base)
        self.assertEqual(a.login(ADMIN)[0], 200)
        s, pools = a.call("GET", "/api/pools")
        self.assertEqual(s, 200)
        self.assertIn("PF001", pools["portfolios"])
        s, f = a.call("GET", "/api/forecast?portfolio_id=PF001&software_id=SW003")
        self.assertEqual((s, len(f["monthly"])), (200, 6))
        s, r = a.call("GET", "/api/recommendation?portfolio_id=PF001&software_id=SW003")
        self.assertEqual(s, 200)
        self.assertTrue(r["recommendation"]["action"])
        self.assertGreater(len(r["options"]), 0)
        s, o = a.call("GET", "/api/optimisation")
        self.assertEqual(s, 200)
        self.assertGreater(len(o["software"]), 0)
        s, w = a.call("POST", "/api/whatif", {"portfolio_id": "PF001", "software_id": "SW003", "licence_change": 2})
        self.assertEqual(s, 200)
        self.assertTrue(w["valid"])
        self.assertLessEqual(w["summary"]["expected_shortage_licence_months_after"], w["summary"]["expected_shortage_licence_months_before"])
        self.assertTrue(w["engine_recommendation"])
        s, c = a.call("POST", "/api/chat", {"question": "Why is PF001 ANSYS at risk?"})
        self.assertEqual(s, 200)
        self.assertIn("PF001", c["answer"])
        self.assertGreater(len(c["sources"]), 0)
        s, c2 = a.call("POST", "/api/chat", {"question": "What if we add 2 licences to PF001 ANSYS?"})
        self.assertEqual(s, 200)
        self.assertTrue(c2["whatif"] and c2["whatif"]["valid"])

    def test_health(self):
        s, h = Api(self.base).call("GET", "/api/health")
        self.assertEqual(s, 200)
        self.assertTrue(h["ready"] and h["simulation_ml_module_excluded"])


if __name__ == "__main__":
    unittest.main()
