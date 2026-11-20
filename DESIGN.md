# Cliffcut design system

**Direction:** a lined script.

A script supervisor's lined script draws a vertical line for every camera setup beside the dialogue it covers. Cliffcut's main view is exactly that page, and the promo's cuts are drawn over it in red pencil. Everything else stays quiet so the script and the cuts carry the screen.

**Mode:** Operate.

The layout is a standard pro-tool layout:

- left rail,
- list column,
- script canvas,
- inspector.

The columns are resizable (react-resizable-panels, the library behind the shadcn/21st.dev Resizable).

## Tokens (web/src/index.css)

| Role | Token | Value |
|---|---|---|
| Rail / deepest | ink-0 | #0e0e0f |
| Page | ink-1 | #131314 |
| Card / hover | ink-2 | #19191a |
| Raised / active row | ink-3 | #222224 |
| Menu hover | ink-4 | #2b2b2e |
| Hairline | fg-1 at 8% | `hairline` utility |
| Text primary / secondary / muted | fg-1 / fg-2 / fg-3 | #ececea / #a3a3a0 / #858582 |
| **Cut marks only** | pencil | #e2553f |
| Pass / fail | ok / bad | #4cc38a / #e5484d |

**Hook types** take the colours of screenplay revision pages:

| Hook type | Revision colour |
|---|---|
| Identity reversal | goldenrod #d6a552 |
| Forced marriage | pink #e295b0 |
| Humiliation → revenge | blue #8aaee6 |
| Forbidden romance | green #93c7a0 |

Yellow #e2cd7a is reserved.

**Type:**

- Geist (interface).
- Geist Mono (timecodes, counts and meta, always tabular).
- Courier Prime (script text only; it's the screenplay's own face, so it's content, not decoration).
- Weights 400 and 500. Sentence case. Character names stay in caps because screenplays set them that way.

**Radius:** keycaps 4, rows and controls 8, cards and menus 10, the preview frame 16.

**Motion:** one curve, `cubic-bezier(0.22, 1, 0.36, 1)`; 150 ms for hover and press; press scales to 0.98. Reduced motion is honoured.

## Signature

- **Coverage lines:**
  - A 1.5 px fg-2 line in the left gutter for each shot.
  - Shots stagger across 3 lanes; each starts with a tick and its shot number.
  - A line of dialogue that carries over the next cut (an L-cut) continues faintly in the next lane.
- **Red pencil:** a 2 px line in the right gutter.
  - IN and OUT ticks show the real cut times.
  - A dashed pencil line marks a range that isn't cut yet.
  - Pencil is never used for anything else.
- **Logo:** two coverage lines (one straight, one with the off-camera squiggle) crossed by a red pencil cut.
  - It draws itself once on load (stroke-dash, 0.9 s total) and redraws on hover.
  - The loading glyph is the same pencil, used only while real work is running.

## Rules

- Every number on screen comes from the API: a real run or a real check. Empty states say what will appear and when.
- Failures are shown in red with the reason, never hidden.
- Keyboard first:
  - ↑ and ↓ move;
  - I and O mark in and out;
  - ↵ cuts;
  - [ and ] change episode;
  - Esc clears.
