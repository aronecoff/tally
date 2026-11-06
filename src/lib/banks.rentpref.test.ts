// @vitest-environment jsdom
/**
 * The rent rule as a setting. On, which is how this app has always run, nothing
 * is different. Off, bank rent stays on the bank's day, and a re-sync puts rows
 * the rule moved back there. A date set by hand stays. Values are invented.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncedTx } from './bankRules'

const h = vi.hoisted(() => ({ feed: [] as unknown[] }))

vi.mock('../db/supabase', () => ({
  supabase: { functions: { invoke: vi.fn(async () => ({ data: { ok: true, transactions: h.feed }, error: null })) } },
}))

import { db } from '../db/db'
import { rentDate, rentRedate, rentRefile } from './bankRules'
import { syncBankTransactions } from './banks'
import { rentDatingOn, setRentDating } from './prefs'

const at = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), 12) / 1000
const tx = (id: string, day: string): SyncedTx => ({
  sourceTxId: id, account: 'Test Bank Checking (3333)', tier: 'cash', posted: at(day), amount: -2400, description: 'ACME PROPERTY MGMT', payee: 'ACME PROPERTY MGMT', memo: '', mcc: null,
})
const rowOf = async (uid: string) => (await db.transactions.toArray()).find((t) => t.uid === uid)

beforeEach(async () => {
  localStorage.clear()
  h.feed = [tx('rent-oct', '2026-09-28')]
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.add({ id: 1, name: 'Rent', icon: 'home', color: '#fff', kind: 'expense', monthlyBudget: 2400, sortOrder: 0, updatedAt: 0 })
})

describe('the setting', () => {
  it('starts on, and stays where it is put', () => {
    expect(rentDatingOn()).toBe(true)
    setRentDating(false)
    expect(rentDatingOn()).toBe(false)
    setRentDating(true)
    expect(rentDatingOn()).toBe(true)
  })

  it('stays on when storage cannot be read', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(rentDatingOn()).toBe(true)
    get.mockRestore()
  })
})

describe('with the rule on', () => {
  it('dates rent to the 1st it pays for, as it always has', async () => {
    await syncBankTransactions()
    expect((await rowOf('sf:rent-oct'))?.date).toBe('2026-10-01')
  })
})

describe('with the rule off', () => {
  beforeEach(() => setRentDating(false))

  it('leaves a date as it is', () => {
    expect(rentDate('2026-09-28')).toBe('2026-09-28')
    expect(rentDate('2026-12-30')).toBe('2026-12-30')
  })

  it('keeps bank rent on the bank day', async () => {
    await syncBankTransactions()
    expect((await rowOf('sf:rent-oct'))?.date).toBe('2026-09-28')
  })

  it('a re-sync puts a row the rule moved back on the bank day', async () => {
    setRentDating(true)
    await syncBankTransactions()
    expect((await rowOf('sf:rent-oct'))?.date).toBe('2026-10-01')
    setRentDating(false)
    await syncBankTransactions()
    expect((await rowOf('sf:rent-oct'))?.date).toBe('2026-09-28')
  })

  it('a date set by hand stays through it', async () => {
    await syncBankTransactions()
    const row = await rowOf('sf:rent-oct')
    await db.transactions.update(row!.id!, { date: '2026-09-15', manual: true })
    await syncBankTransactions()
    expect((await rowOf('sf:rent-oct'))?.date).toBe('2026-09-15')
  })

  it('a re-file into Rent moves nothing', () => {
    const t = { uid: 'sf:x', date: '2026-09-28', type: 'expense', amount: 2400 }
    expect(rentRefile(t, false, true)).toBeNull()
  })

  it('a row the rule moved before it went off still goes home when filed out of Rent', () => {
    const t = { uid: 'sf:x', date: '2026-10-01', type: 'expense', amount: 2400, posted: '2026-09-28' }
    expect(rentRedate(t, true, false)).toBe('2026-09-28')
  })
})
