import { describe, expect, it } from 'vitest'
import { money } from './format'

describe('money', () => {
  it('formats exact amounts with cents and thousands separators', () => {
    expect(money(1234.5)).toBe('$1,234.50')
    expect(money(0)).toBe('$0.00')
  })

  it('uses a true minus sign for negatives', () => {
    expect(money(-42.1)).toBe('−$42.10')
  })

  it('forces a leading sign when asked', () => {
    expect(money(10, { sign: true })).toBe('+$10.00')
    expect(money(-10, { sign: true })).toBe('−$10.00')
  })

  it('approx mode drops cents — estimates must not fake precision', () => {
    expect(money(275, { approx: true })).toBe('$275')
    expect(money(275.6, { approx: true })).toBe('$276')
    expect(money(1234.5, { approx: true })).toBe('$1,235')
  })
})
