from __future__ import annotations
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))

from portfolio_decision_engine import run as run_portfolio_engine


def main() -> None:
    outputs = run_portfolio_engine(ROOT / "output", ROOT)
    print("\nMember 3 forecast-aware recommendation layer completed.")
    for name, path in outputs.items():
        print(f"{name:26s}: {path}")
    print("Note: portfolio-level financial values are not additive until the team confirms pool architecture.")


if __name__ == "__main__":
    main()
