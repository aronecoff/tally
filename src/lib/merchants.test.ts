import { describe, expect, it } from 'vitest'
import { accountLabel, cleanMerchant, merchantInfo, splitMask } from './merchants'

describe('splitMask', () => {
  it('splits a trailing (dddd) mask off', () => {
    expect(splitMask('Citizens Bank Checking Account (4821)')).toEqual({
      base: 'Citizens Bank Checking Account',
      last4: '4821',
    })
  })

  it('leaves strings without a mask alone', () => {
    expect(splitMask('Amex')).toEqual({ base: 'Amex', last4: null })
    expect(splitMask('')).toEqual({ base: '', last4: null })
    expect(splitMask('Schwab 401(k)')).toEqual({ base: 'Schwab 401(k)', last4: null })
  })
})

// Account strings in the shape the bank feed sends them (the masks are made
// up). DISPLAY ONLY: the stored string is never rewritten.
describe('accountLabel', () => {
  const cases: [string, string, string | null][] = [
    ['Citizens Bank Money Market Account (4837)', 'Citizens Money Market', '4837'],
    ['Chase Bank Chase Freedom Unlimited (7418)', 'Chase Freedom Unlimited', '7418'],
    ['Citizens Bank Checking Account (4821)', 'Citizens Checking', '4821'],
    ['American Express American Express Green Card (6152)', 'Amex Green', '6152'],
    ['Chase Bank United Explorer Rewards Visa Signature (7264)', 'Chase United Explorer', '7264'],
    ['American Express Personal Savings High Yield Account (2395)', 'Amex Personal Savings', '2395'],
    ['Amex', 'Amex', null],
    ['', '', null],
  ]

  for (const [raw, label, mask] of cases) {
    it(`${JSON.stringify(raw)} → ${JSON.stringify(label)}`, () => {
      expect(accountLabel(raw)).toEqual({ label, mask })
    })
  }

  it('maps Charles Schwab to Schwab', () => {
    expect(accountLabel('Charles Schwab Brokerage').label).toBe('Schwab Brokerage')
  })

  it('never returns an empty label for a non-empty string', () => {
    expect(accountLabel('Bank Account').label).toBe('Bank Account')
  })
})

describe('cleanMerchant', () => {
  it('strips processor prefixes and register numbers', () => {
    expect(cleanMerchant('SQ *BLUE BOTTLE #4')).toBe('Blue Bottle')
    expect(cleanMerchant('TST* CORNER CAFE - MAIN')).toBe('Corner Cafe - Main')
    expect(cleanMerchant('SAFEWAY #1234')).toBe('Safeway')
  })

  it('strips reference codes', () => {
    expect(cleanMerchant('AMZN Mktp US*2A3BC5X')).toBe('AMZN Mktp US')
  })

  it('title-cases SHOUTING CAPS without breaking possessives', () => {
    expect(cleanMerchant("TRADER JOE'S #123")).toBe("Trader Joe's")
  })

  it('leaves mixed-case names alone', () => {
    expect(cleanMerchant('Netflix')).toBe('Netflix')
    expect(cleanMerchant('DoorDash')).toBe('DoorDash')
  })

  it('same merchant, different registers → identical keys (grouping)', () => {
    const a = cleanMerchant('SQ *BLUE BOTTLE #4').toLowerCase()
    const b = cleanMerchant('SQ *BLUE BOTTLE #9').toLowerCase()
    expect(a).toBe(b)
  })
})

describe('merchantInfo', () => {
  it('recognizes Amazon from a marketplace descriptor', () => {
    const m = merchantInfo('AMZN Mktp US*2A3BC5X')
    expect(m.name).toBe('Amazon')
    expect(m.logoUrl).toContain('amazon.com')
    expect(m.orderUrl).toContain('amazon.com')
    expect(m.orderLabel).toMatch(/Amazon orders/)
  })

  it('unrecognized merchants fall back to a search link, no logo', () => {
    const m = merchantInfo('ZZQX 9921')
    expect(m.logoUrl).toBeNull()
    expect(m.orderUrl).toBeNull()
    expect(m.searchUrl).toContain(encodeURIComponent('"ZZQX 9921" charge'))
  })

  it('empty descriptor yields no links at all', () => {
    const m = merchantInfo('')
    expect(m.name).toBe('')
    expect(m.searchUrl).toBeNull()
  })
})
