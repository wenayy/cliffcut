"""Turn "event A to event B" into clean cut times.

What actually looks broken in a cut (measured on the pack, see docs section 3):
- a FLASH FRAME: a sliver of a shot shorter than MIN_SLIVER left at an edge;
- a CHOPPED LINE: a cut while someone is still speaking;
- NO REACTION: ending on the last word, so the cliffhanger face never lands.
Starting a shot a little late (a head trim) is normal editing, not a defect.

Rules:
1. Prefer the show's own shot boundaries when one is close enough.
2. Otherwise cut inside a long shot, a beat before the hook / a beat after the
   last word, but never inside a line and never leaving a flash frame.
3. The hook must land within HOOK_MAX seconds of the cut-in.
4. The end holds on the reaction; a sound swell crossing the end is let reach its
   peak when a clean boundary is close.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .timeline import Episode, Event, stamp

EPS = 0.011            # scripts give 1/100 s; closer than this counts as equal
HOOK_MAX = 3.0         # hook must land within this many seconds of the cut-in
MIN_SLIVER = 0.7       # shorter than this, a piece of a shot reads as a flash frame
IN_REACH = 1.5         # use a shot boundary for the cut-in if it's this close before the hook
PREROLL = 0.25         # mid-shot cut-in: start this long before the hook
REACTION_HOLD = 0.3    # minimum picture after the last word
OUT_REACH = 2.0        # use a shot boundary for the cut-out if it's this close after the last word
REACTION_MID = 1.0     # mid-shot cut-out: hold this long on the reaction
SFX_REACH = 5.0        # extend the end at most this far to let a swell finish
SFX_NEAR = 1.0         # ...landing within this much of the swell's end
PROMO_MIN, PROMO_MAX = 20.0, 60.0


def boundaries(ep: Episode) -> list[float]:
    pts = {0.0, round(ep.duration, 2)}
    for c in ep.of("camera"):
        pts.add(round(c.start, 2))
        pts.add(round(c.end, 2))
    return sorted(pts)


def inside(ev: Event, t: float) -> bool:
    return ev.start + EPS < t < ev.end - EPS


def speech_at(ep: Episode, t: float) -> Event | None:
    return next((d for d in ep.of("dialogue") if inside(d, t)), None)


def on_boundary(ep: Episode, t: float) -> bool:
    return any(abs(t - b) <= EPS for b in boundaries(ep))


def sliver_ok(ep: Episode, t: float, side: str) -> bool:
    """Cut-in at t: the piece until the next cut must be >= MIN_SLIVER (side='in').
    Cut-out at t: the piece since the last cut must be >= MIN_SLIVER (side='out')."""
    if on_boundary(ep, t):
        return True
    B = boundaries(ep)
    if side == "in":
        nxt = [b for b in B if b > t + EPS]
        return not nxt or nxt[0] - t >= MIN_SLIVER - 1e-6
    prv = [b for b in B if b < t - EPS]
    return not prv or t - prv[-1] >= MIN_SLIVER - 1e-6


def clean_boundaries(ep: Episode) -> list[float]:
    return [b for b in boundaries(ep) if speech_at(ep, b) is None]


def _ok(ep: Episode, t: float, side: str) -> bool:
    return 0.0 <= t <= ep.duration + EPS and speech_at(ep, t) is None and sliver_ok(ep, t, side)


def _steps(lo: float, hi: float, step: float = 0.05) -> list[float]:
    n = int(round((hi - lo) / step))
    return [round(lo + i * step, 2) for i in range(n + 1)]


def snap_in(ep: Episode, hook: float) -> float:
    """Cut-in at or before the hook: a nearby shot boundary, else a head trim inside the shot."""
    clean = clean_boundaries(ep)
    near = [b for b in clean if hook - IN_REACH - EPS <= b <= hook + EPS]
    if near:
        return near[-1]
    order = _steps(0.0, PREROLL)[::-1] + _steps(PREROLL, HOOK_MAX)[1:]
    for k in order:                               # a beat before the hook, else on it, else further back
        t = round(hook - k, 2)
        if _ok(ep, t, "in"):
            return t
    before = [b for b in clean if b <= hook + EPS]
    return before[-1] if before else 0.0


def snap_out(ep: Episode, last_word: float) -> float:
    """Cut-out after the last word, holding on the reaction as long as the scene allows."""
    clean = clean_boundaries(ep)
    near = [b for b in clean if last_word + REACTION_HOLD - EPS <= b <= last_word + OUT_REACH]
    end = near[0] if near else None
    if end is None:
        order = _steps(REACTION_HOLD, REACTION_MID)[::-1] + _steps(REACTION_MID, OUT_REACH)[1:]
        end = next((round(last_word + k, 2) for k in order if _ok(ep, last_word + k, "out")), None)
    if end is None:                               # someone talks right after: take the longest clean hold
        end = next((round(last_word + k, 2) for k in _steps(0.0, REACTION_HOLD)[::-1]
                    if _ok(ep, last_word + k, "out")), None)
    if end is None:                               # last resort: the next clean shot boundary
        after = [b for b in clean if b >= last_word - EPS]
        end = after[0] if after else ep.duration
    end = min(end, ep.duration)
    for s in ep.of("sfx"):  # a swell crossing the cut: end on its peak if a clean cut is close
        if inside(s, end):
            later = [b for b in clean if end < b <= end + SFX_REACH and abs(b - s.end) <= SFX_NEAR]
            if later:
                end = min(later, key=lambda b: abs(b - s.end))
    return end


@dataclass
class Segment:
    episode: int
    first: str          # event id the AI chose to open on
    last: str           # event id the AI chose to close on
    start: float
    end: float
    hook_delay: float   # seconds from cut-in to the first chosen event
    tail: float         # seconds of picture after the last spoken word

    @property
    def length(self) -> float:
        return round(self.end - self.start, 2)

    def as_dict(self) -> dict:
        return {"episode": self.episode, "start": stamp(self.start), "end": stamp(self.end),
                "start_s": self.start, "end_s": self.end, "length_s": self.length,
                "first_event": self.first, "last_event": self.last,
                "hook_delay_s": round(self.hook_delay, 2), "tail_s": round(self.tail, 2)}


def build_segment(ep: Episode, first_id: str, last_id: str) -> Segment:
    ids = ep.by_id()
    missing = [i for i in (first_id, last_id) if i not in ids]
    if missing:
        raise KeyError(f"unknown event id(s) in episode {ep.number}: {missing}")
    a, b = ids[first_id], ids[last_id]
    if b.end < a.start:
        a, b = b, a
    # any line that starts inside the chosen span must be allowed to finish
    spoken = [e.end for e in ep.of("dialogue") if a.start - EPS <= e.start <= b.end]
    last_word = max(spoken + [b.end]) if spoken else b.end
    start = snap_in(ep, a.start)
    end = snap_out(ep, last_word)
    return Segment(ep.number, a.id, b.id, start, end, a.start - start,
                   end - max(spoken) if spoken else end - b.end)


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""


@dataclass
class Promo:
    segments: list[Segment] = field(default_factory=list)

    @property
    def length(self) -> float:
        return round(sum(s.length for s in self.segments), 2)


def check_promo(promo: Promo, eps: dict[int, Episode],
                lo: float = PROMO_MIN, hi: float = PROMO_MAX) -> list[Check]:
    """Code-side checks. The AI-side checks (cliffhanger, cold viewer, spoiler) live elsewhere."""
    out = []
    n = promo.length
    out.append(Check("length", lo <= n <= hi, f"{n:.1f}s (allowed {lo:.0f}–{hi:.0f}s)"))
    if promo.segments:
        d = promo.segments[0].hook_delay
        out.append(Check("hook_in_3s", d <= HOOK_MAX, f"hook lands at {d:.1f}s"))
        t = promo.segments[-1].tail
        out.append(Check("ends_on_reaction", t >= REACTION_HOLD - EPS, f"{t:.1f}s held after the last word"))
    bad = []
    for s in promo.segments:
        ep = eps[s.episode]
        for t, side in ((s.start, "in"), (s.end, "out")):
            if speech_at(ep, t):
                bad.append(f"ep{s.episode} {stamp(t)} cuts a line")
            elif not sliver_ok(ep, t, side):
                bad.append(f"ep{s.episode} {stamp(t)} leaves a flash frame")
    out.append(Check("clean_cuts", not bad, "; ".join(bad) or "no chopped line, no flash frame"))
    return out
