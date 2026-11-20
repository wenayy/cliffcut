import type { Episode, SegOut } from '../lib'

function m(t: number) {
  const mm = Math.floor(t / 60), s = Math.round(t - mm * 60)
  return `${mm}:${String(s).padStart(2, '0')}`
}

/* Where the promo sits, drawn instead of written: one bar per episode it uses, the part that plays filled in,
   the hook (H) and the cut (C) marked, and every camera change as a faint tick. Times on the bar are the
   episode's own clock; the line under it says how long that piece plays. */
export function CutStrip({ segs, eps, onJump }: { segs: SegOut[]; eps: Record<number, Episode>; onJump?: (episode: number) => void }) {
  if (!segs.length) return null
  let offset = 0
  return (
    <div className="shrink-0 border-b hairline px-6 py-3 space-y-3">
      {segs.map((s, i) => {
        const ep = eps[s.episode]
        const dur = ep?.duration || s.end_s
        const pct = (t: number) => `${Math.max(0, Math.min(100, (t / dur) * 100))}%`
        const cuts = ep ? ep.events.filter(e => e.kind === 'camera').map(e => e.start) : []
        const hook = s.start_s + (i === 0 ? (s.hook_delay_s ?? 0) : 0)
        const from = offset
        offset += s.length_s
        return (
          <div key={i}>
            <div className="mb-1 flex items-baseline gap-2 text-[11px]">
              <button onClick={() => onJump?.(s.episode)} className="text-fg-2 hover:text-fg-1 hover:underline underline-offset-2">
                {segs.length > 1 ? `Piece ${i + 1} · ` : ''}Episode {s.episode}
              </button>
              <span className="font-mono text-fg-3 tnum">{m(s.start_s)} → {m(s.end_s)} of {m(dur)}</span>
              <span className="ml-auto font-mono text-fg-2 tnum">plays {m(from)}–{m(offset)} · {s.length_s.toFixed(0)} s</span>
            </div>
            <div className="relative h-6 rounded-[6px] bg-ink-3 overflow-hidden" aria-label={`Episode ${s.episode}, ${m(s.start_s)} to ${m(s.end_s)}`}>
              {cuts.map((c, k) => <span key={k} className="absolute inset-y-1 w-px bg-fg-3/25" style={{ left: pct(c) }} />)}
              <span className="absolute inset-y-0 bg-pencil/35 border-x-2 border-pencil" style={{ left: pct(s.start_s), width: `calc(${pct(s.end_s)} - ${pct(s.start_s)})` }} />
              {i === 0 && <span className="absolute top-0 -translate-x-1/2 rounded-b-[3px] bg-pencil px-1 font-mono text-[9px] leading-3 text-ink-0" style={{ left: pct(hook) }} title="The hook lands here">H</span>}
              {i === segs.length - 1 && <span className="absolute bottom-0 -translate-x-1/2 rounded-t-[3px] bg-fg-1 px-1 font-mono text-[9px] leading-3 text-ink-0" style={{ left: pct(s.end_s) }} title="The cut: the cliffhanger">C</span>}
            </div>
          </div>
        )
      })}
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-3">
        <span><span className="inline-block h-2 w-3 rounded-[2px] bg-pencil/50 align-middle mr-1" />what plays</span>
        <span><span className="inline-block rounded-[2px] bg-pencil px-0.5 font-mono text-[9px] text-ink-0 mr-1">H</span>hook lands</span>
        <span><span className="inline-block rounded-[2px] bg-fg-1 px-0.5 font-mono text-[9px] text-ink-0 mr-1">C</span>cut on the cliffhanger</span>
        <span><span className="inline-block h-2 w-px bg-fg-3 align-middle mr-1" />camera change (cuts land only on these or in a pause)</span>
      </p>
    </div>
  )
}
