import type { KeyboardEvent } from 'react'

/**
 * Makes a non-button element (a list row, a map tile) behave like a button for
 * keyboard and VoiceOver users: role, tab stop, click, and Enter/Space.
 *
 *   <li className="txn-row" {...pressable(() => onEdit(t))}>…</li>
 *
 * Keys pressed on a nested control (an inner button or input) are left alone.
 */
export function pressable(onActivate: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: () => onActivate(),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onActivate()
      }
    },
  }
}

/**
 * Arrow keys for a one-choice control with roving focus: a segmented control
 * marked up as a radio group, or a filter marked up as a tab list. Left/Up and
 * Right/Down move to the previous or next option and choose it, as a native
 * radio group does. Pair it with roving focus (tabIndex 0 on the chosen
 * option, -1 on the others) so Tab stops once on the group.
 *
 *   <div className="seg" role="radiogroup" aria-label="Type" onKeyDown={rovingKeys}>
 */
export function rovingKeys(e: KeyboardEvent<HTMLElement>) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!step) return
  const options = [...e.currentTarget.querySelectorAll<HTMLElement>(':is([role="radio"], [role="tab"]):not(:disabled)')]
  const i = options.indexOf(e.target as HTMLElement)
  if (i === -1) return
  e.preventDefault()
  const next = options[(i + step + options.length) % options.length]
  next.focus()
  next.click()
}
