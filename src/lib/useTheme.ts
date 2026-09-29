import { useCallback, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { reducedMotion } from './motion'

export type Theme = 'light' | 'dark'
export type ThemePref = 'system' | Theme

const KEY = 'tally-theme'
const LIGHT_QUERY = '(prefers-color-scheme: light)'

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'system' || v === 'light' || v === 'dark') return v
  } catch {
    /* storage blocked: fall through to the default */
  }
  return 'system'
}

function systemTheme(): Theme {
  try {
    if (typeof window.matchMedia === 'function') return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark'
  } catch {
    /* no matchMedia: dark */
  }
  return 'dark'
}

/**
 * Theme preference: 'system' (default, follows the OS live), 'light' or 'dark'.
 * The inline boot script in index.html applies the same resolution before first
 * paint; this hook keeps data-theme, the browser theme-color (read from the
 * computed --bg, so it can never drift from the canvas) and the native iOS
 * wrapper in step afterwards.
 */
export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(readPref)
  const [system, setSystem] = useState<Theme>(systemTheme)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(LIGHT_QUERY)
    const onChange = () => setSystem(mq.matches ? 'light' : 'dark')
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  const resolved: Theme = pref === 'system' ? system : pref

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', resolved)
    // Browser chrome (Safari toolbar, PWA title bar) follows the canvas.
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim()
    if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg)
    // Native iOS wrapper: tell it the theme so the status bar, launch canvas
    // and offline screen match. No-op in a browser.
    ;(window as unknown as { webkit?: { messageHandlers?: { theme?: { postMessage(v: string): void } } } })
      .webkit?.messageHandlers?.theme?.postMessage(resolved)
  }, [resolved])

  const setPref = useCallback((p: ThemePref) => {
    try {
      localStorage.setItem(KEY, p)
    } catch {
      /* storage blocked: the choice lasts for this session */
    }
    const root = document.documentElement
    const next: Theme = p === 'system' ? systemTheme() : p
    if (root.getAttribute('data-theme') === next) {
      setPrefState(p)
      return
    }
    // A theme change is one dissolve of the whole page (a root view transition,
    // timed in base.css), not a ripple of per-element fades: the new theme is
    // committed synchronously inside the transition and the colour transitions
    // it starts are finished at once. Reduce Motion, or an engine without view
    // transitions, swaps instantly.
    const commit = () => {
      flushSync(() => setPrefState(p))
      root.setAttribute('data-theme', next)
      if (typeof CSSTransition === 'undefined' || typeof document.getAnimations !== 'function') return
      void getComputedStyle(root).color // resolve the new theme's styles now
      for (const a of document.getAnimations()) {
        if (a instanceof CSSTransition && !/^(transform|opacity)$/.test(a.transitionProperty)) a.finish()
      }
    }
    const doc = document as Document & { startViewTransition?: (update: () => void) => unknown }
    if (typeof doc.startViewTransition === 'function' && !reducedMotion()) doc.startViewTransition(commit)
    else commit()
  }, [])

  return { pref, resolved, setPref }
}
