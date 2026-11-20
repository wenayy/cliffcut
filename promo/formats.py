"""Read scripts in formats other than Kuku's.

Order of attempts, per file:
1. Kuku's timestamped format: exact times.
2. A standard screenplay (Fountain / plain text with INT./EXT. headings and
   CHARACTER cues): no times, so timing is ESTIMATED from word counts, and
   shots are inferred (a new shot on every action paragraph and speaker change).
   Every such episode is marked source_format="screenplay" and the UI says so.
3. Anything else, if a model is available: the model converts it to events.
   Otherwise a clear error naming the file.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import zipfile
from pathlib import Path
from xml.etree import ElementTree

from .providers import ask_json
from .timeline import Episode, Event, looks_like_kuku, parse_kuku

WPS_SPOKEN = 2.6       # words per second of dialogue (typical drama delivery)
WPS_ACTION = 5.0       # action lines play faster than they read aloud
PAUSE = 0.35

_HEADING = re.compile(r"^(\.(?!\.)|(INT|EXT|EST|INT\./EXT|I/E)[\. ])", re.I)
_CUE_LATIN = re.compile(r"^[A-Z][A-Z0-9 .'\-’]{1,40}(\s*\((V\.O\.|O\.S\.|O\.C\.|CONT'D|CONT’D)\))?\s*\^?$")


class _Cue:
    """A character cue: CAPS in Latin scripts; in scripts without capitals (Devanagari, Tamil, Bengali...)
    a short name of at most 3 words with no sentence punctuation, on its own line above the dialogue."""
    @staticmethod
    def match(line: str):
        if _CUE_LATIN.match(line):
            return True
        bare = re.sub(r"\s*\(.*\)\s*$", "", line).strip()
        if not bare or any("a" <= c <= "z" or "A" <= c <= "Z" for c in bare):
            return None
        return bool(len(bare.split()) <= 3 and len(bare) <= 30 and not re.search(r"[।.?!,:;…]$", bare)
                    and any(c.isalpha() for c in bare)) or None


_CUE = _Cue()
_EP = re.compile(r"^(#\s*)?EPISODE\s+(\d+)\b.*$", re.I)


def looks_like_screenplay(text: str) -> bool:
    lines = [l.strip() for l in text.splitlines()]
    cues = sum(1 for i, l in enumerate(lines[:-1]) if _CUE.match(l) and lines[i + 1] and not _CUE.match(lines[i + 1]))
    return cues >= 2


def _split_episodes(text: str, fallback: int) -> list[tuple[int, str]]:
    parts: list[tuple[int, list[str]]] = []
    for line in text.splitlines():
        m = _EP.match(line.strip())
        if m:
            parts.append((int(m.group(2)), []))
        else:
            if not parts:
                parts.append((fallback, []))
            parts[-1][1].append(line)
    if len(parts) > 1 and not _EP.match(text.strip().splitlines()[0].strip()):
        parts = parts[1:]   # a title page before EPISODE 1 is not an episode
    return [(n, "\n".join(body)) for n, body in parts if body and any(l.strip() for l in body)]


def parse_screenplay(text: str, number: int) -> Episode:
    ep = Episode(number=number, title=f"Episode {number}", source_format="screenplay")
    blocks: list[list[str]] = [[]]
    for raw in text.splitlines():
        if raw.strip():
            blocks[-1].append(raw.strip())
        elif blocks[-1]:
            blocks.append([])
    t, count, scene, speaker_prev = 0.0, 0, 0, None

    def add(kind: str, start: float, end: float, text: str, speaker: str = "", emotion: str = "") -> None:
        nonlocal count
        count += 1
        ep.events.append(Event(f"e{number:02d}.{count:03d}", kind, round(start, 2), round(end, 2),
                               text, speaker, emotion, scene))

    for b in blocks:
        if not b:
            continue
        head = b[0]
        if re.match(r"^(title|credit|author|draft date|contact)\s*:", head, re.I):
            for l in b:
                if l.lower().startswith("title:"):
                    ep.title = l.split(":", 1)[1].strip() or ep.title
            continue
        if _HEADING.match(head):
            scene += 1
            ep.scenes.append({"scene": scene, "heading": head.lstrip(".")})
            speaker_prev = None
            continue
        if head.endswith("TO:") or head.startswith(">"):
            speaker_prev = None
            continue
        if _CUE.match(head) and len(b) > 1:
            speaker = re.sub(r"\s*\(.*\)\s*$", "", head).rstrip("^ ").strip()
            emotion, lines = "", []
            for l in b[1:]:
                if l.startswith("(") and l.endswith(")") and not lines:
                    emotion = l[1:-1]
                elif l.startswith("(") and l.endswith(")"):
                    continue
                else:
                    lines.append(l)
            line = " ".join(lines)
            dur = max(1.2, len(line.split()) / WPS_SPOKEN)
            if speaker != speaker_prev:   # assume shot / reverse-shot coverage; ends fixed below
                add("camera", t, t + dur + PAUSE, f"Guessed shot: {speaker.title()} talking")
            add("dialogue", t, t + dur, line, speaker, emotion)
            t += dur + PAUSE
            speaker_prev = speaker
            continue
        action = " ".join(b)
        dur = max(1.5, len(action.split()) / WPS_ACTION)
        add("camera", t, t + dur, "Guessed shot: action")
        add("action", t, t + dur, action)
        t += dur
        speaker_prev = None
    # make camera coverage contiguous: each shot runs to the next shot's start
    cams = [e for e in ep.events if e.kind == "camera"]
    for a, b in zip(cams, cams[1:]):
        a.end = b.start
    if cams:
        cams[-1].end = max(cams[-1].end, max(e.end for e in ep.events))
    if not [e for e in ep.events if e.kind == "dialogue"]:
        raise ValueError("no dialogue found")
    ep.events.sort(key=lambda e: (e.start, ("camera", "action", "dialogue", "sfx").index(e.kind)))
    return ep


CONVERT_SYSTEM = """You convert a TV script in an unknown format into structured events.
Return JSON: {"episodes":[{"number":int,"title":str,"logline":str,"events":[{"kind":"camera|action|dialogue|sfx","speaker":str,"emotion":str,"text":str,"seconds":float}]}]}
Rules: keep every line of dialogue verbatim and in order. "seconds" is how long the event plays on screen; estimate it if the script has no times. Use "camera" for shot or scene changes. Do not invent dialogue."""


def convert_with_model(text: str, number: int, provider) -> list[Episode]:
    data = ask_json(provider, CONVERT_SYSTEM, text[:60000])
    out = []
    for k, e in enumerate(data.get("episodes", [])):
        n = int(e.get("number") or number + k)
        ep = Episode(number=n, title=e.get("title") or f"Episode {n}", logline=e.get("logline", ""), source_format="ai")
        t = 0.0
        for i, v in enumerate(e.get("events", []), 1):
            d = max(0.5, float(v.get("seconds") or 2.0))
            ep.events.append(Event(f"e{n:02d}.{i:03d}", v.get("kind", "action"), round(t, 2), round(t + d, 2),
                                   v.get("text", ""), v.get("speaker", ""), v.get("emotion", "")))
            if v.get("kind") != "camera":
                t += d
        if ep.events:
            out.append(ep)
    if not out:
        raise ValueError("the model could not read this script")
    return out


# ---------------------------------------------------------------- other file types

SCRIPT_SUFFIXES = (".txt", ".md", ".fountain", ".text", "", ".srt", ".vtt", ".fdx", ".docx", ".pdf")


def read_text(path: Path) -> str:
    """Plain text from any supported file: text, Final Draft (.fdx), Word (.docx), PDF (via pdftotext)."""
    suf = path.suffix.lower()
    if suf == ".docx":
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
        xml = re.sub(r"</w:p>", "\n", xml)
        return re.sub(r"<[^>]+>", "", xml)
    if suf == ".pdf":
        if not shutil.which("pdftotext"):
            raise ValueError(f"{path.name}: PDF needs pdftotext installed; or export the script as text")
        return subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True).stdout
    text = path.read_text(encoding="utf-8", errors="replace")
    return fdx_to_screenplay(text) if suf == ".fdx" or text.lstrip().startswith("<?xml") and "FinalDraft" in text[:400] else text


def fdx_to_screenplay(xml: str) -> str:
    """Final Draft XML -> plain screenplay text (headings, action, CHARACTER, (parenthetical), dialogue)."""
    root = ElementTree.fromstring(xml)
    out = []
    for para in root.iter("Paragraph"):
        kind = para.get("Type", "")
        txt = "".join(t.text or "" for t in para.iter("Text")).strip()
        if not txt:
            continue
        if kind == "Character":
            out += ["", txt.upper()]
        elif kind == "Parenthetical":
            out.append(txt if txt.startswith("(") else f"({txt})")
        elif kind == "Dialogue":
            out.append(txt)
        else:   # Scene Heading, Action, Transition
            out += ["", txt]
    return "\n".join(out)


_SUB_TIME = re.compile(r"(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})")


def looks_like_subtitles(text: str) -> bool:
    return len(_SUB_TIME.findall(text)) >= 3


def parse_subtitles(text: str, number: int) -> Episode:
    """SRT / WebVTT: real timestamps for every line. Speakers from "NAME: line" or "[NAME] line" when present;
    a shot is assumed to change whenever the speaker does (marked as inferred)."""
    from .timeline import seconds
    ep = Episode(number=number, title=f"Episode {number}", source_format="subtitles")
    count, prev = 0, None
    for block in re.split(r"\n\s*\n", text.strip()):
        m = _SUB_TIME.search(block)
        if not m:
            continue
        a, b = seconds(m.group(1)), seconds(m.group(2))
        body = " ".join(l.strip() for l in block[m.end():].strip().splitlines() if l.strip())
        body = re.sub(r"<[^>]+>", "", body)
        sm = re.match(r"^\[?([A-Z][A-Za-z .'-]{1,30}|[^\x00-\x7F]{1,20})\]?:\s*(.+)$", body) or re.match(r"^\[([^\]]{1,30})\]\s*(.+)$", body)
        speaker, line = (sm.group(1).strip().upper(), sm.group(2)) if sm else ("", body.lstrip("- "))
        if re.fullmatch(r"[\[(].*[\])]", line):          # [door slams] -> a sound
            count += 1
            ep.events.append(Event(f"e{number:02d}.{count:03d}", "sfx", a, b, line.strip("[]()")))
            continue
        if speaker != prev:
            count += 1
            ep.events.append(Event(f"e{number:02d}.{count:03d}", "camera", a, b, f"Guessed shot: {speaker.title() or 'next line'}"))
        count += 1
        ep.events.append(Event(f"e{number:02d}.{count:03d}", "dialogue", a, b, line, speaker or "VOICE", ""))
        prev = speaker
    cams = [e for e in ep.events if e.kind == "camera"]
    for x, y in zip(cams, cams[1:]):
        x.end = y.start
    if cams:
        cams[-1].end = max(e.end for e in ep.events)
    if not ep.of("dialogue"):
        raise ValueError("no subtitle lines found")
    ep.events.sort(key=lambda e: (e.start, ("camera", "action", "dialogue", "sfx").index(e.kind)))
    return ep


def load_any(text: str, number: int, provider=None) -> list[Episode]:
    if looks_like_kuku(text):
        return [parse_kuku(text, fallback_number=number)]
    if looks_like_subtitles(text):
        return [parse_subtitles(text, number)]
    if looks_like_screenplay(text):
        return [parse_screenplay(body, n) for n, body in _split_episodes(text, number)]
    if provider is not None:
        return convert_with_model(text, number, provider)
    raise ValueError("Unrecognised script format. Supported: Kuku's timestamped format, screenplays (Fountain, plain text, "
                     "Final Draft .fdx, Word .docx, PDF) and subtitles (.srt, .vtt). Anything else needs a model to convert it.")
