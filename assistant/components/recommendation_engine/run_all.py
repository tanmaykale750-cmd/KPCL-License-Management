from __future__ import annotations
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def run_step(script: str) -> None:
    print(f"\n{'=' * 18} Running {script} {'=' * 18}")
    subprocess.run([sys.executable, str(ROOT / script)], cwd=ROOT, check=True)


def main() -> None:
    # Legacy software-level recommendations from Member 1's observed daily history.
    run_step("run_decision_engine.py")
    # Forecast-aware portfolio/software recommendations from Member 2's monthly output.
    run_step("run_portfolio_decision_engine.py")
    print("\nALL MEMBER 3 OUTPUTS GENERATED.")
    print("Start with output/recommendations.csv for software-level history and")
    print("output/portfolio_pool_recommendations.csv for forecast-aware pool-level actions.")


if __name__ == "__main__":
    main()
