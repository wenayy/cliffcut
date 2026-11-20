# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React + Vite + TypeScript + Tailwind, with shadcn / 21st.dev components and Motion for animation. A Python FastAPI backend reuses `promo/` (parser, clean-cut logic, checks). User-confirmed 20 Nov 2026.

## Users

- **Primary:** a promo editor or growth marketer at a microdrama app (Kuku). They have a show's episode screenplays, which are timestamped and run about 2 minutes per episode. They need ad-ready promo cuts and next-episode teasers fast, and they review, adjust and export them for an editor to cut in Premiere or Resolve.
- **Secondary:** Kuku's hiring panel. They evaluate the tool live in an interview on a new input, possibly with their own model, and watch a 3-minute walkthrough.

## Product Purpose

Cliffcut reads every episode of a show and finds the strongest 20–60 second promos. Each promo has a hook in the first 3 seconds, a cliffhanger at the end, and makes sense to a stranger. It ranks them and lets a human edit them, and code makes every cut clean. Success means an editor gets a shortlist of ready-to-cut promos in minutes instead of watching the whole show.

## Positioning

- The AI points at script events, and code computes the cuts. No chopped lines and no flash frames, tested on 2,974 real segments.
- Every promo is checked, and failures are shown:
  - cliffhanger still open past the cut;
  - a cold viewer understands it;
  - no spoiler.
- The model is swappable (Gemini, Groq, OpenAI or any OpenAI-compatible endpoint), and models are compared on the same show.
- It finds the best real footage rather than generating new footage.

## Operating Context

- The input is a folder of episode scripts. In Kuku's format, shots, actions, lines and sound effects each carry their own start and end times and overlap.
- The output is an edit decision list per promo: segments and timecodes, hook, cliffhanger, why it works and hook type. It exports as CSV, JSON and EDL.
- Two outputs:
  - **show promos**, to acquire viewers;
  - **next-episode teasers**, 8–20 s from episode N+1, to retain them.
- Used at a desk for long sessions and recorded on screen for a demo video.

## Capabilities and Constraints

- Kuku's input pack is confidential: never public. The public prototype shows a sample show written by us. Kuku's 50-episode results sit behind a passcode.
- API keys are never shipped to the browser on the public link.
- Promo length is 20–60 s, and the hook must land within 3 s.
- Terms:
  - **event:** a shot, line, action or sound effect;
  - **segment:** one continuous stretch;
  - **promo:** one or more segments;
  - **teaser:** a next-episode promo;
  - **hook type:** identity reversal, forced or contract marriage, humiliation and revenge, or forbidden romance.

## Brand Commitments

- Name: **Cliffcut** (user-chosen).
- The user asked for an animated logo that isn't simple, and a UI that is industry-standard and reads as non-AI.

## Evidence on Hand

- Real test results: 9 tests pass; on the real pack, 0 chopped lines and 0 flash frames across 2,974 segments. Cutting naively on line times causes a defect on 9.8% of lines.
- Research numbers are cited in `docs/PROJECT_NOTES.md` section 11.
- Model comparison results and promo quality numbers **do not exist yet**. Never fabricate them; show empty states until a run produces them.

## Product Principles

1. The human finishes the work. AI narrows the show to a shortlist; the editor decides.
2. Show failures, never hide them.
3. Every number on screen comes from a real run or a real test.
4. Cuts are clean by construction, not by luck.
5. It works on any show, not just this one.
