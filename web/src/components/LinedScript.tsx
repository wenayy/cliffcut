import { useEffect, useMemo, useRef } from 'react'
import type { Episode, Ev, SegOut } from '../lib'
import { tc } from '../lib'

/*
 * The signature view. Like a script supervisor's lined script: every camera
 * setup draws a coverage line in the left gutter beside the lines it covers,
 * staggered so neighbouring shots read apart; a line that carries over a cut
 * (an L-cut) continues in the next shot's lane. The promo's cuts are drawn in
 * red pencil in the right gutter, with IN and OUT ticks at the real cut times.
 */

const LANES = [11, 22, 33]
const EPS = 0.011

interface Props {
  episode: Episode
  segments: SegOut[]          // this episode's segments of the active promo
  hookId?: string
  cliffId?: string
  marks: { in?: string; out?: string }
  focusId?: string
  onFocus: (id: string) => void
  others?: { start: number; end: number; title: string }[]   // other promos in this episode, drawn faintly
}

interface Row { ev: Ev; shot: number; lane: number; carries: boolean; shotStart: boolean }

export function LinedScript({ episode, segments, hookId, cliffId, marks, focusId, onFocus, others = [] }: Props) {
  const rows = useMemo<Row[]>(() => {
    const cams = episode.events.filter(e => e.kind === 'camera')
    const shotAt = (t: number) => {
      let i = 0
      for (let k = 0; k < cams.length; k++) if (cams[k].start <= t + EPS) i = k
      return i
    }
    return episode.events.map(ev => {
      const shot = ev.kind === 'camera' ? cams.indexOf(ev) : shotAt(ev.start)
      const cam = cams[shot]
      return {
        ev, shot, lane: LANES[shot % 3],
        carries: ev.kind === 'dialogue' && !!cam && ev.end > cam.end + EPS,
        shotStart: ev.kind === 'camera',
      }
    })
  }, [episode])

  const inSeg = (ev: Ev) => segments.find(s => ev.start >= s.start_s - EPS && ev.start < s.end_s - EPS)
  const active = segments.length > 0

  const markRange = useMemo(() => {
    if (!marks.in) return null
    const a = episode.events.find(e => e.id === marks.in)
    const b = marks.out ? episode.events.find(e => e.id === marks.out) : a
    if (!a || !b) return null
    return [Math.min(a.start, b.start), Math.max(a.start, b.start)] as const
  }, [marks, episode])

  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!segments[0]) return
    const first = episode.events.find(e => e.start >= segments[0].start_s - EPS)
    box.current?.querySelector(`[data-id="${first?.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [segments, episode])
  useEffect(() => {
    if (focusId) box.current?.querySelector(`[data-id="${focusId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focusId])

  return (
    <div ref={box} className="font-script text-[14px] leading-[22px] pb-24" role="listbox" aria-label={`Episode ${episode.number} script`}>
      {rows.map((r, i) => {
        const seg = inSeg(r.ev)
        const prevSeg = i > 0 ? inSeg(rows[i - 1].ev) : undefined
        const nextSeg = i < rows.length - 1 ? inSeg(rows[i + 1].ev) : undefined
        const isIn = !!seg && seg !== prevSeg
        const isOut = !!seg && seg !== nextSeg
        const marked = markRange && r.ev.start >= markRange[0] - EPS && r.ev.start <= markRange[1] + EPS
        const focused = focusId === r.ev.id
        const nextShotStarts = rows[i + 1]?.shotStart
        return (
          <div
            key={r.ev.id}
            data-id={r.ev.id}
            role="option"
            aria-selected={focused}
            onClick={() => onFocus(r.ev.id)}
            className={[
              'group grid grid-cols-[72px_44px_1fr_84px] transition-[opacity,background-color] duration-150',
              active && !seg ? 'opacity-40 hover:opacity-80' : '',
              focused ? 'bg-ink-3' : marked ? 'bg-ink-2' : 'hover:bg-ink-2/70',
            ].join(' ')}
          >
            {/* timecode */}
            <div className="pl-4 pt-[7px] font-mono text-[11px] leading-4 text-fg-3 tnum flex items-start gap-1">
              {marks.in === r.ev.id && <Key>I</Key>}
              {marks.out === r.ev.id && <Key>O</Key>}
              {!(marks.in === r.ev.id || marks.out === r.ev.id) && (r.shotStart || r.ev.kind === 'dialogue') && tc(r.ev.start)}
            </div>

            {/* coverage gutter */}
            <div className="relative" aria-hidden>
              <span
                className="absolute w-[1.5px] bg-fg-2/70"
                style={{ left: r.lane, top: r.shotStart ? 11 : 0, bottom: nextShotStarts ? 0 : 0 }}
              />
              {r.shotStart && (
                <>
                  <span className="absolute h-[1.5px] w-[7px] bg-fg-2/70" style={{ left: r.lane - 3, top: 10 }} />
                  <span className="absolute font-mono text-[9px] leading-none text-fg-3 tnum" style={{ left: r.lane + 4, top: 2 }}>
                    {r.shot + 1}
                  </span>
                </>
              )}
              {r.carries && (
                <span className="absolute w-[1.5px] bg-fg-2/40" style={{ left: LANES[(r.shot + 1) % 3], top: '55%', bottom: 0 }} />
              )}
            </div>

            {/* the script itself */}
            <div className={`py-[6px] pr-4 min-w-0 ${focused ? 'text-fg-1' : ''}`}>
              <Line ev={r.ev} />
              {(r.ev.id === hookId || r.ev.id === cliffId) && (
                <span className="mt-1 inline-block font-sans text-[11px] leading-4 text-pencil">
                  {r.ev.id === hookId ? 'Hook' : 'Cliffhanger'}
                </span>
              )}
            </div>

            {/* red pencil: the promo's cuts; other promos in this episode as faint grey lines */}
            <div className="relative" aria-hidden>
              {others.filter(o => r.ev.start >= o.start - EPS && r.ev.start < o.end - EPS).slice(0, 3).map((o, k) => (
                <span key={k} title={o.title} className="absolute w-px bg-fg-3/45" style={{ left: 4 + k * 3, top: 0, bottom: 0 }} />
              ))}
              {marked && !seg && (
                <span className="absolute border-l-2 border-dashed border-pencil/70" style={{ left: 14, top: 0, bottom: 0 }} />
              )}
              {seg && (
                <span className="absolute w-[2px] bg-pencil rounded-full" style={{ left: 14, top: isIn ? 9 : 0, bottom: isOut ? 9 : 0 }} />
              )}
              {isIn && (
                <>
                  <span className="absolute h-[2px] w-[12px] bg-pencil rounded-full" style={{ left: 3, top: 8 }} />
                  <span className="absolute font-mono text-[10px] leading-3 text-pencil tnum" style={{ left: 22, top: 3 }}>IN<br />{seg.start}</span>
                </>
              )}
              {isOut && seg && (
                <>
                  <span className="absolute h-[2px] w-[12px] bg-pencil rounded-full" style={{ left: 3, bottom: 8 }} />
                  <span className="absolute font-mono text-[10px] leading-3 text-pencil tnum" style={{ left: 22, bottom: 3 }}>OUT<br />{seg.end}</span>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Line({ ev }: { ev: Ev }) {
  if (ev.kind === 'camera')
    return <p className="font-sans text-[12px] leading-[18px] text-fg-3 truncate" title={ev.text}><span className="text-fg-3/70">Camera: </span>{ev.text}</p>
  if (ev.kind === 'action') return <p className="text-fg-1"><span className="font-sans text-[11px] text-fg-3 mr-1.5">Action</span>{ev.text}</p>
  if (ev.kind === 'sfx') return <p className="text-fg-2"><span className="font-sans text-[11px] text-fg-3 mr-1.5">Sound</span>{ev.text}</p>
  return (
    <div className="pl-[12%] pr-[8%]">
      <p className="uppercase text-fg-1 tracking-normal">
        {ev.speaker}
        {ev.emotion && <span className="normal-case text-fg-3"> ({ev.emotion.toLowerCase()})</span>}
      </p>
      <p className="text-fg-1">{ev.text}</p>
    </div>
  )
}

export function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border hairline bg-ink-3 px-1 font-mono text-[10px] text-fg-2 shadow-[inset_0_-1px_0_rgb(0_0_0/0.4)]">
      {children}
    </kbd>
  )
}
