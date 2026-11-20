export type Kind = 'camera' | 'action' | 'dialogue' | 'sfx'

export interface Ev {
  id: string; kind: Kind; start: number; end: number; text: string
  speaker: string; emotion: string; scene: number
}
export interface EpisodeSummary {
  number: number; title: string; logline: string; duration: number; shots: number; lines: number; format: string
}
export interface ShowRef { id: string; title: string; locked: boolean; note: string }
export interface Show { id: string; title: string; episodes: EpisodeSummary[]; rules: { promo_min: number; promo_max: number }; leads?: string[] }
export interface Episode {
  number: number; title: string; logline: string; continuity: string; duration: number; format: string
  events: Ev[]; clean_cuts: number[]
}
export interface SegIn { episode: number; first: string; last: string; start?: number; end?: number }
export interface SegOut {
  episode: number; start: string; end: string; start_s: number; end_s: number; length_s: number
  first_event: string; last_event: string; hook_delay_s: number; tail_s: number
}
export interface Check { name: string; ok: boolean; detail: string }
export interface CheckResult { segments: SegOut[]; length: number; checks: Check[] }

export type HookType = 'identity_reversal' | 'forced_marriage' | 'humiliation_revenge' | 'forbidden_romance' | 'other'

export interface AiChecks {
  cold_viewer: { who_to_root_for?: string; stakes?: string; open_question?: string; understandable?: boolean; swipe_second?: number | null }
  cliffhanger_open: boolean; cliffhanger_reason: string; spoiler: boolean; spoiler_reason: string
  story?: { retell: string; about: string; about_a_lead: boolean; lost_at: number; lost_why: string; ok: boolean }
}
export interface RunPromo {
  rank?: number; title: string; hook: string; cliffhanger: string; why: string; hook_type: HookType
  scores: Record<string, number>; score?: number; breakdown?: { axis: string; points: number; max: number; why: string }[]; segments: SegOut[]; length: number; checks: Check[]
  problems: string[]; code_ok: boolean; ai_checks?: AiChecks; stitched?: boolean; repaired?: boolean; request?: string; hook_label?: string
  lead?: string; spine?: { beat: string; link: string }[]
  source_episode?: number; line?: string; mood?: string; for_episode?: number; from_episode?: number
}
export interface Run {
  id: string; created: string; show: string; show_id?: string; provider: string; model: string; episodes: number[]
  stats: { calls: number; cached: number; retries: number; prompt_tokens: number; completion_tokens: number
    model_seconds: number; wall_seconds: number; candidates: number; passed_code_checks: number; finalists: number; repaired: number }
  errors: { episode: number; error: string }[]
  promos: RunPromo[]; rejected: RunPromo[]; teasers: RunPromo[]; trailers?: RunPromo[]
  story?: { turning_points: Record<string, number | null>; mood: string; themes: string[] } | null; leads?: string[]
}
export interface Agreement { models: string[]; matrix: Record<string, Record<string, number | null>>; found_by: Record<string, Record<number, number>> }
export interface Job { id: string; status: 'running' | 'done' | 'error'; stage: string; done: number; total: number; message: string; run_id?: string; error?: string; provider: string; model: string }
export interface ProviderInfo { id: string; model: string; base_url: string; has_key: boolean; api: string }

export interface PromoDraft {
  id: string
  kind: 'promo' | 'teaser' | 'trailer'
  title: string
  hookType: HookType
  segments: SegIn[]
  status: 'draft' | 'approved' | 'rejected'
  note: string
  source: 'editor' | string        // 'editor' or provider/model
  ai?: RunPromo
  rank?: number
  foundBy?: number
  edited?: boolean
  summary?: { length: number; failed: number }
}

export const HOOKS: Record<HookType, { label: string; color: string }> = {
  identity_reversal: { label: 'Identity reversal', color: 'var(--color-rev-gold)' },
  forced_marriage: { label: 'Forced marriage', color: 'var(--color-rev-pink)' },
  humiliation_revenge: { label: 'Humiliation → revenge', color: 'var(--color-rev-blue)' },
  forbidden_romance: { label: 'Forbidden romance', color: 'var(--color-rev-green)' },
  other: { label: 'Untagged', color: 'var(--color-fg-3)' },
}

export const CHECK_LABEL: Record<string, string> = {
  length: 'Length',
  no_ending: "Doesn't show the episode's ending",
  hook_in_3s: 'Hook within 3 s',
  ends_on_reaction: 'Holds the reaction',
  clean_cuts: 'No chopped line, no flash frame',
}

export function tc(t: number): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`
}

let passcode = ''
try { passcode = sessionStorage.getItem('cliffcut.passcode') ?? '' } catch { /* storage blocked */ }
export function setPasscode(p: string) { passcode = p; try { sessionStorage.setItem('cliffcut.passcode', p) } catch { /* */ } }

/* The online demo (Cloudflare Pages) has no server: finished runs are baked in as JSON, and anything that would
   call a model or spend a key says so. Built with VITE_DEMO=1; see scripts/export_demo.py. */
export const DEMO = import.meta.env.VITE_DEMO === '1'
export const REPO = 'https://github.com/wenayy/cliffcut'
export const READ_ONLY = `This online demo is read-only: it shows finished runs. To run models on your own scripts, edit cuts or export video, run Cliffcut locally (${REPO}).`

export function checkKey(segments: SegIn[], min: number, max: number, leads?: string[] | null) {
  return `${min}|${max}|${leads?.length ? 'L' : ''}|` + segments.map(s => [s.episode, s.first, s.last, s.start ?? '', s.end ?? ''].join(':')).join(',')
}

const demoChecks: Record<string, Record<string, unknown>> = {}
async function demoReq<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.split('?')[0]
  const fail = (m: string, status = 400) => Object.assign(new Error(m), { status })
  if ((init?.method ?? 'GET') === 'GET') {
    if (url.endsWith('/videos')) return { episodes: [] } as T
    if (url.endsWith('/estimate')) throw fail(READ_ONLY)
    const r = await fetch(`/demo${url.replace(/^\/api/, '')}.json`)
    if (!r.ok) throw fail(r.status === 404 ? 'Not in the online demo' : `${r.status}`, r.status)
    return r.json() as Promise<T>
  }
  if (url.endsWith('/check')) {
    const sid = url.split('/')[3]
    const b = JSON.parse(String(init?.body ?? '{}'))
    demoChecks[sid] ??= await fetch(`/demo/shows/${sid}/checks.json`).then(r => r.ok ? r.json() : {})
    const hit = demoChecks[sid][checkKey(b.segments, b.min, b.max, b.leads)]
    if (hit) return hit as T
    throw fail('Edited cuts are re-checked by the local app. This online demo shows the cuts as the AI found them.')
  }
  if (url.endsWith('/decide')) return {} as T          // approvals stay in this browser
  throw fail(READ_ONLY)
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  if (DEMO) return demoReq<T>(path, init)
  const headers: Record<string, string> = { ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }) }
  if (passcode) headers['x-passcode'] = passcode
  const r = await fetch(path, { ...init, headers })
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try { msg = (await r.json()).detail ?? msg } catch { /* not json */ }
    const e = new Error(msg) as Error & { status?: number }
    e.status = r.status
    throw e
  }
  return r.json() as Promise<T>
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })

export const api = {
  shows: () => req<{ shows: ShowRef[] }>('/api/shows'),
  show: (sid: string) => req<Show>(`/api/shows/${sid}`),
  episode: (sid: string, n: number) => req<Episode>(`/api/shows/${sid}/episodes/${n}`),
  check: (sid: string, segments: SegIn[], min = 20, max = 60, leads?: string[]) => req<CheckResult>(`/api/shows/${sid}/check`, post({ segments, min, max, leads })),
  runs: (sid: string) => req<{ runs: Run[]; agreement: Agreement }>(`/api/shows/${sid}/runs`),
  providers: () => req<{ providers: ProviderInfo[] }>('/api/providers'),
  models: (p: { provider: string; base_url?: string; api_key?: string }) => req<{ models: string[] }>('/api/models', post(p)),
  startRun: (sid: string, body: { provider: string; model?: string; base_url?: string; api_key?: string; episodes?: number[] | null; brief?: string; use_taste?: boolean
    genre?: string; stitch?: boolean; teasers?: boolean; trailer_min?: number; trailer_max?: number; language?: string; leads?: string[] }) =>
    req<Job>(`/api/shows/${sid}/runs`, post(body)),
  job: (id: string) => req<Job>(`/api/jobs/${id}`),
  taste: () => req<{ approved: number; rejected: number }>('/api/taste'),
  decide: (d: { promo_id: string; decision: string; title: string; hook?: string; cliffhanger?: string; hook_type: string; note: string; show: string }) =>
    req<{ approved: number; rejected: number }>('/api/taste', post(d)),
  estimate: (sid: string, episodes: number[] | null) => req<{ episodes: number; calls: number; tokens: number }>(`/api/shows/${sid}/estimate?episodes=${(episodes ?? []).join(',')}`),
  moreTrailers: (sid: string, rid: string, instruction: string, min: number, max: number) =>
    req<{ made: number[]; run: Run }>(`/api/shows/${sid}/runs/${rid}/trailers`, { method: 'POST', body: JSON.stringify({ instruction, min, max }) }),
  videos: (sid: string) => req<{ episodes: number[] }>(`/api/shows/${sid}/videos`),
  uploadVideos: (sid: string, files: File[]) => {
    const f = new FormData()
    files.forEach(x => f.append('files', x))
    return req<{ episodes: number[]; saved: number[] }>(`/api/shows/${sid}/videos`, { method: 'POST', body: f })
  },
  render: async (sid: string, segments: SegIn[], title: string, vertical: boolean, min = 20, max = 60) => {
    if (DEMO) throw new Error(READ_ONLY)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (passcode) headers['x-passcode'] = passcode
    const r = await fetch(`/api/shows/${sid}/render`, { method: 'POST', headers, body: JSON.stringify({ segments, title, vertical, min, max }) })
    if (!r.ok) { let m = `${r.status}`; try { m = (await r.json()).detail ?? m } catch { /* */ } throw new Error(m) }
    return r.blob()
  },
  upload: (files: File[], title: string) => {
    const f = new FormData()
    files.forEach(x => f.append('files', x))
    f.append('title', title)
    return req<{ id: string; title: string; episodes: number; formats: string[] }>('/api/upload', { method: 'POST', body: f })
  },
}

/* ---------- export ---------- */

const FPS = 30 // the scripts carry no frame rate; assumed and stated in the EDL header

function smpte(t: number): string {
  const frames = Math.round(t * FPS)
  const f = frames % FPS, s = Math.floor(frames / FPS) % 60, m = Math.floor(frames / FPS / 60) % 60, h = Math.floor(frames / FPS / 3600)
  return [h, m, s, f].map(v => String(v).padStart(2, '0')).join(':')
}

export function toEDL(p: PromoDraft, segs: SegOut[]): string {
  let rec = 0
  const lines = [`TITLE: ${p.title.toUpperCase().slice(0, 60)}`, 'FCM: NON-DROP FRAME', `* ASSUMED ${FPS} FPS; SOURCE REEL = EPISODE NUMBER`, '']
  segs.forEach((s, i) => {
    const reel = `EP${String(s.episode).padStart(3, '0')}`.padEnd(8)
    lines.push(`${String(i + 1).padStart(3, '0')}  ${reel} V     C        ${smpte(s.start_s)} ${smpte(s.end_s)} ${smpte(rec)} ${smpte(rec + s.length_s)}`)
    lines.push(`* FROM CLIP NAME: EPISODE ${s.episode}  ${s.first_event} → ${s.last_event}`)
    rec += s.length_s
  })
  return lines.join('\n') + '\n'
}

export function toCSV(rows: { p: PromoDraft; segs: SegOut[] }[]): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const out = ['kind,rank,title,hook_type,segment,episode,start,end,length_s,hook,cliffhanger,why,status']
  rows.forEach(({ p, segs }, r) => segs.forEach((s, i) => out.push([
    p.kind, p.rank ?? r + 1, q(p.title), p.hookType, i + 1, s.episode, s.start, s.end, s.length_s,
    q(p.ai?.hook), q(p.ai?.cliffhanger), q(p.ai?.why), p.status,
  ].join(','))))
  return out.join('\n') + '\n'
}

export function download(name: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
}

/* turn a model's promo into an editable draft (the edit is kept separately; the run file never changes) */
export function fromRun(run: Run, p: RunPromo, kind: 'promo' | 'teaser' | 'trailer', i: number, foundBy?: number): PromoDraft {
  return {
    id: `${run.id}:${kind}:${p.rank ?? i + 1}`, kind,
    title: p.title || (kind === 'teaser' ? `Teaser for episode ${p.for_episode}` : kind === 'trailer' ? `Trailer ${p.rank}` : `Promo ${p.rank}`),
    hookType: p.hook_type ?? 'other',
    segments: p.segments.map(s => ({ episode: s.episode, first: s.first_event, last: s.last_event })),
    status: 'draft', note: '', source: `${run.provider} · ${run.model}`, ai: p, rank: p.rank ?? i + 1, foundBy,
    summary: { length: p.length, failed: p.checks.filter(c => !c.ok).length },
  }
}
