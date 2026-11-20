"""Cliffcut API.

  .venv/bin/uvicorn server.app:app --port 8790

Shows:
- "sample": samples/sample-show, our own script, always public.
- "kuku": the folder in CLIFFCUT_KUKU (local only), locked behind CLIFFCUT_PASSCODE when that is set.
- uploads: any scripts dropped into the app (kept in uploads/, never committed).
Keys come from .env; a key typed into the app is used for that request only and never stored or logged.
"""
from __future__ import annotations

import hmac
import json
import os
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from promo.cuts import PROMO_MAX, PROMO_MIN, Promo, Segment, build_segment, check_promo, clean_boundaries
from promo.pipeline import RunConfig, main_characters, run_show, save
from promo.providers import PRESETS, Provider, ProviderError
from promo.run import load_env
from promo.timeline import Episode, load_show

ROOT = Path(__file__).resolve().parent.parent
load_env()
RUNS = Path(os.environ.get("CLIFFCUT_RUNS", ROOT / "runs"))
UPLOADS = ROOT / "uploads"
PASSCODE = os.environ.get("CLIFFCUT_PASSCODE", "")

app = FastAPI(title="Cliffcut")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                   allow_methods=["*"], allow_headers=["*"])

# ------------------------------------------------------------------ shows

SHOWS: dict[str, dict] = {"sample": {"path": ROOT / "samples" / "sample-show", "title": "The Maid Who Owned the House",
                                     "locked": False, "note": "Sample show written for this demo"}}
if os.environ.get("CLIFFCUT_KUKU"):
    SHOWS["kuku"] = {"path": Path(os.environ["CLIFFCUT_KUKU"]), "title": Path(os.environ["CLIFFCUT_KUKU"]).name,
                     "locked": bool(PASSCODE), "note": "Kuku's input pack (confidential)"}
if UPLOADS.is_dir():
    for d in sorted(UPLOADS.iterdir()):
        meta = d / "meta.json"
        if meta.exists():
            m = json.loads(meta.read_text())
            SHOWS[d.name] = {"path": d / "scripts", "title": m.get("title", d.name), "locked": False, "note": "Uploaded"}

_cache: dict[str, dict[int, Episode]] = {}
_lock = threading.Lock()


def episodes(sid: str, passcode: str | None) -> dict[int, Episode]:
    s = SHOWS.get(sid)
    if not s:
        raise HTTPException(404, f"No show '{sid}'")
    if s["locked"] and not hmac.compare_digest(passcode or "", PASSCODE):
        raise HTTPException(401, "This show needs the passcode")
    with _lock:
        if sid not in _cache:
            try:
                _cache[sid] = {e.number: e for e in load_show(s["path"])}
            except (OSError, ValueError) as err:
                raise HTTPException(422, f"Could not read the scripts: {err}") from err
        return _cache[sid]


@app.get("/api/shows")
def list_shows():
    return {"shows": [{"id": k, "title": v["title"], "locked": v["locked"], "note": v["note"]} for k, v in SHOWS.items()]}


@app.get("/api/shows/{sid}")
def get_show(sid: str, x_passcode: str | None = Header(None)):
    eps = episodes(sid, x_passcode)
    return {
        "id": sid, "title": SHOWS[sid]["title"],
        "episodes": [{"number": e.number, "title": e.title, "logline": e.logline, "duration": round(e.duration, 2),
                      "shots": len(e.of("camera")), "lines": len(e.of("dialogue")), "format": e.source_format}
                     for e in eps.values()],
        "rules": {"promo_min": PROMO_MIN, "promo_max": PROMO_MAX},
        "leads": main_characters(eps),
    }


@app.get("/api/shows/{sid}/episodes/{n}")
def get_episode(sid: str, n: int, x_passcode: str | None = Header(None)):
    eps = episodes(sid, x_passcode)
    if n not in eps:
        raise HTTPException(404, f"No episode {n}")
    e = eps[n]
    return {"number": e.number, "title": e.title, "logline": e.logline, "continuity": e.continuity,
            "duration": round(e.duration, 2), "format": e.source_format,
            "events": [{"id": v.id, "kind": v.kind, "start": v.start, "end": v.end, "text": v.text,
                        "speaker": v.speaker, "emotion": v.emotion, "scene": v.scene} for v in e.events],
            "clean_cuts": clean_boundaries(e)}


# ------------------------------------------------------------------ live checks

class SegmentIn(BaseModel):
    episode: int
    first: str
    last: str
    start: float | None = None
    end: float | None = None


class CheckIn(BaseModel):
    segments: list[SegmentIn]
    min: float = PROMO_MIN
    max: float = PROMO_MAX


@app.post("/api/shows/{sid}/check")
def check(sid: str, body: CheckIn, x_passcode: str | None = Header(None)):
    eps = episodes(sid, x_passcode)
    segs: list[Segment] = []
    for s in body.segments:
        if s.episode not in eps:
            raise HTTPException(422, f"No episode {s.episode}")
        e = eps[s.episode]
        try:
            seg = build_segment(e, s.first, s.last)
        except KeyError as err:
            raise HTTPException(422, str(err)) from err
        if s.start is not None or s.end is not None:   # an editor's nudge, checked like anything else
            start = s.start if s.start is not None else seg.start
            end = s.end if s.end is not None else seg.end
            first = e.by_id()[seg.first]
            spoken = [d.end for d in e.of("dialogue") if start - 0.011 <= d.start < end]
            seg = Segment(e.number, seg.first, seg.last, round(start, 2), round(end, 2),
                          first.start - start, end - max(spoken) if spoken else 0.0)
        segs.append(seg)
    checks = check_promo(Promo(segs), eps, lo=body.min, hi=body.max) if segs else []
    return {"segments": [s.as_dict() for s in segs], "length": round(sum(s.length for s in segs), 2),
            "checks": [{"name": c.name, "ok": c.ok, "detail": c.detail} for c in checks]}


# ------------------------------------------------------------------ upload

@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...), title: str = Form("")):
    if not files or len(files) > 200:
        raise HTTPException(422, "Upload between 1 and 200 script files")
    sid = "up-" + uuid.uuid4().hex[:8]
    folder = UPLOADS / sid / "scripts"
    folder.mkdir(parents=True)
    for i, f in enumerate(files):
        raw = await f.read()
        if len(raw) > 2_000_000:
            raise HTTPException(422, f"{f.filename} is over 2 MB")
        name = Path(f.filename or f"script-{i}.txt").name
        (folder / (name if Path(name).suffix else name + ".txt")).write_bytes(raw)
    try:
        eps = load_show(folder)
    except ValueError as err:
        raise HTTPException(422, f"Could not read the scripts: {err}") from err
    show_title = title.strip() or (eps[0].title if eps and eps[0].source_format != "kuku" else f"Upload {sid[3:]}")
    (UPLOADS / sid / "meta.json").write_text(json.dumps({"title": show_title}))
    SHOWS[sid] = {"path": folder, "title": show_title, "locked": False, "note": "Uploaded"}
    _cache[sid] = {e.number: e for e in eps}
    return {"id": sid, "title": show_title, "episodes": len(eps),
            "formats": sorted({e.source_format for e in eps})}


# ------------------------------------------------------------------ models and runs

@app.get("/api/providers")
def providers():
    return {"providers": [{"id": k, "model": v.get("model", ""), "base_url": v.get("base_url", ""), "api": v.get("api", "openai"),
                           "has_key": bool(os.environ.get(v.get("key_env", "")))} for k, v in PRESETS.items()]}


class ProviderIn(BaseModel):
    provider: str = "gemini"
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None


def make_provider(p: ProviderIn):
    try:
        return Provider.from_preset(p.provider, p.model, api_key=p.api_key or None,
                                    base_url=p.base_url or None, cache_dir=RUNS / "cache")
    except ProviderError as err:
        raise HTTPException(400, str(err)) from err


@app.post("/api/models")
def models(p: ProviderIn):
    try:
        skip = ("tts", "whisper", "image", "embed", "audio", "guard", "orpheus", "transcribe", "realtime",
                "moderation", "dall-e", "search", "computer", "veo", "imagen", "lyria", "aqa", "live", "native")
        return {"models": [m for m in make_provider(p).list_models() if not any(k in m.lower() for k in skip)]}
    except ProviderError as err:
        raise HTTPException(400, str(err)) from err
    except Exception as err:
        raise HTTPException(502, f"Could not list models: {err}") from err


class RunIn(ProviderIn):
    episodes: list[int] | None = None
    judge: bool = True
    stitch: bool = True
    brief: str = ""
    use_taste: bool = True
    genre: str = ""
    teasers: bool = True
    trailer_min: float = 60.0
    trailer_max: float = 90.0
    language: str = "English"
    leads: list[str] | None = None


# ------------------------------------------------------------------ the editor's taste

TASTE = RUNS / "taste.json"


def read_taste() -> list[dict]:
    try:
        return json.loads(TASTE.read_text())
    except (OSError, json.JSONDecodeError):
        return []


class Decision(BaseModel):
    promo_id: str
    decision: str            # approved | rejected | draft (undo)
    title: str = ""
    hook: str = ""
    cliffhanger: str = ""
    hook_type: str = ""
    note: str = ""
    show: str = ""


@app.get("/api/taste")
def get_taste():
    t = read_taste()
    return {"decisions": t, "approved": sum(1 for d in t if d["decision"] == "approved"),
            "rejected": sum(1 for d in t if d["decision"] == "rejected")}


@app.post("/api/taste")
def record(d: Decision):
    """Every approve or reject is remembered; the next run sees them as examples of this editor's taste."""
    t = [x for x in read_taste() if x["promo_id"] != d.promo_id]
    if d.decision in ("approved", "rejected"):
        t.append(d.model_dump() | {"at": time.strftime("%Y-%m-%dT%H:%M:%S")})
    TASTE.parent.mkdir(parents=True, exist_ok=True)
    TASTE.write_text(json.dumps(t[-200:], indent=1, ensure_ascii=False))
    return get_taste()


JOBS: dict[str, dict] = {}


@app.post("/api/shows/{sid}/runs")
def start_run(sid: str, body: RunIn, x_passcode: str | None = Header(None)):
    eps = episodes(sid, x_passcode)
    prov = make_provider(body)
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "show": sid, "status": "running", "stage": "find", "done": 0, "total": 0,
           "message": "Starting", "provider": prov.name, "model": prov.model, "started": time.time()}
    JOBS[jid] = job

    def progress(stage: str, done: int, total: int, msg: str) -> None:
        job.update(stage=stage, done=done, total=total, message=msg)

    def work() -> None:
        try:
            run = run_show(prov, eps, SHOWS[sid]["title"],
                           RunConfig(episodes=body.episodes, judge=body.judge, stitch=body.stitch,
                                     brief=body.brief, taste=read_taste() if body.use_taste else None,
                                     genre=body.genre, teasers=body.teasers, trailer_min=body.trailer_min,
                                     trailer_max=body.trailer_max, language=body.language,
                                     leads=[x.strip().upper() for x in body.leads if x.strip()] if body.leads else None), progress)
            run["show_id"] = sid
            save(run, RUNS / sid)
            job.update(status="done", run_id=run["id"], message=f"{len(run['promos'])} promos")
        except ProviderError as err:
            job.update(status="error", error=str(err))
        except Exception as err:
            job.update(status="error", error=f"{type(err).__name__}: {err}")

    threading.Thread(target=work, daemon=True).start()
    return job


@app.get("/api/jobs/{jid}")
def get_job(jid: str):
    if jid not in JOBS:
        raise HTTPException(404, "No such job")
    return JOBS[jid]


def _runs(sid: str) -> list[dict]:
    d = RUNS / sid
    out = []
    for p in sorted(d.glob("*.json"), reverse=True) if d.is_dir() else []:
        try:
            out.append(json.loads(p.read_text()))
        except json.JSONDecodeError:
            continue
    return out


@app.get("/api/shows/{sid}/runs")
def list_runs(sid: str, x_passcode: str | None = Header(None)):
    episodes(sid, x_passcode)
    runs = _runs(sid)
    return {"runs": runs, "agreement": agreement(runs)}


def _spans(p: dict) -> list[tuple[int, float, float]]:
    return [(s["episode"], s["start_s"], s["end_s"]) for s in p.get("segments", [])]


def _same(a: dict, b: dict) -> bool:
    for ea, sa, xa in _spans(a):
        for eb, sb, xb in _spans(b):
            if ea == eb and min(xa, xb) - max(sa, sb) > 0.4 * min(xa - sa, xb - sb):
                return True
    return False


def agreement(runs: list[dict], top: int = 10) -> dict:
    """How often each model's top promos were also found by the other models."""
    latest: dict[str, dict] = {}
    for r in runs:   # newest run per provider/model
        latest.setdefault(f"{r['provider']}/{r['model']}", r)
    keys = list(latest)
    matrix = {a: {b: None for b in keys} for a in keys}
    for a in keys:
        A = latest[a]["promos"][:top]
        for b in keys:
            if a != b and A:
                matrix[a][b] = round(sum(1 for p in A if any(_same(p, q) for q in latest[b]["promos"])) / len(A), 2)
    found_by: dict[str, dict[int, int]] = {}
    for a in keys:
        found_by[latest[a]["id"]] = {p["rank"]: 1 + sum(1 for b in keys if b != a and any(_same(p, q) for q in latest[b]["promos"]))
                                     for p in latest[a]["promos"]}
    return {"models": keys, "matrix": matrix, "found_by": found_by}


# ------------------------------------------------------------------ static app (deploy)

DIST = ROOT / "web" / "dist"
if DIST.is_dir():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
