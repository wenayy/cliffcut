import { Pause, Play, Video } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SegOut } from '../lib'
import { tc } from '../lib'

/*
 * Plays the promo itself from the episode videos on this computer: piece 1, then piece 2…,
 * each from its IN to its OUT. Files are read in the browser (object URLs); nothing is uploaded.
 */
export function VideoPreview({ segs, videos, onAttach }: {
  segs: SegOut[]; videos: Record<number, string>; onAttach: (files: File[]) => void
}) {
  const v = useRef<HTMLVideoElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [piece, setPiece] = useState(-1)
  const [now, setNow] = useState(0)
  const missing = [...new Set(segs.map(s => s.episode))].filter(n => !videos[n])

  const playPiece = (i: number) => {
    const el = v.current, s = segs[i]
    if (!el || !s) { setPiece(-1); return }
    setPiece(i)
    const go = () => { el.currentTime = s.start_s; el.play().catch(() => {}) }
    if (el.dataset.ep !== String(s.episode)) {
      el.src = videos[s.episode]; el.dataset.ep = String(s.episode)
      el.onloadedmetadata = go
    } else go()
  }
  useEffect(() => { setPiece(-1); v.current?.pause() }, [segs])

  const onTime = () => {
    const el = v.current, s = segs[piece]
    if (!el || !s) return
    const done = segs.slice(0, piece).reduce((a, x) => a + x.length_s, 0)
    setNow(done + Math.max(0, el.currentTime - s.start_s))
    if (el.currentTime >= s.end_s - 0.03) { el.pause(); playPiece(piece + 1 < segs.length ? piece + 1 : -1) }
  }

  if (missing.length) return (
    <div className="mx-auto w-[216px] aspect-[9/16] rounded-[16px] border border-dashed border-fg-3/30 grid place-items-center p-5 text-center">
      <div>
        <Video size={20} strokeWidth={1.5} className="mx-auto text-fg-3" />
        <p className="mt-2 text-[12px] leading-[17px] text-fg-2">Watch this promo: attach the video for episode{missing.length > 1 ? 's' : ''} {missing.join(', ')}</p>
        <p className="mt-1 text-[11px] leading-4 text-fg-3">Files stay on this computer. Name them with the episode number, e.g. ep03.mp4</p>
        <input ref={input} type="file" accept="video/*" multiple className="hidden" onChange={e => onAttach(Array.from(e.target.files ?? []))} />
        <button onClick={() => input.current?.click()} className="mt-3 h-8 rounded-[8px] border hairline px-3 text-[12px] text-fg-1 hover:bg-ink-3 transition-colors duration-150">Attach videos</button>
      </div>
    </div>
  )

  const total = segs.reduce((a, s) => a + s.length_s, 0)
  return (
    <div className="mx-auto w-[216px]">
      <div className="relative aspect-[9/16] overflow-hidden rounded-[16px] border hairline bg-black">
        <video ref={v} playsInline onTimeUpdate={onTime} className="h-full w-full object-cover" />
        <span className="absolute left-2 top-2 rounded-[6px] bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white/80 tnum">
          {piece >= 0 ? `piece ${piece + 1}/${segs.length} · ep ${segs[piece].episode} · ${tc(v.current?.currentTime ?? 0)}` : `${segs.length} piece${segs.length > 1 ? 's' : ''}`}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button onClick={() => piece >= 0 ? (v.current?.pause(), setPiece(-1)) : playPiece(0)} aria-label={piece >= 0 ? 'Stop' : 'Play the promo'}
          className="grid size-8 place-items-center rounded-full bg-fg-1 text-ink-1 hover:bg-white transition-colors duration-150">
          {piece >= 0 ? <Pause size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} className="translate-x-px" />}
        </button>
        <div className="h-1 flex-1 rounded-full bg-ink-3"><div className="h-full rounded-full bg-pencil" style={{ width: `${Math.min(100, (now / total) * 100)}%` }} /></div>
        <span className="font-mono text-[10px] text-fg-3 tnum">{now.toFixed(0)}/{total.toFixed(0)} s</span>
      </div>
    </div>
  )
}
