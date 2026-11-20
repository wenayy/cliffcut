"""One timeline per episode: every shot, action, line and sound effect, with times.

The script stores these as overlapping layers. Shot boundaries are the real cuts
in the finished video; everything else floats over them.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

KINDS = ("camera", "action", "dialogue", "sfx")


@dataclass
class Event:
    id: str            # stable address the AI uses, e.g. "e03.041"
    kind: str          # camera | action | dialogue | sfx
    start: float       # seconds from episode start
    end: float
    text: str
    speaker: str = ""  # dialogue only
    emotion: str = ""  # dialogue only, e.g. "Cold, Commanding"
    scene: int = 0


@dataclass
class Episode:
    number: int
    title: str
    logline: str = ""
    continuity: str = ""
    events: list[Event] = field(default_factory=list)
    scenes: list[dict] = field(default_factory=list)
    source_format: str = "kuku"   # kuku | screenplay (timing estimated) | ai (converted by a model)

    @property
    def duration(self) -> float:
        return max((e.end for e in self.events), default=0.0)

    def of(self, kind: str) -> list[Event]:
        return [e for e in self.events if e.kind == kind]

    def by_id(self) -> dict[str, Event]:
        return {e.id: e for e in self.events}


_TIME = re.compile(r"(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)")
_LABEL = re.compile(r"^\*\*(?P<label>[^*]+?):\*\*\s*$")
_SPAN = re.compile(r"Start:\s*\(([^)]+)\)\s*\|\s*End:\s*\(([^)]+)\)")
_HEADER = re.compile(r"^(EPISODE NUMBER|EPISODE LOGLINE|CONTINUITY NOTES):\s*(.*)$")


def seconds(stamp: str) -> float:
    """'02:17.50' -> 137.5; '1:02:03.5' -> 3723.5."""
    m = _TIME.fullmatch(stamp.strip())
    if not m:
        raise ValueError(f"bad timestamp: {stamp!r}")
    h, mnt, s = m.groups()
    return int(h or 0) * 3600 + int(mnt) * 60 + float(s)


def stamp(t: float) -> str:
    """137.5 -> '02:17.50' (the script's own format)."""
    m, s = divmod(round(t, 2), 60)
    return f"{int(m):02d}:{s:05.2f}"


def _kind(label: str) -> tuple[str, str, str]:
    """'CAMERA' -> camera; 'MATRIARCH (Cold, Commanding)' -> dialogue + speaker + emotion."""
    up = label.strip().upper()
    if up in ("CAMERA", "SHOT", "कैमरा", "शॉट"):
        return "camera", "", ""
    if up in ("ACTION", "एक्शन", "क्रिया"):
        return "action", "", ""
    if up in ("SOUND FX", "SFX", "SOUND", "MUSIC", "साउंड", "ध्वनि", "संगीत"):
        return "sfx", "", ""
    m = re.match(r"^(.*?)\s*\((.*)\)\s*$", label.strip())
    if m:
        return "dialogue", m.group(1).strip(), m.group(2).strip()
    return "dialogue", label.strip(), ""


def looks_like_kuku(text: str) -> bool:
    return bool(_SPAN.search(text)) and "**" in text


def parse_kuku(text: str, fallback_number: int = 0) -> Episode:
    """Parse Kuku's screenplay format. Raises ValueError if it isn't that format."""
    if not looks_like_kuku(text):
        raise ValueError("not in the timestamped **LABEL:** format")
    ep = Episode(number=fallback_number, title="")
    lines = text.splitlines()
    scene = 0
    pending: tuple[str, str, str] | None = None  # (kind, speaker, emotion) awaiting its span
    current: Event | None = None
    count = 0

    for raw in lines:
        line = raw.strip()
        h = _HEADER.match(line)
        if h:
            key, val = h.groups()
            if key == "EPISODE NUMBER":
                ep.title = val
                n = re.search(r"\d+", val)
                ep.number = int(n.group()) if n else fallback_number
            elif key == "EPISODE LOGLINE":
                ep.logline = val
            else:
                ep.continuity = val
            continue
        if re.match(r"^SCENE\s+\d+", line):
            scene = int(re.search(r"\d+", line).group())
            ep.scenes.append({"scene": scene, "heading": ""})
            current = None
            continue
        if line.startswith("Scene heading:") and ep.scenes:
            ep.scenes[-1]["heading"] = line.split(":", 1)[1].strip()
            continue
        if line.startswith(("Scene start:", "Scene end:")) and ep.scenes:
            key = "start" if line.startswith("Scene start") else "end"
            ep.scenes[-1][key] = seconds(line.split(":", 1)[1])
            continue
        lab = _LABEL.match(line)
        if lab:
            pending, current = _kind(lab.group("label")), None
            continue
        span = _SPAN.search(line)
        if span and pending:
            count += 1
            kind, speaker, emotion = pending
            current = Event(
                id=f"e{ep.number:02d}.{count:03d}", kind=kind,
                start=seconds(span.group(1)), end=seconds(span.group(2)),
                text="", speaker=speaker, emotion=emotion, scene=scene,
            )
            ep.events.append(current)
            pending = None
            continue
        if current and line and not line.startswith("---") and not line.startswith("Actions and dialogue"):
            current.text = (current.text + " " + line).strip()
        elif not line:
            current = None

    for e in ep.events:
        if e.kind == "dialogue":
            e.text = e.text.strip().strip('"').strip("“”")
    ep.events.sort(key=lambda e: (e.start, KINDS.index(e.kind)))
    if not ep.events:
        raise ValueError("no timed events found")
    return ep


def load_episode(path: str | Path, number: int = 0) -> Episode:
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    return parse_kuku(text, fallback_number=number)


def load_show(folder: str | Path, provider=None) -> list[Episode]:
    """Every script file in a folder, in any format we can read (see promo/formats.py)."""
    from .formats import load_any
    files = sorted(p for p in Path(folder).iterdir()
                   if p.is_file() and p.suffix.lower() in (".txt", ".md", ".fountain", ".text", ""))
    eps: list[Episode] = []
    for i, p in enumerate(files):
        eps.extend(load_any(p.read_text(encoding="utf-8", errors="replace"), i + 1, provider))
    seen: set[int] = set()
    for i, e in enumerate(sorted(eps, key=lambda e: e.number)):   # keep numbers unique
        if e.number in seen or e.number <= 0:
            e.number = max(seen | {0}) + 1
            for v in e.events:
                v.id = f"e{e.number:02d}." + v.id.split(".", 1)[1]
        seen.add(e.number)
    return sorted(eps, key=lambda e: e.number)
