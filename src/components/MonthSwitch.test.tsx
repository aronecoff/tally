// @vitest-environment jsdom
/**
 * B102: keyboard focus must not drop to <body> when Next month reaches the
 * current month (the button used to disable itself under the focus) or when
 * 'This month' is pressed (the button unmounts under the focus).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { MonthSwitch } from './MonthSwitch'

function Host({ initial }: { initial: string }) {
  const [month, setMonth] = useState(initial)
  return <MonthSwitch month={month} setMonth={setMonth} />
}

const label = () => document.querySelector('.ms-label') as HTMLElement

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-04T12:00:00'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('MonthSwitch focus', () => {
  it('Next month that reaches this month keeps focus, and then does nothing', () => {
    render(<Host initial="2026-09" />)
    const next = screen.getByRole('button', { name: 'Next month' })
    expect(next.getAttribute('aria-disabled')).toBe('false')
    next.focus()
    fireEvent.click(next)
    expect(label().textContent).toBe('October')
    // Still focusable (a disabled button drops focus to <body>), and says it is unavailable.
    expect(next.hasAttribute('disabled')).toBe(false)
    expect(next.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(next)
    fireEvent.click(next)
    expect(label().textContent).toBe('October')
  })

  it("'This month' hands keyboard focus to the month label before it goes away", () => {
    render(<Host initial="2026-08" />)
    const back = screen.getByRole('button', { name: 'This month' })
    back.focus()
    fireEvent.click(back)
    expect(label().textContent).toBe('October')
    expect(screen.queryByRole('button', { name: 'This month' })).toBeNull()
    expect(document.activeElement).toBe(label())
  })

  it("a tap on 'This month' that did not focus it leaves focus alone", () => {
    render(<Host initial="2026-08" />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.click(screen.getByRole('button', { name: 'This month' }))
    expect(label().textContent).toBe('October')
    expect(document.activeElement).not.toBe(label())
  })

  it('Previous month still steps back', () => {
    render(<Host initial="2026-10" />)
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(label().textContent).toBe('September')
  })
})
