"""
Neutral wording for everything the user sees. The component projects' own outputs and READMEs refer to the team
members who built them ("Member 1/2/3"); the assistant describes the systems by what they do instead:

    Member 1  -> usage history (observed licence telemetry)
    Member 2  -> the forecast / the forecasting model and its Monte Carlo simulation
    Member 3  -> the recommendation engine
"""
from __future__ import annotations

import re

_RULES = [
    # specific phrases first
    (r"Member 1's software-wide history", "software-wide usage history"),
    (r"Member 1 history", "usage history"),
    (r"Member 1(?:'s)? (?:data|operational usage data|synthetic operational package)", "the usage-history data"),
    (r"Member 1's", "the usage history's"),
    (r"Member 1", "the usage history"),
    (r"Member 2's (?:forecast|forecasts)", "the forecast"),
    (r"Member 2's (?:monthly )?(?:forecast )?simulation", "the forecast simulation"),
    (r"Member 2's model", "the forecasting model"),
    (r"Member 2's own", "the simulation's own"),
    (r"Member 2's", "the forecast's"),
    (r"Member 2", "the forecasting model"),
    (r"Member 3's", "the recommendation engine's"),
    (r"Member 3", "the recommendation engine"),
    (r"\b[Mm]embers? [123]\b", "the team"),
    (r"data/member2/", "forecast-input/"),
    (r"member2_simulation_recommendations", "simulation_recommendations"),
    (r"\bmember[123]\b", "component"),
]
_COMPILED = [(re.compile(a, re.I), b) for a, b in _RULES]
_THE_THE = re.compile(r"\b(the|The) the\b")
_SENT_START = re.compile(r"(^|[.!?]\s+|\n\s*[-*]?\s*)the ")


def neutralize(text):
    if not isinstance(text, str) or "ember" not in text.lower():
        return text
    for rx, rep in _COMPILED:
        text = rx.sub(rep, text)
    text = _THE_THE.sub(lambda m: m.group(1), text)
    return _SENT_START.sub(lambda m: m.group(1) + "The ", text)
