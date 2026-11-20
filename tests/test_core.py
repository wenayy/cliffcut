import os
from pathlib import Path

import pytest

from promo.cuts import Promo, boundaries, build_segment, check_promo, speech_at
from promo.timeline import load_episode, load_show, parse_kuku, seconds, stamp

FIX = Path(__file__).parent / "fixtures" / "mini_episode.txt"


def test_time_round_trip():
    assert seconds("02:17.50") == 137.5
    assert seconds("1:02:03.5") == 3723.5
    assert stamp(137.5) == "02:17.50"


def test_parse_fixture():
    ep = load_episode(FIX)
    assert ep.number == 3
    assert [e.kind for e in ep.events].count("camera") == 5
    mara = next(e for e in ep.events if e.speaker == "MARA")
    assert mara.emotion == "Cold" and mara.text == "You lied to me about the ring."
    assert ep.duration == 30.0
    assert all(e.id.startswith("e03.") for e in ep.events)


def test_rejects_other_formats():
    with pytest.raises(ValueError):
        parse_kuku("INT. HALL - NIGHT\nMARA\nYou lied.\n")


def test_line_crossing_a_shot_boundary_moves_the_cut():
    ep = load_episode(FIX)
    assert 8.0 in boundaries(ep)
    assert speech_at(ep, 8.0) is not None      # Mara is mid-line at the 8.0 shot cut


def test_segment_snaps_to_clean_shot_boundaries():
    ep = load_episode(FIX)
    ids = {e.text: e.id for e in ep.events}
    seg = build_segment(ep, ids["You lied to me about the ring."], ids["Who told you?"])
    assert seg.start == 4.0                     # shot start before the line at 4.5, not 4.5
    assert seg.hook_delay == pytest.approx(0.5)
    assert seg.end == 16.0                      # after the reaction, letting the drone near-finish
    checks = {c.name: c for c in check_promo(Promo([seg]), {3: ep}, lo=5)}
    assert checks["clean_cuts"].ok and checks["hook_in_3s"].ok and checks["length"].ok


LONG_SHOT = """EPISODE NUMBER: Episode 9
--- SCRIPT START ---
SCENE 01
**CAMERA:**
Start: (00:00.00) | End: (00:20.00)
One long held shot.

**ANA (Quiet):**
Start: (00:10.00) | End: (00:12.00)
"It was you."

**CAMERA:**
Start: (00:20.00) | End: (00:24.00)
Close-up.
--- SCRIPT END ---
"""


def test_long_shot_is_trimmed_not_waited_on():
    ep = parse_kuku(LONG_SHOT)
    line = ep.of("dialogue")[0]
    seg = build_segment(ep, line.id, line.id)
    assert seg.start == 9.75 and seg.hook_delay == pytest.approx(0.25)   # head trim, not 10 s of waiting
    assert seg.end == 13.0 and seg.tail == pytest.approx(1.0)            # hold on the reaction
    assert all(c.ok for c in check_promo(Promo([seg]), {9: ep}, lo=0))


def test_flash_frame_is_avoided():
    ep = parse_kuku(LONG_SHOT.replace("(00:10.00) | End: (00:12.00)", "(00:19.60) | End: (00:21.00)"))
    line = ep.of("dialogue")[0]
    seg = build_segment(ep, line.id, line.id)
    assert seg.start == 19.3                                             # 19.35 would leave a 0.65 s flash before the cut at 20
    assert all(c.ok for c in check_promo(Promo([seg]), {9: ep}, lo=0)), check_promo(Promo([seg]), {9: ep}, lo=0)


def test_unknown_event_id_fails_loudly():
    ep = load_episode(FIX)
    with pytest.raises(KeyError):
        build_segment(ep, "e03.999", "e03.001")


PACK = os.environ.get("KUKU_PACK")


@pytest.mark.skipif(not PACK, reason="set KUKU_PACK to the input folder to run on the real pack")
def test_real_pack_numbers():
    eps = load_show(PACK)
    assert len(eps) == 50
    lines = [d for e in eps for d in e.of("dialogue")]
    shots = [c for e in eps for c in e.of("camera")]
    assert len(lines) == 1487 and len(shots) == 1754
    off = sum(1 for e in eps for d in e.of("dialogue")
              if all(abs(d.start - b) > 0.05 for b in boundaries(e)))
    assert off == 1312                           # 88% of lines start mid-shot (not a defect by itself)
    E = {e.number: e for e in eps}
    defects = 0
    for e in eps:
        L = e.of("dialogue")
        for i in range(len(L)):
            for j in (i, min(i + 3, len(L) - 1)):
                seg = build_segment(e, L[i].id, L[j].id)
                c = {x.name: x for x in check_promo(Promo([seg]), E, lo=0, hi=1e9)}
                defects += not c["clean_cuts"].ok
    assert defects == 0                          # no chopped line, no flash frame, anywhere


def test_hindi_screenplay_reads_speakers_and_lines():
    from promo.timeline import load_show
    ep = load_show(Path(__file__).parent.parent / "samples" / "hindi")[0]
    lines = ep.of("dialogue")
    assert ep.source_format == "screenplay" and len(lines) == 5
    assert lines[0].speaker == "रानी माँ" and lines[0].emotion == "गुस्से में"
    assert lines[3].speaker == "वकील"
