import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

function initialTheme(): Theme {
  const saved = localStorage.getItem('tally-theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** Adaptive light/dark: follows the OS on first run, then remembers the toggle. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('tally-theme', theme)
    // Browser chrome (Safari toolbar, PWA title bar) follows the canvas.
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0C0414' : '#F4EFE4')
    // Native iOS wrapper: tell it the theme so the status bar, launch canvas
    // and offline screen match. No-op in a browser.
    ;(window as unknown as { webkit?: { messageHandlers?: { theme?: { postMessage(v: string): void } } } })
      .webkit?.messageHandlers?.theme?.postMessage(theme)
  }, [theme])

  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }
}
