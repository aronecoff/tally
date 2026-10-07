/**
 * Filing bank rows when the category a rule names is gone.
 *
 * - B04: renaming or deleting a category must not send its rows to
 *   Uncategorized at the next bank sync, and new charges follow the rows.
 * - B51: a category the user cleared by hand stays cleared.
 * - B52: a row on a category that is no longer live is filed again.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncedTx } from './bankRules'

const h = vi.hoisted(() => ({ feed: [] as unknown[] }))

vi.mock('../db/supabase', () => ({
  supabase: {
    functions: { invoke: vi.fn(async () => ({ data: { ok: true, transactions: h.feed }, error: null })) },
  },
}))

import { recategorizeUncategorized, syncBankTransactions } from './banks'
import { clearUserRules, setUserRules } from './userRules'
import { db } from '../db/db'

const CARD = 'Test Bank Rewards Visa (5555)'
const DAY = 86400
const NOW = Math.floor(Date.now() / 1000)
const row = (id: string, amount: number, payee: string, ago: number): SyncedTx => ({
  sourceTxId: `bank.test:card:${id}`, account: CARD, tier: 'credit', posted: NOW - ago * DAY, amount, payee, description: payee, memo: '', mcc: null,
})
const catOf = async (id: string) => (await db.transactions.where('uid').equals(`sf:bank.test:card:${id}`).first())?.categoryId

beforeEach(async () => {
  clearUserRules()
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd([
    { id: 1, name: 'Shopping', key: 'shopping', icon: 'bag', color: '#fff', kind: 'expense', monthlyBudget: 200, sortOrder: 0, updatedAt: 0 },
    { id: 2, name: 'Other', key: 'other', icon: 'box', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 1, updatedAt: 0 },
    { id: 3, name: 'Dining', key: 'dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 2, updatedAt: 0 },
    { id: 5, name: 'Coffee', icon: 'cup', color: '#fff', kind: 'expense', monthlyBudget: 50, sortOrder: 3, updatedAt: 0 },
    { id: 6, name: 'Other income', key: 'other income', icon: 'plus', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 4, updatedAt: 0 },
  ])
})
afterEach(() => clearUserRules())

describe('B04: the category a rule names is gone', () => {
  it('deleted Shopping: its rows stay in Other, and a new charge follows them', async () => {
    h.feed = [row('a1', -20, 'AMAZON MKTP', 5), row('a2', -35, 'AMAZON MKTP', 4), row('a3', 12, 'AMAZON MKTP REFUND', 3)]
    await syncBankTransactions()
    expect(await catOf('a1')).toBe(1)
    // What deleting Shopping does (Categories.tsx): rows to Other, then the tombstone.
    await db.transactions.where('categoryId').equals(1).modify({ categoryId: 2, updatedAt: Date.now() })
    await db.categories.update(1, { deleted: true, updatedAt: Date.now() })
    h.feed = [...h.feed, row('a4', -9, 'AMAZON MKTP', 1)]
    await syncBankTransactions()
    expect([await catOf('a1'), await catOf('a2'), await catOf('a3'), await catOf('a4')]).toEqual([2, 2, 2, 2])
  })

  it('a renamed category of the user\'s own: rows stay, new charges follow', async () => {
    setUserRules([{ pattern: 'zorblatt', flags: 'i', category: 'Coffee', kind: 'expense', priority: 5 }])
    h.feed = [row('z1', -4, 'ZORBLATT ROASTERS', 5)]
    await syncBankTransactions()
    expect(await catOf('z1')).toBe(5)
    await db.categories.update(5, { name: 'Cafe', updatedAt: Date.now() })
    h.feed = [...h.feed, row('z2', -6, 'ZORBLATT ROASTERS', 1)]
    await syncBankTransactions()
    expect([await catOf('z1'), await catOf('z2')]).toEqual([5, 5])
  })

  it('a row that turns into income never keeps a spending category', async () => {
    setUserRules([{ pattern: 'zorblatt', flags: 'i', category: 'Coffee', kind: 'expense', priority: 5 }])
    h.feed = [row('z1', -4, 'ZORBLATT ROASTERS', 5)]
    await syncBankTransactions()
    await db.categories.update(5, { name: 'Cafe', updatedAt: Date.now() })
    // The same id now reads as money in on a checking account (income).
    h.feed = [{ ...row('z1', 400, 'ZORBLATT ROASTERS PAYROLL', 5), account: 'Test Bank Checking (1111)', tier: 'cash' }]
    await syncBankTransactions()
    const t = await db.transactions.where('uid').equals('sf:bank.test:card:z1').first()
    expect(t?.type).toBe('income')
    expect(t?.categoryId === 5).toBe(false)
  })
})

describe('B51: a category cleared by hand', () => {
  it('is not filed again by the self-heal', async () => {
    await db.transactions.add({
      uid: 'sf:x1', date: '2026-09-10', amount: 7, type: 'expense', categoryId: null, account: CARD, note: 'STARBUCKS RESERVE',
      manual: true, uncategorized: true, createdAt: 1, updatedAt: 1,
    })
    expect(await recategorizeUncategorized()).toBe(0)
    expect((await db.transactions.where('uid').equals('sf:x1').first())?.categoryId).toBeNull()
  })

  it('a pinned row left empty for another reason still is', async () => {
    await db.transactions.add({
      uid: 'sf:x2', date: '2026-09-10', amount: 7, type: 'expense', categoryId: null, account: CARD, note: 'STARBUCKS RESERVE',
      manual: true, createdAt: 1, updatedAt: 1,
    })
    expect(await recategorizeUncategorized()).toBe(1)
    expect((await db.transactions.where('uid').equals('sf:x2').first())?.categoryId).toBe(3)
  })
})

describe('B52: a row on a category that is no longer live', () => {
  it('is filed again by the self-heal', async () => {
    await db.categories.add({ id: 9, name: 'Fun', icon: 'x', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 9, deleted: true, updatedAt: 0 })
    await db.transactions.add({
      uid: 'sf:x3', date: '2026-09-10', amount: 7, type: 'expense', categoryId: 9, account: CARD, note: 'STARBUCKS RESERVE',
      manual: true, createdAt: 1, updatedAt: 1,
    })
    expect(await recategorizeUncategorized()).toBe(1)
    expect((await db.transactions.where('uid').equals('sf:x3').first())?.categoryId).toBe(3)
  })
})
