"""Entity extraction for portfolio / software / project / month references in free text."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# Aliases people actually type -> software_id (names from the forecasting component's lookups/software_lookup.csv)
SOFTWARE_ALIASES = {
    "SW001": ["autodesk inventor", "inventor"],
    "SW002": ["solidworks", "solid works", "sw2"],
    "SW003": ["ansys mechanical", "ansys"],
    "SW004": ["altair hyperworks", "hyperworks", "hyper works", "altair"],
    "SW005": ["autocad", "auto cad"],
    "SW006": ["cadence orcad", "orcad", "cadence"],
    "SW007": ["matlab"],
    "SW008": ["siemens nx", "nx"],
}
MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
     "november", "december"], 1)}
MONTH_ABBR = {k[:3]: v for k, v in MONTHS.items()}

_PF = re.compile(r"\b(?:PF|portfolio|pool)\s*[-_#]?\s*0*(\d{1,3})\b", re.I)
_SW = re.compile(r"\bSW\s*[-_]?\s*0*(\d{1,3})\b", re.I)
_PROJ = re.compile(r"\bP\s?(\d{4})\b")
_YM = re.compile(r"\b(20\d\d)-(0[1-9]|1[0-2])\b")
_NAMED_MONTH = re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*(20\d\d)?\b", re.I)


@dataclass
class Entities:
    portfolios: list[str] = field(default_factory=list)
    software: list[str] = field(default_factory=list)
    projects: list[str] = field(default_factory=list)
    months: list[str] = field(default_factory=list)

    def empty(self) -> bool:
        return not (self.portfolios or self.software or self.projects or self.months)

    def pool(self) -> tuple[str, str] | None:
        if self.portfolios and self.software:
            return self.portfolios[0], self.software[0]
        return None

    def merged_with(self, other: "Entities") -> "Entities":
        """Fill the slots this object does not have from `other` (used for follow-up questions)."""
        return Entities(self.portfolios or list(other.portfolios), self.software or list(other.software),
                        self.projects or list(other.projects), self.months or list(other.months))

    def to_dict(self) -> dict:
        return {"portfolios": self.portfolios, "software": self.software, "projects": self.projects,
                "months": self.months}

    @classmethod
    def from_dict(cls, d: dict | None) -> "Entities":
        d = d or {}
        return cls(list(d.get("portfolios", [])), list(d.get("software", [])), list(d.get("projects", [])),
                   list(d.get("months", [])))


def _uniq(xs):
    out = []
    for x in xs:
        if x not in out:
            out.append(x)
    return out


def extract(text: str, default_year: int = 2026) -> Entities:
    t = text or ""
    low = t.lower()
    pfs = [f"PF{int(n):03d}" for n in _PF.findall(t) if 1 <= int(n) <= 999]
    sws = [f"SW{int(n):03d}" for n in _SW.findall(t)]
    for sid, names in SOFTWARE_ALIASES.items():
        for nm in names:
            if re.search(r"(?<![a-z0-9])" + re.escape(nm) + r"(?![a-z0-9])", low):
                sws.append(sid)
                break
    projects = [f"P{n}" for n in _PROJ.findall(t)]
    months = [f"{y}-{m}" for y, m in _YM.findall(t)]
    for name, year in _NAMED_MONTH.findall(t):
        key = name.lower()[:3]
        if key == "may" and not year and not re.search(r"\bmay\s+(?:20\d\d)\b", low):
            continue  # "may" is usually the verb
        mi = MONTH_ABBR.get(key)
        if mi:
            y = int(year) if year else (default_year if mi >= 10 else default_year + 1)  # window is Oct 2026 - Mar 2027
            months.append(f"{y}-{mi:02d}")
    return Entities(_uniq(pfs), _uniq(sws), _uniq(projects), _uniq(months))


FOLLOWUP_HINTS = re.compile(
    r"^(and|also|what about|how about|why|so|then|ok|okay|explain|that|this|it|those|these|same)\b|"
    r"\b(it|its|that|this|they|them|those|these|the same|above|previous|earlier|instead)\b", re.I)


def looks_like_followup(text: str) -> bool:
    t = (text or "").strip()
    return bool(FOLLOWUP_HINTS.search(t)) or len(t.split()) <= 6
