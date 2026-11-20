import type { Agreement, Run, RunPromo } from '../lib'
import { HOOKS } from '../lib'

const LABEL: Record<string, string> = { openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini', groq: 'Groq', custom: 'Custom' }

type Metric = { label: string; hint: string; get: (r: Run) => number | null; fmt: (v: number, r: Run) => string; pct?: boolean; lowerBetter?: boolean }

const judged = (r: Run) => r.promos.filter(p => p.ai_checks)
const share = (r: Run, f: (p: RunPromo) => boolean) => { const j = judged(r); return j.length ? j.filter(f).length / j.length : null }

const METRICS: Metric[] = [
  { label: 'Promos found', hint: 'Ranked promos that passed every code check', get: r => r.promos.length, fmt: (v, r) => `${v} across ${new Set(r.promos.map(p => p.segments[0]?.episode)).size} episodes` },
  { label: 'Picks that passed the checks', hint: 'Share of everything the model suggested that was 20–60 s, hooked in 3 s and cut cleanly', get: r => r.stats.candidates ? r.stats.passed_code_checks / r.stats.candidates : null, fmt: v => `${Math.round(v * 100)}%`, pct: true },
  { label: 'Cliffhanger still open', hint: 'Of the checked finalists: the answer comes after the cut, not inside the promo', get: r => share(r, p => !!p.ai_checks?.cliffhanger_open), fmt: v => `${Math.round(v * 100)}%`, pct: true },
  { label: 'A stranger can follow it', hint: 'A fresh model that knows nothing about the show understood who to root for', get: r => share(r, p => p.ai_checks?.cold_viewer.understandable !== false), fmt: v => `${Math.round(v * 100)}%`, pct: true },
  { label: 'No spoiler', hint: 'Does not give away a later twist', get: r => share(r, p => !p.ai_checks?.spoiler), fmt: v => `${Math.round(v * 100)}%`, pct: true },
  { label: 'Teasers that passed', hint: '8–20 s, from the next episode, without its ending', get: r => r.teasers.length ? r.teasers.filter(t => t.code_ok).length / r.teasers.length : null, fmt: (v, r) => `${Math.round(v * 100)}% (${r.teasers.filter(t => t.code_ok).length} of ${r.teasers.length})`, pct: true },
  { label: 'Tokens used', hint: 'Prompt plus answer tokens for the whole show', get: r => r.stats.prompt_tokens + r.stats.completion_tokens, fmt: v => v.toLocaleString(), lowerBetter: true },
  { label: 'Time', hint: 'Wall-clock time for the whole show (free tiers are throttled)', get: r => r.stats.wall_seconds, fmt: v => v >= 120 ? `${Math.round(v / 60)} min` : `${Math.round(v)} s`, lowerBetter: true },
]

function overlap(a: RunPromo, b: RunPromo) {
  return a.segments.some(x => b.segments.some(y => x.episode === y.episode &&
    Math.min(x.end_s, y.end_s) - Math.max(x.start_s, y.start_s) > 0.4 * Math.min(x.length_s, y.length_s)))
}

export function ModelsTable({ runs, agreement, onOpen }: { runs: Run[]; agreement: Agreement | null; onOpen: (id: string) => void }) {
  const latest = new Map<string, Run>()
  runs.filter(r => r.promos.length > 0).forEach(r => { const k = `${r.provider}/${r.model}`; if (!latest.has(k)) latest.set(k, r) })
  const rows = [...latest.entries()]
  const failed = runs.filter(r => r.promos.length === 0)

  if (rows.length === 0)
    return (
      <div className="mx-auto max-w-[560px] px-8 py-16">
        <p className="text-[14px] text-fg-1">No model runs on this show yet</p>
        <p className="mt-1.5 text-[13px] leading-5 text-fg-3">Run the show from New run with two or more models. This page then shows, side by side, how each did on every check, what it cost, and which moments several models picked on their own. Those are the safest promos to post first.</p>
      </div>
    )

  const best = METRICS.map(m => {
    const vals = rows.map(([, r]) => m.get(r)).filter((v): v is number => v !== null)
    return vals.length > 1 ? (m.lowerBetter ? Math.min(...vals) : Math.max(...vals)) : null
  })

  // moments picked independently by more than one model
  const agreed: { p: RunPromo; by: string[] }[] = []
  for (const [k, r] of rows) for (const p of r.promos) {
    const by = rows.filter(([k2, r2]) => k2 !== k && r2.promos.some(q => overlap(p, q))).map(([k2]) => k2)
    if (by.length && !agreed.some(a => overlap(a.p, p))) agreed.push({ p, by: [k, ...by] })
  }
  agreed.sort((a, b) => b.by.length - a.by.length || (a.p.rank ?? 99) - (b.p.rank ?? 99))

  return (
    <div className="px-8 py-8 space-y-10">
      <header>
        <h1 className="text-[20px] leading-7 font-medium text-fg-1">Compare models</h1>
        <p className="mt-1.5 text-[13px] leading-5 text-fg-3 max-w-[70ch]">The newest run of each model on this show, on the same checks. The best value on each line is in white. Click a card to open that model's promos.</p>
      </header>

      <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
        {rows.map(([k, r]) => (
          <button key={k} onClick={() => onOpen(r.id)}
            className="text-left rounded-[14px] border hairline bg-ink-2 p-5 hover:bg-ink-3 transition-colors duration-150">
            <p className="text-[15px] font-medium text-fg-1">{LABEL[r.provider] ?? r.provider}</p>
            <p className="font-mono text-[11px] text-fg-3 truncate">{r.model} · {r.episodes.length} episodes · {r.created.replace('T', ' ').slice(5, 16)}</p>
            <dl className="mt-4 space-y-3">
              {METRICS.map((m, i) => {
                const v = m.get(r)
                const top = v !== null && best[i] !== null && v === best[i]
                return (
                  <div key={m.label} title={m.hint}>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-[12px] text-fg-3">{m.label}</dt>
                      <dd className={`font-mono text-[12px] tnum ${top ? 'text-fg-1' : 'text-fg-2'}`}>{v === null ? 'not checked' : m.fmt(v, r)}</dd>
                    </div>
                    {m.pct && v !== null && (
                      <div className="mt-1 h-1 rounded-full bg-ink-4 overflow-hidden">
                        <div className={`h-full rounded-full ${top ? 'bg-fg-1' : 'bg-fg-3'}`} style={{ width: `${Math.round(v * 100)}%` }} />
                      </div>
                    )}
                  </div>
                )
              })}
              {rows.length > 1 && (
                <div className="pt-1">
                  <dt className="text-[12px] text-fg-3">Its top 10 also found by</dt>
                  <dd className="mt-1 font-mono text-[12px] text-fg-2 tnum">
                    {rows.filter(([k2]) => k2 !== k).map(([k2]) => {
                      const a = agreement?.matrix[k]?.[k2]
                      return `${LABEL[k2.split('/')[0]] ?? k2} ${a == null ? '–' : `${Math.round(a * 100)}%`}`
                    }).join(' · ')}
                  </dd>
                </div>
              )}
            </dl>
          </button>
        ))}
      </div>

      {failed.length > 0 && (
        <section className="space-y-1">
          <h2 className="text-[13px] text-fg-2">Runs that found nothing ({failed.length})</h2>
          {failed.map(r => (
            <p key={r.id} className="font-mono text-[11px] leading-4 text-fg-3">
              {r.provider} {r.model}: {r.errors[0]?.error.slice(0, 160) ?? 'no promo passed the checks'}
            </p>
          ))}
        </section>
      )}

      {rows.length > 1 && (
        <section>
          <h2 className="text-[16px] font-medium text-fg-1">Moments the models agree on</h2>
          <p className="mt-1 mb-4 text-[13px] text-fg-3">Picked independently by more than one model. These are the safest promos to post first.</p>
          {agreed.length === 0 ? <p className="text-[13px] text-fg-3">No overlap yet.</p> : (
            <ul className="divide-y hairline border-y hairline">
              {agreed.slice(0, 12).map(({ p, by }, i) => (
                <li key={i} className="py-3 grid grid-cols-[1fr_auto] gap-x-6 gap-y-1">
                  <p className="text-[13px] text-fg-1 truncate">{p.title}</p>
                  <p className="font-mono text-[11px] text-fg-3 tnum text-right">{p.segments.map(s => `ep ${s.episode} ${s.start}`).join(' + ')}</p>
                  <p className="text-[12px] text-fg-3 truncate flex items-center gap-2">
                    <span className="size-1.5 rounded-full shrink-0" style={{ background: HOOKS[p.hook_type]?.color }} />{p.cliffhanger}
                  </p>
                  <p className="text-[12px] text-ok text-right whitespace-nowrap">{by.length} models: {by.map(b => LABEL[b.split('/')[0]] ?? b).join(', ')}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
