/**
 * Pending transfers in the reconcile. Rows the old rules imported while a
 * transfer was pending (income on one account, spending on the other) are
 * reconciled away, and new ones never land. A pinned row that posts drops its
 * Pending label but keeps everything the user set.
 *
 * The clock is pinned, so the rows never sit on a 1st: a row stored on a 1st
 * may have posted in the month before (rent paid early, banks.earliestPosted),
 * and on the feed's first day it is not reconciled. With the real clock this
 * file failed whenever five days ago was a 1st.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { db, type Transaction } from '../db/db'

const CHK = 'Test Bank Checking (1111)'
const MM = 'Test Bank Money Market (4444)'
const CARD = 'Test Bank Rewards Visa (5555)'
const DAY = 86400
/** Now: mid-month, so T0 (five days back) is mid-month too. */
const NOW = Date.UTC(2026, 2, 15, 12)
const T0 = Math.floor(NOW / 1000) - 5 * DAY
const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)

const row = (id: string, account: string, amount: number, payee: string, p: Partial<SyncedTx> = {}): SyncedTx => ({
  sourceTxId: `bank.test:${account}:${id}`, account, tier: account === CARD ? 'credit' : 'cash', posted: T0,
  amount, payee, description: payee, memo: '', mcc: null, ...p,
})

const PENDING: SyncedTx[] = [
  row('out', MM, -2000, 'Debit', { pending: true }),
  row('in', CHK, 2000, 'Credit', { pending: true }),
  row('buy', CARD, -60, 'CORNER CAFE'),
]
const POSTED: SyncedTx[] = [
  row('out', MM, -2000, 'To Checking', { description: 'TO CHECKING XXXXXX1111' }),
  row('in', CHK, 2000, 'From Checking', { description: 'FROM CHECKING XXXXXX4444' }),
  row('buy', CARD, -60, 'CORNER CAFE'),
]

const live = async () => (await db.transactions.toArray()).filter((t) => !t.deleted)
const total = async (type: Transaction['type']) =>
  (await live()).filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd([
    { id: 1, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 0, updatedAt: 0 },
    { id: 2, name: 'Other income', icon: 'plus', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
  ])
})

afterEach(() => vi.useRealTimers())

describe('pending transfers in the reconcile', () => {
  it('a pending transfer never lands on either side', async () => {
    h.feed = PENDING
    await syncBankTransactions()
    expect((await live()).map((t) => t.uid)).toEqual([`sf:bank.test:${CARD}:buy`])
    expect(await total('income')).toBe(0)
    expect(await total('expense')).toBe(60)
  })

  it('what the old rules imported while pending is reconciled away', async () => {
    const base = { categoryId: null, note: '', pending: true, createdAt: 0, updatedAt: 0, date: iso(T0) }
    await db.transactions.bulkAdd([
      { ...base, uid: `sf:bank.test:${MM}:out`, account: MM, amount: 2000, type: 'expense' },
      { ...base, uid: `sf:bank.test:${CHK}:in`, account: CHK, amount: 2000, type: 'income', categoryId: 2 },
    ])
    for (const feed of [PENDING, POSTED]) {
      h.feed = feed
      await syncBankTransactions()
      expect(await total('income')).toBe(0)
      expect(await total('expense')).toBe(60)
    }
  })

  it('a pinned row that posts drops its Pending label and keeps the user edits', async () => {
    h.feed = [row('buy', CARD, -60, 'CORNER CAFE', { pending: true })]
    await syncBankTransactions()
    const buy = (await live())[0]
    await db.transactions.update(buy.id!, { categoryId: 1, date: '2026-01-15', manual: true, updatedAt: 5 })
    h.feed = POSTED
    await syncBankTransactions()
    expect(await db.transactions.get(buy.id!)).toMatchObject({ pending: false, categoryId: 1, date: '2026-01-15', manual: true })
  })
})
