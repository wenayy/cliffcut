import { useEffect, useMemo, useRef } from 'react'
import type { Episode, Ev, SegOut } from '../lib'
import { tc } from '../lib'

const EPS = 0.011

function fmt(t: number) {
  const m = Math.floor(t / 60), s = Math.floor(t - m * 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/* One line of script, the way an editor reads a running order. */
function Beat({ ev, showCamera }: { ev: Ev; showCamera: boolean }) {
  if (ev.kind === 'camera') return showCamera ? <p className="font-sans text-[12px] leading-[18px] text-fg-3">Shot: {ev.text}</p> : null
  if (ev.kind === 'dialogue')
    return (
      <div>
        <p className="font-sans text-[12px] leading-4 text-fg-2">{ev.speaker.toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase())}{ev.emotion && <span className="text-fg-3"> · {ev.emotion.toLowerCase()}</span>}</p>
        <p className="font-script text-[15px] leading-[22px] text-fg-1">{ev.text}</p>
      </div>
    )
  return <p className={`font-script text-[14px] leading-[21px] ${ev.kind === 'sfx' ? 'text-fg-3' : 'text-fg-2'}`}>{ev.kind === 'sfx' ? 'Sound: ' : ''}{ev.text}</p>
}

/* The promo, and nothing else: what plays, in order, timed from 0:00. */
export function PromoScript({ segs, eps, showCamera }: { segs: SegOut[]; eps: Record<number, Episode>; showCamera: boolean }) {
  let offset = 0
  return (
    <div className="mx-auto max-w-[620px] px-6 pb-24 pt-4">
      {segs.map((s, i) => {
        const ep = eps[s.episode]
        const evs = ep ? ep.events.filter(e => e.start >= s.start_s - EPS && e.start < s.end_s - EPS) : []
        const base = offset
        offset += s.length_s
        return (
          <div key={i}>
            {segs.length > 1 && (
              <p className="mt-6 mb-2 font-mono text-[11px] text-fg-3 tnum">
                Piece {i + 1} of {segs.length} · episode {s.episode} · {tc(s.start_s)} to {tc(s.end_s)} in the episode
              </p>
            )}
            {i === 0 && <p className="mb-3 inline-block rounded-[6px] bg-pencil/15 px-2 py-0.5 text-[12px] text-pencil">Starts here: the hook</p>}
            <ol className="space-y-3">
              {evs.map(e => {
                if (e.kind === 'camera' && !showCamera) return null
                const node = <Beat ev={e} showCamera={showCamera} />
                return (
                  <li key={e.id} className="grid grid-cols-[44px_1fr] gap-x-3">
                    <span className="pt-0.5 font-mono text-[11px] text-fg-3 tnum">{fmt(base + Math.max(0, e.start - s.start_s))}</span>
                    {node}
                  </li>
                )
              })}
            </ol>
          </div>
        )
      })}
      <p className="mt-5 inline-block rounded-[6px] bg-pencil/15 px-2 py-0.5 text-[12px] text-pencil">Cut here, at {fmt(offset)}: the cliffhanger</p>
    </div>
  )
}

interface Props {
  episode: Episode
  segments: SegOut[]          // this episode's pieces of the selected promo
  marks: { in?: string; out?: string }
  focusId?: string
  onFocus: (id: string) => void
  showCamera: boolean
}

/* The whole episode: tinted lines are in the promo, with a marker where it starts and ends. */
export function LinedScript({ episode, segments, marks, focusId, onFocus, showCamera }: Props) {
  const inSeg = (ev: Ev) => segments.find(s => ev.start >= s.start_s - EPS && ev.start < s.end_s - EPS)
  const markRange = useMemo(() => {
    if (!marks.in) return null
    const a = episode.events.find(e => e.id === marks.in), b = marks.out ? episode.events.find(e => e.id === marks.out) : a
    return a && b ? [Math.min(a.start, b.start), Math.max(a.start, b.start)] as const : null
  }, [marks, episode])

  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!segments[0]) return
    const first = episode.events.find(e => e.start >= segments[0].start_s - EPS)
    box.current?.querySelector(`[data-id="${first?.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [segments, episode])
  useEffect(() => { if (focusId) box.current?.querySelector(`[data-id="${focusId}"]`)?.scrollIntoView({ block: 'nearest' }) }, [focusId])

  const rows = episode.events.filter(e => showCamera || e.kind !== 'camera' || e.id === focusId)
  return (
    <div ref={box} className="pb-24" role="listbox" aria-label={`Episode ${episode.number} script`}>
      {rows.map((ev, i) => {
        const seg = inSeg(ev)
        const prev = i > 0 ? inSeg(rows[i - 1]) : undefined
        const next = i < rows.length - 1 ? inSeg(rows[i + 1]) : undefined
        const marked = markRange && ev.start >= markRange[0] - EPS && ev.start <= markRange[1] + EPS
        const focused = focusId === ev.id
        return (
          <div key={ev.id}>
            {seg && seg !== prev && <Marker text={`Ad starts here · ${tc(seg.start_s)} in the episode`} />}
            <div data-id={ev.id} role="option" aria-selected={focused} onClick={() => onFocus(ev.id)}
              className={`grid grid-cols-[76px_1fr] gap-x-3 px-5 py-2 cursor-default transition-colors duration-150 ${
                focused ? 'bg-ink-3' : seg ? 'bg-pencil/[0.07] hover:bg-pencil/[0.11]' : marked ? 'bg-ink-2' : 'hover:bg-ink-2/70'}`}>
              <span className="pt-0.5 font-mono text-[11px] text-fg-3 tnum flex gap-1">
                {marks.in === ev.id ? <Tag>In</Tag> : marks.out === ev.id ? <Tag>Out</Tag> : tc(ev.start)}
              </span>
              <Beat ev={ev} showCamera />
            </div>
            {seg && seg !== next && <Marker text={`Ad cuts here · ${tc(seg.end_s)}`} />}
          </div>
        )
      })}
    </div>
  )
}

function Marker({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 px-5 py-1.5" aria-hidden>
      <span className="h-px flex-1 bg-pencil/60" />
      <span className="font-mono text-[11px] text-pencil tnum">{text}</span>
      <span className="h-px w-6 bg-pencil/60" />
    </div>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-[4px] bg-pencil/20 px-1 text-[10px] text-pencil">{children}</span>
}

export function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border hairline bg-ink-3 px-1 font-mono text-[10px] text-fg-2 shadow-[inset_0_-1px_0_rgb(0_0_0/0.4)]">
      {children}
    </kbd>
  )
}
