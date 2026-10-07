/**
 * The reconcile window: which stored bank rows a sync may tombstone because
 * the bank no longer lists them. Only rows the bank could have listed.
 *
 * - B03: rent stored on the 1st it pays for must outlive its posting's exit
 *   from a rolling feed, or it is tombstoned for good about 90 days later.
 * - B19: a pending row with no date (posted 0) must not widen the window to
 *   366 days, nor be stored in 1970.
 * - B22: one account answering with a shorter span than another keeps its
 *   older rows.
 * - B92: a dropped hold on a card that answered with no rows at all is retired.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncedTx } from './bankRules'

const h = vi.hoisted(() => ({ feed: [] as unknown[], accounts: undefined as string[] | undefined, errors: [] as string[] }))

vi.mock('../db/supabase', () => ({
  supabase: {
    functions: {
      invoke: vi.fn(async () => ({
        data: { ok: true, transactions: h.feed, ...(h.accounts ? { accounts: h.accounts } : {}), errors: h.errors },
        error: null,
      })),
    },
  },
}))

import { syncBankTransactions } from './banks'
import { db, type Transaction } from '../db/db'

const DAY = 86400
const CHK = 'Test Bank Checking (1111)'
const AMEX = 'Test Card Co Gold (2222)'
const CHASE = 'Other Bank Rewards Visa (3333)'
const QUIET = 'Other Bank Spare Visa (4444)'
const sec = (isoDay: string) => Date.parse(`${isoDay}T12:00:00Z`) / 1000
const isoOf = (s: number) => new Date(s * 1000).toISOString().slice(0, 10)
const row = (account: string, id: string, posted: number, amount: number, payee: string, p: Partial<SyncedTx> = {}): SyncedTx => ({
  sourceTxId: `bank.test:${account.slice(-5, -1)}:${id}`, account, tier: account === CHK ? 'cash' : 'credit', posted, amount, payee,
  description: payee, memo: '', mcc: null, ...p,
})
const live = async () => (await db.transactions.toArray()).filter((t) => !t.deleted)
const liveOn = async (account: string) => (await live()).filter((t) => t.account === account)

beforeEach(async () => {
  h.feed = []
  h.accounts = undefined
  h.errors = []
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd([
    { id: 1, name: 'Rent', key: 'rent', icon: 'home', color: '#fff', kind: 'expense', monthlyBudget: 2950, sortOrder: 0, updatedAt: 0 },
    { id: 2, name: 'Dining', key: 'dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 1, updatedAt: 0 },
  ])
})
afterEach(() => vi.useRealTimers())

describe('B03: rent dated on the 1st in a rolling 90-day feed', () => {
  it('is never tombstoned once its posting leaves the feed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const RENT_POSTED = sec('2026-09-26')
    const feedOn = (today: number) => {
      const out: SyncedTx[] = []
      for (let d = today - 90 * DAY; d <= today; d += DAY) out.push(row(CHK, `cafe-${isoOf(d)}`, d, -10, 'CORNER CAFE'))
      if (RENT_POSTED >= today - 90 * DAY) out.push(row(CHK, 'rent-sep', RENT_POSTED, -2950, 'LANDLORD LLC'))
      return out
    }
    for (const day of ['2026-10-04', '2026-12-24', '2026-12-26', '2026-12-28', '2027-01-10']) {
      vi.setSystemTime(new Date(`${day}T12:00:00Z`))
      h.feed = feedOn(sec(day))
      await syncBankTransactions()
      const rent = await db.transactions.where('uid').equals('sf:bank.test:1111:rent-sep').first()
      expect(rent, day).toMatchObject({ date: '2026-10-01', deleted: false })
    }
  })
})

describe('B03 widens only rows rent dating could have moved', () => {
  // The feed starts on the 1st (a short first-link feed, or the oldest edge of
  // a rolling one). Rent paid late last month is stored on that 1st; a row of
  // any other kind on the 1st posted that day, inside the feed.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
  })
  const feed = () => [row(CHK, 'cafe-1', sec('2026-10-01'), -10, 'CORNER CAFE'), row(CHK, 'cafe-5', sec('2026-10-05'), -12, 'CORNER CAFE')]
  const stored = (uid: string, p: Partial<Transaction> & Pick<Transaction, 'amount' | 'categoryId'>): Transaction => ({
    uid: `sf:bank.test:1111:${uid}`, date: '2026-10-01', type: 'expense', account: CHK, note: 'X', createdAt: 1, updatedAt: 1, ...p,
  })

  it('a non-rent row on the 1st that the bank no longer lists is reconciled away', async () => {
    await db.transactions.bulkAdd([
      stored('gone-spend', { amount: 25, categoryId: 2 }),
      stored('gone-income', { amount: 2000, type: 'income', categoryId: null }),
    ])
    h.feed = feed()
    await syncBankTransactions()
    expect((await live()).map((t) => t.uid).sort()).toEqual(['sf:bank.test:1111:cafe-1', 'sf:bank.test:1111:cafe-5'])
  })

  it('rent stored on that 1st, paid before the feed starts, stays (by its posted day, or the rent rule)', async () => {
    await db.transactions.bulkAdd([
      stored('rent-a', { amount: 2950, categoryId: 1, posted: '2026-09-26' }),
      stored('rent-b', { amount: 2950, categoryId: 1 }),
    ])
    h.feed = feed()
    await syncBankTransactions()
    expect((await live()).map((t) => t.uid)).toEqual(expect.arrayContaining(['sf:bank.test:1111:rent-a', 'sf:bank.test:1111:rent-b']))
  })

  it('a row whose posted day is inside the feed is reconciled when the bank drops it', async () => {
    await db.transactions.add(stored('rent-c', { amount: 2950, categoryId: 1, posted: '2026-10-02' }))
    h.feed = feed()
    await syncBankTransactions()
    expect(await db.transactions.where('uid').equals('sf:bank.test:1111:rent-c').first()).toMatchObject({ deleted: true })
  })
})

describe('B19: a pending row with no posting date', () => {
  it('leaves older rows alone and is dated today, not 1970', async () => {
    const now = Math.floor(Date.now() / 1000)
    const old = row(CHK, 'old', now - 150 * DAY, -40, 'CORNER CAFE')
    h.feed = [old, ...Array.from({ length: 5 }, (_, i) => row(CHK, `r${i}`, now - (80 - i) * DAY, -10, 'CORNER CAFE'))]
    // The bank answered 150 days once; now it answers 80, plus an undated hold.
    await syncBankTransactions()
    h.feed = [...h.feed.slice(1), row(CHK, 'hold', 0, -16.3, 'CORNER CAFE', { pending: true })]
    await syncBankTransactions()
    expect(await db.transactions.where('uid').equals('sf:bank.test:1111:old').first()).toMatchObject({ deleted: false })
    const hold = await db.transactions.where('uid').equals('sf:bank.test:1111:hold').first()
    expect(hold?.date.startsWith('1970')).toBe(false)
    expect((hold?.date ?? '') >= isoOf(now - DAY)).toBe(true)
  })

  it('a row the bank keeps sending undated is not rewritten (and re-pushed) every day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-04T18:00:00Z'))
    const posted = sec('2026-10-01')
    h.feed = [row(CHK, 'r1', posted, -10, 'CORNER CAFE'), row(CHK, 'hold', 0, -16.3, 'CORNER CAFE', { pending: true })]
    await syncBankTransactions()
    const first = (await db.transactions.where('uid').equals('sf:bank.test:1111:hold').first())!
    for (const day of ['2026-10-05', '2026-10-06']) {
      vi.setSystemTime(new Date(`${day}T18:00:00Z`))
      await syncBankTransactions()
      const hold = (await db.transactions.where('uid').equals('sf:bank.test:1111:hold').first())!
      expect(hold.date, day).toBe(first.date)
      expect(hold.updatedAt, day).toBe(first.updatedAt)
    }
  })

  it('a row stored in 1970 by an earlier version is retired', async () => {
    const now = Math.floor(Date.now() / 1000)
    await db.transactions.add({
      uid: 'sf:bank.test:1111:ghost', date: '1970-01-01', amount: 16.3, type: 'expense', categoryId: null, account: CHK,
      note: 'CORNER CAFE', pending: true, createdAt: 1, updatedAt: 1,
    })
    h.feed = [row(CHK, 'r1', now - 2 * DAY, -10, 'CORNER CAFE')]
    await syncBankTransactions()
    expect(await db.transactions.where('uid').equals('sf:bank.test:1111:ghost').first()).toMatchObject({ deleted: true })
  })
})

describe('B22: accounts answering different spans', () => {
  const span = (account: string, days: number, every: number) => {
    const now = Math.floor(Date.now() / 1000)
    const out: SyncedTx[] = []
    for (let d = days; d >= 1; d -= every) out.push(row(account, `d${d}`, now - d * DAY, -10, 'CORNER CAFE'))
    return out
  }
  it('a shorter answer from one card keeps that card\'s older rows', async () => {
    h.feed = [...span(AMEX, 150, 10), ...span(CHASE, 98, 7)]
    await syncBankTransactions()
    const before = (await liveOn(CHASE)).length
    const since = Math.floor(Date.now() / 1000) - 45 * DAY
    h.feed = [...span(AMEX, 150, 10), ...span(CHASE, 98, 7).filter((t) => t.posted >= since)]
    await syncBankTransactions()
    expect((await liveOn(CHASE)).length).toBe(before)
    h.feed = [...span(AMEX, 150, 10), ...span(CHASE, 98, 7).slice(-1)] // only its newest charge
    await syncBankTransactions()
    expect((await liveOn(CHASE)).length).toBe(before)
  })

  it('a row gone from inside the card\'s own span is still removed', async () => {
    h.feed = [...span(AMEX, 150, 10), ...span(CHASE, 98, 7)]
    await syncBankTransactions()
    const before = (await liveOn(CHASE)).length
    h.feed = [...span(AMEX, 150, 10), ...span(CHASE, 98, 7).filter((t) => !t.sourceTxId.endsWith(':d49'))]
    await syncBankTransactions()
    expect((await liveOn(CHASE)).length).toBe(before - 1)
  })

  it('a dropped hold on a card with little activity is still removed', async () => {
    const now = Math.floor(Date.now() / 1000)
    h.feed = [...span(AMEX, 150, 10), row(CHASE, 'hold', now - 5 * DAY, -80, 'HOTEL', { pending: true }), row(CHASE, 'a', now - 2 * DAY, -10, 'CORNER CAFE')]
    await syncBankTransactions()
    h.feed = [...span(AMEX, 150, 10), row(CHASE, 'a', now - 2 * DAY, -10, 'CORNER CAFE')]
    await syncBankTransactions()
    expect((await liveOn(CHASE)).map((t) => t.amount)).toEqual([10])
  })
})

describe('B92: a card that answered with no rows', () => {
  const now = Math.floor(Date.now() / 1000)
  const hold = row(QUIET, 'hold', now - 3 * DAY, -250, 'GRAND HOTEL', { pending: true })
  const posted = row(QUIET, 'paid', now - 20 * DAY, -30, 'CORNER CAFE')
  const other = row(CHASE, 'a', now - 40 * DAY, -10, 'CORNER CAFE')

  it('retires its dropped hold and keeps its posted rows', async () => {
    h.feed = [other, posted, hold]
    await syncBankTransactions()
    h.feed = [other]
    h.accounts = [CHASE, QUIET]
    await syncBankTransactions()
    expect((await liveOn(QUIET)).map((t) => t.amount)).toEqual([30])
  })

  it('also when no account sent any row', async () => {
    h.feed = [posted, hold]
    await syncBankTransactions()
    h.feed = []
    h.accounts = [QUIET]
    await syncBankTransactions()
    expect((await liveOn(QUIET)).map((t) => t.amount)).toEqual([30])
  })

  it('an older Edge Function (no account list) or a reported error leaves it alone', async () => {
    h.feed = [other, posted, hold]
    await syncBankTransactions()
    h.feed = [other]
    await syncBankTransactions()
    expect(await liveOn(QUIET)).toHaveLength(2)
    h.accounts = [CHASE, QUIET]
    h.errors = ['Connection to Other Bank may need attention']
    await syncBankTransactions()
    expect(await liveOn(QUIET)).toHaveLength(2)
  })
})
