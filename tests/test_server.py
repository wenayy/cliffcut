import io
import json
from pathlib import Path

from fastapi.testclient import TestClient

import server.app as srv
from promo.pipeline import FIND_SYSTEM
from promo.providers import ReplayProvider

c = TestClient(srv.app)
FOUNTAIN = (Path(__file__).parent.parent / "samples" / "other-format" / "new-show.fountain").read_bytes()


def test_sample_show_and_live_check():
    shows = c.get("/api/shows").json()["shows"]
    assert any(s["id"] == "sample" for s in shows)
    ep = c.get("/api/shows/sample/episodes/1").json()
    lines = [e["id"] for e in ep["events"] if e["kind"] == "dialogue"]
    r = c.post("/api/shows/sample/check", json={"segments": [{"episode": 1, "first": lines[0], "last": lines[6]}]}).json()
    assert {x["name"] for x in r["checks"]} == {"length", "hook_in_3s", "ends_on_reaction", "clean_cuts"}
    bad = c.post("/api/shows/sample/check", json={"segments": [{"episode": 1, "first": "e01.999", "last": "e01.001"}]})
    assert bad.status_code == 422


def test_upload_unseen_format_then_run_with_a_model(monkeypatch, tmp_path):
    monkeypatch.setattr(srv, "UPLOADS", tmp_path / "uploads")
    monkeypatch.setattr(srv, "RUNS", tmp_path / "runs")
    up = c.post("/api/upload", files=[("files", ("night-nurse.fountain", io.BytesIO(FOUNTAIN), "text/plain"))]).json()
    assert up["episodes"] == 2 and up["formats"] == ["screenplay"]
    sid = up["id"]
    ep = c.get(f"/api/shows/{sid}/episodes/1").json()
    L = [e["id"] for e in ep["events"] if e["kind"] == "dialogue"]

    def answer(system, user):
        if system == FIND_SYSTEM:
            return json.dumps({"promos": [{"title": "The will", "segments": [{"first": L[0], "last": L[-1]}],
                                           "hook_type": "identity_reversal", "scores": {"hook": 8}}]})
        return "{}"
    monkeypatch.setattr(srv, "make_provider", lambda p: ReplayProvider(answer))
    job = c.post(f"/api/shows/{sid}/runs", json={"provider": "replay", "episodes": [1], "judge": False, "stitch": False}).json()
    for _ in range(200):
        j = c.get(f"/api/jobs/{job['id']}").json()
        if j["status"] != "running":
            break
        import time; time.sleep(0.02)
    assert j["status"] == "done", j
    runs = c.get(f"/api/shows/{sid}/runs").json()["runs"]
    assert runs[0]["promos"][0]["title"] == "The will"


def test_locked_show_needs_passcode(monkeypatch, tmp_path):
    monkeypatch.setitem(srv.SHOWS, "secret", {"path": tmp_path, "title": "x", "locked": True, "note": ""})
    monkeypatch.setattr(srv, "PASSCODE", "open-sesame")
    assert c.get("/api/shows/secret").status_code == 401
    assert c.get("/api/shows/secret", headers={"x-passcode": "wrong"}).status_code == 401


def test_missing_key_is_a_400_with_the_reason(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("CLIFFCUT_API_KEY", raising=False)
    r = c.post("/api/shows/sample/runs", json={"provider": "groq"})
    assert r.status_code == 400 and "GROQ_API_KEY" in r.json()["detail"]


def test_editor_decisions_are_remembered(monkeypatch, tmp_path):
    monkeypatch.setattr(srv, "TASTE", tmp_path / "taste.json")
    c.post("/api/taste", json={"promo_id": "r1:promo:1", "decision": "approved", "title": "Slap", "note": "great"})
    c.post("/api/taste", json={"promo_id": "r1:promo:2", "decision": "rejected", "title": "Tea", "note": "slow"})
    t = c.post("/api/taste", json={"promo_id": "r1:promo:2", "decision": "draft"}).json()   # undo
    assert t["approved"] == 1 and t["rejected"] == 0
    assert [d["title"] for d in t["decisions"]] == ["Slap"]
