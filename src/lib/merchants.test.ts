import { describe, expect, it } from 'vitest'
import { cleanMerchant, merchantInfo } from './merchants'

describe('cleanMerchant', () => {
  it('strips processor prefixes and register numbers', () => {
    expect(cleanMerchant('SQ *BLUE BOTTLE #4')).toBe('Blue Bottle')
    expect(cleanMerchant('TST* SOUVLA - HAYES')).toBe('Souvla - Hayes')
    expect(cleanMerchant('SAFEWAY #1471')).toBe('Safeway')
  })

  it('strips reference codes', () => {
    expect(cleanMerchant('AMZN Mktp US*2A3BC5X')).toBe('AMZN Mktp US')
  })

  it('title-cases SHOUTING CAPS without breaking possessives', () => {
    expect(cleanMerchant("TRADER JOE'S #189")).toBe("Trader Joe's")
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
