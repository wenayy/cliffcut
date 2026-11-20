import type { Run, RunPromo } from '../lib'
import { HOOKS } from '../lib'

/* Kuku's brief asks two things of every run: "Rank them: which would you post first, and why?"
   and "Check quality: where does your tool pick badly?" This page answers both from the run itself. */

const WEIGHT: Record<string, number> = { hook: 0.30, cliffhanger: 0.25, standalone: 0.20, emotion: 0.15, clarity: 0.10 }
const NAME: Record<string, string> = { hook: 'hook', cliffhanger: 'cliffhanger', standalone: 'makes sense alone', emotion: 'emotion', clarity: 'clarity' }

export function rankReason(p: RunPromo, foundBy?: number): string {
  const base = Object.entries(WEIGHT).reduce((a, [k, w]) => a + w * (p.scores?.[k] ?? 5), 0)
  const top = Object.entries(p.scores ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${NAME[k] ?? k} ${v}`)
  const bits = [`combined score ${base.toFixed(1)}/10 (strongest: ${top.join(', ')})`]
  const j = p.ai_checks
  if (j) {
    const lost = [!j.cliffhanger_open && 'answers its own cliffhanger (−2)', j.spoiler && 'possible spoiler (−3)', j.cold_viewer.understandable === false && 'hard for a stranger to follow (−1.5)'].filter(Boolean)
    bits.push(lost.length ? `lost points: ${lost.join(', ')}` : 'passed the stranger, cliffhanger and spoiler checks')
  } else bits.push('not checked by the judge models (only the top finalists are)')
  if (foundBy && foundBy > 1) bits.push(`also picked by ${foundBy - 1} other model${foundBy > 2 ? 's' : ''}`)
  if (p.source_episode && p.source_episode <= 3) bits.push(`early in the show (episode ${p.source_episode}), close to where a new viewer starts`)
  return bits.join('; ') + '.'
}

type Bucket = { title: string; why: string; items: { label: string; detail: string }[] }

export function QualityReport({ run, foundBy, onOpen }: { run: Run | null; foundBy?: Record<number, number>; onOpen: (rank: number) => void }) {
  if (!run) return <p className="p-8 text-[13px] text-fg-3">Run the show first. This page then shows what to post first and why, and where the tool picked badly.</p>

  const s = run.stats
  const judged = run.promos.filter(p => p.ai_checks)
  const label = (p: RunPromo) => `${p.title || 'Untitled'} (ep ${p.segments.map(x => x.episode).filter((v, i, a) => a.indexOf(v) === i).join(', ')})`
  const failed = (p: RunPromo, name: string) => p.checks.filter(c => c.name === name && !c.ok).map(c => c.detail)[0]

  const buckets: Bucket[] = [
    { title: 'Answered its own cliffhanger', why: 'The judge model saw what comes right after the cut and found the question is already answered inside the promo. These are pushed down the ranking.',
      items: judged.filter(p => !p.ai_checks!.cliffhanger_open).map(p => ({ label: label(p), detail: p.ai_checks!.cliffhanger_reason })) },
    { title: 'Possible spoiler', why: 'Gives away a twist from much later in the show.',
      items: judged.filter(p => p.ai_checks!.spoiler).map(p => ({ label: label(p), detail: p.ai_checks!.spoiler_reason })) },
    { title: 'A stranger could not follow it', why: 'A fresh model with no context could not tell who to root for.',
      items: judged.filter(p => p.ai_checks!.cold_viewer.understandable === false).map(p => ({ label: label(p), detail: p.ai_checks!.cold_viewer.stakes ?? '' })) },
    { title: 'Wrong length (rejected)', why: 'The model is poor at timing. These failed even after one repair round.',
      items: run.rejected.filter(p => failed(p, 'length')).map(p => ({ label: label(p), detail: failed(p, 'length')! })) },
    { title: 'No time to hold the reaction (rejected)', why: 'The model ended on a line that is immediately followed by more talk, so the face never lands.',
      items: run.rejected.filter(p => failed(p, 'ends_on_reaction')).map(p => ({ label: label(p), detail: failed(p, 'ends_on_reaction')! })) },
    { title: "Teasers that showed the episode's ending", why: 'Models like the strongest moment, which is often the ending a teaser must not show.',
      items: run.teasers.filter(t => failed(t, 'no_ending')).map(t => ({ label: `Teaser for episode ${t.for_episode}`, detail: failed(t, 'no_ending')! })) },
  ]

  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–')

  return (
    <div className="px-8 py-8 space-y-10 max-w-[900px]">
      <header>
        <h1 className="text-[20px] leading-7 font-medium text-fg-1">Ranking and quality</h1>
        <p className="mt-1.5 text-[13px] leading-5 text-fg-3 max-w-[70ch]">The two questions Kuku's brief asks of every run: which promos to post first and why, and where the tool picks badly. Run: {run.provider} {run.model}, {run.episodes.length} episodes.</p>
      </header>

      {/* 1. what to post first, and why */}
      <section className="space-y-4">
        <h2 className="text-[16px] font-medium text-fg-1">Post these first, and why</h2>
        <p className="text-[13px] leading-5 text-fg-3 max-w-[75ch]">
          How the rank is decided:
        </p>
        <ol className="list-decimal pl-5 space-y-1 text-[13px] leading-5 text-fg-3 max-w-[75ch]">
          <li>The model scores each promo 1–10, combined as hook 30%, cliffhanger 25%, makes sense alone 20%, emotion 15%, clarity 10%.</li>
          <li>Independent judge models take points off for answering its own cliffhanger, spoilers, or being hard to follow.</li>
          <li>Earlier episodes win ties.</li>
          <li>The top 10 is spread across hook types, so you test different angles.</li>
        </ol>
        <ol className="space-y-3">
          {run.promos.slice(0, 5).map(p => (
            <li key={p.rank} className="grid grid-cols-[28px_1fr] gap-x-2">
              <span className="font-mono text-[14px] text-fg-1 tnum">#{p.rank}</span>
              <div>
                <button onClick={() => onOpen(p.rank!)} className="text-left text-[14px] text-fg-1 hover:underline underline-offset-2">{p.title}</button>
                <span className="ml-2 text-[12px] text-fg-3"><span className="inline-block size-1.5 rounded-full mr-1 align-middle" style={{ background: HOOKS[p.hook_type]?.color }} />{HOOKS[p.hook_type]?.label} · ep {p.segments[0]?.episode} · {p.length.toFixed(0)} s</span>
                <p className="mt-0.5 text-[13px] leading-5 text-fg-2">{p.hook} → {p.cliffhanger}</p>
                <p className="mt-0.5 text-[12px] leading-[18px] text-fg-3">Why #{p.rank}: {rankReason(p, foundBy?.[p.rank!])}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* 2. the numbers */}
      <section className="space-y-3">
        <h2 className="text-[16px] font-medium text-fg-1">Quality in numbers</h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
          {[
            ['Suggested by the model', `${s.candidates}`, 'up to 3 per episode'],
            ['Passed the code checks', pct(s.passed_code_checks, s.candidates), `${s.passed_code_checks} of ${s.candidates}`],
            ['Needed a repair round', `${s.repaired}`, 'sent back once with the reason'],
            ['Cliffhanger still open', pct(judged.filter(p => p.ai_checks!.cliffhanger_open).length, judged.length), `of ${judged.length} judged finalists`],
            ['No spoiler', pct(judged.filter(p => !p.ai_checks!.spoiler).length, judged.length), `of ${judged.length} judged finalists`],
            ['Teasers passed', pct(run.teasers.filter(t => t.code_ok).length, run.teasers.length), `${run.teasers.filter(t => t.code_ok).length} of ${run.teasers.length}`],
          ].map(([k, v, sub]) => (
            <div key={k} className="rounded-[12px] border hairline bg-ink-2 px-4 py-3">
              <p className="text-[12px] text-fg-3">{k}</p>
              <p className="mt-1 font-mono text-[22px] leading-7 text-fg-1 tnum">{v}</p>
              <p className="text-[11px] text-fg-3">{sub}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 3. where it picks badly */}
      <section className="space-y-5">
        <h2 className="text-[16px] font-medium text-fg-1">Where it picks badly</h2>
        {buckets.map(b => (
          <div key={b.title}>
            <p className="text-[14px] text-fg-1">{b.title} <span className="font-mono text-[12px] text-fg-3">{b.items.length}</span></p>
            <p className="text-[12px] leading-[18px] text-fg-3">{b.why}</p>
            {b.items.length === 0 ? <p className="mt-1 text-[12px] text-ok">None in this run.</p> : (
              <ul className="mt-2 space-y-1.5">
                {b.items.slice(0, 4).map((x, i) => (
                  <li key={i} className="text-[12px] leading-[18px]"><span className="text-fg-2">{x.label}:</span> <span className="text-fg-3">{x.detail}</span></li>
                ))}
                {b.items.length > 4 && <li className="text-[12px] text-fg-3">and {b.items.length - 4} more</li>}
              </ul>
            )}
          </div>
        ))}
        <div>
          <p className="text-[14px] text-fg-1">Blind spots no check can catch</p>
          <ul className="mt-1 list-disc pl-5 space-y-1 text-[12px] leading-[18px] text-fg-3">
            <li>It reads scripts, not footage: a line can read flat and play strong. Watch the top picks before posting.</li>
            <li>"Makes sense to a stranger" is judged by a model, which knows more than a real stranger.</li>
            <li>Scores are judgment, not performance. Real proof is click-through and installs, which should feed back into the ranking.</li>
            <li>Hook types are the AI's guess; the editor can correct them.</li>
          </ul>
        </div>
      </section>
    </div>
  )
}
