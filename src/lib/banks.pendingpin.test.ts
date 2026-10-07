/**
 * B02: a pending charge the user pinned (filed, moved or hid it by hand) and
 * the bank then posts under a NEW id. The pinned pending row used to stay live
 * beside the posted one (counted twice), a hidden one came back, a released
 * hold was counted for good, and a same-id post kept the pending amount.
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

import { recategorizeUncategorized, syncBankTransactions } from './banks'
import { db, type Transaction } from '../db/db'

const CARD = 'Test Bank Rewards Visa (5555)'
const DAY = 86400
const NOW = Math.floor(Date.now() / 1000)
const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)

const row = (id: string, amount: number, payee: string, posted: number, p: Partial<SyncedTx> = {}): SyncedTx => ({
  sourceTxId: `bank.test:card:${id}`, account: CARD, tier: 'credit', posted, amount, payee, description: payee, memo: '', mcc: null, ...p,
})
// Another charge on the card, so the account is seen in every feed.
const COFFEE = row('coffee', -5, 'CORNER CAFE', NOW - 9 * DAY)

const live = async () => (await db.transactions.toArray()).filter((t) => !t.deleted)
const spend = async () => Math.round((await live()).filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0) * 100) / 100
const byUid = (uid: string) => db.transactions.where('uid').equals(`sf:bank.test:card:${uid}`).first()

async function pin(id: string, edit: Partial<Transaction>) {
  const t = (await byUid(id))!
  await db.transactions.update(t.id!, { ...edit, manual: true, updatedAt: Date.now() })
}

beforeEach(async () => {
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd([
    { id: 1, name: 'Shopping', icon: 'bag', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
    { id: 2, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 1, updatedAt: 0 },
    { id: 3, name: 'Gifts', icon: 'gift', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 2, updatedAt: 0 },
  ])
})

async function pendingThenPost(edit: Partial<Transaction>, post: SyncedTx | null, holdAmount = -133) {
  h.feed = [COFFEE, row('hold', holdAmount, 'PLONK MARKET', NOW - 3 * DAY, { pending: true })]
  await syncBankTransactions()
  await pin('hold', edit)
  // Later than the hold was imported.
  await new Promise((r) => setTimeout(r, 5))
  h.feed = post ? [COFFEE, post] : [COFFEE]
  await syncBankTransactions()
}

describe('a pinned pending charge that posts under a new id', () => {
  it('filed by hand: counted once, and the posted row keeps the category', async () => {
    await pendingThenPost({ categoryId: 3 }, row('post', -133, 'PLONK MARKET #12', NOW - 1 * DAY))
    expect(await spend()).toBe(138)
    expect(await byUid('post')).toMatchObject({ categoryId: 3, manual: true, deleted: false })
    expect(await byUid('hold')).toMatchObject({ deleted: true })
  })

  it('hidden by hand: the posted row stays hidden', async () => {
    await pendingThenPost({ deleted: true }, row('post', -133, 'PLONK MARKET #12', NOW - 1 * DAY))
    expect(await spend()).toBe(5)
    expect(await byUid('post')).toMatchObject({ deleted: true, manual: true })
  })

  it('moved weeks away: the posted row keeps the move', async () => {
    await pendingThenPost({ date: iso(NOW - 28 * DAY) }, row('post', -133, 'PLONK MARKET #12', NOW - 1 * DAY))
    expect(await spend()).toBe(138)
    expect(await byUid('post')).toMatchObject({ date: iso(NOW - 28 * DAY), manual: true })
  })

  it('a gas pre-authorisation that settles far lower is not counted twice', async () => {
    await pendingThenPost({ categoryId: 3 }, row('post', -45, 'FUEL STOP', NOW - 1 * DAY), -100)
    expect(await spend()).toBe(50)
  })

  it('a released hold is no longer counted', async () => {
    await pendingThenPost({ categoryId: 3 }, null)
    expect(await spend()).toBe(5)
  })

  it('an earlier, separate charge of the same amount is not taken for the posted one', async () => {
    const twin = row('twin', -133, 'PLONK MARKET', NOW - 6 * DAY)
    h.feed = [COFFEE, twin]
    await syncBankTransactions()
    await new Promise((r) => setTimeout(r, 5))
    h.feed = [COFFEE, twin, row('hold', -133, 'PLONK MARKET', NOW - 3 * DAY, { pending: true })]
    await syncBankTransactions()
    await pin('hold', { deleted: true })
    h.feed = [COFFEE, twin]
    await syncBankTransactions()
    expect(await byUid('twin')).toMatchObject({ deleted: false })
    expect(await spend()).toBe(138)
  })

  it('a pinned pending charge the bank still lists is left as the user set it', async () => {
    h.feed = [COFFEE, row('hold', -133, 'PLONK MARKET', NOW - 3 * DAY, { pending: true })]
    await syncBankTransactions()
    await pin('hold', { categoryId: 3 })
    await syncBankTransactions()
    expect(await byUid('hold')).toMatchObject({ categoryId: 3, pending: true, deleted: false })
  })
})

describe('every edit on a pinned pending charge moves to the row it posts as', () => {
  it('a note typed on the hold', async () => {
    await pendingThenPost({ note: 'Birthday gift for Sam' }, row('post', -133, 'PLONK MARKET #12', NOW - 1 * DAY))
    expect(await byUid('post')).toMatchObject({ note: 'Birthday gift for Sam', manual: true, deleted: false })
    expect(await spend()).toBe(138)
  })

  it("the bank's own words are not carried: the posted row keeps its own description", async () => {
    await pendingThenPost({ categoryId: 3 }, row('post', -133, 'PLONK MARKET #12', NOW - 1 * DAY))
    expect(await byUid('post')).toMatchObject({ note: 'PLONK MARKET #12', categoryId: 3 })
  })

  it('a category cleared on purpose stays cleared, through the self-heal', async () => {
    await pendingThenPost({ categoryId: null, uncategorized: true }, row('post', -133, 'PLONK MARKET #12', NOW - 1 * DAY))
    expect(await byUid('post')).toMatchObject({ categoryId: null, uncategorized: true, manual: true })
    await recategorizeUncategorized()
    expect(await byUid('post')).toMatchObject({ categoryId: null, uncategorized: true })
  })

  it('a move of a day or two across a month end, made while it was pending', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const at = (ymd: string) => Math.floor(Date.parse(`${ymd}T18:00:00Z`) / 1000)
      const coffee = row('coffee', -5, 'CORNER CAFE', at('2026-09-20'))
      vi.setSystemTime(new Date('2026-09-29T20:00:00Z'))
      h.feed = [coffee, row('hold', -80, 'PLONK MARKET', at('2026-09-29'), { pending: true })]
      await syncBankTransactions()
      await pin('hold', { date: '2026-10-01' })
      // Still pending a day later: the bank's own day is kept beside the moved one.
      vi.setSystemTime(new Date('2026-09-30T20:00:00Z'))
      await syncBankTransactions()
      expect(await byUid('hold')).toMatchObject({ date: '2026-10-01', posted: '2026-09-29' })
      vi.setSystemTime(new Date('2026-10-02T20:00:00Z'))
      h.feed = [coffee, row('post', -80, 'PLONK MARKET', at('2026-09-30'))]
      await syncBankTransactions()
      expect(await byUid('post')).toMatchObject({ date: '2026-10-01', posted: '2026-09-30', manual: true, deleted: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a hold the user never moved posts on the bank\'s day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const at = (ymd: string) => Math.floor(Date.parse(`${ymd}T18:00:00Z`) / 1000)
      const coffee = row('coffee', -5, 'CORNER CAFE', at('2026-09-20'))
      vi.setSystemTime(new Date('2026-09-29T20:00:00Z'))
      h.feed = [coffee, row('hold', -80, 'PLONK MARKET', at('2026-09-29'), { pending: true })]
      await syncBankTransactions()
      await pin('hold', { categoryId: 3 })
      vi.setSystemTime(new Date('2026-09-30T20:00:00Z'))
      await syncBankTransactions()
      vi.setSystemTime(new Date('2026-10-02T20:00:00Z'))
      h.feed = [coffee, row('post', -80, 'PLONK MARKET', at('2026-10-01'))]
      await syncBankTransactions()
      expect(await byUid('post')).toMatchObject({ date: '2026-10-01', categoryId: 3 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a pinned hold the bank re-dates while it is still pending', () => {
  // A hold's date is the bank's until it posts: SimpleFIN can move a pending
  // row a day as it settles. Only a date the user (or a re-file into Rent) set
  // is theirs. Taking every re-date for a move pinned the posted row to the
  // stale hold day, and the charge could jump a month.
  const at = (ymd: string) => Math.floor(Date.parse(`${ymd}T18:00:00Z`) / 1000)
  const coffee = row('coffee', -5, 'CORNER CAFE', at('2026-09-20'))
  const hold = (ymd: string, amount = -80) => row('hold', amount, 'PLONK MARKET', at(ymd), { pending: true })
  /** One sync of `feed` (beside the coffee), the clock at 8pm UTC on `ymd`. */
  async function syncOn(ymd: string, ...feed: SyncedTx[]) {
    vi.setSystemTime(new Date(`${ymd}T20:00:00Z`))
    h.feed = [coffee, ...feed]
    await syncBankTransactions()
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("filed only: the hold follows the bank, and the posted row keeps the bank's posting day and the category", async () => {
    await syncOn('2026-09-29', hold('2026-09-29'))
    await pin('hold', { categoryId: 3 })
    await syncOn('2026-09-30', hold('2026-09-30'))
    expect(await byUid('hold')).toMatchObject({ date: '2026-09-30', posted: '2026-09-30', categoryId: 3, pending: true })
    await syncOn('2026-10-02', row('post', -80, 'PLONK MARKET', at('2026-10-01')))
    const posted = (await byUid('post'))!
    expect(posted).toMatchObject({ date: '2026-10-01', categoryId: 3, manual: true, deleted: false })
    expect(posted.posted ?? posted.date).toBe('2026-10-01')
    expect(await byUid('hold')).toMatchObject({ deleted: true, retired: true })
    expect(await spend()).toBe(85)
  })

  it('moved by hand onto the day the bank later gives it: the move stays, through more re-dates and the post', async () => {
    await syncOn('2026-09-29', hold('2026-09-29'))
    // As the sheet saves a date (Transaction.dateMoved).
    await pin('hold', { date: '2026-09-30', dateMoved: true })
    await syncOn('2026-09-30', hold('2026-09-30'))
    await syncOn('2026-10-01', hold('2026-10-01'))
    expect(await byUid('hold')).toMatchObject({ date: '2026-09-30', posted: '2026-10-01', pending: true })
    await syncOn('2026-10-03', row('post', -80, 'PLONK MARKET', at('2026-10-02')))
    expect(await byUid('post')).toMatchObject({ date: '2026-09-30', posted: '2026-10-02', manual: true, deleted: false })
  })

  it('moved by hand, then re-issued under a new id while still pending: the move stays marked', async () => {
    const hold2 = (ymd: string) => row('hold2', -80, 'PLONK MARKET', at(ymd), { pending: true })
    await syncOn('2026-09-29', hold('2026-09-29'))
    await pin('hold', { date: '2026-09-30', dateMoved: true })
    await syncOn('2026-09-30', hold2('2026-09-29'))
    expect(await byUid('hold2')).toMatchObject({ date: '2026-09-30', dateMoved: true, manual: true, pending: true })
    await syncOn('2026-10-01', hold2('2026-09-30'))
    await syncOn('2026-10-02', hold2('2026-10-01'))
    expect(await byUid('hold2')).toMatchObject({ date: '2026-09-30', posted: '2026-10-01', pending: true })
  })

  it('hidden by hand: still hidden, on the bank\'s day', async () => {
    await syncOn('2026-09-29', hold('2026-09-29'))
    await pin('hold', { deleted: true })
    await syncOn('2026-09-30', hold('2026-09-30'))
    await syncOn('2026-10-02', row('post', -80, 'PLONK MARKET', at('2026-10-01')))
    expect(await byUid('post')).toMatchObject({ date: '2026-10-01', deleted: true, manual: true })
    expect(await spend()).toBe(5)
  })

  it("filed only, then posted under the same id: on the bank's posting day, with the category", async () => {
    await syncOn('2026-09-29', hold('2026-09-29'))
    await pin('hold', { categoryId: 3 })
    await syncOn('2026-10-02', row('hold', -82.5, 'PLONK MARKET', at('2026-10-01')))
    expect(await byUid('hold')).toMatchObject({ date: '2026-10-01', amount: 82.5, pending: false, categoryId: 3, manual: true })
    // ...and a re-sync leaves it there.
    await syncOn('2026-10-03', row('hold', -82.5, 'PLONK MARKET', at('2026-10-01')))
    expect(await byUid('hold')).toMatchObject({ date: '2026-10-01', pending: false })
  })

  it('moved by hand, then posted under the same id: the move stays', async () => {
    await syncOn('2026-09-29', hold('2026-09-29'))
    await pin('hold', { date: '2026-09-25', dateMoved: true })
    await syncOn('2026-10-02', row('hold', -80, 'PLONK MARKET', at('2026-10-01')))
    expect(await byUid('hold')).toMatchObject({ date: '2026-09-25', pending: false, manual: true })
  })

  // Stored by an earlier version, which kept no bank's day (Transaction.posted)
  // beside a pending row: whether it was moved is read from the day it was
  // imported, as the posting carry always read such a row (a gap of over 3 days).
  const legacy = async () => {
    const t = (await byUid('hold'))!
    await db.transactions.update(t.id!, { posted: undefined, bankNote: undefined })
  }

  it('stored by an earlier version, filed only, re-dated since: it follows the bank, and posts on its day', async () => {
    await syncOn('2026-09-29', hold('2026-09-29'))
    await pin('hold', { categoryId: 3 })
    await legacy()
    await syncOn('2026-09-30', hold('2026-09-30'))
    expect(await byUid('hold')).toMatchObject({ date: '2026-09-30', posted: '2026-09-30', categoryId: 3 })
    await syncOn('2026-10-02', row('post', -80, 'PLONK MARKET', at('2026-10-01')))
    expect(await byUid('post')).toMatchObject({ date: '2026-10-01', categoryId: 3, manual: true })
  })

  it('stored by an earlier version, moved weeks away: the move stays', async () => {
    await syncOn('2026-09-29', hold('2026-09-29'))
    await pin('hold', { date: '2026-09-12' })
    await legacy()
    await syncOn('2026-09-30', hold('2026-09-30'))
    expect(await byUid('hold')).toMatchObject({ date: '2026-09-12', posted: '2026-09-30' })
    await syncOn('2026-10-02', row('post', -80, 'PLONK MARKET', at('2026-10-01')))
    expect(await byUid('post')).toMatchObject({ date: '2026-09-12', manual: true })
  })

  it('filed into Rent before the 20th, then re-dated past it: counts on the 1st it pays for', async () => {
    await db.categories.add({ id: 4, name: 'Rent', icon: 'home', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 3, updatedAt: 0 })
    await syncOn('2026-09-18', hold('2026-09-18', -640))
    // Before the 20th a re-file into Rent leaves the date (bankRules.rentRefile).
    await pin('hold', { categoryId: 4 })
    await syncOn('2026-09-21', hold('2026-09-21', -640))
    expect(await byUid('hold')).toMatchObject({ date: '2026-10-01', posted: '2026-09-21', categoryId: 4 })
    await syncOn('2026-09-23', row('post', -640, 'PLONK MARKET', at('2026-09-22')))
    expect(await byUid('post')).toMatchObject({ date: '2026-10-01', posted: '2026-09-22', categoryId: 4, manual: true })
  })
})

describe('a pinned pending charge that posts under the same id', () => {
  it('takes the final amount and keeps the category', async () => {
    h.feed = [COFFEE, row('hold', -21.37, 'PLONK MARKET', NOW - 3 * DAY, { pending: true })]
    await syncBankTransactions()
    await pin('hold', { categoryId: 3 })
    h.feed = [COFFEE, row('hold', -23.9, 'PLONK MARKET', NOW - 2 * DAY)]
    await syncBankTransactions()
    expect(await byUid('hold')).toMatchObject({ amount: 23.9, pending: false, categoryId: 3, manual: true })
  })
})

describe("a pending row posted under the same id: the bank's words", () => {
  // A card's pending row often reads 'Debit'; the posted row names the merchant.
  it("the stand-in gives way to the merchant's words", async () => {
    h.feed = [COFFEE, row('t1', -58.4, 'Debit', NOW - 2 * DAY, { pending: true })]
    await syncBankTransactions()
    h.feed = [COFFEE, row('t1', -58.4, 'BRAMBLE GROCER #44', NOW - 1 * DAY)]
    await syncBankTransactions()
    expect(await byUid('t1')).toMatchObject({ note: 'BRAMBLE GROCER #44', pending: false, deleted: false })
    expect(await spend()).toBe(63.4)
  })

  it('filed by hand with the note untouched: the note still follows, the category stays', async () => {
    h.feed = [COFFEE, row('t1', -58.4, 'Debit', NOW - 2 * DAY, { pending: true })]
    await syncBankTransactions()
    await pin('t1', { categoryId: 3 })
    h.feed = [COFFEE, row('t1', -58.4, 'BRAMBLE GROCER #44', NOW - 1 * DAY)]
    await syncBankTransactions()
    expect(await byUid('t1')).toMatchObject({ note: 'BRAMBLE GROCER #44', categoryId: 3, manual: true, pending: false })
  })

  it('a note the user typed stays', async () => {
    h.feed = [COFFEE, row('t1', -58.4, 'Debit', NOW - 2 * DAY, { pending: true })]
    await syncBankTransactions()
    await pin('t1', { note: 'Housewarming flowers' })
    h.feed = [COFFEE, row('t1', -58.4, 'BRAMBLE GROCER #44', NOW - 1 * DAY)]
    await syncBankTransactions()
    expect(await byUid('t1')).toMatchObject({ note: 'Housewarming flowers', manual: true, pending: false })
  })

  it('a re-sync writes nothing more', async () => {
    h.feed = [COFFEE, row('t1', -58.4, 'Debit', NOW - 2 * DAY, { pending: true })]
    await syncBankTransactions()
    h.feed = [COFFEE, row('t1', -58.4, 'BRAMBLE GROCER #44', NOW - 1 * DAY)]
    await syncBankTransactions()
    const before = (await byUid('t1'))!
    await new Promise((r) => setTimeout(r, 5))
    await syncBankTransactions()
    expect((await byUid('t1'))!.updatedAt).toBe(before.updatedAt)
  })
})

describe('a pinned pending charge the bank leaves out of one answer, then lists again under its id', () => {
  // SimpleFIN refreshes once a day, and a card's pending list can miss a day.
  async function gapThenBack(edit: Partial<Transaction>, back: SyncedTx) {
    h.feed = [COFFEE, row('hold', -50, 'FLORIST', NOW - 2 * DAY, { pending: true })]
    await syncBankTransactions()
    await pin('hold', edit)
    await new Promise((r) => setTimeout(r, 5))
    h.feed = [COFFEE] // left out once: retired, no longer counted
    await syncBankTransactions()
    expect(await spend()).toBe(5)
    h.feed = [COFFEE, back]
    await syncBankTransactions()
  }

  it('filed by hand: comes back, counted once, with the category and the final amount', async () => {
    await gapThenBack({ categoryId: 3 }, row('hold', -52.5, 'FLORIST', NOW - 1 * DAY))
    expect(await byUid('hold')).toMatchObject({ deleted: false, manual: true, categoryId: 3, pending: false, amount: 52.5 })
    expect(await spend()).toBe(57.5)
    // ...and stays that way.
    await syncBankTransactions()
    expect(await byUid('hold')).toMatchObject({ deleted: false, manual: true, categoryId: 3 })
    expect(await spend()).toBe(57.5)
  })

  it('moved by hand: comes back on the date the user gave it', async () => {
    await gapThenBack({ date: iso(NOW - 20 * DAY) }, row('hold', -50, 'FLORIST', NOW - 1 * DAY))
    expect(await byUid('hold')).toMatchObject({ deleted: false, manual: true, date: iso(NOW - 20 * DAY) })
    expect(await spend()).toBe(55)
  })

  it('still pending when it comes back: counted, and it still follows the bank', async () => {
    await gapThenBack({ categoryId: 3 }, row('hold', -50, 'FLORIST', NOW - 2 * DAY, { pending: true }))
    expect(await byUid('hold')).toMatchObject({ deleted: false, pending: true, categoryId: 3 })
    expect(await spend()).toBe(55)
  })

  it('hidden by hand: stays hidden', async () => {
    await gapThenBack({ deleted: true }, row('hold', -50, 'FLORIST', NOW - 1 * DAY))
    expect(await byUid('hold')).toMatchObject({ deleted: true, manual: true })
    expect(await spend()).toBe(5)
  })

  it('not pinned (control): comes back', async () => {
    h.feed = [COFFEE, row('hold', -50, 'FLORIST', NOW - 2 * DAY, { pending: true })]
    await syncBankTransactions()
    h.feed = [COFFEE]
    await syncBankTransactions()
    h.feed = [COFFEE, row('hold', -50, 'FLORIST', NOW - 1 * DAY)]
    await syncBankTransactions()
    expect(await byUid('hold')).toMatchObject({ deleted: false, pending: false })
    expect(await spend()).toBe(55)
  })
})

describe('a hidden pending charge dropped the day a different charge appears', () => {
  it('the other charge is not hidden, unless it is a sure match', async () => {
    h.feed = [COFFEE, row('hold', -50, 'GRAND HOTEL', NOW - 3 * DAY, { pending: true })]
    await syncBankTransactions()
    await pin('hold', { deleted: true })
    await new Promise((r) => setTimeout(r, 5))
    // The hold drops; a $48 lunch first shows up on the card the same day.
    h.feed = [COFFEE, row('lunch', -48, 'NOODLE BAR', NOW - 1 * DAY)]
    await syncBankTransactions()
    expect(await byUid('lunch')).toMatchObject({ deleted: false })
    expect((await byUid('lunch'))?.manual).toBeFalsy()
    expect(await spend()).toBe(53)
  })

  it('a hide still moves to the one posted row of the exact amount, even with nothing in common in the words', async () => {
    // Real shape: a card's pending row reads 'Debit' and its posted row the merchant.
    h.feed = [COFFEE, row('hold', -121.5, 'Debit', NOW - 3 * DAY, { pending: true })]
    await syncBankTransactions()
    await pin('hold', { deleted: true })
    await new Promise((r) => setTimeout(r, 5))
    h.feed = [COFFEE, row('post', -121.5, 'CORNER MARKET', NOW - 1 * DAY)]
    await syncBankTransactions()
    expect(await byUid('post')).toMatchObject({ deleted: true, manual: true })
    expect(await spend()).toBe(5)
  })

  it('two possible posted rows: neither is hidden', async () => {
    h.feed = [COFFEE, row('hold', -40, 'PLONK MARKET', NOW - 3 * DAY, { pending: true })]
    await syncBankTransactions()
    await pin('hold', { deleted: true })
    await new Promise((r) => setTimeout(r, 5))
    h.feed = [COFFEE, row('a', -40, 'PLONK MARKET #1', NOW - 1 * DAY), row('b', -40, 'PLONK MARKET #2', NOW - 1 * DAY)]
    await syncBankTransactions()
    expect(await spend()).toBe(85)
  })
})
