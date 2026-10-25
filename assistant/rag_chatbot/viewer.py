"""
Who is asking. The chat tailors its answer to the signed-in profile:

  * which sections it may show (recommendations and costs are not shown to every profile),
  * which what-ifs it may run (licence-supply changes vs schedule changes),
  * whose next steps it lists (an administrator raises a purchase; a project head checks the schedule; an engineer
    raises an access request).

The API builds the Viewer from the verified session (backend/auth.py), never from the request body. The Streamlit app
and the terminal chat use FULL_ACCESS.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

ALL_SCOPES = frozenset({"forecast", "recommend", "optimise", "simulate", "simulate_plan", "chat", "costs", "team"})

ROLE_LABEL = {"admin": "Admin (Head)", "deptHead": "Department Head", "projectLead": "Project Head",
              "engineer": "Engineer"}


@dataclass(frozen=True)
class Viewer:
    role: str = "admin"
    label: str = "Admin (Head)"
    name: str = ""
    scopes: frozenset = ALL_SCOPES
    department: str = ""
    ml_departments: tuple = ()
    projects: tuple = ()
    primary_software: tuple = ()            # ML software ids of the user's own tool(s)
    extra: dict = field(default_factory=dict, compare=False, hash=False)

    def can(self, scope: str) -> bool:
        return scope in self.scopes

    @property
    def sees_costs(self) -> bool:
        return self.can("costs")

    @property
    def sees_recommendations(self) -> bool:
        return self.can("recommend")

    def to_dict(self) -> dict:
        return {"role": self.role, "label": self.label, "name": self.name, "department": self.department,
                "sees_costs": self.sees_costs, "sees_recommendations": self.sees_recommendations,
                "can_simulate": self.can("simulate"), "can_simulate_plan": self.can("simulate_plan")}

    @classmethod
    def from_user(cls, user: dict | None) -> "Viewer":
        """Build from backend.auth's public user record."""
        if not user:
            return FULL_ACCESS
        sc = user.get("scope") or {}
        return cls(role=user.get("role", "engineer"),
                   label=user.get("profile_label") or ROLE_LABEL.get(user.get("role", ""), "User"),
                   name=user.get("name", ""),
                   scopes=frozenset(user.get("scopes", [])),
                   department=sc.get("department") or user.get("department", ""),
                   ml_departments=tuple(sc.get("ml_departments") or ()),
                   projects=tuple(sc.get("projects") or ()),
                   primary_software=tuple(sc.get("ml_software_ids") or ()))


FULL_ACCESS = Viewer()

# Rupee amounts as the components and the composer write them: "₹12.80 lakh", "₹29,195", "INR 1,280,000", "INR 682,667/yr"
_MONEY = re.compile(r"(?:₹\s?-?[\d,]+(?:\.\d+)?(?:\s?(?:lakh|crore|L|Cr)\b)?|\bINR\s?-?[\d,]+(?:\.\d+)?(?:/yr)?)")
HIDDEN = "[cost hidden for your profile]"


def redact_money(text: str) -> str:
    return _MONEY.sub(HIDDEN, text) if isinstance(text, str) else text
