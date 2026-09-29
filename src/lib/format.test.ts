import { describe, expect, it } from 'vitest'
import { money, moneyParts, pct } from './format'

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

  it('trim drops .00 from exactly whole amounts and never rounds', () => {
    expect(money(2875, { trim: true })).toBe('$2,875')
    expect(money(2875.5, { trim: true })).toBe('$2,875.50')
    expect(money(0, { trim: true })).toBe('$0')
    expect(money(-6375, { trim: true })).toBe('−$6,375')
    expect(money(312.4, { trim: true })).toBe('$312.40')
    expect(money(0.01, { trim: true })).toBe('$0.01')
    expect(money(6375, { trim: true, sign: true })).toBe('+$6,375')
  })

  it('trim leaves non-whole figures identical to the untrimmed format', () => {
    for (const n of [0.5, 1.01, 99.99, 1742.58, 5525.66, -2541.29]) {
      expect(money(n, { trim: true })).toBe(money(n))
    }
  })
})

describe('moneyParts', () => {
  const values = [0, 0.5, 1, 9.99, 10, 42.1, -42.1, 100, 312.4, 999.99, 1000, 1234.5, 2875, 2875.5, 5525.66,
    -2541.29, 6375, 12345.67, 1_000_000, -0.01]

  it('whole + cents is exactly money(n), for 20 values', () => {
    expect(values).toHaveLength(20)
    for (const n of values) {
      const { whole, cents } = moneyParts(n)
      expect(whole + cents).toBe(money(n))
    }
  })

  it('splits at the last dot', () => {
    expect(moneyParts(2875.5)).toEqual({ whole: '$2,875', cents: '.50' })
    expect(moneyParts(-42.1)).toEqual({ whole: '−$42', cents: '.10' })
  })

  it('has no cents part when the format has none', () => {
    expect(moneyParts(2875, { trim: true })).toEqual({ whole: '$2,875', cents: '' })
    expect(moneyParts(275.6, { approx: true })).toEqual({ whole: '$276', cents: '' })
  })
})

describe('pct', () => {
  it('rounds to a whole percent with a true minus', () => {
    expect(pct(-112.6)).toBe('−113%')
    expect(pct(42.4)).toBe('42%')
    expect(pct(0)).toBe('0%')
    expect(pct(-0.4)).toBe('0%')
  })
})
