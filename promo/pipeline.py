"""Find, cut, check and rank promos and next-episode teasers for a whole show.

  1. find      (AI, one call per episode)  candidate promos + one teaser, as event ids
  2. cut       (code)                      clean cut times, length / hook / clean-cut checks
  3. repair    (AI, only when needed)      failed candidates go back once with the reason
  4. stitch    (AI, one call per show)     promos joined across episodes
  5. judge     (AI, finalists only)        cold-viewer test, cliffhanger-still-open, spoiler
  6. rank      (code)                      weighted score, dedupe, spread across hook types

The model never writes a timestamp. Code never judges taste.
"""
from __future__ import annotations

import json
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Callable

from .cuts import Promo, Segment, build_segment, check_promo
from .providers import ProviderError, ask_json
from .rubric import apply_rubric
from .timeline import Episode, stamp

PROMO_MIN, PROMO_MAX = 20.0, 60.0
TEASER_MIN, TEASER_MAX = 8.0, 20.0
TEASER_ENDING = 0.85          # a teaser may not show the episode's ending (its last 15%); tuned on real runs, see docs
HOOK_TYPES = ("identity_reversal", "forced_marriage", "humiliation_revenge", "forbidden_romance", "other")
WEIGHTS = {"hook": 0.30, "cliffhanger": 0.25, "standalone": 0.20, "emotion": 0.15, "clarity": 0.10}

Progress = Callable[[str, int, int, str], None]


@dataclass
class RunConfig:
    candidates_per_episode: int = 3
    finalists: int = 16
    concurrency: int | None = None      # None = the provider's own setting (free tiers need 1-2)
    episodes: list[int] | None = None
    stitch: bool = True
    judge: bool = True
    brief: str = ""                     # what the editor wants this run to focus on
    taste: list[dict] | None = None     # the editor's past approvals and rejections
    genre: str = ""                     # e.g. "romance", "revenge", "thriller"; empty = let the model infer
    teasers: bool = True                # make next-episode teasers
    trailer_min: float = 60.0           # whole-show trailer length (long serial ads win reach; see docs)
    trailer_max: float = 90.0
    language: str = "English"           # language for titles, hooks and reasons (scripts can be in any language)
    leads: list[str] | None = None      # main characters, named by the editor; None = detect from the scripts


# Kuku's own fiction categories, and the openings that stop a scroll in each (editable)
GENRE_HOOKS = {
    "romance": "a forbidden touch or kiss, a public rejection, a contract or forced marriage, a rich or powerful lover revealed.",
    "thriller": "a body or clue discovered, a threat whispered, someone being watched, a lie about to be exposed.",
    "crime": "the crime itself in progress, an arrest, an interrogation turning, a confession.",
    "horror": "a sound or figure that should not be there, a scream, a slow reveal in the dark; hold the dread, never show the monster fully.",
    "fantasy": "a transformation, a hidden power or bloodline revealed, a forbidden bond (werewolf, vampire, mate).",
    "drama": "a family humiliation, an insult at a gathering, a slap, a betrayal by blood; revenge set up.",
    "comedy": "an awkward misunderstanding, a sharp comeback, a reversal of status played for laughs; end on the setup of the punchline.",
    "mythology": "a divine sign or curse, a vow, a moment of dharma under pressure, a god or hero revealed.",
}


def main_characters(eps: dict[int, Episode], n: int = 3) -> list[str]:
    """The leads: who speaks in the most episodes (not just the most lines, so one long monologue doesn't win)."""
    seen: dict[str, set[int]] = {}
    for e in eps.values():
        for d in e.of("dialogue"):
            name = re.sub(r"^(LADY|LORD|SIR|MR\.?|MRS\.?|MISS)\s+", "", d.speaker.upper()).strip()
            if name and not re.search(r"\b(GUEST|VOICE|CROWD|ALL|MAN|WOMAN|GUARD|SERVANT)\b", name):
                seen.setdefault(name, set()).add(e.number)
    return [k for k, _ in sorted(seen.items(), key=lambda kv: -len(kv[1]))[:n]]


def guidance(cfg: RunConfig) -> str:
    """The editor's voice in every picking prompt: this run's brief, plus their past calls."""
    out = [f"The script may be in any language (English, Hindi, Hinglish or another Indian language). "
           f"Write titles, hooks, cliffhangers and reasons in {cfg.language or 'English'}."]
    if cfg.leads:
        out.append("LEAD CHARACTERS: " + ", ".join(cfg.leads) + ". Viewers follow the leads: prefer moments that put them at the centre.")
    if cfg.genre.strip():
        g = cfg.genre.strip()
        hint = next((v for k, v in GENRE_HOOKS.items() if k in g.lower()), "")
        out.append(f"GENRE: {g}. Judge hooks the way this genre's audience does." + (f" What usually hooks them: {hint}" if hint else ""))
    if cfg.brief.strip():
        out.append("EDITOR BRIEF for this run (follow it unless it breaks the hard rules above):\n" + cfg.brief.strip()[:1500])
    taste = cfg.taste or []
    good = [t for t in taste if t.get("decision") == "approved"][-8:]
    bad = [t for t in taste if t.get("decision") == "rejected"][-8:]
    if good or bad:
        lines = ["THE EDITOR'S PAST DECISIONS (learn their taste; pick more like the approved, avoid what they rejected):"]
        lines += [f"APPROVED: {t.get('title', '')}: hook '{t.get('hook', '')}', ends on '{t.get('cliffhanger', '')}'"
                  + (f". Note: {t['note']}" if t.get("note") else "") for t in good]
        lines += [f"REJECTED: {t.get('title', '')}: hook '{t.get('hook', '')}'"
                  + (f". Why: {t['note']}" if t.get("note") else "") for t in bad]
        out.append("\n".join(lines))
    return ("\n\n" + "\n\n".join(out)) if out else ""


# ---------------------------------------------------------------- prompts

FIND_SYSTEM = f"""You are the promo editor for a vertical microdrama app. You read one episode's script and pick the moments that make the best paid-social promos, for TikTok, Reels and Shorts.

A promo is shown to a STRANGER scrolling a feed. It must:
- HOOK in the first 3 seconds: the first event is already charged (a slap, a reveal, a humiliating line, a shocking question). Never open on scenery or set-up.
- END ON A CLIFFHANGER: cut while a question is open, BEFORE its answer. Showing the shocked face and cutting before the reply is good. Showing the answer is bad.
- MAKE SENSE ALONE: who is hurt, who to root for, what is at stake, with no backstory.
- Run {PROMO_MIN:.0f}–{PROMO_MAX:.0f} seconds (aim for 30–55). Use 1 segment, or 2 segments from this episode to skip a slow middle.
Promos are not summaries. Pick what makes someone NEED the next second, not what is most important.
WORDLESS MOMENTS COUNT: an ACTION or SFX line (a slap, a kneel, a ring offered, a glass smashing, a gasp) can be the hook or the cliffhanger with no dialogue at all. Use the emotion tags in brackets (Furious, Trembling, Cold) to judge how charged a line is; short promos often work best on one wordless beat plus one line.

Also pick ONE TEASER from this episode: {TEASER_MIN:.0f}–{TEASER_MAX:.0f} seconds, played at the end of the PREVIOUS episode ("next time"). It opens a question this episode answers, and it must NOT show this episode's ending or its main pay-off.

Hook types: identity_reversal (hidden identity, status flip), forced_marriage (contract or forced marriage), humiliation_revenge (public humiliation, revenge), forbidden_romance (forbidden or taboo love), other. Pick the closest, and ALSO name the hook in this show's own terms in hook_label (2-4 words, e.g. "public slap", "body in the lake", "jump scare", "fake death").
Also write episode_summary: one line on what happens in this episode.

Refer to moments ONLY by the event ids in [brackets]. Never write timestamps. Do NOT give scores: answer the evidence questions honestly; code scores them.
Evidence: opens_on = id of the charged moment the promo opens on; conflict_type = accusation | humiliation | reveal | threat | violence | rejection | confession | betrayal | other | none; ends_on = id of the moment it cuts on; open_question = the exact question a viewer is left with at the cut ("" if none); needs_backstory = true if a stranger needs earlier episodes to get it; stakes = who is hurt and what they could lose, one line; power_shift = true if someone's status flips inside the promo; intense_beats = ids of the 1-5 most charged moments INSIDE the promo (any genre: a slap, a scream, a door slamming in the dark, a confession, a joke landing).

Reply with JSON only:
{{"promos":[{{"title":"3-6 word name","segments":[{{"first":"id","last":"id"}}],"hook":"what happens in the first 3 s","cliffhanger":"the question left open at the cut","why":"one line on why it works","hook_type":"one of the types","hook_label":"2-4 words","evidence":{{"opens_on":"id","conflict_type":"...","ends_on":"id","open_question":"...","needs_backstory":false,"stakes":"...","power_shift":false,"intense_beats":["id"]}}}}],
"teaser":{{"first":"id","last":"id","line":"the line or moment it hangs on","why":"one line"}},
"episode_summary":"one line"}}"""

def trailer_system(lo: float, hi: float) -> str:
    pieces = "3-4" if hi <= 60 else "4-6"
    return f"""You cut WHOLE-SHOW TRAILERS for a vertical microdrama: one ad that sells the whole series, not one episode.
A trailer joins {pieces} moments from DIFFERENT episodes, in story order, {lo:.0f}-{hi:.0f} s in total:
1. HOOK (first 3 s): the inciting humiliation, betrayal or shock that starts the story.
2. TURN: the new relationship, deal or vow that changes the lead's life.
3. RAISE: a secret, power shift or threat that raises the stakes (more than one beat if the length allows).
4. CLIFFHANGER: cut on the biggest open question, before its answer.
Never show how the series ends or reveal its final twist. It must make sense to a stranger.
Build it from the story's turning points (given below) up to, but never including, the climax. Convey the show's mood.
You may open with 2-3 FLASH pieces of 1-2 s each (a gasp, a slap, a tear, a ring held out): a burst of emotion before the story beats.
Pieces should be short (1-2 s for flashes, 8-18 s otherwise). Use ONLY the event ids given. Reply with JSON only:
{{{{"trailers":[{{{{"title":"3-6 word name","segments":[{{{{"first":"id","last":"id"}}}}],"hook":"...","cliffhanger":"...","why":"...","mood":"...","hook_type":"...","evidence":{{{{"opens_on":"id","conflict_type":"...","ends_on":"id","open_question":"...","needs_backstory":false,"stakes":"...","power_shift":false,"intense_beats":["id"]}}}}}}}}]}}}}"""


TRAILER_SYSTEM = trailer_system(60, 90)

STORY_SYSTEM = """You map a serial drama's story structure from its episode summaries, like a trailer editor before cutting.
Find the five turning points (the episode number where each happens): opportunity (the event that starts the story),
change_of_plans (the main goal is set), point_of_no_return (the lead is fully committed), major_setback (everything falls apart),
climax (the final confrontation). Also the overall mood (e.g. dark, romantic, tense, hopeful) and the themes the show is really about
(e.g. betrayal and redemption, class, social evil, hope).
Reply with JSON only: {"opportunity":1,"change_of_plans":0,"point_of_no_return":0,"major_setback":0,"climax":0,"mood":"...","themes":["..."]}"""


def story_map(provider, eps: dict[int, Episode]) -> dict:
    data = ask_json(provider, STORY_SYSTEM, "EPISODES:\n" + synopsis(eps))
    tp = {k: data.get(k) for k in ("opportunity", "change_of_plans", "point_of_no_return", "major_setback", "climax")}
    return {"turning_points": tp, "mood": str(data.get("mood") or ""), "themes": [str(t) for t in (data.get("themes") or [])][:5]}
STITCH_SYSTEM = TRAILER_SYSTEM

COLD_SYSTEM = """You are a stranger scrolling TikTok. You know NOTHING about this show. Below is everything you see and hear in one ad. Answer honestly from the ad alone.
Reply with JSON only: {"who_to_root_for":"...","stakes":"...","open_question":"...","understandable":true,"swipe_second":null}
"understandable" is false if you could not follow who is who or why it matters. "swipe_second" is the second at which a bored viewer would swipe away, or null if they would watch to the end."""

GUARD_SYSTEM = """You check a promo for a microdrama against what happens right AFTER it is cut, and against the whole series synopsis.
- cliffhanger_open: true if the question the promo raises is still unanswered at the cut (the answer comes after). false if the promo itself already shows the answer.
- spoiler: true ONLY if the promo reveals a major twist from much later in the series (a hidden identity, a death, the ending) that would ruin it for a new viewer. Showing what happens in this episode or the next one or two is normal promo material and is NOT a spoiler.
Reply with JSON only: {"cliffhanger_open":true,"cliffhanger_reason":"...","spoiler":false,"spoiler_reason":"..."}"""


# ---------------------------------------------------------------- text helpers

DRAMATIC_SHOT = re.compile(r"close-up|closeup|extreme|reaction|push(es)? in|slow motion|zoom|tears?|eyes|shock|freeze|insert", re.I)


def script_lines(ep: Episode) -> str:
    """The episode as the model reads it. Routine camera notes are dropped (they were half of all tokens);
    dramatic ones (close-ups, reactions, push-ins) are kept short, because they carry the picture's tension."""
    out = []
    for e in ep.events:
        if e.kind == "camera":
            if DRAMATIC_SHOT.search(e.text):
                out.append(f"[{e.id}] {stamp(e.start)} SHOT: {e.text[:48]}")
        elif e.kind == "dialogue":
            emo = f" ({e.emotion})" if e.emotion else ""
            out.append(f"[{e.id}] {stamp(e.start)}-{stamp(e.end)} {e.speaker}{emo}: {e.text}")
        else:
            out.append(f"[{e.id}] {stamp(e.start)}-{stamp(e.end)} {e.kind.upper()}: {e.text[:200]}")
    return "\n".join(out)


def transcript(segs: list[Segment], eps: dict[int, Episode]) -> str:
    out, offset = [], 0.0
    for s in segs:
        for e in eps[s.episode].events:
            if s.start - 0.011 <= e.start < s.end and e.kind in ("dialogue", "action"):
                t = offset + max(0.0, e.start - s.start)
                out.append(f"{t:4.1f}s  " + (f"{e.speaker}: {e.text}" if e.kind == "dialogue" else f"({e.text})"))
        offset += s.length
    return "\n".join(out)


def after_cut(seg: Segment, eps: dict[int, Episode], n: int = 8) -> str:
    ep = eps[seg.episode]
    nxt = [e for e in ep.events if e.start >= seg.end - 0.011 and e.kind in ("dialogue", "action")][:n]
    if len(nxt) < n and seg.episode + 1 in eps:
        nxt += [e for e in eps[seg.episode + 1].events if e.kind in ("dialogue", "action")][: n - len(nxt)]
    return "\n".join(f"{e.speaker}: {e.text}" if e.kind == "dialogue" else f"({e.text})" for e in nxt) or "(the show ends here)"


def synopsis(eps: dict[int, Episode]) -> str:
    return "\n".join(f"Ep {n}: {e.logline or e.title}" for n, e in sorted(eps.items()))


def episode_of(event_id: str) -> int:
    return int(event_id.split(".", 1)[0].lstrip("e"))


# ---------------------------------------------------------------- building

def build(raw: dict, eps: dict[int, Episode], lo: float, hi: float) -> dict:
    """AI candidate -> cut segments + code checks. Never raises on bad ids; records why."""
    segs: list[Segment] = []
    problems: list[str] = []
    for s in raw.get("segments") or ([{"first": raw.get("first"), "last": raw.get("last")}] if raw.get("first") else []):
        try:
            a, b = str(s["first"]), str(s["last"])
            n = episode_of(a)
            if n not in eps or episode_of(b) != n:
                raise KeyError(f"{a}→{b}")
            segs.append(build_segment(eps[n], a, b))
        except (KeyError, ValueError, TypeError) as err:
            problems.append(f"unknown or mismatched event ids {err}")
    segs.sort(key=lambda s: (s.episode, s.start))
    checks = check_promo(Promo(segs), eps, lo=lo, hi=hi) if segs else []
    out = {
        "segments": [s.as_dict() for s in segs],
        "length": round(sum(s.length for s in segs), 2),
        "checks": [{"name": c.name, "ok": c.ok, "detail": c.detail} for c in checks],
        "problems": problems,
        "_segs": segs,
    }
    out["code_ok"] = bool(segs) and not problems and all(c["ok"] for c in out["checks"])
    return out


def _clean(raw: dict) -> dict:
    ht = raw.get("hook_type") if raw.get("hook_type") in HOOK_TYPES else "other"
    return {"title": str(raw.get("title") or "")[:80], "hook": str(raw.get("hook") or ""),
            "cliffhanger": str(raw.get("cliffhanger") or ""), "why": str(raw.get("why") or ""),
            "mood": str(raw.get("mood") or ""),
            "hook_label": str(raw.get("hook_label") or "")[:40],
            "hook_type": ht,
            "evidence": raw.get("evidence") if isinstance(raw.get("evidence"), dict) else {},
            "scores": {k: 5.0 for k in WEIGHTS}}   # replaced by the rubric once the cut exists


def _failures(item: dict) -> str:
    bits = [f"{c['name']}: {c['detail']}" for c in item["checks"] if not c["ok"]] + item["problems"]
    return "; ".join(bits)


# ---------------------------------------------------------------- stages

def find_episode(provider, ep: Episode, eps: dict[int, Episode], cfg: RunConfig, show_title: str) -> dict:
    prev = [eps[n] for n in sorted(eps) if n < ep.number][-5:]
    nxt = eps.get(ep.number + 1)
    user = (f"SHOW: {show_title}\n"
            f"STORY SO FAR:\n" + ("\n".join(f"Ep {p.number}: {p.logline}" for p in prev) or "(this is the first episode)") +
            f"\n\nTHIS EPISODE {ep.number}: {ep.logline}\nCONTINUITY: {ep.continuity}\n"
            f"NEXT EPISODE: {nxt.logline if nxt else '(none)'}\n"
            f"Duration {ep.duration:.1f} s." + (" Timing is ESTIMATED from word counts." if ep.source_format != "kuku" else "") +
            f"\n\nSCRIPT (each event shows start-end):\n{script_lines(ep)}{guidance(cfg)}\n\n"
            f"MEASURE BEFORE YOU ANSWER: a pick lasts from its first event's start to its last event's end, plus about 1 s held on the reaction. "
            f"Every promo must total {PROMO_MIN:.0f}-{PROMO_MAX:.0f} s; the teaser {TEASER_MIN:.0f}-{TEASER_MAX:.0f} s. "
            f"End on a line or reaction that is NOT immediately followed by more talk, so the face can hold. "
            f"The teaser must END before {stamp(ep.duration * TEASER_ENDING)}: after that is this episode's ending, which a teaser must not show.\n"
            f"Return up to {cfg.candidates_per_episode} promos and one teaser.")
    data = ask_json(provider, FIND_SYSTEM, user)
    if not ep.logline and data.get("episode_summary"):   # scripts without loglines: the model's summary feeds the
        ep.logline = str(data["episode_summary"])[:300]   # story-so-far, the judges, the story map and the trailers
    promos = [{**_clean(p), **build(p, eps, PROMO_MIN, PROMO_MAX), "source_episode": ep.number}
              for p in (data.get("promos") or [])[: cfg.candidates_per_episode + 2] if isinstance(p, dict)]
    teaser = data.get("teaser") if isinstance(data.get("teaser"), dict) else None
    t = None
    if teaser and ep.number > 1:
        t = {"line": str(teaser.get("line") or ""), "why": str(teaser.get("why") or ""),
             **build(teaser, eps, TEASER_MIN, TEASER_MAX), "from_episode": ep.number, "for_episode": ep.number - 1}
        _teaser_ending_check(t, ep)

    failing = [p for p in promos if not p["code_ok"]]
    # one repair round, only when this episode would otherwise have fewer than 2 usable promos
    # (repairing every episode doubled the tokens; a failed teaser is fitted in code instead)
    if failing and sum(1 for p in promos if p["code_ok"]) < 2:
        lines = [f"PROMO {i + 1} ({p.get('title') or 'untitled'}): {_failures(p)}" for i, p in enumerate(failing)]
        fix = ask_json(provider, FIND_SYSTEM, user + "\n\nThese picks FAILED the editor's checks:\n" + "\n".join(lines) +
                       "\nReturn corrected promos and teaser in the same JSON (choose different event ids so each passes).")
        fixed = [{**_clean(p), **build(p, eps, PROMO_MIN, PROMO_MAX), "source_episode": ep.number, "repaired": True}
                 for p in (fix.get("promos") or []) if isinstance(p, dict)]
        promos = [p for p in promos if p["code_ok"]] + fixed
        ft = fix.get("teaser") if isinstance(fix.get("teaser"), dict) else None
        if ft and ep.number > 1 and (t is None or not t["code_ok"]):
            t2 = {"line": str(ft.get("line") or ""), "why": str(ft.get("why") or ""),
                  **build(ft, eps, TEASER_MIN, TEASER_MAX), "from_episode": ep.number, "for_episode": ep.number - 1,
                  "repaired": True}
            _teaser_ending_check(t2, ep)
            t = t2 if t2["code_ok"] or t is None else t
    if t is not None and not t["code_ok"]:
        t = fit_teaser(t, ep, eps) or t
    return {"episode": ep.number, "promos": promos, "teaser": t}


def fit_teaser(t: dict, ep: Episode, eps: dict[int, Episode]) -> dict | None:
    """Keep the moment the model chose to hang on (its last event); slide the start until 8-20 s.
    Mechanical, not taste: the model still chose what the teaser is about."""
    if not t.get("_segs"):
        return None
    last_id = t["_segs"][-1].last
    last = ep.by_id()[last_id]
    starts = [e for e in ep.events if e.kind in ("dialogue", "action") and e.start <= last.start]
    best = None
    for e in reversed(starts):
        built = build({"first": e.id, "last": last_id}, eps, TEASER_MIN, TEASER_MAX)
        if built["code_ok"]:
            if best is None or abs(built["length"] - 14) < abs(best["length"] - 14):
                best = built
        if last.end - e.start > TEASER_MAX + 3:
            break
    if best is None:
        return None
    out = {**t, **best, "fitted": True}
    _teaser_ending_check(out, ep)
    return out if out["code_ok"] else None


def _teaser_ending_check(t: dict, ep: Episode) -> None:
    limit = ep.duration * TEASER_ENDING
    end = max((s.end for s in t["_segs"]), default=0.0)
    ok = end <= limit + 0.011
    t["checks"].append({"name": "no_ending", "ok": ok,
                        "detail": f"ends at {stamp(end)}; the episode's last quarter starts at {stamp(limit)}"})
    t["code_ok"] = t["code_ok"] and ok


def fit_pieces(raw: dict, eps: dict[int, Episode], lo: float, hi: float) -> dict:
    """A multi-piece promo a few seconds too long: trim the middle (later pieces start later,
    earlier pieces end sooner). The hook (first piece's start) and the final cliffhanger never move."""
    pieces = [dict(first=str(x["first"]), last=str(x["last"])) for x in raw.get("segments") or []]
    original = [dict(p) for p in pieces]
    try:   # 1. cap every piece to its share: earlier pieces keep their opening beat, the last keeps its cliffhanger
        share = hi * 0.92 / max(1, len(pieces))
        for i, pc in enumerate(pieces):
            ep = eps[episode_of(pc["first"])]
            ids = ep.by_id()
            beats = [e for e in ep.events if e.kind in ("dialogue", "action")
                     and ids[pc["first"]].start - 0.011 <= e.start <= ids[pc["last"]].start]
            if not beats or ids[pc["last"]].end - ids[pc["first"]].start <= share + 2:
                continue
            if i == len(pieces) - 1:
                keep = [e for e in beats if ids[pc["last"]].end - e.start <= share] or beats[-1:]
                pc["first"] = keep[0].id
            else:
                keep = [e for e in beats if e.end - ids[pc["first"]].start <= share] or beats[:1]
                pc["last"] = keep[-1].id
    except (KeyError, ValueError):
        pass
    item = build({"segments": pieces}, eps, lo, hi)
    for _ in range(200):
        if item["code_ok"] or item["problems"] or item["length"] <= hi or len(pieces) < 2:
            return item | {"fitted": pieces != original}
        options = []
        for i, pc in enumerate(pieces):
            ep = eps[episode_of(pc["first"])]
            spoken = [e.id for e in ep.events if e.kind in ("dialogue", "action")]
            ids = [x for x in spoken if ep.by_id()[pc["first"]].start - 0.011 <= ep.by_id()[x].start <= ep.by_id()[pc["last"]].start]
            if len(ids) < 2:
                continue
            if i > 0:                    # start a later piece later
                options.append((i, "first", ids[1]))
            if i < len(pieces) - 1:      # end an earlier piece sooner
                options.append((i, "last", ids[-2]))
        if not options:
            break
        segs = item["_segs"]
        i, side, new = max(options, key=lambda o: segs[o[0]].length if o[0] < len(segs) else 0)
        pieces[i][side] = new
        item = build({"segments": pieces}, eps, lo, hi)
    return item | {"fitted": True}


def stitch(provider, pool: list[dict], eps: dict[int, Episode], cfg: RunConfig | None = None, story: dict | None = None) -> list[dict]:
    """Whole-show trailers, built from the strongest moments of different episodes."""
    best, seen_eps = [], set()
    for p in pool:                        # the ranked promos, one moment per episode
        e = p["_segs"][0].episode
        if e not in seen_eps:
            best.append(p); seen_eps.add(e)
        if len(best) == 12:
            break
    if len(best) < 3:
        return []
    best.sort(key=lambda p: p["_segs"][0].episode)
    blocks = []
    for p in best:
        s = p["_segs"]
        ids = [e.id for e in eps[s[0].episode].events if s[0].start - 0.011 <= e.start < s[-1].end and e.kind in ("dialogue", "action")]
        blocks.append(f"EPISODE {s[0].episode} | {p['title']} | hook: {p['hook']} | cliffhanger: {p['cliffhanger']}\n"
                      + "\n".join(l for l in script_lines(eps[s[0].episode]).splitlines() if l[1:].split("]")[0] in ids))
    lo, hi = (cfg.trailer_min, cfg.trailer_max) if cfg else (60.0, 90.0)
    data = ask_json(provider, trailer_system(lo, hi), "SERIES SYNOPSIS:\n" + synopsis(eps) +
                    (f"\n\nSTORY STRUCTURE: turning points by episode {story['turning_points']}; mood: {story['mood']}; themes: {', '.join(story['themes'])}" if story else "") +
                    "\n\nSTRONGEST MOMENTS, BY EPISODE:\n\n" +
                    "\n\n".join(blocks) + (guidance(cfg) if cfg else "") + "\n\nReturn 3 different trailers.")
    out = []
    for p in (data.get("trailers") or data.get("promos") or [])[:4]:
        if not isinstance(p, dict):
            continue
        item = {**_clean(p), **fit_pieces(p, eps, lo, hi), "stitched": True}
        item["source_episode"] = min((s.episode for s in item["_segs"]), default=0)
        if len({s.episode for s in item["_segs"]}) >= 2:
            out.append(item)
    return out


def judge(provider, item: dict, eps: dict[int, Episode]) -> dict:
    segs = item["_segs"]
    seen = transcript(segs, eps)
    cold = ask_json(provider, COLD_SYSTEM, f"THE AD ({item['length']:.0f} s):\n{seen}")
    guard = ask_json(provider, GUARD_SYSTEM,
                     f"SERIES SYNOPSIS:\n{synopsis(eps)}\n\nTHE PROMO:\n{seen}\n\nWHAT HAPPENS RIGHT AFTER THE CUT:\n{after_cut(segs[-1], eps)}")
    return {
        "cold_viewer": {k: cold.get(k) for k in ("who_to_root_for", "stakes", "open_question", "understandable", "swipe_second")},
        "cliffhanger_open": bool(guard.get("cliffhanger_open", True)),
        "cliffhanger_reason": str(guard.get("cliffhanger_reason") or ""),
        "spoiler": bool(guard.get("spoiler", False)),
        "spoiler_reason": str(guard.get("spoiler_reason") or ""),
    }


def score(p: dict) -> float:
    s = sum(WEIGHTS[k] * p["scores"].get(k, 5) for k in WEIGHTS)
    j = p.get("ai_checks")
    if j:
        if j["spoiler"]:
            s -= 3.0
        sw = j["cold_viewer"].get("swipe_second")
        if isinstance(sw, (int, float)) and sw < p["length"] * 0.5:
            s -= 1.0
    return round(s - 0.02 * (p.get("source_episode", 1) - 1), 3)   # earlier episode wins a tie


def overlaps(a: dict, b: dict) -> bool:
    for x in a["_segs"]:
        for y in b["_segs"]:
            if x.episode == y.episode:
                inter = min(x.end, y.end) - max(x.start, y.start)
                if inter > 0.4 * min(x.length, y.length):
                    return True
    return False


def rank(pool: list[dict]) -> list[dict]:
    """Best first; drop near-duplicates; push repeats of a hook type down so the top spreads angles."""
    left = sorted(pool, key=lambda p: -score(p))
    chosen: list[dict] = []
    while left:
        def adjusted(p: dict) -> float:
            same = sum(1 for c in chosen[:6] if c["hook_type"] == p["hook_type"])
            return score(p) - 0.6 * same
        best = max(left, key=adjusted)
        left.remove(best)
        if any(overlaps(best, c) for c in chosen):
            continue
        best["score"] = round(adjusted(best), 3)
        chosen.append(best)
    for i, p in enumerate(chosen, 1):
        p["rank"] = i
    return chosen


# ---------------------------------------------------------------- run

def run_show(provider, eps: dict[int, Episode], show_title: str, cfg: RunConfig | None = None,
             progress: Progress | None = None) -> dict:
    cfg = cfg or RunConfig()
    if not cfg.leads:
        cfg.leads = main_characters(eps)
    workers = max(1, cfg.concurrency or getattr(provider, "concurrency", 4))
    say = progress or (lambda *a: None)
    t0 = time.monotonic()
    targets = [n for n in sorted(eps) if not cfg.episodes or n in cfg.episodes]
    found, errors = [], []
    say("find", 0, len(targets), "Reading episodes")
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(find_episode, provider, eps[n], eps, cfg, show_title): n for n in targets}
        for k, f in enumerate(as_completed(futs), 1):
            n = futs[f]
            try:
                found.append(f.result())
            except ProviderError as err:
                if err.fatal:
                    raise
                errors.append({"episode": n, "error": str(err)})
            except Exception as err:   # one bad episode never sinks the show
                errors.append({"episode": n, "error": f"{type(err).__name__}: {err}"})
            say("find", k, len(targets), f"Episode {n}")

    candidates = [apply_rubric(p, eps, cfg.leads) for r in found for p in r["promos"]]
    passing = [p for p in candidates if p["code_ok"]]
    rejected = [p for p in candidates if not p["code_ok"]]
    teasers = sorted([r["teaser"] for r in found if r["teaser"]], key=lambda t: t["for_episode"]) if cfg.teasers else []

    finalists = sorted(passing, key=lambda p: -score(p))[: cfg.finalists]
    if cfg.judge:
        say("judge", 0, len(finalists), "Checking finalists")
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(judge, provider, p, eps): i for i, p in enumerate(finalists)}
            for k, f in enumerate(as_completed(futs), 1):
                try:
                    finalists[futs[f]]["ai_checks"] = f.result()
                    apply_rubric(finalists[futs[f]], eps, cfg.leads)
                except ProviderError as err:
                    if err.fatal:
                        raise
                    finalists[futs[f]]["ai_checks_error"] = str(err)
                except Exception as err:
                    finalists[futs[f]]["ai_checks_error"] = str(err)
                say("judge", k, len(finalists), "Checked")

    ranked = rank(finalists)
    rest = rank([p for p in passing if p not in finalists and not any(overlaps(p, q) for q in ranked)])
    for p in rest:
        p["rank"] += len(ranked)
        p["judged"] = False
    ranked += rest

    trailers: list[dict] = []
    story: dict | None = None
    if cfg.stitch and len({p["_segs"][0].episode for p in ranked}) >= 3:
        say("stitch", 0, 1, "Mapping the story, then building whole-show trailers")
        try:
            try:
                story = story_map(provider, eps)
            except ProviderError as err:
                if err.fatal:
                    raise
            except Exception:
                story = None
            st = [apply_rubric(t, eps, cfg.leads) for t in stitch(provider, ranked, eps, cfg, story)]
            rejected += [p for p in st if not p["code_ok"]]
            trailers = [p for p in st if p["code_ok"]]
            if cfg.judge:
                for t in trailers:
                    try:
                        t["ai_checks"] = judge(provider, t, eps)
                        apply_rubric(t, eps, cfg.leads)
                    except ProviderError as err:
                        if err.fatal:
                            raise
                        t["ai_checks_error"] = str(err)
            trailers = sorted(trailers, key=lambda p: -score(p))
            for i, t in enumerate(trailers, 1):
                t["rank"], t["score"] = i, score(t)
        except ProviderError as err:
            if err.fatal:
                raise
            errors.append({"episode": 0, "error": f"trailers skipped: {err}"})
        except Exception as err:
            errors.append({"episode": 0, "error": f"trailers: {err}"})
        say("stitch", 1, 1, "Trailers built")
    usage = provider.usage
    return {
        "id": time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6],
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "show": show_title,
        "provider": provider.name, "model": provider.model,
        "episodes": targets,
        "config": {k: v for k, v in cfg.__dict__.items() if k != "taste"} | {"taste_examples": len(cfg.taste or [])},
        "stats": {"calls": usage.calls, "cached": usage.cached, "retries": usage.retries,
                  "prompt_tokens": usage.prompt_tokens, "completion_tokens": usage.completion_tokens,
                  "model_seconds": round(usage.seconds, 1), "wall_seconds": round(time.monotonic() - t0, 1),
                  "candidates": len(candidates), "passed_code_checks": len(passing), "finalists": len(finalists),
                  "repaired": sum(1 for p in candidates if p.get("repaired"))},
        "errors": errors,
        "promos": [_public(p) for p in ranked],
        "rejected": [_public(p) for p in rejected],
        "teasers": [_public(t) for t in teasers],
        "trailers": [_public(t) for t in trailers],
        "story": story,
        "leads": cfg.leads or [],
    }


def _public(p: dict) -> dict:
    return {k: v for k, v in p.items() if not k.startswith("_")}


def save(run: dict, folder) -> str:
    from pathlib import Path
    d = Path(folder)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{run['id']}.json"
    path.write_text(json.dumps(run, indent=2, ensure_ascii=False))
    return str(path)
