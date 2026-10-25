"""
Central configuration.

Secrets (API keys) come ONLY from environment variables / the `.env` file.
Non-secret defaults live in `config/settings.json`; any of them can be overridden
by an environment variable with the same name in upper case (e.g. TOP_K=10).
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
COMPONENTS_DIR = PROJECT_ROOT / "components"
FORECAST_DIR = COMPONENTS_DIR / "forecasting"          # trained ML model + Monte Carlo simulation
ENGINE_DIR = COMPONENTS_DIR / "recommendation_engine"      # recommendation engine
ENSEMBLE_DIR = COMPONENTS_DIR / "model_selection"        # light-model comparison; the selected model is the default
SETTINGS_FILE = PROJECT_ROOT / "config" / "settings.json"
ENV_FILE = PROJECT_ROOT / ".env"


def _load_dotenv() -> None:
    """Load .env if python-dotenv is installed; otherwise parse the simple KEY=VALUE format ourselves."""
    if not ENV_FILE.exists():
        return
    try:
        from dotenv import load_dotenv
        load_dotenv(ENV_FILE, override=False)
        return
    except ImportError:
        pass
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def _defaults() -> dict:
    if SETTINGS_FILE.exists():
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    return {}


def _get(name: str, defaults: dict, fallback, cast=str):
    raw = os.environ.get(name.upper())
    if raw is None or raw == "":
        raw = defaults.get(name.lower(), fallback)
    if cast is bool:
        return str(raw).strip().lower() in ("1", "true", "yes", "on")
    try:
        return cast(raw)
    except (TypeError, ValueError):
        return fallback


@dataclass
class Settings:
    # LLM
    llm_provider: str = "auto"          # auto | anthropic | openai | none
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5-5"
    anthropic_base_url: str = "https://api.anthropic.com"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str = "https://api.openai.com/v1"
    temperature: float = 0.2
    max_tokens: int = 1200
    request_timeout_s: float = 60.0
    max_retries: int = 2
    rewrite_followups_with_llm: bool = True
    # retrieval / chat
    top_k: int = 8
    history_turns: int = 6
    # forecasting model: "ensemble" (selected by the light-model comparison) or "single" (single model)
    forecast_model: str = "ensemble"
    # paths
    forecast_dir: Path = field(default_factory=lambda: FORECAST_DIR)
    ensemble_dir: Path = field(default_factory=lambda: ENSEMBLE_DIR)
    engine_dir: Path = field(default_factory=lambda: ENGINE_DIR)

    @property
    def resolved_provider(self) -> str:
        p = (self.llm_provider or "auto").lower()
        if p == "auto":
            if self.anthropic_api_key:
                return "anthropic"
            if self.openai_api_key:
                return "openai"
            return "none"
        return p

    def public_summary(self) -> dict:
        """Settings safe to show in the UI (no secrets)."""
        prov = self.resolved_provider
        return {
            "provider": prov,
            "model": self.anthropic_model if prov == "anthropic" else self.openai_model if prov == "openai" else "-",
            "api_key_configured": bool(self.anthropic_api_key if prov == "anthropic" else
                                       self.openai_api_key if prov == "openai" else False),
            "base_url": self.anthropic_base_url if prov == "anthropic" else self.openai_base_url if prov == "openai" else "-",
            "top_k": self.top_k,
        }


def load_settings() -> Settings:
    _load_dotenv()
    d = _defaults()
    return Settings(
        llm_provider=_get("llm_provider", d, "auto"),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", "").strip(),
        anthropic_model=_get("anthropic_model", d, "claude-sonnet-5-5"),
        anthropic_base_url=_get("anthropic_api_url", d, "https://api.anthropic.com").rstrip("/"),
        openai_api_key=os.environ.get("OPENAI_API_KEY", "").strip(),
        openai_model=_get("openai_model", d, "gpt-4o-mini"),
        openai_base_url=_get("openai_base_url", d, "https://api.openai.com/v1").rstrip("/"),
        temperature=_get("temperature", d, 0.2, float),
        max_tokens=_get("max_tokens", d, 1200, int),
        request_timeout_s=_get("request_timeout_s", d, 60.0, float),
        max_retries=_get("max_retries", d, 2, int),
        rewrite_followups_with_llm=_get("rewrite_followups_with_llm", d, True, bool),
        top_k=_get("top_k", d, 8, int),
        history_turns=_get("history_turns", d, 6, int),
        forecast_model={"member2": "single"}.get(_get("forecast_model", d, "ensemble").strip().lower(),
                                                 _get("forecast_model", d, "ensemble").strip().lower()),
    )
