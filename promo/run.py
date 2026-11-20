"""Command line: run the whole pipeline on a show folder and save the run.

  .venv/bin/python -m promo.run --show "<folder>" --provider gemini [--model gemini-2.5-flash] [--episodes 1-5]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .pipeline import RunConfig, run_show, save
from .providers import Provider, ProviderError
from .timeline import load_show

ROOT = Path(__file__).resolve().parent.parent


def load_env(path: Path = ROOT / ".env") -> None:
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                if v.strip():   # an empty KEY= line means "not set", not an empty key
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def episodes_arg(s: str | None) -> list[int] | None:
    if not s:
        return None
    out: list[int] = []
    for part in s.split(","):
        a, _, b = part.partition("-")
        out += list(range(int(a), int(b or a) + 1))
    return out


def main() -> int:
    load_env()
    ap = argparse.ArgumentParser(description="Find promos in a show's scripts")
    ap.add_argument("--show", required=True)
    ap.add_argument("--provider", default="gemini")
    ap.add_argument("--model")
    ap.add_argument("--base-url")
    ap.add_argument("--episodes")
    ap.add_argument("--concurrency", type=int)
    ap.add_argument("--brief", default="", help="what the editor wants this run to focus on")
    ap.add_argument("--language", default="English", help="language for titles, hooks and reasons")
    ap.add_argument("--genre", default="")
    ap.add_argument("--out", default=str(ROOT / "runs"))
    a = ap.parse_args()
    try:
        prov = Provider.from_preset(a.provider, a.model, base_url=a.base_url, cache_dir=Path(a.out) / "cache")
        eps = {e.number: e for e in load_show(a.show, provider=prov)}
        run = run_show(prov, eps, Path(a.show).name,
                       RunConfig(episodes=episodes_arg(a.episodes), concurrency=a.concurrency, brief=a.brief,
                                 language=a.language, genre=a.genre),
                       progress=lambda st, k, n, m: print(f"\r{st:6} {k}/{n} {m:40}", end="", file=sys.stderr))
    except ProviderError as e:
        print(f"\n{e}", file=sys.stderr)
        return 2
    path = save(run, a.out)
    s = run["stats"]
    print(f"\n{len(run['promos'])} promos, {len(run['teasers'])} teasers, {len(run['rejected'])} rejected; "
          f"{s['calls']} calls, {s['prompt_tokens'] + s['completion_tokens']:,} tokens, {s['wall_seconds']} s -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
