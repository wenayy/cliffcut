"""One interface for every model: anything that speaks the OpenAI chat-completions API.

Gemini, Groq and OpenAI all expose that API, so swapping models is a base URL, a
model name and a key. Kuku can plug in their own model the same way.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import httpx

CONFIG = Path(__file__).resolve().parent.parent / "providers.json"


def load_presets() -> dict[str, dict]:
    """providers.json: one entry per model family. Add a provider there, no code change."""
    try:
        data = json.loads(CONFIG.read_text())
    except (OSError, json.JSONDecodeError):
        data = {}
    return {k: v for k, v in data.items() if not k.startswith("_") and isinstance(v, dict)}


PRESETS = load_presets()


def cache_get(cache_dir: Path | None, key: object) -> tuple[Path | None, str | None]:
    if not cache_dir:
        return None, None
    h = hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()[:24]
    p = cache_dir / f"{h}.json"
    return p, (json.loads(p.read_text())["content"] if p.exists() else None)


def cache_put(path: Path | None, content: str) -> None:
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"content": content}))


class ProviderError(RuntimeError):
    """A failure the user must see. fatal=True (bad key, unknown model) stops a run; others skip one step."""

    def __init__(self, msg: str, fatal: bool = True):
        super().__init__(msg)
        self.fatal = fatal


@dataclass
class Usage:
    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0
    cached: int = 0
    retries: int = 0

    def add(self, other: dict, seconds: float) -> None:
        self.calls += 1
        self.prompt_tokens += int(other.get("prompt_tokens", 0) or 0)
        self.completion_tokens += int(other.get("completion_tokens", 0) or 0)
        self.seconds += seconds


@dataclass
class Provider:
    name: str
    model: str
    base_url: str
    api_key: str = field(repr=False, default="")
    cache_dir: Path | None = None
    timeout: float = 180.0   # thinking models (Gemini 3.x) take ~1 min per episode
    max_retries: int = 4
    usage: Usage = field(default_factory=Usage)
    sleep: Callable[[float], None] = time.sleep

    concurrency: int = 4
    dropped: set = field(default_factory=set)
    exhausted: str = ""   # set when the provider says the quota is used up; no more calls this run   # request fields this model rejected ("temperature", ...)

    @classmethod
    def from_preset(cls, name: str, model: str | None = None, api_key: str | None = None,
                    base_url: str | None = None, cache_dir: Path | None = None):
        """Gemini, Groq, OpenAI, Claude, anything in providers.json, or any URL ('custom')."""
        p = PRESETS.get(name, {})
        key_env = p.get("key_env", "CLIFFCUT_API_KEY")
        key = api_key or os.environ.get(key_env, "") or ("" if p else os.environ.get("CLIFFCUT_API_KEY", ""))
        if not key:
            raise ProviderError(f"No API key for {name}. Set {key_env} in .env or enter one.")
        if p.get("api") == "anthropic":
            from .anthropic_provider import AnthropicProvider
            return AnthropicProvider(name=name, model=model or p["model"], api_key=key, cache_dir=cache_dir,
                                     effort=p.get("effort", "medium"), concurrency=int(p.get("concurrency", 4)))
        url = base_url or p.get("base_url")
        if not url:
            raise ProviderError(f"Unknown provider '{name}'. Add it to providers.json or pass a base URL.")
        return cls(name=name, model=model or p.get("model", ""), base_url=url.rstrip("/"),
                   api_key=key, cache_dir=cache_dir, concurrency=int(p.get("concurrency", 4)))

    def complete(self, system: str, user: str, temperature: float = 0.3) -> str:
        body = {"model": self.model, "temperature": temperature,
                "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        for k in self.dropped:
            body.pop(k, None)
        if self.exhausted:
            raise ProviderError(self.exhausted, fatal=False)
        cp, hit = cache_get(self.cache_dir, [self.base_url, body])
        if hit is not None:
            self.usage.cached += 1
            return hit
        delay = 2.0
        for attempt in range(self.max_retries + 1):
            t0 = time.monotonic()
            try:
                r = httpx.post(f"{self.base_url}/chat/completions", json=body, timeout=self.timeout,
                               headers={"Authorization": f"Bearer {self.api_key}"})
            except httpx.HTTPError as e:
                if attempt == self.max_retries:
                    raise ProviderError(f"{self.name}: network error, {e}", fatal=False) from e
                self.usage.retries += 1
                self.sleep(delay); delay *= 2
                continue
            msg429 = _message(r).lower() if r.status_code == 429 else ""
            if r.status_code == 429 and any(k in msg429 for k in ("quota", "per day", "(tpd)", "(rpd)", "daily")):
                self.exhausted = f"{self.name}: quota used up ({_message(r)[:120]}). Try again later, or use another model."
                raise ProviderError(self.exhausted, fatal=False)
            if r.status_code in (429, 500, 502, 503, 504) and attempt < self.max_retries:
                self.usage.retries += 1
                wait = float(r.headers.get("retry-after", 0) or 0) or delay
                self.sleep(min(wait, 60)); delay *= 2
                continue
            if r.status_code in (401, 403):
                raise ProviderError(f"{self.name}: the API key was rejected ({r.status_code}).")
            if r.status_code == 404:
                raise ProviderError(f"{self.name}: model '{self.model}' not available. {_message(r)}")
            if r.status_code == 400:
                # newer models refuse some optional fields (e.g. "only the default temperature is supported"):
                # drop the field, remember it for this run, and retry once
                msg = _message(r)
                bad = next((k for k in ("temperature", "response_format") if k in body and k in msg), None)
                if not bad and "response_format" in body and "json" in msg.lower():
                    bad = "response_format"   # the provider's strict JSON mode refused the answer; our parser recovers it
                if bad:
                    self.dropped.add(bad)
                    body.pop(bad)
                    continue
            if r.status_code >= 400:
                raise ProviderError(f"{self.name}: {r.status_code} {_message(r)}", fatal=False)
            data = r.json()
            self.usage.add(data.get("usage") or {}, time.monotonic() - t0)
            content = data["choices"][0]["message"]["content"] or ""
            cache_put(cp, content)
            return content
        raise ProviderError(f"{self.name}: gave up after {self.max_retries} retries", fatal=False)

    def list_models(self) -> list[str]:
        r = httpx.get(f"{self.base_url}/models", timeout=20, headers={"Authorization": f"Bearer {self.api_key}"})
        if r.status_code in (401, 403):
            raise ProviderError(f"{self.name}: the API key was rejected ({r.status_code}).")
        r.raise_for_status()
        ids = [m.get("id", "") for m in r.json().get("data", [])]
        return sorted(i.removeprefix("models/") for i in ids if i)


def _message(r: "httpx.Response") -> str:
    """The provider's own reason, e.g. 'this model is no longer available to new users, use X'."""
    try:
        body = r.json()
        body = body[0] if isinstance(body, list) else body
        return str(body.get("error", {}).get("message", ""))[:300]
    except Exception:
        return r.text[:300]


def parse_json(text: str) -> dict:
    """Models wrap JSON in prose or code fences, or leave trailing commas. Recover what we can."""
    t = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if fence:
        t = fence.group(1).strip()
    start = min([i for i in (t.find("{"), t.find("[")) if i >= 0], default=-1)
    if start > 0:
        t = t[start:]
    for candidate in (t, re.sub(r",\s*([}\]])", r"\1", t)):
        try:
            v = json.loads(candidate)
            return v if isinstance(v, dict) else {"items": v}
        except json.JSONDecodeError:
            continue
    end = max(t.rfind("}"), t.rfind("]"))
    if end > 0:
        try:
            v = json.loads(re.sub(r",\s*([}\]])", r"\1", t[: end + 1]))
            return v if isinstance(v, dict) else {"items": v}
        except json.JSONDecodeError:
            pass
    raise ValueError("model reply was not valid JSON")


def ask_json(provider: "Provider | ReplayProvider", system: str, user: str) -> dict:
    """One call, parsed; on broken JSON, one repair round with the error shown to the model."""
    reply = provider.complete(system, user)
    try:
        return parse_json(reply)
    except ValueError:
        fixed = provider.complete(system, user + "\n\nYour last reply was not valid JSON. Reply with the JSON object only.")
        return parse_json(fixed)


@dataclass
class ReplayProvider:
    """For tests and offline demos: answers from a function of the prompt, no network."""
    answer: Callable[[str, str], str]
    name: str = "replay"
    model: str = "replay"
    usage: Usage = field(default_factory=Usage)

    def complete(self, system: str, user: str, temperature: float = 0.3) -> str:
        self.usage.add({"prompt_tokens": len(user) // 4, "completion_tokens": 50}, 0.0)
        return self.answer(system, user)
