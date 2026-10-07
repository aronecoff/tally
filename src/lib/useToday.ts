import { useSyncExternalStore } from 'react'
import { todayISO } from './dates'

/**
 * Today's local date (YYYY-MM-DD), kept current while the app stays open. The
 * screens read the clock while rendering and are memoised, so left open
 * overnight they kept showing yesterday (and last month) until a tab change.
 * Any component that calls this re-renders when the date changes: checked on
 * resume (visibilitychange, focus, pageshow) and once a minute, which also
 * covers a sleep or a time-zone change a midnight timer would miss.
 */

const listeners = new Set<() => void>()
let interval: number | undefined

const check = () => listeners.forEach((f) => f())

function subscribe(f: () => void): () => void {
  listeners.add(f)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('pageshow', check)
    interval = window.setInterval(check, 60_000)
  }
  return () => {
    listeners.delete(f)
    if (listeners.size > 0) return
    document.removeEventListener('visibilitychange', check)
    window.removeEventListener('focus', check)
    window.removeEventListener('pageshow', check)
    window.clearInterval(interval)
  }
}

export function useToday(): string {
  return useSyncExternalStore(subscribe, todayISO, todayISO)
}
