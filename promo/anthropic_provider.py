"""Claude, through the official Anthropic SDK (not an OpenAI-compatible shim).

Same interface as providers.Provider: complete(system, user) -> text, list_models(), usage.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

import anthropic

from .providers import ProviderError, Usage, cache_get, cache_put

FALLBACK_BETA = "server-side-fallback-2026-07-01"


@dataclass
class AnthropicProvider:
    name: str
    model: str
    api_key: str = field(repr=False, default="")
    cache_dir: Path | None = None
    effort: str = "medium"
    concurrency: int = 4
    usage: Usage = field(default_factory=Usage)

    def __post_init__(self) -> None:
        self.client = anthropic.Anthropic(api_key=self.api_key, max_retries=4)

    def complete(self, system: str, user: str, temperature: float = 0.3) -> str:
        key = ["anthropic", self.model, self.effort, system, user]
        cp, hit = cache_get(self.cache_dir, key)
        if hit is not None:
            self.usage.cached += 1
            return hit
        t0 = time.monotonic()
        try:
            # Server-side fallback: if the model declines, the API re-runs the request on a fallback model.
            r = self.client.beta.messages.create(
                model=self.model, max_tokens=16000, system=system,
                messages=[{"role": "user", "content": user}],
                output_config={"effort": self.effort},
                betas=[FALLBACK_BETA], fallbacks="default",
            )
        except anthropic.AuthenticationError as e:
            raise ProviderError(f"{self.name}: the API key was rejected.") from e
        except anthropic.NotFoundError as e:
            raise ProviderError(f"{self.name}: model '{self.model}' not found.") from e
        except anthropic.RateLimitError as e:
            raise ProviderError(f"{self.name}: rate limited after retries.", fatal=False) from e
        except anthropic.APIConnectionError as e:
            raise ProviderError(f"{self.name}: network error, {e}", fatal=False) from e
        except anthropic.APIStatusError as e:
            raise ProviderError(f"{self.name}: {e.status_code} {e.message}", fatal=False) from e
        self.usage.add({"prompt_tokens": r.usage.input_tokens, "completion_tokens": r.usage.output_tokens},
                       time.monotonic() - t0)
        if r.stop_reason == "refusal":
            raise ValueError("the model declined this request")
        text = "".join(b.text for b in r.content if b.type == "text")
        cache_put(cp, text)
        return text

    def list_models(self) -> list[str]:
        try:
            return sorted(m.id for m in self.client.models.list())
        except anthropic.AuthenticationError as e:
            raise ProviderError(f"{self.name}: the API key was rejected.") from e
