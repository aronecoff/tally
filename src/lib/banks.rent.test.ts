/**
 * Rent paid in the last week of a month lands on the 1st of the month it pays
 * for, so no month shows two rents and the next none. Only rent moves; a
 * re-sync writes nothing; a date the user set by hand stays theirs.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncedTx } from './bankRules'

const h = vi.hoisted(() => ({ feed: [] as unknown[] }))

vi.mock('../db/supabase', () => ({
  supabase: {
    functions: {
      invoke: vi.fn(async () => ({ data: { ok: true, transactions: h.feed }, error: null })),
    },
  },
}))

import { syncBankTransactions } from './banks'
import { db } from '../db/db'

const CHECKING = 'Test Bank Checking (3333)'
const at = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), 12) / 1000

const tx = (id: string, day: string, amount: number, payee: string): SyncedTx => ({
  sourceTxId: id, account: CHECKING, tier: 'cash', posted: at(day), amount, description: payee, payee, memo: '', mcc: null,
})

const FEED: SyncedTx[] = [
  tx('rent-oct', '2026-09-28', -2400, 'ACME PROPERTY MGMT'),
  tx('rent-jan', '2025-12-29', -2400, 'ACME PROPERTY MGMT'),
  tx('rent-late', '2026-08-03', -2400, 'ACME PROPERTY MGMT'),
  tx('groceries', '2026-09-28', -42.1, 'SAFEWAY #1234'),
]

const dateOf = async (uid: string) => (await db.transactions.toArray()).find((t) => t.uid === uid)?.date

beforeEach(async () => {
  h.feed = FEED
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd([
    { id: 1, name: 'Rent', icon: 'home', color: '#fff', kind: 'expense', monthlyBudget: 2400, sortOrder: 0, updatedAt: 0 },
    { id: 2, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 400, sortOrder: 1, updatedAt: 0 },
  ])
})

describe('rent paid early', () => {
  it('lands on the 1st of the month it pays for; nothing else moves', async () => {
    await syncBankTransactions()
    expect(await dateOf('sf:rent-oct')).toBe('2026-10-01')
    expect(await dateOf('sf:rent-jan')).toBe('2026-01-01')
    expect(await dateOf('sf:rent-late')).toBe('2026-08-03') // paid late, already in its month
    expect(await dateOf('sf:groceries')).toBe('2026-09-28')
  })

  it('a re-sync writes nothing', async () => {
    await syncBankTransactions()
    const first = await db.transactions.toArray()
    expect(await syncBankTransactions()).toBe(0)
    expect(await db.transactions.toArray()).toEqual(first)
  })

  it('a date set by hand stays', async () => {
    await syncBankTransactions()
    const row = (await db.transactions.toArray()).find((t) => t.uid === 'sf:rent-oct')!
    await db.transactions.update(row.id!, { date: '2026-09-28', manual: true, updatedAt: 5 })
    await syncBankTransactions()
    expect(await dateOf('sf:rent-oct')).toBe('2026-09-28')
  })
})
