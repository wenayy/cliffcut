"""Scores that can be checked, not vibes.

The model never writes a number. It answers concrete questions with evidence from the script
(which event it opens on, what conflict that is, which event it cuts on, the exact question left
open, whether backstory is needed, whether power shifts). Code then awards fixed points for those
answers and for things it measures itself: how fast the hook lands, intense emotion tags and
actions in the script, how many people speak, whether a lead is present, length, pieces, the
reaction hold, and the independent judge models' verdicts.

Every point comes with a reason the editor can read.
"""
from __future__ import annotations

import re

from .timeline import Episode

STRONG_CONFLICT = {"accusation", "humiliation", "reveal", "threat", "violence", "rejection", "confession", "betrayal"}

# intensity read straight from the script: emotion tags, and actions/sounds that play as a jolt
HOT_EMOTION = re.compile(
    r"furious|enraged|livid|hysteri|desperat|terrif|horrif|panic|frantic|scream|sob|weep|tear|trembl|shak|"
    r"devastat|heartbroken|shock|gasp|menac|cruel|venom|vicious|seeth|rage|beg|plead|anguish|accus|threat|"
    r"contempt|sneer|mock|disgust|fear|cold|icy|गुस्स|चीख|डर|रोत", re.I)
HOT_ACTION = re.compile(
    r"\b(slap|strike|struck|punch|shove|push|grab|seiz|kneel|knee|collaps|faint|smash|shatter|throw|thrown|"
    r"rip|kiss|poison|blood|knife|gun|chok|drag|spit|burn|scream|cries|sob|crash|gasp|falls|drops|laugh|humiliat|pours?|tips? her)\w*", re.I)


def _events(item: dict, eps: dict[int, Episode]) -> list[tuple[float, object]]:
    """(time from the promo's start, event) for everything that plays, in order."""
    out, offset = [], 0.0
    for s in item["_segs"]:
        for e in eps[s.episode].events:
            if s.start - 0.011 <= e.start < s.end - 0.011:
                out.append((offset + max(0.0, e.start - s.start), e))
        offset += s.length
    return out


def _quote(e) -> str:
    t = e.text if len(e.text) <= 70 else e.text[:67] + "…"
    return f"{e.speaker}: “{t}”" if e.kind == "dialogue" else f"“{t}”"


def apply_rubric(item: dict, eps: dict[int, Episode], leads: list[str] | None = None, short: bool = False) -> dict:
    """Fill item['scores'] (each axis 0–10) and item['breakdown'] (the reason for every point)."""
    if not item.get("_segs"):
        return item
    ev = item.get("evidence") if isinstance(item.get("evidence"), dict) else {}
    plays = _events(item, eps)
    when = {e.id: t for t, e in plays}
    length = item["length"]
    lines = [(t, e) for t, e in plays if e.kind == "dialogue"]
    B: list[dict] = []

    def add(axis: str, pts: float, top: float, why: str) -> None:
        B.append({"axis": axis, "points": round(pts, 1), "max": top, "why": why})

    # ---- hook: does it open on something charged, fast, that needs no backstory?
    opens, conflict = str(ev.get("opens_on") or ""), str(ev.get("conflict_type") or "none").lower()
    ot = when.get(opens)
    if opens in when and conflict in STRONG_CONFLICT and ot <= 3.0:
        art = "an" if conflict[0] in "aeiou" else "a"
        add("hook", 4, 4, f"Opens on {art} {conflict} at {ot:.1f} s: {_quote(eps[int(opens.split(".")[0][1:])].by_id()[opens])}")
    elif opens in when and conflict in STRONG_CONFLICT:
        add("hook", 1, 4, f"The {conflict} comes at {ot:.1f} s, after the first 3 s")
    elif opens in when and conflict != "none":
        add("hook", 2, 4, f"Opens on something charged ({conflict}) but not a clear conflict")
    else:
        add("hook", 0, 4, "No charged opening moment identified in the first 3 s")
    first3 = [e for t, e in plays if t <= 3.0]
    hot = next((e for e in first3 if HOT_EMOTION.search(e.emotion or "") or (e.kind != "camera" and HOT_ACTION.search(e.text))), None)
    add("hook", 2 if hot else 0, 2, f"Intense from the first seconds: {(hot.emotion or _quote(hot)) if hot else ''}".rstrip(": ") if hot else "No intense emotion or action in the first 3 s")
    add("hook", 0 if ev.get("needs_backstory") else 2, 2, "Needs backstory to land" if ev.get("needs_backstory") else "Lands without backstory")
    delay = item["segments"][0]["hook_delay_s"] if item.get("segments") else 9
    add("hook", 2 if delay <= 1.0 else 1 if delay <= 3.0 else 0, 2, f"First beat lands at {delay:.1f} s")

    # ---- cliffhanger: does it cut on an open question, and is it really still open?
    ends, question = str(ev.get("ends_on") or ""), str(ev.get("open_question") or "").strip()
    et = when.get(ends)
    if question and ends in when and et >= length - 8:
        add("cliffhanger", 4, 4, f"Cuts on an open question: “{question[:90]}”")
    elif question:
        add("cliffhanger", 2, 4, f"Leaves a question (“{question[:60]}”) but the moment is {length - (et or 0):.0f} s before the cut")
    else:
        add("cliffhanger", 0, 4, "No open question named at the cut")
    last = lines[-1][1].text.strip() if lines else ""
    add("cliffhanger", 2 if last.endswith("?") else 1 if last.endswith(("!", "…", "...")) else 0, 2,
        f"Last line: “{last[:60]}”" if last else "No spoken last line")
    tail = item["segments"][-1]["tail_s"] if item.get("segments") else 0
    add("cliffhanger", 2 if tail >= 0.5 else 1 if tail >= 0.3 else 0, 2, f"Holds {tail:.1f} s on the reaction after the last line")
    j = item.get("ai_checks")
    if j:
        add("cliffhanger", 2 if j["cliffhanger_open"] else 0, 2, "Judge: the answer comes after the cut" if j["cliffhanger_open"] else "Judge: the promo already answers it")
    else:
        add("cliffhanger", 1, 2, "Not checked by the judge yet")

    # ---- makes sense alone: clear stakes, few people, a lead in it
    stakes = str(ev.get("stakes") or "").strip()
    add("standalone", 4 if stakes and not ev.get("needs_backstory") else 2 if stakes else 0, 4,
        f"Stakes: {stakes[:90]}" if stakes else "Stakes not stated")
    speakers = {e.speaker for _, e in lines}
    add("standalone", 3 if len(speakers) <= 2 else 2 if len(speakers) == 3 else 1 if len(speakers) == 4 else 0, 3,
        f"{len(speakers)} people speak" + (f": {', '.join(sorted(speakers))}" if len(speakers) <= 4 else ""))
    lead = next((sp for sp in speakers if leads and any(l in sp.upper() for l in leads)), None)
    add("standalone", 3 if lead else 0, 3, f"A lead is in it: {lead}" if lead else "None of the leads speaks")

    # ---- emotion: read from the script, plus a status flip (ReelShort's conflict + reversal)
    beats = [e for _, e in plays if HOT_EMOTION.search(e.emotion or "") or (e.kind in ("action", "sfx") and HOT_ACTION.search(e.text))]
    add("emotion", min(6, 2 * len(beats)), 6,
        f"{len(beats)} intense beat{'s' if len(beats) != 1 else ''} in the script" + (f", e.g. {(beats[0].emotion or _quote(beats[0]))}" if beats else ""))
    add("emotion", 4 if ev.get("power_shift") else 0, 4, "Power shifts inside the promo" if ev.get("power_shift") else "No power shift")

    # ---- clarity: a length and shape a feed rewards, understood by a stranger
    lo, hi = (10, 18) if short else (30, 55)
    add("clarity", 4 if lo <= length <= hi else 2, 4, f"{length:.0f} s long (sweet spot {lo}–{hi} s)")
    n = len(item["_segs"])
    add("clarity", 3 if n == 1 or item.get("stitched") else 2 if n == 2 else 1, 3,
        "One continuous piece" if n == 1 else f"{n} pieces joined" + (" (a trailer)" if item.get("stitched") else ""))
    if j:
        ok = j["cold_viewer"].get("understandable") is not False
        add("clarity", 3 if ok else 0, 3, "Judge: a stranger understood it" if ok else "Judge: a stranger could not follow it")
    else:
        add("clarity", 1.5, 3, "Not checked by the judge yet")

    scores = {}
    for axis in ("hook", "cliffhanger", "standalone", "emotion", "clarity"):
        got = sum(b["points"] for b in B if b["axis"] == axis)
        top = sum(b["max"] for b in B if b["axis"] == axis)
        scores[axis] = round(10 * got / top, 1)
    item["scores"], item["breakdown"] = scores, B
    return item
