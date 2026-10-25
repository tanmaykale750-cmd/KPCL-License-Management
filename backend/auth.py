"""
Sign-in against the authoritative employee dataset (backend/data/employees.xlsx, sheet User_Admin_Roster).

The user enters Employee ID, work email and designation. The server looks the employee up, checks the email and the
designation against the record, and takes the PROFILE from the record's Role_Category, never from the client.
Every API call re-validates the signed session against the roster, so a changed record takes effect immediately.

Four profiles (backend/data/org_scope.json maps Role_Category -> profile):

  admin        Admin (Head)       System Admin                     everything
  deptHead     Department Head    Department Head                  their department's access, seats and approvals
  projectLead  Project Head       Project Head                     their projects' timelines, demand and team access
  engineer     Engineer           Staff Engineer, Project Worker   their assigned licences and own requests

Each signed-in user also gets a data SCOPE (department, projects, tools) resolved through org_scope.json, which the
API uses to filter what it returns and which the frontend uses to scope its views.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from pathlib import Path

DATA = Path(__file__).parent / "data"
ROSTER_FILE = Path(os.environ.get("KPCL_EMPLOYEE_FILE", DATA / "employees.xlsx"))
ORG_FILE = Path(os.environ.get("KPCL_ORG_FILE", DATA / "org_scope.json"))
ROSTER_SHEET = "User_Admin_Roster"
SESSION_SECONDS = int(os.environ.get("KPCL_SESSION_SECONDS", 8 * 3600))
_SECRET = os.environ.get("KPCL_AUTH_SECRET", "").encode() or secrets.token_bytes(32)

# What each profile may do through the API.
#   forecast       ensemble pool forecast and its explanation
#   recommend      recommendation engine decision for a pool
#   optimise       company-wide software cost-risk optimiser
#   simulate       licence-supply what-ifs (add / remove / temporary licences)
#   simulate_plan  schedule what-ifs (delay / cancel a project, change a team size)
#   chat           the RAG assistant
#   costs          rupee amounts in responses (otherwise redacted)
#   team           people in the user's scope (roster)
SCOPES = {
    "admin": {"forecast", "recommend", "optimise", "simulate", "simulate_plan", "chat", "costs", "team"},
    "deptHead": {"forecast", "recommend", "simulate", "simulate_plan", "chat", "costs", "team"},
    "projectLead": {"forecast", "recommend", "simulate_plan", "chat", "team"},
    "engineer": {"forecast", "chat"},
}
SCOPE_LEVEL = {"admin": "all", "deptHead": "department", "projectLead": "project", "engineer": "self"}


class AuthError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _norm(s) -> str:
    return " ".join(str(s or "").split()).casefold()


def _split(v) -> list[str]:
    return [x.strip() for x in str(v or "").replace(",", ";").split(";") if x.strip()]


TELEMETRY_SHEET = "ML_Training_Dataset"
TELEMETRY_FIELDS = ("Software_Tool", "License_Type", "Project_ID", "Project_Phase", "Session_Start", "Session_Duration_Hrs",
                    "Active_Usage_Hrs", "Idle_Duration_Hrs", "CPU_GPU_Utilization_Pct", "Keyboard_Mouse_Activity_Pct",
                    "Idle_Session_Flag", "Recommended_Action")

_lock = threading.Lock()
_cache: dict = {"mtime": None, "rows": {}, "telemetry": {}, "org_mtime": None, "org": {}}


def _load_roster() -> None:
    import openpyxl
    wb = openpyxl.load_workbook(ROSTER_FILE, read_only=True, data_only=True)
    rows = list(wb[ROSTER_SHEET].iter_rows(values_only=True))
    tel_rows = list(wb[TELEMETRY_SHEET].iter_rows(values_only=True)) if TELEMETRY_SHEET in wb.sheetnames else []
    wb.close()
    head = [str(h).strip() for h in rows[0]]
    out = {}
    for r in rows[1:]:
        rec = dict(zip(head, r))
        if rec.get("User_ID"):
            out[str(rec["User_ID"]).strip().upper()] = rec
    tel: dict[str, list] = {}
    if tel_rows:
        th = [str(h).strip() for h in tel_rows[0]]
        for r in tel_rows[1:]:
            rec = dict(zip(th, r))
            if rec.get("Employee_ID"):
                tel.setdefault(str(rec["Employee_ID"]).strip().upper(), []).append(
                    {k: (str(rec[k]) if k == "Session_Start" and rec.get(k) is not None else rec.get(k))
                     for k in TELEMETRY_FIELDS})
    _cache.update(rows=out, telemetry=tel)


def roster() -> dict[str, dict]:
    """Employee_ID (upper case) -> record. Re-read when the file changes."""
    with _lock:
        mtime = ROSTER_FILE.stat().st_mtime
        if _cache["mtime"] != mtime:
            _load_roster()
            _cache["mtime"] = mtime
        return _cache["rows"]


def telemetry(employee_id: str) -> list[dict]:
    """The employee's logged licence sessions (sheet ML_Training_Dataset), newest first."""
    roster()
    return sorted(_cache["telemetry"].get(str(employee_id).upper(), []), key=lambda t: str(t["Session_Start"]),
                  reverse=True)


def org() -> dict:
    """org_scope.json (profiles, department / project / software mapping). Re-read when the file changes."""
    with _lock:
        mtime = ORG_FILE.stat().st_mtime
        if _cache["org_mtime"] != mtime:
            _cache.update(org_mtime=mtime, org=json.loads(ORG_FILE.read_text(encoding="utf-8")))
        return _cache["org"]


def role_map() -> dict[str, str]:
    """Role_Category -> profile id."""
    return {cat: pid for pid, p in org()["profiles"].items() for cat in p["role_categories"]}


def profile_of(rec: dict) -> str | None:
    return role_map().get(str(rec.get("Role_Category") or "").strip())


def _scope(rec: dict, role: str) -> dict:
    o = org()
    dept = str(rec.get("Department") or "").strip()
    d = o["departments"].get(dept, {})
    projects = [p for p in _split(rec.get("Assigned_Project")) if p in o["projects"]]
    app_projects = [o["projects"][p]["app_project_id"] for p in projects if o["projects"][p].get("app_project_id")]
    tool = str(rec.get("Primary_Software_Tool") or "").strip()
    sw = o["software"].get(tool, {})
    return {
        "level": SCOPE_LEVEL[role],
        "department": dept,
        "app_dept_id": d.get("app_dept_id"),
        "ml_departments": d.get("ml_departments", []),
        "projects": projects,
        "app_project_ids": app_projects,
        "primary_tool": tool or None,
        "app_licence_ids": [sw["app_licence_id"]] if sw.get("app_licence_id") else [],
        "ml_software_ids": [sw["ml_software_id"]] if sw.get("ml_software_id") else [],
        "app_user_id": o.get("app_users", {}).get(str(rec["User_ID"]).upper()),
    }


def _public(rec: dict) -> dict:
    role = profile_of(rec)
    p = org()["profiles"][role]
    return dict(employee_id=rec["User_ID"], name=rec["User_Name"], email=rec["User_Email"],
                designation=rec["Role_Title"], role_category=rec["Role_Category"], department=rec["Department"],
                role=role, profile_label=p["label"], profile_summary=p["summary"],
                scopes=sorted(SCOPES[role]), scope=_scope(rec, role))


def verify_employee(employee_id: str, email: str, designation: str) -> dict:
    rec = roster().get(str(employee_id or "").strip().upper())
    if rec is None:
        raise AuthError(401, "unknown_employee", "No employee with this ID in the employee records.")
    if _norm(rec["User_Email"]) != _norm(email):
        raise AuthError(401, "credentials_mismatch", "Employee ID and email do not match the employee records.")
    if _norm(rec["Role_Title"]) != _norm(designation):
        raise AuthError(403, "designation_mismatch", "The designation entered does not match the employee record.")
    if profile_of(rec) is None:
        raise AuthError(403, "role_not_permitted", "This employee category has no access to the platform.")
    return _public(rec)


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def issue_token(user: dict) -> str:
    body = _b64(json.dumps({"sub": user["employee_id"], "role_category": user["role_category"],
                            "exp": int(time.time()) + SESSION_SECONDS}).encode())
    sig = _b64(hmac.new(_SECRET, body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def session_user(token: str | None) -> dict:
    """Validate the signed token AND re-check the employee record (authoritative)."""
    if not token or "." not in token:
        raise AuthError(401, "not_signed_in", "Sign in required.")
    body, sig = token.rsplit(".", 1)
    good = _b64(hmac.new(_SECRET, body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, good):
        raise AuthError(401, "invalid_session", "Session is not valid. Sign in again.")
    data = json.loads(_unb64(body))
    if data["exp"] < time.time():
        raise AuthError(401, "session_expired", "Session expired. Sign in again.")
    rec = roster().get(str(data["sub"]).upper())
    if rec is None or rec.get("Role_Category") != data["role_category"] or profile_of(rec) is None:
        raise AuthError(401, "record_changed", "Your employee record changed. Sign in again.")
    return _public(rec)


def require(user: dict, scope: str) -> None:
    if scope not in user["scopes"]:
        raise AuthError(403, "forbidden",
                        f"Your profile ({user['profile_label']}, {user['designation']}) does not permit '{scope}'.")


def require_any(user: dict, *scopes: str) -> None:
    if not any(s in user["scopes"] for s in scopes):
        require(user, scopes[0])


# ---------------------------------------------------------------------------------------------- people in scope
def _person(rec: dict) -> dict:
    o = org()
    role = profile_of(rec)
    projects = _split(rec.get("Assigned_Project"))
    tool = str(rec.get("Primary_Software_Tool") or "").strip()
    return dict(employee_id=rec["User_ID"], name=rec["User_Name"], email=rec["User_Email"],
                designation=rec["Role_Title"], role_category=rec["Role_Category"], role=role,
                profile_label=o["profiles"][role]["label"] if role else None,
                department=rec["Department"],
                app_dept_id=o["departments"].get(str(rec["Department"]), {}).get("app_dept_id"),
                projects=projects,
                app_project_ids=[o["projects"][p]["app_project_id"] for p in projects
                                 if p in o["projects"] and o["projects"][p].get("app_project_id")],
                primary_tool=tool or None,
                app_licence_id=o["software"].get(tool, {}).get("app_licence_id"),
                app_user_id=o.get("app_users", {}).get(str(rec["User_ID"]).upper()),
                assigned_admin=rec.get("Assigned_Admin_Name"), assigned_admin_id=rec.get("Assigned_Admin_ID"),
                sessions=telemetry(rec["User_ID"]))


def team(user: dict) -> dict:
    """
    The roster people this user may see, and who to contact:
      admin: everyone; department head: their department; project head: members of their projects;
      engineer: only themselves (plus their contacts).
    """
    rows = [r for r in roster().values() if profile_of(r)]
    me = roster()[str(user["employee_id"]).upper()]
    sc = user["scope"]
    if user["role"] == "admin":
        members = rows
    elif user["role"] == "deptHead":
        members = [r for r in rows if _norm(r["Department"]) == _norm(sc["department"]) and profile_of(r) != "admin"]
    elif user["role"] == "projectLead":
        mine = set(sc["projects"])
        members = [r for r in rows if mine & set(_split(r.get("Assigned_Project")))]
    else:
        members = [me]

    my_projects = set(_split(me.get("Assigned_Project")))
    contacts = []
    for r in rows:
        if r is me:
            continue
        role = profile_of(r)
        if role == "deptHead" and _norm(r["Department"]) == _norm(me["Department"]):
            contacts.append({**_person(r), "relation": "Department head"})
        elif role == "projectLead" and my_projects & set(_split(r.get("Assigned_Project"))):
            contacts.append({**_person(r), "relation": "Project head"})
        elif str(r["User_ID"]).upper() == str(me.get("Assigned_Admin_ID") or "").upper():
            contacts.append({**_person(r), "relation": "Licence administrator"})
    order = {"admin": 0, "deptHead": 1, "projectLead": 2, "engineer": 3}
    members = sorted(members, key=lambda r: (order.get(profile_of(r), 9), str(r["Department"]), str(r["User_Name"])))
    return {"level": sc["level"], "members": [_person(r) for r in members], "contacts": contacts}


def demo_accounts() -> list[dict]:
    """One sign-in per profile (prototype convenience; disable with KPCL_DEMO_ACCOUNTS=0)."""
    if os.environ.get("KPCL_DEMO_ACCOUNTS", "1") in ("0", "false", "no"):
        return []
    want = ["ADM101", "DH202", "PH301", "EMP002", "ADM102", "DH201", "PH303", "EMP001", "EMP003"]
    out = []
    for eid in want:
        r = roster().get(eid)
        if r and profile_of(r):
            out.append(dict(employee_id=r["User_ID"], name=r["User_Name"], email=r["User_Email"],
                            designation=r["Role_Title"], profile_label=org()["profiles"][profile_of(r)]["label"],
                            department=r["Department"]))
    return out
