import { Check, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Download, TriangleAlert, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import type { CheckResult, Episode, Ev, HookType, PromoDraft, SegIn, SegOut } from '../lib'
import { HOOKS, tc } from '../lib'
import { VideoPreview } from './VideoPreview'

interface Props {
  promo: PromoDraft
  result: CheckResult | null
  checking: boolean
  error: string | null
  eps: Record<number, Episode>
  limits: { min: number; max: number }
  total: number
  onChange: (p: PromoDraft) => void
  onNudge: (seg: number, side: 'start' | 'end', dir: -1 | 1) => void
  onRemoveSegment: (seg: number) => void
  onExport: (kind: 'edl' | 'csv' | 'json' | 'mp4' | 'mp4wide') => void
  serverVideos?: number[]
  rendering?: string | null
  onDelete: () => void
  onJump: (episode: number) => void
  onSegments: (segments: SegIn[]) => void
  onRestore?: () => void
  rankWhy?: string
  videos: Record<number, string>
  onAttach: (files: File[]) => void
}

const EPS = 0.011

/* Rebuild the pieces after dropping some shots: each piece keeps what is left, split where a shot was removed. */
function withoutShots(segs: SegOut[], eps: Record<number, Episode>, drop: Ev[]): SegIn[] {
  const out: SegIn[] = []
  for (const s of segs) {
    let parts: [number, number][] = [[s.start_s, s.end_s]]
    for (const c of drop.filter(c => eps[s.episode]?.events.includes(c))) {
      parts = parts.flatMap(([a, b]) => {
        if (c.end <= a + EPS || c.start >= b - EPS) return [[a, b] as [number, number]]
        return [[a, Math.max(a, c.start)], [Math.min(b, c.end), b]].filter(([x, y]) => y - x >= 0.7) as [number, number][]
      })
    }
    for (const [a, b] of parts) {
      const evs = eps[s.episode].events.filter(e => e.start >= a - EPS && e.start < b - EPS)
      if (evs.length) out.push({ episode: s.episode, first: evs[0].id, last: evs[evs.length - 1].id, start: +a.toFixed(2), end: +b.toFixed(2) })
    }
  }
  return out
}

const KIND = { promo: 'Promo', teaser: 'Next-episode teaser', trailer: 'Whole-show trailer' } as const

const SCORE_LABEL: Record<string, string> = {
  hook: 'Stops the scroll (hook)',
  cliffhanger: 'Leaves them hanging (cliffhanger)',
  standalone: 'Makes sense to a stranger',
  emotion: 'Emotional punch',
  clarity: 'Easy to follow',
}

function plainCheck(name: string, detail: string, limits: { min: number; max: number }) {
  switch (name) {
    case 'length': return { label: `Between ${limits.min} and ${limits.max} seconds`, note: detail.replace(/\s*\(allowed.*\)/, '').replace('s', ' s') }
    case 'hook_in_3s': return { label: 'Hook lands in the first 3 seconds', note: detail.replace('hook lands at', 'it lands at').replace(/(\d)s$/, '$1 s') }
    case 'ends_on_reaction': return { label: 'Holds on the reaction after the last line', note: detail.replace('held after the last word', 'held on the face') }
    case 'clean_cuts': return { label: 'Clean cuts: no chopped words, no flashes', note: detail.startsWith('no chopped') ? '' : detail }
    case 'no_ending': return { label: "Doesn't show the episode's ending", note: detail }
    default: return { label: name, note: detail }
  }
}

export function Inspector({ promo, result, checking, error, eps, limits, total, onChange, onNudge, onRemoveSegment, onExport, onDelete, onJump, onSegments, onRestore, rankWhy, videos, onAttach, serverVideos = [], rendering }: Props) {
  const segs = result?.segments ?? []
  const ai = promo.ai
  const j = ai?.ai_checks
  const [exportOpen, setExportOpen] = useState(false)
  const [showShots, setShowShots] = useState(false)

  // every camera shot inside the red line, and whether anyone speaks in it
  const shots = useMemo(() => segs.flatMap((s, piece) => {
    const ep = eps[s.episode]
    if (!ep) return []
    const lines = ep.events.filter(e => e.kind === 'dialogue')
    const things = ep.events.filter(e => e.kind === 'action' || e.kind === 'sfx')
    return ep.events.filter(e => e.kind === 'camera' && e.end > s.start_s + EPS && e.start < s.end_s - EPS).map((c, k, arr) => {
      const a = Math.max(c.start, s.start_s), b = Math.min(c.end, s.end_s)
      const spoken = lines.filter(d => d.start < b - EPS && d.end > a + EPS).length
      const happens = things.filter(d => d.start < b - EPS && d.end > a + EPS).length
      return { c, piece, episode: s.episode, len: b - a, spoken, happens, edge: (piece === 0 && k === 0) || (piece === segs.length - 1 && k === arr.length - 1) }
    })
  }), [segs, eps])
  // dead air: nobody speaks AND nothing happens (no action, no sound). A silent slap is not dead air.
  const silent = shots.filter(x => x.spoken === 0 && x.happens === 0 && !x.edge && x.len >= 1.0)

  const beats = useMemo(() => {
    let offset = 0
    const out: { t: number; who: string; text: string }[] = []
    for (const s of segs) {
      const ep = eps[s.episode]
      if (!ep) continue
      for (const e of ep.events)
        if (e.kind === 'dialogue' && e.start >= s.start_s - 0.011 && e.start < s.end_s)
          out.push({ t: offset + e.start - s.start_s, who: e.speaker, text: e.text })
      offset += s.length_s
    }
    return out
  }, [segs, eps])

  const hookEv = segs[0] ? eps[segs[0].episode]?.events.find(e => e.id === segs[0].first_event) : undefined
  const hookText = hookEv ? (hookEv.kind === 'dialogue' ? hookEv.text : hookEv.text.split(/(?<=\.)\s/)[0]) : beats[0]?.text
  const length = result?.length ?? 0
  const hookDelay = segs[0]?.hook_delay_s ?? 0

  // one list of every check, model checks first, in plain words
  const checks: { ok: boolean; label: string; note: string; bad?: string }[] = []
  if (j) {
    checks.push({ ok: j.cliffhanger_open, label: 'Cliffhanger still open at the cut', note: j.cliffhanger_reason, bad: 'the cliffhanger is answered inside the promo' })
    checks.push({ ok: j.cold_viewer.understandable !== false, label: 'A stranger can follow it',
      bad: 'a stranger may not follow it', note: [j.cold_viewer.who_to_root_for && `Roots for ${j.cold_viewer.who_to_root_for}.`, j.cold_viewer.open_question && `Wants to know: ${j.cold_viewer.open_question}`].filter(Boolean).join(' ') })
    checks.push({ ok: !j.spoiler, label: 'No spoiler', note: j.spoiler ? j.spoiler_reason : '', bad: 'it may give away a later twist' })
  }
  result?.checks.forEach(c => { const pc = plainCheck(c.name, c.detail, limits); checks.push({ ok: c.ok, ...pc }) })
  const failing = checks.filter(c => !c.ok)
  const codeFailing = result?.checks.filter(c => !c.ok).length ?? 0

  return (
    <div className="flex h-full flex-col">
      {/* who it is and what to do with it */}
      <div className="border-b hairline px-5 pt-4 pb-4 space-y-3">
        <input value={promo.title} onChange={e => onChange({ ...promo, title: e.target.value })} aria-label="Promo title"
          className="w-full bg-transparent text-[17px] leading-6 font-medium text-fg-1 outline-none rounded-[6px] -mx-1 px-1 hover:bg-ink-2 focus:bg-ink-2" />
        <p className="font-mono text-[11px] text-fg-3 tnum">
          {KIND[promo.kind]}{promo.rank && promo.source !== 'editor' ? ` · #${promo.rank} of ${total}` : ''} · {length.toFixed(1)} s · {segs.length > 1 ? `${segs.length} pieces, episodes ${[...new Set(segs.map(s => s.episode))].join(', ')}` : `episode ${segs[0]?.episode ?? ''}`}
        </p>
        <div className={`flex items-start gap-2 rounded-[10px] px-3 py-2 text-[13px] leading-5 ${failing.length ? 'bg-bad/10 text-fg-1' : 'bg-ok/10 text-fg-1'}`}>
          {failing.length ? <CircleAlert size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-bad" /> : <CircleCheck size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-ok" />}
          <span>
            {checking ? 'Checking' : failing.length ? <>Needs a look: {failing.map(f => f.bad ?? `fails “${f.label.toLowerCase()}”`).join('; ')}</> : 'Ready to post. Every check passed.'}
            {promo.edited && <span className="block text-[12px] text-fg-3">You changed this cut; the checks are for your version.</span>}
          </span>
        </div>
        {rendering && <p className="text-[12px] text-fg-2">{rendering}</p>}
        <div className="flex gap-2">
          <button onClick={() => onChange({ ...promo, status: promo.status === 'approved' ? 'draft' : 'approved' })}
            disabled={codeFailing > 0 || segs.length === 0} title={codeFailing ? 'Fix the failing checks first' : undefined}
            className={`h-9 flex-1 rounded-[8px] text-[13px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.98] disabled:opacity-40 ${
              promo.status === 'approved' ? 'bg-ok/15 text-ok' : 'bg-fg-1 text-ink-1 hover:bg-white shadow-[inset_0_1px_0_rgb(255_255_255/0.4)]'}`}>
            {promo.status === 'approved' ? 'Approved' : 'Approve'}
          </button>
          <button onClick={() => onChange({ ...promo, status: promo.status === 'rejected' ? 'draft' : 'rejected' })}
            className={`h-9 px-3 rounded-[8px] border hairline text-[13px] transition-colors duration-150 ${promo.status === 'rejected' ? 'bg-ink-3 text-fg-1' : 'text-fg-2 hover:bg-ink-2 hover:text-fg-1'}`}>
            {promo.status === 'rejected' ? 'Rejected' : 'Reject'}
          </button>
          <div className="relative">
            <button onClick={() => setExportOpen(o => !o)} disabled={segs.length === 0} aria-label="Export"
              className="h-9 w-9 grid place-items-center rounded-[8px] border hairline text-fg-2 hover:bg-ink-2 hover:text-fg-1 transition-colors duration-150 disabled:opacity-40">
              <Download size={16} strokeWidth={1.5} />
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-11 z-20 w-52 rounded-[10px] border hairline bg-ink-3 p-1 shadow-[0_8px_24px_rgb(0_0_0/0.4)]" onMouseLeave={() => setExportOpen(false)}>
                {segs.every(s => serverVideos.includes(s.episode)) ? (
                  <>
                    <button onClick={() => { onExport('mp4'); setExportOpen(false) }} className="w-full text-left rounded-[6px] px-2.5 py-1.5 text-[13px] text-fg-1 hover:bg-ink-4 transition-colors duration-150">MP4 video, vertical 9:16</button>
                    <button onClick={() => { onExport('mp4wide'); setExportOpen(false) }} className="w-full text-left rounded-[6px] px-2.5 py-1.5 text-[13px] text-fg-1 hover:bg-ink-4 transition-colors duration-150">MP4 video, original shape</button>
                  </>
                ) : <p className="px-2.5 py-1.5 text-[12px] leading-4 text-fg-3">MP4: attach the episode videos below first</p>}
                {([['edl', 'EDL: opens in Premiere, Resolve'], ['csv', 'CSV: a spreadsheet row'], ['json', 'JSON: for other tools']] as const).map(([k, l]) => (
                  <button key={k} onClick={() => { onExport(k); setExportOpen(false) }}
                    className="w-full text-left rounded-[6px] px-2.5 py-1.5 text-[13px] text-fg-1 hover:bg-ink-4 transition-colors duration-150">{l}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-7">
        {rankWhy && promo.rank && (
          <Section title={`Why it's #${promo.rank}`}>
            <p className="text-[13px] leading-5 text-fg-2">{rankWhy}</p>
          </Section>
        )}

        {/* what it is */}
        <Section title="What this promo is">
          {ai?.hook && <Row k="Opens on">{ai.hook}</Row>}
          {(ai?.cliffhanger || ai?.line) && <Row k="Cuts on">{ai.cliffhanger || ai.line}</Row>}
          {ai?.why && <Row k="Why it works">{ai.why}</Row>}
          {ai?.mood && <Row k="Mood">{ai.mood}</Row>}
          <div>
            <p className="text-[12px] text-fg-3">Type of hook</p>
            <div className="mt-1 flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ background: HOOKS[promo.hookType].color }} />
              <select value={promo.hookType} onChange={e => onChange({ ...promo, hookType: e.target.value as HookType })} aria-label="Type of hook"
                className="bg-transparent text-[13px] text-fg-1 outline-none rounded-[6px] hover:text-white">
                {Object.entries(HOOKS).map(([k, v]) => <option key={k} value={k} className="bg-ink-2">{v.label}</option>)}
              </select>
            </div>
            <p className="mt-1 text-[12px] leading-[18px] text-fg-3">The kind of bait it opens with. The top 10 is spread across types so you can test different angles. Change it if the AI guessed wrong.</p>
          </div>
          {!ai && <p className="text-[13px] text-fg-3">You cut this one by hand, so there is no AI explanation.</p>}
        </Section>

        {/* scores, each point with its reason */}
        {ai && Object.keys(ai.scores ?? {}).length > 0 && (
          <Section title="Scores, out of 10" aside={promo.foundBy && promo.foundBy > 1 ? `also picked by ${promo.foundBy - 1} other model${promo.foundBy > 2 ? 's' : ''}` : undefined}>
            <p className="text-[12px] leading-[18px] text-fg-3">{ai.breakdown ? 'Not the AI\'s opinion: each point is earned by something in the script, listed under the bar.' : 'This run is older: these numbers are the model\'s own estimate.'}</p>
            <div className="space-y-4">
              {Object.entries(SCORE_LABEL).map(([k, label]) => {
                const v = ai.scores[k]
                if (v === undefined) return null
                const why = (ai.breakdown ?? []).filter(b => b.axis === k)
                return (
                  <div key={k}>
                    <div className="flex justify-between text-[12px]"><span className="text-fg-1">{label}</span><span className="font-mono text-fg-1 tnum">{Number(v).toFixed(v % 1 ? 1 : 0)}</span></div>
                    <div className="mt-1 h-1 rounded-full bg-ink-3"><div className="h-full rounded-full bg-fg-2" style={{ width: `${v * 10}%` }} /></div>
                    {why.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {why.map((b, i) => (
                          <li key={i} className="grid grid-cols-[34px_1fr] gap-x-1.5 text-[11px] leading-4">
                            <span className={`font-mono tnum ${b.points >= b.max ? 'text-ok' : b.points > 0 ? 'text-fg-2' : 'text-bad'}`}>{b.points}/{b.max}</span>
                            <span className="text-fg-3">{b.why}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
          </Section>
        )}

        {/* every check, one list */}
        <Section title="Checks" aside={checking ? 'checking' : `${checks.length - failing.length} of ${checks.length} passed`}>
          {error && <p className="text-[13px] text-bad">{error}</p>}
          <div className="space-y-2">
            {checks.map((c, i) => (
              <div key={i} className="flex gap-2.5">
                {c.ok ? <Check size={16} strokeWidth={1.5} className="mt-0.5 text-ok shrink-0" /> : <TriangleAlert size={16} strokeWidth={1.5} className="mt-0.5 text-bad shrink-0" />}
                <div className="min-w-0">
                  <p className="text-[13px] leading-5 text-fg-1">{c.label}</p>
                  {c.note && <p className="text-[12px] leading-[18px] text-fg-3 break-words">{c.note}</p>}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* the real thing, from the episode videos */}
        <VideoSection segs={segs} videos={videos} onAttach={onAttach} />

        {/* what a viewer sees */}
        <Section title="The lines, as a viewer hears them">
          <div className="mx-auto w-[216px] aspect-[9/16] rounded-[16px] border hairline bg-ink-0 p-4 flex flex-col overflow-hidden">
            {!hookText ? <p className="m-auto text-center text-[12px] text-fg-3">Nothing in this cut yet</p> : (
              <>
                <p className="font-script text-[15px] leading-[21px] text-fg-1 line-clamp-4">{hookText}</p>
                <p className="mt-1 font-mono text-[10px] text-fg-3">0:00 · the hook</p>
                <div className="flex-1 my-3 overflow-hidden space-y-1.5 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
                  {beats.slice(hookEv?.kind === 'dialogue' ? 1 : 0, -1).map((b, i) => (
                    <p key={i} className="font-script text-[11px] leading-4 text-fg-3"><span className="font-mono text-[9px] tnum mr-1.5">{b.t.toFixed(0).padStart(2, '0')}</span>{b.text}</p>
                  ))}
                </div>
                {beats.length > 0 && beats[beats.length - 1].text !== hookText && (
                  <>
                    <p className="font-script text-[13px] leading-[19px] text-fg-1">{beats[beats.length - 1].text}</p>
                    <p className="mt-1 font-mono text-[10px] text-pencil">cut at {length.toFixed(1)} s</p>
                  </>
                )}
              </>
            )}
          </div>
          <Clock length={length} hook={hookDelay} min={limits.min} max={limits.max} />
        </Section>

        {/* what plays, shot by shot */}
        <Section title="Shots in this cut" aside={`${shots.length} shots`}>
          <p className="text-[12px] leading-[18px] text-fg-3">Everything inside the red line plays, in order. Untick a shot to cut it out; the promo then becomes separate pieces joined together. Dead air means a shot where nobody speaks and nothing happens; a silent slap or reaction is kept.</p>
          {silent.length > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-[10px] bg-ink-2 px-3 py-2.5">
              <span className="text-[13px] text-fg-1">{silent.length} dead-air shot{silent.length > 1 ? 's' : ''}, {silent.reduce((a, x) => a + x.len, 0).toFixed(1)} s</span>
              <button onClick={() => onSegments(withoutShots(segs, eps, silent.map(x => x.c)))}
                className="h-8 whitespace-nowrap rounded-[8px] border hairline px-3 text-[12px] text-fg-1 hover:bg-ink-3 transition-colors duration-150">Remove dead air</button>
            </div>
          )}
          {promo.edited && onRestore && (
            <button onClick={onRestore} className="block text-[12px] text-fg-2 underline underline-offset-2 hover:text-fg-1">Restore the AI's original cut</button>
          )}
          <button onClick={() => setShowShots(v => !v)} className="block text-[12px] text-fg-2 underline underline-offset-2 hover:text-fg-1">{showShots ? 'Hide the shot list' : 'Show every shot'}</button>
          {showShots && (
            <ul className="space-y-1">
              {shots.map(x => (
                <li key={x.c.id}>
                  <label className="flex items-start gap-2.5 rounded-[8px] px-2 py-1.5 hover:bg-ink-2 cursor-pointer">
                    <input type="checkbox" defaultChecked onChange={e => { if (!e.target.checked) onSegments(withoutShots(segs, eps, [x.c])) }}
                      className="mt-[3px] accent-[var(--color-pencil)]" aria-label={`Keep shot at ${tc(x.c.start)}`} />
                    <span className="min-w-0">
                      <span className="block font-mono text-[11px] text-fg-3 tnum">Ep {x.episode} · {tc(x.c.start)} · {x.len.toFixed(1)} s · <span className={x.spoken || x.happens ? 'text-fg-2' : 'text-pencil'}>{x.spoken ? `${x.spoken} line${x.spoken > 1 ? 's' : ''} spoken` : x.happens ? 'action, no lines' : 'dead air'}</span></span>
                      <span className="block text-[12px] leading-[17px] text-fg-2 line-clamp-2">{x.c.text}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* adjust */}
        <Section title={segs.length > 1 ? `Adjust the cut (${segs.length} pieces, played in order)` : 'Adjust the cut'}>
          <p className="text-[12px] leading-[18px] text-fg-3">The arrows move the start (IN) or end (OUT) to the previous or next clean cut. Click an episode to show it in the script.</p>
          {segs.map((s, i) => (
            <div key={i} className="rounded-[10px] border hairline bg-ink-2 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <button onClick={() => onJump(s.episode)} className="text-[13px] text-fg-1 hover:underline underline-offset-2">
                  {segs.length > 1 ? `Piece ${i + 1}: ` : ''}Episode {s.episode}
                </button>
                <span className="ml-auto font-mono text-[11px] text-fg-3 tnum">{s.length_s.toFixed(1)} s</span>
                <button onClick={() => onRemoveSegment(i)} aria-label="Remove this piece" className="-mr-1 p-1 rounded-[6px] text-fg-3 hover:text-fg-1 hover:bg-ink-3 transition-colors duration-150"><X size={14} strokeWidth={1.5} /></button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {(['start', 'end'] as const).map(side => (
                  <div key={side} className="flex items-center gap-1">
                    <button onClick={() => onNudge(i, side, -1)} aria-label={`Earlier ${side === 'start' ? 'start' : 'end'}`} className="p-0.5 rounded-[4px] text-fg-3 hover:text-fg-1 hover:bg-ink-3"><ChevronLeft size={14} strokeWidth={1.5} /></button>
                    <span className="font-mono text-[11px] text-pencil tnum">{side === 'start' ? 'IN ' : 'OUT '}{tc(side === 'start' ? s.start_s : s.end_s)}</span>
                    <button onClick={() => onNudge(i, side, 1)} aria-label={`Later ${side === 'start' ? 'start' : 'end'}`} className="p-0.5 rounded-[4px] text-fg-3 hover:text-fg-1 hover:bg-ink-3"><ChevronRight size={14} strokeWidth={1.5} /></button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Section>

        <Section title="Note">
          <textarea value={promo.note} onChange={e => onChange({ ...promo, note: e.target.value })} rows={3}
            placeholder="Why you approved or rejected it. The next run learns from this."
            className="w-full resize-none rounded-[10px] border hairline bg-ink-2 px-3 py-2 text-[13px] text-fg-1 placeholder:text-fg-3 outline-none focus:border-fg-3/40" />
          <button onClick={onDelete} className="text-[12px] text-fg-3 hover:text-bad transition-colors duration-150">Delete this promo</button>
        </Section>
      </div>
    </div>
  )
}

/* Optional: Kuku's pack has scripts, not video. With the episode files, the promo can be watched here. */
function VideoSection({ segs, videos, onAttach }: { segs: SegOut[]; videos: Record<number, string>; onAttach: (f: File[]) => void }) {
  const has = segs.length > 0 && segs.every(s => videos[s.episode])
  const [open, setOpen] = useState(false)
  if (has || open) return <Section title="Watch it"><VideoPreview segs={segs} videos={videos} onAttach={onAttach} /></Section>
  return (
    <div className="rounded-[10px] border hairline px-3 py-2.5">
      <p className="text-[13px] text-fg-1">Have the episode videos? <span className="text-fg-3">(optional)</span></p>
      <p className="mt-0.5 text-[12px] leading-[18px] text-fg-3">The scripts are enough to find promos. If you also have the episode video files, attach them: this promo plays right here, and Export gives you the finished MP4, cut exactly at these times.</p>
      <button onClick={() => setOpen(true)} className="mt-2 text-[12px] text-fg-2 underline underline-offset-2 hover:text-fg-1">Attach episode videos</button>
    </div>
  )
}

function Section({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium text-fg-1">{title}</h3>
        {aside && <span className="text-[12px] text-fg-3">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[12px] text-fg-3">{k}</p>
      <p className="text-[14px] leading-[21px] text-fg-1">{children}</p>
    </div>
  )
}

/* the allowed window shaded, this cut's length as the bar, the hook as a red tick */
function Clock({ length, hook, min, max }: { length: number; hook: number; min: number; max: number }) {
  const pct = (t: number) => `${Math.min(100, (t / max) * 100)}%`
  const ok = length >= min && length <= max
  return (
    <div className="mx-auto mt-4 w-[216px]" aria-label={`Length ${length.toFixed(1)} seconds`}>
      <div className="relative h-2 rounded-full bg-ink-3">
        <div className="absolute inset-y-0 rounded-full bg-fg-3/25" style={{ left: pct(min), right: 0 }} />
        <div className={`absolute inset-y-0 left-0 rounded-full ${ok ? 'bg-fg-1' : 'bg-bad'} transition-[width] duration-300 ease-out`} style={{ width: pct(length) }} />
        <div className="absolute -top-1 h-4 w-[2px] rounded-full bg-pencil" style={{ left: pct(hook) }} title="Hook" />
      </div>
      <div className="relative mt-1.5 h-3 font-mono text-[10px] leading-3 text-fg-3 tnum">
        <span className="absolute left-0">0</span>
        <span className="absolute -translate-x-1/2" style={{ left: pct(min) }}>{min}</span>
        <span className="absolute right-0">{max} s</span>
      </div>
      <p className="mt-2 text-center text-[11px] text-fg-3">Shaded: allowed length. Red tick: where the hook lands.</p>
    </div>
  )
}
