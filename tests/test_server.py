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
    monkeypatch.setattr(srv, "taste_path", lambda session="": tmp_path / "taste.json")
    c.post("/api/taste", json={"promo_id": "r1:promo:1", "decision": "approved", "title": "Slap", "note": "great"})
    c.post("/api/taste", json={"promo_id": "r1:promo:2", "decision": "rejected", "title": "Tea", "note": "slow"})
    t = c.post("/api/taste", json={"promo_id": "r1:promo:2", "decision": "draft"}).json()   # undo
    assert t["approved"] == 1 and t["rejected"] == 0
    assert [d["title"] for d in t["decisions"]] == ["Slap"]


def test_render_cuts_the_promo_from_episode_videos(monkeypatch, tmp_path):
    import shutil
    import subprocess
    import pytest
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    monkeypatch.setattr(srv, "VIDEOS", tmp_path / "videos")
    monkeypatch.setattr(srv, "RUNS", tmp_path / "runs")
    clip = tmp_path / "ep01.mp4"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=85",
                    "-f", "lavfi", "-i", "sine=duration=85", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", str(clip)], check=True)
    up = c.post("/api/shows/sample/videos", files=[("files", ("ep01.mp4", clip.open("rb"), "video/mp4"))]).json()
    assert up["episodes"] == [1]
    ep = c.get("/api/shows/sample/episodes/1").json()
    L = [e["id"] for e in ep["events"] if e["kind"] == "dialogue"]
    r = c.post("/api/shows/sample/render", json={"segments": [{"episode": 1, "first": L[0], "last": L[2]}, {"episode": 1, "first": L[4], "last": L[5]}], "title": "Test cut"})
    assert r.status_code == 200 and r.headers["content-type"] == "video/mp4"
    out = tmp_path / "out.mp4"
    out.write_bytes(r.content)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)], capture_output=True, text=True).stdout)
    plan = c.post("/api/shows/sample/check", json={"segments": [{"episode": 1, "first": L[0], "last": L[2]}, {"episode": 1, "first": L[4], "last": L[5]}]}).json()
    assert abs(dur - plan["length"]) < 0.3        # the MP4 is exactly the planned cut
    missing = c.post("/api/shows/sample/render", json={"segments": [{"episode": 2, "first": "e02.002", "last": "e02.004"}]})
    assert missing.status_code == 422 and "episode 2" in missing.json()["detail"]


# ---------------------------------------------------------------- the public test server

def _public(monkeypatch, tmp_path):
    monkeypatch.setattr(srv, "PUBLIC", True)
    monkeypatch.setattr(srv, "UPLOADS", tmp_path / "uploads")
    monkeypatch.setattr(srv, "RUNS", tmp_path / "runs")
    monkeypatch.setattr(srv, "SHOWS", {k: v for k, v in srv.SHOWS.items() if k == "sample"})


def _up(session):
    return c.post("/api/upload", files=[("files", ("night-nurse.fountain", io.BytesIO(FOUNTAIN), "text/plain"))],
                  headers={"x-session": session})


def test_public_server_needs_the_visitors_own_key(monkeypatch, tmp_path):
    _public(monkeypatch, tmp_path)
    monkeypatch.setenv("OPENAI_API_KEY", "server-key-must-not-be-used")
    r = c.post("/api/shows/sample/runs", json={"provider": "openai"}, headers={"x-session": "a"})
    assert r.status_code == 400 and "own API key" in r.json()["detail"]
    assert c.get("/api/config").json() == {"public": True}


def test_public_uploads_are_private_to_the_visitor(monkeypatch, tmp_path):
    _public(monkeypatch, tmp_path)
    sid = _up("visitorA").json()["id"]
    assert len(sid) == len("up-") + 16
    mine = {s["id"] for s in c.get("/api/shows", headers={"x-session": "visitorA"}).json()["shows"]}
    theirs = {s["id"] for s in c.get("/api/shows", headers={"x-session": "visitorB"}).json()["shows"]}
    assert sid in mine and sid not in theirs and "sample" in theirs


def test_public_limits_and_video_off(monkeypatch, tmp_path):
    _public(monkeypatch, tmp_path)
    for _ in range(srv.MAX_UPLOADS_PER_SESSION):
        assert _up("busy").status_code == 200
    assert _up("busy").status_code == 429
    big = c.post("/api/upload", files=[("files", (f"e{i}.txt", io.BytesIO(b"x" * 1_900_000), "text/plain")) for i in range(5)],
                 headers={"x-session": "big"})
    assert big.status_code == 422 and "8 MB" in big.json()["detail"]
    assert c.post("/api/shows/sample/videos", files=[("files", ("ep1.mp4", io.BytesIO(b"x"), "video/mp4"))]).status_code == 403
    assert c.post("/api/shows/sample/render", json={"segments": []}).status_code == 403


def test_public_runs_are_saved_per_visitor(monkeypatch, tmp_path):
    _public(monkeypatch, tmp_path)
    assert srv.run_dir("sample", "a") != srv.run_dir("sample", "b")
    assert "sessions" in srv.run_dir("sample", "a").parts
