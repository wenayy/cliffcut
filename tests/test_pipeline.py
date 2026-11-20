"""Pipeline tests with a replayed model: no network, deterministic, cover every stage."""
import json
import re
from pathlib import Path

import httpx
import pytest

from promo.pipeline import COLD_SYSTEM, FIND_SYSTEM, GUARD_SYSTEM, STITCH_SYSTEM, RunConfig, rank, run_show
from promo.providers import Provider, ProviderError, ReplayProvider, parse_json
from promo.timeline import load_show

SAMPLE = Path(__file__).parent.parent / "samples" / "sample-show"
EPS = {e.number: e for e in load_show(SAMPLE)}


def lines(n):
    return [e.id for e in EPS[n].of("dialogue")]


def fake_model(short_first=False):
    calls = {"find": 0}

    def answer(system: str, user: str) -> str:
        if system == FIND_SYSTEM:
            n = int(re.search(r"THIS EPISODE (\d+)", user).group(1))
            L = lines(n)
            calls["find"] += 1
            failed_before = "FAILED" in user
            last = L[0] if (short_first and n == 1 and not failed_before) else L[6]
            return json.dumps({
                "promos": [{"title": f"Ep {n} reveal", "segments": [{"first": L[0], "last": last}],
                            "hook": "a humiliating line", "cliffhanger": "who is she really",
                            "why": "status flip", "hook_type": "humiliation_revenge" if n != 2 else "forced_marriage",
                            "scores": {"hook": 8, "cliffhanger": 7, "standalone": 7, "emotion": 8, "clarity": 7}},
                           {"title": "bad ids", "segments": [{"first": "e99.001", "last": "e99.002"}],
                            "hook_type": "nonsense", "scores": {}}],
                "teaser": {"first": L[1], "last": L[2], "line": "a question", "why": "opens a question"},
            })
        if system.startswith("You cut WHOLE-SHOW TRAILERS"):
            return json.dumps({"trailers": [{"title": "Maid to heiress to bride",
                                           "segments": [{"first": lines(1)[3], "last": lines(1)[6]},
                                                        {"first": lines(2)[3], "last": lines(2)[5]},
                                                        {"first": lines(3)[0], "last": lines(3)[2]}],
                                           "hook_type": "identity_reversal",
                                           "scores": {"hook": 9, "cliffhanger": 8, "standalone": 6, "emotion": 8, "clarity": 6}}]})
        if system.startswith("You map a serial drama"):
            return '{"opportunity":1,"change_of_plans":2,"point_of_no_return":2,"major_setback":3,"climax":3,"mood":"tense","themes":["class"]}'
        if system == COLD_SYSTEM:
            return '```json\n{"who_to_root_for":"the maid","stakes":"the house","open_question":"is she the heir","understandable":true,"swipe_second":null}\n```'
        if system == GUARD_SYSTEM:
            return '{"cliffhanger_open": true, "cliffhanger_reason": "answer comes later", "spoiler": false, "spoiler_reason": "",}'
        raise AssertionError("unexpected prompt")
    return answer, calls


def test_full_run_on_sample_show():
    answer, _ = fake_model()
    run = run_show(ReplayProvider(answer), EPS, "Sample", RunConfig(concurrency=2, trailer_min=20, trailer_max=60))
    assert run["errors"] == []
    assert run["promos"], "expected ranked promos"
    ranks = [p["rank"] for p in run["promos"]]
    assert ranks == list(range(1, len(ranks) + 1))
    for p in run["promos"]:
        assert 20 <= p["length"] <= 60
        assert all(c["ok"] for c in p["checks"])
        assert p["ai_checks"]["cliffhanger_open"] is True
        assert p["hook_type"] in ("identity_reversal", "forced_marriage", "humiliation_revenge", "forbidden_romance", "other")
    assert run["trailers"] and all(len({s["episode"] for s in t["segments"]}) >= 2 for t in run["trailers"]), "a whole-show trailer should survive"
    assert any("unknown or mismatched" in "; ".join(r["problems"]) for r in run["rejected"]), "bad ids are rejected, not crashed"
    assert [t["for_episode"] for t in run["teasers"]] == [1, 2]
    for t in run["teasers"]:
        assert {c["name"] for c in t["checks"]} >= {"length", "no_ending"}
    json.dumps(run)   # the run is plain JSON (no private objects leak)


def test_failed_candidate_goes_back_once_with_the_reason():
    answer, calls = fake_model(short_first=True)
    run = run_show(ReplayProvider(answer), {1: EPS[1], 2: EPS[2]}, "Sample", RunConfig(stitch=False, judge=False))
    assert calls["find"] == 4                    # 2 episodes + 1 repair each (both had a bad-id pick)
    assert any(p.get("repaired") for p in run["promos"])
    assert run["stats"]["repaired"] >= 1


def test_rank_spreads_hook_types_and_drops_duplicates():
    def item(title, ht, hook, ep=1, start=0.0):
        from promo.cuts import Segment
        seg = Segment(ep, "a", "b", start, start + 30, 0, 1)
        return {"title": title, "hook_type": ht, "source_episode": ep, "length": 30, "_segs": [seg],
                "scores": {"hook": hook, "cliffhanger": 7, "standalone": 7, "emotion": 7, "clarity": 7}}
    pool = [item("A", "humiliation_revenge", 9, 1, 0), item("A-dup", "humiliation_revenge", 8.9, 1, 5),
            item("B", "humiliation_revenge", 8.5, 2, 0), item("C", "forced_marriage", 8.2, 3, 0)]
    out = [p["title"] for p in rank(pool)]
    assert "A-dup" not in out                    # overlaps A
    assert out.index("C") < out.index("B")       # a new angle beats a third of the same angle


def test_parse_json_recovers_common_model_mess():
    assert parse_json('Sure! ```json\n{"a": [1, 2,],}\n```') == {"a": [1, 2]}
    assert parse_json('Here you go: {"x": 1} hope that helps') == {"x": 1}
    with pytest.raises(ValueError):
        parse_json("no json here")


def test_provider_retries_rate_limits_and_reports_bad_keys(monkeypatch, tmp_path):
    replies = [httpx.Response(429, headers={"retry-after": "0"}),
               httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": 1}'}}],
                                         "usage": {"prompt_tokens": 10, "completion_tokens": 2}})]
    monkeypatch.setattr(httpx, "post", lambda *a, **k: replies.pop(0))
    p = Provider("test", "m", "https://example.invalid/v1", "k", cache_dir=tmp_path, sleep=lambda s: None)
    assert p.complete("s", "u") == '{"ok": 1}'
    assert p.usage.retries == 1 and p.usage.prompt_tokens == 10
    assert p.complete("s", "u") == '{"ok": 1}' and p.usage.cached == 1     # second time from cache, no call
    monkeypatch.setattr(httpx, "post", lambda *a, **k: httpx.Response(401))
    with pytest.raises(ProviderError, match="key was rejected"):
        Provider("test", "m", "https://example.invalid/v1", "k", sleep=lambda s: None).complete("s", "x")


def test_missing_key_is_a_clear_error(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("CLIFFCUT_API_KEY", raising=False)
    with pytest.raises(ProviderError, match="GROQ_API_KEY"):
        Provider.from_preset("groq")


def test_screenplay_format_runs_through_the_same_pipeline():
    other = {e.number: e for e in load_show(SAMPLE.parent / "other-format")}
    assert all(e.source_format == "screenplay" for e in other.values())
    L = [e.id for e in other[1].of("dialogue")]

    def answer(system, user):
        if system == FIND_SYSTEM:
            return json.dumps({"promos": [{"title": "The will", "segments": [{"first": L[0], "last": L[-1]}],
                                           "hook_type": "identity_reversal", "scores": {"hook": 8}}]})
        return "{}"
    run = run_show(ReplayProvider(answer), other, "Night Nurse", RunConfig(stitch=False, judge=False))
    assert run["promos"] and all(c["ok"] for c in run["promos"][0]["checks"])


def test_editor_brief_and_past_decisions_reach_the_model():
    seen = []

    def answer(system, user):
        seen.append(user)
        return json.dumps({"promos": []})
    taste = [{"decision": "approved", "title": "Slap at the altar", "hook": "the slap", "cliffhanger": "who is he", "note": "more of these"},
             {"decision": "rejected", "title": "Quiet tea", "hook": "tea", "note": "too slow"}]
    run_show(ReplayProvider(answer), {1: EPS[1]}, "Sample",
             RunConfig(stitch=False, judge=False, brief="Focus on the maid's revenge", taste=taste))
    assert "EDITOR BRIEF" in seen[0] and "Focus on the maid's revenge" in seen[0]
    assert "APPROVED: Slap at the altar" in seen[0] and "REJECTED: Quiet tea" in seen[0] and "too slow" in seen[0]


def test_providers_config_adds_models_without_code(monkeypatch):
    from promo import providers as pv
    assert {"gemini", "groq", "openai", "claude"} <= set(pv.PRESETS)
    claude = pv.Provider.from_preset("claude", api_key="test-key")
    assert type(claude).__name__ == "AnthropicProvider" and claude.model == "claude-opus-5-5"
    monkeypatch.setitem(pv.PRESETS, "mymodel", {"api": "openai", "base_url": "https://x.example/v1", "model": "m1", "key_env": "MY_KEY"})
    monkeypatch.setenv("MY_KEY", "k")
    p = pv.Provider.from_preset("mymodel")
    assert p.base_url == "https://x.example/v1" and p.model == "m1"


def test_model_that_rejects_temperature_is_retried_without_it(monkeypatch):
    sent = []

    def post(url, json, **k):
        sent.append(dict(json))
        if "temperature" in json:
            return httpx.Response(400, json={"error": {"message": "Unsupported value: 'temperature' does not support 0.3 with this model."}})
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": 1}'}}], "usage": {}})
    monkeypatch.setattr(httpx, "post", post)
    p = Provider("openai", "gpt-5.6-sol", "https://example.invalid/v1", "k", sleep=lambda s: None)
    assert p.complete("s", "a") == '{"ok": 1}' and p.complete("s", "b") == '{"ok": 1}'
    assert "temperature" not in sent[-1] and len(sent) == 3      # one failed try, then remembered


def test_over_long_trailer_is_trimmed_in_the_middle_not_at_the_hook_or_cliffhanger():
    from promo.pipeline import fit_pieces
    L1, L2, L3 = lines(1), lines(2), lines(3)
    raw = {"segments": [{"first": L1[0], "last": L1[7]}, {"first": L2[0], "last": L2[7]}, {"first": L3[0], "last": L3[3]}]}
    item = fit_pieces(raw, EPS, 20, 60)
    assert item["code_ok"] and item["length"] <= 60 and item["fitted"]
    segs = item["segments"]
    assert segs[0]["first_event"] == L1[0] and segs[-1]["last_event"] == L3[3]   # hook and cliffhanger kept


def test_leads_are_detected_and_named_in_the_prompt():
    from promo.pipeline import main_characters
    leads = main_characters(EPS)
    assert "MIRA" in leads and "CELESTE" in leads
    seen = []
    run_show(ReplayProvider(lambda s, u: seen.append(u) or json.dumps({"promos": []})), {1: EPS[1]}, "S", RunConfig(stitch=False, judge=False))
    assert "LEAD CHARACTERS:" in seen[0] and "MIRA" in seen[0]


def test_scores_come_from_evidence_and_measurements_not_model_numbers():
    from promo.pipeline import build
    from promo.rubric import apply_rubric
    L = lines(1)   # sample ep1: Celeste mocks Mira ... Hale reveals the heir
    item = build({"segments": [{"first": L[0], "last": L[6]}]}, EPS, 20, 60)
    item["evidence"] = {"opens_on": L[0], "conflict_type": "humiliation", "ends_on": L[6],
                        "open_question": "Is the maid really the heir?", "needs_backstory": False,
                        "stakes": "Mira could lose her place, or gain the house", "power_shift": True}
    apply_rubric(item, EPS, ["MIRA", "CELESTE"])
    assert item["scores"]["hook"] >= 8 and item["scores"]["emotion"] >= 6
    assert all("why" in b and b["max"] > 0 for b in item["breakdown"])
    weak = build({"segments": [{"first": L[0], "last": L[6]}]}, EPS, 20, 60) | {"evidence": {}}
    apply_rubric(weak, EPS, [])
    assert weak["scores"]["hook"] < item["scores"]["hook"]          # no evidence, fewer points
    assert any("No charged opening" in b["why"] for b in weak["breakdown"])


def test_a_promo_just_under_the_minimum_is_started_earlier_not_cut_later():
    from promo.pipeline import build
    from promo.timeline import load_show
    eps = {e.number: e for e in load_show(Path(__file__).parent.parent / "samples" / "sample-show")}
    ep = eps[1]
    lines = ep.of("dialogue")
    # find a span of lines that is a little under 20 s
    for i in range(3, len(lines)):
        for j in range(i, len(lines)):
            raw = {"segments": [{"first": lines[i].id, "last": lines[j].id}]}
            plain = build.__globals__["_build"](raw, eps, 20, 60)
            if [c["name"] for c in plain["checks"] if not c["ok"]] == ["length"] and 17 < plain["length"] < 20:
                out = build(raw, eps, 20, 60)
                assert out["code_ok"] and out["stretched"]
                assert out["segments"][-1]["end"] == plain["segments"][-1]["end"]     # the cliffhanger cut is untouched
                return
    import pytest
    pytest.skip("no near-miss span in the sample")
