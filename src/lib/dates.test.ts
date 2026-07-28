import { describe, expect, it } from 'vitest'
import { dayLabel, monthLabel, shiftMonth, todayISO } from './dates'

describe('dates', () => {
  it('todayISO is local time, YYYY-MM-DD', () => {
    const d = new Date()
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(todayISO()).toBe(expected)
  })

  it('shiftMonth crosses year boundaries in both directions', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-07', -3)).toBe('2026-04')
    expect(shiftMonth('2026-07', 0)).toBe('2026-07')
  })

  it('labels render without timezone drift', () => {
    expect(monthLabel('2026-07')).toBe('July 2026')
    expect(dayLabel('2026-07-01')).toBe('Jul 1') // day 1 must not become Jun 30
    expect(dayLabel('2026-12-31')).toBe('Dec 31')
  })
})
