// @vitest-environment jsdom
/**
 * The public project runs with the module swaps on, as a public build does: each
 * import below is the path shared code uses, and each answer is the public one.
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { supabase } from '../../db/supabase'
import { banksEnabled } from '../../lib/banks'
import { rentDate } from '../../lib/bankRules'
import { brand } from '../../lib/brand'
import { brokerageEnabled, syncBrokerages } from '../../lib/brokerage'
import { merchantInfo } from '../../lib/merchants'
import { planCanSave } from '../../lib/planStore'
import xcconfig from '../../../ios/PublicApp.xcconfig?raw'

afterEach(() => localStorage.clear())

describe('the swapped modules', () => {
  it('has no cloud and no brokerage, and banks stay on for the native bridge', async () => {
    expect(supabase).toBeNull()
    expect(banksEnabled).toBe(true)
    expect(brokerageEnabled).toBe(false)
    await expect(syncBrokerages()).resolves.toBe(0)
  })

  it('keeps the savings plan on the device, with no account to ask', async () => {
    await expect(planCanSave()).resolves.toBe(true)
  })

  it('takes its name from the one place it is written, and asks no one to sign in', () => {
    const name = xcconfig.match(/^PUBLIC_APP_NAME = (.+)$/m)?.[1]
    expect(name).toBeTruthy()
    expect(brand.mark).toBe(` ${name}`)
    expect(brand.tell).toBe(`Tell ${name}`)
    expect(brand.noTellRule('zentrix')).toBe(`There is no Tell ${name} rule for "zentrix".`)
    expect(brand.bankFoot).toBe(`Read-only. ${name} never sees your bank login.`)
    expect(brand.sourceNoun()).toBe('your bank')
    for (const copy of Object.values(brand)) {
      expect(typeof copy === 'function' ? copy('', '', '') : copy).not.toMatch(/\bTally\b|sign in/i)
    }
  })

  it('links nowhere from a transaction, and still cleans the name', () => {
    const m = merchantInfo('AMZN Mktp US*2A3BC5X')
    expect(m.name).toBe('Amazon')
    expect(m).toMatchObject({ logoUrl: null, orderUrl: null, orderLabel: null, searchUrl: null })
    expect(merchantInfo('ZZQX 9921').searchUrl).toBeNull()
  })

  it('leaves rent on the day it was paid, until the setting is on', () => {
    expect(rentDate('2031-02-25')).toBe('2031-02-25')
    localStorage.setItem('plainsum:rentDating', '1')
    expect(rentDate('2031-02-25')).toBe('2031-03-01')
    expect(rentDate('2031-02-10')).toBe('2031-02-10')
  })
})
