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
