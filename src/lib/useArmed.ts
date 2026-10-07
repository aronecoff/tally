import { useCallback, useEffect, useRef, useState } from 'react'

/** A confirming tap within this window of arming is treated as a double-tap and ignored. */
export const DOUBLE_TAP_MS = 350

type TimerRef = { current: ReturnType<typeof setTimeout> | null }
function clearTimer(t: TimerRef) {
  if (t.current != null) clearTimeout(t.current)
  t.current = null
}

/**
 * In-place two-tap confirm, the replacement for window.confirm (a silent no-op
 * in the iOS WKWebView wrapper, which made every Delete do nothing).
 *
 *   const { armed, arm, disarm } = useArmed()
 *   <button onClick={() => { if (arm()) remove() }}>{armed ? 'Tap again to delete' : 'Delete'}</button>
 *
 * arm() returns false on the first tap (it arms) and true on a confirming tap.
 * A second tap that lands within 350ms of arming is a double-tap, not a
 * confirmation, so it is ignored. Timing uses performance.now() so a wall-clock
 * change can never confirm early. The armed state clears itself after `ms`, on
 * disarm(), and on unmount.
 */
export function useArmed(ms = 3000) {
  const [armed, setArmed] = useState(false)
  const armedRef = useRef(false)
  const armedAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const disarm = useCallback(() => {
    clearTimer(timer)
    armedRef.current = false
    setArmed(false)
  }, [])

  const arm = useCallback((): boolean => {
    const now = performance.now()
    if (armedRef.current) {
      if (now - armedAt.current < DOUBLE_TAP_MS) return false
      disarm()
      return true
    }
    armedRef.current = true
    armedAt.current = now
    setArmed(true)
    clearTimer(timer)
    timer.current = setTimeout(disarm, ms)
    return false
  }, [ms, disarm])

  useEffect(() => () => clearTimer(timer), [])

  return { armed, arm, disarm }
}
