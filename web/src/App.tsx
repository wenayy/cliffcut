import { ChartColumn, ChevronDown, Clapperboard, Film, Layers, Lock, Play, ScrollText, Scissors } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { Inspector } from './components/Inspector'
import { Key, LinedScript, PromoScript } from './components/LinedScript'
import { Logo } from './components/Logo'
import { ModelsTable } from './components/ModelsTable'
import { QualityReport, rankReason } from './components/QualityReport'
import { RunPanel } from './components/RunPanel'
import type { Agreement, CheckResult, Episode, PromoDraft, Run, SegIn, Show, ShowRef } from './lib'
import { api, download, fromRun, HOOKS, setPasscode, tc, toCSV, toEDL } from './lib'

type View = 'promos' | 'teasers' | 'trailers' | 'episodes' | 'run' | 'models' | 'quality'

const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}

export default function App() {
  const [shows, setShows] = useState<ShowRef[]>([])
  const [showId, setShowId] = useState<string>(() => store.get('cliffcut.show', 'sample'))
  const [show, setShow] = useState<Show | null>(null)
  const [needPass, setNeedPass] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  const [view, setView] = useState<View>('run')
  const [epNo, setEpNo] = useState(1)
  const [eps, setEps] = useState<Record<number, Episode>>({})
  const [runs, setRuns] = useState<Run[]>([])
  const [agreement, setAgreement] = useState<Agreement | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, PromoDraft>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [marks, setMarks] = useState<{ in?: string; out?: string }>({})
  const [focusId, setFocusId] = useState<string>()
  const [result, setResult] = useState<CheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkErr, setCheckErr] = useState<string | null>(null)
  const [centre, setCentre] = useState<'promo' | 'episode'>('promo')
  const [showCamera, setShowCamera] = useState(false)
  const [videos, setVideos] = useState<Record<number, string>>({})   // episode -> local object URL (never uploaded)
  const [serverVideos, setServerVideos] = useState<number[]>([])
  const [rendering, setRendering] = useState<string | null>(null)
  useEffect(() => { api.videos(showId).then(r => setServerVideos(r.episodes)).catch(() => setServerVideos([])) }, [showId])
  const attach = (files: File[]) => {
    attachLocal(files)
    api.uploadVideos(showId, files).then(r => setServerVideos(r.episodes)).catch(() => {})   // local server, for MP4 export
  }
  const attachLocal = (files: File[]) => setVideos(v => {
    const next = { ...v }
    for (const f of files) {
      const n = parseInt((f.name.match(/(\d+)/) ?? [])[1] ?? '', 10)
      if (!Number.isNaN(n)) next[n] = URL.createObjectURL(f)
    }
    return next
  })

  const editsKey = `cliffcut.edits.${showId}`

  /* ---------- loading ---------- */
  const loadShows = useCallback(() => api.shows().then(r => setShows(r.shows)).catch(e => setFatal(String(e.message ?? e))), [])
  useEffect(() => { loadShows() }, [loadShows])

  const loadRuns = useCallback((sid: string, select?: string) => api.runs(sid).then(r => {
    setRuns(r.runs); setAgreement(r.agreement)
    setRunId(select ?? (r.runs.find(x => x.promos.length > 0) ?? r.runs[0])?.id ?? null)
  }).catch(() => { setRuns([]); setAgreement(null) }), [])

  useEffect(() => {
    store.set('cliffcut.show', showId)
    setShow(null); setEps({}); setActiveId(null); setMarks({}); setResult(null); setNeedPass(false)
    setEdits(store.get(`cliffcut.edits.${showId}`, {}))
    api.show(showId).then(s => { setShow(s); setEpNo(s.episodes[0]?.number ?? 1); loadRuns(showId) })
      .catch((e: Error & { status?: number }) => {
        if (e.status === 401) setNeedPass(true)
        else if (e.status === 404 && showId !== 'sample') setShowId('sample')
        else setFatal(e.message)
      })
  }, [showId, loadRuns])

  useEffect(() => { store.set(editsKey, edits) }, [edits, editsKey])

  const run = runs.find(r => r.id === runId) ?? null
  const foundBy = run ? agreement?.found_by[run.id] : undefined

  /* everything in the list: the model's promos (with any human edits on top), then hand cuts */
  const withEdits = (base: PromoDraft) => {
    const e = edits[base.id]
    return e ? { ...e, edited: JSON.stringify(e.segments) !== JSON.stringify(base.segments) } : base
  }
  const promos = useMemo<PromoDraft[]>(() => {
    const fromModel = run ? run.promos.map((p, i) => withEdits(fromRun(run, p, 'promo', i, foundBy?.[p.rank ?? i + 1]))) : []
    const byHand = Object.values(edits).filter(p => p.source === 'editor' && p.kind === 'promo')
    return [...fromModel, ...byHand]
  }, [run, edits, foundBy])
  const teasers = useMemo<PromoDraft[]>(() => run
    ? run.teasers.map((t, i) => withEdits(fromRun(run, t, 'teaser', i))) : [], [run, edits]) // eslint-disable-line react-hooks/exhaustive-deps
  const trailers = useMemo<PromoDraft[]>(() => run
    ? (run.trailers ?? []).map((t, i) => withEdits(fromRun(run, t, 'trailer', i))) : [], [run, edits]) // eslint-disable-line react-hooks/exhaustive-deps
  const rejected = run?.rejected ?? []

  const active = [...promos, ...teasers, ...trailers].find(p => p.id === activeId) ?? null
  const runCfg = (run as unknown as { config?: { trailer_min?: number; trailer_max?: number } })?.config
  const limits = active?.kind === 'teaser' ? { min: 8, max: 20 }
    : active?.kind === 'trailer' ? { min: runCfg?.trailer_min ?? 60, max: runCfg?.trailer_max ?? 90 }
    : { min: 20, max: 60 }
  const episode = eps[epNo]

  const need = useMemo(() => new Set([epNo, ...(active?.segments.map(s => s.episode) ?? [])]), [epNo, active])
  useEffect(() => {
    if (!show) return
    need.forEach(n => { if (!eps[n] && show.episodes.some(e => e.number === n)) api.episode(showId, n).then(e => setEps(m => ({ ...m, [n]: e }))).catch(() => {}) })
  }, [need, eps, show, showId])

  /* ---------- live checks ---------- */
  const segKey = JSON.stringify(active?.segments ?? []) + limits.max
  useEffect(() => {
    if (!active || active.segments.length === 0) { setResult(null); return }
    setChecking(true)
    const t = setTimeout(() => {
      api.check(showId, active.segments, limits.min, limits.max)
        .then(r => {
          if (active.ai) {   // keep the pipeline-only checks (e.g. a teaser must not show the ending)
            const extra = active.ai.checks.filter(c => !r.checks.some(x => x.name === c.name))
            r = { ...r, checks: [...r.checks, ...extra] }
          }
          setResult(r); setCheckErr(null)
        })
        .catch(e => setCheckErr(String(e.message ?? e)))
        .finally(() => setChecking(false))
    }, 160)
    return () => clearTimeout(t)
  }, [segKey, active?.id, showId]) // eslint-disable-line react-hooks/exhaustive-deps

  const update = (p: PromoDraft) => {
    const summary = result ? { length: result.length, failed: result.checks.filter(c => !c.ok).length } : p.summary
    const prev = edits[p.id] ?? [...promos, ...teasers, ...trailers].find(x => x.id === p.id)
    setEdits(m => ({ ...m, [p.id]: { ...p, summary } }))
    // every approve / reject (and its note) is remembered as the editor's taste for the next run
    if (prev && (prev.status !== p.status || (p.status !== 'draft' && prev.note !== p.note))) {
      api.decide({ promo_id: `${showId}:${p.id}`, decision: p.status, title: p.title, hook: p.ai?.hook, cliffhanger: p.ai?.cliffhanger,
        hook_type: p.hookType, note: p.note, show: showId }).catch(() => {})
    }
  }

  const addSegment = useCallback((asNew = true) => {
    if (!episode || !marks.in) return
    const a = episode.events.find(e => e.id === marks.in)!
    const b = episode.events.find(e => e.id === (marks.out ?? marks.in))!
    const [first, last] = a.start <= b.start ? [a, b] : [b, a]
    const seg: SegIn = { episode: episode.number, first: first.id, last: last.id }
    if (!asNew && active && active.status !== 'approved') {
      update({ ...active, segments: [...active.segments, seg] })
    } else {
      const p: PromoDraft = {
        id: crypto.randomUUID(), kind: 'promo', title: `My cut: episode ${episode.number} at ${tc(first.start).slice(0, 5)}`, hookType: 'other',
        segments: [seg], status: 'draft', note: '', source: 'editor',
      }
      setEdits(m => ({ ...m, [p.id]: p })); setActiveId(p.id); setView('promos')
    }
    setMarks({})
  }, [episode, marks, active]) // eslint-disable-line react-hooks/exhaustive-deps

  const nudge = (i: number, side: 'start' | 'end', dir: -1 | 1) => {
    if (!active || !result) return
    const seg = result.segments[i]
    const cuts = eps[seg.episode]?.clean_cuts ?? []
    const cur = side === 'start' ? seg.start_s : seg.end_s
    const next = dir < 0 ? [...cuts].reverse().find(c => c < cur - 0.011) : cuts.find(c => c > cur + 0.011)
    if (next === undefined) return
    update({ ...active, segments: active.segments.map((s, k) => k === i ? { ...s, [side]: next } : s) })
  }

  const exportOne = (kind: 'edl' | 'csv' | 'json' | 'mp4' | 'mp4wide') => {
    if (!active || !result) return
    const slug = active.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'promo'
    if (kind === 'edl') download(`${slug}.edl`, toEDL(active, result.segments))
    if (kind === 'csv') download(`${slug}.csv`, toCSV([{ p: active, segs: result.segments }]), 'text/csv')
    if (kind === 'json') download(`${slug}.json`, JSON.stringify({ ...active, cuts: result.segments, checks: result.checks }, null, 2), 'application/json')
    if (kind === 'mp4' || kind === 'mp4wide') {
      setRendering('Cutting the video')
      api.render(showId, active.segments, active.title, kind === 'mp4', limits.min, limits.max)
        .then(b => { const url = URL.createObjectURL(b); Object.assign(document.createElement('a'), { href: url, download: `${slug}.mp4` }).click(); setRendering(null) })
        .catch(e => setRendering(String(e.message ?? e)))
    }
  }

  const exportAll = () => {
    if (!run) return
    const rows = [...promos.filter(p => p.ai), ...trailers, ...teasers].map(p => ({ p, segs: p.ai!.segments }))
    download(`${run.provider}-${run.model}-promos.csv`, toCSV(rows), 'text/csv')
  }

  /* ---------- keyboard ---------- */
  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  keys.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select') || e.metaKey || e.ctrlKey || !episode) return
    const list = episode.events
    const idx = list.findIndex(x => x.id === focusId)
    if (e.key === 'ArrowDown' || e.key === 'j') { setFocusId(list[Math.min(list.length - 1, idx + 1)]?.id); e.preventDefault() }
    else if (e.key === 'ArrowUp' || e.key === 'k') { setFocusId(list[Math.max(0, idx - 1)]?.id); e.preventDefault() }
    else if (e.key === 'i' && focusId) setMarks({ in: focusId, out: marks.out })
    else if (e.key === 'o' && focusId) setMarks(m => ({ in: m.in ?? focusId, out: focusId }))
    else if (e.key === 'Enter' && marks.in) addSegment(true)
    else if (e.key === 'Escape') setMarks({})
    else if (e.key === ']' && show) setEpNo(n => Math.min(show.episodes.at(-1)!.number, n + 1))
    else if (e.key === '[' && show) setEpNo(n => Math.max(show.episodes[0].number, n - 1))
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const openPromo = (p: PromoDraft) => {
    setActiveId(p.id); setCentre('promo')
    if (p.segments[0]) setEpNo(p.segments[0].episode)
    setMarks({})
  }

  if (fatal) return <Fatal message={fatal} />

  const segsHere = result?.segments.filter(s => s.episode === epNo) ?? []
  const markLen = (() => {
    if (!episode || !marks.in) return null
    const a = episode.events.find(e => e.id === marks.in), b = episode.events.find(e => e.id === (marks.out ?? marks.in))
    return a && b ? Math.abs(Math.max(a.end, b.end) - Math.min(a.start, b.start)) : null
  })()
  const workView = view === 'run' || view === 'models' || view === 'quality'
  const showRef = shows.find(s => s.id === showId)

  const nav: { id: View; label: string; icon: typeof Play; count?: number }[] = [
    { id: 'run', label: 'New run', icon: Play },
    { id: 'promos', label: 'Promos', icon: Scissors, count: promos.length },
    { id: 'trailers', label: 'Whole-show trailers', icon: Film, count: trailers.length },
    { id: 'teasers', label: 'Next-episode teasers', icon: Clapperboard, count: teasers.length },
    { id: 'quality', label: 'Ranking and quality', icon: ChartColumn },
    { id: 'models', label: 'Compare models', icon: Layers, count: new Set(runs.map(r => `${r.provider}/${r.model}`)).size },
    { id: 'episodes', label: 'Read the scripts', icon: ScrollText, count: show?.episodes.length },
  ]

  return (
    <div className="flex h-full">
      {/* rail */}
      <aside className="w-[248px] shrink-0 bg-ink-0 border-r hairline flex flex-col">
        <div className="h-14 px-4 flex items-center"><Logo /></div>
        <div className="px-3 pt-1 pb-5">
          <label className="relative block">
            <span className="sr-only">Show</span>
            <select value={showId} onChange={e => setShowId(e.target.value)}
              className="w-full appearance-none rounded-[8px] bg-transparent px-2 py-1.5 pr-7 text-[13px] text-fg-1 hover:bg-ink-2 outline-none">
              {([['sample', 'Demo show (written for this demo)'], ['kuku', "Kuku's show (private)"], ['up-', 'Your uploads']] as const).map(([k, label]) => {
                const group = shows.filter(x => k === 'up-' ? x.id.startsWith('up-') : x.id === k)
                return group.length ? (
                  <optgroup key={k} label={label} className="bg-ink-2">
                    {group.map(x => <option key={x.id} value={x.id} className="bg-ink-2">{x.title}{x.locked ? ' (locked)' : ''}</option>)}
                  </optgroup>
                ) : null
              })}
            </select>
            <ChevronDown size={14} strokeWidth={1.5} className="pointer-events-none absolute right-2 top-2 text-fg-3" />
          </label>
          <p className="px-2 mt-1 text-[11px] leading-4 text-fg-3">{showRef?.note}</p>
          <p className="px-2 mt-0.5 font-mono text-[11px] text-fg-3 tnum">
            {show ? `${show.episodes.length} episodes · ${show.episodes.reduce((a, e) => a + e.shots, 0).toLocaleString()} shots` : ''}
          </p>
          {show?.episodes.some(e => e.format === 'screenplay') && <p className="px-2 mt-1 text-[11px] leading-4 text-fg-3">This script has no times or camera notes, so both are guessed from the text</p>}
        </div>
        <nav className="px-2 space-y-0.5" aria-label="Sections">
          {nav.map(n => (
            <button key={n.id} onClick={() => { setView(n.id); if (n.id === 'episodes') setCentre('episode') }}
              className={`w-full h-8 px-2.5 flex items-center gap-2.5 rounded-[8px] text-[13px] transition-colors duration-150 ${
                view === n.id ? 'bg-ink-3 text-fg-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]' : 'text-fg-2 hover:bg-ink-2 hover:text-fg-1'}`}>
              <n.icon size={16} strokeWidth={1.5} className="shrink-0" />
              <span className="truncate">{n.label}</span>
              <span className="ml-auto font-mono text-[11px] text-fg-3 tnum">{n.count || ''}</span>
            </button>
          ))}
        </nav>
        <dl className="mt-auto px-4 pb-4 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[12px] text-fg-3">
          {([[['↑', '↓'], 'Move'], [['I', 'O'], 'Mark in and out'], [['↵'], 'Cut it'], [['[', ']'], 'Episode']] as const).map(([ks, label]) => (
            <div key={label} className="contents">
              <dt className="flex gap-1">{ks.map(k => <Key key={k}>{k}</Key>)}</dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
      </aside>

      {needPass ? <PassGate title={showRef?.title ?? showId} onOk={p => { setPasscode(p); setShowId(s => s); setNeedPass(false); api.show(showId).then(s => { setShow(s); loadRuns(showId) }).catch(() => setNeedPass(true)) }} /> : (
      <Group orientation="horizontal" className="flex-1 min-w-0">
        {/* list */}
        <Panel id="list" defaultSize={320} minSize={260} maxSize={480} className="bg-ink-1 border-r hairline flex flex-col">
          <header className="h-14 shrink-0 px-4 flex items-center gap-2 border-b hairline">
            <h2 className="text-[14px] text-fg-1">{{ promos: 'Promos', teasers: 'Next-episode teasers', trailers: 'Whole-show trailers', episodes: 'Episodes', run: 'Runs', models: 'Runs', quality: 'Runs' }[view]}</h2>
            {(view === 'promos' || view === 'teasers' || view === 'trailers') && runs.length > 0 && (
              <label className="relative ml-auto">
                <span className="sr-only">Run</span>
                <select value={runId ?? ''} onChange={e => { setRunId(e.target.value); setActiveId(null) }}
                  className="max-w-[170px] appearance-none rounded-[6px] bg-transparent py-1 pl-2 pr-6 font-mono text-[11px] text-fg-2 hover:bg-ink-2 outline-none">
                  {runs.map(r => <option key={r.id} value={r.id} className="bg-ink-2">{r.provider} · {r.model} · {r.created.slice(5, 16).replace('T', ' ')}</option>)}
                </select>
                <ChevronDown size={12} strokeWidth={1.5} className="pointer-events-none absolute right-1.5 top-1.5 text-fg-3" />
              </label>
            )}
          </header>
          <div className="flex-1 overflow-y-auto p-2">
            {run && view === 'promos' && promos.length > 0 && <Explain>{`${promos.length} promos found in ${run.episodes.length} episode${run.episodes.length > 1 ? 's' : ''}. Each is a 20–60 s ad cut from one episode: start and end times, a hook and a cliffhanger. The AI suggested up to 3 per episode; these passed the checks.`}</Explain>}
            {run && view === 'teasers' && teasers.length > 0 && <Explain>{`${teasers.length} teasers: short "next time on…" clips. Each is 8–20 s from the next episode and plays at the end of this one, to keep current viewers watching. Episode 1 has none because nothing comes before it.`}</Explain>}
            {run && view === 'trailers' && trailers.length > 0 && <Explain>{`${trailers.length} trailers for the whole show: ads that join moments from different episodes in story order (hook, turn, rising stakes, cliffhanger) without giving away the ending.` + (run.story ? ' The AI first mapped the story: ' + ([['it starts in episode', 'opportunity'], ['the point of no return is episode', 'point_of_no_return'], ['the major setback is episode', 'major_setback']] as const)
                .filter(([, k]) => run.story!.turning_points[k]).map(([t, k]) => `${t} ${run.story!.turning_points[k]}`).join(', ') + `. Mood: ${run.story.mood}. About: ${run.story.themes.join(', ')}.` : '')}</Explain>}
            {view === 'trailers' && trailers.length === 0 && <Empty title="No whole-show trailers in this run" body="A run builds them after it has found promos in at least 3 episodes. Run more episodes, or run again to get them." />}
            {view === 'trailers' && trailers.map(p => <ListItem key={p.id} p={p} active={activeId === p.id} onClick={() => openPromo(p)} label={`Episodes ${[...new Set(p.segments.map(s => s.episode))].join(', ')}`} />)}
            {view === 'promos' && (promos.length === 0
              ? <Empty title="No promos yet" body={runs.length ? 'This run found none that passed the checks. See the rejected list below, or cut one by hand.' : 'Go to New run, pick a model and press Find promos. You can also cut one by hand: open an episode, put the cursor on a line, press I to mark in, O to mark out, then Enter.'} />
              : <PromoGroups promos={promos} activeId={activeId} onOpen={openPromo} />)}
            {view === 'promos' && run && run.promos.length > 0 && (
              <button onClick={exportAll} className="mx-3 mt-3 text-[12px] text-fg-3 hover:text-fg-1 transition-colors duration-150">Export all as CSV</button>
            )}
            {view === 'promos' && rejected.length > 0 && <Rejected items={rejected} />}
            {view === 'promos' && run && run.errors.length > 0 && (
              <div className="mx-3 mt-4 space-y-1">
                <p className="text-[12px] text-bad">Failed on {run.errors.length} episode{run.errors.length > 1 ? 's' : ''}</p>
                {run.errors.map(e => <p key={e.episode} className="font-mono text-[11px] text-fg-3">Ep {e.episode}: {e.error}</p>)}
              </div>
            )}
            {view === 'teasers' && (teasers.length === 0
              ? <Empty title="No teasers yet" body="Each run makes one 8–20 s teaser per episode, cut from the next episode, to play at the end of this one. It never shows the next episode's own ending." />
              : teasers.map(p => <ListItem key={p.id} p={p} active={activeId === p.id} onClick={() => openPromo(p)} label={`End of ep ${p.ai?.for_episode}`} />))}
            {view === 'episodes' && show?.episodes.map(e => (
              <button key={e.number} onClick={() => { setEpNo(e.number); setActiveId(null); setCentre('episode') }}
                className={`w-full text-left rounded-[10px] px-3 py-2.5 grid grid-cols-[28px_1fr_auto] gap-x-1 transition-colors duration-150 ${epNo === e.number ? 'bg-ink-3' : 'hover:bg-ink-2'}`}>
                <span className="font-mono text-[12px] text-fg-3 tnum pt-px">{e.number}</span>
                <span className="text-[13px] text-fg-2 line-clamp-2 leading-[18px]">{e.logline || e.title}</span>
                <span className="font-mono text-[11px] text-fg-3 tnum pt-px pl-2">{tc(e.duration).slice(0, 5)}</span>
              </button>
            ))}
            {workView && (runs.length === 0
              ? <Empty title="No runs yet" body="Runs on this show appear here, newest first." />
              : runs.map(r => (
                <button key={r.id} onClick={() => { setRunId(r.id); setView('promos'); setActiveId(null) }}
                  className={`w-full text-left rounded-[10px] px-3 py-2.5 transition-colors duration-150 ${runId === r.id ? 'bg-ink-3' : 'hover:bg-ink-2'}`}>
                  <p className="text-[13px] text-fg-1">{r.provider} <span className="text-fg-3">{r.model}</span></p>
                  <p className="mt-0.5 font-mono text-[11px] text-fg-3 tnum">{r.created.replace('T', ' ').slice(0, 16)} · {r.promos.length} promos · {r.teasers.length} teasers</p>
                </button>
              )))}
          </div>
        </Panel>
        <Separator className="w-px bg-transparent hover:bg-fg-3/30 data-[separator=active]:bg-pencil transition-colors" />

        {/* centre: the lined script, or the run / comparison work areas */}
        <Panel id="centre" minSize={420} className="flex flex-col bg-ink-1 relative">
          {view === 'run' ? <div className="flex-1 overflow-y-auto"><RunPanel show={show} hasRuns={runs.length > 0} onBrowse={() => setView('promos')} onUploaded={id => { loadShows().then(() => setShowId(id)) }} onDone={id => { loadRuns(showId, id); setView('promos') }} /></div>
            : view === 'quality' ? <div className="flex-1 overflow-y-auto"><QualityReport run={run} foundBy={foundBy} onOpen={rank => { const p = promos.find(x => x.rank === rank && x.source !== 'editor'); if (p) { setView('promos'); openPromo(p) } }} /></div>
            : view === 'models' ? <div className="flex-1 overflow-y-auto"><ModelsTable runs={runs} agreement={agreement} onOpen={id => { setRunId(id); setView('promos') }} /></div>
            : (
            <>
              <header className="h-14 shrink-0 px-6 flex items-center gap-4 border-b hairline">
                {active && result && centre === 'promo' ? (
                  <div className="min-w-0">
                    <p className="text-[14px] text-fg-1 truncate">{active.title}</p>
                    <p className="text-[12px] text-fg-3">What plays, in order · {result.length.toFixed(1)} s</p>
                  </div>
                ) : (
                  <div className="min-w-0">
                    <p className="text-[14px] text-fg-1">Episode {epNo}{episode?.format === 'screenplay' ? <span className="ml-2 text-[12px] text-fg-3">timing estimated</span> : null}</p>
                    <p className="text-[12px] text-fg-3 truncate max-w-[60ch]" title={episode?.logline}>{episode?.logline}</p>
                  </div>
                )}
                <div className="ml-auto flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-[12px] text-fg-3 cursor-pointer whitespace-nowrap">
                    <input type="checkbox" checked={showCamera} onChange={e => setShowCamera(e.target.checked)} className="accent-[var(--color-pencil)]" />
                    Camera notes
                  </label>
                  {active && (
                    <div role="radiogroup" aria-label="View" className="inline-flex rounded-[8px] border hairline bg-ink-2 p-0.5">
                      {([['promo', 'The promo'], ['episode', 'Whole episode']] as const).map(([v, l]) => (
                        <button key={v} role="radio" aria-checked={centre === v} onClick={() => setCentre(v)}
                          className={`h-7 rounded-[6px] px-2.5 text-[12px] whitespace-nowrap transition-colors duration-150 ${centre === v ? 'bg-ink-4 text-fg-1' : 'text-fg-2 hover:text-fg-1'}`}>{l}</button>
                      ))}
                    </div>
                  )}
                </div>
              </header>
              <p className="shrink-0 border-b hairline px-6 py-2 text-[12px] text-fg-3">
                {active && centre === 'promo'
                  ? 'Everything below plays, in this order. Times count from the start of the promo.'
                  : active ? 'Tinted lines are in the promo, between the red markers. Click a line and press I, then O, to cut your own.'
                  : 'Click a line, press I for in and O for out, then Enter, to cut your own promo.'}
              </p>
              <div className="flex-1 overflow-y-auto">
                {active && result && centre === 'promo'
                  ? <PromoScript segs={result.segments} eps={eps} showCamera={showCamera} />
                  : episode
                  ? <LinedScript episode={episode} segments={segsHere} marks={marks} focusId={focusId} onFocus={setFocusId} showCamera={showCamera} />
                  : <p className="p-6 text-fg-3 text-[13px]">{show ? `Loading episode ${epNo}` : 'Loading show'}</p>}
              </div>
              {marks.in && (
                <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-[12px] border hairline bg-ink-3 pl-4 pr-1.5 py-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.45)]">
                  <span className="font-mono text-[12px] text-fg-2 tnum whitespace-nowrap">{markLen !== null ? `${markLen.toFixed(1)} s marked` : ''}</span>
                  <span className="text-[12px] text-fg-3 flex items-center gap-1 whitespace-nowrap"><Key>Esc</Key> clear</span>
                  {active && active.status !== 'approved' && (
                    <button onClick={() => addSegment(false)} title={`Join this piece onto "${active.title}"`}
                      className="h-8 whitespace-nowrap rounded-[8px] border hairline px-3 text-[13px] text-fg-1 hover:bg-ink-4 transition-colors duration-150">
                      Add as piece {active.segments.length + 1} of this promo
                    </button>
                  )}
                  <button onClick={() => addSegment(true)}
                    className="h-8 whitespace-nowrap rounded-[8px] bg-fg-1 px-3 text-[13px] font-medium text-ink-1 hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-150">
                    Make a new promo
                  </button>
                </div>
              )}
            </>
          )}
        </Panel>
        {!workView && <>
        <Separator className="w-px bg-transparent hover:bg-fg-3/30 data-[separator=active]:bg-pencil transition-colors" />

        {/* inspector */}
        <Panel id="inspector" defaultSize={348} minSize={300} maxSize={460} className="bg-ink-1 border-l hairline">
          {active
            ? <Inspector promo={active} result={result} checking={checking} error={checkErr} eps={eps} limits={limits}
                total={active.kind === 'teaser' ? teasers.length : active.kind === 'trailer' ? trailers.length : promos.filter(p => p.source !== 'editor').length}
                onJump={n => { setEpNo(n); setCentre('episode') }}
                rankWhy={active.ai && active.kind !== 'teaser' ? rankReason(active.ai, active.foundBy) : undefined}
                onSegments={segments => update({ ...active, segments })}
                videos={videos} onAttach={attach} serverVideos={serverVideos} rendering={rendering}
                onRestore={active.ai ? () => setEdits(m => { const n = { ...m }; delete n[active.id]; return n }) : undefined}
                onChange={update} onNudge={nudge}
                onRemoveSegment={i => update({ ...active, segments: active.segments.filter((_, k) => k !== i) })}
                onExport={exportOne}
                onDelete={() => { setEdits(m => { const n = { ...m }; delete n[active.id]; return n }); setActiveId(null) }} />
            : <EmptyInspector />}
        </Panel>
        </>}
      </Group>
      )}
    </div>
  )
}

function ListItem({ p, active, onClick, label }: { p: PromoDraft; active: boolean; onClick: () => void; label?: string }) {
  const s = p.summary
  const j = p.ai?.ai_checks
  const aiFail = j ? [!j.cliffhanger_open, j.spoiler, j.cold_viewer.understandable === false].filter(Boolean).length : 0
  return (
    <button onClick={onClick}
      className={`w-full text-left rounded-[10px] px-3 py-2.5 grid grid-cols-[24px_1fr] gap-x-1 transition-colors duration-150 ${active ? 'bg-ink-3' : 'hover:bg-ink-2'}`}>
      <span className="font-mono text-[12px] text-fg-3 tnum pt-px">{p.source === 'editor' ? '·' : p.rank}</span>
      <span className={`text-[13px] truncate ${p.status === 'rejected' ? 'text-fg-3 line-through' : 'text-fg-1'}`}>
        {p.title}{p.status === 'approved' && <span className="ml-1.5 text-[12px] text-ok">Approved</span>}{p.edited && <span className="ml-1.5 text-[12px] text-fg-3">edited</span>}
      </span>
      <span />
      <span className="mt-1 flex items-center gap-2 text-[12px] text-fg-3 min-w-0">
        <span className="size-1.5 rounded-full shrink-0" style={{ background: HOOKS[p.hookType].color }} />
        <span className="truncate">{label ?? (p.source === 'editor' ? 'Cut by hand' : HOOKS[p.hookType].label)}</span>
        {(p.foundBy ?? 0) > 1 && <span className="shrink-0 text-ok">{p.foundBy} models</span>}
        {s && <span className="ml-auto font-mono text-[11px] tnum shrink-0">{s.length.toFixed(1)} s</span>}
        {s && <span className={`font-mono text-[11px] shrink-0 ${s.failed || aiFail ? 'text-bad' : 'text-ok'}`}>{s.failed || aiFail ? `${s.failed + aiFail} to check` : 'ready'}</span>}
      </span>
    </button>
  )
}

/* A run finds about 2 promos per episode: a menu, not a posting plan. Lead with the top 10. */
function PromoGroups({ promos, activeId, onOpen }: { promos: PromoDraft[]; activeId: string | null; onOpen: (p: PromoDraft) => void }) {
  const model = promos.filter(p => p.source !== 'editor')
  const mine = promos.filter(p => p.source === 'editor')
  const top = model.slice(0, 10), rest = model.slice(10)
  const [more, setMore] = useState(false)
  const head = (t: string, sub: string) => (
    <div className="px-3 pt-3 pb-1">
      <p className="text-[12px] text-fg-2">{t}</p>
      <p className="text-[11px] leading-4 text-fg-3">{sub}</p>
    </div>
  )
  return (
    <>
      {top.length > 0 && head('Post these first', 'The 10 strongest, spread across different hooks')}
      {top.map(p => <ListItem key={p.id} p={p} active={activeId === p.id} onClick={() => onOpen(p)} />)}
      {rest.length > 0 && (
        <>
          <button onClick={() => setMore(m => !m)} className="w-full text-left">
            {head(`${more ? 'Hide' : 'Show'} ${rest.length} more options`, 'Other good moments the model found, about 2 per episode. Useful for testing new angles or later weeks')}
          </button>
          {more && rest.map(p => <ListItem key={p.id} p={p} active={activeId === p.id} onClick={() => onOpen(p)} />)}
        </>
      )}
      {mine.length > 0 && head('Cut by you', 'Promos you made by hand')}
      {mine.map(p => <ListItem key={p.id} p={p} active={activeId === p.id} onClick={() => onOpen(p)} />)}
    </>
  )
}

function Rejected({ items }: { items: Run['rejected'] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mx-1 mt-5 border-t hairline pt-3">
      <button onClick={() => setOpen(o => !o)} className="px-2 text-[12px] text-fg-3 hover:text-fg-1 transition-colors duration-150 flex items-center gap-1">
        <ChevronDown size={14} strokeWidth={1.5} className={`transition-transform duration-150 ${open ? '' : '-rotate-90'}`} />
        Rejected by the checks ({items.length})
      </button>
      {open && items.map((p, i) => (
        <div key={i} className="px-3 py-2">
          <p className="text-[13px] text-fg-2 truncate">{p.title || 'Untitled'}</p>
          <p className="mt-0.5 font-mono text-[11px] leading-4 text-fg-3">
            {[...p.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`), ...p.problems].join('; ')}
          </p>
        </div>
      ))}
    </div>
  )
}

function PassGate({ title, onOk }: { title: string; onOk: (p: string) => void }) {
  const [v, setV] = useState('')
  return (
    <div className="flex-1 grid place-items-center">
      <form onSubmit={e => { e.preventDefault(); onOk(v) }} className="w-[320px] space-y-3">
        <Lock size={18} strokeWidth={1.5} className="text-fg-3" />
        <p className="text-[14px] text-fg-1">{title}</p>
        <p className="text-[13px] text-fg-3">This show is private. Enter the passcode you were sent.</p>
        <input type="password" value={v} onChange={e => setV(e.target.value)} autoFocus aria-label="Passcode"
          className="h-9 w-full rounded-[8px] border hairline bg-ink-2 px-3 text-[13px] text-fg-1 outline-none focus:border-fg-3/40" />
        <button className="h-9 w-full rounded-[8px] bg-fg-1 text-[13px] font-medium text-ink-1 hover:bg-white transition-colors duration-150">Open</button>
      </form>
    </div>
  )
}

function Explain({ children }: { children: string }) {
  return <p className="mx-1 mb-2 rounded-[10px] bg-ink-2 px-3 py-2.5 text-[12px] leading-[18px] text-fg-2">{children}</p>
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-3 py-6">
      <p className="text-[13px] text-fg-1">{title}</p>
      <p className="mt-1.5 text-[13px] leading-5 text-fg-3">{body}</p>
    </div>
  )
}

function EmptyInspector() {
  return (
    <div className="h-full flex flex-col items-center justify-center px-10 text-center">
      <Logo size={40} wordmark={false} />
      <p className="mt-5 text-[14px] text-fg-1">No promo selected</p>
      <p className="mt-1.5 text-[13px] leading-5 text-fg-3">Pick one from the list to see where it starts and ends, why it works, and whether it passed the checks.</p>
    </div>
  )
}

function Fatal({ message }: { message: string }) {
  return (
    <div className="h-full grid place-items-center p-8">
      <div className="max-w-md">
        <Logo />
        <p className="mt-6 text-[14px] text-fg-1">Can't reach the Cliffcut server</p>
        <p className="mt-1.5 text-[13px] text-fg-3">{message}</p>
        <pre className="mt-4 rounded-[10px] border hairline bg-ink-2 p-3 font-mono text-[12px] text-fg-2 overflow-x-auto">.venv/bin/uvicorn server.app:app --port 8790</pre>
      </div>
    </div>
  )
}
