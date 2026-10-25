"""
End-to-end pipeline: forecasting model -> Monte Carlo simulation -> recommendation engine -> RAG knowledge base.

The forecasting model is FORECAST_MODEL (config/settings.json or .env): "ensemble" (default, the model selected by the
light-model comparison in components/model_selection) or "single" (the single gradient-boosted model). Override with --model.

    python scripts/build_pipeline.py                 # sync forecast outputs into recommendation engine, run recommendation engine, build index
    python scripts/build_pipeline.py --simulate      # first re-run the Monte Carlo simulation with the model (~5-15 min)
    python scripts/build_pipeline.py --retrain       # retrain the model, then simulate, then the rest
                                                     #   ensemble: run_ensemble.py (~2 min; --quick ~40 s)
                                                     #   single:   run_training.py (~15 min; --quick faster)
    python scripts/build_pipeline.py --model single --retrain --backend xgboost   # single model with XGBoost
    python scripts/build_pipeline.py --check         # status report only, changes nothing
    python scripts/build_pipeline.py --check --ping-llm   # also send one tiny request to verify your API key
"""
from __future__ import annotations

import argparse
import platform
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from rag_chatbot.config import ENSEMBLE_DIR, FORECAST_DIR, ENGINE_DIR, load_settings  # noqa: E402


def step(msg: str):
    print(f"\n=== {msg}")


def run_script(folder: Path, script: str, *args: str) -> None:
    cmd = [sys.executable, script, *args]
    print("    $", " ".join(cmd), f"(in {folder})")
    t0 = time.time()
    subprocess.run(cmd, cwd=folder, check=True)
    print(f"    done in {time.time() - t0:.0f}s")


def services_for(model: str):
    from rag_chatbot.integration.engine_adapter import RecommendationService, handoff_files
    from rag_chatbot.integration.ml_adapter import MLService
    ml = MLService(FORECAST_DIR, model, ENSEMBLE_DIR)
    return ml, RecommendationService(ENGINE_DIR, FORECAST_DIR, handoff_files(ml))


def check(model: str, ping_llm: bool = False) -> int:
    from rag_chatbot.llm import LLMError, Message, build_client
    problems = 0
    print(f"Python {platform.python_version()} on {platform.system()}")
    for mod in ("pandas", "numpy", "sklearn", "scipy", "requests", "streamlit", "dotenv", "matplotlib", "xgboost"):
        try:
            m = __import__(mod)
            print(f"  [ok] {mod} {getattr(m, '__version__', '')}")
        except ImportError:
            optional = mod in ("xgboost", "dotenv", "matplotlib")
            print(f"  [{'--' if optional else 'MISSING'}] {mod}{' (optional)' if optional else ''}")
            problems += 0 if optional else 1
    ml, rec = services_for(model)
    st = ml.model_status()
    print(f"  forecasting model: {model} ({ml.model_label})")
    if st["available"]:
        print(f"  [ok] trained model loads: backend={st['backend']} CV MAE={st['cv_mae']:.4f} "
              f"(built with scikit-learn {st['sklearn']}, Python {st['python']})")
    else:
        print(f"  [!!] trained model not usable: {st['error']}")
        problems += 1
    for p in [ml.sim_dir / "pool_forecast_by_month.csv", ml.sim_dir / "recommendations.json"]:
        ok = p.exists()
        print(f"  [{'ok' if ok else 'MISSING'}] {p.relative_to(ROOT)}")
        problems += 0 if ok else 1
    for p in ["output/portfolio_pool_recommendations.csv", "output/recommendations.csv"]:
        ok = (ENGINE_DIR / p).exists()
        print(f"  [{'ok' if ok else 'MISSING'}] recommendation engine {p}")
        problems += 0 if ok else 1
    sync = rec.handoff_in_sync()
    print(f"  [{'ok' if sync['all_in_sync'] else '!!'}] recommendation engine input == active model's latest simulation output: "
          f"{sync['all_in_sync']}" + ("" if sync["all_in_sync"] else "  -> run: python scripts/build_pipeline.py"))
    s = load_settings()
    pub = s.public_summary()
    print(f"  LLM provider: {pub['provider']}  model: {pub['model']}  key configured: {pub['api_key_configured']}")
    if ping_llm:
        try:
            c = build_client(s)
            if c is None:
                print("  [--] no LLM configured; chatbot will run in retrieval-only mode")
            else:
                out = c.generate("Reply with the single word OK.", [Message("user", "ping")], max_tokens=5)
                print(f"  [ok] LLM answered: {out!r}")
        except LLMError as e:
            print(f"  [!!] LLM check failed: {e}")
            problems += 1
    print("\nAll checks passed." if not problems else f"\n{problems} problem(s) found.")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", choices=["ensemble", "single"], default=None,
                    help="forecasting model (default: FORECAST_MODEL setting, 'ensemble')")
    ap.add_argument("--retrain", action="store_true", help="retrain the forecasting model (implies --simulate)")
    ap.add_argument("--quick", action="store_true", help="with --retrain: faster run (fewer folds / candidates)")
    ap.add_argument("--backend", default="sklearn", choices=["auto", "sklearn", "xgboost"],
                    help="with --model single --retrain: model backend")
    ap.add_argument("--simulate", action="store_true", help="re-run the Monte Carlo simulation with the model")
    ap.add_argument("--paths", type=int, default=None, help="with --simulate: Monte Carlo paths (default 4000)")
    ap.add_argument("--check", action="store_true", help="only report status")
    ap.add_argument("--ping-llm", action="store_true", help="with --check: make one tiny LLM call")
    a = ap.parse_args()
    model = a.model or load_settings().forecast_model
    if a.check:
        return 1 if check(model, a.ping_llm) else 0

    t0 = time.time()
    if a.retrain:
        if model == "ensemble":
            step("1. Comparing light models and selecting the most accurate (components/model_selection/run_ensemble.py)")
            run_script(ENSEMBLE_DIR, "run_ensemble.py", *(["--quick"] if a.quick else []))
        else:
            step("1. Training the single gradient-boosted model (run_training.py)")
            run_script(FORECAST_DIR, "run_training.py", "--backend", a.backend, *(["--quick"] if a.quick else []))
    if a.retrain or a.simulate:
        step("2. Monte Carlo simulation of every pool with the model")
        if model == "ensemble":
            from rag_chatbot.integration import simulation_runner
            ml, _ = services_for(model)
            simulation_runner.run(ml, a.paths)
        else:
            run_script(FORECAST_DIR, "run_simulation.py", *(["--paths", str(a.paths)] if a.paths else []))

    ml, rec = services_for(model)
    step(f"3. Handing the {model} forecast to recommendation engine")
    for f in rec.sync_forecast_outputs():
        print(f"    copied -> components/recommendation_engine/{f}")
    step("4. Running the recommendation engine (both layers)")
    for k, v in rec.run_all().items():
        print(f"    {k:26s} {Path(v).relative_to(ROOT)}")
    step("5. Building the RAG knowledge base")
    from rag_chatbot.services import INDEX_FILE, build_services
    settings = load_settings()
    settings.forecast_model = model
    svc = build_services(settings, llm=None)
    print(f"    {len(svc.docs)} documents -> {INDEX_FILE.relative_to(ROOT)}")
    for w in svc.warnings:
        print(f"    warning: {w}")
    st = svc.ml.model_status()
    print(f"    live model: {'available' if st['available'] else 'NOT available - ' + str(st['error'])}")
    print(f"\nPipeline finished in {time.time() - t0:.0f}s. Start the app with:  streamlit run app.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
