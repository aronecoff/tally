/**
 * The bank reconcile with card refunds in the feed. A refund lands once, as an
 * expense with a negative amount in its merchant's category; re-syncing the
 * same feed changes nothing (no second copy, no tombstone, no rewrite); card
 * payments never land at all. Two local rows sharing a uid collapse to one, the
 * pinned copy kept, without a tombstone that would reach the cloud.
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

const CARD = 'Test Bank Rewards Visa (1111)'
const CHECKING = 'Test Bank Checking (3333)'
const DAY = 86400
// Posted times sit inside the window the reconcile derives from the feed itself.
const T0 = Math.floor(Date.now() / 1000) - 20 * DAY

const tx = (id: string, p: Partial<SyncedTx> & Pick<SyncedTx, 'amount' | 'account'>): SyncedTx => ({
  sourceTxId: id,
  tier: p.account === CHECKING ? 'cash' : 'credit',
  posted: T0,
  description: '',
  payee: '',
  memo: '',
  mcc: null,
  ...p,
})

const FEED: SyncedTx[] = [
  tx('buy', { account: CARD, amount: -60, payee: 'Amazon', description: 'AMAZON MKTPLACE PMTS' }),
  tx('back', { account: CARD, amount: 24, posted: T0 + 3 * DAY, payee: 'Amazon', description: 'AMAZON MKTPLACE PMTS' }),
  // A card payment and its checking side, paired.
  tx('pay-card', { account: CARD, amount: 310, posted: T0 + 5 * DAY, payee: 'Payment', description: 'Payment Thank You-Mobile' }),
  tx('pay-bank', { account: CHECKING, amount: -310, posted: T0 + 6 * DAY, description: 'TEST BANK CREDIT CRD EPAY' }),
  // An unpaired payment in the other issuer's wording.
  tx('pay-dash', { account: CARD, amount: 40, posted: T0 + 7 * DAY, payee: 'Payment', description: 'MOBILE PAYMENT - THANK YOU' }),
]

const live = async () => (await db.transactions.toArray()).filter((t) => !t.deleted)
const spend = async () => Math.round((await live()).filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0) * 100) / 100

beforeEach(async () => {
  h.feed = FEED
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd([
    { id: 1, name: 'Shopping', icon: 'bag', color: '#fff', kind: 'expense', monthlyBudget: 400, sortOrder: 0, updatedAt: 0 },
    { id: 2, name: 'Other income', icon: 'plus', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
  ])
})

describe('card refunds in the reconcile', () => {
  it('lands the refund as a negative Shopping expense and no card payment', async () => {
    expect(await syncBankTransactions()).toBe(2)
    const rows = await live()
    expect(rows.map((t) => [t.uid, t.type, t.amount, t.categoryId]).sort()).toEqual([
      ['sf:back', 'expense', -24, 1],
      ['sf:buy', 'expense', 60, 1],
    ])
    expect(await spend()).toBe(36)
  })

  it('re-syncing the same feed adds nothing, tombstones nothing, rewrites nothing', async () => {
    await syncBankTransactions()
    const first = await db.transactions.toArray()
    expect(await syncBankTransactions()).toBe(0)
    const second = await db.transactions.toArray()
    expect(second).toEqual(first)
    expect(await spend()).toBe(36)
  })

  it('a refund flips from pending to posted in place', async () => {
    h.feed = FEED.map((t) => (t.sourceTxId === 'back' ? { ...t, pending: true } : t))
    await syncBankTransactions()
    expect((await live()).find((t) => t.uid === 'sf:back')?.pending).toBe(true)
    h.feed = FEED
    await syncBankTransactions()
    const rows = (await db.transactions.toArray()).filter((t) => t.uid === 'sf:back')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pending: false, deleted: false, amount: -24 })
  })

  it('a refund the bank stops returning is reconciled away like any row', async () => {
    await syncBankTransactions()
    h.feed = FEED.filter((t) => t.sourceTxId !== 'back')
    await syncBankTransactions()
    expect((await db.transactions.toArray()).find((t) => t.uid === 'sf:back')?.deleted).toBe(true)
    expect(await spend()).toBe(60)
  })

  it('a pinned refund is left as the user set it', async () => {
    await syncBankTransactions()
    const back = (await live()).find((t) => t.uid === 'sf:back')!
    await db.transactions.update(back.id!, { date: '2026-01-01', manual: true, updatedAt: 5 })
    await syncBankTransactions()
    expect(await db.transactions.get(back.id!)).toMatchObject({ date: '2026-01-01', manual: true, amount: -24 })
  })
})

describe('one row per uid', () => {
  it('collapses copies to the pinned one, deleting (not tombstoning) the rest', async () => {
    const base = { type: 'expense' as const, categoryId: 1, account: CARD, note: 'Amazon', createdAt: 0 }
    // The bank added its own copy before a pull delivered the pinned row.
    await db.transactions.bulkAdd([
      { ...base, uid: 'sf:buy', date: '2026-03-28', amount: 60, updatedAt: 900 },
      { ...base, uid: 'sf:buy', date: '2026-04-01', amount: 60, manual: true, updatedAt: 100 },
    ])
    await syncBankTransactions()
    const copies = (await db.transactions.toArray()).filter((t) => t.uid === 'sf:buy')
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatchObject({ date: '2026-04-01', manual: true, deleted: false })
  })
})
