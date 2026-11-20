import { Eye, EyeOff, FileText, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Job, ProviderInfo, Show } from '../lib'
import { api, DEMO, READ_ONLY, rememberKey } from '../lib'
import { Working } from './Logo'

const STAGES: Record<string, string> = {
  find: 'Reading episodes and picking moments',
  stitch: 'Joining moments across episodes',
  judge: 'Checking finalists: cold viewer, cliffhanger, spoilers',
}
const LABEL: Record<string, string> = { openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini', groq: 'Groq', custom: 'Custom' }

interface Props {
  show: Show | null
  onUploaded: (showId: string) => void
  onDone: (runId: string) => void
  onBrowse: () => void
  hasRuns: boolean
}

function parseEpisodes(text: string, max: number): number[] | null | undefined {
  if (!text.trim()) return null
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const [a, b] = part.split('-').map(x => parseInt(x.trim(), 10))
    if (Number.isNaN(a) || a < 1 || a > max) return undefined
    const end = b === undefined ? a : b
    if (Number.isNaN(end) || end < a || end > max) return undefined
    for (let n = a; n <= end; n++) out.add(n)
  }
  return [...out]
}

export function RunPanel({ show, onUploaded, onDone, onBrowse, hasRuns }: Props) {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [prov, setProv] = useState('openai')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [scope, setScope] = useState<'all' | 'some'>('all')
  const [range, setRange] = useState('1-5')
  const [job, setJob] = useState<Job | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [title, setTitle] = useState('')
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const [brief, setBrief] = useState(() => { try { return localStorage.getItem('cliffcut.brief') ?? '' } catch { return '' } })
  const [useTaste, setUseTaste] = useState(true)
  const [taste, setTaste] = useState<{ approved: number; rejected: number } | null>(null)
  const [genre, setGenre] = useState('')
  const [language, setLanguage] = useState('English')
  const [makeTrailers, setMakeTrailers] = useState(true)
  const [trailerLen, setTrailerLen] = useState('60-90')
  const [makeTeasers, setMakeTeasers] = useState(true)
  const [leads, setLeads] = useState('')
  useEffect(() => { setLeads((show?.leads ?? []).map(n => n.charAt(0) + n.slice(1).toLowerCase()).join(', ')) }, [show?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { api.providers().then(r => setProviders(r.providers)).catch(() => {}) }, [])
  useEffect(() => { api.taste().then(setTaste).catch(() => {}) }, [])
  useEffect(() => { try { localStorage.setItem('cliffcut.brief', brief) } catch { /* */ } }, [brief])

  const preset = providers.find(p => p.id === prov)
  const custom = prov === 'custom'

  const loadModels = async (p = prov, k = key) => {
    setErr(null); setLoadingModels(true)
    try { setModels((await api.models({ provider: p, base_url: p === 'custom' ? baseUrl : undefined, api_key: k || undefined })).models) }
    catch (e) { setModels([]); if (k || p === 'custom') setErr((e as Error).message) }
    finally { setLoadingModels(false) }
  }

  // switching provider: its default model, and its live model list when a key is available
  useEffect(() => {
    setModel(preset?.model ?? ''); setModels([])
    if (preset?.has_key) loadModels(prov, '')
  }, [prov, preset?.model, preset?.has_key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!job || job.status !== 'running') return
    const t = setInterval(() => api.job(job.id).then(j => {
      setJob(j)
      if (j.status === 'done' && j.run_id) onDone(j.run_id)
    }).catch(() => {}), 800)
    return () => clearInterval(t)
  }, [job, onDone])

  const maxEp = show?.episodes.length ?? 0
  const episodes = scope === 'all' ? null : parseEpisodes(range, maxEp)
  const [est, setEst] = useState<{ episodes: number; calls: number; tokens: number } | null>(null)
  const epKey = JSON.stringify(episodes)
  useEffect(() => {
    if (!show || episodes === undefined) { setEst(null); return }
    api.estimate(show.id, episodes).then(setEst).catch(() => setEst(null))
  }, [show?.id, epKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const canRun = !!show && (custom ? !!baseUrl && !!model : !!model) && episodes !== undefined && job?.status !== 'running'

  const run = async () => {
    if (!show) return
    setErr(null)
    try {
      rememberKey({ api_key: key || undefined, base_url: custom ? baseUrl : undefined })
      setJob(await api.startRun(show.id, {
        provider: prov, model: model || undefined, base_url: custom ? baseUrl : undefined,
        api_key: key || undefined, episodes: episodes ?? null, brief, use_taste: useTaste,
        genre, language, stitch: makeTrailers, leads: leads.split(',').map(x => x.trim()).filter(Boolean), teasers: makeTeasers,
        trailer_min: +trailerLen.split('-')[0], trailer_max: +trailerLen.split('-')[1],
      }))
    } catch (e) { setErr((e as Error).message) }
  }

  const upload = async () => {
    setBusy(true); setUploadMsg(null)
    try {
      const r = await api.upload(files, title)
      const est = r.formats.includes('screenplay') ? ' No timestamps in this format, so timing is estimated from word counts.' : ''
      setUploadMsg(`Read ${r.episodes} episode${r.episodes === 1 ? '' : 's'}.${est}`)
      setFiles([]); setTitle('')
      onUploaded(r.id)
    } catch (e) { setUploadMsg((e as Error).message) }
    finally { setBusy(false) }
  }

  const pct = job && job.total ? Math.round((job.done / job.total) * 100) : 0
  const opts = models.length && !models.includes(model) && model ? [model, ...models] : models
  const field = 'h-9 rounded-[8px] border hairline bg-ink-2 px-3 font-mono text-[12px] text-fg-1 placeholder:text-fg-3 outline-none focus:border-fg-3/40'

  return (
    <div className="mx-auto w-full max-w-[680px] px-8 py-8 space-y-10">
      <header>
        <h1 className="text-[20px] leading-7 font-medium text-fg-1">Find promos in a show</h1>
        <p className="mt-1.5 text-[13px] leading-5 text-fg-3 max-w-[60ch]">
          Pick the scripts, pick a model, press Find promos. It reads every episode, picks 20–60 s promos with a hook in the first 3 s and a cliffhanger at the cut, checks each one, and ranks them.
          {hasRuns && <> Or <button onClick={onBrowse} className="text-fg-1 underline underline-offset-2 decoration-fg-3/50 hover:decoration-fg-1">look at the last run's promos</button>.</>}
        </p>
        {DEMO && <p className="mt-3 rounded-[10px] bg-ink-2 px-3 py-2.5 text-[13px] leading-5 text-fg-2">{READ_ONLY}</p>}
      </header>

      {/* 1. scripts */}
      <section className="space-y-3">
        <h2 className="text-[14px] font-medium text-fg-1"><span className="font-mono text-fg-3 mr-2">1</span>Scripts</h2>
        <p className="text-[13px] text-fg-2">
          {show ? <>Using <span className="text-fg-1">{show.title}</span> ({show.episodes.length} episodes). Change it in the top left, or upload new scripts:</> : 'Pick a show in the top left, or upload scripts:'}
        </p>
        <div
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); setFiles(Array.from(e.dataTransfer.files)) }}
          onClick={() => input.current?.click()}
          className={`cursor-pointer rounded-[12px] border border-dashed px-5 py-5 text-center transition-colors duration-150 ${drag ? 'border-pencil bg-ink-2' : 'border-fg-3/30 hover:bg-ink-2'}`}
        >
          <input ref={input} type="file" multiple className="hidden" accept=".txt,.md,.fountain,text/plain"
            onChange={e => setFiles(Array.from(e.target.files ?? []))} />
          <Upload size={18} strokeWidth={1.5} className="mx-auto text-fg-3" />
          <p className="mt-2 text-[13px] text-fg-1">{files.length ? `${files.length} file${files.length > 1 ? 's' : ''} ready` : 'Drop episode scripts here, or click to choose'}</p>
          <p className="mt-1 text-[12px] text-fg-3">One file per episode. Kuku's timestamped format, or a normal screenplay (Fountain or plain text)</p>
        </div>
        {files.length > 0 && (
          <div className="space-y-2">
            <ul className="space-y-1">
              {files.slice(0, 6).map(f => <li key={f.name} className="flex items-center gap-2 text-[12px] text-fg-2"><FileText size={14} strokeWidth={1.5} className="text-fg-3" />{f.name}</li>)}
              {files.length > 6 && <li className="text-[12px] text-fg-3">and {files.length - 6} more</li>}
            </ul>
            <div className="flex gap-2">
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Show name" className={`${field} flex-1 font-sans text-[13px]`} />
              <button onClick={upload} disabled={busy} className="h-9 rounded-[8px] border hairline bg-ink-3 px-4 text-[13px] text-fg-1 hover:bg-ink-4 transition-colors duration-150 disabled:opacity-50">
                {busy ? 'Reading' : 'Upload'}
              </button>
            </div>
          </div>
        )}
        {uploadMsg && <p className="text-[13px] text-fg-2">{uploadMsg}</p>}
      </section>

      {/* 2. model */}
      <section className="space-y-4">
        <div>
          <h2 className="text-[14px] font-medium text-fg-1"><span className="font-mono text-fg-3 mr-2">2</span>Model</h2>
          <p className="mt-1 text-[13px] text-fg-3">Run the same show on several models to compare them. Custom takes any OpenAI-compatible URL; more providers go in providers.json.</p>
        </div>
        <div role="radiogroup" aria-label="Provider" className="inline-flex flex-wrap rounded-[10px] border hairline bg-ink-2 p-1">
          {[...providers.map(p => p.id), 'custom'].map(id => (
            <button key={id} role="radio" aria-checked={prov === id} onClick={() => setProv(id)}
              className={`h-8 rounded-[7px] px-3 text-[13px] transition-colors duration-150 ${prov === id ? 'bg-ink-4 text-fg-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]' : 'text-fg-2 hover:text-fg-1'}`}>
              {LABEL[id] ?? id}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-[110px_1fr] items-start gap-x-4 gap-y-3">
          {custom && (
            <>
              <label htmlFor="base" className="pt-2 text-[13px] text-fg-2">Base URL</label>
              <input id="base" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://your-endpoint/v1" className={field} />
            </>
          )}
          <label htmlFor="key" className="pt-2 text-[13px] text-fg-2">API key</label>
          <div>
            <div className="relative">
              <input id="key" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={key}
                onChange={e => setKey(e.target.value)} onBlur={() => key && loadModels(prov, key)}
                placeholder={preset?.has_key ? 'Using the key saved in .env' : 'Paste a key'} className={`${field} w-full pr-10`} />
              <button type="button" onClick={() => setShowKey(v => !v)} aria-label={showKey ? 'Hide key' : 'Show key'}
                className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-[6px] text-fg-3 hover:bg-ink-3 hover:text-fg-1 transition-colors duration-150">
                {showKey ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
              </button>
            </div>
            <p className="mt-1.5 text-[12px] text-fg-3">{preset?.has_key && !key ? 'A key for this provider is saved on the server. Paste one only to use a different account.' : 'Used for this run only. Never saved or logged.'}</p>
          </div>
          <label htmlFor="model" className="pt-2 text-[13px] text-fg-2">Model</label>
          <div className="space-y-1.5">
            {opts.length > 0 ? (
              <select id="model" value={model} onChange={e => setModel(e.target.value)} className={`${field} w-full`}>
                {opts.map(m => <option key={m} value={m} className="bg-ink-2">{m}{m === preset?.model ? '  (default)' : ''}</option>)}
              </select>
            ) : (
              <input id="model" value={model} onChange={e => setModel(e.target.value)} placeholder="model name" className={`${field} w-full`} />
            )}
            <p className="text-[12px] text-fg-3">
              {loadingModels ? 'Loading the models this key can use' : opts.length ? `${opts.length} models this key can use` : (
                <>Type a name, or <button onClick={() => loadModels()} className="text-fg-2 underline underline-offset-2 hover:text-fg-1">load the list</button> once a key is set.</>
              )}
            </p>
          </div>
          <span className="pt-2 text-[13px] text-fg-2">Episodes</span>
          <div className="space-y-2">
            <div role="radiogroup" aria-label="Episodes" className="inline-flex rounded-[10px] border hairline bg-ink-2 p-1">
              {(['all', 'some'] as const).map(v => (
                <button key={v} role="radio" aria-checked={scope === v} onClick={() => setScope(v)}
                  className={`h-8 rounded-[7px] px-3 text-[13px] transition-colors duration-150 ${scope === v ? 'bg-ink-4 text-fg-1' : 'text-fg-2 hover:text-fg-1'}`}>
                  {v === 'all' ? `All ${maxEp || ''}` : 'Only some'}
                </button>
              ))}
            </div>
            {scope === 'some' && (
              <div>
                <input value={range} onChange={e => setRange(e.target.value)} aria-label="Which episodes"
                  className={`${field} w-48 ${episodes === undefined ? 'border-bad' : ''}`} />
                <p className="mt-1.5 text-[12px] text-fg-3">
                  {episodes === undefined ? `Use numbers 1–${maxEp}: one (3), a range (1-5) or a list (1,4,7)` : `${episodes?.length ?? 0} episode${episodes?.length === 1 ? '' : 's'}: one (3), a range (1-5) or a list (1,4,7). A few episodes is a quick test.`}
                </p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 3. what to make */}
      <section className="space-y-4">
        <div>
          <h2 className="text-[14px] font-medium text-fg-1"><span className="font-mono text-fg-3 mr-2">3</span>What to make</h2>
          <p className="mt-1 text-[13px] text-fg-3">Promos are always made. Add the other two if you want them.</p>
        </div>
        <div className="space-y-3 text-[13px]">
          <label className="flex items-start gap-2.5 text-fg-2"><input type="checkbox" checked disabled className="mt-[3px] accent-[var(--color-pencil)]" />
            <span><span className="text-fg-1">Promos</span><span className="block text-[12px] text-fg-3">20–60 s ads, each cut from one episode: a hook, then a cliffhanger. About 2 per episode.</span></span></label>
          <label className="flex items-start gap-2.5 text-fg-2 cursor-pointer"><input type="checkbox" checked={makeTrailers} onChange={e => setMakeTrailers(e.target.checked)} className="mt-[3px] accent-[var(--color-pencil)]" />
            <span className="flex-1"><span className="text-fg-1">Whole-show trailers</span><span className="block text-[12px] text-fg-3">One ad for the whole series: 3–6 moments from different episodes, in story order, never the ending.</span>
              {makeTrailers && (
                <span className="mt-2 flex items-center gap-2 text-[12px] text-fg-3">Length
                  <select value={trailerLen} onChange={e => setTrailerLen(e.target.value)} className="h-8 rounded-[8px] border hairline bg-ink-2 px-2 font-mono text-[12px] text-fg-1 outline-none">
                    <option value="45-60" className="bg-ink-2">45–60 s (fits the brief's 60 s cap)</option>
                    <option value="60-90" className="bg-ink-2">60–90 s (default)</option>
                    <option value="90-120" className="bg-ink-2">90–120 s (long serial ad)</option>
                  </select>
                </span>
              )}</span></label>
          <label className="flex items-start gap-2.5 text-fg-2 cursor-pointer"><input type="checkbox" checked={makeTeasers} onChange={e => setMakeTeasers(e.target.checked)} className="mt-[3px] accent-[var(--color-pencil)]" />
            <span><span className="text-fg-1">Next-episode teasers</span><span className="block text-[12px] text-fg-3">8–20 s "next time on…" clips, one per episode, to keep current viewers watching.</span></span></label>
        </div>
        <div className="grid grid-cols-[110px_1fr] items-center gap-x-4 gap-y-3">
          <label htmlFor="genre" className="text-[13px] text-fg-2">Category</label>
          <select id="genre" value={genre} onChange={e => setGenre(e.target.value)} className="h-9 w-64 rounded-[8px] border hairline bg-ink-2 px-3 text-[13px] text-fg-1 outline-none">
            {[['', 'Let the AI work it out'], ['Romance and love (contemporary, forbidden, billionaire)', 'Romance and love'], ['Thriller and suspense', 'Thriller and suspense'], ['Crime', 'Crime'], ['Horror and supernatural', 'Horror and supernatural'], ['Fantasy and sci-fi (werewolf, vampire, magic)', 'Fantasy and sci-fi'], ['Drama and family (household, social, revenge)', 'Drama and family'], ['Comedy', 'Comedy'], ['Mythology and religion', 'Mythology and religion']].map(([v, l]) => <option key={v} value={v} className="bg-ink-2">{l}</option>)}
          </select>
          <label htmlFor="leads" className="self-start pt-2 text-[13px] text-fg-2">Main characters</label>
          <div>
            <input id="leads" value={leads} onChange={e => setLeads(e.target.value)} placeholder="e.g. Mira, Celeste"
              className="h-9 w-full rounded-[8px] border hairline bg-ink-2 px-3 text-[13px] text-fg-1 placeholder:text-fg-3 outline-none focus:border-fg-3/40" />
            <p className="mt-1.5 text-[12px] text-fg-3">Found in the scripts (who appears in the most episodes). Edit if wrong. Promos centre on these characters.</p>
          </div>
          <label htmlFor="lang" className="text-[13px] text-fg-2">Write results in</label>
          <div>
            <select id="lang" value={language} onChange={e => setLanguage(e.target.value)} className="h-9 w-64 rounded-[8px] border hairline bg-ink-2 px-3 text-[13px] text-fg-1 outline-none">
              {['English', 'Hindi', 'Hinglish', 'Tamil', 'Telugu', 'Bengali', 'Marathi'].map(l => <option key={l} value={l} className="bg-ink-2">{l}</option>)}
            </select>
            <p className="mt-1.5 text-[12px] text-fg-3">Scripts can be in any language (English, Hindi or a regional language). This sets the language of the titles, hooks and reasons.</p>
          </div>
        </div>
      </section>

      {/* 4. the editor's voice */}
      <section className="space-y-3">
        <div>
          <h2 className="text-[14px] font-medium text-fg-1"><span className="font-mono text-fg-3 mr-2">4</span>Editor brief <span className="text-fg-3 font-normal">(optional)</span></h2>
          <p className="mt-1 text-[13px] text-fg-3">Tell the model what to focus on. It follows this unless it breaks the hard rules (length, hook, clean cuts).</p>
        </div>
        <textarea value={brief} onChange={e => setBrief(e.target.value)} rows={3}
          placeholder="e.g. Lead with the revenge arc. Prefer episodes 1–10. Nothing that reveals the duke's identity."
          className="w-full resize-none rounded-[10px] border hairline bg-ink-2 px-3 py-2 text-[13px] leading-5 text-fg-1 placeholder:text-fg-3 outline-none focus:border-fg-3/40" />
        <label className="flex items-start gap-2.5 text-[13px] text-fg-2 cursor-pointer">
          <input type="checkbox" checked={useTaste} onChange={e => setUseTaste(e.target.checked)} className="mt-[3px] accent-[var(--color-pencil)]" />
          <span>
            Learn from my past decisions
            <span className="block text-[12px] text-fg-3">
              {taste && taste.approved + taste.rejected > 0
                ? `${taste.approved} approved and ${taste.rejected} rejected promos, with your notes, go to the model as examples of what you want.`
                : 'When you approve or reject promos (with a note on why), the next run picks more like the ones you approved.'}
            </span>
          </span>
        </label>
      </section>

      <div className="space-y-3">
        {err && <p className="text-[13px] text-bad">{err}</p>}
        {est && (
          <p className="text-[12px] leading-[18px] text-fg-3">
            Estimated: about <span className="text-fg-2 font-mono tnum">{est.calls}</span> model calls and <span className="text-fg-2 font-mono tnum">{est.tokens.toLocaleString()}</span> tokens for {est.episodes} episode{est.episodes === 1 ? '' : 's'}. Answers are saved, so running the same thing again costs nothing.
            {est.tokens > 150000 && <span className="block text-fg-2">That's a full show. To try things out, pick "Only some" and 2–3 episodes first.</span>}
          </p>
        )}
        <button onClick={run} disabled={!canRun}
          className="h-10 rounded-[8px] bg-fg-1 px-5 text-[13px] font-medium text-ink-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.4)] hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-150 disabled:opacity-40">
          Find promos
        </button>
      </div>

      {job && (
        <section className="rounded-[12px] border hairline bg-ink-2 p-5 space-y-3" aria-live="polite">
          <div className="flex items-center justify-between gap-4">
            {job.status === 'running' ? <Working label={STAGES[job.stage] ?? job.message} />
              : <span className={`text-[13px] ${job.status === 'error' ? 'text-bad' : 'text-ok'}`}>{job.status === 'error' ? 'Run failed' : `Done: ${job.message}`}</span>}
            <span className="font-mono text-[11px] text-fg-3 truncate">{LABEL[job.provider] ?? job.provider} · {job.model}</span>
          </div>
          {job.status === 'running' && <StageList stage={job.stage} />}
          {job.status === 'running' && (
            <>
              <div className="h-1.5 rounded-full bg-ink-3 overflow-hidden">
                <div className="h-full rounded-full bg-fg-1 transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
              </div>
              <p className="font-mono text-[11px] text-fg-3 tnum">{job.done} of {job.total} · {job.message}</p>
            </>
          )}
          {job.error && <p className="text-[13px] text-fg-2 break-words">{job.error}</p>}
        </section>
      )}
    </div>
  )
}

/* What the run is doing, in order, and what the editor does after. */
const STEPS = [
  ['find', 'Read every episode', 'The AI reads each script and suggests its best 20–60 s moments, a teaser for the next episode, and where to cut. Code checks every cut.'],
  ['judge', 'Test the best ones', 'Fresh AI judges watch the top picks like a stranger would: can they follow it, is the cliffhanger still open, is anything spoiled.'],
  ['stitch', 'Build whole-show trailers', 'The AI maps the story and joins moments from different episodes into 2–3 trailers that never show the ending.'],
] as const

function StageList({ stage }: { stage: string }) {
  const at = STEPS.findIndex(([k]) => k === stage)
  return (
    <ol className="space-y-2.5">
      {STEPS.map(([k, title, body], i) => (
        <li key={k} className="grid grid-cols-[20px_1fr] gap-x-2">
          <span className={`mt-0.5 grid size-4 place-items-center rounded-full font-mono text-[10px] ${i < at ? 'bg-ok/20 text-ok' : i === at ? 'bg-fg-1 text-ink-1' : 'bg-ink-3 text-fg-3'}`}>{i < at ? '✓' : i + 1}</span>
          <div>
            <p className={`text-[13px] ${i === at ? 'text-fg-1' : 'text-fg-3'}`}>{title}</p>
            {i === at && <p className="text-[12px] leading-[18px] text-fg-3">{body}</p>}
          </div>
        </li>
      ))}
      <li className="grid grid-cols-[20px_1fr] gap-x-2">
        <span className="mt-0.5 grid size-4 place-items-center rounded-full bg-ink-3 font-mono text-[10px] text-fg-3">4</span>
        <p className="text-[13px] text-fg-3">You review: approve or reject each one, then export</p>
      </li>
    </ol>
  )
}
