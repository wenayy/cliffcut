import { motion, useAnimationControls } from 'motion/react'
import { useEffect } from 'react'

/*
 * The mark is a lined script in miniature: two staggered coverage lines (two
 * camera setups) and the red-pencil cut that crosses them. On load the pencil
 * draws the coverage, then strikes the cut; hovering redraws it.
 */
const EASE = [0.22, 1, 0.36, 1] as const

export function Logo({ size = 22, wordmark = true }: { size?: number; wordmark?: boolean }) {
  const c = useAnimationControls()

  const play = async () => {
    c.set('hidden')
    await c.start('drawn')
  }
  useEffect(() => { play() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const line = (delay: number, duration: number) => ({
    hidden: { pathLength: 0, opacity: 0 },
    drawn: { pathLength: 1, opacity: 1, transition: { pathLength: { delay, duration, ease: EASE }, opacity: { delay, duration: 0.01 } } },
  })

  return (
    <span className="inline-flex items-center gap-2 select-none" onMouseEnter={play} aria-label="Cliffcut">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        {/* setup A: on-camera, straight */}
        <motion.path d="M8 3.5V20.5" stroke="var(--color-fg-1)" strokeWidth={1.75} strokeLinecap="round"
          variants={line(0, 0.42)} initial="hidden" animate={c} />
        {/* setup B: starts lower, ends with the lined-script squiggle for off-camera */}
        <motion.path d="M15 6.5V14.5c0 .9 1.3 1.1 1.3 2s-1.3 1.1-1.3 2v1.5" stroke="var(--color-fg-2)" strokeWidth={1.75}
          strokeLinecap="round" strokeLinejoin="round" variants={line(0.14, 0.4)} initial="hidden" animate={c} />
        {/* the cut: a red pencil stroke, slightly rising, like a hand mark */}
        <motion.path d="M3.5 12.6L20.5 10.4" stroke="var(--color-pencil)" strokeWidth={2.1} strokeLinecap="round"
          variants={line(0.46, 0.22)} initial="hidden" animate={c} />
      </svg>
      {wordmark && (
        <motion.span
          className="text-[15px] leading-none font-medium tracking-[-0.01em] text-fg-1"
          initial={{ clipPath: 'inset(0 100% 0 0)', opacity: 0.4 }}
          animate={{ clipPath: 'inset(0 0% 0 0)', opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.5, ease: EASE }}
        >
          Cliffcut
        </motion.span>
      )}
    </span>
  )
}

/* While a model is running, the pencil keeps lining coverage. Only shown during real work. */
export function Working({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-fg-2 text-[13px]">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        <motion.path d="M8 4V20" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round"
          animate={{ pathLength: [0, 1, 1], pathOffset: [0, 0, 1] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }} />
        <motion.path d="M15 4V20" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" opacity={0.6}
          animate={{ pathLength: [0, 1, 1], pathOffset: [0, 0, 1] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: 0.25 }} />
      </svg>
      {label}
    </span>
  )
}
