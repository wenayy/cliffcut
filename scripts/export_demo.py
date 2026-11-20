"""Bake the online demo: the web app plus finished runs as static JSON (no server, no keys).

Only shows written for this repo are exported: the demo show and the ex-* test shows. Never Kuku's pack
or uploads. Usage:

    cd web && VITE_DEMO=1 npx vite build --outDir dist-demo && cd ..
    .venv/bin/python scripts/export_demo.py web/dist-demo
    npx wrangler pages deploy web/dist-demo --project-name cliffcut
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

os.environ["CLIFFCUT_KUKU"] = ""          # never load the confidential pack, whatever .env says
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

import server.app as srv  # noqa: E402

PUBLIC = [sid for sid in srv.SHOWS if sid == "sample" or sid.startswith("ex-")]


def num(x: float) -> str:
    """A number spelled the way JavaScript prints it, so the keys match lib.ts checkKey()."""
    return str(int(x)) if float(x).is_integer() else repr(float(x))


def check_key(segments: list[dict], lo: float, hi: float, leads: list[str] | None) -> str:
    return f"{num(lo)}|{num(hi)}|{'L' if leads else ''}|" + ",".join(
        f"{s['episode']}:{s['first']}:{s['last']}::" for s in segments)


def write(root: Path, rel: str, data) -> None:
    p = root / "demo" / f"{rel}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False))


def main(out: Path) -> None:
    for sid in list(srv.SHOWS):
        if sid not in PUBLIC:
            del srv.SHOWS[sid]
    c = TestClient(srv.app)
    shows = c.get("/api/shows").json()
    assert all(s["id"] in PUBLIC for s in shows["shows"])
    write(out, "shows", shows)
    write(out, "providers", {"providers": [{**p, "has_key": False} for p in c.get("/api/providers").json()["providers"]]})
    write(out, "taste", {"decisions": [], "approved": 0, "rejected": 0})
    for sid in PUBLIC:
        show = c.get(f"/api/shows/{sid}").json()
        write(out, f"shows/{sid}", show)
        for e in show["episodes"]:
            write(out, f"shows/{sid}/episodes/{e['number']}", c.get(f"/api/shows/{sid}/episodes/{e['number']}").json())
        runs = c.get(f"/api/shows/{sid}/runs").json()
        runs["runs"] = [r for r in runs["runs"] if r.get("promos") or r.get("trailers")]
        write(out, f"shows/{sid}/runs", runs)
        checks: dict[str, dict] = {}
        for r in runs["runs"]:
            cfg = r.get("config") or {}
            kinds = [(r["promos"], 20, 60, None), (r["teasers"], 8, 20, None),
                     (r.get("trailers") or [], cfg.get("trailer_min") or 60, cfg.get("trailer_max") or 90, r.get("leads"))]
            for items, lo, hi, leads in kinds:
                for p in items:
                    segs = [{"episode": s["episode"], "first": s["first_event"], "last": s["last_event"]} for s in p["segments"]]
                    key = check_key(segs, lo, hi, leads)
                    if key not in checks:
                        checks[key] = c.post(f"/api/shows/{sid}/check", json={"segments": segs, "min": lo, "max": hi, "leads": leads}).json()
        write(out, f"shows/{sid}/checks", checks)
        print(f"{sid}: {len(show['episodes'])} episodes, {len(runs['runs'])} runs, {len(checks)} cuts")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "web/dist-demo"))
