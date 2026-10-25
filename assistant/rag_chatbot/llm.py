"""
LLM clients over plain HTTPS (`requests`), so no vendor SDK is needed.

  AnthropicClient         POST {ANTHROPIC_API_URL}/v1/messages           (Claude)
  OpenAICompatibleClient  POST {OPENAI_BASE_URL}/chat/completions        (OpenAI, or any OpenAI-compatible server:
                                                                          Groq, OpenRouter, Ollama, LM Studio, ...)
  build_client(settings)  picks one from LLM_PROVIDER / the keys present; returns None when no LLM is configured.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import requests

from .config import Settings


class LLMError(RuntimeError):
    """A problem talking to the LLM provider, with a message that is safe to show the user."""


@dataclass
class Message:
    role: str      # "user" | "assistant"
    content: str


def _friendly(status: int, body: str, provider: str) -> str:
    if status in (401, 403):
        return f"{provider} rejected the API key (HTTP {status}). Check the key in your .env file."
    if status == 404:
        return f"{provider} returned 404 - the model name or base URL is probably wrong. Response: {body[:300]}"
    if status == 429:
        return f"{provider} rate limit or quota reached (HTTP 429). Wait a moment or check your plan/billing."
    if status == 400:
        return f"{provider} rejected the request (HTTP 400): {body[:400]}"
    return f"{provider} error HTTP {status}: {body[:300]}"


class _BaseClient:
    provider = "LLM"

    def __init__(self, api_key: str, model: str, base_url: str, temperature: float = 0.2, max_tokens: int = 1200,
                 timeout: float = 60.0, max_retries: int = 2, session: requests.Session | None = None):
        if not api_key:
            raise LLMError(f"No API key configured for {self.provider}.")
        self.api_key, self.model, self.base_url = api_key, model, base_url.rstrip("/")
        self.temperature, self.max_tokens, self.timeout, self.max_retries = temperature, max_tokens, timeout, max_retries
        self.http = session or requests.Session()

    @property
    def label(self) -> str:
        return f"{self.provider} ({self.model})"

    def _post(self, url: str, headers: dict, payload: dict) -> dict:
        last = None
        for attempt in range(self.max_retries + 1):
            try:
                r = self.http.post(url, headers=headers, json=payload, timeout=self.timeout)
            except requests.Timeout:
                last = LLMError(f"{self.provider} did not answer within {self.timeout:.0f}s.")
            except requests.ConnectionError as e:
                last = LLMError(f"Could not connect to {self.provider} at {self.base_url}: {e.__class__.__name__}. "
                                "Check your internet connection / proxy and the base URL.")
            else:
                if r.status_code == 200:
                    try:
                        return r.json()
                    except ValueError:
                        raise LLMError(f"{self.provider} returned a non-JSON response.")
                last = LLMError(_friendly(r.status_code, r.text, self.provider))
                if r.status_code not in (429, 500, 502, 503, 504, 529):
                    raise last
            if attempt < self.max_retries:
                time.sleep(min(8.0, 1.5 * 2 ** attempt))
        raise last

    def generate(self, system: str, messages: list[Message], max_tokens: int | None = None) -> str:
        raise NotImplementedError


class AnthropicClient(_BaseClient):
    provider = "Anthropic"

    def generate(self, system: str, messages: list[Message], max_tokens: int | None = None) -> str:
        payload = {"model": self.model, "max_tokens": max_tokens or self.max_tokens, "temperature": self.temperature,
                   "system": system, "messages": [{"role": m.role, "content": m.content} for m in messages]}
        headers = {"x-api-key": self.api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
        data = self._post(f"{self.base_url}/v1/messages", headers, payload)
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
        if not text:
            raise LLMError(f"Anthropic returned no text (stop_reason={data.get('stop_reason')}).")
        return text


class OpenAICompatibleClient(_BaseClient):
    provider = "OpenAI-compatible"

    def generate(self, system: str, messages: list[Message], max_tokens: int | None = None) -> str:
        payload = {"model": self.model, "temperature": self.temperature, "max_tokens": max_tokens or self.max_tokens,
                   "messages": [{"role": "system", "content": system}]
                   + [{"role": m.role, "content": m.content} for m in messages]}
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        data = self._post(f"{self.base_url}/chat/completions", headers, payload)
        try:
            text = (data["choices"][0]["message"]["content"] or "").strip()
        except (KeyError, IndexError, TypeError):
            raise LLMError(f"Unexpected response format from {self.base_url}: {str(data)[:300]}")
        if not text:
            raise LLMError("The model returned an empty answer.")
        return text


def build_client(s: Settings):
    """Return an LLM client, or None when the provider is 'none' / no key is set."""
    prov = s.resolved_provider
    common = dict(temperature=s.temperature, max_tokens=s.max_tokens, timeout=s.request_timeout_s,
                  max_retries=s.max_retries)
    if prov == "anthropic":
        if not s.anthropic_api_key:
            raise LLMError("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty.")
        return AnthropicClient(s.anthropic_api_key, s.anthropic_model, s.anthropic_base_url, **common)
    if prov == "openai":
        if not s.openai_api_key:
            raise LLMError("LLM_PROVIDER=openai but OPENAI_API_KEY is empty.")
        return OpenAICompatibleClient(s.openai_api_key, s.openai_model, s.openai_base_url, **common)
    if prov == "none":
        return None
    raise LLMError(f"Unknown LLM_PROVIDER '{s.llm_provider}'. Use anthropic, openai, none or auto.")
