from __future__ import annotations
import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))
from decision_engine import run_engine  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Member 3's licence optimisation and recommendation engine")
    parser.add_argument("--forecast", type=Path, default=None,
                        help="Optional Member 2 forecast CSV (software_id, forecast_date/date, predicted_demand)")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data", help="Folder containing required input CSV files")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "output", help="Folder for generated results")
    parser.add_argument("--config", type=Path, default=ROOT / "config.json", help="Configuration JSON")
    args = parser.parse_args()
    try:
        outputs = run_engine(args.data_dir, args.output_dir, args.config, args.forecast)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
    print("\nMember 3 Decision Engine completed.\n")
    for name, path in outputs.items():
        print(f"{name:18s}: {path}")
    print("\nOpen output/recommendations.csv first. Savings are estimates and require human review.")

if __name__ == "__main__":
    main()
