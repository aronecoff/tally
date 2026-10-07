import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ago, dayHeading, dayLabel, monthLabel, monthShortLabel, shiftDayISO, shiftMonth, todayISO } from './dates'

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

  it('shiftDayISO crosses month, year and leap-day boundaries', () => {
    expect(shiftDayISO('2026-09-01', -1)).toBe('2026-08-31')
    expect(shiftDayISO('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDayISO('2028-02-28', 1)).toBe('2028-02-29')
    expect(shiftDayISO('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDayISO('2026-09-22', 0)).toBe('2026-09-22')
  })
})

describe('dates relative to a fixed today (2026-09-22 12:00 local)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 22, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('monthShortLabel: full name this year, short name plus year otherwise', () => {
    expect(monthShortLabel('2026-09')).toBe('September')
    expect(monthShortLabel('2026-01')).toBe('January')
    expect(monthShortLabel('2025-09')).toBe('Sep 2025')
    expect(monthShortLabel('2027-01')).toBe('Jan 2027')
  })

  it('dayHeading: Today, Yesterday, then weekday + date (year only when it differs)', () => {
    expect(dayHeading('2026-09-22')).toBe('Today')
    expect(dayHeading('2026-09-21')).toBe('Yesterday')
    expect(dayHeading('2026-09-18')).toBe('Fri, Sep 18')
    expect(dayHeading('2026-09-01')).toBe('Tue, Sep 1')
    expect(dayHeading('2025-09-18')).toBe('Thu, Sep 18, 2025')
    // Read against a given day (a list left open past midnight passes the new one).
    expect(dayHeading('2026-09-22', '2026-09-23')).toBe('Yesterday')
    expect(dayHeading('2026-09-21', '2026-09-23')).toBe('Mon, Sep 21')
    expect(dayHeading('2026-12-31', '2027-01-01')).toBe('Yesterday')
    expect(dayHeading('2026-12-30', '2027-01-01')).toBe('Wed, Dec 30, 2026')
  })

  it('ago: just now, minutes, hours, days', () => {
    const now = Date.now()
    expect(ago(now)).toBe('just now')
    expect(ago(now - 59_000)).toBe('just now')
    expect(ago(now - 5 * 60_000)).toBe('5m ago')
    expect(ago(now - 3 * 3_600_000)).toBe('3h ago')
    expect(ago(now - 2 * 86_400_000)).toBe('2d ago')
    expect(ago(now + 10_000)).toBe('just now') // clock skew never reads negative
  })
})
