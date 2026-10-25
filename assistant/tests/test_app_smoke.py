"""
Streamlit smoke test using Streamlit's own test harness (streamlit.testing.v1.AppTest).
Runs every page of app.py headlessly and fails on any exception. Skipped if Streamlit is not installed.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import unittest
from pathlib import Path

import _shared  # noqa: F401

APP = str(Path(__file__).resolve().parent.parent / "app.py")
try:
    from streamlit.testing.v1 import AppTest
    HAVE_ST = True
except Exception:  # pragma: no cover
    HAVE_ST = False


@unittest.skipUnless(HAVE_ST, "streamlit is not installed")
class AppSmokeTests(unittest.TestCase):
    def test_every_page_renders_without_exceptions(self):
        at = AppTest.from_file(APP, default_timeout=180)
        at.run()
        self.assertFalse(at.exception, at.exception)
        pages = at.sidebar.radio[0].options
        for p in pages:
            at.sidebar.radio[0].set_value(p).run()
            self.assertFalse(at.exception, f"{p}: {at.exception}")

    def test_chat_round_trip(self):
        at = AppTest.from_file(APP, default_timeout=180)
        at.run()
        at.chat_input[0].set_value("Why is PF001 ANSYS at risk?").run()
        self.assertFalse(at.exception, at.exception)
        self.assertGreaterEqual(len(at.session_state["messages"]), 2)


if __name__ == "__main__":
    unittest.main()
