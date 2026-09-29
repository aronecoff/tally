import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Script-driven motion (S3-motion). CSS owns every other animation; these are
 * the few that must follow a value rather than a class: a figure that settles
 * when it changes, and the month step. Script animations never replay when a
 * hidden pane is shown again (CSS animations do), and they run on the same
 * duration and easing tokens as the CSS, read from :root. Transform and opacity
 * only. Reduce Motion skips them.
 */

export const reducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

type DurToken = '--dur-1' | '--dur-2' | '--dur-3'
const FALLBACK_MS: Record<DurToken, number> = { '--dur-1': 160, '--dur-2': 240, '--dur-3': 380 }
const FALLBACK_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

function tokens() {
  const css = getComputedStyle(document.documentElement)
  const ms = (t: DurToken) => {
    const v = css.getPropertyValue(t).trim()
    const n = parseFloat(v)
    if (!Number.isFinite(n)) return FALLBACK_MS[t]
    return v.endsWith('ms') ? n : v.endsWith('s') ? n * 1000 : n
  }
  return { ms, ease: css.getPropertyValue('--ease-out').trim() || FALLBACK_EASE }
}

/** Play a one-off transform/opacity animation on the shared tokens (--ease-out). */
export function play(el: Element | null | undefined, frames: Keyframe[], dur: DurToken): void {
  if (!el || typeof (el as HTMLElement).animate !== 'function' || reducedMotion()) return
  const t = tokens()
  ;(el as HTMLElement).animate(frames, { duration: t.ms(dur), easing: t.ease })
}

/** A figure arrives: from clear and .12em low to rest. Never counts through values. */
const SETTLE: Keyframe[] = [
  { opacity: 0, transform: 'translateY(0.12em)' },
  { opacity: 1, transform: 'none' },
]

/**
 * Numbers settle: the element `sel` inside `root` settles once each time its
 * key changes. The key is its formatted text (so it plays only when the figure
 * on screen actually changes), or `key` when given. Never on first render (the
 * .enter entrance covers first view) and never on re-show.
 */
export function useSettle(root: RefObject<HTMLElement | null>, sel: string, key?: string): void {
  const last = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = root.current?.querySelector(sel) ?? null
    const k = key ?? el?.textContent ?? null
    const prev = last.current
    last.current = k
    if (prev !== null && k !== null && prev !== k) play(el, SETTLE, '--dur-3')
  })
}
