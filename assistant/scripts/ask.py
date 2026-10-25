"""
Terminal chat with the same engine as the Streamlit app (handy for quick checks).

    python scripts/ask.py "Why is PF001 ANSYS at risk?"
    python scripts/ask.py --interactive
    python scripts/ask.py --no-llm "Which pools are riskiest for MATLAB?"
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from rag_chatbot.services import build_services  # noqa: E402


def show(res, verbose: bool):
    print("\n" + res.answer + "\n")
    for n in res.notes:
        print(f"  note: {n}")
    print(f"  [llm: {res.llm_used or 'none'} | resolved: {res.entities.to_dict()} | query: {res.standalone_query!r}]")
    for b in res.blocks:
        print(f"  [{b.label}] {b.kind:<11} {b.title}  <- {b.source}")
        if verbose:
            print("      " + b.text[:400].replace("\n", "\n      "))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("question", nargs="*")
    ap.add_argument("--interactive", "-i", action="store_true")
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--pool", help="focus pool, e.g. PF001/SW003")
    ap.add_argument("--verbose", "-v", action="store_true")
    a = ap.parse_args()
    svc = build_services(llm=None) if a.no_llm else build_services()
    for w in svc.warnings:
        print("warning:", w)
    focus = tuple(a.pool.split("/")) if a.pool else None
    history: list[dict] = []
    qs = [" ".join(a.question)] if a.question else []
    while True:
        if qs:
            q = qs.pop(0)
        elif a.interactive:
            try:
                q = input("\nYou> ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if q.lower() in ("exit", "quit"):
                break
        else:
            break
        if not q:
            continue
        res = svc.engine.answer(q, history, focus)
        show(res, a.verbose)
        history += [{"role": "user", "content": q, "meta": {"entities": res.entities.to_dict()}},
                    {"role": "assistant", "content": res.answer, "meta": {"entities": res.entities.to_dict()}}]


if __name__ == "__main__":
    main()
