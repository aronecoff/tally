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

import { recategorizeUncategorized, syncBankTransactions } from './banks'
import { db } from '../db/db'

const CHECKING = 'Test Bank Checking (3333)'
const at = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), 12) / 1000

const CARD = 'Test Bank Rewards Visa (1111)'
const tx = (id: string, day: string, amount: number, payee: string, account = CHECKING): SyncedTx => ({
  sourceTxId: id, account, tier: account === CARD ? 'credit' : 'cash', posted: at(day), amount, description: payee, payee, memo: '', mcc: null,
})

const FEED: SyncedTx[] = [
  tx('rent-oct', '2026-09-28', -2400, 'ACME PROPERTY MGMT'),
  tx('rent-jan', '2025-12-29', -2400, 'ACME PROPERTY MGMT'),
  tx('rent-late', '2026-08-03', -2400, 'ACME PROPERTY MGMT'),
  tx('groceries', '2026-09-28', -42.1, 'SAFEWAY #1234'),
]

const dateOf = async (uid: string) => (await db.transactions.toArray()).find((t) => t.uid === uid)?.date
const rowOf = async (uid: string) => (await db.transactions.toArray()).find((t) => t.uid === uid)
/** A category's net spend in a month, in cents, from the stored rows. */
const monthSpend = async (catId: number, month: string) =>
  (await db.transactions.toArray())
    .filter((t) => !t.deleted && t.type === 'expense' && t.categoryId === catId && t.date.startsWith(month))
    .reduce((s, t) => s + Math.round(t.amount * 100), 0)

beforeEach(async () => {
  h.feed = FEED
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd([
    { id: 1, name: 'Rent', icon: 'home', color: '#fff', kind: 'expense', monthlyBudget: 2400, sortOrder: 0, updatedAt: 0 },
    { id: 2, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 400, sortOrder: 1, updatedAt: 0 },
    { id: 3, name: 'Transport', icon: 'car', color: '#fff', kind: 'expense', monthlyBudget: 200, sortOrder: 2, updatedAt: 0 },
    { id: 4, name: 'Salary', icon: 'briefcase', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 3, updatedAt: 0 },
    { id: 5, name: 'Other income', icon: 'plus', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 4, updatedAt: 0 },
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

describe('rent paid on a fixed day', () => {
  it('the 24th of a 31-day month counts in the next month, like the 24th of a 30-day one', async () => {
    h.feed = [tx('aug24', '2026-08-24', -2400, 'ACME PROPERTY MGMT'), tx('sep24', '2026-09-24', -2400, 'ACME PROPERTY MGMT')]
    await syncBankTransactions()
    expect(await dateOf('sf:aug24')).toBe('2026-09-01')
    expect(await dateOf('sf:sep24')).toBe('2026-10-01')
  })
})

describe('only rent is re-dated', () => {
  it('a car rental late in the month stays on its day, under Transport; real rent still moves', async () => {
    h.feed = [tx('car', '2026-09-27', -312.4, 'ENTERPRISE RENT-A-CAR', CARD), tx('rent', '2026-09-27', -2400, 'ACME PROPERTY MGMT')]
    await syncBankTransactions()
    expect(await rowOf('sf:car')).toMatchObject({ date: '2026-09-27', categoryId: 3 })
    expect(await rowOf('sf:rent')).toMatchObject({ date: '2026-10-01', categoryId: 1 })
  })
})

describe('rent refunds', () => {
  it('a card rent refunded before the 1st nets to nothing in both months', async () => {
    h.feed = [tx('pay', '2026-09-26', -2400, 'ACME PROPERTY MGMT', CARD), tx('back', '2026-09-28', 2400, 'ACME PROPERTY MGMT', CARD)]
    await syncBankTransactions()
    expect(await rowOf('sf:back')).toMatchObject({ date: '2026-10-01', amount: -2400, categoryId: 1 })
    expect(await monthSpend(1, '2026-09')).toBe(0)
    expect(await monthSpend(1, '2026-10')).toBe(0)
  })

  it('a refund of rent paid on time stays in its month', async () => {
    h.feed = [tx('pay', '2026-09-15', -2400, 'ACME PROPERTY MGMT', CARD), tx('back', '2026-09-25', 2400, 'ACME PROPERTY MGMT', CARD)]
    await syncBankTransactions()
    expect(await dateOf('sf:back')).toBe('2026-09-25')
    expect(await monthSpend(1, '2026-09')).toBe(0)
  })

  it("the landlord's credit to checking offsets the rent it returns, not income", async () => {
    h.feed = [
      tx('sep', '2026-09-01', -2400, 'ACME PROPERTY MGMT'),
      tx('dup', '2026-09-26', -2400, 'ACME PROPERTY MGMT'),
      tx('back', '2026-09-29', 2400, 'ACME PROPERTY MGMT'),
      tx('pay', '2026-09-29', 4000, 'ACME PAYROLL'),
    ]
    await syncBankTransactions()
    expect(await rowOf('sf:back')).toMatchObject({ type: 'expense', amount: -2400, categoryId: 1, date: '2026-10-01' })
    expect(await rowOf('sf:pay')).toMatchObject({ type: 'income', amount: 4000, categoryId: 4 })
    expect(await monthSpend(1, '2026-09')).toBe(240000)
    expect(await monthSpend(1, '2026-10')).toBe(0)
    const income = (await db.transactions.toArray()).filter((t) => !t.deleted && t.type === 'income')
    expect(income.map((t) => t.uid)).toEqual(['sf:pay'])
    expect(await syncBankTransactions()).toBe(0)
  })
})

describe('rent filed by hand', () => {
  it('recategorize files a pinned, uncategorized rent on the 1st it pays for', async () => {
    await db.transactions.add({
      uid: 'sf:zelle', date: '2026-09-27', amount: 2400, type: 'expense', categoryId: null, account: CHECKING,
      note: 'ACME PROPERTY MGMT', manual: true, createdAt: 0, updatedAt: 0,
    })
    expect(await recategorizeUncategorized()).toBe(1)
    expect(await rowOf('sf:zelle')).toMatchObject({ categoryId: 1, date: '2026-10-01', posted: '2026-09-27' })
  })
})

describe("the bank's posted day beside a rent date", () => {
  it('is kept on the rows rent moved, and only on those', async () => {
    await syncBankTransactions()
    expect(await rowOf('sf:rent-oct')).toMatchObject({ date: '2026-10-01', posted: '2026-09-28' })
    expect((await rowOf('sf:rent-late'))?.posted).toBeUndefined()
    expect((await rowOf('sf:groceries'))?.posted).toBeUndefined()
  })

  it('reaches rows stored before it existed, and rows filed into Rent on another device, without a push', async () => {
    await db.transactions.bulkAdd([
      // Stored by an earlier version: dated the 1st, no posted day.
      { uid: 'sf:rent-oct', date: '2026-10-01', amount: 2400, type: 'expense', categoryId: 1, account: CHECKING, note: 'ACME PROPERTY MGMT', createdAt: 0, updatedAt: 7 },
      // Pulled from the cloud: filed into Rent by hand elsewhere.
      { uid: 'sf:groceries', date: '2026-10-01', amount: 42.1, type: 'expense', categoryId: 1, account: CHECKING, note: 'SAFEWAY #1234', manual: true, createdAt: 0, updatedAt: 7 },
    ])
    await syncBankTransactions()
    expect(await rowOf('sf:rent-oct')).toMatchObject({ posted: '2026-09-28', updatedAt: 7 })
    expect(await rowOf('sf:groceries')).toMatchObject({ date: '2026-10-01', posted: '2026-09-28', updatedAt: 7 })
  })

  it('a bank row moved out of Rent by hand gets its posted day back, and a re-sync leaves it there', async () => {
    await syncBankTransactions()
    const row = (await rowOf('sf:rent-oct'))!
    // The sheet and Tell Tally both re-date through bankRules.rentRefile.
    const { rentRefile } = await import('./bankRules')
    const move = rentRefile(row, true, false)
    expect(move).toEqual({ date: '2026-09-28' })
    await db.transactions.update(row.id!, { categoryId: 3, ...move, manual: true, updatedAt: 9 })
    await syncBankTransactions()
    expect(await rowOf('sf:rent-oct')).toMatchObject({ categoryId: 3, date: '2026-09-28', updatedAt: 9 })
  })
})

describe('a renamed Rent', () => {
  it('keeps filing and dating rent', async () => {
    await db.categories.update(1, { name: 'Housing', key: 'rent' })
    h.feed = [tx('rent', '2026-09-28', -2400, 'ACME PROPERTY MGMT')]
    await syncBankTransactions()
    expect(await rowOf('sf:rent')).toMatchObject({ categoryId: 1, date: '2026-10-01' })
  })
})

